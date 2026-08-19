//! Pass 7a: walkable surface extraction.
//!
//! [`is_standable`] is exported and reused **at runtime**, because the map gets
//! destroyed. `MapMeta.surface_points` is a snapshot of the pristine map; by minute
//! three many of those points are mid-air. Respawn (T4.13) and periodic item spawns
//! (T4.05) re-check with this exact function. A second copy of this logic anywhere
//! would be a bug waiting to happen.
//!
//! See `docs/10-map-generation.md` §Pass 7a.

use crate::constants::{HEAD_CLEARANCE, PLAYER_H, PLAYER_W, SURFACE_SAMPLE_STEP};
use crate::map::Mask;
use crate::math::Point;

/// Half the player box width, in pixels, rounded out. The box is centred on `x`.
const HALF_W: i32 = (PLAYER_W as i32) / 2;
const BODY_H: i32 = PLAYER_H as i32;

/// Solid pixels required in the row beneath the body box for it to count as
/// supported.
///
/// One pixel is enough to physically stop an AABB, but a lone pinnacle is not a
/// place anyone can usefully be put — spawns and items placed there would be
/// perched on a needle. Three is enough to reject a spike while accepting every
/// real ledge and slope.
const MIN_SUPPORT_PX: u32 = 3;

/// Can a player stand with their feet at `(x, y)`?
///
/// All of:
/// - the `PLAYER_W × PLAYER_H` box whose bottom edge is at `y` is entirely air;
/// - the row immediately below the box has at least `MIN_SUPPORT_PX` solid pixels
///   within the box's width;
/// - at least `HEAD_CLEARANCE` px of air directly above `y` at column `x`.
///
/// The support test looks at the whole width of the box rather than only the pixel
/// under `x`. That is how an AABB actually rests: on a slope the box sits on the
/// highest ground beneath it, and the centre column may be air. Requiring solid
/// directly under the centre rejects every sloped surface on the map — measured at
/// 168 of 192 sampled columns on a medium map, which starves spawns and item
/// placement of anywhere to go.
pub fn is_standable(mask: &Mask, x: i32, y: i32) -> bool {
    // The centre must be inside the world. Without this an x a few pixels off the
    // left edge reads as standable: out-of-bounds is air, so the half of the body
    // box that hangs outside looks clear and the half inside finds real support.
    if x < 0 || x >= mask.w as i32 || y < 0 || y + 1 >= mask.h as i32 {
        return false;
    }

    // The body box: bottom edge at y, centred on x.
    let (x0, x1) = (x - HALF_W, x + HALF_W - 1);
    for by in (y - BODY_H + 1)..=y {
        if mask.count_run(by, x0, x1) != 0 {
            return false;
        }
    }

    if mask.count_run(y + 1, x0, x1) < MIN_SUPPORT_PX {
        return false;
    }

    // Head clearance straight up. Early-out on the first solid pixel.
    for hy in (y - HEAD_CLEARANCE)..=y {
        if mask.get(x, hy) {
            return false;
        }
    }

    true
}

/// Every point a player could stand on, sampled every `SURFACE_SAMPLE_STEP`
/// columns, ordered by x then y.
///
/// Collects **every** standable y per column, not just the topmost. That is what
/// finds cave floors, ledges under overhangs and island tops — players walk on all
/// of them, and validation, spawns and item placement all consume this set. Taking
/// only the outer skin would make half the map invisible to the rest of the
/// pipeline.
pub fn extract_surface(mask: &Mask) -> Vec<Point> {
    let (w, h) = (mask.w as i32, mask.h as i32);
    let mut points = Vec::new();

    let mut x = 0;
    while x < w {
        for y in 0..h - 1 {
            if is_standable(mask, x, y) {
                points.push(Point::new(x, y));
            }
        }
        x += SURFACE_SAMPLE_STEP;
    }

    points
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::silhouette::GenParams;

    const W: u32 = 512;
    const H: u32 = 256;

    fn floor_at(y: i32) -> Mask {
        let mut m = Mask::new_empty(W, H);
        for fy in y..H as i32 {
            m.set_run(fy, 0, W as i32 - 1);
        }
        m
    }

    #[test]
    fn a_flat_floor_yields_one_point_per_sampled_column() {
        let m = floor_at(200);
        let pts = extract_surface(&m);
        assert_eq!(pts.len(), (W / SURFACE_SAMPLE_STEP as u32) as usize);
        for p in &pts {
            assert_eq!(p.y, 199, "point {p:?} not on the floor");
        }
    }

    #[test]
    fn a_one_pixel_spike_is_not_standable() {
        let mut m = Mask::new_empty(W, H);
        m.set(100, 200); // a single pixel, nothing else
        assert!(
            !is_standable(&m, 100, 199),
            "a player cannot balance on one pixel"
        );
    }

    #[test]
    fn head_clearance_is_enforced_exactly() {
        // Floor at y=200 (feet stand at 199). A ceiling HEAD_CLEARANCE-1 above the
        // feet blocks it; HEAD_CLEARANCE+1 above does not.
        let mut tight = floor_at(200);
        for y in 0..=(199 - (HEAD_CLEARANCE - 1)) {
            tight.set_run(y, 0, W as i32 - 1);
        }
        assert!(!is_standable(&tight, 100, 199), "tight ceiling was allowed");

        let mut roomy = floor_at(200);
        for y in 0..=(199 - (HEAD_CLEARANCE + 1)) {
            roomy.set_run(y, 0, W as i32 - 1);
        }
        assert!(is_standable(&roomy, 100, 199), "roomy ceiling was rejected");
    }

    #[test]
    fn a_two_level_cave_yields_two_points_in_one_column() {
        let mut m = Mask::new_empty(W, H);
        // Lower floor at y=200, roof of the cave at y=150, upper floor at y=140.
        for y in 200..H as i32 {
            m.set_run(y, 0, W as i32 - 1);
        }
        for y in 140..150 {
            m.set_run(y, 0, W as i32 - 1);
        }
        let pts: Vec<Point> = extract_surface(&m)
            .into_iter()
            .filter(|p| p.x == 96)
            .collect();
        assert_eq!(pts.len(), 2, "expected two levels, got {pts:?}");
        assert_eq!(pts[0].y, 139, "upper floor");
        assert_eq!(pts[1].y, 199, "cave floor");
    }

    #[test]
    fn a_solid_column_with_no_air_yields_nothing() {
        let m = Mask::new_full(W, H);
        assert!(extract_surface(&m).is_empty());
    }

    #[test]
    fn an_all_air_mask_yields_nothing() {
        let m = Mask::new_empty(W, H);
        assert!(extract_surface(&m).is_empty());
    }

    #[test]
    fn points_are_ordered_by_x_then_y() {
        let mut m = Mask::new_empty(W, H);
        for y in 200..H as i32 {
            m.set_run(y, 0, W as i32 - 1);
        }
        for y in 100..110 {
            m.set_run(y, 0, W as i32 - 1);
        }
        let pts = extract_surface(&m);
        for w in pts.windows(2) {
            assert!(
                (w[0].x, w[0].y) < (w[1].x, w[1].y),
                "not ordered: {:?} then {:?}",
                w[0],
                w[1]
            );
        }
    }

    #[test]
    fn a_ledge_exactly_player_wide_is_standable_only_at_its_centre() {
        // A PLAYER_W-wide ledge: standable at the centre, not one pixel either side
        // (the box would overhang into the wall beside it).
        let mut m = Mask::new_empty(W, H);
        let cx = 200;
        // The ledge itself.
        m.set_run(200, cx - HALF_W, cx + HALF_W - 1);
        // Walls hugging both ends, tall enough to block the body box.
        for y in 160..200 {
            m.set(cx - HALF_W - 1, y);
            m.set(cx + HALF_W, y);
        }

        assert!(
            is_standable(&m, cx, 199),
            "centre of the ledge is not standable"
        );
        assert!(
            !is_standable(&m, cx - 1, 199),
            "one px left should overhang into the wall"
        );
        assert!(
            !is_standable(&m, cx + 1, 199),
            "one px right should overhang into the wall"
        );
    }

    #[test]
    fn feet_must_be_air_over_solid() {
        let m = floor_at(200);
        assert!(is_standable(&m, 100, 199));
        assert!(!is_standable(&m, 100, 200), "feet inside the floor");
        assert!(
            !is_standable(&m, 100, 198),
            "floating one px above the floor"
        );
    }

    #[test]
    fn a_real_map_yields_a_plausible_number_of_points() {
        // Near zero means an earlier pass broke; enormous means the sampling step
        // was lost. Runs the FULL v2 pipeline — islands, bridges and cave chambers
        // all contribute floors, so a partial pipeline undercounts badly (measured:
        // 135 without them, 212-285 with).
        let p = GenParams::default_for(MapScale::Medium);
        let seed = 4242;
        let mut m = crate::map::gen::silhouette::silhouette(seed, &p);
        let islands = crate::map::gen::blobs::add_blobs(&mut m, seed, &p);
        crate::map::gen::bridges::add_bridges(&mut m, seed, &p, &islands);
        crate::map::gen::network::carve_network(&mut m, seed, &p);
        crate::map::gen::caves::carve_caves(&mut m, seed, &p);
        crate::map::gen::carvings::carve_crevices(&mut m, seed, &p);
        crate::map::gen::carvings::carve_voids(&mut m, seed, &p);
        crate::map::gen::smooth::smooth(&mut m);
        crate::map::gen::components::cleanup(&mut m);

        let pts = extract_surface(&m);
        assert!(
            (200..=4000).contains(&pts.len()),
            "implausible surface point count: {}",
            pts.len()
        );
    }

    #[test]
    fn is_standable_is_false_outside_the_map() {
        let m = floor_at(200);
        assert!(!is_standable(&m, -5, 199));
        assert!(!is_standable(&m, W as i32 + 5, 199));
        assert!(!is_standable(&m, 100, -5));
        assert!(!is_standable(&m, 100, H as i32 + 5));
    }
}
