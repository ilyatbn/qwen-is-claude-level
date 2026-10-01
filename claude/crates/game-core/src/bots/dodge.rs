//! T23.26C item 1 (`docs/78` §A3) — **meteors are dodged on the move, not hidden from.**
//!
//! The owner, watching T23.26's cover: *"they should still be moving and attempting to
//! dodge meteors (not always succeeding)"*. So a shower changes nothing about a bot's
//! goal. What it adds is a sidestep: every meteor and fragment in flight is flown
//! forward through the same gravity the projectile step applies, and one that will burst
//! within reach of the body inside `BOT_DODGE_HORIZON` sends the bot sideways, away from
//! where it lands — for as long as the threat lasts, and then the route resumes.
//!
//! **Imperfect on purpose, and by a measured knob rather than a dice roll.** A bot sees a
//! meteor only once it has been falling for its `lag` (skill-scaled:
//! `BOT_DODGE_LAG_MIN` at full skill, `+ BOT_DODGE_LAG_SPAN` at none), so a meteor that
//! lands sooner than the lag plus the time to walk clear still hits. Nothing random:
//! the same round dodges the same way in a replay.

use crate::constants::{
    BOT_DODGE_HORIZON, BOT_DODGE_LAG_MIN, BOT_DODGE_LAG_SPAN, BOT_DODGE_MARGIN, BOT_NAV_CELL,
    GRAVITY, PLAYER_H, PLAYER_W, SIM_DT,
};
use crate::effects::meteor::MeteorShower;
use crate::math::Vec2;
use crate::player::input::button;
use crate::player::state::PlayerState;
use crate::world::World;

/// The prediction's step, px of flight: half a body's width, so a flight is never
/// stepped over a body or through a floor (a fixed two-tick step skipped a 24 px shelf at
/// a falling meteor's speed on alternate ticks, and the bot flickered between dodging and
/// not — measured, it crept 7 px in half a second).
const STEP_PX: f32 = PLAYER_W * 0.5;

/// The seconds a bot of `skill` takes to notice a meteor.
pub(super) fn lag(skill: f32) -> f32 {
    BOT_DODGE_LAG_MIN + (1.0 - skill.clamp(0.0, 1.0)) * BOT_DODGE_LAG_SPAN
}

/// How far from a burst of `blast` radius a body's middle must be to take none of it:
/// the radius, half a body, and `BOT_DODGE_MARGIN` — the blast's edge still bit a body
/// stopped exactly at radius + half a body (measured: 3.6 hp, the dodge test's first run).
pub(super) fn reach(blast: f32) -> f32 {
    blast + PLAYER_H * 0.5 + BOT_DODGE_MARGIN
}

/// Where the nearest-in-time meteor or fragment the bot has noticed will burst within
/// reach of it, inside `BOT_DODGE_HORIZON`: `(burst point, its reach)`. `None` with
/// nothing coming — or under a roof, where a meteor's blast is not dealt (§E13,
/// `effects::under_a_roof`).
pub(super) fn incoming(world: &World, me: &PlayerState, lag: f32, now: f32) -> Option<(Vec2, f32)> {
    let pos = me.body.pos;
    if crate::effects::under_a_roof(&world.map, pos) {
        return None;
    }
    let g = GRAVITY * world.gravity.scale();
    let mut best: Option<(f32, Vec2, f32)> = None;
    for p in world.projectiles.iter() {
        if !MeteorShower::owns(p.weapon) || now - p.spawned_at < lag {
            continue;
        }
        let Some(def) = crate::weapons::defs::def(p.weapon) else {
            continue;
        };
        // The burst is where the flight first meets rock or a body.
        let reach = reach(def.blast_radius);
        let gy = g * def.gravity_scale;
        // Cheap rejects first: a flight whose x never comes within reach of the body, or
        // that cannot fall as far as the body inside the horizon, is no threat.
        let h = BOT_DODGE_HORIZON;
        let (x0, x1) = (p.pos.x, p.pos.x + p.vel.x * h);
        if pos.x < x0.min(x1) - reach || pos.x > x0.max(x1) + reach {
            continue;
        }
        if pos.y - p.pos.y > p.vel.y.max(0.0) * h + 0.5 * gy * h * h + reach {
            continue;
        }
        let (mut at, mut v) = (p.pos, p.vel);
        let mut t = 0.0;
        while t < h {
            let step = (STEP_PX / v.len().max(1.0)).min(SIM_DT);
            v.y += gy * step;
            at += v * step;
            t += step;
            let into_body = (at - pos).len() < PLAYER_H * 0.5 + PLAYER_W * 0.5;
            let into_rock = world.map.mask.get(at.x as i32, at.y as i32);
            if into_body || into_rock {
                if (at - pos).len() < reach && best.is_none_or(|(bt, ..)| t < bt) {
                    best = Some((t, at, reach));
                }
                break;
            }
        }
    }
    best.map(|(_, at, r)| (at, r))
}

/// The sideways button that takes a body at `pos` out of a burst at `at` of `reach` —
/// the nearer edge, unless a step that way is into the void or a wall, then the other.
/// `None` when both ways are shut.
pub(super) fn away(world: &World, pos: Vec2, at: Vec2, reach: f32) -> Option<u8> {
    let grid = super::nav::Grid::new(&world.map);
    let open = |dir: f32| {
        let ahead = Vec2::new(pos.x + dir * BOT_NAV_CELL, pos.y);
        !grid.over_void(ahead) && !world.map.mask.get(ahead.x as i32, pos.y as i32)
    };
    // Distance to clear each way: the burst's reach past the body, from where it is.
    let off = pos.x - at.x;
    let (left, right) = (reach + off, reach - off);
    let (first, second) = if left <= right {
        ((-1.0, button::LEFT), (1.0, button::RIGHT))
    } else {
        ((1.0, button::RIGHT), (-1.0, button::LEFT))
    };
    [first, second]
        .into_iter()
        .find(|&(d, _)| open(d))
        .map(|(_, b)| b)
}
