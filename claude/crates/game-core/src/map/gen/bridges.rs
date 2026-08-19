//! Pass 3b: bridges between islands (v2).
//!
//! A floating island you cannot reach on foot is scenery. Bridges make islands a
//! route, which is what turns "there is terrain up there" into "there is a way
//! round the back".
//!
//! Bridges are ordinary terrain: destructible, and blowing one up strands whoever
//! is on the far side until they find another way. That is a feature.
//!
//! See `docs/70-amendments-v2.md` §A2 Pass 3b.

use crate::constants::{
    BRIDGE_MAX_SPAN, BRIDGE_MIN_SPAN, BRIDGE_SAG, BRIDGE_THICKNESS, SKY_MARGIN,
};
use crate::map::gen::silhouette::{force_borders, GenParams};
use crate::map::shape::stamp_circle;
use crate::map::Mask;
use crate::math::Point;

/// Step between stamps along a span. Small enough that consecutive discs of
/// `BRIDGE_THICKNESS / 2` overlap solidly.
const SPAN_STEP: i32 = 3;

/// Stamp up to `params.bridge_count` solid spans between nearby island centres.
///
/// `islands` are the centres returned by `add_blobs`. Returns the spans actually
/// built, as `(from, to)` **surface** points.
/// `seed` is accepted for signature symmetry with the other passes and for future
/// randomised span selection; bridge placement is currently fully determined by the
/// island layout, which is itself seeded.
pub fn add_bridges(
    mask: &mut Mask,
    _seed: u64,
    params: &GenParams,
    islands: &[Point],
) -> Vec<(Point, Point)> {
    let mut spans = Vec::new();
    if params.bridge_count == 0 || islands.len() < 2 {
        force_borders(mask);
        return spans;
    }

    // Sort by x (ties by y) so the pairing does not depend on the order add_blobs
    // happened to produce.
    let mut sorted: Vec<Point> = islands.to_vec();
    sorted.sort_by_key(|p| (p.x, p.y));

    let mut bridged = vec![false; sorted.len()];

    for i in 0..sorted.len() {
        if spans.len() >= params.bridge_count as usize {
            break;
        }
        if bridged[i] {
            continue;
        }

        // Nearest unbridged partner whose horizontal distance is in range.
        let mut best: Option<(usize, i32)> = None;
        for (j, other) in sorted.iter().enumerate() {
            if j == i || bridged[j] {
                continue;
            }
            let dx = (other.x - sorted[i].x).abs();
            if !(BRIDGE_MIN_SPAN..=BRIDGE_MAX_SPAN).contains(&dx) {
                continue;
            }
            if best.is_none_or(|(_, bd)| dx < bd) {
                best = Some((j, dx));
            }
        }
        let Some((j, _)) = best else { continue };

        // Anchor each end on the island's top surface. An island whose centre is
        // already air has been eaten by a later pass or never landed — skip it.
        let (Some(a), Some(b)) = (top_surface(mask, sorted[i]), top_surface(mask, sorted[j]))
        else {
            continue;
        };

        stamp_span(mask, a, b);
        bridged[i] = true;
        bridged[j] = true;
        spans.push((a, b));
    }

    force_borders(mask);
    spans
}

/// Walk up from a centre until the pixel above is air: the island's top surface.
/// `None` if the centre is not inside solid rock.
fn top_surface(mask: &Mask, centre: Point) -> Option<Point> {
    if !mask.get(centre.x, centre.y) {
        return None;
    }
    let mut y = centre.y;
    while y > SKY_MARGIN as i32 && mask.get(centre.x, y - 1) {
        y -= 1;
    }
    Some(Point::new(centre.x, y))
}

/// A sagging band from `a` to `b`, stamped with the shared rasteriser.
fn stamp_span(mask: &mut Mask, a: Point, b: Point) {
    let r = BRIDGE_THICKNESS / 2;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len = dx.abs().max(dy.abs()).max(1);
    let steps = (len / SPAN_STEP).max(1);

    for i in 0..=steps {
        let t = i as f32 / steps as f32;
        // Quadratic sag: zero at both ends, BRIDGE_SAG at mid-span.
        let sag = BRIDGE_SAG as f32 * 4.0 * t * (1.0 - t);
        let x = a.x + (dx as f32 * t).round() as i32;
        let y = a.y + (dy as f32 * t).round() as i32 + sag.round() as i32;
        stamp_circle(mask, x, y, r, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::blobs::add_blobs;
    use crate::map::gen::silhouette::{borders_hold, silhouette};

    fn params() -> GenParams {
        GenParams::default_for(MapScale::Large)
    }

    /// Two solid pads at a known separation, on an otherwise empty mask.
    fn two_pads(gap: i32) -> (Mask, Vec<Point>) {
        let p = params();
        let mut m = Mask::new_empty(p.width(), p.height());
        let (ax, ay) = (500, 600);
        let bx = ax + gap;
        for (cx, cy) in [(ax, ay), (bx, ay)] {
            stamp_circle(&mut m, cx, cy, 40, true);
        }
        (m, vec![Point::new(ax, ay), Point::new(bx, ay)])
    }

    #[test]
    fn determinism() {
        let p = params();
        let mut base = silhouette(4242, &p);
        let islands = add_blobs(&mut base, 4242, &p);

        let mut first = base.clone();
        let spans = add_bridges(&mut first, 4242, &p, &islands);
        let hash = first.hash();
        for _ in 0..20 {
            let mut m = base.clone();
            let s = add_bridges(&mut m, 4242, &p, &islands);
            assert_eq!(m.hash(), hash);
            assert_eq!(s, spans);
        }
    }

    #[test]
    fn bridges_never_remove_solid() {
        let p = params();
        let mut m = silhouette(9, &p);
        let islands = add_blobs(&mut m, 9, &p);
        let before = m.count_solid();
        add_bridges(&mut m, 9, &p, &islands);
        assert!(m.count_solid() >= before, "a bridge removed solid pixels");
    }

    #[test]
    fn zero_count_or_too_few_islands_builds_nothing() {
        let (mut m, islands) = two_pads(200);
        let before = m.hash();

        let mut p = params();
        p.bridge_count = 0;
        assert!(add_bridges(&mut m, 1, &p, &islands).is_empty());

        let p = params();
        assert!(add_bridges(&mut m, 1, &p, &islands[..1]).is_empty());
        assert!(add_bridges(&mut m, 1, &p, &[]).is_empty());

        // force_borders is the only change any of those may have made.
        let mut reference = {
            let (mut r, _) = two_pads(200);
            force_borders(&mut r);
            r
        };
        force_borders(&mut reference);
        assert_eq!(m.hash(), reference.hash());
        let _ = before;
    }

    #[test]
    fn spans_are_within_the_documented_length_range() {
        let p = params();
        let mut m = silhouette(31337, &p);
        let islands = add_blobs(&mut m, 31337, &p);
        let spans = add_bridges(&mut m, 31337, &p, &islands);
        for (a, b) in &spans {
            let dx = (b.x - a.x).abs();
            assert!(
                (BRIDGE_MIN_SPAN..=BRIDGE_MAX_SPAN).contains(&dx),
                "span {dx} outside {BRIDGE_MIN_SPAN}..={BRIDGE_MAX_SPAN}"
            );
        }
    }

    #[test]
    fn no_island_is_an_endpoint_of_two_bridges() {
        let p = params();
        let mut m = silhouette(777, &p);
        let islands = add_blobs(&mut m, 777, &p);
        let spans = add_bridges(&mut m, 777, &p, &islands);

        let mut seen_x = Vec::new();
        for (a, b) in &spans {
            for e in [a, b] {
                assert!(
                    !seen_x.contains(&e.x),
                    "island at x={} is an endpoint twice",
                    e.x
                );
                seen_x.push(e.x);
            }
        }
    }

    #[test]
    fn a_bridge_actually_connects_the_two_islands() {
        // The point of the whole pass: after bridging, a 4-connected flood fill of
        // solid pixels from one island reaches the other.
        let (mut m, islands) = two_pads(200);
        let p = params();
        let spans = add_bridges(&mut m, 5, &p, &islands);
        assert_eq!(spans.len(), 1, "expected exactly one bridge");

        let start = islands[0];
        let target = islands[1];
        assert!(flood_reaches(&m, start, target), "bridge does not connect");
    }

    #[test]
    fn islands_too_far_apart_are_not_bridged() {
        let (mut m, islands) = two_pads(BRIDGE_MAX_SPAN + 100);
        let p = params();
        assert!(add_bridges(&mut m, 5, &p, &islands).is_empty());
    }

    #[test]
    fn islands_too_close_are_not_bridged() {
        let (mut m, islands) = two_pads(BRIDGE_MIN_SPAN - 20);
        let p = params();
        assert!(add_bridges(&mut m, 5, &p, &islands).is_empty());
    }

    #[test]
    fn the_span_sags_in_the_middle() {
        let (mut m, islands) = two_pads(300);
        let p = params();
        let spans = add_bridges(&mut m, 5, &p, &islands);
        let (a, b) = spans[0];
        assert_eq!(a.y, b.y, "test pads should be level");

        // The lowest solid pixel at mid-span must be below the endpoints. Scan only
        // the bridge's neighbourhood — scanning the whole column finds bedrock,
        // which force_borders keeps solid.
        let mid_x = (a.x + b.x) / 2;
        let scan_to = a.y + BRIDGE_SAG + BRIDGE_THICKNESS + 8;
        let mut lowest = None;
        for y in (a.y - 32).max(0)..=scan_to.min(m.h as i32 - 1) {
            if m.get(mid_x, y) {
                lowest = Some(y);
            }
        }
        let lowest = lowest.expect("mid-span must be solid");
        assert!(
            lowest > a.y,
            "no sag: mid-span bottom {lowest} vs endpoint {}",
            a.y
        );
        assert!(
            lowest <= a.y + BRIDGE_SAG + BRIDGE_THICKNESS,
            "sagged too far: {lowest}"
        );
    }

    #[test]
    fn borders_hold_afterwards() {
        let p = params();
        for seed in 0..6 {
            let mut m = silhouette(seed, &p);
            let islands = add_blobs(&mut m, seed, &p);
            add_bridges(&mut m, seed, &p, &islands);
            assert!(borders_hold(&m), "seed {seed}");
        }
    }

    #[test]
    fn a_centre_in_open_air_is_skipped_rather_than_panicking() {
        let p = params();
        let mut m = Mask::new_empty(p.width(), p.height());
        // Islands that were never stamped: both centres are air.
        let ghosts = vec![Point::new(500, 600), Point::new(700, 600)];
        assert!(add_bridges(&mut m, 1, &p, &ghosts).is_empty());
    }

    /// 4-connected flood fill over solid pixels, from `start` to `target`.
    fn flood_reaches(mask: &Mask, start: Point, target: Point) -> bool {
        let (w, h) = (mask.w as i32, mask.h as i32);
        let mut seen = vec![false; (w * h) as usize];
        let mut stack = vec![start];
        seen[(start.y * w + start.x) as usize] = true;

        while let Some(p) = stack.pop() {
            if p == target {
                return true;
            }
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (p.x + dx, p.y + dy);
                if nx < 0 || ny < 0 || nx >= w || ny >= h {
                    continue;
                }
                let idx = (ny * w + nx) as usize;
                if seen[idx] || !mask.get(nx, ny) {
                    continue;
                }
                seen[idx] = true;
                stack.push(Point::new(nx, ny));
            }
        }
        false
    }
}
