//! Sub-stepped movement resolution.
//!
//! **The sub-step cap is a correctness guarantee, not an optimisation.** No step
//! ever exceeds `MAX_SUBSTEP_PX` (1 px), so a body can never skip over a 1-px wall
//! regardless of speed or tick rate. `MAX_SUBSTEPS` (64) bounds the worst case: a
//! body moving faster than 64 px per tick moves slower than requested rather than
//! tunnelling. That trade is correct — a capped speed is recoverable, a body on the
//! wrong side of a wall is not.
//!
//! See `docs/20-player-movement.md` §2.

use crate::constants::{
    GRAVITY, MAX_FALL_SPEED, MAX_SUBSTEPS, MAX_SUBSTEP_PX, STEP_DOWN, STEP_UP, WALL_W,
};
use crate::map::Map;
use crate::math::Vec2;
use crate::physics::body::Body;
use crate::physics::collide::{aabb_overlaps_solid, ground_probe, step_up_clearance};

/// Split a displacement into steps of at most `MAX_SUBSTEP_PX`, capped at
/// `MAX_SUBSTEPS`. Always at least one step, so a zero delta never divides by zero.
///
/// When the cap binds, the **step size stays at 1 px and the body travels less far**
/// than asked. Dividing the full delta by the capped count instead would produce
/// 140-px steps for a fast body and tunnel it straight through a wall — which is
/// precisely the failure this whole mechanism exists to prevent. Moving slower than
/// requested is recoverable; ending up on the far side of a wall is not.
/// **Every moving thing in this crate must call this.** Bodies (M2) and
/// projectiles (M4) each tunnelled through a 1 px wall on their first attempt for
/// the identical reason: the split was re-derived locally, dividing the delta by
/// the *capped* step count, which makes a "sub-step" arbitrarily large once the cap
/// binds. The rule is that the cap bounds distance travelled, not step size — so
/// when it binds the body moves LESS FAR rather than in bigger jumps.
///
/// `no_other_substep_derivation_exists` in the tests below is the guard against a
/// third occurrence.
pub fn substeps(delta: Vec2) -> (u32, Vec2) {
    let dist = delta.x.abs().max(delta.y.abs());
    let ideal = (dist / MAX_SUBSTEP_PX).ceil().max(1.0);
    let per = delta / ideal;
    let steps = (ideal as u32).min(MAX_SUBSTEPS);
    (steps, per)
}

/// Move horizontally by `dx`, resolving collisions and climbing small steps.
/// Returns true if the body was blocked (and `vel.x` zeroed).
pub fn move_x(map: &Map, body: &mut Body, dx: f32) -> bool {
    if dx == 0.0 {
        return false;
    }
    let (steps, per) = substeps(Vec2::new(dx, 0.0));

    // Step-up must not fire while airborne, or a player climbs sheer walls by
    // holding a direction into them.
    let may_step_up = body.grounded || body.in_coyote_time();

    for _ in 0..steps {
        let before = body.pos;
        body.pos.x += per.x;

        if !aabb_overlaps_solid(map, body.aabb()) {
            continue;
        }

        if may_step_up {
            if let Some(lift) = step_up_clearance(map, body.aabb(), STEP_UP) {
                body.pos.y -= lift as f32;
                continue;
            }
        }

        // A wall. Undo and stop — continuing would let step-up be retried each
        // sub-step and walk the body up a sheer face one pixel at a time.
        body.pos = before;
        body.vel.x = 0.0;
        return true;
    }
    false
}

/// Move vertically by `dy`. Sets `grounded` on a downward hit. Returns true if
/// blocked.
pub fn move_y(map: &Map, body: &mut Body, dy: f32) -> bool {
    if dy == 0.0 {
        return false;
    }
    let (steps, per) = substeps(Vec2::new(0.0, dy));
    let downward = dy > 0.0;

    for _ in 0..steps {
        let before = body.pos;
        body.pos.y += per.y;

        if !aabb_overlaps_solid(map, body.aabb()) {
            continue;
        }

        body.pos = before;
        body.vel.y = 0.0;
        if downward {
            body.grounded = true;
        }
        // Upward hits are ceilings: velocity zeroed, nothing else.
        return true;
    }
    false
}

/// After both axes: snap a body that walked off a slope back down, so downhill
/// walking does not become a series of tiny falls.
pub fn ground_snap(map: &Map, body: &mut Body, was_grounded: bool) {
    if !was_grounded || body.grounded || body.vel.y < 0.0 {
        return;
    }
    if aabb_overlaps_solid(map, body.aabb()) {
        return;
    }
    if let Some(drop) = ground_probe(map, body.aabb(), STEP_DOWN) {
        body.pos.y += drop as f32;
        body.grounded = true;
    }
}

/// Gravity with terminal velocity.
///
/// Clamped on the way **down only**. Upward velocity is not clamped, so a strong
/// knockback still launches properly.
pub fn apply_gravity(body: &mut Body, gravity_scale: f32, dt: f32) {
    if gravity_scale == 0.0 {
        return;
    }
    body.vel.y += GRAVITY * gravity_scale * dt;
    if body.vel.y > MAX_FALL_SPEED {
        body.vel.y = MAX_FALL_SPEED;
    }
}

/// Clamp the body inside the world (`docs/70-amendments-v2.md` §A1).
///
/// The arena is bounded and reaching its edge stops you. The `WALL_W` columns are
/// indestructible so collision already handles the sides in practice, but the clamp
/// is what guarantees it after a knockback or a jetpack burn — and the ceiling at
/// `y = 0` has no terrain behind it at all, so without this a jetpack simply leaves
/// the world.
pub fn clamp_to_world(map: &Map, body: &mut Body) {
    let half_w = body.size.x / 2.0;
    let min_x = WALL_W as f32 + half_w;
    let max_x = map.mask.w as f32 - WALL_W as f32 - half_w;

    if body.pos.x < min_x {
        body.pos.x = min_x;
        body.vel.x = body.vel.x.max(0.0);
    } else if body.pos.x > max_x {
        body.pos.x = max_x;
        body.vel.x = body.vel.x.min(0.0);
    }

    // Hard ceiling: the body's top edge may not pass y = 0.
    let min_y = body.size.y / 2.0;
    if body.pos.y < min_y {
        body.pos.y = min_y;
        body.vel.y = body.vel.y.max(0.0);
    }
}

/// The full per-tick movement step.
///
/// The order is part of the contract:
/// 1. record `was_grounded`;
/// 2. clear `grounded` — it must be re-established this tick, not inherited, which
///    is what makes walking off a ledge register immediately and coyote time mean
///    anything;
/// 3. gravity;
/// 4. X then Y — X first, so a body sliding into a slope climbs it before gravity
///    pulls it into the face;
/// 5. ground snap;
/// 6. world clamp;
/// 7. airborne bookkeeping.
///
/// **Returns the landing impact** (T20.11): the downward speed at the moment the
/// body touched down, or `0.0` on any tick that is not a landing. Also written to
/// `body.landing_impact`; the return is a read-back of that field, for a caller
/// that has the return value in hand and should not have to know where it lives.
///
/// ## The naive detector is exactly inverted, and this is why
///
/// A caller cannot compute this itself from what `integrate` leaves behind,
/// because the two ways a body becomes grounded have **opposite** velocity
/// semantics:
///
///  - `move_y` — a real landing — sets `vel.y = 0.0` **and then** `grounded`, so
///    the tick ends at `vel.y == 0`;
///  - `ground_snap` — walking downhill, which must never hurt — sets `grounded`
///    and **does not touch `vel.y`**, so the tick ends at one tick of gravity,
///    small but **nonzero**.
///
/// So "grounded went true this tick, read `vel.y`" reads **zero on every real
/// landing and nonzero on every downhill step**. It does not merely leak into
/// `ground_snap`; it reads *only* `ground_snap`. The impact has to be captured
/// before `move_y` runs, which is what happens below, and `ground_snap` cannot
/// produce one because it only fires when `was_grounded` was already true.
pub fn integrate(map: &Map, body: &mut Body, gravity_scale: f32, dt: f32) -> f32 {
    let was_grounded = body.grounded;
    body.grounded = false;
    body.landing_impact = 0.0;

    apply_gravity(body, gravity_scale, dt);

    move_x(map, body, body.vel.x * dt);

    // Captured **before** `move_y`, which is the whole trick: this is the speed
    // the body is actually travelling at when it meets the ground, and `move_y`
    // is about to overwrite it with zero.
    let falling_at = body.vel.y;
    let blocked = move_y(map, body, body.vel.y * dt);
    // `move_y` sets `grounded` only on a *downward* block, so `body.grounded`
    // here distinguishes a floor from a ceiling without a second flag; and
    // `!was_grounded` is what makes this a landing rather than a body resting on
    // the floor, which is blocked downward on every tick of its life.
    if blocked && body.grounded && !was_grounded {
        body.landing_impact = falling_at.max(0.0);
    }

    ground_snap(map, body, was_grounded);
    clamp_to_world(map, body);

    if body.grounded {
        body.airborne_ticks = 0;
    } else {
        body.airborne_ticks = body.airborne_ticks.saturating_add(1);
    }
    body.landing_impact
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{GRAVITY, PLAYER_H, PLAYER_W, SIM_DT, STEP_DOWN, WALK_SPEED};
    use crate::map::Mask;
    use crate::physics::collide::tests::{floor_at, test_map};

    const W: u32 = 512;
    const H: u32 = 512;

    fn body_resting_on(floor_y: i32, x: f32) -> Body {
        let mut b = Body::new(Vec2::new(x, floor_y as f32 - PLAYER_H / 2.0));
        b.grounded = true;
        b
    }

    // ---- landing impact (T20.11) ----------------------------------------
    //
    // `integrate` is the only place that can measure this, because `move_y`
    // destroys `vel.y` on the way past. These tests pin the number and, more
    // importantly, pin the **two paths apart**: a real landing and a downhill
    // snap both end the tick grounded, and the obvious way to tell them apart
    // reads exactly the wrong one.

    /// A staircase descending to the right: `drop_per` px every `run` columns.
    fn slope_down(top: i32, run: i32, drop_per: i32) -> impl FnOnce(&mut Mask) {
        move |m: &mut Mask| {
            let cols = m.w as i32;
            for x in 0..cols {
                let y = top + (x / run) * drop_per;
                for fy in y.min(m.h as i32 - 1)..m.h as i32 {
                    m.set(x, fy);
                }
            }
        }
    }

    /// Drop a body from `h` px up and return the impact `integrate` reported.
    fn drop_from(h: f32) -> (f32, u32) {
        let map = test_map(W, H, floor_at(400));
        let mut b = Body::new(Vec2::new(256.0, 400.0 - PLAYER_H / 2.0 - h));
        for t in 0..600 {
            let got = integrate(&map, &mut b, 1.0, SIM_DT);
            if got > 0.0 {
                return (got, t);
            }
        }
        (0.0, u32::MAX)
    }

    #[test]
    fn a_landing_reports_the_speed_it_was_falling_at() {
        // Against the closed form, not against a recorded number: `v = sqrt(2gh)`
        // with one tick of discretisation slack either side. A hardcoded 537
        // would go stale the day `GRAVITY` moves.
        for h in [64.0f32, 128.0, 256.0] {
            let want = (2.0 * GRAVITY * h).sqrt();
            let (got, _) = drop_from(h);
            let slack = GRAVITY * SIM_DT;
            assert!(
                (got - want).abs() <= slack,
                "a {h} px drop reported {got:.1} px/s against {want:.1} +/- {slack:.1}"
            );
        }
    }

    #[test]
    fn the_impact_is_reported_on_exactly_one_tick_and_is_zero_on_the_others() {
        // The control the test above needs: a number that is correct on the
        // landing tick and *also* nonzero while falling would make every
        // airborne tick a landing.
        let map = test_map(W, H, floor_at(400));
        let mut b = Body::new(Vec2::new(256.0, 400.0 - PLAYER_H / 2.0 - 200.0));
        let mut reports = 0;
        let mut airborne_reports = 0;
        for _ in 0..600 {
            let before = b.grounded;
            let got = integrate(&map, &mut b, 1.0, SIM_DT);
            if got > 0.0 {
                reports += 1;
                if before {
                    airborne_reports += 1;
                }
            }
            assert_eq!(got, b.landing_impact, "the return disagreed with the field");
        }
        assert_eq!(reports, 1, "one fall reported {reports} landings");
        assert_eq!(airborne_reports, 0);
        assert_eq!(
            b.landing_impact, 0.0,
            "the last tick still claims a landing"
        );
    }

    #[test]
    fn a_body_resting_on_the_floor_never_reports_a_landing() {
        // It is blocked downward on **every** tick of its life, so a detector
        // that only looked at `move_y` returning true would charge it rent.
        let map = test_map(W, H, floor_at(400));
        let mut b = body_resting_on(400, 256.0);
        for _ in 0..120 {
            assert_eq!(integrate(&map, &mut b, 1.0, SIM_DT), 0.0);
        }
    }

    #[test]
    fn walking_downhill_reports_no_landing_although_it_is_descending() {
        // **The `ground_snap` path**, which must never hurt. The control is the
        // descent itself: without it this passes for a body that walked into a
        // wall and never went anywhere, which is what a first draft of this test
        // actually did on a generated map.
        let map = test_map(W, H, slope_down(300, 8, STEP_DOWN - 2));
        let mut b = body_resting_on(300, 16.0);
        let y0 = b.pos.y;
        let x0 = b.pos.x;
        let mut reports = 0;
        for _ in 0..240 {
            b.vel.x = WALK_SPEED;
            if integrate(&map, &mut b, 1.0, SIM_DT) > 0.0 {
                reports += 1;
            }
        }
        assert!(
            b.pos.x - x0 > PLAYER_W * 4.0,
            "the body only travelled {:.0} px, so it never walked downhill",
            b.pos.x - x0
        );
        assert!(
            b.pos.y - y0 > PLAYER_H,
            "the body only descended {:.0} px",
            b.pos.y - y0
        );
        assert_eq!(reports, 0, "walking downhill reported {reports} landing(s)");
    }

    /// **The naive detector is inverted, and this is the proof.**
    ///
    /// The obvious rule — *"the body is on the ground and still moving down, so it
    /// just hit something"* — is `grounded && vel.y > 0` at the end of a tick.
    /// Measured, it is exactly backwards:
    ///
    ///  - on a **real landing** `move_y` sets `vel.y = 0.0` and *then* `grounded`,
    ///    so the tick ends at `vel.y == 0` and the rule is **false**;
    ///  - while **walking downhill** `ground_snap` sets `grounded` and never
    ///    touches `vel.y`, so the tick ends at one tick of gravity and the rule is
    ///    **true**.
    ///
    /// Zero damage on every fall, damage on every downhill step. Locked here so
    /// nobody re-derives it the wrong way round — and note that the edge-triggered
    /// variant (*"grounded went true this tick"*) is no better in the other
    /// direction: a downhill walker is grounded at the end of every tick, so the
    /// edge never fires at all and `ground_snap` is invisible to it.
    #[test]
    fn the_obvious_detector_reads_exactly_the_wrong_one() {
        let flat = test_map(W, H, floor_at(400));
        let mut falling = Body::new(Vec2::new(256.0, 400.0 - PLAYER_H / 2.0 - 200.0));
        let mut landing_says = None;
        for _ in 0..600 {
            let real = integrate(&flat, &mut falling, 1.0, SIM_DT) > 0.0;
            if real {
                landing_says = Some(falling.grounded && falling.vel.y > 0.0);
                break;
            }
        }
        assert_eq!(
            landing_says,
            Some(false),
            "the naive rule fired on a real landing — then it is not inverted after all"
        );

        let hill = test_map(W, H, slope_down(300, 8, STEP_DOWN - 2));
        let mut walking = body_resting_on(300, 16.0);
        let mut naive_fired = 0;
        let mut real_landings = 0;
        for _ in 0..240 {
            walking.vel.x = WALK_SPEED;
            if integrate(&hill, &mut walking, 1.0, SIM_DT) > 0.0 {
                real_landings += 1;
            }
            if walking.grounded && walking.vel.y > 0.0 {
                naive_fired += 1;
            }
        }
        assert_eq!(real_landings, 0, "walking downhill is not a landing");
        assert!(
            naive_fired > 0,
            "the naive rule never fired walking downhill — then this test is not \
             demonstrating the inversion and the slope is wrong"
        );
    }

    // ---- substeps --------------------------------------------------------

    #[test]
    fn substep_counts() {
        assert_eq!(substeps(Vec2::new(0.5, 0.0)).0, 1);
        assert_eq!(substeps(Vec2::new(10.0, 0.0)).0, 10);
        assert_eq!(substeps(Vec2::new(-10.0, 0.0)).0, 10);
        assert_eq!(substeps(Vec2::new(1000.0, 0.0)).0, MAX_SUBSTEPS);
        assert_eq!(substeps(Vec2::ZERO).0, 1, "must never divide by zero");

        let (n, per) = substeps(Vec2::new(10.0, 0.0));
        assert!((per.x - 1.0).abs() < 1e-6, "per-step should be 1 px");
        assert!((per.x * n as f32 - 10.0).abs() < 1e-4);

        // When the cap binds, the STEP stays 1 px and the distance is truncated.
        // Dividing the delta by the capped count would give 15.6 px steps here.
        let (n, per) = substeps(Vec2::new(1000.0, 0.0));
        assert_eq!(n, MAX_SUBSTEPS);
        assert!(per.x.abs() <= MAX_SUBSTEP_PX + 1e-6, "step of {} px", per.x);
        assert!((per.x * n as f32).abs() <= MAX_SUBSTEPS as f32 + 1.0);

        // Every input, however extreme, yields a sub-MAX_SUBSTEP_PX step.
        for d in [0.1f32, 1.0, 63.0, 64.0, 65.0, 1e4, 1e6] {
            for v in [Vec2::new(d, 0.0), Vec2::new(0.0, d), Vec2::new(d, d)] {
                let (_, per) = substeps(v);
                assert!(
                    per.x.abs() <= MAX_SUBSTEP_PX + 1e-6 && per.y.abs() <= MAX_SUBSTEP_PX + 1e-6,
                    "delta {v:?} gave a step of {per:?}"
                );
            }
        }
    }

    // ---- move_x ----------------------------------------------------------

    #[test]
    fn moving_in_open_air_covers_the_full_distance() {
        let map = test_map(W, H, floor_at(400));
        let mut b = Body::new(Vec2::new(100.0, 100.0));
        assert!(!move_x(&map, &mut b, 20.0));
        assert!((b.pos.x - 120.0).abs() < 1e-3, "at {}", b.pos.x);
    }

    #[test]
    fn a_twenty_px_wall_stops_the_body_against_it() {
        let map = test_map(W, H, |m| {
            floor_at(200)(m);
            for y in 180..200 {
                m.set_run(y, 300, 320);
            }
        });
        // Walk in at a realistic per-tick step rather than one 200 px jump: the
        // substep cap deliberately truncates a single huge move to 64 px.
        let mut b = body_resting_on(200, 200.0);
        b.vel.x = WALK_SPEED;
        let mut blocked = false;
        for _ in 0..200 {
            if move_x(&map, &mut b, WALK_SPEED * SIM_DT) {
                blocked = true;
                break;
            }
        }
        assert!(blocked, "should be blocked");
        assert_eq!(b.vel.x, 0.0);

        // Against the wall, not 5 px short and not embedded.
        let gap = 300.0 - (b.pos.x + PLAYER_W / 2.0);
        assert!((0.0..=1.5).contains(&gap), "stopped {gap} px from the wall");
        assert!(!aabb_overlaps_solid(&map, b.aabb()), "embedded in the wall");
    }

    #[test]
    fn a_four_px_step_is_climbed_and_a_seven_px_step_is_not() {
        let map = test_map(W, H, |m| {
            floor_at(200)(m);
            for y in 196..200 {
                m.set_run(y, 300, 511);
            }
        });
        let mut b = body_resting_on(200, 290.0);
        b.vel.x = WALK_SPEED;
        let start_vx = b.vel.x;
        assert!(!move_x(&map, &mut b, 20.0), "a 4 px step should be climbed");
        assert!(
            (b.pos.y - (196.0 - PLAYER_H / 2.0)).abs() < 1.5,
            "y {}",
            b.pos.y
        );
        assert_eq!(b.vel.x, start_vx, "climbing must not cost speed");

        let map7 = test_map(W, H, |m| {
            floor_at(200)(m);
            for y in 193..200 {
                m.set_run(y, 300, 511);
            }
        });
        let mut b = body_resting_on(200, 290.0);
        b.vel.x = WALK_SPEED;
        assert!(move_x(&map7, &mut b, 20.0), "a 7 px step is a wall");
        assert_eq!(b.vel.x, 0.0);
    }

    #[test]
    fn step_up_does_not_fire_while_airborne() {
        // Otherwise a player climbs sheer walls by holding a direction into them.
        let map = test_map(W, H, |m| {
            floor_at(200)(m);
            for y in 196..200 {
                m.set_run(y, 300, 511);
            }
        });
        let mut b = body_resting_on(200, 290.0);
        b.grounded = false;
        b.airborne_ticks = 100; // well past coyote time
        assert!(move_x(&map, &mut b, 20.0), "airborne must be blocked");
    }

    #[test]
    fn moving_left_mirrors_every_case() {
        let map = test_map(W, H, |m| {
            floor_at(200)(m);
            for y in 180..200 {
                m.set_run(y, 100, 120);
            }
        });
        let mut b = body_resting_on(200, 250.0);
        b.vel.x = -WALK_SPEED;
        let mut blocked = false;
        for _ in 0..200 {
            if move_x(&map, &mut b, -WALK_SPEED * SIM_DT) {
                blocked = true;
                break;
            }
        }
        assert!(blocked);
        assert_eq!(b.vel.x, 0.0);
        let gap = (b.pos.x - PLAYER_W / 2.0) - 121.0;
        assert!((0.0..=1.5).contains(&gap), "stopped {gap} px from the wall");
    }

    #[test]
    fn no_horizontal_tunnelling_through_a_one_px_wall() {
        for dir in [1.0f32, -1.0] {
            let wall_x = if dir > 0.0 { 300 } else { 100 };
            let map = test_map(W, H, move |m| {
                floor_at(200)(m);
                for y in 150..200 {
                    m.set(wall_x, y);
                }
            });
            let mut b = body_resting_on(200, 200.0);
            b.vel.x = dir * 10.0 * WALK_SPEED;
            for _ in 0..400 {
                let dx = b.vel.x * SIM_DT;
                move_x(&map, &mut b, dx);
            }
            // Never on the far side of the wall.
            if dir > 0.0 {
                assert!(
                    b.pos.x + PLAYER_W / 2.0 <= wall_x as f32 + 1.0,
                    "tunnelled right to {}",
                    b.pos.x
                );
            } else {
                assert!(
                    b.pos.x - PLAYER_W / 2.0 >= wall_x as f32,
                    "tunnelled left to {}",
                    b.pos.x
                );
            }
        }
    }

    #[test]
    fn an_embedded_body_does_not_burrow_further() {
        let map = test_map(W, H, |m| {
            for y in 0..H as i32 {
                m.set_run(y, 0, W as i32 - 1);
            }
        });
        let mut b = Body::new(Vec2::new(200.0, 200.0));
        let before = b.pos;
        assert!(move_x(&map, &mut b, 20.0));
        assert_eq!(b.pos, before);
    }

    // ---- move_y ----------------------------------------------------------

    #[test]
    fn falling_onto_a_floor_grounds_the_body() {
        let map = test_map(W, H, floor_at(300));
        let mut b = Body::new(Vec2::new(100.0, 100.0));
        b.vel.y = 500.0;
        let mut blocked = false;
        for _ in 0..300 {
            if move_y(&map, &mut b, 500.0 * SIM_DT) {
                blocked = true;
                break;
            }
        }
        assert!(blocked, "never reached the floor");
        assert!(b.grounded);
        assert_eq!(b.vel.y, 0.0);
        assert!((b.feet_y() - 300.0).abs() <= 1.5, "feet at {}", b.feet_y());
    }

    #[test]
    fn hitting_a_ceiling_zeroes_velocity_without_grounding() {
        let map = test_map(W, H, |m| {
            floor_at(400)(m);
            for y in 100..120 {
                m.set_run(y, 0, W as i32 - 1);
            }
        });
        // Head starts at 186; the ceiling's underside is y = 119, so the head has
        // 67 px to travel. Step it in tick-sized moves.
        let mut b = Body::new(Vec2::new(100.0, 200.0));
        b.vel.y = -500.0;
        let mut blocked = false;
        for _ in 0..60 {
            if move_y(&map, &mut b, -500.0 * SIM_DT) {
                blocked = true;
                break;
            }
        }
        assert!(blocked, "never reached the ceiling, head at {}", b.head_y());
        assert_eq!(b.vel.y, 0.0);
        assert!(!b.grounded, "a ceiling must not ground the body");
        assert!(!aabb_overlaps_solid(&map, b.aabb()));
    }

    #[test]
    fn no_vertical_tunnelling_through_a_one_px_floor() {
        for dir in [1.0f32, -1.0] {
            let surface = if dir > 0.0 { 300 } else { 100 };
            let map = test_map(W, H, move |m| {
                m.set_run(surface, 0, W as i32 - 1);
            });
            let mut b = Body::new(Vec2::new(100.0, 200.0));
            b.vel.y = dir * 10.0 * MAX_FALL_SPEED;
            for _ in 0..400 {
                let dy = b.vel.y * SIM_DT;
                move_y(&map, &mut b, dy);
            }
            if dir > 0.0 {
                assert!(
                    b.feet_y() <= surface as f32 + 1.0,
                    "fell through to {}",
                    b.pos.y
                );
            } else {
                assert!(b.head_y() >= surface as f32, "rose through to {}", b.pos.y);
            }
        }
    }

    // ---- gravity ---------------------------------------------------------

    #[test]
    fn gravity_clamps_downward_only() {
        let mut b = Body::new(Vec2::ZERO);
        for _ in 0..600 {
            apply_gravity(&mut b, 1.0, SIM_DT);
        }
        assert_eq!(b.vel.y, MAX_FALL_SPEED, "terminal velocity after 10 s");

        // Upward velocity is untouched, so knockback still launches.
        let mut b = Body::new(Vec2::ZERO);
        b.vel.y = -3000.0;
        apply_gravity(&mut b, 1.0, SIM_DT);
        assert!(b.vel.y < -2900.0);
    }

    #[test]
    fn gravity_scale_zero_leaves_velocity_alone() {
        let mut b = Body::new(Vec2::ZERO);
        b.vel.y = 42.0;
        apply_gravity(&mut b, 0.0, SIM_DT);
        assert_eq!(b.vel.y, 42.0);
    }

    // ---- integrate -------------------------------------------------------

    #[test]
    fn a_resting_body_is_bit_identical_after_600_ticks() {
        // A drift of 0.001 px per tick is a real bug that an approximate assertion
        // would hide.
        let map = test_map(W, H, floor_at(300));
        let mut b = body_resting_on(300, 100.0);
        integrate(&map, &mut b, 1.0, SIM_DT); // settle
        let settled = b.pos;

        for tick in 0..600 {
            integrate(&map, &mut b, 1.0, SIM_DT);
            assert_eq!(b.pos, settled, "drifted at tick {tick}");
            assert!(b.grounded, "lost grounding at tick {tick}");
        }
    }

    #[test]
    fn a_dropped_body_lands_and_stops() {
        let map = test_map(W, H, floor_at(300));
        let mut b = Body::new(Vec2::new(100.0, 100.0));
        for _ in 0..300 {
            integrate(&map, &mut b, 1.0, SIM_DT);
        }
        assert!(b.grounded);
        assert_eq!(b.vel.y, 0.0);
        assert!((b.feet_y() - 300.0).abs() <= 1.5);
    }

    #[test]
    fn walking_down_a_thirty_degree_slope_stays_grounded_every_tick() {
        // The ground-snap test, and the one that matters most: without the snap,
        // every downhill step is a brief fall and `grounded` flickers, which breaks
        // jump input.
        let map = test_map(1024, 512, |m| {
            for x in 0..1024 {
                let surface = 200 + (x as f32 * 0.577) as i32;
                for y in surface..512 {
                    m.set(x, y);
                }
            }
        });
        // The surface at x = 60 is 200 + 60*0.577, not 200.
        let start_x = 60.0f32;
        let surface = 200 + (start_x * 0.577) as i32;
        let mut b = body_resting_on(surface, start_x);
        integrate(&map, &mut b, 1.0, SIM_DT);
        assert!(b.grounded, "precondition: not standing on the slope");

        // Stop before the slope runs off the bottom of the map: at 0.577 rise per
        // px it reaches y = 512 at x ~ 540.
        for tick in 0..150 {
            b.vel.x = WALK_SPEED;
            integrate(&map, &mut b, 1.0, SIM_DT);
            assert!(
                b.grounded,
                "went airborne at tick {tick}, x = {}, y = {}",
                b.pos.x, b.pos.y
            );
            assert!(b.pos.x < 450.0, "walked past the usable slope");
        }
        assert!(b.pos.x > 300.0, "did not actually travel: x = {}", b.pos.x);
    }

    #[test]
    fn walking_off_a_ledge_becomes_airborne_immediately() {
        let map = test_map(W, H, |m| {
            for y in 300..H as i32 {
                m.set_run(y, 0, 250);
            }
        });
        let mut b = body_resting_on(300, 200.0);
        integrate(&map, &mut b, 1.0, SIM_DT);
        assert!(b.grounded, "precondition");

        let mut went_airborne = None;
        for tick in 0..120 {
            b.vel.x = WALK_SPEED;
            integrate(&map, &mut b, 1.0, SIM_DT);
            if !b.grounded {
                went_airborne = Some(tick);
                break;
            }
        }
        let tick = went_airborne.expect("never left the ledge");
        assert!(
            b.airborne_ticks >= 1,
            "airborne_ticks did not start counting"
        );
        assert!(
            b.pos.x > 250.0 - PLAYER_W,
            "left the ledge too early at tick {tick}"
        );
    }

    #[test]
    fn a_step_taller_than_step_down_makes_the_body_airborne() {
        let map = test_map(W, H, |m| {
            for y in 300..H as i32 {
                m.set_run(y, 0, 250);
            }
            // The lower level is 20 px below, more than STEP_DOWN.
            for y in 320..H as i32 {
                m.set_run(y, 251, W as i32 - 1);
            }
        });
        let mut b = body_resting_on(300, 240.0);
        integrate(&map, &mut b, 1.0, SIM_DT);

        let mut saw_airborne = false;
        for _ in 0..60 {
            b.vel.x = WALK_SPEED;
            integrate(&map, &mut b, 1.0, SIM_DT);
            if !b.grounded {
                saw_airborne = true;
            }
        }
        assert!(saw_airborne, "a 20 px drop should not be snapped down");
    }

    #[test]
    fn a_body_in_a_tight_gap_does_not_oscillate() {
        // Floor at 300, ceiling exactly PLAYER_H + 1 above it.
        let map = test_map(W, H, |m| {
            floor_at(300)(m);
            for y in 0..(300 - PLAYER_H as i32 - 1) {
                m.set_run(y, 0, W as i32 - 1);
            }
        });
        let mut b = body_resting_on(300, 100.0);
        integrate(&map, &mut b, 1.0, SIM_DT);

        let mut flips = 0;
        let mut last = b.grounded;
        for _ in 0..600 {
            integrate(&map, &mut b, 1.0, SIM_DT);
            if b.grounded != last {
                flips += 1;
                last = b.grounded;
            }
        }
        assert_eq!(flips, 0, "grounded flickered {flips} times in a tight gap");
    }

    #[test]
    fn no_tunnelling_at_ten_times_terminal_velocity_through_integrate() {
        let map = test_map(W, H, |m| m.set_run(300, 0, W as i32 - 1));
        let mut b = Body::new(Vec2::new(100.0, 100.0));
        b.vel.y = 10.0 * MAX_FALL_SPEED;
        for _ in 0..10 {
            integrate(&map, &mut b, 1.0, SIM_DT);
        }
        assert!(b.feet_y() <= 301.0, "tunnelled to y = {}", b.pos.y);
    }

    // ---- world limits (docs/70-amendments-v2.md A1) -----------------------

    #[test]
    fn the_body_cannot_leave_the_world_sideways() {
        let map = test_map(W, H, floor_at(300));
        let half = PLAYER_W / 2.0;

        let mut b = body_resting_on(300, 100.0);
        b.vel.x = -5000.0;
        for _ in 0..60 {
            integrate(&map, &mut b, 1.0, SIM_DT);
        }
        assert!(
            b.pos.x >= WALL_W as f32 + half - 0.001,
            "escaped left to {}",
            b.pos.x
        );
        assert!(b.vel.x >= 0.0, "velocity into the wall was not cleared");

        let mut b = body_resting_on(300, 400.0);
        b.vel.x = 5000.0;
        for _ in 0..60 {
            integrate(&map, &mut b, 1.0, SIM_DT);
        }
        assert!(
            b.pos.x <= W as f32 - WALL_W as f32 - half + 0.001,
            "escaped right to {}",
            b.pos.x
        );
        assert!(b.vel.x <= 0.0);
    }

    #[test]
    fn a_jetpack_cannot_leave_the_world_through_the_ceiling() {
        let map = test_map(W, H, floor_at(400));
        let mut b = Body::new(Vec2::new(100.0, 200.0));
        b.vel.y = -5000.0;
        for _ in 0..120 {
            integrate(&map, &mut b, 0.35, SIM_DT);
        }
        assert!(
            b.head_y() >= -0.001,
            "left the world through the ceiling: head at {}",
            b.head_y()
        );
        assert!(
            b.vel.y >= 0.0,
            "upward velocity was not cleared at the ceiling"
        );
    }

    #[test]
    fn the_world_clamp_does_not_disturb_a_body_in_open_space() {
        let map = test_map(W, H, floor_at(300));
        let mut b = Body::new(Vec2::new(200.0, 150.0));
        b.vel = Vec2::new(50.0, -20.0);
        let before = b;
        clamp_to_world(&map, &mut b);
        assert_eq!(b, before);
    }
}

#[cfg(test)]
mod substep_guard {
    /// Nothing outside this module may derive its own sub-step count.
    ///
    /// This has been the same bug twice — M2's bodies and M4's projectiles both
    /// tunnelled through a 1 px wall because the split was recomputed file-locally.
    /// A comment asking people not to is not a guard; this is. It reads the crate's
    /// own source, so a third re-derivation fails the suite rather than shipping
    /// and being found by a tunnelling test that may not exist for that mover.
    #[test]
    fn no_other_substep_derivation_exists() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        let mut offenders = Vec::new();
        let mut stack = vec![std::path::PathBuf::from(root)];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("read src") {
                let path = entry.expect("entry").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                // `resolve.rs` is where the one derivation lives, and
                // `constants.rs` is where the values are declared.
                let name = path.file_name().and_then(|f| f.to_str());
                if name == Some("resolve.rs") || name == Some("constants.rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).expect("read file");
                for (i, line) in text.lines().enumerate() {
                    let l = line.trim();
                    if l.starts_with("//") {
                        continue;
                    }
                    if l.contains("MAX_SUBSTEP_PX") || l.contains("MAX_SUBSTEPS") {
                        offenders.push(format!("{}:{}: {l}", path.display(), i + 1));
                    }
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "sub-step constants used outside physics::resolve — call substeps() \
             instead. Dividing a delta by the capped count is how bodies and \
             projectiles each tunnelled through a 1 px wall:\n{}",
            offenders.join("\n")
        );
    }
}
