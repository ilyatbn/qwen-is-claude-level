//! `World::step` — the tick ordering contract (`docs/41-server-loop-rooms.md` §2).
//!
//! These are the tests that keep a replay reproducing a live round. If the
//! determinism ones fail, the golden map hashes, the replay footer and the
//! bit-identical client masks all fail with them.

use game_core::constants::{MapScale, BASE_HEALTH, SIM_DT};
use game_core::items::registry::{BAZOOKA, MEDKIT};
use game_core::math::Vec2;
use game_core::player::input::{button, Input};
use game_core::world::{give, GameEvent, RoundPhase, World};

const SEED: u64 = 4242;

fn world() -> World {
    World::new(SEED, MapScale::Small)
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
    // Death, then the respawn delay.
    for _ in 0..(60 * 4) {
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
