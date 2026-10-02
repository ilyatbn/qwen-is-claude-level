//! The jetpack: engagement rules, fuel, and thrust.
//!
//! Space is both jump and jetpack, so the engagement rules are the whole point.
//! `docs/20-player-movement.md` §5 gives an exhaustive table and it is implemented
//! here row for row, with a named test per row.
//!
//! [`update`] decides *whether* the jetpack is thrusting and manages fuel;
//! [`apply_thrust`] applies the force. Keeping the decision separate from the force
//! is what makes both testable.

use crate::constants::{
    GravityMode, JETPACK_DRAIN, JETPACK_GRAVITY_SCALE, JETPACK_HOLD_DELAY, JETPACK_MAX_FUEL,
    JETPACK_MAX_SPEED, JETPACK_MIN_FUEL_TO_ENGAGE, JETPACK_REFILL, JETPACK_REFILL_DELAY,
    JETPACK_THRUST_DOWN, JETPACK_THRUST_SIDE, JETPACK_THRUST_UP, SIM_HZ, SPACE_BRAKE_SCALE,
    SPACE_JUMP_FUEL, SPACE_THRUST_SCALE,
};
use crate::math::Vec2;
use crate::physics::body::Body;
use crate::player::input::{button, Input};

/// Hold delay in ticks: 0.18 s × 60 Hz = 10.
pub const HOLD_DELAY_TICKS: u32 = (JETPACK_HOLD_DELAY * SIM_HZ as f32) as u32;
/// Refill delay in ticks: 0.5 s × 60 Hz = 30.
pub const REFILL_DELAY_TICKS: u32 = (JETPACK_REFILL_DELAY * SIM_HZ as f32) as u32;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JetpackState {
    pub fuel: f32,
    pub active: bool,
    /// Ticks since last thrust, for the refill delay.
    pub idle_ticks: u32,
    /// Ticks since the last jump launch, for the hold-delay rule.
    pub ticks_since_jump: u32,
    /// Set after running dry; cleared once fuel reaches `JETPACK_MIN_FUEL_TO_ENGAGE`.
    pub locked_out: bool,
    /// T23.32: the engage key was held while the pack was refused ([`refuse`] — on a
    /// platform, on wings) and has not been let go since. Holding JUMP is the dismount
    /// gesture, and since a held JUMP climbs, a dismount held a moment long launched the
    /// player (`the_dismount_hold_never_launches_the_player`). On the ground the pack waits
    /// for a fresh press.
    pub refused_hold: bool,
    /// T23.32: the engage key has been held continuously since a jump it launched. On the
    /// ground a held key engages only then — "a held key after a jump has already been
    /// consumed". A hold that never jumped (carried across a respawn, pressed while dead)
    /// would otherwise engage on the ground, and since a held JUMP climbs, it launched the
    /// player (`prediction.test.ts`: a respawn while holding JUMP does not jump).
    pub hold_jumped: bool,
}

impl Default for JetpackState {
    fn default() -> Self {
        JetpackState {
            fuel: JETPACK_MAX_FUEL,
            active: false,
            idle_ticks: 0,
            ticks_since_jump: u32::MAX / 2,
            locked_out: false,
            refused_hold: false,
            hold_jumped: false,
        }
    }
}

/// Decide whether the jetpack thrusts this tick, and burn or refill fuel.
///
/// Call **after** `try_jump`, so `jumped_this_tick` is known. That ordering is what
/// implements the disambiguation: the jump consumes a grounded press, and the
/// jetpack only sees what is left.
/// **The two engage parameters are named for the signal, not for the key**
/// (T22.03). Under gravity they are JUMP held and JUMP pressed. In space a held
/// *direction* engages the same pack — `player::space` explains why that is one
/// path and not two — so what arrives here is "is this player asking the
/// thrusters for a push". Nothing about the state machine below changes: the
/// tank, the lockout, the refill delay and `active` still have exactly one
/// author, which is the point.
pub fn update(
    state: &mut JetpackState,
    body: &Body,
    engage_held: bool,
    engage_pressed: bool,
    jumped_this_tick: bool,
    dt: f32,
) {
    if jumped_this_tick {
        state.ticks_since_jump = 0;
    } else {
        state.ticks_since_jump = state.ticks_since_jump.saturating_add(1);
    }

    // Running dry locks the jetpack out until there is enough fuel to be worth
    // re-engaging. Without it, a player at 0.01 fuel gets one tick of thrust per
    // frame and the jetpack stutters.
    if state.fuel <= 0.0 {
        state.locked_out = true;
    }
    if state.locked_out && state.fuel >= JETPACK_MIN_FUEL_TO_ENGAGE {
        state.locked_out = false;
    }

    // MIN_FUEL_TO_ENGAGE gates STARTING, not burning. Requiring it every tick
    // stops the tank at 0.3 and the documented "5 s of thrust drains to exactly 0"
    // becomes impossible.
    let can_start = state.fuel >= JETPACK_MIN_FUEL_TO_ENGAGE && !state.locked_out;
    let can_continue = state.fuel > 0.0 && !state.locked_out;
    let has_fuel = if state.active {
        can_continue
    } else {
        can_start
    };

    // Let go, or off the ground (a dismounted body that walked off its platform, wings
    // dropped in mid-air): a held key engages again.
    if !engage_held || !body.grounded {
        state.refused_hold = false;
    }
    if !engage_held {
        state.hold_jumped = false;
    } else if jumped_this_tick {
        state.hold_jumped = true;
    }
    state.active = if !engage_held || !has_fuel || state.refused_hold {
        // Released, or nothing to burn: disengage instantly.
        false
    } else if jumped_this_tick {
        // The press that launched a jump does not also start the jetpack.
        false
    } else if state.ticks_since_jump <= HOLD_DELAY_TICKS {
        // Still inside the post-jump hold delay. Only a *fresh* press while
        // genuinely airborne engages here; a continuing hold must wait.
        engage_pressed && !body.grounded && !body.in_coyote_time()
    } else if body.grounded || body.in_coyote_time() {
        // On the ground with Space held but no jump this tick: that is a held key
        // after a jump has already been consumed, so it engages once the delay has
        // elapsed. A hold that launched no jump (carried across a respawn) does not —
        // unless the signal is fresh this tick: in space a held direction is the engage
        // signal and arrives as a press every tick (`player::apply_input`), with no jump.
        state.hold_jumped || engage_pressed
    } else {
        true
    };

    if state.active {
        state.fuel = (state.fuel - JETPACK_DRAIN * dt).max(0.0);
        state.idle_ticks = 0;
        if state.fuel <= 0.0 {
            state.active = false;
            state.locked_out = true;
        }
    } else {
        state.idle_ticks = state.idle_ticks.saturating_add(1);
        // Refill runs whether grounded or airborne — there is no landing
        // requirement.
        if state.idle_ticks > REFILL_DELAY_TICKS {
            state.fuel = (state.fuel + JETPACK_REFILL * dt).min(JETPACK_MAX_FUEL);
        }
    }
}

/// The share of the `JETPACK_THRUST_*` axes the pack pushes with under
/// `gravity`: [`SPACE_THRUST_SCALE`] in space, `1.0` everywhere else (T22.20,
/// `M22-RULINGS` R109 — the owner: *"can you make jetpacks in space less
/// powerful? it creates too much inertia."*).
pub fn thrust_scale(gravity: GravityMode) -> f32 {
    if gravity == GravityMode::Space {
        SPACE_THRUST_SCALE
    } else {
        1.0
    }
}

/// The velocity change this input asks the pack for, per axis, for one tick.
///
/// **Lifted out of [`apply_thrust`] so there is one author of "which way does
/// the pack push"** (T22.03). The space regime has to ask whether a held
/// direction is worth burning fuel for, and the honest form of that question is
/// *"would `apply_thrust` change the velocity"* — asking it by re-listing the
/// four buttons would be a second author, and it would get **UP + DOWN wrong**:
/// those do not cancel. `JETPACK_THRUST_UP` is 2200 against
/// `JETPACK_THRUST_DOWN`'s 900, so both held is a net *climb*, which
/// `opposing_vertical_thrust_leaves_the_asymmetric_remainder` pins.
///
/// The four lines below are `apply_thrust`'s own, moved unchanged rather than
/// refactored into `(accel) * dt`: `(-2200 + 900) * dt` and
/// `-2200 * dt + 900 * dt` are not the same `f32`, and a physics function's
/// arithmetic is not something to change while doing something else.
///
/// **T22.20 (`M22-RULINGS` R109): the match's gravity mode scales the push** —
/// [`thrust_scale`], `SPACE_THRUST_SCALE` in space and exactly `1.0` elsewhere.
/// Scaling the constant rather than the product keeps standard and low gravity
/// bit-identical (`x * 1.0 == x` in `f32`), and it is here rather than at a
/// caller because this is the one author of the push: `apply_thrust` (so
/// `apply_input`, server and mirror), `space::engaging` and the plume's
/// `thrust_at` all read it.
///
/// **T22.22 (`M22-RULINGS` R109c): in space the push that brakes is strong** —
/// `vel` is the body's velocity before the push, and each axis goes through
/// [`brake_axis`]. Off space `vel` is not read, so standard and low gravity are
/// still bit-identical. The sign of each axis never changes (`brake_axis` only
/// rescales a push in its own direction), so `space::engaging`'s sign test and the
/// plume's direction per axis read the same as before.
pub fn thrust_delta(input: &Input, gravity: GravityMode, vel: Vec2, dt: f32) -> (f32, f32) {
    let scale = thrust_scale(gravity);
    let mut thrust_x = 0.0;
    let mut thrust_y = 0.0;

    // T23.32 (owner: *"make pressing and holding space (jetpack) fly up … without having to
    // click w"*): under gravity the pack is engaged only by a held JUMP, so a held JUMP with
    // neither UP nor DOWN pushes **up**, as UP does. DOWN still wins its own direction. Not
    // in space: there a held direction is what engages the thrusters (`player::space`) and
    // JUMP is a jump that costs fuel, so a JUMP-alone climb would be a second, unasked-for
    // UP key in a scheme that has one.
    let jump_climbs =
        gravity != GravityMode::Space && input.held(button::JUMP) && !input.held(button::DOWN);
    if input.held(button::UP) || jump_climbs {
        thrust_y -= JETPACK_THRUST_UP * scale * dt;
    }
    if input.held(button::DOWN) {
        thrust_y += JETPACK_THRUST_DOWN * scale * dt;
    }
    if input.held(button::LEFT) {
        thrust_x -= JETPACK_THRUST_SIDE * scale * dt;
    }
    if input.held(button::RIGHT) {
        thrust_x += JETPACK_THRUST_SIDE * scale * dt;
    }

    if gravity == GravityMode::Space {
        (brake_axis(thrust_x, vel.x), brake_axis(thrust_y, vel.y))
    } else {
        (thrust_x, thrust_y)
    }
}

/// One axis of space thrust, `push` (this tick's velocity change at
/// [`SPACE_THRUST_SCALE`]), against that axis's velocity `v` — R109c, T22.22.
///
/// **Per axis, as the clamp in [`apply_thrust`] is**, and for the reason given
/// there: the buttons are axes, and a projection onto the velocity would turn a
/// LEFT press while drifting diagonally into a push with a vertical part nobody
/// asked for. The "component of thrust that opposes the velocity" is therefore
/// the axis whose push and velocity have opposite signs.
///
/// That axis pushes at [`SPACE_BRAKE_SCALE`] **only until `v` reaches zero**; the
/// rest of the tick's push is at the gentle share again. So:
///  - it never accelerates — the boosted part only ever removes speed;
///  - it cannot overshoot, so tapping against the travel cannot be used to reverse
///    at double rate;
///  - it is continuous in `v`: at `v = 0` (or the same sign) it is `push` exactly,
///    and at a tiny opposing `v` it is `push` plus at most `|v|`'s worth. That is
///    the dead-band the ruling asked for, in its exact form — no threshold for a
///    rounding error to chatter across, and no division (the ratio of two
///    constants is the only quotient).
pub fn brake_axis(push: f32, v: f32) -> f32 {
    if push * v >= 0.0 {
        return push;
    }
    let boosted = push * (SPACE_BRAKE_SCALE / SPACE_THRUST_SCALE);
    if boosted.abs() <= v.abs() {
        boosted
    } else {
        // Brake to zero, then the unspent part of the tick at the gentle share.
        -v + (boosted + v) * (SPACE_THRUST_SCALE / SPACE_BRAKE_SCALE)
    }
}

/// Apply directional thrust for one tick. Only called when `state.active`.
///
/// **Clamping policy:** the clamp bounds the *thrust*, not the body. An axis is
/// clamped only if it was thrust this tick **and** its speed was already within
/// `JETPACK_MAX_SPEED` before the thrust. A body already moving faster than the
/// limit — a rocket jump at 800 px/s — is left alone, so engaging the jetpack
/// mid-flight never brakes you. Thrust from rest still tops out at the limit.
pub fn apply_thrust(body: &mut Body, input: &Input, gravity: GravityMode, dt: f32) {
    let (thrust_x, thrust_y) = thrust_delta(input, gravity, body.vel, dt);

    let (before_x, before_y) = (body.vel.x, body.vel.y);
    body.vel.x += thrust_x;
    body.vel.y += thrust_y;

    // Per axis, not by vector magnitude: a magnitude clamp makes diagonal flight
    // slower on each axis than straight flight, which reads as the controls
    // fighting you.
    if thrust_x != 0.0 && before_x.abs() <= JETPACK_MAX_SPEED {
        body.vel.x = body.vel.x.clamp(-JETPACK_MAX_SPEED, JETPACK_MAX_SPEED);
    }
    if thrust_y != 0.0 && before_y.abs() <= JETPACK_MAX_SPEED {
        body.vel.y = body.vel.y.clamp(-JETPACK_MAX_SPEED, JETPACK_MAX_SPEED);
    }
}

/// Gravity multiplier for this tick.
///
/// `JETPACK_GRAVITY_SCALE` rather than 0 is deliberate: holding Space with no WASD
/// gives a slow controlled descent rather than a dead hover, so running out of fuel
/// is a gradual loss of lift instead of a sudden drop.
///
/// **The match's gravity mode multiplies all three regimes** (T22.02), and it is
/// applied here rather than at `apply_input`'s `integrate` line for the reason
/// the wings' `0.0` is here: *"which gravity is this player under"* must have
/// exactly one answer, and a second place to decide it is how a player ends up
/// jetpack-scaled **and** low-gravity-scaled by two paths that disagree. The
/// wings' regime is `0.0`, and `0.0 * anything` is still no gravity, so no mode
/// can resurrect a force T21.03 refused.
pub fn gravity_scale(state: &JetpackState, flying: bool, gravity: GravityMode) -> f32 {
    gravity.scale()
        * if flying {
            // **T21.03's wings: no gravity at all.** The third regime lives here
            // rather than in a branch at the call site, because "which gravity is
            // this player under" must have exactly one answer — a second place to
            // decide it is how a player ends up jetpack-scaled *and* flying.
            //
            // 0.0 rather than a small number: `apply_flight` assigns the vertical
            // velocity outright, so any residual gravity would be overwritten on the
            // very next tick and would only show up as a discrepancy between the
            // server and a client that rounded differently.
            0.0
        } else if state.active {
            JETPACK_GRAVITY_SCALE
        } else {
            1.0
        }
}

/// Can the tank pay for a space jump (T22.03, `M22-RULINGS` R4)?
///
/// **A question, not a deduction the caller may make itself.** `apply_input`
/// asks this before `try_jump` so that an unaffordable press is *refused* — the
/// press cleared with it — rather than launching a jump the tank cannot cover
/// and clamping the fuel at zero afterwards, which is a free jump wearing a
/// cost.
pub fn can_afford_jump(state: &JetpackState) -> bool {
    state.fuel >= SPACE_JUMP_FUEL
}

/// Charge a space jump to the tank (T22.03).
///
/// **Here rather than a `jet.fuel -=` at the call site, for the reason
/// [`refuse`] below is here**: the jetpack owns its own state machine, and a
/// second author of the tank is the one that forgets `locked_out` and
/// `idle_ticks`. Both are maintained:
///
///  - the lockout, because a jump that empties the tank must leave it locked
///    out exactly as a burn that empties it does — otherwise the one way to
///    reach 0 fuel and still get a stuttering tick of thrust is to jump there;
///  - `idle_ticks`, because a jump **is** a burn. Without the reset a player
///    could jump every tick off a rock and refill the whole way.
pub fn spend_jump(state: &mut JetpackState) {
    state.fuel = (state.fuel - SPACE_JUMP_FUEL).max(0.0);
    state.idle_ticks = 0;
    if state.fuel <= 0.0 {
        state.locked_out = true;
    }
}

/// Refuse the jetpack for this tick (T21.03).
///
/// **Not `state.active = false` at the call site.** The jetpack owns its own
/// state machine — `locked_out`, `idle_ticks`, the refill delay — and a caller
/// that reached in to clear one field would be a second author of that machine.
/// Refusing here keeps the fuel accounting honest: a winged player is not
/// burning, so their tank refills exactly as it does for anyone not thrusting.
pub fn refuse(state: &mut JetpackState) {
    state.active = false;
    state.refused_hold = true;
    state.idle_ticks = state.idle_ticks.saturating_add(1);
    state.ticks_since_jump = state.ticks_since_jump.saturating_add(1);
    if state.idle_ticks > REFILL_DELAY_TICKS {
        state.fuel = (state.fuel + JETPACK_REFILL * crate::constants::SIM_DT).min(JETPACK_MAX_FUEL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{GravityMode, GRAVITY, SIM_DT};
    use crate::math::Vec2;
    use crate::player::input::button::*;

    fn airborne() -> Body {
        let mut b = Body::new(Vec2::ZERO);
        b.grounded = false;
        b.airborne_ticks = 100;
        b
    }

    fn grounded() -> Body {
        let mut b = Body::new(Vec2::ZERO);
        b.grounded = true;
        b
    }

    // ---- the disambiguation table, one test per row ----------------------

    #[test]
    fn row1_a_press_while_grounded_does_not_engage() {
        let mut s = JetpackState::default();
        // try_jump consumed this press, so jumped_this_tick is true.
        update(&mut s, &grounded(), true, true, true, SIM_DT);
        assert!(!s.active, "the grounded press belongs to the jump");
        assert_eq!(s.fuel, JETPACK_MAX_FUEL, "no fuel burned");
    }

    #[test]
    fn row2_holding_through_a_jump_engages_after_exactly_the_hold_delay() {
        assert_eq!(HOLD_DELAY_TICKS, 10, "0.18 s at 60 Hz");
        let mut s = JetpackState::default();
        let mut b = grounded();

        // Tick 0: the jump.
        update(&mut s, &b, true, true, true, SIM_DT);
        assert!(!s.active);
        b = airborne();

        // Ticks 1..=HOLD_DELAY_TICKS: still held, must not engage yet.
        for tick in 1..=HOLD_DELAY_TICKS {
            update(&mut s, &b, true, false, false, SIM_DT);
            assert!(!s.active, "engaged early at tick {tick}");
        }
        // The next tick is past the delay.
        update(&mut s, &b, true, false, false, SIM_DT);
        assert!(s.active, "did not engage after the hold delay");
    }

    /// T23.32: a JUMP held on the ground that launched no jump (carried across a respawn,
    /// pressed while dead — the edge was refused) never engages there, however long it is
    /// held; since a held JUMP climbs, it would launch the player. Control: the same hold
    /// after a jump it launched engages once grounded past the hold delay.
    #[test]
    fn a_grounded_hold_that_never_jumped_does_not_engage() {
        let mut s = JetpackState::default();
        for tick in 0..=HOLD_DELAY_TICKS * 3 {
            update(&mut s, &grounded(), true, false, false, SIM_DT);
            assert!(
                !s.active,
                "a hold that never jumped engaged on the ground at tick {tick}"
            );
        }
        // Control: the hold launches a jump, lands, keeps holding.
        let mut c = JetpackState::default();
        update(&mut c, &grounded(), true, true, true, SIM_DT);
        for _ in 0..=HOLD_DELAY_TICKS {
            update(&mut c, &grounded(), true, false, false, SIM_DT);
        }
        assert!(
            c.active,
            "control: a hold after its own jump did not engage on the ground"
        );
    }

    #[test]
    fn row3_a_press_while_airborne_engages_immediately() {
        let mut s = JetpackState::default();
        update(&mut s, &airborne(), true, true, false, SIM_DT);
        assert!(s.active);
    }

    #[test]
    fn row4_releasing_space_disengages_on_that_tick() {
        let mut s = JetpackState::default();
        update(&mut s, &airborne(), true, true, false, SIM_DT);
        assert!(s.active, "precondition");
        update(&mut s, &airborne(), false, false, false, SIM_DT);
        assert!(!s.active);
    }

    #[test]
    fn row5_running_dry_disengages_and_locks_out() {
        let mut s = JetpackState::default();
        let b = airborne();
        for _ in 0..400 {
            update(&mut s, &b, true, false, false, SIM_DT);
        }
        assert_eq!(s.fuel, 0.0);
        assert!(!s.active);
        assert!(s.locked_out);
    }

    // ---- fuel ------------------------------------------------------------

    #[test]
    fn five_seconds_of_thrust_drains_the_tank_to_exactly_zero() {
        let mut s = JetpackState::default();
        let b = airborne();
        // Engage first, then burn for exactly JETPACK_MAX_FUEL seconds.
        let ticks = (JETPACK_MAX_FUEL * SIM_HZ as f32) as u32;
        for _ in 0..ticks {
            update(&mut s, &b, true, true, false, SIM_DT);
        }
        assert!(
            s.fuel.abs() < 1e-4,
            "fuel {} after {} s of thrust",
            s.fuel,
            JETPACK_MAX_FUEL
        );
    }

    #[test]
    fn fuel_never_goes_below_zero_or_above_max() {
        let mut s = JetpackState::default();
        let b = airborne();
        for _ in 0..2000 {
            update(&mut s, &b, true, false, false, SIM_DT);
            assert!(
                (0.0..=JETPACK_MAX_FUEL).contains(&s.fuel),
                "fuel {}",
                s.fuel
            );
        }
        for _ in 0..3000 {
            update(&mut s, &b, false, false, false, SIM_DT);
            assert!(
                (0.0..=JETPACK_MAX_FUEL).contains(&s.fuel),
                "fuel {}",
                s.fuel
            );
        }
        assert_eq!(s.fuel, JETPACK_MAX_FUEL);
    }

    #[test]
    fn ten_seconds_of_idling_refills_a_full_burn() {
        let mut s = JetpackState {
            fuel: 0.0,
            locked_out: true,
            ..Default::default()
        };
        let b = airborne();

        // The refill delay first, then 10 s of refill at 0.5/s.
        let ticks = REFILL_DELAY_TICKS + (10.0 * SIM_HZ as f32) as u32;
        for _ in 0..ticks {
            update(&mut s, &b, false, false, false, SIM_DT);
        }
        assert!(
            (s.fuel - JETPACK_MAX_FUEL).abs() < 1e-3,
            "fuel {} after 10 s idle",
            s.fuel
        );
        assert!(!s.locked_out, "lock-out should have cleared");
    }

    #[test]
    fn refill_does_not_start_during_the_delay() {
        assert_eq!(REFILL_DELAY_TICKS, 30, "0.5 s at 60 Hz");
        let mut s = JetpackState {
            fuel: 2.0,
            ..Default::default()
        };
        let b = airborne();
        for _ in 0..REFILL_DELAY_TICKS {
            update(&mut s, &b, false, false, false, SIM_DT);
            assert_eq!(s.fuel, 2.0, "refilled during the delay");
        }
        update(&mut s, &b, false, false, false, SIM_DT);
        assert!(s.fuel > 2.0, "refill did not start after the delay");
    }

    #[test]
    fn a_full_burn_and_refill_returns_to_exactly_the_starting_fuel() {
        // Guards against accumulated float drift over 900 ticks.
        let mut s = JetpackState::default();
        let b = airborne();
        let start = s.fuel;

        for _ in 0..(JETPACK_MAX_FUEL * SIM_HZ as f32) as u32 {
            update(&mut s, &b, true, true, false, SIM_DT);
        }
        for _ in 0..2000 {
            update(&mut s, &b, false, false, false, SIM_DT);
        }
        assert_eq!(s.fuel, start, "fuel drifted over a burn/refill cycle");
    }

    #[test]
    fn lockout_blocks_re_engagement_until_the_minimum() {
        let mut s = JetpackState {
            fuel: 0.0,
            locked_out: true,
            ..Default::default()
        };
        let b = airborne();

        // Hold Space throughout: it must not engage while below the minimum.
        let mut engaged_at_fuel = None;
        for _ in 0..600 {
            update(&mut s, &b, true, true, false, SIM_DT);
            if s.active {
                engaged_at_fuel = Some(s.fuel);
                break;
            }
        }
        let fuel = engaged_at_fuel.expect("never re-engaged");
        assert!(
            fuel >= JETPACK_MIN_FUEL_TO_ENGAGE - JETPACK_DRAIN * SIM_DT,
            "engaged at {fuel}, below the {JETPACK_MIN_FUEL_TO_ENGAGE} minimum"
        );
    }

    #[test]
    fn zero_fuel_never_engages_under_any_input_combination() {
        for (held, pressed, jumped) in [
            (true, true, false),
            (true, false, false),
            (true, true, true),
            (false, false, false),
        ] {
            let mut s = JetpackState {
                fuel: 0.0,
                ..Default::default()
            };
            update(&mut s, &airborne(), held, pressed, jumped, SIM_DT);
            assert!(
                !s.active,
                "engaged at zero fuel with ({held},{pressed},{jumped})"
            );
        }
    }

    // ---- thrust ----------------------------------------------------------

    fn input_with(buttons: u8) -> Input {
        Input::new(0, buttons, 0)
    }

    #[test]
    fn each_direction_converges_on_the_clamp() {
        for (btn, axis_up) in [(UP, true), (DOWN, false)] {
            let mut b = Body::new(Vec2::ZERO);
            for _ in 0..200 {
                apply_thrust(&mut b, &input_with(btn), GravityMode::Standard, SIM_DT);
            }
            if axis_up {
                assert_eq!(b.vel.y, -JETPACK_MAX_SPEED);
            } else {
                assert_eq!(b.vel.y, JETPACK_MAX_SPEED);
            }
        }
        for (btn, sign) in [(LEFT, -1.0f32), (RIGHT, 1.0)] {
            let mut b = Body::new(Vec2::ZERO);
            for _ in 0..200 {
                apply_thrust(&mut b, &input_with(btn), GravityMode::Standard, SIM_DT);
            }
            assert_eq!(b.vel.x, sign * JETPACK_MAX_SPEED);
        }
    }

    #[test]
    fn diagonal_flight_reaches_the_full_clamp_on_both_axes() {
        // The test that catches a magnitude clamp.
        let mut b = Body::new(Vec2::ZERO);
        for _ in 0..200 {
            apply_thrust(
                &mut b,
                &input_with(UP | RIGHT),
                GravityMode::Standard,
                SIM_DT,
            );
        }
        assert_eq!(b.vel.y, -JETPACK_MAX_SPEED);
        assert_eq!(b.vel.x, JETPACK_MAX_SPEED);
    }

    #[test]
    fn opposing_lateral_thrust_cancels() {
        let mut b = Body::new(Vec2::ZERO);
        apply_thrust(
            &mut b,
            &input_with(LEFT | RIGHT),
            GravityMode::Standard,
            SIM_DT,
        );
        assert_eq!(b.vel.x, 0.0);
    }

    #[test]
    fn opposing_vertical_thrust_leaves_the_asymmetric_remainder() {
        let mut b = Body::new(Vec2::ZERO);
        apply_thrust(
            &mut b,
            &input_with(UP | DOWN),
            GravityMode::Standard,
            SIM_DT,
        );
        let expected = (JETPACK_THRUST_DOWN - JETPACK_THRUST_UP) * SIM_DT;
        assert!(
            (b.vel.y - expected).abs() < 1e-4,
            "{} vs {expected}",
            b.vel.y
        );
    }

    #[test]
    fn no_directional_input_applies_no_thrust() {
        // T23.32: no button at all (a held JUMP climbs now — below). And in space a
        // held JUMP alone is no direction, as before.
        let mut b = Body::new(Vec2::new(1.0, 2.0));
        b.vel = Vec2::new(3.0, 4.0);
        apply_thrust(&mut b, &input_with(0), GravityMode::Standard, SIM_DT);
        assert_eq!(b.vel, Vec2::new(3.0, 4.0));
        let still = thrust_delta(&input_with(JUMP), GravityMode::Space, Vec2::ZERO, SIM_DT);
        assert_eq!(still, (0.0, 0.0), "space: JUMP alone pushed {still:?}");
    }

    #[test]
    fn a_rocket_jump_is_not_clamped_down_by_engaging_the_jetpack() {
        // Only thrust-driven velocity is clamped. Holding UP while already moving
        // up at 800 px/s must not brake to 260.
        let mut b = Body::new(Vec2::ZERO);
        b.vel.y = -800.0;
        apply_thrust(&mut b, &input_with(UP), GravityMode::Standard, SIM_DT);
        assert!(
            b.vel.y < -800.0,
            "upward thrust braked a rocket jump to {}",
            b.vel.y
        );

        // Thrusting the OPPOSITE way does reduce it, as it should.
        let mut b = Body::new(Vec2::ZERO);
        b.vel.y = -800.0;
        apply_thrust(&mut b, &input_with(DOWN), GravityMode::Standard, SIM_DT);
        assert!(b.vel.y > -800.0);
        assert!(b.vel.y < 0.0, "one tick should not reverse it");
    }

    #[test]
    fn upward_thrust_beats_gravity() {
        let mut b = Body::new(Vec2::ZERO);
        let s = JetpackState {
            active: true,
            ..Default::default()
        };
        for _ in 0..30 {
            apply_thrust(&mut b, &input_with(UP), GravityMode::Standard, SIM_DT);
            b.vel.y += GRAVITY * gravity_scale(&s, false, GravityMode::Standard) * SIM_DT;
            b.pos.y += b.vel.y * SIM_DT;
        }
        assert!(b.pos.y < 0.0, "did not climb: y = {}", b.pos.y);
    }

    /// **T23.32 (owner: *"make pressing and holding space (jetpack) fly up … without
    /// having to click w"*): a held JUMP alone pushes as UP does**, in standard and low
    /// gravity — the push pinned to `JETPACK_THRUST_UP` (and the mode's scale), equal to
    /// the UP case's. Controls: JUMP + DOWN is the DOWN case's (DOWN wins its own
    /// direction); JUMP + UP is UP's, not doubled. And a JUMP press on the ground is a
    /// jump, not thrust: the pack does not engage that tick. (Plant: `jump_climbs`
    /// `false` → red.)
    #[test]
    fn holding_space_alone_flies_up_as_up_does() {
        for g in [GravityMode::Standard, GravityMode::Low] {
            let up = thrust_delta(&input_with(UP), g, Vec2::ZERO, SIM_DT);
            let space = thrust_delta(&input_with(JUMP), g, Vec2::ZERO, SIM_DT);
            assert_eq!(space, up, "{g:?}: Space alone pushed {space:?}, UP {up:?}");
            assert_eq!(space.1, -JETPACK_THRUST_UP * thrust_scale(g) * SIM_DT);
            let down = thrust_delta(&input_with(DOWN), g, Vec2::ZERO, SIM_DT);
            let space_down = thrust_delta(&input_with(JUMP | DOWN), g, Vec2::ZERO, SIM_DT);
            assert_eq!(space_down, down, "{g:?}: Space+S is not S's push");
            let both = thrust_delta(&input_with(JUMP | UP), g, Vec2::ZERO, SIM_DT);
            assert_eq!(both, up, "{g:?}: Space+W doubled the climb");
        }
        // It climbs, in the integrator the game runs.
        let mut b = Body::new(Vec2::ZERO);
        let s = JetpackState {
            active: true,
            ..Default::default()
        };
        for _ in 0..30 {
            apply_thrust(&mut b, &input_with(JUMP), GravityMode::Standard, SIM_DT);
            b.vel.y += GRAVITY * gravity_scale(&s, false, GravityMode::Standard) * SIM_DT;
            b.pos.y += b.vel.y * SIM_DT;
        }
        assert!(b.pos.y < 0.0, "Space alone did not climb: y = {}", b.pos.y);
        // A press on the ground is the jump.
        let mut st = JetpackState::default();
        update(&mut st, &grounded(), true, true, true, SIM_DT);
        assert!(!st.active, "the jump's press engaged the pack");
    }

    #[test]
    fn gravity_scale_switches_with_active() {
        let mut s = JetpackState::default();
        assert_eq!(gravity_scale(&s, false, GravityMode::Standard), 1.0);
        s.active = true;
        assert_eq!(
            gravity_scale(&s, false, GravityMode::Standard),
            JETPACK_GRAVITY_SCALE
        );
    }

    /// **R109c (T22.22): the brake only takes speed away.** Per axis, over a sweep of
    /// velocities through zero both ways and every push, `brake_axis`:
    ///  - leaves a push with (or from zero) the travel exactly as it was — the
    ///    control that says the boost is not everywhere;
    ///  - pushes at `SPACE_BRAKE_SCALE` while the push cannot reach zero — the
    ///    presence;
    ///  - once the push can reach zero, reaches it and reverses only by the rest of
    ///    the tick at the gentle share (`|v + out| ≤ |strong + v| / ratio`) — never
    ///    overshooting at the strong rate, never gaining more than the braked `|v|`;
    ///  - is continuous at zero: a velocity a hair against the push changes the push by
    ///    no more than the hair.
    ///
    /// Off space the velocity is not read at all: standard gravity's `thrust_delta` is
    /// the same for every velocity.
    #[test]
    fn the_brake_is_strong_until_zero_and_gentle_after() {
        use crate::constants::{SPACE_BRAKE_SCALE, SPACE_THRUST_SCALE};
        use crate::player::input::Input;
        let ratio = SPACE_BRAKE_SCALE / SPACE_THRUST_SCALE;
        assert!(
            ratio > 1.0,
            "the brake is not stronger than the push — nothing to test"
        );
        let pushes = [
            JETPACK_THRUST_SIDE * SPACE_THRUST_SCALE * SIM_DT,
            JETPACK_THRUST_UP * SPACE_THRUST_SCALE * SIM_DT,
            JETPACK_THRUST_DOWN * SPACE_THRUST_SCALE * SIM_DT,
        ];
        let mut boosted_seen = 0;
        for &p in &pushes {
            for push in [p, -p] {
                for i in -400..=400 {
                    let v = i as f32 * 0.5;
                    let out = brake_axis(push, v);
                    assert_eq!(
                        out.signum(),
                        push.signum(),
                        "push {push} at v {v} flipped: {out}"
                    );
                    if push * v >= 0.0 {
                        assert_eq!(out, push, "push {push} with the travel {v} was changed");
                        continue;
                    }
                    let strong = push * ratio;
                    if strong.abs() <= v.abs() {
                        assert_eq!(
                            out, strong,
                            "push {push} against {v} not at the brake's rate"
                        );
                        boosted_seen += 1;
                    } else {
                        // Crossed zero: what is left is the gentle share of the rest.
                        let after = v + out;
                        assert!(
                            after * push >= 0.0,
                            "push {push} against {v} did not reach zero: {after}"
                        );
                        assert!(
                            after.abs() <= (strong + v).abs() / ratio + 1e-4,
                            "push {push} against {v} overshot at the brake's rate: {after}"
                        );
                        assert!(
                            (out - push).abs() <= v.abs() + 1e-4,
                            "push {push} against {v} gained more than the velocity it braked"
                        );
                    }
                }
            }
        }
        assert!(
            boosted_seen > 100,
            "the sweep never braked at the strong rate"
        );
        let input = Input::new(0, UP | RIGHT, 0);
        let rest = thrust_delta(&input, GravityMode::Standard, Vec2::ZERO, SIM_DT);
        for v in [Vec2::new(-400.0, 400.0), Vec2::new(400.0, -400.0)] {
            assert_eq!(thrust_delta(&input, GravityMode::Standard, v, SIM_DT), rest);
            assert_eq!(thrust_delta(&input, GravityMode::Low, v, SIM_DT).0, {
                thrust_delta(&input, GravityMode::Low, Vec2::ZERO, SIM_DT).0
            });
        }
        // And in space the same input against the travel is the brake's push.
        let (x, _) = thrust_delta(&input, GravityMode::Space, Vec2::new(-400.0, 0.0), SIM_DT);
        assert_eq!(x, JETPACK_THRUST_SIDE * SPACE_THRUST_SCALE * SIM_DT * ratio);
    }
}
