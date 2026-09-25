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

/// **Where a destroyed core's battery floats** (T22.18, from T22.16's review): the
/// rock's centre, as R102 says — **unless no body can get within `PICKUP_RADIUS` of
/// it**, and then the body-reachable point nearest the centre.
///
/// The case it exists for: a core shot out through tunnels narrower than a body (an
/// SMG's craters) crumbles to a pocket the core's size (7..21 px, under a body's
/// half-diagonal of 16.1 on most rocks) sealed but for those tunnels, and a battery
/// there is bait nobody can take without a shovel. A bigger crumble does not fix it
/// — a body-sized pocket behind a 6 px tunnel is just as sealed — so this asks the
/// question itself: **which body centres are connected to open air by body-fitting
/// one-pixel moves?** A flood over body centres in a window one `PLAYER_H` past the
/// rock's bounding radius, from every centre on the window's border where a body fits
/// (open space around the rock). A body fits where its box — `Body::new(p).aabb()`,
/// the box `collide::aabb_overlaps_solid` reads, out-of-map as air as there — holds no
/// solid pixel, counted off a summed-area table of the window, so each test is O(1).
/// ~40 000 centres for the largest rock, once per destroyed core.
pub fn battery_site(mask: &Mask, a: &Asteroid) -> Vec2 {
    use crate::constants::{PICKUP_RADIUS, PLAYER_H};
    use crate::physics::body::Body;
    let centre = Vec2::new(a.x as f32, a.y as f32);
    let half = a.r + PLAYER_H as i32;
    let side = (2 * half + 1) as usize;
    // Any body box whose centre is in the window lies inside the padded window.
    let (bx0, by0, bx1, by1) = Body::new(Vec2::ZERO).aabb().pixel_bounds();
    let (px0, py0) = (a.x - half + bx0, a.y - half + by0);
    let (pw, ph) = (
        (side as i32 + bx1 - bx0) as usize,
        (side as i32 + by1 - by0) as usize,
    );
    // sat[(y + 1) * (pw + 1) + x + 1] = solid pixels in [px0, px0 + x] × [py0, py0 + y].
    let mut sat = vec![0u32; (pw + 1) * (ph + 1)];
    for y in 0..ph {
        let mut row = 0u32;
        for x in 0..pw {
            row += u32::from(mask.get(px0 + x as i32, py0 + y as i32));
            sat[(y + 1) * (pw + 1) + x + 1] = sat[y * (pw + 1) + x + 1] + row;
        }
    }
    let fits = |i: usize, j: usize| {
        let p = Vec2::new(
            (a.x - half + i as i32) as f32,
            (a.y - half + j as i32) as f32,
        );
        let (x0, y0, x1, y1) = Body::new(p).aabb().pixel_bounds();
        let (x0, y0) = ((x0 - px0) as usize, (y0 - py0) as usize);
        let (x1, y1) = ((x1 - px0) as usize + 1, (y1 - py0) as usize + 1);
        let at = |x: usize, y: usize| sat[y * (pw + 1) + x];
        at(x1, y1) + at(x0, y0) == at(x0, y1) + at(x1, y0)
    };
    let mut seen = vec![false; side * side];
    let mut queue = std::collections::VecDeque::new();
    for k in 0..side {
        for (i, j) in [(k, 0), (k, side - 1), (0, k), (side - 1, k)] {
            if !seen[j * side + i] && fits(i, j) {
                seen[j * side + i] = true;
                queue.push_back((i, j));
            }
        }
    }
    let mut best: Option<(i64, usize, usize)> = None;
    while let Some((i, j)) = queue.pop_front() {
        let (dx, dy) = (i as i64 - half as i64, j as i64 - half as i64);
        let d2 = dx * dx + dy * dy;
        if best.is_none_or(|b| (d2, j, i) < (b.0, b.2, b.1)) {
            best = Some((d2, i, j));
        }
        let steps = [
            (i.wrapping_sub(1), j),
            (i + 1, j),
            (i, j.wrapping_sub(1)),
            (i, j + 1),
        ];
        for (ni, nj) in steps {
            if ni < side && nj < side && !seen[nj * side + ni] && fits(ni, nj) {
                seen[nj * side + ni] = true;
                queue.push_back((ni, nj));
            }
        }
    }
    match best {
        Some((d2, i, j)) if (d2 as f32).sqrt() > PICKUP_RADIUS => Vec2::new(
            (a.x - half + i as i32) as f32,
            (a.y - half + j as i32) as f32,
        ),
        _ => centre,
    }
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
            // Floats where the core was (R14: an item in space stays where it is put)
            // — or, when no body can get to it there, where one can (T22.18).
            let at = battery_site(&self.map.mask, &a);
            self.drop_wildlife_loot(crate::items::registry::BATTERY_PACK, at, Vec2::ZERO, now);
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

    fn batteries(events: &[GameEvent]) -> Vec<Vec2> {
        events
            .iter()
            .filter_map(|e| match e {
                GameEvent::ItemSpawn { item_id, x, y, .. } if *item_id == BATTERY_PACK => {
                    Some(Vec2::new(*x, *y))
                }
                _ => None,
            })
            .collect()
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
                lumps: Default::default(),
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
    /// battery pack floats where [`battery_site`] puts it, and the rock's well is gone
    /// from the sum. *T22.18: was "at the centre"* — this core is hollowed from the
    /// inside, a cavity sealed all round, so no body can get to the centre and the
    /// battery goes to the nearest place one can (the tunnel cases are
    /// `a_core_shot_out_through_narrow_tunnels_leaves_its_battery_where_a_body_reaches`).
    #[test]
    fn a_carved_core_switches_the_well_off_crumbles_and_drops_one_battery() {
        let mut w = space_world(4242);
        let (i, a) = largest(&w);
        let centre = Vec2::new(a.x as f32, a.y as f32);
        let band = centre - Vec2::new(0.0, well_reach(&a, centre - Vec2::new(0.0, 1.0)) - 1.0);
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
                assert!(
                    batteries(&ev).is_empty(),
                    "k {k}: a battery under the threshold"
                );
                assert_eq!(wells(&w), 1, "k {k}: the well went under the threshold");
                continue;
            }
            assert!(!rock.core_intact, "k {k}: over the threshold, still intact");
            assert_eq!(destroyed_events(&ev), vec![(a.x, a.y)]);
            assert_eq!(
                batteries(&ev),
                vec![battery_site(&w.map.mask, &a)],
                "exactly one battery, where a body can reach it"
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
        assert!(destroyed_events(&ev).is_empty() && batteries(&ev).is_empty());
    }

    /// Every body centre connected to open air by body-fitting one-pixel moves, within
    /// `half` of `(cx, cy)` — **the oracle for [`battery_site`], written the other
    /// way**: `collide::aabb_overlaps_solid` on the live map (the predicate movement
    /// uses) instead of a summed-area table, flooded from far outside the rock.
    fn reachable(map: &crate::map::Map, cx: i32, cy: i32, half: i32) -> Vec<(i32, i32)> {
        use crate::physics::{body::Body, collide::aabb_overlaps_solid};
        let fits = |x: i32, y: i32| {
            !aabb_overlaps_solid(map, Body::new(Vec2::new(x as f32, y as f32)).aabb())
        };
        let side = (2 * half + 1) as usize;
        let mut seen = vec![false; side * side];
        let start = (cx - half, cy - half);
        assert!(
            fits(start.0, start.1),
            "premise: the window's corner is open space"
        );
        let mut stack = vec![start];
        seen[0] = true;
        let mut out = Vec::new();
        while let Some((x, y)) = stack.pop() {
            out.push((x, y));
            for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
                let (i, j) = (nx - cx + half, ny - cy + half);
                if i < 0 || j < 0 || i >= side as i32 || j >= side as i32 {
                    continue;
                }
                let k = j as usize * side + i as usize;
                if !seen[k] && fits(nx, ny) {
                    seen[k] = true;
                    stack.push((nx, ny));
                }
            }
        }
        out
    }

    /// **T22.18 (from T22.16's review): a core shot out through tunnels narrower than
    /// a body leaves its battery where a body can get to it.** On the largest rock of
    /// three maps, straight tunnels an SMG crater wide (`SMG_BLAST_RADIUS`) are shot
    /// through the rock, crater by crater, until the core counts destroyed. Then:
    /// - **the premise** — the independent flood ([`reachable`], on the production
    ///   collision predicate) finds **no** body centre within `PICKUP_RADIUS` of the
    ///   centre: R102's "at the core's centre" would be bait nobody can take;
    /// - the battery spawned is one the flood reaches (a body can stand on it — pickup
    ///   distance 0), and **a player put there takes it** on the next tick (the
    ///   effect, through `resolve_pickups`);
    /// - **the control arm**: the same rock tunnelled a body wide (a shovel's
    ///   capsule, `PLAYER_W` across plus a pixel each side) keeps R102's placement —
    ///   the battery is exactly at the centre, which the flood reaches.
    #[test]
    fn a_core_shot_out_through_narrow_tunnels_leaves_its_battery_where_a_body_reaches() {
        use crate::constants::{PICKUP_RADIUS, SMG_BLAST_RADIUS};
        for seed in [4242u64, 7, 99] {
            for wide in [false, true] {
                let mut w = space_world(seed);
                w.add_player(0, 0, "ana".into());
                let (_, a) = largest(&w);
                let centre = Vec2::new(a.x as f32, a.y as f32);
                let half = a.r + PLAYER_H as i32;
                let _ = w.drain_events();
                let radius = if wide {
                    (PLAYER_W / 2.0) as i32 + 1
                } else {
                    SMG_BLAST_RADIUS.round() as i32
                };
                // Straight through the rock from just outside its bounding circle, a
                // crater a tick, top to bottom and then left to right — one tunnel is
                // ~10 % of the core, two crossing ones are past the threshold.
                let span = a.r + 2;
                let path = (-span..=span)
                    .step_by(2)
                    .map(|d| (a.x, a.y + d))
                    .chain((-span..=span).step_by(2).map(|d| (a.x + d, a.y)));
                let mut destroyed = false;
                for (x, y) in path {
                    let _ = w.map.carve_circle(x, y, radius);
                    w.step(SIM_DT);
                    let ev = w.drain_events();
                    if !destroyed_events(&ev).is_empty() {
                        destroyed = true;
                        let got = batteries(&ev);
                        assert_eq!(got.len(), 1, "seed {seed} wide {wide}: one battery");
                        let site = got[0];
                        let reach = reachable(&w.map, a.x, a.y, half);
                        let near_centre = reach.iter().any(|&(x, y)| {
                            (Vec2::new(x as f32, y as f32) - centre).len() <= PICKUP_RADIUS
                        });
                        if wide {
                            assert!(near_centre, "seed {seed}: control — the shaft reaches");
                            assert_eq!(site, centre, "seed {seed}: a reachable core moved");
                        } else {
                            assert!(
                                !near_centre,
                                "seed {seed}: premise — a body reaches the centre through \
                                 a {radius} px tunnel"
                            );
                            assert!(
                                reach.contains(&(site.x as i32, site.y as i32)),
                                "seed {seed}: the battery at {site:?} is where no body can get"
                            );
                            assert!(w.player(0).expect("ana").alive, "premise: ana is alive");
                            let p = w.player_mut(0).expect("ana");
                            p.body = crate::physics::body::Body::new(site);
                            let before = p.batteries;
                            w.step(SIM_DT);
                            assert_eq!(
                                w.player(0).expect("ana").batteries,
                                before + 1,
                                "seed {seed}: a body on the battery's site did not take it"
                            );
                            eprintln!(
                                "seed {seed}: r {} core {} — battery {:.1} px from the centre",
                                a.r,
                                core_radius(&a),
                                (site - centre).len()
                            );
                        }
                        break;
                    }
                }
                assert!(
                    destroyed,
                    "seed {seed} wide {wide}: the tunnel never destroyed the core"
                );
            }
        }
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
