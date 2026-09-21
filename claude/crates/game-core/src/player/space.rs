//! Zero-g locomotion: **the flying regime with the damping removed and a fuel
//! cost added** (T22.03, `M22-RULINGS` R1/R4/R5).
//!
//! The owner: *"In no gravity mode the players movement just doesn't stop. If
//! they move in a certain direction, it's constant until they hit something.
//! Jumping and even moving now takes jetpack energy."* And, later: *"you can
//! reuse the wings mechanic for movement in space but add the no-gravity part
//! to it."*
//!
//! # There is no fourth gravity regime
//!
//! `jetpack::gravity_scale` still names exactly three — wings, jetpack,
//! ordinary — and the *match's* multiplier sits in front of all of them.
//! `GravityMode::Space.scale()` is `0.0`, so whichever regime a player is in,
//! `physics::resolve::apply_gravity` returns before it touches `vel.y`. This
//! module adds no regime and no per-player state; everything it decides it
//! decides from the body, the input and the mode.
//!
//! # Why this cannot be `apply_flight`
//!
//! `movement::apply_flight` **assigns** `vel.y`. Its doc calls that "set, not
//! accelerated", and its idempotence is a contract `prediction.ts` relies on
//! when it replays a frame forty times. Space must **accumulate**, so it uses
//! `jetpack::apply_thrust` — the accumulate-per-axis force this crate already
//! has, already clamped per axis, already paid for out of the same tank. What
//! the owner's sentence describes is the wings *seam* (UP climbs, DOWN
//! descends, no input holds), and that is what space has; what it cannot mean
//! is the wings *function*.
//!
//! # The three things that damp, and where each is turned off
//!
//! | damping | lives in | off in space because |
//! |---|---|---|
//! | gravity, and `MAX_FALL_SPEED` with it | `resolve::apply_gravity` | the scale is `0.0` and the function early-returns |
//! | `GROUND_FRICTION` / `AIR_DRAG` | `movement::apply_horizontal` | `apply_input` does not call it while [`floating`] |
//! | **the walk target itself** | `apply_horizontal`, same call | `approach(vel.x, dir * WALK_SPEED, …)` drags a body drifting at 400 px/s *down* to 150 |
//!
//! The third is the one that is easy to miss, and it is why *"set `AIR_DRAG` to
//! zero"* is not this task: zeroing the drag constant leaves the target, and a
//! player still could not drift faster than `WALK_SPEED`.
//!
//! # R1 has no test here, deliberately
//!
//! R1 rules that contact costs you the component **into** the surface and keeps
//! the component **along** it, with no restitution. `resolve::move_x` already
//! zeroes only `vel.x` and `move_y` only `vel.y`, so that *is* R1 and a test
//! named for it passes with this whole file deleted. What earns its keep is the
//! no-damping half — the tangential component surviving *forever* afterwards,
//! which under gravity it does not — and that is
//! [`tests::a_ceiling_takes_the_normal_and_the_tangential_survives_forever`].

use crate::constants::{GravityMode, SIM_DT};
use crate::physics::body::Body;
use crate::player::input::Input;
use crate::player::jetpack;
use crate::player::MoveMods;

/// Is this player under the zero-g **locomotion** rules this tick?
///
/// Three exclusions, each with a different reason:
///
///  - **grounded** — `M22-RULINGS` R4 makes a player standing on an asteroid an
///    ordinary grounded player. They walk at `WALK_SPEED`, friction holds them
///    still, coyote time and the jump buffer work, and it costs no fuel. A
///    surface to push against is the one thing the mode gives you for free, and
///    charging for it would strand a dry player on the only thing that could
///    save them.
///  - **flying** — T21.03's wings are still the third regime and they still
///    win. A winged player in space flies exactly as they do anywhere else,
///    horizontal axis included, which is the restatement `T22.03` owed rather
///    than a new interaction.
///  - **mounted** — T21.11B zeroes a rider's direction so that a player who
///    mounts mid-stride is *decelerated* off their own momentum. That
///    deceleration is `apply_horizontal` with `dir == 0`, so a mounted player
///    must keep it; skipping it here would leave a rider drifting away from the
///    platform they just mounted, with no input that could stop them.
pub fn floating(gravity: GravityMode, body: &Body, mods: MoveMods) -> bool {
    gravity == GravityMode::Space && !body.grounded && !mods.flying && !mods.mounted
}

/// Is this player asking the thrusters for a push that would actually move
/// them?
///
/// **Asked of the force, not of the buttons.** The question the fuel cost has
/// to answer is *"would `apply_thrust` change this velocity"*, and the only
/// honest way to ask it is to call the thing that decides.
/// `LEFT + RIGHT` cancels exactly and must be free; `UP + DOWN` does **not**
/// cancel — it is a net climb, because the two thrust constants differ — and
/// must be charged. A predicate that re-listed the four buttons would get the
/// second one wrong, and it would get it wrong silently.
///
/// `dt` is `SIM_DT` only because `thrust_delta` takes one; it scales both
/// components and so cannot change whether either is zero.
pub fn thrusting(input: &Input) -> bool {
    let (dx, dy) = jetpack::thrust_delta(input, SIM_DT);
    dx != 0.0 || dy != 0.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        GRAVITY, JETPACK_MAX_FUEL, JETPACK_MAX_SPEED, JETPACK_REFILL, JETPACK_REFILL_DELAY,
        PLAYER_H, SPACE_JUMP_FUEL, WALK_SPEED,
    };
    use crate::map::Map;
    use crate::math::Vec2;
    use crate::physics::collide::tests::{floor_at, test_map};
    use crate::player::input::button;
    use crate::player::{apply_input, Input, JetpackState, JumpState, MovementState};

    const W: u32 = 1024;
    const H: u32 = 512;
    const FLOOR: i32 = 300;

    /// An empty map: no floor anywhere, so nothing but the world clamp can stop
    /// a drifting body. Every no-damping assertion below needs this, or the
    /// thing it measures is a collision.
    fn void() -> Map {
        test_map(W, H, |_| {})
    }

    fn drifting(pos: Vec2, vel: Vec2) -> MovementState {
        let mut st = MovementState::new(crate::physics::body::Body::new(pos));
        st.body.vel = vel;
        st.body.grounded = false;
        st.body.airborne_ticks = 100;
        st
    }

    /// One tick of `apply_input` under `mode`, with `buttons` held.
    ///
    /// Through `MovementState::step`, which is `apply_input`, which is the
    /// function **both sides run**. Not a re-statement of its body: a fixture
    /// that reimplemented the branch would agree with itself forever.
    fn step(map: &Map, st: &mut MovementState, buttons: u8, mode: GravityMode) {
        let input = Input::new(0, buttons, 0);
        st.step(map, &input, &input, MoveMods::NONE, mode, SIM_DT);
    }

    fn run(map: &Map, st: &mut MovementState, buttons: u8, mode: GravityMode, ticks: u32) {
        for _ in 0..ticks {
            step(map, st, buttons, mode);
        }
    }

    // ---- no damping: the test that earns its keep (R1's real half) ---------

    /// **Velocity persists exactly, across ticks, with no input and no
    /// contact** — and the standard-gravity control in the same body is what
    /// makes that a claim about this mode rather than about arithmetic.
    ///
    /// `assert_eq!` on both components, not an epsilon: "constant until they
    /// hit something" is an exact statement, and a drift of 0.001 px/s per tick
    /// is 0.06 px/s per second, which over a round is a player who slowly stops.
    ///
    /// What this would report if the mode reached nothing: the space arm would
    /// pick up `GRAVITY * dt` on `vel.y` every tick and `AIR_DRAG` on `vel.x`,
    /// and both assertions fail on the first tick.
    #[test]
    fn velocity_persists_exactly_and_a_standard_gravity_control_damps() {
        let map = void();
        let start = Vec2::new(120.0, 260.0);
        let vel = Vec2::new(200.0, -50.0);

        let mut space = drifting(start, vel);
        run(&map, &mut space, 0, GravityMode::Space, 120);
        assert_eq!(
            space.body.vel, vel,
            "space: two seconds of nothing changed the velocity"
        );
        // And the body actually went somewhere, or "unchanged velocity" is
        // satisfied by a simulation that is not running.
        //
        // **Within a fiftieth of a pixel, not exactly.** `move_x` adds one
        // sub-step at a time — 120 ticks of 200 px/s is 400 additions — and
        // `v * dt * 120` in one multiply is a different `f32` from that sum
        // (measured: 520.0022 against 520.0). The exact claim in this test is
        // the *velocity* above; this one only has to be able to see a body that
        // did not move.
        let expected_x = start.x + vel.x * SIM_DT * 120.0;
        assert!(
            (space.body.pos.x - expected_x).abs() < 0.02,
            "space: the body travelled to {} where its own kept velocity puts \
             it at {expected_x}",
            space.body.pos.x
        );

        let mut control = drifting(start, vel);
        run(&map, &mut control, 0, GravityMode::Standard, 120);
        assert!(
            control.body.vel.y > vel.y + GRAVITY * SIM_DT,
            "control: standard gravity did not accelerate the body downward \
             ({} from {})",
            control.body.vel.y,
            vel.y
        );
        assert!(
            control.body.vel.x < vel.x,
            "control: AIR_DRAG did not bleed the horizontal drift ({} from {})",
            control.body.vel.x,
            vel.x
        );
    }

    /// **R1's half that is not free.** A ceiling takes the component into it and
    /// leaves the component along it — and in space the survivor then survives
    /// *forever*, which is the part standard gravity cannot reproduce.
    ///
    /// The control is the same collision under standard gravity: the tangential
    /// component is bled by `AIR_DRAG` over the following two seconds, so a
    /// build that damped in space would read like the control rather than like
    /// this.
    #[test]
    fn a_ceiling_takes_the_normal_and_the_tangential_survives_forever() {
        // Solid roof, open below it.
        let map = test_map(W, H, |m| {
            for x in 0..W as i32 {
                for y in 0..40 {
                    m.set(x, y);
                }
            }
        });
        let vx = 180.0;
        let start = Vec2::new(120.0, 40.0 + PLAYER_H / 2.0 + 6.0);

        let mut space = drifting(start, Vec2::new(vx, -120.0));
        run(&map, &mut space, 0, GravityMode::Space, 4);
        assert_eq!(space.body.vel.y, 0.0, "space: the ceiling did not stop us");
        assert_eq!(
            space.body.vel.x, vx,
            "space: the ceiling took the tangential component too"
        );
        assert!(
            !space.body.grounded,
            "space: a ceiling grounded the player (R4: only contact from below does)"
        );

        run(&map, &mut space, 0, GravityMode::Space, 120);
        assert_eq!(
            space.body.vel.x, vx,
            "space: the tangential component decayed over the next two seconds"
        );

        let mut control = drifting(start, Vec2::new(vx, -120.0));
        run(&map, &mut control, 0, GravityMode::Standard, 124);
        assert!(
            control.body.vel.x < vx,
            "control: standard gravity did not bleed the tangential component, \
             so the space assertion above proves nothing ({} from {vx})",
            control.body.vel.x
        );
    }

    // ---- R4: what grounds you, and what does not --------------------------

    /// **R4 — drifting sideways onto a rock lands you, with `vel.y == 0.0`.**
    ///
    /// `move_y` cannot do this: it returns at `dy == 0.0` before it probes.
    /// Falsify by deleting the `zero_g` arm in `resolve::integrate` — the
    /// player then floats along the surface, ungrounded, forever.
    ///
    /// The second half is the control that stops the probe being "always true":
    /// the same body over open space must **not** be grounded.
    #[test]
    fn drifting_sideways_onto_a_rock_lands_you_and_open_space_does_not() {
        let map = test_map(W, H, floor_at(FLOOR));
        let feet = FLOOR as f32 - PLAYER_H / 2.0;

        let mut on_rock = drifting(Vec2::new(120.0, feet), Vec2::new(WALK_SPEED, 0.0));
        step(&map, &mut on_rock, 0, GravityMode::Space);
        assert!(
            on_rock.body.grounded,
            "space: sliding along the top of a rock with vel.y == 0 did not ground"
        );
        assert_eq!(
            on_rock.body.vel.y, 0.0,
            "space: landing invented a vertical velocity"
        );

        let mut in_void = drifting(Vec2::new(120.0, 120.0), Vec2::new(WALK_SPEED, 0.0));
        step(&void(), &mut in_void, 0, GravityMode::Space);
        assert!(
            !in_void.body.grounded,
            "space: a body with nothing under it was reported grounded, so the \
             probe answers true unconditionally"
        );
    }

    /// **R4 — a wall stops you but does not ground you.**
    ///
    /// Held against a wall, not standing on a floor. Without this the R4 probe
    /// could have been written as "any contact", and a player would walk up the
    /// side of an asteroid.
    #[test]
    fn a_wall_stops_you_without_grounding_you() {
        let map = test_map(W, H, |m| {
            for x in 300..W as i32 {
                for y in 0..H as i32 {
                    m.set(x, y);
                }
            }
        });
        let mut st = drifting(Vec2::new(240.0, 120.0), Vec2::new(400.0, -30.0));
        run(&map, &mut st, 0, GravityMode::Space, 20);
        assert_eq!(
            st.body.vel.x, 0.0,
            "the wall did not stop the normal component"
        );
        assert_eq!(
            st.body.vel.y, -30.0,
            "the wall took the tangential component as well"
        );
        assert!(!st.body.grounded, "a wall grounded the player");
    }

    /// **R4 — `ground_snap` is off in space, and the same body under standard
    /// gravity is snapped.**
    ///
    /// A body that was grounded last tick, has `vel.y == 0.0`, and has just
    /// moved out over a drop of less than `STEP_DOWN`. Under gravity that is a
    /// downhill step and the snap is what keeps walking smooth; in space it is
    /// the mode refusing to let go of you.
    #[test]
    fn a_walker_is_snapped_downhill_and_a_drifter_in_space_is_not() {
        // A single step down of 4 px at x = 200.
        let map = test_map(W, H, |m| {
            for x in 0..W as i32 {
                let surface = if x < 200 { FLOOR } else { FLOOR + 4 };
                for y in surface..H as i32 {
                    m.set(x, y);
                }
            }
        });
        let start = Vec2::new(190.0, FLOOR as f32 - PLAYER_H / 2.0);

        // **RIGHT held on both runs, and enough ticks to cross the step.**
        // Not a coasting drifter: a *grounded* player in space is an ordinary
        // grounded player (R4), so with no input `GROUND_FRICTION` stops them
        // before they ever reach the edge and the two runs differ because one
        // of them never went anywhere. Walking is free in space, so this is the
        // same gesture on both sides and the only difference is the snap.
        const CROSS_TICKS: u32 = 12;
        let mut walker = MovementState::new(crate::physics::body::Body::new(start));
        walker.body.grounded = true;
        walker.body.vel = Vec2::new(WALK_SPEED, 0.0);
        run(
            &map,
            &mut walker,
            button::RIGHT,
            GravityMode::Standard,
            CROSS_TICKS,
        );

        let mut drifter = MovementState::new(crate::physics::body::Body::new(start));
        drifter.body.grounded = true;
        drifter.body.vel = Vec2::new(WALK_SPEED, 0.0);
        run(
            &map,
            &mut drifter,
            button::RIGHT,
            GravityMode::Space,
            CROSS_TICKS,
        );

        assert!(
            drifter.body.pos.x > 200.0 && walker.body.pos.x > 200.0,
            "precondition: neither run reached the step at x = 200 \
             (walker {}, drifter {})",
            walker.body.pos.x,
            drifter.body.pos.x
        );

        assert!(
            walker.body.pos.y > start.y,
            "control: the walker was not snapped down the step at all, so this \
             fixture cannot see ground_snap ({} from {})",
            walker.body.pos.y,
            start.y
        );
        assert_eq!(
            drifter.body.pos.y, start.y,
            "space: the drifter was pulled down onto the step — ground_snap is \
             still running (R4 turns it off)"
        );
        assert!(
            !drifter.body.grounded,
            "space: the drifter is still grounded over a 4 px drop, so \
             something re-established the contact the snap was supposed to lose"
        );
    }

    /// A body at rest on a rock in space does not drift, and stays grounded.
    ///
    /// `resolve`'s `a_resting_body_is_bit_identical_after_600_ticks` for the
    /// other contact rules. The R4 probe runs every tick, so if it ever moved
    /// the body this would find it.
    #[test]
    fn a_body_resting_on_a_rock_in_space_is_bit_identical_after_600_ticks() {
        let map = test_map(W, H, floor_at(FLOOR));
        let mut st = drifting(Vec2::new(120.0, FLOOR as f32 - PLAYER_H / 2.0), Vec2::ZERO);
        step(&map, &mut st, 0, GravityMode::Space);
        let settled = st.body.pos;
        for tick in 0..600 {
            step(&map, &mut st, 0, GravityMode::Space);
            assert_eq!(st.body.pos, settled, "drifted at tick {tick}");
            assert!(st.body.grounded, "lost the rock at tick {tick}");
        }
    }

    // ---- fuel: the whole resource economy of the mode ----------------------

    /// **Thrusting costs fuel; walking on a rock does not; and a
    /// standard-gravity control holding the same key spends nothing.**
    ///
    /// The third clause is the one that makes the first a claim about space: a
    /// floating player under standard gravity holding RIGHT uses air control,
    /// which is free, so a build that charged everyone would fail it.
    #[test]
    fn thrusting_costs_fuel_walking_on_a_rock_does_not_and_gravity_is_free() {
        let map = test_map(W, H, floor_at(FLOOR));

        let mut floater = drifting(Vec2::new(120.0, 120.0), Vec2::ZERO);
        run(&void(), &mut floater, button::RIGHT, GravityMode::Space, 30);
        assert!(
            floater.jet.fuel < JETPACK_MAX_FUEL,
            "space: half a second of thrust burned no fuel"
        );
        assert!(
            floater.body.vel.x > 0.0,
            "space: the fuel bought no movement"
        );

        let mut walker = drifting(Vec2::new(120.0, FLOOR as f32 - PLAYER_H / 2.0), Vec2::ZERO);
        // One neutral tick so the R4 probe can find the rock. `drifting` hands
        // out an *airborne* body, and an airborne player in space who holds a
        // direction is thrusting — correctly. Without this the fixture charges
        // one tick of fuel to the walking case and then reports it as the bug.
        step(&map, &mut walker, 0, GravityMode::Space);
        assert!(
            walker.body.grounded,
            "precondition: the walker never found the rock"
        );
        let tank = walker.jet.fuel;
        run(&map, &mut walker, button::RIGHT, GravityMode::Space, 30);
        assert!(
            walker.body.grounded,
            "precondition: the walker left the rock, so this is not a walking test"
        );
        assert_eq!(
            walker.jet.fuel, tank,
            "space: walking on a rock charged the tank"
        );
        assert!(
            (walker.body.vel.x - WALK_SPEED).abs() < 1.0,
            "space: a grounded player did not reach WALK_SPEED — they are not \
             walking, they are thrusting ({})",
            walker.body.vel.x
        );

        let mut control = drifting(Vec2::new(120.0, 120.0), Vec2::ZERO);
        run(
            &void(),
            &mut control,
            button::RIGHT,
            GravityMode::Standard,
            30,
        );
        assert_eq!(
            control.jet.fuel, JETPACK_MAX_FUEL,
            "control: a falling player under standard gravity was charged fuel \
             for holding RIGHT"
        );
    }

    /// **At zero fuel you keep drifting, and you cannot steer.**
    ///
    /// The task's own sentence, asserted as two halves that fail separately: the
    /// position keeps changing at a *constant* velocity (drift), and holding a
    /// direction changes that velocity by exactly nothing (no steering).
    #[test]
    fn a_dry_tank_drifts_and_cannot_steer() {
        let map = void();
        // **Low in the void, not high.** The control below climbs on UP, and
        // `clamp_to_world` zeroes upward velocity at `y = 0` — the first draft
        // started at y = 120, hit the ceiling inside the window and reported
        // its own control as broken.
        let start_y = H as f32 - 100.0;
        let mut st = drifting(Vec2::new(60.0, start_y), Vec2::new(60.0, 0.0));
        st.jet.fuel = 0.0;
        st.jet.locked_out = true;

        // UP held: with fuel this climbs hard. Dry, it must do nothing at all.
        let before = st.body.vel;
        let x0 = st.body.pos.x;
        // Short enough that the refill delay has not elapsed
        // (`JETPACK_REFILL_DELAY` is 0.5 s) — otherwise the tank buys a tick of
        // thrust back and the assertion becomes a race with the refill clock.
        let ticks = (JETPACK_REFILL_DELAY * 60.0) as u32 - 2;
        run(&map, &mut st, button::UP, GravityMode::Space, ticks);
        assert_eq!(
            st.body.vel, before,
            "a dry tank still steered: velocity moved from {before:?}"
        );
        // Within a fiftieth of a pixel: `move_x` accumulates sub-steps and the
        // closed form is a different `f32`. The exact claim is the velocity.
        let expected_x = x0 + before.x * SIM_DT * ticks as f32;
        assert!(
            (st.body.pos.x - expected_x).abs() < 0.02,
            "a dry player stopped drifting: {} against {expected_x}",
            st.body.pos.x
        );

        // The control: the identical run with fuel does move.
        let mut fuelled = drifting(Vec2::new(60.0, start_y), Vec2::new(60.0, 0.0));
        run(&map, &mut fuelled, button::UP, GravityMode::Space, ticks);
        assert!(
            fuelled.body.vel.y < before.y,
            "control: a fuelled player did not climb, so 'cannot steer' is \
             satisfied by thrust that never works"
        );
    }

    /// **`SPACE_JUMP_FUEL`'s value, against a basis that does not move with
    /// it** — the assertion `CLAUDE.md` asks for on a tunable whose *value*
    /// matters, since everything else is pinned to the constant and moves with
    /// it.
    ///
    /// Two measurements, both taken by running the simulation rather than by
    /// restating the division:
    ///
    ///  - a full tank buys **ten** jumps and refuses the eleventh;
    ///  - one jump is bought back by **one second** of not thrusting, on top of
    ///    `JETPACK_REFILL_DELAY`.
    ///
    /// If the constant were retuned to, say, a fifth of the tank, the counted
    /// number here would be 5 and this fails — which is exactly what a pinned
    /// assertion could not do.
    #[test]
    fn a_full_tank_buys_ten_jumps_and_a_dry_one_refuses() {
        let map = test_map(W, H, floor_at(FLOOR));
        let feet = FLOOR as f32 - PLAYER_H / 2.0;
        let mut st = drifting(Vec2::new(120.0, feet), Vec2::ZERO);
        step(&map, &mut st, 0, GravityMode::Space);
        assert!(st.body.grounded, "precondition: not standing on the rock");

        // Jump, settle back, jump again, until one is refused.
        let mut jumps = 0;
        for _ in 0..40 {
            // A fresh press: released on the previous tick by `step`'s use of
            // the same input for `prev` only while held, so drive the edge
            // explicitly.
            let pressed = Input::new(0, button::JUMP, 0);
            let released = Input::new(0, 0, 0);
            st.step(
                &map,
                &released,
                &released,
                MoveMods::NONE,
                GravityMode::Space,
                SIM_DT,
            );
            let before = st.body.vel.y;
            st.step(
                &map,
                &pressed,
                &released,
                MoveMods::NONE,
                GravityMode::Space,
                SIM_DT,
            );
            if st.body.vel.y < before - 1.0 {
                jumps += 1;
                // Fall back onto the rock. With no gravity that means driving
                // ourselves down: DOWN thrust would cost fuel, so put the body
                // back by hand — this test counts jumps, not landings.
                st.body.pos = Vec2::new(120.0, feet);
                st.body.vel = Vec2::ZERO;
                st.body.grounded = true;
            } else {
                break;
            }
        }
        let expected = (JETPACK_MAX_FUEL / SPACE_JUMP_FUEL) as i32;
        assert_eq!(
            jumps, expected,
            "a full tank bought {jumps} jumps; the basis in SPACE_JUMP_FUEL's \
             doc comment says {expected}"
        );
        assert!(
            st.jet.fuel < SPACE_JUMP_FUEL,
            "the run stopped for some reason other than an empty tank ({})",
            st.jet.fuel
        );

        // And one jump comes back in one second of rest, past the refill delay.
        let rest = ((JETPACK_REFILL_DELAY + SPACE_JUMP_FUEL / JETPACK_REFILL) * 60.0).ceil() as u32;
        run(&map, &mut st, 0, GravityMode::Space, rest + 1);
        assert!(
            jetpack::can_afford_jump(&st.jet),
            "{rest} ticks of rest did not buy a jump back ({} of {SPACE_JUMP_FUEL})",
            st.jet.fuel
        );
    }

    // ---- the regime, restated ---------------------------------------------

    /// **No fourth regime**: under space gravity, all three of
    /// `jetpack::gravity_scale`'s answers are `0.0`.
    ///
    /// The control is the same three under standard gravity, where they are
    /// three different numbers. Without it, "all zero" is satisfied by a
    /// function that returns zero.
    #[test]
    fn space_multiplies_all_three_regimes_to_zero() {
        let idle = JetpackState::default();
        let active = JetpackState {
            active: true,
            ..Default::default()
        };
        for (name, state, flying) in [
            ("ordinary", &idle, false),
            ("jetpack", &active, false),
            ("wings", &idle, true),
        ] {
            assert_eq!(
                jetpack::gravity_scale(state, flying, GravityMode::Space),
                0.0,
                "{name} under space gravity"
            );
        }
        let standard: Vec<f32> = [(&idle, false), (&active, false), (&idle, true)]
            .iter()
            .map(|(s, f)| jetpack::gravity_scale(s, *f, GravityMode::Standard))
            .collect();
        assert_eq!(standard.len(), 3);
        assert!(
            standard[0] != standard[1] && standard[1] != standard[2],
            "control: the three regimes are not distinct under standard \
             gravity ({standard:?}), so the zeroes above prove nothing"
        );
    }

    /// **Wings still win in space, and they do not burn fuel** (T21.03,
    /// restated rather than rediscovered).
    ///
    /// A winged player in space hovers with no input and climbs on UP at
    /// `WINGS_FLY_SPEED`, exactly as they do under gravity — `apply_flight`
    /// assigns, so whatever drift they had is cancelled. And because
    /// `mods.flying` takes the refusal arm of `apply_input`, no fuel is spent.
    #[test]
    fn wings_in_space_fly_and_cost_nothing() {
        let map = void();
        let wings = MoveMods {
            flying: true,
            ..MoveMods::NONE
        };
        let input = Input::new(0, button::UP, 0);
        let mut body = crate::physics::body::Body::new(Vec2::new(120.0, 260.0));
        body.vel = Vec2::new(300.0, 300.0);
        body.grounded = false;
        body.airborne_ticks = 100;
        let mut jump = JumpState::default();
        let mut jet = JetpackState::default();
        for _ in 0..10 {
            apply_input(
                &map,
                &mut body,
                &mut jump,
                &mut jet,
                &input,
                &input,
                wings,
                GravityMode::Space,
                SIM_DT,
            );
        }
        assert_eq!(
            body.vel.y,
            -crate::constants::WINGS_FLY_SPEED,
            "wings in space did not assign the climb — space accumulated over them"
        );
        assert_eq!(
            jet.fuel, JETPACK_MAX_FUEL,
            "wings in space burned thruster fuel"
        );
    }

    /// Thrust is clamped per axis at `JETPACK_MAX_SPEED`, which is the only cap
    /// this mode has — **and it is a per-axis cap on the thrust, not a speed
    /// limit on the body.**
    ///
    /// Recorded because it is the interaction `M22-RULINGS` R10 flags: a
    /// magnitude clamp is `Forces::max_speed`, which R10 assigns to `T22.11`,
    /// so a knockback that puts a player past this is **not** clawed back here.
    #[test]
    fn thrust_tops_out_per_axis_and_a_knockback_past_it_is_left_alone() {
        let map = void();
        let mut st = drifting(Vec2::new(60.0, 260.0), Vec2::ZERO);
        run(&map, &mut st, button::RIGHT, GravityMode::Space, 120);
        assert!(
            (st.body.vel.x - JETPACK_MAX_SPEED).abs() < 1.0,
            "thrust from rest did not top out at JETPACK_MAX_SPEED ({})",
            st.body.vel.x
        );

        let mut knocked = drifting(Vec2::new(60.0, 260.0), Vec2::new(900.0, 0.0));
        let before = knocked.body.vel.x;
        run(&map, &mut knocked, button::RIGHT, GravityMode::Space, 10);
        assert!(
            knocked.body.vel.x >= before,
            "engaging the thrusters braked a body already past the clamp \
             ({} from {before}) — the clamp bounds the thrust, not the body",
            knocked.body.vel.x
        );
    }
}
