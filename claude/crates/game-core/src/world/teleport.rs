//! Standing on a pad moves you (`docs/72-amendments-v4.md` §C5).
//!
//! Three rules, and every one of them exists because the obvious implementation
//! without it is unplayable:
//!
//! - **Arming.** A pad does nothing until you have moved `TELEPORT_ARM_DISTANCE`
//!   from where you spawned. Respawn puts you *on* a pad, so without this the
//!   first thing every death does is throw you somewhere else a charge later.
//! - **Charge.** `TELEPORT_CHARGE` seconds of standing on the pad, and stepping
//!   off resets it. A pad that fired on contact would be a trap, not a choice.
//! - **Cooldown.** `TELEPORT_COOLDOWN` after arriving, or you ping-pong: the pad
//!   you land on starts charging immediately and sends you straight back.
//!
//! ## Where the state lives
//!
//! On the player, in [`TeleportState`], reset by `respawn` — the arming rule is
//! per *life*, and a global flag would arm every pad for everyone the moment the
//! first player walked anywhere.

use crate::constants::{TELEPORT_ARM_DISTANCE, TELEPORT_CHARGE, TELEPORT_COOLDOWN};
use crate::map::meta::TeleportPad;
use crate::math::Vec2;

/// One player's relationship with the pads, for one life.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TeleportState {
    /// Body centre at the start of this life. The arming rule measures from it.
    ///
    /// **Per life, not a flag.** A `bool` set the first time anyone moved would
    /// stay set through every subsequent death, and the arming rule would protect
    /// only the very first respawn of the round.
    pub spawn_pos: Vec2,
    /// Whether this life has yet been `TELEPORT_ARM_DISTANCE` from `spawn_pos`.
    ///
    /// **Latched, and it has to be.** §C5 says a pad does nothing until the
    /// player *has moved* — past tense. Recomputing it from the current position
    /// each tick looks tidier and is wrong by construction: `TELEPORT_ARM_DISTANCE`
    /// (32) is larger than a pad's half-width (`PAD_W / 2` = 20), so the only way
    /// to be armed is to be standing off the pad, and walking back onto the pad
    /// you spawned on would disarm you again. The pad you respawn on would then be
    /// unusable for the whole life rather than for the first few seconds of it.
    /// The two fixtures that assert the arming rule are what found this.
    pub armed: bool,
    /// The pad currently charging, and for how long.
    ///
    /// One field rather than a pad id beside a float, because they are one fact:
    /// there is no such thing as a charge that belongs to no pad, and a pair that
    /// can express one is a pair that will eventually hold a stale charge from a
    /// pad you left.
    pub charging: Option<(u8, f32)>,
    /// Round time before which no pad will charge.
    pub ready_at: f32,
}

impl TeleportState {
    pub fn new(spawn_pos: Vec2, now: f32) -> Self {
        TeleportState {
            spawn_pos,
            armed: false,
            charging: None,
            // A fresh life is **not** on cooldown: the arming rule is what stops
            // the respawn pad firing, and stacking a cooldown on top would make
            // the pad you spawned on dead for five seconds after you had already
            // walked away from it.
            ready_at: now,
        }
    }

    /// `0.0..=1.0`, for the client's charge indicator.
    ///
    /// Derived, never stored: a second field holding the fraction is a field that
    /// disagrees with the timer the moment either is edited.
    pub fn charge_fraction(&self) -> f32 {
        match self.charging {
            Some((_, t)) => (t / TELEPORT_CHARGE).clamp(0.0, 1.0),
            None => 0.0,
        }
    }

    /// Latch the arming rule from where the body is now. Returns the new state.
    ///
    /// One place, called from [`step`] every tick a player is alive — including
    /// the ticks they are nowhere near a pad, because that is where the walking
    /// happens.
    pub fn observe(&mut self, pos: Vec2) -> bool {
        self.armed |= (pos - self.spawn_pos).len() >= TELEPORT_ARM_DISTANCE;
        self.armed
    }
}

/// What one tick of standing on pads did.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum TeleportStep {
    /// Nothing: off a pad, unarmed, on cooldown, or still charging.
    Idle,
    /// Charge complete on this pad — the caller picks a destination and moves the
    /// player. Deliberately **not** done here: choosing needs the RNG and the pad
    /// list, and moving needs the body, none of which belong to this state.
    Fire(u8),
}

/// Advance one player's pad state by `dt`.
///
/// `pos` is the body centre and `now` is round time. Returns `Fire` on the tick
/// the charge completes, and only then; the caller is responsible for the move,
/// for stamping `ready_at`, and for the event.
pub fn step(
    state: &mut TeleportState,
    pads: &[TeleportPad],
    pos: Vec2,
    grounded: bool,
    now: f32,
    dt: f32,
) -> TeleportStep {
    // **Before** the early return below: arming is about having walked, and the
    // walking happens away from the pads. Latching only while standing on one
    // would make the rule unsatisfiable.
    let armed = state.observe(pos);

    // Standing, not brushing past in mid-air: a pad is ground, and a jetpack
    // hovering through the rect for a whole charge is not "standing on" it.
    let under = if grounded {
        pads.iter().find(|p| p.underfoot(pos)).map(|p| p.id)
    } else {
        None
    };

    let Some(id) = under else {
        state.charging = None;
        return TeleportStep::Idle;
    };

    // Arming and cooldown reset the charge rather than freezing it, so the
    // charge starts when the pad actually becomes usable — a charge accumulated
    // while unusable would fire the instant it stopped being so.
    if !armed || now < state.ready_at {
        state.charging = None;
        return TeleportStep::Idle;
    }

    let elapsed = match state.charging {
        // Stepping from one pad straight onto another restarts the clock.
        Some((was, t)) if was == id => t + dt,
        _ => dt,
    };

    if elapsed >= TELEPORT_CHARGE {
        state.charging = None;
        return TeleportStep::Fire(id);
    }
    state.charging = Some((id, elapsed));
    TeleportStep::Idle
}

/// Where a pad sends you: any pad **other than** the one you are standing on.
///
/// Returns `None` when there is nowhere else to go, which is a one-pad map and a
/// no-op rather than a teleport to yourself.
pub fn destination(pads: &[TeleportPad], from: u8, rng: &mut crate::rng::ChaCha8Rng) -> Option<u8> {
    let others: Vec<u8> = pads.iter().map(|p| p.id).filter(|&id| id != from).collect();
    if others.is_empty() {
        return None;
    }
    let i = crate::rng::range_i32(rng, 0, others.len() as i32 - 1) as usize;
    Some(others[i])
}

/// Everything that happens to the state on arrival: cooldown, and re-basing the
/// arming rule on where you landed.
///
/// One function rather than three writes at the call site, because they are one
/// event and the third is the one a caller forgets. Arriving is not respawning —
/// you are standing on the destination pad now, and without re-basing `spawn_pos`
/// the pad you arrived on is already armed and fires the moment the cooldown
/// expires (`arriving_re_arms_from_the_destination` is the test).
pub fn arrive(state: &mut TeleportState, dest: Vec2, now: f32) {
    state.charging = None;
    state.spawn_pos = dest;
    state.armed = false;
    state.ready_at = now + TELEPORT_COOLDOWN;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{PLAYER_H, SIM_DT};
    use crate::math::Point;
    use crate::rng::substream;

    fn pads() -> Vec<TeleportPad> {
        vec![
            TeleportPad {
                id: 0,
                pos: Point::new(200, 500),
            },
            TeleportPad {
                id: 1,
                pos: Point::new(900, 500),
            },
            TeleportPad {
                id: 2,
                pos: Point::new(1600, 500),
            },
        ]
    }

    /// A body centre whose feet land exactly on pad `i`'s surface line.
    fn on_pad(p: &TeleportPad) -> Vec2 {
        Vec2::new(p.pos.x as f32, p.pos.y as f32 - PLAYER_H / 2.0)
    }

    /// Run `secs` of ticks and report the first `Fire`, if any.
    fn hold(state: &mut TeleportState, pads: &[TeleportPad], pos: Vec2, secs: f32) -> Option<u8> {
        let mut now = state.ready_at.max(0.0);
        let n = (secs / SIM_DT).ceil() as i32;
        for _ in 0..n {
            now += SIM_DT;
            if let TeleportStep::Fire(id) = step(state, pads, pos, true, now, SIM_DT) {
                return Some(id);
            }
        }
        None
    }

    #[test]
    fn standing_still_after_a_spawn_never_teleports() {
        let pads = pads();
        let spawn = on_pad(&pads[0]);
        let mut s = TeleportState::new(spawn, 0.0);
        // Ten times the charge time, standing exactly where we spawned.
        assert_eq!(
            hold(&mut s, &pads, spawn, TELEPORT_CHARGE * 10.0),
            None,
            "an unarmed pad fired"
        );
        assert_eq!(
            s.charge_fraction(),
            0.0,
            "an unarmed pad accumulated charge"
        );
    }

    /// The control for the test above: the *only* difference is having walked.
    ///
    /// It walks **off** the pad and back, because that is the only way to satisfy
    /// the rule — `TELEPORT_ARM_DISTANCE` (32) exceeds a pad's half-width
    /// (`PAD_W / 2` = 20), so "32 px from where I spawned" is always off the pad
    /// you spawned on. That is what makes the latch load-bearing rather than
    /// tidy: without it, coming back disarms you and the respawn pad is dead for
    /// the whole life.
    #[test]
    fn walking_off_the_pad_and_back_arms_it_and_then_it_fires() {
        let pads = pads();
        let spawn = on_pad(&pads[0]);
        let mut s = TeleportState::new(spawn, 0.0);

        let away = Vec2::new(spawn.x + TELEPORT_ARM_DISTANCE, spawn.y);
        assert!(
            !pads[0].underfoot(away),
            "the arm distance no longer clears the pad — this fixture is stale"
        );
        // One tick out there is all it takes; the pad is not involved.
        assert_eq!(
            step(&mut s, &pads, away, true, SIM_DT, SIM_DT),
            TeleportStep::Idle
        );
        assert!(s.armed, "walking the arm distance did not arm");

        // Back onto the pad, standing still.
        assert_eq!(
            hold(&mut s, &pads, spawn, TELEPORT_CHARGE * 2.0),
            Some(0),
            "an armed pad did not fire"
        );
    }

    #[test]
    fn just_under_the_arm_distance_does_not_arm() {
        let pads = pads();
        let spawn = on_pad(&pads[0]);
        let mut s = TeleportState::new(spawn, 0.0);
        assert!(!s.observe(Vec2::new(spawn.x + TELEPORT_ARM_DISTANCE - 1.0, spawn.y)));
        assert!(s.observe(Vec2::new(spawn.x + TELEPORT_ARM_DISTANCE, spawn.y)));
    }

    /// The latch, stated on its own: coming back does not undo it.
    #[test]
    fn arming_does_not_wear_off_when_you_walk_back() {
        let pads = pads();
        let spawn = on_pad(&pads[0]);
        let mut s = TeleportState::new(spawn, 0.0);
        assert!(s.observe(Vec2::new(spawn.x + TELEPORT_ARM_DISTANCE * 4.0, spawn.y)));
        assert!(
            s.observe(spawn),
            "walking back to the spawn point disarmed the player"
        );
    }

    /// The charge is `TELEPORT_CHARGE` long — measured at **both** ends.
    ///
    /// Every other fixture here holds for a multiple of the constant and asks
    /// only whether the pad fired, which is satisfied by any charge from one
    /// tick to three seconds. This one pins the duration itself: strictly
    /// nothing before the constant, and a `Fire` on the tick the constant names.
    /// It is the fixture that fails if `step` ever reads a literal instead of
    /// `TELEPORT_CHARGE`, and it is counted in **ticks** rather than seconds
    /// because both clocks here are accumulated `f32`s and a fixture that
    /// compares two drifting sums is a fixture that fails on a rounding change.
    #[test]
    fn the_charge_lasts_exactly_teleport_charge() {
        let pads = pads();
        let mut s = TeleportState::new(Vec2::new(0.0, 0.0), 0.0);
        let here = on_pad(&pads[1]);

        // `step` fires the first tick its accumulated hold reaches the charge,
        // and the first tick contributes one `SIM_DT`.
        let due = (TELEPORT_CHARGE / SIM_DT).ceil() as i32;
        // One tick of slack on the far side, and only there: `step` sums `dt`
        // the same way this loop does, so the sum can land a hair under the
        // constant on the tick that arithmetic says is due.
        let mut fired_on = None;
        let mut now = 0.0;
        for tick in 1..=due + 1 {
            now += SIM_DT;
            if let TeleportStep::Fire(id) = step(&mut s, &pads, here, true, now, SIM_DT) {
                fired_on = Some((id, tick));
                break;
            }
        }
        let (id, tick) = fired_on.unwrap_or_else(|| {
            panic!(
                "the pad had not fired after {} ticks, past TELEPORT_CHARGE ({TELEPORT_CHARGE} s)",
                due + 1
            )
        });
        assert_eq!(id, 1, "the wrong pad fired");
        assert!(
            tick >= due,
            "fired on tick {tick} of {due} — {:.3} s into a {TELEPORT_CHARGE} s charge",
            tick as f32 * SIM_DT
        );
    }

    #[test]
    fn stepping_off_the_pad_resets_the_charge() {
        let pads = pads();
        let mut s = TeleportState::new(Vec2::new(0.0, 0.0), 0.0);
        let here = on_pad(&pads[1]);

        // Most of the way there...
        let mut now = 0.0;
        while s.charge_fraction() < 0.8 {
            now += SIM_DT;
            assert_eq!(
                step(&mut s, &pads, here, true, now, SIM_DT),
                TeleportStep::Idle
            );
        }
        // ...then one tick in mid-air off the pad.
        now += SIM_DT;
        step(
            &mut s,
            &pads,
            Vec2::new(here.x + 400.0, here.y),
            true,
            now,
            SIM_DT,
        );
        assert_eq!(s.charge_fraction(), 0.0, "the charge survived stepping off");
    }

    #[test]
    fn a_pad_does_nothing_while_you_are_in_the_air_over_it() {
        let pads = pads();
        let mut s = TeleportState::new(Vec2::new(0.0, 0.0), 0.0);
        let here = on_pad(&pads[1]);
        let mut now = 0.0;
        for _ in 0..((TELEPORT_CHARGE * 3.0 / SIM_DT) as i32) {
            now += SIM_DT;
            assert_eq!(
                step(&mut s, &pads, here, false, now, SIM_DT),
                TeleportStep::Idle,
                "a hovering player charged a pad"
            );
        }
    }

    #[test]
    fn teleporting_twice_inside_the_cooldown_is_refused() {
        let pads = pads();
        let mut s = TeleportState::new(Vec2::new(0.0, 0.0), 0.0);
        let here = on_pad(&pads[1]);

        let fired = hold(&mut s, &pads, here, TELEPORT_CHARGE * 2.0);
        assert_eq!(fired, Some(1), "the first teleport did not fire");

        // Arrive somewhere, which stamps the cooldown.
        let now = TELEPORT_CHARGE * 2.0;
        arrive(&mut s, Vec2::new(0.0, 0.0), now);
        let dest = on_pad(&pads[2]);

        // Stand on the destination for less than the cooldown: nothing.
        let mut t = now;
        let mut fired_again = None;
        while t < now + TELEPORT_COOLDOWN - SIM_DT {
            t += SIM_DT;
            if let TeleportStep::Fire(id) = step(&mut s, &pads, dest, true, t, SIM_DT) {
                fired_again = Some(id);
                break;
            }
        }
        assert_eq!(
            fired_again, None,
            "a second teleport fired inside the cooldown"
        );

        // The control: keep standing past the cooldown and it does fire, so the
        // assertion above is about the cooldown and not about the pad being dead.
        let mut fired_after = None;
        while t < now + TELEPORT_COOLDOWN + TELEPORT_CHARGE * 2.0 {
            t += SIM_DT;
            if let TeleportStep::Fire(id) = step(&mut s, &pads, dest, true, t, SIM_DT) {
                fired_after = Some(id);
                break;
            }
        }
        assert_eq!(fired_after, Some(2), "the pad never came off cooldown");
    }

    /// Arriving re-bases the arming rule, or the destination pad is already armed
    /// and fires you straight on the moment the cooldown expires.
    #[test]
    fn arriving_re_arms_from_the_destination() {
        let pads = pads();
        let dest = on_pad(&pads[2]);
        let mut s = TeleportState::new(Vec2::new(0.0, 0.0), 0.0);
        assert!(
            s.observe(dest),
            "the fixture starts unarmed, so this proves nothing"
        );

        arrive(&mut s, dest, 10.0);
        assert!(!s.armed, "the destination pad was still armed on arrival");

        // Stand on it well past the cooldown: nothing, because you have not moved.
        let mut t = 10.0;
        while t < 10.0 + TELEPORT_COOLDOWN + TELEPORT_CHARGE * 3.0 {
            t += SIM_DT;
            assert_eq!(
                step(&mut s, &pads, dest, true, t, SIM_DT),
                TeleportStep::Idle,
                "the pad fired without the player moving off it"
            );
        }

        // The control: walk off, come back, and it works again.
        let away = Vec2::new(dest.x + TELEPORT_ARM_DISTANCE, dest.y);
        t += SIM_DT;
        step(&mut s, &pads, away, true, t, SIM_DT);
        assert!(s.armed, "the walk did not re-arm");

        let mut fired = None;
        while t < 10.0 + TELEPORT_COOLDOWN + TELEPORT_CHARGE * 6.0 {
            t += SIM_DT;
            if let TeleportStep::Fire(id) = step(&mut s, &pads, dest, true, t, SIM_DT) {
                fired = Some(id);
                break;
            }
        }
        assert_eq!(fired, Some(2), "the pad never worked again");
    }

    #[test]
    fn a_destination_is_never_the_pad_you_are_standing_on() {
        let pads = pads();
        let mut rng = substream(4242, "teleport");
        for _ in 0..200 {
            for from in 0..3u8 {
                let to = destination(&pads, from, &mut rng).expect("no destination");
                assert_ne!(to, from);
            }
        }
    }

    #[test]
    fn destinations_actually_vary() {
        // Otherwise "never the one you are on" is satisfied by always picking the
        // same other pad, which is a teleport with one exit.
        let pads = pads();
        let mut rng = substream(7, "teleport");
        let mut seen = std::collections::HashSet::new();
        for _ in 0..100 {
            seen.insert(destination(&pads, 0, &mut rng).expect("no destination"));
        }
        assert!(seen.len() > 1, "every destination from pad 0 was {seen:?}");
    }

    #[test]
    fn one_pad_has_nowhere_to_send_you() {
        let pads = vec![TeleportPad {
            id: 0,
            pos: Point::new(100, 100),
        }];
        let mut rng = substream(1, "teleport");
        assert_eq!(destination(&pads, 0, &mut rng), None);
    }

    #[test]
    fn stepping_between_two_pads_restarts_the_clock() {
        let pads = pads();
        let mut s = TeleportState::new(Vec2::new(0.0, 0.0), 0.0);
        let a = on_pad(&pads[0]);
        let b = on_pad(&pads[1]);

        let mut now = 0.0;
        while s.charge_fraction() < 0.9 {
            now += SIM_DT;
            step(&mut s, &pads, a, true, now, SIM_DT);
        }
        now += SIM_DT;
        step(&mut s, &pads, b, true, now, SIM_DT);
        assert!(
            s.charge_fraction() < 0.1,
            "pad 0's charge carried over to pad 1: {}",
            s.charge_fraction()
        );
    }
}
