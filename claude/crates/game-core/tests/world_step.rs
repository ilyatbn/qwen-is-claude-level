//! `World::step` — the tick ordering contract (`docs/41-server-loop-rooms.md` §2).
//!
//! These are the tests that keep a replay reproducing a live round. If the
//! determinism ones fail, the golden map hashes, the replay footer and the
//! bit-identical client masks all fail with them.

use game_core::constants::{MapScale, BASE_HEALTH, SIM_DT};
use game_core::items::registry::{BAZOOKA, MEDKIT};
use game_core::math::Vec2;
use game_core::player::input::{button, Input};
// `wield` alongside `give`: §F5 seats a shovel in slot 0 of every player, and
// `give` appends to the first *free* slot, so a fixture that only gives a
// bazooka and then fires is swinging. Four tests here went red on that; the
// others fire nothing and are unaffected, but the pairing is applied uniformly
// so the next one added does not have to rediscover it.
use game_core::world::{give, wield, GameEvent, RoundPhase, World};

const SEED: u64 = 4242;

/// Cached: nothing using this fixture is about generation. The two buried-secret
/// tests below are, and they call `World::new` themselves.
fn world() -> World {
    World::for_test(SEED, MapScale::Small)
}

/// A world already past warmup, which is where almost everything is testable.
fn playing() -> World {
    let mut w = world();
    w.set_phase(RoundPhase::Playing);
    let _ = w.drain_events();
    w
}

fn spawn_at(w: &mut World, id: u8) -> Vec2 {
    w.add_player(id, 0, format!("p{id}"));
    w.player(id).expect("just added").body.pos
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

#[test]
fn a_fresh_world_has_a_map_no_players_and_tick_zero() {
    let w = world();
    assert!(w.map.mask.w >= 2048, "map generated");
    assert!(w.players.is_empty());
    assert_eq!(w.tick, 0);
    assert_eq!(w.round_time, 0.0);
}

#[test]
fn step_advances_tick_by_one_and_round_time_by_dt() {
    let mut w = world();
    w.step(SIM_DT);
    assert_eq!(w.tick, 1);
    assert!((w.round_time - SIM_DT).abs() < 1e-6);
    w.step(SIM_DT);
    assert_eq!(w.tick, 2);
    assert!((w.round_time - 2.0 * SIM_DT).abs() < 1e-6);
}

// ---------------------------------------------------------------------------
// Determinism — the property everything else leans on
// ---------------------------------------------------------------------------

/// A scripted input sequence, so both worlds get byte-identical driving.
fn script(seq: u32) -> Input {
    let mut b = 0u8;
    if seq % 7 < 3 {
        b |= button::RIGHT;
    }
    if seq % 11 < 2 {
        b |= button::LEFT;
    }
    if seq.is_multiple_of(23) {
        b |= button::JUMP;
    }
    Input::new(seq, b, (seq.wrapping_mul(1013)) as u16)
}

#[test]
fn the_same_seed_and_inputs_give_the_same_state_hash_after_1000_ticks() {
    let run = || {
        let mut w = playing();
        spawn_at(&mut w, 1);
        spawn_at(&mut w, 2);
        for t in 1..=1000u32 {
            w.queue_input(1, script(t));
            w.queue_input(2, script(t + 5));
            w.step(SIM_DT);
        }
        w.state_hash()
    };
    assert_eq!(run(), run(), "same seed + same inputs must be identical");
}

/// The bug this catches is a `HashMap` creeping into the step: it only shows up
/// when insertion order differs, which is exactly what a joining player does.
#[test]
fn adding_players_in_either_order_gives_the_same_state_hash() {
    let run = |order: [u8; 3]| {
        // Seated during warmup, which is when a lobby actually fills.
        let mut w = world();
        for id in order {
            spawn_at(&mut w, id);
        }
        w.set_phase(RoundPhase::Playing);
        let _ = w.drain_events();
        for t in 1..=100u32 {
            for id in [1u8, 2, 3] {
                w.queue_input(id, script(t + id as u32));
            }
            w.step(SIM_DT);
        }
        w.state_hash()
    };
    assert_eq!(run([1, 2, 3]), run([3, 2, 1]));
}

#[test]
fn a_player_left_alone_settles_and_stays_bit_identical() {
    let mut w = playing();
    spawn_at(&mut w, 1);
    for _ in 0..600 {
        w.step(SIM_DT);
    }
    let settled = w.player(1).expect("alive").body.pos;
    let hash = w.state_hash();
    for _ in 0..600 {
        w.step(SIM_DT);
    }
    let after = w.player(1).expect("alive").body.pos;
    assert_eq!(
        settled.x.to_bits(),
        after.x.to_bits(),
        "x drifted: {settled:?} -> {after:?}"
    );
    assert_eq!(settled.y.to_bits(), after.y.to_bits(), "y drifted");
    // The world hash still moves (round_time is in it), so compare the part that
    // must not: the player's own position.
    assert_ne!(hash, w.state_hash(), "round time is part of the hash");
}

// ---------------------------------------------------------------------------
// Pickup ties — ascending PlayerId, always
// ---------------------------------------------------------------------------

#[test]
fn two_players_on_one_item_resolve_to_the_lower_id_every_time() {
    for _ in 0..100 {
        let mut w = playing();
        spawn_at(&mut w, 7);
        spawn_at(&mut w, 3);
        // Both bodies exactly on the item, so the tie is genuine.
        let at = Vec2::new(500.0, 300.0);
        if let Some(p) = w.player_mut(3) {
            p.body.pos = at;
        }
        if let Some(p) = w.player_mut(7) {
            p.body.pos = at;
        }
        let id = w.items.spawn(
            MEDKIT,
            1,
            at,
            Vec2::ZERO,
            game_core::items::world::SpawnSource::Initial,
            w.round_time,
        );
        w.step(SIM_DT);

        let winner = w
            .drain_events()
            .into_iter()
            .find_map(|e| match e {
                GameEvent::ItemPickup {
                    world_item_id,
                    player_id,
                    ..
                } if world_item_id == id => Some(player_id),
                _ => None,
            })
            .expect("someone picked it up");
        assert_eq!(winner, 3, "the lower id must always win");
    }
}

// ---------------------------------------------------------------------------
// Warmup gating
// ---------------------------------------------------------------------------

/// Fire a rocket into the ground at your own feet and check the two phases
/// disagree.
///
/// The control half is not optional. Two things silently make this vacuous: the
/// rocket may never explode near enough to hurt, and a freshly-added player is
/// inside `SPAWN_IFRAMES` for two seconds, which refuses all damage regardless of
/// phase. The first version of this test passed against a build with **no warmup
/// gate at all**.
fn self_rocket(phase: RoundPhase) -> f32 {
    let mut w = world();
    spawn_at(&mut w, 1);
    w.set_phase(phase);
    let _ = w.drain_events();

    // Outlast the spawn i-frames first, or nothing can be damaged in either phase.
    while w.round_time < game_core::constants::SPAWN_IFRAMES + 0.2 {
        w.step(SIM_DT);
    }
    give(&mut w, 1, BAZOOKA, 4);
    wield(&mut w, 1, BAZOOKA);
    if let Some(p) = w.player_mut(1) {
        p.aim = (0.25f32 * 65536.0) as u16; // +y is down: into the ground underfoot
    }
    w.fire(1, w.round_time).expect("armed");
    for _ in 0..60 {
        w.step(SIM_DT);
    }
    w.player(1).expect("alive").health
}

#[test]
fn a_rocket_at_your_own_feet_hurts_you() {
    // The control: without this, "warmup does no damage" is satisfied by a build
    // that does no damage ever.
    let hp = self_rocket(RoundPhase::Playing);
    assert!(
        hp < BASE_HEALTH,
        "self damage must land while playing, got {hp}"
    );
}

#[test]
fn no_damage_is_applied_during_warmup() {
    let hp = self_rocket(RoundPhase::Warmup);
    assert_eq!(hp, BASE_HEALTH, "warmup must not damage: {hp}");
}

#[test]
fn no_weather_and_no_item_spawns_during_warmup() {
    let mut w = world();
    spawn_at(&mut w, 1);
    let before = w.items.len();
    // Warmup is 10 s; item spawns are every 20 s and effects roll at 30 s+, so
    // run well past the point where a missing gate would fire.
    for _ in 0..(60 * 9) {
        w.step(SIM_DT);
    }
    assert_eq!(w.phase, RoundPhase::Warmup, "still warming up");
    let evs = w.drain_events();
    assert!(
        !evs.iter()
            .any(|e| matches!(e, GameEvent::EffectStart { .. })),
        "an effect started during warmup"
    );
    assert_eq!(w.items.len(), before, "items spawned during warmup");
}

#[test]
fn warmup_advances_to_playing_on_its_own() {
    let mut w = world();
    for _ in 0..(60 * 11) {
        w.step(SIM_DT);
    }
    assert_eq!(w.phase, RoundPhase::Playing);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[test]
fn firing_a_bazooka_produces_spawn_then_explosion_and_carve() {
    let mut w = playing();
    spawn_at(&mut w, 1);
    give(&mut w, 1, BAZOOKA, 4);
    wield(&mut w, 1, BAZOOKA);
    if let Some(p) = w.player_mut(1) {
        p.aim = (0.25f32 * 65536.0) as u16; // down, so it hits quickly
    }
    w.fire(1, w.round_time).expect("armed");

    let spawned = w
        .drain_events()
        .into_iter()
        .any(|e| matches!(e, GameEvent::ProjectileSpawn { .. }));
    assert!(spawned, "projectile_spawn");

    let mut saw_explosion = false;
    let mut saw_carve = false;
    for _ in 0..120 {
        w.step(SIM_DT);
        for e in w.drain_events() {
            match e {
                GameEvent::Explosion { .. } => saw_explosion = true,
                GameEvent::Carve { .. } => saw_carve = true,
                _ => {}
            }
        }
        if saw_explosion && saw_carve {
            break;
        }
    }
    assert!(saw_explosion, "explosion event");
    assert!(saw_carve, "carve event");
}

#[test]
fn an_explosion_emits_both_an_explosion_and_a_carve_never_one_merged() {
    let mut w = playing();
    spawn_at(&mut w, 1);
    give(&mut w, 1, BAZOOKA, 4);
    wield(&mut w, 1, BAZOOKA);
    if let Some(p) = w.player_mut(1) {
        p.aim = (0.25f32 * 65536.0) as u16;
    }
    w.fire(1, w.round_time).expect("armed");

    let mut explosions = 0;
    let mut carves = 0;
    for _ in 0..120 {
        w.step(SIM_DT);
        for e in w.drain_events() {
            match e {
                GameEvent::Explosion { .. } => explosions += 1,
                GameEvent::Carve { .. } => carves += 1,
                _ => {}
            }
        }
    }
    assert!(explosions > 0);
    assert_eq!(
        explosions, carves,
        "each blast is one explosion and one carve"
    );
}

#[test]
fn carve_sequence_numbers_are_monotonic_with_no_gaps() {
    let mut w = playing();
    spawn_at(&mut w, 1);
    give(&mut w, 1, BAZOOKA, 4);
    wield(&mut w, 1, BAZOOKA);
    let mut seqs = Vec::new();
    for shot in 0..4 {
        if let Some(p) = w.player_mut(1) {
            p.aim = (0.25f32 * 65536.0) as u16;
            p.fire_ready_at = 0.0;
        }
        let _ = w.fire(1, w.round_time);
        for _ in 0..90 {
            w.step(SIM_DT);
            for e in w.drain_events() {
                if let GameEvent::Carve { seq, .. } = e {
                    seqs.push(seq);
                }
            }
        }
        assert!(!seqs.is_empty(), "shot {shot} produced no carve");
    }
    for (i, s) in seqs.iter().enumerate() {
        assert_eq!(*s, i as u32 + 1, "carve seq must be 1,2,3… with no gaps");
    }
}

#[test]
fn a_death_produces_a_death_event_and_drops_every_stack() {
    let mut w = playing();
    spawn_at(&mut w, 1);
    give(&mut w, 1, BAZOOKA, 4);
    wield(&mut w, 1, BAZOOKA);
    give(&mut w, 1, MEDKIT, 2);
    if let Some(p) = w.player_mut(1) {
        p.health = 1.0;
        // Killed by the environment, so nobody is credited.
        p.health = 0.0;
    }
    w.step(SIM_DT);
    let evs = w.drain_events();

    let deaths = evs
        .iter()
        .filter(|e| matches!(e, GameEvent::Death { .. }))
        .count();
    assert_eq!(deaths, 1, "exactly one death");

    let drops = evs
        .iter()
        .filter(|e| {
            matches!(
                e,
                GameEvent::ItemSpawn {
                    source: game_core::items::world::SpawnSource::Death,
                    ..
                }
            )
        })
        .count();
    assert_eq!(drops, 2, "one world item per stack");
}

#[test]
fn drain_events_empties_the_queue() {
    let mut w = playing();
    spawn_at(&mut w, 1);
    w.step(SIM_DT);
    let _ = w.drain_events();
    assert!(w.drain_events().is_empty(), "second drain is empty");
}

#[test]
fn every_event_carries_the_tick_it_happened_on() {
    let mut w = playing();
    spawn_at(&mut w, 1);
    give(&mut w, 1, BAZOOKA, 4);
    wield(&mut w, 1, BAZOOKA);
    if let Some(p) = w.player_mut(1) {
        p.aim = (0.25f32 * 65536.0) as u16;
    }
    w.fire(1, w.round_time).expect("armed");
    let _ = w.drain_events();

    for _ in 0..120 {
        w.step(SIM_DT);
        let t = w.tick;
        for e in w.drain_events() {
            assert_eq!(e.tick(), t, "event {e:?} carries the wrong tick");
        }
    }
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/// `docs/60-testing.md` §6: a generous ceiling, so a 50× regression is caught and
/// normal variance is not.
#[test]
fn six_players_and_twenty_projectiles_step_under_two_milliseconds() {
    let mut w = playing();
    for id in 1..=6u8 {
        spawn_at(&mut w, id);
        give(&mut w, id, BAZOOKA, 4);
        wield(&mut w, id, BAZOOKA);
    }
    for id in 1..=6u8 {
        if let Some(p) = w.player_mut(id) {
            p.aim = ((id as f32 / 8.0) * 65536.0) as u16;
        }
        let _ = w.fire(id, w.round_time);
    }
    // Warm up, then measure a steady tick.
    for _ in 0..10 {
        w.step(SIM_DT);
    }
    let n = 100;
    let start = std::time::Instant::now();
    for _ in 0..n {
        w.step(SIM_DT);
        let _ = w.drain_events();
    }
    let per = start.elapsed().as_secs_f64() * 1000.0 / n as f64;
    // Debug builds are far slower than release; the ceiling is for release.
    let ceiling = if cfg!(debug_assertions) { 40.0 } else { 2.0 };
    assert!(per < ceiling, "tick took {per:.3} ms (ceiling {ceiling})");
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/// A spawn point is a **feet line**, not a body centre: `is_standable(x, y)` means
/// "the box whose bottom edge is at `y` fits". Handing one straight to `Body::new`
/// buries the lower half of the player in rock.
///
/// The failure mode is silent — the player is alive, grounded and at a plausible
/// position; they simply cannot move, because every horizontal step already
/// overlaps solid and step-up cannot clear it. Nothing short of asking them to walk
/// detects it, which is why this test does.
#[test]
fn a_spawned_player_is_not_buried_and_can_walk() {
    let mut w = playing();
    for id in 0..6u8 {
        w.add_player(id, 0, format!("p{id}"));
        let p = w.player(id).expect("seated");
        assert!(
            !game_core::physics::collide::aabb_overlaps_solid(&w.map, p.body.aabb()),
            "player {id} spawned inside rock at {:?}",
            p.body.pos
        );
    }

    let before: Vec<f32> = (0..6u8)
        .map(|id| w.player(id).expect("seated").body.pos.x)
        .collect();
    for seq in 1..=60u32 {
        for id in 0..6u8 {
            w.queue_input(id, Input::new(seq, button::RIGHT, 0));
        }
        w.step(SIM_DT);
    }
    for id in 0..6u8 {
        let after = w.player(id).expect("seated").body.pos.x;
        let moved = after - before[id as usize];
        assert!(
            moved > 1.0,
            "player {id} held right for a second and moved {moved} px"
        );
    }
}

/// The same for a respawn, which uses a different code path on a damaged map.
#[test]
fn a_respawned_player_is_not_buried_either() {
    let mut w = playing();
    spawn_at(&mut w, 1);
    if let Some(p) = w.player_mut(1) {
        p.health = 0.0;
    }
    // Death, then the respawn delay — **derived**, not a literal.
    //
    // This was `60 * 4` and broke silently when §B4 moved `RESPAWN_DELAY` from
    // 3.0 to 5.0: four seconds of ticks stopped being long enough and the test
    // began asserting "should have respawned" against a player who correctly had
    // not yet. A wait hardcoded against a tunable is a test that expires.
    let ticks = ((game_core::constants::RESPAWN_DELAY + 1.0) / SIM_DT).ceil() as u32;
    for _ in 0..ticks {
        w.step(SIM_DT);
    }
    let p = w.player(1).expect("seated");
    assert!(p.alive, "should have respawned");
    assert!(
        !game_core::physics::collide::aabb_overlaps_solid(&w.map, p.body.aabb()),
        "respawned inside rock at {:?}",
        p.body.pos
    );
}

// ---------------------------------------------------------------------------
// §A30 — packet rate must not be a speed multiplier
// ---------------------------------------------------------------------------

/// The server decides how much time an input is worth, and one input is worth
/// one tick.
///
/// Before `docs/70-amendments-v2.md` §A30 the tick applied *every* queued input
/// with a full `dt`, so a client sending 2 inputs per tick travelled 2.06x as
/// far as one sending 1 — server-authoritative movement defeated by the client
/// choosing its own packet rate.
///
/// **Measured over a single tick.** A 60-tick run walks into terrain, and once
/// both rates are stopped by the same wall they report the same distance and the
/// test passes against the bug — which is exactly what happened to the first
/// version of this test.
#[test]
fn sending_more_inputs_in_one_tick_does_not_move_you_further() {
    fn one_tick(inputs: u32) -> f32 {
        let mut w = playing();
        let start = spawn_at(&mut w, 1);
        // Seq 0, numbered by the world (T22.10G): a client-numbered first input
        // waits out the jitter buffer's lead, so one or two of them would not
        // move on this tick at all while eight (a trim) would.
        for _ in 1..=inputs {
            w.queue_input(
                1,
                Input {
                    seq: 0,
                    buttons: button::RIGHT,
                    aim: 0,
                },
            );
        }
        w.step(SIM_DT);
        w.player(1).expect("player").body.pos.x - start.x
    }

    let one = one_tick(1);
    let two = one_tick(2);
    let eight = one_tick(8);

    // The control: a tick that produces no movement makes every comparison
    // below vacuously true.
    assert!(
        one.abs() > 0.001,
        "one input produced no movement at all ({one:.6} px); nothing is proven"
    );
    assert!(
        (two - one).abs() < 0.001,
        "2 inputs in one tick moved {two:.4} px against {one:.4} px for 1 — \
         packet rate is a speed multiplier"
    );
    assert!(
        (eight - one).abs() < 0.001,
        "8 inputs in one tick moved {eight:.4} px against {one:.4} px for 1"
    );
}

// ---------------------------------------------------------------------------
// T22.10F (coordinator ruling R89) — one simulated step per player per tick
// ---------------------------------------------------------------------------

fn walk(seq: u32) -> Input {
    Input::new(seq, button::RIGHT, 0)
}

/// What a scenario sends on one tick: `Stream` is the one input a steady client's
/// tick carries, `Burst(n)` the next `n` seqs at once, `Silent` nothing.
#[derive(Clone, Copy)]
enum Send {
    Stream,
    Burst(u32),
    Silent,
}

/// Plays `plan` into a walking world — `warm` one-per-tick inputs first, so a
/// stream exists to stand in for — and returns the body's position after every
/// tick, the backlog (inputs sent minus the last simulated seq) after every tick,
/// and the most any tick left queued. Every input is a walk, so **any world that
/// steps each player exactly once a tick walks the same path whatever the plan**:
/// a tick that steps twice (a dash) or not at all (a hover) is a different path.
fn play(warm: u32, plan: &[Send]) -> (Vec<Vec2>, Vec<u32>, usize) {
    let mut w = playing();
    spawn_at(&mut w, 1);
    let mut sent = 0u32;
    let (mut path, mut backlog, mut most) = (Vec::new(), Vec::new(), 0usize);
    let warmup = std::iter::repeat_n(Send::Stream, warm as usize);
    for (t, send) in warmup.chain(plan.iter().copied()).enumerate() {
        let n = match send {
            Send::Stream => 1,
            Send::Burst(n) => n,
            Send::Silent => 0,
        };
        for _ in 0..n {
            sent += 1;
            w.queue_input(1, walk(sent));
        }
        w.step(SIM_DT);
        if t >= warm as usize {
            path.push(w.player(1).expect("seated").body.pos);
            let acked = w.last_simulated_seq(1).expect("seated");
            backlog.push(sent.saturating_sub(acked));
            most = most.max(w.pending_len());
        }
    }
    (path, backlog, most)
}

/// §A30 under R89: **packet rate is not a speed multiplier, and neither is a
/// burst.** A client sending two inputs every tick, one frame's burst after a
/// long frame, and the review's split bursts (T22.10E: silence, then 2|6, 3|5
/// and 3|12 across two ticks, then one a tick — under the catch-up credit the
/// last left 13 inputs, ~217 ms, standing forever) all walk the one-a-tick path
/// exactly, and none leaves more than `INPUT_BACKLOG_TARGET` behind once the
/// burst is over. The control is that the path moves at all, and that each
/// burst really did arrive more than the target at once.
#[test]
fn every_tick_steps_each_player_once_whatever_arrives() {
    use game_core::constants::{INPUT_BACKLOG_TARGET, MAX_FRAME_TICKS};
    const WARM: u32 = 10;
    const AFTER: usize = 3 * MAX_FRAME_TICKS;
    let frame = MAX_FRAME_TICKS as u32;
    let stream = |n: usize| std::iter::repeat_n(Send::Stream, n);
    let silent = |n: u32| std::iter::repeat_n(Send::Silent, n as usize);
    let split = |gap: u32, a: u32, b: u32| -> Vec<Send> {
        silent(gap)
            .chain([Send::Burst(a), Send::Burst(b)])
            .chain(stream(AFTER))
            .collect()
    };
    let (reference, _, _) = play(
        WARM,
        &stream(AFTER + 2 * frame as usize).collect::<Vec<_>>(),
    );
    assert!(
        (reference[AFTER] - reference[0]).len() > 1.0,
        "control: the walk moved nobody, so no path below can differ"
    );
    let scenarios: Vec<(&str, Vec<Send>)> = vec![
        (
            "two a tick",
            std::iter::repeat_n(Send::Burst(2), AFTER).collect(),
        ),
        (
            "a long frame",
            silent(frame)
                .chain([Send::Burst(frame)])
                .chain(stream(AFTER))
                .collect(),
        ),
        ("2|6", split(8, 2, 6)),
        ("3|5", split(8, 3, 5)),
        ("3|12", split(frame, 3, 12)),
    ];
    for (name, plan) in scenarios {
        let (path, backlog, _) = play(WARM, &plan);
        for (t, (got, want)) in path.iter().zip(&reference).enumerate() {
            assert!(
                (*got - *want).len() < 1e-4,
                "{name}: at tick {t} the body is {:.2} px off the one-step-a-tick path — \
                 a tick stepped it twice or not at all",
                (*got - *want).len()
            );
        }
        let settled = &backlog[backlog.len() - MAX_FRAME_TICKS..];
        assert!(
            settled.iter().all(|b| *b as usize <= INPUT_BACKLOG_TARGET),
            "{name}: {settled:?} inputs still stood behind the simulation a frame's worth \
             of ticks before the end — a standing delay (bound {INPUT_BACKLOG_TARGET})"
        );
    }
    let (_, backlog, most) = play(
        WARM,
        &std::iter::repeat_n(Send::Burst(2), AFTER).collect::<Vec<_>>(),
    );
    assert!(
        backlog.iter().any(|b| *b as usize > INPUT_BACKLOG_TARGET) || most == INPUT_BACKLOG_TARGET,
        "control: two a tick never filled the jitter buffer (backlog {backlog:?})"
    );
}

/// T22.10E F-1's exploit, under R89: **silence is not a bank.** Silent while
/// alive, dead through a respawn, or silent through warmup; then honest ticks (or
/// none); then a frame's worth of *future* seqs in one tick — the 2× dash the
/// review of `d2d4c07` measured at 5.00 px/tick against a walk's 2.50. The honest
/// ticks stand still (a walk would reach a wall before the burst). Each run
/// is compared, tick by tick, with the same bank followed by one input a tick:
/// any tick that ran two of the burst is ahead of that path. The control is that
/// the reference path moves during the burst's ticks.
#[test]
fn a_bank_then_a_burst_of_future_seqs_is_no_dash() {
    use game_core::constants::{MAX_FRAME_TICKS, RESPAWN_DELAY, SIM_HZ};
    let silent = MAX_FRAME_TICKS as u32;
    type Bank = fn(u32) -> World;
    let banks: [(&str, Bank); 3] = [
        ("silent", |silent| {
            let mut w = playing();
            spawn_at(&mut w, 1);
            for _ in 0..silent {
                w.step(SIM_DT);
            }
            w
        }),
        ("dead", |_| {
            let mut w = playing();
            spawn_at(&mut w, 1);
            if let Some(p) = w.player_mut(1) {
                p.health = 0.0;
            }
            w.step(SIM_DT);
            assert!(!w.player(1).expect("seated").alive, "control: not killed");
            let limit = ((RESPAWN_DELAY + 1.0) * SIM_HZ as f32) as u32;
            let mut ticks = 0;
            while !w.player(1).expect("seated").alive {
                assert!(ticks < limit, "control: never respawned");
                w.step(SIM_DT);
                ticks += 1;
            }
            // T22.10G: settle the respawn's fall, silent. The comparison below is
            // shifted by the stream's lead, so it holds only from a body at rest.
            for _ in 0..SIM_HZ {
                w.step(SIM_DT);
            }
            w
        }),
        ("warmup", |silent| {
            let mut w = world();
            w.set_phase(RoundPhase::Warmup);
            spawn_at(&mut w, 1);
            for _ in 0..silent {
                w.step(SIM_DT);
            }
            assert_eq!(w.phase, RoundPhase::Warmup, "control: warmup ended early");
            w.set_phase(RoundPhase::Playing);
            // T22.10G: before its first input a body is not stepped in warmup, so
            // it is still at its spawn; settle it (silent) for the shifted
            // comparison below, as the dead bank does its respawn.
            for _ in 0..game_core::constants::SIM_HZ {
                w.step(SIM_DT);
            }
            w
        }),
    ];
    let ticks = 2 * MAX_FRAME_TICKS as u32;
    for (bank, make) in banks {
        for honest in [0u32, 60] {
            let run = |burst: bool| {
                let mut w = make(silent);
                let mut sent = 0u32;
                for _ in 0..honest {
                    sent += 1;
                    w.queue_input(1, Input::new(sent, 0, 0));
                    w.step(SIM_DT);
                }
                let mut path = Vec::new();
                for t in 0..ticks {
                    let n = if burst {
                        if t == 0 {
                            silent
                        } else {
                            0
                        }
                    } else {
                        1
                    };
                    for _ in 0..n {
                        sent += 1;
                        w.queue_input(1, walk(sent));
                    }
                    w.step(SIM_DT);
                    path.push(w.player(1).expect("seated").body.pos);
                }
                path
            };
            let (reference, burst) = (run(false), run(true));
            assert!(
                (reference[reference.len() - 1] - reference[0]).len() > 1.0,
                "control: bank {bank}, {honest} honest: the reference did not move"
            );
            // T22.10G: the stream runs `INPUT_BACKLOG_TARGET` behind the newest
            // sent (the jitter buffer's lead), while the burst is a trim and runs
            // newest − target at once — so the burst's tick `t` is the stream's
            // `t + target`. A tick that ran two is still ahead of that.
            let reference = &reference[game_core::constants::INPUT_BACKLOG_TARGET..];
            for (t, (got, want)) in burst.iter().zip(reference).enumerate() {
                assert!(
                    (*got - *want).len() < 1e-4,
                    "banked {bank}, then {honest} honest ticks: {t} ticks into a burst of \
                     future seqs the body is {:.2} px off the one-a-tick path — a dash",
                    (*got - *want).len()
                );
            }
        }
    }
}

/// **T22.10F: a silent player falls** (was `t2210f_a_silent_player_hangs_in_the_air_today`,
/// which pinned 0.00 px). A body lifted into open air and sent nothing for a
/// second is stepped every tick by a stand-in — here the neutral held state of a
/// player who never pressed anything — so it falls exactly as far as the control,
/// the same body sent a neutral input every tick (224.78 px, measured when this
/// was filed). A lag switch no longer hovers.
#[test]
fn a_silent_player_falls_under_gravity() {
    use game_core::constants::{PLAYER_H, SIM_HZ};
    let run = |send: bool| {
        let mut w = playing();
        spawn_at(&mut w, 1);
        if let Some(p) = w.player_mut(1) {
            p.body.pos.y -= PLAYER_H * 8.0;
            p.body.vel = Vec2::ZERO;
            p.body.grounded = false;
        }
        let from = w.player(1).expect("seated").body.pos;
        for seq in 1..=SIM_HZ {
            if send {
                w.queue_input(1, Input::new(seq, 0, 0));
            }
            w.step(SIM_DT);
        }
        w.player(1).expect("seated").body.pos.y - from.y
    };
    let neutral = run(true);
    assert!(
        neutral > PLAYER_H,
        "control: a body sent neutral inputs fell only {neutral:.2} px in a second"
    );
    let silent = run(false);
    assert!(
        (silent - neutral).abs() < 1e-3,
        "a silent player fell {silent:.2} px in a second against {neutral:.2} px for one \
         sent neutral inputs — the silent ticks were not integrated (T22.10F)"
    );
}

/// The expected seq (R89): **a stand-in claims the next seq, a late input is
/// discarded but still steers, and a client that lost time is not locked out.**
/// A stand-in claims a seq only within `MAX_FRAME_TICKS` of the newest sent: past
/// that the client's clock has fallen behind the server's (a hidden tab's frames
/// are capped at `MAX_FRAME_DT`) and a claimed seq would discard its every input.
#[test]
fn the_expected_seq_runs_one_a_tick_and_stops_a_frame_ahead() {
    use game_core::constants::MAX_FRAME_TICKS;
    let frame = MAX_FRAME_TICKS as u32;
    let mut w = playing();
    spawn_at(&mut w, 1);
    for _ in 0..frame {
        w.step(SIM_DT);
    }
    assert_eq!(
        w.last_simulated_seq(1),
        Some(0),
        "a player who never sent claimed a seq — there is no stream to stand in for"
    );
    for seq in 1..=3 {
        w.queue_input(1, walk(seq));
        w.step(SIM_DT);
    }
    // T22.10G: the first input waits out the buffer's lead, so three ticks of one
    // a tick have simulated `3 − INPUT_BACKLOG_TARGET` and hold the rest.
    let lead = game_core::constants::INPUT_BACKLOG_TARGET as u32;
    assert_eq!(
        w.last_simulated_seq(1),
        Some(3 - lead),
        "the first input did not wait out the jitter buffer's lead"
    );
    for _ in 0..lead {
        w.step(SIM_DT);
    }
    assert_eq!(
        w.last_simulated_seq(1),
        Some(3),
        "control: the buffer drained one real input a tick"
    );
    let x = w.player(1).expect("seated").body.pos.x;
    w.step(SIM_DT);
    assert_eq!(
        w.last_simulated_seq(1),
        Some(4),
        "a stand-in claims the next seq"
    );
    let walked = w.player(1).expect("seated").body.pos.x - x;
    assert!(
        walked > 0.0,
        "the stand-in did not hold the walk ({walked:.3} px)"
    );
    // Seq 4 arrives after its tick, pressing LEFT: discarded, but the next
    // stand-in steers by it.
    w.queue_input(1, Input::new(4, button::LEFT, 0));
    let vx = w.player(1).expect("seated").body.vel.x;
    w.step(SIM_DT);
    assert_eq!(
        w.last_simulated_seq(1),
        Some(5),
        "the late seq 4 moved the expected seq"
    );
    assert_eq!(w.pending_len(), 0, "the late seq 4 was queued");
    let now = w.player(1).expect("seated").body.vel.x;
    assert!(
        now < vx,
        "the stand-in after a late LEFT did not steer left (vx {vx:.2} -> {now:.2})"
    );
    // Lost time: silent far longer than a frame. The seq stops a frame ahead of
    // the newest sent (4) while the body goes on being stepped.
    for _ in 0..3 * frame {
        w.step(SIM_DT);
    }
    assert_eq!(
        w.last_simulated_seq(1),
        Some(4 + frame),
        "the seq ran past a frame ahead"
    );
    // The client's next frame — capped at a frame's inputs — is all at or below
    // it, and the input after it is simulated on the next tick.
    for seq in 5..=4 + frame {
        w.queue_input(1, walk(seq));
    }
    w.step(SIM_DT);
    assert_eq!(w.pending_len(), 0, "a frame of already-run seqs was kept");
    w.queue_input(1, walk(5 + frame + 1));
    w.step(SIM_DT);
    assert_eq!(
        w.last_simulated_seq(1),
        Some(5 + frame + 1),
        "the client's first input after the lost time was not simulated on its tick"
    );
}

/// **T22.10G — the jitter buffer R89 asked for.** A client's inputs arrive a tick
/// late or two at once (a 59 fps page against a 60 Hz server, TCP), and with no
/// lead every late one was a stand-in — 57 % of `teleport`'s ticks. The first
/// input now waits `INPUT_BACKLOG_TARGET` ticks, so a stream jittered by one tick
/// either way is simulated from real inputs only: the same path, tick for tick,
/// as the same stream arriving one a tick. The inputs change direction every few
/// seqs, so a stand-in (the newest held input run under the wrong seq) is off the
/// path; the control is that the jittered arrivals really did leave ticks with
/// nothing new to run, and that the reference walks at all.
#[test]
fn a_stream_jittered_by_a_tick_is_never_stood_in() {
    const TICKS: u32 = 120;
    let dir = |seq: u32| {
        if (seq / 5).is_multiple_of(2) {
            button::RIGHT
        } else {
            button::LEFT
        }
    };
    // Arrivals per tick: one a tick, or a tick late then two at once.
    let run = |jitter: bool| {
        let mut w = playing();
        spawn_at(&mut w, 1);
        let (mut sent, mut path, mut starved) = (0u32, Vec::new(), 0u32);
        for t in 0..TICKS {
            let n = match (jitter, t % 3) {
                (false, _) | (true, 0) => 1,
                (true, 1) => 0,
                (true, _) => 2,
            };
            for _ in 0..n {
                sent += 1;
                w.queue_input(1, Input::new(sent, dir(sent), 0));
            }
            // A server with no lead runs seq `t + 1` on tick `t`: starved when it
            // has not arrived — a stand-in there.
            if sent < t + 1 {
                starved += 1;
            }
            w.step(SIM_DT);
            path.push(w.player(1).expect("seated").body.pos);
        }
        (path, starved)
    };
    let (reference, _) = run(false);
    let span = reference
        .iter()
        .map(|p| p.x)
        .fold(f32::NEG_INFINITY, f32::max)
        - reference.iter().map(|p| p.x).fold(f32::INFINITY, f32::min);
    assert!(span > 1.0, "control: the reference walked {span:.2} px");
    let (jittered, starved) = run(true);
    assert!(
        starved > 0,
        "control: the jittered arrivals never starved a server with no lead — they \
         test no jitter"
    );
    for (t, (got, want)) in jittered.iter().zip(&reference).enumerate() {
        assert!(
            (*got - *want).len() < 1e-4,
            "a stream a tick late every third tick: at tick {t} the body is {:.2} px off \
             the same stream arriving one a tick — a stand-in ran where the jitter \
             buffer should have held a real input",
            (*got - *want).len()
        );
    }
}

/// **T22.10G: before its first input, a body waits in warmup and falls in
/// `Playing`.** Warmup is the one window a player is not stepped — the pre-T22.10F
/// behaviour, which is what the client predicts from (its first seq runs from the
/// spawn it was handed) — and it is bounded by the warmup, since joins are refused
/// mid-match. `a_silent_player_falls_under_gravity` is the `Playing` half; this
/// pins the warmup half and its control in one place.
#[test]
fn a_body_is_not_stepped_before_its_first_input_only_in_warmup() {
    use game_core::constants::{MAX_FRAME_TICKS, PLAYER_H};
    let drop = |phase: RoundPhase| {
        let mut w = world();
        w.set_phase(phase);
        spawn_at(&mut w, 1);
        if let Some(p) = w.player_mut(1) {
            p.body.pos.y -= PLAYER_H * 8.0;
            p.body.vel = Vec2::ZERO;
            p.body.grounded = false;
        }
        let from = w.player(1).expect("seated").body.pos.y;
        for _ in 0..MAX_FRAME_TICKS {
            w.step(SIM_DT);
        }
        assert_eq!(w.phase, phase, "control: the phase moved on");
        w.player(1).expect("seated").body.pos.y - from
    };
    let playing = drop(RoundPhase::Playing);
    assert!(
        playing > 1.0,
        "a silent body in Playing fell {playing:.2} px — it hangs in the air mid-round"
    );
    let warmup = drop(RoundPhase::Warmup);
    assert!(
        warmup.abs() < 1e-6,
        "a body that never sent an input moved {warmup:.2} px in warmup — the server \
         stepped it before its first input, so the client's first seq (run from the \
         spawn) disagrees with every ack-0 snapshot"
    );
}

/// **T22.10G, from the T22.10F review: a held JUMP that goes silent jumps once.**
/// A stand-in repeats the newest input's held buttons, and every edge is `current`
/// against `prev` — so the stood-in ticks of a held JUMP press nothing. The review
/// planted "a stand-in steps against a released previous input" (every stood-in
/// tick a fresh press) and nothing went red. The controls: the silence really was
/// stood in (the ack ran past the last seq sent), the jump happened, and the body
/// came back to the ground during the silence, so a second jump was possible.
#[test]
fn a_held_jump_that_goes_silent_jumps_exactly_once() {
    use game_core::constants::SIM_HZ;
    let mut w = playing();
    spawn_at(&mut w, 1);
    let mut sent = 0u32;
    // Settle, sending neutral one a tick (the stream the stand-ins continue).
    for _ in 0..SIM_HZ {
        sent += 1;
        w.queue_input(1, Input::new(sent, 0, 0));
        w.step(SIM_DT);
    }
    let settled = w.player(1).expect("seated").body.grounded;
    assert!(settled, "control: the body never settled");
    let (mut jumps, mut landed_after, mut airborne) = (0u32, false, false);
    let mut was_grounded = true;
    let hold = 3;
    for t in 0..3 * SIM_HZ {
        if t < hold {
            sent += 1;
            w.queue_input(1, Input::new(sent, button::JUMP, 0));
        }
        w.step(SIM_DT);
        let p = w.player(1).expect("seated");
        if was_grounded && !p.body.grounded && p.body.vel.y < 0.0 {
            jumps += 1;
        }
        airborne |= !p.body.grounded;
        if airborne && p.body.grounded && t > hold {
            landed_after = true;
        }
        was_grounded = p.body.grounded;
    }
    let acked = w.last_simulated_seq(1).expect("seated");
    assert!(
        acked > sent,
        "control: the silence was not stood in (ack {acked}, last sent {sent})"
    );
    assert!(
        landed_after,
        "control: the body never came down during the silence"
    );
    assert_eq!(
        jumps, 1,
        "a JUMP held into silence jumped {jumps} times — a stood-in tick fired the \
         jump edge again"
    );
}

/// A client that sends faster than the sim runs, forever, must not queue an
/// unbounded future: the jitter buffer keeps `INPUT_BACKLOG_TARGET` after a tick.
#[test]
fn the_input_backlog_is_bounded() {
    use game_core::constants::INPUT_BACKLOG_TARGET;
    let mut w = playing();
    spawn_at(&mut w, 1);
    for seq in 1..=500u32 {
        w.queue_input(1, walk(seq));
    }
    w.step(SIM_DT);
    assert_eq!(
        w.pending_len(),
        INPUT_BACKLOG_TARGET,
        "the jitter buffer kept {} against a target of {INPUT_BACKLOG_TARGET}",
        w.pending_len()
    );
    assert_eq!(
        w.last_simulated_seq(1),
        Some(500 - INPUT_BACKLOG_TARGET as u32),
        "the excess was not the oldest"
    );
}

// ---------------------------------------------------------------------------
// §A31 — buried slots must not be recomputable from the seed
// ---------------------------------------------------------------------------

/// `welcome` carries the seed and `game-core` ships as WASM, so a modified
/// client can call the generator itself. Hiding buried slots from an honest
/// client is not hiding them.
#[test]
fn a_buried_secret_moves_the_slots_for_the_same_seed() {
    let plain = World::new(SEED, MapScale::Small);
    let secret = World::with_buried_secret(SEED, MapScale::Small, 0xDEAD_BEEF_CAFE_F00D);

    let a: Vec<_> = plain.map.meta.buried_slots.iter().map(|s| s.pos).collect();
    let b: Vec<_> = secret.map.meta.buried_slots.iter().map(|s| s.pos).collect();

    // The control: a map with no buried slots would make "they differ" vacuous.
    assert!(
        !a.is_empty(),
        "no buried slots were placed; nothing is proven"
    );
    assert_ne!(
        a, b,
        "the same seed produced the same buried slots with and without a secret"
    );

    // Everything else about the map must be untouched — the secret feeds the
    // buried stream only, or it would invalidate every golden hash.
    assert_eq!(
        plain.map.mask.hash_hex(),
        secret.map.mask.hash_hex(),
        "the secret changed the terrain, not just the buried slots"
    );
    assert_eq!(plain.map.meta.spawn_points, secret.map.meta.spawn_points);
}

/// Default zero, so every existing golden table and sweep is unaffected.
#[test]
fn the_default_secret_reproduces_the_plain_generator() {
    let a = World::new(SEED, MapScale::Small);
    let b = World::with_buried_secret(SEED, MapScale::Small, 0);
    let pa: Vec<_> = a.map.meta.buried_slots.iter().map(|s| s.pos).collect();
    let pb: Vec<_> = b.map.meta.buried_slots.iter().map(|s| s.pos).collect();
    assert_eq!(pa, pb);
}

/// A rocket at your own feet is a **self-kill**, not a death by the map.
///
/// This goes through the real derivation — fire, take the damage, let
/// `resolve_deaths` decide — because that is where the bug was. The existing
/// unit test passed `DeathCause::SelfInflicted` into `killer()` as its input and
/// so could never have caught it: it handed the function the answer.
///
/// `apply_damage` recorded `last_damaged_by` only for `DamageSource::Player`, so
/// after a rocket-jump death `resolve_deaths` saw no recent attacker and fell
/// through to `Weather`. **Scoring hid it**: a self-kill and a weather death are
/// both −1 with no credit (`docs/21` §6), so every score assertion passed. Only
/// the cause was wrong, and nothing read the cause until the death overlay did —
/// which reported "Killed by weather" for a player who had rocketed themselves.
#[test]
fn a_rocket_at_your_own_feet_is_a_self_kill_and_not_the_weather() {
    let mut w = world();
    spawn_at(&mut w, 1);
    w.set_phase(RoundPhase::Playing);
    let _ = w.drain_events();
    while w.round_time < game_core::constants::SPAWN_IFRAMES + 0.2 {
        w.step(SIM_DT);
    }
    if let Some(p) = w.player_mut(1) {
        p.health = 20.0; // one rocket is enough
        p.aim = (0.25f32 * 65536.0) as u16;
    }
    give(&mut w, 1, BAZOOKA, 4);
    wield(&mut w, 1, BAZOOKA);
    w.fire(1, w.round_time).expect("armed");

    let mut death = None;
    for _ in 0..120 {
        w.step(SIM_DT);
        for e in w.drain_events() {
            if let GameEvent::Death {
                victim,
                attacker,
                cause,
                ..
            } = e
            {
                death = Some((victim, attacker, cause));
            }
        }
        if death.is_some() {
            break;
        }
    }

    let (victim, attacker, cause) = death.expect("the rocket must have killed them");
    assert_eq!(victim, 1);
    assert_eq!(
        cause,
        game_core::player::state::DeathCause::SelfInflicted,
        "a rocket-jump death is self-inflicted, not weather"
    );
    assert_eq!(
        attacker,
        Some(1),
        "attacker is the victim, which is what makes the client say \
         'You killed yourself' rather than 'Killed by the map'"
    );
}

/// The control for the test above: a death with **no** damage at all really is
/// the weather, and must not be relabelled as a self-kill by the fix.
#[test]
fn a_death_with_no_attacker_is_still_the_weather() {
    let mut w = playing();
    spawn_at(&mut w, 1);
    let _ = w.drain_events();
    if let Some(p) = w.player_mut(1) {
        p.health = 0.0;
    }
    w.step(SIM_DT);
    let cause = w.drain_events().into_iter().find_map(|e| match e {
        GameEvent::Death {
            attacker, cause, ..
        } => Some((attacker, cause)),
        _ => None,
    });
    assert_eq!(
        cause,
        Some((None, game_core::player::state::DeathCause::Weather)),
        "nobody touched them, so nobody is to blame"
    );
}

/// A death leaves a grave where you fell (§B8).
///
/// Asserted at the **world** level, not on `Tombstones` alone: the unit tests
/// prove a stone falls and the cap holds, and would all still pass if the death
/// path never called `place`. That is §A39's shape — five mechanisms on this
/// project were built, unit-tested and never wired — so the wiring gets its own
/// assertion.
#[test]
fn a_death_leaves_a_tombstone_where_the_player_fell() {
    let mut w = playing();
    let pos = spawn_at(&mut w, 1);
    let _ = w.drain_events();
    assert_eq!(w.tombstones.len(), 0, "no graves before anyone dies");

    if let Some(p) = w.player_mut(1) {
        p.tombstone_skin_id = 3;
        p.health = 0.0;
    }
    w.step(SIM_DT);

    let ev = w.drain_events().into_iter().find_map(|e| match e {
        GameEvent::TombstoneSpawn {
            owner,
            x,
            y,
            skin_id,
            ..
        } => Some((owner, x, y, skin_id)),
        _ => None,
    });
    let (owner, x, y, skin) = ev.expect("a death must announce a tombstone");
    assert_eq!(owner, 1);
    assert_eq!(skin, 3, "the player's chosen grave, carried through");
    assert_eq!(w.tombstones.len(), 1);
    // Where they fell, within a pixel — the body has not fallen yet this tick.
    assert!(
        (x - pos.x).abs() < 2.0 && (y - pos.y).abs() < 2.0,
        "grave at ({x}, {y}) but they died at {pos:?}"
    );
}

/// The graveyard is capped, and the eviction is announced.
///
/// A client that never hears the despawn draws a grave the server has forgotten,
/// which is the same leak as an item drawn by nothing — just in the other
/// direction.
#[test]
fn the_graveyard_is_capped_and_evictions_are_announced() {
    let mut w = playing();
    spawn_at(&mut w, 1);
    let _ = w.drain_events();
    let cap = game_core::constants::MAX_TOMBSTONES;

    let mut despawns = 0;
    for _ in 0..(cap + 3) {
        if let Some(p) = w.player_mut(1) {
            p.alive = true;
            p.health = 0.0;
        }
        w.step(SIM_DT);
        despawns += w
            .drain_events()
            .iter()
            .filter(|e| matches!(e, GameEvent::TombstoneDespawn { .. }))
            .count();
    }
    assert_eq!(w.tombstones.len(), cap, "the cap holds");
    assert_eq!(despawns, 3, "three over the cap, three evictions announced");
}

// ---------------------------------------------------------------------------
// T20.09 — dropping a slot on the ground
// ---------------------------------------------------------------------------

/// The tile empties, the world gains the item, **counted at both ends**.
///
/// The stack that leaves the inventory and the one that appears on the ground
/// are asserted against each other rather than each against a literal: a drop
/// that halved a count, or dropped a different item, satisfies "the slot is
/// empty" and "something is on the ground" separately.
#[test]
fn dropping_a_slot_moves_the_whole_stack_to_the_ground_at_your_feet() {
    let mut w = playing();
    let at = spawn_at(&mut w, 0);
    give(&mut w, 0, BAZOOKA, 2);
    let slot = (0..game_core::constants::INVENTORY_SLOTS as u8)
        .find(|s| {
            w.player(0)
                .and_then(|p| p.inventory.slot(*s))
                .is_some_and(|st| st.item == BAZOOKA)
        })
        .expect("the bazooka is in a slot");
    let held = w
        .player(0)
        .and_then(|p| p.inventory.slot(slot))
        .expect("a stack to drop");
    let before = w.items.iter().count();
    let _ = w.drain_events();

    assert!(w.drop_item(0, slot), "the drop was refused");

    assert!(
        w.player(0).and_then(|p| p.inventory.slot(slot)).is_none(),
        "the tile still holds something"
    );
    assert_eq!(
        w.items.iter().count(),
        before + 1,
        "nothing reached the ground"
    );
    let dropped = w.items.iter().last().expect("the dropped item");
    assert_eq!(
        dropped.item, held.item,
        "a different item reached the ground"
    );
    assert_eq!(
        dropped.count, held.count,
        "the count changed on the way down"
    );
    assert!(
        (dropped.pos - at).len() < 1.0,
        "the drop landed {:.0} px from the player, not at their feet",
        (dropped.pos - at).len()
    );
    // The client is told twice, and both are needed: `Inventory` redraws the
    // bag, `ItemSpawn` draws the thing on the floor. A drop that emitted only
    // the first would leave an invisible item to walk into.
    let evs = w.drain_events();
    assert!(
        evs.iter()
            .any(|e| matches!(e, GameEvent::Inventory { player_id, .. } if *player_id == 0)),
        "no inventory event: the bag on screen still shows the item"
    );
    assert!(
        evs.iter().any(|e| matches!(e, GameEvent::ItemSpawn { .. })),
        "no item_spawn event: nothing is drawn where it landed"
    );
}

/// It is not picked straight back up — **with the control that it can be
/// afterwards.**
///
/// `resolve_pickups` collects anything inside `PICKUP_RADIUS` and a drop lands
/// at the player's feet, so without `DROP_PICKUP_LOCK` the gesture does nothing
/// at all. The second half is what stops this passing for an item that has
/// become permanently uncollectable.
#[test]
fn a_dropped_item_is_not_hoovered_back_up_and_can_be_taken_once_the_lock_expires() {
    let mut w = playing();
    spawn_at(&mut w, 0);
    give(&mut w, 0, MEDKIT, 1);
    let slot = (0..game_core::constants::INVENTORY_SLOTS as u8)
        .find(|s| {
            w.player(0)
                .and_then(|p| p.inventory.slot(*s))
                .is_some_and(|st| st.item == MEDKIT)
        })
        .expect("the medkit is in a slot");
    assert!(w.drop_item(0, slot));
    // **By id, not by count.** A live world keeps spawning periodic items, so
    // `items.len()` is about the spawn schedule and not about this drop — it
    // read 9 the first time this was written that way.
    let dropped = w.items.iter().last().expect("the dropped medkit").id;
    let still_there = |w: &World| w.items.iter().any(|i| i.id == dropped);

    // Stand still on top of it for the whole lock.
    let ticks = (game_core::constants::DROP_PICKUP_LOCK / SIM_DT) as u32;
    for _ in 0..ticks {
        w.step(SIM_DT);
    }
    assert!(
        still_there(&w),
        "the item was picked back up inside DROP_PICKUP_LOCK — the drop did nothing"
    );

    // The control: keep standing there, past the lock.
    for _ in 0..ticks {
        w.step(SIM_DT);
    }
    assert!(
        !still_there(&w),
        "the item was never collectable again, so the assertion above is about a \
         broken pickup rather than about the lock"
    );
}

/// The **starting kit** cannot be dropped, and the control is a stack that can.
///
/// §F5: "no ammo, and it cannot be dropped or lost". Refused through
/// `STARTING_KIT`, not by naming the shovel — the list is what `die` filters on,
/// and §F7's `all` start kit makes "the kit grows" a live possibility.
#[test]
fn the_starting_kit_cannot_be_dropped_and_an_ordinary_stack_can() {
    let mut w = playing();
    spawn_at(&mut w, 0);
    let kit = *game_core::player::state::STARTING_KIT
        .first()
        .expect("a starting kit");
    let kit_slot = (0..game_core::constants::INVENTORY_SLOTS as u8)
        .find(|s| {
            w.player(0)
                .and_then(|p| p.inventory.slot(*s))
                .is_some_and(|st| st.item == kit)
        })
        .expect("the kit is issued at spawn");

    let before = w.items.iter().count();
    assert!(!w.drop_item(0, kit_slot), "the starting kit was dropped");
    assert!(
        w.player(0)
            .and_then(|p| p.inventory.slot(kit_slot))
            .is_some_and(|st| st.item == kit),
        "the kit left the inventory even though the drop reported a refusal"
    );
    assert_eq!(w.items.iter().count(), before, "the kit reached the ground");

    // The control, in the same fixture: an ordinary stack in the same player's
    // bag **is** droppable, so the refusal above is about the kit and not about
    // a drop path that refuses everything.
    give(&mut w, 0, BAZOOKA, 2);
    let other = (0..game_core::constants::INVENTORY_SLOTS as u8)
        .find(|s| {
            w.player(0)
                .and_then(|p| p.inventory.slot(*s))
                .is_some_and(|st| st.item == BAZOOKA)
        })
        .expect("the bazooka is in a slot");
    assert!(w.drop_item(0, other), "nothing at all could be dropped");
}

/// An empty slot, an out-of-range one and a dead player are all refused, and
/// none of them puts anything on the ground.
///
/// The index comes off the wire (`unwrap_or(255)` at the socket), so "out of
/// range" is a real input rather than a hypothetical.
#[test]
fn a_drop_is_refused_for_an_empty_slot_an_impossible_one_and_a_corpse() {
    let mut w = playing();
    spawn_at(&mut w, 0);
    let before = w.items.iter().count();

    let empty = (0..game_core::constants::INVENTORY_SLOTS as u8)
        .find(|s| w.player(0).and_then(|p| p.inventory.slot(*s)).is_none())
        .expect("an empty slot");
    assert!(!w.drop_item(0, empty), "an empty slot dropped something");
    assert!(!w.drop_item(0, 255), "slot 255 was accepted");
    assert!(
        !w.drop_item(9, 0),
        "a player who is not here dropped something"
    );
    assert_eq!(
        w.items.iter().count(),
        before,
        "a refused drop still spawned an item"
    );
}
