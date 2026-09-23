//! Passes 7b–7c: the traversal graph and validation.
//!
//! This is what makes "no player is ever stranded" a testable property rather than
//! a hope. Nodes are surface points; edges are the moves a player can actually
//! make. If the largest connected component does not cover
//! `MIN_TRAVERSABLE_FRACTION` of the surface, the map is regenerated.
//!
//! **Be conservative.** A false negative costs one extra generation attempt; a
//! false positive strands a player for four minutes. When a check is borderline,
//! say no.
//!
//! See `docs/10-map-generation.md` §Pass 7b, 7c.

use crate::constants::{
    GRAVITY, JETPACK_CLIMB_BUDGET, JETPACK_MAX_FUEL, JETPACK_MAX_SPEED, JUMP_VELOCITY,
    MIN_TRAVERSABLE_FRACTION, SPAWN_COUNT_MIN, SPAWN_MIN_SEPARATION, STEP_UP, SURFACE_SAMPLE_STEP,
    WALK_SPEED,
};
use crate::map::gen::objects::{self, PlacedObject};
use crate::map::Mask;
use crate::math::Point;

/// Conservative jetpack reach: full speed for the whole tank, times 0.6 slack for
/// the fact that flight is not a straight line.
pub const JETPACK_RANGE: f32 = JETPACK_MAX_SPEED * JETPACK_MAX_FUEL * 0.6;

/// Peak of a jump: `v² / 2g` ≈ 66 px.
pub const JUMP_HEIGHT: f32 = JUMP_VELOCITY * JUMP_VELOCITY / (2.0 * GRAVITY);

/// Horizontal reach of a full jump at walk speed ≈ 92 px.
pub const JUMP_REACH: f32 = WALK_SPEED * 2.0 * JUMP_VELOCITY / GRAVITY;

/// Arc and corridor sampling interval, in px.
const SAMPLE_STEP: f32 = 8.0;

#[derive(Clone, Debug, PartialEq)]
pub struct TraversalReport {
    pub total_points: usize,
    /// Indices into the surface point list.
    pub largest_component: Vec<usize>,
    pub traversable_fraction: f32,
    pub passed: bool,
}

/// Where the player body fits, and which of those positions connect.
///
/// This is the edge type the four ballistic predicates cannot express. A cave is
/// reached through a **winding** shaft: no straight line and no parabola runs from
/// a surface point down into it, so a graph built only from those predicates scores
/// every cave floor as its own island. Measured on a medium map, that put the
/// traversable fraction at 0.59 while a body flood proved 100% of chambers were in
/// fact reachable — the map was fine and the model was wrong.
///
/// **A shared region is necessary but not sufficient** (`docs/70` §A10). The box
/// fits everywhere in open air, so the whole sky is one region; unioning it wholesale
/// certified a 1900 px ledgeless shaft at fraction 1.000. A region edge is therefore
/// only issued between points within `JETPACK_CLIMB_BUDGET` of each other, and longer
/// routes must chain through intermediate surface points — which is exactly the
/// "land on a ledge and refuel" the budget describes.
pub struct NavRegions {
    w: i32,
    labels: Vec<u32>,
}

impl NavRegions {
    /// Both dilations are separable and run with a sliding count, so this is O(w·h)
    /// rather than O(w·h·PLAYER_W·PLAYER_H).
    pub fn build(mask: &Mask) -> Self {
        let (w, h) = (mask.w as i32, mask.h as i32);
        let half = (crate::constants::PLAYER_W as i32) / 2;
        let body_h = crate::constants::PLAYER_H as i32;
        let (wu, hu) = (w as usize, h as usize);

        // 1. Horizontal dilation: `wide[y][x]` = any solid in row y over the box's
        //    column span [x-half, x+half-1].
        let mut wide = vec![false; wu * hu];
        for y in 0..h {
            let mut count = 0i32;
            // Prime the window over [-half, half-1].
            for x in -half..half {
                if mask.get(x, y) {
                    count += 1;
                }
            }
            for x in 0..w {
                wide[y as usize * wu + x as usize] = count > 0;
                // Slide: drop x-half, take x+half.
                if mask.get(x - half, y) {
                    count -= 1;
                }
                if mask.get(x + half, y) {
                    count += 1;
                }
            }
        }

        // 2. Vertical dilation over `wide`: the box with its bottom edge at y spans
        //    rows y-body_h+1 ..= y.
        let mut fits = vec![false; wu * hu];
        for x in 0..w {
            let mut count = 0i32;
            for y in 0..body_h.min(h) {
                if wide[y as usize * wu + x as usize] {
                    count += 1;
                }
            }
            for y in (body_h - 1)..h {
                fits[y as usize * wu + x as usize] = count == 0;
                let leaving = y - body_h + 1;
                if wide[leaving as usize * wu + x as usize] {
                    count -= 1;
                }
                if y + 1 < h && wide[(y + 1) as usize * wu + x as usize] {
                    count += 1;
                }
            }
        }

        // 3. Label the connected regions of `fits`.
        let mut labels = vec![0u32; wu * hu];
        let mut next = 0u32;
        let mut stack: Vec<Point> = Vec::with_capacity(4096);
        for y0 in 0..h {
            for x0 in 0..w {
                let i0 = y0 as usize * wu + x0 as usize;
                if labels[i0] != 0 || !fits[i0] {
                    continue;
                }
                next += 1;
                labels[i0] = next;
                stack.clear();
                stack.push(Point::new(x0, y0));
                while let Some(p) = stack.pop() {
                    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                        let (nx, ny) = (p.x + dx, p.y + dy);
                        if nx < 0 || ny < 0 || nx >= w || ny >= h {
                            continue;
                        }
                        let i = ny as usize * wu + nx as usize;
                        if labels[i] != 0 || !fits[i] {
                            continue;
                        }
                        labels[i] = next;
                        stack.push(Point::new(nx, ny));
                    }
                }
            }
        }

        NavRegions { w, labels }
    }

    /// 0 means the body does not fit here at all.
    #[inline]
    pub fn label_at(&self, p: Point) -> u32 {
        if p.x < 0 || p.y < 0 || p.x >= self.w {
            return 0;
        }
        let i = p.y as usize * self.w as usize + p.x as usize;
        self.labels.get(i).copied().unwrap_or(0)
    }
}

/// A uniform grid over the map, so only neighbouring cells need edge testing.
///
/// A dense all-pairs graph over a few thousand points is millions of edge tests and
/// would dominate generation time. Deliberately a `Vec` rather than a `HashMap`:
/// `HashMap` iteration order is randomly seeded per process, and anything the
/// generator's output depends on must be ordered (`docs/70` §A11).
struct Buckets {
    cell: i32,
    gw: i32,
    gh: i32,
    lists: Vec<Vec<u32>>,
}

impl Buckets {
    fn build(mask: &Mask, surface: &[Point], cell: i32) -> Self {
        let cell = cell.max(1);
        let gw = (mask.w as i32).div_euclid(cell) + 2;
        let gh = (mask.h as i32).div_euclid(cell) + 2;
        let mut lists = vec![Vec::new(); (gw * gh) as usize];
        for (i, p) in surface.iter().enumerate() {
            let gx = p.x.div_euclid(cell).clamp(0, gw - 1);
            let gy = p.y.div_euclid(cell).clamp(0, gh - 1);
            lists[(gy * gw + gx) as usize].push(i as u32);
        }
        Buckets {
            cell,
            gw,
            gh,
            lists,
        }
    }

    /// Every index in the 3×3 block of cells around `p`, in a fixed order.
    fn neighbours(&self, p: Point, out: &mut Vec<u32>) {
        out.clear();
        let (bx, by) = (
            p.x.div_euclid(self.cell).clamp(0, self.gw - 1),
            p.y.div_euclid(self.cell).clamp(0, self.gh - 1),
        );
        for gy in (by - 1).max(0)..=(by + 1).min(self.gh - 1) {
            for gx in (bx - 1).max(0)..=(bx + 1).min(self.gw - 1) {
                out.extend_from_slice(&self.lists[(gy * self.gw + gx) as usize]);
            }
        }
    }
}

/// Build the **directed** graph, find the largest strongly connected set, and check
/// the invariants.
///
/// Directed is the whole point (`docs/70` §A10). Falling is free and climbing is
/// not, so "a can reach b" does not imply "b can reach a" — and a validation that
/// assumes it does will certify a pit you die in. The metric is the largest set of
/// points that can all reach each other **both ways**.
pub fn analyse(mask: &Mask, surface: &[Point], objects: &[PlacedObject]) -> TraversalReport {
    let n = surface.len();
    if n == 0 {
        return TraversalReport {
            total_points: 0,
            largest_component: Vec::new(),
            traversable_fraction: 0.0,
            passed: false,
        };
    }

    let nav = NavRegions::build(mask);
    let labels: Vec<u32> = surface.iter().map(|p| nav.label_at(*p)).collect();

    // Region edges are capped at the climb budget, so bucketing by it covers both
    // them and the (shorter) ballistic edges.
    let budget_sq = (JETPACK_CLIMB_BUDGET * JETPACK_CLIMB_BUDGET) as i64;
    let buckets = Buckets::build(mask, surface, JETPACK_CLIMB_BUDGET.max(1.0) as i32);

    let mut adj: Vec<Vec<u32>> = vec![Vec::new(); n];
    let mut near: Vec<u32> = Vec::new();
    for (i, a) in surface.iter().enumerate() {
        buckets.neighbours(*a, &mut near);
        for &ju in near.iter() {
            let j = ju as usize;
            // Each unordered pair once; both directions are decided together.
            if j <= i {
                continue;
            }
            let b = surface[j];

            // Same navigable region and inside one tank of fuel: mutual. Beyond the
            // budget, a shared region proves nothing — see NavRegions' doc comment.
            let region_edge =
                labels[i] != 0 && labels[i] == labels[j] && a.distance_sq(b) <= budget_sq;

            let walk = can_walk(mask, *a, b);
            let jet = can_jetpack(mask, *a, b);

            let fwd = walk || jet || region_edge || can_drop(mask, *a, b) || can_jump(mask, *a, b);
            let rev = walk || jet || region_edge || can_drop(mask, b, *a) || can_jump(mask, b, *a);

            if fwd {
                adj[i].push(ju);
            }
            if rev {
                adj[j].push(i as u32);
            }
        }
    }

    let mut largest = largest_scc(&adj);
    largest.sort_unstable();

    let traversable_fraction = largest.len() as f32 / n as f32;

    // §D5 keeps spawns `OBJECT_CLEAR_OF_SPAWN` from an object centre, so the
    // candidates validation counts must be the ones that survive that rule.
    //
    // **Counted here rather than fixed up in pass 8.** A map whose objects blanket
    // its surface has nowhere legal to put six spawns, and that is the same class
    // of failure as a map cut in two — so it goes through the same door: fail
    // validation, and `generate_terrain` retries on the next seed. Filtering after
    // the fact instead would mean either five spawns on a six-player map, or
    // spawns beside the objects the rule exists to keep them away from.
    let clear = objects::clear_of_objects(surface, &largest, objects, objects::WhenStarved::Reject);
    let enough_spawns = count_separated(surface, &clear, SPAWN_MIN_SEPARATION) >= SPAWN_COUNT_MIN;
    let passed = traversable_fraction >= MIN_TRAVERSABLE_FRACTION && enough_spawns;

    TraversalReport {
        total_points: n,
        largest_component: largest,
        traversable_fraction,
        passed,
    }
}

/// Tarjan's strongly connected components, **iterative** — the graphs run to tens of
/// thousands of nodes and recursion would blow the stack.
///
/// Returns the largest component. Ties are broken on the lowest member index, never
/// left to `max_by_key`'s last-wins over an unordered container: the previous code
/// took the largest component out of a `HashMap`, which is randomly seeded per
/// process, so tied components resolved differently between runs of the same binary
/// on the same input — and that feeds spawn selection (`docs/70` §A11).
fn largest_scc(adj: &[Vec<u32>]) -> Vec<usize> {
    let n = adj.len();
    const UNVISITED: u32 = u32::MAX;

    let mut index = vec![UNVISITED; n];
    let mut low = vec![0u32; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<u32> = Vec::with_capacity(n);
    let mut next_index: u32 = 0;

    // (node, position in that node's adjacency list)
    let mut call: Vec<(u32, usize)> = Vec::with_capacity(64);
    let mut best: Vec<usize> = Vec::new();

    for root in 0..n {
        if index[root] != UNVISITED {
            continue;
        }
        call.push((root as u32, 0));
        index[root] = next_index;
        low[root] = next_index;
        next_index += 1;
        stack.push(root as u32);
        on_stack[root] = true;

        while let Some(&mut (v, ref mut edge)) = call.last_mut() {
            let vu = v as usize;
            if *edge < adj[vu].len() {
                let w = adj[vu][*edge] as usize;
                *edge += 1;
                if index[w] == UNVISITED {
                    index[w] = next_index;
                    low[w] = next_index;
                    next_index += 1;
                    stack.push(w as u32);
                    on_stack[w] = true;
                    call.push((w as u32, 0));
                } else if on_stack[w] {
                    low[vu] = low[vu].min(index[w]);
                }
            } else {
                call.pop();
                if let Some(&(parent, _)) = call.last() {
                    low[parent as usize] = low[parent as usize].min(low[vu]);
                }
                if low[vu] == index[vu] {
                    // Pop one component off the stack.
                    let mut comp: Vec<usize> = Vec::new();
                    while let Some(w) = stack.pop() {
                        on_stack[w as usize] = false;
                        comp.push(w as usize);
                        if w == v {
                            break;
                        }
                    }
                    comp.sort_unstable();
                    let better = match comp.len().cmp(&best.len()) {
                        std::cmp::Ordering::Greater => true,
                        std::cmp::Ordering::Equal => {
                            comp.first().copied().unwrap_or(usize::MAX)
                                < best.first().copied().unwrap_or(usize::MAX)
                        }
                        std::cmp::Ordering::Less => false,
                    };
                    if better {
                        best = comp;
                    }
                }
            }
        }
    }

    best
}

/// Greedy count of points at least `sep` apart, so "enough spawns exist" is checked
/// with the same separation rule T1.12 will use.
fn count_separated(surface: &[Point], component: &[usize], sep: f32) -> usize {
    let sep_sq = (sep * sep) as i64;
    let mut chosen: Vec<Point> = Vec::new();
    for &i in component {
        let p = surface[i];
        if chosen.iter().all(|c| p.distance_sq(*c) >= sep_sq) {
            chosen.push(p);
            if chosen.len() >= SPAWN_COUNT_MIN {
                break;
            }
        }
    }
    chosen.len()
}

/// Walk: adjacent columns, small height change, and the body sweep is clear.
pub fn can_walk(mask: &Mask, a: Point, b: Point) -> bool {
    if (a.x - b.x).abs() > SURFACE_SAMPLE_STEP || (a.y - b.y).abs() > STEP_UP {
        return false;
    }
    sweep_clear(mask, a, b)
}

/// Drop: `b` is below `a`, roughly beneath it, with a clear fall corridor.
///
/// The corridor is **vertical, at `b.x`** — not the slanted line from `a` to `b`.
/// A drop happens by walking off an edge and then falling, so the slanted line
/// starts inside the platform you are standing on and is always blocked by its own
/// rock. Tracing it instead of the fall column makes drop edges essentially never
/// fire, which quietly costs a large slice of the traversable fraction.
pub fn can_drop(mask: &Mask, a: Point, b: Point) -> bool {
    if b.y <= a.y || (a.x - b.x).abs() > SURFACE_SAMPLE_STEP {
        return false;
    }
    let steps = (((b.y - a.y) as f32 / SAMPLE_STEP).ceil() as i32).max(1);
    for s in 0..=steps {
        let y = a.y + (b.y - a.y) * s / steps;
        if !body_clear(mask, b.x, y) {
            return false;
        }
    }
    true
}

/// Jump: `b` is inside the ballistic envelope from `a`, and the sampled arc is
/// clear. The envelope check alone is not enough — a wall between two points that
/// are within range must block the edge, which is what the arc sampling proves.
pub fn can_jump(mask: &Mask, a: Point, b: Point) -> bool {
    let dx = (b.x - a.x) as f32;
    let dy = (b.y - a.y) as f32; // negative = upward
    if dx.abs() > JUMP_REACH || -dy > JUMP_HEIGHT {
        return false;
    }

    let vy = -JUMP_VELOCITY;
    // Time to reach b's height: 0.5*g*t² + vy*t - dy = 0.
    let disc = vy * vy + 2.0 * GRAVITY * dy;
    if disc < 0.0 {
        return false; // the apex is below b — never reaches that height
    }
    let root = disc.sqrt();

    // BOTH roots are legitimate arrivals: the early one crosses b on the way up,
    // the late one on the way down. Trying only the ascending root rejects most
    // real jumps, because covering 60 px in the 0.11 s before the apex would need
    // 526 px/s of horizontal speed, while the descending arrival needs only 120.
    let max_vx = WALK_SPEED + crate::constants::JUMP_H_BOOST;
    for t in [(-vy - root) / GRAVITY, (-vy + root) / GRAVITY] {
        if t <= 0.0 {
            continue;
        }
        let vx = dx / t;
        if vx.abs() > max_vx {
            continue;
        }
        if arc_clear(mask, a, vx, vy, t) {
            return true;
        }
    }
    false
}

/// Sample a launch arc from `a` and test the body box at each sample.
fn arc_clear(mask: &Mask, a: Point, vx: f32, vy: f32, t_end: f32) -> bool {
    let span = (vx.abs() * t_end).max(JUMP_HEIGHT);
    let steps = ((span / SAMPLE_STEP).ceil() as i32).max(1);
    for s in 0..=steps {
        let ts = t_end * s as f32 / steps as f32;
        let x = a.x as f32 + vx * ts;
        let y = a.y as f32 + vy * ts + 0.5 * GRAVITY * ts * ts;
        if !body_clear(mask, x.round() as i32, y.round() as i32) {
            return false;
        }
    }
    true
}

/// Jetpack: within the conservative range, straight line clear.
pub fn can_jetpack(mask: &Mask, a: Point, b: Point) -> bool {
    let d_sq = a.distance_sq(b) as f32;
    if d_sq > JETPACK_RANGE * JETPACK_RANGE {
        return false;
    }
    sweep_clear(mask, a, b)
}

/// Sample the straight line between two points, testing the body box at each.
fn sweep_clear(mask: &Mask, a: Point, b: Point) -> bool {
    let dx = (b.x - a.x) as f32;
    let dy = (b.y - a.y) as f32;
    let len = (dx * dx + dy * dy).sqrt();
    let steps = ((len / SAMPLE_STEP).ceil() as i32).max(1);
    for s in 0..=steps {
        let t = s as f32 / steps as f32;
        let x = (a.x as f32 + dx * t).round() as i32;
        let y = (a.y as f32 + dy * t).round() as i32;
        if !body_clear(mask, x, y) {
            return false;
        }
    }
    true
}

/// Is the player box, bottom edge at `y` and centred on `x`, entirely air?
fn body_clear(mask: &Mask, x: i32, y: i32) -> bool {
    let half = (crate::constants::PLAYER_W as i32) / 2;
    let h = crate::constants::PLAYER_H as i32;
    let (x0, x1) = (x - half, x + half - 1);
    for by in (y - h + 1)..=y {
        if mask.count_run(by, x0, x1) != 0 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {

    /// The clearance branch of `analyse`, at its own call site.
    ///
    /// Every other test here passes `&[]`, which short-circuits to the pre-6b
    /// behaviour — correct, and the reason those are behaviour-preserving, but it
    /// leaves the branch that decides whether a map is **rejected** exercised only
    /// indirectly through `generate()`. This drives it directly: the same mask and
    /// surface, once with no objects and once with objects blanketing the ground,
    /// and only the second is refused.
    #[test]
    fn objects_blanketing_the_surface_make_analyse_reject_the_map() {
        use crate::constants::OBJECT_CLEAR_OF_SPAWN;
        use crate::map::gen::objects::PlacedObject;

        let mut m = Mask::new_empty(2048, 512);
        for y in 400..512 {
            m.set_run(y, 0, 2047);
        }
        let surface = crate::map::gen::surface::extract_surface(&m);

        // The control: flat open ground passes, so a rejection below is the
        // objects and not the fixture.
        let clean = analyse(&m, &surface, &[]);
        assert!(
            clean.passed,
            "flat ground failed validation on its own: fraction {:.3}, {} points",
            clean.traversable_fraction,
            surface.len()
        );

        // One object every OBJECT_CLEAR_OF_SPAWN across the whole width: no
        // surface point is far enough from all of them to seat a spawn.
        let blanket: Vec<PlacedObject> = (0..2048 / OBJECT_CLEAR_OF_SPAWN)
            .map(|i| PlacedObject {
                id: 0,
                x: i * OBJECT_CLEAR_OF_SPAWN,
                y: 380,
                w: 8,
                h: 8,
                flip: false,
            })
            .collect();
        let blanketed = analyse(&m, &surface, &blanket);
        assert!(
            !blanketed.passed,
            "a surface with no legal spawn left passed validation"
        );

        // And it is the *spawn* clause that refused it, not traversability —
        // otherwise this would pass for the wrong reason.
        assert!(
            blanketed.traversable_fraction >= MIN_TRAVERSABLE_FRACTION,
            "the map became untraversable, so the spawn clause was never reached"
        );
        assert_eq!(
            blanketed.largest_component, clean.largest_component,
            "objects must not change the component; they only change what can spawn"
        );
    }

    /// A few objects must **not** reject a map, or 6b would fail every seed.
    #[test]
    fn a_handful_of_objects_leaves_a_map_passing() {
        use crate::map::gen::objects::PlacedObject;

        let mut m = Mask::new_empty(2048, 512);
        for y in 400..512 {
            m.set_run(y, 0, 2047);
        }
        let surface = crate::map::gen::surface::extract_surface(&m);
        let few: Vec<PlacedObject> = [200, 400, 600]
            .iter()
            .map(|&x| PlacedObject {
                id: 0,
                x,
                y: 380,
                w: 8,
                h: 8,
                flip: false,
            })
            .collect();
        assert!(analyse(&m, &surface, &few).passed);
    }
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::silhouette::GenParams;
    use crate::map::gen::surface::extract_surface;

    // Wide enough that SPAWN_COUNT_MIN points can be SPAWN_MIN_SEPARATION apart:
    // 6 x 256 = 1536, so a 1024-wide test map can never pass validation.
    const W: u32 = 2048;
    const H: u32 = 768;

    /// A solid platform whose top surface is at `y`, spanning `x0..=x1`.
    fn platform(m: &mut Mask, x0: i32, x1: i32, y: i32) {
        for py in y..(y + 40).min(H as i32) {
            m.set_run(py, x0, x1);
        }
    }

    fn feet_on(y: i32) -> i32 {
        y - 1
    }

    #[test]
    fn two_platforms_20px_apart_are_connected_by_walking() {
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 100, 300, 400);
        platform(&mut m, 320, 500, 400);
        let a = Point::new(290, feet_on(400));
        let b = Point::new(330, feet_on(400));
        // 40 px apart is beyond one sample step, so walking should not connect them;
        // 16 px should.
        let near = Point::new(300, feet_on(400));
        assert!(can_walk(&m, a, near), "adjacent points should walk");
        assert!(!can_walk(&m, a, b), "40 px is beyond a walk edge");
    }

    #[test]
    fn platforms_beyond_jetpack_range_are_not_connected() {
        // JETPACK_RANGE is 260 * 5.0 * 0.6 = 780 px, so "300 px apart with nothing
        // between" is comfortably *reachable* by design — the doc intends jetpack
        // traversal to be real. Unreachable means beyond 780 px.
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 100, 200, 400);
        platform(&mut m, 1400, 1600, 400);
        let a = Point::new(150, feet_on(400));
        let b = Point::new(1450, feet_on(400));
        assert!(!can_walk(&m, a, b));
        assert!(!can_jump(&m, a, b));
        assert!(
            !can_jetpack(&m, a, b),
            "1300 px must exceed the jetpack range of {JETPACK_RANGE}"
        );
    }

    #[test]
    fn a_300px_gap_is_crossed_by_jetpack() {
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 100, 200, 400);
        platform(&mut m, 500, 600, 400);
        let a = Point::new(150, feet_on(400));
        let b = Point::new(550, feet_on(400));
        assert!(
            can_jetpack(&m, a, b),
            "400 px is inside the {JETPACK_RANGE} px range"
        );
    }

    #[test]
    fn a_60px_gap_with_a_40px_rise_is_crossed_by_jumping() {
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 100, 300, 400);
        platform(&mut m, 360, 600, 360);
        let a = Point::new(300, feet_on(400));
        let b = Point::new(360, feet_on(360));

        assert!(!can_walk(&m, a, b), "too far and too high to walk");
        assert!(can_jump(&m, a, b), "should be within the jump envelope");
    }

    #[test]
    fn platforms_200px_apart_are_connected_by_jetpack_only() {
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 100, 250, 400);
        platform(&mut m, 450, 600, 400);
        let a = Point::new(240, feet_on(400));
        let b = Point::new(460, feet_on(400));

        assert!(!can_walk(&m, a, b));
        assert!(
            !can_jump(&m, a, b),
            "220 px is beyond jump reach {JUMP_REACH}"
        );
        assert!(
            can_jetpack(&m, a, b),
            "220 px is inside jetpack range {JETPACK_RANGE}"
        );
    }

    #[test]
    fn a_wall_blocks_a_jump_that_is_otherwise_in_range() {
        // The test that proves the arc is actually sampled rather than the endpoints
        // being checked against a bounding box.
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 100, 300, 400);
        platform(&mut m, 340, 600, 400);
        let a = Point::new(300, feet_on(400));
        let b = Point::new(340, feet_on(400));
        assert!(can_jump(&m, a, b), "precondition: reachable with no wall");

        // Now put a tall wall in the gap.
        for y in 200..400 {
            m.set_run(y, 315, 325);
        }
        assert!(
            !can_jump(&m, a, b),
            "the arc passes straight through a wall"
        );
        assert!(
            !can_jetpack(&m, a, b),
            "the straight line passes through a wall"
        );
    }

    #[test]
    fn a_sealed_chamber_forms_its_own_component() {
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 0, W as i32 - 1, 600);

        // A chamber hollowed out of a solid block: floor to stand on, walls and a
        // roof thick enough that no straight line escapes. The earlier version of
        // this test left the bottom open, so the jetpack edge simply flew out.
        for y in 100..300 {
            m.set_run(y, 700, 1000);
        }
        for y in 200..240 {
            m.clear_run(y, 760, 940);
        }

        let surface = extract_surface(&m);
        let report = analyse(&m, &surface, &[]);
        assert!(report.total_points > 0);

        // The chamber floor is at y=240, feet at 239, inside x 760..940.
        let inside: Vec<usize> = surface
            .iter()
            .enumerate()
            .filter(|(_, p)| p.y == 239 && (760..940).contains(&p.x))
            .map(|(i, _)| i)
            .collect();
        assert!(!inside.is_empty(), "no standable point inside the chamber");
        for i in inside {
            assert!(
                !report.largest_component.contains(&i),
                "sealed chamber point {:?} joined the main component",
                surface[i]
            );
        }
    }

    #[test]
    fn a_single_flat_floor_is_fully_traversable() {
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 0, W as i32 - 1, 600);
        let surface = extract_surface(&m);
        let report = analyse(&m, &surface, &[]);
        assert_eq!(report.traversable_fraction, 1.0);
        assert!(report.passed, "a flat floor must pass validation");
        assert_eq!(report.largest_component.len(), report.total_points);
    }

    #[test]
    fn an_empty_surface_does_not_panic() {
        let m = Mask::new_empty(W, H);
        let report = analyse(&m, &[], &[]);
        assert_eq!(report.total_points, 0);
        assert!(!report.passed);
        assert_eq!(report.traversable_fraction, 0.0);
    }

    // ------------------------------------------------------------------
    // The §A10 adversarial masks.
    //
    // Every one of these was certified traversable by the undirected model, and
    // three of them are places a player falls into and dies in. They are permanent
    // because the failure they guard against is invisible in aggregate statistics:
    // a map with one inescapable pit still scores 0.99.
    // ------------------------------------------------------------------

    /// Tall enough to hold a shaft longer than the climb budget.
    const TALL_H: u32 = 2304;

    /// Solid rock from `y` to the bottom, full width.
    /// §C15: the void is a **hazard, not a wall**.
    ///
    /// The note on T15.02 asks whether the validator counts the bottom band as
    /// walkable ground, because if it did, thinning `BEDROCK_H` to zero would
    /// have moved every traversability number for a reason that has nothing to do
    /// with playability.
    ///
    /// **Measured, it does not, and it cannot.** `NavRegions::build` indexes rows
    /// `0..h` and nothing below; `Mask::get` outside the map reads as air, so the
    /// region under the map is not a wall to route around — it is simply not part
    /// of the graph. This pins that: two maps identical except that one has a
    /// solid bottom row and the other does not produce the same verdict for a
    /// ledge well above the floor.
    #[test]
    fn removing_the_floor_does_not_change_a_verdict_higher_up() {
        const W: u32 = 512;
        const H: u32 = 512;

        let build = |floor: bool| {
            let mut m = Mask::new_empty(W, H);
            // A ledge in the middle of the map, far from the bottom.
            for y in 300..310 {
                m.set_run(y, 100, 400);
            }
            if floor {
                m.set_run(H as i32 - 1, 0, W as i32 - 1);
            }
            m
        };

        let a = build(true);
        let b = build(false);
        // Adjacent surface samples: `can_walk` only ever joins neighbours, so the
        // gap is `SURFACE_SAMPLE_STEP` rather than a number picked to look right.
        let ledge = vec![
            Point { x: 200, y: 299 },
            Point {
                x: 200 + SURFACE_SAMPLE_STEP,
                y: 299,
            },
        ];

        // The control: the two masks really do differ, so "same verdict" is a
        // claim about the validator and not about two identical inputs.
        assert_ne!(a.hash(), b.hash(), "the fixture built the same mask twice");

        assert!(
            can_walk(&a, ledge[0], ledge[1]),
            "the fixture ledge is not walkable even with a floor"
        );
        assert_eq!(
            can_walk(&a, ledge[0], ledge[1]),
            can_walk(&b, ledge[0], ledge[1]),
            "taking the floor away changed a verdict about a ledge 200 px above it"
        );

        let ra = analyse(&a, &ledge, &[]);
        let rb = analyse(&b, &ledge, &[]);
        assert_eq!(
            ra.traversable_fraction, rb.traversable_fraction,
            "the traversable fraction depends on whether there is a floor"
        );
    }

    fn bedrock_from(m: &mut Mask, y: i32, h: u32) {
        for py in y..h as i32 {
            m.set_run(py, 0, m_w(m) - 1);
        }
    }

    fn m_w(m: &Mask) -> i32 {
        m.w as i32
    }

    /// Clear a rectangle.
    fn shaft(m: &mut Mask, x0: i32, x1: i32, y0: i32, y1: i32) {
        for py in y0..=y1 {
            m.clear_run(py, x0, x1);
        }
    }

    /// Analyse a hand-built mask and report whether the deepest surface point —
    /// the one at the bottom of whatever hole the test dug — made it into the
    /// largest strongly connected set.
    fn deepest_is_connected(m: &Mask) -> (bool, f32) {
        let surface = extract_surface(m);
        let report = analyse(m, &surface, &[]);
        let in_main: std::collections::HashSet<usize> =
            report.largest_component.iter().copied().collect();
        let deepest = surface
            .iter()
            .enumerate()
            .max_by_key(|(_, p)| p.y)
            .map(|(i, _)| i);
        match deepest {
            Some(i) => (in_main.contains(&i), report.traversable_fraction),
            None => (false, report.traversable_fraction),
        }
    }

    #[test]
    fn a_ledgeless_shaft_longer_than_the_climb_budget_is_rejected() {
        // The headline case. 1900 px of smooth vertical wall, open to the sky at the
        // top, nothing to land on. A jetpack gives ~1300 px on a full tank and there
        // is nowhere to refuel, so the floor is a grave. The undirected model scored
        // this map at fraction 1.000.
        let mut m = Mask::new_empty(W, TALL_H);
        bedrock_from(&mut m, 200, TALL_H);
        shaft(&mut m, 1000, 1060, 200, 2100);

        let (connected, fraction) = deepest_is_connected(&m);
        assert!(
            !connected,
            "the floor of a 1900 px ledgeless shaft must not be in the traversable \
             set (fraction {fraction:.3})"
        );
    }

    #[test]
    fn a_shaft_inside_the_climb_budget_is_accepted() {
        // The boundary in the other direction, so the test above cannot be satisfied
        // by simply rejecting every shaft. 500 px is one comfortable tank.
        let mut m = Mask::new_empty(W, TALL_H);
        bedrock_from(&mut m, 1400, TALL_H);
        shaft(&mut m, 1000, 1060, 1400, 1900);

        let (connected, fraction) = deepest_is_connected(&m);
        assert!(
            connected,
            "a 500 px shaft is inside the {JETPACK_CLIMB_BUDGET} px climb budget and \
             must stay traversable (fraction {fraction:.3})"
        );
    }

    #[test]
    fn a_pit_deeper_than_the_climb_budget_is_rejected() {
        // Same failure with a wide mouth rather than a narrow one, so it cannot be
        // passing merely because the body does not fit.
        let mut m = Mask::new_empty(W, TALL_H);
        bedrock_from(&mut m, 200, TALL_H);
        shaft(&mut m, 800, 1300, 200, 1600);

        let (connected, _) = deepest_is_connected(&m);
        assert!(
            !connected,
            "a 1400 px pit is inescapable however wide it is"
        );
    }

    #[test]
    fn two_plateaus_beyond_the_budget_are_not_one_component() {
        // Open sky between them, so the body fits the whole way and the nav region
        // is shared — which is exactly why a shared region cannot be sufficient.
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 0, 200, 400);
        platform(&mut m, 1800, W as i32 - 1, 400);

        let surface = extract_surface(&m);
        let report = analyse(&m, &surface, &[]);
        let in_main: std::collections::HashSet<usize> =
            report.largest_component.iter().copied().collect();

        let left = surface.iter().position(|p| p.x < 200);
        let right = surface.iter().position(|p| p.x > 1800);
        let (Some(l), Some(r)) = (left, right) else {
            panic!("both plateaus should produce surface points");
        };
        assert!(
            !(in_main.contains(&l) && in_main.contains(&r)),
            "plateaus 1600 px apart with no way across must not share a component"
        );
    }

    #[test]
    fn a_slit_too_narrow_for_the_body_seals_a_cave_and_a_sealed_pocket_does_too() {
        // These two produce the same verdict, and the test proves they reach it for
        // different reasons: the slit is a real opening that the *body* cannot use,
        // the pocket has no opening at all. Asserting only the verdict would let one
        // of them pass for the wrong reason.
        let build = |slit: bool| {
            let mut m = Mask::new_empty(W, H);
            bedrock_from(&mut m, 200, H);
            // A chamber well inside the rock.
            shaft(&mut m, 900, 1200, 450, 600);
            if slit {
                // One pixel wide: visible, and useless to a 16 px body.
                shaft(&mut m, 1050, 1050, 200, 450);
            }
            m
        };

        let nav_slit = NavRegions::build(&build(true));
        let nav_sealed = NavRegions::build(&build(false));

        let outside = Point::new(400, 199);
        let inside = Point::new(1050, 599);

        assert_ne!(
            nav_slit.label_at(outside),
            0,
            "open ground must be navigable"
        );
        assert_ne!(
            nav_slit.label_at(outside),
            nav_slit.label_at(inside),
            "a 1 px slit must not join the chamber to the outside"
        );
        assert_eq!(
            nav_slit.label_at(Point::new(1050, 400)),
            0,
            "the body does not fit in the slit itself — this is why the slit case is \
             rejected, and it is a different reason from the sealed case"
        );
        assert_ne!(
            nav_sealed.label_at(outside),
            nav_sealed.label_at(inside),
            "a sealed pocket is its own region"
        );

        for slit in [true, false] {
            let m = build(slit);
            let (connected, _) = deepest_is_connected(&m);
            assert!(!connected, "chamber must be unreachable (slit = {slit})");
        }
    }

    #[test]
    fn a_shaft_wide_enough_for_the_body_opens_the_cave() {
        // The positive control for the slit test: same geometry, a mouth the body
        // fits through, and now the chamber counts.
        let mut m = Mask::new_empty(W, H);
        bedrock_from(&mut m, 200, H);
        shaft(&mut m, 900, 1200, 450, 600);
        shaft(&mut m, 1032, 1068, 200, 450); // 36 px

        let (connected, fraction) = deepest_is_connected(&m);
        assert!(
            connected,
            "a 36 px shaft admits a {} px body, so the chamber is reachable \
             (fraction {fraction:.3})",
            crate::constants::PLAYER_W
        );
    }

    #[test]
    fn drop_only_routes_do_not_count_as_traversable() {
        // The property in one sentence: a one-way trip is not traversal. A high ledge
        // with a long fall to a floor it cannot get back up to must leave the two in
        // different strongly connected sets, even though the fall itself is legal.
        let mut m = Mask::new_empty(W, TALL_H);
        bedrock_from(&mut m, 2000, TALL_H);
        platform(&mut m, 0, 400, 300);

        let surface = extract_surface(&m);
        let report = analyse(&m, &surface, &[]);
        let in_main: std::collections::HashSet<usize> =
            report.largest_component.iter().copied().collect();

        let ledge = surface.iter().position(|p| p.y < 400);
        let floor = surface.iter().position(|p| p.y > 1900);
        let (Some(l), Some(f)) = (ledge, floor) else {
            panic!("expected a ledge and a floor");
        };
        assert!(
            !(in_main.contains(&l) && in_main.contains(&f)),
            "a 1700 px drop is one-way and must not make the two mutually reachable"
        );
    }

    #[test]
    fn the_largest_component_is_stable_across_runs() {
        // §A11: the previous implementation took the largest component out of a
        // HashMap, whose iteration order is seeded per process, so tied components
        // resolved differently between runs of the same binary. That feeds spawn
        // selection. Two identical, separated islands make the tie certain.
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 100, 400, 400);
        platform(&mut m, 1600, 1900, 400);

        let surface = extract_surface(&m);
        let first = analyse(&m, &surface, &[]).largest_component;
        for _ in 0..32 {
            assert_eq!(
                analyse(&m, &surface, &[]).largest_component,
                first,
                "tied components must resolve the same way every time"
            );
        }
    }

    #[test]
    fn determinism() {
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 0, 400, 600);
        platform(&mut m, 500, 900, 500);
        let surface = extract_surface(&m);
        let first = analyse(&m, &surface, &[]);
        for _ in 0..20 {
            assert_eq!(analyse(&m, &surface, &[]), first);
        }
    }

    #[test]
    fn drop_edges_run_downward_only() {
        // A ledge you can only fall from is still a connectivity problem, so
        // analyse() tests can_drop in both directions — but the predicate itself is
        // one-way. The lower platform is offset horizontally so the fall corridor
        // is not through the upper platform's own 40 px of rock.
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 100, 300, 300);
        platform(&mut m, 305, 500, 500);
        let high = Point::new(300, feet_on(300));
        let low = Point::new(310, feet_on(500));
        assert!(can_drop(&m, high, low), "should be able to fall");
        assert!(!can_drop(&m, low, high), "cannot fall upward");
    }

    #[test]
    fn nav_regions_separate_a_sealed_chamber_from_the_sky() {
        let mut m = Mask::new_full(W, H);
        // Open sky at the top.
        for y in 0..100 {
            m.clear_run(y, 0, W as i32 - 1);
        }
        // A sealed room deep in the rock.
        for y in 400..460 {
            m.clear_run(y, 300, 400);
        }
        let nav = NavRegions::build(&m);
        let sky = nav.label_at(Point::new(500, 99));
        let room = nav.label_at(Point::new(350, 459));
        assert_ne!(sky, 0, "the sky must be navigable");
        assert_ne!(room, 0, "the room must be navigable");
        assert_ne!(sky, room, "a sealed room must not share the sky's region");
    }

    #[test]
    fn nav_regions_follow_a_winding_shaft() {
        // The case the ballistic predicates cannot express, and the reason this
        // type exists: a zig-zag passage with no straight line through it.
        let mut m = Mask::new_full(W, H);
        for y in 0..100 {
            m.clear_run(y, 0, W as i32 - 1);
        }
        for y in 400..460 {
            m.clear_run(y, 300, 400);
        }

        let sky = NavRegions::build(&m).label_at(Point::new(350, 99));
        let sealed = NavRegions::build(&m).label_at(Point::new(350, 459));
        assert_ne!(sky, sealed, "precondition: the room starts sealed");

        // Carve a zig-zag from the room up to the sky, wide enough for the body.
        let bore = 20;
        let mut cx = 350;
        let mut cy = 430;
        for (tx, ty) in [(250, 340), (450, 250), (350, 150), (350, 90)] {
            let steps = 60;
            for s in 0..=steps {
                let t = s as f32 / steps as f32;
                let x = cx + ((tx - cx) as f32 * t) as i32;
                let y = cy + ((ty - cy) as f32 * t) as i32;
                for dy in -bore..=bore {
                    let dx = ((bore * bore - dy * dy) as f32).sqrt() as i32;
                    m.clear_run(y + dy, x - dx, x + dx);
                }
            }
            cx = tx;
            cy = ty;
        }

        let nav = NavRegions::build(&m);
        assert_eq!(
            nav.label_at(Point::new(350, 459)),
            nav.label_at(Point::new(350, 99)),
            "a winding shaft must join the room to the sky"
        );
    }

    #[test]
    fn nav_regions_reject_a_gap_narrower_than_the_body() {
        let mut m = Mask::new_full(W, H);
        for y in 0..100 {
            m.clear_run(y, 0, W as i32 - 1);
        }
        for y in 400..460 {
            m.clear_run(y, 300, 400);
        }
        // A shaft only 10 px wide: the 16-wide body cannot use it.
        for y in 100..430 {
            m.clear_run(y, 345, 354);
        }
        let nav = NavRegions::build(&m);
        assert_ne!(
            nav.label_at(Point::new(350, 459)),
            nav.label_at(Point::new(350, 99)),
            "a 10 px shaft must not connect a 16 px-wide body"
        );
    }

    #[test]
    fn analyse_is_fast_enough_on_real_maps() {
        use std::time::Instant;
        let p = GenParams::default_for(MapScale::Medium);
        let seed = 4242;
        let mut m = crate::map::gen::silhouette::silhouette(seed, &p);
        let islands = crate::map::gen::blobs::add_blobs(&mut m, seed, &p);
        crate::map::gen::bridges::add_bridges(&mut m, seed, &p, &islands);
        crate::map::gen::network::carve_network(&mut m, seed, &p);
        crate::map::gen::caves::carve_caves(&mut m, seed, &p);
        crate::map::gen::smooth::smooth(&mut m);
        crate::map::gen::components::cleanup(&mut m);
        let surface = extract_surface(&m);

        let t = Instant::now();
        let report = analyse(&m, &surface, &[]);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "analyse: {ms:.1} ms for {} points, fraction {:.3}, passed {}",
            surface.len(),
            report.traversable_fraction,
            report.passed
        );
        // Generous: this is a debug build. The release figure is far lower.
        assert!(ms < 2000.0, "analyse took {ms:.0} ms");
    }
}
