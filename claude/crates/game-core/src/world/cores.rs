//! T22.16 — **asteroid cores** (`M22-OWNER-ROUND-2` R102). The owner: *"when an
//! 'asterodid' is destroyed (make like a round core at the center) its gravity pull
//! disappears, a battery is spawned when its destroyed."*
//!
//! - **The core** is a disc at the rock's centre, [`core_radius`] =
//!   `round(SPACE_CORE_FRAC · r)` — the generator stamps it solid (it is inside the
//!   rock's round body, `SPACE_ASTEROID_CORE_FRAC · r`), the client draws it in its
//!   own colour (`render/chunkBake.ts`), and it refuses every carve until its
//!   `CORE_HITS`-th hit.
//! - **Destroyed** ([`core_destroyed`]) on its `CORE_HITS`-th hit (R112, T22.21): a
//!   hit is one carve whose hardened disc overlaps the core, counted by the carve
//!   itself (`Map::strike_cores`) — the one truth both sides carve. Until then the
//!   core's pixels are uncarvable, so no cavity can hold the centre while the well
//!   is on (refinement A, which `SPACE_CORE_DESTROYED_FRAC`'s arithmetic used to
//!   buy; T22.16's carved-fraction rule is retired with that constant).
//! - **Then, once, on the server** ([`World::step_cores`]): the rock's
//!   `core_intact` goes false for the round (its well is gone — `asteroid_attractors`
//!   skips it), `core_destroyed` goes out with the tick, what is left of the core
//!   crumbles (one ordinary `Carve`, so the drawn core disappears whole and the centre
//!   is air), and **one battery pack** floats at the centre through the wildlife
//!   drop — an ordinary world item, on the wire and picked up like any other.
//! - **The black hole eating a rock is not a destruction**: `arrive_black_hole`
//!   removes the rock from the list before it carves it, and this step only reads the
//!   list.

use crate::constants::CORE_HITS;
use crate::map::meta::Asteroid;
use crate::map::Mask;
use crate::math::{isqrt, Vec2};
use crate::world::{CarveKind, GameEvent, World};

/// The core's radius, px: `round(SPACE_CORE_FRAC · r)` — 7 on the smallest rock, 21
/// on the largest.
pub fn core_radius(a: &Asteroid) -> i32 {
    a.core_r()
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

/// **Is `a`'s core destroyed?** It has taken [`CORE_HITS`] hits (R112). Never on an
/// iron asteroid, which has no core (R113).
pub fn core_destroyed(a: &Asteroid) -> bool {
    !a.iron && a.core_hits >= CORE_HITS
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
            if !a.core_intact || !core_destroyed(&a) {
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
            // stream the client's mask already follows. A destroyed core's disc is
            // not hardened (R111), so this core-sized carve takes all of it.
            let r = core_radius(&a);
            let carve = self.map.carve_circle(a.x, a.y, r);
            self.publish_carve(&carve, a.x, a.y, r, CarveKind::Meteor);
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
    };
    use crate::items::registry::BATTERY_PACK;
    use crate::world::attractors::asteroid_attractors;
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
            // An iron rock (R113) is bigger and has no core.
            .filter(|(_, a)| !a.iron)
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

    /// **R112 (T22.21): the core takes exactly `CORE_HITS` hits, end to end.** On a
    /// real space world the largest rock's core is struck at its centre by a carve
    /// whose hardened disc (R111) is the core's own — through `World::step` after each:
    /// - **before the last hit** (the absence arm): the hit is counted, the carve did
    ///   bite (it removed rock around the core — the presence control in the same
    ///   carve), but **every core pixel is still solid**, the flag is up, no event, no
    ///   battery, and the well is still summed;
    /// - **on the last hit**, on that tick: the flag goes false, one `core_destroyed`
    ///   with the rock's centre, the core crumbles whole, **exactly one** battery pack
    ///   where [`battery_site`] puts it, and the well is gone from the sum;
    /// - and never again: more carving brings no second event or battery.
    ///
    /// Falsified at the live site: `CORE_HITS` 3 → 2 fails the absence arm at hit 2;
    /// the locked-core guard removed from `map::carve` fails it at hit 1.
    #[test]
    fn a_core_takes_exactly_core_hits_hits_and_the_last_destroys_it() {
        let mut w = space_world(4242);
        let (i, a) = largest(&w);
        let centre = Vec2::new(a.x as f32, a.y as f32);
        let wells = |w: &World| {
            asteroid_attractors(&w.map)
                .filter(|x| x.pos == centre)
                .count()
        };
        assert_eq!(wells(&w), 1, "premise: the rock's well is in the sum");
        let _ = w.drain_events();
        let c = core_radius(&a);
        let (solid0, total) = core_pixels(&w.map.mask, &a);
        assert_eq!(solid0, total, "premise: the core is whole");
        // A carve whose hardened disc is the core plus a ring of rock around it.
        let r = 2 * (c + 4);
        assert_eq!(crate::map::carve::hard_radius(r), c + 4);
        for k in 1..=CORE_HITS {
            let carve = w.map.carve_circle(a.x, a.y, r);
            assert!(carve.core_hit, "hit {k}: not counted as a hit");
            w.step(SIM_DT);
            let ev = w.drain_events();
            let rock = w.map.meta.asteroids[i];
            if k < CORE_HITS {
                assert_eq!(rock.core_hits, k, "hit {k}: the count");
                if k == 1 {
                    assert!(
                        carve.pixels_removed > 0,
                        "control: the first hit removed no rock at all"
                    );
                }
                assert_eq!(
                    core_pixels(&w.map.mask, &a).0,
                    total,
                    "hit {k} of {CORE_HITS}: a core pixel was carved"
                );
                assert!(rock.core_intact, "hit {k}: destroyed early");
                assert!(destroyed_events(&ev).is_empty(), "hit {k}: an event early");
                assert!(batteries(&ev).is_empty(), "hit {k}: a battery early");
                assert_eq!(wells(&w), 1, "hit {k}: the well went early");
                continue;
            }
            assert!(!rock.core_intact, "hit {k}: the last hit left it intact");
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
        }
        let _ = w.map.carve_circle(a.x, a.y, r);
        for _ in 0..10 {
            w.step(SIM_DT);
        }
        let ev = w.drain_events();
        assert!(destroyed_events(&ev).is_empty() && batteries(&ev).is_empty());
    }

    /// **What a hit is** (R112): a carve whose hardened disc reaches the core's disc —
    /// one pixel short is not a hit and one pixel nearer is. A capsule through the
    /// core is **one** hit however many discs it stamps, and an iron rock (no core)
    /// is never hit.
    #[test]
    fn a_hit_is_a_hardened_disc_that_reaches_the_core_and_a_capsule_is_one() {
        let w = space_world(4242);
        let (i, a) = largest(&w);
        let c = core_radius(&a);
        // The narrowest carve that counts at all (R112b, T22.22B).
        let r = crate::constants::CORE_HIT_MIN_R as i32;
        let rh = crate::map::carve::hard_radius(r);
        for (d, hit) in [(c + rh + 1, false), (c + rh, true)] {
            let mut m = w.map.clone();
            let res = m.carve_circle(a.x + d, a.y, r);
            assert_eq!(res.core_hit, hit, "a carve {d} px from the centre");
            assert_eq!(m.meta.asteroids[i].core_hits, u8::from(hit));
        }
        let mut m = w.map.clone();
        let res = m.carve_capsule(a.x - a.r, a.y, a.x + a.r, a.y, r);
        assert!(res.core_hit);
        assert_eq!(
            m.meta.asteroids[i].core_hits, 1,
            "a capsule counted per stamp"
        );
        let mut iron = w.map.meta.asteroids[i];
        iron.iron = true;
        assert!(!core_destroyed(&Asteroid {
            core_hits: CORE_HITS,
            ..iron
        }));
        assert!(core_destroyed(&Asteroid {
            core_hits: CORE_HITS,
            ..a
        }));
    }

    /// The largest ordinary rock of `space_world(seed)` with **everything but its core
    /// dug away** — the core a bare disc in a hollow, every core pixel solid, nothing else
    /// of the rock left — and the events of the digging drained. What a player finds
    /// after tunnelling to the centre, without the tunnelling.
    fn exposed_core(seed: u64) -> (World, usize, Asteroid) {
        let mut w = space_world(seed);
        let (i, a) = largest(&w);
        let _ = w
            .map
            .carve_unguarded(a.x, a.y, a.r + crate::map::carve::ROCK_GUARD_MARGIN);
        let _ = w.map.fill_circle(a.x, a.y, core_radius(&a));
        let (solid, total) = core_pixels(&w.map.mask, &a);
        assert_eq!(solid, total, "premise: the core is whole");
        let _ = w.drain_events();
        (w, i, a)
    }

    /// What a client's mirror does with the carve stream (`game-wasm`'s `carve` /
    /// `carve_capsule`): the same public carves, on its own copy, in order.
    fn mirror_follows(m: &mut crate::map::Map, events: &[GameEvent]) {
        for e in events {
            match *e {
                GameEvent::Carve { x, y, r, .. } => {
                    let _ = m.carve_circle(x, y, r);
                }
                GameEvent::CarveCapsule {
                    x0, y0, x1, y1, r, ..
                } => {
                    let _ = m.carve_capsule(x0, y0, x1, y1, r);
                }
                _ => {}
            }
        }
    }

    fn carves_at(events: &[GameEvent], at: (i32, i32)) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, GameEvent::Carve { x, y, .. } if (*x, *y) == at))
            .count()
    }

    /// **R112b (T22.22B): three SMG rounds on an exposed core are no hit; three
    /// bazookas destroy it** — both through `World::land_on_terrain_for_test` (the
    /// bullet path and the blast path, as a real round lands them), on the same spot one
    /// pixel off the core's surface, where the SMG's hardened disc **does** reach the
    /// core (the premise: at T22.21 each round was a hit). Absence arm: after three SMG
    /// rounds, no hit counted, every core pixel solid, no event, no battery. Presence
    /// arm, the same spot: bazookas 1–2 count and change no pixel, the third destroys.
    ///
    /// **And T22.22B F1 — a hit that moves no pixel still reaches the client.** Each of
    /// bazookas 1–2 removes **0** pixels (the core refuses them and nothing else is
    /// left), and still: a carve event goes out at the impact, and a mirror fed **only
    /// the drained events** (a copy of the map taken after the digging, `mirror_follows`)
    /// counts the same hits, and at the end holds the same mask and the same count.
    ///
    /// Falsified at the live site: `CORE_HIT_MIN_R`'s predicate removed from
    /// `strike_cores` fails the SMG arm at round 1; `emit_blast` skipping a carve that
    /// removed no pixel fails the event arm at bazooka 1.
    #[test]
    fn three_smg_rounds_on_an_exposed_core_are_no_hit_and_three_bazookas_destroy_it() {
        use crate::constants::{BAZOOKA_BLAST_RADIUS, SMG_BLAST_RADIUS};
        use crate::items::registry::{WEAPON_BAZOOKA, WEAPON_SMG};
        use crate::map::carve::hard_radius;
        let (mut w, i, a) = exposed_core(4242);
        let mut mirror = w.map.clone();
        let c = core_radius(&a);
        let spot = (a.x + c + 1, a.y);
        let at = Vec2::new(spot.0 as f32, spot.1 as f32);
        assert!(
            spot.0 - a.x <= hard_radius(SMG_BLAST_RADIUS.round() as i32) + c,
            "premise: the SMG's hardened disc reaches the core from here"
        );
        let total = core_pixels(&w.map.mask, &a).1;
        let mut now = w.round_time;
        for k in 1..=3 {
            w.land_on_terrain_for_test(at, WEAPON_SMG, now);
            w.step(SIM_DT);
            now = w.round_time;
            let ev = w.drain_events();
            mirror_follows(&mut mirror, &ev);
            let rock = w.map.meta.asteroids[i];
            assert_eq!(rock.core_hits, 0, "SMG round {k} counted as a core hit");
            assert_eq!(
                core_pixels(&w.map.mask, &a).0,
                total,
                "SMG round {k}: a core pixel"
            );
            assert!(destroyed_events(&ev).is_empty() && batteries(&ev).is_empty());
        }
        assert_eq!(mirror.meta.asteroids[i].core_hits, 0);

        let r = BAZOOKA_BLAST_RADIUS.round() as i32;
        assert!(
            spot.0 - a.x <= hard_radius(r) + c,
            "premise: the bazooka reaches the core"
        );
        for k in 1..=CORE_HITS {
            let before = w.map.mask.count_solid();
            w.land_on_terrain_for_test(at, WEAPON_BAZOOKA, now);
            let moved = before - w.map.mask.count_solid();
            w.step(SIM_DT);
            now = w.round_time;
            let ev = w.drain_events();
            mirror_follows(&mut mirror, &ev);
            let rock = w.map.meta.asteroids[i];
            assert_eq!(rock.core_hits, k, "bazooka {k}: the count");
            assert_eq!(
                mirror.meta.asteroids[i].core_hits, k,
                "bazooka {k}: the mirror, fed only the drained events, counts a different hit"
            );
            if k < CORE_HITS {
                assert_eq!(moved, 0, "premise: bazooka {k} moved no pixel");
                assert_eq!(
                    carves_at(&ev, spot),
                    1,
                    "bazooka {k}: a hit that moved no pixel sent no carve event"
                );
                assert!(rock.core_intact && destroyed_events(&ev).is_empty());
                continue;
            }
            assert!(!rock.core_intact, "the third bazooka left the core intact");
            assert_eq!(destroyed_events(&ev), vec![(a.x, a.y)]);
            assert_eq!(batteries(&ev).len(), 1, "exactly one battery");
        }
        assert_eq!(
            core_pixels(&w.map.mask, &a).0,
            0,
            "the core did not crumble"
        );
        assert!(
            mirror.mask == w.map.mask,
            "the mirror's mask is not the server's after the core went"
        );
    }

    /// **T22.22B F1: `World::publish_carve` — the five skip-if-empty sites' one guard —
    /// sends a carve that counted a core hit and moved no pixel.** Presence: a zero-pixel
    /// hit and a pixel with no hit both go out, each with the next sequence number.
    /// Absence: an empty carve with no hit does not. (No production site can hand it a
    /// hit since R112b — every one of the five carves under `CORE_HIT_MIN_R`, or carves
    /// a rock already off the list — so this is the guard's own test; the blast path's
    /// end-to-end twin is the bazooka arm above.)
    ///
    /// Falsified at the live site: `carve.changed()` → `carve.pixels_removed > 0` in
    /// `publish_carve` fails the first arm.
    #[test]
    fn publish_carve_sends_a_hit_that_moved_no_pixel() {
        use crate::map::CarveResult;
        let mut w = space_world(4242);
        let _ = w.drain_events();
        let hit = CarveResult {
            core_hit: true,
            ..Default::default()
        };
        let bite = CarveResult {
            pixels_removed: 1,
            ..Default::default()
        };
        let seq0 = w.carve_seq;
        assert!(w.publish_carve(&hit, 10, 20, 42, CarveKind::Weapon));
        assert!(!w.publish_carve(&CarveResult::default(), 30, 40, 3, CarveKind::Weapon));
        assert!(w.publish_carve(&bite, 50, 60, 3, CarveKind::Weapon));
        let ev = w.drain_events();
        let seqs: Vec<(u32, i32)> = ev
            .iter()
            .filter_map(|e| match e {
                GameEvent::Carve { seq, x, .. } => Some((*seq, *x)),
                _ => None,
            })
            .collect();
        assert_eq!(
            seqs,
            vec![(seq0 + 1, 10), (seq0 + 2, 50)],
            "a zero-pixel core hit must go out, an empty carve must not"
        );
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
                // Rock bites at half the radius since R111 (T22.21), so the wide arm
                // carves at twice a body-wide tunnel's radius to dig one.
                let radius = if wide {
                    2 * ((PLAYER_W / 2.0) as i32 + 1)
                } else {
                    SMG_BLAST_RADIUS.round() as i32
                };
                // Straight through the rock from just outside its bounding circle,
                // top to bottom and then left to right. *Since R112 (T22.21)* the
                // core refuses the craters until its third hit and is destroyed on
                // it — when the first tunnel has only just reached it — so the whole
                // of both tunnels is dug before the step that destroys it: the shape
                // this test is about is the finished tunnels', not the third crater's.
                let span = a.r + 2;
                let path = (-span..=span)
                    .step_by(2)
                    .map(|d| (a.x, a.y + d))
                    .chain((-span..=span).step_by(2).map(|d| (a.x + d, a.y)));
                let mut destroyed = false;
                for (x, y) in path {
                    let _ = w.map.carve_circle(x, y, radius);
                }
                // *Since R112b (T22.22B)* no tunnel crater is a hit, however many: the
                // core goes to `CORE_HITS` blasts at its centre, whose hardened disc is
                // inside the core (asserted) — so what is left is the tunnels plus the
                // core's own crumble, the shape this test is about.
                let blast = crate::constants::CORE_HIT_MIN_R as i32;
                assert!(crate::map::carve::hard_radius(blast) <= core_radius(&a));
                for _ in 0..CORE_HITS {
                    let _ = w.map.carve_circle(a.x, a.y, blast);
                }
                {
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
            for _ in 0..CORE_HITS {
                let _ = w
                    .map
                    .carve_circle(a.x, a.y, crate::constants::CORE_HIT_MIN_R as i32);
            }
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
        // R112/R113 (T22.21): the hit count and the substance are hashed too.
        one.map.meta.asteroids[i].core_intact = false;
        assert_eq!(one.state_hash(), two.state_hash(), "premise: restored");
        one.map.meta.asteroids[i].core_hits -= 1;
        assert_ne!(
            one.state_hash(),
            two.state_hash(),
            "the hits are not hashed"
        );
        one.map.meta.asteroids[i].core_hits += 1;
        one.map.meta.asteroids[i].iron = true;
        assert_ne!(one.state_hash(), two.state_hash(), "iron is not hashed");
    }
}
