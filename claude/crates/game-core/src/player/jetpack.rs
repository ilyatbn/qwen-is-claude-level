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
    JETPACK_DRAIN, JETPACK_GRAVITY_SCALE, JETPACK_HOLD_DELAY, JETPACK_MAX_FUEL, JETPACK_MAX_SPEED,
    JETPACK_MIN_FUEL_TO_ENGAGE, JETPACK_REFILL, JETPACK_REFILL_DELAY, JETPACK_THRUST_DOWN,
    JETPACK_THRUST_SIDE, JETPACK_THRUST_UP, SIM_HZ,
};
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
}

impl Default for JetpackState {
    fn default() -> Self {
        JetpackState {
            fuel: JETPACK_MAX_FUEL,
            active: false,
            idle_ticks: 0,
            ticks_since_jump: u32::MAX / 2,
            locked_out: false,
        }
    }
}

/// Decide whether the jetpack thrusts this tick, and burn or refill fuel.
///
/// Call **after** `try_jump`, so `jumped_this_tick` is known. That ordering is what
/// implements the disambiguation: the jump consumes a grounded press, and the
/// jetpack only sees what is left.
pub fn update(
    state: &mut JetpackState,
    body: &Body,
    jump_held: bool,
    jump_pressed: bool,
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

    state.active = if !jump_held || !has_fuel {
        // Released, or nothing to burn: disengage instantly.
        false
    } else if jumped_this_tick {
        // The press that launched a jump does not also start the jetpack.
        false
    } else if state.ticks_since_jump <= HOLD_DELAY_TICKS {
        // Still inside the post-jump hold delay. Only a *fresh* press while
        // genuinely airborne engages here; a continuing hold must wait.
        jump_pressed && !body.grounded && !body.in_coyote_time()
    } else if body.grounded || body.in_coyote_time() {
        // On the ground with Space held but no jump this tick: that is a held key
        // after a jump has already been consumed, so it engages once the delay has
        // elapsed.
        true
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

/// Apply directional thrust for one tick. Only called when `state.active`.
///
/// **Clamping policy:** the clamp bounds the *thrust*, not the body. An axis is
/// clamped only if it was thrust this tick **and** its speed was already within
/// `JETPACK_MAX_SPEED` before the thrust. A body already moving faster than the
/// limit — a rocket jump at 800 px/s — is left alone, so engaging the jetpack
/// mid-flight never brakes you. Thrust from rest still tops out at the limit.
pub fn apply_thrust(body: &mut Body, input: &Input, dt: f32) {
    let mut thrust_x = 0.0;
    let mut thrust_y = 0.0;

    if input.held(button::UP) {
        thrust_y -= JETPACK_THRUST_UP * dt;
    }
    if input.held(button::DOWN) {
        thrust_y += JETPACK_THRUST_DOWN * dt;
    }
    if input.held(button::LEFT) {
        thrust_x -= JETPACK_THRUST_SIDE * dt;
    }
    if input.held(button::RIGHT) {
        thrust_x += JETPACK_THRUST_SIDE * dt;
    }

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
pub fn gravity_scale(state: &JetpackState) -> f32 {
    if state.active {
        JETPACK_GRAVITY_SCALE
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{GRAVITY, SIM_DT};
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
                apply_thrust(&mut b, &input_with(btn), SIM_DT);
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
                apply_thrust(&mut b, &input_with(btn), SIM_DT);
            }
            assert_eq!(b.vel.x, sign * JETPACK_MAX_SPEED);
        }
    }

    #[test]
    fn diagonal_flight_reaches_the_full_clamp_on_both_axes() {
        // The test that catches a magnitude clamp.
        let mut b = Body::new(Vec2::ZERO);
        for _ in 0..200 {
            apply_thrust(&mut b, &input_with(UP | RIGHT), SIM_DT);
        }
        assert_eq!(b.vel.y, -JETPACK_MAX_SPEED);
        assert_eq!(b.vel.x, JETPACK_MAX_SPEED);
    }

    #[test]
    fn opposing_lateral_thrust_cancels() {
        let mut b = Body::new(Vec2::ZERO);
        apply_thrust(&mut b, &input_with(LEFT | RIGHT), SIM_DT);
        assert_eq!(b.vel.x, 0.0);
    }

    #[test]
    fn opposing_vertical_thrust_leaves_the_asymmetric_remainder() {
        let mut b = Body::new(Vec2::ZERO);
        apply_thrust(&mut b, &input_with(UP | DOWN), SIM_DT);
        let expected = (JETPACK_THRUST_DOWN - JETPACK_THRUST_UP) * SIM_DT;
        assert!(
            (b.vel.y - expected).abs() < 1e-4,
            "{} vs {expected}",
            b.vel.y
        );
    }

    #[test]
    fn no_directional_input_applies_no_thrust() {
        let mut b = Body::new(Vec2::new(1.0, 2.0));
        b.vel = Vec2::new(3.0, 4.0);
        apply_thrust(&mut b, &input_with(JUMP), SIM_DT);
        assert_eq!(b.vel, Vec2::new(3.0, 4.0));
    }

    #[test]
    fn a_rocket_jump_is_not_clamped_down_by_engaging_the_jetpack() {
        // Only thrust-driven velocity is clamped. Holding UP while already moving
        // up at 800 px/s must not brake to 260.
        let mut b = Body::new(Vec2::ZERO);
        b.vel.y = -800.0;
        apply_thrust(&mut b, &input_with(UP), SIM_DT);
        assert!(
            b.vel.y < -800.0,
            "upward thrust braked a rocket jump to {}",
            b.vel.y
        );

        // Thrusting the OPPOSITE way does reduce it, as it should.
        let mut b = Body::new(Vec2::ZERO);
        b.vel.y = -800.0;
        apply_thrust(&mut b, &input_with(DOWN), SIM_DT);
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
            apply_thrust(&mut b, &input_with(UP), SIM_DT);
            b.vel.y += GRAVITY * gravity_scale(&s) * SIM_DT;
            b.pos.y += b.vel.y * SIM_DT;
        }
        assert!(b.pos.y < 0.0, "did not climb: y = {}", b.pos.y);
    }

    #[test]
    fn holding_space_with_no_wasd_is_a_slow_descent() {
        // Between 10% and 50% of an unpowered fall over the same time.
        let ticks = 60;
        let mut powered = Body::new(Vec2::ZERO);
        let s = JetpackState {
            active: true,
            ..Default::default()
        };
        for _ in 0..ticks {
            apply_thrust(&mut powered, &input_with(JUMP), SIM_DT);
            powered.vel.y += GRAVITY * gravity_scale(&s) * SIM_DT;
            powered.pos.y += powered.vel.y * SIM_DT;
        }

        let mut free = Body::new(Vec2::ZERO);
        for _ in 0..ticks {
            free.vel.y += GRAVITY * SIM_DT;
            free.pos.y += free.vel.y * SIM_DT;
        }

        let ratio = powered.pos.y / free.pos.y;
        assert!(
            (0.10..=0.50).contains(&ratio),
            "descent ratio {ratio:.3} (powered {:.1} px, free {:.1} px)",
            powered.pos.y,
            free.pos.y
        );
    }

    #[test]
    fn gravity_scale_switches_with_active() {
        let mut s = JetpackState::default();
        assert_eq!(gravity_scale(&s), 1.0);
        s.active = true;
        assert_eq!(gravity_scale(&s), JETPACK_GRAVITY_SCALE);
    }
}
