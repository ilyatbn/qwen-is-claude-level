//! Birds (`docs/72-amendments-v4.md` §C16): ambient life that is also a reason to
//! shoot at the sky.
//!
//! **They are not decoration.** A bird killed drops a heal or a battery, so a bird
//! that never spawns is a supply line that never opens — which is why the tests
//! here and in `scripts/checks/birds.mjs` assert birds exist **in the world**
//! rather than that the spawner ticked (§A15, §B25).
//!
//! ## What is deliberately absent
//!
//! No pathing, no terrain collision, no flocking. A bird is a position, a
//! direction and a sine offset; four of them cost nothing. §C16 asks for cheap
//! and this is the cheap version.
//!
//! ## Why the sine is sampled, not integrated
//!
//! `y` is a pure function of `now - spawned_at`. Integrating a vertical velocity
//! would accumulate float error over a crossing and make two clients — or a round
//! and its replay — disagree by a pixel that grows. The horizontal position does
//! integrate, because it has to respond to `dt`, but nothing reads it as anything
//! but a position.

use crate::constants::{
    BIRD_ALTITUDE_ABOVE_MAX, BIRD_ALTITUDE_ABOVE_MIN, BIRD_EDGE_MARGIN, BIRD_H, BIRD_HEALTH,
    BIRD_INTERVAL, BIRD_MAX, BIRD_METAL_CHANCE, BIRD_METAL_HEALTH, BIRD_METAL_SPEED_MULT,
    BIRD_SPEED, BIRD_W, BIRD_WAVE_AMPLITUDE, BIRD_WAVE_PERIOD, SKY_MARGIN,
};
use crate::map::Map;
use crate::math::Vec2;
use crate::rng::{range_f32, substream, ChaCha8Rng};

/// The altitude band birds fly in, derived from the map once.
///
/// Computed here rather than per hatch because it is a property of the map and
/// scanning every column is not something to do four times a minute.
#[derive(Copy, Clone, Debug)]
pub struct SkyBand {
    pub top: f32,
    pub bottom: f32,
}

impl SkyBand {
    /// From the **median** column-top, not the highest or the mean.
    ///
    /// The median is the ground the players are actually on: the highest is a
    /// single mesa and the mean is dragged up by every floating island.
    pub fn of(map: &Map) -> Self {
        let h = map.mask.h as i32;
        let mut tops: Vec<i32> = (0..map.mask.w as i32)
            .map(|x| (0..h).find(|y| map.mask.get(x, *y)).unwrap_or(h))
            .collect();
        tops.sort_unstable();
        let median = tops[tops.len() / 2] as f32;
        // Never above the top of the world, however high the ground happens to be.
        let floor = SKY_MARGIN as f32 + BIRD_WAVE_AMPLITUDE;
        Self {
            top: (median - BIRD_ALTITUDE_ABOVE_MAX).max(floor),
            bottom: (median - BIRD_ALTITUDE_ABOVE_MIN).max(floor),
        }
    }
}

pub use crate::weapons::explode::BirdId;

/// Which bird, and therefore which drop.
///
/// The two are visually distinct and carry different rewards, so this reaches the
/// client on the spawn event — a player who cannot tell them apart cannot decide
/// whether a bird is worth a rocket.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BirdKind {
    /// Drops a heal.
    Normal,
    /// Tougher, slower, drops a battery.
    Metal,
}

impl BirdKind {
    pub fn health(self) -> f32 {
        match self {
            BirdKind::Normal => BIRD_HEALTH,
            BirdKind::Metal => BIRD_METAL_HEALTH,
        }
    }

    pub fn speed(self) -> f32 {
        match self {
            BirdKind::Normal => BIRD_SPEED,
            BirdKind::Metal => BIRD_SPEED * BIRD_METAL_SPEED_MULT,
        }
    }

    pub fn to_u8(self) -> u8 {
        match self {
            BirdKind::Normal => 0,
            BirdKind::Metal => 1,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Bird {
    pub id: BirdId,
    pub kind: BirdKind,
    /// Where it is **now**, sine included. Recomputed every tick.
    pub pos: Vec2,
    /// The altitude the sine oscillates about.
    base_y: f32,
    /// Signed: the sign is the direction of travel.
    vx: f32,
    spawned_at: f32,
    pub health: f32,
}

impl Bird {
    /// The hit box every weapon path tests against.
    pub fn size(&self) -> (f32, f32) {
        (BIRD_W, BIRD_H)
    }

    /// Facing, for the client. `true` when flying right.
    pub fn facing_right(&self) -> bool {
        self.vx > 0.0
    }
}

/// What one `Birds::tick` did.
///
/// Named fields rather than two bare `Vec<BirdId>`, for the reason `ItemStep`
/// gives: two lists that mean opposite things handed over positionally is how a
/// caller eventually announces a spawn for something that has just despawned.
#[derive(Clone, Debug, Default)]
pub struct BirdStep {
    pub spawned: Vec<BirdId>,
    /// Left the map on its own. **Not** the same as killed — nothing drops.
    pub gone: Vec<BirdId>,
}

#[derive(Clone, Debug)]
pub struct Birds {
    rng: ChaCha8Rng,
    birds: Vec<Bird>,
    next_id: BirdId,
    /// `None` until the first tick that is allowed to spawn. See `tick`.
    next_spawn_at: Option<f32>,
    band: SkyBand,
}

impl Birds {
    pub fn new(seed: u64, map: &Map) -> Self {
        Self {
            rng: substream(seed, "birds"),
            birds: Vec::new(),
            next_id: 0,
            next_spawn_at: None,
            band: SkyBand::of(map),
        }
    }

    pub fn band(&self) -> SkyBand {
        self.band
    }

    pub fn iter(&self) -> impl Iterator<Item = &Bird> {
        self.birds.iter()
    }

    pub fn len(&self) -> usize {
        self.birds.len()
    }

    pub fn is_empty(&self) -> bool {
        self.birds.is_empty()
    }

    pub fn get(&self, id: BirdId) -> Option<&Bird> {
        self.birds.iter().find(|b| b.id == id)
    }

    /// Spawn on cadence, fly, and drop anything that has left the map.
    ///
    /// `active` is the round being in play. Like the meteor shower, the cadence
    /// is anchored on the **first active tick** rather than at construction: a
    /// clock started during the lobby would release a burst of birds the moment
    /// the round began, to catch up on time it had "missed".
    pub fn tick(&mut self, map_w: f32, active: bool, now: f32, dt: f32) -> BirdStep {
        let mut out = BirdStep::default();
        if !active {
            return out;
        }

        // --- spawn ---------------------------------------------------------
        let mut next = self.next_spawn_at.unwrap_or(now);
        while now >= next {
            // **The cadence advances whether or not the bird spawns.** It is a
            // clock, not a queue: skipping the advance while at `BIRD_MAX` would
            // bank the missed spawns and fire them all the instant a slot freed.
            if self.birds.len() < BIRD_MAX {
                let id = self.next_id;
                self.next_id += 1;
                let bird = Self::hatch(&mut self.rng, self.band, id, map_w, now);
                self.birds.push(bird);
                out.spawned.push(id);
            }
            next += BIRD_INTERVAL;
        }
        self.next_spawn_at = Some(next);

        // --- fly -----------------------------------------------------------
        for b in self.birds.iter_mut() {
            b.pos.x += b.vx * dt;
            let t = now - b.spawned_at;
            b.pos.y = b.base_y
                + BIRD_WAVE_AMPLITUDE * (t * std::f32::consts::TAU / BIRD_WAVE_PERIOD).sin();
        }

        // --- leave ---------------------------------------------------------
        //
        // Off the far edge only. A bird spawned at `-margin` flying right is
        // outside the map on its very first tick, and a plain "outside the map"
        // test would delete it before it had moved.
        let gone = &mut out.gone;
        self.birds.retain(|b| {
            let past = if b.vx > 0.0 {
                b.pos.x > map_w + BIRD_EDGE_MARGIN
            } else {
                b.pos.x < -BIRD_EDGE_MARGIN
            };
            if past {
                gone.push(b.id);
                false
            } else {
                true
            }
        });

        out
    }

    /// One bird, entering from a random side at a random altitude.
    ///
    /// **Every draw happens unconditionally and in a fixed order**, even the ones
    /// a branch will not use — the stream position after a hatch must not depend
    /// on which side or which kind came out, or a replay diverges the first time
    /// a metal bird appears where a normal one did.
    fn hatch(rng: &mut ChaCha8Rng, band: SkyBand, id: BirdId, map_w: f32, now: f32) -> Bird {
        let kind = if range_f32(rng, 0.0, 1.0) < BIRD_METAL_CHANCE {
            BirdKind::Metal
        } else {
            BirdKind::Normal
        };
        // Left-to-right or right-to-left, drawn before the altitude so the stream
        // order is fixed however the branches fall.
        let rightward = range_f32(rng, 0.0, 1.0) < 0.5;
        let base_y = range_f32(rng, band.top, band.bottom);
        let speed = kind.speed();
        let (x, vx) = if rightward {
            (-BIRD_EDGE_MARGIN, speed)
        } else {
            (map_w + BIRD_EDGE_MARGIN, -speed)
        };
        Bird {
            id,
            kind,
            pos: Vec2::new(x, base_y),
            base_y,
            vx,
            spawned_at: now,
            health: kind.health(),
        }
    }
}

/// A bird that was killed, and what it owes.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct BirdKill {
    pub id: BirdId,
    pub kind: BirdKind,
    /// Where it was when it died — the drop starts here.
    pub at: Vec2,
}

impl Birds {
    /// Test seam: put a known bird at a known place.
    ///
    /// The natural spawn enters off the edge of the map and takes most of a
    /// minute to cross it; every test about *hitting* a bird would otherwise
    /// spend that minute, and would depend on which kind the draw produced.
    #[doc(hidden)]
    pub fn place_for_test(&mut self, id: BirdId, kind: BirdKind, at: Vec2) {
        if let Some(b) = self.birds.iter_mut().find(|b| b.id == id) {
            b.kind = kind;
            b.health = kind.health();
            b.pos = at;
            b.base_y = at.y;
        }
    }

    /// Apply damage logged against birds this tick and remove the dead.
    ///
    /// Returns the kills, because the caller is the only place that can turn one
    /// into a `WorldItem` and an event — a drop nobody was told about cannot be
    /// drawn, which is §A39 in its usual costume.
    pub fn apply_damage(&mut self, log: &[(BirdId, f32)]) -> Vec<BirdKill> {
        for (id, amount) in log {
            if let Some(b) = self.birds.iter_mut().find(|b| b.id == *id) {
                b.health -= amount;
            }
        }
        let mut kills = Vec::new();
        self.birds.retain(|b| {
            if b.health > 0.0 {
                true
            } else {
                kills.push(BirdKill {
                    id: b.id,
                    kind: b.kind,
                    at: b.pos,
                });
                false
            }
        });
        kills
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    const DT: f32 = 1.0 / 60.0;

    /// A real generated map, because the flight band is derived from one.
    fn map() -> crate::map::Map {
        crate::map::generate(4242, MapScale::Medium)
    }

    fn birds(seed: u64, map: &crate::map::Map) -> Birds {
        Birds::new(seed, map)
    }

    /// Run `seconds` of ticks from `t0`, returning every step.
    fn run_from(b: &mut Birds, w: f32, t0: f32, seconds: f32) -> Vec<BirdStep> {
        let ticks = (seconds / DT).round() as u32;
        let mut out = Vec::new();
        for i in 0..ticks {
            out.push(b.tick(w, true, t0 + (i + 1) as f32 * DT, DT));
        }
        out
    }

    fn run(b: &mut Birds, w: f32, seconds: f32) -> Vec<BirdStep> {
        run_from(b, w, 0.0, seconds)
    }

    #[test]
    fn a_bird_is_in_the_world_almost_immediately() {
        // §A15: the spawner ticking is not the claim. The claim is that a bird
        // exists, because that is the supply line.
        let m = map();
        let mut b = birds(7, &m);
        run(&mut b, m.mask.w as f32, 1.0);
        assert_eq!(b.len(), 1, "no bird in the world after a second of play");
    }

    #[test]
    fn nothing_spawns_while_the_round_is_not_active() {
        let m = map();
        let mut b = birds(7, &m);
        for i in 0..600 {
            b.tick(m.mask.w as f32, false, (i + 1) as f32 * DT, DT);
        }
        assert!(b.is_empty(), "birds spawned outside a live round");
        // The control: the same clock with `active` true does produce one, so
        // the assertion above is about the gate and not about the cadence.
        let mut c = birds(7, &m);
        run(&mut c, m.mask.w as f32, 1.0);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn the_cadence_is_bird_interval_and_never_exceeds_bird_max() {
        let m = map();
        let mut b = birds(11, &m);
        let steps = run(&mut b, m.mask.w as f32, BIRD_INTERVAL * 3.0 + 1.0);
        let spawned: usize = steps.iter().map(|s| s.spawned.len()).sum();
        // One at the first active tick, then one per interval.
        assert_eq!(spawned, 4, "spawned {spawned} over three intervals");
        assert!(b.len() <= BIRD_MAX);
    }

    #[test]
    fn the_cap_holds_over_a_long_round_and_the_clock_does_not_bank_spawns() {
        // Long enough that the cadence would have produced far more than the cap.
        let m = map();
        let mut b = birds(3, &m);
        let mut peak = 0;
        let ticks = (BIRD_INTERVAL * 12.0 / DT) as u32;
        for i in 0..ticks {
            b.tick(m.mask.w as f32, true, (i + 1) as f32 * DT, DT);
            peak = peak.max(b.len());
        }
        assert!(
            peak <= BIRD_MAX,
            "{peak} birds alive at once, cap is {BIRD_MAX}"
        );
        // ...and the cap was actually reached, or the assertion above is vacuous.
        assert_eq!(peak, BIRD_MAX, "the cap was never approached: peak {peak}");
    }

    #[test]
    fn a_bird_crosses_the_map_and_leaves_at_the_far_edge() {
        let m = map();
        let w = m.mask.w as f32;
        let mut b = birds(7, &m);

        // One tick, so the bird is observed essentially where it entered.
        run(&mut b, w, DT);
        let entered = b.iter().next().expect("a bird").clone();
        let rightward = entered.facing_right();
        let entry_edge = if rightward {
            -BIRD_EDGE_MARGIN
        } else {
            w + BIRD_EDGE_MARGIN
        };
        assert!(
            (entered.pos.x - entry_edge).abs() <= BIRD_SPEED * DT + 1.0,
            "entered at x={} rather than off the edge at {entry_edge}",
            entered.pos.x
        );

        // Long enough for the slowest bird to cross the widest span.
        let span = w + BIRD_EDGE_MARGIN * 2.0;
        let slowest = BIRD_SPEED * BIRD_METAL_SPEED_MULT;
        let steps = run_from(&mut b, w, DT, span / slowest + 1.0);

        let leaving = steps
            .iter()
            .flat_map(|s| s.gone.iter())
            .any(|id| *id == entered.id);
        assert!(leaving, "the bird never left");
        // The control: it did not simply vanish on the tick it spawned — it was
        // alive for most of a crossing first.
        let ticks_alive = steps
            .iter()
            .position(|s| s.gone.contains(&entered.id))
            .expect("a leaving tick");
        let expected = span / entered.kind.speed() / DT;
        assert!(
            (ticks_alive as f32) > expected * 0.9,
            "left after {ticks_alive} ticks, a crossing is about {expected}"
        );
    }

    #[test]
    fn the_path_is_a_sine_about_a_fixed_altitude() {
        let m = map();
        let mut b = birds(7, &m);
        run(&mut b, m.mask.w as f32, 1.0);
        let base = b.iter().next().expect("a bird").base_y;

        let mut lo = f32::INFINITY;
        let mut hi = f32::NEG_INFINITY;
        let ticks = (BIRD_WAVE_PERIOD / DT) as u32;
        for i in 0..ticks {
            b.tick(m.mask.w as f32, true, 1.0 + (i + 1) as f32 * DT, DT);
            if let Some(bird) = b.get(0) {
                lo = lo.min(bird.pos.y);
                hi = hi.max(bird.pos.y);
            }
        }
        // A full period visits both extremes, within a tick's worth of curve.
        let tol = 1.0;
        assert!(
            (hi - (base + BIRD_WAVE_AMPLITUDE)).abs() < tol
                && (lo - (base - BIRD_WAVE_AMPLITUDE)).abs() < tol,
            "sine spanned {lo}..{hi} about {base}, expected +/-{BIRD_WAVE_AMPLITUDE}"
        );
    }

    /// Birds fly over the ground players stand on, and stay inside the world.
    ///
    /// **Not "above all terrain"** — that was the first version of this test and
    /// it failed, correctly. The generator clamps the tallest rock to
    /// `SKY_MARGIN` at every scale, so the only terrain-free band is the top 96
    /// px, which at `CAMERA_ZOOM` 2 is never on screen. §C16 gives birds no
    /// terrain collision precisely so they can fly where they can be seen; they
    /// are drawn behind the terrain, so one crossing a mesa slides behind it.
    #[test]
    fn birds_fly_over_the_ground_and_stay_inside_the_world() {
        for scale in [MapScale::Small, MapScale::Medium, MapScale::Large] {
            let m = crate::map::generate(4242, scale);
            let band = SkyBand::of(&m);
            let mut tops: Vec<i32> = (0..m.mask.w as i32)
                .map(|x| {
                    (0..m.mask.h as i32)
                        .find(|y| m.mask.get(x, *y))
                        .unwrap_or(m.mask.h as i32)
                })
                .collect();
            tops.sort_unstable();
            let median = tops[tops.len() / 2] as f32;

            assert!(
                band.bottom < median,
                "{scale:?}: birds fly at {} which is below the median ground {median}",
                band.bottom
            );
            assert!(
                band.top - BIRD_WAVE_AMPLITUDE >= 0.0,
                "{scale:?}: the sine takes a bird off the top of the world"
            );
            // Close enough to the ground to be on screen: the camera shows
            // VIEWPORT_H / CAMERA_ZOOM, so half of that is what a player at the
            // median surface can see above them.
            let half_view =
                crate::constants::VIEWPORT_H as f32 / crate::constants::CAMERA_ZOOM / 2.0;
            assert!(
                median - band.bottom < half_view,
                "{scale:?}: the lowest bird is {} px up, past a {half_view} px half-view",
                median - band.bottom
            );
        }
    }

    #[test]
    fn the_same_seed_gives_the_same_birds_and_a_different_seed_does_not() {
        let m = map();
        let sample = |seed: u64| {
            let mut b = birds(seed, &m);
            run(&mut b, m.mask.w as f32, BIRD_INTERVAL * 2.0 + 1.0);
            b.iter()
                .map(|x| {
                    (
                        x.kind,
                        x.pos.x.to_bits(),
                        x.base_y.to_bits(),
                        x.vx.to_bits(),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(sample(31337), sample(31337), "same seed diverged");
        // The control. Without it the assertion above holds for a spawner that
        // ignores its seed entirely.
        assert_ne!(sample(31337), sample(999), "two seeds gave the same birds");
    }

    #[test]
    fn birds_draw_from_their_own_sub_stream() {
        // Not "drain a local rng and see nothing move" — that holds however the
        // streams are named, because `Birds::new` is deterministic either way
        // (the T15.01 review). Two differently-named streams must simply produce
        // different birds from one seed.
        let m = map();
        let own = {
            let mut b = birds(31337, &m);
            run(&mut b, m.mask.w as f32, BIRD_INTERVAL + 1.0);
            b.iter().map(|x| x.base_y.to_bits()).collect::<Vec<_>>()
        };
        let as_if_shared = {
            let mut b = birds(31337, &m);
            b.rng = substream(31337, "items");
            run(&mut b, m.mask.w as f32, BIRD_INTERVAL + 1.0);
            b.iter().map(|x| x.base_y.to_bits()).collect::<Vec<_>>()
        };
        assert_ne!(
            own, as_if_shared,
            "the bird stream and the item stream produce identical draws"
        );
    }

    #[test]
    fn a_metal_bird_survives_a_hit_that_kills_a_normal_one() {
        // The constants' own relationship is a `const` assertion in
        // `constants.rs` — a runtime one on two constants cannot fail. This test
        // is about the behaviour that relationship is supposed to buy.
        let m = map();
        let mut b = birds(1, &m);
        // Build one of each by hand so the test does not depend on the draw.
        let mut rng = substream(1, "birds");
        let band = b.band();
        let w = m.mask.w as f32;
        let normal = Bird {
            kind: BirdKind::Normal,
            health: BirdKind::Normal.health(),
            ..Birds::hatch(&mut rng, band, 100, w, 0.0)
        };
        let metal = Bird {
            kind: BirdKind::Metal,
            health: BirdKind::Metal.health(),
            ..Birds::hatch(&mut rng, band, 101, w, 0.0)
        };
        b.birds = vec![normal, metal];

        let kills = b.apply_damage(&[(100, BIRD_HEALTH), (101, BIRD_HEALTH)]);
        assert_eq!(
            kills.len(),
            1,
            "one hit should kill exactly the normal bird"
        );
        assert_eq!(kills[0].kind, BirdKind::Normal);
        assert_eq!(b.len(), 1, "the metal bird should still be flying");

        // ...and it is not invincible: enough damage finishes it.
        let kills = b.apply_damage(&[(101, BIRD_METAL_HEALTH)]);
        assert_eq!(kills.len(), 1);
        assert_eq!(kills[0].kind, BirdKind::Metal);
        assert!(b.is_empty());
    }

    #[test]
    fn a_metal_bird_is_slower() {
        assert!(BirdKind::Metal.speed() < BirdKind::Normal.speed());
    }
}
