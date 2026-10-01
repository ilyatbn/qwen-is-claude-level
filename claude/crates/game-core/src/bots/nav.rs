//! T23.26 A — a route planner over the live terrain (`docs/78` §A2).
//!
//! The walking model steers greedily at a point, so a wall taller than a hop, a cave
//! whose way out is behind the bot, or a target over a ridge all ended in pressing
//! into rock. This plans a route instead: **walk, hop, fall, jetpack and dig**, each
//! priced in seconds from the movement and tool constants, so "jet over it", "dig
//! through it" and "go round" are one comparison rather than three special cases.
//!
//! - **The grid** is `BOT_NAV_CELL` (= `PLAYER_W`, 16 px) cells, read on demand from the
//!   map's exact coarse grid (four 8 px counts a cell) — nothing is cached per bot, so
//!   a carve is seen the next time a cell is read. A cell is **air** when at most
//!   `BOT_NAV_AIR_PX` of its pixels are rock, **rock** otherwise, and **hard** (never
//!   dug) where the carve itself refuses: the side walls, a pad's or a platform's
//!   footing, and the bottom `PLAYER_H` of the map (there is no bedrock, so digging
//!   down there opens the void).
//! - **A node** is where a body can be: its feet cell and the cell above are air (two
//!   cells, 32 px, hold a 28 px body). It *stands* when the cell below is rock or hard.
//! - **The search** is A* with the jetpack's fuel as a second dimension (bucketed by
//!   `BOT_NAV_FUEL_STEP`), so a climb the tank cannot make is not a route and a route
//!   may stop on a ledge to refuel. Its work is a **node count** per call — never a
//!   clock, which would make a replay think differently from the round it records —
//!   and a search resumes where it stopped on the next tick.
//! - **Order** is total: the open set is keyed on `(f in ms, state key)`, so equal
//!   costs never tie on anything but an integer, and the visited table is only ever
//!   looked up, never iterated.
//!
//! Space is out of scope (`space::flies` replaces the walking model's buttons
//! wholesale there), and so are wings (their own sweep, T22.03F).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::hash::{BuildHasherDefault, Hasher};

use crate::constants::{
    BOT_LOS_STEP, BOT_NAV_AIR_PX, BOT_NAV_CELL, BOT_NAV_DIG_S, BOT_NAV_FLOOR_BAND,
    BOT_NAV_FUEL_STEP, BOT_NAV_HOP_ROWS, COARSE_CELL, GRAVITY, JETPACK_DRAIN, JETPACK_HOLD_DELAY,
    JETPACK_MAX_FUEL, JETPACK_MAX_SPEED, JETPACK_MIN_FUEL_TO_ENGAGE, JETPACK_REFILL,
    JETPACK_REFILL_DELAY, JUMP_VELOCITY, PLAYER_H, TELEPORT_CHARGE, TELEPORT_COOLDOWN, WALK_SPEED,
    WALL_W,
};
use crate::map::Map;
use crate::math::Vec2;

/// A nav cell is exactly a 2×2 block of coarse cells, so its rock count is four exact
/// reads and never a pixel walk.
const _: () = assert!(BOT_NAV_CELL as u32 == 2 * COARSE_CELL);
const CELL: i32 = BOT_NAV_CELL as i32;

/// Seconds to walk one cell.
pub(super) const WALK_S: f32 = BOT_NAV_CELL / WALK_SPEED;
/// Seconds to jet one cell at the pack's top speed.
pub(super) const JET_S: f32 = BOT_NAV_CELL / JETPACK_MAX_SPEED;
const SQRT2: f32 = std::f32::consts::SQRT_2;

/// Seconds to fall one cell: one cell at the speed a one-cell drop lands with,
/// `sqrt(2 g h)` — under the real fall time of the first cell and over every later
/// one, which is what keeps a long drop's price near its truth without a per-height
/// table.
pub(super) fn fall_s() -> f32 {
    BOT_NAV_CELL / (2.0 * GRAVITY * BOT_NAV_CELL).sqrt()
}

/// Seconds a jump takes to rise `h` px: `(v - sqrt(v² - 2gh)) / g`. A hop is priced
/// as its rise plus a cell's walk, which is why a kerb never costs a jet.
pub(super) fn rise_s(h: f32) -> f32 {
    let v = JUMP_VELOCITY;
    let d = (v * v - 2.0 * GRAVITY * h).max(0.0);
    (v - d.sqrt()) / GRAVITY
}

/// The cheapest any one-cell move can be — the heuristic's unit, so it never
/// over-estimates (admissible): every edge below moves at most one cell per this.
fn cheapest_cell_s() -> f32 {
    JET_S.min(WALK_S).min(fall_s())
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(super) enum Cell {
    Air,
    Rock,
    /// Rock the carve refuses: never a dig.
    Hard,
}

/// How a step is made. The follower turns each into buttons.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub(super) enum Move {
    #[default]
    Start,
    Walk,
    Hop,
    Fall,
    Jet,
    /// Stand on the spot until the tank is full.
    Rest,
    /// Swing at the step's cell until it is air, then move into it.
    Dig,
    /// T23.26C item 4: stand on a teleport pad until it fires, arriving at this step's
    /// node — another pad's (`Search::pads`).
    Teleport,
}

/// One step of a route: arrive at cell `(x, y)` (feet) by `how`.
#[derive(Copy, Clone, Debug, PartialEq)]
pub(super) struct Step {
    pub x: i32,
    pub y: i32,
    pub how: Move,
    /// This step's own price, seconds.
    pub cost: f32,
    /// The tank the plan expects on arrival.
    pub fuel: f32,
}

/// What the search is looking for.
#[derive(Copy, Clone, Debug, PartialEq)]
pub(super) enum Want {
    /// A node within `r` cells (Chebyshev) of `(x, y)`; with `sight`, one with a clear
    /// line to that point as well.
    Near {
        x: i32,
        y: i32,
        r: i32,
        sight: Option<Vec2>,
    },
    /// A standing node with no clear line to `from` (§A2's cover from an enemy).
    Hide { from: Vec2 },
    /// T23.26C item 7: a node a body **stands** on, out of `from`'s line of sight and at
    /// least `beyond` px from it — where a hurt bot runs to before it digs in.
    Away { from: Vec2, beyond: f32 },
}

/// The live terrain as the planner sees it. Borrowed per call, never stored: the map
/// changes under a bot every carve.
pub(super) struct Grid<'a> {
    map: &'a Map,
    pub nx: i32,
    pub ny: i32,
}

impl<'a> Grid<'a> {
    pub fn new(map: &'a Map) -> Self {
        Grid {
            map,
            nx: map.mask.w as i32 / CELL,
            ny: map.mask.h as i32 / CELL,
        }
    }

    /// Rock pixels in cell `(x, y)`: four exact coarse counts.
    fn rock_px(&self, x: i32, y: i32) -> u32 {
        let (cx, cy) = (x as u32 * 2, y as u32 * 2);
        let c = &self.map.coarse;
        c.count_at(cx, cy) as u32
            + c.count_at(cx + 1, cy) as u32
            + c.count_at(cx, cy + 1) as u32
            + c.count_at(cx + 1, cy + 1) as u32
    }

    /// Would the carve refuse every pixel of this cell's dig — or should a bot never ask?
    /// The side walls (`carve.rs` clamps to `WALL_W`), the bottom `BOT_NAV_FLOOR_BAND`
    /// (no bedrock: a hole there is a hole into the void), and the pads' and platforms'
    /// footings (§C5, T21.11).
    fn hard(&self, x: i32, y: i32) -> bool {
        let (w, h) = (self.map.mask.w as i32, self.map.mask.h as i32);
        let (x0, y0) = (x * CELL, y * CELL);
        let (x1, y1) = (x0 + CELL - 1, y0 + CELL - 1);
        if x0 < WALL_W as i32 || x1 >= w - WALL_W as i32 || y1 >= h - BOT_NAV_FLOOR_BAND as i32 {
            return true;
        }
        let meta = &self.map.meta;
        meta.teleport_pads
            .iter()
            .map(|p| p.rect())
            .chain(meta.gun_platforms.iter().map(|g| g.rect()))
            .any(|(px0, py0, px1, py1)| px0 <= x1 && px1 >= x0 && py0 <= y1 && py1 >= y0)
    }

    pub fn cell(&self, x: i32, y: i32) -> Cell {
        // Off the sides or over the top: nothing a route may enter. Below the bottom
        // is the void, and `node` never reaches it.
        if x < 0 || x >= self.nx || y < 0 {
            return Cell::Hard;
        }
        if y >= self.ny {
            return Cell::Air;
        }
        if self.rock_px(x, y) <= BOT_NAV_AIR_PX {
            Cell::Air
        } else if self.hard(x, y) {
            Cell::Hard
        } else {
            Cell::Rock
        }
    }

    fn solid(&self, x: i32, y: i32) -> bool {
        self.cell(x, y) != Cell::Air
    }

    /// A body fits with its feet in `(x, y)`. Never the bottom row: the cell below
    /// it is the void.
    pub fn node(&self, x: i32, y: i32) -> bool {
        y >= 1
            && y + 1 < self.ny
            && self.cell(x, y) == Cell::Air
            && self.cell(x, y - 1) == Cell::Air
    }

    pub fn stands(&self, x: i32, y: i32) -> bool {
        self.node(x, y) && self.solid(x, y + 1)
    }

    /// Would a body at `pos` be over the void — no rock anywhere under its feet before
    /// the map's bottom? The planner's own rule (`floored`), for the walking model's
    /// greedy step to share (T23.26).
    pub fn over_void(&self, pos: Vec2) -> bool {
        let x = (pos.x / BOT_NAV_CELL).floor() as i32;
        let y = ((pos.y + PLAYER_H * 0.5 - 1.0) / BOT_NAV_CELL).floor() as i32;
        x >= 0 && x < self.nx && !self.floored(x, y - 1)
    }

    /// Is there ground somewhere under `(x, y)` before the bottom? A fall into a
    /// column with none is a fall out of the map.
    fn floored(&self, x: i32, y: i32) -> bool {
        ((y + 1)..self.ny).any(|yy| self.solid(x, yy))
    }

    /// Can the node `(x, y)` be dug into — every cell of it air or diggable rock, and
    /// at least one rock? `None` when a cell is hard or it is no node at all.
    fn diggable(&self, x: i32, y: i32) -> Option<bool> {
        if y < 1 || y + 1 >= self.ny {
            return None;
        }
        let (a, b) = (self.cell(x, y), self.cell(x, y - 1));
        if a == Cell::Hard || b == Cell::Hard {
            return None;
        }
        Some(a == Cell::Rock || b == Cell::Rock)
    }

    /// The node a body at `pos` is in: its centre's column, the row of its lowest
    /// pixel — or, when that row is rock (feet sunk into a mixed cell), the nearest
    /// node above or beside it. `None` buried.
    pub fn locate(&self, pos: Vec2) -> Option<(i32, i32)> {
        let x = (pos.x / BOT_NAV_CELL).floor() as i32;
        let y = ((pos.y + PLAYER_H * 0.5 - 1.0) / BOT_NAV_CELL).floor() as i32;
        [(0, 0), (0, -1), (-1, 0), (1, 0), (-1, -1), (1, -1), (0, 1)]
            .into_iter()
            .map(|(dx, dy)| (x + dx, y + dy))
            .find(|&(cx, cy)| self.node(cx, cy))
    }

    /// The pixel centre of a node's body: the feet cell's centre column, the boundary
    /// between its two cells.
    pub fn centre(x: i32, y: i32) -> Vec2 {
        Vec2::new((x * CELL) as f32 + BOT_NAV_CELL * 0.5, (y * CELL) as f32)
    }

    /// No rock sampled on the straight line — what a person can see along.
    pub fn clear(&self, from: Vec2, to: Vec2) -> bool {
        let steps = ((to - from).len() / BOT_LOS_STEP).ceil().max(1.0) as u32;
        (1..steps).all(|i| {
            let p = from + (to - from) * (i as f32 / steps as f32);
            !self.map.mask.get(p.x as i32, p.y as i32)
        })
    }
}

/// A deterministic hasher for the visited table (FxHash's multiply). `std`'s default
/// is seeded from the OS per process, which is ambient randomness `game-core` refuses
/// even where only lookups depend on it.
#[derive(Default)]
struct KeyHasher(u64);
impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0.rotate_left(5) ^ *b as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
    fn write_u64(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

#[derive(Copy, Clone, Debug)]
struct Rec {
    /// The price so far: seconds, plus the refill time of the fuel spent.
    g: f32,
    /// This step's own seconds (what the follower times it against).
    secs: f32,
    fuel: f32,
    parent: u64,
    how: Move,
    closed: bool,
}

const NO_PARENT: u64 = u64::MAX;

fn level(fuel: f32) -> u64 {
    (fuel / BOT_NAV_FUEL_STEP).floor().max(0.0) as u64
}

/// What one call of [`Search::run`] got to.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Progress {
    /// Out of this call's budget; call again.
    Searching,
    /// The route, first step the start.
    Found(Vec<Step>),
    /// Nothing within the bound — no route, or the node cap was hit.
    NoRoute,
}

/// One resumable A*.
pub(super) struct Search {
    want: Want,
    nx: i32,
    open: BinaryHeap<(Reverse<u32>, Reverse<u64>)>,
    seen: HashMap<u64, Rec, BuildHasherDefault<KeyHasher>>,
    /// Per cell, the `(price, fuel)` pairs reached so far that no other beats on both:
    /// a state reached dearer *and* emptier than one already found is not worth
    /// expanding. Without it every fuel bucket of every cell is its own node, and a
    /// detour round a thick wall ran past the node cap (measured: 6001 expansions).
    labels: HashMap<u64, Vec<(f32, f32)>, BuildHasherDefault<KeyHasher>>,
    expanded: u32,
    max_nodes: u32,
    max_cost: f32,
    /// Whether dig edges exist — a body with no digging tool in its bag has none.
    pub dig: bool,
    /// A point the route keeps this far from (px): a hurt bot hiding from an enemy is not
    /// routed past it (T23.26 C).
    pub avoid: Option<(Vec2, f32)>,
    /// `(from, dir)`: only nodes on `dir`'s side of `from` — a run from an enemy never
    /// goes past it (T23.26C: an arc over its head stayed outside `avoid` and ended
    /// behind it, 44 px off).
    pub side: Option<(Vec2, Vec2)>,
    /// T23.26C item 4 (`docs/78` §A3: "teleport gates are routes"): the node standing on
    /// each teleport pad, and what a ride from one to a chosen other costs. A pad sends
    /// you to a **random** other pad (`world::teleport::destination`), so with `n` others
    /// reaching a chosen one takes `n` charges and `n − 1` cooldowns on average — on a
    /// two-pad map one charge, on a six-pad map ~28 s, over `BOT_NAV_COST_MAX`: there a
    /// pad is not a route, which is the truth about a lottery.
    pads: Vec<(i32, i32)>,
    pad_s: f32,
}

impl Search {
    /// From the node a body at `from` is in, holding `fuel`. `None` when the body is
    /// in no node (buried in rock).
    pub fn new(
        map: &Map,
        from: Vec2,
        fuel: f32,
        want: Want,
        max_nodes: u32,
        max_cost: f32,
    ) -> Option<Self> {
        let g = Grid::new(map);
        let (x, y) = g.locate(from)?;
        let mut s = Search {
            want,
            nx: g.nx,
            open: BinaryHeap::new(),
            seen: HashMap::default(),
            labels: HashMap::default(),
            expanded: 0,
            max_nodes,
            max_cost,
            dig: true,
            avoid: None,
            side: None,
            pads: Vec::new(),
            pad_s: 0.0,
        };
        let pads: Vec<(i32, i32)> = map
            .meta
            .teleport_pads
            .iter()
            .filter_map(|p| {
                let centre = Vec2::new(p.pos.x as f32, p.pos.y as f32 - PLAYER_H * 0.5);
                g.locate(centre).filter(|&(x, y)| g.stands(x, y))
            })
            .collect();
        if pads.len() >= 2 {
            let n = (pads.len() - 1) as f32;
            s.pad_s = TELEPORT_CHARGE * n + TELEPORT_COOLDOWN * (n - 1.0);
            s.pads = pads;
        }
        let fuel = fuel.clamp(0.0, JETPACK_MAX_FUEL);
        let k = s.key(x, y, fuel);
        s.seen.insert(
            k,
            Rec {
                g: 0.0,
                secs: 0.0,
                fuel,
                parent: NO_PARENT,
                how: Move::Start,
                closed: false,
            },
        );
        s.open.push((Reverse(s.f_ms(x, y, 0.0)), Reverse(k)));
        Some(s)
    }

    /// Nodes expanded so far.
    #[cfg(test)]
    pub fn expanded(&self) -> u32 {
        self.expanded
    }

    fn key(&self, x: i32, y: i32, fuel: f32) -> u64 {
        (((y * self.nx + x) as u64) << 8) | level(fuel)
    }

    fn unkey(&self, k: u64) -> (i32, i32) {
        let c = (k >> 8) as i32;
        (c % self.nx, c / self.nx)
    }

    fn h(&self, x: i32, y: i32) -> f32 {
        match self.want {
            Want::Near {
                x: tx, y: ty, r, ..
            } => {
                let dx = ((x - tx).abs() - r).max(0) as f32;
                let dy = ((y - ty).abs() - r).max(0) as f32;
                let (lo, hi) = (dx.min(dy), dx.max(dy));
                (hi + (SQRT2 - 1.0) * lo) * cheapest_cell_s()
            }
            Want::Hide { .. } | Want::Away { .. } => 0.0,
        }
    }

    fn f_ms(&self, x: i32, y: i32, g: f32) -> u32 {
        ((g + self.h(x, y)) * 1000.0).round() as u32
    }

    fn is_goal(&self, grid: &Grid, x: i32, y: i32) -> bool {
        satisfies(grid, self.want, x, y)
    }

    /// Up to `budget` expansions.
    pub fn run(&mut self, map: &Map, budget: u32) -> Progress {
        let grid = Grid::new(map);
        let mut edges: Vec<(i32, i32, Move, f32, f32)> = Vec::with_capacity(16);
        for _ in 0..budget {
            let Some((_, Reverse(k))) = self.open.pop() else {
                return Progress::NoRoute;
            };
            let Some(rec) = self.seen.get(&k).copied() else {
                continue;
            };
            if rec.closed {
                continue;
            }
            if let Some(r) = self.seen.get_mut(&k) {
                r.closed = true;
            }
            let (x, y) = self.unkey(k);
            if self.is_goal(&grid, x, y) {
                return Progress::Found(self.route(k));
            }
            self.expanded += 1;
            if self.expanded > self.max_nodes {
                return Progress::NoRoute;
            }
            edges.clear();
            successors(&grid, x, y, rec.fuel, self.dig, &mut edges);
            if self.pads.contains(&(x, y)) {
                for &(px, py) in &self.pads {
                    if (px, py) != (x, y) {
                        edges.push((px, py, Move::Teleport, self.pad_s, rec.fuel));
                    }
                }
            }
            for &(nx, ny, how, secs, fuel) in &edges {
                let c = Grid::centre(nx, ny);
                if self.avoid.is_some_and(|(p, r)| (c - p).len() < r)
                    || self.side.is_some_and(|(p, d)| (c - p).dot(d) < 0.0)
                {
                    continue;
                }
                // Fuel is not free: a second burned is `1 / JETPACK_REFILL` seconds of
                // standing still later. Priced in, a flat run is walked and a kerb hopped
                // rather than flown, because flying is faster only until the tank is owed.
                let spent = (rec.fuel - fuel).max(0.0);
                let g = rec.g + secs + spent / JETPACK_REFILL;
                if g > self.max_cost {
                    continue;
                }
                let cell = (ny * self.nx + nx) as u64;
                let labels = self.labels.entry(cell).or_default();
                if labels.iter().any(|&(lg, lf)| lg <= g && lf >= fuel) {
                    continue;
                }
                labels.retain(|&(lg, lf)| !(g <= lg && fuel >= lf));
                labels.push((g, fuel));
                let nk = self.key(nx, ny, fuel);
                let better = self.seen.get(&nk).is_none_or(|r| !r.closed && g < r.g);
                if better {
                    self.seen.insert(
                        nk,
                        Rec {
                            g,
                            secs,
                            fuel,
                            parent: k,
                            how,
                            closed: false,
                        },
                    );
                    self.open.push((Reverse(self.f_ms(nx, ny, g)), Reverse(nk)));
                }
            }
        }
        Progress::Searching
    }

    fn route(&self, mut k: u64) -> Vec<Step> {
        let mut out = Vec::new();
        while let Some(r) = self.seen.get(&k) {
            let (x, y) = self.unkey(k);
            out.push(Step {
                x,
                y,
                how: r.how,
                cost: r.secs,
                fuel: r.fuel,
            });
            if r.parent == NO_PARENT {
                break;
            }
            k = r.parent;
        }
        out.reverse();
        out
    }
}

/// Is node `(x, y)` what `want` asks for? The search's goal test, and the follower's
/// check that a bot already in cover still is (T23.26 C).
pub(super) fn satisfies(grid: &Grid, want: Want, x: i32, y: i32) -> bool {
    match want {
        Want::Near {
            x: tx,
            y: ty,
            r,
            sight,
        } => {
            (x - tx).abs() <= r
                && (y - ty).abs() <= r
                && sight.is_none_or(|p| grid.clear(Grid::centre(x, y), p))
        }
        // Ground under it, not `stands`: a dug pocket is still rock to the grid the
        // search reads (the dig is planned, not done), and a cover only reachable by
        // digging is exactly the one a bot with nothing near digs (measured: the foxhole
        // two cells down was never a goal, so a hurt bot found none).
        Want::Hide { from } => grid.solid(x, y + 1) && !grid.clear(Grid::centre(x, y), from),
        Want::Away { from, beyond } => {
            grid.stands(x, y)
                && (Grid::centre(x, y) - from).len() >= beyond
                && !grid.clear(Grid::centre(x, y), from)
        }
    }
}

/// Every move out of node `(x, y)` holding `fuel`: `(x, y, how, seconds, fuel after)`.
///
/// The prices are the physics' own numbers, so changing a movement constant moves the
/// routes with it:
/// - **walk** a cell, `BOT_NAV_CELL / WALK_SPEED`, from a standing node;
/// - **hop** up 1..`BOT_NAV_HOP_ROWS` and one across, the jump's rise plus a cell's
///   walk — no fuel, which is why a kerb is never a jet;
/// - **fall** a cell (straight or drifting), from a node with nothing under it, never
///   into a column with no floor before the bottom;
/// - **jet** a cell up, up-across, or across in the air, `BOT_NAV_CELL /
///   JETPACK_MAX_SPEED` (`√2` diagonal) plus `JETPACK_HOLD_DELAY` leaving the ground,
///   draining `JETPACK_DRAIN` a second and refused below what starting the pack needs;
/// - **rest** on the ground to a full tank: the refill delay and the refill;
/// - **dig** into a neighbouring node that has rock in it, `BOT_NAV_DIG_S` plus the
///   move into it (walk, fall, or — up, or across in the air — jet, the swing's time
///   hovering).
fn successors(
    g: &Grid,
    x: i32,
    y: i32,
    fuel: f32,
    dig: bool,
    out: &mut Vec<(i32, i32, Move, f32, f32)>,
) {
    let stands = g.solid(x, y + 1);
    let jet = |secs: f32, from_ground: bool| -> Option<f32> {
        let t = secs + if from_ground { JETPACK_HOLD_DELAY } else { 0.0 };
        let drain = secs * JETPACK_DRAIN;
        // Never plan a jet that leaves less than starting the pack takes: what is left is
        // the brake a fall needs (`Bot::think`), and a plan that flies the tank dry over
        // a drop is the void death it was meant to avoid (measured: most routed void
        // deaths were bots at 0.0–0.5 s of fuel).
        let need = drain
            + JETPACK_MIN_FUEL_TO_ENGAGE
            + if from_ground {
                JETPACK_MIN_FUEL_TO_ENGAGE
            } else {
                0.0
            };
        (fuel >= need).then_some(t).map(|_| fuel - drain)
    };
    let hold = |from_ground: bool| if from_ground { JETPACK_HOLD_DELAY } else { 0.0 };

    for dx in [-1, 1] {
        if stands {
            if g.node(x + dx, y) {
                out.push((x + dx, y, Move::Walk, WALK_S, fuel));
            }
            // Hop: straight up `dy` (head room above), then one across onto ground.
            for dy in 1..=BOT_NAV_HOP_ROWS {
                if !g.node(x, y - dy) {
                    break;
                }
                if g.stands(x + dx, y - dy) {
                    out.push((
                        x + dx,
                        y - dy,
                        Move::Hop,
                        rise_s((dy * CELL) as f32) + WALK_S,
                        fuel,
                    ));
                    break;
                }
            }
        } else {
            // Drift while falling.
            if g.node(x + dx, y) && g.node(x + dx, y + 1) && g.floored(x + dx, y + 1) {
                out.push((x + dx, y + 1, Move::Fall, fall_s() * SQRT2, fuel));
            }
            // Across in the air on the pack.
            if g.node(x + dx, y) {
                if let Some(f) = jet(JET_S, false) {
                    out.push((x + dx, y, Move::Jet, JET_S, f));
                }
            }
        }
        // Up and across on the pack.
        if g.node(x + dx, y - 1) && g.node(x, y - 1) && g.node(x + dx, y) {
            if let Some(f) = jet(JET_S * SQRT2, stands) {
                out.push((x + dx, y - 1, Move::Jet, JET_S * SQRT2 + hold(stands), f));
            }
        }
        // Dig across: walk into it from the ground, hover into it from the air.
        if dig && g.diggable(x + dx, y) == Some(true) {
            if stands {
                out.push((x + dx, y, Move::Dig, BOT_NAV_DIG_S + WALK_S, fuel));
            } else if let Some(f) = jet(BOT_NAV_DIG_S + JET_S, false) {
                out.push((x + dx, y, Move::Dig, BOT_NAV_DIG_S + JET_S, f));
            }
        }
    }
    if !stands && g.node(x, y + 1) && g.floored(x, y + 1) {
        out.push((x, y + 1, Move::Fall, fall_s(), fuel));
    }
    if g.node(x, y - 1) {
        if let Some(f) = jet(JET_S, stands) {
            out.push((x, y - 1, Move::Jet, JET_S + hold(stands), f));
        }
    }
    // Dig up (hovering while it swings) and down (then drop into it).
    if dig && g.diggable(x, y - 1) == Some(true) {
        if let Some(f) = jet(BOT_NAV_DIG_S + JET_S, stands) {
            out.push((x, y - 1, Move::Dig, BOT_NAV_DIG_S + JET_S + hold(stands), f));
        }
    }
    if dig && stands && g.diggable(x, y + 1) == Some(true) && g.floored(x, y + 1) {
        out.push((x, y + 1, Move::Dig, BOT_NAV_DIG_S + fall_s(), fuel));
    }
    if stands && fuel < JETPACK_MAX_FUEL - BOT_NAV_FUEL_STEP {
        out.push((
            x,
            y,
            Move::Rest,
            JETPACK_REFILL_DELAY + (JETPACK_MAX_FUEL - fuel) / JETPACK_REFILL,
            JETPACK_MAX_FUEL,
        ));
    }
    // **Never over the void.** A node in the air with no floor anywhere under it is a
    // fall out of the map the moment anything goes wrong — the tank, a blast, the
    // brake — and most of the void deaths routes added were exactly that (bots crossing
    // bottomless gaps on the pack). Such a node is not a step into it.
    // A node already over the void may move through more of it: that is the way out.
    if stands || g.floored(x, y) {
        out.retain(|&(nx, ny, ..)| g.solid(nx, ny + 1) || g.floored(nx, ny));
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::constants::{MapScale, BOT_NAV_COST_MAX, BOT_NAV_NODES_MAX};
    use crate::world::World;

    /// A carved fixture, in nav cells: everything inside `(x0, y0)..=(x1, y1)` is set
    /// to `rock` (`true`) or air. Callers rebuild the coarse grid with [`seal`].
    pub(in crate::bots) fn fill(w: &mut World, x0: i32, y0: i32, x1: i32, y1: i32, rock: bool) {
        for y in (y0 * CELL)..((y1 + 1) * CELL) {
            let (a, b) = (x0 * CELL, (x1 + 1) * CELL - 1);
            if rock {
                w.map.mask.set_run(y, a, b);
            } else {
                w.map.mask.clear_run(y, a, b);
            }
        }
    }

    /// The coarse grid is a cache of the mask and both physics and the planner read
    /// it, so a hand-carved fixture that skipped this would be rock to the mask and
    /// air to everything else.
    pub(in crate::bots) fn seal(w: &mut World) {
        w.map.coarse = crate::map::coarse::CoarseGrid::build(&w.map.mask);
    }

    /// A world whose middle is a block of rock `cols × rows` cells, its top-left cell
    /// returned — fixtures carve their rooms into it, so nothing the generator put
    /// there decides a route. No pads or platforms: their footings are hard, and a
    /// fixture that happened to sit on one would be testing the generator.
    pub(in crate::bots) fn block(scale: MapScale, cols: i32, rows: i32) -> (World, i32, i32) {
        let mut w = World::for_test(4242, scale);
        w.map.meta.teleport_pads.clear();
        w.map.meta.gun_platforms.clear();
        let g = Grid::new(&w.map);
        let (ox, oy) = ((g.nx - cols) / 2, (g.ny - rows) / 2);
        fill(&mut w, ox, oy, ox + cols - 1, oy + rows - 1, true);
        (w, ox, oy)
    }

    /// The body centre standing with its feet in cell `(x, y)` — where `flat_shelf`
    /// stands one: its lowest pixel on the row above the floor.
    pub(in crate::bots) fn stand_at(x: i32, y: i32) -> Vec2 {
        Vec2::new(
            (x * CELL) as f32 + BOT_NAV_CELL * 0.5,
            ((y + 1) * CELL) as f32 - PLAYER_H * 0.5 - 1.0,
        )
    }

    fn plan(w: &World, from: Vec2, fuel: f32, want: Want) -> Progress {
        let mut s = Search::new(
            &w.map,
            from,
            fuel,
            want,
            BOT_NAV_NODES_MAX,
            BOT_NAV_COST_MAX,
        )
        .expect("the start is in no node");
        loop {
            match s.run(&w.map, 64) {
                Progress::Searching => continue,
                done => return done,
            }
        }
    }

    fn near(x: i32, y: i32) -> Want {
        Want::Near {
            x,
            y,
            r: 0,
            sight: None,
        }
    }

    fn moves(p: &Progress) -> Vec<Move> {
        match p {
            Progress::Found(r) => r.iter().map(|s| s.how).collect(),
            other => panic!("no route: {other:?}"),
        }
    }

    /// The grid reads the live coarse grid: a carved cell is air on the next read.
    #[test]
    fn a_cell_is_air_once_it_is_carved_and_rock_before() {
        let (mut w, ox, oy) = block(MapScale::Small, 6, 6);
        assert_eq!(Grid::new(&w.map).cell(ox + 2, oy + 2), Cell::Rock);
        fill(&mut w, ox + 2, oy + 2, ox + 2, oy + 2, false);
        seal(&mut w);
        assert_eq!(Grid::new(&w.map).cell(ox + 2, oy + 2), Cell::Air);
        // Hard: the side wall's columns and the bottom `PLAYER_H`.
        let g = Grid::new(&w.map);
        assert_eq!(g.cell(0, oy), Cell::Hard, "the wall column");
        assert_eq!(g.cell(ox, g.ny - 1), Cell::Hard, "the bottom row");
    }

    /// A body standing in a room is located in the node its feet are in — the same
    /// cell `stand_at` put it in, so the fixtures and the follower agree.
    #[test]
    fn a_standing_body_is_located_in_its_feet_cell() {
        let (mut w, ox, oy) = block(MapScale::Small, 8, 6);
        fill(&mut w, ox + 1, oy + 1, ox + 6, oy + 4, false);
        seal(&mut w);
        let g = Grid::new(&w.map);
        assert_eq!(g.locate(stand_at(ox + 3, oy + 4)), Some((ox + 3, oy + 4)));
        assert!(g.stands(ox + 3, oy + 4));
        assert!(!g.stands(ox + 3, oy + 3), "control: one up is in the air");
    }

    /// **A kerb is a hop, not a jet.** A step two cells high (inside a jump) between the
    /// bot and the goal: the route hops it and burns no fuel. The control is the same
    /// room with the step four cells high — over a jump, so the pack is the way.
    #[test]
    fn a_step_inside_a_jump_is_hopped_and_a_taller_one_is_jetted() {
        let route = |step: i32| {
            let (mut w, ox, oy) = block(MapScale::Small, 14, 10);
            fill(&mut w, ox + 1, oy + 1, ox + 12, oy + 8, false);
            fill(&mut w, ox + 7, oy + 9 - step, ox + 12, oy + 8, true);
            seal(&mut w);
            plan(
                &w,
                stand_at(ox + 3, oy + 8),
                JETPACK_MAX_FUEL,
                near(ox + 9, oy + 8 - step),
            )
        };
        const { assert!(BOT_NAV_HOP_ROWS >= 2, "the fixture's step is inside a hop") };
        let low = moves(&route(2));
        assert!(
            low.contains(&Move::Hop),
            "a 2-cell step was not hopped: {low:?}"
        );
        assert!(
            !low.contains(&Move::Jet),
            "a 2-cell step cost a jet: {low:?}"
        );
        let high = moves(&route(BOT_NAV_HOP_ROWS + 1));
        assert!(
            high.contains(&Move::Jet),
            "control: a step over a hop was not jetted: {high:?}"
        );
    }

    /// **A climb the tank cannot make in one go rests on the way.** A wall twelve cells
    /// tall with the bot at the foot holding just over what starting the pack needs:
    /// the route refuels first. The control is the same wall from a full tank — no
    /// rest.
    #[test]
    fn a_climb_on_a_low_tank_refuels_first_and_a_full_one_does_not() {
        let route = |fuel: f32| {
            let (mut w, ox, oy) = block(MapScale::Small, 10, 18);
            fill(&mut w, ox + 1, oy + 1, ox + 8, oy + 16, false);
            fill(&mut w, ox + 5, oy + 4, ox + 8, oy + 16, true);
            seal(&mut w);
            plan(&w, stand_at(ox + 2, oy + 16), fuel, near(ox + 6, oy + 3))
        };
        let low = moves(&route(JETPACK_MIN_FUEL_TO_ENGAGE + BOT_NAV_FUEL_STEP));
        let rest = low.iter().position(|m| *m == Move::Rest);
        let jet = low.iter().position(|m| *m == Move::Jet);
        assert!(
            matches!((rest, jet), (Some(r), Some(j)) if r < j),
            "a low tank did not rest before the climb: {low:?}"
        );
        let full = moves(&route(JETPACK_MAX_FUEL));
        assert!(
            !full.contains(&Move::Rest),
            "control: a full tank rested: {full:?}"
        );
        assert!(
            full.contains(&Move::Jet),
            "control: a full tank did not climb: {full:?}"
        );
    }

    /// **A climb no tank can make is not a route** — a smooth shaft taller than
    /// `JETPACK_MAX_FUEL × JETPACK_MAX_SPEED`, its walls unclimbable rock, and digging
    /// a ledge to rest on refused. The control: the same shaft with digging allowed
    /// finds the ledge (dig in, rest, climb on), and a shaft inside one tank is flown.
    #[test]
    fn a_climb_longer_than_a_tank_is_refused_unless_a_ledge_can_be_dug() {
        let tank_cells =
            (JETPACK_MAX_FUEL / JETPACK_DRAIN * JETPACK_MAX_SPEED / BOT_NAV_CELL) as i32;
        let shaft = |rows: i32, dig: bool| {
            let (mut w, ox, oy) = block(MapScale::Large, 7, rows + 4);
            // The pit: floor at the bottom, the open shaft one cell wide over it, open
            // air at the top to land on.
            fill(&mut w, ox + 1, oy + 1, ox + 5, oy + 2, false);
            fill(&mut w, ox + 3, oy + 3, ox + 3, oy + rows + 2, false);
            seal(&mut w);
            let mut s = Search::new(
                &w.map,
                stand_at(ox + 3, oy + rows + 2),
                JETPACK_MAX_FUEL,
                near(ox + 1, oy + 2),
                // Measured: the dug-ledge route takes ~25 000 expansions (every rock cell
                // beside the shaft is a dig, at every height) — four times a round's cap.
                // The cap is not what this test is about; the shaft without digging
                // answers in ~80.
                20 * BOT_NAV_NODES_MAX,
                // A climb past a tank, priced with its refill, is dearer than any
                // route a round asks for — the bound is not what this test is about.
                4.0 * BOT_NAV_COST_MAX,
            )
            .expect("start");
            s.dig = dig;
            loop {
                match s.run(&w.map, 256) {
                    Progress::Searching => continue,
                    done => return done,
                }
            }
        };
        let too_tall = tank_cells + 6;
        assert!(
            (too_tall + 4) * CELL
                < Grid::new(&World::for_test(4242, MapScale::Large).map).ny * CELL,
            "the map is too short for the fixture"
        );
        assert_eq!(
            shaft(too_tall, false),
            Progress::NoRoute,
            "a climb past the tank was a route"
        );
        let dug = moves(&shaft(too_tall, true));
        assert!(
            dug.contains(&Move::Dig) && dug.contains(&Move::Rest),
            "control: with digging it should dig a ledge and rest: {dug:?}"
        );
        let short = moves(&shaft(tank_cells / 2, false));
        assert!(
            short.contains(&Move::Jet),
            "control: a half-tank shaft was not flown: {short:?}"
        );
    }

    /// **Thin wall: dig through. Thick wall: go round.** Two chambers side by side, a
    /// wall between, and an open way round over the top. One cell of wall is cheaper to
    /// dig than the trip round; the thick one is not. Both priced by the same edges —
    /// nothing here says "prefer digging".
    #[test]
    fn a_thin_wall_is_dug_through_and_a_thick_one_is_gone_round() {
        let route = |thick: i32| {
            let cols = 8 + thick;
            let (mut w, ox, oy) = block(MapScale::Small, cols + 2, 16);
            let wall = ox + 5;
            // The gallery over the top, and a shaft down into each chamber.
            fill(&mut w, ox + 1, oy + 1, ox + cols, oy + 2, false);
            fill(&mut w, ox + 1, oy + 3, ox + 1, oy + 12, false);
            fill(&mut w, ox + cols, oy + 3, ox + cols, oy + 12, false);
            // The chambers, the wall between them.
            fill(&mut w, ox + 1, oy + 11, wall - 1, oy + 14, false);
            fill(&mut w, wall + thick, oy + 11, ox + cols, oy + 14, false);
            seal(&mut w);
            let r = plan(
                &w,
                stand_at(wall - 1, oy + 14),
                JETPACK_MAX_FUEL,
                near(wall + thick, oy + 14),
            );
            let m = moves(&r);
            (
                m.iter().filter(|m| **m == Move::Dig).count(),
                m.contains(&Move::Jet),
            )
        };
        let (digs, jets) = route(1);
        assert!(
            digs >= 1 && !jets,
            "a one-cell wall was not dug through ({digs} digs, jet {jets})"
        );
        let (digs, jets) = route(14);
        assert!(
            digs == 0 && jets,
            "a 14-cell wall was dug ({digs} digs) rather than gone round"
        );
    }

    /// A fall never goes into a column with no floor before the bottom: the map has no
    /// bedrock, so that is a fall out of it. A ledge over a bottomless pit with the
    /// goal across it: no route by falling (the control: with a floor in the pit, the
    /// route drops into it).
    #[test]
    fn a_route_never_falls_into_the_void() {
        let route = |floor: bool| {
            let mut w = World::for_test(4242, MapScale::Small);
            w.map.meta.teleport_pads.clear();
            w.map.meta.gun_platforms.clear();
            let g = Grid::new(&w.map);
            let (nx, ny) = (g.nx, g.ny);
            let x = nx / 2;
            // A ledge, then a pit open all the way down, then the goal's ledge.
            fill(&mut w, x - 6, 1, x + 6, ny - 1, false);
            fill(&mut w, x - 6, ny - 8, x - 2, ny - 8, true);
            fill(&mut w, x + 2, ny - 8, x + 6, ny - 8, true);
            if floor {
                fill(&mut w, x - 1, ny - 4, x + 1, ny - 4, true);
            }
            seal(&mut w);
            let mut s = Search::new(
                &w.map,
                stand_at(x - 3, ny - 9),
                0.0,
                near(x, ny - 5),
                BOT_NAV_NODES_MAX,
                BOT_NAV_COST_MAX,
            )
            .expect("start");
            s.dig = false;
            loop {
                match s.run(&w.map, 256) {
                    Progress::Searching => continue,
                    done => return done,
                }
            }
        };
        assert!(
            matches!(route(true), Progress::Found(_)),
            "control: a pit with a floor"
        );
        assert_eq!(
            route(false),
            Progress::NoRoute,
            "a route fell into a bottomless pit"
        );
    }

    /// The same search twice is the same route, step for step, and the work is a count:
    /// two runs with different per-call budgets end at the same route.
    #[test]
    fn the_search_is_deterministic_and_its_budget_is_a_count() {
        let (mut w, ox, oy) = block(MapScale::Small, 20, 16);
        fill(&mut w, ox + 1, oy + 1, ox + 18, oy + 14, false);
        fill(&mut w, ox + 6, oy + 6, ox + 7, oy + 14, true);
        fill(&mut w, ox + 12, oy + 3, ox + 13, oy + 11, true);
        seal(&mut w);
        let from = stand_at(ox + 2, oy + 14);
        let run = |budget: u32| {
            let mut s = Search::new(
                &w.map,
                from,
                2.0,
                near(ox + 16, oy + 14),
                BOT_NAV_NODES_MAX,
                BOT_NAV_COST_MAX,
            )
            .expect("start");
            let mut calls = 0;
            loop {
                calls += 1;
                match s.run(&w.map, budget) {
                    Progress::Searching => continue,
                    done => return (done, s.expanded(), calls),
                }
            }
        };
        let (a, na, ca) = run(1);
        let (b, nb, cb) = run(1000);
        assert!(matches!(a, Progress::Found(_)), "no route: {a:?}");
        assert_eq!(a, b, "a route depended on how the work was split");
        assert_eq!(na, nb, "the expansions depended on how the work was split");
        assert!(
            ca > cb,
            "control: a budget of 1 took {ca} calls against {cb}"
        );
    }
}
