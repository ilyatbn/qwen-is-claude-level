//! The player: input, movement rules, the jetpack, and `apply_input`.

pub mod input;
pub mod jetpack;
pub mod movement;
pub mod respawn;

pub use input::{button, edges, Input, InputEdges};
pub use jetpack::JetpackState;
pub use movement::{apply_horizontal, try_jump, JumpState};

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
    };
}

// Eight, and the allow stays (T21.02). `MoveMods` **replaced** an argument
// rather than adding one — the count is what it was — and the struct is what
// stops the next modifier making it nine.
#[allow(clippy::too_many_arguments)]
pub fn apply_input(
    map: &Map,
    body: &mut Body,
    jump: &mut JumpState,
    jet: &mut JetpackState,
    input: &Input,
    prev: &Input,
    mods: MoveMods,
    dt: f32,
) -> f32 {
    let e = edges(input, prev);
    let dir = input.move_dir();

    apply_horizontal(body, dir, mods.speed, dt);

    let jumped = try_jump(body, jump, e.jump_pressed, dir, mods.jump);

    jetpack::update(
        jet,
        body,
        input.held(button::JUMP),
        e.jump_pressed,
        jumped,
        dt,
    );

    if jet.active {
        jetpack::apply_thrust(body, input, dt);
    }

    integrate(map, body, jetpack::gravity_scale(jet), dt)
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

    pub fn step(&mut self, map: &Map, input: &Input, prev: &Input, mods: MoveMods, dt: f32) -> f32 {
        apply_input(
            map,
            &mut self.body,
            &mut self.jump,
            &mut self.jet,
            input,
            prev,
            mods,
            dt,
        )
    }
}
pub mod state;
