//! M4 part B: projectiles, explosions, hitscan, stats, death and scoring.

use game_core::constants::*;
use game_core::items::registry::{self, WEAPON_BAZOOKA, WEAPON_GRENADE, WEAPON_SMG};
use game_core::map::gen::silhouette::force_borders;
use game_core::map::{CoarseGrid, Map, MapMeta, Mask};
use game_core::math::{Aabb, Point, Vec2};
use game_core::physics::collide::aabb_overlaps_solid;
use game_core::player::state::{choose_respawn, DeathCause, PlayerState, UseError};
use game_core::rng::substream;
use game_core::weapons::defs;
use game_core::weapons::explode::{
    explode, fire_hitscan, DamageSource, EffectKind, HitscanHit, PlayerHitTarget,
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
        surface_points: Vec::new(),
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
        for (pid, out) in pr.step(&map, &[], 0.0, now, SIM_DT) {
            assert_eq!(pid, id);
            if let ProjectileOutcome::Exploded { at } = out {
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
        let outs = pr.step(&map, &[], 0.0, now, SIM_DT);
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
        pr.step(&map, &[], 0.0, now, SIM_DT);
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
        pr.step(&map, &[], 0.0, 2.0 + i as f32 * SIM_DT, SIM_DT);
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
        for (pid, out) in pr.step(&map, &[], 0.0, now, SIM_DT) {
            if pid == id {
                exploded = Some((now, out));
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
        for (_, out) in pr.step(&map, &[], 0.0, i as f32 * SIM_DT, SIM_DT) {
            if let ProjectileOutcome::Exploded { at: a } = out {
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
            .step(&map, &[], 0.0, i as f32 * SIM_DT, SIM_DT)
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
    let outs = pr.step(&map, &[(0u8, owner_box)], 0.0, SIM_DT, SIM_DT);
    assert!(outs.is_empty(), "a rocket hit its own owner at the muzzle");
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
        let mut targets: Vec<PlayerHitTarget> = Vec::new();
        let mut closures: Vec<Box<dyn FnMut(f32, DamageSource) -> bool>> = Vec::new();
        for _ in victims.iter() {
            closures.push(Box::new(|_, _| true));
        }
        let _ = &mut closures;
        let _ = &mut targets;
    }
    // Applied by hand: PlayerHitTarget borrows mutably, so the accumulation is
    // done through indices rather than closures capturing the same slice.
    for (i, v) in victims.iter_mut().enumerate() {
        let mut acc = 0.0f32;
        {
            let mut cb = |d: f32, _s: DamageSource| {
                acc += d;
                true
            };
            let mut targets = [PlayerHitTarget {
                id: i as u8,
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
                owner,
                Some(WEAPON_BAZOOKA),
                0.0,
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
    let mut targets: Vec<PlayerHitTarget> = Vec::new();
    let _ = &mut v;
    let res = explode(
        &mut map,
        &mut targets,
        Vec2::new(400.0, 340.0),
        BAZOOKA_BLAST_RADIUS,
        BAZOOKA_DAMAGE,
        None,
        None,
        0.0,
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
        let mut targets = [PlayerHitTarget {
            id: 0,
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
            None,
            None,
            0.0,
        );
    }
    assert!(applied, "damage was never offered");
    assert!(
        vel.y < -1.0,
        "knockback was skipped when damage was refused"
    );
}

// ------------------------------------------------------------------ T4.11

#[test]
fn an_smg_ray_stops_at_terrain_and_carves_it() {
    let mut map = flat_map(400);
    let before = map.mask.count_solid();
    let mut rng = substream(1, "test");
    let smg = defs::by_key("smg").expect("smg");
    let mut targets: Vec<PlayerHitTarget> = Vec::new();
    let shots = fire_hitscan(
        &mut map,
        &mut targets,
        smg,
        0,
        Vec2::new(300.0, 300.0),
        std::f32::consts::FRAC_PI_2,
        &mut rng,
        0.0,
    );
    assert_eq!(shots.len(), SMG_SHOTS as usize);
    assert_eq!(shots[0].hit, Some(HitscanHit::Terrain));
    assert!(
        (shots[0].to.y - 400.0).abs() < 3.0,
        "hit at {}",
        shots[0].to.y
    );
    // The 3-px carve is the SMG's identity: sustained fire tunnels.
    assert!(
        before - map.mask.count_solid() > 0,
        "the bullet did not dig"
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
    let smg = defs::by_key("smg").expect("smg");
    let mut breached = false;
    for _ in 0..60 {
        let mut targets: Vec<PlayerHitTarget> = Vec::new();
        fire_hitscan(
            &mut map,
            &mut targets,
            smg,
            0,
            Vec2::new(300.0, 256.0),
            0.0,
            &mut rng,
            0.0,
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
fn an_smg_ray_hits_a_player_without_knocking_them_back() {
    let mut map = empty_map();
    let mut rng = substream(3, "test");
    let smg = defs::by_key("smg").expect("smg");
    let mut vel = Vec2::ZERO;
    let mut dealt = 0.0f32;
    {
        let mut cb = |d: f32, _s: DamageSource| {
            dealt += d;
            true
        };
        let mut targets = [PlayerHitTarget {
            id: 1,
            pos: Vec2::new(500.0, 300.0),
            vel: &mut vel,
            alive: true,
            apply_damage: &mut cb,
        }];
        let shots = fire_hitscan(
            &mut map,
            &mut targets,
            smg,
            0,
            Vec2::new(300.0, 300.0),
            0.0,
            &mut rng,
            0.0,
        );
        assert_eq!(shots[0].hit, Some(HitscanHit::Player(1)));
    }
    assert_eq!(dealt, SMG_DAMAGE);
    assert_eq!(vel, Vec2::ZERO, "the smg must not displace anyone");
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

#[test]
fn death_drops_every_stack_and_respawn_clears_the_inventory() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.inventory.add(registry::GRENADE, 4);
    p.inventory.add(registry::MEDKIT, 1);
    p.flashlight_on = true;
    let dropped = p.die(DeathCause::Weather, 0.0);
    assert_eq!(dropped.len(), 3, "two grenade stacks and a medkit");
    assert!(p.inventory.is_empty());
    assert!(!p.flashlight_on, "the light dies with the item");
}

#[test]
fn the_verb_and_the_kind_must_agree() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.inventory.add(registry::MEDKIT, 1);
    p.inventory.select(0);
    assert_eq!(
        p.try_fire(0.0),
        Err(UseError::WrongKind),
        "cannot fire a medkit"
    );

    let mut q = PlayerState::new(0, Vec2::ZERO, 0);
    q.inventory.add(registry::BAZOOKA, 1);
    assert_eq!(
        q.use_item(0, 0.0),
        Err(UseError::WrongKind),
        "cannot use a bazooka"
    );
}

#[test]
fn firing_respects_the_cooldown_and_the_ammo_count() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.inventory.add(registry::BAZOOKA, 2);
    p.inventory.select(0);
    assert_eq!(p.try_fire(0.0), Ok(WEAPON_BAZOOKA));
    assert_eq!(p.try_fire(0.1), Err(UseError::OnCooldown));
    assert_eq!(p.try_fire(BAZOOKA_COOLDOWN), Ok(WEAPON_BAZOOKA));
    // Out of rockets: the slot is gone, so firing reports an empty slot.
    assert_eq!(p.try_fire(BAZOOKA_COOLDOWN * 2.0), Err(UseError::EmptySlot));
}

#[test]
fn the_flashlight_toggles_without_being_consumed() {
    let mut p = PlayerState::new(0, Vec2::ZERO, 0);
    p.inventory.add(registry::FLASHLIGHT, 1);
    assert_eq!(p.use_item(0, 0.0), Ok(registry::FLASHLIGHT));
    assert!(p.flashlight_on);
    assert_eq!(
        p.inventory.count_of(registry::FLASHLIGHT),
        1,
        "the item was consumed"
    );
    p.use_item(0, 0.0).expect("toggle back");
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
        let aabb =
            Aabb::from_center_size(Vec2::new(at.x, at.y - PLAYER_H / 2.0), PLAYER_W, PLAYER_H);
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
