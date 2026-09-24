//! T22.12 — the black hole (owner: *"a permanent one and appears randomly at the last
//! minute. it will destroy one of the many random asteroids and suck players into it
//! if they get close. they die immediately. if you get within the range of it, you
//! cannot escape."*).
//!
//! **It is the closing pressure, not a fourth thing to dodge**: it arrives in the last
//! minute, never leaves, and takes an asteroid with it.
//!
//! Where each rule lives (`M22-RULINGS` R8, R11, R20, R21):
//! - **the lifecycle** is the round controller's, not the scheduler's (R21): one
//!   `World` field, [`BlackHole`], rolled on the first `Playing` tick of a space round
//!   and stepped by [`World::step_black_hole`] from `World::step`;
//! - **the pull** is `attractors::Attractor::black_hole`, chained into the one
//!   `field_at` after the wells and the vortices, on both sides through
//!   `attractors::env_at` — and gated on the phase by [`pulling`], which both sides
//!   call (R8.4: it freezes at `Ended`);
//! - **the horizon** is a state change, not a force: [`in_horizon`] zeroes health like
//!   the void, and `resolve_deaths` re-derives `DeathCause::BlackHole` from the same
//!   predicate one pass later (R20's shape — derive, do not add a flag).
//!
//! **Decisions this file makes, for the coordinator** (reversible, each in one place):
//! - the hole sits at the eaten asteroid's centre, and the rock is carved away there
//!   (`CarveKind::Meteor`, an existing wire kind, so the client's carve stream and
//!   its mask checksum carry the change with no new terrain path);
//! - **anyone standing on that rock is inside the capture radius** (`BLACK_HOLE_CAPTURE_R`
//!   is twice the largest rock) and goes where the hole sends everyone — in;
//! - it never eats the **last** asteroid: `Map::space_geometry` is derived from the
//!   asteroid list being non-empty, so eating the only rock would turn the rim, the
//!   void and every space rule off mid-round. A map with one rock gets the hole at
//!   the arena centre instead. (No generated space map has one; the guard is for the
//!   derivation, which is a field meaning two things — reported, not changed here.)

use crate::constants::{
    BLACK_HOLE_HORIZON_R, BLACK_HOLE_LATEST, BLACK_HOLE_REACH, BLACK_HOLE_WINDOW,
};
use crate::math::Vec2;
use crate::rng::{range_f32, substream};
use crate::world::{CarveKind, GameEvent, RoundPhase, World};

/// The black hole's whole lifecycle — **one field**, so "rolled", "due" and "here"
/// cannot disagree with each other.
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum BlackHole {
    /// Not rolled: before the round's first `Playing` tick, or not a space round.
    Unrolled,
    /// Rolled: arrives at round time `at` and eats the asteroid `pick` indexes
    /// (modulo the list as it stands then).
    Due { at: f32, pick: u32 },
    /// Here, for the rest of the round (R8: permanent, fixed size).
    Here { pos: Vec2 },
}

impl BlackHole {
    /// Where it is, once it is.
    pub fn pos(&self) -> Option<Vec2> {
        match *self {
            BlackHole::Here { pos } => Some(pos),
            _ => None,
        }
    }

    pub(super) fn hash_into(&self, h: &mut blake3::Hasher) {
        match *self {
            BlackHole::Unrolled => {
                h.update(&[0]);
            }
            BlackHole::Due { at, pick } => {
                h.update(&[1]);
                h.update(&at.to_le_bytes());
                h.update(&pick.to_le_bytes());
            }
            BlackHole::Here { pos } => {
                h.update(&[2]);
                h.update(&pos.x.to_le_bytes());
                h.update(&pos.y.to_le_bytes());
            }
        }
    }
}

/// The arrival roll: a seeded moment in the last minute, and which rock.
///
/// Its own substream, so rolling it moves no other roll (the vortex's reason).
/// Uniform over `[end - WINDOW, end - LATEST]`, never before the phase began.
pub fn roll(seed: u64, phase_started_at: f32, round_ends_at: f32) -> BlackHole {
    let mut rng = substream(seed, "black_hole");
    let earliest = round_ends_at - BLACK_HOLE_WINDOW;
    let at = earliest + range_f32(&mut rng, 0.0, BLACK_HOLE_WINDOW - BLACK_HOLE_LATEST);
    let pick = rand::RngCore::next_u32(&mut rng);
    BlackHole::Due {
        at: at.max(phase_started_at),
        pick,
    }
}

/// The hole as it **pulls** this tick: present, and the phase takes input.
///
/// R8.4: it freezes at `Ended` — T21.30 keeps physics running after the bell
/// (*"input does nothing — but gravity does"*), so an attractor left on that path
/// would keep pulling on the results screen. **Both sides call this**:
/// `World::apply_inputs` and `GameCore::apply_input`, so the mirror cannot gate it
/// differently. The asteroid wells deliberately keep pulling (T22.11B's note there).
pub fn pulling(hole: Option<Vec2>, phase: RoundPhase) -> Option<Vec2> {
    hole.filter(|_| phase.accepts_input())
}

/// Inside the event horizon — the one predicate the kill and the death's cause share.
pub fn in_horizon(hole: Vec2, pos: Vec2) -> bool {
    (pos - hole).len() < BLACK_HOLE_HORIZON_R
}

/// How far a body centre at `centre` is outside the hole's reach, px (negative
/// inside): the clearance the respawn and the vortex's destination are held to, so
/// neither puts anybody where the hole pulls at all.
pub fn clearance(hole: Option<Vec2>, centre: Vec2) -> f32 {
    hole.map_or(f32::INFINITY, |h| (centre - h).len() - BLACK_HOLE_REACH)
}

impl World {
    /// The hole, if it has arrived.
    pub fn black_hole(&self) -> Option<Vec2> {
        self.black_hole.pos()
    }

    /// When it is due, while it is due — the arrival assertion's readback.
    pub fn black_hole_due_at(&self) -> Option<f32> {
        match self.black_hole {
            BlackHole::Due { at, .. } => Some(at),
            _ => None,
        }
    }

    /// `Playing` only (the caller gates): roll, arrive when due, and take whoever is
    /// inside the horizon. Before the void in `step`, for the void's reason — it
    /// works by zeroing health and letting `resolve_deaths` do the rest.
    pub(super) fn step_black_hole(&mut self, now: f32) {
        if self.map.space_geometry().is_none() {
            return;
        }
        if self.black_hole == BlackHole::Unrolled {
            self.black_hole = roll(self.seed, self.phase_started_at, self.round_ends_at());
        }
        if let BlackHole::Due { at, pick } = self.black_hole {
            if now >= at {
                self.arrive_black_hole(pick as usize, now);
            }
        }
        let Some(hole) = self.black_hole.pos() else {
            return;
        };
        for p in self.players.iter_mut() {
            if p.alive && in_horizon(hole, p.body.pos) {
                p.health = 0.0;
            }
        }
    }

    /// Bring the hole now, eating the asteroid nearest `near` — the tests' and the
    /// dev hook's way in, through the same arrival the roll uses. Space only, once.
    pub fn summon_black_hole_near(&mut self, near: Vec2, now: f32) -> Option<Vec2> {
        if self.map.space_geometry().is_none() || self.black_hole.pos().is_some() {
            return None;
        }
        let d = |a: &crate::map::meta::Asteroid| (Vec2::new(a.x as f32, a.y as f32) - near).len();
        let index = self
            .map
            .meta
            .asteroids
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| d(a).total_cmp(&d(b)))
            .map_or(0, |(i, _)| i);
        self.arrive_black_hole(index, now);
        self.black_hole.pos()
    }

    /// Dev seam for the browser checks (`debug_black_hole`): put player `id` at rest
    /// `dist` from the hole, on a side whose straight run in to the horizon is clear
    /// of rock — so the pull drags them from a known spot. Nearest the side they are
    /// already on first. `None` without a hole, a player, or a clear side.
    pub fn dev_place_near_black_hole(
        &mut self,
        id: crate::player::state::PlayerId,
        dist: f32,
    ) -> Option<Vec2> {
        let hole = self.black_hole.pos()?;
        let from = self.player(id)?.body.pos - hole;
        let base = from.y.atan2(from.x);
        let fits = |p: Vec2| {
            !crate::physics::collide::aabb_overlaps_solid(
                &self.map,
                crate::physics::body::Body::new(p).aabb(),
            )
        };
        let at = (0..16)
            .map(|i| {
                let k = (i + 1) / 2;
                let turn = if i % 2 == 0 { k as f32 } else { -(k as f32) };
                base + turn * std::f32::consts::TAU / 16.0
            })
            .map(|a| Vec2::new(a.cos(), a.sin()))
            .find(|dir| {
                let steps = ((dist - BLACK_HOLE_HORIZON_R) / 4.0).ceil().max(1.0) as i32;
                (0..=steps).all(|i| {
                    let d = BLACK_HOLE_HORIZON_R
                        + (dist - BLACK_HOLE_HORIZON_R) * i as f32 / steps as f32;
                    fits(hole + *dir * d)
                })
            })
            .map(|dir| hole + dir * dist)?;
        let p = self.player_mut(id)?;
        p.body = crate::physics::body::Body::new(at);
        Some(at)
    }

    /// R8.3: it eats exactly one asteroid, on arrival, and never again. The rock
    /// leaves the list — so its well goes with it (`asteroid_attractors` reads the
    /// list) and `map_init` stops shipping it — and its pixels are carved through
    /// the ordinary carve stream.
    fn arrive_black_hole(&mut self, pick: usize, now: f32) {
        let n = self.map.meta.asteroids.len();
        let pos = if n >= 2 {
            let a = self.map.meta.asteroids.remove(pick % n);
            // `+ 2`: the stamp keeps every pixel inside `r`, and rounding may put
            // one on it (`stamp_asteroid`); asteroids are `SPACE_ASTEROID_GAP_MIN`
            // apart, so the margin reaches nothing else.
            let r = a.r + 2;
            let carve = self.map.carve_circle(a.x, a.y, r);
            if carve.pixels_removed > 0 {
                self.carve_seq += 1;
                let (tick, seq) = (self.tick, self.carve_seq);
                self.events.push(GameEvent::Carve {
                    tick,
                    seq,
                    x: a.x,
                    y: a.y,
                    r,
                    kind: CarveKind::Meteor,
                });
            }
            self.reveal(&carve.revealed, now);
            Vec2::new(a.x as f32, a.y as f32)
        } else {
            let geo = self.map.space_geometry().expect("gated by the caller");
            Vec2::new(geo.cx, geo.cy)
        };
        self.black_hole = BlackHole::Here { pos };
        let tick = self.tick;
        self.events.push(GameEvent::BlackHole {
            tick,
            x: pos.x,
            y: pos.y,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        GravityMode, MapScale, BLACK_HOLE_ACCEL_MAX, BLACK_HOLE_CAPTURE_R, BLACK_HOLE_THRUST_BOUND,
        DEFAULT_MAP_GENERATOR, JETPACK_MAX_FUEL, SIM_DT,
    };
    use crate::player::input::{button, Input};
    use crate::player::state::DeathCause;
    use crate::world::attractors::{env_at, Attractor};

    fn world(gravity: GravityMode, seed: u64, round: f32) -> World {
        let mut w = World::with_gravity(seed, MapScale::Small, 0, DEFAULT_MAP_GENERATOR, gravity);
        w.set_round_seconds(round);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w
    }

    /// One tick with `buttons` held — seq 0, numbered by the world, so the input
    /// lands on this tick (T22.10G).
    fn step(w: &mut World, buttons: u8) {
        w.queue_input(0, Input::new(0, buttons, 0));
        w.step(SIM_DT);
    }

    fn deaths(events: &[GameEvent]) -> Vec<DeathCause> {
        events
            .iter()
            .filter_map(|e| match e {
                GameEvent::Death { cause, .. } => Some(*cause),
                _ => None,
            })
            .collect()
    }

    /// Park ana somewhere the hole cannot reach, so a round runs without her dying.
    fn park_far(w: &mut World, from: Vec2) {
        let geo = w.map.space_geometry().expect("space");
        let far = [
            Vec2::new(geo.cx - geo.rx * 0.8, geo.cy),
            Vec2::new(geo.cx + geo.rx * 0.8, geo.cy),
        ]
        .into_iter()
        .max_by(|a, b| (*a - from).len().total_cmp(&(*b - from).len()))
        .expect("two");
        let p = w.player_mut(0).expect("ana");
        p.body = crate::physics::body::Body::new(far);
    }

    /// R8.1: **every round, inside the last minute, never before** — over many
    /// seeds, with the control that it does arrive (a hazard that never spawns
    /// passes "never early"). Round length pinned to the constant's multiple so
    /// the window is a strict tail of the round.
    #[test]
    fn it_arrives_inside_the_last_minute_every_round_and_never_before() {
        let round = 1.5 * BLACK_HOLE_WINDOW;
        let seeds = 0..12u64;
        let mut arrivals = Vec::new();
        for seed in seeds.clone() {
            let mut w = world(GravityMode::Space, seed, round);
            let end = round; // `Playing` began at round time 0.
            let mut arrived_at = None;
            while w.phase == RoundPhase::Playing {
                step(&mut w, 0);
                if let Some(h) = w.black_hole() {
                    arrived_at.get_or_insert(w.round_time);
                    park_far(&mut w, h);
                } else {
                    assert!(
                        w.round_time < end - BLACK_HOLE_LATEST + SIM_DT,
                        "seed {seed}: not here {:.2}s before the bell",
                        end - w.round_time
                    );
                }
            }
            let at = arrived_at.unwrap_or_else(|| panic!("seed {seed}: it never arrived"));
            assert!(
                at >= end - BLACK_HOLE_WINDOW,
                "seed {seed}: arrived {:.2}s before the bell, outside the last minute",
                end - at
            );
            arrivals.push(at);
        }
        // Random timing, not one fixed moment: the draws differ across seeds.
        let spread = arrivals.iter().cloned().fold(f32::MIN, f32::max)
            - arrivals.iter().cloned().fold(f32::MAX, f32::min);
        assert!(
            spread > 1.0,
            "every seed arrived within {spread:.2}s: not random"
        );
    }

    /// R8.3: exactly one asteroid is gone — from the list (so its well with it),
    /// from the mask — and the rest are untouched. And it never happens twice.
    #[test]
    fn it_eats_exactly_one_asteroid_and_its_well_goes_with_it() {
        let mut w = world(GravityMode::Space, 7, 600.0);
        let before = w.map.meta.asteroids.clone();
        let target = before[3];
        let centre = Vec2::new(target.x as f32, target.y as f32);
        let solid_near = |w: &World, a: &crate::map::meta::Asteroid| {
            let mut n = 0;
            for y in (a.y - a.r)..=(a.y + a.r) {
                for x in (a.x - a.r)..=(a.x + a.r) {
                    if (x - a.x).pow(2) + (y - a.y).pow(2) <= a.r * a.r && w.map.mask.get(x, y) {
                        n += 1;
                    }
                }
            }
            n
        };
        assert!(
            solid_near(&w, &target) > 0,
            "control: the rock was not there"
        );
        let pos = w
            .summon_black_hole_near(centre, w.round_time)
            .expect("summoned");
        assert_eq!(pos, centre);
        assert_eq!(w.map.meta.asteroids.len(), before.len() - 1);
        assert!(!w.map.meta.asteroids.contains(&target));
        assert_eq!(solid_near(&w, &target), 0, "the eaten rock left pixels");
        for a in &w.map.meta.asteroids {
            assert!(
                solid_near(&w, a) > 0,
                "a rock the hole did not eat lost its pixels"
            );
        }
        // Its well is gone: the field just outside the rock is the hole's alone.
        let probe = centre + Vec2::new(0.0, crate::constants::BLACK_HOLE_REACH * 0.75);
        let expect = crate::world::attractors::field_at(
            w.map
                .meta
                .asteroids
                .iter()
                .map(Attractor::asteroid)
                .chain(Some(Attractor::black_hole(centre))),
            probe,
        );
        let got = env_at(&w.map, GravityMode::Space, &[], Some(centre), probe).accel;
        assert_eq!(got, expect);
        let events = w.drain_events();
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, GameEvent::BlackHole { .. }))
                .count(),
            1,
            "the arrival was not announced exactly once"
        );
        assert!(events.iter().any(|e| matches!(e, GameEvent::Carve { .. })));
        // R8.3: never again — a second summon and a whole minute of steps eat nothing.
        assert_eq!(w.summon_black_hole_near(centre, w.round_time), None);
        park_far(&mut w, centre);
        for _ in 0..(60.0 / SIM_DT) as usize {
            step(&mut w, 0);
        }
        assert_eq!(w.map.meta.asteroids.len(), before.len() - 1);
    }

    /// Place ana at `d` from the hole, on the side `angle` names, at rest, full tank.
    fn place(w: &mut World, hole: Vec2, d: f32, angle: f32) {
        let at = hole + Vec2::new(angle.cos(), angle.sin()) * d;
        let p = w.player_mut(0).expect("ana");
        p.body = crate::physics::body::Body::new(at);
        p.jetpack.fuel = JETPACK_MAX_FUEL;
    }

    /// The buttons whose thrust points most directly away from the hole.
    fn away(hole: Vec2, pos: Vec2) -> u8 {
        let out = pos - hole;
        let h = if out.x > 0.0 {
            button::RIGHT
        } else {
            button::LEFT
        };
        let v = if out.y < 0.0 {
            button::UP
        } else {
            button::DOWN
        };
        // Diagonal only when the off-axis component is worth it.
        if out.x.abs() < out.y.abs() * 0.3 {
            v
        } else if out.y.abs() < out.x.abs() * 0.3 {
            h
        } else {
            h | v
        }
    }

    /// Run ana for `secs` holding thrust away from the hole; the result is whether
    /// she died of it and how far out she ever got alive.
    fn flee(w: &mut World, hole: Vec2, secs: f32) -> (bool, f32) {
        let mut furthest: f32 = 0.0;
        for _ in 0..(secs / SIM_DT) as usize {
            let pos = w.player(0).expect("ana").body.pos;
            step(w, away(hole, pos));
            let p = w.player(0).expect("ana");
            if p.alive {
                furthest = furthest.max((p.body.pos - hole).len());
            }
            if deaths(&w.drain_events()).contains(&DeathCause::BlackHole) {
                return (true, furthest);
            }
        }
        (false, furthest)
    }

    fn hole_world(seed: u64) -> (World, Vec2) {
        let mut w = world(GravityMode::Space, seed, 600.0);
        let geo = w.map.space_geometry().expect("space");
        let hole = w
            .summon_black_hole_near(Vec2::new(geo.cx, geo.cy), w.round_time)
            .expect("summoned");
        w.drain_events();
        (w, hole)
    }

    /// **The inverse of `T22.11`'s escape ceiling** — *"if you get within the
    /// range of it, you cannot escape"* as a rule rather than a hope. From inside
    /// `BLACK_HOLE_CAPTURE_R`, at rest on a full tank, holding the thrust that
    /// points most directly away, on every side: dead of the hole, never out past
    /// the capture radius alive. The control is the same flight from where the pull
    /// is half the **weakest** thrust (sideways): it escapes past the reach —
    /// otherwise this passes for a hole that kills everyone on the map.
    ///
    /// **Measured, and why the control is not "just outside the capture radius":**
    /// thrust is anisotropic (UP 2200, SIDE 1100, the diagonal ~2460), so the true
    /// no-escape radius depends on the side — at 1.3× the capture radius a mostly
    /// sideways flight still died (166 px, pull 2320 against SIDE's 1100). The
    /// capture radius is the radius inside which **no** direction escapes; outside
    /// it, some directions still cannot.
    #[test]
    fn from_inside_the_capture_radius_full_thrust_does_not_escape() {
        // The constants' own claim, stated once: at the capture radius the pull
        // equals the bound on any thrust, and the bound covers the diagonal.
        let edge = Attractor::black_hole(Vec2::ZERO)
            .pull_at(Vec2::new(BLACK_HOLE_CAPTURE_R, 0.0))
            .len();
        assert!((edge - BLACK_HOLE_THRUST_BOUND).abs() < 1.0);
        let diag = (crate::constants::JETPACK_THRUST_UP.powi(2)
            + crate::constants::JETPACK_THRUST_SIDE.powi(2))
        .sqrt();
        assert!(diag <= BLACK_HOLE_THRUST_BOUND);

        let secs = 2.0 * JETPACK_MAX_FUEL;
        let mut controls = 0;
        for k in 0..8 {
            let angle = k as f32 * std::f32::consts::TAU / 8.0 + 0.2;
            let (mut w, hole) = hole_world(11);
            place(&mut w, hole, BLACK_HOLE_CAPTURE_R * 0.95, angle);
            let (died, furthest) = flee(&mut w, hole, secs);
            assert!(
                died,
                "side {k}: full thrust from inside the capture radius escaped"
            );
            assert!(
                furthest <= BLACK_HOLE_CAPTURE_R,
                "side {k}: got {furthest:.1} px out alive, past the capture radius"
            );

            let (mut w, hole) = hole_world(11);
            let far = crate::constants::BLACK_HOLE_REACH
                * (1.0 - 0.5 * crate::constants::JETPACK_THRUST_SIDE / BLACK_HOLE_ACCEL_MAX);
            // Only on a side whose way out is open space — a rock in the way stops
            // the flight for a reason that is not the hole.
            let dir = Vec2::new(angle.cos(), angle.sin());
            let open = (0..=40).all(|i| {
                let at = hole + dir * (far + i as f32 * 4.0);
                !crate::physics::collide::aabb_overlaps_solid(
                    &w.map,
                    crate::physics::body::Body::new(at).aabb(),
                )
            });
            if !open {
                continue;
            }
            controls += 1;
            place(&mut w, hole, far, angle);
            let (died, furthest) = flee(&mut w, hole, secs);
            assert!(
                !died && furthest > crate::constants::BLACK_HOLE_REACH,
                "control, side {k}: full thrust from {far:.1} px did not escape past the \
                 reach (died {died}, furthest {furthest:.1} px)"
            );
        }
        assert!(
            controls >= 4,
            "only {controls} open sides: the control is too thin"
        );
    }

    /// The horizon is a **state change**: inside it you are dead on that tick,
    /// whatever you hold, and the death is named. Announced exactly once.
    #[test]
    fn inside_the_horizon_is_death_on_the_tick_and_it_is_named() {
        let (mut w, hole) = hole_world(3);
        place(
            &mut w,
            hole,
            crate::constants::BLACK_HOLE_HORIZON_R * 0.9,
            1.0,
        );
        step(&mut w, button::UP | button::RIGHT);
        assert_eq!(deaths(&w.drain_events()), vec![DeathCause::BlackHole]);
        assert!(!w.player(0).expect("ana").alive);
    }

    /// The control for the pull: outside its reach nothing changes — the field is
    /// bit-identical to the hole-free one there, and inside it is not.
    #[test]
    fn outside_the_reach_the_hole_adds_nothing() {
        let (w, hole) = hole_world(5);
        let out = hole + Vec2::new(crate::constants::BLACK_HOLE_REACH + 1.0, 0.0);
        let with = env_at(&w.map, GravityMode::Space, &[], Some(hole), out).accel;
        let without = env_at(&w.map, GravityMode::Space, &[], None, out).accel;
        assert_eq!(with, without);
        let inside = hole + Vec2::new(crate::constants::BLACK_HOLE_REACH * 0.5, 0.0);
        let with = env_at(&w.map, GravityMode::Space, &[], Some(hole), inside).accel;
        let without = env_at(&w.map, GravityMode::Space, &[], None, inside).accel;
        assert_ne!(
            with, without,
            "control: inside the reach the hole pulled nothing"
        );
    }

    /// R8.4: at `Ended` it freezes — no pull, no kill — and stays (drawn: the
    /// client keeps the event). The control is the same body one tick before the
    /// bell, which the hole does pull.
    #[test]
    fn at_ended_it_freezes_and_stays() {
        let (mut w, hole) = hole_world(9);
        let at = hole + Vec2::new(0.0, BLACK_HOLE_CAPTURE_R * 1.5);
        assert!(pulling(Some(hole), RoundPhase::Playing).is_some());
        assert_eq!(pulling(Some(hole), RoundPhase::Ended), None);
        // Playing: pulled toward the hole (the control).
        let p = w.player_mut(0).expect("ana");
        p.body = crate::physics::body::Body::new(at);
        step(&mut w, 0);
        let v_playing = w.player(0).expect("ana").body.vel;
        let wells = env_at(&w.map, GravityMode::Space, &[], None, at).accel;
        assert!(
            (v_playing - wells * SIM_DT).y < -1.0,
            "control: the hole did not pull"
        );
        // Ended: the same body, the same place — only the wells.
        w.set_phase(RoundPhase::Ended);
        let p = w.player_mut(0).expect("ana");
        p.body = crate::physics::body::Body::new(at);
        step(&mut w, 0);
        let v_ended = w.player(0).expect("ana").body.vel;
        assert!(
            (v_ended - wells * SIM_DT).len() < 1e-3,
            "it pulled after the bell"
        );
        // No kill inside the horizon after the bell, and it is still here.
        let p = w.player_mut(0).expect("ana");
        p.body = crate::physics::body::Body::new(hole + Vec2::new(1.0, 0.0));
        step(&mut w, 0);
        assert!(
            deaths(&w.drain_events()).is_empty(),
            "it killed after the bell"
        );
        assert_eq!(w.black_hole(), Some(hole));
    }

    /// Nothing in the other modes — with the presence control in space.
    #[test]
    fn nothing_happens_in_the_other_modes() {
        for g in [GravityMode::Standard, GravityMode::Low] {
            let mut w = world(g, 4, BLACK_HOLE_WINDOW);
            while w.phase == RoundPhase::Playing {
                step(&mut w, 0);
            }
            assert_eq!(w.black_hole(), None, "{g:?}");
            assert!(!w
                .drain_events()
                .iter()
                .any(|e| matches!(e, GameEvent::BlackHole { .. })));
            assert_eq!(w.summon_black_hole_near(Vec2::ZERO, 0.0), None);
        }
        let mut w = world(GravityMode::Space, 4, BLACK_HOLE_WINDOW);
        let mut seen = false;
        while w.phase == RoundPhase::Playing {
            step(&mut w, 0);
            if let Some(h) = w.black_hole() {
                seen = true;
                park_far(&mut w, h);
            }
        }
        assert!(seen, "control: no hole in space either");
    }

    /// The live binding of the respawn filter: with no one else alive the picker
    /// takes the **first listed spawn point**, so a hole sat on that point is the
    /// case a missing filter gets wrong — `a_respawn_is_never_inside_the_reach`
    /// alone passed with the filter deleted, because its hole was far from every
    /// listed point. The control: the unfiltered picker does choose that point.
    #[test]
    fn a_respawn_never_takes_the_spawn_point_the_hole_sits_on() {
        let (mut w, _) = hole_world(13);
        let first = w.map.meta.spawn_points[0];
        let spot =
            crate::player::state::surface_to_centre(Vec2::new(first.x as f32, first.y as f32));
        let unfiltered = crate::player::state::choose_respawn(&w.map, &[], &mut w.rng.clone());
        assert_eq!(
            unfiltered, spot,
            "control: the picker's first choice is not the first point"
        );
        w.black_hole = BlackHole::Here { pos: spot };
        place(&mut w, spot, 1.0, 0.0);
        let mut at = None;
        for _ in 0..((crate::constants::RESPAWN_DELAY + 1.0) / SIM_DT) as usize {
            step(&mut w, 0);
            for e in w.drain_events() {
                if let GameEvent::Respawn { x, y, .. } = e {
                    at = Some(Vec2::new(x, y));
                }
            }
            if at.is_some() {
                break;
            }
        }
        let at = at.expect("never respawned");
        assert!(
            clearance(Some(spot), at) >= 0.0,
            "respawned {:.1} px from a hole sitting on the first spawn point",
            (at - spot).len()
        );
    }

    /// The respawn and the vortex's destination never offer the hole: a dead
    /// player comes back outside its reach, every time.
    #[test]
    fn a_respawn_is_never_inside_the_reach() {
        let (mut w, hole) = hole_world(13);
        for i in 0..12 {
            place(&mut w, hole, 1.0, i as f32);
            // Die in it, then wait out the respawn; read where it put her.
            let mut at = None;
            for _ in 0..((crate::constants::RESPAWN_DELAY + 1.0) / SIM_DT) as usize {
                step(&mut w, 0);
                for e in w.drain_events() {
                    if let GameEvent::Respawn { x, y, .. } = e {
                        at = Some(Vec2::new(x, y));
                    }
                }
                if at.is_some() {
                    break;
                }
            }
            let at = at.unwrap_or_else(|| panic!("round {i}: never respawned"));
            assert!(
                clearance(Some(hole), at) >= 0.0,
                "round {i}: respawned {:.1} px from the hole",
                (at - hole).len()
            );
        }
    }
}
