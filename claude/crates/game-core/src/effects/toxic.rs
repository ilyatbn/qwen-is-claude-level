//! Toxic rain: area denial that leaves the map alone.
//!
//! This is the effect that does **not** carve. Denying space and reshaping the
//! map are different jobs, and giving this one terrain damage would make it a
//! weaker meteor shower (`docs/13-weather-effects.md` §3).
//!
//! ## It falls (§C21)
//!
//! Puddles used to be placed directly on a random point from
//! `MapMeta.surface_points`. A surface point is the top of the terrain column,
//! so on a map with caves — which is every map — a puddle could land on a cave
//! floor with a roof over it: rain that fell through solid rock.
//!
//! A drop is now a **projectile**. It leaves a cloud at `y = SKY_MARGIN` and
//! falls, and the puddle forms wherever it stops. That fixes the underground
//! case *by construction* rather than by filtering surface points — a drop
//! cannot reach a cave floor without an opening to fall through — and it makes
//! the rain visible for free, because the client draws every projectile
//! (§C4/§C22).
//!
//! What did not change: the puddle's radius, lifetime and damage, and the number
//! of drops per active window. Only where a puddle can appear.

use crate::constants::{
    SKY_MARGIN, TOXIC_DPS, TOXIC_DROP_SPEED, TOXIC_PUDDLE_EVERY, TOXIC_PUDDLE_LIFE,
    TOXIC_PUDDLE_RADIUS,
};
use crate::items::registry::{WeaponId, WEAPON_TOXIC_DROP};
use crate::map::Map;
use crate::math::Vec2;
use crate::rng::{range_f32, substream, ChaCha8Rng};
use crate::weapons::explode::{DamageSource, EffectKind, PlayerHitTarget};
use crate::weapons::projectile::{ProjectileId, Projectiles};

/// Share of puddles biased toward the half of the map the players are in.
/// Uniform placement on a large map wastes most of them on empty terrain and the
/// effect becomes something nobody notices.
const PLAYER_HALF_BIAS: f32 = 0.7;

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Puddle {
    pub id: u32,
    pub pos: Vec2,
    pub radius: f32,
    pub expires_at: f32,
}

pub struct ToxicRain {
    rng: ChaCha8Rng,
    puddles: Vec<Puddle>,
    /// `None` until the first **active** tick. See `tick`.
    next_spawn_at: Option<f32>,
    next_id: u32,
}

/// True when this projectile is a drop of rain this effect owns.
pub fn owns(weapon: WeaponId) -> bool {
    weapon == WEAPON_TOXIC_DROP
}

impl ToxicRain {
    pub fn new(seed: u64, _now: f32) -> Self {
        Self {
            rng: substream(seed, "toxic"),
            puddles: Vec::new(),
            // Set on the first ACTIVE tick, not here.
            //
            // An effect is constructed when it starts its TELEGRAPH and does not
            // release anything for `EFFECT_TELEGRAPH` (3 s) afterwards. Anchoring
            // the cadence at construction meant the first active tick ran
            // `while now >= next_spawn_at` against three seconds of missed
            // cadence and released **eight drops in one tick** to catch up — a
            // burst, then a normal cadence, and 28 drops in a window that is
            // supposed to hold 20. The unit tests never saw it because they pass
            // `active: true` from t=0, where there is no telegraph to skip.
            next_spawn_at: None,
            next_id: 0,
        }
    }

    /// Release drops on cadence, expire puddles, and damage whoever is standing
    /// in one.
    ///
    /// Returns the **drops** released this tick, so the caller can announce them
    /// as projectiles. Nothing lands here: a drop becomes a puddle in
    /// [`ToxicRain::land`], when the shared projectile step says it has stopped.
    pub fn tick(
        &mut self,
        projectiles: &mut Projectiles,
        map: &Map,
        players: &mut [PlayerHitTarget],
        active: bool,
        now: f32,
        dt: f32,
    ) -> Vec<ProjectileId> {
        let mut released = Vec::new();

        if active {
            // The first active tick is the first drop, and the cadence runs from
            // there.
            let mut next = self.next_spawn_at.unwrap_or(now);
            while now >= next {
                if let Some(x) = self.pick_column(map, players) {
                    // From the cloud, not from the ground. `SKY_MARGIN` is the
                    // guaranteed-empty band at the top of every map, so a drop
                    // always starts in open air.
                    released.push(projectiles.spawn_raw(
                        WEAPON_TOXIC_DROP,
                        // No owner: a puddle is attributed to the weather, and
                        // this id is never read as a player.
                        u8::MAX,
                        Vec2::new(x, SKY_MARGIN as f32),
                        Vec2::new(0.0, TOXIC_DROP_SPEED),
                        now,
                    ));
                }
                next += TOXIC_PUDDLE_EVERY;
            }
            self.next_spawn_at = Some(next);
        }

        self.puddles.retain(|p| now < p.expires_at);

        // Damage is per-tick, so crossing a puddle costs proportionally less than
        // standing in it. A player in two overlapping puddles takes double — dense
        // clusters are meant to be genuinely dangerous, so this is not deduplicated.
        for target in players.iter_mut() {
            if !target.alive {
                continue;
            }
            let aabb = crate::math::Aabb::from_center_size(
                target.pos,
                crate::constants::PLAYER_W,
                crate::constants::PLAYER_H,
            );
            for p in &self.puddles {
                if circle_overlaps_aabb(p.pos, p.radius, aabb) {
                    (target.apply_damage)(
                        TOXIC_DPS * dt,
                        DamageSource::Weather(EffectKind::ToxicRain),
                    );
                }
            }
        }

        released
    }

    /// A drop has stopped falling: leave a puddle where it stopped.
    ///
    /// Called from `World::detonate`, which intercepts this weapon before any
    /// blast — a drop of rain does not explode, and routing it through `explode`
    /// with a zero radius would be one refactor away from digging, which is the
    /// one thing `docs/13` §3 says toxic rain must never do.
    ///
    /// Lifetime runs from the landing, not from the release: the puddle is what
    /// has a lifetime, and a drop that fell further would otherwise get a shorter
    /// one purely for having had further to fall.
    pub fn land(&mut self, at: Vec2, now: f32) -> Puddle {
        let p = Puddle {
            id: self.next_id,
            pos: at,
            radius: TOXIC_PUDDLE_RADIUS,
            expires_at: now + TOXIC_PUDDLE_LIFE,
        };
        self.next_id += 1;
        self.puddles.push(p);
        p
    }

    pub fn puddles(&self) -> &[Puddle] {
        &self.puddles
    }

    /// Which column to release a drop over, biased toward the half of the map
    /// the players occupy.
    ///
    /// Only the **x** is taken from the surface point now. The y was the bug:
    /// a surface point is the top of a terrain column, and dropping a puddle
    /// straight onto one put it inside any cave that happened to be under it.
    /// The drop falls from the cloud and finds its own y.
    fn pick_column(&mut self, map: &Map, players: &[PlayerHitTarget]) -> Option<f32> {
        let pts = &map.meta.surface_points;
        if pts.is_empty() {
            return None;
        }

        let living: Vec<f32> = players
            .iter()
            .filter(|p| p.alive)
            .map(|p| p.pos.x)
            .collect();
        let mid = map.mask.w as f32 / 2.0;
        let want_left = if living.is_empty() {
            None
        } else {
            let mean = living.iter().sum::<f32>() / living.len() as f32;
            Some(mean < mid)
        };

        let biased = want_left.is_some() && range_f32(&mut self.rng, 0.0, 1.0) < PLAYER_HALF_BIAS;
        if biased {
            let left = want_left.unwrap_or(true);
            // One filtered pass, then a uniform draw from it. Rejection sampling
            // would be unbounded when every surface point is in the other half.
            let candidates: Vec<usize> = (0..pts.len())
                .filter(|&i| ((pts[i].x as f32) < mid) == left)
                .collect();
            if !candidates.is_empty() {
                let i = candidates
                    [crate::rng::range_u32(&mut self.rng, 0, candidates.len() as u32 - 1) as usize];
                return Some(pts[i].x as f32);
            }
        }
        let i = crate::rng::range_u32(&mut self.rng, 0, pts.len() as u32 - 1) as usize;
        Some(pts[i].x as f32)
    }
}

/// Closest-point test. A player exactly on the boundary **is** hit: `<=`, so a
/// puddle's stated radius is the radius that damages you.
fn circle_overlaps_aabb(c: Vec2, r: f32, b: crate::math::Aabb) -> bool {
    let (mn, mx) = (b.min(), b.max());
    let nx = c.x.clamp(mn.x, mx.x);
    let ny = c.y.clamp(mn.y, mx.y);
    let (dx, dy) = (c.x - nx, c.y - ny);
    dx * dx + dy * dy <= r * r
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, TOXIC_DURATION};
    use crate::map::generate;
    use crate::math::Vec2;

    const DT: f32 = 1.0 / 60.0;

    /// A player harness that records damage the way `PlayerState` would apply it.
    struct Dummy {
        pos: Vec2,
        vel: Vec2,
        alive: bool,
        health: f32,
        shielded: bool,
        iframes: bool,
    }

    impl Dummy {
        fn new(pos: Vec2) -> Self {
            Self {
                pos,
                vel: Vec2::ZERO,
                alive: true,
                health: 1000.0,
                shielded: false,
                iframes: false,
            }
        }
    }

    /// Build the borrow-checker-friendly view the effects take.
    fn targets(ds: &mut [Dummy]) -> Vec<PlayerHitTarget<'_>> {
        ds.iter_mut()
            .enumerate()
            .map(|(i, d)| {
                let shielded = d.shielded;
                let iframes = d.iframes;
                let health = &mut d.health;
                PlayerHitTarget {
                    id: i as u8,
                    pos: d.pos,
                    vel: &mut d.vel,
                    alive: d.alive,
                    apply_damage: Box::leak(Box::new(move |amount: f32, _s: DamageSource| {
                        if iframes {
                            return false;
                        }
                        *health -= if shielded { amount * 0.5 } else { amount };
                        true
                    })),
                }
            })
            .collect()
    }

    /// Run the effect for `seconds`, returning how many **drops** it released.
    fn run(rain: &mut ToxicRain, map: &Map, ds: &mut [Dummy], seconds: f32, from: f32) -> usize {
        let mut pr = Projectiles::new();
        let mut released = 0;
        let ticks = (seconds / DT) as u32;
        for i in 0..ticks {
            let now = from + i as f32 * DT;
            let mut t = targets(ds);
            released += rain.tick(&mut pr, map, &mut t, true, now, DT).len();
        }
        released
    }

    #[test]
    fn a_full_active_window_releases_exactly_duration_over_cadence_drops() {
        let map = generate(4242, MapScale::Small);
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(100.0, 100.0))];
        let n = run(&mut rain, &map, &mut ds, TOXIC_DURATION, 0.0);
        assert_eq!(
            n,
            (TOXIC_DURATION / TOXIC_PUDDLE_EVERY) as usize,
            "{n} drops"
        );
    }

    #[test]
    fn nothing_is_released_while_inactive() {
        let map = generate(4242, MapScale::Small);
        let mut pr = Projectiles::new();
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(100.0, 100.0))];
        for i in 0..600 {
            let mut t = targets(&mut ds);
            assert!(rain
                .tick(&mut pr, &map, &mut t, false, i as f32 * DT, DT)
                .is_empty());
        }
        assert!(rain.puddles().is_empty());
        assert_eq!(pr.len(), 0, "an inactive effect put drops in the air");
    }

    /// Every drop leaves the **cloud**, in open sky.
    ///
    /// The control for the cave test below: if drops were released at ground
    /// level, "no puddle under a roof" would hold for reasons that have nothing
    /// to do with falling.
    #[test]
    fn every_drop_is_released_from_the_sky_and_falls() {
        let map = generate(4242, MapScale::Small);
        let mut pr = Projectiles::new();
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(100.0, 100.0))];
        let ticks = (TOXIC_DURATION / DT) as u32;
        let mut seen = 0;
        for i in 0..ticks {
            let mut t = targets(&mut ds);
            for id in rain.tick(&mut pr, &map, &mut t, true, i as f32 * DT, DT) {
                let d = pr.get(id).expect("just released");
                assert_eq!(
                    d.pos.y,
                    crate::constants::SKY_MARGIN as f32,
                    "a drop did not start at the cloud"
                );
                assert!(d.vel.y > 0.0, "a drop was released with no downward speed");
                seen += 1;
            }
        }
        assert!(seen > 0, "no drops at all");
    }

    #[test]
    fn a_puddle_expires_exactly_one_lifetime_after_landing() {
        let mut rain = ToxicRain::new(1, 0.0);
        let map = generate(4242, MapScale::Small);
        let mut ds = vec![Dummy::new(Vec2::new(-9999.0, -9999.0))];
        let mut pr = Projectiles::new();

        rain.land(Vec2::new(500.0, 500.0), 0.0);
        assert_eq!(rain.puddles().len(), 1);

        // Just before, and just after.
        let mut t = targets(&mut ds);
        rain.tick(&mut pr, &map, &mut t, false, TOXIC_PUDDLE_LIFE - DT, DT);
        drop(t);
        assert_eq!(rain.puddles().len(), 1, "expired early");

        let mut t = targets(&mut ds);
        rain.tick(&mut pr, &map, &mut t, false, TOXIC_PUDDLE_LIFE, DT);
        drop(t);
        assert!(rain.puddles().is_empty(), "outlived TOXIC_PUDDLE_LIFE");
    }

    #[test]
    fn standing_in_a_puddle_for_its_whole_life_costs_dps_times_life() {
        let map = generate(4242, MapScale::Small);
        let mut pr = Projectiles::new();
        let mut rain = ToxicRain::new(1, 0.0);
        let at = Vec2::new(500.0, 500.0);
        let mut ds = vec![Dummy::new(at)];
        rain.land(at, 0.0);

        // Damage is charged per tick from the tick after it lands, so the run
        // starts at DT.
        let ticks = (TOXIC_PUDDLE_LIFE / DT) as u32;
        for i in 1..=ticks {
            let mut t = targets(&mut ds);
            rain.tick(&mut pr, &map, &mut t, false, i as f32 * DT, DT);
        }
        let lost = 1000.0 - ds[0].health;
        let expected = TOXIC_DPS * TOXIC_PUDDLE_LIFE;
        assert!(
            (lost - expected).abs() <= TOXIC_DPS * DT * 3.0,
            "lost {lost}, expected {expected}"
        );
    }

    #[test]
    fn a_player_outside_the_radius_takes_nothing() {
        let map = generate(4242, MapScale::Small);
        let mut pr = Projectiles::new();
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(-5000.0, -5000.0))];
        rain.land(Vec2::new(500.0, 500.0), 0.0);
        for i in 1..60 {
            let mut t = targets(&mut ds);
            rain.tick(&mut pr, &map, &mut t, false, i as f32 * DT, DT);
        }
        assert_eq!(ds[0].health, 1000.0);
    }

    #[test]
    fn overlapping_puddles_stack() {
        // Two puddles at the same point deal double.
        let map = generate(4242, MapScale::Small);
        let mut pr = Projectiles::new();
        let at = Vec2::new(500.0, 500.0);

        let mut rain = ToxicRain::new(1, 0.0);
        rain.land(at, 0.0);
        let mut one = vec![Dummy::new(at)];
        let mut t = targets(&mut one);
        rain.tick(&mut pr, &map, &mut t, false, DT, DT);
        drop(t);
        let single = 1000.0 - one[0].health;

        rain.land(at, 0.0);
        let mut two = vec![Dummy::new(at)];
        let mut t = targets(&mut two);
        rain.tick(&mut pr, &map, &mut t, false, DT, DT);
        drop(t);
        let double = 1000.0 - two[0].health;

        assert!(single > 0.0);
        assert!(
            (double - 2.0 * single).abs() < 1e-4,
            "one puddle {single}, two {double}"
        );
    }

    #[test]
    fn a_shielded_player_takes_half_and_iframes_take_none() {
        let map = generate(4242, MapScale::Small);
        let mut pr = Projectiles::new();
        let at = Vec2::new(500.0, 500.0);
        let make = || {
            let mut r = ToxicRain::new(1, 0.0);
            r.land(at, 0.0);
            r
        };

        let mut plain = vec![Dummy::new(at)];
        let mut t = targets(&mut plain);
        make().tick(&mut pr, &map, &mut t, false, DT, DT);
        drop(t);

        let mut shielded = vec![Dummy::new(at)];
        shielded[0].shielded = true;
        let mut t = targets(&mut shielded);
        make().tick(&mut pr, &map, &mut t, false, DT, DT);
        drop(t);

        let mut iframed = vec![Dummy::new(at)];
        iframed[0].iframes = true;
        let mut t = targets(&mut iframed);
        make().tick(&mut pr, &map, &mut t, false, DT, DT);
        drop(t);

        let full = 1000.0 - plain[0].health;
        assert!(full > 0.0);
        assert!((1000.0 - shielded[0].health - full / 2.0).abs() < 1e-4);
        assert_eq!(iframed[0].health, 1000.0);
    }

    #[test]
    fn drops_are_biased_toward_the_players_half() {
        let map = generate(4242, MapScale::Small);
        let mut pr = Projectiles::new();
        let mid = map.mask.w as f32 / 2.0;
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(mid * 0.2, 500.0))];

        let mut xs = Vec::new();
        let ticks = (100.0 / DT) as u32;
        for i in 0..ticks {
            let mut t = targets(&mut ds);
            for id in rain.tick(&mut pr, &map, &mut t, true, i as f32 * DT, DT) {
                xs.push(pr.get(id).expect("just released").pos.x);
            }
        }
        assert!(xs.len() > 200, "only {} drops", xs.len());
        let mean = xs.iter().sum::<f32>() / xs.len() as f32;
        assert!(mean < mid, "mean drop x {mean} vs midpoint {mid}");

        // And the bias is measurable, not marginal: most fall on the players' side.
        let left = xs.iter().filter(|&&x| x < mid).count() as f32 / xs.len() as f32;
        assert!(left > 0.6, "only {:.2} of drops on the players' half", left);
    }

    #[test]
    fn the_same_seed_produces_the_same_rain() {
        let map = generate(4242, MapScale::Small);
        let sample = || {
            let mut pr = Projectiles::new();
            let mut rain = ToxicRain::new(77, 0.0);
            let mut ds = vec![Dummy::new(Vec2::new(300.0, 500.0))];
            let mut out = Vec::new();
            let ticks = (TOXIC_DURATION / DT) as u32;
            for i in 0..ticks {
                let mut t = targets(&mut ds);
                for id in rain.tick(&mut pr, &map, &mut t, true, i as f32 * DT, DT) {
                    let d = pr.get(id).expect("just released");
                    out.push((d.pos.x.to_bits(), d.pos.y.to_bits()));
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
}
