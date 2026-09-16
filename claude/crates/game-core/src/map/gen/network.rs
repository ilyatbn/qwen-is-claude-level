//! Pass 4 (v2): the cave network — chambers, loops and surface entrances.
//!
//! Caves are no longer independent worms. They form an **ant farm**: chambers
//! joined by tunnels, with loops so there is more than one way round, and with
//! several mouths open to the sky so you can fall in or climb out.
//!
//! The property that makes this a feature rather than decoration is that a player
//! can get in and out. `carve_network` guarantees it structurally: every chamber is
//! in one spanning tree, and at least `CAVE_ENTRANCES_MIN` chambers have a shaft
//! that reaches open sky. The test asserts it by flood-filling air from the sky and
//! requiring every chamber centre to be reached.
//!
//! See `docs/70-amendments-v2.md` §A2 Pass 4.

use crate::constants::{
    CAVE_ENTRANCES_MAX, CAVE_ENTRANCES_MIN, CAVE_EXTRA_EDGE_FRACTION, CAVE_FLOOR_KEEPOUT,
    CHAMBER_MIN_SEPARATION, CHAMBER_RADIUS_MAX, CHAMBER_RADIUS_MIN, ENTRANCE_RADIUS, SKY_MARGIN,
    TUNNEL_RADIUS_MAX, TUNNEL_RADIUS_MIN, TUNNEL_STEP, WALL_W,
};
use crate::map::gen::caves::{is_buried, walk_to};
use crate::map::gen::silhouette::{force_borders, GenParams};
use crate::map::shape::{stamp_capsule, stamp_circle};
use crate::map::Mask;
use crate::math::Point;
use crate::rng::{range_i32, substream, ChaCha8Rng};

/// Solid rock required around a chamber centre for it to count as buried.
const CHAMBER_CLEARANCE: i32 = 40;

/// A chamber must sit at least this far below the sky margin, so an entrance shaft
/// is a shaft rather than a dent in the surface.
const CHAMBER_TOP_INSET: i32 = 120;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CaveNetwork {
    pub chambers: Vec<Point>,
    pub edges: Vec<(usize, usize)>,
    /// Indices into `chambers` that have a shaft to the surface.
    pub entrances: Vec<usize>,
    /// Every stamped centre, for buried-slot placement in T1.13.
    pub paths: Vec<Vec<Point>>,
}

/// Chambers, a spanning tree, loop edges, and shafts to the sky.
pub fn carve_network(mask: &mut Mask, seed: u64, params: &GenParams) -> CaveNetwork {
    let mut rng = substream(seed, "chambers");
    let mut net = CaveNetwork::default();

    if params.cave_chambers == 0 {
        force_borders(mask);
        return net;
    }

    // ---- 1. Chambers ----------------------------------------------------
    net.chambers = place_chambers(mask, &mut rng, params.cave_chambers);
    if net.chambers.is_empty() {
        force_borders(mask);
        return net;
    }

    for &c in &net.chambers {
        // A cluster of 2–4 circles, so a chamber is a room rather than a bubble.
        let count = range_i32(&mut rng, 2, 4);
        for _ in 0..count {
            let r = range_i32(&mut rng, CHAMBER_RADIUS_MIN, CHAMBER_RADIUS_MAX);
            let jitter = CHAMBER_RADIUS_MIN / 2;
            let dx = range_i32(&mut rng, -jitter, jitter);
            let dy = range_i32(&mut rng, -jitter, jitter);
            stamp_circle(mask, c.x + dx, c.y + dy, r, false);
        }
    }

    // ---- 2. Spanning tree ------------------------------------------------
    net.edges = spanning_tree(&net.chambers);

    // ---- 3. Loop edges ---------------------------------------------------
    // Loops are what make a cave system escapable rather than a dead-end maze.
    let extra = ((net.chambers.len() as f32 * CAVE_EXTRA_EDGE_FRACTION).round()) as usize;
    net.edges
        .extend(extra_edges(&net.chambers, &net.edges, extra));

    // ---- 4. Tunnels ------------------------------------------------------
    for &(a, b) in &net.edges {
        let (from, to) = (net.chambers[a], net.chambers[b]);
        let direct = (from.distance_sq(to) as f64).sqrt();
        // Generous: the walk wanders, so it covers more ground than the straight
        // line. Three times the direct distance always suffices in practice.
        let max_steps = ((direct * 3.0) / TUNNEL_STEP as f64).ceil() as usize + 8;
        let path = walk_to(
            mask,
            &mut rng,
            from,
            to,
            TUNNEL_RADIUS_MIN,
            TUNNEL_RADIUS_MAX,
            max_steps,
        );
        net.paths.push(path);
    }

    // ---- 5. Entrances ----------------------------------------------------
    let wanted = range_i32(
        &mut rng,
        CAVE_ENTRANCES_MIN as i32,
        CAVE_ENTRANCES_MAX as i32,
    ) as usize;
    let wanted = wanted.min(net.chambers.len());

    // Spread the entrances across distinct chambers, preferring the shallowest —
    // a shaft from a deep chamber is a long climb and often crosses another
    // chamber on the way.
    let mut by_depth: Vec<usize> = (0..net.chambers.len()).collect();
    by_depth.sort_by_key(|&i| (net.chambers[i].y, net.chambers[i].x));

    for &i in by_depth.iter().take(wanted) {
        let c = net.chambers[i];
        let jitter = range_i32(&mut rng, -40, 40);
        let target = Point::new(
            (c.x + jitter).clamp(
                WALL_W as i32 + ENTRANCE_RADIUS + 1,
                mask.w as i32 - WALL_W as i32 - ENTRANCE_RADIUS - 1,
            ),
            SKY_MARGIN as i32,
        );
        let max_steps = ((c.y - SKY_MARGIN as i32).max(1) * 3 / TUNNEL_STEP) as usize + 8;
        let mut path = walk_to(
            mask,
            &mut rng,
            c,
            target,
            ENTRANCE_RADIUS,
            ENTRANCE_RADIUS,
            max_steps,
        );

        // The walk stops within a radius of its target, which may leave the last
        // few pixels of rock in place. An entrance that does not actually open is
        // not an entrance, so finish the junction explicitly.
        if let Some(&last) = path.last() {
            if last.y > SKY_MARGIN as i32 {
                stamp_capsule(
                    mask,
                    last.x,
                    last.y,
                    last.x,
                    SKY_MARGIN as i32 - 1,
                    ENTRANCE_RADIUS,
                    false,
                );
                path.push(Point::new(last.x, SKY_MARGIN as i32 - 1));
            }
        }

        net.paths.push(path);
        net.entrances.push(i);
    }

    force_borders(mask);
    net
}

/// Rejection-sample chamber centres inside solid rock, respecting separation.
fn place_chambers(mask: &Mask, rng: &mut ChaCha8Rng, want: u32) -> Vec<Point> {
    let (w, h) = (mask.w as i32, mask.h as i32);
    let y_lo = SKY_MARGIN as i32 + CHAMBER_TOP_INSET;
    let y_hi = h - CAVE_FLOOR_KEEPOUT as i32 - CHAMBER_CLEARANCE;
    if y_hi <= y_lo {
        return Vec::new();
    }

    let min_sep_sq = (CHAMBER_MIN_SEPARATION as i64).pow(2);
    let mut chambers: Vec<Point> = Vec::with_capacity(want as usize);

    for _ in 0..want {
        for _ in 0..200 {
            let p = Point::new(
                range_i32(
                    rng,
                    WALL_W as i32 + CHAMBER_CLEARANCE,
                    w - WALL_W as i32 - CHAMBER_CLEARANCE,
                ),
                range_i32(rng, y_lo, y_hi),
            );
            if !is_buried(mask, p, CHAMBER_CLEARANCE) {
                continue;
            }
            if chambers.iter().any(|o| p.distance_sq(*o) < min_sep_sq) {
                continue;
            }
            chambers.push(p);
            break;
        }
    }
    chambers
}

/// Prim's over Euclidean distance. Ties break by lower index, so the result is
/// deterministic without ever comparing floats.
fn spanning_tree(chambers: &[Point]) -> Vec<(usize, usize)> {
    let n = chambers.len();
    let mut edges = Vec::with_capacity(n.saturating_sub(1));
    if n < 2 {
        return edges;
    }

    let mut in_tree = vec![false; n];
    in_tree[0] = true;
    let mut count = 1;

    while count < n {
        let mut best: Option<(i64, usize, usize)> = None;
        for (i, inside) in in_tree.iter().enumerate() {
            if !inside {
                continue;
            }
            for (j, outside) in in_tree.iter().enumerate() {
                if *outside {
                    continue;
                }
                let d = chambers[i].distance_sq(chambers[j]);
                // Strictly-less keeps the first (lowest-index) pair on a tie.
                if best.is_none_or(|(bd, _, _)| d < bd) {
                    best = Some((d, i, j));
                }
            }
        }
        let Some((_, i, j)) = best else { break };
        in_tree[j] = true;
        edges.push((i, j));
        count += 1;
    }

    edges
}

/// The `want` shortest pairs that are not already edges.
fn extra_edges(
    chambers: &[Point],
    existing: &[(usize, usize)],
    want: usize,
) -> Vec<(usize, usize)> {
    if want == 0 || chambers.len() < 3 {
        return Vec::new();
    }
    let has = |a: usize, b: usize| {
        existing
            .iter()
            .any(|&(x, y)| (x == a && y == b) || (x == b && y == a))
    };

    let mut candidates: Vec<(i64, usize, usize)> = Vec::new();
    for i in 0..chambers.len() {
        for j in (i + 1)..chambers.len() {
            if has(i, j) {
                continue;
            }
            candidates.push((chambers[i].distance_sq(chambers[j]), i, j));
        }
    }
    // Distance first, then indices: a total order, so no tie is resolved by
    // whatever order the pairs happened to be pushed in.
    candidates.sort_unstable();
    candidates
        .into_iter()
        .take(want)
        .map(|(_, i, j)| (i, j))
        .collect()
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

    /// Flood the positions a **player body** can occupy, from the sky inward.
    ///
    /// Indexed by the body's centre-bottom pixel, exactly like a surface point. A
    /// position is enterable when the whole `PLAYER_W × PLAYER_H` box at it is air.
    ///
    /// This is deliberately not a 1-px flood. A 1-px flood certifies that *water*
    /// could reach a chamber, which is not a claim anyone can play: at the old
    /// tunnel radii it reported 100% chamber reachability while a real body reached
    /// 76%. See docs/70-amendments-v2.md §A9.
    fn body_reachable_from_sky(mask: &Mask) -> Vec<bool> {
        let (w, h) = (mask.w as i32, mask.h as i32);
        let half = (crate::constants::PLAYER_W as i32) / 2;
        let body_h = crate::constants::PLAYER_H as i32;

        let fits = |x: i32, y: i32| -> bool {
            if x - half < 0 || x + half > w || y - body_h + 1 < 0 || y >= h {
                return false;
            }
            for by in (y - body_h + 1)..=y {
                if mask.count_run(by, x - half, x + half - 1) != 0 {
                    return false;
                }
            }
            true
        };

        let mut seen = vec![false; (w * h) as usize];
        let mut stack = Vec::new();

        // Sources: every body position along the bottom of the sky band.
        for x in 0..w {
            let y = crate::constants::SKY_MARGIN as i32 - 1;
            if fits(x, y) {
                seen[(y * w + x) as usize] = true;
                stack.push(Point::new(x, y));
            }
        }

        while let Some(p) = stack.pop() {
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (p.x + dx, p.y + dy);
                if nx < 0 || ny < 0 || nx >= w || ny >= h {
                    continue;
                }
                let idx = (ny * w + nx) as usize;
                if seen[idx] || !fits(nx, ny) {
                    continue;
                }
                seen[idx] = true;
                stack.push(Point::new(nx, ny));
            }
        }
        seen
    }

    /// A chamber counts as reached if a body can stand anywhere inside it. The
    /// centre pixel itself may be too close to the floor for the box to fit, which
    /// says nothing about whether the room is usable.
    fn body_can_reach_near(reachable: &[bool], mask: &Mask, c: Point) -> bool {
        let w = mask.w as i32;
        let r = CHAMBER_RADIUS_MAX;
        for dy in -r..=r {
            for dx in -r..=r {
                let (x, y) = (c.x + dx, c.y + dy);
                if x < 0 || y < 0 || x >= w || y >= mask.h as i32 {
                    continue;
                }
                if reachable[(y * w + x) as usize] {
                    return true;
                }
            }
        }
        false
    }

    #[test]
    fn determinism() {
        let p = params();
        let base = silhouette(4242, &p);
        let mut first = base.clone();
        let net = carve_network(&mut first, 4242, &p);
        let hash = first.hash();
        for _ in 0..20 {
            let mut m = base.clone();
            let n = carve_network(&mut m, 4242, &p);
            assert_eq!(m.hash(), hash);
            assert_eq!(n, net);
        }
    }

    #[test]
    fn network_only_removes_solid() {
        let p = params();
        let mut m = silhouette(7, &p);
        let before = m.count_solid();
        carve_network(&mut m, 7, &p);
        assert!(m.count_solid() <= before, "carve_network added solid");
    }

    #[test]
    fn zero_chambers_leaves_the_mask_unchanged() {
        let mut p = params();
        p.cave_chambers = 0;
        let mut m = silhouette(7, &p);
        let before = m.hash();
        let net = carve_network(&mut m, 7, &p);
        assert_eq!(net, CaveNetwork::default());
        assert_eq!(m.hash(), before);
    }

    #[test]
    fn edges_form_a_spanning_tree() {
        let p = GenParams::default_for(MapScale::Large);
        let mut m = solid_map(&p);
        let net = carve_network(&mut m, 555, &p);
        assert!(
            net.chambers.len() >= 2,
            "need chambers to test connectivity"
        );

        // Union-find over the edges: every chamber must end in one set.
        let n = net.chambers.len();
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(parent: &mut [usize], mut x: usize) -> usize {
            while parent[x] != x {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            x
        }
        for &(a, b) in &net.edges {
            let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
            parent[ra] = rb;
        }
        let root = find(&mut parent, 0);
        for i in 0..n {
            assert_eq!(find(&mut parent, i), root, "chamber {i} is not connected");
        }
    }

    #[test]
    fn edge_count_matches_tree_plus_loops() {
        let p = GenParams::default_for(MapScale::Large);
        let mut m = solid_map(&p);
        let net = carve_network(&mut m, 909, &p);
        let n = net.chambers.len();
        assert!(n >= 2);

        let expected_extra = ((n as f32 * CAVE_EXTRA_EDGE_FRACTION).round()) as usize;
        let max_pairs = n * (n - 1) / 2;
        let expected = (n - 1 + expected_extra).min(max_pairs);
        assert_eq!(net.edges.len(), expected, "chambers = {n}");

        // No duplicate and no self edges.
        for (i, &(a, b)) in net.edges.iter().enumerate() {
            assert_ne!(a, b, "self edge at {i}");
            for &(c, d) in &net.edges[i + 1..] {
                assert!(
                    !((a == c && b == d) || (a == d && b == c)),
                    "duplicate edge ({a},{b})"
                );
            }
        }
    }

    #[test]
    fn loops_actually_exist() {
        // A tree has n-1 edges; more than that means there is a cycle, which is
        // what makes a cave system readable rather than a dead-end maze.
        let p = GenParams::default_for(MapScale::Large);
        let mut m = solid_map(&p);
        let net = carve_network(&mut m, 1234, &p);
        assert!(
            net.edges.len() > net.chambers.len().saturating_sub(1),
            "no loop edges: {} edges for {} chambers",
            net.edges.len(),
            net.chambers.len()
        );
    }

    #[test]
    fn entrance_count_is_in_range() {
        let p = GenParams::default_for(MapScale::Large);
        for seed in 0..10 {
            let mut m = solid_map(&p);
            let net = carve_network(&mut m, seed, &p);
            assert!(net.chambers.len() >= CAVE_ENTRANCES_MAX as usize);
            assert!(
                (CAVE_ENTRANCES_MIN as usize..=CAVE_ENTRANCES_MAX as usize)
                    .contains(&net.entrances.len()),
                "seed {seed}: {} entrances",
                net.entrances.len()
            );
            // Distinct chambers.
            let mut sorted = net.entrances.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), net.entrances.len(), "duplicate entrance");
        }
    }

    /// **The point of the whole task.** If this fails the caves are decorative.
    #[test]
    fn every_chamber_is_reachable_from_the_sky() {
        let p = params();
        for seed in 0..20 {
            let mut m = solid_map(&p);
            let net = carve_network(&mut m, seed, &p);
            assert!(!net.chambers.is_empty(), "seed {seed}: no chambers placed");

            let reachable = body_reachable_from_sky(&m);
            for (i, c) in net.chambers.iter().enumerate() {
                assert!(
                    !m.get(c.x, c.y),
                    "seed {seed}: chamber {i} centre {c:?} is still solid"
                );
                assert!(
                    body_can_reach_near(&reachable, &m, *c),
                    "seed {seed}: chamber {i} at {c:?} cannot be reached by a \
                     16x28 body from the sky"
                );
            }
        }
    }

    #[test]
    fn every_chamber_is_reachable_at_large_scale_too() {
        let p = GenParams::default_for(MapScale::Large);
        for seed in 0..4 {
            let mut m = solid_map(&p);
            let net = carve_network(&mut m, seed * 31 + 7, &p);
            let reachable = body_reachable_from_sky(&m);
            for (i, c) in net.chambers.iter().enumerate() {
                assert!(
                    body_can_reach_near(&reachable, &m, *c),
                    "seed {seed}: chamber {i} at {c:?} not body-reachable"
                );
            }
        }
    }

    #[test]
    fn an_entrance_shaft_reaches_open_sky() {
        let p = GenParams::default_for(MapScale::Large);
        let mut m = solid_map(&p);
        let net = carve_network(&mut m, 4242, &p);
        assert!(!net.entrances.is_empty());

        let reachable = body_reachable_from_sky(&m);
        // At least one entrance chamber must be body-reachable from the sky, which
        // is the only sense in which a shaft is an entrance.
        let found = net
            .entrances
            .iter()
            .any(|&i| body_can_reach_near(&reachable, &m, net.chambers[i]));
        assert!(found, "no entrance shaft admits a player body");
    }

    #[test]
    fn borders_hold_and_bedrock_is_intact() {
        let p = params();
        for seed in 0..8 {
            let mut m = silhouette(seed, &p);
            carve_network(&mut m, seed, &p);
            assert!(borders_hold(&m), "seed {seed}");
        }
    }

    #[test]
    fn chambers_respect_separation_and_depth() {
        let p = GenParams::default_for(MapScale::Large);
        let mut m = solid_map(&p);
        let net = carve_network(&mut m, 31337, &p);
        let min_sq = (CHAMBER_MIN_SEPARATION as i64).pow(2);
        for (i, a) in net.chambers.iter().enumerate() {
            assert!(
                a.y >= SKY_MARGIN as i32 + CHAMBER_TOP_INSET,
                "chamber {i} at {a:?} is too shallow"
            );
            assert!(
                a.y <= m.h as i32 - CAVE_FLOOR_KEEPOUT as i32 - CHAMBER_CLEARANCE,
                "chamber {i} at {a:?} is in the bedrock"
            );
            for b in &net.chambers[i + 1..] {
                assert!(
                    a.distance_sq(*b) >= min_sq,
                    "chambers {a:?} and {b:?} are too close"
                );
            }
        }
    }

    #[test]
    fn spanning_tree_is_deterministic_for_equidistant_points() {
        // Ties must break by index, or the same seed could produce two different
        // networks on two runs.
        let pts = vec![
            Point::new(0, 0),
            Point::new(100, 0),
            Point::new(0, 100),
            Point::new(100, 100),
        ];
        let first = spanning_tree(&pts);
        for _ in 0..50 {
            assert_eq!(spanning_tree(&pts), first);
        }
        assert_eq!(first.len(), 3);
    }

    #[test]
    fn degenerate_chamber_counts_do_not_panic() {
        assert!(spanning_tree(&[]).is_empty());
        assert!(spanning_tree(&[Point::new(1, 1)]).is_empty());
        assert!(extra_edges(&[Point::new(1, 1)], &[], 5).is_empty());
        assert!(extra_edges(&[], &[], 0).is_empty());
    }
}
