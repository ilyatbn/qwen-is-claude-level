//! A flame: fire as an **object** (`docs/75-amendments-v7.md` §F10, §F10.1).
//!
//! Fire used to be two things and neither was a fire. The flamethrower was a
//! `Delivery::Cone` — an arc that was *checked* each tick — and a molotov lit
//! static discs of "burning ground". A disc that damages you while you stand in
//! it is a rule, not a flame: you cannot see where fire will go, you cannot push
//! it, and it does not behave like the thing on the screen.
//!
//! ## What lives here, and what deliberately does not
//!
//! **The flight is not here.** A flame is a `Projectile` with a fuse and no
//! contact explosion — which is a grenade that does not go off — so it bounces,
//! rests and expires on `projectile.rs`'s shared step. Writing a second flight
//! loop for fire is the §A24 mistake this codebase has paid for twice, and the
//! table entry (`defs.rs`) is the whole of a flame's physics.
//!
//! What is here is everything a projectile step has no opinion about: the
//! continuous burn, the scorch timer, and the global cap.
//!
//! ## Nothing emits a flame yet
//!
//! That is §F10.2 — the flamethrower, the molotov and the lava vent — and it is
//! T19.12. **The production-caller grep for this module is deferred there**, and
//! it is said out loud here so a later reader meeting a mechanism with no caller
//! does not conclude it was forgotten. What T19.11 owns is the flame; what
//! T19.12 owns is everything that makes one.

use crate::constants::{
    FLAME_DPS, FLAME_LIFE, FLAME_MAX_LIVE, FLAME_RADIUS, FLAME_SCORCH_EVERY, FLAME_SCORCH_R,
    PROJECTILE_OWNER_GRACE_TICKS,
};
use crate::items::registry::{WeaponId, WEAPON_FLAME};
use crate::map::{CarveResult, Map};
use crate::math::Vec2;
use crate::rng::{range_f32, ChaCha8Rng};
use crate::weapons::bullet::muzzle_angle;
use crate::weapons::explode::{BlastSource, HitId, HitTarget};
use crate::weapons::projectile::{PlayerId, Projectiles};

/// A flame with no dps, no life or no radius is `Burst::Flame` meaning nothing,
/// and §F10's whole claim is that fire is a thing that hurts you.
///
/// Checked at **compile time**. `defs.rs`'s `every_weapon_digs` asserts the
/// equivalent for every other burst kind out of the def's own fields, but a
/// flame's numbers are constants — so the same assertion written there is one
/// the optimiser can fold, which clippy rejects as `assertions_on_constants`.
/// This fails the build instead of a test, which is strictly earlier.
const _: () = assert!(FLAME_DPS > 0.0 && FLAME_LIFE > 0.0 && FLAME_RADIUS > 0.0);

/// Light `count` flames at `at`, fanned around `aim` by `spread`.
///
/// **The one spawn function, for all three emitters** (§F10.2): the flamethrower
/// presses, a molotov bursts, a lava vent smoulders. A second "spawn a fan of
/// flames" written for the molotov is the §A24 mistake this codebase has paid
/// for twice, and `burn.rs`'s own header used to say exactly that about the
/// system this replaces.
///
/// The angles are **drawn**, not evenly spaced. `burst_pellets` fans its nine
/// pellets deterministically on purpose — an even fan is what a shotgun wants —
/// but a flamethrower emitting two flames forty times a second along an even fan
/// lays down two perfectly straight lines, which is a laser with a fire palette.
/// The draw is from the world's seeded `ChaCha8Rng`, so a replay reproduces it
/// exactly; that is the same stream `bullet::muzzle_angle` already draws from.
///
/// Returns the ids, so a caller can announce them.
/// Where a fan of flames comes from and where it is pointed.
///
/// A struct rather than five loose `f32`s, for the reason `burn::Zone` is one:
/// `at`, `aim`, `spread` and `speed` are one description of a burst, and three
/// call sites passing them positionally is three chances to put a spread where a
/// speed goes.
#[derive(Copy, Clone, Debug)]
pub struct Fan {
    pub at: Vec2,
    /// Radians. Up is `-PI/2`.
    pub aim: f32,
    /// Half-width of the fan, radians.
    pub spread: f32,
    pub speed: f32,
    pub count: u32,
}

pub fn light_fan(
    projectiles: &mut Projectiles,
    owner: PlayerId,
    fan: Fan,
    rng: &mut ChaCha8Rng,
    now: f32,
) -> Vec<crate::weapons::projectile::ProjectileId> {
    let Fan {
        at,
        aim,
        spread,
        speed,
        count,
    } = fan;
    let mut ids = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let a = muzzle_angle(rng, aim, spread);
        // Speed varies as well as angle, or every flame in a burst lands on one
        // arc and a molotov's "crowd scattered along the ground" is a crowd
        // standing in a line. 60..100 % of the nominal speed.
        let v = speed * range_f32(rng, 0.6, 1.0);
        ids.push(projectiles.spawn_raw(
            WEAPON_FLAME,
            owner,
            at,
            Vec2::new(a.cos(), a.sin()) * v,
            now,
        ));
    }
    ids
}

/// Is this projectile a flame?
///
/// A function rather than a comparison at each call site, for the reason
/// `bullet::is_bullet` is one: three places decide what a flame means and a
/// fourth would be written as `weapon == WeaponId(25)`.
pub fn is_flame(weapon: WeaponId) -> bool {
    weapon == WEAPON_FLAME
}

/// One terrain bite, for the caller to turn into a `Carve` event **if it took
/// anything**.
///
/// Returned rather than emitted here for the same reason `explode` returns its
/// carve: this module has no access to the world's event queue or its carve
/// sequence, and a scorch that changes the mask without telling the clients is a
/// hole that exists on the server and not on the screen — §C0's shape.
#[derive(Debug)]
pub struct Scorch {
    pub at: Vec2,
    pub carve: CarveResult,
}

/// Burn everyone standing in a flame, and scorch the ground under the resting
/// ones. Call once per tick.
///
/// **Continuous, and it stacks.** `FLAME_DPS × dt` per overlapping flame per
/// tick, so standing in two burns twice as fast. That is a decision, not an
/// accident of the loop — a crowd of flames is meant to be worse than one — and
/// it is the same rule `BurnField::tick` already made for overlapping patches.
///
/// Damage goes to the caller's `apply_damage` closure, which is the one path
/// through `World::apply_damage_log` and therefore through the warmup gate. A
/// flame that subtracted health directly would be the single damage source that
/// skips it (§E13's lesson, one milestone old).
pub fn tick(
    projectiles: &Projectiles,
    map: &mut Map,
    targets: &mut [HitTarget],
    now: f32,
    dt: f32,
) -> Vec<Scorch> {
    let mut scorches = Vec::new();
    for p in projectiles.iter() {
        if !is_flame(p.weapon) {
            continue;
        }
        // Fire does not check whose side you are on (§F10.1) — but not on the
        // tick it leaves the muzzle, or a flamethrower would burn its user for
        // every shot before the flame had cleared them. The same
        // `PROJECTILE_OWNER_GRACE_TICKS` the flight step uses for collision, so
        // "the owner is briefly immune" has one definition.
        let owner_grace = p.age_ticks <= PROJECTILE_OWNER_GRACE_TICKS;
        let source = BlastSource::Fired {
            owner: p.owner,
            weapon: p.weapon,
        };
        for t in targets.iter_mut() {
            if !t.alive {
                continue;
            }
            if owner_grace && t.id == HitId::Player(p.owner) {
                continue;
            }
            if touching(p.pos, t) {
                (t.apply_damage)(FLAME_DPS * dt, source.for_victim(t.id));
            }
        }

        // The scorch is a **timer per flame, derived rather than stored**.
        //
        // A flame that carved every tick would eat a crater in a second. A
        // `last_scorched_at` field on `Projectile` would be a field every other
        // projectile carries and never reads; the interval index is a function
        // of `now - spawned_at`, so crossing a boundary is a comparison between
        // this tick and the last one and there is nothing to keep in step.
        //
        // Only while resting: a flame in mid-air scorches nothing, which is what
        // stops a flamethrower drilling a tunnel along its own stream.
        if p.resting && crate::math::fired_this_tick(p.spawned_at, FLAME_SCORCH_EVERY, now, dt) {
            let carve = map.carve_circle(
                p.pos.x.round() as i32,
                p.pos.y.round() as i32,
                FLAME_SCORCH_R.round() as i32,
            );
            // Reported **whether or not it removed anything**. A flame resting
            // in the hole it has already eaten bites nothing, and the caller is
            // the one that decides an empty carve is not worth an event — the
            // shape the toxic drop already uses. Filtering here would make "the
            // timer fired" and "there was rock left" the same number, and the
            // timer is the thing with a rule.
            scorches.push(Scorch { at: p.pos, carve });
        }
    }
    scorches
}

/// Is a flame at `at` touching this body?
///
/// **Circle against the body's box, not against a circle around its centre.**
/// `BurnField::tick` tests `radius + target.w * 0.5`, which works for it only
/// because `LAVA_BURN_RADIUS` (28) is bigger than a player's half-height (14) —
/// the extra reach hides the missing `h`. A flame is 10 px, and a body is 16
/// wide by 28 tall, so the same formula puts a flame **resting at your feet**
/// 22 px from your centre and 4 px outside its own radius: fire on the ground
/// would burn nobody standing in it. That is what this function is for, and it
/// is why `HitTarget` carries `h` at all.
///
/// `t.w`/`t.h`, not `PLAYER_W`/`PLAYER_H`: the slice holds birds too since §C16.
fn touching(at: Vec2, t: &HitTarget) -> bool {
    let dx = ((at.x - t.pos.x).abs() - t.w * 0.5).max(0.0);
    let dy = ((at.y - t.pos.y).abs() - t.h * 0.5).max(0.0);
    dx * dx + dy * dy <= FLAME_RADIUS * FLAME_RADIUS
}

/// Drop the oldest flames past `FLAME_MAX_LIVE`. Returns how many went.
///
/// **Global, and enforced in the step rather than at each emitter.** Three
/// things make flames (§F10.2) and a fourth will be added one day; a cap each
/// caller applies is a cap the fourth caller forgets, which is `CLAUDE.md`'s
/// "share the guard, or share the function". It is also why the cap counts
/// flames rather than projectiles: a rocket must not be deleted because someone
/// emptied a flamethrower.
///
/// Oldest is **lowest id**. `Projectiles` hands out ids from a monotonic
/// counter, so id order is spawn order exactly, and using `spawned_at` instead
/// would need a tie-break for the dozens a single molotov spawns on one tick.
pub fn enforce_cap(projectiles: &mut Projectiles) -> usize {
    let mut ids: Vec<u32> = projectiles
        .iter()
        .filter(|p| is_flame(p.weapon))
        .map(|p| p.id)
        .collect();
    if ids.len() <= FLAME_MAX_LIVE {
        return 0;
    }
    ids.sort_unstable();
    let excess = ids.len() - FLAME_MAX_LIVE;
    for id in ids.into_iter().take(excess) {
        projectiles.remove(id);
    }
    excess
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{GRENADE_REST_SPEED, PLAYER_H, PLAYER_W, SIM_DT};
    use crate::map::{CoarseGrid, MapMeta, Mask};
    use crate::weapons::defs::def;
    use crate::weapons::explode::DamageSource;
    use crate::weapons::projectile::{ProjectileId, ProjectileOutcome};

    // Multiples of CHUNK_SIZE: `Mask::new_empty` requires it.
    const W: u32 = 512;
    const H: u32 = 512;
    const GROUND: u32 = 400;

    /// A flat world with a floor at `GROUND` and a wall at `WALL_X`.
    const WALL_X: u32 = 300;

    fn flat_map(with_wall: bool) -> Map {
        let mut mask = Mask::new_empty(W, H);
        for y in GROUND..H {
            for x in 0..W {
                mask.set(x as i32, y as i32);
            }
        }
        if with_wall {
            for y in 200..GROUND {
                for x in WALL_X..(WALL_X + 20) {
                    mask.set(x as i32, y as i32);
                }
            }
        }
        let coarse = CoarseGrid::build(&mask);
        let meta = MapMeta {
            seed: 1,
            requested_seed: 1,
            attempts: 1,
            used_safe_preset: false,
            scale: crate::constants::MapScale::Small,
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
        };
        Map::from_parts(mask, coarse, meta)
    }

    /// One damageable body that records what it took and from whom.
    #[derive(Default)]
    struct Victim {
        pos: Vec2,
        taken: f32,
        sources: Vec<DamageSource>,
    }

    /// Run `f` with `victims` presented as a `HitTarget` slice.
    ///
    /// Written as a callback rather than a builder because `HitTarget` holds
    /// `&mut` borrows of the victim's velocity and damage closure, so the slice
    /// cannot outlive them.
    fn with_targets<R>(victims: &mut [Victim], f: impl FnOnce(&mut [HitTarget]) -> R) -> R {
        // One recorder per victim, filled after the borrow ends.
        let mut vels: Vec<Vec2> = victims.iter().map(|_| Vec2::ZERO).collect();
        let mut acc: Vec<(f32, Vec<DamageSource>)> =
            victims.iter().map(|_| (0.0, Vec::new())).collect();
        let poss: Vec<Vec2> = victims.iter().map(|v| v.pos).collect();
        let r = {
            let mut cbs: Vec<Box<dyn FnMut(f32, DamageSource) -> bool>> = Vec::new();
            let acc_ptr: *mut Vec<(f32, Vec<DamageSource>)> = &mut acc;
            for i in 0..poss.len() {
                cbs.push(Box::new(move |amount, src| {
                    // Safe: each closure touches only its own index, the vector
                    // is not resized, and none of them outlive this block.
                    let a = unsafe { &mut *acc_ptr };
                    a[i].0 += amount;
                    a[i].1.push(src);
                    true
                }));
            }
            let mut targets: Vec<HitTarget> = Vec::new();
            for ((i, cb), vel) in cbs.iter_mut().enumerate().zip(vels.iter_mut()) {
                targets.push(HitTarget {
                    id: HitId::Player(i as u8),
                    pos: poss[i],
                    w: PLAYER_W,
                    h: PLAYER_H,
                    vel,
                    alive: true,
                    apply_damage: cb.as_mut(),
                });
            }
            f(&mut targets)
        };
        for (v, (amount, srcs)) in victims.iter_mut().zip(acc) {
            v.taken += amount;
            v.sources.extend(srcs);
        }
        r
    }

    /// Spawn one flame with an explicit velocity, as every emitter will.
    fn light(ps: &mut Projectiles, owner: u8, pos: Vec2, vel: Vec2, now: f32) -> ProjectileId {
        ps.spawn_raw(WEAPON_FLAME, owner, pos, vel, now)
    }

    /// Advance the projectile step alone — no players, no birds, no wind.
    fn fly(ps: &mut Projectiles, map: &Map, now: f32, dt: f32) -> Vec<ProjectileOutcome> {
        ps.step(map, &[], &[], 0.0, now, dt)
            .into_iter()
            .map(|i| i.outcome)
            .collect()
    }

    #[test]
    fn a_flame_lives_exactly_flame_life() {
        let map = flat_map(false);
        let mut ps = Projectiles::new();
        light(
            &mut ps,
            0,
            Vec2::new(100.0, GROUND as f32 - 4.0),
            Vec2::ZERO,
            0.0,
        );

        // The control: one tick before the constant it is still alight. Without
        // it "it is gone" is satisfied by a flame that never existed.
        let mut now = 0.0;
        let mut ended_at = None;
        while now < FLAME_LIFE * 2.0 {
            now += SIM_DT;
            let out = fly(&mut ps, &map, now, SIM_DT);
            if !out.is_empty() {
                ended_at = Some(now);
                break;
            }
            assert!(
                now < FLAME_LIFE,
                "the flame was still alight at {now:.3} s, past FLAME_LIFE ({FLAME_LIFE})"
            );
            assert_eq!(
                ps.len(),
                1,
                "the flame vanished without reporting an outcome"
            );
        }
        let at = ended_at.unwrap_or_else(|| panic!("the flame never went out"));
        assert!(
            (at - FLAME_LIFE).abs() <= SIM_DT * 2.0,
            "the flame went out at {at:.3} s, not at FLAME_LIFE ({FLAME_LIFE})"
        );
        assert!(
            ps.is_empty(),
            "the flame is gone from the outcome and not from the list"
        );
    }

    #[test]
    fn a_flame_that_goes_out_is_not_a_blast() {
        // The def is what `World::detonate` reads to decide what going off
        // means, and the two zeroes are the difference between a fire that ends
        // and 160 craters.
        let w = def(WEAPON_FLAME).expect("the flame has no def");
        assert_eq!(w.blast_radius, 0.0, "a flame carves when it goes out");
        assert_eq!(w.damage, 0.0, "a flame deals its damage twice");
        assert!(
            matches!(w.burst, crate::weapons::defs::Burst::BurnsOut),
            "a flame's burst is not Burst::Flame"
        );
    }

    #[test]
    fn standing_in_one_costs_flame_dps_and_standing_beside_it_costs_nothing() {
        let mut map = flat_map(false);
        let mut ps = Projectiles::new();
        // **On the floor, not in mid-air.** `FLAME_GRAVITY_SCALE` is 0.35 and
        // `FLAME_RADIUS` is 10, so a flame dropped beside a standing body falls
        // out of its own radius in about a sixth of a second — the first draft
        // of this measured 3.0 of an expected 12.0 and looked like a dps bug.
        let at = Vec2::new(100.0, GROUND as f32 - 2.0);
        light(&mut ps, 9, at, Vec2::ZERO, 0.0);

        let mut vs = vec![
            Victim {
                pos: at,
                ..Default::default()
            },
            // The control, and it is the whole test: just outside the radius,
            // in the same run, taking the same ticks.
            Victim {
                pos: at + Vec2::new(FLAME_RADIUS + PLAYER_W * 0.5 + 1.0, 0.0),
                ..Default::default()
            },
        ];
        // The **whole life**, so this also asserts the burn stops when the flame
        // goes out: run past `FLAME_LIFE` and a flame that outlived its fuse
        // would overshoot rather than land on the product.
        let mut now = 0.0;
        while now < FLAME_LIFE * 1.5 {
            now += SIM_DT;
            // Stepped as well as ticked: this is what ages it past the owner
            // grace, and what eventually expires it.
            ps.step(&map, &[], &[], 0.0, now, SIM_DT);
            with_targets(&mut vs, |t| {
                tick(&ps, &mut map, t, now, SIM_DT);
            });
        }
        assert!(ps.is_empty(), "the flame outlived FLAME_LIFE");
        let want = FLAME_DPS * FLAME_LIFE;
        assert!(
            (vs[0].taken - want).abs() < FLAME_DPS * SIM_DT * 5.0,
            "a player standing in a flame for its whole life took {}, expected              FLAME_DPS x FLAME_LIFE = {want}",
            vs[0].taken
        );
        assert_eq!(
            vs[1].taken,
            0.0,
            "a player {} px away from a {FLAME_RADIUS} px flame was burned",
            FLAME_RADIUS + PLAYER_W * 0.5 + 1.0
        );
    }

    #[test]
    fn two_overlapping_flames_burn_twice_as_fast() {
        let mut map = flat_map(false);
        let at = Vec2::new(100.0, GROUND as f32 - 2.0);

        let burn_for = |n: usize, map: &mut Map| {
            let mut ps = Projectiles::new();
            for _ in 0..n {
                light(&mut ps, 9, at, Vec2::ZERO, 0.0);
            }
            let mut vs = vec![Victim {
                pos: at,
                ..Default::default()
            }];
            for _ in 0..30 {
                ps.step(map, &[], &[], 0.0, 0.0, SIM_DT);
                with_targets(&mut vs, |t| {
                    tick(&ps, map, t, 1.0, SIM_DT);
                });
            }
            vs[0].taken
        };
        // The control is one flame in the same place, so the claim is about the
        // second flame and not about the loop running twice.
        let one = burn_for(1, &mut map);
        let two = burn_for(2, &mut map);
        assert!(
            one > 0.0,
            "one flame burned nobody, so the ratio means nothing"
        );
        assert!(
            (two / one - 2.0).abs() < 0.05,
            "two overlapping flames dealt {two} against one flame's {one} — \
             the ratio is {}, not 2",
            two / one
        );
    }

    #[test]
    fn the_owner_is_burned_by_their_own_flame_but_not_before_the_grace() {
        let mut map = flat_map(false);
        let at = Vec2::new(100.0, GROUND as f32 - 2.0);
        let mut ps = Projectiles::new();
        light(&mut ps, 0, at, Vec2::ZERO, 0.0);
        let mut me = vec![Victim {
            pos: at,
            ..Default::default()
        }];

        // The grace, tick by tick. `PROJECTILE_OWNER_GRACE_TICKS` is the same
        // number the flight step uses, so "the owner is briefly immune" has one
        // definition rather than two that drift.
        for _ in 0..PROJECTILE_OWNER_GRACE_TICKS {
            ps.step(&map, &[], &[], 0.0, 0.0, SIM_DT);
            with_targets(&mut me, |t| {
                tick(&ps, &mut map, t, 1.0, SIM_DT);
            });
        }
        assert_eq!(
            me[0].taken, 0.0,
            "a flame burned its owner inside the grace"
        );

        for _ in 0..10 {
            ps.step(&map, &[], &[], 0.0, 0.0, SIM_DT);
            with_targets(&mut me, |t| {
                tick(&ps, &mut map, t, 1.0, SIM_DT);
            });
        }
        assert!(
            me[0].taken > 0.0,
            "a flame never burned its owner — fire does not check whose side you are on (§F10.1)"
        );
        // And it is attributed to them, not to nobody: §A20's rule survives.
        assert!(
            me[0].sources.iter().all(
                |s| matches!(s, DamageSource::SelfInflicted { weapon } if *weapon == WEAPON_FLAME)
            ),
            "burning yourself was not attributed as self-inflicted: {:?}",
            me[0].sources
        );
    }

    #[test]
    fn a_burn_kill_credits_whoever_lit_it() {
        let mut map = flat_map(false);
        let at = Vec2::new(100.0, GROUND as f32 - 2.0);
        let mut ps = Projectiles::new();
        // Owner 3, victim 0 — different players, so the `SelfInflicted` arm
        // above cannot be what is being observed here.
        light(&mut ps, 3, at, Vec2::ZERO, 0.0);
        let mut vs = vec![Victim {
            pos: at,
            ..Default::default()
        }];
        for _ in 0..20 {
            ps.step(&map, &[], &[], 0.0, 0.0, SIM_DT);
            with_targets(&mut vs, |t| {
                tick(&ps, &mut map, t, 1.0, SIM_DT);
            });
        }
        assert!(!vs[0].sources.is_empty(), "nobody was burned");
        assert!(
            vs[0].sources.iter().all(
                |s| matches!(s, DamageSource::Player { id: 3, weapon } if *weapon == WEAPON_FLAME)
            ),
            "a burn was credited to the map rather than to whoever lit it: {:?}",
            vs[0].sources
        );
    }

    #[test]
    fn a_flame_thrown_at_a_wall_bounces_and_comes_to_rest() {
        let map = flat_map(true);
        let mut ps = Projectiles::new();
        let start = Vec2::new(200.0, 380.0);
        let id = light(&mut ps, 0, start, Vec2::new(400.0, -50.0), 0.0);

        let mut now = 0.0;
        let mut bounced = false;
        // Stop short of `FLAME_LIFE` so this is about resting, not expiring.
        while now < FLAME_LIFE - 0.5 {
            now += SIM_DT;
            let before = ps.get(id).map(|p| p.vel.x);
            let out = fly(&mut ps, &map, now, SIM_DT);
            assert!(
                out.is_empty(),
                "the flame ended on contact: {out:?} — a flame's only end is FLAME_LIFE"
            );
            if let (Some(b), Some(p)) = (before, ps.get(id)) {
                if b > 0.0 && p.vel.x < 0.0 {
                    bounced = true;
                }
            }
        }
        let p = ps.get(id).expect("the flame is gone before FLAME_LIFE");
        assert!(
            bounced,
            "the flame never bounced off the wall at x={WALL_X}"
        );
        assert!(p.resting, "the flame never came to rest, vel {:?}", p.vel);
        assert!(
            p.vel.len() < GRENADE_REST_SPEED,
            "a resting flame still has speed {:?}",
            p.vel
        );
    }

    #[test]
    fn a_resting_flame_scorches_on_its_timer_and_a_flying_one_scorches_nothing() {
        let mut map = flat_map(false);
        let mut ps = Projectiles::new();
        // On the floor, at rest from the first tick.
        light(
            &mut ps,
            0,
            Vec2::new(100.0, GROUND as f32 - 2.0),
            Vec2::ZERO,
            0.0,
        );
        let mut none: Vec<Victim> = Vec::new();

        let mut scorches = 0;
        let mut now = 0.0;
        let window = FLAME_SCORCH_EVERY * 4.0;
        while now < window {
            now += SIM_DT;
            ps.step(&map, &[], &[], 0.0, now, SIM_DT);
            with_targets(&mut none, |t| {
                scorches += tick(&ps, &mut map, t, now, SIM_DT).len();
            });
        }
        // Four windows, so four bites and no more — the timer is the claim, and
        // a per-tick carve would report sixty times this.
        let want = (window / FLAME_SCORCH_EVERY).round() as usize;
        assert!(
            scorches == want || scorches == want - 1,
            "a resting flame scorched {scorches} times in {window} s, expected about {want} \
             (one every FLAME_SCORCH_EVERY = {FLAME_SCORCH_EVERY} s)"
        );

        // The control: the same flame, in mid-air, run **until it lands** rather
        // than for the same wall-clock window. `FLAME_GRAVITY_SCALE` brings it
        // down inside two seconds, and a control that keeps counting after that
        // is counting a resting flame and calling it a flying one — which is
        // what the first draft of this did, reporting 2 bites and looking like a
        // bug in the guard.
        let mut air_map = flat_map(false);
        let mut air = Projectiles::new();
        let id = light(&mut air, 0, Vec2::new(100.0, 120.0), Vec2::ZERO, 0.0);
        let mut air_scorches = 0;
        let mut t2 = 0.0;
        while air.get(id).is_some_and(|p| !p.resting) && t2 < FLAME_LIFE {
            t2 += SIM_DT;
            air.step(&air_map, &[], &[], 0.0, t2, SIM_DT);
            with_targets(&mut none, |t| {
                air_scorches += tick(&air, &mut air_map, t, t2, SIM_DT).len();
            });
        }
        // Not vacuous: it has to have been airborne across at least one boundary
        // of the very timer whose bites are being asserted absent.
        assert!(
            t2 > FLAME_SCORCH_EVERY,
            "the flame landed in {t2:.2} s, before one FLAME_SCORCH_EVERY had passed —              this control never got the chance to scorch"
        );
        assert_eq!(
            air_scorches, 0,
            "a flame in mid-air took {air_scorches} bites out of the ground over {t2:.2} s"
        );
    }

    #[test]
    fn the_field_is_capped_and_the_oldest_go_first() {
        let mut ps = Projectiles::new();
        let mut ids = Vec::new();
        for i in 0..(FLAME_MAX_LIVE + 10) {
            ids.push(light(
                &mut ps,
                0,
                Vec2::new(100.0 + i as f32, 300.0),
                Vec2::ZERO,
                i as f32 * SIM_DT,
            ));
        }
        // A rocket in the same list, to prove the cap counts flames and not
        // projectiles: emptying a flamethrower must not delete somebody's shot.
        let rocket = ps.spawn_raw(
            crate::items::registry::WEAPON_BAZOOKA,
            1,
            Vec2::new(50.0, 50.0),
            Vec2::new(100.0, 0.0),
            0.0,
        );

        let dropped = enforce_cap(&mut ps);
        assert_eq!(dropped, 10, "the cap dropped {dropped} flames, expected 10");
        let live: Vec<u32> = ps
            .iter()
            .filter(|p| is_flame(p.weapon))
            .map(|p| p.id)
            .collect();
        assert_eq!(live.len(), FLAME_MAX_LIVE);
        for gone in &ids[..10] {
            assert!(
                !live.contains(gone),
                "flame {gone} survived and it was the oldest"
            );
        }
        for kept in &ids[10..] {
            assert!(
                live.contains(kept),
                "flame {kept} was dropped and it was not the oldest"
            );
        }
        assert!(ps.get(rocket).is_some(), "the cap deleted a rocket");

        // And it is a no-op under the cap, so the guard cannot quietly thin a
        // field that is within budget.
        assert_eq!(enforce_cap(&mut ps), 0);
    }
}
