//! T11.01 — melee, cone and placed delivery (`docs/71-amendments-v3.md` §B6).
//!
//! Every one of these resolves through the same `apply_damage` closure that
//! explosions and hitscan use, so what is tested here is the *geometry* and the
//! *lifecycle* — the parts that are new — rather than a third copy of the damage
//! rules (§A24).

use game_core::constants::*;
use game_core::items::registry::WeaponId;
use game_core::map::gen::silhouette::force_borders;
use game_core::map::{CoarseGrid, Map, MapMeta, Mask};
use game_core::math::Vec2;
use game_core::weapons::burn::BurnField;
use game_core::weapons::cone::spray;
use game_core::weapons::defs::{Delivery, WeaponDef};
use game_core::weapons::explode::{BlastSource, DamageSource, HitId, HitTarget};
use game_core::weapons::melee::swing;
use game_core::weapons::placed::{MineEnd, Mines};

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
    Map::from_parts(mask.clone(), CoarseGrid::build(&mask), meta())
}

/// A flat floor plus a full-height wall at `wall_x`, 12 px thick.
fn walled_map(floor_y: i32, wall_x: i32) -> Map {
    let mut mask = Mask::new_empty(W, H);
    for y in floor_y..H as i32 {
        mask.set_run(y, 0, W as i32 - 1);
    }
    for y in 0..floor_y {
        mask.set_run(y, wall_x, wall_x + 11);
    }
    force_borders(&mut mask);
    Map::from_parts(mask.clone(), CoarseGrid::build(&mask), meta())
}

/// A melee weapon built here rather than taken from the registry: T11.01 is the
/// delivery, and T11.05 is the five weapons that use it.
fn melee_def(damage: f32, carve: f32) -> WeaponDef {
    WeaponDef {
        id: WeaponId(900),
        key: "test_melee",
        delivery: Delivery::Melee {
            reach: 40.0,
            arc: 1.2,
            knockback: 200.0,
        },
        damage,
        blast_radius: carve,
        range: 0.0,
        cooldown: 0.5,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: game_core::weapons::defs::Burst::Blast,
    }
}

fn cone_def() -> WeaponDef {
    WeaponDef {
        id: WeaponId(901),
        key: "test_cone",
        delivery: Delivery::Cone {
            range: 150.0,
            arc: 0.55,
            dps: 14.0,
            particle_life: 0.3,
        },
        damage: 0.0,
        blast_radius: 0.0,
        range: 150.0,
        cooldown: 0.05,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: game_core::weapons::defs::Burst::Blast,
    }
}

fn mine_def() -> WeaponDef {
    WeaponDef {
        id: WeaponId(902),
        key: "test_mine",
        delivery: Delivery::Placed {
            arm_time: 1.0,
            trigger_radius: 36.0,
            lifetime: 90.0,
        },
        damage: 60.0,
        blast_radius: 48.0,
        range: 0.0,
        cooldown: 1.0,
        muzzle_speed: 0.0,
        gravity_scale: 0.0,
        wind_scale: 0.0,
        energy_cost: 0.0,
        burst: game_core::weapons::defs::Burst::Blast,
    }
}

struct Victim {
    pos: Vec2,
    vel: Vec2,
    alive: bool,
    taken: f32,
    sources: Vec<DamageSource>,
}

impl Victim {
    fn at(x: f32, y: f32) -> Self {
        Victim {
            pos: Vec2::new(x, y),
            vel: Vec2::ZERO,
            alive: true,
            taken: 0.0,
            sources: Vec::new(),
        }
    }
}

/// Run `f` with `victims` wired as hit targets, ids starting at 1 so 0 is free
/// for the attacker.
fn with_targets<R>(victims: &mut [Victim], f: impl FnOnce(&mut [HitTarget]) -> R) -> R {
    // One victim per call keeps the borrow checker out of the way; every test
    // here needs at most two, so they are handled explicitly.
    assert!(
        victims.len() <= 2,
        "extend this helper if a test needs more"
    );
    let (a, rest) = victims.split_at_mut(1);
    let v0 = &mut a[0];
    let mut t0acc = 0.0f32;
    let mut t0src: Vec<DamageSource> = Vec::new();
    if rest.is_empty() {
        let mut cb = |d: f32, s: DamageSource| {
            t0acc += d;
            t0src.push(s);
            true
        };
        let mut targets = [HitTarget {
            id: HitId::Player(1),
            w: game_core::constants::PLAYER_W,
            h: game_core::constants::PLAYER_H,
            pos: v0.pos,
            vel: &mut v0.vel,
            alive: v0.alive,
            apply_damage: &mut cb,
        }];
        let r = f(&mut targets);
        v0.taken += t0acc;
        v0.sources.extend(t0src);
        return r;
    }
    let v1 = &mut rest[0];
    let mut t1acc = 0.0f32;
    let mut t1src: Vec<DamageSource> = Vec::new();
    let mut cb0 = |d: f32, s: DamageSource| {
        t0acc += d;
        t0src.push(s);
        true
    };
    let mut cb1 = |d: f32, s: DamageSource| {
        t1acc += d;
        t1src.push(s);
        true
    };
    let mut targets = [
        HitTarget {
            id: HitId::Player(1),
            w: game_core::constants::PLAYER_W,
            h: game_core::constants::PLAYER_H,
            pos: v0.pos,
            vel: &mut v0.vel,
            alive: v0.alive,
            apply_damage: &mut cb0,
        },
        HitTarget {
            id: HitId::Player(2),
            w: game_core::constants::PLAYER_W,
            h: game_core::constants::PLAYER_H,
            pos: v1.pos,
            vel: &mut v1.vel,
            alive: v1.alive,
            apply_damage: &mut cb1,
        },
    ];
    let r = f(&mut targets);
    v0.taken += t0acc;
    v0.sources.extend(t0src);
    v1.taken += t1acc;
    v1.sources.extend(t1src);
    r
}

const OWNER: BlastSource = BlastSource::Fired {
    owner: 0,
    weapon: WeaponId(900),
};

// ---------------------------------------------------------------- melee

#[test]
fn melee_hits_inside_the_arc_and_misses_just_outside_it() {
    let def = melee_def(35.0, 0.0);
    let origin = Vec2::new(500.0, 380.0);

    // Straight ahead, well inside the 1.2 rad arc.
    let mut inside = [Victim::at(530.0, 380.0)];
    let mut map = flat_map(400);
    with_targets(&mut inside, |t| {
        swing(&mut map, t, origin, 0.0, &def, 40.0, 1.2, 200.0, OWNER)
    });
    assert_eq!(inside[0].taken, 35.0, "a target dead ahead was not hit");

    // Just outside half the arc (0.6 rad) on each side, at the same distance.
    for sign in [-1.0f32, 1.0] {
        let a = sign * 0.75;
        let mut out = [Victim::at(
            origin.x + 30.0 * a.cos(),
            origin.y + 30.0 * a.sin(),
        )];
        let mut map = flat_map(400);
        with_targets(&mut out, |t| {
            swing(&mut map, t, origin, 0.0, &def, 40.0, 1.2, 200.0, OWNER)
        });
        assert_eq!(
            out[0].taken, 0.0,
            "a target at {a} rad should be outside the arc"
        );
    }
}

#[test]
fn melee_misses_beyond_its_reach() {
    let def = melee_def(35.0, 0.0);
    let origin = Vec2::new(500.0, 380.0);
    // Both sides of the boundary, since "reach" is the whole point of a whip.
    for (dx, want) in [(39.0f32, 35.0f32), (41.0, 0.0)] {
        let mut v = [Victim::at(origin.x + dx, origin.y)];
        let mut map = flat_map(400);
        with_targets(&mut v, |t| {
            swing(&mut map, t, origin, 0.0, &def, 40.0, 1.2, 200.0, OWNER)
        });
        assert_eq!(v[0].taken, want, "at {dx} px away");
    }
}

#[test]
fn melee_does_not_reach_through_a_wall() {
    let def = melee_def(35.0, 0.0);
    let origin = Vec2::new(500.0, 380.0);
    let target = Vec2::new(530.0, 380.0);

    // The control first: with no wall, this exact geometry connects. Without it
    // "no damage" would also pass for a swing that never hits anything.
    let mut clear = [Victim::at(target.x, target.y)];
    let mut open = flat_map(400);
    with_targets(&mut clear, |t| {
        swing(&mut open, t, origin, 0.0, &def, 40.0, 1.2, 200.0, OWNER)
    });
    assert_eq!(clear[0].taken, 35.0, "the control must connect");

    let mut blocked = [Victim::at(target.x, target.y)];
    let mut walled = walled_map(400, 512);
    with_targets(&mut blocked, |t| {
        swing(&mut walled, t, origin, 0.0, &def, 40.0, 1.2, 200.0, OWNER)
    });
    assert_eq!(blocked[0].taken, 0.0, "the swing went through a wall");
}

#[test]
fn melee_knocks_back_away_from_the_swinger_even_when_damage_is_refused() {
    let def = melee_def(35.0, 0.0);
    let origin = Vec2::new(500.0, 380.0);
    let mut v = Victim::at(530.0, 380.0);
    let mut map = flat_map(400);
    let mut refused = false;
    {
        // Refuse the damage the way i-frames do. Being thrown is not damage
        // (`docs/21` §5), so the impulse must land anyway.
        let mut cb = |_d: f32, _s: DamageSource| {
            refused = true;
            false
        };
        let mut targets = [HitTarget {
            id: HitId::Player(1),
            w: game_core::constants::PLAYER_W,
            h: game_core::constants::PLAYER_H,
            pos: v.pos,
            vel: &mut v.vel,
            alive: true,
            apply_damage: &mut cb,
        }];
        swing(
            &mut map,
            &mut targets,
            origin,
            0.0,
            &def,
            40.0,
            1.2,
            200.0,
            OWNER,
        );
    }
    assert!(refused, "the callee was never offered the damage");
    assert!(
        v.vel.x > 100.0,
        "knockback should push right, got {:?}",
        v.vel
    );
}

#[test]
fn a_swing_hits_every_target_in_the_arc_not_just_the_first() {
    let def = melee_def(20.0, 0.0);
    let origin = Vec2::new(500.0, 380.0);
    let mut vs = [Victim::at(520.0, 380.0), Victim::at(535.0, 384.0)];
    let mut map = flat_map(400);
    with_targets(&mut vs, |t| {
        swing(&mut map, t, origin, 0.0, &def, 40.0, 1.2, 200.0, OWNER)
    });
    assert_eq!(vs[0].taken, 20.0);
    assert_eq!(
        vs[1].taken, 20.0,
        "the second target in the arc was skipped"
    );
}

#[test]
fn melee_never_hits_its_own_swinger() {
    let def = melee_def(35.0, 0.0);
    let mut map = flat_map(400);
    let mut vel = Vec2::ZERO;
    let mut taken = 0.0f32;
    {
        let mut cb = |d: f32, _s: DamageSource| {
            taken += d;
            true
        };
        // id 0 is the owner in `OWNER`.
        let mut targets = [HitTarget {
            id: HitId::Player(0),
            w: game_core::constants::PLAYER_W,
            h: game_core::constants::PLAYER_H,
            pos: Vec2::new(500.0, 380.0),
            vel: &mut vel,
            alive: true,
            apply_damage: &mut cb,
        }];
        swing(
            &mut map,
            &mut targets,
            Vec2::new(500.0, 380.0),
            0.0,
            &def,
            40.0,
            1.2,
            200.0,
            OWNER,
        );
    }
    assert_eq!(taken, 0.0, "a bat hit its own wielder");
}

#[test]
fn a_carving_melee_digs_and_a_knife_does_not() {
    let origin = Vec2::new(500.0, 380.0);

    let mut digger = flat_map(400);
    let before = digger.mask.count_solid();
    let mut none: [Victim; 1] = [Victim::at(-999.0, -999.0)];
    with_targets(&mut none, |t| {
        // Swing down into the floor.
        swing(
            &mut digger,
            t,
            origin,
            std::f32::consts::FRAC_PI_2,
            &melee_def(55.0, 10.0),
            40.0,
            1.2,
            140.0,
            OWNER,
        )
    });
    assert!(
        digger.mask.count_solid() < before,
        "an axe with a carve radius did not dig"
    );

    let mut knife_map = flat_map(400);
    let before = knife_map.mask.count_solid();
    let mut none2: [Victim; 1] = [Victim::at(-999.0, -999.0)];
    with_targets(&mut none2, |t| {
        swing(
            &mut knife_map,
            t,
            origin,
            std::f32::consts::FRAC_PI_2,
            &melee_def(35.0, 0.0),
            40.0,
            1.2,
            60.0,
            OWNER,
        )
    });
    assert_eq!(
        knife_map.mask.count_solid(),
        before,
        "a knife with no carve radius dug a hole"
    );
}

// ----------------------------------------------------------------- cone

#[test]
fn cone_damage_accumulates_with_time_in_it() {
    let def = cone_def();
    let map = flat_map(400);
    let origin = Vec2::new(400.0, 380.0);
    let mut burn = BurnField::default();

    let mut v = [Victim::at(480.0, 380.0)];
    with_targets(&mut v, |t| {
        for i in 0..10 {
            spray(
                &map,
                t,
                &mut burn,
                origin,
                0.0,
                &def,
                150.0,
                0.55,
                14.0,
                i as f32 * SIM_DT,
                SIM_DT,
                OWNER,
            );
        }
    });
    let want = 14.0 * SIM_DT * 10.0;
    assert!(
        (v[0].taken - want).abs() < 0.01,
        "ten ticks in the cone dealt {} not {want}",
        v[0].taken
    );
}

#[test]
fn cone_stops_at_its_range_and_at_a_wall() {
    let def = cone_def();
    let origin = Vec2::new(400.0, 380.0);
    let mut burn = BurnField::default();

    // Beyond range.
    let map = flat_map(400);
    let mut far = [Victim::at(origin.x + 151.0, 380.0)];
    with_targets(&mut far, |t| {
        spray(
            &map, t, &mut burn, origin, 0.0, &def, 150.0, 0.55, 14.0, 0.0, SIM_DT, OWNER,
        )
    });
    assert_eq!(far[0].taken, 0.0, "a target past the range was burned");

    // The control: the same distance, inside range, does burn.
    let mut near = [Victim::at(origin.x + 140.0, 380.0)];
    with_targets(&mut near, |t| {
        spray(
            &map, t, &mut burn, origin, 0.0, &def, 150.0, 0.55, 14.0, 0.0, SIM_DT, OWNER,
        )
    });
    assert!(near[0].taken > 0.0, "the control must burn");

    // Behind a wall, in range and in the arc.
    let walled = walled_map(400, 450);
    let mut hidden = [Victim::at(480.0, 380.0)];
    with_targets(&mut hidden, |t| {
        spray(
            &walled, t, &mut burn, origin, 0.0, &def, 150.0, 0.55, 14.0, 0.0, SIM_DT, OWNER,
        )
    });
    assert_eq!(hidden[0].taken, 0.0, "the flame reached through a wall");
}

#[test]
fn cone_leaves_burning_ground_that_goes_out() {
    let def = cone_def();
    let map = flat_map(400);
    let mut burn = BurnField::default();
    let mut none: [Victim; 1] = [Victim::at(-999.0, -999.0)];
    with_targets(&mut none, |t| {
        spray(
            &map,
            t,
            &mut burn,
            Vec2::new(400.0, 380.0),
            0.0,
            &def,
            150.0,
            0.55,
            14.0,
            0.0,
            SIM_DT,
            OWNER,
        )
    });
    assert!(!burn.is_empty(), "the flame left no burning ground");

    // It expires. Ticking with no players still has to retire the patch, or
    // fire would burn for the rest of the round.
    let mut none2: [Victim; 1] = [Victim::at(-999.0, -999.0)];
    with_targets(&mut none2, |t| burn.tick(t, 60.0, SIM_DT));
    assert!(burn.is_empty(), "burning ground never went out");
}

#[test]
fn a_cone_carves_nothing() {
    // Fire does not dig (§B6). This is what keeps the flamethrower from being
    // strictly better than the arsenal it competes with.
    let def = cone_def();
    let map = flat_map(400);
    let before = map.mask.count_solid();
    let mut burn = BurnField::default();
    let mut none: [Victim; 1] = [Victim::at(-999.0, -999.0)];
    with_targets(&mut none, |t| {
        spray(
            &map,
            t,
            &mut burn,
            Vec2::new(400.0, 380.0),
            std::f32::consts::FRAC_PI_2,
            &def,
            150.0,
            0.55,
            14.0,
            0.0,
            SIM_DT,
            OWNER,
        )
    });
    assert_eq!(map.mask.count_solid(), before);
}

// ---------------------------------------------------------------- mines

#[test]
fn a_mine_arms_only_after_its_arm_time() {
    let def = mine_def();
    let mut map = flat_map(400);
    let mut mines = Mines::default();
    mines.place(0, &def, Vec2::new(500.0, 396.0), 1.0, 36.0, 90.0, 0.0);

    // An intruder is standing on it from the start. Both sides of the boundary.
    for (now, want) in [(0.99f32, false), (1.01, true)] {
        let mut mines2 = Mines::default();
        mines2.place(0, &def, Vec2::new(500.0, 396.0), 1.0, 36.0, 90.0, 0.0);
        let mut v = [Victim::at(505.0, 396.0)];
        let ended = with_targets(&mut v, |t| mines2.step(&mut map, t, now, SIM_DT));
        assert_eq!(
            ended.iter().any(|o| o.reason == MineEnd::Detonated),
            want,
            "at t={now}"
        );
    }
    let _ = &mut mines;
}

#[test]
fn a_mine_ignores_its_owner_and_triggers_on_anyone_else() {
    let def = mine_def();
    let mut map = flat_map(400);

    // The owner is id 0 and stands on it: nothing happens, ever.
    let mut mines = Mines::default();
    mines.place(0, &def, Vec2::new(500.0, 396.0), 1.0, 36.0, 90.0, 0.0);
    let mut vel = Vec2::ZERO;
    let mut cb = |_d: f32, _s: DamageSource| true;
    let mut owner = [HitTarget {
        id: HitId::Player(0),
        w: game_core::constants::PLAYER_W,
        h: game_core::constants::PLAYER_H,
        pos: Vec2::new(500.0, 396.0),
        vel: &mut vel,
        alive: true,
        apply_damage: &mut cb,
    }];
    let ended = mines.step(&mut map, &mut owner, 5.0, SIM_DT);
    assert!(ended.is_empty(), "a mine went off under its own owner");
    assert_eq!(mines.len(), 1);

    // Anyone else does set it off — the control that proves the above is not
    // simply a mine that never triggers.
    let mut v = [Victim::at(505.0, 396.0)];
    let ended = with_targets(&mut v, |t| mines.step(&mut map, t, 5.0, SIM_DT));
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].reason, MineEnd::Detonated);
    assert!(v[0].taken > 0.0, "the detonation dealt no damage");
}

#[test]
fn a_mine_triggers_at_its_radius_and_not_a_pixel_past_it() {
    let def = mine_def();
    let mut map = flat_map(400);
    for (dx, want) in [(35.0f32, true), (37.0, false)] {
        let mut mines = Mines::default();
        mines.place(0, &def, Vec2::new(500.0, 396.0), 1.0, 36.0, 90.0, 0.0);
        let mut v = [Victim::at(500.0 + dx, 396.0)];
        let ended = with_targets(&mut v, |t| mines.step(&mut map, t, 5.0, SIM_DT));
        assert_eq!(
            ended.iter().any(|o| o.reason == MineEnd::Detonated),
            want,
            "at {dx} px from the mine"
        );
    }
}

#[test]
fn a_mine_expires_and_says_so() {
    let def = mine_def();
    let mut map = flat_map(400);
    let mut mines = Mines::default();
    mines.place(0, &def, Vec2::new(500.0, 396.0), 1.0, 36.0, 90.0, 0.0);
    let mut v = [Victim::at(-999.0, -999.0)];
    let ended = with_targets(&mut v, |t| mines.step(&mut map, t, 91.0, SIM_DT));
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].reason, MineEnd::Expired);
    assert!(mines.is_empty());
}

#[test]
fn an_explosion_destroys_a_mine_without_detonating_it() {
    // `docs/31` §5: explosions do not chain. A mine caught in a blast is
    // destroyed silently, exactly as a grenade is.
    let def = mine_def();
    let mut mines = Mines::default();
    let id = mines.place(0, &def, Vec2::new(500.0, 396.0), 1.0, 36.0, 90.0, 0.0);
    let gone: Vec<_> = mines
        .destroy_in_blast(Vec2::new(520.0, 396.0), 42.0)
        .into_iter()
        .map(|o| o.id)
        .collect();
    assert_eq!(gone, vec![id]);
    assert!(mines.is_empty());

    // Out of range, it survives — the control.
    let mut mines = Mines::default();
    mines.place(0, &def, Vec2::new(500.0, 396.0), 1.0, 36.0, 90.0, 0.0);
    assert!(mines
        .destroy_in_blast(Vec2::new(600.0, 396.0), 42.0)
        .into_iter()
        .map(|o| o.id)
        .collect::<Vec<_>>()
        .is_empty());
    assert_eq!(mines.len(), 1);
}

#[test]
fn a_mine_falls_when_the_ground_under_it_is_carved() {
    // The floating-item bug, which this project has already shipped once
    // (`docs/32` §4): a mine hanging over a crater is the same lie.
    let def = mine_def();
    let mut map = flat_map(400);
    let mut mines = Mines::default();
    mines.place(0, &def, Vec2::new(500.0, 396.0), 1.0, 36.0, 90.0, 0.0);

    let mut v = [Victim::at(-999.0, -999.0)];
    with_targets(&mut v, |t| {
        for i in 0..30 {
            mines.step(&mut map, t, i as f32 * SIM_DT, SIM_DT);
        }
    });
    let settled = mines.iter().next().expect("the mine expired").pos().y;

    map.carve_circle(500, 410, 60);
    let mut v2 = [Victim::at(-999.0, -999.0)];
    with_targets(&mut v2, |t| {
        for i in 30..90 {
            mines.step(&mut map, t, i as f32 * SIM_DT, SIM_DT);
        }
    });
    let after = mines.iter().next().expect("the mine expired").pos().y;
    assert!(
        after > settled + 10.0,
        "the mine hung over the crater: {settled} → {after}"
    );
}
