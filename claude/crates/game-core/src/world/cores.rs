//! T22.16 — **asteroid cores** (`M22-OWNER-ROUND-2` R102). The owner: *"when an
//! 'asterodid' is destroyed (make like a round core at the center) its gravity pull
//! disappears, a battery is spawned when its destroyed."*
//!
//! - **The core** is a disc at the rock's centre, [`core_radius`] =
//!   `round(SPACE_CORE_FRAC · r)` — the generator stamps it solid (it is inside the
//!   rock's round body, `SPACE_ASTEROID_CORE_FRAC · r`), the client draws it in its
//!   own colour (`render/chunkBake.ts`), and it is carved like any rock.
//! - **Destroyed** ([`core_destroyed`]) when at least `SPACE_CORE_DESTROYED_FRAC` of
//!   its pixels are air — derived from the mask, the one truth both sides carve. The
//!   constant's doc has refinement A's arithmetic: no body-sized cavity can hold the
//!   centre while the well is on.
//! - **Then, once, on the server** ([`World::step_cores`]): the rock's
//!   `core_intact` goes false for the round (its well is gone — `asteroid_attractors`
//!   skips it), `core_destroyed` goes out with the tick, what is left of the core
//!   crumbles (one ordinary `Carve`, so the drawn core disappears whole and the centre
//!   is air), and **one battery pack** floats at the centre through the wildlife
//!   drop — an ordinary world item, on the wire and picked up like any other.
//! - **The black hole eating a rock is not a destruction**: `arrive_black_hole`
//!   removes the rock from the list before it carves it, and this step only reads the
//!   list.

use crate::constants::{SPACE_CORE_DESTROYED_FRAC, SPACE_CORE_FRAC};
use crate::map::meta::Asteroid;
use crate::map::Mask;
use crate::math::{isqrt, Vec2};
use crate::world::{CarveKind, GameEvent, World};

/// The core's radius, px: `round(SPACE_CORE_FRAC · r)` — 7 on the smallest rock, 21
/// on the largest.
pub fn core_radius(a: &Asteroid) -> i32 {
    (SPACE_CORE_FRAC * a.r as f32).round() as i32
}

/// `(solid, total)` pixels of `a`'s core disc — the raster `shape::stamp_circle` and
/// `carve_circle` use (row `dy`, columns `±isqrt(c² − dy²)`), so "the core" is the
/// same pixel set that was stamped and that a core-sized carve clears.
pub fn core_pixels(mask: &Mask, a: &Asteroid) -> (u32, u32) {
    let c = core_radius(a);
    let (mut solid, mut total) = (0u32, 0u32);
    for dy in -c..=c {
        let dx = isqrt(c * c - dy * dy);
        total += (2 * dx + 1) as u32;
        solid += mask.count_run(a.y + dy, a.x - dx, a.x + dx);
    }
    (solid, total)
}

/// **Is `a`'s core destroyed?** At least [`SPACE_CORE_DESTROYED_FRAC`] of its pixels
/// are air.
pub fn core_destroyed(mask: &Mask, a: &Asteroid) -> bool {
    let (solid, total) = core_pixels(mask, a);
    (total - solid) as f32 >= SPACE_CORE_DESTROYED_FRAC * total as f32
}

impl World {
    /// R102: every rock whose core is still intact and is now destroyed — its well
    /// off for the round, `core_destroyed`, the rest of the core carved away, and one
    /// battery pack at its centre. `World::step` calls it after every carve of the
    /// tick. A pass over the list, a row count per core row: ~40 `count_run`s a rock.
    pub(super) fn step_cores(&mut self, now: f32) {
        for i in 0..self.map.meta.asteroids.len() {
            let a = self.map.meta.asteroids[i];
            if !a.core_intact || !core_destroyed(&self.map.mask, &a) {
                continue;
            }
            self.map.meta.asteroids[i].core_intact = false;
            let tick = self.tick;
            self.events.push(GameEvent::CoreDestroyed {
                tick,
                x: a.x,
                y: a.y,
            });
            // The rest of it crumbles — the hole's carve kind, through the carve
            // stream the client's mask already follows.
            let r = core_radius(&a);
            let carve = self.map.carve_circle(a.x, a.y, r);
            if carve.pixels_removed > 0 {
                self.carve_seq += 1;
                let seq = self.carve_seq;
                self.events.push(GameEvent::Carve {
                    tick,
                    seq,
                    x: a.x,
                    y: a.y,
                    r,
                    kind: CarveKind::Meteor,
                });
            }
            self.reveal(&carve.revealed, now);
            // Floats where the core was (R14: an item in space stays where it is put).
            self.drop_wildlife_loot(
                crate::items::registry::BATTERY_PACK,
                Vec2::new(a.x as f32, a.y as f32),
                Vec2::ZERO,
                now,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        GravityMode, MapScale, DEFAULT_MAP_GENERATOR, PLAYER_H, PLAYER_W, SIM_DT,
        SPACE_ASTEROID_MASS_MAX, SPACE_ASTEROID_R_MAX, SPACE_ASTEROID_R_MIN,
    };
    use crate::items::registry::BATTERY_PACK;
    use crate::map::shape::stamp_circle;
    use crate::world::attractors::{asteroid_attractors, well_reach, Attractor};
    use crate::world::RoundPhase;

    fn space_world(seed: u64) -> World {
        let mut w = World::with_gravity(
            seed,
            MapScale::Small,
            0,
            DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_round_seconds(600.0);
        w.set_phase(RoundPhase::Playing);
        w
    }

    fn largest(w: &World) -> (usize, Asteroid) {
        w.map
            .meta
            .asteroids
            .iter()
            .copied()
            .enumerate()
            .max_by_key(|(_, a)| a.r)
            .expect("rocks")
    }

    fn batteries_at(events: &[GameEvent], at: Vec2) -> usize {
        events
            .iter()
            .filter(|e| {
                matches!(e, GameEvent::ItemSpawn { item_id, x, y, .. }
                    if *item_id == BATTERY_PACK && Vec2::new(*x, *y) == at)
            })
            .count()
    }

    fn destroyed_events(events: &[GameEvent]) -> Vec<(i32, i32)> {
        events
            .iter()
            .filter_map(|e| match e {
                GameEvent::CoreDestroyed { x, y, .. } => Some((*x, *y)),
                _ => None,
            })
            .collect()
    }

    /// **Refinement A, as arithmetic run on the real predicate.** For every rock radius
    /// the generator can make (24 up to the largest grown, 70) and every pixel placement
    /// of a `PLAYER_W` × `PLAYER_H` box that holds the rock's centre pixel, a core whose
    /// box pixels are air (all a body there needs) is already [`core_destroyed`]. The
    /// fraction that box covers is at least **22.58 %** (r = 69, c = 21: 310 of 1373),
    /// and `SPACE_CORE_DESTROYED_FRAC` is 0.2.
    ///
    /// The control is that the minimum is real and near: a threshold over it (the
    /// minimum plus a pixel's worth) leaves some placement standing — so the test can
    /// see the constant being raised past the arithmetic.
    #[test]
    fn a_body_that_can_hold_the_centre_has_already_destroyed_the_core() {
        let (bw, bh) = (PLAYER_W as i32, PLAYER_H as i32);
        let r_max =
            crate::map::gen::space::grown_radius(SPACE_ASTEROID_R_MAX, SPACE_ASTEROID_MASS_MAX);
        let mut worst = (1.0f32, 0i32);
        for r in SPACE_ASTEROID_R_MIN..=r_max {
            let a = Asteroid {
                x: 128,
                y: 128,
                r,
                level: 1,
                core_intact: true,
            };
            let c = core_radius(&a);
            let mut mask = Mask::new_empty(256, 256);
            stamp_circle(&mut mask, a.x, a.y, c, true);
            let (_, total) = core_pixels(&mask, &a);
            for x0 in a.x - (bw - 1)..=a.x {
                for y0 in a.y - (bh - 1)..=a.y {
                    for y in y0..y0 + bh {
                        mask.clear_run(y, x0, x0 + bw - 1);
                    }
                    let (solid, _) = core_pixels(&mask, &a);
                    let frac = (total - solid) as f32 / total as f32;
                    if frac < worst.0 {
                        worst = (frac, r);
                    }
                    assert!(
                        core_destroyed(&mask, &a),
                        "r {r} (core {c}): a body box at ({x0}, {y0}) holds the centre with \
                         only {:.1} % of the core carved — the well is still on",
                        frac * 100.0
                    );
                    stamp_circle(&mut mask, a.x, a.y, c, true);
                }
            }
        }
        eprintln!(
            "the least of a core a centre-holding body box carves: {:.2} % (r {})",
            worst.0 * 100.0,
            worst.1
        );
        assert!(
            worst.0 < SPACE_CORE_DESTROYED_FRAC + 0.05,
            "control: the minimum {:.3} is far above the threshold — this test would not see \
             it raised",
            worst.0
        );
    }

    /// **R102 end to end, and the threshold at its live site.** On a real space world
    /// the largest rock's core is carved from the centre out, one pixel of radius at a
    /// time through `World::step`: while under `SPACE_CORE_DESTROYED_FRAC` is air
    /// nothing happens (the absence arm, and its control is the next radius); at the
    /// first radius over it, on that tick — the flag goes false, one `core_destroyed`
    /// with the rock's centre, the rest of the core is carved away, **exactly one**
    /// battery pack floats at the centre, and the rock's well is gone from the sum.
    #[test]
    fn a_carved_core_switches_the_well_off_crumbles_and_drops_one_battery() {
        let mut w = space_world(4242);
        let (i, a) = largest(&w);
        let centre = Vec2::new(a.x as f32, a.y as f32);
        let band = centre - Vec2::new(0.0, well_reach(&a) - 1.0);
        let wells = |w: &World| {
            asteroid_attractors(&w.map)
                .filter(|x| x.pos == centre)
                .count()
        };
        assert_eq!(wells(&w), 1, "premise: the rock's well is in the sum");
        assert!(
            Attractor::asteroid(&a).pull_at(band) != Vec2::ZERO,
            "premise: the band pulls"
        );
        let _ = w.drain_events();
        let c = core_radius(&a);
        let mut at_k = None;
        for k in 0..=c {
            let _ = w.map.carve_circle(a.x, a.y, k);
            let (solid, total) = core_pixels(&w.map.mask, &a);
            let over = (total - solid) as f32 >= SPACE_CORE_DESTROYED_FRAC * total as f32;
            w.step(SIM_DT);
            let ev = w.drain_events();
            let rock = w.map.meta.asteroids[i];
            if !over {
                assert!(rock.core_intact, "k {k}: destroyed under the threshold");
                assert!(
                    destroyed_events(&ev).is_empty(),
                    "k {k}: an event under the threshold"
                );
                assert_eq!(
                    batteries_at(&ev, centre),
                    0,
                    "k {k}: a battery under the threshold"
                );
                assert_eq!(wells(&w), 1, "k {k}: the well went under the threshold");
                continue;
            }
            assert!(!rock.core_intact, "k {k}: over the threshold, still intact");
            assert_eq!(destroyed_events(&ev), vec![(a.x, a.y)]);
            assert_eq!(
                batteries_at(&ev, centre),
                1,
                "exactly one battery at the centre"
            );
            assert_eq!(
                core_pixels(&w.map.mask, &a).0,
                0,
                "the core did not crumble"
            );
            assert_eq!(wells(&w), 0, "the destroyed core's well is still summed");
            at_k = Some(k);
            break;
        }
        let k = at_k.expect("the core was never destroyed");
        assert!(k > 0, "control: destroyed with nothing carved");
        // Once: more carving and more ticks bring no second battery or event.
        let _ = w.map.carve_circle(a.x, a.y, c + 4);
        for _ in 0..10 {
            w.step(SIM_DT);
        }
        let ev = w.drain_events();
        assert!(destroyed_events(&ev).is_empty() && batteries_at(&ev, centre) == 0);
    }

    /// **The black hole eating a rock is not a core destruction** (R102): no
    /// `core_destroyed`, no battery at its centre — though its core's pixels are all
    /// gone. The control is the other rocks: none of them changed either.
    #[test]
    fn the_black_hole_eating_a_rock_drops_no_battery() {
        let mut w = space_world(4242);
        let (_, a) = largest(&w);
        let centre = Vec2::new(a.x as f32, a.y as f32);
        let _ = w.drain_events();
        let hole = w
            .summon_black_hole_near(centre, 0.0)
            .expect("space, no hole yet");
        assert_eq!(hole, centre, "premise: it ate this rock");
        assert_eq!(
            core_pixels(&w.map.mask, &a).0,
            0,
            "premise: the core's pixels are gone"
        );
        for _ in 0..5 {
            w.step(SIM_DT);
        }
        let ev = w.drain_events();
        assert!(
            destroyed_events(&ev).is_empty(),
            "the hole counted as a core destruction"
        );
        assert_eq!(batteries_at(&ev, centre), 0, "the hole dropped a battery");
        assert!(w.map.meta.asteroids.iter().all(|r| r.core_intact));
    }

    /// Deterministic and hashed: two worlds carving the same core step to the same
    /// state hash; the flag alone moves it.
    #[test]
    fn a_core_destruction_is_deterministic_and_in_the_state_hash() {
        let run = || {
            let mut w = space_world(77);
            let (_, a) = largest(&w);
            let _ = w.map.carve_circle(a.x, a.y, core_radius(&a));
            for _ in 0..3 {
                w.step(SIM_DT);
            }
            w
        };
        let (mut one, two) = (run(), run());
        assert_eq!(one.state_hash(), two.state_hash());
        let (i, _) = largest(&one);
        one.map.meta.asteroids[i].core_intact = true;
        assert_ne!(one.state_hash(), two.state_hash(), "the flag is not hashed");
    }
}
