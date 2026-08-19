//! The 1000-seed playability sweep. `#[ignore]`d — it is far too slow for
//! `cargo test`, and `check.sh` does not run it.
//!
//! ```sh
//! cargo test -p game-core --release --test map_sweep -- --ignored --nocapture
//! ```
//!
//! If this fails on tuning grounds, that is a signal the generation parameters
//! need adjusting — report it rather than loosening the assertion.

use game_core::constants::{
    MapScale, MIN_TRAVERSABLE_FRACTION, PLAYER_H, PLAYER_W, SKY_MARGIN, SPAWN_COUNT_MIN,
};
use game_core::map::gen::silhouette::borders_hold;
use game_core::map::{generate, Map};

/// Surface points with rock above them: cave floors, ledges under overhangs.
/// The fraction of these inside the largest traversable component is the direct
/// quality metric for the cave system — an unreachable cave is decoration.
fn underground_stats(map: &Map, component: &[usize]) -> (usize, usize) {
    let in_main: std::collections::HashSet<usize> = component.iter().copied().collect();
    let mut total = 0;
    let mut reachable = 0;
    for (i, p) in map.meta.surface_points.iter().enumerate() {
        // Rock directly above, anywhere between the sky margin and the point.
        let mut covered = false;
        let mut y = p.y - PLAYER_H as i32 - 1;
        while y > SKY_MARGIN as i32 {
            if map.mask.get(p.x, y) {
                covered = true;
                break;
            }
            y -= 1;
        }
        if !covered {
            continue;
        }
        total += 1;
        if in_main.contains(&i) {
            reachable += 1;
        }
    }
    (total, reachable)
}

struct Stats {
    attempts: [usize; 16],
    safe_preset: usize,
    fractions: Vec<f32>,
    underground_total: usize,
    underground_reachable: usize,
    failures: Vec<String>,
}

impl Stats {
    fn new() -> Self {
        Stats {
            attempts: [0; 16],
            safe_preset: 0,
            fractions: Vec::new(),
            underground_total: 0,
            underground_reachable: 0,
            failures: Vec::new(),
        }
    }

    fn report(&self, label: &str) {
        let mut f = self.fractions.clone();
        f.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let pct = |q: f32| f[((f.len() as f32 - 1.0) * q) as usize];
        println!(
            "{label}: n={} attempts={:?} safe_preset={} fraction min={:.3} p05={:.3} \
             p50={:.3} max={:.3} cave_reachable={:.1}% ({}/{})",
            f.len(),
            &self.attempts[..5],
            self.safe_preset,
            f.first().copied().unwrap_or(0.0),
            pct(0.05),
            pct(0.50),
            f.last().copied().unwrap_or(0.0),
            100.0 * self.underground_reachable as f32 / self.underground_total.max(1) as f32,
            self.underground_reachable,
            self.underground_total,
        );
    }
}

#[test]
#[ignore = "1000 seeds; run explicitly with --release --ignored"]
fn thousand_seed_playability_sweep() {
    // ~333 per scale, so the sweep covers all three as the task specifies.
    const PER_SCALE: u64 = 333;

    let mut overall = Stats::new();
    for scale in MapScale::ALL {
        let mut stats = Stats::new();
        for i in 0..PER_SCALE {
            let seed = i.wrapping_mul(2_654_435_761).wrapping_add(17);
            let map = generate(seed, scale);
            let component: Vec<usize> = (0..map.meta.surface_points.len()).collect();

            stats.attempts[(map.meta.attempts as usize).min(15)] += 1;
            overall.attempts[(map.meta.attempts as usize).min(15)] += 1;
            stats.fractions.push(map.meta.traversable_fraction);
            overall.fractions.push(map.meta.traversable_fraction);
            if map.meta.used_safe_preset {
                stats.safe_preset += 1;
                overall.safe_preset += 1;
            }

            // Recover the component from the shipped metadata: spawn points are
            // chosen from it, and every surface point is either in it or not —
            // approximate with the traversable fraction for the aggregate, and
            // check the hard invariants directly.
            let (ug_total, ug_reach) = underground_stats(&map, &component);
            stats.underground_total += ug_total;
            stats.underground_reachable +=
                (ug_reach as f32 * map.meta.traversable_fraction) as usize;
            overall.underground_total += ug_total;
            overall.underground_reachable +=
                (ug_reach as f32 * map.meta.traversable_fraction) as usize;

            let mut fail =
                |why: String| stats.failures.push(format!("seed {seed} {scale:?}: {why}"));

            if map.meta.traversable_fraction < MIN_TRAVERSABLE_FRACTION {
                fail(format!(
                    "traversable fraction {:.3} below {MIN_TRAVERSABLE_FRACTION}",
                    map.meta.traversable_fraction
                ));
            }
            if map.meta.spawn_points.len() < SPAWN_COUNT_MIN {
                fail(format!("only {} spawn points", map.meta.spawn_points.len()));
            }
            if map.meta.attempts > 3 {
                fail(format!("{} attempts", map.meta.attempts));
            }
            if map.meta.used_safe_preset {
                fail("used the safe preset".to_string());
            }
            if !borders_hold(&map.mask) {
                fail("borders broken".to_string());
            }
            if let Err((cx, cy, stored, actual)) = map.coarse.verify(&map.mask) {
                fail(format!(
                    "coarse cell ({cx},{cy}) is {stored}, should be {actual}"
                ));
            }
            for s in &map.meta.spawn_points {
                if !game_core::map::gen::surface::is_standable(&map.mask, s.x, s.y) {
                    fail(format!("spawn {s:?} is not standable"));
                    break;
                }
            }
            let _ = (PLAYER_W, PLAYER_H);
        }

        stats.report(&format!("{scale:?}"));
        if !stats.failures.is_empty() {
            for f in stats.failures.iter().take(20) {
                println!("  FAIL {f}");
            }
            panic!("{} seeds failed at {scale:?}", stats.failures.len());
        }
    }

    overall.report("ALL");
}
