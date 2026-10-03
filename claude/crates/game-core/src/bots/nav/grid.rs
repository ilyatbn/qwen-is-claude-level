//! The planner's view of the live terrain: cells, nodes, standing, line of sight (T23.26B split of `nav.rs`).

#[allow(unused_imports)]
use super::*;

/// The live terrain as the planner sees it. Borrowed per call, never stored: the map
/// changes under a bot every carve.
pub(in crate::bots) struct Grid<'a> {
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
    pub(super) fn rock_px(&self, x: i32, y: i32) -> u32 {
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
    pub(super) fn hard(&self, x: i32, y: i32) -> bool {
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

    /// T23.26F: is cell `(x, y)` air — the planner's own threshold, without the hard-rock
    /// read a rock cell's [`cell`](Self::cell) pays for (the openness field reads every
    /// cell of the map). Off the sides is not air; over the top is.
    pub fn air(&self, x: i32, y: i32) -> bool {
        if x < 0 || x >= self.nx {
            return false;
        }
        y < 0 || y >= self.ny || self.rock_px(x, y) <= BOT_NAV_AIR_PX
    }

    pub(super) fn solid(&self, x: i32, y: i32) -> bool {
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

    /// T23.26E step 4: is node `(x, y)` **enclosed by rock** — of the five cells round its
    /// head (left, up-left, up, up-right, right), three or more not air? A tunnel (the
    /// three above), a shaft (both sides and their tops) and a pocket are; open ground, a
    /// wall at one side or a ledge overhead alone are not. `movement::enclosed`'s rule in
    /// cells.
    pub fn enclosed(&self, x: i32, y: i32) -> bool {
        [(-1, -1), (-1, -2), (0, -2), (1, -2), (1, -1)]
            .into_iter()
            .filter(|&(dx, dy)| self.solid(x + dx, y + dy))
            .count()
            >= 3
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
    pub(super) fn floored(&self, x: i32, y: i32) -> bool {
        ((y + 1)..self.ny).any(|yy| self.solid(x, yy))
    }

    /// Can the node `(x, y)` be dug into — every cell of it air or diggable rock, and
    /// at least one rock? `None` when a cell is hard or it is no node at all.
    pub(super) fn diggable(&self, x: i32, y: i32) -> Option<bool> {
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
