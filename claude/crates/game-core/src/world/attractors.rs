//! **The one place any attractor is applied** (`M22-RULINGS` R11).
//!
//! `T22.11A` built the seam — `physics::resolve::Forces::accel`, a vector beside
//! the scalar, applied where `apply_gravity`'s early return cannot skip it — and
//! left it `Vec2::ZERO` at every construction site. This module is what fills it:
//! every asteroid pulls, the pulls sum, and the sum is the same on both sides.
//!
//! # The shape is a list of **attractors**, not a list of asteroids
//!
//! R11: `T22.10`'s breach vortex and `T22.12`'s black hole push entries into this
//! same list and write no loop of their own, so the summation is written once and
//! [`Kind`] is what lets this task's escape guarantee be scoped to asteroids while
//! `T22.12`'s horizon carries the opposite assertion. Two attractor loops is the
//! thing this file exists to prevent.
//!
//! # The falloff is linear to a cutoff, and that was costed rather than preferred
//!
//! ```text
//! a(d) = strength * max(0, 1 - d / reach)
//! ```
//!
//! `M22-RULINGS` R47 did the arithmetic for inverse-square: pinned to an escapable
//! ceiling at the smallest rock that can carry level 5, `k(5) < 900 * 54.5² =
//! 2 673 225 px³/s²`, and that same well one climb budget out delivers
//! `2 673 225 / 780²` = **4.4 px/s²** against an 1100 px/s² sideways thruster.
//! An inverse-square well pinned to an escapable ceiling is brutal on contact or
//! imperceptible at range and there is no setting where it is both.
//!
//! Linear-to-cutoff buys three things:
//!
//! 1. [`SPACE_WELL_ACCEL_MAX`] **is** the quantity R46's inequality bounds, so the
//!    table cannot drift away from its own assertion — the tunable and the guard
//!    are one number.
//! 2. The reach is one [`JETPACK_CLIMB_BUDGET`](crate::constants::JETPACK_CLIMB_BUDGET)
//!    at the top level, which is a sentence a player can feel: *a full tank always
//!    clears the well.*
//! 3. The acceleration reaches zero **continuously** at the cutoff, which answers
//!    the design record's own objection that *"a well with a hard edge is a wall
//!    you fall off"*.
//!
//! # R101 (T22.15): the asteroid wells are short-range, and a step
//!
//! The owner, after playing it: *"gravity is way way too powerful. i keep being
//! swayed throughout the map constantly. gravity should be like a few pixels around
//! each 'asteroid'."* Points 2 and 3 above are **superseded for the asteroids**: a
//! well pulls at its level's full strength out to one
//! [`WELL_SURFACE_BAND`](crate::constants::WELL_SURFACE_BAND) of air past its rock
//! ([`well_reach`]) and exactly zero beyond — the same reach at every level. Point
//! 1 stands: the full strength *is* `SPACE_WELL_ACCEL_MAX` at level 5. Measured
//! over 9 seeds (`short_range_wells_report`): open arena with any pull 99.8 % →
//! 8.3 %; a player left at a spawn for 5 s drifted p50 554 px → 0. The vortices
//! and the hole keep the linear law (R47), unchanged to the bit.
//!
//! # The cutoff is not a performance decision, and the design record's premise was wrong
//!
//! *"Tons of tiny islands, so N is large"* does not survive the numbers. N is the
//! scale's `asteroid_count` target and Large's is **64** — with `MAX_PLAYERS` = 6
//! that is 384 attractor-player pairs a tick, a few hundred thousand flops a
//! second. **No cost claim is made here, because none was measured.** The cutoff is
//! a gameplay decision (a well you can be outside of) and a float-order one: it
//! bounds how many terms enter each sum, and every term that enters is a term whose
//! rounding the two sides have to agree about.
//!
//! # Determinism, which is the half that fails silently
//!
//! Float addition is not associative, so client and server must add the same
//! contributions in the same order or the two drift apart with nothing in this mode
//! to damp the error. [`field_at`] sums in **iteration order** and every production
//! caller feeds it `map.meta.asteroids` in the order `place_asteroids` produced —
//! a `Vec`, never a `HashMap`, for the reason `World::players` already gives at the
//! code. [`tests::three_wells_sum_in_list_order_and_the_order_is_observable`] pins
//! it with a fixture whose forward and reverse sums provably differ.
//!
//! **The client is fed the same list, and that gap is closed** (`M22-RULINGS` R49,
//! `T22.11C`). `GameCore::new()` generates on the *standard* generator, so until
//! that task a networked client's `map.meta.asteroids` was **empty** — not stale,
//! empty — and the mirror predicted against no field at all. It is now installed
//! from `map_init` by `worldMirror.ts::applyMapInit` through
//! `GameCore::set_asteroids`, in the wire's order, and both sides call this
//! module's [`env_at`] — so nothing here changed when it landed, which is what
//! sharing the function bought.

use crate::constants::{
    GravityMode, BLACK_HOLE_ACCEL_MAX, BLACK_HOLE_REACH, PLAYER_H, SPACE_LEVEL_MAX,
    SPACE_MAX_SPEED, SPACE_WELL_ACCEL_MAX, VORTEX_ACCEL_MAX, VORTEX_REACH, WELL_SURFACE_BAND,
};
use crate::map::meta::Asteroid;
use crate::map::Map;
use crate::math::Vec2;
use crate::player::Env;

/// What kind of thing is pulling, and therefore which guarantee it carries.
///
/// It is what scopes the escape ceiling: `no_well_traps_a_player_on_the_underside_of_a_rock`
/// asserts that **asteroid** wells are escapable, and `T22.12`'s black hole is
/// deliberately not — widening that assertion to every attractor in the mode is
/// how the two tasks would end up contradicting each other (R11).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Asteroid,
    /// T22.10's breach vortex. *Was "not escapable near its centre, by design" —
    /// superseded by R97 (T22.03I):* its pull is summed with the wells and capped
    /// with them ([`capped_at`]), so outside its capture radius it is escapable; inside
    /// that radius the capture takes the body, which is the vortex's guarantee now.
    Vortex,
    /// T22.12's black hole. **Escapable everywhere outside its horizon and death
    /// inside it** (R90): its own guarantee is
    /// `black_hole::tests::from_just_outside_the_horizon_full_thrust_escapes_past_the_reach`,
    /// and the asteroid ceiling must not widen to it (its margin is thinner).
    BlackHole,
}

/// One thing that pulls players toward it.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Attractor {
    /// Centre, world px.
    pub pos: Vec2,
    /// Acceleration out to [`Attractor::floor`], px/s². See [`Attractor::pull_at`].
    pub strength: f32,
    /// Centre distance out to which the pull is the full `strength`, px: 0 for a
    /// vortex and the hole (their pull falls from the centre, R47); for an asteroid
    /// its whole reach — a step (R101, T22.15, [`Attractor::asteroid`]).
    pub floor: f32,
    /// Centre-to-centre distance at which the pull reaches exactly zero, px.
    pub reach: f32,
    /// Which guarantee this one carries. See [`Kind`].
    pub kind: Kind,
}

impl Attractor {
    /// The well of one asteroid: **a step** — its level's full strength out to
    /// [`well_reach`], nothing past it (R101, T22.15; `floor` = `reach`).
    ///
    /// *Why a step and not R47's linear falloff* (builder's call, T22.15; reverse it
    /// by setting `floor` to [`well_contact`]): a band returns a body that leaves the
    /// rock at `v` only while `v²/2` is under the pull integrated across it. Tapered
    /// from full at contact to zero one band out, that is `strength · BAND / 2`, which
    /// on a level-1 rock (135 px/s²) returns **61 px/s** from a body resting at the
    /// bounding radius — under the ~70 px/s of the smallest hop a player can make (UP
    /// until airborne: two ticks). Measured on the stamped level-1 rock of
    /// `a_hop_on_a_rock_lands_back_and_a_jump_leaves`, the tapered well brought that
    /// hop back only after 1.83 s, nearly stalled at the band edge; the step returns **87 px/s**
    /// there and brings it back in 1.02 s. The objection R47 answered — *"a well with
    /// a hard edge is a wall you fall off"* — was about a well reaching across the
    /// arena; this edge sits one body height off the rock.
    pub fn asteroid(a: &Asteroid) -> Self {
        let reach = well_reach(a);
        Attractor {
            pos: Vec2::new(a.x as f32, a.y as f32),
            strength: well_strength(a.level),
            floor: reach,
            reach,
            kind: Kind::Asteroid,
        }
    }

    /// This attractor's contribution to the field at `pos`, px/s².
    ///
    /// ```text
    /// a(d) = strength                                    d ≤ floor
    ///        strength · (1 − (d − floor) / (reach − floor))   floor < d < reach
    ///        0                                           d ≥ reach
    /// ```
    ///
    /// With `floor` 0 (a vortex, the hole) the middle arm is `1 − d / reach` to the
    /// bit — `d − 0.0` and `reach − 0.0` are exact — so R101 moved no number of
    /// theirs.
    ///
    /// Zero exactly at the centre, where the direction is undefined — a zero rather
    /// than a NaN, for the reason [`Vec2::normalized`] gives: NaN positions
    /// propagate silently and are miserable to debug. No player can occupy the
    /// centre of a rock, so that arm is a fixture guard rather than a game rule.
    pub fn pull_at(&self, pos: Vec2) -> Vec2 {
        let to_centre = self.pos - pos;
        let d = to_centre.len();
        if d == 0.0 || d >= self.reach {
            return Vec2::ZERO;
        }
        let k = if d <= self.floor {
            1.0
        } else {
            1.0 - (d - self.floor) / (self.reach - self.floor)
        };
        to_centre / d * (self.strength * k)
    }
}

/// The pull of a level-`level` asteroid, px/s² — everywhere inside its
/// [`well_reach`] since R101 (it was the pull at the centre, falling off outward).
///
/// **Linear in the level**, and that is the whole table: five literals with no
/// relation to anything is a table nobody can retune (R18), so this is
/// [`SPACE_WELL_ACCEL_MAX`] — itself a fraction of the jetpack's weakest axis —
/// scaled by `level / SPACE_LEVEL_MAX`.
///
/// **The level is clamped into `1..=SPACE_LEVEL_MAX` rather than trusted.** It
/// arrives over the wire (`codec.rs::encode_map_init`), so a 0 would give a rock
/// no pull and a 200 would give it a well nothing in the game could escape. The
/// clamp is what makes the escape ceiling a statement about every `u8`, which is
/// what [`tests::a_level_off_the_wire_is_clamped_into_the_table`] asserts.
pub fn well_strength(level: u8) -> f32 {
    SPACE_WELL_ACCEL_MAX * table_level(level) / SPACE_LEVEL_MAX as f32
}

/// Where an asteroid's band starts, centre distance, px: **the rock's round body**
/// (`SPACE_ASTEROID_CORE_FRAC · r`, the generator's core disc the lumps are stamped
/// on) plus half a body — a body resting on that disc.
///
/// *T22.16, refinement B (the owner's "a few pixels"): was the bounding circle `r`
/// plus half a body*, so over a rock's lumpless side — most of its silhouette — the
/// band began up to a quarter of `r` of air out and reached one `WELL_SURFACE_BAND`
/// past that: 38 px of air at the median (`well_air_gap_report`). Measured from the
/// body the band sits on the rock itself.
///
/// **The body a band still has to reach**: one standing on the outermost lump, at up
/// to `r`, touching it anywhere along its box — `r + ½·hypot(PLAYER_W, PLAYER_H)`
/// from the centre. `f·r + PLAYER_H/2 + WELL_SURFACE_BAND` exceeds it while
/// `(1 − f)·r < WELL_SURFACE_BAND + PLAYER_H/2 − ½·hypot(…)` = 25.9 px: at f = 0.75
/// every rock up to r = 103 (the largest is 70, 8.4 px spare) —
/// `tests::the_band_still_reaches_a_body_on_the_outermost_lump`. **Not the R102 core**
/// (`SPACE_CORE_FRAC`, 0.3 r): from it the inequality fails at every r from 37 up, and
/// a body on a big rock's lump would feel nothing. Carving never *adds* reach.
pub fn well_contact(a: &Asteroid) -> f32 {
    crate::constants::SPACE_ASTEROID_CORE_FRAC * a.r as f32 + PLAYER_H / 2.0
}

/// **Where an asteroid's pull stops**, centre distance, px — one
/// [`WELL_SURFACE_BAND`] of air past [`well_contact`] (R101, T22.15); full strength
/// inside, exactly zero from here out. **The same for every level**: the level
/// scales the strength, not the reach. *Was* `SPACE_WELL_REACH_MAX × level /
/// SPACE_LEVEL_MAX` — up to one climb budget, 780 px (R47), so the wells covered
/// 99.8 % of the open arena.
pub fn well_reach(a: &Asteroid) -> f32 {
    well_contact(a) + WELL_SURFACE_BAND
}

/// The wire's level, clamped into the table. See [`well_strength`].
fn table_level(level: u8) -> f32 {
    level.clamp(1, SPACE_LEVEL_MAX) as f32
}

impl Attractor {
    /// A breach vortex at `pos` (T22.10): `VORTEX_ACCEL_MAX` at the centre, linear
    /// to nothing at `VORTEX_REACH` — the wells' shape (R47) with the vortex's numbers.
    pub fn vortex(pos: Vec2) -> Self {
        Attractor {
            pos,
            strength: VORTEX_ACCEL_MAX,
            floor: 0.0,
            reach: VORTEX_REACH,
            kind: Kind::Vortex,
        }
    }
}

impl Attractor {
    /// The black hole at `pos` (T22.12): `BLACK_HOLE_ACCEL_MAX` at the centre,
    /// linear to nothing at `BLACK_HOLE_REACH` — the same law, its own numbers.
    pub fn black_hole(pos: Vec2) -> Self {
        Attractor {
            pos,
            strength: BLACK_HOLE_ACCEL_MAX,
            floor: 0.0,
            reach: BLACK_HOLE_REACH,
            kind: Kind::BlackHole,
        }
    }
}

/// Every asteroid on this map **whose core is intact** as an attractor, in the map's
/// own order.
///
/// The order is `place_asteroids`' order, which both sides receive — the server
/// generates it and `codec.rs::encode_map_init` writes it as a sequence. That is
/// what makes [`field_at`]'s sum reproducible across the wire.
///
/// T22.16 (R102): a rock whose core is destroyed has no well for the rest of the
/// round — skipped here, the one reader, so every sum on both sides drops it together
/// (`Asteroid::core_intact`; the server sets it in `World::step_cores`, the mirror per
/// seq in `GameCore::sync_cores`).
pub fn asteroid_attractors(map: &Map) -> impl Iterator<Item = Attractor> + '_ {
    map.meta
        .asteroids
        .iter()
        .filter(|a| a.core_intact)
        .map(Attractor::asteroid)
}

/// The summed field at `pos`, px/s².
///
/// **Summed in iteration order, and the order is part of the contract** — see the
/// module doc. Generic over the iterator rather than taking a slice so that
/// production adds no allocation to the tick and `T22.10`/`T22.12` can chain their
/// attractors onto the asteroids without anyone building a `Vec` first.
pub fn field_at<I: IntoIterator<Item = Attractor>>(attractors: I, pos: Vec2) -> Vec2 {
    field_from(Vec2::ZERO, attractors, pos)
}

/// [`field_at`]'s one summation, started from `start` instead of zero — so
/// [`capped_at`] can add the vortices onto the wells and [`env_at`] the hole onto
/// the **capped** sum, in the same order and the same float additions as the single
/// sum it replaced (`0 + a₁ + … + aₙ + v₁ + … + h`). Wherever the cap does not bind
/// the result is bit-identical to the pre-R96 sum.
fn field_from<I: IntoIterator<Item = Attractor>>(start: Vec2, attractors: I, pos: Vec2) -> Vec2 {
    let mut sum = start;
    for a in attractors {
        sum += a.pull_at(pos);
    }
    sum
}

/// **The summed asteroid wells at `pos`, capped at [`SPACE_WELL_ACCEL_MAX`]** —
/// `M22-RULINGS` R96 (T22.03G).
///
/// Each well is under the weakest thrust by construction (R46), **but the sum of
/// two or three is not**: at seed 451383, (2194, 1235), under a rock ceiling, three
/// wells summed to (18, −919) px/s² against `JETPACK_THRUST_DOWN` 900, and a body
/// holding any of the 8 directions for 30 ticks moved 0–1.8 px — a human trapped
/// exactly as a bot was. The cap is **derived, not a new number**: it is the
/// per-well ceiling itself, `JETPACK_THRUST_DOWN × SPACE_WELL_ESCAPE_MARGIN` (675),
/// so wherever one rock's well stands alone it is never touched (a lone well is
/// below 675 at every point a body can reach — `a_well_alone_still_pulls_at_its_full_strength`),
/// and wherever wells pile up a player keeps the same quarter of the down thrust
/// that R46 guarantees next to one rock — which is also the premise
/// `BOT_SPACE_BRAKE` (`DOWN − SPACE_WELL_ACCEL_MAX`) was already stated on.
///
/// *R96's "wells only" is superseded by R97* — the vortices are inside the cap
/// now ([`capped_at`]); this is that sum with no vortex in it.
pub fn wells_at(map: &Map, pos: Vec2) -> Vec2 {
    capped_at(map, true, &[], pos)
}

/// **Everything that is escapable, summed and capped** — `M22-RULINGS` R97
/// (T22.03I): the asteroid wells (when `wells`, R91) **and every live vortex's pull**,
/// in that order, clamped together to [`SPACE_WELL_ACCEL_MAX`].
///
/// R96 capped the wells alone and added the vortices on top, so beside a vortex the
/// capped wells (675) and the vortex's outer pull (900 at `VORTEX_REACH / 2`) summed
/// to 1575 px/s² against `JETPACK_THRUST_DOWN` 900 — a body against rock there was
/// held for the round. **Outside a vortex's capture radius escape is now always
/// possible**, by the same margin R46 guarantees beside one rock. Inside the capture
/// radius the vortex captures, unchanged: `World::step_vortices` takes every body
/// within `VORTEX_CAPTURE_R` on the tick it arrives, cooldown or not (R86), so the
/// pull there is never what holds anyone — which is why the cap needs no carve-out
/// for it (builder's reading of R97, recorded in T22.03I). What the vortex's pull
/// still does is draw an idle body in: a body left alone near one is taken
/// (`vortex::tests::…_still_takes_an_idle_body`).
///
/// **The black hole is not in it** (R90/R91: death inside the horizon, the one rule
/// a player can see) — [`env_at`] adds it after this cap, uncapped.
///
/// One summation, continued: `0 + a₁ + … + aₙ + v₁ + …`, then one clamp — wherever
/// the cap does not bind, bit-identical to the single sum before R96.
pub fn capped_at(map: &Map, wells: bool, vortices: &[Vec2], pos: Vec2) -> Vec2 {
    let start = if wells {
        field_at(asteroid_attractors(map), pos)
    } else {
        Vec2::ZERO
    };
    field_from(start, vortices.iter().map(|&v| Attractor::vortex(v)), pos)
        .clamp_len(SPACE_WELL_ACCEL_MAX)
}

/// **The one composition of [`Env`], called by both sides** — `World::apply_inputs`
/// and `GameCore::apply_input`.
///
/// One function rather than two matching call sites, because *share the guard or
/// share the function*: a value the mirror can assemble itself is a value the
/// mirror will assemble differently, and that is what both of the last two
/// rubber-band bugs were.
///
/// The match is exhaustive on purpose. A fourth gravity mode has to come here and
/// say whether it has a field, rather than inheriting one arm's answer from a `_`.
///
/// `vortices` (T22.10) are the live breach vortices, in the order the world opened
/// them — the order both sides hold them in, so the sum is the same sum. Chained
/// **after** the asteroids, into the **same** `field_at` (R11: one summation; a
/// second loop beside it is the thing that rule exists to prevent).
///
/// `hole` (T22.12) is the black hole if it has arrived, and `hole_pulls` whether it
/// pulls this tick (`black_hole::pulls`, R8.4: not after the bell) — chained last.
/// **Two arguments, because they are two facts**: R91 keys on the hole being
/// *there*, the pull on it *pulling*.
///
/// **R91: within the hole's `BLACK_HOLE_REACH` the asteroid wells do not pull —
/// only the hole does** — **and nor do the vortices** (H1, T22.14A: R91 muted the
/// wells and left every live vortex in `capped_at`, up to 675 px/s² on top of the
/// hole's 810 at the horizon — ~1485 against DOWN 900 — so a body *outside* the
/// horizon, the line R90 promises is safe, was dragged in: 117 of 208 flights in
/// the escape test's vortex arm). A vortex still **captures** there — capture is by
/// radius (`World::step_vortices`), not by pull, so muting the pull opens no exit
/// through the rim. Rocks beside the eaten one summed to 745 px/s² at the
/// horizon and trapped 20 of 208 flights the hole alone lets go, which turned the
/// horizon — the rule a player can see — back into a guess. Filtered here, inside
/// this one summation, not by a second loop; and keyed on the hole being present
/// rather than pulling, so after the bell nothing pulls inside the reach at all (the
/// results screen is still, R8.4) instead of the wells taking over from the hole.
/// The same `d >= reach` boundary as `Attractor::pull_at`, so the hole's pull and the
/// wells' hand over at one radius.
///
/// `flying` (R100, T22.14C) is `MoveMods::flying` — wings, not mounted — the same
/// derivation on both sides: a winged body in space feels **no field at all**, not
/// the wells, not a vortex's pull, not the hole's (see the arm below for why the
/// hole's too). Capture and the horizon are radii, not fields, and still apply.
#[allow(clippy::too_many_arguments)]
pub fn env_at(
    map: &Map,
    gravity: GravityMode,
    flying: bool,
    vortices: &[Vec2],
    hole: Option<Vec2>,
    hole_pulls: bool,
    pos: Vec2,
) -> Env {
    match gravity {
        // **The control that this task did not change the game everyone else is
        // playing.** Standard and low gravity get the same `Env` they got at
        // T22.11A: no field, no speed cap, so `integrate`'s two new lines add
        // exactly nothing and the scalar path's arithmetic is untouched.
        GravityMode::Standard | GravityMode::Low => Env::field_free(gravity),
        GravityMode::Space => {
            let outside = hole.is_none_or(|h| (pos - h).len() >= BLACK_HOLE_REACH);
            // R97 (was R96's wells-only cap): the wells and the vortices are summed
            // and capped together, then the hole is added onto that uncapped — one
            // summation, continued from the capped partial sum (`field_from`), not a
            // second loop. **Inside the hole's reach neither pulls** (R91 for the
            // wells; H1, T22.14A, for the vortices — their capped 675 on top of the
            // hole's 810 dragged bodies in from outside the horizon).
            //
            // **R100 (T22.14C): nor on a winged body, anywhere.** Wings are the
            // flying regime — `jetpack::gravity_scale` is 0 for them under every
            // gravity — and the ruling extends that to the fields: the asteroid
            // wells and a vortex's outer pull pass a winged player by. A vortex still
            // *captures* one inside `VORTEX_CAPTURE_R` (by radius, `World::step_vortices`,
            // not by pull), and the black hole still kills inside its horizon.
            //
            // **The hole's outer pull passes wings by too — builder's call, measured.**
            // R90's promise is that outside the horizon every escape works; wings'
            // horizontal control is the walking model's, below the hole's 810 px/s²
            // at the horizon, so with the pull on 26 of the 208 flights of
            // `black_hole::tests::from_just_outside_the_horizon_wings_fly_out_past_the_reach`
            // died (every pure LEFT/RIGHT side), and 0 with it off. The horizon stays
            // the line for a winged player: fly into it and you die.
            let (wells, vortices) = if flying || !outside {
                (false, &[][..])
            } else {
                (true, vortices)
            };
            let hole_pulls = hole_pulls && !flying;
            Env {
                gravity,
                accel: field_from(
                    capped_at(map, wells, vortices, pos),
                    hole.filter(|_| hole_pulls).map(Attractor::black_hole),
                    pos,
                ),
                max_speed: Some(SPACE_MAX_SPEED),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        GRAVITY, JETPACK_MAX_FUEL, JETPACK_MAX_SPEED, JETPACK_THRUST_DOWN, MAP_SMALL_W, PLAYER_H,
        SIM_DT, SPACE_ASTEROID_CORE_FRAC, SPACE_ASTEROID_R_MAX, SPACE_ASTEROID_R_MIN,
        SPACE_WELL_ESCAPE_MARGIN,
    };
    use crate::map::Map;
    use crate::physics::collide::tests::test_map;
    use crate::player::input::{button, Input};
    use crate::player::{MoveMods, MoveStep, MovementState};
    use crate::world::World;

    /// The closest a live player body's centre can get to a rock's centre: the
    /// core disc's radius plus half the body's height.
    ///
    /// `M22-RULINGS` R46's `d_min(r)`. The lumps only push you further out, and
    /// `Body::pos` is the body's centre — `clamp_to_world` uses `size.y / 2.0` the
    /// same way.
    fn d_min(r: i32) -> f32 {
        SPACE_ASTEROID_CORE_FRAC * r as f32 + PLAYER_H / 2.0
    }

    /// The largest radius a rock can have: the top of the base band, grown by the
    /// most mass a rock draws (R103).
    fn r_grown_max() -> i32 {
        crate::map::gen::space::grown_radius(
            SPACE_ASTEROID_R_MAX,
            crate::constants::SPACE_ASTEROID_MASS_MAX,
        )
    }

    fn rock(x: i32, y: i32, r: i32, level: u8) -> Asteroid {
        Asteroid {
            x,
            y,
            r,
            level,
            core_intact: true,
        }
    }

    /// A map with **rocks in its meta and nothing in its mask**.
    ///
    /// That separation is the point: the mask carries a rock's shape and collision,
    /// `meta.asteroids` carries its pull, and this fixture keeps the second without
    /// the first so that a body that moves has been moved by the field and not by a
    /// contact. A generated space map stamps both — `a_space_round_pulls_players_and_
    /// an_asteroid_free_one_moves_nobody` is the test that runs on one of those.
    fn field_map(w: u32, h: u32, rocks: &[Asteroid]) -> Map {
        let mut map = test_map(w, h, |_| {});
        map.meta.asteroids = rocks.to_vec();
        map
    }

    fn drifting(pos: Vec2) -> MovementState {
        let mut st = MovementState::new(crate::physics::body::Body::new(pos));
        st.body.grounded = false;
        st.body.airborne_ticks = 100;
        st
    }

    /// One tick of the real `apply_input`, with the real [`env_at`].
    ///
    /// Through `MovementState::step` and `env_at`, which are the two functions
    /// production calls. A fixture that composed its own `Env` would agree with
    /// itself forever while `World::apply_inputs` handed out something else.
    fn step(map: &Map, st: &mut MovementState, buttons: u8, gravity: GravityMode) {
        let input = Input::new(0, buttons, 0);
        let env = env_at(map, gravity, false, &[], None, false, st.body.pos);
        st.step(
            map,
            &input,
            &input,
            MoveStep {
                mods: MoveMods::NONE,
                env,
            },
            SIM_DT,
        );
    }

    // ---- the hole T22.11A left open ---------------------------------------

    /// **The test that closes the hole, and it is the reason this task is hard to
    /// do well.**
    ///
    /// All 20 tests in `player/space.rs` run on `void()` or `floor_at` — maps with
    /// no asteroids — so `T22.11A` deleted `integrate`'s one `forces.accel` line
    /// entirely and watched **1062 of 1062** still pass. Nothing in this repository
    /// could report a gravity field that never fires.
    ///
    /// **The near rock is the control and it is not optional.** *"A player far away
    /// does not accelerate"* is satisfied in full by a build in which the field is
    /// never applied at all, which is exactly the build that was green. The two
    /// halves have to be in the same test or the far half means nothing.
    ///
    /// Falsified three ways, each at the live binding site: deleting `integrate`'s
    /// `accel` line, making `env_at` answer `Env::field_free` for space, and
    /// flipping `pull_at`'s direction. All three fail the near half; only the third
    /// leaves the far half passing.
    #[test]
    fn a_player_near_a_rock_is_pulled_toward_it_and_one_past_the_cutoff_is_not() {
        let centre = Vec2::new(600.0, 300.0);
        let level = SPACE_LEVEL_MAX;
        // Dimensions are multiples of `CHUNK_SIZE` (256) because `Mask::new_empty`
        // insists, and wide enough that the far body's cutoff-plus-one sits inside
        // `clamp_to_world`'s bounds — a body held by the world clamp would report
        // "did not move" for the wrong reason.
        let map = field_map(
            1792,
            512,
            &[rock(
                centre.x as i32,
                centre.y as i32,
                SPACE_ASTEROID_R_MAX,
                level,
            )],
        );

        // Inside the well, and clear of the rock: one core radius plus a body.
        let near_at = centre + Vec2::new(d_min(SPACE_ASTEROID_R_MAX) + 20.0, 0.0);
        let mut near = drifting(near_at);
        // Past the cutoff by one pixel. The far body is on the same map, the same
        // tick count and the same code path — the only difference is `d >= reach`.
        let far_at = centre + Vec2::new(well_reach(&map.meta.asteroids[0]) + 1.0, 0.0);
        let mut far = drifting(far_at);

        for _ in 0..30 {
            step(&map, &mut near, 0, GravityMode::Space);
            step(&map, &mut far, 0, GravityMode::Space);
        }

        let inward = (centre - near_at).normalized();
        assert!(
            near.body.vel.dot(inward) > 0.0,
            "a player {:.1} px from a level-{level} rock ended half a second at \
             vel {:?}, which is not toward it",
            near_at.distance(centre),
            near.body.vel
        );
        // And it is a *pull*, not a nudge: the body has to have visibly closed the
        // gap, or "accelerated toward it" is satisfied by a rounding error.
        assert!(
            near.body.pos.distance(centre) < near_at.distance(centre) - 1.0,
            "the near body went from {:.2} px out to {:.2} px out",
            near_at.distance(centre),
            near.body.pos.distance(centre)
        );

        assert_eq!(
            far.body.vel,
            Vec2::ZERO,
            "a player one pixel past the cutoff was accelerated to {:?}",
            far.body.vel
        );
        assert_eq!(
            far.body.pos, far_at,
            "a player one pixel past the cutoff moved"
        );
    }

    /// **The production caller, which is a different claim from "the function
    /// works".** Twelve mechanisms in this tree were built, unit-tested and wired
    /// to nothing.
    ///
    /// This runs a real space `World` — a real space map, real generated rocks,
    /// `World::step` driving `apply_inputs` — and its control is the same world
    /// with `map.meta.asteroids` emptied, which is the one difference the field can
    /// see. In space nothing else accelerates a player who presses nothing, so
    /// "moved at all" is the whole signal and the control is what makes it one.
    ///
    /// *R101 (T22.15): the body starts half a band above a rock's top*, not at its
    /// spawn — a spawn is in open space, where there is no field any more
    /// (`beyond_the_band_the_pull_is_exactly_zero_on_every_seed`).
    #[test]
    fn a_space_round_pulls_players_and_an_asteroid_free_one_moves_nobody() {
        for scale in crate::constants::MapScale::ALL {
            let mut moved = 0usize;
            let mut still = 0usize;
            for asteroids in [true, false] {
                let mut w = World::with_gravity(
                    4242,
                    scale,
                    0,
                    crate::constants::DEFAULT_MAP_GENERATOR,
                    GravityMode::Space,
                );
                assert!(
                    !w.map.meta.asteroids.is_empty(),
                    "{scale:?}: a space world with no rocks to begin with"
                );
                let top = (0..w.map.meta.asteroids.len())
                    .find_map(|i| on_top(&w, i))
                    .expect("no rock with room on top");
                let start = top - Vec2::new(0.0, WELL_SURFACE_BAND / 2.0);
                if !asteroids {
                    w.map.meta.asteroids.clear();
                }
                w.set_phase(crate::world::RoundPhase::Playing);
                w.add_player(0, 0, "ana".into());
                {
                    let p = w.player_mut(0).expect("player 0");
                    p.body.pos = start;
                    p.body.vel = Vec2::ZERO;
                    p.body.grounded = false;
                }
                for tick in 0..60u32 {
                    w.queue_input(0, Input::new(tick + 1, 0, 0));
                    w.step(SIM_DT);
                }
                let p = w.player(0).expect("player 0");
                if asteroids {
                    if p.body.pos != start || p.body.vel != Vec2::ZERO {
                        moved += 1;
                    }
                } else {
                    assert_eq!(
                        (p.body.pos, p.body.vel),
                        (start, Vec2::ZERO),
                        "{scale:?}: a space round with no asteroids moved a player \
                         who pressed nothing — something other than the field is \
                         accelerating them, and this control cannot tell them apart"
                    );
                    still += 1;
                }
            }
            assert_eq!(
                (moved, still),
                (1, 1),
                "{scale:?}: the rocks made no difference to a player who pressed \
                 nothing, so `World::apply_inputs` is not applying the field"
            );
        }
    }

    // ---- R46: the escape ceiling, stated downward -------------------------

    /// **`M22-RULINGS` R46 — the ceiling is `JETPACK_THRUST_DOWN`, and it is
    /// asserted over the whole table.**
    ///
    /// R18 and the design record both wrote this guard against `JETPACK_THRUST_UP`
    /// = 2200, the pack's *strongest* axis. The pack is anisotropic — up 2200,
    /// sideways 1100, **down 900** — so the binding case is a player at rest on the
    /// **underside** of a rock, who must push downward to leave. A well of 1500
    /// px/s² passes the guard as originally written and traps that player forever
    /// with nothing on screen saying why.
    ///
    /// **Over the whole cross product, not at one radius** — every `(level, r)`
    /// pair up to the largest grown radius (R103), not only the achievable ones, so
    /// the guard is independent of `level_for`'s jitter arithmetic.
    ///
    /// *R101 (T22.15) moved the binding case:* the pull is now the level's full
    /// strength everywhere within one band of the rock (`well_reach`), so at
    /// `d_min` **every radius at the top level binds equally**, at exactly
    /// `SPACE_WELL_ACCEL_MAX` — it used to be the smallest rock, the one whose
    /// `d_min` sat deepest in a centre-anchored falloff.
    ///
    /// Falsified by `SPACE_WELL_ESCAPE_MARGIN` 0.75 → 1.5, which is the live
    /// binding site for every number in this test.
    #[test]
    fn no_well_traps_a_player_on_the_underside_of_a_rock() {
        let mut worst = (0.0f32, 0u8, 0i32);
        for level in 1..=SPACE_LEVEL_MAX {
            for r in SPACE_ASTEROID_R_MIN..=r_grown_max() {
                let a = Attractor::asteroid(&rock(0, 0, r, level));
                assert_eq!(a.kind, Kind::Asteroid, "the guard is scoped to asteroids");
                // Directly below the centre, which is the direction the pack is
                // weakest in. The magnitude is radial, so any bearing gives the
                // same number; the *bearing* is why the constant is the down one.
                let pull = a.pull_at(Vec2::new(0.0, d_min(r))).len();
                if pull > worst.0 {
                    worst = (pull, level, r);
                }
            }
        }
        let (pull, level, r) = worst;
        assert!(
            pull < JETPACK_THRUST_DOWN,
            "the worst well in the table pulls at {pull:.1} px/s² at the closest a \
             body can get (level {level}, r = {r}), against {JETPACK_THRUST_DOWN} \
             px/s² of down-thrust: a player on the underside of that rock is stuck \
             there for the rest of the round"
        );
        assert_eq!(
            level, SPACE_LEVEL_MAX,
            "the binding case moved off the top level (r = {r})"
        );
        // And the margin is the constant, so this cannot pass by the ceiling having
        // quietly become unreachable: a body on a level-5 rock feels exactly it.
        let expected = SPACE_WELL_ESCAPE_MARGIN * JETPACK_THRUST_DOWN;
        assert_eq!(
            pull, expected,
            "the worst pull {pull:.1} should be SPACE_WELL_ACCEL_MAX ({expected}) — a \
             body resting on a level-5 rock is inside its full-strength floor (R101)"
        );
    }

    /// **Escape is possible from every level on a full tank, measured downward and
    /// with the control that says the field is on.**
    ///
    /// The ceiling test above is arithmetic. This is the effect: a body at rest at
    /// `d_min` directly *below* the rock, holding DOWN, clears its own well before
    /// the tank runs dry — and the same body holding nothing is pulled in instead.
    /// Without that second half, "escaped" is satisfied by a field that never
    /// fires.
    ///
    /// **The escape *time* is now governed by the pull** (R101, T22.15): every
    /// level reaches the same one band past the rock, so the distance to clear is
    /// the same and a deeper well leaves less of the down thrust to cover it with —
    /// net 765 px/s² at level 1, 225 at level 5. (Before R101 the reach scaled with
    /// the level and `jetpack::apply_thrust`'s 260 px/s governor made the ticks
    /// scale with the reach instead.)
    #[test]
    fn a_full_tank_escapes_every_level_downward_and_a_deeper_well_takes_longer() {
        const TANK_TICKS: u32 = (JETPACK_MAX_FUEL / crate::constants::JETPACK_DRAIN) as u32 * 60;
        let mut ticks: Vec<u32> = Vec::new();

        for level in 1..=SPACE_LEVEL_MAX {
            let r = SPACE_ASTEROID_R_MIN;
            let centre = Vec2::new(600.0, 200.0);
            let map = field_map(
                1280,
                1280,
                &[rock(centre.x as i32, centre.y as i32, r, level)],
            );
            let start = centre + Vec2::new(0.0, d_min(r));

            // The control first, so a failure says which half broke: no input at
            // all, and the well must pull the body *in*.
            let mut held = drifting(start);
            for _ in 0..10 {
                step(&map, &mut held, 0, GravityMode::Space);
            }
            assert!(
                held.body.pos.distance(centre) < start.distance(centre),
                "level {level}: a body left alone under the rock did not fall \
                 toward it, so this fixture cannot tell an escape from a vacuum"
            );

            let mut out = drifting(start);
            let reach = well_reach(&map.meta.asteroids[0]);
            let mut escaped = None;
            for tick in 1..=TANK_TICKS {
                step(&map, &mut out, button::DOWN, GravityMode::Space);
                if out.body.pos.distance(centre) >= reach {
                    escaped = Some(tick);
                    break;
                }
            }
            let t = escaped.unwrap_or_else(|| {
                panic!(
                    "level {level}: {TANK_TICKS} ticks of down-thrust — one whole \
                     tank — got a body from {:.1} px out to {:.1} px out, and its \
                     well reaches {reach:.1}",
                    start.distance(centre),
                    out.body.pos.distance(centre)
                )
            });
            assert!(
                out.jet.fuel > 0.0,
                "level {level}: escaped on tick {t} but the tank was already empty"
            );
            ticks.push(t);
        }

        for w in ticks.windows(2) {
            assert!(
                w[1] > w[0],
                "escaping a deeper well was not slower: ticks per level were {ticks:?}"
            );
        }
    }

    /// **Level 5 outpulls level 1 by at least the level ratio, at the same
    /// distance** — the ratio R18 asked for, against the stated basis.
    ///
    /// Measured at a fixed distance on the rock (`d_min`, inside every level's
    /// full-strength floor since R101), so the ratio is the table's: exactly
    /// `SPACE_LEVEL_MAX`. (It was *more* than that while the reach grew with the
    /// level and the falloff was gentler for the longer reach.)
    #[test]
    fn the_pull_is_linear_in_the_level() {
        let probe = Vec2::new(0.0, d_min(SPACE_ASTEROID_R_MIN));
        let pulls: Vec<f32> = (1..=SPACE_LEVEL_MAX)
            .map(|n| {
                Attractor::asteroid(&rock(0, 0, SPACE_ASTEROID_R_MIN, n))
                    .pull_at(probe)
                    .len()
            })
            .collect();
        for w in pulls.windows(2) {
            assert!(
                w[1] > w[0],
                "the table is not monotone in the level: {pulls:?}"
            );
        }
        let ratio = pulls[SPACE_LEVEL_MAX as usize - 1] / pulls[0];
        assert!(
            ratio >= SPACE_LEVEL_MAX as f32,
            "level {SPACE_LEVEL_MAX} pulls {ratio:.2}x a level 1 rock at the same \
             distance, and the linear table says at least {SPACE_LEVEL_MAX}x: {pulls:?}"
        );
        // Stated where a reader will look for it: a level-5 surface is about half
        // of ordinary gravity, which is the sentence SPACE_WELL_ACCEL_MAX's doc
        // makes. Pinned loosely, because it is a feel claim and not a law.
        let deepest = pulls[SPACE_LEVEL_MAX as usize - 1];
        assert!(
            deepest > GRAVITY * 0.4 && deepest < GRAVITY * 0.55,
            "the deepest well is {deepest:.1} px/s² against GRAVITY {GRAVITY}"
        );
    }

    /// Every well reaches past its own rock's surface — otherwise a rock exists
    /// that a player can stand on and feel nothing from, which reads as the mode
    /// being broken on that rock and nowhere else.
    #[test]
    fn every_well_reaches_past_its_own_rocks_surface() {
        for level in 1..=SPACE_LEVEL_MAX {
            for r in SPACE_ASTEROID_R_MIN..=r_grown_max() {
                let a = Attractor::asteroid(&rock(0, 0, r, level));
                assert!(
                    a.reach > d_min(r),
                    "a level-{level} rock of radius {r} reaches {:.1} px and a body \
                     on it sits at {:.1} px",
                    a.reach,
                    d_min(r)
                );
                assert!(a.pull_at(Vec2::new(0.0, d_min(r))).len() > 0.0);
            }
        }
    }

    /// **Refinement B's inequality (T22.16): the band, measured from the rock's round
    /// body, still reaches a body standing on the outermost lump** — for every radius
    /// the generator makes. The farthest a body touching the rock can be is a lump at
    /// the bounding radius `r` touched by the box's far corner:
    /// `r + ½·hypot(PLAYER_W, PLAYER_H)`. Asserted with the spare printed; the control
    /// is the R102 core used instead (`SPACE_CORE_FRAC`): the same inequality fails on
    /// the big rocks — which is why the reach is not measured from it.
    ///
    /// And on the stamped rocks themselves: every generated rock of three seeds, every
    /// 5°, a body slid in along the bearing until it touches rock is pulled there.
    #[test]
    fn the_band_still_reaches_a_body_on_the_outermost_lump() {
        use crate::constants::{PLAYER_W, SPACE_CORE_FRAC};
        let corner = 0.5 * PLAYER_W.hypot(PLAYER_H);
        let mut spare = f32::MAX;
        let mut core_fails = 0;
        for r in SPACE_ASTEROID_R_MIN..=r_grown_max() {
            let a = rock(0, 0, r, 1);
            let farthest = r as f32 + corner;
            assert!(
                well_reach(&a) > farthest,
                "r {r}: the band ends at {:.1} px and a body on the outermost lump reaches \
                 {farthest:.1}",
                well_reach(&a)
            );
            spare = spare.min(well_reach(&a) - farthest);
            let from_core = SPACE_CORE_FRAC * r as f32 + PLAYER_H / 2.0 + WELL_SURFACE_BAND;
            core_fails += usize::from(from_core <= farthest);
        }
        eprintln!("least spare past the outermost lump: {spare:.2} px");
        assert!(
            core_fails > 0,
            "control: measured from the R102 core every rock still reaches — the choice of \
             radius is not what this test sees"
        );
        for seed in [POCKET_SEED, 7919, 15838] {
            let w = pocket_world_seed(seed);
            for a in &w.map.meta.asteroids {
                let c = Vec2::new(a.x as f32, a.y as f32);
                for k in 0..72 {
                    let t = k as f32 * std::f32::consts::TAU / 72.0;
                    let u = Vec2::new(t.cos(), t.sin());
                    let fits = |p: Vec2| {
                        !crate::physics::collide::aabb_overlaps_solid(
                            &w.map,
                            crate::math::Aabb::from_center_size(p, PLAYER_W, PLAYER_H),
                        )
                    };
                    let start = c + u * (a.r as f32 + corner + 1.0);
                    if !fits(start) {
                        continue;
                    }
                    // Slide in until the next quarter pixel would touch.
                    let rest = (1..)
                        .map(|i| start - u * (i as f32 * 0.25))
                        .take_while(|&p| fits(p))
                        .last()
                        .unwrap_or(start);
                    assert!(
                        Attractor::asteroid(a).pull_at(rest) != Vec2::ZERO,
                        "seed {seed} rock ({}, {}) r {}: a body resting at {rest:?} on bearing \
                         {k}×5° feels no pull",
                        a.x,
                        a.y,
                        a.r
                    );
                }
            }
        }
    }

    /// A level the wire should never carry is clamped into the table rather than
    /// trusted, so the escape ceiling is a claim about every `u8`.
    #[test]
    fn a_level_off_the_wire_is_clamped_into_the_table() {
        for bad in [0u8, SPACE_LEVEL_MAX + 1, 200, u8::MAX] {
            let a = Attractor::asteroid(&rock(0, 0, SPACE_ASTEROID_R_MIN, bad));
            let clamped = bad.clamp(1, SPACE_LEVEL_MAX);
            let expect = Attractor::asteroid(&rock(0, 0, SPACE_ASTEROID_R_MIN, clamped));
            assert_eq!(
                (a.strength, a.reach),
                (expect.strength, expect.reach),
                "level {bad} off the wire was not clamped to {clamped}"
            );
            assert!(
                a.pull_at(Vec2::new(0.0, d_min(SPACE_ASTEROID_R_MIN))).len() < JETPACK_THRUST_DOWN
            );
        }
    }

    // ---- determinism -----------------------------------------------------

    /// **The sum is taken in list order, and this fixture can tell.**
    ///
    /// Float addition is commutative, so two terms prove nothing about order: the
    /// smallest fixture that can is three. These three contributions are chosen so
    /// that folding them forward and folding them backward give **different
    /// `f32`s** — `assert_ne!` below is the control, and without it this test would
    /// pass for a `field_at` that iterated any way it liked.
    ///
    /// The expected value is folded from `pull_at`, not from a restatement of the
    /// falloff: what is under test here is the summation and its order.
    #[test]
    fn three_wells_sum_in_list_order_and_the_order_is_observable() {
        let probe = Vec2::ZERO;
        // The probe is inside all three reaches (R101: one band past each rock),
        // at three bearings, so each term is an irrational unit vector times a strength.
        let rocks = [
            rock(0, -60, SPACE_ASTEROID_R_MAX, 5),
            rock(-32, 30, 36, 4),
            rock(20, 45, 24, 3),
        ];
        let list: Vec<Attractor> = rocks.iter().map(Attractor::asteroid).collect();

        let fold = |order: &[&Attractor]| {
            let mut s = Vec2::ZERO;
            for a in order {
                s += a.pull_at(probe);
            }
            s
        };
        let forward = fold(&list.iter().collect::<Vec<_>>());
        let reverse = fold(&list.iter().rev().collect::<Vec<_>>());
        assert_ne!(
            forward, reverse,
            "this fixture cannot discriminate summation order, so the assertion \
             below proves nothing — pick three attractors whose f32 sum is \
             order-dependent"
        );

        assert_eq!(
            field_at(list.iter().copied(), probe),
            forward,
            "the field was not summed in list order"
        );
        // And the same list reached through the map, which is how production gets
        // it: `map.meta.asteroids` is a Vec and its order is the wire's order.
        let map = field_map(1024, 512, &rocks);
        assert_eq!(field_at(asteroid_attractors(&map), probe), forward);
    }

    /// **`M22-RULINGS` R36 — a level that differs between the two sides moves the
    /// state hash.** Red before green: `World::state_hash` hashed
    /// `self.map.mask.hash()` and nothing from `MapMeta`, so `level` was covered by
    /// the golden meta digest at *generation* time and by nothing at all at
    /// runtime — which is precisely when it started driving physics.
    ///
    /// `replay.rs`' own argument for leaving gravity unhashed — *"a world that ran
    /// under a different gravity diverges in `players`, which is hashed"* — does
    /// not apply to a field nothing reads yet, and it starts applying for the wrong
    /// reason the moment something does. The hash is the guard that localises a
    /// divergence to the tick it happened on; a field the two sides disagree about
    /// before the first tick has to be visible at tick zero.
    #[test]
    fn an_asteroid_that_differs_between_two_worlds_moves_the_state_hash() {
        let build = || {
            World::with_gravity(
                4242,
                crate::constants::MapScale::Small,
                0,
                crate::constants::DEFAULT_MAP_GENERATOR,
                GravityMode::Space,
            )
        };
        let server = build();
        assert!(!server.map.meta.asteroids.is_empty());
        assert_eq!(
            server.state_hash(),
            build().state_hash(),
            "two identically built space worlds disagree, so the assertions below \
             would fire for any reason at all"
        );

        // Each field the field-summation reads, one at a time.
        for (what, mutate) in [
            (
                "level",
                (|a: &mut Asteroid| a.level = a.level % SPACE_LEVEL_MAX + 1) as fn(&mut Asteroid),
            ),
            ("x", |a: &mut Asteroid| a.x += 1),
            ("y", |a: &mut Asteroid| a.y += 1),
            ("r", |a: &mut Asteroid| a.r += 1),
        ] {
            let mut client = build();
            mutate(&mut client.map.meta.asteroids[0]);
            assert_ne!(
                server.state_hash(),
                client.state_hash(),
                "a rock whose {what} differs between server and client hashes the \
                 same on both sides, so the determinism guard this milestone rests \
                 on cannot see the field the two are predicting against"
            );
        }

        // And dropping the whole table is the sharper R49 case: a networked client
        // today has *no* rocks, not stale ones.
        let mut empty = build();
        empty.map.meta.asteroids.clear();
        assert_ne!(server.state_hash(), empty.state_hash());
    }

    // ---- the speed clamp, which R50 says must bring its own guard ---------

    /// **`M22-RULINGS` R50 — this is the guard `T22.11B` owes, and it is not the
    /// one four documents nominated.**
    ///
    /// `resolve::no_tunnelling_at_ten_times_terminal_velocity_through_integrate`
    /// cannot see a `max_speed` fault: `apply_gravity` has already clamped `vel.y`
    /// to `MAX_FALL_SPEED` before the magnitude clamp runs, so on the scalar path
    /// the clamp is an exact no-op and `Forces::gravity` carrying
    /// `Some(MAX_FALL_SPEED)` leaves 1062/1062 passing. That test is named for a
    /// *speed* and asserts a *distance*, and an upper bound at that, which a clamp
    /// can only help.
    ///
    /// So this one drives a body on the **vector path** — `gravity_scale` is 0.0 in
    /// space, `apply_gravity` returns before touching `vel.y`, and nothing has
    /// clamped anything — past this mode's terminal speed, and asserts the speed
    /// itself. The control is the same body under standard gravity, where
    /// `max_speed` is `None` and the 9000 px/s survives: without it, "the speed is
    /// under the cap" is satisfied by a simulation that lost the velocity for any
    /// reason.
    #[test]
    fn space_clamps_a_bodys_speed_on_the_vector_path() {
        let fast = Vec2::new(7000.0, 5657.0);
        assert!(
            fast.len() > SPACE_MAX_SPEED * 5.0,
            "the fixture must exceed the cap"
        );
        // No rocks: the clamp is the only thing in this test, and a well would
        // make the number depend on where the body happened to be.
        let map = field_map(MAP_SMALL_W, 1024, &[]);

        let mut space = drifting(Vec2::new(900.0, 500.0));
        space.body.vel = fast;
        step(&map, &mut space, 0, GravityMode::Space);
        assert!(
            space.body.vel.len() <= SPACE_MAX_SPEED + 0.001,
            "a body at {:.0} px/s on the vector path ended the tick at {:.0} px/s, \
             and this mode's terminal speed is {SPACE_MAX_SPEED}",
            fast.len(),
            space.body.vel.len()
        );
        // The direction is kept — a terminal speed is a clamp, not a stop.
        assert!(space.body.vel.normalized().dot(fast.normalized()) > 0.999);

        let mut standard = drifting(Vec2::new(900.0, 500.0));
        standard.body.vel = fast;
        step(&map, &mut standard, 0, GravityMode::Standard);
        assert!(
            standard.body.vel.len() > SPACE_MAX_SPEED,
            "standard gravity clamped |vel| to {:.0} px/s, so the space assertion \
             above is not about space",
            standard.body.vel.len()
        );
    }

    /// The deepest single-well dive: a level-5 rock, from its reach down to `d_min` —
    /// measured by the test below. *T22.16: 194.4, exactly one band at 675 px/s²
    /// (`√(2·675·28)`) — the reach now starts at `d_min` itself (refinement B); 247.8 at
    /// R101, when it started at `r + PLAYER_H / 2`.*
    const WELL_DIVE: f32 = 194.4;

    /// [`SPACE_MAX_SPEED`] against the measurement its doc comment claims, the way
    /// `capacity.rs::max_rooms_carries_its_basis` pins the claim in its constant's
    /// doc — except that this one recomputes the basis instead of grepping for the
    /// word.
    ///
    /// `CLAUDE.md`: a suite where every assertion is pinned to the constant cannot
    /// detect the constant itself changing. The relations below are what make this
    /// number falsifiable — the attractors' own free-fall speeds, the diagonal
    /// jetpack burn it must not undercut, and the sub-step cap above which it is
    /// inert.
    #[test]
    fn space_max_speed_carries_its_basis() {
        // A free fall from an attractor's cutoff to the closest a body gets, integrated
        // numerically over its falloff — never a closed form typed into a comment.
        let dive = |a: Attractor, stop: f32, cap: f32| {
            let (mut d, mut energy) = (a.reach, 0.0f64);
            let dd = 0.01f32;
            while d > stop {
                energy += (a.pull_at(Vec2::new(0.0, d)).len().min(cap) * dd) as f64;
                d -= dd;
            }
            (2.0 * energy).sqrt() as f32
        };
        // R101 (T22.15): a well reaches one band past its rock, so its dive is short.
        let mut well = 0.0f32;
        for r in SPACE_ASTEROID_R_MIN..=r_grown_max() {
            let a = Attractor::asteroid(&rock(0, 0, r, SPACE_LEVEL_MAX));
            well = well.max(dive(a, d_min(r), f32::MAX));
        }
        assert!(
            (well - WELL_DIVE).abs() < 1.0,
            "the deepest single-well dive measures {well:.1} px/s and the doc says \
             {WELL_DIVE} — one of the two is stale"
        );
        // The other two attractors: a vortex (capped with the wells, R97) down to its
        // capture radius, the hole down to its horizon.
        let vortex = dive(
            Attractor::vortex(Vec2::ZERO),
            crate::constants::VORTEX_CAPTURE_R,
            SPACE_WELL_ACCEL_MAX,
        );
        let hole = dive(
            Attractor::black_hole(Vec2::ZERO),
            crate::constants::BLACK_HOLE_HORIZON_R,
            f32::MAX,
        );
        let worst = well.max(vortex).max(hole);
        assert!(
            SPACE_MAX_SPEED > worst * 1.5,
            "SPACE_MAX_SPEED {SPACE_MAX_SPEED} against the fastest honest dive \
             {worst:.1} px/s (well {well:.1}, vortex {vortex:.1}, hole {hole:.1}): \
             the clamp would fire on a fall toward one attractor"
        );
        // *R101 retired the upper bound* (was: under 2.5x the single-well dive, 695.8
        // px/s): with no field between rocks there is no chain of wells to run away
        // along, so the clamp now bounds only stacked thrust and pulls. Left at 1350
        // rather than retuned — T22.15 changes the field, not the speed.

        // R10's two named interactions, both computed here.
        let diagonal = (JETPACK_MAX_SPEED * JETPACK_MAX_SPEED * 2.0).sqrt();
        assert!(
            SPACE_MAX_SPEED > diagonal,
            "a magnitude clamp below the {diagonal:.1} px/s a diagonal jetpack \
             burn already reaches re-introduces the complaint \
             `jetpack::apply_thrust`'s comment exists to refuse"
        );
        // R10's third interaction — the sub-step cap above which this clamp would
        // be inert — is asserted in `physics::resolve`, because
        // `substep_guard::no_other_substep_derivation_exists` reads this crate's
        // source and forbids every file but that one from naming `MAX_SUBSTEPS`.
        // The guard is right and the assertion belongs in the file that owns the
        // cap: `resolve::tests::the_space_terminal_speed_is_not_inert_against_the_substep_cap`.
    }

    /// **The control: standard and low gravity are untouched.**
    ///
    /// Not "the numbers happen to match" — `env_at` hands those two modes the exact
    /// `Env` T22.11A handed them, on a map that *has* rocks, which is the only way
    /// this can fail. A build that summed the field regardless of mode passes every
    /// other test in this file.
    #[test]
    fn standard_and_low_gravity_see_no_field_however_many_rocks_are_on_the_map() {
        let rocks = [
            rock(300, 200, SPACE_ASTEROID_R_MAX, SPACE_LEVEL_MAX),
            rock(360, 240, SPACE_ASTEROID_R_MIN, 1),
        ];
        let map = field_map(1024, 512, &rocks);
        let at = Vec2::new(320.0, 220.0);

        for mode in [GravityMode::Standard, GravityMode::Low] {
            assert_eq!(
                env_at(&map, mode, false, &[], None, false, at),
                Env::field_free(mode),
                "{mode:?} picked up a field or a speed cap from a map with rocks on it"
            );
        }
        // The presence half, in the same test: the same map, the same point.
        let space = env_at(&map, GravityMode::Space, false, &[], None, false, at);
        assert_ne!(space.accel, Vec2::ZERO, "space read no field at all");
        assert_eq!(space.max_speed, Some(SPACE_MAX_SPEED));
    }

    // ---- R96: the summed wells are capped (T22.03G) --------------------------

    /// The seed of the traced pocket (T22.03E F7): a body under a rock ceiling that
    /// three wells summed to (18, −919) px/s² against `JETPACK_THRUST_DOWN` 900 —
    /// every direction held for 30 ticks moved it 0–1.8 px (re-traced at T22.17 to
    /// (534, 1344), raw −1120). **R101 (T22.15) dissolved it**: with wells one band
    /// deep, three rocks cannot reach one point, and the same spot reads (9, −405).
    /// The world is still this seed's; the pocket is now built on it
    /// ([`stacked_pocket`]), because the cap still has to hold where wells stack.
    const POCKET_SEED: u64 = 451_383;

    /// The first point on the map (32 px grid) with a clear 144 × 496 px box around
    /// it — room to stamp a fixture rock and move a body under it.
    fn open_column(w: &World) -> Vec2 {
        let clear = |c: Vec2| {
            (-4..=4).all(|i| {
                (-20..=10).all(|j| {
                    w.map.body_fits_at(crate::math::Point::new(
                        c.x as i32 + i * 16,
                        c.y as i32 + j * 16,
                    ))
                })
            })
        };
        let (mw, mh) = (w.map.mask.w as i32, w.map.mask.h as i32);
        (0..mh)
            .step_by(32)
            .flat_map(|y| {
                (0..mw)
                    .step_by(32)
                    .map(move |x| Vec2::new(x as f32, y as f32))
            })
            .find(|&c| clear(c))
            .expect("no open column on the map to build the fixture in")
    }

    /// **A pocket where two wells stack** (R96 after R101): two of the smallest
    /// level-5 rocks, cores stamped, side by side `POCKET_HALF_SPAN` either side of an
    /// open column, and the body resting against both undersides — inside both
    /// full-strength floors, so each pulls 675 px/s² and their upward components sum
    /// past the down thrust. Returns where the body rests.
    fn stacked_pocket(w: &mut World) -> Vec2 {
        use crate::constants::SPACE_ASTEROID_CORE_FRAC;
        let c = open_column(w);
        let r = SPACE_ASTEROID_R_MIN;
        let core = (SPACE_ASTEROID_CORE_FRAC * r as f32).round() as i32;
        for dx in [-POCKET_HALF_SPAN, POCKET_HALF_SPAN] {
            let x = c.x as i32 + dx;
            let _ = w.map.fill_circle(x, c.y as i32, core);
            w.map
                .meta
                .asteroids
                .push(rock(x, c.y as i32, r, SPACE_LEVEL_MAX));
        }
        // Lowest body centre whose box clears both discs, found rather than solved.
        let mut at = c;
        while crate::physics::collide::aabb_overlaps_solid(
            &w.map,
            crate::math::Aabb::from_center_size(at, crate::constants::PLAYER_W, PLAYER_H),
        ) || !touching(w, at)
        {
            at.y += 0.25;
        }
        at
    }

    /// Half the distance between the pocket's two rock centres, px.
    const POCKET_HALF_SPAN: i32 = 20;

    fn pocket_world() -> World {
        let mut w = World::with_gravity(
            POCKET_SEED,
            crate::constants::DEFAULT_MAP_SCALE,
            0,
            crate::constants::DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_phase(crate::world::RoundPhase::Playing);
        w
    }

    /// The raw, uncapped sum of every asteroid well at `pos` — the thing R96 caps.
    fn raw_wells(map: &Map, pos: Vec2) -> Vec2 {
        field_at(asteroid_attractors(map), pos)
    }

    /// **R96: the summed well pull never exceeds `SPACE_WELL_ACCEL_MAX` anywhere a
    /// body fits**, swept on an 8 px grid over the whole map for 9 seeds.
    ///
    /// **The presence half is what makes the sweep mean anything**: the cap must be
    /// exercised. Before R101 the generated maps did that themselves (the traced
    /// pocket among others); with wells one band deep they rarely stack, so the
    /// sweep ends at the built pocket ([`stacked_pocket`]), where the raw sum is over
    /// the cap and `env_at` must hand out exactly the cap. Planted: `capped_at`
    /// without its `clamp_len` → red here.
    #[test]
    fn the_summed_wells_never_exceed_the_cap_anywhere_in_open_air() {
        // f32 rounding of `clamp_len`'s rescale: a few ulps of the cap, no more.
        let tol = SPACE_WELL_ACCEL_MAX * 4.0 * f32::EPSILON;
        let mut over_raw = 0usize;
        let mut worst_raw = 0.0f32;
        let mut sampled = 0usize;
        let seeds: Vec<u64> = std::iter::once(POCKET_SEED)
            .chain((1..=8u64).map(|i| i * 7919))
            .collect();
        for &seed in &seeds {
            let w = World::with_gravity(
                seed,
                crate::constants::DEFAULT_MAP_SCALE,
                0,
                crate::constants::DEFAULT_MAP_GENERATOR,
                GravityMode::Space,
            );
            assert!(!w.map.meta.asteroids.is_empty(), "seed {seed}: no rocks");
            let (mw, mh) = (w.map.mask.w as i32, w.map.mask.h as i32);
            for y in (0..mh).step_by(8) {
                for x in (0..mw).step_by(8) {
                    if !w.map.body_fits_at(crate::math::Point::new(x, y)) {
                        continue;
                    }
                    sampled += 1;
                    let at = Vec2::new(x as f32, y as f32);
                    let raw = raw_wells(&w.map, at).len();
                    worst_raw = worst_raw.max(raw);
                    if raw > SPACE_WELL_ACCEL_MAX {
                        over_raw += 1;
                    }
                    let got = env_at(&w.map, GravityMode::Space, false, &[], None, false, at)
                        .accel
                        .len();
                    assert!(
                        got <= SPACE_WELL_ACCEL_MAX + tol,
                        "seed {seed} ({x}, {y}): the wells sum to {got:.1} px/s² \
                         (raw {raw:.1}) over the cap {SPACE_WELL_ACCEL_MAX}"
                    );
                }
            }
        }
        let mut w = pocket_world();
        let at = stacked_pocket(&mut w);
        let raw = raw_wells(&w.map, at).len();
        let got = env_at(&w.map, GravityMode::Space, false, &[], None, false, at)
            .accel
            .len();
        assert!(
            raw > SPACE_WELL_ACCEL_MAX && (got - SPACE_WELL_ACCEL_MAX).abs() <= tol,
            "the built pocket: raw {raw:.1}, handed out {got:.1}, cap {SPACE_WELL_ACCEL_MAX} \
             (the generated maps: {over_raw} of {sampled} points over the cap, worst \
             raw {worst_raw:.1} px/s²)"
        );
    }

    /// **R96, the effect: a human holding DOWN leaves the pocket** — through
    /// `World::step`, the server's own path, on a full tank from rest. Red before the
    /// cap: the body moved 0 px. The control in the same test: the raw sum there
    /// really does out-pull the down thrust, so this is the trap and not a quiet spot.
    /// *Since R101 the pocket is built* ([`stacked_pocket`]); the traced one is gone.
    #[test]
    fn a_human_holding_down_leaves_the_traced_pocket() {
        let mut w = pocket_world();
        let pocket = stacked_pocket(&mut w);
        let raw = raw_wells(&w.map, pocket);
        assert!(
            raw.y < -JETPACK_THRUST_DOWN,
            "the pocket moved: the raw wells there are ({:.0}, {:.0}), no longer over \
             the {JETPACK_THRUST_DOWN} px/s² down thrust — re-trace it",
            raw.x,
            raw.y
        );
        w.add_player(0, 0, "ana".into());
        {
            let p = w.player_mut(0).expect("seated");
            p.body.pos = pocket;
            p.body.vel = Vec2::ZERO;
            p.body.grounded = false;
        }
        let ticks = (POCKET_ESCAPE_S / SIM_DT).round() as u32;
        for tick in 0..ticks {
            w.queue_input(0, Input::new(tick + 1, button::DOWN, 0));
            w.step(SIM_DT);
        }
        let p = w.player(0).expect("seated");
        assert!(p.alive, "died in the pocket");
        let moved = p.body.pos.y - pocket.y;
        assert!(
            moved >= PLAYER_H,
            "{POCKET_ESCAPE_S} s of down-thrust from rest moved the body {moved:.1} px \
             down (from {pocket:?} to {:?}) — still held by the summed wells",
            p.body.pos
        );
    }

    /// How long the escape from the pocket may take: a second. Measured with the cap
    /// in the traced pocket (before R101): DOWN cleared `PLAYER_H` on tick 32 and was
    /// 107 px out at 60. Pushing away from the rock is the escape R46 guarantees.
    const POCKET_ESCAPE_S: f32 = 1.0;

    /// **R96's presence control: a well alone is never clamped.** At the worst
    /// point the table allows — the smallest rock at the top level, at `d_min`, the
    /// binding case of `no_well_traps_a_player_on_the_underside_of_a_rock` — `env_at`
    /// hands out exactly that rock's own `pull_at`, bit for bit. A cap set below the
    /// per-well ceiling would weaken every rock in the game and pass the sweep above.
    #[test]
    fn a_well_alone_still_pulls_at_its_full_strength() {
        for level in 1..=SPACE_LEVEL_MAX {
            for r in [SPACE_ASTEROID_R_MIN, SPACE_ASTEROID_R_MAX] {
                let a = rock(400, 400, r, level);
                let map = field_map(1024, 1024, &[a]);
                let at = Vec2::new(400.0, 400.0 + d_min(r));
                let alone = Attractor::asteroid(&a).pull_at(at);
                assert!(alone.len() > 0.0, "level {level} r {r}: no pull at all");
                assert_eq!(
                    env_at(&map, GravityMode::Space, false, &[], None, false, at).accel,
                    alone,
                    "level {level} r {r}: a lone well was changed by the cap"
                );
            }
        }
    }

    // ---- R97: the wells and the vortices are capped together (T22.03I) --------

    /// Three breaches through the rim (top, left, right), opened by the world's own
    /// step — three live vortices, the most that pull (R9). Returns their centres.
    fn three_live_vortices(w: &mut World) -> Vec<Vec2> {
        let geo = w.map.space_geometry().expect("space");
        for (x, y) in [
            (geo.cx, geo.cy - geo.ry),
            (geo.cx - geo.rx, geo.cy),
            (geo.cx + geo.rx, geo.cy),
        ] {
            let _ = w.map.carve_circle(
                x.round() as i32,
                y.round() as i32,
                crate::constants::METEOR_CARVE_R as i32,
            );
        }
        w.step(SIM_DT);
        w.vortices.iter().map(|v| v.pos).collect()
    }

    /// **R97: outside every capture radius, the summed pull never exceeds the cap** —
    /// wells and live vortices together, swept on an 8 px grid over the whole map for
    /// 9 seeds, three vortices each. Red at `c3f7861`, where the vortices were added
    /// on top of the capped wells (675 + up to 900 at `VORTEX_REACH / 2`).
    ///
    /// The presence half: the raw sum (wells + vortices) must exceed the cap
    /// somewhere in the sweep, or "never exceeded" is a property of the maps.
    #[test]
    fn beside_live_vortices_the_summed_pull_never_exceeds_the_cap() {
        use crate::constants::VORTEX_CAPTURE_R;
        let tol = SPACE_WELL_ACCEL_MAX * 4.0 * f32::EPSILON;
        let (mut over_raw, mut near_vortex) = (0usize, 0usize);
        for seed in std::iter::once(POCKET_SEED).chain((1..=8u64).map(|i| i * 7919)) {
            let mut w = World::with_gravity(
                seed,
                crate::constants::DEFAULT_MAP_SCALE,
                0,
                crate::constants::DEFAULT_MAP_GENERATOR,
                GravityMode::Space,
            );
            w.set_phase(crate::world::RoundPhase::Playing);
            let vs = three_live_vortices(&mut w);
            assert_eq!(
                vs.len(),
                3,
                "seed {seed}: the three breaches opened {} vortices",
                vs.len()
            );
            let (mw, mh) = (w.map.mask.w as i32, w.map.mask.h as i32);
            for y in (0..mh).step_by(8) {
                for x in (0..mw).step_by(8) {
                    let at = Vec2::new(x as f32, y as f32);
                    if vs.iter().any(|&v| (v - at).len() <= VORTEX_CAPTURE_R)
                        || !w.map.body_fits_at(crate::math::Point::new(x, y))
                    {
                        continue;
                    }
                    let raw = field_at(
                        asteroid_attractors(&w.map).chain(vs.iter().map(|&v| Attractor::vortex(v))),
                        at,
                    )
                    .len();
                    if raw > SPACE_WELL_ACCEL_MAX {
                        over_raw += 1;
                        near_vortex += usize::from(
                            vs.iter()
                                .any(|&v| (v - at).len() < crate::constants::VORTEX_REACH),
                        );
                    }
                    let got = env_at(&w.map, GravityMode::Space, false, &vs, None, false, at)
                        .accel
                        .len();
                    assert!(
                        got <= SPACE_WELL_ACCEL_MAX + tol,
                        "seed {seed} ({x}, {y}): wells and vortices pull {got:.1} px/s² (raw \
                         {raw:.1}) over the cap {SPACE_WELL_ACCEL_MAX}, outside every capture radius"
                    );
                }
            }
        }
        // *R101 (T22.15):* away from a vortex the wells no longer stack past the cap
        // on generated maps (the R96 sweep's built pocket covers that case), so only
        // the beside-a-vortex half is required here; the other is printed.
        assert!(
            near_vortex > 0,
            "the sweep never exercised the cap beside a vortex ({near_vortex}; away from \
             one {} of {over_raw})",
            over_raw - near_vortex
        );
    }

    /// Where the escape below sits from the vortex, as a fraction of `VORTEX_REACH`:
    /// just past half the reach, where the vortex alone pulls 0.45 × `VORTEX_ACCEL_MAX`
    /// (810 px/s²) — under the down thrust by itself, over it with the wells R96 left
    /// on top of it.
    const ESCAPE_REACH_FRAC: f32 = 0.55;

    /// **R97, the effect: a human under a rock, a vortex beyond it, holds DOWN and
    /// leaves** — through `World::step`, from rest, on a full tank. The rock is the
    /// binding case of R46 (the smallest rock at the top level, the body at `d_min`
    /// on its underside) stamped into open air on a real space map, and the vortex
    /// sits `ESCAPE_REACH_FRAC` of the reach above the body, through the rock. Red at
    /// `c3f7861`: the well (≈ 647) plus the vortex (810) held the body against the rock.
    ///
    /// The control in the same test: at `c3f7861`'s composition — the capped wells
    /// with the vortex added on top — the up-pull there really does out-pull the down
    /// thrust, so this is the trap and not a quiet spot.
    #[test]
    fn a_human_under_a_rock_beside_a_vortex_holds_down_and_leaves() {
        use crate::constants::{SPACE_ASTEROID_CORE_FRAC, VORTEX_REACH};
        let mut w = pocket_world();
        let r = SPACE_ASTEROID_R_MIN;
        let centre = open_column(&w);
        let _ = w.map.fill_circle(
            centre.x as i32,
            centre.y as i32,
            (SPACE_ASTEROID_CORE_FRAC * r as f32).round() as i32,
        );
        w.map
            .meta
            .asteroids
            .push(rock(centre.x as i32, centre.y as i32, r, SPACE_LEVEL_MAX));
        // Against the underside: the body's box clear of the rock, and touching it
        // once grown by a pixel (`balance.rs::touches`' definition).
        let start = centre + Vec2::new(0.0, d_min(r) + 1.0);
        let boxed = |grow: f32| {
            crate::physics::collide::aabb_overlaps_solid(
                &w.map,
                crate::math::Aabb::from_center_size(
                    start,
                    crate::constants::PLAYER_W + grow,
                    PLAYER_H + grow,
                ),
            )
        };
        assert!(
            !boxed(0.0) && boxed(2.0),
            "fixture: the body is not resting against the rock"
        );
        let vortex = start - Vec2::new(0.0, VORTEX_REACH * ESCAPE_REACH_FRAC);
        let mut seq = 0;
        let _ = crate::world::vortex::open(&mut w.vortices, &mut seq, vortex);
        let old = wells_at(&w.map, start) + Attractor::vortex(vortex).pull_at(start);
        assert!(
            old.y < -JETPACK_THRUST_DOWN,
            "control: at c3f7861's composition the pull under the rock is ({:.0}, {:.0}), not \
             over the {JETPACK_THRUST_DOWN} px/s² down thrust — no trap to leave",
            old.x,
            old.y
        );
        w.add_player(0, 0, "ana".into());
        {
            let p = w.player_mut(0).expect("seated");
            p.body.pos = start;
            p.body.vel = Vec2::ZERO;
            p.body.grounded = false;
        }
        let ticks = (POCKET_ESCAPE_S / SIM_DT).round() as u32;
        for tick in 0..ticks {
            w.queue_input(0, Input::new(tick + 1, button::DOWN, 0));
            w.step(SIM_DT);
        }
        let p = w.player(0).expect("seated");
        let moved = p.body.pos.y - start.y;
        assert!(
            p.alive && moved >= PLAYER_H,
            "{POCKET_ESCAPE_S} s of down-thrust from rest under the rock moved the body {moved:.1} \
             px (to {:?}) — still held by the wells and the vortex beyond",
            p.body.pos
        );
    }

    // ---- R101 (T22.15): wells are short-range ---------------------------------

    /// **R101: farther than one band from every rock, the pull is exactly zero** —
    /// every open-arena point (a body fits, inside the rim) on an 8 px grid, 9 seeds,
    /// through `env_at`, the function both sides call. Red at `7dee0df`: 99.8 % of
    /// those points were pulled.
    ///
    /// The presence half: points **inside** a band are pulled (or the sweep passes for
    /// a field that is off), and the far points are most of the arena — the owner's
    /// *"its fine to sometimes have no gravity at all and just float in space"*.
    #[test]
    fn beyond_the_band_the_pull_is_exactly_zero_on_every_seed() {
        let (mut far, mut near, mut near_pulled) = (0usize, 0usize, 0usize);
        for seed in report_seeds() {
            let w = pocket_world_seed(seed);
            let geo = w.map.space_geometry().expect("space");
            let (mw, mh) = (w.map.mask.w as i32, w.map.mask.h as i32);
            for y in (0..mh).step_by(8) {
                for x in (0..mw).step_by(8) {
                    let feet = crate::math::Point::new(x, y + (PLAYER_H / 2.0) as i32);
                    if !geo.inside(x as f32, y as f32) || !w.map.body_fits_at(feet) {
                        continue;
                    }
                    let at = Vec2::new(x as f32, y as f32);
                    let accel =
                        env_at(&w.map, GravityMode::Space, false, &[], None, false, at).accel;
                    let beyond =
                        w.map.meta.asteroids.iter().all(|a| {
                            at.distance(Vec2::new(a.x as f32, a.y as f32)) >= well_reach(a)
                        });
                    if beyond {
                        far += 1;
                        assert_eq!(
                            accel,
                            Vec2::ZERO,
                            "seed {seed} ({x}, {y}): more than a band from every rock and \
                             pulled at {accel:?}"
                        );
                    } else {
                        near += 1;
                        near_pulled += usize::from(accel != Vec2::ZERO);
                    }
                }
            }
        }
        assert!(
            near_pulled * 10 > near * 9,
            "inside a band only {near_pulled} of {near} points were pulled — the field is off"
        );
        let share = far as f32 / (far + near) as f32;
        assert!(
            share > OPEN_ARENA_FIELD_FREE_MIN,
            "only {:.1} % of the open arena is field-free ({far} of {})",
            100.0 * share,
            far + near
        );
    }

    /// The least share of the open arena that must be field-free after R101:
    /// measured **0.917** (363 293 of 396 213 points, `report_seeds`, T22.15),
    /// floored with room for a map sweep that crowds the rocks a little.
    const OPEN_ARENA_FIELD_FREE_MIN: f32 = 0.85;

    /// A stamped rock (core disc only, no lumps) in open air, its well in the meta.
    fn stamped_rock(level: u8, r: i32) -> (Map, Asteroid) {
        use crate::constants::SPACE_ASTEROID_CORE_FRAC;
        let a = rock(512, 512, r, level);
        let core = (SPACE_ASTEROID_CORE_FRAC * r as f32).round() as i32;
        let mut map = field_map(1024, 1024, &[a]);
        let _ = map.fill_circle(a.x, a.y, core);
        (map, a)
    }

    /// Directly above `a`, a body centre `h` px from its centre, at rest.
    fn above(a: &Asteroid, h: f32) -> MovementState {
        drifting(Vec2::new(a.x as f32, a.y as f32 - h))
    }

    fn touching_map(map: &Map, pos: Vec2) -> bool {
        crate::physics::collide::aabb_overlaps_solid(
            map,
            crate::math::Aabb::from_center_size(
                pos,
                crate::constants::PLAYER_W + 2.0,
                PLAYER_H + 2.0,
            ),
        )
    }

    /// **R101: a body just inside the band falls to the surface; just outside, it
    /// feels nothing** — every level, the smallest and largest rock, through the real
    /// `apply_input`. The inside body is one pixel in, where the pull is its weakest
    /// (a 28th of the level's strength), so this is the band's edge and not its core.
    #[test]
    fn a_body_just_inside_the_band_falls_to_the_surface_and_one_just_outside_stays() {
        let ticks = (BAND_FALL_S / SIM_DT).round() as u32;
        for level in 1..=SPACE_LEVEL_MAX {
            for r in [SPACE_ASTEROID_R_MIN, r_grown_max()] {
                let (map, a) = stamped_rock(level, r);
                let reach = well_reach(&a);
                let mut inside = above(&a, reach - 1.0);
                let mut outside = above(&a, reach + 1.0);
                let out_at = outside.body.pos;
                let mut landed = None;
                for t in 0..ticks {
                    step(&map, &mut inside, 0, GravityMode::Space);
                    step(&map, &mut outside, 0, GravityMode::Space);
                    if landed.is_none() && inside.body.grounded {
                        landed = Some(t);
                    }
                }
                assert!(
                    landed.is_some() && touching_map(&map, inside.body.pos),
                    "level {level} r {r}: a body one pixel inside the band did not land \
                     in {BAND_FALL_S} s (at {:?}, vel {:?})",
                    inside.body.pos,
                    inside.body.vel
                );
                assert_eq!(
                    (outside.body.pos, outside.body.vel),
                    (out_at, Vec2::ZERO),
                    "level {level} r {r}: a body one pixel outside the band moved"
                );
            }
        }
    }

    /// How long a body one pixel inside the band may take to land: measured 0.30 s
    /// (level 5, smallest rock) to **0.80 s** (level 1, largest), floored up.
    const BAND_FALL_S: f32 = 1.5;

    /// **R101: a hop lands back; a jump leaves** — on every level. Standing on a
    /// stamped rock, UP held just until the body is off the ground (the smallest lift
    /// a player can make — two ticks on every level here, ~70 px/s; one tick does
    /// not unground a body) comes back down onto the rock; a jump (430 px/s, the push-off) goes out past
    /// the band and keeps going, because nothing pulls out there. The jump is the
    /// control: without it, "lands back" is satisfied by a band that reaches forever.
    #[test]
    fn a_hop_on_a_rock_lands_back_and_a_jump_leaves() {
        let settle = (0.5 / SIM_DT).round() as u32;
        let after = (HOP_BACK_S / SIM_DT).round() as u32;
        for level in 1..=SPACE_LEVEL_MAX {
            for r in [SPACE_ASTEROID_R_MIN, r_grown_max()] {
                let (map, a) = stamped_rock(level, r);
                let core = (crate::constants::SPACE_ASTEROID_CORE_FRAC * r as f32).round();
                let rest = core + PLAYER_H / 2.0 + 0.5;
                for (buttons, back) in [(button::UP, true), (button::JUMP, false)] {
                    let mut st = above(&a, rest);
                    for _ in 0..settle {
                        step(&map, &mut st, 0, GravityMode::Space);
                    }
                    assert!(st.body.grounded, "level {level} r {r}: never came to rest");
                    // Pressed from nothing, so JUMP is an edge (`step` holds its input).
                    let (none, press) = (Input::new(0, 0, 0), Input::new(0, buttons, 0));
                    let env = env_at(
                        &map,
                        GravityMode::Space,
                        false,
                        &[],
                        None,
                        false,
                        st.body.pos,
                    );
                    st.step(
                        &map,
                        &press,
                        &none,
                        MoveStep {
                            mods: MoveMods::NONE,
                            env,
                        },
                        SIM_DT,
                    );
                    // The hop: UP held only until the body is off the ground — on a
                    // deep well one tick of it does not lift a body clear.
                    let mut held = 1;
                    while back && st.body.grounded && held < HOP_MAX_TICKS {
                        step(&map, &mut st, buttons, GravityMode::Space);
                        held += 1;
                    }
                    let (mut left, mut returned) = (!st.body.grounded, false);
                    let centre = Vec2::new(a.x as f32, a.y as f32);
                    for _ in 0..after {
                        step(&map, &mut st, 0, GravityMode::Space);
                        let on = st.body.grounded;
                        left |= !on;
                        returned |= left && on;
                        // The jump is judged a body past the band, before the world
                        // clamp at the map's edge can stop it.
                        if !back && st.body.pos.distance(centre) > well_reach(&a) + PLAYER_H {
                            break;
                        }
                    }
                    assert!(
                        left,
                        "level {level} r {r}: buttons {buttons:#x} never left the rock"
                    );
                    if back {
                        assert!(
                            returned,
                            "level {level} r {r}: a hop ({held} ticks of UP) did not land back in \
                             {HOP_BACK_S} s (at {:?})",
                            st.body.pos
                        );
                    } else {
                        assert!(
                            !returned
                                && st.body.pos.distance(centre) > well_reach(&a)
                                && st.body.vel.dot(st.body.pos - centre) > 0.0
                                && env_at(
                                    &map,
                                    GravityMode::Space,
                                    false,
                                    &[],
                                    None,
                                    false,
                                    st.body.pos
                                )
                                .accel
                                    == Vec2::ZERO,
                            "level {level} r {r}: a jump did not leave the band for good \
                             (at {:.1} px from the centre, reach {:.1})",
                            st.body.pos.distance(centre),
                            well_reach(&a)
                        );
                    }
                }
            }
        }
    }

    /// How long the hop may take to land back: measured 0.15 s (level 5) to **1.02 s**
    /// (level 1), floored up.
    const HOP_BACK_S: f32 = 2.0;

    /// The most ticks the hop may hold UP before it counts as not leaving.
    const HOP_MAX_TICKS: u32 = 10;

    // ---- R101 (T22.15): the measurements, before and after -----------------

    /// Seeds for the R101 measurements: the traced pocket's and eight more.
    fn report_seeds() -> Vec<u64> {
        std::iter::once(POCKET_SEED)
            .chain((1..=8u64).map(|i| i * 7919))
            .collect()
    }

    /// A body's box grown by a pixel each way overlaps rock (`balance.rs::touches`).
    fn touching(w: &World, pos: Vec2) -> bool {
        crate::physics::collide::aabb_overlaps_solid(
            &w.map,
            crate::math::Aabb::from_center_size(
                pos,
                crate::constants::PLAYER_W + 2.0,
                PLAYER_H + 2.0,
            ),
        )
    }

    /// Where a body rests on top of rock `i`: the first solid pixel down the rock's
    /// centre column, the body half a height above it. `None` when a body does not
    /// fit there (another rock, the rim).
    fn on_top(w: &World, i: usize) -> Option<Vec2> {
        let a = w.map.meta.asteroids[i];
        let top = (a.y - a.r - 4..=a.y).find(|&y| w.map.mask.get(a.x, y))?;
        let at = Vec2::new(a.x as f32, top as f32 - PLAYER_H / 2.0 - 0.5);
        let clear = !crate::physics::collide::aabb_overlaps_solid(
            &w.map,
            crate::math::Aabb::from_center_size(at, crate::constants::PLAYER_W, PLAYER_H),
        );
        clear.then_some(at)
    }

    /// Put player 0 at `at`, at rest, and step it `ticks` with `buttons(tick,
    /// grounded)`; returns the body centre and `grounded` after every tick.
    fn drive(
        w: &mut World,
        at: Vec2,
        ticks: u32,
        mut buttons: impl FnMut(u32, bool) -> u8,
    ) -> Vec<(Vec2, bool)> {
        {
            let p = w.player_mut(0).expect("seated");
            p.body.pos = at;
            p.body.vel = Vec2::ZERO;
            p.body.grounded = false;
            p.alive = true;
            // A full tank each run: the walk before a hop drains it in the air.
            p.jetpack = crate::player::JetpackState::default();
            p.jump = crate::player::JumpState::default();
        }
        let mut path = Vec::with_capacity(ticks as usize);
        let seq0 = w.last_simulated_seq(0).unwrap_or(0);
        for t in 0..ticks {
            let grounded = w.player(0).expect("seated").body.grounded;
            w.queue_input(0, Input::new(seq0 + t + 1, buttons(t, grounded), 0));
            w.step(SIM_DT);
            let b = &w.player(0).expect("seated").body;
            path.push((b.pos, b.grounded));
        }
        path
    }

    /// **R101's measurements** (T22.15): run at the commit before and after, the
    /// numbers written into the task file. A report: it prints, it asserts nothing.
    ///
    /// 1. the fraction of open arena (a body fits, inside the rim) with a nonzero
    ///    pull, 8 px grid, 9 seeds;
    /// 2. a free-floating player's drift over 5 s from each spawn point;
    /// 3. on each rock's top: how long a player stands with no input (10 s run),
    ///    how long one walking RIGHT stays on the rock, whether a hop (UP until
    ///    airborne) and a jump come back down onto that rock within 3 s.
    ///
    /// `R101_ALONE=1` is the control for 3: only the stood-on rock's well is left in
    /// the list, so what the neighbours' wells do is visible as the difference.
    #[test]
    #[ignore = "report: R101's before/after measurements, seconds in release"]
    fn short_range_wells_report() {
        let (mut open, mut pulled, mut strong) = (0usize, 0usize, 0usize);
        let mut sum = 0.0f64;
        let (mut drifts, mut moved) = (Vec::new(), 0usize);
        let (mut rocks, mut stood, mut walk_s, mut tap_back, mut jump_back) =
            (0usize, 0usize, Vec::new(), 0usize, 0usize);
        for seed in report_seeds() {
            let w = pocket_world_seed(seed);
            let geo = w.map.space_geometry().expect("space");
            let (mw, mh) = (w.map.mask.w as i32, w.map.mask.h as i32);
            for y in (0..mh).step_by(8) {
                for x in (0..mw).step_by(8) {
                    let feet = crate::math::Point::new(x, y + (PLAYER_H / 2.0) as i32);
                    if !geo.inside(x as f32, y as f32) || !w.map.body_fits_at(feet) {
                        continue;
                    }
                    open += 1;
                    let a = env_at(
                        &w.map,
                        GravityMode::Space,
                        false,
                        &[],
                        None,
                        false,
                        Vec2::new(x as f32, y as f32),
                    )
                    .accel
                    .len();
                    sum += a as f64;
                    pulled += usize::from(a > 0.0);
                    strong += usize::from(a > SPACE_WELL_ACCEL_MAX * 0.1);
                }
            }
            // 2: every player seated at a spawn, nothing pressed, 5 s.
            let mut w = pocket_world_seed(seed);
            for id in 0..crate::constants::MAX_PLAYERS as u8 {
                w.add_player(id, 0, format!("p{id}"));
            }
            let ids: Vec<u8> = (0..crate::constants::MAX_PLAYERS as u8).collect();
            let start: Vec<Vec2> = ids
                .iter()
                .map(|&i| w.player(i).expect("p").body.pos)
                .collect();
            for t in 0..(5.0 / SIM_DT).round() as u32 {
                for &i in &ids {
                    w.queue_input(i, Input::new(t + 1, 0, 0));
                }
                w.step(SIM_DT);
            }
            for (k, &i) in ids.iter().enumerate() {
                let d = w.player(i).expect("p").body.pos.distance(start[k]);
                moved += usize::from(d > 1.0);
                drifts.push(d);
            }
            // 3: on each rock's top.
            // A fresh world per rock: 27 s of steps a rock, and a round long
            // enough for the black hole to arrive and eat one would move the list.
            let fresh = pocket_world_seed(seed);
            for i in 0..fresh.map.meta.asteroids.len() {
                let mut w = pocket_world_seed(seed);
                w.add_player(0, 0, "ana".into());
                let Some(at) = on_top(&w, i) else { continue };
                let a = w.map.meta.asteroids[i];
                if std::env::var("R101_ALONE").is_ok() {
                    let keep = w.map.meta.asteroids[i];
                    w.map.meta.asteroids = vec![keep];
                }
                rocks += 1;
                let secs = |path: &[(Vec2, bool)], w: &World| {
                    // On the rock until the first second-long run of no contact.
                    let mut off = 0u32;
                    for (t, &(p, _)) in path.iter().enumerate() {
                        if touching(w, p) {
                            off = 0;
                        } else {
                            off += 1;
                            if off as f32 * SIM_DT >= 1.0 {
                                return (t as f32 + 1.0 - off as f32) * SIM_DT;
                            }
                        }
                    }
                    path.len() as f32 * SIM_DT
                };
                let ten = (10.0 / SIM_DT).round() as u32;
                let idle = drive(&mut w, at, ten, |_, _| 0);
                stood += usize::from(secs(&idle, &w) >= 10.0 - 1e-3);
                let walk = drive(&mut w, at, ten, |_, _| button::RIGHT);
                walk_s.push(secs(&walk, &w));
                let three = (3.0 / SIM_DT).round() as u32;
                let settle = (0.5 / SIM_DT).round() as u32;
                // Back **on this rock**: grounded again, touching it — a body that
                // lands on another rock or the rim has not come back.
                let c = Vec2::new(a.x as f32, a.y as f32);
                let lands = |path: &[(Vec2, bool)]| {
                    let after = &path[settle as usize..];
                    let left = after.iter().position(|&(_, g)| !g);
                    left.is_some_and(|l| {
                        after[l..]
                            .iter()
                            .any(|&(p, g)| g && p.distance(c) <= well_contact(&a) + 1.0)
                    })
                };
                // The hop: UP from rest, held only until the body is off the ground.
                let mut lifted = false;
                let hop = drive(&mut w, at, settle + three, |t, grounded| {
                    if t < settle || lifted {
                        return 0;
                    }
                    lifted = !grounded || t >= settle + HOP_MAX_TICKS;
                    if lifted {
                        0
                    } else {
                        button::UP
                    }
                });
                tap_back += usize::from(lands(&hop));
                let jump = drive(&mut w, at, settle + three, |t, _| {
                    if t == settle {
                        button::JUMP
                    } else {
                        0
                    }
                });
                jump_back += usize::from(lands(&jump));
            }
        }
        drifts.sort_by(f32::total_cmp);
        walk_s.sort_by(f32::total_cmp);
        let pct = |a: usize, b: usize| 100.0 * a as f32 / b.max(1) as f32;
        let q = |v: &[f32], f: f32| v[((v.len() - 1) as f32 * f) as usize];
        println!(
            "\nR101 report, {} seeds:\n  open arena: {open} points, {:.1}% with any pull, {:.1}% over a tenth of the cap, mean {:.1} px/s²",
            report_seeds().len(),
            pct(pulled, open),
            pct(strong, open),
            sum / open.max(1) as f64
        );
        println!(
            "  spawn drift over 5 s: {} players, {moved} moved > 1 px; p50 {:.1} p90 {:.1} max {:.1} px",
            drifts.len(),
            q(&drifts, 0.5),
            q(&drifts, 0.9),
            q(&drifts, 1.0)
        );
        println!(
            "  rock tops: {rocks}; stood 10 s idle {stood} ({:.1}%); walking RIGHT stays p10 {:.2} p50 {:.2} p90 {:.2} s; \
             a hop (UP until airborne) lands back on the rock {tap_back} ({:.1}%); a jump lands back {jump_back} ({:.1}%)",
            pct(stood, rocks),
            q(&walk_s, 0.1),
            q(&walk_s, 0.5),
            q(&walk_s, 0.9),
            pct(tap_back, rocks),
            pct(jump_back, rocks)
        );
    }

    fn pocket_world_seed(seed: u64) -> World {
        let mut w = World::with_gravity(
            seed,
            crate::constants::DEFAULT_MAP_SCALE,
            0,
            crate::constants::DEFAULT_MAP_GENERATOR,
            GravityMode::Space,
        );
        w.set_phase(crate::world::RoundPhase::Playing);
        w
    }

    // ---- T22.16: refinement B — the air gap, before and after --------------

    /// **Refinement B's measurement** (T22.16): how much air a body at the band's
    /// outer edge floats in before it touches its rock. For every rock of the report
    /// seeds, along 72 bearings: a body centre just inside `well_reach` on that bearing
    /// (skipped where it does not fit, is outside the rim, or feels no pull), then
    /// walked straight in toward the centre in quarter pixels until its box touches
    /// rock — the distance walked is the gap. Twice: the rocks as generated, and each
    /// carved by three craters of `0.4 r` centred on its bounding circle (the lumps
    /// blown off, the core untouched — it is `0.3 r` and the craters reach `0.6 r`).
    /// A report: it prints, it asserts nothing. Run at the commit before and after.
    #[test]
    #[ignore = "report: T22.16's air gap before/after, seconds in release"]
    fn well_air_gap_report() {
        let q = |v: &mut Vec<f32>, f: f32| -> f32 {
            v.sort_by(f32::total_cmp);
            v[((v.len() - 1) as f32 * f).round() as usize]
        };
        for carved in [false, true] {
            let (mut gaps, mut none) = (Vec::new(), 0usize);
            for seed in report_seeds() {
                let mut w = pocket_world_seed(seed);
                let rocks = w.map.meta.asteroids.clone();
                if carved {
                    for a in &rocks {
                        for k in 0..3 {
                            let t = k as f32 * std::f32::consts::TAU / 3.0;
                            let (cx, cy) = (
                                a.x + (a.r as f32 * t.cos()).round() as i32,
                                a.y + (a.r as f32 * t.sin()).round() as i32,
                            );
                            let _ = w
                                .map
                                .carve_circle(cx, cy, (0.4 * a.r as f32).round() as i32);
                        }
                    }
                }
                let geo = w.map.space_geometry().expect("space");
                let fits = |w: &World, p: Vec2| {
                    !crate::physics::collide::aabb_overlaps_solid(
                        &w.map,
                        crate::math::Aabb::from_center_size(
                            p,
                            crate::constants::PLAYER_W,
                            PLAYER_H,
                        ),
                    )
                };
                for a in &rocks {
                    let centre = Vec2::new(a.x as f32, a.y as f32);
                    let reach = well_reach(a);
                    for b in 0..72 {
                        let t = b as f32 * std::f32::consts::TAU / 72.0;
                        let u = Vec2::new(t.cos(), t.sin());
                        let edge = centre + u * (reach - 0.01);
                        if !geo.inside(edge.x, edge.y)
                            || !fits(&w, edge)
                            || Attractor::asteroid(a).pull_at(edge) == Vec2::ZERO
                            || !asteroid_attractors(&w.map).any(|x| x.pos == centre)
                        {
                            continue;
                        }
                        let hit = (1..=1600)
                            .map(|k| k as f32 * 0.25)
                            .find(|&d| !fits(&w, edge - u * d));
                        match hit {
                            Some(d) => gaps.push(d - 0.25),
                            None => none += 1,
                        }
                    }
                }
            }
            eprintln!(
                "air gap (carved={carved}): {} band-edge points, gap to rock along the pull \
                 p10 {:.1} p50 {:.1} p90 {:.1} max {:.1} px; no rock within 400 px {none}",
                gaps.len(),
                q(&mut gaps, 0.1),
                q(&mut gaps, 0.5),
                q(&mut gaps, 0.9),
                q(&mut gaps, 1.0),
            );
        }
    }

    // ---- T22.16: refinement A — a hollowed centre --------------------------

    /// The hollow the review of T22.15 carved: radius 32 at a rock's centre, room for
    /// a body to sit anywhere 20 px off it.
    const HOLLOW_R: i32 = 32;

    /// **Refinement A (T22.16): a body in a carved centre feels no pull or settles —
    /// it never bounces for seconds.** The reviewer's scenario at `8e6f59a`: a rock's
    /// centre hollowed out, a body at rest 20 px off it, and the well (full strength
    /// everywhere inside its reach, R101's step) swung it through the centre and back,
    /// ±20 px at ~54 px/s for as long as anyone watched — undamped. Three offsets
    /// (across, up, diagonal), the largest rock of the pocket seed, 10 s of real
    /// `World::step`; over the last 5 s the body may not move more than a pixel.
    ///
    /// Red at `8e6f59a`; green because a body-sized cavity that holds the centre has
    /// carved more than `SPACE_CORE_DESTROYED_FRAC` of the core (`cores.rs` proves the
    /// arithmetic), so the well is off before the first bounce.
    #[test]
    fn a_body_in_a_carved_centre_feels_nothing_or_settles() {
        let ticks = (10.0 / SIM_DT).round() as usize;
        let tail = (5.0 / SIM_DT).round() as usize;
        for off in [
            Vec2::new(20.0, 0.0),
            Vec2::new(0.0, 12.0),
            Vec2::new(12.0, 10.0),
        ] {
            let mut w = pocket_world_seed(POCKET_SEED);
            w.set_round_seconds(600.0);
            w.add_player(0, 0, String::new());
            let a = *w
                .map
                .meta
                .asteroids
                .iter()
                .max_by_key(|a| a.r)
                .expect("rocks");
            let _ = w.map.carve_circle(a.x, a.y, HOLLOW_R);
            let centre = Vec2::new(a.x as f32, a.y as f32);
            let start = centre + off;
            assert!(
                !crate::physics::collide::aabb_overlaps_solid(
                    &w.map,
                    crate::math::Aabb::from_center_size(
                        start,
                        crate::constants::PLAYER_W,
                        PLAYER_H
                    ),
                ),
                "premise: the body fits in the hollow at {off:?}"
            );
            let path = drive(&mut w, start, ticks as u32, |_, _| 0);
            let last = &path[ticks - tail..];
            let (lo, hi) = last.iter().fold(
                (Vec2::new(f32::MAX, f32::MAX), Vec2::new(f32::MIN, f32::MIN)),
                |(lo, hi), (p, _)| {
                    (
                        Vec2::new(lo.x.min(p.x), lo.y.min(p.y)),
                        Vec2::new(hi.x.max(p.x), hi.y.max(p.y)),
                    )
                },
            );
            let span = (hi - lo).len();
            let vel = w.player(0).expect("seated").body.vel;
            assert!(
                span <= 1.0,
                "offset {off:?} in a hollowed centre (rock r {} level {}): the body still \
                 swings {span:.1} px over the last 5 s (x {:.1}..{:.1}, y {:.1}..{:.1}), \
                 vel {vel:?}",
                a.r,
                a.level,
                lo.x,
                hi.x,
                lo.y,
                hi.y
            );
        }
    }
}
