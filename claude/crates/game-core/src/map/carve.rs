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

use crate::constants::{
    BEDROCK_H, CHUNK_SIZE, COARSE_CELL, GUN_PLATFORMS, MAX_PENDING_BREACHES, TELEPORT_PADS, WALL_W,
};
use crate::map::shape;
use crate::map::Map;
use crate::math::isqrt;

pub type ChunkId = u32;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CarveResult {
    pub pixels_removed: u32,
    pub dirty_chunks: Vec<ChunkId>,
    /// Buried slot ids exposed by this carve.
    pub revealed: Vec<u16>,
    /// T22.10: the point on the space rim's centreline where this carve opened a
    /// hole through it, if it did — once per **carve call**, never per stamp.
    pub breach: Option<(i32, i32)>,
}

/// What [`Map::breach_probe`] saw before a carve: the rim, the padded box the
/// flood runs over, the carve's centre, and whether air already crossed the rim
/// inside that box.
struct BreachProbe {
    geo: crate::map::gen::space::SpaceGeometry,
    bbox: (i32, i32, i32, i32),
    at: (i32, i32),
    was_open: bool,
}

impl Map {
    /// Clear a filled circle. Bedrock and the side walls are never touched.
    pub fn carve_circle(&mut self, cx: i32, cy: i32, r: i32) -> CarveResult {
        // Saturating: `circle` rejects centres near `i32::MAX` before any arithmetic
        // on them, and this box must not be the first place that overflows.
        let bbox = (
            cx.saturating_sub(r),
            cy.saturating_sub(r),
            cx.saturating_add(r),
            cy.saturating_add(r),
        );
        let probe = self.breach_probe(bbox, (cx, cy));
        let mut out = self.circle(cx, cy, r, false);
        self.note_breach(probe, &mut out);
        out
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

        // Clamp and walk through the shared helpers in `shape`, so a carved
        // capsule and a stamped one cover exactly the same pixels. They used to
        // be two different walks — integer 1-px here, float `r/2` there — which
        // is two rasterisers against this crate's stated one-rasteriser
        // invariant (§A24).
        let (x0, y0, x1, y1) = shape::clamp_capsule(self.mask.w, self.mask.h, r, x0, y0, x1, y1);

        // Before the sweep: the rim's state in this box *before* the carve is half
        // of what a breach is (R87).
        let probe = self.breach_probe(
            (
                x0.min(x1).saturating_sub(r),
                y0.min(y1).saturating_sub(r),
                x0.max(x1).saturating_add(r),
                y0.max(y1).saturating_add(r),
            ),
            ((x0 + x1) / 2, (y0 + y1) / 2),
        );

        // Collected first because `walk_capsule` borrows its closure mutably and
        // `self.circle` needs `&mut self`.
        let mut centres = Vec::new();
        shape::walk_capsule(x0, y0, x1, y1, |x, y| centres.push((x, y)));

        for (x, y) in centres {
            let step = self.circle(x, y, r, false);
            acc.pixels_removed += step.pixels_removed;
            for c in step.dirty_chunks {
                if !acc.dirty_chunks.contains(&c) {
                    acc.dirty_chunks.push(c);
                }
            }
            acc.revealed.extend(step.revealed);
        }
        // **Once for the whole sweep** (`M22-RULINGS` R19): `circle` is stamped once
        // per Bresenham centre, so a detector per stamp would open a vortex per pixel
        // of one shovel swing or one lava channel.
        self.note_breach(probe, &mut acc);
        acc
    }

    /// **T22.10: could this carve open the space rim, and was it open here
    /// already?** Taken **before** the carve; [`Map::note_breach`] finishes it.
    ///
    /// **Here, at the two public carves, and nowhere else** (R19): every production
    /// carve — the seven sites R19 lists — goes through `carve_circle` or
    /// `carve_capsule`, so a breach cannot be made by a path this does not see. Not
    /// inside `circle` itself, which also serves `fill_circle` and is stamped per
    /// pixel by the capsule.
    ///
    /// Cheap for almost every carve: nothing on a map with no rim, nothing whose
    /// bounding circle cannot reach the rim band. What is left is a flood over the
    /// carve's box padded by a rim thickness (`space::breach_in`) — **run twice,
    /// before and after** (T22.10C, `M22-RULINGS` R87). The padded box can reach an
    /// *existing* hole, and asking only "does air cross the rim in here?" after
    /// the carve answered yes for a nick 128 px from a hole that never went through
    /// the rim — a phantom vortex over solid rock, which with three live evicts a
    /// real one. **A breach is the change closed → open, not the state open.**
    fn breach_probe(
        &self,
        (x0, y0, x1, y1): (i32, i32, i32, i32),
        (cx, cy): (i32, i32),
    ) -> Option<BreachProbe> {
        let geo = self.space_geometry()?;
        // Onto the map first: a carve that removed rock touched it, but its box may
        // be `i32`-wide (a radius of `i32::MAX` is legal and means "all of it").
        let (w, h) = (self.mask.w as i32, self.mask.h as i32);
        let (x0, y0, x1, y1) = (
            x0.clamp(0, w - 1),
            y0.clamp(0, h - 1),
            x1.clamp(0, w - 1),
            y1.clamp(0, h - 1),
        );
        let half = geo.thickness * 0.5;
        let reach = ((x1 - x0).max(y1 - y0) as f32) * std::f32::consts::FRAC_1_SQRT_2;
        if geo.distance_to_rim(cx as f32, cy as f32) > reach + half + 1.0 {
            return None;
        }
        let pad = geo.thickness as i32 + 2;
        let bbox = (x0 - pad, y0 - pad, x1 + pad, y1 + pad);
        Some(BreachProbe {
            was_open: crate::map::gen::space::breach_in(&self.mask, &geo, bbox),
            geo,
            bbox,
            at: (cx, cy),
        })
    }

    /// The second half of [`Map::breach_probe`], after the carve: a carve that
    /// removed rock, in a box where the rim was closed and now is not, is a breach
    /// — recorded on the result and queued for `World::step_vortices`.
    fn note_breach(&mut self, probe: Option<BreachProbe>, out: &mut CarveResult) {
        let Some(p) = probe else {
            return;
        };
        if out.pixels_removed == 0
            || p.was_open
            || !crate::map::gen::space::breach_in(&self.mask, &p.geo, p.bbox)
        {
            return;
        }
        let at = p.geo.onto_rim(p.at.0 as f32, p.at.1 as f32);
        out.breach = Some(at);
        if self.breaches.len() >= MAX_PENDING_BREACHES {
            self.breaches.remove(0);
        }
        self.breaches.push(at);
    }

    /// Breaches since the last drain, oldest first (T22.10). `World::step_vortices`
    /// is the consumer.
    pub fn take_breaches(&mut self) -> Vec<(i32, i32)> {
        std::mem::take(&mut self.breaches)
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

        // Teleport pads are indestructible (§C5), and that is what guarantees six
        // standable spots for the whole round however much of the map is dug away
        // — including through the floor, once §C15 removes the bedrock. Collected
        // once for the whole circle rather than re-scanned per row: there are six.
        //
        // **Gun platforms join them (T21.11)** for exactly the same reason and
        // through exactly the same rect: a platform you can dig out from under is
        // a platform that falls out of the map, and the coordinator asked for
        // "a couple pixels of ground you cannot destroy under it". One list, so
        // the two cannot disagree about what protection means.
        //
        // Only for a **carve**. `fill_circle` adding rock inside a footprint
        // cannot break the guarantee, and refusing it would make the footprint a
        // hole that nothing can ever fill.
        let protected: Vec<(i32, i32, i32, i32)> = if solid {
            Vec::new()
        } else {
            self.meta
                .teleport_pads
                .iter()
                .map(|p| p.rect())
                .chain(self.meta.gun_platforms.iter().map(|g| g.rect()))
                .filter(|(px0, py0, px1, py1)| {
                    *px1 >= cx - r && *px0 <= cx + r && *py1 >= cy - r && *py0 <= cy + r
                })
                .collect()
        };

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

            // The row's span minus every protected rect crossing it. Sorted and
            // non-empty spans only, so the coarse-cell walk below is unchanged.
            //
            // **A fixed array, not a `Vec`.** This runs once per row of every
            // carve — an r=200 sandbox carve is 400 rows — and the first version
            // allocated on every one of them even though `protected` is empty for
            // nearly every carve. `docs/60` §6 budgets a single-chunk rebake at
            // 4 ms and `perf` asserts against it, so a per-row heap allocation is
            // not free. Each rect cuts at most one span in two, so the pads and
            // the platforms together bound the count at
            // `TELEPORT_PADS + GUN_PLATFORMS + 1`.
            let mut spans = [(0i32, 0i32); TELEPORT_PADS + GUN_PLATFORMS + 1];
            let mut n_spans = 1;
            spans[0] = (x0, x1);
            for &(px0, py0, px1, py1) in &protected {
                if y < py0 || y > py1 {
                    continue;
                }
                let mut next = [(0i32, 0i32); TELEPORT_PADS + GUN_PLATFORMS + 1];
                let mut n_next = 0;
                for &(sx, ex) in &spans[..n_spans] {
                    if ex < px0 || sx > px1 {
                        next[n_next] = (sx, ex);
                        n_next += 1;
                        continue;
                    }
                    if sx < px0 {
                        next[n_next] = (sx, px0 - 1);
                        n_next += 1;
                    }
                    if ex > px1 {
                        next[n_next] = (px1 + 1, ex);
                        n_next += 1;
                    }
                }
                spans = next;
                n_spans = n_next;
            }

            // Split each span at coarse-cell boundaries so the grid can be updated
            // from the exact per-cell counts, with no recounting.
            for &(span_start, span_end) in &spans[..n_spans] {
                let mut sx = span_start;
                while sx <= span_end {
                    let cell_end = ((sx / COARSE_CELL as i32) + 1) * COARSE_CELL as i32 - 1;
                    let ex = cell_end.min(span_end);
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

    /// §C15 inverted this test. It used to be `bedrock_is_never_removed`, and
    /// with `BEDROCK_H` at 0 that version would have kept passing while asserting
    /// **nothing**: its loop ran `h..h`, which is empty. A test that cannot fail
    /// is worse than no test, so it now asserts the opposite thing — the floor
    /// really can be dug through — at every scale, which is where §A19 says a
    /// carve claim has to be measured.
    #[test]
    fn the_floor_can_be_dug_through_at_every_scale() {
        for scale in MapScale::ALL {
            let mut m = generate(4242, scale);
            m.mask = Mask::new_full(m.mask.w, m.mask.h);
            m.coarse = crate::map::CoarseGrid::build(&m.mask);
            m.drain_dirty();
            let (w, h) = (m.mask.w as i32, m.mask.h as i32);

            // The control: the bottom row is solid before the carve, so "it is
            // clear afterwards" is a statement about the carve and not about how
            // the fixture was built.
            assert_eq!(
                m.mask.count_run(h - 1, 0, w - 1),
                m.mask.w,
                "{scale:?}: the fixture's bottom row was not solid to begin with"
            );

            let removed = m.carve_circle(w / 2, h - 5, 60).pixels_removed;
            assert!(
                removed > 0,
                "{scale:?}: a carve at the bottom removed nothing — the floor is \
                 still indestructible"
            );
            assert!(
                !m.mask.get(w / 2, h - 1),
                "{scale:?}: the bottom row survived a carve centred 5 px above it"
            );
        }
    }

    /// The other half of §C15, and the control for the test above: **the walls
    /// did not change.** Without this, "the floor can be carved" is also
    /// satisfied by a build that stopped clamping anything at all.
    #[test]
    fn the_walls_are_still_indestructible_at_the_bottom() {
        let mut m = solid_map();
        let h = m.mask.h as i32;
        m.carve_circle(0, h - 5, 120);
        m.carve_circle(m.mask.w as i32, h - 5, 120);
        for y in (h - 200).max(0)..h {
            for x in 0..WALL_W as i32 {
                assert!(m.mask.get(x, y), "left wall cleared at ({x}, {y})");
                assert!(
                    m.mask.get(m.mask.w as i32 - 1 - x, y),
                    "right wall cleared at ({}, {y})",
                    m.mask.w as i32 - 1 - x
                );
            }
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
        // A slot within the circle's radius but in a **wall** column: the span was
        // clamped away, so the pixel is still solid and the slot stays hidden.
        //
        // It used to sit in the bedrock band, which §C15 deleted — and with
        // `BEDROCK_H` at 0 that version would have quietly started testing a
        // carve that succeeds. The walls are the indestructible thing now, so the
        // test moved to them rather than being dropped.
        let mut m = solid_map();
        let h = m.mask.h as i32;
        let x = WALL_W as i32 / 2;
        m.meta.buried_slots = vec![crate::map::BuriedSlot {
            id: 0,
            pos: Point::new(x, h / 2),
            revealed: false,
        }];
        let r = m.carve_circle(x, h / 2, 20);
        assert!(
            r.revealed.is_empty(),
            "a slot inside an indestructible wall was reported as revealed"
        );
        assert!(m.mask.get(x, h / 2), "the wall should still be solid");
        // The control: the same carve **did** open rock just past the wall, so
        // this is a statement about the clamp and not about a carve that missed.
        assert!(
            !m.mask.get(WALL_W as i32 + 2, h / 2),
            "the carve removed nothing at all, so the clamp proves nothing"
        );
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

    /// The two capsule paths are one path.
    ///
    /// `stamp_capsule` (solid) and `carve_capsule` (clear) were two different
    /// walks — integer 1-px here, float `r/2` there — against a stated
    /// one-rasteriser invariant (§A24). Carving a capsule out of a full mask must
    /// leave exactly the inverse of stamping the same capsule into an empty one,
    /// for every endpoint pair and radius, or the two disagree at the edges and
    /// the client and server masks eventually diverge.
    #[test]
    fn stamping_and_carving_a_capsule_cover_the_same_pixels() {
        use crate::map::shape::stamp_capsule;

        let cases = [
            (60, 60, 300, 60, 9),    // horizontal
            (60, 60, 60, 300, 13),   // vertical, the entrance-shaft case
            (60, 60, 300, 300, 7),   // 45 degrees
            (300, 60, 60, 300, 11),  // the other diagonal
            (200, 200, 260, 210, 5), // shallow
            (200, 200, 200, 200, 6), // zero length
            (100, 100, 400, 180, 1), // radius 1
            (100, 100, 400, 180, 0), // radius 0
        ];

        for (x0, y0, x1, y1, r) in cases {
            let (mw, mh) = {
                let m = solid_map();
                (m.mask.w, m.mask.h)
            };
            let mut stamped = Mask::new_empty(mw, mh);
            stamp_capsule(&mut stamped, x0, y0, x1, y1, r, true);

            let mut map = solid_map();
            map.carve_capsule(x0, y0, x1, y1, r);

            // Compare only where carving is allowed: carve clamps bedrock and the
            // wall columns, and stamp deliberately does not.
            let (w, h) = (mw as i32, mh as i32);
            for y in 0..(h - BEDROCK_H as i32) {
                for x in (WALL_W as i32)..(w - WALL_W as i32) {
                    assert_eq!(
                        stamped.get(x, y),
                        !map.mask.get(x, y),
                        "({x},{y}) disagrees for capsule ({x0},{y0})-({x1},{y1}) r={r}"
                    );
                }
            }
        }
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
    fn a_capsule_respects_the_walls_and_digs_through_the_floor() {
        let mut map = solid_map();
        let h = map.mask.h as i32;
        map.carve_capsule(0, h - 10, map.mask.w as i32, h - 10, 20);
        // §C15: the sweep along the bottom now opens the floor. Asserted between
        // the walls, which is the only part of the row the capsule was allowed
        // to touch.
        let cleared = (WALL_W as i32..map.mask.w as i32 - WALL_W as i32)
            .filter(|&x| !map.mask.get(x, h - 1))
            .count();
        assert!(
            cleared > 0,
            "a capsule swept along the bottom cleared none of the floor"
        );
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

    // ------------------------------------------------------------- T22.10 breach

    /// A Small space map and its rim, and the rim's top centreline point.
    fn space() -> (Map, crate::map::gen::space::SpaceGeometry, (i32, i32)) {
        let map = crate::map::meta::generate_with(
            4242,
            MapScale::Small,
            crate::constants::MapGenerator::Space,
        );
        let geo = map.space_geometry().expect("a space map has a rim");
        let top = (geo.cx.round() as i32, (geo.cy - geo.ry).round() as i32);
        (map, geo, top)
    }

    /// **A breach is a carve through the rim, and only that.** Three carves, each
    /// removing rock: an island in the arena, a nick in the rim's outer face, and a
    /// meteor-sized crater straight through it. Only the last is a breach — the
    /// controls are what stop this passing for a game that calls every carve one.
    #[test]
    fn a_carve_through_the_rim_is_a_breach_and_an_island_or_a_nick_is_not() {
        let (mut map, geo, (tx, ty)) = space();
        let rock = map.meta.asteroids[0];
        let island = map.carve_circle(rock.x, rock.y, rock.r / 2);
        assert!(
            island.pixels_removed > 0,
            "control: the island carve removed nothing"
        );
        assert_eq!(island.breach, None, "an asteroid is not the rim");

        let outer = ty - (geo.thickness * 0.5) as i32;
        let nick = map.carve_circle(tx, outer, 6);
        assert!(nick.pixels_removed > 0, "control: the nick removed nothing");
        assert_eq!(
            nick.breach, None,
            "a nick that does not go through is not a hole"
        );
        assert!(map.take_breaches().is_empty());

        let hole = map.carve_circle(tx, ty, crate::constants::METEOR_CARVE_R as i32);
        let (bx, by) = hole.breach.expect("a crater through the rim is a breach");
        assert!(
            (bx - tx).abs() <= 1 && (by - ty).abs() <= 1,
            "the breach sits on the rim: {bx},{by}"
        );
        assert_eq!(map.take_breaches(), vec![(bx, by)]);
        assert!(map.take_breaches().is_empty(), "drained");
    }

    /// **A breach is closed → open, not "open somewhere in the box"** (T22.10C F2,
    /// `M22-RULINGS` R87). A meteor-sized carve biting half-way into the rim's
    /// outer face — never through it — at 60, 100, 128 and 135 px along the rim
    /// from an existing hole. The padded box reaches that hole at the first four
    /// of those in the old detector, which reported every one as a breach; at
    /// 128 that is past `VORTEX_CAPTURE_R`, so it was a **new vortex over solid
    /// rock**, and with three live it evicted a real one. The control is the same
    /// carve going straight through the rim well clear of the hole: a breach.
    #[test]
    fn a_nick_beside_an_existing_hole_is_not_a_breach_and_a_new_hole_is() {
        let r = crate::constants::METEOR_CARVE_R as i32;
        for d in [60, 100, 128, 135] {
            let (mut map, _, (tx, ty)) = space();
            assert!(
                map.carve_circle(tx, ty, r).breach.is_some(),
                "control: the hole"
            );
            let _ = map.take_breaches();
            // Centred outside the rim so the disc bites half the rim's thickness
            // into the outer face: the inner half is untouched, nothing new crosses.
            // Its lowest point is the rim centreline.
            let nick = map.carve_circle(tx + d, ty - r, r);
            assert!(
                nick.pixels_removed > 0,
                "{d} px: control — the nick removed nothing"
            );
            assert_eq!(
                nick.breach, None,
                "{d} px from a hole: a nick that never went through the rim is a breach"
            );
            assert!(map.take_breaches().is_empty());
        }
        let (mut map, _, (tx, ty)) = space();
        let _ = map.carve_circle(tx, ty, r);
        let _ = map.take_breaches();
        assert!(
            map.carve_circle(tx + 300, ty, r).breach.is_some(),
            "control: a second hole clear of the first is a breach"
        );
    }

    /// **One capsule, one breach** (`M22-RULINGS` R19). A shovel swing or a lava
    /// channel stamps `circle` once per Bresenham centre — here about eighty — so a
    /// detector per stamp would queue a breach per pixel of one swing.
    #[test]
    fn a_capsule_through_the_rim_is_one_breach_not_one_per_stamp() {
        let (mut map, geo, (tx, ty)) = space();
        let x = tx + 300;
        let t = geo.thickness as i32;
        let out = map.carve_capsule(x, ty - t - 8, x, ty + t + 8, 6);
        assert!(
            out.breach.is_some(),
            "a channel through the rim is a breach"
        );
        assert_eq!(map.take_breaches().len(), 1);
    }

    /// The landscape generators have no rim, so nothing there is ever a breach —
    /// however large the crater or wherever it lands.
    #[test]
    fn no_carve_on_a_landscape_map_is_a_breach() {
        let mut map = generate(4242, MapScale::Small);
        assert!(map.space_geometry().is_none());
        let mut removed = 0;
        for (x, y) in [(200, 150), (1024, 100), (1800, 900)] {
            let out = map.carve_circle(x, y, 60);
            assert_eq!(out.breach, None);
            removed += out.pixels_removed;
        }
        // T22.10C F8: a carve into empty sky is not a breach on any map, so this
        // is only a claim about landscape *rock* if some of it went.
        assert!(removed > 0, "control: none of the carves removed rock");
        assert!(map.take_breaches().is_empty());
    }
}
