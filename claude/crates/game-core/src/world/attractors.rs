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
    GravityMode, BLACK_HOLE_ACCEL_MAX, BLACK_HOLE_REACH, SPACE_LEVEL_MAX, SPACE_MAX_SPEED,
    SPACE_WELL_ACCEL_MAX, SPACE_WELL_REACH_MAX, VORTEX_ACCEL_MAX, VORTEX_REACH,
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
    /// Acceleration at `pos`, px/s². Nothing can be *at* `pos` — the core disc is
    /// solid rock — so this is the top of a range no player reaches, and the
    /// number a player standing on the rock feels is this times the falloff at
    /// their closest approach. See [`Attractor::pull_at`].
    pub strength: f32,
    /// Centre-to-centre distance at which the pull reaches exactly zero, px.
    pub reach: f32,
    /// Which guarantee this one carries. See [`Kind`].
    pub kind: Kind,
}

impl Attractor {
    /// The well of one asteroid.
    pub fn asteroid(a: &Asteroid) -> Self {
        Attractor {
            pos: Vec2::new(a.x as f32, a.y as f32),
            strength: well_strength(a.level),
            reach: well_reach(a.level),
            kind: Kind::Asteroid,
        }
    }

    /// This attractor's contribution to the field at `pos`, px/s².
    ///
    /// Zero at and beyond [`Attractor::reach`], and zero exactly at the centre
    /// where the direction is undefined — a zero rather than a NaN, for the reason
    /// [`Vec2::normalized`] gives: NaN positions propagate silently and are
    /// miserable to debug. No player can occupy the centre of a rock, so that arm
    /// is a fixture guard rather than a game rule.
    pub fn pull_at(&self, pos: Vec2) -> Vec2 {
        let to_centre = self.pos - pos;
        let d = to_centre.len();
        if d == 0.0 || d >= self.reach {
            return Vec2::ZERO;
        }
        to_centre / d * (self.strength * (1.0 - d / self.reach))
    }
}

/// The pull at the centre of a level-`level` asteroid, px/s².
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

/// The reach of a level-`level` asteroid's well, centre to centre, px.
///
/// Linear in the level for the same reason [`well_strength`] is, and a function of
/// the **level** rather than of the rock's radius: the level is already monotone in
/// the radius by construction (`map::gen::space::level_for`), so a radius term
/// would be the same fact counted twice and R47 spells the law `R(n)`.
pub fn well_reach(level: u8) -> f32 {
    SPACE_WELL_REACH_MAX * table_level(level) / SPACE_LEVEL_MAX as f32
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
            reach: BLACK_HOLE_REACH,
            kind: Kind::BlackHole,
        }
    }
}

/// Every asteroid on this map as an attractor, in the map's own order.
///
/// The order is `place_asteroids`' order, which both sides receive — the server
/// generates it and `codec.rs::encode_map_init` writes it as a sequence. That is
/// what makes [`field_at`]'s sum reproducible across the wire.
pub fn asteroid_attractors(map: &Map) -> impl Iterator<Item = Attractor> + '_ {
    map.meta.asteroids.iter().map(Attractor::asteroid)
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

    fn rock(x: i32, y: i32, r: i32, level: u8) -> Asteroid {
        Asteroid { x, y, r, level }
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
        let far_at = centre + Vec2::new(well_reach(level) + 1.0, 0.0);
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
                if !asteroids {
                    w.map.meta.asteroids.clear();
                }
                w.set_phase(crate::world::RoundPhase::Playing);
                w.add_player(0, 0, "ana".into());
                let start = w.player(0).expect("player 0").body.pos;
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
    /// **Over the whole cross product, not at one radius.** Two reasons. Within the
    /// table the pull is largest at the *smallest* `d_min`, so the binding rock is
    /// the smallest one at the top level and not the biggest — R46 makes that point
    /// about `r = 54`, the smallest radius `level_for` can score as level 5. And
    /// iterating every `(level, r)` pair rather than only the achievable ones makes
    /// the guard independent of `level_for`'s jitter arithmetic, which is free to
    /// be retuned: `r = 24` at level 5 is not a rock the generator makes today, and
    /// the guard holds for it anyway.
    ///
    /// Falsified by `SPACE_WELL_ESCAPE_MARGIN` 0.75 → 1.5, which is the live
    /// binding site for every number in this test.
    #[test]
    fn no_well_traps_a_player_on_the_underside_of_a_rock() {
        let mut worst = (0.0f32, 0u8, 0i32);
        for level in 1..=SPACE_LEVEL_MAX {
            for r in SPACE_ASTEROID_R_MIN..=SPACE_ASTEROID_R_MAX {
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
            (level, r),
            (SPACE_LEVEL_MAX, SPACE_ASTEROID_R_MIN),
            "the binding case moved: it should be the *smallest* rock at the top \
             level, because `d_min` grows with the radius"
        );
        // And the margin is the constant, so this cannot pass by the ceiling having
        // quietly become unreachable.
        let expected = SPACE_WELL_ESCAPE_MARGIN * JETPACK_THRUST_DOWN;
        assert!(
            pull > expected * 0.9 && pull < expected,
            "the worst pull {pull:.1} should sit just under \
             SPACE_WELL_ACCEL_MAX ({expected}), not far below it — if it is far \
             below, the table has stopped being bounded by its own guard"
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
    /// **The escape *time* is governed by the reach, not by the pull, and that is
    /// worth knowing.** `jetpack::apply_thrust` is a speed governor: an axis it
    /// thrust is clamped back to `JETPACK_MAX_SPEED` whenever its pre-thrust speed
    /// was within it, so a player pushing away from a rock settles at 260 px/s
    /// whatever the well is doing, and the pull decides only whether they make
    /// progress at all. So the ticks below scale with `well_reach`, and the claim
    /// *"level 5 is harder to escape"* is carried here by *distance under thrust*
    /// and by `the_pull_is_linear_in_the_level` for the pull itself.
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
            let reach = well_reach(level);
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
    /// Measured at a fixed distance rather than at each rock's own surface, which
    /// isolates the pull from the reach. The basis is the table: the strength is
    /// linear in the level, so at a distance well inside every level's cutoff the
    /// ratio is at least `SPACE_LEVEL_MAX`, and it is more than that because the
    /// falloff term is gentler for the longer reach.
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
            for r in SPACE_ASTEROID_R_MIN..=SPACE_ASTEROID_R_MAX {
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
        let rocks = [
            rock(100, 40, SPACE_ASTEROID_R_MAX, 5),
            rock(-220, 150, 48, 4),
            rock(60, -310, 36, 3),
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

    /// [`SPACE_MAX_SPEED`] against the measurement its doc comment claims, the way
    /// `capacity.rs::max_rooms_carries_its_basis` pins the claim in its constant's
    /// doc — except that this one recomputes the basis instead of grepping for the
    /// word.
    ///
    /// `CLAUDE.md`: a suite where every assertion is pinned to the constant cannot
    /// detect the constant itself changing. The three relations below are what make
    /// this number falsifiable — the well's own free-fall speed, the diagonal
    /// jetpack burn it must not undercut, and the sub-step cap above which it is
    /// inert.
    #[test]
    fn space_max_speed_carries_its_basis() {
        // The fastest a single well can make you: a free fall from its cutoff to
        // the closest a body can get. Integrated numerically over the falloff,
        // rather than trusting a closed form typed into a comment.
        let mut worst = 0.0f32;
        for r in SPACE_ASTEROID_R_MIN..=SPACE_ASTEROID_R_MAX {
            let a = Attractor::asteroid(&rock(0, 0, r, SPACE_LEVEL_MAX));
            let (mut d, mut energy, stop) = (a.reach, 0.0f64, d_min(r));
            let dd = 0.01f32;
            while d > stop {
                energy += (a.pull_at(Vec2::new(0.0, d)).len() * dd) as f64;
                d -= dd;
            }
            worst = worst.max((2.0 * energy).sqrt() as f32);
        }
        assert!(
            (worst - 695.8).abs() < 1.0,
            "the deepest single-well dive measures {worst:.1} px/s and this \
             constant's doc comment says 695.8 — one of the two is stale"
        );
        assert!(
            SPACE_MAX_SPEED > worst * 1.5 && SPACE_MAX_SPEED < worst * 2.5,
            "SPACE_MAX_SPEED {SPACE_MAX_SPEED} against a {worst:.1} px/s \
             single-well dive: below ~1.5x the clamp fires on an honest fall \
             toward one rock, above ~2.5x it stops bounding anything"
        );

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

    /// The traced pocket (T22.03E F7): seed 451383 on the default scale, a body
    /// under a rock ceiling that three wells summed to (18, −919) px/s² against
    /// `JETPACK_THRUST_DOWN` 900 — every direction held for 30 ticks moved it 0–1.8 px.
    const POCKET_SEED: u64 = 451_383;
    const POCKET: Vec2 = Vec2::new(2194.0, 1235.0);

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
    /// body fits**, swept on an 8 px grid over the whole map for 8 seeds.
    ///
    /// **The presence half is what makes the sweep mean anything**: the raw sum must
    /// exceed the cap somewhere in the sweep (it does, at the traced pocket among
    /// others), or the cap was never exercised and "never exceeded" is a property of
    /// the maps, not of `env_at`. Planted: `wells_at` returning the raw sum → red here.
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
        assert!(
            over_raw > 0,
            "no sampled point's raw well sum exceeded the cap ({sampled} points, worst \
             {worst_raw:.1} px/s²) — the sweep never exercised the cap"
        );
    }

    /// **R96, the effect: a human holding DOWN leaves the traced pocket** — through
    /// `World::step`, the server's own path, on a full tank from rest. Red before the
    /// cap: the body moved 0 px. The control in the same test: the raw sum there
    /// really does out-pull the down thrust, so this is the trap and not a quiet spot.
    #[test]
    fn a_human_holding_down_leaves_the_traced_pocket() {
        let mut w = pocket_world();
        let raw = raw_wells(&w.map, POCKET);
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
            p.body.pos = POCKET;
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
        let moved = p.body.pos.y - POCKET.y;
        assert!(
            moved >= PLAYER_H,
            "{POCKET_ESCAPE_S} s of down-thrust from rest moved the body {moved:.1} px \
             down (from {POCKET:?} to {:?}) — still held by the summed wells",
            p.body.pos
        );
    }

    /// How long the escape from the traced pocket may take: a second. Measured with
    /// the cap: DOWN clears `PLAYER_H` on tick 32 and is 107 px out at 60; DOWN+LEFT
    /// / DOWN+RIGHT on tick 21. UP, LEFT, RIGHT and the up-diagonals still move 0–1.8
    /// px — pressed into the ceiling and a 1 px bump — which is the rock, not the
    /// field: pushing away from it is the escape R46 guarantees, and now has.
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
        assert!(
            near_vortex > 0 && over_raw > near_vortex,
            "the sweep never exercised the cap beside a vortex ({near_vortex}) or away from \
             one ({} of {over_raw})",
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
        let clear = |w: &World, c: Vec2| {
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
        let centre = (0..mh)
            .step_by(32)
            .flat_map(|y| {
                (0..mw)
                    .step_by(32)
                    .map(move |x| Vec2::new(x as f32, y as f32))
            })
            .find(|&c| clear(&w, c))
            .expect("no open column on the map to build the fixture in");
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
}
