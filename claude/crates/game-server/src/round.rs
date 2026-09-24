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
    /// The tally last announced in `round_state`, so a change — a vote, or a
    /// human leaving — is announced once and not sixty times a second (T21.38).
    /// `None` outside `Ended`, so entering the window always announces.
    announced_tally: Option<VoteTally>,
    /// Seconds left before a full lobby starts, or `None` while it is not
    /// counting (`docs/72` §C18).
    ///
    /// It has its own accumulator because a `Lobby` room does not step the
    /// A player pressed "Start with bots": start regardless of head count.
    force_start: bool,
}

/// The restart vote as the clients are shown it: `yes` of `humans` seated.
///
/// Carried on `round_state` during `Ended` (T21.38 R4). Bots are in neither
/// number — they do not vote and do not count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoteTally {
    pub yes: usize,
    pub humans: usize,
}

/// What the room should do after `tick`.
#[derive(Debug, PartialEq, Eq)]
pub enum RoundOutcome {
    Continue,
    /// A lobby is ready: seat bots, spawn players, go to `Warmup`.
    Start,
    /// Every seated human voted restart: rebuild the world on this seed and go
    /// to `Warmup`.
    Restart {
        seed: u64,
    },
    /// Nobody wanted another round. `seed` is the one the **next** match from
    /// the lobby is built on (T21.32 item 2) — see [`RoundController::advance_seed`].
    ToLobby {
        seed: u64,
    },
}

impl RoundController {
    pub fn new(seed: u64) -> Self {
        RoundController {
            round_number: 0,
            seed,
            votes: BTreeMap::new(),
            last_state_at: f32::NEG_INFINITY,
            resolved: false,
            announced_tally: None,
            force_start: false,
        }
    }

    /// A vote is only meaningful during `Ended`; anything else is ignored rather
    /// than banked, or a player could pre-vote the next round.
    ///
    /// **Returns whether it was counted** (T21.32 item 1). The client used to
    /// show "Voted" on the click, and a click after the window had closed — the
    /// only kind a stuck results screen could produce — showed it too while this
    /// discarded the vote. Only the server knows which side of the window a vote
    /// landed on, so it says.
    pub fn vote(&mut self, world: &World, id: PlayerId, restart: bool) -> bool {
        if world.phase != RoundPhase::Ended || self.resolved {
            return false;
        }
        self.votes.insert(id, restart);
        true
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

    /// Step to the next round's seed and return it.
    ///
    /// **One step for both ways a round can follow a round** (T21.32 item 2). It
    /// lived inline in the `Restart` branch only, so a room whose vote failed went
    /// back to the lobby still holding the seed it had just played — and the next
    /// lobby start regenerated the identical map, ground texture and all.
    /// Reported from play: two rounds in `room=1`, both
    /// `map generated seed=222892591914436108`.
    pub fn advance_seed(&mut self) -> u64 {
        self.round_number += 1;
        let seed = self.next_seed();
        self.seed = seed;
        seed
    }

    /// **Every seated human voted yes**, and there is at least one of them.
    ///
    /// The owner's ruling, 2026-09-15 (T21.38): *"as long as all human players
    /// vote yes, restart. If not, title screen."* It replaces T21.32's majority
    /// of the votes cast, whose argument — silence should abstain, not veto — is
    /// overruled: silence is now a no, and so is a no.
    ///
    /// `humans` is `Room::human_count` at the moment of resolution, so:
    /// - **bots never count.** They have no socket and cannot vote, and a room
    ///   of one human and three bots restarts on that one human's yes;
    /// - **a human who leaves during the window does not block** (T21.38 R2).
    ///   They are no longer seated, so they are not in `humans`, and `forget`
    ///   has already dropped their vote.
    ///
    /// Counting `yes == humans` rather than checking each human by id rests on
    /// `votes` holding only seated players' ids. That invariant is kept where
    /// seats are freed: `Command::Leave` and `sweep_unready` both call `forget`,
    /// and a bot seat (freed in `restart`/`return_to_lobby`) never held a vote.
    fn restart_wins(&self, humans: usize) -> bool {
        humans > 0 && self.tally(humans).yes == humans
    }

    /// Where the vote stands, for the clients (T21.38 R4): how many yes votes
    /// against how many seated humans.
    pub fn tally(&self, humans: usize) -> VoteTally {
        VoteTally {
            yes: self.votes.values().filter(|v| **v).count(),
            humans,
        }
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
    ///
    /// `humans` is `Room::human_count` — seated players who are not bots. It is
    /// what the vote is counted against (T21.38).
    pub fn tick(
        &mut self,
        world: &mut World,
        humans: usize,
        dt: f32,
    ) -> (Vec<GameEvent>, RoundOutcome) {
        let mut events = Vec::new();
        let now = world.round_time;
        let _ = dt;

        // **The clock went backwards, so this is a different world** (T21.13).
        //
        // A `RoundController` outlives every world it drives: `restart` and the
        // return-to-lobby path both install a fresh `World` whose `round_time`
        // starts at zero, while `last_state_at` still holds a value from the
        // round that just ended — around 249 in a four-minute round. The
        // condition below then needs `round_time >= 250`, which a 240-second
        // round never reaches, so the once-a-second rebroadcast `docs/41` §3
        // promises produced **nothing** in round two and every round after.
        //
        // That is also what would otherwise have corrected a missed phase
        // announcement within a second, so the two defects hid each other.
        //
        // Detected rather than reset from the call sites: every path that
        // replaces the world has this property, and a reset written into two of
        // them is a reset the third will not have.
        if now < self.last_state_at {
            self.last_state_at = f32::NEG_INFINITY;
        }

        match world.phase {
            RoundPhase::Lobby => {}
            RoundPhase::Playing => {
                if now - self.last_state_at >= ROUND_STATE_INTERVAL {
                    self.last_state_at = now;
                    events.push(world.round_state_event());
                }
            }
            RoundPhase::Ended => {
                // **Early resolution** (T21.38 R3): once every seated human has
                // said yes the answer cannot change — the client has no "no"
                // button and a yes is not withdrawn — so nobody waits the rest of
                // the window out for it. Decided from recorded commands only, so
                // a replay restarts on the same tick.
                // Counted in ticks, by the rule that ends every phase (T22.12D, R94).
                let window_closed = world.phase_over();
                if !self.resolved && (window_closed || self.restart_wins(humans)) {
                    self.resolved = true;
                    self.announced_tally = None;
                    let restart = self.restart_wins(humans);
                    self.votes.clear();
                    let seed = self.advance_seed();
                    return if restart {
                        (events, RoundOutcome::Restart { seed })
                    } else {
                        (events, RoundOutcome::ToLobby { seed })
                    };
                }
                // The tally changed — a vote landed, or a human left or
                // arrived — so say so to everyone. `round_state` is the carrier
                // (T21.38 R4); the room attaches `votes` when it flushes.
                let tally = self.tally(humans);
                if !self.resolved && self.announced_tally != Some(tally) {
                    self.announced_tally = Some(tally);
                    events.push(world.round_state_event());
                }
            }
            RoundPhase::Warmup => {}
        }

        // Leaving `Ended` for any reason re-arms the resolver.
        if world.phase != RoundPhase::Ended {
            self.resolved = false;
            self.announced_tally = None;
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

    /// T21.38, the owner's ruling: every human yes restarts; one no does not.
    /// (Was `a_majority_of_those_who_voted_restarts_the_round`, whose 2-yes-1-no
    /// case is now the losing half.)
    #[test]
    fn every_human_voting_yes_restarts_the_round_and_one_no_does_not() {
        let w = world_in(RoundPhase::Ended);
        let mut r = RoundController::new(1234);
        r.vote(&w, 1, true);
        r.vote(&w, 2, true);
        r.vote(&w, 3, true);
        assert!(
            r.restart_wins(3),
            "three yes of three humans did not restart"
        );

        // One human says no: a majority, and still the title for everyone.
        let mut r2 = RoundController::new(1234);
        r2.vote(&w, 1, true);
        r2.vote(&w, 2, true);
        r2.vote(&w, 3, false);
        assert!(!r2.restart_wins(3), "a human's no was outvoted");
    }

    /// T21.38: silence is a no. (Was `non_voters_abstain_rather_than_veto`, the
    /// rule the owner overruled; same scenario, opposite verdict, and the
    /// control half is now the unanimous case.)
    #[test]
    fn a_silent_human_blocks_the_restart() {
        let w = world_in(RoundPhase::Ended);
        let mut r = RoundController::new(1234);
        // Two of three humans vote yes; the third says nothing.
        r.vote(&w, 1, true);
        r.vote(&w, 2, true);
        assert!(
            !r.restart_wins(3),
            "a silent human did not block the restart"
        );

        // The control: once the third says yes too, it restarts — so the verdict
        // above is about the silence and not a rule that never restarts.
        r.vote(&w, 3, true);
        assert!(r.restart_wins(3));
    }

    /// A lone human is "every human", and no humans at all is not a yes.
    #[test]
    fn a_lone_human_can_restart_and_an_empty_room_cannot() {
        let w = world_in(RoundPhase::Ended);
        let mut r = RoundController::new(1234);
        assert!(!r.restart_wins(0), "a room with no humans restarted itself");
        r.vote(&w, 1, true);
        assert!(r.restart_wins(1));
    }

    #[test]
    fn the_tally_counts_yes_votes_against_humans() {
        let w = world_in(RoundPhase::Ended);
        let mut r = RoundController::new(1234);
        assert_eq!(r.tally(3), VoteTally { yes: 0, humans: 3 });
        r.vote(&w, 1, true);
        r.vote(&w, 2, false);
        assert_eq!(r.tally(3), VoteTally { yes: 1, humans: 3 });
        r.forget(1);
        assert_eq!(r.tally(2), VoteTally { yes: 0, humans: 2 });
    }

    /// T21.38 R3/R4 at the controller: the tally is announced on entering the
    /// window and on each change, and every human yes resolves **before** the
    /// window closes.
    #[test]
    fn a_unanimous_yes_resolves_early_and_tally_changes_are_announced() {
        let mut w = world_in(RoundPhase::Ended);
        let mut r = RoundController::new(1);
        let states = |evs: &[GameEvent]| {
            evs.iter()
                .filter(|e| matches!(e, GameEvent::RoundState { .. }))
                .count()
        };
        let (evs, out) = r.tick(&mut w, 2, SIM_DT);
        assert_eq!((states(&evs), &out), (1, &RoundOutcome::Continue));
        // Nothing changed: nothing announced.
        let (evs, _) = r.tick(&mut w, 2, SIM_DT);
        assert_eq!(states(&evs), 0, "an unchanged tally was re-announced");
        // One of two votes: announced, not resolved.
        r.vote(&w, 1, true);
        let (evs, out) = r.tick(&mut w, 2, SIM_DT);
        assert_eq!((states(&evs), &out), (1, &RoundOutcome::Continue));
        assert!(w.phase_time_left() > 1.0, "the premise: the window is open");
        // The second: resolved on this tick, with the window still open.
        r.vote(&w, 2, true);
        let (_, out) = r.tick(&mut w, 2, SIM_DT);
        assert!(
            matches!(out, RoundOutcome::Restart { .. }),
            "every human said yes and the room waited: {out:?}"
        );
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

    /// T22.12D (R94): the vote window closes on **exactly** its `ENDED_SECONDS · SIM_HZ`-th
    /// tick — the tick rule every phase ends by (`World::phase_over`), not an `f32`
    /// clock reaching zero (which closed it one tick late, measured). A silent human,
    /// so only the window can resolve it; the tick before is the control.
    #[test]
    fn the_ended_window_closes_on_its_last_tick() {
        use game_core::constants::{ENDED_SECONDS, SIM_HZ};
        assert_eq!(ENDED_SECONDS.fract(), 0.0, "premise: whole seconds");
        let window = ENDED_SECONDS as u32 * SIM_HZ;
        let mut w = world_in(RoundPhase::Ended);
        let mut r = RoundController::new(1);
        for _ in 0..window - 1 {
            w.step(SIM_DT);
        }
        let (_, before) = r.tick(&mut w, 1, SIM_DT);
        assert_eq!(before, RoundOutcome::Continue, "closed a tick early");
        w.step(SIM_DT);
        let (_, at) = r.tick(&mut w, 1, SIM_DT);
        assert!(
            matches!(at, RoundOutcome::ToLobby { .. }),
            "the window did not close on tick {window}: {at:?}"
        );
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
