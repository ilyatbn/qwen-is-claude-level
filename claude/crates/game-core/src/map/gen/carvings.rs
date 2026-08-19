//! Passes 4b and 4c (v2): crevices and voids.
//!
//! **Crevices** are narrow cracks that open the surface into the rock. They are how
//! you fall into a cave without meaning to, and how a fight on the surface suddenly
//! becomes a fight underground.
//!
//! **Voids** are big irregular holes punched through the mass. They create chasms
//! and arches, and — once cleanup deletes what is left dangling — genuine islands.
//!
//! See `docs/70-amendments-v2.md` §A2 Pass 4b, Pass 4c.

use crate::constants::{
    BEDROCK_H, CREVICE_DEPTH_MAX, CREVICE_DEPTH_MIN, CREVICE_STEP, CREVICE_WANDER,
    CREVICE_WIDTH_MAX, CREVICE_WIDTH_MIN, SKY_MARGIN, VOID_MIN_SEPARATION, VOID_RADIUS_MAX,
    VOID_RADIUS_MIN, WALL_W,
};
use crate::map::gen::silhouette::{force_borders, GenParams};
use crate::map::shape::stamp_circle;
use crate::map::Mask;
use crate::math::{lerp, Point, PI};
use crate::rng::{range_f32, range_i32, substream};

/// Attempts to find a column whose surface a crevice can start from.
const START_ATTEMPTS: u32 = 200;

/// A crevice tapers to this fraction of its starting width at the bottom.
const TAPER_TO: f32 = 0.6;

/// Narrow cracks opening the surface into the rock.
///
/// Returns each crevice's stamped centres.
pub fn carve_crevices(mask: &mut Mask, seed: u64, params: &GenParams) -> Vec<Vec<Point>> {
    let mut rng = substream(seed, "crevices");
    let mut paths = Vec::with_capacity(params.crevice_count as usize);
    let (w, h) = (mask.w as i32, mask.h as i32);
    let floor = h - BEDROCK_H as i32;

    for _ in 0..params.crevice_count {
        // Find a column with a surface to start from. A column that is empty all
        // the way down (open sky over a chasm) is skipped rather than retried
        // forever.
        let mut start = None;
        for _ in 0..START_ATTEMPTS {
            let x = range_i32(&mut rng, WALL_W as i32 + 20, w - WALL_W as i32 - 20);
            if let Some(y) = surface_y(mask, x, floor) {
                start = Some(Point::new(x, y));
                break;
            }
        }
        let Some(start) = start else { continue };

        let width = range_i32(&mut rng, CREVICE_WIDTH_MIN, CREVICE_WIDTH_MAX);
        let depth = range_i32(&mut rng, CREVICE_DEPTH_MIN, CREVICE_DEPTH_MAX);
        let steps = (depth / CREVICE_STEP).max(1);

        // Straight down, wandering a little.
        let mut heading = PI / 2.0;
        let mut pos = (start.x as f32, start.y as f32);
        let mut path = Vec::with_capacity(steps as usize + 1);

        for i in 0..=steps {
            let t = i as f32 / steps as f32;
            let r = ((lerp(1.0, TAPER_TO, t) * width as f32) / 2.0).round() as i32;

            let p = Point::new(pos.0.round() as i32, pos.1.round() as i32);
            if p.y >= floor || p.x < WALL_W as i32 || p.x >= w - WALL_W as i32 {
                break;
            }
            stamp_circle(mask, p.x, p.y, r.max(1), false);
            path.push(p);

            heading += range_f32(&mut rng, -CREVICE_WANDER, CREVICE_WANDER);
            pos.0 += heading.cos() * CREVICE_STEP as f32;
            pos.1 += heading.sin() * CREVICE_STEP as f32;
        }

        paths.push(path);
    }

    force_borders(mask);
    paths
}

/// The first solid pixel in a column, i.e. the surface. `None` for a column with
/// no rock in it.
fn surface_y(mask: &Mask, x: i32, floor: i32) -> Option<i32> {
    (SKY_MARGIN as i32..floor).find(|&y| mask.get(x, y))
}

/// Big irregular holes that create chasms, arches and islands.
///
/// Returns the void centres.
pub fn carve_voids(mask: &mut Mask, seed: u64, params: &GenParams) -> Vec<Point> {
    let mut rng = substream(seed, "voids");
    let (w, h) = (mask.w as i32, mask.h as i32);
    let y_lo = SKY_MARGIN as i32;
    let y_hi = h - BEDROCK_H as i32 - 60;
    if y_hi <= y_lo {
        force_borders(mask);
        return Vec::new();
    }

    let min_sep_sq = (VOID_MIN_SEPARATION as i64).pow(2);
    let mut centres: Vec<Point> = Vec::with_capacity(params.void_count as usize);

    for _ in 0..params.void_count {
        let mut placed = None;
        for _ in 0..50 {
            let c = Point::new(
                range_i32(&mut rng, WALL_W as i32, w - WALL_W as i32),
                range_i32(&mut rng, y_lo, y_hi),
            );
            if centres.iter().all(|o| c.distance_sq(*o) >= min_sep_sq) {
                placed = Some(c);
                break;
            }
        }
        let Some(centre) = placed else { continue };

        let count = range_i32(&mut rng, 3, 6);
        let jitter = VOID_RADIUS_MAX / 2;
        for _ in 0..count {
            let r = range_i32(&mut rng, VOID_RADIUS_MIN, VOID_RADIUS_MAX);
            let dx = range_i32(&mut rng, -jitter, jitter);
            let dy = range_i32(&mut rng, -jitter, jitter);
            stamp_circle(mask, centre.x + dx, centre.y + dy, r, false);
        }
        centres.push(centre);
    }

    force_borders(mask);
    centres
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::silhouette::{borders_hold, silhouette};

    fn params() -> GenParams {
        GenParams::default_for(MapScale::Small)
    }

    fn solid_map(p: &GenParams) -> Mask {
        let mut m = Mask::new_full(p.width(), p.height());
        force_borders(&mut m);
        m
    }

    // ---- crevices --------------------------------------------------------

    #[test]
    fn crevice_determinism() {
        let p = params();
        let base = silhouette(4242, &p);
        let mut first = base.clone();
        let paths = carve_crevices(&mut first, 4242, &p);
        let hash = first.hash();
        for _ in 0..20 {
            let mut m = base.clone();
            let q = carve_crevices(&mut m, 4242, &p);
            assert_eq!(m.hash(), hash);
            assert_eq!(q, paths);
        }
    }

    #[test]
    fn crevices_only_remove_solid() {
        let p = params();
        let mut m = silhouette(7, &p);
        let before = m.count_solid();
        carve_crevices(&mut m, 7, &p);
        assert!(m.count_solid() <= before);
    }

    #[test]
    fn zero_crevices_leaves_the_mask_unchanged() {
        let mut p = params();
        p.crevice_count = 0;
        let mut m = silhouette(7, &p);
        let before = m.hash();
        assert!(carve_crevices(&mut m, 7, &p).is_empty());
        assert_eq!(m.hash(), before);
    }

    #[test]
    fn a_crevice_starts_at_the_surface() {
        // Its first stamped point must have been air-above-solid before carving.
        let p = params();
        let mut m = solid_map(&p);
        let reference = m.clone();
        let paths = carve_crevices(&mut m, 21, &p);
        assert!(!paths.is_empty());

        let floor = m.h as i32 - BEDROCK_H as i32;
        for path in &paths {
            let first = path[0];
            assert!(
                reference.get(first.x, first.y),
                "crevice started at {first:?}, which was not solid"
            );
            let expected = surface_y(&reference, first.x, floor);
            assert_eq!(
                Some(first.y),
                expected,
                "crevice at x={} did not start at the surface",
                first.x
            );
        }
    }

    #[test]
    fn crevice_depth_is_in_range_and_stops_at_bedrock() {
        let p = params();
        let mut m = solid_map(&p);
        let paths = carve_crevices(&mut m, 33, &p);
        let floor = m.h as i32 - BEDROCK_H as i32;

        for path in &paths {
            let (first, last) = (path[0], *path.last().expect("non-empty"));
            let depth = last.y - first.y;
            // A crevice that ran into bedrock terminates early, which is correct.
            let hit_floor = last.y + CREVICE_STEP >= floor;
            assert!(
                (CREVICE_DEPTH_MIN - CREVICE_STEP..=CREVICE_DEPTH_MAX).contains(&depth)
                    || hit_floor,
                "depth {depth} outside {CREVICE_DEPTH_MIN}..={CREVICE_DEPTH_MAX} \
                 and did not reach bedrock (last {last:?}, floor {floor})"
            );
            for pt in path {
                assert!(pt.y < floor, "crevice point {pt:?} is in the bedrock");
            }
        }
    }

    #[test]
    fn crevice_steps_and_heading_are_bounded() {
        let p = params();
        let mut m = solid_map(&p);
        let paths = carve_crevices(&mut m, 44, &p);
        for path in paths.iter().filter(|p| p.len() > 2) {
            for w in path.windows(2) {
                let d = ((w[0].distance_sq(w[1])) as f32).sqrt();
                assert!(
                    (d - CREVICE_STEP as f32).abs() <= 1.5,
                    "step of {d} px, expected {CREVICE_STEP}"
                );
            }
            for w in path.windows(3) {
                let h1 = ((w[1].y - w[0].y) as f32).atan2((w[1].x - w[0].x) as f32);
                let h2 = ((w[2].y - w[1].y) as f32).atan2((w[2].x - w[1].x) as f32);
                let turn = crate::math::wrap_to_pi(h2 - h1).abs();
                // Integer rounding at 6 px steps adds noticeable apparent turn.
                assert!(
                    turn <= CREVICE_WANDER + 0.35,
                    "turn of {turn} rad exceeds {CREVICE_WANDER}"
                );
            }
        }
    }

    #[test]
    fn crevices_go_downward() {
        let p = params();
        let mut m = solid_map(&p);
        for path in carve_crevices(&mut m, 55, &p) {
            if path.len() < 3 {
                continue;
            }
            let (first, last) = (path[0], *path.last().expect("non-empty"));
            assert!(last.y > first.y, "crevice went up: {first:?} -> {last:?}");
        }
    }

    #[test]
    fn a_crevice_opens_the_surface() {
        // The whole point: after carving, the column at the crevice start is air
        // where it used to be rock.
        let p = params();
        let mut m = solid_map(&p);
        let paths = carve_crevices(&mut m, 66, &p);
        for path in &paths {
            let first = path[0];
            assert!(
                !m.get(first.x, first.y),
                "crevice mouth {first:?} is still solid"
            );
        }
    }

    #[test]
    fn crevice_borders_hold() {
        let p = params();
        for seed in 0..8 {
            let mut m = silhouette(seed, &p);
            carve_crevices(&mut m, seed, &p);
            assert!(borders_hold(&m), "seed {seed}");
        }
    }

    // ---- voids -----------------------------------------------------------

    #[test]
    fn void_determinism() {
        let p = params();
        let base = silhouette(4242, &p);
        let mut first = base.clone();
        let centres = carve_voids(&mut first, 4242, &p);
        let hash = first.hash();
        for _ in 0..20 {
            let mut m = base.clone();
            let c = carve_voids(&mut m, 4242, &p);
            assert_eq!(m.hash(), hash);
            assert_eq!(c, centres);
        }
    }

    #[test]
    fn voids_only_remove_solid() {
        let p = params();
        let mut m = silhouette(7, &p);
        let before = m.count_solid();
        carve_voids(&mut m, 7, &p);
        assert!(m.count_solid() <= before);
    }

    #[test]
    fn zero_voids_leaves_the_mask_unchanged() {
        let mut p = params();
        p.void_count = 0;
        let mut m = silhouette(7, &p);
        let before = m.hash();
        assert!(carve_voids(&mut m, 7, &p).is_empty());
        assert_eq!(m.hash(), before);
    }

    #[test]
    fn void_centres_respect_separation() {
        let p = GenParams::default_for(MapScale::Large);
        let mut m = solid_map(&p);
        let centres = carve_voids(&mut m, 31337, &p);
        assert!(centres.len() >= 2);
        let min_sq = (VOID_MIN_SEPARATION as i64).pow(2);
        for (i, a) in centres.iter().enumerate() {
            for b in &centres[i + 1..] {
                assert!(a.distance_sq(*b) >= min_sq, "{a:?} and {b:?} too close");
            }
        }
    }

    #[test]
    fn a_void_removes_a_meaningful_amount() {
        let mut p = params();
        p.void_count = 1;
        let mut m = solid_map(&p);
        let before = m.count_solid();
        let centres = carve_voids(&mut m, 5, &p);
        assert_eq!(centres.len(), 1);
        let removed = before - m.count_solid();
        // At least one minimum-radius disc's worth.
        let one_disc = std::f64::consts::PI * (VOID_RADIUS_MIN as f64).powi(2);
        assert!(
            removed as f64 > one_disc,
            "void removed only {removed} px, less than one disc ({one_disc:.0})"
        );
    }

    #[test]
    fn void_borders_hold() {
        let p = params();
        for seed in 0..8 {
            let mut m = silhouette(seed, &p);
            carve_voids(&mut m, seed, &p);
            assert!(borders_hold(&m), "seed {seed}");
        }
    }

    #[test]
    fn crevices_and_voids_draw_from_separate_streams() {
        // Exhausting one must not move the other — the sub-stream guarantee.
        let p = params();
        let base = silhouette(9, &p);

        let mut a = base.clone();
        carve_voids(&mut a, 9, &p);

        let mut b = base.clone();
        let mut crevice_rng = substream(9, "crevices");
        for _ in 0..10_000 {
            let _ = range_i32(&mut crevice_rng, 0, 1000);
        }
        carve_voids(&mut b, 9, &p);

        assert_eq!(a.hash(), b.hash());
    }
}
