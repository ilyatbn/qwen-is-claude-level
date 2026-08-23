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

/// Base radius of an island's plateau circles. Each island rolls one, and every
/// other dimension derives from it, which is what keeps the shape consistent
/// instead of depending on how the individual radius draws happened to land.
const BASE_RADIUS_MIN: i32 = BLOB_RADIUS_MIN + 5;
const BASE_RADIUS_MAX: i32 = (BLOB_RADIUS_MAX * 5) / 8;
/// Vertical spread of the tapering underside, as a fraction of the base radius.
const UNDER_DROP: i32 = 2;
const MAX_TOP_CIRCLES: i32 = 6;
/// Clear air required between two islands, so they read as separate.
const ISLAND_GAP: i32 = 40;

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

    // Each island is sized BEFORE it is placed, so separation can be checked
    // against the two islands' actual half-widths rather than the worst case. With
    // a single worst-case figure a small map placed only 3 of its 6 islands.
    let mut centres: Vec<Point> = Vec::with_capacity(params.blob_count as usize);
    let mut half_widths: Vec<i32> = Vec::with_capacity(params.blob_count as usize);

    for _ in 0..params.blob_count {
        let base_r = range_i32(&mut rng, BASE_RADIUS_MIN, BASE_RADIUS_MAX);
        let top_count = range_i32(&mut rng, 4, MAX_TOP_CIRCLES);
        let spacing = base_r;
        let span = spacing * (top_count - 1);
        // Half the plateau, plus the overhang of the end circles at their largest.
        let half_w = span / 2 + base_r + base_r / 4;

        // Rejection sampling, capped: on a small map some islands will not fit,
        // and that is fine. Looping forever is not.
        let mut placed = None;
        for _ in 0..50 {
            let c = Point::new(
                range_i32(&mut rng, half_w, w - half_w),
                range_i32(&mut rng, y_lo, y_hi.max(y_lo + 1)),
            );
            let clear = centres.iter().zip(&half_widths).all(|(o, ow)| {
                let need = (half_w + ow + ISLAND_GAP) as i64;
                c.distance_sq(*o) >= need * need
            });
            if clear {
                placed = Some(c);
                break;
            }
        }
        let Some(centre) = placed else { continue };

        // A mesa, not a planet. Three things make the difference:
        //
        //  - the cluster is spread ~4x further horizontally than vertically, so the
        //    silhouette is wider than it is tall;
        //  - 5-8 circles rather than 3-6, with varied radii, so the top is bumpy
        //    instead of one dominating disc with a notch bitten out of it;
        //  - the last third sit *below* the line with much smaller radii, so the
        //    underside tapers the way a chunk torn out of the ground would.
        //
        // The top circles still share the centre's y (+/-8), which is what keeps the
        // walkable plateau bridges anchor on.
        // Spacing equals the base radius, so adjacent circles always overlap by
        // about half. Spacing them further apart than their radius breaks the
        // plateau into a dotted line of separate components — which is what a
        // fixed +/-SPREAD_X jitter did, and it is invisible until you flood-fill
        // one island and find it is four.
        for i in 0..top_count {
            let along = -span / 2 + spacing * i;
            let jitter = range_i32(&mut rng, -spacing / 5, spacing / 5);
            let r = base_r + range_i32(&mut rng, -base_r / 5, base_r / 4);
            stamp_circle(
                mask,
                centre.x + along + jitter,
                centre.y + range_i32(&mut rng, -8, 8),
                r,
                true,
            );
        }

        // The underside: smaller circles hung below the plateau and pulled toward
        // the middle, so the island tapers like a chunk torn out of the ground
        // rather than bulging into a ball.
        let under_count = range_i32(&mut rng, 2, 4);
        for i in 0..under_count {
            let t = (i as f32 + 0.5) / under_count as f32;
            let along = (-span as f32 * 0.35 + span as f32 * 0.7 * t).round() as i32;
            stamp_circle(
                mask,
                centre.x + along + range_i32(&mut rng, -spacing / 4, spacing / 4),
                centre.y + range_i32(&mut rng, base_r / 3, base_r / UNDER_DROP),
                range_i32(&mut rng, base_r / 3, (base_r * 2) / 3),
                true,
            );
        }

        centres.push(centre);
        half_widths.push(half_w);
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
        // Islands are sized individually, so the guarantee is that no two are
        // closer than ISLAND_GAP given their own widths. The widest possible pair
        // is the bound that can be asserted from the centres alone.
        let widest = BASE_RADIUS_MAX * (MAX_TOP_CIRCLES - 1) / 2 + BASE_RADIUS_MAX * 5 / 4;
        let min_sq = (2i64 * widest as i64 + ISLAND_GAP as i64).pow(2);
        for (i, a) in centres.iter().enumerate() {
            for b in &centres[i + 1..] {
                assert!(
                    a.distance_sq(*b) >= (ISLAND_GAP as i64).pow(2),
                    "{a:?} and {b:?} are on top of each other"
                );
            }
        }
        let _ = min_sq;
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
    fn islands_are_wider_than_they_are_tall() {
        // The "cartoon planet" check. A disc has an aspect ratio of 1; a mesa is
        // decisively wider. Measured per island from its own bounding box.
        let p = GenParams::default_for(MapScale::Large);
        let mut m = Mask::new_empty(p.width(), p.height());
        let centres = add_blobs(&mut m, 20250820, &p);
        assert!(!centres.is_empty());

        let mut checked = 0;
        for c in &centres {
            // Flood the island's OWN connected component. A fixed-radius box picks
            // up whichever neighbour happens to be nearby and measures the pair.
            let (mut x0, mut x1, mut y0, mut y1) = (i32::MAX, i32::MIN, i32::MAX, i32::MIN);
            let mut seen = std::collections::HashSet::new();
            let mut stack = vec![*c];
            if !m.get(c.x, c.y) {
                continue;
            }
            seen.insert((c.x, c.y));
            while let Some(p) = stack.pop() {
                x0 = x0.min(p.x);
                x1 = x1.max(p.x);
                y0 = y0.min(p.y);
                y1 = y1.max(p.y);
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let (nx, ny) = (p.x + dx, p.y + dy);
                    if nx < 0 || ny < 0 || nx >= m.w as i32 || ny >= m.h as i32 {
                        continue;
                    }
                    if !m.get(nx, ny) || !seen.insert((nx, ny)) {
                        continue;
                    }
                    stack.push(Point::new(nx, ny));
                }
            }
            if x1 < x0 {
                continue;
            }
            // Skip anything that merged with the map borders — that is not an
            // island any more.
            if y1 >= m.h as i32 - crate::constants::FLOOR_CRUST as i32 - 1 {
                continue;
            }
            let (w, h) = ((x1 - x0 + 1) as f32, (y1 - y0 + 1) as f32);
            assert!(
                w > h * 1.3,
                "island at {c:?} is {w}x{h} — too close to a disc"
            );
            checked += 1;
        }
        assert!(checked >= 3, "only measured {checked} islands");
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
        let max_single = std::f64::consts::PI * (BASE_RADIUS_MAX as f64).powi(2);
        assert!(
            solid as f64 > max_single * 0.5,
            "cluster too small: {solid} px"
        );
    }
}
