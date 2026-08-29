//! Toxic rain: falling drops that poison what they hit.
//!
//! This is the effect that barely touches the map. Denying space and reshaping
//! it are different jobs, and giving this one a meteor's crater would make it a
//! weaker meteor shower (`docs/13-weather-effects.md` §3) — so a drop takes a
//! `TOXIC_DROP_CARVE_R` bite, the size a bullet makes, and nothing more.
//!
//! ## It falls (§C21)
//!
//! A drop is a **projectile**. It leaves a cloud at `y = SKY_MARGIN` and falls,
//! and whatever it reaches is what it affects. Rain that fell through solid rock
//! is impossible by construction rather than by filtering, and the rain is
//! visible for free, because the client draws every projectile (§C4/§C22).
//!
//! ## It poisons (§E13)
//!
//! Puddles are gone. Nobody ever saw one: a 40 px disc that lived three seconds
//! on a map thousands of pixels wide, placed where no player had any reason to
//! be. What a drop does now is land on someone — `TOXIC_POISON_DURATION` of
//! `TOXIC_POISON_DPS`, **replacing** any poison already running rather than
//! stacking with it.
//!
//! The poison itself is `PlayerState`'s, not this module's. A status that
//! outlives the weather that caused it cannot be owned by an effect the
//! scheduler is free to drop at any moment — the rain ends at a fixed time and
//! the poison it left has up to three seconds still to run.

use crate::constants::{SKY_MARGIN, TOXIC_DROP_EVERY, TOXIC_DROP_SPEED};
use crate::items::registry::{WeaponId, WEAPON_TOXIC_DROP};
use crate::map::Map;
use crate::math::Vec2;
use crate::rng::{range_f32, substream, ChaCha8Rng};
use crate::weapons::projectile::{ProjectileId, Projectiles};

/// Share of drops biased toward the half of the map the players are in.
/// Uniform placement on a large map wastes most of them on empty terrain and the
/// effect becomes something nobody notices.
const PLAYER_HALF_BIAS: f32 = 0.7;

pub struct ToxicRain {
    rng: ChaCha8Rng,
    /// `None` until the first **active** tick. See `tick`.
    next_spawn_at: Option<f32>,
}

/// True when this projectile is a drop of rain this effect owns.
pub fn owns(weapon: WeaponId) -> bool {
    weapon == WEAPON_TOXIC_DROP
}

impl ToxicRain {
    pub fn new(seed: u64, _now: f32) -> Self {
        Self {
            rng: substream(seed, "toxic"),
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
        }
    }

    /// Release drops on cadence.
    ///
    /// Returns the **drops** released this tick, so the caller can announce them
    /// as projectiles. Nothing lands here and nothing is damaged here: a drop is
    /// resolved where every other projectile is, when the shared step reports it
    /// hit something.
    ///
    /// `living_x` is every **living player's** x, and it is all this needs: the
    /// only thing the rain asks about players is which half of the map to favour.
    /// It used to take the full `HitTarget` slice, which since §C16 also holds
    /// birds — so the bias was being pulled toward whatever the flock was doing.
    /// Take what the caller needs, and nothing it has to construct for you.
    pub fn tick(
        &mut self,
        projectiles: &mut Projectiles,
        map: &Map,
        living_x: &[f32],
        active: bool,
        now: f32,
    ) -> Vec<ProjectileId> {
        let mut released = Vec::new();

        if active {
            // The first active tick is the first drop, and the cadence runs from
            // there.
            let mut next = self.next_spawn_at.unwrap_or(now);
            while now >= next {
                if let Some(x) = self.pick_column(map, living_x) {
                    // From the cloud, not from the ground. `SKY_MARGIN` is the
                    // guaranteed-empty band at the top of every map, so a drop
                    // always starts in open air.
                    released.push(projectiles.spawn_raw(
                        WEAPON_TOXIC_DROP,
                        // No owner: a drop is attributed to the weather, and
                        // this id is never read as a player.
                        u8::MAX,
                        Vec2::new(x, SKY_MARGIN as f32),
                        Vec2::new(0.0, TOXIC_DROP_SPEED),
                        now,
                    ));
                }
                next += TOXIC_DROP_EVERY;
            }
            self.next_spawn_at = Some(next);
        }

        released
    }

    /// Which column to release a drop over, biased toward the half of the map
    /// the players occupy.
    ///
    /// Only the **x** is taken from the surface point. The y was the bug the
    /// projectile fixed: a surface point is the top of a terrain column, and
    /// placing the hazard straight onto one put it inside any cave that happened
    /// to be under it. The drop falls from the cloud and finds its own y.
    fn pick_column(&mut self, map: &Map, living_x: &[f32]) -> Option<f32> {
        let pts = &map.meta.surface_points;
        if pts.is_empty() {
            return None;
        }

        let mid = map.mask.w as f32 / 2.0;
        let want_left = if living_x.is_empty() {
            None
        } else {
            let mean = living_x.iter().sum::<f32>() / living_x.len() as f32;
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

/// Does a drop that reached `victim` actually poison them (§E13)?
///
/// **The roof rule, at the one site that decides.** A drop falls, so terrain
/// normally stops it long before this is asked — but drops drift on the wind
/// (`wind_scale` 1.0, the one weather projectile where drift is a feature), and
/// a drop that slid in through a cave mouth can reach a player who has solid
/// rock over their head. §E13 says that player is not poisoned, and this is
/// where that is decided. The same question, asked by the same function, keeps a
/// meteor's blast out of a sealed cave.
///
/// Position, not the whole `HitTarget`: the caller has a `PlayerId` from the
/// projectile outcome and a `&mut Map`, and asking this for a borrow it would
/// otherwise have to arrange is how a guard ends up copied instead of called.
pub fn poison_lands(map: &Map, victim: Vec2) -> bool {
    !crate::effects::under_a_roof(map, victim)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, TOXIC_DURATION};
    use crate::map::meta::MapMeta;
    use crate::map::{generate, CoarseGrid, Mask};
    use crate::math::Vec2;

    const DT: f32 = 1.0 / 60.0;

    /// Run the effect for `seconds`, returning how many **drops** it released.
    fn run(rain: &mut ToxicRain, map: &Map, living: &[f32], seconds: f32, from: f32) -> usize {
        let mut pr = Projectiles::new();
        let mut released = 0;
        let ticks = (seconds / DT) as u32;
        for i in 0..ticks {
            let now = from + i as f32 * DT;
            released += rain.tick(&mut pr, map, living, true, now).len();
        }
        released
    }

    #[test]
    fn a_full_active_window_releases_exactly_duration_over_cadence_drops() {
        let map = generate(4242, MapScale::Small);
        let mut rain = ToxicRain::new(1, 0.0);
        let n = run(&mut rain, &map, &[100.0], TOXIC_DURATION, 0.0);
        assert_eq!(n, (TOXIC_DURATION / TOXIC_DROP_EVERY) as usize, "{n} drops");
    }

    #[test]
    fn nothing_is_released_while_inactive() {
        let map = generate(4242, MapScale::Small);
        let mut pr = Projectiles::new();
        let mut rain = ToxicRain::new(1, 0.0);
        for i in 0..600 {
            assert!(rain
                .tick(&mut pr, &map, &[100.0], false, i as f32 * DT)
                .is_empty());
        }
        assert_eq!(pr.len(), 0, "an inactive effect put drops in the air");
    }

    /// Every drop leaves the **cloud**, in open sky.
    ///
    /// The control for every roof claim downstream: if drops were released at
    /// ground level, "nothing lands under a roof" would hold for reasons that
    /// have nothing to do with falling.
    #[test]
    fn every_drop_is_released_from_the_sky_and_falls() {
        let map = generate(4242, MapScale::Small);
        let mut pr = Projectiles::new();
        let mut rain = ToxicRain::new(1, 0.0);
        let ticks = (TOXIC_DURATION / DT) as u32;
        let mut seen = 0;
        for i in 0..ticks {
            for id in rain.tick(&mut pr, &map, &[100.0], true, i as f32 * DT) {
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

    fn slab_map(roof: Option<(i32, i32)>) -> Map {
        let mut mask = Mask::new_empty(256, 256);
        if let Some((x0, x1)) = roof {
            for y in 40..52 {
                mask.set_run(y, x0, x1);
            }
        }
        let coarse = CoarseGrid::build(&mask);
        let meta = MapMeta {
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
        };
        Map::from_parts(mask, coarse, meta)
    }

    /// §E13's roof rule, at the function `World::detonate` calls.
    ///
    /// The pair, on one point: the same coordinates under a slab and under open
    /// sky. Either half alone passes for a function that always answers the same
    /// way, and "the roof protected them" is exactly the absence claim that needs
    /// its presence control.
    #[test]
    fn a_roof_stops_the_poison_and_open_sky_does_not() {
        let under = Vec2::new(128.0, 100.0);
        assert!(
            !poison_lands(&slab_map(Some((0, 255))), under),
            "a drop poisoned a player through twelve pixels of rock"
        );
        assert!(
            poison_lands(&slab_map(None), under),
            "a drop under open sky poisoned nobody — the rule refuses everything"
        );
    }

    /// The gap is what makes the rule about *this* player rather than about the
    /// map: rain reaches the floor of a cave through its mouth, and the column
    /// is what decides which floor.
    #[test]
    fn a_player_beside_the_roof_is_still_poisoned() {
        let m = slab_map(Some((0, 99)));
        assert!(!poison_lands(&m, Vec2::new(50.0, 100.0)), "under the slab");
        assert!(poison_lands(&m, Vec2::new(150.0, 100.0)), "beside it");
    }

    #[test]
    fn drops_are_biased_toward_the_players_half() {
        let map = generate(4242, MapScale::Small);
        let mut pr = Projectiles::new();
        let mid = map.mask.w as f32 / 2.0;
        let mut rain = ToxicRain::new(1, 0.0);

        let mut xs = Vec::new();
        let ticks = (100.0 / DT) as u32;
        for i in 0..ticks {
            for id in rain.tick(&mut pr, &map, &[mid * 0.2], true, i as f32 * DT) {
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

    /// No players, no bias, and no panic: an empty living set is the state
    /// between a wipe and the respawns.
    #[test]
    fn rain_with_nobody_alive_still_falls() {
        let map = generate(4242, MapScale::Small);
        let mut rain = ToxicRain::new(1, 0.0);
        let n = run(&mut rain, &map, &[], TOXIC_DURATION, 0.0);
        assert_eq!(n, (TOXIC_DURATION / TOXIC_DROP_EVERY) as usize);
    }

    #[test]
    fn the_same_seed_produces_the_same_rain() {
        let map = generate(4242, MapScale::Small);
        let sample = || {
            let mut pr = Projectiles::new();
            let mut rain = ToxicRain::new(77, 0.0);
            let mut out = Vec::new();
            let ticks = (TOXIC_DURATION / DT) as u32;
            for i in 0..ticks {
                for id in rain.tick(&mut pr, &map, &[300.0], true, i as f32 * DT) {
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
