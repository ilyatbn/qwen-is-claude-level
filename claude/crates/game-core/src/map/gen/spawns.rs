//! Pass 8: spawn point selection.
//!
//! Farthest-point sampling rather than random rejection sampling. Random placement
//! clusters, and clustered spawns mean two players start in each other's faces
//! while a third of the map is empty.
//!
//! See `docs/10-map-generation.md` §Pass 8.

use crate::constants::{SPAWN_COUNT_MIN, SPAWN_MIN_SEPARATION, SPAWN_WALK_CLEARANCE};
use crate::map::gen::surface::is_standable;
use crate::map::Mask;
use crate::math::Point;
use crate::rng::{range_i32, substream};

/// How many times the separation may be relaxed before giving up on it.
const MAX_RELAXATIONS: u32 = 3;
/// Each relaxation keeps this much of the previous separation.
const RELAX_FACTOR: f32 = 0.75;

/// Choose well-separated spawn points from the traversable component.
///
/// `component` holds indices into `surface`. Points are returned in **selection
/// order**, which is itself meaningful and reproducible — do not sort them.
pub fn choose_spawns(
    mask: &Mask,
    surface: &[Point],
    component: &[usize],
    seed: u64,
    count: usize,
) -> Vec<Point> {
    if count == 0 || component.is_empty() {
        return Vec::new();
    }

    let all: Vec<Point> = component
        .iter()
        .filter_map(|&i| surface.get(i).copied())
        .collect();
    if all.is_empty() {
        return Vec::new();
    }

    // Prefer somewhere you can **walk**, not merely stand.
    //
    // `is_standable` says a body fits; it says nothing about being able to leave.
    // A spawn wedged in a crevice or hard against a cliff lets you stand, aim and
    // fire and not move, which a player reads as the controls being broken —
    // measured in the browser as "held D and moved 0 px", twice, about spawns that
    // were perfectly legal.
    //
    // A **preference**, not a filter: a map whose traversable component is all
    // ledges would otherwise return nothing at all, and a cramped spawn beats no
    // spawn. The fallback is the unfiltered set, and `spawns_prefer_walkable_ground`
    // is the test that this is doing anything at all.
    let roomy: Vec<Point> = all
        .iter()
        .copied()
        .filter(|p| walkable_both_ways(mask, *p))
        .collect();
    let want = count.min(SPAWN_COUNT_MIN);

    let mut rng = substream(seed, "spawns");

    // Try the roomy set; fall back to the whole component if it cannot fill the
    // quota. **Count-based, not size-based**: 40 roomy points clustered in one
    // corner pass any "are there enough candidates" test and still only yield
    // five well-separated spawns — measured, on seed 0.
    if roomy.len() >= want {
        let first = range_i32(&mut rng, 0, roomy.len() as i32 - 1) as usize;
        let chosen = pick(&roomy, first, count);
        if chosen.len() >= want {
            return chosen;
        }
    }
    let first = range_i32(&mut rng, 0, all.len() as i32 - 1) as usize;
    pick(&all, first, count)
}

/// Farthest-point sampling with relaxation.
///
/// Relaxing beats returning fewer than `SPAWN_COUNT_MIN`: on a small map, or one
/// whose traversable component is a narrow strip, a slightly tighter set of six
/// is better than four well-spread ones.
fn pick(candidates: &[Point], first: usize, count: usize) -> Vec<Point> {
    let mut separation = SPAWN_MIN_SEPARATION;
    let mut best: Vec<Point> = Vec::new();

    for _ in 0..=MAX_RELAXATIONS {
        let chosen = sample(candidates, first, count, separation);
        if chosen.len() > best.len() {
            best = chosen;
        }
        if best.len() >= count.min(SPAWN_COUNT_MIN) {
            break;
        }
        separation *= RELAX_FACTOR;
    }

    best
}

/// Standable ground `SPAWN_WALK_CLEARANCE` px to the left **and** to the right.
///
/// Both, not either: a ledge you can only leave one way is still a place a player
/// walks into a wall from. Sampled every 8 px rather than every pixel — the gap
/// this is looking for is tens of pixels wide, and `is_standable` is not cheap.
fn walkable_both_ways(mask: &Mask, p: Point) -> bool {
    let step = 8;
    for dir in [-1, 1] {
        let mut ok = false;
        let mut d = step;
        while d <= SPAWN_WALK_CLEARANCE {
            // Allow for a slope: the ground either side is rarely at the same y.
            ok = (-step..=step).any(|dy| is_standable(mask, p.x + dir * d, p.y + dy));
            if !ok {
                break;
            }
            d += step;
        }
        if !ok {
            return false;
        }
    }
    true
}

/// Farthest-point sampling: repeatedly take the candidate whose distance to its
/// nearest already-chosen point is greatest, while that distance clears `separation`.
fn sample(candidates: &[Point], first: usize, count: usize, separation: f32) -> Vec<Point> {
    let sep_sq = (separation * separation) as i64;
    let mut chosen = Vec::with_capacity(count);
    chosen.push(candidates[first]);

    // Distance from each candidate to the nearest chosen point, maintained
    // incrementally: O(n·k) overall, with k = 6.
    let mut nearest: Vec<i64> = candidates
        .iter()
        .map(|c| c.distance_sq(candidates[first]))
        .collect();

    while chosen.len() < count {
        let mut best_i = None;
        let mut best_d = -1i64;
        for (i, &d) in nearest.iter().enumerate() {
            if d > best_d {
                best_d = d;
                best_i = Some(i);
            }
        }
        let Some(i) = best_i else { break };
        if best_d < sep_sq {
            break; // nothing left far enough away
        }

        chosen.push(candidates[i]);
        for (j, c) in candidates.iter().enumerate() {
            let d = c.distance_sq(candidates[i]);
            if d < nearest[j] {
                nearest[j] = d;
            }
        }
    }

    chosen
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::generate_terrain;

    /// A long flat floor: `n` points spaced `step` apart, and the mask that
    /// actually has that floor in it.
    ///
    /// The mask is not decoration. `choose_spawns` prefers points with walkable
    /// ground either side, so a fixture that passed an empty mask would exercise
    /// only the fallback and every assertion below would be about the branch
    /// nobody takes.
    fn flat(n: usize, step: i32) -> (Mask, Vec<Point>, Vec<usize>) {
        // Rounded up to `CHUNK_SIZE`, which `Mask::new_empty` requires.
        let cs = crate::constants::CHUNK_SIZE;
        let w = ((n as u32 * step as u32 + 64).max(cs)).div_ceil(cs) * cs;
        let h = 768u32;
        let mut mask = Mask::new_empty(w, h);
        for y in 501..h as i32 {
            mask.set_run(y, 0, w as i32 - 1);
        }
        let surface: Vec<Point> = (0..n).map(|i| Point::new(i as i32 * step, 500)).collect();
        let component: Vec<usize> = (0..n).collect();
        (mask, surface, component)
    }

    #[test]
    fn determinism() {
        let (mask, surface, component) = flat(200, 16);
        let first = choose_spawns(&mask, &surface, &component, 4242, 6);
        for _ in 0..20 {
            assert_eq!(choose_spawns(&mask, &surface, &component, 4242, 6), first);
        }
    }

    #[test]
    fn six_spawns_on_a_long_floor_are_well_separated() {
        let (mask, surface, component) = flat(200, 16); // 3184 px long
        let spawns = choose_spawns(&mask, &surface, &component, 1, 6);
        assert_eq!(spawns.len(), 6);
        for (i, a) in spawns.iter().enumerate() {
            for b in &spawns[i + 1..] {
                let d = (a.distance_sq(*b) as f64).sqrt();
                assert!(
                    d >= SPAWN_MIN_SEPARATION as f64,
                    "spawns {a:?} and {b:?} are only {d:.0} px apart"
                );
            }
        }
    }

    #[test]
    fn every_spawn_comes_from_the_supplied_component() {
        let (mask, surface, _) = flat(100, 16);
        // Only the second half is traversable.
        let component: Vec<usize> = (50..100).collect();
        let spawns = choose_spawns(&mask, &surface, &component, 7, 6);
        assert!(!spawns.is_empty());
        for s in &spawns {
            assert!(
                s.x >= 50 * 16,
                "spawn {s:?} came from outside the component"
            );
            assert!(surface.contains(s));
        }
    }

    #[test]
    fn spread_quality_proves_farthest_point_sampling() {
        // The assertion that actually distinguishes farthest-point sampling from
        // random rejection: with 6 points on a floor of length L the best possible
        // minimum pairwise distance is L/5, and we must reach 60% of it.
        let (mask, surface, component) = flat(200, 16);
        let floor_len = 199.0 * 16.0;
        let spawns = choose_spawns(&mask, &surface, &component, 3, 6);
        assert_eq!(spawns.len(), 6);

        let mut min_d = f64::MAX;
        for (i, a) in spawns.iter().enumerate() {
            for b in &spawns[i + 1..] {
                min_d = min_d.min((a.distance_sq(*b) as f64).sqrt());
            }
        }
        let theoretical = floor_len / 5.0;
        assert!(
            min_d >= theoretical * 0.6,
            "min pairwise {min_d:.0} px is under 60% of the theoretical {theoretical:.0}"
        );
    }

    #[test]
    fn a_tiny_clustered_component_returns_what_it_can() {
        let (mask, _, _) = flat(10, 16);
        let surface = vec![
            Point::new(100, 500),
            Point::new(110, 500),
            Point::new(120, 500),
        ];
        let component = vec![0, 1, 2];
        let spawns = choose_spawns(&mask, &surface, &component, 5, 6);
        // Relaxation lets it take more than one, but it must never invent points
        // or loop forever.
        assert!(!spawns.is_empty() && spawns.len() <= 3);
    }

    #[test]
    fn degenerate_inputs_return_empty_without_panicking() {
        let (mask, surface, component) = flat(10, 16);
        assert!(choose_spawns(&mask, &surface, &component, 1, 0).is_empty());
        assert!(choose_spawns(&mask, &surface, &[], 1, 6).is_empty());
        assert!(choose_spawns(&mask, &[], &[], 1, 6).is_empty());
        // Indices that do not exist in `surface` are ignored, not indexed.
        assert!(choose_spawns(&mask, &surface, &[99, 100], 1, 6).is_empty());
    }

    #[test]
    fn selection_order_is_preserved_not_sorted() {
        let (mask, surface, component) = flat(200, 16);
        let spawns = choose_spawns(&mask, &surface, &component, 11, 6);
        let mut sorted = spawns.clone();
        sorted.sort_by_key(|p| (p.x, p.y));
        assert_ne!(
            spawns, sorted,
            "farthest-point order should not coincidentally be sorted"
        );
    }

    /// The preference does something, and the fallback still works.
    ///
    /// A floor with a **slot** in it: one standable point with walls either side,
    /// and a long flat run elsewhere. The slot is legal — a body fits — and it is
    /// somewhere a player would hold D and not move, which is what two browser
    /// checks reported before this existed.
    #[test]
    fn spawns_prefer_walkable_ground_over_a_slot_you_cannot_leave() {
        let cs = crate::constants::CHUNK_SIZE;
        let (w, h) = (cs * 8, cs * 3);
        let mut mask = Mask::new_empty(w, h);
        // A floor across the whole map...
        for y in 501..h as i32 {
            mask.set_run(y, 0, w as i32 - 1);
        }
        // ...and a one-body-wide slot at x = 300: two pillars, and nothing else.
        //
        // Narrow pillars, not "everything either side": filling the rest of the
        // map to the slot's height puts a roof over the open floor too, and
        // `is_standable` then reports there is nowhere to stand anywhere — which
        // is a fixture with no control in it.
        let slot = 300;
        for y in 400..501 {
            mask.set_run(y, slot - 44, slot - 12);
            mask.set_run(y, slot + 12, slot + 44);
        }

        let inside = Point::new(slot, 500);
        assert!(
            is_standable(&mask, inside.x, inside.y),
            "the fixture's slot is not standable, so it is not the case this is about",
        );
        assert!(
            !walkable_both_ways(&mask, inside),
            "the fixture's slot has walking room, so it is not a slot",
        );

        // Open floor is only past the walls, where the ceiling stops.
        let open: Vec<Point> = (0..40)
            .map(|i| Point::new(600 + i * 24, 500))
            .filter(|p| is_standable(&mask, p.x, p.y))
            .collect();
        assert!(
            open.len() >= 6,
            "the fixture has nowhere walkable to prefer"
        );

        let mut surface = vec![inside];
        surface.extend(open);
        let component: Vec<usize> = (0..surface.len()).collect();

        let spawns = choose_spawns(&mask, &surface, &component, 4242, 6);
        assert!(!spawns.is_empty());
        assert!(
            !spawns.contains(&inside),
            "a spawn was placed in the slot with {} walkable points available",
            surface.len() - 1,
        );

        // The fallback: with **only** the slot to choose from, it is still used —
        // a cramped spawn beats no spawn, and a filter here would return nothing.
        let only = choose_spawns(&mask, &[inside], &[0], 4242, 6);
        assert_eq!(only, vec![inside], "the fallback returned nothing at all");
    }

    #[test]
    fn real_maps_always_yield_enough_spawns() {
        for seed in 0..20u64 {
            let o = generate_terrain(seed * 977 + 5, MapScale::Medium);
            let spawns = choose_spawns(&o.mask, &o.surface, &o.report.largest_component, o.seed, 6);
            assert!(
                spawns.len() >= SPAWN_COUNT_MIN,
                "seed {seed}: only {} spawns (fraction {:.3})",
                spawns.len(),
                o.report.traversable_fraction
            );
        }
    }
}
