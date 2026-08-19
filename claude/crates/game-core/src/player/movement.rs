//! Walking, friction, air control and jumping.
//!
//! These functions apply **acceleration only** — they never move the body. Keeping
//! acceleration and integration separate is what lets the jetpack layer its own
//! thrust on top without duplicating any of this, and it is why every force is
//! accumulated into velocity before the body moves once per tick.
//!
//! See `docs/20-player-movement.md` §3, §4.

use crate::constants::{
    AIR_ACCEL_FACTOR, AIR_DRAG, GROUND_FRICTION, JUMP_BUFFER, JUMP_H_BOOST,
    JUMP_VELOCITY, SIM_HZ, WALK_ACCEL, WALK_SPEED,
};
use crate::math::approach;
use crate::physics::body::{Body, COYOTE_TICKS};

/// Jump buffer window in ticks: 0.12 s × 60 Hz = 7.
pub const JUMP_BUFFER_TICKS: u32 = (JUMP_BUFFER * SIM_HZ as f32) as u32;

/// Apply horizontal acceleration for one tick.
///
/// The **target speed** is scaled by `speed_multiplier`, not the acceleration.
/// Scaling acceleration makes a wounded player feel sluggish to control rather than
/// simply slower, which is not what `docs/21-player-stats.md` §3 specifies.
pub fn apply_horizontal(body: &mut Body, dir: f32, speed_multiplier: f32, dt: f32) {
    let target = dir * WALK_SPEED * speed_multiplier;

    let rate = if dir != 0.0 {
        if body.grounded {
            WALK_ACCEL
        } else {
            WALK_ACCEL * AIR_ACCEL_FACTOR
        }
    } else if body.grounded {
        GROUND_FRICTION
    } else {
        // Deliberately much weaker than ground friction: you keep most of your
        // momentum in the air, which is what makes jump-then-steer feel right.
        AIR_DRAG
    };

    body.vel.x = approach(body.vel.x, target, rate * dt);
}

/// Per-player jump bookkeeping. Lives on `PlayerState` (T4.12); defined here
/// because this is the only file that reads or writes it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JumpState {
    pub buffered_ticks: u32,
}

/// Try to jump this tick. Returns true if a jump was launched.
pub fn try_jump(body: &mut Body, jump_state: &mut JumpState, jump_pressed: bool, dir: f32) -> bool {
    // A press that cannot launch is remembered briefly, so a jump pressed just
    // before landing fires on touchdown instead of being swallowed.
    if jump_pressed {
        jump_state.buffered_ticks = JUMP_BUFFER_TICKS;
    }

    let can_launch = body.grounded || body.in_coyote_time();
    let wants = jump_pressed || jump_state.buffered_ticks > 0;

    if !(can_launch && wants) {
        jump_state.buffered_ticks = jump_state.buffered_ticks.saturating_sub(1);
        return false;
    }

    body.vel.y = -JUMP_VELOCITY;
    if dir != 0.0 {
        // Added on top of current walking speed, not replacing it.
        body.vel.x += dir * JUMP_H_BOOST;
    }
    body.grounded = false;
    // Push past the coyote window, or a held jump re-launches on the very next
    // tick — the body is still nominally within coyote time — and the player
    // rockets upward.
    body.airborne_ticks = COYOTE_TICKS + 1;
    jump_state.buffered_ticks = 0;
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{GRAVITY, SIM_DT};
    use crate::math::Vec2;

    fn grounded_body() -> Body {
        let mut b = Body::new(Vec2::ZERO);
        b.grounded = true;
        b
    }

    fn airborne_body() -> Body {
        let mut b = Body::new(Vec2::ZERO);
        b.grounded = false;
        b.airborne_ticks = 100;
        b
    }

    // ---- walking ---------------------------------------------------------

    #[test]
    fn walking_converges_exactly_on_walk_speed() {
        let mut b = grounded_body();
        for _ in 0..600 {
            apply_horizontal(&mut b, 1.0, 1.0, SIM_DT);
        }
        assert_eq!(b.vel.x, WALK_SPEED, "must land exactly on the target");
    }

    #[test]
    fn friction_stops_exactly_at_zero_without_oscillating() {
        let mut b = grounded_body();
        b.vel.x = WALK_SPEED;
        for _ in 0..600 {
            apply_horizontal(&mut b, 0.0, 1.0, SIM_DT);
        }
        assert_eq!(b.vel.x, 0.0);
        // And it stays there.
        apply_horizontal(&mut b, 0.0, 1.0, SIM_DT);
        assert_eq!(b.vel.x, 0.0);
    }

    #[test]
    fn time_to_full_speed_matches_the_acceleration() {
        let mut b = grounded_body();
        let mut ticks = 0;
        while b.vel.x < WALK_SPEED {
            apply_horizontal(&mut b, 1.0, 1.0, SIM_DT);
            ticks += 1;
            assert!(ticks < 1000, "never reached full speed");
        }
        let expected = (WALK_SPEED / WALK_ACCEL) * SIM_HZ as f32;
        assert!(
            (ticks as f32 - expected).abs() <= 1.0,
            "took {ticks} ticks, expected {expected}"
        );
    }

    #[test]
    fn air_acceleration_is_exactly_the_documented_fraction_of_ground() {
        // Measured as the single-tick velocity delta from rest, which is exact.
        // Counting ticks-to-half-speed instead quantises to whole ticks (4 vs 7)
        // and reports a ratio of 1.75 for a true ratio of 1.818 — the test would be
        // measuring rounding, not acceleration.
        let delta = |grounded: bool| {
            let mut b = if grounded {
                grounded_body()
            } else {
                airborne_body()
            };
            apply_horizontal(&mut b, 1.0, 1.0, SIM_DT);
            b.vel.x
        };
        let ratio = delta(false) / delta(true);
        assert!(
            (ratio - AIR_ACCEL_FACTOR).abs() < 1e-5,
            "air/ground acceleration ratio {ratio}, expected {AIR_ACCEL_FACTOR}"
        );
    }

    #[test]
    fn air_drag_is_far_weaker_than_ground_friction() {
        let decel = |grounded: bool| {
            let mut b = if grounded {
                grounded_body()
            } else {
                airborne_body()
            };
            b.vel.x = WALK_SPEED;
            apply_horizontal(&mut b, 0.0, 1.0, SIM_DT);
            WALK_SPEED - b.vel.x
        };
        let ratio = decel(false) / decel(true);
        assert!(
            (ratio - AIR_DRAG / GROUND_FRICTION).abs() < 1e-4,
            "drag ratio {ratio}, expected {}",
            AIR_DRAG / GROUND_FRICTION
        );
    }

    #[test]
    fn reversing_at_full_speed_crosses_zero_and_reaches_full_speed_the_other_way() {
        let mut b = grounded_body();
        b.vel.x = WALK_SPEED;
        let mut ticks = 0;
        while b.vel.x > -WALK_SPEED {
            apply_horizontal(&mut b, -1.0, 1.0, SIM_DT);
            ticks += 1;
            assert!(ticks < 1000);
        }
        assert_eq!(b.vel.x, -WALK_SPEED);
        let expected = (2.0 * WALK_SPEED / WALK_ACCEL) * SIM_HZ as f32;
        assert!(
            (ticks as f32 - expected).abs() <= 1.0,
            "took {ticks}, expected {expected}"
        );
    }

    #[test]
    fn the_speed_multiplier_caps_the_target_not_the_acceleration() {
        let mut b = grounded_body();
        for _ in 0..600 {
            apply_horizontal(&mut b, 1.0, 0.75, SIM_DT);
        }
        assert_eq!(b.vel.x, 0.75 * WALK_SPEED);

        let mut b = grounded_body();
        b.vel.x = WALK_SPEED;
        for _ in 0..600 {
            apply_horizontal(&mut b, 1.0, 0.0, SIM_DT);
        }
        assert_eq!(b.vel.x, 0.0, "a zero multiplier must stop the body");
    }

    #[test]
    fn no_direction_never_accelerates() {
        for start in [-WALK_SPEED, 0.0, WALK_SPEED] {
            let mut b = grounded_body();
            b.vel.x = start;
            apply_horizontal(&mut b, 0.0, 1.0, SIM_DT);
            assert!(
                b.vel.x.abs() <= start.abs(),
                "speed grew from {start} to {}",
                b.vel.x
            );
        }
    }

    #[test]
    fn apply_horizontal_touches_nothing_else() {
        let mut b = grounded_body();
        b.vel.y = 123.0;
        b.pos = Vec2::new(5.0, 6.0);
        apply_horizontal(&mut b, 1.0, 1.0, SIM_DT);
        assert_eq!(b.vel.y, 123.0);
        assert_eq!(b.pos, Vec2::new(5.0, 6.0));
    }

    // ---- jumping ---------------------------------------------------------

    #[test]
    fn a_grounded_press_launches() {
        let mut b = grounded_body();
        let mut j = JumpState::default();
        assert!(try_jump(&mut b, &mut j, true, 0.0));
        assert_eq!(b.vel.y, -JUMP_VELOCITY);
        assert!(!b.grounded);
    }

    #[test]
    fn an_airborne_press_past_coyote_time_does_not_launch() {
        let mut b = airborne_body();
        let mut j = JumpState::default();
        assert!(!try_jump(&mut b, &mut j, true, 0.0));
        assert_eq!(b.vel.y, 0.0);
    }

    #[test]
    fn coyote_time_boundaries() {
        let mut b = Body::new(Vec2::ZERO);
        b.grounded = false;
        b.airborne_ticks = 5;
        let mut j = JumpState::default();
        assert!(try_jump(&mut b, &mut j, true, 0.0), "5 ticks is inside");

        let mut b = Body::new(Vec2::ZERO);
        b.grounded = false;
        b.airborne_ticks = 7;
        let mut j = JumpState::default();
        assert!(!try_jump(&mut b, &mut j, true, 0.0), "7 ticks is outside");
    }

    #[test]
    fn a_standing_jump_adds_no_horizontal_speed() {
        let mut b = grounded_body();
        let mut j = JumpState::default();
        try_jump(&mut b, &mut j, true, 0.0);
        assert_eq!(b.vel.x, 0.0);
    }

    #[test]
    fn a_running_jump_adds_the_boost_on_top_of_walking_speed() {
        let mut b = grounded_body();
        b.vel.x = WALK_SPEED;
        let mut j = JumpState::default();
        try_jump(&mut b, &mut j, true, 1.0);
        assert_eq!(b.vel.x, WALK_SPEED + JUMP_H_BOOST);
    }

    #[test]
    fn holding_jump_launches_exactly_once() {
        let mut b = grounded_body();
        let mut j = JumpState::default();
        let mut launches = 0;
        let mut prev_held = false;

        for _ in 0..60 {
            let held = true;
            let pressed = held && !prev_held;
            if try_jump(&mut b, &mut j, pressed, 0.0) {
                launches += 1;
            }
            prev_held = held;
            // The body stays airborne after launching.
            b.airborne_ticks = b.airborne_ticks.saturating_add(1);
        }
        assert_eq!(launches, 1, "a held jump must not re-launch");
    }

    #[test]
    fn the_jump_buffer_fires_on_landing() {
        let mut b = airborne_body();
        let mut j = JumpState::default();

        // Pressed while airborne: buffered, not launched.
        assert!(!try_jump(&mut b, &mut j, true, 0.0));
        assert!(j.buffered_ticks > 0);

        // 5 ticks later, still airborne, then land.
        for _ in 0..5 {
            assert!(!try_jump(&mut b, &mut j, false, 0.0));
        }
        b.grounded = true;
        assert!(
            try_jump(&mut b, &mut j, false, 0.0),
            "the buffered press should fire on the landing tick"
        );
    }

    #[test]
    fn the_jump_buffer_expires() {
        let mut b = airborne_body();
        let mut j = JumpState::default();
        try_jump(&mut b, &mut j, true, 0.0);

        for _ in 0..15 {
            try_jump(&mut b, &mut j, false, 0.0);
        }
        assert_eq!(j.buffered_ticks, 0, "buffer should have expired");

        b.grounded = true;
        assert!(
            !try_jump(&mut b, &mut j, false, 0.0),
            "an expired buffer must not launch a jump much later"
        );
    }

    #[test]
    fn apex_height_matches_the_analytic_value() {
        // Integrate the launch velocity under gravity with no terrain.
        let mut b = grounded_body();
        let mut j = JumpState::default();
        try_jump(&mut b, &mut j, true, 0.0);

        let start_y = b.pos.y;
        let mut peak = start_y;
        for _ in 0..200 {
            b.vel.y += GRAVITY * SIM_DT;
            b.pos.y += b.vel.y * SIM_DT;
            peak = peak.min(b.pos.y);
        }
        let height = start_y - peak;
        let analytic = JUMP_VELOCITY * JUMP_VELOCITY / (2.0 * GRAVITY);

        // The analytic value is the CONTINUOUS apex. Semi-implicit Euler at 60 Hz
        // undershoots it by about v*dt/2 = 3.6 px, and 62.5 px is what a player
        // actually experiences. Asserting "within 2 px of 66" would be asserting
        // that the game does not use discrete time.
        let euler_shortfall = JUMP_VELOCITY * SIM_DT / 2.0;
        let expected = analytic - euler_shortfall;
        assert!(
            (height - expected).abs() < 1.0,
            "apex {height:.2} px, expected {expected:.2} \
             (analytic {analytic:.2} less the {euler_shortfall:.2} px Euler shortfall)"
        );
    }
}
