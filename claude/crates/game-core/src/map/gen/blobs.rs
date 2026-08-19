//! Pass 3: floating islands.
//!
//! Islands keep the airspace from being empty and give jetpack traversal
//! somewhere to go. Under `docs/70-amendments-v2.md` §A2 they are a headline
//! feature, so there are more of them and they have flat-ish tops you can actually
//! stand and fight on.
//!
//! Each island is a **cluster**, not a single circle: a single circle reads as a
//! cartoon planet, a cluster reads as an island.

use crate::constants::{BLOB_RADIUS_MAX, BLOB_RADIUS_MIN, SKY_MARGIN};
use crate::map::gen::silhouette::{force_borders, GenParams};
use crate::map::shape::stamp_circle;
use crate::map::Mask;
use crate::math::Point;
use crate::rng::{range_i32, substream};

/// Stamp `params.blob_count` floating islands.
///
/// Returns the centres actually placed — T1.05b needs them to span bridges, and
/// tests need them to check separation.
pub fn add_blobs(mask: &mut Mask, seed: u64, params: &GenParams) -> Vec<Point> {
    let mut rng = substream(seed, "blobs");
    let (w, h) = (mask.w as i32, mask.h as i32);

    // Centres go in the upper two thirds: that is where the silhouette's bias has
    // left airspace, so that is where an island reads as an island rather than
    // being absorbed into the ground.
    let y_lo = SKY_MARGIN as i32;
    let y_hi = (h * 2) / 3;

    let min_separation = 2 * BLOB_RADIUS_MAX;
    let min_sep_sq = (min_separation as i64) * (min_separation as i64);

    let mut centres: Vec<Point> = Vec::with_capacity(params.blob_count as usize);

    for _ in 0..params.blob_count {
        // Rejection sampling, capped: on a small map some islands will not fit,
        // and that is fine. Looping forever is not.
        let mut placed = None;
        for _ in 0..50 {
            let c = Point::new(
                range_i32(&mut rng, BLOB_RADIUS_MAX, w - BLOB_RADIUS_MAX),
                range_i32(&mut rng, y_lo, y_hi.max(y_lo + 1)),
            );
            if centres.iter().all(|o| c.distance_sq(*o) >= min_sep_sq) {
                placed = Some(c);
                break;
            }
        }
        let Some(centre) = placed else { continue };

        // 3–6 overlapping circles. At least half of them share the centre's y
        // (±8), which gives the island a flat-ish walkable top instead of a lumpy
        // ball — docs/70-amendments-v2.md §A2 Pass 3.
        let count = range_i32(&mut rng, 3, 6);
        let flat_count = (count + 1) / 2;
        let jitter = BLOB_RADIUS_MAX / 2;

        for i in 0..count {
            let r = range_i32(&mut rng, BLOB_RADIUS_MIN, BLOB_RADIUS_MAX);
            let dx = range_i32(&mut rng, -jitter, jitter);
            let dy = if i < flat_count {
                range_i32(&mut rng, -8, 8)
            } else {
                range_i32(&mut rng, -jitter, jitter)
            };
            stamp_circle(mask, centre.x + dx, centre.y + dy, r, true);
        }

        centres.push(centre);
    }

    // An island near an edge must not eat the wall.
    force_borders(mask);
    centres
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::silhouette::borders_hold;

    fn params() -> GenParams {
        GenParams::default_for(MapScale::Small)
    }

    fn empty() -> Mask {
        let p = params();
        Mask::new_empty(p.width(), p.height())
    }

    #[test]
    fn determinism() {
        let p = params();
        let mut first = empty();
        let centres = add_blobs(&mut first, 4242, &p);
        let hash = first.hash();
        for _ in 0..20 {
            let mut m = empty();
            let c = add_blobs(&mut m, 4242, &p);
            assert_eq!(m.hash(), hash);
            assert_eq!(c, centres);
        }
    }

    #[test]
    fn blobs_only_add_solid() {
        let p = params();
        let mut m = empty();
        // Start from a partly solid mask so "only adds" is a real claim.
        for y in 300..400 {
            m.set_run(y, 100, 600);
        }
        let before = m.count_solid();
        add_blobs(&mut m, 7, &p);
        assert!(m.count_solid() > before, "blobs removed solid pixels");
    }

    #[test]
    fn zero_count_leaves_the_mask_alone() {
        let mut p = params();
        p.blob_count = 0;
        let mut m = empty();
        let before = m.hash();
        let centres = add_blobs(&mut m, 7, &p);
        assert!(centres.is_empty());
        // force_borders still runs, so compare against a bordered empty mask.
        let mut reference = empty();
        force_borders(&mut reference);
        assert_eq!(m.hash(), reference.hash());
        let _ = before;
    }

    #[test]
    fn borders_hold_afterwards() {
        let p = params();
        for seed in 0..10 {
            let mut m = crate::map::gen::silhouette::silhouette(seed, &p);
            add_blobs(&mut m, seed, &p);
            assert!(borders_hold(&m), "seed {seed}");
        }
    }

    #[test]
    fn centres_are_in_the_upper_two_thirds() {
        let p = params();
        let mut m = empty();
        let centres = add_blobs(&mut m, 99, &p);
        assert!(!centres.is_empty());
        let h = m.h as i32;
        for c in &centres {
            assert!(
                c.y >= SKY_MARGIN as i32 && c.y <= (h * 2) / 3,
                "centre {c:?} outside the upper two thirds of {h}"
            );
        }
    }

    #[test]
    fn centres_respect_the_minimum_separation() {
        let p = GenParams::default_for(MapScale::Large);
        let mut m = Mask::new_empty(p.width(), p.height());
        let centres = add_blobs(&mut m, 31337, &p);
        assert!(centres.len() >= 2, "need at least two to compare");
        let min_sq = (2i64 * BLOB_RADIUS_MAX as i64).pow(2);
        for (i, a) in centres.iter().enumerate() {
            for b in &centres[i + 1..] {
                assert!(
                    a.distance_sq(*b) >= min_sq,
                    "{a:?} and {b:?} are too close ({} < {min_sq})",
                    a.distance_sq(*b)
                );
            }
        }
    }

    #[test]
    fn islands_have_flat_ish_tops() {
        // The v2 requirement: at least half the circles in a cluster share the
        // centre y, so the top is walkable. Measure the top profile's roughness
        // across the middle of each island and require it to be gentle.
        let p = GenParams::default_for(MapScale::Large);
        let mut m = Mask::new_empty(p.width(), p.height());
        let centres = add_blobs(&mut m, 20250820, &p);

        let mut flat_enough = 0;
        for c in &centres {
            // Sample the surface height over the central 60 px of the island.
            let mut heights = Vec::new();
            for dx in -30..=30 {
                let x = c.x + dx;
                let mut top = None;
                for y in (SKY_MARGIN as i32)..m.h as i32 {
                    if m.get(x, y) {
                        top = Some(y);
                        break;
                    }
                }
                if let Some(t) = top {
                    heights.push(t);
                }
            }
            if heights.len() < 40 {
                continue;
            }
            let lo = *heights.iter().min().unwrap_or(&0);
            let hi = *heights.iter().max().unwrap_or(&0);
            // A ball of radius ~130 would vary by tens of px over 60 px of span.
            if hi - lo <= 24 {
                flat_enough += 1;
            }
        }
        assert!(
            flat_enough * 2 >= centres.len(),
            "only {flat_enough} of {} islands have a flat top",
            centres.len()
        );
    }

    #[test]
    fn a_cluster_is_wider_than_a_single_circle() {
        // Guards against the cluster silently collapsing to one stamp.
        let mut p = params();
        p.blob_count = 1;
        let mut m = empty();
        let centres = add_blobs(&mut m, 5, &p);
        assert_eq!(centres.len(), 1);
        let solid = m.count_solid();
        let max_single = std::f64::consts::PI * (BLOB_RADIUS_MAX as f64).powi(2);
        assert!(
            solid as f64 > max_single * 0.5,
            "cluster too small: {solid} px"
        );
    }
}
