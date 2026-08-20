//! Toxic rain: area denial that leaves the map alone.
//!
//! This is the effect that does **not** carve. Denying space and reshaping the
//! map are different jobs, and giving this one terrain damage would make it a
//! weaker meteor shower (`docs/13-weather-effects.md` §3).

use crate::constants::{TOXIC_DPS, TOXIC_PUDDLE_EVERY, TOXIC_PUDDLE_LIFE, TOXIC_PUDDLE_RADIUS};
use crate::map::Map;
use crate::math::Vec2;
use crate::rng::{range_f32, substream, ChaCha8Rng};
use crate::weapons::explode::{DamageSource, EffectKind, PlayerHitTarget};

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
    next_spawn_at: f32,
    next_id: u32,
}

impl ToxicRain {
    pub fn new(seed: u64, now: f32) -> Self {
        Self {
            rng: substream(seed, "toxic"),
            puddles: Vec::new(),
            // The first puddle lands on the first active tick, not one cadence
            // in. That puts exactly `duration / cadence` spawns inside the active
            // window [0, duration); waiting a cadence first would push the last
            // one to exactly `duration`, i.e. outside it.
            next_spawn_at: now,
            next_id: 0,
        }
    }

    /// Spawn on cadence, expire, and damage. Returns the puddles spawned this
    /// tick so the caller can broadcast them — clients never roll their own
    /// (`docs/13-weather-effects.md` §7).
    pub fn tick(
        &mut self,
        map: &Map,
        players: &mut [PlayerHitTarget],
        active: bool,
        now: f32,
        dt: f32,
    ) -> Vec<Puddle> {
        let mut spawned = Vec::new();

        if active {
            while now >= self.next_spawn_at {
                if let Some(pos) = self.pick_position(map, players) {
                    let p = Puddle {
                        id: self.next_id,
                        pos,
                        radius: TOXIC_PUDDLE_RADIUS,
                        expires_at: self.next_spawn_at + TOXIC_PUDDLE_LIFE,
                        // Expiry is measured from the SCHEDULED spawn time, not
                        // from `now`, for the same anti-drift reason the scheduler
                        // advances `next_at` from the schedule.
                    };
                    self.puddles.push(p);
                    spawned.push(p);
                    self.next_id += 1;
                }
                self.next_spawn_at += TOXIC_PUDDLE_EVERY;
            }
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

        spawned
    }

    pub fn puddles(&self) -> &[Puddle] {
        &self.puddles
    }

    /// A surface point, biased toward the half of the map the players occupy.
    fn pick_position(&mut self, map: &Map, players: &[PlayerHitTarget]) -> Option<Vec2> {
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
                return Some(Vec2::new(pts[i].x as f32, pts[i].y as f32));
            }
        }
        let i = crate::rng::range_u32(&mut self.rng, 0, pts.len() as u32 - 1) as usize;
        Some(Vec2::new(pts[i].x as f32, pts[i].y as f32))
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

    fn run(rain: &mut ToxicRain, map: &Map, ds: &mut [Dummy], seconds: f32, from: f32) -> usize {
        let mut spawned = 0;
        let ticks = (seconds / DT) as u32;
        for i in 0..ticks {
            let now = from + i as f32 * DT;
            let mut t = targets(ds);
            spawned += rain.tick(map, &mut t, true, now, DT).len();
        }
        spawned
    }

    #[test]
    fn a_full_active_window_spawns_exactly_duration_over_cadence_puddles() {
        let map = generate(4242, MapScale::Small);
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(100.0, 100.0))];
        let n = run(&mut rain, &map, &mut ds, TOXIC_DURATION, 0.0);
        assert_eq!(
            n,
            (TOXIC_DURATION / TOXIC_PUDDLE_EVERY) as usize,
            "{n} puddles"
        );
    }

    #[test]
    fn nothing_spawns_while_inactive() {
        let map = generate(4242, MapScale::Small);
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(100.0, 100.0))];
        for i in 0..600 {
            let mut t = targets(&mut ds);
            assert!(rain.tick(&map, &mut t, false, i as f32 * DT, DT).is_empty());
        }
        assert!(rain.puddles().is_empty());
    }

    #[test]
    fn a_puddle_expires_exactly_one_lifetime_after_spawning() {
        let map = generate(4242, MapScale::Small);
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(-9999.0, -9999.0))];

        let mut spawn_time = None;
        let mut gone_time = None;
        let ticks = ((TOXIC_PUDDLE_LIFE + 2.0) / DT) as u32;
        for i in 0..ticks {
            let now = i as f32 * DT;
            let mut t = targets(&mut ds);
            // Active only long enough for one puddle: `active` goes false as soon
            // as the first has landed, so the list empties exactly once.
            let new = rain.tick(&map, &mut t, spawn_time.is_none(), now, DT);
            drop(t);
            if !new.is_empty() && spawn_time.is_none() {
                spawn_time = Some(now);
            } else if spawn_time.is_some() && rain.puddles().is_empty() && gone_time.is_none() {
                gone_time = Some(now);
            }
        }
        let s = spawn_time.expect("no puddle spawned");
        let g = gone_time.expect("puddle never expired");
        assert!(
            (g - s - TOXIC_PUDDLE_LIFE).abs() <= 2.0 * DT,
            "lived {} s, expected {TOXIC_PUDDLE_LIFE}",
            g - s
        );
    }

    #[test]
    fn standing_in_a_puddle_for_its_whole_life_costs_dps_times_life() {
        let map = generate(4242, MapScale::Small);
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(-9999.0, -9999.0))];

        // Move the player onto whichever puddle actually spawns, rather than
        // predicting it: `pick_position` reads player positions, so a second run
        // with the player somewhere else does not reproduce the first run's
        // placement. Chasing that cost this test one debugging round.
        let ticks = ((TOXIC_PUDDLE_LIFE + 1.0) / DT) as u32;
        let mut moved = false;
        for i in 0..ticks {
            let now = i as f32 * DT;
            let mut t = targets(&mut ds);
            // Only the first puddle: stop spawning immediately after it lands.
            let new = rain.tick(&map, &mut t, !moved, now, DT);
            drop(t);
            if let Some(p) = new.first() {
                ds[0].pos = p.pos;
                ds[0].health = 1000.0; // discount the tick it spawned on
                moved = true;
            }
        }
        assert!(moved, "no puddle spawned");
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
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(-5000.0, -5000.0))];
        run(&mut rain, &map, &mut ds, TOXIC_DURATION, 0.0);
        assert_eq!(ds[0].health, 1000.0);
    }

    #[test]
    fn overlapping_puddles_stack() {
        // Two puddles at the same point deal double. Built directly rather than
        // waiting for the RNG to place two on top of each other.
        let map = generate(4242, MapScale::Small);
        let mut rain = ToxicRain::new(1, 0.0);
        let at = Vec2::new(500.0, 500.0);
        rain.puddles.push(Puddle {
            id: 100,
            pos: at,
            radius: TOXIC_PUDDLE_RADIUS,
            expires_at: 1000.0,
        });
        let mut one = vec![Dummy::new(at)];
        let mut t = targets(&mut one);
        rain.tick(&map, &mut t, false, 0.0, DT);
        drop(t);
        let single = 1000.0 - one[0].health;

        rain.puddles.push(Puddle {
            id: 101,
            pos: at,
            radius: TOXIC_PUDDLE_RADIUS,
            expires_at: 1000.0,
        });
        let mut two = vec![Dummy::new(at)];
        let mut t = targets(&mut two);
        rain.tick(&map, &mut t, false, 0.0, DT);
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
        let at = Vec2::new(500.0, 500.0);
        let make = || {
            let mut r = ToxicRain::new(1, 0.0);
            r.puddles.push(Puddle {
                id: 1,
                pos: at,
                radius: TOXIC_PUDDLE_RADIUS,
                expires_at: 1000.0,
            });
            r
        };

        let mut plain = vec![Dummy::new(at)];
        let mut t = targets(&mut plain);
        make().tick(&map, &mut t, false, 0.0, DT);
        drop(t);

        let mut shielded = vec![Dummy::new(at)];
        shielded[0].shielded = true;
        let mut t = targets(&mut shielded);
        make().tick(&map, &mut t, false, 0.0, DT);
        drop(t);

        let mut iframed = vec![Dummy::new(at)];
        iframed[0].iframes = true;
        let mut t = targets(&mut iframed);
        make().tick(&map, &mut t, false, 0.0, DT);
        drop(t);

        let full = 1000.0 - plain[0].health;
        assert!(full > 0.0);
        assert!((1000.0 - shielded[0].health - full / 2.0).abs() < 1e-4);
        assert_eq!(iframed[0].health, 1000.0);
    }

    #[test]
    fn the_mask_is_untouched_by_a_full_toxic_rain() {
        // The defining property of this effect: it denies space, it does not
        // reshape the map.
        let map = generate(4242, MapScale::Small);
        let before = map.mask.count_solid();
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(500.0, 500.0))];
        run(&mut rain, &map, &mut ds, TOXIC_DURATION, 0.0);
        assert_eq!(map.mask.count_solid(), before);
    }

    #[test]
    fn puddles_are_biased_toward_the_players_half() {
        let map = generate(4242, MapScale::Small);
        let mid = map.mask.w as f32 / 2.0;
        let mut rain = ToxicRain::new(1, 0.0);
        let mut ds = vec![Dummy::new(Vec2::new(mid * 0.2, 500.0))];

        let mut xs = Vec::new();
        let ticks = (100.0 / DT) as u32;
        for i in 0..ticks {
            let mut t = targets(&mut ds);
            for p in rain.tick(&map, &mut t, true, i as f32 * DT, DT) {
                xs.push(p.pos.x);
            }
        }
        assert!(xs.len() > 200, "only {} puddles", xs.len());
        let mean = xs.iter().sum::<f32>() / xs.len() as f32;
        assert!(mean < mid, "mean puddle x {mean} vs midpoint {mid}");

        // And the bias is measurable, not marginal: most land on the players' side.
        let left = xs.iter().filter(|&&x| x < mid).count() as f32 / xs.len() as f32;
        assert!(
            left > 0.6,
            "only {:.2} of puddles on the players' half",
            left
        );
    }

    #[test]
    fn the_same_seed_produces_the_same_puddles() {
        let map = generate(4242, MapScale::Small);
        let sample = || {
            let mut rain = ToxicRain::new(77, 0.0);
            let mut ds = vec![Dummy::new(Vec2::new(300.0, 500.0))];
            let mut out = Vec::new();
            let ticks = (TOXIC_DURATION / DT) as u32;
            for i in 0..ticks {
                let mut t = targets(&mut ds);
                for p in rain.tick(&map, &mut t, true, i as f32 * DT, DT) {
                    out.push((p.id, p.pos.x, p.pos.y, p.expires_at));
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
