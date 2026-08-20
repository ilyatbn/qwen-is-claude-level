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
}

/// What the room should do after `tick`.
#[derive(Debug, PartialEq, Eq)]
pub enum RoundOutcome {
    Continue,
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
    pub fn tick(
        &mut self,
        world: &mut World,
        connected: usize,
        min_to_start: usize,
    ) -> (Vec<GameEvent>, RoundOutcome) {
        let mut events = Vec::new();
        let now = world.round_time;

        match world.phase {
            RoundPhase::Lobby => {
                if connected >= min_to_start.max(1) {
                    world.set_phase(RoundPhase::Warmup);
                }
            }
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
            let (evs, _) = r.tick(&mut w, 1, 1);
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

    #[test]
    fn a_lobby_starts_once_it_has_enough_players() {
        let mut w = world_in(RoundPhase::Lobby);
        let mut r = RoundController::new(1);
        r.tick(&mut w, 0, 1);
        assert_eq!(w.phase, RoundPhase::Lobby, "started with nobody in it");
        r.tick(&mut w, 1, 1);
        assert_eq!(w.phase, RoundPhase::Warmup);
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
        let (_, first) = r.tick(&mut w, 1, 1);
        assert!(matches!(first, RoundOutcome::Restart { .. }));
        let (_, second) = r.tick(&mut w, 1, 1);
        assert_eq!(
            second,
            RoundOutcome::Continue,
            "the window resolved twice, so a round would restart repeatedly"
        );
    }
}
