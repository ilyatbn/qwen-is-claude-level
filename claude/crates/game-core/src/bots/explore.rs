//! Where a bot has been (§E10): its coverage grid — split out of `bots/mod.rs` by
//! T22.14B, unchanged.

use crate::constants::{BOT_EXPLORE_CELL, SPACE_RIM_CLEARANCE};
use crate::math::Vec2;
use crate::world::World;

/// Which cells of the map a bot has been to (§E10).
///
/// **This is not pathfinding and must not become it.** A bot marks the cell it
/// is standing in, heads for the middle of the nearest cell it has not marked,
/// and gives up on one it cannot reach. There is no graph, no route and no
/// A* — the map is destructible, so any route is stale the moment somebody
/// fires, and the behaviour this exists to produce is "went somewhere else",
/// not "took the best way there".
///
/// Per bot, not shared: five bots that agreed on where they had been would
/// spread out like a search party rather than like opponents.
#[derive(Debug, Clone)]
pub(super) struct Coverage {
    cols: i32,
    rows: i32,
    /// One bit per cell, row-major.
    seen: Vec<u64>,
}

impl Coverage {
    pub(super) fn new(map_w: i32, map_h: i32) -> Self {
        let cols = (map_w.max(1) + BOT_EXPLORE_CELL - 1) / BOT_EXPLORE_CELL;
        let rows = (map_h.max(1) + BOT_EXPLORE_CELL - 1) / BOT_EXPLORE_CELL;
        let cells = (cols.max(1) * rows.max(1)) as usize;
        Coverage {
            cols: cols.max(1),
            rows: rows.max(1),
            seen: vec![0; cells.div_ceil(64)],
        }
    }

    pub(super) fn index(&self, cx: i32, cy: i32) -> usize {
        (cy * self.cols + cx) as usize
    }

    pub(super) fn cell_of(&self, p: Vec2) -> (i32, i32) {
        (
            ((p.x as i32) / BOT_EXPLORE_CELL).clamp(0, self.cols - 1),
            ((p.y as i32) / BOT_EXPLORE_CELL).clamp(0, self.rows - 1),
        )
    }

    pub(super) fn is_seen(&self, i: usize) -> bool {
        self.seen
            .get(i / 64)
            .is_some_and(|w| w & (1 << (i % 64)) != 0)
    }

    pub(super) fn mark(&mut self, i: usize) {
        if let Some(w) = self.seen.get_mut(i / 64) {
            *w |= 1 << (i % 64);
        }
    }

    /// T22.03B: in space, count every cell whose middle is not inside the arena
    /// (clear of the rim by `SPACE_RIM_CLEARANCE`) as seen, so exploring never
    /// heads for the rim or the void beyond it. Nothing elsewhere.
    pub(super) fn mark_outside(&mut self, world: &World) {
        let Some(geo) = world.map.space_geometry() else {
            return;
        };
        for cy in 0..self.rows {
            for cx in 0..self.cols {
                let x = (cx * BOT_EXPLORE_CELL + BOT_EXPLORE_CELL / 2) as f32;
                let y = (cy * BOT_EXPLORE_CELL + BOT_EXPLORE_CELL / 2) as f32;
                if !geo.inside(x, y) || geo.distance_to_rim(x, y) < SPACE_RIM_CLEARANCE {
                    let i = self.index(cx, cy);
                    self.mark(i);
                }
            }
        }
    }

    pub(super) fn all_seen(&self) -> bool {
        (0..(self.cols * self.rows) as usize).all(|i| self.is_seen(i))
    }

    pub(super) fn clear(&mut self) {
        for w in &mut self.seen {
            *w = 0;
        }
    }

    /// The middle of the nearest cell this bot has not been to, if any.
    ///
    /// Ties break on the lower index rather than at random, so two bots with the
    /// same coverage make the same choice — the sim is deterministic and this is
    /// read on the hot path, where a coin flip would cost a draw from the RNG
    /// and buy nothing.
    pub(super) fn nearest_unseen(&self, from: Vec2) -> Option<Vec2> {
        let mut best: Option<(f32, Vec2)> = None;
        for cy in 0..self.rows {
            for cx in 0..self.cols {
                let i = self.index(cx, cy);
                if self.is_seen(i) {
                    continue;
                }
                let c = Vec2::new(
                    (cx * BOT_EXPLORE_CELL + BOT_EXPLORE_CELL / 2) as f32,
                    (cy * BOT_EXPLORE_CELL + BOT_EXPLORE_CELL / 2) as f32,
                );
                let d = (c - from).len();
                if best.is_none_or(|(bd, _)| d < bd) {
                    best = Some((d, c));
                }
            }
        }
        best.map(|(_, c)| c)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::*;
    use super::*;

    /// Distinct `BOT_EXPLORE_CELL` cells the bots stood in over `seconds`.
    ///
    /// Sampled from the world rather than read off the bots' own grids: a
    /// coverage grid asserting on itself would pass for a grid that marks
    /// everything and a bot that never moves.
    fn cells_visited(seed: u64, scale: MapScale, n_bots: usize, seconds: f32) -> usize {
        let mut w = World::new(seed, scale);
        w.set_phase(RoundPhase::Playing);
        let mut bots = Vec::new();
        for i in 0..n_bots {
            let id = i as PlayerId;
            w.add_player(id, 0, format!("p{i}"));
            bots.push(Bot::new(id, seed, i as u32, 0.85));
        }
        let _ = w.drain_events();
        let mut seen: std::collections::BTreeSet<(i32, i32)> = std::collections::BTreeSet::new();
        let ticks = (seconds / SIM_DT) as u32;
        for t in 0..ticks {
            let now = t as f32 * SIM_DT;
            for b in bots.iter_mut() {
                let inp = b.think(&w, now, SIM_DT);
                w.queue_input(b.player, inp);
                if let Some(slot) = b.wants_select() {
                    w.select_slot(b.player, slot);
                }
                if inp.buttons & button::FIRE != 0 {
                    let _ = w.fire(b.player, now);
                }
                if let Some(slot) = b.wants_use() {
                    let _ = w.use_item(b.player, slot, now);
                }
            }
            w.step(SIM_DT);
            let _ = w.drain_events();
            for p in &w.players {
                if p.alive {
                    seen.insert((
                        p.body.pos.x as i32 / BOT_EXPLORE_CELL,
                        p.body.pos.y as i32 / BOT_EXPLORE_CELL,
                    ));
                }
            }
        }
        seen.len()
    }

    /// §E10: exploration, against the model it replaced.
    ///
    /// **The `before` numbers were measured at `9a19b2d`** — the commit before
    /// this task — with five bots at skill 0.85 for 120 simulated seconds, the
    /// same seeds, scales and sim time used here. They cannot be re-measured
    /// in-tree, because the random-spawn-point `Wander` they describe no longer
    /// exists; that is why they are written down with their provenance rather
    /// than left as a remembered figure. A metric with no control is a number.
    ///
    /// | seed / scale | before | after |
    /// |---|---|---|
    /// | 4242 small | 11 of 32 | 21 |
    /// | 4242 medium | 18 of 72 | 24 |
    /// | 31337 medium | 24 of 72 | **24 — a tie** |
    ///
    /// **Two of the three improve and the third ties**, so the assertion is a
    /// population one: no case is worse, and the total is strictly better. Said
    /// that way rather than as three wins, because it is not three wins — and a
    /// `>` on every case would have to be weakened to a `>=` to pass, which is
    /// the same thing said dishonestly.
    #[test]
    fn exploring_covers_more_map_than_the_random_wander_it_replaced() {
        const BEFORE: [(u64, MapScale, usize, &str); 3] = [
            (4242, MapScale::Small, 11, "4242 small"),
            (4242, MapScale::Medium, 18, "4242 medium"),
            (31337, MapScale::Medium, 24, "31337 medium"),
        ];
        let mut before_total = 0;
        let mut after_total = 0;
        for (seed, scale, before, label) in BEFORE {
            let after = cells_visited(seed, scale, 5, 120.0);
            assert!(
                after >= before,
                "{label}: {after} cells against {before} measured at 9a19b2d — \
                 exploration covered *less* ground than picking a random spawn point",
            );
            before_total += before;
            after_total += after;
        }
        assert!(
            after_total > before_total,
            "across all three: {after_total} cells against {before_total} at 9a19b2d — \
             no better than the model this replaced",
        );
    }

    /// The vacuity control the comparison above needs.
    ///
    /// Five bots that never moved would still occupy up to five cells, so a
    /// "more than before" comparison could in principle be satisfied by a wrong
    /// before-number rather than by movement. The floor here is **derived from
    /// the setup** — one cell per bot — rather than picked, which is the whole
    /// difference between a control and another threshold.
    #[test]
    fn bots_visit_more_cells_than_they_could_by_standing_still() {
        const N: usize = 5;
        let seen = cells_visited(SEED, MapScale::Small, N, 120.0);
        assert!(
            seen > N,
            "{N} bots reached {seen} cells in 120 s — no more than standing still would",
        );
    }

    /// T22.03B: in space a bot never explores toward the rim or the void past it —
    /// every cell whose middle is outside the arena (or within `SPACE_RIM_CLEARANCE`
    /// of the rim) starts seen, on eight maps. Control: some cells stay unseen, and a
    /// standard map pre-marks none.
    #[test]
    fn a_space_bot_never_explores_past_the_rim() {
        for seed in [1u64, 7, 42, 99, 4242, 12345, 31337, 8675309] {
            let w = World::with_gravity(
                seed,
                MapScale::Small,
                0,
                crate::constants::DEFAULT_MAP_GENERATOR,
                GravityMode::Space,
            );
            let geo = w.map.space_geometry().expect("space");
            let mut c = Coverage::new(w.map.mask.w as i32, w.map.mask.h as i32);
            c.mark_outside(&w);
            let mut open = 0;
            for cy in 0..c.rows {
                for cx in 0..c.cols {
                    if c.is_seen(c.index(cx, cy)) {
                        continue;
                    }
                    open += 1;
                    let x = (cx * BOT_EXPLORE_CELL + BOT_EXPLORE_CELL / 2) as f32;
                    let y = (cy * BOT_EXPLORE_CELL + BOT_EXPLORE_CELL / 2) as f32;
                    assert!(
                        geo.inside(x, y) && geo.distance_to_rim(x, y) >= SPACE_RIM_CLEARANCE,
                        "seed {seed}: cell ({cx}, {cy}) at ({x}, {y}) is past the rim, and unseen"
                    );
                }
            }
            assert!(
                open > 0,
                "seed {seed}: control — every cell pre-marked, nowhere to go"
            );
        }
        let w = World::for_test(SEED, MapScale::Small);
        let mut c = Coverage::new(w.map.mask.w as i32, w.map.mask.h as i32);
        c.mark_outside(&w);
        assert!(
            !c.all_seen() && c.seen.iter().all(|&b| b == 0),
            "a standard map pre-marked cells"
        );
    }
}
