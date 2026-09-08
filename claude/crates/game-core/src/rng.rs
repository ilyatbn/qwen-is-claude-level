//! Seeded randomness. `ChaCha8Rng` and nothing else.
//!
//! One `u64` seed per round; every subsystem draws from its **own** stream derived
//! from that seed by [`substream`]. If everything shared one stream, adding a single
//! extra item spawn would shift every later draw and silently change the terrain for
//! the same seed — invalidating every golden test and every bug report.
//!
//! `StdRng` is explicitly not reproducible across `rand` versions and `thread_rng` is
//! not reproducible at all. Neither may appear anywhere in this workspace.
//!
//! See `docs/10-map-generation.md` §2.

use rand::{Rng, SeedableRng};
pub use rand_chacha::ChaCha8Rng;

/// FNV-1a 64-bit hash. `const fn` so tags can be hashed at compile time.
pub const fn fnv1a64(s: &str) -> u64 {
    let bytes = s.as_bytes();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut i = 0;
    while i < bytes.len() {
        hash ^= bytes[i] as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        i += 1;
    }
    hash
}

/// An RNG for one subsystem, isolated from every other.
///
/// Tags in use across the project: `"terrain"`, `"blobs"`, `"bridges"`, `"caves"`,
/// `"chambers"`, `"crevices"`, `"voids"`, `"spawns"`, `"buried"`, `"items"`,
/// `"weather"`, `"decor"`, `"theme"`, `"wind"`, `"objects"`, and `"bot{n}"` per
/// bot.
///
/// Two different tags on the same seed give independent streams: exhausting one
/// cannot perturb another.
pub fn substream(seed: u64, tag: &str) -> ChaCha8Rng {
    ChaCha8Rng::seed_from_u64(seed ^ fnv1a64(tag))
}

/// The next round's seed, derived reproducibly so the whole sequence of rounds is
/// itself replayable (`docs/41-server-loop-rooms.md` §3).
pub fn next_round_seed(seed: u64, round: u32) -> u64 {
    // A 64-bit mix (splitmix64 finaliser) over the pair, so consecutive rounds do
    // not produce visibly related maps.
    let mut z = seed
        .wrapping_add(round as u64)
        .wrapping_mul(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// Inclusive on both ends. `lo > hi` returns `lo` rather than panicking.
pub fn range_u32(rng: &mut ChaCha8Rng, lo: u32, hi: u32) -> u32 {
    if lo >= hi {
        return lo;
    }
    rng.gen_range(lo..=hi)
}

/// Inclusive on both ends. `lo > hi` returns `lo` rather than panicking.
pub fn range_i32(rng: &mut ChaCha8Rng, lo: i32, hi: i32) -> i32 {
    if lo >= hi {
        return lo;
    }
    rng.gen_range(lo..=hi)
}

/// Half-open, as float ranges always are. `lo >= hi` returns `lo`.
pub fn range_f32(rng: &mut ChaCha8Rng, lo: f32, hi: f32) -> f32 {
    if lo >= hi {
        return lo;
    }
    rng.gen_range(lo..hi)
}

/// `p <= 0` is never, `p >= 1` is always.
pub fn chance(rng: &mut ChaCha8Rng, p: f32) -> bool {
    if p <= 0.0 {
        return false;
    }
    if p >= 1.0 {
        return true;
    }
    rng.gen::<f32>() < p
}

/// Index into `weights`, proportional to weight.
///
/// A zero weight is never selected. An empty or all-zero slice returns 0 — this is
/// `game-core`, which does no logging, so a caller that cares must check first.
pub fn pick_weighted(rng: &mut ChaCha8Rng, weights: &[u16]) -> usize {
    let total: u32 = weights.iter().map(|&w| w as u32).sum();
    if total == 0 {
        return 0;
    }
    let mut roll = rng.gen_range(0..total);
    for (i, &w) in weights.iter().enumerate() {
        let w = w as u32;
        if roll < w {
            return i;
        }
        roll -= w;
    }
    // Unreachable while `total` is the true sum, but returning the last non-zero
    // index beats an unwrap in a function this widely used.
    weights
        .iter()
        .rposition(|&w| w > 0)
        .unwrap_or(weights.len().saturating_sub(1))
}

/// Fisher-Yates, so shuffles are reproducible and do not depend on `rand`'s
/// internal shuffle implementation changing between versions.
pub fn shuffle<T>(rng: &mut ChaCha8Rng, items: &mut [T]) {
    if items.len() < 2 {
        return;
    }
    for i in (1..items.len()).rev() {
        let j = rng.gen_range(0..=i);
        items.swap(i, j);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draw(rng: &mut ChaCha8Rng, n: usize) -> Vec<u64> {
        (0..n).map(|_| rng.gen::<u64>()).collect()
    }

    #[test]
    fn same_seed_and_tag_repeat_exactly() {
        let a = draw(&mut substream(42, "terrain"), 100);
        let b = draw(&mut substream(42, "terrain"), 100);
        assert_eq!(a, b);
    }

    #[test]
    fn different_tags_give_different_sequences() {
        let terrain = draw(&mut substream(42, "terrain"), 100);
        let items = draw(&mut substream(42, "items"), 100);
        let caves = draw(&mut substream(42, "caves"), 100);
        assert_ne!(terrain, items);
        assert_ne!(terrain, caves);
        assert_ne!(items, caves);
    }

    #[test]
    fn different_seeds_give_different_sequences() {
        assert_ne!(
            draw(&mut substream(1, "terrain"), 50),
            draw(&mut substream(2, "terrain"), 50)
        );
    }

    /// The property the whole design rests on: exhausting one stream cannot move
    /// another. Without it, adding an item spawn would change the map.
    #[test]
    fn streams_are_isolated() {
        let baseline = draw(&mut substream(7, "terrain"), 100);

        let mut items = substream(7, "items");
        let _ = draw(&mut items, 10_000);

        let after = draw(&mut substream(7, "terrain"), 100);
        assert_eq!(baseline, after);
    }

    #[test]
    fn fnv1a64_matches_known_vectors() {
        assert_eq!(fnv1a64(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64("a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64("foobar"), 0x85944171f73967e8);
    }

    #[test]
    fn fnv1a64_is_const_evaluable() {
        const H: u64 = fnv1a64("terrain");
        assert_eq!(H, fnv1a64("terrain"));
    }

    #[test]
    fn range_u32_with_equal_bounds_is_constant() {
        let mut rng = substream(1, "t");
        for _ in 0..100 {
            assert_eq!(range_u32(&mut rng, 5, 5), 5);
        }
    }

    #[test]
    fn range_u32_with_inverted_bounds_does_not_panic() {
        let mut rng = substream(1, "t");
        assert_eq!(range_u32(&mut rng, 9, 3), 9);
        assert_eq!(range_i32(&mut rng, 9, 3), 9);
        assert_eq!(range_f32(&mut rng, 9.0, 3.0), 9.0);
    }

    #[test]
    fn range_u32_covers_both_endpoints() {
        let mut rng = substream(3, "t");
        let mut lo = false;
        let mut hi = false;
        for _ in 0..2000 {
            match range_u32(&mut rng, 0, 4) {
                0 => lo = true,
                4 => hi = true,
                v => assert!(v < 4),
            }
        }
        assert!(lo && hi, "endpoints not covered: lo={lo} hi={hi}");
    }

    #[test]
    fn range_f32_stays_in_bounds() {
        let mut rng = substream(4, "t");
        for _ in 0..2000 {
            let v = range_f32(&mut rng, -2.5, 7.5);
            assert!((-2.5..7.5).contains(&v), "{v}");
        }
    }

    #[test]
    fn chance_endpoints_are_absolute() {
        let mut rng = substream(5, "t");
        for _ in 0..100 {
            assert!(!chance(&mut rng, 0.0));
            assert!(chance(&mut rng, 1.0));
            assert!(!chance(&mut rng, -1.0));
            assert!(chance(&mut rng, 2.0));
        }
    }

    #[test]
    fn chance_is_roughly_fair() {
        let mut rng = substream(6, "t");
        let hits = (0..10_000).filter(|_| chance(&mut rng, 0.25)).count();
        assert!((2300..2700).contains(&hits), "hits = {hits}");
    }

    #[test]
    fn pick_weighted_never_returns_a_zero_weight() {
        let mut rng = substream(8, "t");
        let weights = [0u16, 5, 0, 3, 0];
        for _ in 0..10_000 {
            let i = pick_weighted(&mut rng, &weights);
            assert!(weights[i] > 0, "picked zero-weight index {i}");
        }
    }

    #[test]
    fn pick_weighted_distribution_is_within_two_percent() {
        let mut rng = substream(9, "t");
        let weights = [10u16, 30, 60];
        let total: f32 = 100.0;
        let n = 100_000;
        let mut counts = [0usize; 3];
        for _ in 0..n {
            counts[pick_weighted(&mut rng, &weights)] += 1;
        }
        for (i, &w) in weights.iter().enumerate() {
            let expected = w as f32 / total;
            let actual = counts[i] as f32 / n as f32;
            assert!(
                (actual - expected).abs() < 0.02,
                "index {i}: expected {expected}, got {actual}"
            );
        }
    }

    #[test]
    fn pick_weighted_degenerate_inputs_do_not_panic() {
        let mut rng = substream(10, "t");
        assert_eq!(pick_weighted(&mut rng, &[]), 0);
        assert_eq!(pick_weighted(&mut rng, &[0, 0, 0]), 0);
        assert_eq!(pick_weighted(&mut rng, &[7]), 0);
    }

    #[test]
    fn next_round_seed_is_deterministic_and_moves() {
        let s = 8_123_491_234u64;
        assert_eq!(next_round_seed(s, 1), next_round_seed(s, 1));
        assert_ne!(next_round_seed(s, 1), s);
        assert_ne!(next_round_seed(s, 1), next_round_seed(s, 2));
        // A chain of rounds does not collapse onto one value.
        let mut seen = std::collections::HashSet::new();
        let mut cur = s;
        for r in 0..64 {
            cur = next_round_seed(cur, r);
            assert!(seen.insert(cur), "seed repeated at round {r}");
        }
    }

    #[test]
    fn shuffle_is_deterministic_and_permutes() {
        let mut a: Vec<u32> = (0..32).collect();
        let mut b = a.clone();
        shuffle(&mut substream(11, "t"), &mut a);
        shuffle(&mut substream(11, "t"), &mut b);
        assert_eq!(a, b);

        let mut sorted = a.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..32).collect::<Vec<_>>());
        assert_ne!(a, sorted, "shuffle left the slice in order");
    }

    #[test]
    fn shuffle_handles_short_slices() {
        let mut rng = substream(12, "t");
        let mut empty: [u32; 0] = [];
        shuffle(&mut rng, &mut empty);
        let mut one = [9u32];
        shuffle(&mut rng, &mut one);
        assert_eq!(one, [9]);
    }
}
