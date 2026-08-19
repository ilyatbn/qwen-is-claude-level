//! Pass 4: random-walk tunnels.
//!
//! Tunnels do three jobs: they hollow the interior so the map is not a solid
//! brick, they create the pockets that hide buried items, and they give explosions
//! somewhere interesting to break into.
//!
//! This module owns the walk itself. The structured cave *network* — chambers,
//! loops and surface entrances — is T1.06b in `network.rs`, and it steers the same
//! walk toward a target.

use crate::constants::{
    BEDROCK_H, SKY_MARGIN, TUNNEL_LENGTH_MAX, TUNNEL_LENGTH_MIN, TUNNEL_RADIUS_MAX,
    TUNNEL_RADIUS_MIN, TUNNEL_STEP, TUNNEL_TURN_MAX, WALL_W,
};
use crate::map::gen::silhouette::{force_borders, GenParams};
use crate::map::shape::stamp_circle;
use crate::map::Mask;
use crate::math::{Point, PI};
use crate::rng::{range_f32, range_i32, substream, ChaCha8Rng};

/// How far a tunnel radius may drift per step. More than this and the tunnel looks
/// like a string of beads rather than a passage.
const RADIUS_DRIFT: i32 = 2;

/// A point is a good tunnel start if it is solid and has solid rock this far away
/// in all four directions — start inside the rock, not on its skin.
const START_CLEARANCE: i32 = 32;

/// Carve `params.cave_tunnels` winding tunnels through the solid mass.
///
/// Returns the tunnel paths; T1.13 uses them to place buried item slots nearby.
pub fn carve_caves(mask: &mut Mask, seed: u64, params: &GenParams) -> Vec<Vec<Point>> {
    let mut rng = substream(seed, "caves");
    let mut paths = Vec::with_capacity(params.cave_tunnels as usize);

    for _ in 0..params.cave_tunnels {
        let Some(start) = find_start(mask, &mut rng) else {
            continue;
        };

        // Bias the heading toward horizontal. Without this, tunnels drill straight
        // down through the bedrock and out, and the map fills with vertical shafts.
        let a = range_f32(&mut rng, -PI, PI);
        let mut heading = a * 0.55;
        if rng_bool(&mut rng) {
            heading = PI - heading;
        }

        let length = range_i32(&mut rng, TUNNEL_LENGTH_MIN, TUNNEL_LENGTH_MAX);
        let steps = (length / TUNNEL_STEP).max(1);
        let mut radius = range_i32(&mut rng, TUNNEL_RADIUS_MIN, TUNNEL_RADIUS_MAX);

        let mut path = Vec::with_capacity(steps as usize + 1);
        let mut pos = (start.x as f32, start.y as f32);
        path.push(start);
        stamp_circle(mask, start.x, start.y, radius, false);

        for _ in 0..steps {
            heading += range_f32(&mut rng, -TUNNEL_TURN_MAX, TUNNEL_TURN_MAX);
            pos.0 += heading.cos() * TUNNEL_STEP as f32;
            pos.1 += heading.sin() * TUNNEL_STEP as f32;

            let p = Point::new(pos.0.round() as i32, pos.1.round() as i32);
            if out_of_carveable_bounds(mask, p) {
                break;
            }

            radius = (radius + range_i32(&mut rng, -RADIUS_DRIFT, RADIUS_DRIFT))
                .clamp(TUNNEL_RADIUS_MIN, TUNNEL_RADIUS_MAX);
            stamp_circle(mask, p.x, p.y, radius, false);
            path.push(p);
        }

        paths.push(path);
    }

    // A tunnel must not breach the walls or the bedrock.
    force_borders(mask);
    paths
}

/// One draw of a fair coin from the tunnel stream.
fn rng_bool(rng: &mut ChaCha8Rng) -> bool {
    crate::rng::chance(rng, 0.5)
}

/// True once a walk has wandered somewhere it must not carve.
pub(crate) fn out_of_carveable_bounds(mask: &Mask, p: Point) -> bool {
    p.x < WALL_W as i32
        || p.x >= mask.w as i32 - WALL_W as i32
        || p.y < 0
        || p.y >= mask.h as i32 - BEDROCK_H as i32
}

/// Sample for a point buried in rock. `None` if 200 attempts fail, which happens
/// on a map with very little solid mass.
fn find_start(mask: &Mask, rng: &mut ChaCha8Rng) -> Option<Point> {
    let (w, h) = (mask.w as i32, mask.h as i32);
    for _ in 0..200 {
        let p = Point::new(
            range_i32(
                rng,
                WALL_W as i32 + START_CLEARANCE,
                w - WALL_W as i32 - START_CLEARANCE,
            ),
            range_i32(
                rng,
                SKY_MARGIN as i32 + START_CLEARANCE,
                h - BEDROCK_H as i32 - START_CLEARANCE,
            ),
        );
        if is_buried(mask, p, START_CLEARANCE) {
            return Some(p);
        }
    }
    None
}

/// Solid at `p`, with solid rock `clearance` px away in all four directions.
pub(crate) fn is_buried(mask: &Mask, p: Point, clearance: i32) -> bool {
    mask.get(p.x, p.y)
        && mask.get(p.x - clearance, p.y)
        && mask.get(p.x + clearance, p.y)
        && mask.get(p.x, p.y - clearance)
        && mask.get(p.x, p.y + clearance)
}

/// A random walk **steered** toward `target`: at each step the heading turns toward
/// the bearing by at most `TUNNEL_TURN_MAX`, plus jitter, so it wanders but always
/// arrives. Shared with T1.06b, which uses it for every network edge.
///
/// Returns the stamped centres. Stops on arrival, on leaving the carveable area, or
/// after `max_steps`.
pub fn walk_to(
    mask: &mut Mask,
    rng: &mut ChaCha8Rng,
    from: Point,
    target: Point,
    r_min: i32,
    r_max: i32,
    max_steps: usize,
) -> Vec<Point> {
    let mut path = Vec::with_capacity(max_steps.min(512));
    let mut pos = (from.x as f32, from.y as f32);
    let mut radius = range_i32(rng, r_min, r_max);
    let mut heading = ((target.y - from.y) as f32).atan2((target.x - from.x) as f32);

    stamp_circle(mask, from.x, from.y, radius, false);
    path.push(from);

    for _ in 0..max_steps {
        let bearing = (target.y as f32 - pos.1).atan2(target.x as f32 - pos.0);
        // Turn toward the bearing, capped, then jitter — wander with intent.
        let delta = crate::math::wrap_to_pi(bearing - heading);
        heading += delta.clamp(-TUNNEL_TURN_MAX, TUNNEL_TURN_MAX);
        heading += range_f32(rng, -TUNNEL_TURN_MAX * 0.6, TUNNEL_TURN_MAX * 0.6);

        pos.0 += heading.cos() * TUNNEL_STEP as f32;
        pos.1 += heading.sin() * TUNNEL_STEP as f32;

        let p = Point::new(pos.0.round() as i32, pos.1.round() as i32);
        if out_of_carveable_bounds(mask, p) {
            break;
        }

        radius = (radius + range_i32(rng, -RADIUS_DRIFT, RADIUS_DRIFT)).clamp(r_min, r_max);
        stamp_circle(mask, p.x, p.y, radius, false);
        path.push(p);

        // Arrived: within one radius of the target.
        let d = p.distance_sq(target);
        if d <= (radius as i64 * radius as i64).max(64) {
            break;
        }
    }

    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::silhouette::{borders_hold, silhouette};

    fn params() -> GenParams {
        GenParams::default_for(MapScale::Small)
    }

    fn solid_map() -> Mask {
        let p = params();
        let mut m = Mask::new_full(p.width(), p.height());
        force_borders(&mut m);
        m
    }

    #[test]
    fn determinism() {
        let p = params();
        let base = silhouette(4242, &p);
        let mut first = base.clone();
        let paths = carve_caves(&mut first, 4242, &p);
        let hash = first.hash();
        for _ in 0..20 {
            let mut m = base.clone();
            let q = carve_caves(&mut m, 4242, &p);
            assert_eq!(m.hash(), hash);
            assert_eq!(q, paths);
        }
    }

    #[test]
    fn caves_only_remove_solid() {
        let p = params();
        let mut m = silhouette(7, &p);
        let before = m.count_solid();
        carve_caves(&mut m, 7, &p);
        assert!(m.count_solid() <= before, "carve_caves added solid pixels");
    }

    #[test]
    fn zero_tunnels_leaves_the_mask_unchanged() {
        let mut p = params();
        p.cave_tunnels = 0;
        let mut m = silhouette(7, &p);
        let before = m.hash();
        let paths = carve_caves(&mut m, 7, &p);
        assert!(paths.is_empty());
        assert_eq!(m.hash(), before);
    }

    #[test]
    fn borders_hold_and_no_bedrock_is_cleared() {
        let p = params();
        for seed in 0..8 {
            let mut m = silhouette(seed, &p);
            carve_caves(&mut m, seed, &p);
            assert!(borders_hold(&m), "seed {seed}");

            // Explicitly: every bedrock pixel is still solid.
            let (w, h) = (m.w as i32, m.h as i32);
            for y in (h - BEDROCK_H as i32)..h {
                assert_eq!(
                    m.count_run(y, 0, w - 1),
                    w as u32,
                    "bedrock row {y} breached"
                );
            }
        }
    }

    #[test]
    fn paths_are_long_enough_unless_they_hit_the_edge() {
        let p = params();
        let mut m = solid_map();
        let paths = carve_caves(&mut m, 99, &p);
        assert!(!paths.is_empty());

        let min_points = (TUNNEL_LENGTH_MIN / TUNNEL_STEP) as usize;
        for path in &paths {
            let last = path.last().copied().unwrap_or_default();
            let terminated_early = out_of_carveable_bounds(&m, last)
                || last.x < WALL_W as i32 + TUNNEL_RADIUS_MAX
                || last.x > m.w as i32 - WALL_W as i32 - TUNNEL_RADIUS_MAX
                || last.y > m.h as i32 - BEDROCK_H as i32 - TUNNEL_RADIUS_MAX
                || last.y < SKY_MARGIN as i32;
            assert!(
                path.len() >= min_points || terminated_early,
                "path of {} points (min {min_points}) ended at {last:?} without hitting an edge",
                path.len()
            );
        }
    }

    #[test]
    fn consecutive_points_are_one_step_apart() {
        let p = params();
        let mut m = solid_map();
        let paths = carve_caves(&mut m, 5, &p);
        for path in &paths {
            for w in path.windows(2) {
                let (a, b) = (w[0], w[1]);
                let d = ((a.distance_sq(b)) as f32).sqrt();
                assert!(
                    (d - TUNNEL_STEP as f32).abs() <= 1.5,
                    "step of {d} px between {a:?} and {b:?}"
                );
            }
        }
    }

    #[test]
    fn heading_never_turns_more_than_the_maximum() {
        let p = params();
        let mut m = solid_map();
        let paths = carve_caves(&mut m, 17, &p);
        for path in &paths {
            for w in path.windows(3) {
                let h1 = ((w[1].y - w[0].y) as f32).atan2((w[1].x - w[0].x) as f32);
                let h2 = ((w[2].y - w[1].y) as f32).atan2((w[2].x - w[1].x) as f32);
                let turn = crate::math::wrap_to_pi(h2 - h1).abs();
                // Rounding to integer pixels adds a little apparent turn on top of
                // the true heading change.
                assert!(
                    turn <= TUNNEL_TURN_MAX + 0.25,
                    "turn of {turn} rad exceeds {TUNNEL_TURN_MAX}"
                );
            }
        }
    }

    #[test]
    fn tunnels_are_meaningfully_horizontal() {
        // Over many seeds, the mean absolute vertical displacement of a path must
        // be less than its horizontal displacement — otherwise the heading bias is
        // broken and the map fills with vertical shafts.
        let p = params();
        let (mut dx_total, mut dy_total, mut n) = (0.0f64, 0.0f64, 0u32);
        for seed in 0..50 {
            let mut m = solid_map();
            for path in carve_caves(&mut m, seed, &p) {
                let (Some(first), Some(last)) = (path.first(), path.last()) else {
                    continue;
                };
                dx_total += (last.x - first.x).abs() as f64;
                dy_total += (last.y - first.y).abs() as f64;
                n += 1;
            }
        }
        assert!(n > 0);
        let (mean_dx, mean_dy) = (dx_total / n as f64, dy_total / n as f64);
        assert!(
            mean_dy < mean_dx,
            "tunnels are not horizontal: mean |dx| {mean_dx:.1}, mean |dy| {mean_dy:.1}"
        );
    }

    #[test]
    fn carved_volume_is_roughly_the_swept_area() {
        // Self-overlap on turns makes this inexact, which is why the tolerance is
        // loose. It still catches a radius or step that is wildly wrong.
        let mut p = params();
        p.cave_tunnels = 1;
        let mut m = solid_map();
        let before = m.count_solid();
        let paths = carve_caves(&mut m, 21, &p);
        let removed = before - m.count_solid();

        let path_len = paths[0].len() as f64 * TUNNEL_STEP as f64;
        let mean_r = (TUNNEL_RADIUS_MIN + TUNNEL_RADIUS_MAX) as f64 / 2.0;
        let expected = path_len * 2.0 * mean_r;
        assert!(
            removed as f64 > expected * 0.4 && (removed as f64) < expected * 1.6,
            "removed {removed}, expected around {expected:.0}"
        );
    }

    #[test]
    fn walk_to_arrives_at_its_target() {
        let mut m = solid_map();
        let mut rng = substream(1, "walk-test");
        let from = Point::new(300, 400);
        let target = Point::new(900, 500);
        let path = walk_to(&mut m, &mut rng, from, target, 10, 14, 400);

        let last = path.last().copied().expect("path must not be empty");
        let d = (last.distance_sq(target) as f64).sqrt();
        assert!(d < 30.0, "walk ended {d:.0} px from its target at {last:?}");
    }

    #[test]
    fn walk_to_reaches_targets_in_every_direction() {
        let from = Point::new(1000, 500);
        for (dx, dy) in [
            (600, 0),
            (-600, 0),
            (0, 300),
            (0, -300),
            (500, 300),
            (-500, -300),
        ] {
            let mut m = solid_map();
            let mut rng = substream(2, "walk-dirs");
            let target = Point::new(from.x + dx, from.y + dy);
            let path = walk_to(&mut m, &mut rng, from, target, 10, 14, 500);
            let last = path.last().copied().unwrap_or_default();
            let d = (last.distance_sq(target) as f64).sqrt();
            assert!(d < 40.0, "({dx},{dy}): ended {d:.0} px away");
        }
    }

    #[test]
    fn walk_to_leaves_a_connected_passage() {
        let mut m = solid_map();
        let mut rng = substream(3, "walk-connect");
        let from = Point::new(400, 400);
        let target = Point::new(1200, 700);
        walk_to(&mut m, &mut rng, from, target, 10, 14, 500);

        // Air flood fill from the start must reach the target.
        assert!(air_reaches(&m, from, target), "walk left a gap");
    }

    /// 4-connected flood fill over **air**, from `start` to `target`.
    pub(super) fn air_reaches(mask: &Mask, start: Point, target: Point) -> bool {
        let (w, h) = (mask.w as i32, mask.h as i32);
        if mask.get(start.x, start.y) || mask.get(target.x, target.y) {
            return false;
        }
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
                if seen[idx] || mask.get(nx, ny) {
                    continue;
                }
                seen[idx] = true;
                stack.push(Point::new(nx, ny));
            }
        }
        false
    }
}
