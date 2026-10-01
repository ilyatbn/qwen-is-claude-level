//! T23.26F (`docs/78` §A6) — **open ground**: where a body stands with room round it.
//!
//! The owner: *"their top priority is to find as much open ground and each other … make
//! them even more open space aware by calculating the best path to places outside of
//! caves"*. `nav::Grid::enclosed` reads five cells round a head — a tunnel's roof — and a
//! cave chamber two bodies tall passes it. This reads the **volume**: a nav cell is open
//! when the box `BOT_OPEN_REACH` cells either side and `BOT_OPEN_HEAD` rows above its
//! feet is mostly air (`BOT_OPEN_AIR_SHARE`), or when the sky is straight above it and
//! the box is at least `BOT_OPEN_SKY_SHARE` air (a crater, a valley floor — not a
//! two-cell shaft).
//!
//! **Generic over the map's shape** (§A5): nothing assumes ground touches the bottom edge
//! or rock the sides. Under an island, on a multilevel map's lower ground, on an island
//! in the clouds: the box asks only how much air is round the body.
//!
//! The field is two arrays rebuilt from the map in one pass — prefix sums of air cells and
//! each column's first non-air row — when `World::carve_seq` has moved and at least
//! `BOT_OPEN_REFRESH_S` has passed since the last build: a carve is seen within a second,
//! and a round of constant digging rebuilds once a second, not once a swing. Deterministic:
//! the rebuild is keyed on round time and the carve counter, never a clock.

use crate::constants::{
    BOT_OPEN_AIR_SHARE, BOT_OPEN_HEAD, BOT_OPEN_REACH, BOT_OPEN_REFRESH_S, BOT_OPEN_SEARCH,
    BOT_OPEN_SKY_SHARE,
};
use crate::math::Vec2;
use crate::world::World;

use super::nav::Grid;

#[derive(Debug, Clone, Default)]
pub(super) struct Openness {
    nx: i32,
    ny: i32,
    /// `(nx + 1) × (ny + 1)` prefix sums of air cells.
    air: Vec<u32>,
    /// Per column, the first row from the top that is not air (`ny` when none).
    roof: Vec<i32>,
    /// The carve counter and round time of the last build; `None` never built.
    built: Option<(u32, f32)>,
    /// T23.26F: the middle of the map's open ground — the mean of its open standing
    /// nodes' centres, `None` with none. Where bots drift to meet (`Bot::choose_goal`).
    centre: Option<Vec2>,
}

impl Openness {
    /// Rebuild when the terrain has changed and the last build is `BOT_OPEN_REFRESH_S`
    /// old — or the map is not the one built from (a new round, a fixture).
    pub(super) fn refresh(&mut self, world: &World) {
        let grid = Grid::new(&world.map);
        let (seq, now) = (world.carve_seq(), world.round_time);
        let stale = match self.built {
            None => true,
            Some((s, at)) => {
                grid.nx != self.nx
                    || grid.ny != self.ny
                    || now < at
                    || (s != seq && now - at >= BOT_OPEN_REFRESH_S)
            }
        };
        if stale {
            self.build(&grid);
            self.built = Some((seq, now));
        }
    }

    /// Build from the grid as it is now.
    pub(super) fn build(&mut self, grid: &Grid) {
        let (nx, ny) = (grid.nx.max(0), grid.ny.max(0));
        self.nx = nx;
        self.ny = ny;
        let w = (nx + 1) as usize;
        self.air.clear();
        self.air.resize(w * (ny + 1) as usize, 0);
        self.roof.clear();
        self.roof.resize(nx as usize, ny);
        for y in 0..ny {
            let mut row = 0u32;
            for x in 0..nx {
                let a = grid.air(x, y);
                row += u32::from(a);
                if !a && self.roof[x as usize] == ny {
                    self.roof[x as usize] = y;
                }
                let i = (y + 1) as usize * w + (x + 1) as usize;
                self.air[i] = self.air[i - w] + row;
            }
        }
        let (mut sx, mut sy, mut n) = (0.0f64, 0.0f64, 0u32);
        for y in 0..ny {
            for x in 0..nx {
                if self.ground(grid, x, y) {
                    let c = Grid::centre(x, y);
                    sx += f64::from(c.x);
                    sy += f64::from(c.y);
                    n += 1;
                }
            }
        }
        self.centre =
            (n > 0).then(|| Vec2::new((sx / f64::from(n)) as f32, (sy / f64::from(n)) as f32));
    }

    /// T23.26F: the middle of the open ground (see the field).
    pub(super) fn centre(&self) -> Option<Vec2> {
        self.centre
    }

    /// Air cells and all cells in the box, clamped to the map.
    fn box_air(&self, x: i32, y: i32) -> (u32, u32) {
        let (x0, x1) = (
            (x - BOT_OPEN_REACH).max(0),
            (x + BOT_OPEN_REACH).min(self.nx - 1),
        );
        let (y0, y1) = ((y - BOT_OPEN_HEAD).max(0), y.min(self.ny - 1));
        if x0 > x1 || y0 > y1 {
            return (0, 0);
        }
        let w = (self.nx + 1) as usize;
        let at = |cx: i32, cy: i32| self.air[cy as usize * w + cx as usize];
        let air = at(x1 + 1, y1 + 1) + at(x0, y0) - at(x0, y1 + 1) - at(x1 + 1, y0);
        (air, ((x1 - x0 + 1) * (y1 - y0 + 1)) as u32)
    }

    /// Is a body with its feet in cell `(x, y)` **in the open** — the rule above.
    pub(super) fn open(&self, x: i32, y: i32) -> bool {
        if x < 0 || x >= self.nx || y < 0 || y >= self.ny {
            return false;
        }
        let (air, all) = self.box_air(x, y);
        let share = air as f32 / all.max(1) as f32;
        let sky = self.roof[x as usize] >= y;
        share >= BOT_OPEN_AIR_SHARE || (sky && share >= BOT_OPEN_SKY_SHARE)
    }

    /// Open **ground**: a node a body stands on, in the open.
    pub(super) fn ground(&self, grid: &Grid, x: i32, y: i32) -> bool {
        grid.stands(x, y) && self.open(x, y)
    }

    /// Is a body at `pos` in the open — its node's rule; buried is not.
    pub(super) fn open_at(&self, grid: &Grid, pos: Vec2) -> bool {
        grid.locate(pos).is_some_and(|(x, y)| self.open(x, y))
    }

    /// **The way out of a cave**: the open ground nearest `from` through the air — a
    /// breadth-first walk over nodes (four ways), at most `BOT_OPEN_SEARCH` of them, so the
    /// answer is the mouth of the cave the body is in, not the open ground on the far side
    /// of its wall. How to get there (climb, jet, dig a lip) is the planner's. `None` when
    /// no open ground is reachable through air within the count — sealed in.
    pub(super) fn nearest_ground(&self, grid: &Grid, from: Vec2) -> Option<(i32, i32)> {
        let start = grid.locate(from)?;
        if self.ground(grid, start.0, start.1) {
            return Some(start);
        }
        let idx = |x: i32, y: i32| (y * self.nx + x) as usize;
        let mut seen = vec![false; (self.nx * self.ny).max(0) as usize];
        let mut queue = std::collections::VecDeque::new();
        seen[idx(start.0, start.1)] = true;
        queue.push_back(start);
        let mut count = 0u32;
        while let Some((x, y)) = queue.pop_front() {
            count += 1;
            if count > BOT_OPEN_SEARCH {
                return None;
            }
            for (dx, dy) in [(0, -1), (-1, 0), (1, 0), (0, 1)] {
                let (nx, ny) = (x + dx, y + dy);
                if nx < 0 || nx >= self.nx || ny < 0 || ny >= self.ny || seen[idx(nx, ny)] {
                    continue;
                }
                seen[idx(nx, ny)] = true;
                if !grid.node(nx, ny) {
                    continue;
                }
                if self.ground(grid, nx, ny) {
                    return Some((nx, ny));
                }
                queue.push_back((nx, ny));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bots::nav::tests::{block, fill, seal};
    use crate::constants::MapScale;

    /// A cave — a pocket three nodes tall carved in a block — is not open; the sky over a
    /// wide crater is; and a carve that opens the cave's roof makes it open on the next
    /// build. Control: the same box rule on the pocket's ceiling removed.
    #[test]
    fn a_cave_is_enclosed_and_a_crater_under_the_sky_is_open() {
        let (mut w, ox, oy) = block(MapScale::Medium, 40, 30);
        // The pocket: 10 cells wide, 3 tall, deep in the block.
        let (px, py) = (ox + 15, oy + 20);
        fill(&mut w, px, py - 2, px + 9, py, false);
        // The crater: the block's top 6 rows over 24 columns, open to the sky.
        fill(&mut w, ox + 8, 0, ox + 31, oy + 5, false);
        seal(&mut w);
        let mut o = Openness::default();
        o.build(&Grid::new(&w.map));
        let g = Grid::new(&w.map);
        assert!(g.stands(px + 5, py), "fixture: the pocket's floor stands");
        assert!(
            !o.open(px + 5, py),
            "a pocket three cells tall read as open"
        );
        assert!(
            g.stands(ox + 20, oy + 5),
            "fixture: the crater's floor stands"
        );
        assert!(
            o.ground(&g, ox + 20, oy + 5),
            "the crater under the sky read as enclosed"
        );
        // Control: lift the pocket's roof into the crater above it — the same floor, open.
        fill(&mut w, px, oy + 6, px + 9, py, false);
        seal(&mut w);
        o.build(&Grid::new(&w.map));
        assert!(
            o.open(px + 5, py),
            "a pit 15 rows deep and 10 wide with the sky over it"
        );
    }

    /// The way out of a cave is its mouth: a tunnel from the pocket to the crater, and the
    /// nearest open ground through the air is in the crater — while a sealed pocket has none.
    #[test]
    fn the_nearest_open_ground_is_reached_through_the_cave_mouth() {
        let (mut w, ox, oy) = block(MapScale::Medium, 40, 30);
        let (px, py) = (ox + 15, oy + 20);
        fill(&mut w, px, py - 2, px + 9, py, false);
        fill(&mut w, ox + 8, 0, ox + 31, oy + 5, false);
        seal(&mut w);
        let mut o = Openness::default();
        o.build(&Grid::new(&w.map));
        let from = crate::bots::nav::tests::stand_at(px + 5, py);
        let g = Grid::new(&w.map);
        assert_eq!(
            o.nearest_ground(&g, from),
            None,
            "sealed: no way out through air"
        );
        // A shaft from the pocket's left end up into the crater.
        fill(&mut w, px, oy + 5, px + 1, py, false);
        seal(&mut w);
        o.build(&Grid::new(&w.map));
        let g = Grid::new(&w.map);
        let (x, y) = o.nearest_ground(&g, from).expect("the shaft is a way out");
        assert!(
            y <= oy + 5,
            "the way out ends in the crater, row {y} (crater floor {})",
            oy + 5
        );
        assert!(o.ground(&g, x, y));
    }
}
