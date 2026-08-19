//! `rng` — the single source of randomness for a round (docs/00 §4).
//!
//! Determinism is the headline requirement (docs/00 §2): `game-core` must
//! produce identical state for the same `(seed, tick count, input sequence)`.
//! Every random draw in this crate goes through [`GameRng`]. Nothing else may
//! call `rand::random`, a thread RNG, or read a clock.
//!
//! ## Why the algorithms here are spelled out rather than delegated
//!
//! [`GameRng::shuffle`] and [`GameRng::random_unit`] are implemented explicitly
//! instead of calling `SliceRandom::shuffle` / `Rng::random`. Those helpers are
//! not contractually stable across `rand` releases — a future version may
//! change its sampling strategy or draw a different number of words, which
//! would silently change every generated map for a given seed. Pinning the
//! algorithm here means map output depends only on ChaCha8 (which *is* a
//! stable, specified stream) plus code in this file.

use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha8Rng;

/// A seeded, reproducible RNG. One per round (docs/00 §4).
#[derive(Debug, Clone)]
pub struct GameRng {
    inner: ChaCha8Rng,
}

impl GameRng {
    /// Create an RNG from a round seed.
    pub fn new(seed: u64) -> Self {
        GameRng {
            inner: ChaCha8Rng::seed_from_u64(seed),
        }
    }

    /// Next raw `u64`.
    pub fn next_u64(&mut self) -> u64 {
        self.inner.next_u64()
    }

    /// Next raw `u32`.
    pub fn next_u32(&mut self) -> u32 {
        self.inner.next_u32()
    }

    /// A uniform `f32` in `[0, 1)`.
    ///
    /// Takes the top 24 bits of one `u32` — exactly the `f32` mantissa width,
    /// so every representable value is equally likely and the result is exact.
    pub fn random_unit(&mut self) -> f32 {
        const MANTISSA: u32 = 1 << 24;
        (self.next_u32() >> 8) as f32 / MANTISSA as f32
    }

    /// A uniform `f32` in `[min, max)`.
    pub fn gen_range_f32(&mut self, min: f32, max: f32) -> f32 {
        debug_assert!(min <= max, "gen_range_f32: empty range {min}..{max}");
        min + self.random_unit() * (max - min)
    }

    /// A uniform integer in `[low, high)` — half-open, like `low..high`.
    ///
    /// docs/01 T1.1 names this `gen_range<R: UniformRange>`. There is no
    /// `UniformRange` trait in `rand` (the real ones are `SampleUniform` /
    /// `SampleRange`), and `rand` 0.9 renamed the method to `random_range`.
    /// The doc's *name* is kept here; see DEVIATIONS.md D17.
    ///
    /// Uses Lemire's debiased multiply-shift rejection method, so the result is
    /// unbiased and consumes a well-defined number of words.
    pub fn gen_range(&mut self, low: u32, high: u32) -> u32 {
        assert!(low < high, "gen_range: empty range {low}..{high}");
        low + self.below(high - low)
    }

    /// Inclusive variant: a uniform integer in `[low, high]`.
    pub fn gen_range_inclusive(&mut self, low: u32, high: u32) -> u32 {
        assert!(low <= high, "gen_range_inclusive: empty range {low}..={high}");
        low + self.below((high - low) + 1)
    }

    /// A uniform integer in `[0, bound)`. `bound` must be non-zero.
    fn below(&mut self, bound: u32) -> u32 {
        debug_assert!(bound > 0);
        // Lemire: multiply into 64 bits and reject the biased low window.
        let mut product = (self.next_u32() as u64) * (bound as u64);
        let mut low = product as u32;
        if low < bound {
            let threshold = bound.wrapping_neg() % bound;
            while low < threshold {
                product = (self.next_u32() as u64) * (bound as u64);
                low = product as u32;
            }
        }
        (product >> 32) as u32
    }

    /// Fisher–Yates shuffle, in place.
    ///
    /// Walks high to low drawing one value per step, so a slice of length `n`
    /// consumes exactly `n - 1` draws.
    pub fn shuffle<T>(&mut self, slice: &mut [T]) {
        if slice.len() < 2 {
            return;
        }
        for i in (1..slice.len()).rev() {
            let j = self.below(i as u32 + 1) as usize;
            slice.swap(i, j);
        }
    }

    /// Pick an index from a weight table, proportional to the weights.
    ///
    /// Used by the item spawn weights (docs/04 §3). Returns `None` only if the
    /// table is empty or every weight is zero.
    pub fn weighted_index(&mut self, weights: &[u32]) -> Option<usize> {
        let total: u32 = weights.iter().sum();
        if total == 0 {
            return None;
        }
        let mut roll = self.below(total);
        for (index, &weight) in weights.iter().enumerate() {
            if roll < weight {
                return Some(index);
            }
            roll -= weight;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// docs/08 §1 (rng row): "same seed → same 1000-value sequence".
    #[test]
    fn seeded_rng_deterministic() {
        let mut a = GameRng::new(42);
        let mut b = GameRng::new(42);
        let left: Vec<u64> = (0..1000).map(|_| a.next_u64()).collect();
        let right: Vec<u64> = (0..1000).map(|_| b.next_u64()).collect();
        assert_eq!(left, right);

        // Every exposed draw kind must be reproducible, not just next_u64.
        let mut a = GameRng::new(7);
        let mut b = GameRng::new(7);
        for _ in 0..1000 {
            assert_eq!(a.random_unit(), b.random_unit());
            assert_eq!(a.gen_range(0, 97), b.gen_range(0, 97));
            assert_eq!(a.gen_range_inclusive(2, 6), b.gen_range_inclusive(2, 6));
            assert_eq!(a.gen_range_f32(-1.0, 1.0), b.gen_range_f32(-1.0, 1.0));
        }
        let mut left: Vec<u32> = (0..64).collect();
        let mut right: Vec<u32> = (0..64).collect();
        a.shuffle(&mut left);
        b.shuffle(&mut right);
        assert_eq!(left, right);
    }

    #[test]
    fn different_seeds_differ() {
        let mut a = GameRng::new(1);
        let mut b = GameRng::new(2);
        let left: Vec<u64> = (0..1000).map(|_| a.next_u64()).collect();
        let right: Vec<u64> = (0..1000).map(|_| b.next_u64()).collect();
        assert_ne!(left, right);
    }

    #[test]
    fn random_unit_is_in_unit_interval() {
        let mut rng = GameRng::new(3);
        for _ in 0..100_000 {
            let value = rng.random_unit();
            assert!((0.0..1.0).contains(&value), "{value} outside [0,1)");
        }
    }

    #[test]
    fn gen_range_respects_bounds() {
        let mut rng = GameRng::new(4);
        for _ in 0..100_000 {
            let value = rng.gen_range(10, 20);
            assert!((10..20).contains(&value), "{value} outside 10..20");
        }
        // A single-value half-open range is legal and constant.
        for _ in 0..10 {
            assert_eq!(rng.gen_range(5, 6), 5);
        }
    }

    #[test]
    fn gen_range_inclusive_covers_both_ends() {
        let mut rng = GameRng::new(5);
        let mut saw_low = false;
        let mut saw_high = false;
        for _ in 0..10_000 {
            let value = rng.gen_range_inclusive(2, 6);
            assert!((2..=6).contains(&value), "{value} outside 2..=6");
            saw_low |= value == 2;
            saw_high |= value == 6;
        }
        assert!(saw_low && saw_high, "inclusive range never hit an endpoint");
        // Degenerate range is legal.
        assert_eq!(rng.gen_range_inclusive(3, 3), 3);
    }

    #[test]
    fn gen_range_is_reasonably_uniform() {
        // Guards the Lemire rejection loop against an off-by-one that would
        // skew the distribution while still "working".
        let mut rng = GameRng::new(6);
        let mut counts = [0u32; 10];
        const DRAWS: u32 = 200_000;
        for _ in 0..DRAWS {
            counts[rng.gen_range(0, 10) as usize] += 1;
        }
        let expected = DRAWS / 10;
        for (bucket, &count) in counts.iter().enumerate() {
            let delta = count.abs_diff(expected);
            assert!(
                delta < expected / 10,
                "bucket {bucket} got {count}, expected ~{expected}"
            );
        }
    }

    #[test]
    fn shuffle_is_a_permutation() {
        let mut rng = GameRng::new(8);
        let mut values: Vec<u32> = (0..500).collect();
        rng.shuffle(&mut values);
        assert_ne!(values, (0..500).collect::<Vec<u32>>(), "shuffle was a no-op");
        values.sort_unstable();
        assert_eq!(values, (0..500).collect::<Vec<u32>>());
    }

    #[test]
    fn shuffle_handles_degenerate_slices() {
        let mut rng = GameRng::new(9);
        let mut empty: [u32; 0] = [];
        rng.shuffle(&mut empty);
        let mut single = [42];
        rng.shuffle(&mut single);
        assert_eq!(single, [42]);
    }

    #[test]
    fn shuffle_consumes_one_draw_per_element_after_the_first() {
        // Draw count is part of the determinism contract: if shuffle consumed a
        // different number of words, every later draw in the round would shift.
        let mut probe = GameRng::new(11);
        let mut data: Vec<u32> = (0..10).collect();
        probe.shuffle(&mut data);
        let after_shuffle = probe.next_u64();

        let mut manual = GameRng::new(11);
        for i in (1..10u32).rev() {
            let _ = manual.below(i + 1);
        }
        assert_eq!(manual.next_u64(), after_shuffle);
    }

    #[test]
    fn weighted_index_follows_weights() {
        let mut rng = GameRng::new(12);
        // Zero-weight entries must never be selected.
        let weights = [30, 0, 20, 50];
        let mut counts = [0u32; 4];
        for _ in 0..100_000 {
            counts[rng.weighted_index(&weights).unwrap()] += 1;
        }
        assert_eq!(counts[1], 0, "zero-weight entry was selected");
        assert!(counts[3] > counts[0], "weight 50 should beat weight 30");
        assert!(counts[0] > counts[2], "weight 30 should beat weight 20");

        assert_eq!(rng.weighted_index(&[]), None);
        assert_eq!(rng.weighted_index(&[0, 0]), None);
    }
}
