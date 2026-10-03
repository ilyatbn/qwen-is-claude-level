//! The goal test and the moves out of a node — walk, hop, fall, jet, fly, dig, ride (T23.26B split of `nav.rs`).

#[allow(unused_imports)]
use super::*;

/// Is node `(x, y)` what `want` asks for? The search's goal test, and the follower's
/// check that a bot already in cover still is (T23.26 C).
pub(in crate::bots) fn satisfies(grid: &Grid, want: Want, x: i32, y: i32) -> bool {
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

/// T23.26C item 3 (`docs/78` §A3: "a bot with wings hunts and shops with them"): every
/// move out of node `(x, y)` for a winged body. Wings hover with no input, climb and
/// descend at `WINGS_FLY_SPEED` and move sideways at the walk times `WINGS_SPEED_MULT`
/// (`movement::apply_flight`), with no fuel and no fall — so the air is all one cheap
/// medium, and the two axes run at once (a diagonal costs the slower of the two). Dig
/// edges as the walker's, hovering while the swing works.
pub(super) fn fly_successors(
    g: &Grid,
    x: i32,
    y: i32,
    fuel: f32,
    dig: bool,
    out: &mut Vec<(i32, i32, Move, f32, f32)>,
) {
    let across = BOT_NAV_CELL / (WALK_SPEED * WINGS_SPEED_MULT);
    let up = BOT_NAV_CELL / WINGS_FLY_SPEED;
    for dy in -1..=1 {
        for dx in -1..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let (nx, ny) = (x + dx, y + dy);
            let secs = (across * dx.abs() as f32).max(up * dy.abs() as f32);
            if g.node(nx, ny) && (dx == 0 || dy == 0 || (g.node(nx, y) && g.node(x, ny))) {
                out.push((nx, ny, Move::Fly, secs, fuel));
            } else if dig && (dx == 0 || dy == 0) && g.diggable(nx, ny) == Some(true) {
                out.push((nx, ny, Move::Dig, BOT_NAV_DIG_S + secs, fuel));
            }
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
pub(in crate::bots) fn successors(
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
