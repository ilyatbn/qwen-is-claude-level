//! Collision queries against the mask.
//!
//! [`aabb_overlaps_solid`] is the hottest function in the project. It consults the
//! coarse grid first and usually returns without reading a single bit — that is the
//! entire reason the coarse grid exists. A naive per-pixel loop over a 16×28 box is
//! 448 bit tests, called dozens of times per body per tick.
//!
//! Every function here is a pure query. Movement resolution applies their answers.
//!
//! See `docs/20-player-movement.md` §2.

use crate::constants::COARSE_CELL;
use crate::map::CellState;
use crate::map::Map;
use crate::math::{Aabb, Vec2};

#[inline]
pub fn solid_at(map: &Map, x: i32, y: i32) -> bool {
    map.mask.get(x, y)
}

/// True if any solid pixel lies inside the box.
pub fn aabb_overlaps_solid(map: &Map, aabb: Aabb) -> bool {
    let (x0, y0, x1, y1) = aabb.pixel_bounds();
    if x1 < x0 || y1 < y0 {
        return false;
    }

    // Walk the coarse cells the box overlaps. Empty and Full are decisive with no
    // bit reads; only Mixed cells need per-pixel work, and then only over the part
    // of the cell actually inside the box.
    let cell = COARSE_CELL as i32;
    let (cx0, cy0) = (x0.div_euclid(cell), y0.div_euclid(cell));
    let (cx1, cy1) = (x1.div_euclid(cell), y1.div_euclid(cell));

    for cy in cy0..=cy1 {
        for cx in cx0..=cx1 {
            match map.coarse.cell_at(cx * cell, cy * cell) {
                CellState::Empty => continue,
                CellState::Full => {
                    // The cell is entirely solid; the box overlaps it, so they
                    // intersect — but only if the overlap is a real pixel, which it
                    // is by construction of the cell range.
                    return true;
                }
                CellState::Mixed => {
                    let px0 = (cx * cell).max(x0);
                    let px1 = (cx * cell + cell - 1).min(x1);
                    let py0 = (cy * cell).max(y0);
                    let py1 = (cy * cell + cell - 1).min(y1);
                    for y in py0..=py1 {
                        if map.mask.count_run(y, px0, px1) != 0 {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

/// First solid point along a ray, stepping 1 px at a time.
///
/// Not a DDA. A DDA is faster, but the 1-px step matches the sub-stepping guarantee
/// used everywhere else in the project, and that consistency is worth more here than
/// the speed.
pub fn raycast(map: &Map, from: Vec2, dir: Vec2, max_dist: f32) -> Option<Vec2> {
    let d = dir.normalized();
    if d == Vec2::ZERO {
        return None;
    }
    // A ray starting inside rock hits at its origin.
    if solid_at(map, from.x.floor() as i32, from.y.floor() as i32) {
        return Some(from);
    }

    let steps = max_dist.ceil() as i32;
    for i in 1..=steps {
        let p = from + d * i as f32;
        let (px, py) = (p.x.floor() as i32, p.y.floor() as i32);
        if px < 0 || py < 0 || px >= map.mask.w as i32 || py >= map.mask.h as i32 {
            return None;
        }
        if solid_at(map, px, py) {
            return Some(p);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// T2.03: ground probing and step-up
// ---------------------------------------------------------------------------

/// How far down the box can move (`0..=max_depth`) before it would touch solid.
///
/// Returns the **distance to move down**, not an absolute y. `Some(0)` means the
/// box is already touching ground; `None` means nothing is within `max_depth` and
/// the body is genuinely falling.
pub fn ground_probe(map: &Map, aabb: Aabb, max_depth: i32) -> Option<i32> {
    for d in 0..=max_depth {
        let probe = Aabb {
            center: aabb.center + Vec2::new(0.0, d as f32 + 1.0),
            half: aabb.half,
        };
        if aabb_overlaps_solid(map, probe) {
            return Some(d);
        }
    }
    None
}

/// The **smallest** lift in `1..=max_lift` that clears an overlap.
///
/// Smallest, not first-from-the-top: lifting more than necessary makes the player
/// visibly hop up slopes.
pub fn step_up_clearance(map: &Map, aabb: Aabb, max_lift: i32) -> Option<i32> {
    for lift in 1..=max_lift {
        let lifted = Aabb {
            center: aabb.center - Vec2::new(0.0, lift as f32),
            half: aabb.half,
        };
        if !aabb_overlaps_solid(map, lifted) {
            return Some(lift);
        }
    }
    None
}

/// Is the box resting on ground?
///
/// Checks that it overlaps nothing **now** as well as that it would 1 px down.
/// Checking only the second returns true for a body already embedded in rock, which
/// then never resolves.
pub fn is_on_ground(map: &Map, aabb: Aabb) -> bool {
    if aabb_overlaps_solid(map, aabb) {
        return false;
    }
    let down = Aabb {
        center: aabb.center + Vec2::new(0.0, 1.0),
        half: aabb.half,
    };
    aabb_overlaps_solid(map, down)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::constants::{MapScale, PLAYER_H, PLAYER_W, STEP_DOWN};
    use crate::map::{CoarseGrid, Map, MapMeta, Mask};
    use crate::rng::substream;
    use rand::Rng;

    /// A bare map with a hand-built mask, for scenario tests. Uses a real
    /// `CoarseGrid` so the fast path is exercised exactly as in production.
    pub(crate) fn test_map(w: u32, h: u32, build: impl FnOnce(&mut Mask)) -> Map {
        let mut mask = Mask::new_empty(w, h);
        build(&mut mask);
        let coarse = CoarseGrid::build(&mask);
        let chunks = (mask.chunks_x() * mask.chunks_y()) as usize;
        Map {
            mask,
            coarse,
            meta: MapMeta {
                seed: 0,
                requested_seed: 0,
                attempts: 1,
                used_safe_preset: false,
                scale: MapScale::Small,
                theme: 0,
                spawn_points: Vec::new(),
                surface_points: Vec::new(),
                buried_slots: Vec::new(),
                decorations: Vec::new(),
                wind: 0.0,
                traversable_fraction: 1.0,
                largest_component: Vec::new(),
            },
            dirty: vec![false; chunks],
            dirty_list: Vec::new(),
        }
    }

    /// Solid from `y` downward across the full width.
    pub(crate) fn floor_at(y: i32) -> impl FnOnce(&mut Mask) {
        move |m: &mut Mask| {
            for fy in y..m.h as i32 {
                m.set_run(fy, 0, m.w as i32 - 1);
            }
        }
    }

    fn box_at(x: f32, y: f32) -> Aabb {
        Aabb::from_center_size(Vec2::new(x, y), PLAYER_W, PLAYER_H)
    }

    /// A body whose feet rest exactly on a floor at `floor_y`.
    fn resting_on(floor_y: i32, x: f32) -> Aabb {
        box_at(x, floor_y as f32 - PLAYER_H / 2.0)
    }

    #[test]
    fn solid_at_outside_the_map_is_false() {
        let map = test_map(512, 512, floor_at(200));
        assert!(!solid_at(&map, -1, 300));
        assert!(!solid_at(&map, 512, 300));
        assert!(!solid_at(&map, 100, -1));
        assert!(!solid_at(&map, 100, 512));
    }

    #[test]
    fn a_box_in_open_air_does_not_overlap() {
        let map = test_map(512, 512, floor_at(400));
        assert!(!aabb_overlaps_solid(&map, box_at(100.0, 100.0)));
    }

    #[test]
    fn a_box_in_solid_rock_overlaps() {
        let map = test_map(512, 512, |m| {
            for y in 0..512 {
                m.set_run(y, 0, 511);
            }
        });
        assert!(aabb_overlaps_solid(&map, box_at(100.0, 100.0)));
    }

    #[test]
    fn one_pixel_of_overlap_at_each_corner_is_detected() {
        // Corner cases are where coarse-cell iteration usually gets its bounds
        // wrong, so all four are checked explicitly.
        for (name, px, py) in [
            ("top-left", 92, 86),
            ("top-right", 107, 86),
            ("bottom-left", 92, 113),
            ("bottom-right", 107, 113),
        ] {
            let map = test_map(512, 512, move |m| m.set(px, py));
            assert!(
                aabb_overlaps_solid(&map, box_at(100.0, 100.0)),
                "{name} pixel ({px},{py}) not detected"
            );
        }
    }

    #[test]
    fn one_pixel_clear_on_each_side_is_not_detected() {
        for (name, px, py) in [
            ("left", 91, 100),
            ("right", 108, 100),
            ("above", 100, 85),
            ("below", 100, 114),
        ] {
            let map = test_map(512, 512, move |m| m.set(px, py));
            assert!(
                !aabb_overlaps_solid(&map, box_at(100.0, 100.0)),
                "{name} pixel ({px},{py}) falsely detected"
            );
        }
    }

    /// The most valuable test here: proves the coarse fast path never lies.
    #[test]
    fn the_coarse_fast_path_agrees_with_brute_force_on_a_real_map() {
        let map = crate::map::generate(4242, MapScale::Small);
        let mut rng = substream(7, "collide-fuzz");

        for _ in 0..10_000 {
            let x = rng.gen_range(-20.0..map.mask.w as f32 + 20.0);
            let y = rng.gen_range(-20.0..map.mask.h as f32 + 20.0);
            let aabb = box_at(x, y);

            let fast = aabb_overlaps_solid(&map, aabb);

            let (bx0, by0, bx1, by1) = aabb.pixel_bounds();
            let mut brute = false;
            'outer: for py in by0..=by1 {
                for px in bx0..=bx1 {
                    if map.mask.get(px, py) {
                        brute = true;
                        break 'outer;
                    }
                }
            }

            assert_eq!(fast, brute, "disagreement for box at ({x}, {y})");
        }
    }

    #[test]
    fn the_query_trusts_the_coarse_grid_for_empty_cells() {
        // Build a mask, take its grid, then corrupt the BITS behind an empty cell.
        // The query must not read them — that is what makes the fast path fast.
        let mut mask = Mask::new_empty(512, 512);
        let coarse = CoarseGrid::build(&mask);
        mask.set(100, 100); // grid still says this cell is empty
        let chunks = (mask.chunks_x() * mask.chunks_y()) as usize;
        let map = Map {
            mask,
            coarse,
            meta: test_map(256, 256, |_| {}).meta,
            dirty: vec![false; chunks],
            dirty_list: Vec::new(),
        };
        assert!(
            !aabb_overlaps_solid(&map, box_at(100.0, 100.0)),
            "the query read bits behind a cell the grid called Empty"
        );
    }

    #[test]
    fn raycast_down_onto_a_floor_finds_its_top() {
        let map = test_map(512, 512, floor_at(200));
        let hit = raycast(&map, Vec2::new(100.0, 50.0), Vec2::new(0.0, 1.0), 500.0)
            .expect("must hit the floor");
        assert!((hit.y - 200.0).abs() <= 1.0, "hit at {hit:?}");
        assert!((hit.x - 100.0).abs() < 0.01);
    }

    #[test]
    fn raycast_into_open_air_finds_nothing() {
        let map = test_map(512, 512, floor_at(200));
        assert!(raycast(&map, Vec2::new(100.0, 100.0), Vec2::new(0.0, -1.0), 50.0).is_none());
    }

    #[test]
    fn raycast_respects_max_dist() {
        let map = test_map(512, 512, floor_at(200));
        // The floor is 150 px away; the ray only reaches 100.
        assert!(raycast(&map, Vec2::new(100.0, 50.0), Vec2::new(0.0, 1.0), 100.0).is_none());
        assert!(raycast(&map, Vec2::new(100.0, 50.0), Vec2::new(0.0, 1.0), 200.0).is_some());
    }

    #[test]
    fn raycast_from_inside_solid_returns_its_origin() {
        let map = test_map(512, 512, floor_at(200));
        let from = Vec2::new(100.0, 300.0);
        assert_eq!(raycast(&map, from, Vec2::new(1.0, 0.0), 50.0), Some(from));
    }

    #[test]
    fn raycast_with_a_zero_direction_is_none() {
        let map = test_map(512, 512, floor_at(200));
        assert!(raycast(&map, Vec2::new(100.0, 100.0), Vec2::ZERO, 50.0).is_none());
    }

    // ---- ground probe ----------------------------------------------------

    #[test]
    fn a_box_resting_on_the_floor_probes_zero() {
        let map = test_map(512, 512, floor_at(200));
        let aabb = resting_on(200, 100.0);
        assert_eq!(ground_probe(&map, aabb, STEP_DOWN), Some(0));
        assert!(is_on_ground(&map, aabb));
    }

    #[test]
    fn a_box_three_px_above_the_floor_probes_three() {
        let map = test_map(512, 512, floor_at(200));
        let aabb = resting_on(200, 100.0).translated(Vec2::new(0.0, -3.0));
        assert_eq!(ground_probe(&map, aabb, STEP_DOWN), Some(3));
        assert!(!is_on_ground(&map, aabb), "3 px up is not resting");
    }

    #[test]
    fn a_box_too_far_above_the_floor_probes_none() {
        let map = test_map(512, 512, floor_at(200));
        let aabb = resting_on(200, 100.0).translated(Vec2::new(0.0, -20.0));
        assert_eq!(ground_probe(&map, aabb, STEP_DOWN), None);
        assert_eq!(ground_probe(&map, box_at(100.0, 50.0), STEP_DOWN), None);
    }

    #[test]
    fn is_on_ground_is_false_for_an_embedded_box() {
        // Checking only "would overlap 1 px down" would return true here, and the
        // body would never resolve out of the rock.
        let map = test_map(512, 512, floor_at(200));
        let embedded = box_at(100.0, 210.0);
        assert!(aabb_overlaps_solid(&map, embedded), "precondition");
        assert!(!is_on_ground(&map, embedded));
    }

    #[test]
    fn is_on_ground_is_false_one_px_above_the_floor() {
        let map = test_map(512, 512, floor_at(200));
        let aabb = resting_on(200, 100.0).translated(Vec2::new(0.0, -1.0));
        assert!(!is_on_ground(&map, aabb));
    }

    // ---- step up ---------------------------------------------------------

    #[test]
    fn a_four_px_step_needs_a_four_px_lift() {
        let map = test_map(512, 512, |m| {
            for y in 200..512 {
                m.set_run(y, 0, 511);
            }
            // A 4 px step from x = 120 rightward.
            for y in 196..200 {
                m.set_run(y, 120, 511);
            }
        });
        // Body overlapping the step face.
        let aabb = resting_on(200, 124.0);
        assert!(aabb_overlaps_solid(&map, aabb), "precondition: overlapping");
        assert_eq!(
            step_up_clearance(&map, aabb, crate::constants::STEP_UP),
            Some(4)
        );
    }

    #[test]
    fn a_seven_px_step_is_a_wall_at_step_up_six() {
        let map = test_map(512, 512, |m| {
            for y in 200..512 {
                m.set_run(y, 0, 511);
            }
            for y in 193..200 {
                m.set_run(y, 120, 511);
            }
        });
        let aabb = resting_on(200, 124.0);
        assert_eq!(
            step_up_clearance(&map, aabb, crate::constants::STEP_UP),
            None
        );
    }

    #[test]
    fn step_up_returns_the_smallest_working_lift() {
        // A 2 px lift clears; so would 5. It must return 2, or players hop.
        let map = test_map(512, 512, |m| {
            for y in 200..512 {
                m.set_run(y, 0, 511);
            }
            for y in 198..200 {
                m.set_run(y, 120, 511);
            }
        });
        let aabb = resting_on(200, 124.0);
        assert_eq!(step_up_clearance(&map, aabb, 6), Some(2));
    }

    #[test]
    fn a_ceiling_prevents_stepping_up() {
        let map = test_map(512, 512, |m| {
            for y in 200..512 {
                m.set_run(y, 0, 511);
            }
            for y in 196..200 {
                m.set_run(y, 120, 511);
            }
            // Ceiling right above the body.
            for y in 150..172 {
                m.set_run(y, 0, 511);
            }
        });
        let aabb = resting_on(200, 124.0);
        assert_eq!(
            step_up_clearance(&map, aabb, crate::constants::STEP_UP),
            None
        );
    }

    #[test]
    fn ground_probe_stays_within_step_down_on_a_thirty_degree_slope() {
        // The property that makes downhill walking smooth (used by T2.05).
        // tan(30 deg) ~ 0.577, so 16 px across drops ~9 px — but sampled every
        // 4 px the drop per sample stays inside STEP_DOWN.
        let map = test_map(1024, 512, |m| {
            for x in 0..1024 {
                let surface = 200 + (x as f32 * 0.577) as i32;
                for y in surface..512 {
                    m.set(x, y);
                }
            }
        });

        let mut x = 100.0f32;
        while x < 300.0 {
            let surface = 200 + (x as i32 as f32 * 0.577) as i32;
            let aabb = resting_on(surface, x);
            // Standing on the slope, the probe must find ground within STEP_DOWN
            // after a small horizontal move.
            let moved = aabb.translated(Vec2::new(4.0, 0.0));
            if !aabb_overlaps_solid(&map, moved) {
                let d = ground_probe(&map, moved, STEP_DOWN);
                assert!(
                    d.is_some(),
                    "no ground within STEP_DOWN at x={x} after a 4 px step"
                );
            }
            x += 4.0;
        }
    }
}
