//! The terrain occupancy mask: one bit per pixel, set = solid rock.
//!
//! Nothing else describes the terrain. Every visual detail — material texture, the
//! grass edge, decorations — is derived from these bits at render time.
//!
//! `w` is always a multiple of `CHUNK_SIZE` (256) and `256 % 64 == 0`, so **every
//! row starts on a word boundary**. `set_run` and `clear_run` lean on that: the
//! interior of a run is a whole-word fill with at most two masked partial words at
//! the ends. That is what makes circle rasterisation cheap enough to do per carve.
//!
//! See `docs/10-map-generation.md` §1.1.

use crate::constants::CHUNK_SIZE;

/// Bits per word. Not a tunable — the type is `u64`.
const WORD_BITS: u32 = 64;

#[derive(Clone, PartialEq, Eq)]
pub struct Mask {
    pub w: u32,
    pub h: u32,
    words: Vec<u64>,
}

/// Bit mask covering `[lo, hi]` within one word, both in `0..64`.
#[inline(always)]
fn range_mask(lo: u32, hi: u32) -> u64 {
    debug_assert!(lo <= hi && hi < WORD_BITS);
    (!0u64 << lo) & (!0u64 >> (63 - hi))
}

impl Mask {
    /// Panics unless both dimensions are multiples of `CHUNK_SIZE`. Every caller
    /// gets its dimensions from `MapScale::params()`, so a panic here means a test
    /// invented a size, not that a map is misconfigured.
    pub fn new_empty(w: u32, h: u32) -> Self {
        Self::check_dims(w, h);
        Mask {
            w,
            h,
            words: vec![0u64; Self::word_count(w, h)],
        }
    }

    pub fn new_full(w: u32, h: u32) -> Self {
        Self::check_dims(w, h);
        Mask {
            w,
            h,
            words: vec![!0u64; Self::word_count(w, h)],
        }
    }

    fn check_dims(w: u32, h: u32) {
        assert!(
            w.is_multiple_of(CHUNK_SIZE) && h.is_multiple_of(CHUNK_SIZE),
            "mask dimensions must be multiples of CHUNK_SIZE ({CHUNK_SIZE}), got {w}x{h}"
        );
        assert!(w > 0 && h > 0, "mask dimensions must be non-zero");
    }

    #[inline]
    fn word_count(w: u32, h: u32) -> usize {
        // w is a multiple of 64, so this divides exactly and there are no padding
        // bits anywhere — every bit in every word is a real pixel.
        (w as usize * h as usize) / WORD_BITS as usize
    }

    /// Words per row. Exact, because `w % 64 == 0`.
    #[inline(always)]
    pub fn words_per_row(&self) -> usize {
        self.w as usize / WORD_BITS as usize
    }

    #[inline(always)]
    fn in_bounds(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as u32) < self.w && (y as u32) < self.h
    }

    /// Out of bounds reads as air. A player walking past the map edge must not
    /// collide with imaginary rock — the real wall is the `WALL_W` band of set bits.
    #[inline]
    pub fn get(&self, x: i32, y: i32) -> bool {
        if !self.in_bounds(x, y) {
            return false;
        }
        let bit = y as usize * self.w as usize + x as usize;
        (self.words[bit >> 6] >> (bit & 63)) & 1 != 0
    }

    /// Out of bounds is a silent no-op: carve circles routinely overhang the edge.
    #[inline]
    pub fn set(&mut self, x: i32, y: i32) {
        if !self.in_bounds(x, y) {
            return;
        }
        let bit = y as usize * self.w as usize + x as usize;
        self.words[bit >> 6] |= 1u64 << (bit & 63);
    }

    #[inline]
    pub fn clear(&mut self, x: i32, y: i32) {
        if !self.in_bounds(x, y) {
            return;
        }
        let bit = y as usize * self.w as usize + x as usize;
        self.words[bit >> 6] &= !(1u64 << (bit & 63));
    }

    #[inline]
    pub fn put(&mut self, x: i32, y: i32, solid: bool) {
        if solid {
            self.set(x, y);
        } else {
            self.clear(x, y);
        }
    }

    /// Clamp an inclusive run to the row, returning `None` if nothing remains.
    #[inline(always)]
    fn clamp_run(&self, y: i32, x0: i32, x1: i32) -> Option<(usize, u32, u32)> {
        if y < 0 || (y as u32) >= self.h || x1 < x0 {
            return None;
        }
        let x0 = x0.max(0);
        let x1 = x1.min(self.w as i32 - 1);
        if x1 < x0 {
            return None;
        }
        let row_word = y as usize * self.words_per_row();
        Some((row_word, x0 as u32, x1 as u32))
    }

    /// Set an inclusive horizontal run. Whole-word writes for the interior.
    pub fn set_run(&mut self, y: i32, x0: i32, x1: i32) {
        let Some((row_word, x0, x1)) = self.clamp_run(y, x0, x1) else {
            return;
        };
        let (fw, lw) = ((x0 / WORD_BITS) as usize, (x1 / WORD_BITS) as usize);
        let (lo, hi) = (x0 % WORD_BITS, x1 % WORD_BITS);

        if fw == lw {
            self.words[row_word + fw] |= range_mask(lo, hi);
            return;
        }
        self.words[row_word + fw] |= !0u64 << lo;
        if lw > fw + 1 {
            self.words[row_word + fw + 1..row_word + lw].fill(!0u64);
        }
        self.words[row_word + lw] |= !0u64 >> (63 - hi);
    }

    /// Clear an inclusive horizontal run, returning how many bits were actually
    /// cleared. That count is what lets T1.14 maintain the coarse grid without
    /// recounting whole cells.
    pub fn clear_run(&mut self, y: i32, x0: i32, x1: i32) -> u32 {
        let Some((row_word, x0, x1)) = self.clamp_run(y, x0, x1) else {
            return 0;
        };
        let (fw, lw) = ((x0 / WORD_BITS) as usize, (x1 / WORD_BITS) as usize);
        let (lo, hi) = (x0 % WORD_BITS, x1 % WORD_BITS);
        let mut removed = 0u32;

        if fw == lw {
            let m = range_mask(lo, hi);
            let w = &mut self.words[row_word + fw];
            removed += (*w & m).count_ones();
            *w &= !m;
            return removed;
        }

        let m = !0u64 << lo;
        let w = &mut self.words[row_word + fw];
        removed += (*w & m).count_ones();
        *w &= !m;

        for w in &mut self.words[row_word + fw + 1..row_word + lw] {
            removed += w.count_ones();
            *w = 0;
        }

        let m = !0u64 >> (63 - hi);
        let w = &mut self.words[row_word + lw];
        removed += (*w & m).count_ones();
        *w &= !m;

        removed
    }

    /// Read an inclusive run as a count of solid bits, without modifying anything.
    /// Used by the coarse grid and by cave-reachability tests.
    pub fn count_run(&self, y: i32, x0: i32, x1: i32) -> u32 {
        let Some((row_word, x0, x1)) = self.clamp_run(y, x0, x1) else {
            return 0;
        };
        let (fw, lw) = ((x0 / WORD_BITS) as usize, (x1 / WORD_BITS) as usize);
        let (lo, hi) = (x0 % WORD_BITS, x1 % WORD_BITS);

        if fw == lw {
            return (self.words[row_word + fw] & range_mask(lo, hi)).count_ones();
        }
        let mut n = (self.words[row_word + fw] & (!0u64 << lo)).count_ones();
        for w in &self.words[row_word + fw + 1..row_word + lw] {
            n += w.count_ones();
        }
        n += (self.words[row_word + lw] & (!0u64 >> (63 - hi))).count_ones();
        n
    }

    pub fn count_solid(&self) -> u64 {
        // No padding bits exist, so this is exact with no tail handling.
        self.words.iter().map(|w| w.count_ones() as u64).sum()
    }

    #[inline]
    pub fn words(&self) -> &[u64] {
        &self.words
    }

    #[inline]
    pub fn words_mut(&mut self) -> &mut [u64] {
        &mut self.words
    }

    /// blake3 over the dimensions and the words. Dimensions are included so two
    /// masks of different shapes can never collide on content.
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = blake3::Hasher::new();
        hasher.update(&self.w.to_le_bytes());
        hasher.update(&self.h.to_le_bytes());
        // Chunked rather than per-word: 131 072 update() calls for a large map is
        // measurable, 128 is not.
        let mut buf = [0u8; 8192];
        for chunk in self.words.chunks(1024) {
            let n = chunk.len() * 8;
            for (i, word) in chunk.iter().enumerate() {
                buf[i * 8..i * 8 + 8].copy_from_slice(&word.to_le_bytes());
            }
            hasher.update(&buf[..n]);
        }
        *hasher.finalize().as_bytes()
    }

    /// Short form for logs and golden tables.
    pub fn hash_hex(&self) -> String {
        let h = self.hash();
        let mut s = String::with_capacity(64);
        for b in h {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    #[inline]
    pub fn chunks_x(&self) -> u32 {
        self.w / CHUNK_SIZE
    }

    #[inline]
    pub fn chunks_y(&self) -> u32 {
        self.h / CHUNK_SIZE
    }
}

impl core::fmt::Debug for Mask {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // Never print a million words.
        write!(
            f,
            "Mask {{ w: {}, h: {}, solid: {} }}",
            self.w,
            self.h,
            self.count_solid()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::substream;
    use rand::Rng;

    const W: u32 = 512;
    const H: u32 = 256;

    #[test]
    fn empty_and_full_counts() {
        let e = Mask::new_empty(W, H);
        assert_eq!(e.count_solid(), 0);
        let f = Mask::new_full(W, H);
        assert_eq!(f.count_solid(), W as u64 * H as u64);
    }

    #[test]
    #[should_panic(expected = "multiples of CHUNK_SIZE")]
    fn non_chunk_multiple_dimensions_panic() {
        let _ = Mask::new_empty(100, 100);
    }

    #[test]
    fn set_then_get_at_corners_and_random_points() {
        let mut m = Mask::new_empty(W, H);
        m.set(0, 0);
        m.set(W as i32 - 1, H as i32 - 1);
        assert!(m.get(0, 0));
        assert!(m.get(W as i32 - 1, H as i32 - 1));
        assert_eq!(m.count_solid(), 2);

        let mut rng = substream(1, "mask-test");
        let mut points = Vec::new();
        for _ in 0..100 {
            let x = rng.gen_range(0..W as i32);
            let y = rng.gen_range(0..H as i32);
            m.set(x, y);
            points.push((x, y));
        }
        for (x, y) in points {
            assert!(m.get(x, y), "({x},{y}) should be solid");
        }
    }

    #[test]
    fn out_of_bounds_get_is_air() {
        let m = Mask::new_full(W, H);
        assert!(!m.get(-1, 0));
        assert!(!m.get(0, -1));
        assert!(!m.get(W as i32, 0));
        assert!(!m.get(0, H as i32));
        assert!(!m.get(i32::MIN, i32::MAX));
    }

    #[test]
    fn out_of_bounds_set_is_a_no_op() {
        let mut m = Mask::new_empty(W, H);
        m.set(-1, 5);
        m.set(5, -1);
        m.set(W as i32, 5);
        m.set(5, H as i32);
        m.set(i32::MIN, i32::MIN);
        assert_eq!(m.count_solid(), 0);
        m.clear(-1, -1);
        assert_eq!(m.count_solid(), 0);
    }

    #[test]
    fn set_run_across_a_word_boundary() {
        let mut m = Mask::new_empty(W, H);
        m.set_run(3, 60, 70);
        assert_eq!(m.count_solid(), 11);
        for x in 60..=70 {
            assert!(m.get(x, 3), "x={x}");
        }
        assert!(!m.get(59, 3));
        assert!(!m.get(71, 3));
    }

    #[test]
    fn set_run_spanning_whole_words() {
        let mut m = Mask::new_empty(W, H);
        m.set_run(1, 5, 300);
        assert_eq!(m.count_solid(), 296);
        assert!(!m.get(4, 1));
        assert!(m.get(5, 1));
        assert!(m.get(300, 1));
        assert!(!m.get(301, 1));
    }

    #[test]
    fn set_run_single_pixel_and_full_row() {
        let mut m = Mask::new_empty(W, H);
        m.set_run(0, 7, 7);
        assert_eq!(m.count_solid(), 1);
        assert!(m.get(7, 0));

        let mut m = Mask::new_empty(W, H);
        m.set_run(2, 0, W as i32 - 1);
        assert_eq!(m.count_solid(), W as u64);
    }

    #[test]
    fn clear_run_returns_bits_actually_cleared() {
        let mut m = Mask::new_full(W, H);
        assert_eq!(m.clear_run(4, 10, 19), 10);
        // Second time there is nothing left to clear.
        assert_eq!(m.clear_run(4, 10, 19), 0);

        let mut m = Mask::new_empty(W, H);
        m.set_run(4, 12, 15);
        // Overlapping run: only the 4 set bits count.
        assert_eq!(m.clear_run(4, 0, 100), 4);
    }

    #[test]
    fn clear_run_across_many_words() {
        let mut m = Mask::new_full(W, H);
        assert_eq!(m.clear_run(5, 3, 400), 398);
        assert!(m.get(2, 5));
        assert!(!m.get(3, 5));
        assert!(!m.get(400, 5));
        assert!(m.get(401, 5));
    }

    #[test]
    fn inverted_run_is_a_no_op() {
        let mut m = Mask::new_full(W, H);
        assert_eq!(m.clear_run(4, 20, 19), 0);
        assert_eq!(m.count_solid(), W as u64 * H as u64);
        m.set_run(4, 20, 19);
        assert_eq!(m.count_solid(), W as u64 * H as u64);
    }

    #[test]
    fn runs_never_bleed_into_neighbouring_rows() {
        // The classic bug in a flat bitset. A run that overhangs both ends of its
        // row must clamp, not wrap into the rows either side.
        let mut m = Mask::new_empty(W, H);
        m.set_run(5, 0, W as i32 - 1);
        assert_eq!(m.count_solid(), W as u64);

        m.clear_run(5, -100, W as i32 + 100);
        assert_eq!(m.count_solid(), 0, "the overhanging clear ate other rows");

        // And the same for set: fill row 5 by overhanging, check 4 and 6 are clean.
        let mut m = Mask::new_empty(W, H);
        m.set_run(5, -50, W as i32 + 50);
        assert_eq!(m.count_solid(), W as u64);
        for x in 0..W as i32 {
            assert!(!m.get(x, 4), "row 4 polluted at x={x}");
            assert!(!m.get(x, 6), "row 6 polluted at x={x}");
        }
    }

    #[test]
    fn runs_on_out_of_range_rows_are_no_ops() {
        let mut m = Mask::new_empty(W, H);
        m.set_run(-1, 0, 10);
        m.set_run(H as i32, 0, 10);
        assert_eq!(m.count_solid(), 0);
        assert_eq!(m.clear_run(-1, 0, 10), 0);
        assert_eq!(m.clear_run(H as i32, 0, 10), 0);
    }

    #[test]
    fn count_run_matches_a_manual_count() {
        let mut m = Mask::new_empty(W, H);
        m.set_run(7, 30, 200);
        assert_eq!(m.count_run(7, 0, W as i32 - 1), 171);
        assert_eq!(m.count_run(7, 30, 200), 171);
        assert_eq!(m.count_run(7, 0, 29), 0);
        assert_eq!(m.count_run(7, 100, 100), 1);
        assert_eq!(m.count_run(8, 0, W as i32 - 1), 0);
    }

    #[test]
    fn set_run_is_idempotent_and_clear_is_its_inverse() {
        let mut m = Mask::new_empty(W, H);
        m.set_run(9, 40, 90);
        let after_first = m.count_solid();
        m.set_run(9, 40, 90);
        assert_eq!(m.count_solid(), after_first);
        m.clear_run(9, 40, 90);
        assert_eq!(m.count_solid(), 0);
    }

    #[test]
    fn hash_is_stable_and_sensitive() {
        let m = Mask::new_full(W, H);
        let c = m.clone();
        assert_eq!(m.hash(), c.hash());

        let mut flipped = m.clone();
        flipped.clear(123, 45);
        assert_ne!(m.hash(), flipped.hash(), "a single bit flip must change it");

        // Same contents, different shape, must not collide.
        let a = Mask::new_empty(512, 256);
        let b = Mask::new_empty(256, 512);
        assert_ne!(a.hash(), b.hash());

        assert_eq!(m.hash_hex().len(), 64);
    }

    #[test]
    fn chunk_dimensions() {
        let m = Mask::new_empty(W, H);
        assert_eq!(m.chunks_x(), W / CHUNK_SIZE);
        assert_eq!(m.chunks_y(), H / CHUNK_SIZE);
        assert_eq!(m.words_per_row(), W as usize / 64);
    }

    #[test]
    fn random_runs_agree_with_a_per_pixel_reference() {
        // The runs are the only clever code in this file, so cross-check them
        // against the naive implementation over many random cases.
        let mut rng = substream(99, "mask-fuzz");
        let mut m = Mask::new_empty(W, H);
        let mut reference = vec![false; (W * H) as usize];

        for _ in 0..400 {
            let y = rng.gen_range(0..H as i32);
            let x0 = rng.gen_range(-20..W as i32 + 20);
            let x1 = x0 + rng.gen_range(0..150);
            let set = rng.gen_bool(0.5);

            let mut expected_removed = 0u32;
            for x in x0.max(0)..=x1.min(W as i32 - 1) {
                let idx = y as usize * W as usize + x as usize;
                if set {
                    reference[idx] = true;
                } else {
                    if reference[idx] {
                        expected_removed += 1;
                    }
                    reference[idx] = false;
                }
            }

            if set {
                m.set_run(y, x0, x1);
            } else {
                let removed = m.clear_run(y, x0, x1);
                assert_eq!(removed, expected_removed, "clear_run count mismatch");
            }
        }

        for y in 0..H as i32 {
            for x in 0..W as i32 {
                assert_eq!(
                    m.get(x, y),
                    reference[y as usize * W as usize + x as usize],
                    "divergence at ({x},{y})"
                );
            }
        }
    }
}
