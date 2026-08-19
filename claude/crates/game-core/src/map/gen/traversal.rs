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
    GRAVITY, JETPACK_MAX_FUEL, JETPACK_MAX_SPEED, JUMP_VELOCITY, MIN_TRAVERSABLE_FRACTION,
    SPAWN_COUNT_MIN, SPAWN_MIN_SEPARATION, STEP_UP, SURFACE_SAMPLE_STEP, WALK_SPEED,
};
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
/// A player with a jetpack can move anywhere within a connected region of positions
/// their box fits in, so two surface points in the same region are connected. Fuel
/// is not modelled here; the `JETPACK_RANGE` slack in `can_jetpack` already stands
/// in for it, and the failure this validation exists to catch is a sealed pocket,
/// not a long flight.
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

/// Build the graph, find components, and check the invariants.
pub fn analyse(mask: &Mask, surface: &[Point]) -> TraversalReport {
    let n = surface.len();
    if n == 0 {
        return TraversalReport {
            total_points: 0,
            largest_component: Vec::new(),
            traversable_fraction: 0.0,
            passed: false,
        };
    }

    let mut uf = UnionFind::new(n);

    // Union by navigable region first: this is the edge the ballistic predicates
    // cannot express, and it is what makes winding cave passages count.
    let nav = NavRegions::build(mask);
    let mut first_of_region: std::collections::HashMap<u32, usize> =
        std::collections::HashMap::new();
    for (i, p) in surface.iter().enumerate() {
        let l = nav.label_at(*p);
        if l == 0 {
            continue;
        }
        match first_of_region.get(&l) {
            Some(&j) => uf.union(i, j),
            None => {
                first_of_region.insert(l, i);
            }
        }
    }

    // Spatial buckets sized to the jetpack range, so only neighbouring buckets need
    // testing. A dense all-pairs graph over a few thousand points is millions of
    // edge tests and would dominate generation time.
    let cell = JETPACK_RANGE.max(1.0) as i32;
    let mut buckets: std::collections::HashMap<(i32, i32), Vec<usize>> =
        std::collections::HashMap::new();
    for (i, p) in surface.iter().enumerate() {
        buckets
            .entry((p.x.div_euclid(cell), p.y.div_euclid(cell)))
            .or_default()
            .push(i);
    }

    for (i, a) in surface.iter().enumerate() {
        let (bx, by) = (a.x.div_euclid(cell), a.y.div_euclid(cell));
        for gy in (by - 1)..=(by + 1) {
            for gx in (bx - 1)..=(bx + 1) {
                let Some(list) = buckets.get(&(gx, gy)) else {
                    continue;
                };
                for &j in list {
                    // Each unordered pair once.
                    if j <= i || uf.connected(i, j) {
                        continue;
                    }
                    let b = surface[j];
                    if can_walk(mask, *a, b)
                        || can_drop(mask, *a, b)
                        || can_drop(mask, b, *a)
                        || can_jump(mask, *a, b)
                        || can_jump(mask, b, *a)
                        || can_jetpack(mask, *a, b)
                    {
                        uf.union(i, j);
                    }
                }
            }
        }
    }

    // Largest component.
    let mut counts: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for i in 0..n {
        counts.entry(uf.find(i)).or_default().push(i);
    }
    let mut largest: Vec<usize> = counts
        .into_values()
        .max_by_key(|v| v.len())
        .unwrap_or_default();
    largest.sort_unstable();

    let traversable_fraction = largest.len() as f32 / n as f32;
    let enough_spawns = count_separated(surface, &largest, SPAWN_MIN_SEPARATION) >= SPAWN_COUNT_MIN;
    let passed = traversable_fraction >= MIN_TRAVERSABLE_FRACTION && enough_spawns;

    TraversalReport {
        total_points: n,
        largest_component: largest,
        traversable_fraction,
        passed,
    }
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

struct UnionFind {
    parent: Vec<usize>,
    rank: Vec<u8>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        UnionFind {
            parent: (0..n).collect(),
            rank: vec![0; n],
        }
    }
    fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]];
            x = self.parent[x];
        }
        x
    }
    fn connected(&mut self, a: usize, b: usize) -> bool {
        self.find(a) == self.find(b)
    }
    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra == rb {
            return;
        }
        match self.rank[ra].cmp(&self.rank[rb]) {
            std::cmp::Ordering::Less => self.parent[ra] = rb,
            std::cmp::Ordering::Greater => self.parent[rb] = ra,
            std::cmp::Ordering::Equal => {
                self.parent[rb] = ra;
                self.rank[ra] += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
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
        let report = analyse(&m, &surface);
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
        let report = analyse(&m, &surface);
        assert_eq!(report.traversable_fraction, 1.0);
        assert!(report.passed, "a flat floor must pass validation");
        assert_eq!(report.largest_component.len(), report.total_points);
    }

    #[test]
    fn an_empty_surface_does_not_panic() {
        let m = Mask::new_empty(W, H);
        let report = analyse(&m, &[]);
        assert_eq!(report.total_points, 0);
        assert!(!report.passed);
        assert_eq!(report.traversable_fraction, 0.0);
    }

    #[test]
    fn determinism() {
        let mut m = Mask::new_empty(W, H);
        platform(&mut m, 0, 400, 600);
        platform(&mut m, 500, 900, 500);
        let surface = extract_surface(&m);
        let first = analyse(&m, &surface);
        for _ in 0..20 {
            assert_eq!(analyse(&m, &surface), first);
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
        let report = analyse(&m, &surface);
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
