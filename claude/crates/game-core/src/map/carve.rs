//! Terrain destruction: the single choke point.
//!
//! Weapons, meteors and lava do not touch the mask directly — they call these. That
//! choke point is what makes destruction easy to replicate on clients, easy to
//! record for replays, and easy to test.
//!
//! **Integer arithmetic only.** `isqrt`, never `f32::sqrt`. This is what makes the
//! result bit-identical on the server and in the browser, which is the entire basis
//! of terrain replication (`docs/11-map-destruction.md` §6). A float version will
//! diverge by a pixel somewhere, and the divergence surfaces weeks later as "I got
//! shot through a wall".
//!
//! See `docs/11-map-destruction.md` §1–§5.

use crate::constants::{BEDROCK_H, CHUNK_SIZE, COARSE_CELL, WALL_W};
use crate::map::Map;
use crate::math::isqrt;

pub type ChunkId = u32;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CarveResult {
    pub pixels_removed: u32,
    pub dirty_chunks: Vec<ChunkId>,
    /// Buried slot ids exposed by this carve.
    pub revealed: Vec<u16>,
}

impl Map {
    /// Clear a filled circle. Bedrock and the side walls are never touched.
    pub fn carve_circle(&mut self, cx: i32, cy: i32, r: i32) -> CarveResult {
        self.circle(cx, cy, r, false)
    }

    /// Add solid rock back. Not used in v1 gameplay; exists for tests and tools.
    pub fn fill_circle(&mut self, cx: i32, cy: i32, r: i32) -> CarveResult {
        self.circle(cx, cy, r, true)
    }

    /// Clear a thick line: a circle of radius `r` swept from `(x0,y0)` to
    /// `(x1,y1)`.
    ///
    /// Deferred from T1.14 until it had a user (`docs/11-map-destruction.md` §1);
    /// lava channels are it. Built by stamping `circle` along a Bresenham walk, so
    /// it inherits bit-exactness, bedrock and wall clamping, coarse-grid
    /// maintenance and buried-slot reveal from the one rasteriser rather than
    /// reimplementing any of them.
    ///
    /// Stepping one pixel at a time rather than by the radius is deliberate: a
    /// sweep sampled at `r` intervals leaves lens-shaped gaps on the diagonal,
    /// which is the classic bug here and exactly what
    /// `a_diagonal_capsule_leaves_no_gaps` pins.
    pub fn carve_capsule(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, r: i32) -> CarveResult {
        let mut acc = CarveResult::default();
        if r < 0 {
            return acc;
        }

        // Clamp the endpoints to the map **before** any i32 arithmetic on them.
        //
        // `(x1 - x0).abs()` is the trap: at `i32::MIN` it panics in debug, and in
        // release `.abs()` of a wrapped value stays negative, `err` becomes
        // garbage, and the sweep silently collapses to its endpoint — carving a few
        // pixels where the correct clip is thousands. This is the same class of bug
        // `circle` carries its i64 early-reject for; this sibling reimplemented the
        // entry path and dropped the guard.
        //
        // Clamping first also bounds the cost by construction: the Bresenham loop
        // runs once per pixel, so an unclamped 20-million-pixel endpoint took 103 ms
        // in release for a carve that touches nothing.
        let (w, h) = (self.mask.w as i64, self.mask.h as i64);
        let r64 = r as i64;
        let lo_x = -r64 - 1;
        let hi_x = w + r64 + 1;
        let lo_y = -r64 - 1;
        let hi_y = h + r64 + 1;
        let clamp = |v: i32, lo: i64, hi: i64| (v as i64).clamp(lo, hi) as i32;
        let (x0, y0) = (clamp(x0, lo_x, hi_x), clamp(y0, lo_y, hi_y));
        let (x1, y1) = (clamp(x1, lo_x, hi_x), clamp(y1, lo_y, hi_y));

        let (mut x, mut y) = (x0, y0);
        let (dx, dy) = ((x1 - x0).abs(), -(y1 - y0).abs());
        let (sx, sy) = (if x0 < x1 { 1 } else { -1 }, if y0 < y1 { 1 } else { -1 });
        let mut err = dx + dy;

        loop {
            let step = self.circle(x, y, r, false);
            acc.pixels_removed += step.pixels_removed;
            for c in step.dirty_chunks {
                if !acc.dirty_chunks.contains(&c) {
                    acc.dirty_chunks.push(c);
                }
            }
            acc.revealed.extend(step.revealed);

            if x == x1 && y == y1 {
                break;
            }
            let e2 = 2 * err;
            if e2 >= dy {
                err += dy;
                x += sx;
            }
            if e2 <= dx {
                err += dx;
                y += sy;
            }
        }
        acc
    }

    fn circle(&mut self, cx: i32, cy: i32, r: i32, solid: bool) -> CarveResult {
        let mut result = CarveResult::default();
        if r < 0 {
            return result;
        }

        let (w, h) = (self.mask.w as i32, self.mask.h as i32);
        let carveable_bottom = h - BEDROCK_H as i32;
        let (min_x, max_x) = (WALL_W as i32, w - WALL_W as i32 - 1);
        if max_x < min_x {
            return result;
        }

        // Reject circles that cannot touch the map before doing any i32 arithmetic
        // on the centre. `cy + dy` overflows for a centre near i32::MAX — a panic in
        // debug, and silently *wrapping to the other side of the map* in release,
        // which would carve a crater somewhere unrelated. Projectile positions feed
        // straight into this.
        // A radius beyond the map diagonal cannot mean anything more than "all of
        // it", and squaring an unclamped one overflows i32 just as readily as the
        // centre arithmetic does.
        let r = r.min(w + h);
        let (cx64, cy64, r64) = (cx as i64, cy as i64, r as i64);
        if cx64 + r64 < min_x as i64
            || cx64 - r64 > max_x as i64
            || cy64 + r64 < 0
            || cy64 - r64 >= carveable_bottom as i64
        {
            return result;
        }

        let rr = r * r;
        let mut changed = 0u32;

        for dy in -r..=r {
            let y = cy + dy;
            // Bedrock and the top clamp. Excluding them by clamping the span rather
            // than testing per pixel is what makes a rocket at the base of a wall
            // dig a correct half-crater.
            if y < 0 || y >= carveable_bottom {
                continue;
            }
            let dx = isqrt(rr - dy * dy);
            let x0 = (cx - dx).max(min_x);
            let x1 = (cx + dx).min(max_x);
            if x1 < x0 {
                continue;
            }

            // Split the span at coarse-cell boundaries so the grid can be updated
            // from the exact per-cell counts, with no recounting.
            let mut sx = x0;
            while sx <= x1 {
                let cell_end = ((sx / COARSE_CELL as i32) + 1) * COARSE_CELL as i32 - 1;
                let ex = cell_end.min(x1);
                let (cell_x, cell_y) = (sx as u32 / COARSE_CELL, y as u32 / COARSE_CELL);

                let n = if solid {
                    let before = self.mask.count_run(y, sx, ex);
                    self.mask.set_run(y, sx, ex);
                    let added = (ex - sx + 1) as u32 - before;
                    if added > 0 {
                        self.coarse.add(cell_x, cell_y, added as u8);
                    }
                    added
                } else {
                    let removed = self.mask.clear_run(y, sx, ex);
                    if removed > 0 {
                        self.coarse.subtract(cell_x, cell_y, removed as u8);
                    }
                    removed
                };

                changed += n;
                sx = ex + 1;
            }
        }

        result.pixels_removed = changed;
        if changed == 0 {
            // Idempotent: a repeat carve reports nothing and dirties nothing.
            return result;
        }

        self.mark_dirty_box(cx - r, cy - r, cx + r, cy + r, &mut result);

        if !solid {
            self.reveal_buried(cx, cy, r, &mut result);
        }

        result
    }

    /// Every chunk the circle's bounding box overlaps. The bounding box is close
    /// enough and much cheaper than an exact per-chunk intersection.
    fn mark_dirty_box(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, result: &mut CarveResult) {
        let (cw, ch) = (self.mask.chunks_x(), self.mask.chunks_y());
        let cx0 = (x0.max(0) as u32 / CHUNK_SIZE).min(cw.saturating_sub(1));
        let cy0 = (y0.max(0) as u32 / CHUNK_SIZE).min(ch.saturating_sub(1));
        let cx1 = (x1.max(0) as u32 / CHUNK_SIZE).min(cw.saturating_sub(1));
        let cy1 = (y1.max(0) as u32 / CHUNK_SIZE).min(ch.saturating_sub(1));

        for cy in cy0..=cy1 {
            for cx in cx0..=cx1 {
                let id = cy * cw + cx;
                result.dirty_chunks.push(id);
                if !self.dirty[id as usize] {
                    self.dirty[id as usize] = true;
                    self.dirty_list.push(id);
                }
            }
        }
    }

    /// At most 16 slots, so checking every one per carve is free.
    fn reveal_buried(&mut self, cx: i32, cy: i32, r: i32, result: &mut CarveResult) {
        let rr = (r as i64) * (r as i64);
        for slot in &mut self.meta.buried_slots {
            if slot.revealed {
                continue;
            }
            let d = slot.pos.distance_sq(crate::math::Point::new(cx, cy));
            if d <= rr && !self.mask.get(slot.pos.x, slot.pos.y) {
                slot.revealed = true;
                result.revealed.push(slot.id);
            }
        }
    }

    /// Chunks changed since the last drain. Consumed by the client renderer.
    pub fn drain_dirty(&mut self) -> Vec<ChunkId> {
        let out = std::mem::take(&mut self.dirty_list);
        for id in &out {
            self.dirty[*id as usize] = false;
        }
        out
    }

    /// Chunks currently pending, without draining.
    pub fn dirty_count(&self) -> usize {
        self.dirty_list.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::{generate, Mask};
    use crate::math::Point;
    use crate::rng::substream;
    use rand::Rng;

    /// A map whose mask is entirely solid, so carve effects are unambiguous.
    fn solid_map() -> Map {
        let mut map = generate(4242, MapScale::Small);
        map.mask = Mask::new_full(map.mask.w, map.mask.h);
        map.coarse = crate::map::CoarseGrid::build(&map.mask);
        map.drain_dirty();
        map
    }

    #[test]
    fn carving_outside_the_map_is_a_no_op() {
        let mut m = solid_map();
        let before = m.mask.count_solid();
        // "Outside" means the circle does not reach the carveable band at all.
        // (-10, 100) with r=20 is NOT outside: it spans x -30..10 and the band
        // starts at WALL_W = 8, so it legitimately digs a sliver.
        for (x, y) in [
            (-500, -500),
            (99_999, 99_999),
            (-100, 100),
            (100, -100),
            (100, m.mask.h as i32 + 100),
        ] {
            let r = m.carve_circle(x, y, 20);
            assert_eq!(r.pixels_removed, 0, "carve at ({x},{y}) removed pixels");
            assert!(r.dirty_chunks.is_empty());
        }
        assert_eq!(m.mask.count_solid(), before);
    }

    #[test]
    fn negative_radius_and_coordinates_do_not_panic() {
        let mut m = solid_map();
        assert_eq!(m.carve_circle(100, 100, -5).pixels_removed, 0);
        // Extreme centres must be rejected before any i32 arithmetic on them:
        // `cy + dy` overflows, which panics in debug and wraps in release.
        for (x, y) in [
            (i32::MIN, i32::MIN),
            (i32::MAX, i32::MAX),
            (i32::MIN, 100),
            (100, i32::MAX),
            (i32::MAX, i32::MIN),
        ] {
            assert_eq!(m.carve_circle(x, y, 10).pixels_removed, 0, "({x},{y})");
            assert_eq!(
                m.carve_circle(x, y, i32::MAX).pixels_removed,
                0,
                "({x},{y}) huge r"
            );
        }
    }

    #[test]
    fn radius_zero_and_one() {
        let mut m = solid_map();
        assert_eq!(m.carve_circle(500, 500, 0).pixels_removed, 1);
        assert!(!m.mask.get(500, 500));

        let mut m = solid_map();
        assert_eq!(m.carve_circle(600, 600, 1).pixels_removed, 5, "plus shape");
    }

    #[test]
    fn carving_is_idempotent() {
        let mut m = solid_map();
        let first = m.carve_circle(700, 500, 30);
        assert!(first.pixels_removed > 0);
        assert!(!first.dirty_chunks.is_empty());
        m.drain_dirty();

        let second = m.carve_circle(700, 500, 30);
        assert_eq!(second.pixels_removed, 0);
        assert!(
            second.dirty_chunks.is_empty(),
            "a no-op carve must not dirty chunks"
        );
    }

    #[test]
    fn bedrock_is_never_removed() {
        let mut m = solid_map();
        let h = m.mask.h as i32;
        let floor = h - BEDROCK_H as i32;
        m.carve_circle(500, h - 5, 60);
        for y in floor..h {
            assert_eq!(
                m.mask.count_run(y, 0, m.mask.w as i32 - 1),
                m.mask.w,
                "bedrock row {y} was carved"
            );
        }
    }

    #[test]
    fn walls_are_never_removed() {
        let mut m = solid_map();
        let w = m.mask.w as i32;
        m.carve_circle(0, 500, 60);
        m.carve_circle(w - 1, 500, 60);
        for y in 460..540 {
            for x in 0..WALL_W as i32 {
                assert!(m.mask.get(x, y), "left wall carved at ({x},{y})");
                assert!(m.mask.get(w - 1 - x, y), "right wall carved");
            }
        }
        // And it still dug a half-crater inside the wall.
        assert!(!m.mask.get(WALL_W as i32 + 5, 500));
    }

    #[test]
    fn area_is_within_two_percent_of_pi_r_squared() {
        let mut m = solid_map();
        let r = 40;
        let removed = m.carve_circle(800, 600, r).pixels_removed as f64;
        let expected = std::f64::consts::PI * (r as f64).powi(2);
        let error = (removed - expected).abs() / expected;
        assert!(
            error < 0.02,
            "removed {removed}, expected {expected:.0} ({:.1}% off)",
            error * 100.0
        );
    }

    /// The most important test in the task: a drifting coarse grid produces
    /// invisible walls and phantom holes in collision.
    #[test]
    fn the_coarse_grid_stays_exact_after_500_random_carves() {
        let mut m = solid_map();
        let mut rng = substream(7, "carve-fuzz");
        for _ in 0..500 {
            let x = rng.gen_range(-50..m.mask.w as i32 + 50);
            let y = rng.gen_range(-50..m.mask.h as i32 + 50);
            let r = rng.gen_range(0..60);
            m.carve_circle(x, y, r);
        }
        assert_eq!(m.coarse.verify(&m.mask), Ok(()));
        assert_eq!(m.coarse.total(), m.mask.count_solid());
    }

    #[test]
    fn the_coarse_grid_stays_exact_across_fill_and_carve() {
        let mut m = solid_map();
        let mut rng = substream(8, "fill-fuzz");
        for _ in 0..200 {
            let x = rng.gen_range(0..m.mask.w as i32);
            let y = rng.gen_range(0..m.mask.h as i32);
            let r = rng.gen_range(0..40);
            if rng.gen_bool(0.5) {
                m.carve_circle(x, y, r);
            } else {
                m.fill_circle(x, y, r);
            }
        }
        assert_eq!(m.coarse.verify(&m.mask), Ok(()));
    }

    #[test]
    fn dirty_chunks_cover_exactly_what_changed() {
        let mut m = solid_map();
        m.drain_dirty();
        let before = m.mask.clone();

        m.carve_circle(700, 500, 45);
        let reported: std::collections::HashSet<ChunkId> = m.drain_dirty().into_iter().collect();

        // Brute-force diff: which chunks actually have changed bits?
        let cw = m.mask.chunks_x();
        let mut actual = std::collections::HashSet::new();
        for y in 0..m.mask.h as i32 {
            for x in 0..m.mask.w as i32 {
                if before.get(x, y) != m.mask.get(x, y) {
                    let id = (y as u32 / CHUNK_SIZE) * cw + (x as u32 / CHUNK_SIZE);
                    actual.insert(id);
                }
            }
        }

        assert!(!actual.is_empty(), "the carve changed nothing");
        assert!(
            actual.is_subset(&reported),
            "chunks changed but not reported: {:?}",
            actual.difference(&reported).collect::<Vec<_>>()
        );
        // The bounding box may over-report by a chunk at the corners; that is
        // documented and cheap. It must not be wildly over though.
        assert!(
            reported.len() <= actual.len() + 4,
            "reported {} chunks for {} changed",
            reported.len(),
            actual.len()
        );
    }

    #[test]
    fn drain_dirty_returns_each_chunk_once_and_empties_the_set() {
        let mut m = solid_map();
        m.drain_dirty();

        // Overlapping carves in the same chunk.
        m.carve_circle(700, 500, 20);
        m.carve_circle(710, 505, 20);
        m.carve_circle(720, 510, 20);

        let drained = m.drain_dirty();
        let unique: std::collections::HashSet<_> = drained.iter().collect();
        assert_eq!(unique.len(), drained.len(), "a chunk was listed twice");
        assert!(m.drain_dirty().is_empty(), "the set was not emptied");
        assert_eq!(m.dirty_count(), 0);
    }

    #[test]
    fn a_carve_over_a_buried_slot_reveals_it_exactly_once() {
        let mut m = solid_map();
        // Plant a slot at a known spot.
        m.meta.buried_slots = vec![crate::map::BuriedSlot {
            id: 0,
            pos: Point::new(900, 700),
            revealed: false,
        }];

        // One pixel short: the slot is outside the circle.
        let miss = m.carve_circle(900 - 21, 700, 20);
        assert!(miss.revealed.is_empty(), "a near miss revealed the slot");
        assert!(!m.meta.buried_slots[0].revealed);

        let hit = m.carve_circle(900, 700, 20);
        assert_eq!(hit.revealed, vec![0]);
        assert!(m.meta.buried_slots[0].revealed);

        // Never twice.
        let again = m.carve_circle(900, 700, 30);
        assert!(again.revealed.is_empty(), "slot revealed a second time");
    }

    #[test]
    fn a_slot_inside_the_radius_but_still_solid_is_not_revealed() {
        // A slot within the circle's radius but in the bedrock band: the span was
        // clamped away, so the pixel is still solid and the slot stays hidden.
        let mut m = solid_map();
        let h = m.mask.h as i32;
        m.meta.buried_slots = vec![crate::map::BuriedSlot {
            id: 0,
            pos: Point::new(900, h - 5),
            revealed: false,
        }];
        let r = m.carve_circle(900, h - 5, 20);
        assert!(r.revealed.is_empty());
        assert!(m.mask.get(900, h - 5), "bedrock should still be solid");
    }

    #[test]
    fn fill_is_the_inverse_of_carve() {
        let mut m = solid_map();
        let before = m.mask.count_solid();
        let carved = m.carve_circle(900, 600, 35).pixels_removed;
        assert!(carved > 0);
        let filled = m.fill_circle(900, 600, 35).pixels_removed;
        assert_eq!(filled, carved, "fill did not restore the same pixel count");
        assert_eq!(m.mask.count_solid(), before);
        assert_eq!(m.coarse.verify(&m.mask), Ok(()));
    }

    #[test]
    fn carving_is_bit_identical_when_repeated_from_the_same_state() {
        // The replication guarantee: the same carve sequence from the same start
        // state must produce the same mask, every time.
        let sequence = [(700, 500, 40), (712, 530, 25), (690, 480, 33)];
        let mut hashes = Vec::new();
        for _ in 0..5 {
            let mut m = solid_map();
            for (x, y, r) in sequence {
                m.carve_circle(x, y, r);
            }
            hashes.push(m.mask.hash());
        }
        assert!(hashes.windows(2).all(|w| w[0] == w[1]));
    }

    #[test]
    fn carve_matches_the_shared_rasteriser_inside_the_carveable_band() {
        // carve_circle and stamp_circle must agree, or client-side prediction of a
        // crater lands in a different place than the server's.
        let mut m = solid_map();
        let (cx, cy, r) = (900, 500, 37);
        m.carve_circle(cx, cy, r);

        let mut reference = Mask::new_full(m.mask.w, m.mask.h);
        crate::map::stamp_circle(&mut reference, cx, cy, r, false);

        for y in (cy - r)..=(cy + r) {
            for x in (cx - r)..=(cx + r) {
                assert_eq!(
                    m.mask.get(x, y),
                    reference.get(x, y),
                    "carve and stamp_circle disagree at ({x},{y})"
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // carve_capsule (T5.04)
    // -----------------------------------------------------------------------

    #[test]
    fn a_vertical_capsule_clears_a_band_of_the_right_width() {
        let mut map = solid_map();
        map.carve_capsule(100, 100, 100, 200, 10);
        for y in 100..=200 {
            for dx in -10..=10 {
                assert!(!map.mask.get(100 + dx, y), "solid at ({}, {y})", 100 + dx);
            }
            assert!(map.mask.get(100 - 12, y), "cleared too wide");
            assert!(map.mask.get(100 + 12, y), "cleared too wide");
        }
    }

    #[test]
    fn a_horizontal_capsule_clears_a_horizontal_band() {
        let mut map = solid_map();
        map.carve_capsule(100, 300, 300, 300, 8);
        for x in 100..=300 {
            for dy in -8..=8 {
                assert!(!map.mask.get(x, 300 + dy), "solid at ({x}, {})", 300 + dy);
            }
        }
        assert!(map.mask.get(200, 300 - 10));
    }

    #[test]
    fn a_diagonal_capsule_leaves_no_gaps() {
        // The classic bug: sampling the sweep at radius intervals leaves
        // lens-shaped holes between stamps on the diagonal.
        //
        // Those lenses appear near the capsule EDGE, not on its centre line, so a
        // test that walks the centre would pass while leaving the rim scalloped.
        // Assert the real property instead: every pixel within `r` of the segment
        // is clear.
        let mut map = solid_map();
        let (x0, y0, x1, y1, r) = (120i32, 120i32, 320i32, 260i32, 6i32);
        map.carve_capsule(x0, y0, x1, y1, r);

        let seg = ((x1 - x0) as f32, (y1 - y0) as f32);
        let len2 = seg.0 * seg.0 + seg.1 * seg.1;
        for y in (y0 - r - 2)..=(y1 + r + 2) {
            for x in (x0 - r - 2)..=(x1 + r + 2) {
                let d = ((x - x0) as f32, (y - y0) as f32);
                let t = ((d.0 * seg.0 + d.1 * seg.1) / len2).clamp(0.0, 1.0);
                let (px, py) = (d.0 - seg.0 * t, d.1 - seg.1 * t);
                // Strictly inside, so the integer rasteriser's boundary rounding is
                // not what is being asserted.
                if px * px + py * py <= ((r - 1) * (r - 1)) as f32 {
                    assert!(!map.mask.get(x, y), "gap inside the capsule at ({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn a_capsule_with_extreme_endpoints_is_a_no_op_and_does_not_panic() {
        // `(x1 - x0).abs()` on i32::MIN panics in debug; in release the wrapped
        // value stays negative, `err` becomes garbage and the sweep collapses to a
        // point, carving a few pixels where the correct clip is thousands. Same
        // class as the overflow `circle` guards against (`docs/11` §8).
        let baseline = solid_map().mask.count_solid();
        for (x0, y0, x1, y1, r) in [
            (i32::MIN, i32::MIN, i32::MAX, i32::MAX, 8),
            (i32::MAX, i32::MIN, i32::MIN, i32::MAX, 8),
            (i32::MIN, 0, i32::MIN, 0, 8),
            (i32::MAX, 100, i32::MAX, 200, 8),
            (0, i32::MIN, 0, i32::MAX, 4),
            (-20_000_000, 100, 20_000_000, 100, 3),
        ] {
            let mut map = solid_map();
            let before = std::time::Instant::now();
            let r0 = map.carve_capsule(x0, y0, x1, y1, r);
            let took = before.elapsed();
            // Bounded by construction now that endpoints are clamped first.
            assert!(
                took.as_millis() < 2_000,
                "capsule ({x0},{y0})-({x1},{y1}) took {took:?}"
            );
            assert_eq!(
                map.mask.count_solid() + r0.pixels_removed as u64,
                baseline,
                "removal count disagrees with the mask for ({x0},{y0})-({x1},{y1})"
            );
        }
    }

    #[test]
    fn a_clipped_capsule_carves_the_part_that_is_on_the_map() {
        // The counterpart to the extreme test: a line that starts far off the map
        // and crosses it must still carve the crossing, not collapse to nothing.
        let mut map = solid_map();
        let r = map.carve_capsule(-500_000, 300, 500_000, 300, 5);
        assert!(
            r.pixels_removed > 1_000,
            "a full-width sweep removed only {}",
            r.pixels_removed
        );
        assert!(!map.mask.get(map.mask.w as i32 / 2, 300));
    }

    #[test]
    fn a_zero_length_capsule_equals_a_circle() {
        let mut a = solid_map();
        let mut b = solid_map();
        a.carve_capsule(200, 200, 200, 200, 15);
        b.carve_circle(200, 200, 15);
        assert_eq!(a.mask.count_solid(), b.mask.count_solid());
        for y in 180..220 {
            for x in 180..220 {
                assert_eq!(a.mask.get(x, y), b.mask.get(x, y), "differ at ({x}, {y})");
            }
        }
    }

    #[test]
    fn a_capsule_respects_bedrock_and_walls() {
        let mut map = solid_map();
        let h = map.mask.h as i32;
        map.carve_capsule(0, h - 10, map.mask.w as i32, h - 10, 20);
        for y in (h - BEDROCK_H as i32)..h {
            for x in 0..map.mask.w as i32 {
                assert!(map.mask.get(x, y), "bedrock cleared at ({x}, {y})");
            }
        }
        for y in 0..h {
            for x in 0..WALL_W as i32 {
                assert!(map.mask.get(x, y), "wall cleared at ({x}, {y})");
            }
        }
    }

    #[test]
    fn a_capsule_keeps_the_coarse_grid_exact() {
        let mut map = solid_map();
        map.carve_capsule(150, 150, 500, 380, 18);
        map.carve_capsule(500, 120, 200, 400, 9);
        assert!(map.coarse.verify(&map.mask).is_ok(), "coarse grid drifted");
    }

    #[test]
    fn a_capsule_dirties_every_chunk_it_touched() {
        let mut map = solid_map();
        let before: Vec<bool> = (0..map.mask.chunks_x() * map.mask.chunks_y())
            .map(|i| {
                let (cw, cs) = (map.mask.chunks_x(), CHUNK_SIZE as i32);
                let (cx, cy) = ((i % cw) as i32 * cs, (i / cw) as i32 * cs);
                (0..cs).any(|dy| (0..cs).any(|dx| map.mask.get(cx + dx, cy + dy)))
            })
            .collect();
        let res = map.carve_capsule(150, 150, 500, 380, 18);
        let after: Vec<bool> = (0..map.mask.chunks_x() * map.mask.chunks_y())
            .map(|i| {
                let (cw, cs) = (map.mask.chunks_x(), CHUNK_SIZE as i32);
                let (cx, cy) = ((i % cw) as i32 * cs, (i / cw) as i32 * cs);
                (0..cs).any(|dy| (0..cs).any(|dx| map.mask.get(cx + dx, cy + dy)))
            })
            .collect();
        for (i, (b, a)) in before.iter().zip(after.iter()).enumerate() {
            if b != a {
                assert!(
                    res.dirty_chunks.contains(&(i as u32)),
                    "chunk {i} changed but was not reported dirty"
                );
            }
        }
        // And no duplicates: the caller applies them, and a repeated id is a
        // wasted rebake per stamp along the sweep.
        let mut sorted = res.dirty_chunks.clone();
        sorted.sort_unstable();
        let len = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), len, "duplicate dirty chunk ids");
    }
}
