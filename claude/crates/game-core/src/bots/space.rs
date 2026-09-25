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
//! of something that kills or takes: the black hole's reach (and where it is
//! telegraphed), a live vortex's pull, a spent vortex's mouth, a flare's ribbon, a fire
//! — each asked through the world's own predicate (`KeepOut`, T22.14B).

use crate::constants::{
    GravityMode, BOT_SPACE_BRAKE, BOT_SPACE_BURN_MARGIN, BOT_SPACE_CRUISE, BOT_SPACE_DEADBAND,
    BOT_SPACE_DETOUR, BOT_SPACE_FUEL_RESERVE, BOT_SPACE_HAZARD_MARGIN, BOT_SPACE_STUCK_SPEED,
    BOT_SPACE_STUCK_WINDOW, PLAYER_H, PLAYER_W,
};
use crate::effects::flare;
use crate::math::Vec2;
use crate::player::input::button;
use crate::player::state::PlayerState;
use crate::world::vortex::{self, Vortex};
use crate::world::{black_hole, World};

/// Where a flying bot is going, and how close counts as there.
#[derive(Debug, Clone, Copy)]
pub(super) struct Dest {
    pub at: Vec2,
    pub stop: f32,
}

/// What a flying bot remembers between ticks (T22.03D): how long it has been
/// **blocked** — airborne, pressed against rock, not moving, while it wants to —
/// and the detour it is holding off that rock.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct Flight {
    /// The life this memory belongs to (`PlayerState::deaths`): a respawned bot
    /// starts clean, not holding a dead body's detour (T22.03E F6).
    life: u16,
    blocked_for: f32,
    /// The heading, the time left on it, and whether it is an **escape's** detour —
    /// an escape is never cut short by a later escape, but a destination's detour
    /// is dropped the tick an escape starts (T22.03E F6).
    detour: Option<(Vec2, f32, bool)>,
    /// Detours taken since the bot last left the rock: each one takes the next
    /// clear heading, so a heading that turned out not to fly (two wells' pull
    /// beating the thrust down a crevice, measured) is not taken forever.
    tries: usize,
}

/// Is the body's box, grown by a pixel, into rock? Touching, not overlapping.
fn touches_rock(world: &World, me: &PlayerState) -> bool {
    let a = me.body.aabb();
    crate::physics::collide::aabb_overlaps_solid(
        &world.map,
        crate::math::Aabb::from_center_size(a.center, a.width() + 2.0, a.height() + 2.0),
    )
}

/// Does this bot move by the space rules? The mode, and neither of the two regimes
/// that win over it (`space::floating`'s exclusions): wings fly as anywhere, and a
/// rider is the platform's. **Grounded counts** — a bot on a rock walks, but it
/// leaves the rock by this module's rules.
pub(super) fn flies(world: &World, me: &PlayerState) -> bool {
    world.gravity == GravityMode::Space && !me.move_mods().flying && me.mount.mounted.is_none()
}

/// One thing a bot keeps out of, and **the world's own predicate for how far a point is
/// outside it** (T22.14B: the bots carried copies of each hazard's geometry, and a copy is
/// a guard one side drops — the spent vortices were the one they dropped).
#[derive(Debug, Clone, Copy)]
enum KeepOut {
    /// The black hole's reach, arrived or telegraphed (`World::black_hole_site`, the ring
    /// on screen says where): `black_hole::clearance`.
    Hole(Vec2),
    /// A live vortex: the reach of its pull (`vortex::pull_clearance`). **T22.14B M5**:
    /// the margin used to be `VORTEX_REACH / 2` (the half-reach the trip destination is
    /// held to), where the pull is already the cap — a bot that stopped at that edge held
    /// station on thrust, spent its reserve, and was taken dry: 69 of 125 trips over 32
    /// seeds were a bot with a dry tank a second before (`gate-t2214b-*.txt`).
    Live(Vortex),
    /// A spent vortex: it pulls nothing but still catches (R88) — its capture radius
    /// (`vortex::capture_clearance`). The bots skipped these outright.
    Spent(Vortex),
}

impl KeepOut {
    fn centre(self) -> Vec2 {
        match self {
            KeepOut::Hole(h) => h,
            KeepOut::Live(v) | KeepOut::Spent(v) => v.pos,
        }
    }

    /// How far `at` is outside it, px (negative inside) — the world's number.
    fn clearance(self, at: Vec2) -> f32 {
        match self {
            KeepOut::Hole(h) => black_hole::clearance(Some(h), at),
            KeepOut::Live(v) => vortex::pull_clearance(&v, at),
            KeepOut::Spent(v) => vortex::capture_clearance(&v, at),
        }
    }

    /// Is `at` inside it, or within `BOT_SPACE_HAZARD_MARGIN` of its edge?
    fn near(self, at: Vec2) -> bool {
        self.clearance(at) < BOT_SPACE_HAZARD_MARGIN
    }
}

/// Every keep-out on the map now.
fn keep_outs(world: &World) -> impl Iterator<Item = KeepOut> + '_ {
    let hole = world.black_hole_site().map(KeepOut::Hole);
    let live = world.vortices.iter().copied().map(KeepOut::Live);
    let spent = world.spent_vortices.iter().copied().map(KeepOut::Spent);
    hole.into_iter().chain(live).chain(spent)
}

/// Is `at` somewhere a bot must not go? Inside a keep-out plus the margin.
pub(super) fn forbidden(world: &World, at: Vec2) -> bool {
    keep_outs(world).any(|k| k.near(at))
}

/// The step `approach` walks a line at, px — two sweep steps; a keep-out's edge is
/// found to within it.
const APPROACH_STEP: f32 = 2.0 * CLEAR_STEP;

/// **Where to fly for `at`** (T22.14B M1): `at` itself, or — when it lies in a keep-out
/// — the last point before the first keep-out on the straight line from `pos`. A
/// destination in a keep-out used to be refused outright, and a bot whose enemy stood
/// near a vortex or the black hole floated pressing nothing (65 % of the ticks its
/// destination was forbidden, 8 seeds). It now closes to the edge and holds there, facing
/// the enemy. `pos` inside a keep-out is [`escape`]'s, and never reaches here.
pub(super) fn approach(world: &World, pos: Vec2, at: Vec2) -> Vec2 {
    if !forbidden(world, at) {
        return at;
    }
    let off = at - pos;
    let n = (off.len() / APPROACH_STEP).ceil().max(1.0) as i32;
    (1..=n)
        .map(|k| pos + off * (k as f32 / n as f32))
        .take_while(|&p| !forbidden(world, p))
        .last()
        .unwrap_or(pos)
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
    if let Some(k) = keep_outs(world)
        .filter(|k| k.near(pos) || k.near(stops_at))
        .min_by(|a, b| {
            (pos - a.centre())
                .len()
                .total_cmp(&(pos - b.centre()).len())
        })
    {
        return Some(clear_heading(world, pos, away(k.centre())));
    }
    // The flare: the world's contact test, asked of the body's box grown by the margin
    // on every side, the telegraph included (`World::flare_ribbon`).
    if let Some(ribbon) = world.flare_ribbon() {
        let grow = 2.0 * BOT_SPACE_HAZARD_MARGIN;
        if let Some(p) = flare::ribbon_touches(&ribbon, pos, PLAYER_W + grow, PLAYER_H + grow) {
            return Some(clear_heading(world, pos, away(p)));
        }
    }
    fire.map(|f| clear_heading(world, pos, away(f)))
}

/// The sweep step `clear_heading` tests a heading at, px: a pixel past touching
/// on the first step, and fine enough that no rock the mask can hold is skipped.
const CLEAR_STEP: f32 = 2.0;

/// `dir`, or the nearest turn of it (±45°, ±90°, ±135°, back) whose next two body
/// lengths are clear of rock. (The last three are T22.03D's: a bot pressed against
/// a round rock with its destination straight behind it has both tangents curving
/// into the rock, and the only clear heading is off the face.) Straight away from a hole can run into a rock the hole has
/// muted (R91), and a body pressed against it thrusts its tank dry inside the reach
/// (measured: seed 7, one side of eight, 236 px from the hole after 4 s).
fn clear_heading(world: &World, pos: Vec2, dir: Vec2) -> Vec2 {
    clear_headings(world, pos, dir).next().unwrap_or(dir)
}

/// The sweep's steps: two body lengths at `CLEAR_STEP`.
fn sweep_steps() -> i32 {
    (2.0 * PLAYER_H / CLEAR_STEP).ceil() as i32
}

/// Is a body's box at `p` clear of rock?
fn box_clear(world: &World, p: Vec2) -> bool {
    !crate::physics::collide::aabb_overlaps_solid(
        &world.map,
        crate::physics::body::Body::new(p).aabb(),
    )
}

/// Every clear turn of `dir`, nearest first and **lazily** — [`clear_heading`]
/// takes the first and sweeps no further (T22.03E F1); a detour that must try the
/// next when one does not fly walks on.
fn clear_headings(world: &World, pos: Vec2, dir: Vec2) -> impl Iterator<Item = Vec2> + '_ {
    // Swept, not sampled at whole body lengths (T22.03D): a body under a thin
    // overhang found "up" open because the box one length up had cleared it, and
    // thrust into the overhang for a second at a time (`gate-t2203d-*.txt`).
    let steps = sweep_steps();
    turns(dir)
        .filter(move |&d| (1..=steps).all(|k| box_clear(world, pos + d * (k as f32 * CLEAR_STEP))))
}

/// For a body **already overlapping rock**, whose every sweep fails on its first
/// step: the turn of `dir` that is out of the rock soonest — the first step at
/// which the box is clear — or `None` if no turn clears it within the sweep
/// (T22.03E F6: such a body counted a detour try every window forever, each one
/// "the next clear heading" of an empty list, i.e. `want` again).
fn way_out(world: &World, pos: Vec2, dir: Vec2) -> Option<Vec2> {
    let steps = sweep_steps();
    turns(dir)
        .filter_map(|d| {
            (1..=steps)
                .find(|&k| box_clear(world, pos + d * (k as f32 * CLEAR_STEP)))
                .map(|k| (k, d))
        })
        .min_by_key(|&(k, _)| k)
        .map(|(_, d)| d)
}

/// `dir` and its turns, nearest first: 0, ±45°, ±90°, ±135°, back.
pub(super) fn turns(dir: Vec2) -> impl Iterator<Item = Vec2> {
    use std::f32::consts::FRAC_PI_4;
    [0.0, 1.0, -1.0, 2.0, -2.0, 3.0, -3.0, 4.0]
        .into_iter()
        .map(move |k: f32| {
            let (sn, cs) = (k * FRAC_PI_4).sin_cos();
            Vec2::new(dir.x * cs - dir.y * sn, dir.x * sn + dir.y * cs)
        })
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
    let Some(d) = dest else {
        return (Vec2::ZERO, false);
    };
    let off = approach(world, pos, d.at) - pos;
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
///
/// **Fuel has hysteresis** (T22.03D F1a): a burn *starts* only with
/// `BOT_SPACE_BURN_MARGIN` above the reserve and, once going, runs down to it.
/// **Rock has a detour** (F1b): airborne, touching rock, slower than
/// `BOT_SPACE_STUCK_SPEED` while wanting to move, for `BOT_SPACE_STUCK_WINDOW`, the
/// bot flies the nearest clear turn of where it wanted to go (`clear_heading`, the
/// escape's) for `BOT_SPACE_DETOUR` — the walking model's stuck-jump, for a body
/// that a well holds against the face it is pushing into.
pub(super) fn steer(
    world: &World,
    me: &PlayerState,
    dest: Option<Dest>,
    fire: Option<Vec2>,
    flight: &mut Flight,
    dt: f32,
) -> u8 {
    let pos = me.body.pos;
    let (mut want, urgent) = wanted(world, pos, me.body.vel, dest, fire);
    // A new life starts with no memory of the last one's rock (T22.03E F6).
    if flight.life != me.deaths {
        *flight = Flight {
            life: me.deaths,
            ..Flight::default()
        };
    }
    // **An escape outranks a destination's detour** (T22.03E F6): a bot a second
    // into flying round a rock toward its enemy must not fly on into the black
    // hole's reach, a fire or a flare that appeared meanwhile.
    if urgent && flight.detour.is_some_and(|(_, _, escaping)| !escaping) {
        flight.detour = None;
    }
    // An escape is detoured too: straight out of a fire can be straight into the
    // rock the bot is pressed against, and an urgent thrust into rock spends the
    // reserve to nothing (a bot held 35 s at an empty tank, `gate-t2203d-*.txt`).
    if me.body.grounded {
        *flight = Flight {
            life: me.deaths,
            ..Flight::default()
        };
    } else if let Some((dir, left, escaping)) = flight.detour {
        want = dir * BOT_SPACE_CRUISE;
        flight.detour = (left > dt).then_some((dir, left - dt, escaping));
    } else {
        let touching = touches_rock(world, me);
        if !touching {
            flight.tries = 0;
        }
        let blocked = touching
            && want.len() > BOT_SPACE_DEADBAND
            && me.body.vel.len() < BOT_SPACE_STUCK_SPEED;
        flight.blocked_for = if blocked {
            flight.blocked_for + dt
        } else {
            0.0
        };
        if flight.blocked_for > BOT_SPACE_STUCK_WINDOW {
            flight.blocked_for = 0.0;
            let open: Vec<Vec2> = clear_headings(world, pos, want.normalized()).collect();
            // Each try takes the next clear heading; a body inside rock has none,
            // and takes the way out instead, without counting a try — or, with no
            // way out in reach, no detour at all (T22.03E F6).
            let dir = if open.is_empty() {
                way_out(world, pos, want.normalized())
            } else {
                flight.tries += 1;
                Some(open[(flight.tries - 1) % open.len()])
            };
            if let Some(dir) = dir {
                flight.detour = Some((dir, BOT_SPACE_DETOUR, urgent));
                want = dir * BOT_SPACE_CRUISE;
            }
        }
    }
    // **The margin is for leaving rock.** The pinning was a bot on a rock face at
    // the reserve buying one tick of thrust, falling under it and being drawn back;
    // clear of rock, a burn above the reserve is a brake or a correction that must
    // not wait for the margin — applied there too, two maps of eight coasted
    // 50–70 px past their destination at 250 px/s (`a_flying_bot_arrives_and_stops`),
    // and exempting only brakes let the one-tick burns back (at the reserve
    // 1.5 → 4.1–4.9 %, measured).
    // **An escape from rock waits for the margin too**: a bot pressed into a crevice
    // inside a vortex's margin spent every drop the moment it refilled past
    // `JETPACK_MIN_FUEL_TO_ENGAGE` and never moved (35 s at an empty tank, measured);
    // a burst of `BOT_SPACE_BURN_MARGIN` can.
    let fuel = me.jetpack.fuel;
    let may_start = me.jetpack.active
        || !touches_rock(world, me)
        || fuel > BOT_SPACE_FUEL_RESERVE + BOT_SPACE_BURN_MARGIN;
    let funded = may_start && (urgent || fuel > BOT_SPACE_FUEL_RESERVE);
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
    use crate::constants::{
        MapScale, BLACK_HOLE_REACH, DEFAULT_MAP_GENERATOR, PICKUP_RADIUS, SIM_DT, SIM_HZ,
        SOLAR_FLARE_RIBBON_R,
    };
    use crate::physics::body::Body;
    use crate::player::input::Input;
    use crate::world::RoundPhase;

    const SEEDS: [u64; 8] = [1, 7, 42, 99, 4242, 12345, 31337, 8675309];

    fn space_world(seed: u64) -> World {
        space_world_on(seed, MapScale::Small)
    }

    fn space_world_on(seed: u64, scale: MapScale) -> World {
        let mut w = World::with_gravity(seed, scale, 0, DEFAULT_MAP_GENERATOR, GravityMode::Space);
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
    fn fly(w: &mut World, dest: Option<Dest>, steering: bool, flight: &mut Flight) {
        let b = match w.player(0) {
            Some(me) if steering && me.alive => steer(w, me, dest, None, flight, SIM_DT),
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
    /// and under `BOT_SPACE_DEADBAND`; **and at no tick of the run is it further past
    /// the destination along its approach than that** (T22.03D F3 — the overshoot
    /// itself, which the last-second window cannot see if it swings back in time).
    ///
    /// **What removing the √(2·brake·d) profile does, measured** (T22.03D): not an
    /// overshoot — braking from cruise takes ~18–22 px at 900–1100 px/s², so the
    /// furthest-past is 11.7 px with the profile and 17.0 without, also 7–10 px flying
    /// *up* under a rock where the brake is weakest. It is the **arrival jitter**: the
    /// fastest over the last second is 18.6–20.2 px/s with the profile and 35–64
    /// without, so the speed bound is `BOT_SPACE_DEADBAND` (it was twice that, which
    /// the plant passed). Control, per map: it started far away, and it moved.
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
            let mut flight = Flight::default();
            // T22.03D F3: how far past the destination along the approach it ever
            // got — the overshoot itself, over the whole run, not only its end.
            let along = (to - from).normalized();
            let mut over = f32::MIN;
            for t in 0..secs * SIM_HZ {
                fly(&mut w, Some(dest), true, &mut flight);
                let p = w.player(0).expect("ana");
                over = over.max((p.body.pos - to).dot(along));
                if t >= (secs - 1) * SIM_HZ {
                    last.push(((p.body.pos - to).len(), p.body.vel.len()));
                }
            }
            let far = last.iter().map(|l| l.0).fold(0.0f32, f32::max);
            let fast = last.iter().map(|l| l.1).fold(0.0f32, f32::max);
            report.push((seed, (from - to).len(), far, fast, over));
        }
        let bad: Vec<_> = report
            .iter()
            .filter(|r| {
                r.2 > PICKUP_RADIUS * 0.5 + PLAYER_H
                    || r.3 > BOT_SPACE_DEADBAND
                    || r.4 > PICKUP_RADIUS * 0.5 + PLAYER_H
            })
            .collect();
        assert!(
            bad.is_empty(),
            "(seed, start distance, furthest over the last second, fastest, furthest past the \
             destination along the approach) — overshot, or did not arrive and stop: {bad:?} \
             of {report:?}"
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
        let b = steer(&w, me, Some(near), None, &mut Flight::default(), SIM_DT);
        assert!(
            b & button::LEFT != 0 && b & button::RIGHT == 0,
            "closing at {BOT_SPACE_CRUISE} px/s, {PLAYER_H} px short: pressed {b:#010b}, not LEFT"
        );
        let far = Dest {
            at: at + Vec2::new(10.0 * crate::constants::FOV_DAY, 0.0),
            stop: 0.0,
        };
        let b = steer(&w, me, Some(far), None, &mut Flight::default(), SIM_DT);
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
    ///
    /// *T22.18: on Large maps.* At R106's reach (512) 0.8 of it is 410 px — past a
    /// Small arena's rim above and below a central hole (the centreline is 400 px from
    /// the middle), so those starts sat in the void and died before any steering, and
    /// "out of the reach" upward or downward was outside the rim. The escape flights in
    /// `black_hole.rs` moved to Large for the same reason.
    #[test]
    fn a_flying_bot_leaves_the_black_holes_reach() {
        let (mut escaped, mut died_idle, mut runs) = (0, 0, 0);
        let mut stuck = Vec::new();
        for seed in SEEDS {
            for steering in [true, false] {
                for k in 0..8 {
                    let mut w = space_world_on(seed, MapScale::Large);
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
                    let mut flight = Flight::default();
                    for _ in 0..4 * SIM_HZ {
                        fly(&mut w, Some(dest), steering, &mut flight);
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
        // Half-way out on a bearing whose straight run away from the hole is clear
        // rock-free air for four body heights — searched for, not assumed (T22.17: the
        // fixed bearing +x had a rock across it once R103/R104 moved the map, and
        // `clear_heading` rightly turned 45° off it). The claim is the keep-out's, not
        // the rock-dodge's, so the bearing is one with nothing to dodge.
        let clear_run = |p: Vec2, dir: Vec2| {
            (0..=(4.0 * PLAYER_H / 2.0) as i32).all(|k| {
                !crate::physics::collide::aabb_overlaps_solid(
                    &w.map,
                    Body::new(p + dir * (k as f32 * 2.0)).aabb(),
                )
            })
        };
        let (inside, dir) = (0..16)
            .map(|k| {
                let a = k as f32 * std::f32::consts::TAU / 16.0;
                let dir = Vec2::new(a.cos(), a.sin());
                (warned + dir * (BLACK_HOLE_REACH * 0.5), dir)
            })
            .find(|&(p, dir)| clear_run(p, dir))
            .expect("a clear bearing out of the telegraphed reach");
        let out =
            escape(&w, inside, Vec2::ZERO, None).expect("no escape from the telegraphed reach");
        assert!(
            out.dot(dir) > 0.9,
            "the escape points {out:?}, not away from the hole along {dir:?}"
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

    /// **T22.14B M1: a destination in a keep-out is closed on to its edge, not refused.**
    /// `wanted` returned no velocity at all for a destination inside one, so a bot whose
    /// enemy stood near a vortex floated pressing nothing. Eight maps: a clear run from
    /// `from` to `to`, a live vortex placed a pull's reach past `to` (so `to` is in its
    /// keep-out and `from` is not); 6 s of steering. It arrives at `approach`'s point and
    /// holds there, and it never enters the pull. Premise per map: `to` forbidden, `from`
    /// and the approach point not.
    #[test]
    fn a_flying_bot_closes_on_a_destination_in_a_keep_out_to_its_edge() {
        use crate::constants::VORTEX_REACH;
        let mut bad = Vec::new();
        for seed in SEEDS {
            let mut w = space_world(seed);
            let pts = open_points(&w);
            let Some((from, to)) = pts.iter().find_map(|&a| {
                pts.iter()
                    .find(|&&b| {
                        let d = (b - a).len();
                        (0.75 * crate::constants::FOV_DAY..crate::constants::FOV_DAY).contains(&d)
                            && clear_run(&w, a, b)
                    })
                    .map(|&b| (a, b))
            }) else {
                panic!("seed {seed}: no clear pair of open points a sight radius apart");
            };
            let along = (to - from).normalized();
            let v = to + along * VORTEX_REACH;
            let mut seq = 0;
            let _ = vortex::open(&mut w.vortices, &mut seq, v);
            let edge = approach(&w, from, to);
            assert!(
                forbidden(&w, to) && !forbidden(&w, from) && !forbidden(&w, edge),
                "seed {seed}: premise — the destination in the keep-out, the start and the edge not"
            );
            put(&mut w, from);
            let dest = Dest {
                at: to,
                stop: PICKUP_RADIUS * 0.5,
            };
            let mut flight = Flight::default();
            let mut nearest = f32::INFINITY;
            for _ in 0..6 * SIM_HZ {
                fly(&mut w, Some(dest), true, &mut flight);
                let p = w.player(0).expect("ana");
                nearest = nearest.min((p.body.pos - v).len());
            }
            let p = w.player(0).expect("ana");
            // Where it holds is `approach`'s point **from where it is** — a well may slide
            // it along the edge inside the dead band (the arrival jitter
            // `a_flying_bot_arrives_and_stops` bounds), and the point slides with it.
            let short = (p.body.pos - approach(&w, p.body.pos, to)).len();
            let off_edge = (p.body.pos - v).len() - (edge - v).len();
            if short > dest.stop + PLAYER_H
                || off_edge > dest.stop + PLAYER_H
                || nearest < VORTEX_REACH
                || p.deaths > 0
            {
                bad.push((seed, (p.body.pos - from).len(), off_edge, short, nearest));
            }
        }
        assert!(
            bad.is_empty(),
            "(seed, moved, ended outside the keep-out's edge by, off its approach point by, nearest \
             to the vortex) — it did not close to the keep-out's edge, or went into the pull: \
             {bad:?}"
        );
    }

    /// **T22.14B M5: every vortex is a keep-out — a spent one by its capture radius, a live
    /// one by the reach of its pull.** The bots kept `VORTEX_REACH / 2` of the live ones
    /// only: a spent hole (it still catches, R88) was no keep-out at all, and at the
    /// half-reach a live one pulls the cap, so a bot held there on thrust until it ran dry.
    /// Escape and `forbidden` at points inside each margin; controls a margin past each.
    #[test]
    fn a_spent_vortex_is_kept_out_of_and_a_live_ones_whole_pull_is() {
        use crate::constants::{VORTEX_CAPTURE_R, VORTEX_REACH};
        let mut w = space_world(4242);
        let at = open_both_ways(&w);
        let right = Vec2::new(1.0, 0.0);
        let v = Vortex {
            id: 7,
            pos: at - right * (0.5 * (VORTEX_CAPTURE_R + BOT_SPACE_HAZARD_MARGIN)),
        };
        // Spent: inside its capture radius's margin, it leaves (away: right).
        w.spent_vortices.push(v);
        let near = at;
        let out = escape(&w, near, Vec2::ZERO, None);
        assert!(
            out.is_some_and(|o| o.x > 0.5) && forbidden(&w, v.pos),
            "a spent vortex {:.0} px off is not kept out of: escape {out:?}",
            (near - v.pos).len()
        );
        let far = v.pos + right * (VORTEX_CAPTURE_R + 2.0 * BOT_SPACE_HAZARD_MARGIN);
        assert!(
            escape(&w, far, Vec2::ZERO, None).is_none() && !forbidden(&w, far),
            "control: a spent vortex pulls nothing, so past its capture margin is free"
        );
        // Live: at three quarters of the reach (outside the old half-reach margin).
        w.spent_vortices.clear();
        w.vortices.push(v);
        let mid = v.pos + right * (0.75 * VORTEX_REACH);
        assert!(
            escape(&w, mid, Vec2::ZERO, None).is_some_and(|o| o.x > 0.5) && forbidden(&w, mid),
            "a live vortex's pull at 0.75 of its reach is not kept out of"
        );
        let past = v.pos + right * (VORTEX_REACH + 2.0 * BOT_SPACE_HAZARD_MARGIN);
        assert!(
            escape(&w, past, Vec2::ZERO, None).is_none() && !forbidden(&w, past),
            "control: past the pull's reach and the margin is free"
        );
    }

    /// An open point with `PLAYER_H * 2` of clear air to its left and its right.
    fn open_both_ways(w: &World) -> Vec2 {
        let side = Vec2::new(2.0 * PLAYER_H, 0.0);
        open_points(w)
            .into_iter()
            .find(|&p| clear_run(w, p - side, p + side))
            .expect("an open point with clear air either side")
    }

    /// One tick of `steer` at rest where the bot is, with a held detour.
    fn with_detour(w: &World, flight: &mut Flight, fire: Option<Vec2>) -> u8 {
        let me = w.player(0).expect("ana");
        steer(w, me, None, fire, flight, SIM_DT)
    }

    /// T22.03E F6: **a respawned bot does not fly its last life's detour.** A detour
    /// left over from a death, held with nowhere to go: under a new life (`deaths`
    /// moved) nothing is pressed and the memory is gone. Control: the same memory in
    /// the same life flies it (`LEFT`).
    #[test]
    fn a_new_life_forgets_the_last_ones_detour() {
        let mut w = space_world(4242);
        let at = open_both_ways(&w);
        put(&mut w, at);
        let held = Flight {
            detour: Some((Vec2::new(-1.0, 0.0), BOT_SPACE_DETOUR, false)),
            ..Flight::default()
        };
        let mut same = held;
        assert!(
            with_detour(&w, &mut same, None) & button::LEFT != 0,
            "control: a held detour left was not flown"
        );
        w.player_mut(0).expect("ana").deaths += 1;
        let mut next = held;
        let b = with_detour(&w, &mut next, None);
        assert!(
            b == 0 && next.detour.is_none(),
            "a new life flew the old one's detour: buttons {b:08b}, {next:?}"
        );
    }

    /// T22.03E F6: **an escape outranks a destination's detour.** A bot holding a
    /// detour left, with a fire appearing on its left: it flies right, out of the
    /// fire, and drops the detour. Control: an **escape's** own detour is not cut
    /// short by the escape it serves (it keeps `LEFT`).
    #[test]
    fn an_escape_overrides_a_detour_toward_its_destination() {
        let mut w = space_world(4242);
        let at = open_both_ways(&w);
        put(&mut w, at);
        let fire = Some(at - Vec2::new(PLAYER_H, 0.0));
        let mut flight = Flight {
            detour: Some((Vec2::new(-1.0, 0.0), BOT_SPACE_DETOUR, false)),
            ..Flight::default()
        };
        let b = with_detour(&w, &mut flight, fire);
        assert!(
            b & button::RIGHT != 0 && b & button::LEFT == 0 && flight.detour.is_none(),
            "flew its detour into the fire: buttons {b:08b}, {flight:?}"
        );
        let mut escaping = Flight {
            detour: Some((Vec2::new(-1.0, 0.0), BOT_SPACE_DETOUR, true)),
            ..Flight::default()
        };
        assert!(
            with_detour(&w, &mut escaping, fire) & button::LEFT != 0,
            "control: an escape's own detour was cut short"
        );
    }

    /// T22.03E F6: **a body inside rock takes the way out, and counts no try.** Every
    /// swept heading of a box 6 px into a face fails on its first step, so the old
    /// detour took "the next clear heading" of an empty list — `want`, straight back
    /// in — and counted a try every window forever. Now it flies the turn that is
    /// out soonest (a heading off the face) and `tries` stays 0.
    #[test]
    fn a_body_inside_rock_takes_the_way_out() {
        let mut w = space_world(4242);
        let dirs = [
            Vec2::new(1.0, 0.0),
            Vec2::new(-1.0, 0.0),
            Vec2::new(0.0, 1.0),
            Vec2::new(0.0, -1.0),
        ];
        // From an open point, fly a ray into the first rock, 6 px past touching.
        let (at, into) = open_points(&w)
            .into_iter()
            .flat_map(|p| dirs.iter().map(move |&d| (p, d)))
            .find_map(|(p, d)| {
                let k = (1..200).find(|&k| !box_clear(&w, p + d * k as f32))?;
                let at = p + d * (k as f32 + 5.0);
                (clear_headings(&w, at, d).next().is_none() && way_out(&w, at, d).is_some())
                    .then_some((at, d))
            })
            .expect("a point just inside a rock face with a way out");
        put(&mut w, at);
        let dest = Some(Dest {
            at: at + into * crate::constants::FOV_DAY,
            stop: 0.0,
        });
        let mut flight = Flight::default();
        let me = w.player(0).expect("ana");
        for _ in 0..((BOT_SPACE_STUCK_WINDOW / SIM_DT) as u32 + 2) {
            steer(&w, me, dest, None, &mut flight, SIM_DT);
        }
        let (dir, _, _) = flight.detour.expect("no detour after the stuck window");
        let out = (1..=sweep_steps()).find(|&k| box_clear(&w, at + dir * (k as f32 * CLEAR_STEP)));
        assert!(
            flight.tries == 0 && dir.dot(into) < 0.5 && out.is_some(),
            "inside rock: detour {dir:?} (into the rock {into:?}), out after {out:?} steps, \
             tries {}",
            flight.tries
        );
    }
}
