//! The A* search over (node, fuel) states, resumable across ticks (T23.26B split of `nav.rs`).

#[allow(unused_imports)]
use super::*;

/// A deterministic hasher for the visited table (FxHash's multiply). `std`'s default
/// is seeded from the OS per process, which is ambient randomness `game-core` refuses
/// even where only lookups depend on it.
#[derive(Default)]
pub(super) struct KeyHasher(u64);
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
pub(super) struct Rec {
    /// The price so far: seconds, plus the refill time of the fuel spent.
    g: f32,
    /// This step's own seconds (what the follower times it against).
    secs: f32,
    fuel: f32,
    parent: u64,
    how: Move,
    closed: bool,
}

pub(super) const NO_PARENT: u64 = u64::MAX;

pub(super) fn level(fuel: f32) -> u64 {
    (fuel / BOT_NAV_FUEL_STEP).floor().max(0.0) as u64
}

/// What one call of [`Search::run`] got to.
#[derive(Debug, Clone, PartialEq)]
pub(in crate::bots) enum Progress {
    /// Out of this call's budget; call again.
    Searching,
    /// The route, first step the start.
    Found(Vec<Step>),
    /// Nothing within the bound — no route, or the node cap was hit.
    NoRoute,
}

/// One resumable A*.
pub(in crate::bots) struct Search {
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
    /// T23.26C item 3: the body flies on wings — `fly_successors`' edges, not the
    /// walker's, and no pads (wings refuse them, `World::fire_pads`).
    fly: bool,
    /// T23.26E step 4: **open ground is preferred** — each dig edge priced
    /// `BOT_NAV_DIG_FACTOR` times its time and each enclosed node `BOT_NAV_ENCLOSED_S`
    /// more, in the search's price only (the follower still times a step by its seconds).
    /// Off for hiding (cover is the point) and running (`route::Route::step`).
    pub open_ground: bool,
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
            fly: false,
            open_ground: false,
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

    /// The body is winged: plan its flight (T23.26C item 3).
    pub fn flying(&mut self) {
        self.fly = true;
        self.pads.clear();
    }

    /// Nodes expanded so far.
    #[cfg(test)]
    pub fn expanded(&self) -> u32 {
        self.expanded
    }

    pub(super) fn key(&self, x: i32, y: i32, fuel: f32) -> u64 {
        (((y * self.nx + x) as u64) << 8) | level(fuel)
    }

    pub(super) fn unkey(&self, k: u64) -> (i32, i32) {
        let c = (k >> 8) as i32;
        (c % self.nx, c / self.nx)
    }

    pub(super) fn h(&self, x: i32, y: i32) -> f32 {
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

    pub(super) fn f_ms(&self, x: i32, y: i32, g: f32) -> u32 {
        ((g + self.h(x, y)) * 1000.0).round() as u32
    }

    pub(super) fn is_goal(&self, grid: &Grid, x: i32, y: i32) -> bool {
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
            if self.fly {
                fly_successors(&grid, x, y, rec.fuel, self.dig, &mut edges);
            } else {
                successors(&grid, x, y, rec.fuel, self.dig, &mut edges);
            }
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
                let mut g = rec.g + secs + spent / JETPACK_REFILL;
                if self.open_ground {
                    if how == Move::Dig {
                        g += (BOT_NAV_DIG_FACTOR - 1.0) * BOT_NAV_DIG_S;
                    }
                    if how == Move::Hop {
                        let h = ((y - ny) * CELL) as f32;
                        g += hop_air_s(h) - rise_s(h);
                    }
                    if grid.enclosed(nx, ny) {
                        g += BOT_NAV_ENCLOSED_S;
                    }
                }
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

    pub(super) fn route(&self, mut k: u64) -> Vec<Step> {
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
