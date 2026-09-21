//! The player: input, movement rules, the jetpack, and `apply_input`.

pub mod input;
pub mod jetpack;
pub mod movement;
pub mod respawn;
pub mod space;

pub use input::{button, edges, Input, InputEdges};
pub use jetpack::JetpackState;
pub use movement::{apply_flight, apply_horizontal, try_jump, JumpState};

use crate::constants::GravityMode;
use crate::map::Map;
use crate::physics::body::Body;
use crate::physics::resolve::integrate;

/// Everything a player's own input does in one tick.
///
/// **Pure.** No randomness, no time source, no logging, no allocation. The client
/// calls this dozens of times per frame during reconciliation replay
/// (`docs/42-netcode-prediction.md` §2), and its purity is the property that makes
/// prediction correct. If anything in the call chain were impure, prediction would
/// silently drift and surface as rubber-banding weeks later.
///
/// The order is part of the contract:
/// 1. derive edges;
/// 2. horizontal acceleration;
/// 3. `try_jump` — **before** the jetpack, so a grounded press is consumed by the
///    jump and the jetpack only sees what is left. That is the whole Space
///    disambiguation;
/// 4. jetpack decision and fuel;
/// 5. jetpack thrust, if engaged;
/// 6. `integrate` **last** — every force lands in velocity first, then the body
///    moves once. Moving between force applications would make the result depend on
///    the order of the forces, which is exactly what diverges between server and
///    client under reordering.
///
/// **Returns `integrate`'s landing impact** (T20.11), and does nothing with it.
/// Fall damage must not happen in here: the purity above is what makes prediction
/// correct, and `prediction.ts` replays this dozens of times per frame. Health is
/// not predicted client-side — it arrives in the binary snapshot — so the *effect*
/// belongs to `World::apply_inputs`, on the server, and only the measurement
/// belongs here.
/// Everything `apply_input` needs to know about a player beyond their body.
///
/// **One struct rather than a growing parameter list, and — much more
/// importantly — one derivation rather than two.**
/// `PlayerState::move_mods` builds it, `World::apply_inputs` calls that, and the
/// wasm mirror calls the same function on its own mirrored `PlayerState`.
/// Nothing else constructs one outside a test.
///
/// That shape is what makes T20.19 and T20.21's rule structural instead of
/// remembered. The rule is *"everything `apply_input` reads must be identical on
/// both sides"*, and it was broken twice in one week by the same mechanism: the
/// client passed a literal where the server passed a value. A literal is exactly
/// what a bare `f32` parameter invites — and there is nowhere to write a literal
/// here, because the only thing that fits is what the shared derivation
/// returned. A new modifier is now a **field** that both sides get for free
/// rather than a fifth argument one of them will be handed and the other will
/// not.
///
/// `MoveMods` deliberately has no `Default`: see `NONE`.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct MoveMods {
    /// Target walk speed as a fraction of `WALK_SPEED`. Health (`docs/21` §3)
    /// times whatever the bag adds (T21.02's boots).
    pub speed: f32,
    /// **Launch velocity** as a fraction of `JUMP_VELOCITY` — not height. Height
    /// goes as `v²/2g`, so this is `sqrt` of the height multiplier; see
    /// `BOOTS_JUMP_HEIGHT_MULT`.
    pub jump: f32,
    /// Constant flight (T21.03's unicorn wings).
    ///
    /// While true: gravity is off, the vertical velocity is driven to
    /// `WINGS_FLY_SPEED`, and **the jump and the jetpack are refused** — refused
    /// rather than ignored, which is the difference between a bug report that
    /// says "jump does nothing" and one that says "jump is disabled while you
    /// are flying".
    ///
    /// **This is a field on the struct and not a fourth flag** precisely because
    /// it is the third gravity regime: `jetpack::gravity_scale` names all three
    /// in one place, so nothing can be in two of them at once.
    pub flying: bool,
    /// Riding a gun platform (T21.11B).
    ///
    /// **The lockout lives here rather than in the input reader**, because
    /// `apply_input` is what both sides run and a client-side refusal leaves the
    /// server moving anyone with a modified client. It is also T20.19/T20.21's
    /// rule applied: a movement modifier the client does not know about ships as
    /// rubber-banding, not as an immobile player.
    ///
    /// Mutually exclusive with `flying` by construction — `move_mods` derives
    /// `flying` as *wings and not mounted* — so `jetpack::gravity_scale` still
    /// names one regime at a time.
    pub mounted: bool,
}

impl MoveMods {
    /// An unmodified player: full health, and nothing in the bag that moves you.
    ///
    /// **Not a `Default` impl, on purpose.** A `Default` is what a caller
    /// reaches for when it does not know what to pass, and "a caller that did
    /// not know what to pass" is the literal `1.0` the mirror carried for
    /// fifteen milestones. Production has exactly one source — `move_mods` — and
    /// this is for the movement fixtures that own a bare `Body` and have no
    /// `PlayerState` at all.
    pub const NONE: MoveMods = MoveMods {
        speed: 1.0,
        jump: 1.0,
        flying: false,
        mounted: false,
    };
}

// Eight became nine at T22.02, and the reason is recorded rather than glossed.
//
// The comment this replaces said: *"`MoveMods` replaced an argument rather than
// adding one — the count is what it was — and the struct is what stops the next
// modifier making it nine."* `gravity` is not a modifier of the *player*, which
// is what `MoveMods` is and what `PlayerState::move_mods` derives; it is a
// property of the **match**, and folding it into `MoveMods` would give
// `move_mods()` an argument and end its single-derivation property — the thing
// T20.19 and T21.02 paid for and the one rule both of the last two rubber-band
// bugs broke.
//
// **The wrapper that restores the count is M22-RULINGS R10's `MoveStep { mods,
// env }`, and R10 says in as many words that `T22.11` introduces it and nobody
// before it does.** So this argument is the scalar-seam form of the same value,
// and T22.11 absorbs it: `mods` and `gravity` become one `MoveStep`, one
// parameter replaces two, and the count goes back to eight — which is the move
// the old comment blessed, done once R10's owner is the one doing it.
#[allow(clippy::too_many_arguments)]
pub fn apply_input(
    map: &Map,
    body: &mut Body,
    jump: &mut JumpState,
    jet: &mut JetpackState,
    input: &Input,
    prev: &Input,
    mods: MoveMods,
    gravity: GravityMode,
    dt: f32,
) -> f32 {
    let e = edges(input, prev);
    // **T21.11B — a mounted player supplies no direction.** Zeroed here rather
    // than at any of the callers, because this is the function both sides run:
    // a lockout applied in the client's input reader would leave the server
    // moving anyone with a modified client, and a lockout applied only
    // server-side would rubber-band every mounted player on screen.
    //
    // Zero rather than skipping `apply_horizontal`: the deceleration still has
    // to run, or a player who mounts mid-stride keeps their velocity and slides
    // off the platform they just mounted.
    let dir = if mods.mounted { 0.0 } else { input.move_dir() };

    // **T22.03 — the zero-g locomotion rules** (`M22-RULINGS` R1/R4). One
    // branch, not a second movement function: `space::floating` is the whole
    // condition and it is read twice below.
    //
    // `apply_horizontal` is skipped while floating, and **both** of the things
    // it does are the reason. It applies `AIR_DRAG`, which is the damping this
    // mode exists not to have — and it `approach`es `dir * WALK_SPEED`, which
    // drags a body drifting at 400 px/s back down to 150 whether or not the
    // drag constant is zero. *"Set `AIR_DRAG` to zero"* fixes only the first.
    //
    // A player standing on an asteroid is **not** floating (R4) and walks
    // through this line exactly as they do anywhere else.
    let floating = space::floating(gravity, body, mods);
    if !floating {
        apply_horizontal(body, dir, mods.speed, dt);
    }

    // **T21.03 — wings refuse the jump and the jetpack, and *refused* is the
    // operative word.** `try_jump` is not called at all, and the buffered press
    // is cleared with it: a jump silently swallowed would otherwise fire the
    // instant the wings were dropped, up to `JUMP_BUFFER` later, which reads on
    // screen as the game doing something nobody asked for. The jetpack is driven
    // to inactive rather than merely left unthrust, so `jet.active` — which the
    // wire, the animation and `gravity_scale` all read — cannot say a player is
    // jetpacking while the wings are carrying them.
    // **Mounted refuses the jump for the same reason wings do, and it matters
    // more here**: holding jump is the *dismount* gesture (T21.11B), so a
    // mounted player is holding it on purpose for a whole second. Without this
    // they would launch off the platform on the first frame of every dismount,
    // and the buffered press would fire again the moment they landed.
    let jumped = if mods.flying || mods.mounted {
        jump.buffered_ticks = 0;
        jetpack::refuse(jet);
        false
    } else {
        // **T22.03 — in space a jump is a push off a rock and it costs fuel.**
        // The owner: *"Jumping and even moving now takes jetpack energy."*
        //
        // Refused rather than swallowed when the tank cannot pay, and the
        // buffered press is cleared with it **for the reason the wings arm
        // above clears it**: a press held back would otherwise fire the instant
        // the tank refilled, up to `JUMP_BUFFER` later, which reads on screen
        // as the game jumping on its own.
        //
        // Asked *before* `try_jump` and spent *after* it, so the tank is only
        // charged for a jump that actually launched — a press in mid-air, where
        // `try_jump` refuses anyway, is free.
        let broke = gravity == GravityMode::Space && !jetpack::can_afford_jump(jet);
        let jumped = if broke {
            jump.buffered_ticks = 0;
            false
        } else {
            try_jump(body, jump, e.jump_pressed, dir, mods.jump)
        };
        if jumped && gravity == GravityMode::Space {
            jetpack::spend_jump(jet);
        }

        // **One thrust path, not two.** In space a held *direction* engages the
        // same pack the JUMP key engages everywhere else: the same
        // `JetpackState`, the same drain, the same lockout and refill delay, the
        // same `jet.active` that the wire, the animation and the flame all read.
        // A separate space thruster would be a second author of the tank, which
        // is *share the guard, or share the function* broken at the one place
        // this mode's whole economy lives.
        //
        // **And JUMP alone does not engage it in space.** Under gravity, holding
        // SPACE with no direction is a controlled descent — that is what
        // `JETPACK_GRAVITY_SCALE` is for. With no gravity there is nothing to
        // descend against, so it is fuel spent on nothing, and a player who
        // rests a thumb on the key would arrive at every fight dry.
        //
        // **The engage edge is the direction itself in space, and that is not a
        // synthesised press.** `jetpack::update`'s hold-delay branch asks for a
        // *fresh* press so that SPACE cannot mean both "jump" and "jetpack" on
        // one tick. A direction key carries no such ambiguity, so there is
        // nothing to disambiguate and the thrust resumes on the tick after a
        // jump instead of ten ticks later.
        let (engage_held, engage_pressed) = if gravity == GravityMode::Space {
            let asking = floating && space::thrusting(input);
            (asking, asking)
        } else {
            (input.held(button::JUMP), e.jump_pressed)
        };
        jetpack::update(jet, body, engage_held, engage_pressed, jumped, dt);
        if jet.active {
            jetpack::apply_thrust(body, input, dt);
        }
        jumped
    };
    let _ = jumped;

    if mods.flying {
        apply_flight(body, input);
    }

    integrate(
        map,
        body,
        jetpack::gravity_scale(jet, mods.flying, gravity),
        // **R4's contact rules, and deliberately not `mods.flying`.** The
        // winged regime also hands `integrate` a scale of `0.0`, under ordinary
        // gravity, and must keep the ordinary contact rules; these are the
        // *match's* rules, so the condition is the match's mode. See
        // `integrate`'s doc for why this cannot be derived from the scale.
        gravity == GravityMode::Space,
        dt,
    )
}

/// The complete per-player movement state, so a caller can snapshot and restore it
/// in one value. Prediction (T6.09) and the determinism tests both need this.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MovementState {
    pub body: Body,
    pub jump: JumpState,
    pub jet: JetpackState,
}

impl MovementState {
    pub fn new(body: Body) -> Self {
        MovementState {
            body,
            jump: JumpState::default(),
            jet: JetpackState::default(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        map: &Map,
        input: &Input,
        prev: &Input,
        mods: MoveMods,
        gravity: GravityMode,
        dt: f32,
    ) -> f32 {
        apply_input(
            map,
            &mut self.body,
            &mut self.jump,
            &mut self.jet,
            input,
            prev,
            mods,
            gravity,
            dt,
        )
    }
}
pub mod state;
