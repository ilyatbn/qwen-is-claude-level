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
    BOT_LOS_STEP, BOT_NAV_AIR_PX, BOT_NAV_CELL, BOT_NAV_DIG_FACTOR, BOT_NAV_DIG_S,
    BOT_NAV_ENCLOSED_S, BOT_NAV_FLOOR_BAND, BOT_NAV_FUEL_STEP, BOT_NAV_HOP_ROWS, COARSE_CELL,
    GRAVITY, JETPACK_DRAIN, JETPACK_HOLD_DELAY, JETPACK_MAX_FUEL, JETPACK_MAX_SPEED,
    JETPACK_MIN_FUEL_TO_ENGAGE, JETPACK_REFILL, JETPACK_REFILL_DELAY, JUMP_VELOCITY, PLAYER_H,
    TELEPORT_CHARGE, TELEPORT_COOLDOWN, WALK_SPEED, WALL_W, WINGS_FLY_SPEED, WINGS_SPEED_MULT,
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

/// T23.26E step 4: seconds a hop up `h` px **spends off the ground** — a jump is always
/// the full `JUMP_VELOCITY`, so it rises past the ledge and comes down onto it:
/// `(v + sqrt(v² - 2gh)) / g` (≈ 0.58 s onto one row, against the 0.04 s [`rise_s`] of
/// reaching its height). An open-ground route pays the difference (`Search::open_ground`):
/// a hop is a jump, and a level walk is preferred to one where both exist.
pub(super) fn hop_air_s(h: f32) -> f32 {
    let v = JUMP_VELOCITY;
    let d = (v * v - 2.0 * GRAVITY * h).max(0.0);
    (v + d.sqrt()) / GRAVITY
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
    /// T23.26C item 3: on wings, one cell in any of eight directions — no fuel, no fall.
    Fly,
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

mod edges;
mod grid;
mod search;
// T23.26B: `nav.rs` (~1160 lines) split into grid / search / edges with no behaviour change. What the other bot
// modules name stays at `nav::…`.
#[allow(unused_imports)]
use edges::*;
pub(in crate::bots) use edges::{satisfies, successors};
pub(in crate::bots) use grid::Grid;
#[allow(unused_imports)]
use search::*;
pub(in crate::bots) use search::{Progress, Search};

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
