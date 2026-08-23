//! Movement scenarios against hand-built masks, plus the determinism and
//! no-tunnelling properties the whole netcode rests on.
//!
//! `cargo test -p game-core --test movement_scenarios`

use game_core::constants::*;
use game_core::map::{CoarseGrid, Map, MapMeta, Mask};
use game_core::math::Vec2;
use game_core::physics::body::Body;
use game_core::player::input::button::*;
use game_core::player::jetpack::HOLD_DELAY_TICKS;
use game_core::player::{apply_input, Input, JetpackState, JumpState, MovementState};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn make_map(w: u32, h: u32, build: impl FnOnce(&mut Mask)) -> Map {
    let mut mask = Mask::new_empty(w, h);
    build(&mut mask);
    let coarse = CoarseGrid::build(&mask);
    let meta = MapMeta {
        seed: 0,
        requested_seed: 0,
        attempts: 1,
        used_safe_preset: false,
        scale: MapScale::Small,
        theme: 0,
        spawn_points: Vec::new(),
        teleport_pads: Vec::new(),
        surface_points: Vec::new(),
        buried_slots: Vec::new(),
        decorations: Vec::new(),
        wind: 0.0,
        traversable_fraction: 1.0,
        largest_component: Vec::new(),
    };
    Map::from_parts(mask, coarse, meta)
}

const W: u32 = 1024;
const H: u32 = 512;
const FLOOR: i32 = 300;

fn flat_floor() -> Map {
    make_map(W, H, |m| {
        for y in FLOOR..H as i32 {
            m.set_run(y, 0, W as i32 - 1);
        }
    })
}

/// Flat floor with a step of `height` px rising at x = 500.
fn floor_with_step(height: i32) -> Map {
    make_map(W, H, move |m| {
        for y in FLOOR..H as i32 {
            m.set_run(y, 0, W as i32 - 1);
        }
        for y in (FLOOR - height)..FLOOR {
            m.set_run(y, 500, W as i32 - 1);
        }
    })
}

/// Flat floor with a 20 px wall at x = 500.
fn floor_with_wall() -> Map {
    make_map(W, H, |m| {
        for y in FLOOR..H as i32 {
            m.set_run(y, 0, W as i32 - 1);
        }
        for y in (FLOOR - 20)..FLOOR {
            m.set_run(y, 500, 520);
        }
    })
}

/// A 45-degree ramp descending to the right from x = 200.
fn ramp_down() -> Map {
    make_map(W, H, |m| {
        for x in 0..W as i32 {
            let surface = if x < 200 {
                200
            } else {
                (200 + (x - 200)).min(H as i32 - 1)
            };
            for y in surface..H as i32 {
                m.set(x, y);
            }
        }
    })
}

fn body_on_floor(x: f32, floor_y: i32) -> Body {
    let mut b = Body::new(Vec2::new(x, floor_y as f32 - PLAYER_H / 2.0));
    b.grounded = true;
    b
}

fn input(buttons: u8) -> Input {
    Input::new(0, buttons, 0)
}

/// Run `ticks` of the same held input, returning the final state.
fn run(map: &Map, mut st: MovementState, buttons: u8, ticks: u32) -> MovementState {
    let inp = input(buttons);
    let mut prev = Input::default();
    for _ in 0..ticks {
        st.step(map, &inp, &prev, 1.0, SIM_DT);
        prev = inp;
    }
    st
}

// ---------------------------------------------------------------------------
// Determinism — the foundation
// ---------------------------------------------------------------------------

/// A varied, reproducible input sequence. No RNG: the sequence is a pure function
/// of the tick index, so the test is identical on every machine.
fn scripted_input(tick: u32) -> Input {
    let mut b = 0u8;
    if tick % 7 < 3 {
        b |= RIGHT;
    }
    if tick % 11 < 2 {
        b |= LEFT;
    }
    if tick.is_multiple_of(13) {
        b |= JUMP;
    }
    if tick % 23 < 9 {
        b |= JUMP;
    }
    if tick.is_multiple_of(5) {
        b |= UP;
    }
    if tick.is_multiple_of(17) {
        b |= DOWN;
    }
    Input::new(tick, b, (tick as u16).wrapping_mul(997))
}

#[test]
fn the_same_inputs_from_the_same_state_are_byte_identical_every_time() {
    let map = flat_floor();
    let start = MovementState::new(body_on_floor(100.0, FLOOR));

    let simulate = || {
        let mut st = start;
        let mut prev = Input::default();
        for tick in 0..1000 {
            let inp = scripted_input(tick);
            st.step(&map, &inp, &prev, 1.0, SIM_DT);
            prev = inp;
        }
        st
    };

    let reference = simulate();
    for run_no in 0..100 {
        assert_eq!(simulate(), reference, "diverged on run {run_no}");
    }
}

/// The reconciliation identity from `docs/42-netcode-prediction.md` §9. If this
/// fails, client-side prediction cannot work.
#[test]
fn replaying_from_a_midpoint_reaches_the_same_state_as_running_straight_through() {
    let map = ramp_down();
    let start = MovementState::new(body_on_floor(100.0, 200));

    // Straight through 0..1000.
    let mut straight = start;
    let mut prev = Input::default();
    let mut midpoint = None;
    let mut midpoint_prev = Input::default();
    for tick in 0..1000u32 {
        let inp = scripted_input(tick);
        straight.step(&map, &inp, &prev, 1.0, SIM_DT);
        if tick == 499 {
            midpoint = Some(straight);
            midpoint_prev = inp;
        }
        prev = inp;
    }

    // Replay 500..1000 from the captured midpoint.
    let mut replayed = midpoint.expect("midpoint captured");
    let mut prev = midpoint_prev;
    for tick in 500..1000u32 {
        let inp = scripted_input(tick);
        replayed.step(&map, &inp, &prev, 1.0, SIM_DT);
        prev = inp;
    }

    assert_eq!(
        replayed, straight,
        "replaying from a snapshot must reach the same state"
    );
}

#[test]
fn apply_input_does_not_mutate_its_inputs() {
    let map = flat_floor();
    let mut body = body_on_floor(100.0, FLOOR);
    let mut jump = JumpState::default();
    let mut jet = JetpackState::default();
    let inp = input(RIGHT | JUMP);
    let prev = Input::default();
    let (inp_before, prev_before) = (inp, prev);

    apply_input(
        &map, &mut body, &mut jump, &mut jet, &inp, &prev, 1.0, SIM_DT,
    );

    assert_eq!(inp, inp_before);
    assert_eq!(prev, prev_before);
}

// ---------------------------------------------------------------------------
// No tunnelling — every axis, both directions
// ---------------------------------------------------------------------------

#[test]
fn a_body_at_ten_times_terminal_velocity_is_stopped_by_a_one_px_floor() {
    for dir in [1.0f32, -1.0] {
        let surface = if dir > 0.0 { 400 } else { 100 };
        let map = make_map(W, H, move |m| m.set_run(surface, 0, W as i32 - 1));
        let mut st = MovementState::new(Body::new(Vec2::new(100.0, 250.0)));
        st.body.vel.y = dir * 10.0 * MAX_FALL_SPEED;

        for _ in 0..600 {
            st.step(&map, &input(0), &Input::default(), 1.0, SIM_DT);
        }

        if dir > 0.0 {
            assert!(
                st.body.feet_y() <= surface as f32 + 1.0,
                "tunnelled down through the floor to y = {}",
                st.body.pos.y
            );
        } else {
            assert!(
                st.body.head_y() >= surface as f32,
                "tunnelled up through the ceiling to y = {}",
                st.body.pos.y
            );
        }
    }
}

#[test]
fn a_body_at_ten_times_walk_speed_is_stopped_by_a_one_px_wall() {
    for dir in [1.0f32, -1.0] {
        let wall_x = if dir > 0.0 { 600 } else { 200 };
        let map = make_map(W, H, move |m| {
            for y in FLOOR..H as i32 {
                m.set_run(y, 0, W as i32 - 1);
            }
            for y in (FLOOR - 60)..FLOOR {
                m.set(wall_x, y);
            }
        });

        let mut st = MovementState::new(body_on_floor(400.0, FLOOR));
        st.body.vel.x = dir * 10.0 * WALK_SPEED;

        for _ in 0..600 {
            // Re-assert the extreme velocity: friction would otherwise bleed it off
            // before the body reaches the wall, and the test would prove nothing.
            st.body.vel.x = dir * 10.0 * WALK_SPEED;
            st.step(&map, &input(0), &Input::default(), 1.0, SIM_DT);
        }

        if dir > 0.0 {
            assert!(
                st.body.pos.x + PLAYER_W / 2.0 <= wall_x as f32 + 1.0,
                "tunnelled right through the wall to x = {}",
                st.body.pos.x
            );
        } else {
            assert!(
                st.body.pos.x - PLAYER_W / 2.0 >= wall_x as f32,
                "tunnelled left through the wall to x = {}",
                st.body.pos.x
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

#[test]
fn standing_still_is_bit_identical_after_600_ticks() {
    let map = flat_floor();
    let mut st = MovementState::new(body_on_floor(100.0, FLOOR));
    st.step(&map, &input(0), &Input::default(), 1.0, SIM_DT); // settle
    let settled = st.body.pos;

    for tick in 0..600 {
        st.step(&map, &input(0), &Input::default(), 1.0, SIM_DT);
        assert_eq!(st.body.pos, settled, "drifted at tick {tick}");
    }
}

#[test]
fn a_six_px_step_is_climbed_and_a_seven_px_step_is_not() {
    let map = floor_with_step(6);
    let st = run(
        &map,
        MovementState::new(body_on_floor(400.0, FLOOR)),
        RIGHT,
        240,
    );
    assert!(
        st.body.pos.x > 520.0,
        "did not climb the 6 px step: x = {}",
        st.body.pos.x
    );

    let map = floor_with_step(7);
    let st = run(
        &map,
        MovementState::new(body_on_floor(400.0, FLOOR)),
        RIGHT,
        240,
    );
    assert!(
        st.body.pos.x < 500.0,
        "climbed a 7 px step: x = {}",
        st.body.pos.x
    );
}

#[test]
fn a_twenty_px_wall_blocks_and_zeroes_horizontal_velocity() {
    let map = floor_with_wall();
    let st = run(
        &map,
        MovementState::new(body_on_floor(400.0, FLOOR)),
        RIGHT,
        240,
    );
    assert!(
        st.body.pos.x < 500.0,
        "passed the wall: x = {}",
        st.body.pos.x
    );
    assert_eq!(st.body.vel.x, 0.0);
}

#[test]
fn walking_down_a_slope_keeps_grounded_true_every_tick() {
    let map = ramp_down();
    let mut st = MovementState::new(body_on_floor(150.0, 200));
    st.step(&map, &input(RIGHT), &Input::default(), 1.0, SIM_DT);
    assert!(st.body.grounded, "precondition");

    let inp = input(RIGHT);
    let mut prev = inp;
    for tick in 0..150 {
        st.step(&map, &inp, &prev, 1.0, SIM_DT);
        prev = inp;
        assert!(
            st.body.grounded,
            "went airborne at tick {tick} (x = {}, y = {})",
            st.body.pos.x, st.body.pos.y
        );
    }
}

#[test]
fn a_standing_jump_lands_within_two_px_of_its_origin() {
    let map = flat_floor();
    let mut st = MovementState::new(body_on_floor(400.0, FLOOR));
    st.step(&map, &input(0), &Input::default(), 1.0, SIM_DT);
    let origin = st.body.pos.x;

    // One-tick press, then release and let it land.
    st.step(&map, &input(JUMP), &Input::default(), 1.0, SIM_DT);
    let mut prev = input(JUMP);
    for _ in 0..300 {
        st.step(&map, &input(0), &prev, 1.0, SIM_DT);
        prev = input(0);
    }

    assert!(st.body.grounded, "never landed");
    assert!(
        (st.body.pos.x - origin).abs() < 2.0,
        "drifted {} px",
        st.body.pos.x - origin
    );
}

#[test]
fn a_running_jump_travels_further_than_a_standing_one() {
    let map = flat_floor();

    let jump_distance = |hold_dir: bool| {
        let mut st = MovementState::new(body_on_floor(200.0, FLOOR));
        if hold_dir {
            st = run(&map, st, RIGHT, 60); // reach full speed
        } else {
            st.step(&map, &input(0), &Input::default(), 1.0, SIM_DT);
        }
        let start = st.body.pos.x;

        let buttons = if hold_dir { RIGHT | JUMP } else { JUMP };
        st.step(
            &map,
            &input(buttons),
            &input(if hold_dir { RIGHT } else { 0 }),
            1.0,
            SIM_DT,
        );
        let after = if hold_dir { RIGHT } else { 0 };
        let mut prev = input(buttons);
        for _ in 0..300 {
            st.step(&map, &input(after), &prev, 1.0, SIM_DT);
            prev = input(after);
            if st.body.grounded {
                break;
            }
        }
        st.body.pos.x - start
    };

    let standing = jump_distance(false);
    let running = jump_distance(true);
    assert!(
        running > standing + 20.0,
        "running jump {running:.1} px vs standing {standing:.1} px"
    );
}

#[test]
fn the_jump_apex_matches_the_discrete_expectation() {
    let map = flat_floor();
    let mut st = MovementState::new(body_on_floor(400.0, FLOOR));
    st.step(&map, &input(0), &Input::default(), 1.0, SIM_DT);
    let ground_y = st.body.pos.y;

    st.step(&map, &input(JUMP), &Input::default(), 1.0, SIM_DT);
    let mut peak = st.body.pos.y;
    let mut prev = input(JUMP);
    for _ in 0..300 {
        st.step(&map, &input(0), &prev, 1.0, SIM_DT);
        prev = input(0);
        peak = peak.min(st.body.pos.y);
    }

    let height = ground_y - peak;
    // The continuous apex less the semi-implicit Euler shortfall of v*dt/2.
    let expected = JUMP_VELOCITY * JUMP_VELOCITY / (2.0 * GRAVITY) - JUMP_VELOCITY * SIM_DT / 2.0;
    assert!(
        (height - expected).abs() < 2.0,
        "apex {height:.2} px, expected {expected:.2}"
    );
}

#[test]
fn holding_the_opposite_direction_mid_air_reverses_within_the_expected_time() {
    let map = flat_floor();
    let mut st = MovementState::new(body_on_floor(300.0, FLOOR));
    st = run(&map, st, RIGHT, 60);
    assert!(st.body.vel.x > 0.0);

    // Jump, then hold left.
    st.step(&map, &input(RIGHT | JUMP), &input(RIGHT), 1.0, SIM_DT);
    let mut prev = input(RIGHT | JUMP);
    let mut ticks = 0;
    while st.body.vel.x > -WALK_SPEED * 0.9 && ticks < 600 {
        st.step(&map, &input(LEFT), &prev, 1.0, SIM_DT);
        prev = input(LEFT);
        ticks += 1;
        if st.body.grounded {
            break;
        }
    }

    let budget_s = (2.0 * WALK_SPEED) / (WALK_ACCEL * AIR_ACCEL_FACTOR);
    let budget_ticks = (budget_s * SIM_HZ as f32).ceil() as u32 + 5;
    assert!(
        st.body.vel.x < 0.0,
        "never reversed: vel.x = {}",
        st.body.vel.x
    );
    assert!(
        ticks <= budget_ticks,
        "took {ticks} ticks, budget {budget_ticks}"
    );
}

#[test]
fn coyote_time_works_at_five_ticks_and_fails_at_twelve() {
    // A ledge ending at x = 500.
    let ledge = || {
        make_map(W, H, |m| {
            for y in FLOOR..H as i32 {
                m.set_run(y, 0, 500);
            }
        })
    };

    let jumped_after = |delay: u32| {
        let map = ledge();
        let mut st = MovementState::new(body_on_floor(450.0, FLOOR));
        // Walk off the edge.
        let mut prev = Input::default();
        let mut airborne_for = 0;
        for _ in 0..400 {
            let inp = input(RIGHT);
            st.step(&map, &inp, &prev, 1.0, SIM_DT);
            prev = inp;
            if !st.body.grounded {
                airborne_for += 1;
                if airborne_for == delay {
                    break;
                }
            }
        }
        assert!(!st.body.grounded, "never left the ledge");
        let before = st.body.vel.y;
        st.step(&map, &input(RIGHT | JUMP), &prev, 1.0, SIM_DT);
        // A launch sets vel.y to -JUMP_VELOCITY, far more negative than gravity.
        st.body.vel.y < before - 100.0
    };

    assert!(jumped_after(5), "coyote jump at 5 ticks should work");
    assert!(!jumped_after(12), "coyote jump at 12 ticks should fail");
}

#[test]
fn five_seconds_of_thrust_drains_the_tank_and_ten_seconds_idle_refills_it() {
    let map = flat_floor();
    let mut st = MovementState::new(body_on_floor(400.0, FLOOR));

    // Airborne, holding jump: after the hold delay the jetpack burns.
    //
    // Watch for the moment the tank empties rather than sampling at a fixed time.
    // Once it hits zero the jetpack locks out and — with Space still held — starts
    // REFILLING, so a fixed 6 s sample reads 0.158 and looks like a leak.
    let mut prev = Input::default();
    let mut emptied_at = None;
    for tick in 0..(8.0 * SIM_HZ as f32) as u32 {
        let inp = input(JUMP | UP);
        st.step(&map, &inp, &prev, 1.0, SIM_DT);
        prev = inp;
        if st.jet.fuel <= 0.0 {
            emptied_at = Some(tick);
            break;
        }
    }
    let emptied = emptied_at.expect("the tank never emptied");
    // The hold delay, then JETPACK_MAX_FUEL seconds of burn.
    let expected = HOLD_DELAY_TICKS + (JETPACK_MAX_FUEL * SIM_HZ as f32) as u32;
    assert!(
        emptied.abs_diff(expected) <= 3,
        "tank emptied at tick {emptied}, expected about {expected}"
    );

    for _ in 0..(11.0 * SIM_HZ as f32) as u32 {
        let inp = input(0);
        st.step(&map, &inp, &prev, 1.0, SIM_DT);
        prev = inp;
    }
    assert!(
        (st.jet.fuel - JETPACK_MAX_FUEL).abs() < 0.01,
        "fuel {} after 11 s idle",
        st.jet.fuel
    );
}

#[test]
fn the_jetpack_does_not_engage_from_a_grounded_press_until_the_hold_delay() {
    let map = flat_floor();
    let mut st = MovementState::new(body_on_floor(400.0, FLOOR));
    st.step(&map, &input(0), &Input::default(), 1.0, SIM_DT);

    let mut prev = Input::default();
    for tick in 0..=10u32 {
        let inp = input(JUMP);
        st.step(&map, &inp, &prev, 1.0, SIM_DT);
        prev = inp;
        assert!(
            !st.jet.active,
            "jetpack engaged at tick {tick}, before the 0.18 s hold delay"
        );
    }
    let inp = input(JUMP);
    st.step(&map, &inp, &prev, 1.0, SIM_DT);
    assert!(st.jet.active, "jetpack never engaged after the hold delay");
}

#[test]
fn a_player_cannot_climb_a_sheer_wall_by_holding_a_direction() {
    let map = make_map(W, H, |m| {
        for y in FLOOR..H as i32 {
            m.set_run(y, 0, W as i32 - 1);
        }
        // A tall sheer wall.
        for y in 100..FLOOR {
            m.set_run(y, 500, 520);
        }
    });

    let mut st = MovementState::new(body_on_floor(400.0, FLOOR));
    let start_y = st.body.pos.y;
    let inp = input(RIGHT);
    let mut prev = Input::default();
    for _ in 0..600 {
        st.step(&map, &inp, &prev, 1.0, SIM_DT);
        prev = inp;
        assert!(
            st.body.pos.y >= start_y - 1.0,
            "climbed the wall to y = {}",
            st.body.pos.y
        );
    }
}

// ---------------------------------------------------------------------------
// Integration: a real generated map
// ---------------------------------------------------------------------------

/// A 16x28 body must actually be able to move around the caves M1 carves. Finding
/// out in M3 with a renderer attached would be far more expensive than finding out
/// here.
#[test]
fn a_body_can_walk_along_a_generated_cave_floor() {
    let map = game_core::map::generate(4242, MapScale::Medium);

    // Underground surface points: rock somewhere above them.
    let underground: Vec<_> = map
        .meta
        .surface_points
        .iter()
        .copied()
        .filter(|p| {
            (SKY_MARGIN as i32..p.y - PLAYER_H as i32)
                .rev()
                .any(|y| map.mask.get(p.x, y))
        })
        .collect();

    assert!(
        underground.len() >= 20,
        "expected plenty of cave floor, found {}",
        underground.len()
    );

    // A *fraction* of the sample, not a fixed count. The old `>= 30 of 40` was
    // written against v1, whose whole map is tunnel: it silently asserted "the map
    // has at least 40 underground standing spots", which v2 does not and is not
    // meant to (2 caves and an arch on a medium map yield 28). The property this
    // test is for — a 16x28 body fits on the cave floors the generator makes, and
    // can walk along them — is the ratio, and that is what is asserted below.
    let sample: Vec<_> = underground.iter().take(40).copied().collect();
    let mut walked = 0;
    let mut spawned_ok = 0;
    for p in &sample {
        let mut st = MovementState::new(Body::new(Vec2::new(
            p.x as f32,
            p.y as f32 - PLAYER_H / 2.0,
        )));

        // It must not start embedded in rock.
        if game_core::physics::aabb_overlaps_solid(&map, st.body.aabb()) {
            continue;
        }
        spawned_ok += 1;

        let start_x = st.body.pos.x;
        let inp = input(RIGHT);
        let mut prev = Input::default();
        for _ in 0..120 {
            st.step(&map, &inp, &prev, 1.0, SIM_DT);
            prev = inp;
        }
        if (st.body.pos.x - start_x).abs() > 12.0 {
            walked += 1;
        }
        assert!(
            !game_core::physics::aabb_overlaps_solid(&map, st.body.aabb()),
            "body ended up inside rock at {:?} after walking from {p:?}",
            st.body.pos
        );
    }

    assert!(
        spawned_ok * 10 >= sample.len() * 9,
        "only {spawned_ok} of {} cave points were clear",
        sample.len()
    );
    assert!(
        walked * 2 >= spawned_ok,
        "only {walked} of {spawned_ok} cave floors allowed a body to walk"
    );
}

#[test]
fn a_body_dropped_at_every_spawn_point_settles_without_falling_through() {
    let map = game_core::map::generate(8123, MapScale::Medium);
    for spawn in &map.meta.spawn_points {
        let mut st = MovementState::new(Body::new(Vec2::new(
            spawn.x as f32,
            spawn.y as f32 - PLAYER_H / 2.0,
        )));
        for _ in 0..240 {
            st.step(&map, &input(0), &Input::default(), 1.0, SIM_DT);
        }
        assert!(
            st.body.grounded,
            "spawn {spawn:?} never settled (y = {})",
            st.body.pos.y
        );
        // `FLOOR_CRUST`, not `BEDROCK_H`. §C15 took `BEDROCK_H` to 0, which
        // silently moved this bound from `h - 22` to `h + 2` — a body that fell
        // through the crust and came to rest on nothing would have passed. The
        // claim is "it settled on the ground, not at the bottom of the map", and
        // the ground is where generation stops laying rock.
        assert!(
            st.body.feet_y() < (map.mask.h - FLOOR_CRUST) as f32 + 2.0,
            "spawn {spawn:?} sank to the floor crust at y = {}",
            st.body.pos.y
        );
        assert!(
            !game_core::physics::aabb_overlaps_solid(&map, st.body.aabb()),
            "spawn {spawn:?} settled inside rock"
        );
    }
}
