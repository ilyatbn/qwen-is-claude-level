//! How a bot flies in space (T22.03B, `M22-RULINGS` R5).
//!
//! **Target selection, aiming and firing are untouched** — this is only the part
//! that turns *"I want to be over there"* into buttons, for a body nothing damps
//! (`player/space.rs` is the contract). The walking model's answers are wrong here
//! in the three ways T22.03B lists: `JUMP` in the air buys nothing, "stuck" is not
//! solved by jumping, and there is no falling to descend by.
//!
//! **The control law is a wanted velocity and the error against it**, per axis:
//! thrust while the velocity misses the wanted one by more than
//! `BOT_SPACE_DEADBAND`, and not otherwise. That one rule is R5's three sentences —
//! thrust toward where you want to go, *stop* thrusting when the velocity already
//! points there, and **thrust against your own velocity when it does not** (the
//! brake is the error's sign flipping, not a separate manoeuvre). The wanted speed
//! falls as `√(2 · BOT_SPACE_BRAKE · d)` near the destination, so a bot arrives and
//! stops instead of overshooting and oscillating — the characteristic failure of a
//! model that thrusts whenever it is not there yet.
//!
//! **Fuel is the economy.** Cruising and braking spend only above
//! `BOT_SPACE_FUEL_RESERVE`; below it a bot coasts, a well draws it onto a rock, and
//! it walks (free, R4) while the tank refills. The reserve is spent only getting out
//! of something that kills: the black hole's reach (and where it is telegraphed), a
//! vortex's no-escape disc, a flare's ribbon, a fire.

use crate::constants::{
    GravityMode, BLACK_HOLE_REACH, BOT_SPACE_BRAKE, BOT_SPACE_CRUISE, BOT_SPACE_DEADBAND,
    BOT_SPACE_FUEL_RESERVE, BOT_SPACE_HAZARD_MARGIN, PLAYER_H, SOLAR_FLARE_RIBBON_R, VORTEX_REACH,
};
use crate::math::Vec2;
use crate::player::input::button;
use crate::player::state::PlayerState;
use crate::world::World;

/// Where a flying bot is going, and how close counts as there.
#[derive(Debug, Clone, Copy)]
pub(super) struct Dest {
    pub at: Vec2,
    pub stop: f32,
}

/// Does this bot move by the space rules? The mode, and neither of the two regimes
/// that win over it (`space::floating`'s exclusions): wings fly as anywhere, and a
/// rider is the platform's. **Grounded counts** — a bot on a rock walks, but it
/// leaves the rock by this module's rules.
pub(super) fn flies(world: &World, me: &PlayerState) -> bool {
    world.gravity == GravityMode::Space && !me.move_mods().flying && me.mount.mounted.is_none()
}

/// The hazards a bot keeps out of, each as a centre and the radius it keeps clear
/// of: the black hole's reach (arrived, or telegraphed — the ring on screen says
/// where), and a live vortex's no-escape disc (`VORTEX_REACH / 2`, where thrust
/// stops beating its pull). Spent vortices do not pull; a trip is survivable, so
/// they are not worth fuel.
fn keep_out(world: &World) -> impl Iterator<Item = (Vec2, f32)> + '_ {
    let hole = [world.black_hole(), world.black_hole_warned_at()]
        .into_iter()
        .flatten()
        .map(|h| (h, BLACK_HOLE_REACH));
    let vortices = world.vortices.iter().map(|v| (v.pos, VORTEX_REACH * 0.5));
    hole.chain(vortices)
}

/// Is `at` somewhere a bot must not go? Inside a keep-out disc plus the margin.
pub(super) fn forbidden(world: &World, at: Vec2) -> bool {
    keep_out(world).any(|(c, r)| (at - c).len() < r + BOT_SPACE_HAZARD_MARGIN)
}

/// The unit direction out of the most pressing hazard at `pos`, if it is inside
/// one's margin: the black hole and vortices first (a death, a trip), then a
/// flare's ribbon, then `fire` (the nearest burning hazard, `Bot::hazard_at`'s).
///
/// **A keep-out disc is judged where the bot would stop**, not where it is: its
/// position plus its stopping distance at `BOT_SPACE_BRAKE` along its velocity. A
/// bot coasting in at a few hundred px/s crosses the margin in a fifth of a second,
/// and every black-hole death the first cut measured was one that arrived that way
/// and ran its tank dry braking inside the reach (six of six, fuel under
/// `JETPACK_MIN_FUEL_TO_ENGAGE` the tick before).
pub(super) fn escape(world: &World, pos: Vec2, vel: Vec2, fire: Option<Vec2>) -> Option<Vec2> {
    let stops_at = pos + vel * (vel.len() / (2.0 * BOT_SPACE_BRAKE));
    let away = |from: Vec2| {
        let d = pos - from;
        if d.len() > f32::EPSILON {
            d.normalized()
        } else {
            Vec2::new(1.0, 0.0)
        }
    };
    if let Some((c, _)) = keep_out(world)
        .filter(|&(c, r)| {
            let edge = r + BOT_SPACE_HAZARD_MARGIN;
            (pos - c).len() < edge || (stops_at - c).len() < edge
        })
        .min_by(|a, b| (pos - a.0).len().total_cmp(&(pos - b.0).len()))
    {
        return Some(clear_heading(world, pos, away(c)));
    }
    if let Some(ribbon) = world.flare_ribbon() {
        let near = ribbon
            .into_iter()
            .min_by(|a, b| (pos - *a).len().total_cmp(&(pos - *b).len()));
        if let Some(p) =
            near.filter(|p| (pos - *p).len() < SOLAR_FLARE_RIBBON_R + BOT_SPACE_HAZARD_MARGIN)
        {
            return Some(away(p));
        }
    }
    fire.map(away)
}

/// `dir`, or the nearest turn of it (±45°, ±90°) whose next two body lengths are
/// clear of rock. Straight away from a hole can run into a rock the hole has
/// muted (R91), and a body pressed against it thrusts its tank dry inside the reach
/// (measured: seed 7, one side of eight, 236 px from the hole after 4 s).
fn clear_heading(world: &World, pos: Vec2, dir: Vec2) -> Vec2 {
    use std::f32::consts::FRAC_PI_4;
    let open = |d: Vec2| {
        (1..=2).all(|k| {
            let p = pos + d * (k as f32 * PLAYER_H);
            !crate::physics::collide::aabb_overlaps_solid(
                &world.map,
                crate::physics::body::Body::new(p).aabb(),
            )
        })
    };
    [
        0.0,
        FRAC_PI_4,
        -FRAC_PI_4,
        2.0 * FRAC_PI_4,
        -2.0 * FRAC_PI_4,
    ]
    .into_iter()
    .map(|a| {
        let (sn, cs) = a.sin_cos();
        Vec2::new(dir.x * cs - dir.y * sn, dir.x * sn + dir.y * cs)
    })
    .find(|&d| open(d))
    .unwrap_or(dir)
}

/// The velocity a bot wants: out of a hazard at cruise, or toward `dest` at the
/// speed it can still stop from, or none. `true` with it when it is an escape.
fn wanted(
    world: &World,
    pos: Vec2,
    vel: Vec2,
    dest: Option<Dest>,
    fire: Option<Vec2>,
) -> (Vec2, bool) {
    if let Some(out) = escape(world, pos, vel, fire) {
        return (out * BOT_SPACE_CRUISE, true);
    }
    let Some(d) = dest.filter(|d| !forbidden(world, d.at)) else {
        return (Vec2::ZERO, false);
    };
    let off = d.at - pos;
    let dist = off.len();
    if dist <= d.stop {
        return (Vec2::ZERO, false);
    }
    let speed = BOT_SPACE_CRUISE.min((2.0 * BOT_SPACE_BRAKE * (dist - d.stop)).sqrt());
    (off * (speed / dist), false)
}

/// This tick's movement buttons for a bot that [`flies`].
///
/// **Grounded, it walks** (R4: free, with friction) toward the wanted velocity's
/// side, and leaves the rock upward with `UP` — the one push a grounded player may
/// buy (R42); a destination below is reached by walking off the edge. **Floating,
/// it thrusts on each axis the velocity error exceeds the dead band**, and only
/// above the fuel reserve unless it is escaping.
pub(super) fn steer(world: &World, me: &PlayerState, dest: Option<Dest>, fire: Option<Vec2>) -> u8 {
    let pos = me.body.pos;
    let (want, urgent) = wanted(world, pos, me.body.vel, dest, fire);
    let funded = urgent || me.jetpack.fuel > BOT_SPACE_FUEL_RESERVE;
    let mut b = 0u8;
    if me.body.grounded {
        let side = if want.x > BOT_SPACE_DEADBAND {
            button::RIGHT
        } else if want.x < -BOT_SPACE_DEADBAND {
            button::LEFT
        } else if want.y > BOT_SPACE_DEADBAND {
            // Straight down through the rock: walk off it, toward the destination's side.
            if dest.is_some_and(|d| d.at.x < pos.x) {
                button::LEFT
            } else {
                button::RIGHT
            }
        } else {
            0
        };
        b |= side;
        if want.y < -BOT_SPACE_DEADBAND && funded {
            b |= button::UP;
        }
        return b;
    }
    if !funded {
        return 0;
    }
    let err = want - me.body.vel;
    if err.x > BOT_SPACE_DEADBAND {
        b |= button::RIGHT;
    } else if err.x < -BOT_SPACE_DEADBAND {
        b |= button::LEFT;
    }
    if err.y < -BOT_SPACE_DEADBAND {
        b |= button::UP;
    } else if err.y > BOT_SPACE_DEADBAND {
        b |= button::DOWN;
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, DEFAULT_MAP_GENERATOR, PICKUP_RADIUS, SIM_DT, SIM_HZ};
    use crate::physics::body::Body;
    use crate::player::input::Input;
    use crate::world::RoundPhase;

    const SEEDS: [u64; 8] = [1, 7, 42, 99, 4242, 12345, 31337, 8675309];

    fn space_world(seed: u64) -> World {
        let mut w = World::with_gravity(
            seed,
            MapScale::Small,
            0,
            DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "bot".into());
        w
    }

    /// Put ana at rest at `at`, tank full.
    fn put(w: &mut World, at: Vec2) {
        let p = w.player_mut(0).expect("ana");
        p.body = Body::new(at);
        p.jetpack.fuel = crate::constants::JETPACK_MAX_FUEL;
    }

    /// A tick of `steer` toward `dest` (or of nothing, for a control).
    fn fly(w: &mut World, dest: Option<Dest>, steering: bool) {
        let b = match w.player(0) {
            Some(me) if steering && me.alive => steer(w, me, dest, None),
            _ => 0,
        };
        w.queue_input(0, Input::new(0, b, 0));
        w.step(SIM_DT);
    }

    /// Open points of the arena, body centres, clear of the rock.
    fn open_points(w: &World) -> Vec<Vec2> {
        let geo = w.map.space_geometry().expect("space");
        crate::map::gen::space::open_space_grid(&w.map.mask, &geo, &w.map.meta.asteroids)
            .into_iter()
            .map(|p| Vec2::new(p.x as f32, p.y as f32 - PLAYER_H / 2.0))
            .filter(|&p| !crate::physics::collide::aabb_overlaps_solid(&w.map, Body::new(p).aabb()))
            .collect()
    }

    /// A straight run from `a` to `b` a body can fly.
    fn clear_run(w: &World, a: Vec2, b: Vec2) -> bool {
        let n = ((b - a).len() / 4.0).ceil().max(1.0) as i32;
        (0..=n).all(|i| {
            let p = a + (b - a) * (i as f32 / n as f32);
            !crate::physics::collide::aabb_overlaps_solid(&w.map, Body::new(p).aabb())
        })
    }

    /// **A bot in space reaches where it is sent, and stops there** (R5's hazard: a
    /// bot that thrusts whenever it is not there yet overshoots and oscillates). Eight
    /// maps, from a point at rest to another ~a sight radius off across open space,
    /// wells and all. Over the last second it stays within a body of the stop radius
    /// and slow. Control, per map: it started far away, and it moved.
    #[test]
    fn a_flying_bot_arrives_and_stops() {
        let mut report = Vec::new();
        for seed in SEEDS {
            let mut w = space_world(seed);
            let pts = open_points(&w);
            let pair = pts.iter().find_map(|&a| {
                pts.iter()
                    .find(|&&b| {
                        let d = (b - a).len();
                        (0.75 * crate::constants::FOV_DAY..crate::constants::FOV_DAY).contains(&d)
                            && clear_run(&w, a, b)
                    })
                    .map(|&b| (a, b))
            });
            let Some((from, to)) = pair else {
                panic!("seed {seed}: no clear pair of open points a sight radius apart");
            };
            put(&mut w, from);
            let dest = Dest {
                at: to,
                stop: PICKUP_RADIUS * 0.5,
            };
            let secs = 6;
            let mut last = Vec::new();
            for t in 0..secs * SIM_HZ {
                fly(&mut w, Some(dest), true);
                if t >= (secs - 1) * SIM_HZ {
                    let p = w.player(0).expect("ana");
                    last.push(((p.body.pos - to).len(), p.body.vel.len()));
                }
            }
            let far = last.iter().map(|l| l.0).fold(0.0f32, f32::max);
            let fast = last.iter().map(|l| l.1).fold(0.0f32, f32::max);
            report.push((seed, (from - to).len(), far, fast));
        }
        let bad: Vec<_> = report
            .iter()
            .filter(|r| r.2 > PICKUP_RADIUS * 0.5 + PLAYER_H || r.3 > 2.0 * BOT_SPACE_DEADBAND)
            .collect();
        assert!(
            bad.is_empty(),
            "(seed, start distance, furthest over the last second, fastest) — did not arrive \
             and stop: {bad:?} of {report:?}"
        );
    }

    /// **The brake is a thrust against the bot's own velocity.** Closing on the
    /// destination at cruise from ~a braking distance out, the destination still
    /// ahead: it thrusts *backwards*. And coasting toward a far destination at cruise
    /// it thrusts not at all (R5: stop thrusting when the velocity already points
    /// where you want to go) — the fuel half of the same law.
    #[test]
    fn a_bot_closing_too_fast_thrusts_against_its_velocity() {
        let mut w = space_world(4242);
        let pts = open_points(&w);
        let at = pts[pts.len() / 2];
        put(&mut w, at);
        w.player_mut(0).expect("ana").body.vel = Vec2::new(BOT_SPACE_CRUISE, 0.0);
        let me = w.player(0).expect("ana");
        let near = Dest {
            at: at + Vec2::new(PLAYER_H, 0.0),
            stop: 0.0,
        };
        let b = steer(&w, me, Some(near), None);
        assert!(
            b & button::LEFT != 0 && b & button::RIGHT == 0,
            "closing at {BOT_SPACE_CRUISE} px/s, {PLAYER_H} px short: pressed {b:#010b}, not LEFT"
        );
        let far = Dest {
            at: at + Vec2::new(10.0 * crate::constants::FOV_DAY, 0.0),
            stop: 0.0,
        };
        let b = steer(&w, me, Some(far), None);
        assert_eq!(
            b & (button::LEFT | button::RIGHT),
            0,
            "already at cruise toward a far destination, it still thrusts: {b:#010b}"
        );
    }

    /// **Out of the black hole's reach, not into it** (T22.12C F2). Placed at rest
    /// inside the reach (outside the horizon, where every thrust escapes, R90), sent
    /// toward the hole: it leaves and lives, on eight maps × eight sides. Control: the
    /// same bodies pressing nothing die in it — the pull is real at that spot.
    #[test]
    fn a_flying_bot_leaves_the_black_holes_reach() {
        let (mut escaped, mut died_idle, mut runs) = (0, 0, 0);
        let mut stuck = Vec::new();
        for seed in SEEDS {
            for steering in [true, false] {
                for k in 0..8 {
                    let mut w = space_world(seed);
                    let geo = w.map.space_geometry().expect("space");
                    let Some(hole) = w.summon_black_hole_near(Vec2::new(geo.cx, geo.cy), 0.0)
                    else {
                        continue;
                    };
                    let dir = Vec2::from_angle(k as f32 * std::f32::consts::TAU / 8.0);
                    let at = hole + dir * (0.8 * BLACK_HOLE_REACH);
                    if crate::physics::collide::aabb_overlaps_solid(&w.map, Body::new(at).aabb()) {
                        continue;
                    }
                    put(&mut w, at);
                    let dest = Dest {
                        at: hole,
                        stop: 0.0,
                    };
                    for _ in 0..4 * SIM_HZ {
                        fly(&mut w, Some(dest), steering);
                    }
                    let p = w.player(0).expect("ana");
                    if steering {
                        runs += 1;
                        let out = p.alive && (p.body.pos - hole).len() > BLACK_HOLE_REACH;
                        escaped += u32::from(out);
                        if !out {
                            stuck.push((
                                seed,
                                k,
                                p.alive,
                                p.deaths,
                                (p.body.pos - hole).len(),
                                p.body.grounded,
                                p.jetpack.fuel,
                            ));
                        }
                    } else {
                        died_idle += u32::from(p.deaths > 0 || !p.alive);
                    }
                }
            }
        }
        assert!(runs > 0, "premise: no placement fitted");
        assert_eq!(
            escaped, runs,
            "{escaped} of {runs} steered bots got out of the reach alive; \
             (seed, side, alive, deaths, distance, grounded, fuel) of the rest: {stuck:?}"
        );
        assert!(
            died_idle * 2 > runs,
            "control: only {died_idle} of {runs} idle bodies died there — the pull did not bite"
        );
    }

    /// The telegraph counts: where the hole *will* open is kept out of (and flown out
    /// of) exactly like where it is. Control: before the warning, nothing.
    #[test]
    fn the_telegraphed_hole_is_already_a_keep_out() {
        let mut w = space_world(4242);
        let geo = w.map.space_geometry().expect("space");
        let centre = Vec2::new(geo.cx, geo.cy);
        let before = w.black_hole_warned_at();
        assert!(before.is_none(), "premise: no warning yet");
        let warned = w.warn_black_hole_near(centre, 0.0).expect("warned");
        assert!(
            w.black_hole().is_none(),
            "premise: telegraphed, not arrived"
        );
        let inside = warned + Vec2::new(BLACK_HOLE_REACH * 0.5, 0.0);
        let out =
            escape(&w, inside, Vec2::ZERO, None).expect("no escape from the telegraphed reach");
        assert!(
            out.x > 0.9,
            "the escape points {out:?}, not away from the hole"
        );
        assert!(
            forbidden(&w, warned),
            "the telegraphed hole is not forbidden"
        );
        let far = warned + Vec2::new(BLACK_HOLE_REACH + 2.0 * BOT_SPACE_HAZARD_MARGIN, 0.0);
        assert!(
            escape(&w, far, Vec2::ZERO, None).is_none() && !forbidden(&w, far),
            "control: far away is fine"
        );
    }

    /// **A flare's ribbon is flown away from** — the direction out of it at a point
    /// just off the ribbon, and nothing a margin further out. Control: no flare, no
    /// escape at the same point.
    #[test]
    fn a_bot_near_a_flare_ribbon_flies_away_from_it() {
        use crate::constants::EFFECT_TELEGRAPH;
        use crate::weapons::explode::EffectKind;
        let mut w = space_world(4242);
        w.weather_mode = crate::world::WeatherMode::Off;
        let now = w.round_time;
        w.force_effect(EffectKind::SolarFlare, now);
        for _ in 0..((EFFECT_TELEGRAPH + 1.0) * SIM_HZ as f32) as u32 {
            w.step(SIM_DT);
        }
        let ribbon = w.flare_ribbon().expect("the flare burns");
        let mid = ribbon[ribbon.len() / 2];
        let prev = ribbon[ribbon.len() / 2 - 1];
        // Off the ribbon, across it.
        let along = (mid - prev).normalized();
        let across = Vec2::new(-along.y, along.x);
        let near = mid + across * (SOLAR_FLARE_RIBBON_R + BOT_SPACE_HAZARD_MARGIN * 0.5);
        let out = escape(&w, near, Vec2::ZERO, None).expect("no escape beside the ribbon");
        let nearest = ribbon
            .iter()
            .copied()
            .min_by(|a, b| (near - *a).len().total_cmp(&(near - *b).len()))
            .expect("points");
        assert!(
            out.dot(near - nearest) > 0.0,
            "the escape {out:?} points toward the ribbon (nearest {nearest:?} from {near:?})"
        );
        let mut quiet = space_world(4242);
        quiet.weather_mode = crate::world::WeatherMode::Off;
        assert!(
            quiet.flare_ribbon().is_none() && escape(&quiet, near, Vec2::ZERO, None).is_none(),
            "control: no flare, yet an escape"
        );
    }
}
