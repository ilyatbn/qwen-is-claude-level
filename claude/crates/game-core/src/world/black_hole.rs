//! T22.12 — the black hole (owner: *"a permanent one and appears randomly at the last
//! minute. it will destroy one of the many random asteroids and suck players into it
//! if they get close. they die immediately. if you get within the range of it, you
//! cannot escape."*).
//!
//! **It is the closing pressure, not a fourth thing to dodge**: it arrives in the last
//! minute, never leaves, and takes an asteroid with it.
//!
//! Where each rule lives (`M22-RULINGS` R8, R11, R20, R21; `T22.12` "As ruled" R90–R93):
//! - **the lifecycle** is the round controller's, not the scheduler's (R21): one
//!   `World` field, [`BlackHole`], rolled on the first `Playing` tick of a space round,
//!   **telegraphed** [`BLACK_HOLE_TELEGRAPH`] seconds before it opens (R93,
//!   `black_hole_warn`) and stepped by [`World::step_black_hole`] from `World::step`;
//! - **the pull** is `attractors::Attractor::black_hole`, chained into the one
//!   `field_at` after the wells and the vortices, on both sides through
//!   `attractors::env_at` — gated on the phase by [`pulls`], which both sides call
//!   (R8.4: it freezes at `Ended`); and **inside its reach the wells are muted** (R91,
//!   in that same `env_at`);
//! - **the horizon** is a state change, not a force: [`in_horizon`] zeroes health like
//!   the void, and `resolve_deaths` re-derives `DeathCause::BlackHole` from the same
//!   predicate one pass later (R20's shape — derive, do not add a flag), **only while
//!   it [`pulls`]** — the kill is gated on `Playing`, so is the name (T22.12C F9). A
//!   black-hole death drops nothing (R92).
//! - **the horizon is the whole rule** (R90): the pull there is
//!   `BLACK_HOLE_EDGE_PULL`, under the weakest thrust, so one pixel outside it every
//!   player holding thrust away climbs out — and the ring drawn at it is the line.
//!
//! **Decisions this file makes, for the coordinator** (reversible, each in one place):
//! - the hole sits at the eaten asteroid's centre, and the rock is carved away there
//!   (`CarveKind::Meteor`, an existing wire kind, so the client's carve stream and
//!   its mask checksum carry the change with no new terrain path);
//! - **anyone standing on that rock is inside the horizon or just outside it** (the
//!   horizon is the largest rock's radius) — with the 2 s telegraph over their feet;
//! - it never eats the **last** asteroid: `Map::space_geometry` is derived from the
//!   asteroid list being non-empty, so eating the only rock would turn the rim, the
//!   void and every space rule off mid-round. A map with one rock gets the hole at
//!   the arena centre instead. (No generated space map has one; the guard is for the
//!   derivation, which is a field meaning two things — reported, not changed here.)

use crate::constants::{
    BLACK_HOLE_HORIZON_R, BLACK_HOLE_LATEST, BLACK_HOLE_REACH, BLACK_HOLE_TELEGRAPH,
    BLACK_HOLE_WINDOW,
};
use crate::math::Vec2;
use crate::rng::{range_f32, substream};
use crate::world::{CarveKind, GameEvent, RoundPhase, World};

/// The black hole's whole lifecycle — **one field**, so "rolled", "warned" and
/// "here" cannot disagree with each other.
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum BlackHole {
    /// Not rolled: before the round's first `Playing` tick, or not a space round.
    Unrolled,
    /// Rolled: arrives at round time `at` and eats the asteroid `pick` indexes
    /// (modulo the list as it stands then).
    Due { at: f32, pick: u32 },
    /// Telegraphed (R93): `black_hole_warn` has gone out, and at round time `at` it
    /// opens at `pos`, eating asteroid `index` (the list cannot change before then —
    /// only the hole removes rocks).
    Warned { at: f32, index: u32, pos: Vec2 },
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
            BlackHole::Warned { at, index, pos } => {
                h.update(&[3]);
                h.update(&at.to_le_bytes());
                h.update(&index.to_le_bytes());
                h.update(&pos.x.to_le_bytes());
                h.update(&pos.y.to_le_bytes());
            }
        }
    }
}

/// The arrival roll: a seeded moment in the last minute, and which rock.
///
/// Its own substream, so rolling it moves no other roll (the vortex's reason).
/// Uniform over `[end - window, end - window · LATEST / WINDOW]`, where `window` is
/// `BLACK_HOLE_WINDOW` — or, on a round too short for it plus the telegraph, the
/// round's length less the telegraph (T22.12C F8: scaled, see the constant), so the
/// telegraph always fits after the phase begins.
pub fn roll(seed: u64, phase_started_at: f32, round_ends_at: f32) -> BlackHole {
    let mut rng = substream(seed, "black_hole");
    let length = round_ends_at - phase_started_at;
    let window = BLACK_HOLE_WINDOW
        .min(length - BLACK_HOLE_TELEGRAPH)
        .max(0.0);
    let span = window * (1.0 - BLACK_HOLE_LATEST / BLACK_HOLE_WINDOW);
    let at = round_ends_at - window + range_f32(&mut rng, 0.0, span);
    let pick = rand::RngCore::next_u32(&mut rng);
    BlackHole::Due {
        at: at.max(phase_started_at),
        pick,
    }
}

/// Whether the hole **pulls** this tick: the phase takes input.
///
/// R8.4: it freezes at `Ended` — T21.30 keeps physics running after the bell
/// (*"input does nothing — but gravity does"*), so an attractor left on that path
/// would keep pulling on the results screen. **Both sides call this**:
/// `World::apply_inputs` and `GameCore::apply_input` (which also stops at the bell's
/// seq, T22.12C F5), so the mirror cannot gate it differently. The asteroid wells
/// keep pulling outside the reach (T22.11B's note there); inside it nothing pulls
/// after the bell (R91 mutes them by the hole's presence, `attractors::env_at`).
pub fn pulls(phase: RoundPhase) -> bool {
    phase.accepts_input()
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

/// **The first input seq the server steps after the bell** (T22.12C F5) — the seq
/// from which a client's prediction must stop pulling toward the hole.
///
/// The server stops the pull on its `Ended` tick; a client hears `ended` a trip
/// later and, until then, predicted the pull on inputs the server stepped without
/// it. Derived from what the client already holds, **in integers** (T22.12D, R94): a
/// `Playing` `round_state`'s `ends_tick` is the last tick stepped in `Playing`
/// (`World::phase_ends_tick`; `World::step` changes phase last, so that tick still
/// pulled); and a snapshot says seq `ack` ran on tick `snap_tick`, one seq a tick
/// after it (R89: one step per player per tick). So the first seq stepped in `Ended`
/// is `ack + ends_tick − snap_tick + 1`. (T22.12C derived the bell from an `f32`
/// `time_left`, which a round counted by a float sum missed by 1/2/6 ticks on
/// 240/300/600 s rounds.)
pub fn bell_seq(ends_tick: u32, ack: u32, snap_tick: u32) -> u32 {
    (i64::from(ack) + i64::from(ends_tick) - i64::from(snap_tick) + 1).clamp(0, i64::from(u32::MAX))
        as u32
}

impl World {
    /// The hole, if it has arrived.
    pub fn black_hole(&self) -> Option<Vec2> {
        self.black_hole.pos()
    }

    /// When it is due, while it is due or warned — the arrival assertion's readback.
    pub fn black_hole_due_at(&self) -> Option<f32> {
        match self.black_hole {
            BlackHole::Due { at, .. } | BlackHole::Warned { at, .. } => Some(at),
            _ => None,
        }
    }

    /// Tests outside `world` (the bots') put a hole where they need one, on any map.
    #[cfg(test)]
    pub(crate) fn place_black_hole_for_test(&mut self, pos: Vec2) {
        self.black_hole = BlackHole::Here { pos };
    }

    /// Where it will open, while it is telegraphed (R93).
    pub fn black_hole_warned_at(&self) -> Option<Vec2> {
        match self.black_hole {
            BlackHole::Warned { pos, .. } => Some(pos),
            _ => None,
        }
    }

    /// `Playing` only (the caller gates): roll, telegraph, arrive when due, and take
    /// whoever is inside the horizon. Before the void in `step`, for the void's
    /// reason — it works by zeroing health and letting `resolve_deaths` do the rest.
    pub(super) fn step_black_hole(&mut self, now: f32) {
        if self.map.space_geometry().is_none() {
            return;
        }
        if self.black_hole == BlackHole::Unrolled {
            self.black_hole = roll(self.seed, self.phase_started_at(), self.round_ends_at());
        }
        if let BlackHole::Due { at, pick } = self.black_hole {
            if now >= at - BLACK_HOLE_TELEGRAPH {
                let (index, pos) = self.black_hole_site(pick as usize);
                self.warn_black_hole(at, index, pos);
            }
        }
        if let BlackHole::Warned { at, index, .. } = self.black_hole {
            if now >= at {
                self.arrive_black_hole(index as usize, now);
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

    /// Which rock `pick` eats and where the hole opens: the rock's index in the list
    /// as it stands and its centre — or, with fewer than two rocks, the arena centre
    /// and no rock (never the last asteroid; the module doc says why).
    fn black_hole_site(&self, pick: usize) -> (u32, Vec2) {
        let rocks = &self.map.meta.asteroids;
        if rocks.len() >= 2 {
            let i = pick % rocks.len();
            (i as u32, Vec2::new(rocks[i].x as f32, rocks[i].y as f32))
        } else {
            let geo = self.map.space_geometry().expect("gated by the caller");
            (u32::MAX, Vec2::new(geo.cx, geo.cy))
        }
    }

    /// R93: the telegraph — the state, and `black_hole_warn` with the spot and how
    /// long until it opens, for everyone.
    fn warn_black_hole(&mut self, at: f32, index: u32, pos: Vec2) {
        self.black_hole = BlackHole::Warned { at, index, pos };
        if let Some(e) = self.black_hole_warn_event() {
            self.events.push(e);
        }
    }

    /// **The one `black_hole_warn`** (T22.12D F7): this tick, the spot, and how long
    /// until it opens — for the live telegraph and the join catch-up
    /// (`session.rs`) alike, so a joiner's countdown cannot drift from a watcher's.
    /// `None` unless the hole is telegraphed and not yet here.
    pub fn black_hole_warn_event(&self) -> Option<GameEvent> {
        let BlackHole::Warned { at, pos, .. } = self.black_hole else {
            return None;
        };
        Some(GameEvent::BlackHoleWarn {
            tick: self.tick,
            x: pos.x,
            y: pos.y,
            arrives_in: (at - self.round_time).max(0.0),
        })
    }

    /// Bring the hole now, eating the asteroid nearest `near` — the tests' and the
    /// dev hook's way in, through the same arrival the roll uses. Space only, once.
    /// **No telegraph**: see [`World::warn_black_hole_near`] for the one that has it.
    pub fn summon_black_hole_near(&mut self, near: Vec2, now: f32) -> Option<Vec2> {
        if self.map.space_geometry().is_none() || self.black_hole.pos().is_some() {
            return None;
        }
        let index = self.rock_nearest(near, 0.0);
        self.arrive_black_hole(index, now);
        self.black_hole.pos()
    }

    /// Telegraph the hole now, to open [`BLACK_HOLE_TELEGRAPH`] seconds from `now`
    /// through the ordinary step (R93) — the dev hook's `warn` (T22.12C). It eats the
    /// rock nearest `near` **whose centre is outside the reach of `near`**, so the
    /// asker is not standing in it while the check photographs the warning. Space
    /// only, before the hole is here; `None` otherwise.
    pub fn warn_black_hole_near(&mut self, near: Vec2, now: f32) -> Option<Vec2> {
        if self.map.space_geometry().is_none() || self.black_hole.pos().is_some() {
            return None;
        }
        let pick = self.rock_nearest(near, BLACK_HOLE_REACH);
        let (index, pos) = self.black_hole_site(pick);
        self.warn_black_hole(now + BLACK_HOLE_TELEGRAPH, index, pos);
        Some(pos)
    }

    /// The index of the rock whose centre is nearest `near` among those at least
    /// `min` from it (all of them if none is), 0 on an empty list.
    fn rock_nearest(&self, near: Vec2, min: f32) -> usize {
        let d = |a: &crate::map::meta::Asteroid| (Vec2::new(a.x as f32, a.y as f32) - near).len();
        let rocks = &self.map.meta.asteroids;
        let far_enough = rocks.iter().any(|a| d(a) >= min);
        rocks
            .iter()
            .enumerate()
            .filter(|(_, a)| !far_enough || d(a) >= min)
            .min_by(|(_, a), (_, b)| d(a).total_cmp(&d(b)))
            .map_or(0, |(i, _)| i)
    }

    /// Dev seam for the browser checks (`debug_black_hole`): put player `id` at rest
    /// `dist` from the hole, on a side whose straight run in to the horizon is clear
    /// of rock — so the pull drags them from a known spot. Nearest the side they are
    /// already on first. `None` without a hole, a player, or a clear side.
    ///
    /// **Announced as a relocation** (T22.12D F3, `GameEvent::Relocate`), so the
    /// asker's prediction snaps there like a pad or a vortex trip instead of
    /// counting the move as an error.
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
        self.dev_relocate(id, at)
    }

    /// R8.3: it eats exactly one asteroid, on arrival, and never again. The rock
    /// leaves the list — so its well goes with it (`asteroid_attractors` reads the
    /// list) and `map_init` stops shipping it — and its pixels are carved through
    /// the ordinary carve stream.
    fn arrive_black_hole(&mut self, pick: usize, now: f32) {
        let n = self.map.meta.asteroids.len();
        let pos = if n >= 2 {
            // `pick % n` is `pick` itself when it came from `black_hole_site`.
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
        GravityMode, MapScale, BLACK_HOLE_EDGE_PULL, DEFAULT_MAP_GENERATOR, JETPACK_MAX_FUEL,
        JETPACK_THRUST_DOWN, JETPACK_THRUST_SIDE, JETPACK_THRUST_UP, SIM_DT,
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
        // Its well is gone. Probed **just outside the hole's reach**, where the wells
        // pull again (R91 mutes them inside it, so a probe there would pass with the
        // eaten rock's well still in the list): the field is the survivors' alone,
        // and the eaten rock's own well does reach this far (the control).
        let probe = centre + Vec2::new(0.0, crate::constants::BLACK_HOLE_REACH + 2.0);
        assert_ne!(
            Attractor::asteroid(&target).pull_at(probe),
            Vec2::ZERO,
            "control: the eaten rock's well does not reach the probe"
        );
        let expect = crate::world::attractors::wells_at(&w.map, probe);
        let got = env_at(&w.map, GravityMode::Space, &[], Some(centre), true, probe).accel;
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

    /// T22.12E: both dev placers announce their move, on **the first tick whose state
    /// holds it** — `tick + 1`, since a dev command runs after tick `tick`'s snapshot
    /// went out. The prediction skips a relocation a snapshot at or past that tick
    /// already carried (`Predictor.relocate`), so the tick is load-bearing: at `tick`
    /// it would skip a move the snapshot it compares never saw. `dev_place_inward_of`
    /// had no event at all before this.
    #[test]
    fn dev_relocations_are_announced_on_the_first_tick_that_holds_them() {
        let (mut w, _hole) = hole_world(4242);
        let geo = w.map.space_geometry().expect("space");
        let breach = w
            .dev_breach_toward(Vec2::new(geo.cx - 100.0, geo.cy - 50.0))
            .expect("a breach");
        w.drain_events();
        let t = w.tick;
        let near = w
            .dev_place_near_black_hole(0, 0.8 * BLACK_HOLE_REACH)
            .expect("placed near the hole");
        let inward = w.dev_place_inward_of(0, breach).expect("placed inward");
        assert_eq!(
            w.player(0).expect("ana").body.pos,
            inward,
            "the move itself"
        );
        let said: Vec<_> = w
            .drain_events()
            .into_iter()
            .filter_map(|e| match e {
                GameEvent::Relocate { tick, id, x, y } => Some((tick, id, Vec2::new(x, y))),
                _ => None,
            })
            .collect();
        assert_eq!(said, vec![(t + 1, 0, near), (t + 1, 0, inward)]);
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

    /// How long a flight keeps thrusting once past the reach (T22.12D F4): the wells
    /// switch back on **abruptly** at `REACH` (R91 mutes them inside it), so "past the
    /// reach" is only an escape if the wells there do not drag the body back in.
    const PAST_REACH_TICKS: u32 = crate::constants::SIM_HZ / 2;

    /// What one flight did: died of the hole; how far out it got alive; and, once
    /// past `REACH + 8`, the nearest it came back to the hole over the next
    /// [`PAST_REACH_TICKS`] with the wells back on.
    struct Flight {
        died: bool,
        furthest: f32,
        nearest_after: Option<f32>,
    }

    /// Run ana for up to `secs` holding thrust away from the hole; once she is past
    /// the reach (+8 px), keep thrusting [`PAST_REACH_TICKS`] more and track the
    /// nearest she comes back.
    fn escape(w: &mut World, hole: Vec2, secs: f32) -> Flight {
        let mut f = Flight {
            died: false,
            furthest: 0.0,
            nearest_after: None,
        };
        let mut past = 0;
        for _ in 0..(secs / SIM_DT) as usize {
            let pos = w.player(0).expect("ana").body.pos;
            step(w, away(hole, pos));
            let p = w.player(0).expect("ana");
            let d = (p.body.pos - hole).len();
            if p.alive {
                f.furthest = f.furthest.max(d);
            }
            if deaths(&w.drain_events()).contains(&DeathCause::BlackHole) {
                f.died = true;
                return f;
            }
            if let Some(n) = f.nearest_after.as_mut() {
                *n = n.min(d);
                past += 1;
                if past >= PAST_REACH_TICKS {
                    break;
                }
            } else if f.furthest > crate::constants::BLACK_HOLE_REACH + 8.0 {
                f.nearest_after = Some(d);
            }
        }
        f
    }

    /// **R90 + R91: the horizon is the whole rule** — from one pixel outside it, at
    /// rest on a full tank, holding the thrust that points away, **every** flight
    /// climbs out past the reach: 16 sides of 13 maps, the review's 208 flights
    /// (**0 escaped** at T22.12A's sizes, and **20 were trapped** by neighbouring
    /// wells once the pull was right-sized — the plant that un-mutes R91 is red
    /// here). The kill inside it is `inside_the_horizon_is_death_on_the_tick…`.
    ///
    /// **And a live vortex does not change that** (H1, T22.14A): the same 208 flights
    /// again with a vortex beyond the hole, placed where its pull alone passes the cap
    /// and it does not capture. Before the fix every vortex pulled inside the hole's
    /// reach too, capped to 675 on top of the hole's 810.
    ///
    /// **The terrain is cleared out of the way** to past the reach first: the claim is
    /// about the *field* — the hole plus every rock's well, whose list is untouched —
    /// and a flight that bumps a rock's side is stopped by the rock, not the hole
    /// (measured: a straight-up flight on a side whose radial was clear ran into the
    /// rock beside it at 168 px, because the buttons cannot point along the radial).
    ///
    /// The constants' own claim first: the pull at the horizon is `EDGE_PULL`, under
    /// the **weakest** thrust (DOWN), and every thrust is at least that.
    #[test]
    fn from_just_outside_the_horizon_full_thrust_escapes_past_the_reach() {
        use crate::constants::{BLACK_HOLE_HORIZON_R, BLACK_HOLE_REACH, PLAYER_H, VORTEX_CAPTURE_R};
        let edge = Attractor::black_hole(Vec2::ZERO)
            .pull_at(Vec2::new(BLACK_HOLE_HORIZON_R, 0.0))
            .len();
        assert!(
            (edge - BLACK_HOLE_EDGE_PULL).abs() < 0.5,
            "edge pull {edge}"
        );
        let weakest = JETPACK_THRUST_DOWN
            .min(JETPACK_THRUST_SIDE)
            .min(JETPACK_THRUST_UP);
        assert!(
            edge < weakest,
            "the pull at the horizon {edge} beats a thrust {weakest}"
        );

        const SIDES: usize = 16;
        let mut flights = 0;
        let mut trapped = Vec::new();
        let mut wells_inside = 0;
        let (mut fell_back, mut worst_after) = (Vec::new(), f32::INFINITY);
        // H1 (T22.14A): the vortex arm. A live vortex on the far side of the hole,
        // `VORTEX_ARM_D` from the start — outside its capture radius, where its
        // pull alone is past the cap — so before the fix the capped 675 px/s² and
        // the hole's 810 summed to ~1485 against DOWN 900 and dragged the body in.
        // Inside the hole's reach no vortex pulls now (`env_at`); its capture is by
        // radius, so muting its pull there opens no exit.
        let vortex_arm_d = 1.5 * VORTEX_CAPTURE_R;
        let mut vortex_trapped = Vec::new();
        let mut vortex_premise = 0;
        for seed in 0..13u64 {
            for k in 0..SIDES {
                let angle = k as f32 * std::f32::consts::TAU / SIDES as f32 + 0.1;
                for with_vortex in [false, true] {
                    let (mut w, hole) = hole_world(seed);
                    // Through `Map::carve_circle` (the coarse grid collision reads is
                    // kept with the mask), with its pending breaches drained: this
                    // arm is about the hole and the wells, and the vortex a breach
                    // opens is the other arm's subject (placed where it is worst,
                    // rather than wherever this disc happens to reach the rim).
                    let clear = (BLACK_HOLE_REACH + 8.0 + PLAYER_H).ceil() as i32;
                    let _ = w
                        .map
                        .carve_circle(hole.x.round() as i32, hole.y.round() as i32, clear);
                    let _ = w.map.take_breaches();
                    if k == 0 && !with_vortex {
                        // The control that there are wells to mute: some rock's well
                        // reaches the horizon on this map.
                        let at = hole + Vec2::new(BLACK_HOLE_HORIZON_R + 1.0, 0.0);
                        let wells = crate::world::attractors::field_at(
                            w.map.meta.asteroids.iter().map(Attractor::asteroid),
                            at,
                        );
                        wells_inside += usize::from(wells != Vec2::ZERO);
                    }
                    place(&mut w, hole, BLACK_HOLE_HORIZON_R + 1.0, angle);
                    if with_vortex {
                        let start = w.player(0).expect("ana").body.pos;
                        let v = start + (hole - start) * (vortex_arm_d / (hole - start).len());
                        w.vortices.push(crate::world::vortex::Vortex { id: 0, pos: v });
                        // The premise: at the start its pull alone is past the cap,
                        // and it does not capture there.
                        let alone = Attractor::vortex(v).pull_at(start).len();
                        vortex_premise += usize::from(
                            alone >= crate::constants::SPACE_WELL_ACCEL_MAX
                                && (start - v).len() > VORTEX_CAPTURE_R,
                        );
                    }
                    let f = escape(&mut w, hole, JETPACK_MAX_FUEL);
                    flights += 1;
                    if f.died || f.furthest <= BLACK_HOLE_REACH {
                        let line = format!("seed {seed} side {k}: died {}, {:.1} px", f.died, f.furthest);
                        if with_vortex {
                            vortex_trapped.push(line);
                        } else {
                            trapped.push(line);
                        }
                    }
                    // F4 (T22.12D): past the reach the wells are back — still out.
                    match f.nearest_after {
                        Some(n) if n > BLACK_HOLE_REACH => {
                            worst_after = worst_after.min(n);
                        }
                        _ => fell_back.push(format!(
                            "seed {seed} side {k} vortex {with_vortex}: {:?} px",
                            f.nearest_after
                        )),
                    }
                }
            }
        }
        assert!(
            wells_inside >= 10,
            "control: a well reaches the horizon on only {wells_inside} of 13 maps"
        );
        assert_eq!(
            vortex_premise,
            13 * SIDES,
            "premise: the vortex arm's vortex out-pulls the cap at the start and does not capture there"
        );
        assert!(
            trapped.is_empty(),
            "{} of {flights} flights from just outside the horizon did not get past the \
             reach: {trapped:?}",
            trapped.len()
        );
        assert!(
            vortex_trapped.is_empty(),
            "{} of {} flights with a vortex beyond the hole did not get past the reach: \
             {vortex_trapped:?}",
            vortex_trapped.len(),
            13 * SIDES
        );
        assert!(
            fell_back.is_empty(),
            "{} of {flights} flights past the reach came back inside it within {} ticks, the \
             wells switched back on (nearest after passing): {fell_back:?}",
            fell_back.len(),
            PAST_REACH_TICKS
        );
        eprintln!(
            "escape: {flights} flights, nearest any came back to the hole in the \
             {PAST_REACH_TICKS} ticks after passing the reach: {worst_after:.1} px (reach \
             {BLACK_HOLE_REACH})"
        );
    }

    /// **R91: inside the hole's reach only the hole pulls; outside it the wells do.**
    /// Inside: the field is exactly the hole's own pull, though rocks' wells reach
    /// there (the control that muting changed something). Outside, one pixel past
    /// the reach: the wells, exactly the hole-free field, and not zero — a presence
    /// control, or "muted" would pass for a map with no wells at all.
    #[test]
    fn inside_the_reach_only_the_hole_pulls_and_outside_it_the_wells_do() {
        use crate::constants::BLACK_HOLE_REACH;
        let (w, hole) = hole_world(5);
        // The hole-free field: the wells' sum, capped (R96, T22.03G) — at 1 px past
        // the reach some side's wells pile past the cap, so the raw sum is not it.
        let wells_at = |p: Vec2| crate::world::attractors::wells_at(&w.map, p);
        let mut muted = 0;
        for k in 0..16 {
            let a = k as f32 * std::f32::consts::TAU / 16.0;
            let dir = Vec2::new(a.cos(), a.sin());
            let inside = hole + dir * (BLACK_HOLE_REACH * 0.5);
            let got = env_at(&w.map, GravityMode::Space, &[], Some(hole), true, inside).accel;
            assert_eq!(
                got,
                Attractor::black_hole(hole).pull_at(inside),
                "side {k}: inside"
            );
            if wells_at(inside) != Vec2::ZERO {
                muted += 1;
            }
            let outside = hole + dir * (BLACK_HOLE_REACH + 1.0);
            let got = env_at(&w.map, GravityMode::Space, &[], Some(hole), true, outside).accel;
            assert_eq!(got, wells_at(outside), "side {k}: outside");
            assert_ne!(
                got,
                Vec2::ZERO,
                "side {k}: control — no well reaches past the reach"
            );
        }
        assert!(
            muted > 0,
            "control: no well reached inside the reach, so muting proves nothing"
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
        let with = env_at(&w.map, GravityMode::Space, &[], Some(hole), true, out).accel;
        let without = env_at(&w.map, GravityMode::Space, &[], None, false, out).accel;
        assert_eq!(with, without);
        let inside = hole + Vec2::new(crate::constants::BLACK_HOLE_REACH * 0.5, 0.0);
        let with = env_at(&w.map, GravityMode::Space, &[], Some(hole), true, inside).accel;
        let without = env_at(&w.map, GravityMode::Space, &[], None, false, inside).accel;
        assert_ne!(
            with, without,
            "control: inside the reach the hole pulled nothing"
        );
    }

    /// R8.4: at `Ended` it freezes — no pull, no kill — and stays (drawn: the
    /// client keeps the event). The control is the same body before the bell, which
    /// the hole does pull. And R91 keys on the hole being *there*: inside its reach
    /// after the bell **nothing** pulls — not the hole, and not the wells it mutes —
    /// so a body at rest stays at rest on the results screen.
    #[test]
    fn at_ended_it_freezes_and_stays() {
        let (mut w, hole) = hole_world(9);
        let at = hole + Vec2::new(0.0, crate::constants::BLACK_HOLE_REACH * 0.6);
        assert!(pulls(RoundPhase::Playing));
        assert!(!pulls(RoundPhase::Ended));
        // Playing: pulled toward the hole (the control).
        let p = w.player_mut(0).expect("ana");
        p.body = crate::physics::body::Body::new(at);
        step(&mut w, 0);
        let v_playing = w.player(0).expect("ana").body.vel;
        assert!(
            v_playing.y < -1.0,
            "control: the hole did not pull ({v_playing:?})"
        );
        // Ended: the same body, the same place — nothing pulls.
        w.set_phase(RoundPhase::Ended);
        let p = w.player_mut(0).expect("ana");
        p.body = crate::physics::body::Body::new(at);
        for _ in 0..30 {
            step(&mut w, 0);
        }
        let b = w.player(0).expect("ana").body;
        assert_eq!(b.vel, Vec2::ZERO, "something pulled after the bell");
        assert_eq!(b.pos, at, "the body moved after the bell");
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

    /// **T22.12C F9: the cause is gated as the kill is.** A player who dies inside
    /// the horizon *after the bell* died of something else — the hole does not kill
    /// then — so the death is not named the hole's. The control is the same death on
    /// the same spot in `Playing`, which is.
    #[test]
    fn a_death_inside_the_horizon_after_the_bell_is_not_named_the_holes() {
        let cause_of = |phase: RoundPhase| {
            let (mut w, hole) = hole_world(9);
            w.set_phase(phase);
            let p = w.player_mut(0).expect("ana");
            p.body = crate::physics::body::Body::new(hole + Vec2::new(2.0, 0.0));
            p.health = 0.0;
            step(&mut w, 0);
            deaths(&w.drain_events())
        };
        assert_eq!(
            cause_of(RoundPhase::Playing),
            vec![DeathCause::BlackHole],
            "control"
        );
        let ended = cause_of(RoundPhase::Ended);
        assert_eq!(
            ended.len(),
            1,
            "control: the death after the bell was not resolved"
        );
        assert_ne!(
            ended[0],
            DeathCause::BlackHole,
            "named the hole after the bell"
        );
    }

    /// **R92: the hole swallows the inventory** — a black-hole death drops nothing,
    /// so there is no loot floating at the horizon. The control is the same carried
    /// item on a death that is not the hole's (health to zero, clear of it), which
    /// does drop.
    #[test]
    fn a_black_hole_death_drops_nothing() {
        let drops_of = |in_hole: bool| {
            let (mut w, hole) = hole_world(3);
            let at = if in_hole {
                hole + Vec2::new(crate::constants::BLACK_HOLE_HORIZON_R * 0.5, 0.0)
            } else {
                hole + Vec2::new(crate::constants::BLACK_HOLE_REACH * 3.0, 0.0)
            };
            let p = w.player_mut(0).expect("ana");
            p.body = crate::physics::body::Body::new(at);
            p.inventory.add(crate::items::registry::FLASHLIGHT, 1);
            if !in_hole {
                p.health = 0.0;
            }
            step(&mut w, 0);
            let events = w.drain_events();
            assert_eq!(deaths(&events).len(), 1, "in_hole {in_hole}: nobody died");
            events
                .iter()
                .filter(|e| matches!(e, GameEvent::ItemSpawn { .. }))
                .count()
        };
        assert!(
            drops_of(false) > 0,
            "control: a death clear of the hole dropped nothing"
        );
        assert_eq!(drops_of(true), 0, "the hole left the inventory floating");
    }

    /// **R93: the telegraph** — `black_hole_warn` goes out exactly once,
    /// `BLACK_HOLE_TELEGRAPH` before the arrival, at the spot the hole then opens,
    /// over many seeds. The control is that the hole does arrive (a telegraph for a
    /// hole that never comes passes "at the spot" vacuously).
    #[test]
    fn it_is_telegraphed_at_the_spot_two_seconds_before_it_opens() {
        use crate::constants::BLACK_HOLE_TELEGRAPH;
        for seed in 0..8u64 {
            let mut w = world(GravityMode::Space, seed, 1.5 * BLACK_HOLE_WINDOW);
            let (mut warned, mut arrived) = (Vec::new(), None);
            while w.phase == RoundPhase::Playing && arrived.is_none() {
                step(&mut w, 0);
                for e in w.drain_events() {
                    match e {
                        GameEvent::BlackHoleWarn {
                            x, y, arrives_in, ..
                        } => warned.push((w.round_time, Vec2::new(x, y), arrives_in)),
                        GameEvent::BlackHole { x, y, .. } => {
                            arrived = Some((w.round_time, Vec2::new(x, y)))
                        }
                        _ => {}
                    }
                }
                if let Some(h) = w.black_hole_warned_at() {
                    park_far(&mut w, h);
                }
            }
            let (t_arrive, spot) =
                arrived.unwrap_or_else(|| panic!("seed {seed}: it never arrived"));
            assert_eq!(
                warned.len(),
                1,
                "seed {seed}: warned {} times",
                warned.len()
            );
            let (t_warn, at, arrives_in) = warned[0];
            assert_eq!(
                at, spot,
                "seed {seed}: warned at one spot, opened at another"
            );
            let lead = t_arrive - t_warn;
            assert!(
                (lead - BLACK_HOLE_TELEGRAPH).abs() <= SIM_DT * 1.5,
                "seed {seed}: telegraphed {lead:.3}s ahead, not {BLACK_HOLE_TELEGRAPH}"
            );
            assert!(
                (arrives_in - lead).abs() <= SIM_DT * 1.5,
                "seed {seed}: the warning said {arrives_in:.3}s, it took {lead:.3}s"
            );
        }
    }

    /// **T22.12C F8: a short round scales the window** — a dev `ROUND_SECONDS` a
    /// third of the window still gets a hole, after the phase began plus a full
    /// telegraph and before the scaled latest point, and at seeded moments rather
    /// than all piled onto the first tick (what clipping did).
    #[test]
    fn a_short_round_scales_the_window_and_still_telegraphs() {
        use crate::constants::BLACK_HOLE_TELEGRAPH;
        let round = BLACK_HOLE_WINDOW / 3.0;
        let window = round - BLACK_HOLE_TELEGRAPH;
        let mut arrivals = Vec::new();
        for seed in 0..12u64 {
            let mut w = world(GravityMode::Space, seed, round);
            let mut at = None;
            while w.phase == RoundPhase::Playing && at.is_none() {
                step(&mut w, 0);
                if let Some(h) = w.black_hole_warned_at().or(w.black_hole()) {
                    park_far(&mut w, h);
                }
                if w.black_hole().is_some() {
                    at = Some(w.round_time);
                }
            }
            let at = at.unwrap_or_else(|| panic!("seed {seed}: no hole in a {round}s round"));
            assert!(
                at >= BLACK_HOLE_TELEGRAPH,
                "seed {seed}: arrived {at:.2}s in, before a whole telegraph"
            );
            let latest = round - window * BLACK_HOLE_LATEST / BLACK_HOLE_WINDOW;
            assert!(
                at <= latest + SIM_DT,
                "seed {seed}: arrived {at:.2}s, past the scaled latest {latest:.2}"
            );
            arrivals.push(at);
        }
        let spread = arrivals.iter().cloned().fold(f32::MIN, f32::max)
            - arrivals.iter().cloned().fold(f32::MAX, f32::min);
        assert!(
            spread > 1.0,
            "every short round arrived within {spread:.2}s"
        );
    }

    /// **T22.12C F3: a mid-round joiner never spawns inside the reach** —
    /// `World::spawn_for`'s filter, at its live binding: the hole is put on the very
    /// point the unfiltered picker chooses (the control asserts it would), then a
    /// player joins.
    #[test]
    fn a_mid_round_joiner_never_spawns_inside_the_reach() {
        let (mut w, _) = hole_world(13);
        let living: Vec<Vec2> = w
            .players
            .iter()
            .filter(|p| p.alive)
            .map(|p| p.body.pos)
            .collect();
        let unfiltered = crate::player::state::choose_respawn(&w.map, &living, &mut w.rng.clone());
        w.black_hole = BlackHole::Here { pos: unfiltered };
        w.add_player(1, 0, "bo".into());
        let at = w.player(1).expect("bo").body.pos;
        assert!(
            clearance(Some(unfiltered), at) >= 0.0,
            "joined {:.1} px from a hole on the point the unfiltered picker chose",
            (at - unfiltered).len()
        );
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
