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
use crate::weapons::explode::{explode, BlastSource, EffectKind, ExplosionResult, PlayerHitTarget};
use crate::weapons::projectile::{ProjectileId, Projectiles};

/// Meteors spawn above the map and fall in.
const SPAWN_Y: f32 = -32.0;
/// A little lateral drift so they do not all fall in perfect verticals.
const LATERAL_MAX: f32 = 60.0;

pub struct MeteorShower {
    rng: ChaCha8Rng,
    next_spawn_at: f32,
}

impl MeteorShower {
    pub fn new(seed: u64, now: f32) -> Self {
        Self {
            rng: substream(seed, "meteor"),
            // First meteor on the first active tick, as with toxic rain: it puts
            // exactly duration/cadence impacts inside the active window.
            next_spawn_at: now,
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
        while now >= self.next_spawn_at {
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
            self.next_spawn_at += METEOR_EVERY;
        }
        out
    }

    /// Resolve an impact: carve, damage, and (for a meteor, never a fragment)
    /// throw fragments.
    ///
    /// `is_fragment` is the entire recursion guard. Six fragments each spawning
    /// six is 36, then 216: the tick stops terminating in about four generations.
    pub fn on_impact(
        projectiles: &mut Projectiles,
        map: &mut Map,
        players: &mut [PlayerHitTarget],
        at: Vec2,
        is_fragment: bool,
        seed: u64,
        now: f32,
    ) -> ExplosionResult {
        let (radius, damage) = if is_fragment {
            (METEOR_FRAG_CARVE_R, METEOR_FRAG_DAMAGE)
        } else {
            (METEOR_CARVE_R, METEOR_DAMAGE)
        };

        let result = explode(
            map,
            players,
            at,
            radius,
            damage,
            BlastSource::Weather(EffectKind::MeteorShower),
        );

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
                projectiles.spawn_raw(
                    WEAPON_METEOR_FRAG,
                    u8::MAX,
                    at,
                    Vec2::new(a.cos() * speed, a.sin() * speed),
                    now,
                );
            }
        }

        result
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
            surface_points: Vec::new(),
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
            let kinds: Vec<(ProjectileId, bool)> = pr
                .iter()
                .map(|p| (p.id, MeteorShower::is_fragment(p.weapon)))
                .collect();

            for (id, outcome) in pr.step(&map, &[], 0.0, now, DT) {
                let at = match outcome {
                    ProjectileOutcome::Exploded { at } => at,
                    ProjectileOutcome::HitPlayer { at, .. } => at,
                    ProjectileOutcome::Alive => continue,
                };
                let is_frag = kinds
                    .iter()
                    .find(|(pid, _)| *pid == id)
                    .map(|(_, f)| *f)
                    .unwrap_or(true);
                let before = pr.len();
                MeteorShower::on_impact(&mut pr, &mut map, &mut [], at, is_frag, id as u64, now);
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
        assert!(res.carve.pixels_removed > 0);
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
            let mut map = solid_map();
            let mut pr = Projectiles::new();
            let at = Vec2::new(600.0, 300.0);
            let mut vel = Vec2::ZERO;
            let mut taken = 0.0f32;
            let mut cb = |amount: f32, s: DamageSource| {
                assert_eq!(s, DamageSource::Weather(EffectKind::MeteorShower));
                taken += if shielded { amount * 0.5 } else { amount };
                true
            };
            let mut targets = [PlayerHitTarget {
                id: 0,
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
        assert_eq!(res.carve.revealed, vec![0], "the slot it landed on");

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
        assert!(res.carve.revealed.is_empty(), "revealed a slot it missed");
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
            for (_, o) in pr.step(&map, &[], 0.0, now, DT) {
                if let ProjectileOutcome::Exploded { at } = o {
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
