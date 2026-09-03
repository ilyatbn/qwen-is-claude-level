//! M4 part B: projectiles, explosions, hitscan, stats, death and scoring.

use game_core::constants::*;
use game_core::items::registry::{self, WEAPON_BAZOOKA, WEAPON_GRENADE, WEAPON_SHOVEL, WEAPON_SMG};
use game_core::map::gen::silhouette::force_borders;
use game_core::map::{CoarseGrid, Map, MapMeta, Mask};
use game_core::math::{Aabb, Point, Vec2};
use game_core::physics::collide::aabb_overlaps_solid;
use game_core::player::state::{choose_respawn, DeathCause, PlayerState, UseError};
use game_core::rng::substream;
use game_core::weapons::bullet;
use game_core::weapons::defs::{self, Delivery};
use game_core::weapons::explode::{
    explode, BlastSource, DamageSource, EffectKind, HitId, HitTarget,
};
use game_core::weapons::projectile::{ProjectileOutcome, Projectiles};

const W: u32 = 1024;
const H: u32 = 512;

fn meta() -> MapMeta {
    MapMeta {
        seed: 1,
        requested_seed: 1,
        attempts: 1,
        used_safe_preset: false,
        scale: MapScale::Small,
        theme: 0,
        spawn_points: Vec::new(),
        teleport_pads: Vec::new(),
        surface_points: Vec::new(),
        objects: Vec::new(),
        buried_slots: Vec::new(),
        decorations: Vec::new(),
        wind: 0.0,
        traversable_fraction: 1.0,
        largest_component: Vec::new(),
    }
}

fn flat_map(floor_y: i32) -> Map {
    let mut mask = Mask::new_empty(W, H);
    for y in floor_y..H as i32 {
        mask.set_run(y, 0, W as i32 - 1);
    }
    force_borders(&mut mask);
    let coarse = CoarseGrid::build(&mask);
    Map::from_parts(mask, coarse, meta())
}

/// A 30° ramp rising to the right — the shape a grenade jitters on.
fn slope_map(base_y: i32) -> Map {
    let mut mask = Mask::new_empty(W, H);
    for x in 0..W as i32 {
        let top = base_y - x / 2;
        for y in top.max(0)..H as i32 {
            mask.set(x, y);
        }
    }
    force_borders(&mut mask);
    let coarse = CoarseGrid::build(&mask);
    Map::from_parts(mask, coarse, meta())
}

fn empty_map() -> Map {
    let mut mask = Mask::new_empty(W, H);
    force_borders(&mut mask);
    let coarse = CoarseGrid::build(&mask);
    Map::from_parts(mask, coarse, meta())
}

/// Fire one bullet and fly it until it stops — the **whole** §F1 path.
///
/// Spawn, spread draw, sub-stepped flight and impact resolution, in the order and
/// through the functions the world uses. A helper that reached past any of them
/// would be testing a path the game does not run, which is how `destroy_in_blast`
/// sat green with no production caller.
///
/// Returns what it did: where it stopped, whether it hit a body, and what it took
/// out of the ground.
fn fire_bullet(
    map: &mut Map,
    targets: &mut [HitTarget],
    key: &str,
    owner: u8,
    from: Vec2,
    aim: f32,
    rng: &mut game_core::rng::ChaCha8Rng,
) -> (Vec2, Option<(HitId, f32)>, bool, u32) {
    let w = defs::by_key(key).unwrap_or_else(|| panic!("{key} is not a weapon"));
    let Delivery::Bullet { spread, .. } = w.delivery else {
        panic!("{key} is not a bullet");
    };
    let a = bullet::muzzle_angle(rng, aim, spread);
    let mut pr = Projectiles::new();
    let id = pr.spawn(w.id, owner, from, a, 0.0);

    // Long enough for the slowest gun to fly its longest range, and no longer:
    // a loop with no bound turns a stuck projectile into a hang.
    let max_ticks = ((w.range / w.muzzle_speed) / SIM_DT).ceil() as u32 + 10;
    let boxes: Vec<(HitId, Aabb)> = targets
        .iter()
        .map(|t| (t.id, Aabb::from_center_size(t.pos, t.w, t.h)))
        .collect();
    for i in 0..max_ticks {
        let now = i as f32 * SIM_DT;
        // One round in flight, so the first impact is the only impact — and
        // clippy is right that this never loops.
        if let Some(im) = pr
            .step(map, &boxes, &[], 0.0, now, SIM_DT)
            .into_iter()
            .next()
        {
            assert_eq!(im.id, id);
            let (at, victim, spent) = match im.outcome {
                ProjectileOutcome::Exploded { at } => (at, None, false),
                ProjectileOutcome::Hit { at, victim } => (at, Some(victim), false),
                ProjectileOutcome::Spent { at } => (at, None, true),
                ProjectileOutcome::Voided { at } => (at, None, true),
                ProjectileOutcome::Alive => unreachable!(),
            };
            let r = if spent {
                // A spent round resolves to nothing at all — that is the point of
                // the outcome being distinct.
                Default::default()
            } else {
                bullet::resolve(
                    map,
                    targets,
                    w,
                    at,
                    victim,
                    BlastSource::Fired {
                        owner,
                        weapon: w.id,
                    },
                )
            };
            let removed = r.carve.as_ref().map_or(0, |c| c.pixels_removed);
            return (at, r.hit, spent, removed);
        }
    }
    panic!("{key} was still flying after {max_ticks} ticks");
}

// ------------------------------------------------------------------ T4.09

#[test]
fn a_bazooka_explodes_on_the_wall_it_hits() {
    let mut map = flat_map(400);
    let mut pr = Projectiles::new();
    // Fired straight down from above the floor.
    let id = pr.spawn(
        WEAPON_BAZOOKA,
        0,
        Vec2::new(300.0, 200.0),
        std::f32::consts::FRAC_PI_2,
        0.0,
    );
    let mut hit_at = None;
    for i in 0..600 {
        let now = i as f32 * SIM_DT;
        for im in pr.step(&map, &[], &[], 0.0, now, SIM_DT) {
            assert_eq!(im.id, id);
            if let ProjectileOutcome::Exploded { at } = im.outcome {
                hit_at = Some(at);
            }
        }
        if hit_at.is_some() {
            break;
        }
    }
    let at = hit_at.expect("the rocket never hit the floor");
    assert!((at.y - 400.0).abs() < 4.0, "exploded at y {}", at.y);
    let _ = &mut map;
}

#[test]
fn a_grenade_bounces_rather_than_exploding_on_contact() {
    let map = flat_map(400);
    let mut pr = Projectiles::new();
    pr.spawn(WEAPON_GRENADE, 0, Vec2::new(200.0, 300.0), 0.3, 0.0);
    let mut bounced = false;
    for i in 0..60 {
        let now = i as f32 * SIM_DT;
        let outs = pr.step(&map, &[], &[], 0.0, now, SIM_DT);
        assert!(
            outs.is_empty(),
            "a grenade must not explode on contact: {outs:?}"
        );
        if let Some(p) = pr.iter().next() {
            if p.vel.y < 0.0 && i > 5 {
                bounced = true;
            }
        }
    }
    assert!(bounced, "the grenade never bounced upward off the floor");
}

/// The classic bug in this system.
#[test]
fn a_grenade_comes_to_rest_on_a_slope_instead_of_jittering() {
    let map = slope_map(460);
    let mut pr = Projectiles::new();
    let id = pr.spawn(WEAPON_GRENADE, 0, Vec2::new(400.0, 150.0), 0.6, 0.0);

    let mut last = Vec2::ZERO;
    for i in 0..(2.0 / SIM_DT) as i32 {
        let now = i as f32 * SIM_DT;
        pr.step(&map, &[], &[], 0.0, now, SIM_DT);
        if let Some(p) = pr.get(id) {
            last = p.pos;
        }
    }
    let p = pr.get(id).expect("the fuse has not fired yet");
    assert!(
        p.resting,
        "the grenade never settled — it is still jittering"
    );

    // And it stays put: bit-identical over another second.
    for i in 0..(1.0 / SIM_DT) as i32 {
        pr.step(&map, &[], &[], 0.0, 2.0 + i as f32 * SIM_DT, SIM_DT);
    }
    assert_eq!(pr.get(id).expect("still there").pos, last);
}

#[test]
fn a_grenade_fuse_fires_in_mid_air_if_it_never_touches_anything() {
    let map = empty_map();
    let mut pr = Projectiles::new();
    // Straight up in an empty world: nothing to hit before the fuse expires.
    let id = pr.spawn(WEAPON_GRENADE, 0, Vec2::new(500.0, 300.0), -1.57, 0.0);
    let mut exploded = None;
    for i in 0..(GRENADE_FUSE / SIM_DT) as i32 + 30 {
        let now = i as f32 * SIM_DT;
        for im in pr.step(&map, &[], &[], 0.0, now, SIM_DT) {
            if im.id == id {
                exploded = Some((now, im.outcome));
            }
        }
    }
    let (t, _) = exploded.expect("the fuse never fired");
    assert!((t - GRENADE_FUSE).abs() < 0.1, "fuse fired at {t}");
}

#[test]
fn a_projectile_never_passes_through_a_one_pixel_wall() {
    let mut mask = Mask::new_empty(W, H);
    for y in 0..H as i32 {
        mask.set(600, y);
    }
    force_borders(&mut mask);
    let coarse = CoarseGrid::build(&mask);
    let map = Map::from_parts(mask, coarse, meta());

    let mut pr = Projectiles::new();
    // Ten times terminal velocity, straight at the wall.
    pr.spawn_raw(
        WEAPON_BAZOOKA,
        0,
        Vec2::new(100.0, 200.0),
        Vec2::new(MAX_FALL_SPEED * 10.0, 0.0),
        0.0,
    );
    let mut at = None;
    for i in 0..120 {
        for im in pr.step(&map, &[], &[], 0.0, i as f32 * SIM_DT, SIM_DT) {
            if let ProjectileOutcome::Exploded { at: a } = im.outcome {
                at = Some(a);
            }
        }
        if at.is_some() {
            break;
        }
    }
    let a = at.expect("the rocket passed through the wall");
    assert!(a.x <= 602.0, "stopped at {} — tunnelled past the wall", a.x);
}

#[test]
fn a_projectile_despawns_at_its_lifetime_even_with_no_gravity() {
    let map = empty_map();
    let mut pr = Projectiles::new();
    // The smg has gravity_scale 0, so this would drift forever without the guard.
    pr.spawn_raw(
        WEAPON_SMG,
        0,
        Vec2::new(100.0, 100.0),
        Vec2::new(1.0, 0.0),
        0.0,
    );
    let mut gone = false;
    for i in 0..((PROJECTILE_MAX_LIFETIME + 1.0) / SIM_DT) as i32 {
        if !pr
            .step(&map, &[], &[], 0.0, i as f32 * SIM_DT, SIM_DT)
            .is_empty()
        {
            gone = true;
            break;
        }
    }
    assert!(gone, "a projectile leaked past PROJECTILE_MAX_LIFETIME");
    assert!(pr.is_empty());
}

#[test]
fn the_owner_is_immune_for_the_first_few_ticks() {
    let map = empty_map();
    let mut pr = Projectiles::new();
    let owner_box = Aabb::from_center_size(Vec2::new(500.0, 300.0), PLAYER_W, PLAYER_H);
    // Spawned inside the owner's own hitbox, firing sideways.
    pr.spawn(WEAPON_BAZOOKA, 0, Vec2::new(500.0, 300.0), 0.0, 0.0);
    let outs = pr.step(
        &map,
        &[(HitId::Player(0), owner_box)],
        &[],
        0.0,
        SIM_DT,
        SIM_DT,
    );
    assert!(outs.is_empty(), "a rocket hit its own owner at the muzzle");
}

/// The owner grace, tested where it is the **only** thing standing in the way.
///
/// The first version of this spawned through `Projectiles::spawn`, which offsets
/// by `MUZZLE_OFFSET` 18 — past the body's 14 px half-height — so a round was
/// outside its owner before the guard was ever consulted. Deleting the guard
/// outright left all 36 tests in this file green: the test proved the muzzle
/// offset and said nothing about the grace.
///
/// `spawn_raw` puts the round **inside** the owner's box, at the body centre,
/// which is the state the guard exists for: a projectile that starts in contact
/// and must be ignored until it has left. That is not a hypothetical — every
/// `spawn_raw` caller (meteors, rain, death throws) places a body wherever it
/// likes, and §F10's flames will spawn in a crowd around whoever lit them.
#[test]
fn the_owner_grace_ignores_a_round_that_starts_inside_its_owner() {
    for key in ["deagle", "smg", "pistol", "revolver", "machinegun"] {
        let map = empty_map();
        let mut pr = Projectiles::new();
        let at = Vec2::new(500.0, 300.0);
        let owner_box = Aabb::from_center_size(at, PLAYER_W, PLAYER_H);
        let w = defs::by_key(key).expect(key);
        // Dead centre of the owner, moving right: inside the box on tick one.
        pr.spawn_raw(w.id, 0, at, Vec2::new(w.muzzle_speed, 0.0), 0.0);
        let mut hit_self = None;
        for i in 0..(PROJECTILE_OWNER_GRACE_TICKS + 5) {
            let now = i as f32 * SIM_DT;
            let outs = pr.step(
                &map,
                &[(HitId::Player(0), owner_box)],
                &[],
                0.0,
                now,
                SIM_DT,
            );
            for im in outs {
                if matches!(
                    im.outcome,
                    ProjectileOutcome::Hit {
                        victim: HitId::Player(0),
                        ..
                    }
                ) {
                    hit_self = Some(i);
                }
            }
        }
        assert_eq!(
            hit_self, None,
            "a {key} round spawned inside its owner shot them on tick {hit_self:?}"
        );
    }
}

/// The control: the same round, the same box, a **different** owner — it hits.
///
/// Without this the test above is satisfied by a build where nothing hits
/// anybody, which is the shape `CLAUDE.md` names: an absence needs a presence.
#[test]
fn a_round_that_starts_inside_someone_else_hits_them() {
    let map = empty_map();
    let mut pr = Projectiles::new();
    let at = Vec2::new(500.0, 300.0);
    let victim_box = Aabb::from_center_size(at, PLAYER_W, PLAYER_H);
    let w = defs::by_key("deagle").expect("deagle");
    // Owner 1, victim 0 — the only difference from the test above.
    pr.spawn_raw(w.id, 1, at, Vec2::new(w.muzzle_speed, 0.0), 0.0);
    let outs = pr.step(
        &map,
        &[(HitId::Player(0), victim_box)],
        &[],
        0.0,
        0.0,
        SIM_DT,
    );
    assert!(
        outs.iter().any(|im| matches!(
            im.outcome,
            ProjectileOutcome::Hit {
                victim: HitId::Player(0),
                ..
            }
        )),
        "a round inside a stranger did not hit them: {:?}",
        outs.iter().map(|i| i.outcome).collect::<Vec<_>>()
    );
}

// ------------------------------------------------------------------ T4.10

struct Victim {
    pos: Vec2,
    vel: Vec2,
    damage: f32,
    alive: bool,
}

fn blast(map: &mut Map, victims: &mut [Victim], at: Vec2, r: f32, dmg: f32, owner: Option<u8>) {
    let mut taken = vec![0.0f32; victims.len()];
    {
        let mut targets: Vec<HitTarget> = Vec::new();
        let mut closures: Vec<Box<dyn FnMut(f32, DamageSource) -> bool>> = Vec::new();
        for _ in victims.iter() {
            closures.push(Box::new(|_, _| true));
        }
        let _ = &mut closures;
        let _ = &mut targets;
    }
    // Applied by hand: HitTarget borrows mutably, so the accumulation is
    // done through indices rather than closures capturing the same slice.
    for (i, v) in victims.iter_mut().enumerate() {
        let mut acc = 0.0f32;
        {
            let mut cb = |d: f32, _s: DamageSource| {
                acc += d;
                true
            };
            let mut targets = [HitTarget {
                id: HitId::Player(i as u8),
                w: game_core::constants::PLAYER_W,
                h: game_core::constants::PLAYER_H,
                pos: v.pos,
                vel: &mut v.vel,
                alive: v.alive,
                apply_damage: &mut cb,
            }];
            explode(
                map,
                &mut targets,
                at,
                r,
                dmg,
                match owner {
                    Some(o) => BlastSource::Fired {
                        owner: o,
                        weapon: WEAPON_BAZOOKA,
                    },
                    None => BlastSource::Weather(EffectKind::MeteorShower),
                },
            );
        }
        taken[i] = acc;
    }
    for (i, v) in victims.iter_mut().enumerate() {
        v.damage = taken[i];
    }
}

#[test]
fn explosion_falloff_is_full_at_the_centre_and_zero_at_the_edge() {
    let mut map = flat_map(400);
    let r = BAZOOKA_BLAST_RADIUS;
    let at = Vec2::new(300.0, 300.0);

    let mut v = vec![
        Victim {
            pos: at,
            vel: Vec2::ZERO,
            damage: 0.0,
            alive: true,
        },
        Victim {
            pos: at + Vec2::new(r - 0.5, 0.0),
            vel: Vec2::ZERO,
            damage: 0.0,
            alive: true,
        },
        Victim {
            pos: at + Vec2::new(r + 2.0, 0.0),
            vel: Vec2::ZERO,
            damage: 0.0,
            alive: true,
        },
        Victim {
            pos: at + Vec2::new(r / 2.0, 0.0),
            vel: Vec2::ZERO,
            damage: 0.0,
            alive: true,
        },
    ];
    blast(&mut map, &mut v, at, r, BAZOOKA_DAMAGE, Some(9));

    assert!(
        (v[0].damage - BAZOOKA_DAMAGE).abs() < 0.01,
        "epicentre took {}",
        v[0].damage
    );
    assert!(v[1].damage < 1.0, "the radius edge took {}", v[1].damage);
    assert_eq!(v[2].damage, 0.0, "beyond the radius took damage");
    assert!(
        (v[3].damage - BAZOOKA_DAMAGE / 2.0).abs() < 0.5,
        "half-radius took {} not half",
        v[3].damage
    );
}

#[test]
fn knockback_points_away_from_the_blast() {
    let mut map = flat_map(400);
    let at = Vec2::new(300.0, 300.0);
    let mut v = vec![
        Victim {
            pos: at + Vec2::new(0.0, -10.0),
            vel: Vec2::ZERO,
            damage: 0.0,
            alive: true,
        },
        Victim {
            pos: at + Vec2::new(10.0, 0.0),
            vel: Vec2::ZERO,
            damage: 0.0,
            alive: true,
        },
    ];
    blast(
        &mut map,
        &mut v,
        at,
        BAZOOKA_BLAST_RADIUS,
        BAZOOKA_DAMAGE,
        None,
    );
    // Directly above: a purely upward impulse.
    assert!(
        v[0].vel.y < -1.0 && v[0].vel.x.abs() < 0.01,
        "{:?}",
        v[0].vel
    );
    assert!(
        v[1].vel.x > 1.0 && v[1].vel.y.abs() < 0.01,
        "{:?}",
        v[1].vel
    );
}

#[test]
fn explode_carves_before_it_damages_so_a_reveal_is_part_of_the_same_event() {
    let mut map = flat_map(300);
    map.meta.buried_slots = vec![game_core::map::BuriedSlot {
        id: 0,
        pos: Point::new(400, 340),
        revealed: false,
    }];
    let mut v: Vec<Victim> = Vec::new();
    let mut targets: Vec<HitTarget> = Vec::new();
    let _ = &mut v;
    let res = explode(
        &mut map,
        &mut targets,
        Vec2::new(400.0, 340.0),
        BAZOOKA_BLAST_RADIUS,
        BAZOOKA_DAMAGE,
        BlastSource::Weather(EffectKind::MeteorShower),
    );
    assert!(res.carve.pixels_removed > 0, "the blast carved nothing");
    assert_eq!(
        res.carve.revealed,
        vec![0],
        "the buried slot was not revealed"
    );
}

#[test]
fn knockback_applies_through_iframes_and_through_the_shield() {
    // Being thrown is not damage: this is what makes rocket-jumping work.
    let mut map = flat_map(400);
    let at = Vec2::new(300.0, 300.0);
    let mut vel = Vec2::ZERO;
    let mut applied = false;
    {
        let mut cb = |_d: f32, _s: DamageSource| {
            // The callee refuses the damage, exactly as i-frames would.
            applied = true;
            false
        };
        let mut targets = [HitTarget {
            id: HitId::Player(0),
            w: game_core::constants::PLAYER_W,
            h: game_core::constants::PLAYER_H,
            pos: at + Vec2::new(0.0, -8.0),
            vel: &mut vel,
            alive: true,
            apply_damage: &mut cb,
        }];
        explode(
            &mut map,
            &mut targets,
            at,
            BAZOOKA_BLAST_RADIUS,
            BAZOOKA_DAMAGE,
            BlastSource::Weather(EffectKind::MeteorShower),
        );
    }
    assert!(applied, "damage was never offered");
    assert!(
        vel.y < -1.0,
        "knockback was skipped when damage was refused"
    );
}

// ------------------------------------------------------------------ T4.11

/// §F1: the same claim as the old hitscan test, now flown.
#[test]
fn an_smg_bullet_stops_at_terrain_and_carves_it() {
    let mut map = flat_map(400);
    let before = map.mask.count_solid();
    let mut rng = substream(1, "test");
    let mut targets: Vec<HitTarget> = Vec::new();
    let (at, hit, spent, removed) = fire_bullet(
        &mut map,
        &mut targets,
        "smg",
        0,
        Vec2::new(300.0, 300.0),
        std::f32::consts::FRAC_PI_2,
        &mut rng,
    );
    assert!(
        !spent,
        "a bullet fired at a floor 100 px away ran out of range"
    );
    assert_eq!(hit, None, "it hit a body on an empty map");
    assert!((at.y - 400.0).abs() < 3.0, "stopped at {}", at.y);
    // The 3-px carve is the SMG's identity: sustained fire tunnels.
    assert!(removed > 0, "the bullet did not dig");
    assert_eq!(
        before - map.mask.count_solid(),
        removed as u64,
        "the carve it reported and the pixels it removed disagree"
    );
}

/// The property §F1 exists for, and the one a hitscan implementation cannot
/// satisfy: **a bullet is somewhere in between**.
///
/// A hitscan shot resolves in the tick it is fired — it is never in flight, which
/// is why nothing could draw it. This asserts the opposite directly: ticks after
/// firing at a distant wall, the round is still alive and its position has
/// advanced along the aim by roughly `muzzle_speed × elapsed`.
#[test]
fn a_bullet_is_in_flight_between_the_muzzle_and_the_wall() {
    let map = empty_map();
    let smg = defs::by_key("smg").expect("smg");
    let mut pr = Projectiles::new();
    let from = Vec2::new(100.0, 256.0);
    pr.spawn(smg.id, 0, from, 0.0, 0.0);

    let mut seen: Vec<f32> = Vec::new();
    for i in 0..12 {
        let now = i as f32 * SIM_DT;
        let done = pr.step(&map, &[], &[], 0.0, now, SIM_DT);
        assert!(done.is_empty(), "the round stopped on an empty map");
        seen.push(pr.iter().next().expect("still flying").pos.x);
    }
    // It moved, monotonically, and it is still short of its range.
    assert!(
        seen.windows(2).all(|w| w[1] > w[0]),
        "a bullet that is not advancing: {seen:?}"
    );
    let flown = seen.last().expect("samples") - from.x;
    let expected = SMG_MUZZLE_SPEED * 12.0 * SIM_DT;
    assert!(
        (flown - expected).abs() < expected * 0.25,
        "flew {flown} px in 12 ticks, expected about {expected}"
    );
    // The control that makes this about *flight* rather than about spawning: a
    // laser is still hitscan and puts nothing in the air at all.
    let laser = defs::by_key("laser_pistol").expect("laser");
    assert!(
        matches!(laser.delivery, Delivery::Hitscan { .. }),
        "the laser stopped being a beam"
    );
}

#[test]
fn sustained_smg_fire_breaches_a_thin_wall() {
    let mut mask = Mask::new_empty(W, H);
    for y in 0..H as i32 {
        for x in 500..510 {
            mask.set(x, y);
        }
    }
    force_borders(&mut mask);
    let coarse = CoarseGrid::build(&mask);
    let mut map = Map::from_parts(mask, coarse, meta());

    let mut rng = substream(2, "test");
    let mut breached = false;
    for _ in 0..60 {
        let mut targets: Vec<HitTarget> = Vec::new();
        fire_bullet(
            &mut map,
            &mut targets,
            "smg",
            0,
            Vec2::new(300.0, 256.0),
            0.0,
            &mut rng,
        );
        let mut clear = true;
        for x in 500..510 {
            if map.mask.get(x, 256) {
                clear = false;
                break;
            }
        }
        if clear {
            breached = true;
            break;
        }
    }
    assert!(breached, "60 rounds did not breach a 10 px wall");
}

#[test]
fn an_smg_bullet_hits_a_player_without_knocking_them_back() {
    let mut map = empty_map();
    let mut rng = substream(3, "test");
    let mut vel = Vec2::ZERO;
    let mut dealt = 0.0f32;
    let hit;
    {
        let mut cb = |d: f32, _s: DamageSource| {
            dealt += d;
            true
        };
        let mut targets = [HitTarget {
            id: HitId::Player(1),
            w: game_core::constants::PLAYER_W,
            h: game_core::constants::PLAYER_H,
            pos: Vec2::new(500.0, 300.0),
            vel: &mut vel,
            alive: true,
            apply_damage: &mut cb,
        }];
        let (_, h, spent, removed) = fire_bullet(
            &mut map,
            &mut targets,
            "smg",
            0,
            Vec2::new(300.0, 300.0),
            0.0,
            &mut rng,
        );
        assert!(!spent, "it ran out of range 200 px from the muzzle");
        assert_eq!(
            removed, 0,
            "a bullet that stopped on a body carved the ground"
        );
        hit = h;
    }
    assert_eq!(hit, Some((HitId::Player(1), SMG_DAMAGE)));
    // Once, at full value — not once per sub-step, which at 800 px/s would be
    // thirteen hits in the tick it arrives.
    assert_eq!(dealt, SMG_DAMAGE);
    assert_eq!(vel, Vec2::ZERO, "the smg must not displace anyone");
}

/// §F1's range, and the thing that separates it from `Exploded`: a round that
/// reaches the end of its flight leaves **no mark at all**.
#[test]
fn a_bullet_that_flies_its_range_is_spent_and_carves_nothing() {
    let mut map = empty_map();
    let mut rng = substream(4, "test");
    let mut targets: Vec<HitTarget> = Vec::new();
    let before = map.mask.count_solid();
    let from = Vec2::new(100.0, 256.0);
    let (at, hit, spent, removed) =
        fire_bullet(&mut map, &mut targets, "pistol", 0, from, 0.0, &mut rng);
    assert!(
        spent,
        "a pistol round crossing empty air did not run out of range"
    );
    assert_eq!(hit, None);
    assert_eq!(removed, 0, "a spent round left a hole");
    assert_eq!(
        map.mask.count_solid(),
        before,
        "the mask changed when a round ran out of range"
    );
    // It stopped at its range, not at the edge of the world — pinned to the
    // constant at both ends.
    let flown = at.x - from.x;
    assert!(
        (flown - PISTOL_RANGE).abs() <= MUZZLE_OFFSET + PISTOL_MUZZLE_SPEED * SIM_DT,
        "flew {flown} px against a range of {PISTOL_RANGE}"
    );
}

/// A fast round cannot pass through a thin wall (§A24's sub-stepping, inherited).
///
/// The deagle is the fastest gun in the game: 1050 px/s is 17.5 px a tick, and a
/// 2 px wall is invisible to any check that only looks where the round lands.
#[test]
fn the_fastest_bullet_cannot_tunnel_a_two_pixel_wall() {
    let mut mask = Mask::new_empty(W, H);
    for y in 0..H as i32 {
        for x in 500..502 {
            mask.set(x, y);
        }
    }
    force_borders(&mut mask);
    let coarse = CoarseGrid::build(&mask);
    let mut map = Map::from_parts(mask, coarse, meta());
    let mut rng = substream(5, "test");
    let mut targets: Vec<HitTarget> = Vec::new();
    let (at, _, spent, _) = fire_bullet(
        &mut map,
        &mut targets,
        "deagle",
        0,
        Vec2::new(300.0, 256.0),
        0.0,
        &mut rng,
    );
    assert!(!spent, "the round passed the wall and flew its whole range");
    assert!(
        at.x < 505.0,
        "a deagle round stopped at x={} — it went through a 2 px wall",
        at.x
    );
}

// ------------------------------------------------------------------ T4.12

#[test]
fn overheal_decays_to_base_in_the_documented_time_and_then_stops() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.heal(100.0);
    assert_eq!(p.health, HEALTH_CAP, "a medkit at full health caps at 150");
    let mut t = 0.0;
    while p.health > BASE_HEALTH + 0.01 && t < 60.0 {
        p.tick_stats(t, SIM_DT);
        t += SIM_DT;
    }
    assert!((t - 25.0).abs() < 0.5, "overheal took {t} s to decay");
    // And then it stops rather than draining into the floor.
    for _ in 0..600 {
        p.tick_stats(t, SIM_DT);
    }
    assert!((p.health - BASE_HEALTH).abs() < 0.01);
}

#[test]
fn a_medkit_clamps_rather_than_overshooting() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.health = 60.0;
    p.heal(MEDKIT_HEAL);
    assert_eq!(p.health, 110.0);
    p.health = 130.0;
    p.heal(MEDKIT_HEAL);
    assert_eq!(p.health, HEALTH_CAP, "130 + 50 must clamp to 150, not 180");
}

#[test]
fn the_shield_halves_damage_replaces_rather_than_stacks_and_expires() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.apply_shield(0.0);
    p.apply_damage(40.0, DamageSource::Weather(EffectKind::ToxicRain), 1.0);
    assert_eq!(p.health, BASE_HEALTH - 20.0, "the shield must halve damage");

    // Re-applying at 2 s left gives a fresh 20 s, not 38.
    p.apply_shield(SHIELD_DURATION - 2.0);
    assert!(p.shield_active(SHIELD_DURATION + 17.0));
    assert!(!p.shield_active(SHIELD_DURATION + 19.0));
}

#[test]
fn speed_scales_with_health_and_overheal_does_not_help() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    assert!((p.speed_multiplier() - 1.0).abs() < 1e-6);
    p.health = 0.0;
    assert!((p.speed_multiplier() - HEALTH_SPEED_MIN).abs() < 1e-6);
    p.health = HEALTH_CAP;
    assert!(
        (p.speed_multiplier() - 1.0).abs() < 1e-6,
        "overheal must not make you faster"
    );
}

// ------------------------------------------------------------------ T4.13

#[test]
fn iframes_block_damage_for_exactly_the_spawn_window() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.respawn(Vec2::ZERO, 10.0);
    assert!(!p.apply_damage(
        10.0,
        DamageSource::Weather(EffectKind::LavaBurst),
        10.0 + SPAWN_IFRAMES - 0.1
    ));
    assert_eq!(p.health, BASE_HEALTH);
    assert!(p.apply_damage(
        10.0,
        DamageSource::Weather(EffectKind::LavaBurst),
        10.0 + SPAWN_IFRAMES + 0.1
    ));
    assert_eq!(p.health, BASE_HEALTH - 10.0);
}

#[test]
fn a_second_death_does_not_double_decrement_the_score() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.die(DeathCause::SelfInflicted, 0.0);
    assert_eq!(p.score, DEATH_POINTS);
    p.die(DeathCause::SelfInflicted, 0.0);
    assert_eq!(
        p.score, DEATH_POINTS,
        "a corpse must not lose another point"
    );
}

#[test]
fn a_self_kill_costs_the_victim_a_point_and_credits_nobody() {
    let mut me = PlayerState::new(0, Vec2::ZERO, 0);
    let mut other = PlayerState::new(1, Vec2::ZERO, 0);
    me.apply_damage(
        200.0,
        DamageSource::SelfInflicted {
            weapon: WEAPON_BAZOOKA,
        },
        1.0,
    );
    assert!(me.health <= 0.0);
    let cause = me.killer(DeathCause::SelfInflicted, 1.0);
    assert_eq!(cause, DeathCause::SelfInflicted);
    me.die(cause, 1.0);
    assert_eq!(me.score, DEATH_POINTS);
    assert_eq!(other.score, 0, "nobody else scores off a rocket-jump death");
    let _ = &mut other;
}

#[test]
fn the_assist_window_credits_at_four_point_nine_and_not_at_five_point_one() {
    // Shooting someone off a ledge into lava has to reward the shooter.
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.apply_damage(
        10.0,
        DamageSource::Player {
            id: 3,
            weapon: WEAPON_SMG,
        },
        100.0,
    );
    assert_eq!(p.killer(DeathCause::Weather, 104.9), DeathCause::Player(3));

    let mut q = PlayerState::new(0, Vec2::ZERO, 0);
    q.apply_damage(
        10.0,
        DamageSource::Player {
            id: 3,
            weapon: WEAPON_SMG,
        },
        100.0,
    );
    assert_eq!(q.killer(DeathCause::Weather, 105.1), DeathCause::Weather);
}

/// Which slot an item landed in.
///
/// §F5 issues a shovel into slot 0 of every `PlayerState`, so `add` puts the next
/// item in slot 1 and every fixture here that said `select(0)` / `use_item(0, ..)`
/// was operating on the shovel. Four of them did, and none failed loudly: firing
/// a shovel returns `Ok`, and `use_item` on it returns the same `WrongKind` a
/// bazooka does.
fn slot_of(p: &PlayerState, item: registry::ItemId) -> u8 {
    (0..INVENTORY_SLOTS as u8)
        .find(|s| p.inventory.slot(*s).is_some_and(|st| st.item == item))
        .unwrap_or_else(|| panic!("item {item} is not in the inventory"))
}

#[test]
fn death_drops_every_stack_and_respawn_clears_the_inventory() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    // Four grenades against a `max_stack` of 3. §C24: a grenade is a **weapon**,
    // so it occupies one slot ever — the stack tops out at 3 and the fourth is
    // refused. This asserted `3` dropped stacks (two grenade slots plus the
    // medkit) under the pre-§C24 rule, which is the rule §C24 removed.
    p.inventory.add(registry::GRENADE, 4);
    // The control, in the same fixture: a **consumable** still spills into a
    // second slot, so "one stack per item" is not what is being asserted above.
    // Without it, `dropped.len()` falling to 2 would also be satisfied by a
    // build that had capped every item at one slot.
    let medkit_stack = registry::max_stack(registry::MEDKIT);
    p.inventory.add(registry::MEDKIT, medkit_stack + 1);
    p.flashlight_on = true;

    assert_eq!(
        p.inventory.count_of(registry::GRENADE),
        u32::from(registry::max_stack(registry::GRENADE)),
        "the held weapon did not top up to max_stack"
    );

    let dropped = p.die(DeathCause::Weather, 0.0);
    // **The starting kit is not among them** (§F5): a shovel that dropped would
    // be re-granted on respawn while the corpse's copy stayed on the ground, so
    // every death would mint one. Asserted here rather than only in
    // `melee::t1905_shovel`, because `die` is where the drop list is built.
    assert_eq!(
        dropped
            .iter()
            .filter(|s| s.item == registry::SHOVEL)
            .count(),
        0,
        "death dropped the issued shovel"
    );
    assert_eq!(
        dropped
            .iter()
            .filter(|s| s.item == registry::GRENADE)
            .count(),
        1,
        "death dropped more than one stack of a weapon (§C24)"
    );
    assert_eq!(
        dropped
            .iter()
            .filter(|s| s.item == registry::MEDKIT)
            .count(),
        2,
        "the consumable stopped spilling, so the weapon assertion above proves nothing"
    );
    assert_eq!(
        dropped.len(),
        3,
        "one grenade stack and two medkit stacks, and no shovel"
    );
    assert!(p.inventory.is_empty());
    assert!(!p.flashlight_on, "the light dies with the item");
}

#[test]
fn the_verb_and_the_kind_must_agree() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.inventory.add(registry::MEDKIT, 1);
    // **Found, not slot 0.** §F5 issues a shovel into slot 0 at construction, so
    // a hardcoded 0 here fires *that* — `Ok(WeaponId(24))` where the test says
    // "cannot fire a medkit", which is the assertion passing over the wrong item.
    let slot = slot_of(&p, registry::MEDKIT);
    p.inventory.select(slot);
    assert_eq!(
        p.try_fire(0.0),
        Err(UseError::WrongKind),
        "cannot fire a medkit"
    );

    let mut q = PlayerState::new(0, Vec2::ZERO, 0);
    q.inventory.add(registry::BAZOOKA, 1);
    let slot = slot_of(&q, registry::BAZOOKA);
    assert_eq!(
        q.use_item(slot, 0.0),
        Err(UseError::WrongKind),
        "cannot use a bazooka"
    );
}

#[test]
fn firing_respects_the_cooldown_and_the_ammo_count() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.inventory.add(registry::BAZOOKA, 2);
    // Not slot 0 — that is the §F5 shovel, which fires happily and forever.
    let slot = slot_of(&p, registry::BAZOOKA);
    p.inventory.select(slot);
    assert_eq!(p.try_fire(0.0), Ok(WEAPON_BAZOOKA));
    assert_eq!(p.try_fire(0.1), Err(UseError::OnCooldown));
    assert_eq!(p.try_fire(BAZOOKA_COOLDOWN), Ok(WEAPON_BAZOOKA));
    // Out of rockets: the stack is gone, and **the selection falls back to the
    // §F5 shovel** rather than to nothing. That is the floor of the arsenal made
    // literal — "what you still have when you have nothing" — and it is asserted
    // rather than routed around, because `Err(EmptySlot)` here is precisely what
    // a living player is no longer meant to be able to reach.
    assert!(
        p.inventory.slot(slot).is_none(),
        "the emptied rocket stack survived"
    );
    assert_eq!(p.try_fire(BAZOOKA_COOLDOWN * 2.0), Ok(WEAPON_SHOVEL));
    // The control: `EmptySlot` is still reachable, by selecting a slot that
    // holds nothing. Without it the assertion above would also be satisfied by a
    // build that had stopped reporting empty slots at all.
    p.inventory.select(slot);
    assert_eq!(
        p.try_fire(BAZOOKA_COOLDOWN * 4.0),
        Err(UseError::EmptySlot),
        "an empty slot stopped reporting itself"
    );
}

#[test]
fn the_flashlight_toggles_without_being_consumed() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.inventory.add(registry::FLASHLIGHT, 1);
    let slot = slot_of(&p, registry::FLASHLIGHT);
    assert_eq!(p.use_item(slot, 0.0), Ok(registry::FLASHLIGHT));
    assert!(p.flashlight_on);
    assert_eq!(
        p.inventory.count_of(registry::FLASHLIGHT),
        1,
        "the item was consumed"
    );
    p.use_item(slot, 0.0).expect("toggle back");
    assert!(!p.flashlight_on);
}

#[test]
fn a_dead_player_cannot_act() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.inventory.add(registry::BAZOOKA, 1);
    p.die(DeathCause::Weather, 0.0);
    assert_eq!(p.try_fire(10.0), Err(UseError::Dead));
    assert_eq!(p.use_item(0, 10.0), Err(UseError::Dead));
}

/// The doc is explicit that skipping this is how players spawn inside rock.
#[test]
fn respawn_never_places_a_player_inside_terrain_even_with_every_spawn_destroyed() {
    let mut map = game_core::map::generate(4242, MapScale::Medium);
    let spawns: Vec<Point> = map.meta.spawn_points.clone();
    assert!(spawns.len() >= 6);

    // Blow away all six listed spawn points, exactly as docs/21 §4 describes.
    for p in &spawns {
        map.carve_circle(p.x, p.y, 70);
    }

    let mut rng = substream(1, "respawn");
    for _ in 0..50 {
        let at = choose_respawn(&map, &[], &mut rng);
        // `choose_respawn` returns a body centre, so no compensation here.
        let aabb = Aabb::from_center_size(at, PLAYER_W, PLAYER_H);
        assert!(
            !aabb_overlaps_solid(&map, aabb),
            "respawned inside rock at {at:?}"
        );
    }
}

#[test]
fn respawn_prefers_a_point_away_from_the_living() {
    let map = game_core::map::generate(4242, MapScale::Medium);
    let mut rng = substream(2, "respawn");
    let camper = Vec2::new(
        map.meta.spawn_points[0].x as f32,
        map.meta.spawn_points[0].y as f32,
    );
    for _ in 0..20 {
        let at = choose_respawn(&map, &[camper], &mut rng);
        assert!(
            (at - camper).len() >= SPAWN_MIN_ENEMY_DIST - 1.0,
            "respawned {} px from a living player",
            (at - camper).len()
        );
    }
}

// ---------------------------------------------------------------------------
// A20: report damage that was applied, and name the source that caused it
// ---------------------------------------------------------------------------

/// A blast on a player who refuses the damage (i-frames) must record no hit —
/// but must still throw them. Recording the refused amount would put a phantom
/// `damage` event on the wire in M6 and poison kill attribution built on it.
#[test]
fn a_refused_hit_is_not_reported_but_is_still_thrown() {
    let mut map = flat_map(400);
    let at = Vec2::new(400.0, 340.0);
    let mut vel = Vec2::ZERO;
    let mut offered = 0.0f32;
    // Refuses everything, exactly as `apply_damage` does under SPAWN_IFRAMES.
    let mut cb = |amount: f32, _s: DamageSource| {
        offered += amount;
        false
    };
    let mut targets = [HitTarget {
        id: HitId::Player(3),
        w: game_core::constants::PLAYER_W,
        h: game_core::constants::PLAYER_H,
        pos: at,
        vel: &mut vel,
        alive: true,
        apply_damage: &mut cb,
    }];
    let res = explode(
        &mut map,
        &mut targets,
        at,
        BAZOOKA_BLAST_RADIUS,
        BAZOOKA_DAMAGE,
        BlastSource::Weather(EffectKind::LavaBurst),
    );

    assert!(offered > 0.0, "the blast never reached the player");
    assert!(
        res.hits.is_empty(),
        "recorded {:?} for damage the callee refused",
        res.hits
    );
    assert!(
        vel.len() > 0.0,
        "knockback must apply through i-frames (docs/21 §5)"
    );
}

/// The kill feed must not read "meteor" for every environmental death.
#[test]
fn an_ownerless_blast_is_attributed_to_the_source_that_caused_it() {
    for kind in [
        EffectKind::LavaBurst,
        EffectKind::ToxicRain,
        EffectKind::MeteorShower,
    ] {
        let mut map = flat_map(400);
        let at = Vec2::new(400.0, 340.0);
        let mut vel = Vec2::ZERO;
        let mut seen: Option<DamageSource> = None;
        let mut cb = |_a: f32, s: DamageSource| {
            seen = Some(s);
            true
        };
        let mut targets = [HitTarget {
            id: HitId::Player(1),
            w: game_core::constants::PLAYER_W,
            h: game_core::constants::PLAYER_H,
            pos: at,
            vel: &mut vel,
            alive: true,
            apply_damage: &mut cb,
        }];
        explode(
            &mut map,
            &mut targets,
            at,
            BAZOOKA_BLAST_RADIUS,
            BAZOOKA_DAMAGE,
            BlastSource::Weather(kind),
        );
        assert_eq!(seen, Some(DamageSource::Weather(kind)), "for {kind:?}");
    }
}

/// An owner blasting themselves is `SelfInflicted`, not `Player` — that is what
/// makes a rocket-jump death cost a point and award nobody.
#[test]
fn a_fired_blast_names_self_inflicted_for_its_own_owner() {
    let mut map = flat_map(400);
    let at = Vec2::new(400.0, 340.0);
    for (victim, expect_self) in [(7u8, true), (2u8, false)] {
        let mut vel = Vec2::ZERO;
        let mut seen: Option<DamageSource> = None;
        let mut cb = |_a: f32, s: DamageSource| {
            seen = Some(s);
            true
        };
        let mut targets = [HitTarget {
            id: HitId::Player(victim),
            w: game_core::constants::PLAYER_W,
            h: game_core::constants::PLAYER_H,
            pos: at,
            vel: &mut vel,
            alive: true,
            apply_damage: &mut cb,
        }];
        explode(
            &mut map,
            &mut targets,
            at,
            BAZOOKA_BLAST_RADIUS,
            BAZOOKA_DAMAGE,
            BlastSource::Fired {
                owner: 7,
                weapon: WEAPON_BAZOOKA,
            },
        );
        match (seen, expect_self) {
            (Some(DamageSource::SelfInflicted { .. }), true) => {}
            (Some(DamageSource::Player { id: 7, .. }), false) => {}
            other => panic!("victim {victim}: got {other:?}"),
        }
    }
}
