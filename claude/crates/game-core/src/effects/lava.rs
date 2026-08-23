//! Lava bursts: the effect that punishes players who have dug themselves a hole.
//!
//! Timeline per vent, and getting this wrong by a phase is the most likely error
//! in the milestone (`docs/13-weather-effects.md` §5):
//!
//! ```text
//!   t=0                 t=3s              t=6s              t=9s
//!   |---- telegraph ----|---- jet -------|---- burn -------|
//!   (the scheduler's)    channel carved    ground on fire    out
//!                        LAVA_JET_DPS      LAVA_BURN_DPS
//! ```
//!
//! The scheduler owns the telegraph; this type's `active` flag goes true at t=3,
//! so its own clock runs 0..LAVA_JET_DURATION+LAVA_BURN_DURATION.

use crate::constants::{
    LAVA_BURN_DPS, LAVA_BURN_DURATION, LAVA_BURN_RADIUS, LAVA_CHANNEL_R, LAVA_JET_DPS,
    LAVA_JET_DURATION, LAVA_VENTS_MAX, LAVA_VENTS_MIN, PLAYER_H, PLAYER_W,
};
use crate::map::carve::CarveResult;
use crate::map::Map;
use crate::math::Vec2;
use crate::rng::{range_f32, range_u32, substream, ChaCha8Rng};
use crate::weapons::explode::{DamageSource, EffectKind, PlayerHitTarget};

/// Minimum separation between vents, so a burst covers ground rather than
/// stacking on one spot.
const VENT_SEPARATION: f32 = 200.0;
/// Jet geometry: a cone from the vent, leaning up to 30 degrees off vertical.
const JET_HEIGHT: f32 = 180.0;
const JET_HALF_ANGLE: f32 = 0.35; // ~20 degrees
const JET_MAX_LEAN: f32 = 0.52; // ~30 degrees

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Vent {
    pub id: u32,
    pub pos: Vec2,
    pub jet_until: f32,
    pub burn_until: f32,
    /// Radians off vertical, positive is to the right.
    pub lean: f32,
}

pub struct LavaBurst {
    vents: Vec<Vent>,
    opened: bool,
}

impl LavaBurst {
    /// Vent positions are chosen at construction — during the telegraph — so the
    /// client can draw cracks at exactly the points that will open.
    pub fn new(seed: u64, map: &Map, now: f32) -> Self {
        let mut rng: ChaCha8Rng = substream(seed, "lava");
        let want = range_u32(&mut rng, LAVA_VENTS_MIN, LAVA_VENTS_MAX) as usize;
        let pts = &map.meta.surface_points;
        let mut vents: Vec<Vent> = Vec::new();

        if !pts.is_empty() {
            // Rejection sampling with a hard attempt cap: on a small or heavily
            // carved map the separation may be unsatisfiable, and looping until it
            // is would hang the tick.
            for _ in 0..200 {
                if vents.len() >= want {
                    break;
                }
                let i = range_u32(&mut rng, 0, pts.len() as u32 - 1) as usize;
                let p = Vec2::new(pts[i].x as f32, pts[i].y as f32);
                if vents.iter().any(|v| (v.pos - p).len() < VENT_SEPARATION) {
                    continue;
                }
                vents.push(Vent {
                    id: vents.len() as u32,
                    pos: p,
                    jet_until: now + LAVA_JET_DURATION,
                    burn_until: now + LAVA_JET_DURATION + LAVA_BURN_DURATION,
                    lean: range_f32(&mut rng, -JET_MAX_LEAN, JET_MAX_LEAN),
                });
            }
        }

        Self {
            vents,
            opened: false,
        }
    }

    pub fn vents(&self) -> &[Vent] {
        &self.vents
    }

    /// Opens the channels on the first active tick, then damages each tick.
    pub fn tick(
        &mut self,
        map: &mut Map,
        players: &mut [PlayerHitTarget],
        active: bool,
        now: f32,
        dt: f32,
    ) -> Vec<CarveResult> {
        let mut carves = Vec::new();
        if !active {
            return carves;
        }

        if !self.opened {
            self.opened = true;
            for v in &mut self.vents {
                // Re-base the clock on the moment the vent actually opened, so a
                // telegraph of a different length cannot shift the jet or burn.
                v.jet_until = now + LAVA_JET_DURATION;
                v.burn_until = now + LAVA_JET_DURATION + LAVA_BURN_DURATION;
                let (x, y) = (v.pos.x.round() as i32, v.pos.y.round() as i32);
                carves.push(map.carve_capsule(
                    x,
                    y,
                    x,
                    y + (3.0 * LAVA_CHANNEL_R) as i32,
                    LAVA_CHANNEL_R as i32,
                ));
            }
        }

        for target in players.iter_mut() {
            if !target.alive {
                continue;
            }
            let p = target.pos;
            for v in &self.vents {
                let dps = if now < v.jet_until {
                    if in_jet(v, p) {
                        LAVA_JET_DPS
                    } else {
                        0.0
                    }
                } else if now < v.burn_until {
                    // Burning ground: a disc at the vent, not a cone.
                    if (p - v.pos).len() <= LAVA_BURN_RADIUS + PLAYER_W * 0.5 {
                        LAVA_BURN_DPS
                    } else {
                        0.0
                    }
                } else {
                    0.0
                };
                if dps > 0.0 {
                    (target.apply_damage)(dps * dt, DamageSource::Weather(EffectKind::LavaBurst));
                }
            }
        }

        carves
    }

    /// True once every vent has finished burning.
    pub fn finished(&self, now: f32) -> bool {
        self.opened && self.vents.iter().all(|v| now >= v.burn_until)
    }
}

/// Is the player's centre inside this vent's jet cone?
///
/// Cone from the vent, pointing up with `lean`, half-angle `JET_HALF_ANGLE`,
/// length `JET_HEIGHT`. Testing the centre rather than exact cone-box
/// intersection: the difference is under half a player width and the effect is
/// area denial, not a precision instrument.
fn in_jet(v: &Vent, p: Vec2) -> bool {
    let d = p - v.pos;
    let dist = d.len();
    if !(1e-3..=JET_HEIGHT).contains(&dist) {
        // Standing exactly on the vent counts as inside; beyond the jet's reach
        // does not.
        return dist <= JET_HEIGHT;
    }
    // Screen coords: up is negative y.
    let up = Vec2::new(v.lean.sin(), -v.lean.cos());
    let cos = (d.x * up.x + d.y * up.y) / dist;
    cos >= JET_HALF_ANGLE.cos()
}

/// Height of the jet, for the client's particle emitter.
pub fn jet_height() -> f32 {
    JET_HEIGHT
}

/// The player box, so callers can size their own overlap checks consistently.
pub fn player_box() -> (f32, f32) {
    (PLAYER_W, PLAYER_H)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::silhouette::force_borders;
    use crate::map::meta::MapMeta;
    use crate::map::{CoarseGrid, Mask};
    use crate::math::Point;

    const DT: f32 = 1.0 / 60.0;
    const W: u32 = 1024;
    const H: u32 = 512;

    /// A solid map with a row of surface points across the middle. Built directly
    /// rather than generated: these tests need known vent candidates, and the
    /// generator costs seconds per call in debug.
    fn lava_map() -> Map {
        let mut mask = Mask::new_full(W, H);
        force_borders(&mut mask);
        let coarse = CoarseGrid::build(&mask);
        let mut m = MapMeta {
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
        };
        for x in (60..(W as i32 - 60)).step_by(16) {
            m.surface_points.push(Point::new(x, 300));
        }
        Map::from_parts(mask, coarse, m)
    }

    struct Dummy {
        pos: Vec2,
        vel: Vec2,
        health: f32,
        shielded: bool,
    }

    fn targets(ds: &mut [Dummy]) -> Vec<PlayerHitTarget<'_>> {
        ds.iter_mut()
            .enumerate()
            .map(|(i, d)| {
                let shielded = d.shielded;
                let health = &mut d.health;
                PlayerHitTarget {
                    id: i as u8,
                    pos: d.pos,
                    vel: &mut d.vel,
                    alive: true,
                    apply_damage: Box::leak(Box::new(move |a: f32, s: DamageSource| {
                        assert_eq!(s, DamageSource::Weather(EffectKind::LavaBurst));
                        *health -= if shielded { a * 0.5 } else { a };
                        true
                    })),
                }
            })
            .collect()
    }

    fn dummy(pos: Vec2) -> Dummy {
        Dummy {
            pos,
            vel: Vec2::ZERO,
            health: 1000.0,
            shielded: false,
        }
    }

    #[test]
    fn it_picks_between_three_and_six_separated_vents_on_the_surface() {
        for seed in 0..40u64 {
            let map = lava_map();
            let lava = LavaBurst::new(seed, &map, 0.0);
            let n = lava.vents().len();
            assert!(
                (LAVA_VENTS_MIN as usize..=LAVA_VENTS_MAX as usize).contains(&n),
                "seed {seed}: {n} vents"
            );
            for (i, a) in lava.vents().iter().enumerate() {
                assert!(
                    map.meta
                        .surface_points
                        .iter()
                        .any(|p| p.x as f32 == a.pos.x && p.y as f32 == a.pos.y),
                    "vent not on a surface point"
                );
                for b in &lava.vents()[i + 1..] {
                    assert!(
                        (a.pos - b.pos).len() >= VENT_SEPARATION,
                        "vents {} apart",
                        (a.pos - b.pos).len()
                    );
                }
            }
        }
    }

    #[test]
    fn activation_carves_a_channel_at_every_vent() {
        let mut map = lava_map();
        let before = map.mask.count_solid();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let n = lava.vents().len();
        let carves = lava.tick(&mut map, &mut [], true, 0.0, DT);
        assert_eq!(carves.len(), n, "one channel per vent");
        assert!(map.mask.count_solid() < before, "nothing was carved");
        for c in &carves {
            assert!(c.pixels_removed > 0);
        }
        // Only once, however long it runs.
        let again = lava.tick(&mut map, &mut [], true, DT, DT);
        assert!(again.is_empty(), "channels re-carved on a later tick");
    }

    #[test]
    fn nothing_happens_while_inactive() {
        let mut map = lava_map();
        let before = map.mask.count_solid();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let mut ds = vec![dummy(Vec2::new(200.0, 300.0))];
        for i in 0..600 {
            let mut t = targets(&mut ds);
            assert!(lava
                .tick(&mut map, &mut t, false, i as f32 * DT, DT)
                .is_empty());
        }
        assert_eq!(map.mask.count_solid(), before);
        assert_eq!(ds[0].health, 1000.0);
    }

    #[test]
    fn a_player_in_the_jet_takes_jet_dps_and_one_outside_takes_nothing() {
        let mut map = lava_map();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let v = lava.vents()[0];

        // Directly above the vent, well inside the cone.
        let inside = v.pos + Vec2::new(v.lean.sin() * 60.0, -v.lean.cos() * 60.0);
        // Beside it, past the cone's half-angle and outside the burn disc.
        let outside = v.pos + Vec2::new(160.0, 0.0);
        let mut ds = vec![dummy(inside), dummy(outside)];

        let ticks = (LAVA_JET_DURATION / DT) as u32;
        for i in 0..ticks {
            let mut t = targets(&mut ds);
            lava.tick(&mut map, &mut t, true, i as f32 * DT, DT);
        }
        let took = 1000.0 - ds[0].health;
        let expected = LAVA_JET_DPS * LAVA_JET_DURATION;
        assert!(
            (took - expected).abs() < LAVA_JET_DPS * DT * 3.0,
            "in-jet took {took}, expected {expected}"
        );
        assert_eq!(ds[1].health, 1000.0, "a player outside the cone was burned");
    }

    #[test]
    fn a_vent_deals_jet_then_burn_then_stops() {
        // The whole timeline: 3 s of jet at 10/s, then 3 s of burning ground at
        // 8/s, then nothing. 54 total for someone who never moves.
        let mut map = lava_map();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let v = lava.vents()[0];
        let mut ds = vec![dummy(v.pos)];

        let total = LAVA_JET_DURATION + LAVA_BURN_DURATION;
        let ticks = ((total + 2.0) / DT) as u32;
        let mut at_jet_end = 0.0;
        for i in 0..ticks {
            let now = i as f32 * DT;
            let mut t = targets(&mut ds);
            lava.tick(&mut map, &mut t, true, now, DT);
            drop(t);
            if at_jet_end == 0.0 && now >= LAVA_JET_DURATION {
                at_jet_end = 1000.0 - ds[0].health;
            }
        }
        let took = 1000.0 - ds[0].health;
        let expected = LAVA_JET_DPS * LAVA_JET_DURATION + LAVA_BURN_DPS * LAVA_BURN_DURATION;
        assert!(
            (took - expected).abs() < 1.0,
            "total {took}, expected {expected}"
        );
        assert!(
            (at_jet_end - LAVA_JET_DPS * LAVA_JET_DURATION).abs() < 1.0,
            "at the jet's end {at_jet_end}, expected {}",
            LAVA_JET_DPS * LAVA_JET_DURATION
        );
        // And it is over: two more seconds cost nothing.
        let health = ds[0].health;
        for i in 0..120 {
            let mut t = targets(&mut ds);
            lava.tick(&mut map, &mut t, true, total + 1.0 + i as f32 * DT, DT);
        }
        assert_eq!(ds[0].health, health, "still burning after the burn ended");
        assert!(lava.finished(total + 1.0));
    }

    #[test]
    fn a_shielded_player_takes_half() {
        let mut map = lava_map();
        let mut lava = LavaBurst::new(3, &map, 0.0);
        let v = lava.vents()[0];
        let mut ds = vec![dummy(v.pos), dummy(v.pos)];
        ds[1].shielded = true;
        let ticks = (LAVA_JET_DURATION / DT) as u32;
        for i in 0..ticks {
            let mut t = targets(&mut ds);
            lava.tick(&mut map, &mut t, true, i as f32 * DT, DT);
        }
        let full = 1000.0 - ds[0].health;
        let half = 1000.0 - ds[1].health;
        assert!(full > 0.0);
        assert!((half - full / 2.0).abs() < 0.01, "{half} vs {full}");
    }

    #[test]
    fn the_same_seed_produces_the_same_vents_and_leans() {
        let map = lava_map();
        let sample = || {
            LavaBurst::new(77, &map, 0.0)
                .vents()
                .iter()
                .map(|v| (v.pos.x.to_bits(), v.pos.y.to_bits(), v.lean.to_bits()))
                .collect::<Vec<_>>()
        };
        let first = sample();
        assert!(!first.is_empty());
        for _ in 0..10 {
            assert_eq!(sample(), first);
        }
    }

    #[test]
    fn a_map_with_no_surface_points_produces_no_vents_and_does_not_hang() {
        let mut mask = Mask::new_full(W, H);
        force_borders(&mut mask);
        let coarse = CoarseGrid::build(&mask);
        let m = MapMeta {
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
        };
        let mut map = Map::from_parts(mask, coarse, m);
        let mut lava = LavaBurst::new(1, &map, 0.0);
        assert!(lava.vents().is_empty());
        assert!(lava.tick(&mut map, &mut [], true, 0.0, DT).is_empty());
    }
}
