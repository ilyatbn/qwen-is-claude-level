//! Pass 6: connected components and cleanup.
//!
//! Deletes floating gravel that would look like rendering noise, fills sealed
//! bubbles too small to matter, and — importantly — **keeps** the larger sealed air
//! pockets. Those are legitimate caves, and they are where buried items live.
//!
//! Flood fill is iterative with an explicit stack. Never recursion: a 4096×2048 map
//! has components of millions of pixels and a recursive fill blows the stack
//! immediately, from a call site that looks innocent.
//!
//! See `docs/10-map-generation.md` §Pass 6.

use crate::constants::{MIN_BLOB_PX, MIN_POCKET_PX};
use crate::map::gen::silhouette::force_borders;
use crate::map::Mask;
use crate::math::Point;

/// 0 means "not part of a component of the requested colour".
pub struct Components {
    pub labels: Vec<u32>,
    /// Indexed by label; `sizes[0]` is unused and always 0.
    pub sizes: Vec<u32>,
    pub count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedPocket {
    pub label: u32,
    pub size: u32,
    pub centroid: Point,
}

/// Label 4-connected regions of `solid` (`true`) or air (`false`).
pub fn label(mask: &Mask, solid: bool) -> Components {
    let (w, h) = (mask.w as i32, mask.h as i32);
    let mut labels = vec![0u32; (w as usize) * (h as usize)];
    let mut sizes = vec![0u32]; // index 0 reserved
    let mut count = 0u32;

    // One stack, reused across every component. Growing a fresh Vec per component
    // is where this pass otherwise spends its time.
    let mut stack: Vec<Point> = Vec::with_capacity(4096);

    for y0 in 0..h {
        for x0 in 0..w {
            let idx0 = (y0 as usize) * (w as usize) + x0 as usize;
            if labels[idx0] != 0 || mask.get(x0, y0) != solid {
                continue;
            }

            count += 1;
            let this = count;
            let mut size = 0u32;

            stack.clear();
            stack.push(Point::new(x0, y0));
            labels[idx0] = this;

            while let Some(p) = stack.pop() {
                size += 1;
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let (nx, ny) = (p.x + dx, p.y + dy);
                    if nx < 0 || ny < 0 || nx >= w || ny >= h {
                        continue;
                    }
                    let idx = (ny as usize) * (w as usize) + nx as usize;
                    if labels[idx] != 0 || mask.get(nx, ny) != solid {
                        continue;
                    }
                    labels[idx] = this;
                    stack.push(Point::new(nx, ny));
                }
            }

            sizes.push(size);
        }
    }

    Components {
        labels,
        sizes,
        count,
    }
}

/// Pass 6, in the order the doc specifies. Returns the sealed air pockets that
/// survived, for buried-item placement in T1.13.
pub fn cleanup(mask: &mut Mask) -> Vec<SealedPocket> {
    let (w, h) = (mask.w as i32, mask.h as i32);

    // ---- 1. Delete solid components smaller than MIN_BLOB_PX ----------------
    {
        let solid = label(mask, true);
        for y in 0..h {
            for x in 0..w {
                let l = solid.labels[(y as usize) * (w as usize) + x as usize];
                if l != 0 && solid.sizes[l as usize] < MIN_BLOB_PX {
                    mask.clear(x, y);
                }
            }
        }
        // `solid` (up to 32 MB of labels at the largest scale) is dropped here,
        // before the second labelling allocates its own.
    }

    // ---- 2. Re-label air and fill the tiny pockets --------------------------
    // The re-label is the subtle part: deleting solid blobs MERGES air regions, so
    // labels from before the deletion would mis-classify a large cave as tiny.
    let air = label(mask, false);
    for y in 0..h {
        for x in 0..w {
            let l = air.labels[(y as usize) * (w as usize) + x as usize];
            if l != 0 && air.sizes[l as usize] < MIN_POCKET_PX {
                mask.set(x, y);
            }
        }
    }

    // ---- 3. Everything that is still air and not the sky is a sealed pocket --
    // The sky region is the air component containing (w/2, 0).
    let sky_label = air.labels[(w / 2) as usize];

    let mut sums: Vec<(u64, u64, u32)> = vec![(0, 0, 0); (air.count + 1) as usize];
    for y in 0..h {
        for x in 0..w {
            let l = air.labels[(y as usize) * (w as usize) + x as usize];
            if l == 0 || l == sky_label {
                continue;
            }
            if air.sizes[l as usize] < MIN_POCKET_PX {
                continue; // filled above
            }
            let e = &mut sums[l as usize];
            e.0 += x as u64;
            e.1 += y as u64;
            e.2 += 1;
        }
    }

    let mut pockets = Vec::new();
    for (l, &(sx, sy, n)) in sums.iter().enumerate() {
        if n == 0 {
            continue;
        }
        pockets.push(SealedPocket {
            label: l as u32,
            size: n,
            centroid: Point::new((sx / n as u64) as i32, (sy / n as u64) as i32),
        });
    }

    force_borders(mask);
    pockets
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::silhouette::{borders_hold, silhouette, GenParams};

    const W: u32 = 512;
    const H: u32 = 512;

    fn fill_rect(m: &mut Mask, x0: i32, y0: i32, x1: i32, y1: i32) {
        for y in y0..=y1 {
            m.set_run(y, x0, x1);
        }
    }

    fn clear_rect(m: &mut Mask, x0: i32, y0: i32, x1: i32, y1: i32) {
        for y in y0..=y1 {
            m.clear_run(y, x0, x1);
        }
    }

    #[test]
    fn empty_mask_has_no_solid_components() {
        let m = Mask::new_empty(W, H);
        assert_eq!(label(&m, true).count, 0);
    }

    #[test]
    fn full_mask_is_one_component() {
        let m = Mask::new_full(W, H);
        let c = label(&m, true);
        assert_eq!(c.count, 1);
        assert_eq!(c.sizes[1], W * H);
    }

    #[test]
    fn two_separated_squares_are_two_components() {
        let mut m = Mask::new_empty(W, H);
        fill_rect(&mut m, 10, 10, 19, 19); // 100 px
        fill_rect(&mut m, 100, 100, 119, 119); // 400 px
        let c = label(&m, true);
        assert_eq!(c.count, 2);
        let mut sizes: Vec<u32> = c.sizes[1..].to_vec();
        sizes.sort_unstable();
        assert_eq!(sizes, vec![100, 400]);
    }

    #[test]
    fn diagonally_touching_squares_are_two_components() {
        // 4-connectivity, not 8. If this ever returns 1, the neighbour list has
        // grown diagonals and every size in the pipeline shifts.
        let mut m = Mask::new_empty(W, H);
        fill_rect(&mut m, 10, 10, 19, 19);
        fill_rect(&mut m, 20, 20, 29, 29);
        assert_eq!(label(&m, true).count, 2);
    }

    #[test]
    fn a_million_pixel_component_does_not_overflow_the_stack() {
        // The test that catches accidental recursion.
        let m = Mask::new_full(2048, 1024); // 2 M pixels, one component
        let c = label(&m, true);
        assert_eq!(c.count, 1);
        assert_eq!(c.sizes[1], 2048 * 1024);
    }

    #[test]
    fn cleanup_deletes_small_blobs_and_keeps_large_ones() {
        let mut m = Mask::new_empty(W, H);
        // 100 px — below MIN_BLOB_PX (400), must go.
        fill_rect(&mut m, 30, 200, 39, 209);
        // 1024 px — above, must stay.
        fill_rect(&mut m, 200, 200, 231, 231);
        cleanup(&mut m);

        assert!(!m.get(35, 205), "small blob survived");
        assert!(m.get(215, 215), "large blob was deleted");
    }

    #[test]
    fn cleanup_fills_small_pockets_and_keeps_large_ones() {
        let mut m = Mask::new_full(W, H);
        // 49 px pocket — below MIN_POCKET_PX (250), must be filled.
        clear_rect(&mut m, 100, 100, 106, 106);
        // 900 px pocket — above, must survive as a sealed pocket.
        clear_rect(&mut m, 300, 300, 329, 329);
        let pockets = cleanup(&mut m);

        assert!(m.get(103, 103), "small pocket was not filled");
        assert!(!m.get(315, 315), "large pocket was filled");

        assert_eq!(pockets.len(), 1, "expected exactly one sealed pocket");
        let p = &pockets[0];
        assert_eq!(p.size, 900);
        assert!(
            (p.centroid.x - 314).abs() <= 1 && (p.centroid.y - 314).abs() <= 1,
            "centroid {:?} is not in the middle of the pocket",
            p.centroid
        );
        assert!(!m.get(p.centroid.x, p.centroid.y), "centroid is not air");
    }

    #[test]
    fn a_cave_open_to_the_sky_is_not_sealed() {
        let mut m = Mask::new_full(W, H);
        // A shaft from the very top down into a chamber: connected to the sky, so
        // it is not a pocket no matter how big it is.
        clear_rect(&mut m, 250, 0, 259, 300);
        clear_rect(&mut m, 200, 300, 320, 360);
        let pockets = cleanup(&mut m);
        assert!(
            pockets.is_empty(),
            "a sky-connected cave was reported as sealed: {pockets:?}"
        );
    }

    #[test]
    fn a_sealed_cave_and_a_sky_cave_are_told_apart() {
        let mut m = Mask::new_full(W, H);
        clear_rect(&mut m, 250, 0, 259, 200); // shaft to sky
        clear_rect(&mut m, 200, 200, 320, 240); // open cave
        clear_rect(&mut m, 60, 400, 120, 440); // sealed cave, 61*41 px
        let pockets = cleanup(&mut m);

        assert_eq!(pockets.len(), 1);
        assert!(pockets[0].centroid.x > 55 && pockets[0].centroid.x < 125);
        assert!(pockets[0].centroid.y > 395 && pockets[0].centroid.y < 445);
    }

    #[test]
    fn re_labelling_after_blob_deletion_is_not_skipped() {
        // Two air pockets, each below MIN_POCKET_PX on its own, separated by a thin
        // solid blob that is itself below MIN_BLOB_PX. Deleting the blob MERGES
        // them into one pocket that is above the threshold and must survive.
        //
        // With stale labels this fills both, and a legitimate cave silently
        // disappears.
        let mut m = Mask::new_full(W, H);
        clear_rect(&mut m, 100, 100, 115, 109); // 160 px
        clear_rect(&mut m, 100, 112, 115, 121); // 160 px
                                                // The divider is rows 110..111 over x 100..115 = 32 px, but it is joined to
                                                // the surrounding rock, so instead cut it free:
        clear_rect(&mut m, 96, 96, 119, 125); // widen to isolate
        fill_rect(&mut m, 100, 110, 115, 111); // the 32 px divider, now floating

        let pockets = cleanup(&mut m);
        // The divider (32 px < 400) is deleted, so the whole 24x30 hole is one
        // pocket of 720 px and survives.
        assert!(!m.get(107, 110), "the floating divider was not deleted");
        assert_eq!(pockets.len(), 1, "the merged pocket was lost: {pockets:?}");
        assert!(pockets[0].size > MIN_POCKET_PX);
    }

    #[test]
    fn borders_hold_afterwards() {
        let p = GenParams::default_for(MapScale::Small);
        for seed in 0..6 {
            let mut m = silhouette(seed, &p);
            cleanup(&mut m);
            assert!(borders_hold(&m), "seed {seed}");
        }
    }

    #[test]
    fn determinism() {
        let p = GenParams::default_for(MapScale::Small);
        let base = silhouette(4242, &p);
        let mut first = base.clone();
        let pockets = cleanup(&mut first);
        let hash = first.hash();
        for _ in 0..20 {
            let mut m = base.clone();
            let q = cleanup(&mut m);
            assert_eq!(m.hash(), hash);
            assert_eq!(q, pockets);
        }
    }

    #[test]
    fn cleanup_on_a_real_map_removes_gravel() {
        let p = GenParams::default_for(MapScale::Small);
        let mut m = silhouette(11, &p);
        crate::map::gen::caves::carve_caves(&mut m, 11, &p);
        crate::map::gen::smooth::smooth(&mut m);

        let before = label(&m, true).count;
        cleanup(&mut m);
        let after = label(&m, true).count;
        assert!(
            after <= before,
            "cleanup increased the component count: {before} -> {after}"
        );
    }
}
