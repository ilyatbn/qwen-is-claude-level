//! The one circle rasteriser.
//!
//! **Every** solid stamp and every carve in this project goes through
//! [`stamp_circle`]. That is not a style preference: the client replays the
//! server's carves against its own mask and the two must end up bit-identical
//! (`docs/11-map-destruction.md` §2, §6). A second rasteriser written with float
//! distance tests would disagree with this one at the edges, and the divergence
//! would present months later as "sometimes I get shot through a wall".
//!
//! Integer arithmetic throughout: `isqrt` per row, then a single run write.

use crate::map::Mask;
use crate::math::isqrt;

/// Fill or clear a disc of radius `r` centred on `(cx, cy)`.
///
/// Radius 0 touches exactly one pixel. Overhanging the map edge is fine — runs
/// clamp, and `Mask` treats out-of-bounds writes as no-ops.
pub fn stamp_circle(mask: &mut Mask, cx: i32, cy: i32, r: i32, solid: bool) {
    if r < 0 {
        return;
    }
    let rr = r * r;
    for dy in -r..=r {
        let y = cy + dy;
        if y < 0 || y >= mask.h as i32 {
            continue;
        }
        let dx = isqrt(rr - dy * dy);
        if solid {
            mask.set_run(y, cx - dx, cx + dx);
        } else {
            mask.clear_run(y, cx - dx, cx + dx);
        }
    }
}

/// Clear a disc and report how many solid pixels it removed. Carve (T1.14) needs
/// the count to maintain the coarse grid without recounting.
pub fn carve_circle_counted(mask: &mut Mask, cx: i32, cy: i32, r: i32) -> u32 {
    if r < 0 {
        return 0;
    }
    let rr = r * r;
    let mut removed = 0;
    for dy in -r..=r {
        let y = cy + dy;
        if y < 0 || y >= mask.h as i32 {
            continue;
        }
        let dx = isqrt(rr - dy * dy);
        removed += mask.clear_run(y, cx - dx, cx + dx);
    }
    removed
}

/// Stamp a thick line as a swept circle, used for bridges, tunnels and (in M5)
/// lava channels. Steps along the segment so consecutive discs overlap.
pub fn stamp_capsule(mask: &mut Mask, x0: i32, y0: i32, x1: i32, y1: i32, r: i32, solid: bool) {
    let (dx, dy) = ((x1 - x0) as f32, (y1 - y0) as f32);
    let len = (dx * dx + dy * dy).sqrt();
    // Step by at most half a radius so the discs overlap and leave no scalloping;
    // never less than 1 px, or a long capsule becomes a very long loop.
    let step = (r as f32 * 0.5).max(1.0);
    let n = (len / step).ceil().max(1.0) as i32;
    for i in 0..=n {
        let t = i as f32 / n as f32;
        stamp_circle(
            mask,
            x0 + (dx * t).round() as i32,
            y0 + (dy * t).round() as i32,
            r,
            solid,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u32 = 512;
    const H: u32 = 512;

    /// Brute-force reference: exactly the pixels a float distance test would call
    /// inside the circle. `stamp_circle` uses integer `isqrt`, so per row it may
    /// differ by at most one pixel at each end.
    fn reference_count(r: i32) -> u64 {
        let mut n = 0u64;
        for dy in -r..=r {
            for dx in -r..=r {
                if dx * dx + dy * dy <= r * r {
                    n += 1;
                }
            }
        }
        n
    }

    #[test]
    fn radius_zero_sets_exactly_one_pixel() {
        let mut m = Mask::new_empty(W, H);
        stamp_circle(&mut m, 100, 100, 0, true);
        assert_eq!(m.count_solid(), 1);
        assert!(m.get(100, 100));
    }

    #[test]
    fn radius_one_is_a_plus_shape() {
        let mut m = Mask::new_empty(W, H);
        stamp_circle(&mut m, 100, 100, 1, true);
        // isqrt(1 - 1) = 0 for the top and bottom rows, isqrt(1) = 1 for the middle.
        assert_eq!(m.count_solid(), 5);
        for (x, y) in [(100, 99), (99, 100), (100, 100), (101, 100), (100, 101)] {
            assert!(m.get(x, y), "({x},{y})");
        }
        assert!(!m.get(99, 99));
    }

    #[test]
    fn area_matches_a_brute_force_count_within_a_pixel_per_row() {
        for r in [2, 3, 5, 8, 13, 21, 40, 64, 130] {
            let mut m = Mask::new_empty(W, H);
            stamp_circle(&mut m, 200, 200, r, true);
            let actual = m.count_solid();
            let expected = reference_count(r);
            let rows = (2 * r + 1) as u64;
            assert!(
                actual.abs_diff(expected) <= rows,
                "r={r}: {actual} vs reference {expected}"
            );
            // And it must never exceed the true disc.
            assert!(actual <= expected, "r={r}: stamped outside the disc");
        }
    }

    #[test]
    fn every_stamped_pixel_is_inside_the_radius() {
        let r = 37;
        let mut m = Mask::new_empty(W, H);
        stamp_circle(&mut m, 128, 128, r, true);
        for y in 0..H as i32 {
            for x in 0..W as i32 {
                if m.get(x, y) {
                    let (dx, dy) = (x - 128, y - 128);
                    assert!(dx * dx + dy * dy <= r * r, "({x},{y}) outside r={r}");
                }
            }
        }
    }

    #[test]
    fn stamping_is_symmetric() {
        let mut m = Mask::new_empty(W, H);
        stamp_circle(&mut m, 256, 256, 29, true);
        for d in 0..=29 {
            for s in 0..=29 {
                assert_eq!(
                    m.get(256 + d, 256 + s),
                    m.get(256 - d, 256 + s),
                    "x asymmetry at d={d} s={s}"
                );
                assert_eq!(
                    m.get(256 + d, 256 + s),
                    m.get(256 + d, 256 - s),
                    "y asymmetry at d={d} s={s}"
                );
            }
        }
    }

    #[test]
    fn overhanging_the_edge_does_not_panic_or_wrap() {
        let mut m = Mask::new_empty(W, H);
        stamp_circle(&mut m, 0, 0, 20, true);
        // Nothing may have wrapped onto the right-hand side of a row.
        for y in 0..25 {
            assert!(!m.get(W as i32 - 1, y), "wrapped at row {y}");
        }
        stamp_circle(&mut m, W as i32 - 1, H as i32 - 1, 20, true);
        for y in (H as i32 - 25)..H as i32 {
            assert!(!m.get(0, y), "wrapped at row {y}");
        }
        // Entirely outside is a silent no-op.
        let before = m.count_solid();
        stamp_circle(&mut m, -500, -500, 10, true);
        stamp_circle(&mut m, 5000, 5000, 10, true);
        assert_eq!(m.count_solid(), before);
    }

    #[test]
    fn clearing_is_the_exact_inverse_of_stamping() {
        let mut m = Mask::new_empty(W, H);
        stamp_circle(&mut m, 200, 180, 45, true);
        let n = m.count_solid();
        assert!(n > 0);
        stamp_circle(&mut m, 200, 180, 45, false);
        assert_eq!(m.count_solid(), 0, "clear did not undo the same pixels");

        // And the counted carve reports exactly what it removed.
        stamp_circle(&mut m, 200, 180, 45, true);
        assert_eq!(carve_circle_counted(&mut m, 200, 180, 45), n as u32);
        assert_eq!(
            carve_circle_counted(&mut m, 200, 180, 45),
            0,
            "not idempotent"
        );
    }

    #[test]
    fn negative_radius_is_a_no_op() {
        let mut m = Mask::new_empty(W, H);
        stamp_circle(&mut m, 100, 100, -3, true);
        assert_eq!(m.count_solid(), 0);
        assert_eq!(carve_circle_counted(&mut m, 100, 100, -3), 0);
    }

    #[test]
    fn capsule_connects_its_endpoints() {
        let mut m = Mask::new_empty(W, H);
        stamp_capsule(&mut m, 50, 50, 400, 300, 6, true);
        assert!(m.get(50, 50));
        assert!(m.get(400, 300));

        // Walk the segment: every sample along it must be solid, i.e. no gaps.
        for i in 0..=100 {
            let t = i as f32 / 100.0;
            let x = (50.0 + 350.0 * t).round() as i32;
            let y = (50.0 + 250.0 * t).round() as i32;
            assert!(m.get(x, y), "gap in the capsule at ({x},{y})");
        }
    }

    #[test]
    fn capsule_of_zero_length_is_just_a_circle() {
        let mut a = Mask::new_empty(W, H);
        stamp_capsule(&mut a, 100, 100, 100, 100, 9, true);
        let mut b = Mask::new_empty(W, H);
        stamp_circle(&mut b, 100, 100, 9, true);
        assert_eq!(a.hash(), b.hash());
    }

    #[test]
    fn stamping_twice_is_idempotent() {
        let mut m = Mask::new_empty(W, H);
        stamp_circle(&mut m, 300, 300, 50, true);
        let once = m.hash();
        stamp_circle(&mut m, 300, 300, 50, true);
        assert_eq!(m.hash(), once);
    }
}
