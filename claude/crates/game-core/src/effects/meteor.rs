//! Meteor shower: the effect that reshapes the map more than any weapon.
//!
//! Meteors are **ordinary projectiles** (`docs/13-weather-effects.md` §4). They
//! already need gravity, sub-stepped terrain collision and player AABB tests, and
//! a bespoke meteor simulation would be a second copy of all of it, free to drift.

use crate::constants::{
    METEOR_CARVE_R, METEOR_DAMAGE, METEOR_EVERY, METEOR_FRAGMENTS, METEOR_FRAG_CARVE_R,
    METEOR_FRAG_DAMAGE, METEOR_FRAG_SPEED_MAX, METEOR_FRAG_SPEED_MIN, METEOR_SPEED, SKY_MARGIN,
    WALL_W,
};
use crate::items::registry::{WEAPON_METEOR, WEAPON_METEOR_FRAG};
use crate::map::Map;
use crate::math::Vec2;
use crate::rng::{range_f32, substream, ChaCha8Rng};
use crate::weapons::explode::{explode, BlastSource, EffectKind, ExplosionResult, HitTarget};
use crate::weapons::projectile::{ProjectileId, Projectiles};

/// Meteors spawn above the map and fall in.
const SPAWN_Y: f32 = -32.0;
/// A little lateral drift so they do not all fall in perfect verticals.
const LATERAL_MAX: f32 = 60.0;

pub struct MeteorShower {
    rng: ChaCha8Rng,
    /// `None` until the first **active** tick. See `tick`.
    next_spawn_at: Option<f32>,
}

impl MeteorShower {
    pub fn new(seed: u64, _now: f32) -> Self {
        Self {
            rng: substream(seed, "meteor"),
            // Set on the first ACTIVE tick, not here — the shower is constructed
            // when its TELEGRAPH starts and drops nothing for `EFFECT_TELEGRAPH`
            // (3 s) afterwards. Anchoring the cadence here meant the first active
            // tick released six meteors at once to catch up on cadence it had
            // "missed" while telegraphing. Same defect as toxic rain's, same
            // cause, found by the same test.
            next_spawn_at: None,
        }
    }

    /// Spawn meteors on cadence into the shared projectile pool.
    pub fn tick(
        &mut self,
        projectiles: &mut Projectiles,
        map: &Map,
        active: bool,
        now: f32,
    ) -> Vec<ProjectileId> {
        let mut out = Vec::new();
        if !active {
            return out;
        }
        let mut next = self.next_spawn_at.unwrap_or(now);
        while now >= next {
            let x = range_f32(
                &mut self.rng,
                (WALL_W as f32) + 32.0,
                (map.mask.w as f32) - (WALL_W as f32) - 32.0,
            );
            let vx = range_f32(&mut self.rng, -LATERAL_MAX, LATERAL_MAX);
            out.push(projectiles.spawn_raw(
                WEAPON_METEOR,
                // No owner: `BlastSource::Weather` at impact makes attribution
                // explicit, so this id is never read as a player.
                u8::MAX,
                Vec2::new(x, SPAWN_Y),
                Vec2::new(vx, METEOR_SPEED),
                now,
            ));
            next += METEOR_EVERY;
        }
        self.next_spawn_at = Some(next);
        out
    }

    /// Resolve an impact: carve, damage, and (for a meteor, never a fragment)
    /// throw fragments.
    ///
    /// `is_fragment` is the entire recursion guard. Six fragments each spawning
    /// six is 36, then 216: the tick stops terminating in about four generations.
    /// Returns the blast **and the fragment ids it threw**, because the caller
    /// has to announce them: a projectile nobody was told about cannot be drawn,
    /// and these six per impact were spawned straight into the pool and never
    /// broadcast (§A39).
    pub fn on_impact(
        projectiles: &mut Projectiles,
        map: &mut Map,
        players: &mut [HitTarget],
        at: Vec2,
        is_fragment: bool,
        seed: u64,
        now: f32,
    ) -> (ExplosionResult, Vec<ProjectileId>) {
        let (radius, damage) = if is_fragment {
            (METEOR_FRAG_CARVE_R, METEOR_FRAG_DAMAGE)
        } else {
            (METEOR_CARVE_R, METEOR_DAMAGE)
        };

        // **A roof protects you** (§E13). Asked before the blast, because the
        // blast carves: a meteor that opened the ceiling and *then* checked
        // would find open sky above everyone it just buried.
        //
        // Partitioned rather than filtered, because `explode` takes a slice.
        // Sheltered targets are swapped to the tail and the blast is handed the
        // head; the head keeps its relative order, so which victims appear in
        // `hits` and in what order is unchanged for everyone still exposed.
        //
        // This is the half §E13 predicted: the amendment asked toxic rain for a
        // roof rule and observed that the shower "also does not have it". It did
        // not — a meteor landing on a cave roof dealt its full 55 through the
        // rock to whoever was sheltering underneath, which is the one thing
        // cover is for.
        let mut exposed = 0usize;
        for i in 0..players.len() {
            if !crate::effects::under_a_roof(map, players[i].pos) {
                players.swap(i, exposed);
                exposed += 1;
            }
        }

        let result = explode(
            map,
            &mut players[..exposed],
            at,
            radius,
            damage,
            BlastSource::Weather(EffectKind::MeteorShower),
        );

        let mut fragments = Vec::new();
        if !is_fragment {
            // Seeded from the impact so a replay reproduces the spread, and so two
            // clients rendering the same impact agree.
            let mut rng = substream(seed, "meteor_frag");
            for i in 0..METEOR_FRAGMENTS {
                // The UPWARD hemisphere: fragments driven straight back into the
                // ground they just came from are wasted. Screen coords, so upward
                // is negative y, i.e. angles in -pi..0.
                let a = -std::f32::consts::PI * (i as f32 + 0.5) / METEOR_FRAGMENTS as f32
                    + range_f32(&mut rng, -0.2, 0.2);
                let speed = range_f32(&mut rng, METEOR_FRAG_SPEED_MIN, METEOR_FRAG_SPEED_MAX);
                fragments.push(projectiles.spawn_raw(
                    WEAPON_METEOR_FRAG,
                    u8::MAX,
                    at,
                    Vec2::new(a.cos() * speed, a.sin() * speed),
                    now,
                ));
            }
        }

        (result, fragments)
    }

    /// True when this projectile is weather ordnance the shower owns.
    pub fn owns(weapon: crate::items::registry::WeaponId) -> bool {
        weapon == WEAPON_METEOR || weapon == WEAPON_METEOR_FRAG
    }

    pub fn is_fragment(weapon: crate::items::registry::WeaponId) -> bool {
        weapon == WEAPON_METEOR_FRAG
    }
}

/// Where a meteor spawns, for the client's telegraph shadows.
pub fn spawn_band() -> (f32, f32) {
    (SPAWN_Y, SKY_MARGIN as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, METEOR_DURATION};
    use crate::map::gen::silhouette::force_borders;
    use crate::map::meta::{BuriedSlot, MapMeta};
    use crate::map::{CoarseGrid, Mask};
    use crate::math::Aabb;
    use crate::weapons::explode::DamageSource;
    use crate::weapons::explode::HitId;
    use crate::weapons::projectile::ProjectileOutcome;

    const DT: f32 = 1.0 / 60.0;

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

    /// A fully solid map, built directly.
    ///
    /// Deliberately NOT `generate()`: these tests need a known shape, not a
    /// realistic one, and calling the generator ~18 times across the module made
    /// this file take over ten minutes in a debug build. Fixtures should cost
    /// what the property under test needs and no more.
    fn solid_map() -> Map {
        let mask = Mask::new_full(W, H);
        let coarse = CoarseGrid::build(&mask);
        Map::from_parts(mask, coarse, meta())
    }

    /// Solid ground with **open sky over a column**, so a meteor can reach what
    /// is standing there.
    ///
    /// `solid_map` is solid to `y = 0`, which since §E13 means every point in it
    /// is under a roof and immune to the shower. That is the rule working, not a
    /// fixture bug — but a fixture that measures blast falloff has to put its
    /// target somewhere a blast can reach, or it measures the roof instead.
    fn map_with_a_shaft(x0: i32, x1: i32, down_to: i32) -> Map {
        let mut mask = Mask::new_full(W, H);
        for y in 0..down_to {
            mask.clear_run(y, x0, x1);
        }
        let coarse = CoarseGrid::build(&mask);
        Map::from_parts(mask, coarse, meta())
    }

    /// A solid map with one buried slot at a known point.
    fn map_with_slot(at: crate::math::Point) -> Map {
        let mut mask = Mask::new_full(W, H);
        force_borders(&mut mask);
        let coarse = CoarseGrid::build(&mask);
        let mut m = meta();
        m.buried_slots.push(BuriedSlot {
            id: 0,
            pos: at,
            revealed: false,
        });
        Map::from_parts(mask, coarse, m)
    }

    /// Drive a shower to completion, resolving impacts exactly as the world step
    /// will. Returns (meteors spawned, fragments spawned, peak live projectiles).
    fn run_shower(seconds: f32) -> (usize, usize, usize) {
        let mut map = solid_map();
        let mut pr = Projectiles::new();
        let mut shower = MeteorShower::new(9, 0.0);
        let (mut meteors, mut frags, mut peak) = (0usize, 0usize, 0usize);

        let ticks = ((seconds + 6.0) / DT) as u32;
        for i in 0..ticks {
            let now = i as f32 * DT;
            meteors += shower.tick(&mut pr, &map, now < seconds, now).len();

            // The weapon must be read BEFORE `step`, which removes a projectile as
            // it reports the outcome. An earlier version of this harness guessed
            // `is_fragment` from the id and got it wrong for every impact, so
            // fragments spawned fragments and the test hung — the fork bomb
            // `is_fragment` exists to prevent, reproduced by accident.
            //
            // `Impact` now carries the weapon, so there is nothing to snapshot and
            // nothing to get wrong.
            for im in pr.step(&map, &[], &[], 0.0, now, DT) {
                let at = match im.outcome {
                    ProjectileOutcome::Exploded { at } => at,
                    ProjectileOutcome::Hit { at, .. } => at,
                    // A meteor has no `range`, so it can never be spent — named
                    // rather than caught by `_` so a new outcome is a compile
                    // error here too.
                    ProjectileOutcome::Spent { at } => at,
                    // A meteor that leaves the map spawns no fragments: it is
                    // gone, not detonated (§C15).
                    ProjectileOutcome::Alive | ProjectileOutcome::Voided { .. } => continue,
                };
                let is_frag = MeteorShower::is_fragment(im.weapon);
                let before = pr.len();
                MeteorShower::on_impact(&mut pr, &mut map, &mut [], at, is_frag, im.id as u64, now);
                frags += pr.len().saturating_sub(before);
            }
            peak = peak.max(pr.len());
        }
        (meteors, frags, peak)
    }

    #[test]
    fn a_full_shower_spawns_duration_over_cadence_meteors() {
        let mut map = solid_map();
        let mut pr = Projectiles::new();
        let mut shower = MeteorShower::new(9, 0.0);
        let mut n = 0;
        let ticks = (METEOR_DURATION / DT) as u32;
        for i in 0..ticks {
            n += shower.tick(&mut pr, &map, true, i as f32 * DT).len();
        }
        let _ = &mut map;
        assert_eq!(n, (METEOR_DURATION / METEOR_EVERY) as usize, "{n} meteors");
    }

    #[test]
    fn nothing_spawns_while_inactive() {
        let map = solid_map();
        let mut pr = Projectiles::new();
        let mut shower = MeteorShower::new(9, 0.0);
        for i in 0..600 {
            assert!(shower.tick(&mut pr, &map, false, i as f32 * DT).is_empty());
        }
    }

    #[test]
    fn meteors_spawn_above_the_map_and_fall_downward() {
        let map = solid_map();
        let mut pr = Projectiles::new();
        let mut shower = MeteorShower::new(9, 0.0);
        shower.tick(&mut pr, &map, true, 0.0);
        let p = pr.iter().next().expect("no meteor");
        assert!(p.pos.y < 0.0, "spawned at y={}", p.pos.y);
        assert!(p.vel.y > 0.0, "not falling: vy={}", p.vel.y);
        assert!(p.pos.x > WALL_W as f32 && p.pos.x < map.mask.w as f32 - WALL_W as f32);
    }

    #[test]
    fn an_impact_carves_its_radius_and_spawns_exactly_six_fragments() {
        let mut map = solid_map();
        let before = map.mask.count_solid();
        let mut pr = Projectiles::new();
        let at = Vec2::new(600.0, 300.0);

        let res = MeteorShower::on_impact(&mut pr, &mut map, &mut [], at, false, 1, 0.0);

        let removed = before - map.mask.count_solid();
        let expected = std::f32::consts::PI * METEOR_CARVE_R * METEOR_CARVE_R;
        assert!(
            (removed as f32 - expected).abs() / expected < 0.05,
            "carved {removed}, expected about {expected}"
        );
        assert!(res.0.carve.pixels_removed > 0);
        assert_eq!(pr.len(), METEOR_FRAGMENTS as usize);
    }

    #[test]
    fn fragments_go_upward_at_the_stated_speeds() {
        let mut map = solid_map();
        let mut pr = Projectiles::new();
        MeteorShower::on_impact(
            &mut pr,
            &mut map,
            &mut [],
            Vec2::new(600.0, 300.0),
            false,
            1,
            0.0,
        );
        for p in pr.iter() {
            let speed = p.vel.len();
            assert!(
                (METEOR_FRAG_SPEED_MIN - 1.0..=METEOR_FRAG_SPEED_MAX + 1.0).contains(&speed),
                "fragment speed {speed}"
            );
            assert!(p.vel.y < 0.0, "fragment not upward: vy={}", p.vel.y);
        }
    }

    #[test]
    fn a_fragment_impact_is_smaller_and_spawns_nothing() {
        // THE RECURSION GUARD. Six fragments each spawning six is 36, then 216;
        // the tick stops terminating in about four generations.
        let mut map = solid_map();
        let before = map.mask.count_solid();
        let mut pr = Projectiles::new();

        MeteorShower::on_impact(
            &mut pr,
            &mut map,
            &mut [],
            Vec2::new(600.0, 300.0),
            true,
            1,
            0.0,
        );

        assert!(pr.is_empty(), "a fragment spawned {} more", pr.len());
        let removed = before - map.mask.count_solid();
        let expected = std::f32::consts::PI * METEOR_FRAG_CARVE_R * METEOR_FRAG_CARVE_R;
        assert!(
            (removed as f32 - expected).abs() / expected < 0.10,
            "fragment carved {removed}, expected about {expected}"
        );
    }

    #[test]
    fn fragments_never_spawn_fragments() {
        // THE recursion test. Rather than simulating a full 16 s shower — minutes
        // in a debug build, for no extra confidence — resolve one meteor and then
        // resolve every fragment it threw, and assert generation two is empty. Six
        // fragments each spawning six is 36, then 216, and the tick stops
        // terminating in about four generations.
        let mut map = solid_map();
        let mut pr = Projectiles::new();
        let at = Vec2::new(600.0, 300.0);

        MeteorShower::on_impact(&mut pr, &mut map, &mut [], at, false, 1, 0.0);
        assert_eq!(pr.len(), METEOR_FRAGMENTS as usize);

        let ids: Vec<_> = pr.iter().map(|p| (p.id, p.weapon)).collect();
        assert!(
            ids.iter().all(|(_, w)| MeteorShower::is_fragment(*w)),
            "an impact threw something that is not a fragment"
        );
        for (id, w) in ids {
            pr.remove(id);
            MeteorShower::on_impact(
                &mut pr,
                &mut map,
                &mut [],
                at,
                MeteorShower::is_fragment(w),
                id as u64,
                0.0,
            );
        }
        assert!(
            pr.is_empty(),
            "generation two produced {} more projectiles",
            pr.len()
        );
    }

    #[test]
    fn a_short_shower_stays_bounded() {
        // A live run through the real projectile step, kept to two seconds so it
        // costs seconds rather than minutes in a debug build.
        let (meteors, _frags, peak) = run_shower(2.0);
        assert_eq!(meteors, (2.0 / METEOR_EVERY) as usize);
        assert!(peak < 200, "peak projectile count {peak}");
    }

    #[test]
    fn damage_falls_off_and_the_shield_halves_it() {
        for (dist, shielded) in [(0.0f32, false), (0.0, true), (METEOR_CARVE_R * 0.5, false)] {
            // Open above the target and the impact point, so this test measures
            // falloff rather than §E13's roof.
            let mut map = map_with_a_shaft(500, 800, 320);
            let mut pr = Projectiles::new();
            let at = Vec2::new(600.0, 300.0);
            let mut vel = Vec2::ZERO;
            let mut taken = 0.0f32;
            let mut cb = |amount: f32, s: DamageSource| {
                assert_eq!(s, DamageSource::Weather(EffectKind::MeteorShower));
                taken += if shielded { amount * 0.5 } else { amount };
                true
            };
            let mut targets = [HitTarget {
                id: HitId::Player(0),
                w: crate::constants::PLAYER_W,
                h: crate::constants::PLAYER_H,
                pos: at + Vec2::new(dist, 0.0),
                vel: &mut vel,
                alive: true,
                apply_damage: &mut cb,
            }];
            MeteorShower::on_impact(&mut pr, &mut map, &mut targets, at, false, 1, 0.0);

            let base = METEOR_DAMAGE * (1.0 - dist / METEOR_CARVE_R);
            let expected = if shielded { base * 0.5 } else { base };
            assert!(
                (taken - expected).abs() < 0.5,
                "dist {dist} shielded {shielded}: took {taken}, expected {expected}"
            );
        }
    }

    /// §E13's roof rule, on the shower.
    ///
    /// The amendment asked toxic rain for it and observed the shower "also does
    /// not have it" — it did not, and a meteor landing on a cave roof dealt its
    /// full `METEOR_DAMAGE` through the rock to whoever was sheltering.
    ///
    /// The pair, on one map and one impact: two targets the same distance from
    /// the blast, one under the slab and one in the shaft beside it. A single
    /// sheltered target proves nothing — a blast that hurt nobody would pass it —
    /// so the exposed one is the control and it has to take the full number.
    #[test]
    fn a_roof_stops_a_meteor_and_the_player_beside_it_still_takes_the_hit() {
        // Solid everywhere, with one open shaft. The impact sits in the shaft,
        // and both targets sit at its mouth: same distance, different ceilings.
        let mut map = map_with_a_shaft(600, 640, 400);
        let mut pr = Projectiles::new();
        let at = Vec2::new(620.0, 300.0);

        let mut sheltered_vel = Vec2::ZERO;
        let mut exposed_vel = Vec2::ZERO;
        let mut sheltered = 0.0f32;
        let mut exposed = 0.0f32;
        {
            let mut a = |amount: f32, _s: DamageSource| {
                sheltered += amount;
                true
            };
            let mut b = |amount: f32, _s: DamageSource| {
                exposed += amount;
                true
            };
            let mut targets = [
                HitTarget {
                    id: HitId::Player(0),
                    w: crate::constants::PLAYER_W,
                    h: crate::constants::PLAYER_H,
                    // Just outside the shaft: rock overhead, well inside the blast.
                    pos: Vec2::new(590.0, 300.0),
                    vel: &mut sheltered_vel,
                    alive: true,
                    apply_damage: &mut a,
                },
                HitTarget {
                    id: HitId::Player(1),
                    w: crate::constants::PLAYER_W,
                    h: crate::constants::PLAYER_H,
                    // Inside it, the same distance the other way.
                    pos: Vec2::new(620.0, 330.0),
                    vel: &mut exposed_vel,
                    alive: true,
                    apply_damage: &mut b,
                },
            ];
            MeteorShower::on_impact(&mut pr, &mut map, &mut targets, at, false, 1, 0.0);
        }

        assert!(
            exposed > 0.0,
            "the control took nothing — the blast reached neither of them, so \
             'the roof protected the other one' is free"
        );
        assert_eq!(
            sheltered, 0.0,
            "a meteor dealt {sheltered} through solid rock to a player under a roof"
        );
    }

    #[test]
    fn an_impact_over_a_buried_slot_reveals_it() {
        let at = crate::math::Point::new(400, 300);
        let mut map = map_with_slot(at);
        let mut pr = Projectiles::new();
        let res = MeteorShower::on_impact(
            &mut pr,
            &mut map,
            &mut [],
            Vec2::new(at.x as f32, at.y as f32),
            false,
            1,
            0.0,
        );
        assert_eq!(res.0.carve.revealed, vec![0], "the slot it landed on");

        // And one that misses does not: the boundary, not just the happy path.
        let mut map = map_with_slot(at);
        let res = MeteorShower::on_impact(
            &mut pr,
            &mut map,
            &mut [],
            Vec2::new(at.x as f32 + METEOR_CARVE_R + 8.0, at.y as f32),
            false,
            1,
            0.0,
        );
        assert!(res.0.carve.revealed.is_empty(), "revealed a slot it missed");
    }

    #[test]
    fn the_same_seed_produces_the_same_shower() {
        let sample = || {
            let map = solid_map();
            let mut pr = Projectiles::new();
            let mut shower = MeteorShower::new(77, 0.0);
            let mut out = Vec::new();
            let ticks = (METEOR_DURATION / DT) as u32;
            for i in 0..ticks {
                for id in shower.tick(&mut pr, &map, true, i as f32 * DT) {
                    if let Some(p) = pr.get(id) {
                        out.push((p.pos.x.to_bits(), p.vel.x.to_bits()));
                    }
                }
            }
            out
        };
        let first = sample();
        assert!(!first.is_empty());
        for _ in 0..10 {
            assert_eq!(sample(), first);
        }
    }

    #[test]
    fn a_meteor_travels_through_the_shared_projectile_step() {
        // Not a bespoke integrator: it must fall, and it must not tunnel.
        let map = solid_map();
        let mut pr = Projectiles::new();
        let mut shower = MeteorShower::new(9, 0.0);
        shower.tick(&mut pr, &map, true, 0.0);
        let start = pr.iter().next().expect("no meteor").pos.y;
        let mut hit = None;
        for i in 1..600 {
            let now = i as f32 * DT;
            for im in pr.step(&map, &[], &[], 0.0, now, DT) {
                if let ProjectileOutcome::Exploded { at } = im.outcome {
                    hit = Some(at);
                }
            }
            if hit.is_some() {
                break;
            }
        }
        let at = hit.expect("meteor never landed");
        assert!(at.y > start, "did not fall");
        // The map is fully solid, so it must stop at the surface rather than
        // passing through it.
        assert!(at.y < 40.0, "tunnelled to y={}", at.y);
        let _ = Aabb::from_center_size(Vec2::ZERO, 1.0, 1.0);
    }
}
