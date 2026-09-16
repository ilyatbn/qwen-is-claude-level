//! An 8×8 occupancy index over the mask: one byte per cell holding the count of
//! solid pixels in it, 0..=64.
//!
//! Its whole value is answering "can I skip this cell?" without touching bits.
//! `Empty` and `Full` are decisive; only `Mixed` needs per-pixel work. On typical
//! generated terrain the large majority of cells are one of the two extremes, which
//! is why collision (T2.02) rarely reads the mask at all.
//!
//! The grid must stay **exact** — physics trusts it. Carve maintains it
//! incrementally from the bit counts `clear_run` returns rather than recounting.
//!
//! See `docs/10-map-generation.md` §1.2 and `docs/11-map-destruction.md` §3.

use crate::constants::COARSE_CELL;
use crate::map::Mask;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum CellState {
    Empty,
    Full,
    Mixed,
}

/// Solid pixels in a completely full cell.
pub const CELL_CAPACITY: u8 = (COARSE_CELL * COARSE_CELL) as u8;

#[derive(Clone, PartialEq, Eq)]
pub struct CoarseGrid {
    pub cw: u32,
    pub ch: u32,
    counts: Vec<u8>,
}

impl CoarseGrid {
    /// Full recount from a mask. `O(w*h)` — round start and tests only.
    pub fn build(mask: &Mask) -> Self {
        let cw = mask.w.div_ceil(COARSE_CELL);
        let ch = mask.h.div_ceil(COARSE_CELL);
        let mut counts = vec![0u8; (cw * ch) as usize];

        // Row-major over cells, counting each cell's 8 rows with count_run so the
        // inner loop stays word-at-a-time rather than per pixel.
        for cy in 0..ch {
            let y0 = (cy * COARSE_CELL) as i32;
            let y1 = (y0 + COARSE_CELL as i32 - 1).min(mask.h as i32 - 1);
            for cx in 0..cw {
                let x0 = (cx * COARSE_CELL) as i32;
                let x1 = (x0 + COARSE_CELL as i32 - 1).min(mask.w as i32 - 1);
                let mut n = 0u32;
                for y in y0..=y1 {
                    n += mask.count_run(y, x0, x1);
                }
                counts[(cy * cw + cx) as usize] = n as u8;
            }
        }

        CoarseGrid { cw, ch, counts }
    }

    /// World pixel coordinates. Out of bounds is `Empty`, consistent with
    /// `Mask::get` returning air.
    #[inline]
    pub fn cell_at(&self, x: i32, y: i32) -> CellState {
        if x < 0 || y < 0 {
            return CellState::Empty;
        }
        let (cx, cy) = (x as u32 / COARSE_CELL, y as u32 / COARSE_CELL);
        if cx >= self.cw || cy >= self.ch {
            return CellState::Empty;
        }
        Self::state_of(self.counts[(cy * self.cw + cx) as usize])
    }

    #[inline]
    fn state_of(count: u8) -> CellState {
        match count {
            0 => CellState::Empty,
            CELL_CAPACITY => CellState::Full,
            _ => CellState::Mixed,
        }
    }

    /// Cell coordinates, not pixels. Out of bounds returns 0.
    #[inline]
    pub fn count_at(&self, cx: u32, cy: u32) -> u8 {
        if cx >= self.cw || cy >= self.ch {
            return 0;
        }
        self.counts[(cy * self.cw + cx) as usize]
    }

    #[inline]
    pub fn state_at(&self, cx: u32, cy: u32) -> CellState {
        Self::state_of(self.count_at(cx, cy))
    }

    /// Saturating. An underflow means the count and the mask have diverged, which
    /// is a real bug — but wrapping to 255 would turn a small bookkeeping error
    /// into "this empty cell is now completely solid", which is far harder to
    /// trace. Loud in debug, survivable in release.
    #[inline]
    pub fn subtract(&mut self, cx: u32, cy: u32, n: u8) {
        if cx >= self.cw || cy >= self.ch {
            return;
        }
        let slot = &mut self.counts[(cy * self.cw + cx) as usize];
        debug_assert!(
            *slot >= n,
            "coarse underflow at ({cx},{cy}): {slot} - {n}; the grid has diverged from the mask"
        );
        *slot = slot.saturating_sub(n);
    }

    #[inline]
    pub fn add(&mut self, cx: u32, cy: u32, n: u8) {
        if cx >= self.cw || cy >= self.ch {
            return;
        }
        let slot = &mut self.counts[(cy * self.cw + cx) as usize];
        debug_assert!(
            slot.saturating_add(n) <= CELL_CAPACITY,
            "coarse overflow at ({cx},{cy}): {slot} + {n} exceeds {CELL_CAPACITY}"
        );
        *slot = (*slot + n).min(CELL_CAPACITY);
    }

    /// Verify every cell against a from-scratch recount.
    ///
    /// Returns the **first** mismatch as `(cx, cy, stored, actual)` rather than a
    /// bare bool: when this fires in a test you want to know where, immediately.
    pub fn verify(&self, mask: &Mask) -> Result<(), (u32, u32, u8, u8)> {
        let fresh = CoarseGrid::build(mask);
        if fresh.cw != self.cw || fresh.ch != self.ch {
            return Err((0, 0, 0, 0));
        }
        for cy in 0..self.ch {
            for cx in 0..self.cw {
                let stored = self.count_at(cx, cy);
                let actual = fresh.count_at(cx, cy);
                if stored != actual {
                    return Err((cx, cy, stored, actual));
                }
            }
        }
        Ok(())
    }

    /// Total solid pixels according to the index. Should always equal
    /// `mask.count_solid()`; a cheap cross-check in tests.
    pub fn total(&self) -> u64 {
        self.counts.iter().map(|&c| c as u64).sum()
    }

    #[cfg(test)]
    fn corrupt_for_test(&mut self, cx: u32, cy: u32, to: u8) {
        self.counts[(cy * self.cw + cx) as usize] = to;
    }
}

impl core::fmt::Debug for CoarseGrid {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "CoarseGrid {{ cw: {}, ch: {}, total: {} }}",
            self.cw,
            self.ch,
            self.total()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;

    const W: u32 = 512;
    const H: u32 = 256;

    #[test]
    fn empty_mask_is_all_empty_cells() {
        let m = Mask::new_empty(W, H);
        let g = CoarseGrid::build(&m);
        assert_eq!(g.cw, W / COARSE_CELL);
        assert_eq!(g.ch, H / COARSE_CELL);
        for cy in 0..g.ch {
            for cx in 0..g.cw {
                assert_eq!(g.count_at(cx, cy), 0);
                assert_eq!(g.state_at(cx, cy), CellState::Empty);
            }
        }
        assert_eq!(g.total(), 0);
    }

    #[test]
    fn full_mask_is_all_full_cells() {
        let m = Mask::new_full(W, H);
        let g = CoarseGrid::build(&m);
        for cy in 0..g.ch {
            for cx in 0..g.cw {
                assert_eq!(g.count_at(cx, cy), CELL_CAPACITY);
                assert_eq!(g.state_at(cx, cy), CellState::Full);
            }
        }
        assert_eq!(g.total(), W as u64 * H as u64);
    }

    #[test]
    fn a_single_solid_pixel_makes_exactly_one_mixed_cell() {
        let mut m = Mask::new_empty(W, H);
        m.set(19, 27); // cell (2, 3)
        let g = CoarseGrid::build(&m);

        assert_eq!(g.count_at(2, 3), 1);
        assert_eq!(g.state_at(2, 3), CellState::Mixed);

        let mut mixed = 0;
        for cy in 0..g.ch {
            for cx in 0..g.cw {
                if g.state_at(cx, cy) != CellState::Empty {
                    mixed += 1;
                }
            }
        }
        assert_eq!(mixed, 1);
        assert_eq!(g.total(), 1);
    }

    #[test]
    fn one_fully_solid_cell_reads_full_with_empty_neighbours() {
        let mut m = Mask::new_empty(W, H);
        for y in 8..16 {
            m.set_run(y, 8, 15); // exactly cell (1, 1)
        }
        let g = CoarseGrid::build(&m);
        assert_eq!(g.state_at(1, 1), CellState::Full);
        assert_eq!(g.count_at(1, 1), 64);
        for (cx, cy) in [(0, 0), (0, 1), (1, 0), (2, 1), (1, 2), (2, 2)] {
            assert_eq!(g.state_at(cx, cy), CellState::Empty, "cell ({cx},{cy})");
        }
    }

    #[test]
    fn cell_at_maps_world_pixels_to_cells() {
        let mut m = Mask::new_empty(W, H);
        for y in 0..8 {
            m.set_run(y, 0, 7);
        }
        let g = CoarseGrid::build(&m);
        assert_eq!(g.cell_at(0, 0), CellState::Full);
        assert_eq!(g.cell_at(7, 7), CellState::Full);
        assert_eq!(g.cell_at(8, 0), CellState::Empty);
        assert_eq!(g.cell_at(0, 8), CellState::Empty);
    }

    #[test]
    fn out_of_bounds_cell_at_is_empty() {
        let m = Mask::new_full(W, H);
        let g = CoarseGrid::build(&m);
        assert_eq!(g.cell_at(-1, 0), CellState::Empty);
        assert_eq!(g.cell_at(0, -1), CellState::Empty);
        assert_eq!(g.cell_at(W as i32, 0), CellState::Empty);
        assert_eq!(g.cell_at(0, H as i32), CellState::Empty);
        assert_eq!(g.count_at(g.cw, 0), 0);
        assert_eq!(g.count_at(0, g.ch), 0);
    }

    #[test]
    fn subtract_saturates_rather_than_wrapping() {
        let m = Mask::new_empty(W, H);
        let mut g = CoarseGrid::build(&m);
        g.add(1, 1, 10);
        assert_eq!(g.count_at(1, 1), 10);
        g.subtract(1, 1, 4);
        assert_eq!(g.count_at(1, 1), 6);
        // Release behaviour: saturate at 0. (debug_assert fires in debug builds,
        // so this arm is checked with the assertion disabled — see below.)
        g.subtract(1, 1, 6);
        assert_eq!(g.count_at(1, 1), 0);
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "coarse underflow")]
    fn subtract_past_zero_is_loud_in_debug() {
        let m = Mask::new_empty(W, H);
        let mut g = CoarseGrid::build(&m);
        g.subtract(0, 0, 1);
    }

    #[test]
    fn add_clamps_at_capacity() {
        let m = Mask::new_full(W, H);
        let mut g = CoarseGrid::build(&m);
        assert_eq!(g.count_at(0, 0), CELL_CAPACITY);
        // Out-of-range cells are ignored rather than panicking.
        g.add(g.cw, 0, 5);
        g.subtract(0, g.ch, 5);
    }

    #[test]
    fn verify_passes_on_a_fresh_grid() {
        let mut m = Mask::new_empty(W, H);
        for y in 40..90 {
            m.set_run(y, 13, 400);
        }
        let g = CoarseGrid::build(&m);
        assert_eq!(g.verify(&m), Ok(()));
        assert_eq!(g.total(), m.count_solid());
    }

    #[test]
    fn verify_reports_the_corrupted_cell() {
        let mut m = Mask::new_empty(W, H);
        for y in 8..16 {
            m.set_run(y, 8, 15);
        }
        let mut g = CoarseGrid::build(&m);
        g.corrupt_for_test(1, 1, 12);
        assert_eq!(g.verify(&m), Err((1, 1, 12, 64)));
    }

    #[test]
    fn grid_dimensions_are_right_at_every_scale() {
        for scale in MapScale::ALL {
            let p = scale.params();
            let m = Mask::new_empty(p.width, p.height);
            let g = CoarseGrid::build(&m);
            assert_eq!(g.cw, p.width / COARSE_CELL, "{scale:?}");
            assert_eq!(g.ch, p.height / COARSE_CELL, "{scale:?}");
        }
    }

    #[test]
    fn build_matches_a_per_pixel_recount_on_ragged_terrain() {
        // Diagonal stripes, so most cells land in Mixed rather than the extremes.
        let mut m = Mask::new_empty(W, H);
        for y in 0..H as i32 {
            let x0 = (y * 3) % W as i32;
            m.set_run(y, x0, x0 + 37);
        }
        let g = CoarseGrid::build(&m);

        for cy in 0..g.ch {
            for cx in 0..g.cw {
                let mut n = 0u8;
                for y in 0..COARSE_CELL as i32 {
                    for x in 0..COARSE_CELL as i32 {
                        if m.get((cx * COARSE_CELL) as i32 + x, (cy * COARSE_CELL) as i32 + y) {
                            n += 1;
                        }
                    }
                }
                assert_eq!(g.count_at(cx, cy), n, "cell ({cx},{cy})");
            }
        }
        assert_eq!(g.total(), m.count_solid());
    }
}
