//! Pass 8: spawn point selection.
//!
//! Farthest-point sampling rather than random rejection sampling. Random placement
//! clusters, and clustered spawns mean two players start in each other's faces
//! while a third of the map is empty.
//!
//! See `docs/10-map-generation.md` §Pass 8.

use crate::constants::{SPAWN_COUNT_MIN, SPAWN_MIN_SEPARATION};
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
    surface: &[Point],
    component: &[usize],
    seed: u64,
    count: usize,
) -> Vec<Point> {
    if count == 0 || component.is_empty() {
        return Vec::new();
    }

    let candidates: Vec<Point> = component
        .iter()
        .filter_map(|&i| surface.get(i).copied())
        .collect();
    if candidates.is_empty() {
        return Vec::new();
    }

    let mut rng = substream(seed, "spawns");
    let first = range_i32(&mut rng, 0, candidates.len() as i32 - 1) as usize;

    // Relaxing beats returning fewer than SPAWN_COUNT_MIN: on a small map, or one
    // whose traversable component is a narrow strip, a slightly tighter set of six
    // is better than four well-spread ones.
    let mut separation = SPAWN_MIN_SEPARATION;
    let mut best: Vec<Point> = Vec::new();

    for _ in 0..=MAX_RELAXATIONS {
        let chosen = sample(&candidates, first, count, separation);
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

    /// A long flat floor: `n` points spaced `step` apart.
    fn flat(n: usize, step: i32) -> (Vec<Point>, Vec<usize>) {
        let surface: Vec<Point> = (0..n).map(|i| Point::new(i as i32 * step, 500)).collect();
        let component: Vec<usize> = (0..n).collect();
        (surface, component)
    }

    #[test]
    fn determinism() {
        let (surface, component) = flat(200, 16);
        let first = choose_spawns(&surface, &component, 4242, 6);
        for _ in 0..20 {
            assert_eq!(choose_spawns(&surface, &component, 4242, 6), first);
        }
    }

    #[test]
    fn six_spawns_on_a_long_floor_are_well_separated() {
        let (surface, component) = flat(200, 16); // 3184 px long
        let spawns = choose_spawns(&surface, &component, 1, 6);
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
        let surface: Vec<Point> = (0..100).map(|i| Point::new(i * 16, 500)).collect();
        // Only the second half is traversable.
        let component: Vec<usize> = (50..100).collect();
        let spawns = choose_spawns(&surface, &component, 7, 6);
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
        let (surface, component) = flat(200, 16);
        let floor_len = 199.0 * 16.0;
        let spawns = choose_spawns(&surface, &component, 3, 6);
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
        let surface = vec![
            Point::new(100, 500),
            Point::new(110, 500),
            Point::new(120, 500),
        ];
        let component = vec![0, 1, 2];
        let spawns = choose_spawns(&surface, &component, 5, 6);
        // Relaxation lets it take more than one, but it must never invent points
        // or loop forever.
        assert!(!spawns.is_empty() && spawns.len() <= 3);
    }

    #[test]
    fn degenerate_inputs_return_empty_without_panicking() {
        let (surface, component) = flat(10, 16);
        assert!(choose_spawns(&surface, &component, 1, 0).is_empty());
        assert!(choose_spawns(&surface, &[], 1, 6).is_empty());
        assert!(choose_spawns(&[], &[], 1, 6).is_empty());
        // Indices that do not exist in `surface` are ignored, not indexed.
        assert!(choose_spawns(&surface, &[99, 100], 1, 6).is_empty());
    }

    #[test]
    fn selection_order_is_preserved_not_sorted() {
        let (surface, component) = flat(200, 16);
        let spawns = choose_spawns(&surface, &component, 11, 6);
        let mut sorted = spawns.clone();
        sorted.sort_by_key(|p| (p.x, p.y));
        assert_ne!(
            spawns, sorted,
            "farthest-point order should not coincidentally be sorted"
        );
    }

    #[test]
    fn real_maps_always_yield_enough_spawns() {
        for seed in 0..20u64 {
            let o = generate_terrain(seed * 977 + 5, MapScale::Medium);
            let spawns = choose_spawns(&o.surface, &o.report.largest_component, o.seed, 6);
            assert!(
                spawns.len() >= SPAWN_COUNT_MIN,
                "seed {seed}: only {} spawns (fraction {:.3})",
                spawns.len(),
                o.report.traversable_fraction
            );
        }
    }
}
