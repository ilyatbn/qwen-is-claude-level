//! T24.01 — **the durian grenade**: thrown like a grenade, it bursts **mid-air** on its fuse into exactly
//! `DURIAN_PIECES` pieces flung in seeded random directions, and each piece bursts into a purple gas cloud
//! (`HazardKind::DurianGas`, the toxic burn). The owner: *"a cluster grenade of poison gas (explodes mid air, breaks
//! into 4 small particles flying in random direction and then exploding into a purple gas cloud)."*

use game_core::constants::*;
use game_core::items::registry::{DURIAN_GRENADE, WEAPON_DURIAN, WEAPON_DURIAN_PIECE};
use game_core::math::Vec2;
use game_core::world::{GameEvent, HazardKind, RoundPhase, World};

const SEED: u64 = 4242;
/// The throw: 60° above the horizontal to the right (y grows downward) — a lob over cover.
const AIM: f32 = -std::f32::consts::FRAC_PI_3;

/// A round past warmup and spawn i-frames with the thrower (0) holding durian grenades and two bystanders (1, 2),
/// and open air carved around the thrower so the throw meets no rock.
fn armed_round(seed: u64) -> World {
    let mut w = World::for_test(seed, MapScale::Small);
    for id in 0..3u8 {
        w.add_player(id, 0, format!("p{id}"));
    }
    let mut guard = 0;
    while (w.phase != RoundPhase::Playing || w.round_time <= SPAWN_IFRAMES + 0.1) && guard < 4000 {
        w.step(SIM_DT);
        guard += 1;
    }
    game_core::world::give(&mut w, 0, DURIAN_GRENADE, DURIAN_GRENADE_AMMO);
    game_core::world::wield(&mut w, 0, DURIAN_GRENADE);
    let at = w.player(0).map(|p| p.body.pos).expect("thrower");
    for y in (at.y as i32 - 320)..(at.y as i32 - 20) {
        w.map
            .mask
            .clear_run(y, at.x as i32 - 320, at.x as i32 + 320);
    }
    w.map.coarse = game_core::map::coarse::CoarseGrid::build(&w.map.mask);
    let _ = w.drain_events();
    w
}

/// Pull the trigger at `AIM` and step until every cloud is out: the events of the whole flight, the fire tick.
fn throw(w: &mut World) -> (Vec<GameEvent>, u32) {
    if let Some(p) = w.player_mut(0) {
        p.aim = game_core::math::quantize_angle(AIM);
    }
    let fired_at = w.tick;
    let now = w.round_time;
    let _ = w.fire(0, now);
    let mut events = w.drain_events();
    for _ in 0..((DURIAN_FUSE + DURIAN_PIECE_FUSE) / SIM_DT) as u32 + 10 {
        w.step(SIM_DT);
        events.extend(w.drain_events());
    }
    (events, fired_at)
}

fn spawns_of(
    events: &[GameEvent],
    weapon: game_core::items::registry::WeaponId,
) -> Vec<(u32, Vec2, Vec2)> {
    events
        .iter()
        .filter_map(|e| match e {
            GameEvent::ProjectileSpawn {
                tick,
                weapon: wpn,
                x,
                y,
                vx,
                vy,
                ..
            } if *wpn == weapon => Some((*tick, Vec2::new(*x, *y), Vec2::new(*vx, *vy))),
            _ => None,
        })
        .collect()
}

fn clouds(events: &[GameEvent]) -> Vec<(Vec2, f32)> {
    events
        .iter()
        .filter_map(|e| match e {
            GameEvent::HazardSpawn {
                kind: HazardKind::DurianGas,
                x,
                y,
                r,
                ..
            } => Some((Vec2::new(*x, *y), *r)),
            _ => None,
        })
        .collect()
}

/// One grenade; at its fuse, in the air, exactly four pieces from one point in four different directions; then
/// exactly four purple clouds of the stated radius. Counted at both ends: the pieces announced and the clouds
/// announced are the same number.
#[test]
fn a_durian_grenade_bursts_mid_air_into_four_pieces_and_four_purple_clouds() {
    let mut w = armed_round(SEED);
    let hand = w.player(0).map(|p| p.body.pos).expect("thrower");
    let (events, fired_at) = throw(&mut w);
    let grenades = spawns_of(&events, WEAPON_DURIAN);
    assert_eq!(grenades.len(), 1, "one throw, one grenade: {grenades:?}");
    let pieces = spawns_of(&events, WEAPON_DURIAN_PIECE);
    assert_eq!(
        pieces.len(),
        DURIAN_PIECES as usize,
        "the burst made {} pieces",
        pieces.len()
    );
    let (tick, at, _) = pieces[0];
    let fuse_ticks = (DURIAN_FUSE / SIM_DT).round() as u32;
    assert!(
        tick.abs_diff(fired_at + fuse_ticks) <= 1,
        "it burst on tick {tick}, not at its fuse ({} after {fired_at})",
        fuse_ticks
    );
    for (t, p, _) in &pieces {
        assert_eq!(
            (*t, *p),
            (tick, at),
            "the pieces did not leave together from one point"
        );
    }
    // Mid-air: above the hand (a 60° lob is 45 px up at the fuse, `DURIAN_FUSE`'s basis) and no rock round it.
    assert!(
        at.y < hand.y,
        "it burst at y {} — not above the thrower's hand ({})",
        at.y,
        hand.y
    );
    for dy in -8..=8 {
        for dx in -8..=8 {
            assert!(
                !game_core::physics::collide::solid_at(&w.map, at.x as i32 + dx, at.y as i32 + dy),
                "it burst touching rock at {at:?}"
            );
        }
    }
    // Four directions, not one: every pair of pieces leaves at least 1° apart, each at the stated speed.
    for (i, (_, _, a)) in pieces.iter().enumerate() {
        assert!(
            (a.len() - DURIAN_PIECE_SPEED).abs() < 1e-2,
            "piece {i} left at {} px/s",
            a.len()
        );
        for (_, _, b) in &pieces[..i] {
            let d = (a.y.atan2(a.x) - b.y.atan2(b.x)).abs();
            assert!(
                d > 1f32.to_radians(),
                "two pieces left in the same direction"
            );
        }
    }
    let c = clouds(&events);
    assert_eq!(
        c.len(),
        pieces.len(),
        "{} pieces made {} clouds",
        pieces.len(),
        c.len()
    );
    for (_, r) in &c {
        assert!((r - DURIAN_GAS_RADIUS).abs() < 1e-6);
    }
    // And no toxic-green cloud: the purple is its own kind on the wire.
    assert!(
        !events.iter().any(|e| matches!(
            e,
            GameEvent::HazardSpawn {
                kind: HazardKind::Toxic,
                ..
            }
        )),
        "a durian piece announced a toxic-grenade cloud"
    );
}

/// Seeded: the same round and throw split the same way twice; another seed splits another way (the control — a
/// split that ignored the RNG would pass the first half alone).
#[test]
fn the_split_is_deterministic_and_seeded() {
    let dirs = |seed: u64| -> Vec<(i32, i32)> {
        let mut w = armed_round(seed);
        let (events, _) = throw(&mut w);
        spawns_of(&events, WEAPON_DURIAN_PIECE)
            .iter()
            .map(|(_, _, v)| (v.x.round() as i32, v.y.round() as i32))
            .collect()
    };
    let a = dirs(SEED);
    assert_eq!(a.len(), DURIAN_PIECES as usize);
    assert_eq!(a, dirs(SEED), "the same throw split two ways");
    assert_ne!(
        a,
        dirs(SEED + 1),
        "control: another seed split the same way"
    );
}

/// Damage only inside the clouds: a bystander held in a cloud's centre loses health, one held well clear of every
/// cloud does not (the control — and the reason it exists: a bystander far away that lost nothing passes for a
/// gas that hurts nobody).
#[test]
fn the_gas_hurts_inside_a_cloud_and_not_outside() {
    let mut w = armed_round(SEED);
    let (events, _) = throw(&mut w);
    let c = clouds(&events);
    assert!(!c.is_empty(), "no cloud to stand in");
    let inside = c[0].0;
    // Clear of every cloud by two radii, on the same row.
    let far = (1..40)
        .map(|k| Vec2::new(inside.x + k as f32 * DURIAN_GAS_RADIUS, inside.y))
        .find(|p| c.iter().all(|(q, r)| (*p - *q).len() > 3.0 * r))
        .expect("somewhere clear of the clouds");
    let hp = |w: &World, id: u8| w.player(id).map(|p| p.health).expect("player");
    let (h1, h2) = (hp(&w, 1), hp(&w, 2));
    for _ in 0..(1.0 / SIM_DT) as u32 {
        for (id, at) in [(1u8, inside), (2u8, far)] {
            if let Some(p) = w.player_mut(id) {
                p.body.pos = at;
                p.body.vel = Vec2::ZERO;
            }
        }
        w.step(SIM_DT);
    }
    assert!(
        hp(&w, 1) < h1,
        "a bystander in a cloud's centre for a second lost nothing ({h1})"
    );
    assert_eq!(hp(&w, 2), h2, "a bystander clear of every cloud was hurt");
}

/// **The basis of `DURIAN_MUZZLE_SPEED` and `DURIAN_FUSE`, against the flight itself**: every lob from 30° to 60°, in
/// open air, bursts farther from the hand than its gas reaches (`DURIAN_PIECE_SPEED × DURIAN_PIECE_FUSE +
/// DURIAN_GAS_RADIUS`) — so a thrower standing still is outside their own clouds. Walked by the projectile step's own
/// predictor, not by the formula in the constants' comment, so the claim moves if the physics or a number does.
/// Falsified: the first values (480 px/s, 0.45 s, 200 px/s pieces) fail it — a 60° lob 128 px out against 130.
#[test]
fn a_lob_bursts_past_its_own_gas() {
    let mut w = World::for_test(SEED, MapScale::Small);
    let hand = Vec2::new(w.map.mask.w as f32 / 2.0, w.map.mask.h as f32 / 2.0);
    for y in (hand.y as i32 - 400)..(hand.y as i32 + 400) {
        w.map
            .mask
            .clear_run(y, hand.x as i32 - 500, hand.x as i32 + 500);
    }
    let reach = DURIAN_PIECE_SPEED * DURIAN_PIECE_FUSE + DURIAN_GAS_RADIUS;
    let burst = |deg: f32| {
        game_core::weapons::projectile::predict_impact(
            &w.map,
            WEAPON_DURIAN,
            hand,
            -deg.to_radians(),
            0.0,
            GravityMode::Standard,
            200,
            SIM_DT,
        )
        .expect("it bursts")
    };
    for deg in (30..=60).step_by(5) {
        let d = (burst(deg as f32) - hand).len();
        assert!(
            d > reach,
            "a {deg}° lob bursts {d:.0} px out, inside its own gas ({reach} px)"
        );
    }
}
