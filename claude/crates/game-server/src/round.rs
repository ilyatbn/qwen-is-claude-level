//! Round phases, the restart vote and the periodic `round_state` broadcast
//! (`docs/41-server-loop-rooms.md` §3).
//!
//! The phase machine itself lives in `game-core` — it is part of the simulation
//! and a replay has to reproduce it. What lives here is everything that needs to
//! know about *connections*: how many players are attached, who voted, and when
//! to re-announce the state to a client that missed a transition.

use std::collections::BTreeMap;

use game_core::player::state::PlayerId;
use game_core::world::{GameEvent, RoundPhase, World};

/// How often `round_state` is re-broadcast during `Playing`, in seconds.
///
/// A client that missed a transition self-corrects within a second rather than
/// spending the round in the wrong phase (`docs/41` §3).
const ROUND_STATE_INTERVAL: f32 = 1.0;

pub struct RoundController {
    pub round_number: u32,
    pub seed: u64,
    /// `BTreeMap`, not `HashMap`: this is iterated to count the vote, and
    /// `HashMap` iteration order is randomly seeded per process. Nothing here
    /// depends on order today, but the generator already shipped one
    /// order-dependent bug from exactly this (`docs/70-amendments-v2.md` §A11).
    votes: BTreeMap<PlayerId, bool>,
    last_state_at: f32,
    /// Set once the `Ended` window has been resolved, so it resolves exactly once.
    resolved: bool,
    /// Seconds left before a full lobby starts, or `None` while it is not
    /// counting (`docs/72` §C18).
    ///
    /// It has its own accumulator because a `Lobby` room does not step the
    /// A player pressed "Start with bots": start regardless of head count.
    force_start: bool,
}

/// What the room should do after `tick`.
#[derive(Debug, PartialEq, Eq)]
pub enum RoundOutcome {
    Continue,
    /// A lobby is ready: seat bots, spawn players, go to `Warmup`.
    Start,
    /// Majority voted restart: rebuild the world on this seed and go to `Warmup`.
    Restart {
        seed: u64,
    },
    /// Nobody wanted another round.
    ToLobby,
}

impl RoundController {
    pub fn new(seed: u64) -> Self {
        RoundController {
            round_number: 0,
            seed,
            votes: BTreeMap::new(),
            last_state_at: f32::NEG_INFINITY,
            resolved: false,
            force_start: false,
        }
    }

    /// A vote is only meaningful during `Ended`; anything else is ignored rather
    /// than banked, or a player could pre-vote the next round.
    pub fn vote(&mut self, world: &World, id: PlayerId, restart: bool) {
        if world.phase != RoundPhase::Ended {
            return;
        }
        self.votes.insert(id, restart);
    }

    pub fn forget(&mut self, id: PlayerId) {
        self.votes.remove(&id);
    }

    /// "Start with bots" — the solo path (`docs/72` §C18).
    ///
    /// It sets a flag rather than changing the phase, so starting goes through
    /// the one place in `tick` that also seats bots. Two ways to begin a round
    /// is how one of them ends up not seating them.
    pub fn request_start(&mut self) {
        self.force_start = true;
    }

    /// The next seed, derived so a run of rounds is itself reproducible: when a
    /// sequence of maps produces a bad one, you can get back to it.
    pub fn next_seed(&self) -> u64 {
        // Splitmix-style mix of (seed, round_number) — cheap and well-distributed,
        // and deterministic, which is the only property that matters.
        let mut z = self
            .seed
            .wrapping_add(u64::from(self.round_number).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Majority of **connected** players.
    ///
    /// Non-voters abstain; they do not count as "no". A player who alt-tabs
    /// during the scoreboard should not veto the next round, and making silence
    /// a veto is how a lobby dies.
    fn restart_wins(&self, connected: usize) -> bool {
        let yes = self.votes.values().filter(|v| **v).count();
        let cast = self.votes.len();
        if cast == 0 {
            return false;
        }
        let _ = connected;
        yes * 2 > cast
    }

    /// Advance bookkeeping around the world's own phase machine.
    ///
    /// The world advances Warmup → Playing → Ended itself; this adds the
    /// connection-aware parts: entering Warmup when a lobby fills, the periodic
    /// re-broadcast, and resolving the vote when the `Ended` window closes.
    /// The lobby half, which **takes no world** — because a lobby does not have
    /// one (`docs/74-amendments-v6.md` §E1).
    ///
    /// Split out rather than guarded inside `tick`, because the only thing the
    /// old lobby branch read off the world was `tick` for the event stamp; a
    /// signature that demands a world to decide whether to build one is the
    /// wrong way round.
    pub fn tick_lobby(&mut self, tick: u32, dt: f32) -> (Vec<GameEvent>, RoundOutcome) {
        let _ = (tick, dt);
        // §E2 **retired the countdown.** A lobby starts when it fills, or when
        // its bot timeout expires, and both of those are decided in `Room` —
        // which is where the capacity, the roster and the timeout live. What is
        // left here is the manual path: a player pressing "start with bots".
        //
        // `LOBBY_COUNTDOWN` and `MIN_PLAYERS_TO_START` are gone with it. One
        // human plus four bots after ten seconds is a game; two humans and an
        // infinite wait is not.
        if self.force_start {
            self.force_start = false;
            return (Vec::new(), RoundOutcome::Start);
        }
        (Vec::new(), RoundOutcome::Continue)
    }

    /// The match half. `world` is present by construction: every phase below
    /// `Lobby` has one.
    pub fn tick(
        &mut self,
        world: &mut World,
        connected: usize,
        dt: f32,
    ) -> (Vec<GameEvent>, RoundOutcome) {
        let mut events = Vec::new();
        let now = world.round_time;
        let _ = dt;

        match world.phase {
            RoundPhase::Lobby => {}
            RoundPhase::Playing => {
                if now - self.last_state_at >= ROUND_STATE_INTERVAL {
                    self.last_state_at = now;
                    events.push(GameEvent::RoundState {
                        tick: world.tick,
                        phase: world.phase,
                        time_left: world.phase_time_left(),
                    });
                }
            }
            RoundPhase::Ended => {
                if !self.resolved && world.phase_time_left() <= 0.0 {
                    self.resolved = true;
                    return if self.restart_wins(connected) {
                        self.round_number += 1;
                        let seed = self.next_seed();
                        self.seed = seed;
                        self.votes.clear();
                        (events, RoundOutcome::Restart { seed })
                    } else {
                        self.votes.clear();
                        (events, RoundOutcome::ToLobby)
                    };
                }
            }
            RoundPhase::Warmup => {}
        }

        // Leaving `Ended` for any reason re-arms the resolver.
        if world.phase != RoundPhase::Ended {
            self.resolved = false;
        }
        (events, RoundOutcome::Continue)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use game_core::constants::{MapScale, SIM_DT};

    fn world_in(phase: RoundPhase) -> World {
        let mut w = World::new(1234, MapScale::Small);
        w.set_phase(phase);
        let _ = w.drain_events();
        w
    }

    #[test]
    fn a_majority_of_those_who_voted_restarts_the_round() {
        let w = world_in(RoundPhase::Ended);
        let mut r = RoundController::new(1234);
        r.vote(&w, 1, true);
        r.vote(&w, 2, true);
        r.vote(&w, 3, false);
        assert!(r.restart_wins(3));
    }

    /// The rule that shapes how the game feels between rounds.
    #[test]
    fn non_voters_abstain_rather_than_veto() {
        let w = world_in(RoundPhase::Ended);
        let mut r = RoundController::new(1234);
        // Two of six connected players vote yes; the other four say nothing.
        r.vote(&w, 1, true);
        r.vote(&w, 2, true);
        assert!(
            r.restart_wins(6),
            "silence from four of six players vetoed the restart"
        );

        // The control: an actual majority of NO still loses.
        let mut r2 = RoundController::new(1234);
        r2.vote(&w, 1, true);
        r2.vote(&w, 2, false);
        r2.vote(&w, 3, false);
        assert!(!r2.restart_wins(6));
    }

    #[test]
    fn nobody_voting_does_not_restart() {
        let mut r = RoundController::new(1234);
        assert!(!r.restart_wins(4));
        let _ = &mut r;
    }

    #[test]
    fn a_vote_outside_the_ended_window_is_ignored() {
        let w = world_in(RoundPhase::Playing);
        let mut r = RoundController::new(1234);
        r.vote(&w, 1, true);
        assert!(
            !r.restart_wins(1),
            "a vote cast during Playing was banked for the Ended window"
        );
    }

    #[test]
    fn the_next_seed_is_deterministic_and_differs_from_the_current() {
        let mut r = RoundController::new(0xABCD_1234);
        let a = r.next_seed();
        let b = r.next_seed();
        assert_eq!(a, b, "next_seed is not a function of state alone");
        assert_ne!(a, r.seed);
        r.round_number += 1;
        assert_ne!(
            a,
            r.next_seed(),
            "the round number does not affect the seed"
        );
    }

    #[test]
    fn round_state_is_rebroadcast_about_once_a_second_while_playing() {
        let mut w = world_in(RoundPhase::Playing);
        let mut r = RoundController::new(1);
        let mut broadcasts = 0;
        // Three seconds of ticks.
        for _ in 0..(3 * 60) {
            let (evs, _) = r.tick(&mut w, 1, SIM_DT);
            broadcasts += evs
                .iter()
                .filter(|e| matches!(e, GameEvent::RoundState { .. }))
                .count();
            w.step(SIM_DT);
        }
        assert!(
            (3..=4).contains(&broadcasts),
            "expected ~3 round_state broadcasts in 3 s, got {broadcasts}"
        );
    }

    /// The manual path (§C18's solo path, §E2's manual form of the timeout).
    ///
    /// The countdown tests that stood here are gone with the countdown: §E2
    /// retired `LOBBY_COUNTDOWN` and `MIN_PLAYERS_TO_START`, and the rule that
    /// replaced them — fill to capacity, or bots after the timeout — is decided
    /// in `Room`, so its tests live in `tests/public_lobby.rs` where the seats
    /// and the clock are.
    #[test]
    fn start_with_bots_starts_immediately() {
        let mut r = RoundController::new(1);
        assert_eq!(
            r.tick_lobby(0, SIM_DT).1,
            RoundOutcome::Continue,
            "a lobby nobody asked to start must not start itself"
        );
        r.request_start();
        assert_eq!(r.tick_lobby(0, SIM_DT).1, RoundOutcome::Start);
        // Once, not forever: the flag is consumed.
        assert_eq!(r.tick_lobby(0, SIM_DT).1, RoundOutcome::Continue);
    }

    #[test]
    fn the_ended_window_resolves_exactly_once() {
        let mut w = world_in(RoundPhase::Ended);
        let mut r = RoundController::new(1);
        r.vote(&w, 1, true);
        // Run the window out.
        for _ in 0..(25 * 60) {
            w.step(SIM_DT);
        }
        let (_, first) = r.tick(&mut w, 1, SIM_DT);
        assert!(matches!(first, RoundOutcome::Restart { .. }));
        let (_, second) = r.tick(&mut w, 1, SIM_DT);
        assert_eq!(
            second,
            RoundOutcome::Continue,
            "the window resolved twice, so a round would restart repeatedly"
        );
    }
}
