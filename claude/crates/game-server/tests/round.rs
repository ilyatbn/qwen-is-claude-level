//! The phase machine on a shortened round (`docs/41-server-loop-rooms.md` §3, §8).

use std::sync::Arc;
use std::time::Duration;

use game_core::constants::{MapScale, SIM_DT};
use game_core::world::RoundPhase;
use game_server::config::Config;
use game_server::room::Room;
use game_server::round::{RoundController, RoundOutcome};

fn cfg(round_seconds: f32) -> Arc<Config> {
    Arc::new(Config {
        map_scale: MapScale::Small,
        round_seconds,
        bot_count: 0,
        ..Config::default()
    })
}

/// `ROUND_SECONDS` was parsed into `Config` and never reached the phase machine,
/// so a "shortened" round still ran for 240 s and this test would have hung.
#[test]
fn the_round_seconds_override_actually_shortens_the_round() {
    let room = Room::new(cfg(5.0));
    assert_eq!(room.world.round_seconds(), 5.0);

    let default_room = Room::new(cfg(game_core::constants::ROUND_SECONDS));
    assert_eq!(
        default_room.world.round_seconds(),
        game_core::constants::ROUND_SECONDS,
        "the default must still be the constant"
    );
}

#[test]
fn the_phase_machine_advances_warmup_then_playing_then_ended() {
    let mut room = Room::new(cfg(3.0));
    let mut seen: Vec<RoundPhase> = vec![room.world.phase];

    // Warmup (10 s) + Playing (3 s) + a margin, at 60 Hz.
    for _ in 0..(20 * 60) {
        let _ = room.tick_once(SIM_DT);
        if *seen.last().expect("non-empty") != room.world.phase {
            seen.push(room.world.phase);
        }
        if room.world.phase == RoundPhase::Ended {
            break;
        }
    }

    assert_eq!(
        seen,
        vec![RoundPhase::Warmup, RoundPhase::Playing, RoundPhase::Ended],
        "the round did not pass through every phase in order"
    );
}

/// The warmup damage gate itself is tested in `game-core`
/// (`tests/world_step.rs::self_rocket`), with the control asserting damage
/// *does* land while Playing. Duplicating it here would test the same function
/// through a longer pipe; what is worth checking at this level is that the room
/// actually starts in Warmup rather than skipping it.
#[test]
fn a_room_starts_in_warmup() {
    let room = Room::new(cfg(5.0));
    assert_eq!(room.world.phase, RoundPhase::Warmup);
}

#[test]
fn a_majority_restart_starts_a_new_round_on_a_new_seed_with_zeroed_scores() {
    let mut room = Room::new(cfg(1.0));
    room.world.add_player(0, 0, "a".into());
    room.world.add_player(1, 0, "b".into());

    // Give someone a score, so the reset is observable.
    if let Some(p) = room.world.player_mut(0) {
        p.score = 7;
    }
    let first_seed = room.world.seed;

    // Run to Ended.
    for _ in 0..(20 * 60) {
        let _ = room.tick_once(SIM_DT);
        if room.world.phase == RoundPhase::Ended {
            break;
        }
    }
    assert_eq!(room.world.phase, RoundPhase::Ended);

    room.vote_for_test(0, true);
    room.vote_for_test(1, true);

    // Run the 20 s vote window out.
    for _ in 0..(25 * 60) {
        let _ = room.tick_once(SIM_DT);
        if room.world.phase == RoundPhase::Warmup {
            break;
        }
    }

    assert_eq!(
        room.world.phase,
        RoundPhase::Warmup,
        "the round did not restart"
    );
    assert_ne!(room.world.seed, first_seed, "restarted on the same seed");
    assert_eq!(
        room.world.player(0).map(|p| p.score),
        Some(0),
        "scores were not reset"
    );
    assert_eq!(
        room.world.players.len(),
        2,
        "seated players were dropped by the restart"
    );
}

#[test]
fn without_a_majority_the_room_returns_to_lobby() {
    let mut room = Room::new(cfg(1.0));
    room.world.add_player(0, 0, "a".into());
    for _ in 0..(20 * 60) {
        let _ = room.tick_once(SIM_DT);
        if room.world.phase == RoundPhase::Ended {
            break;
        }
    }
    room.vote_for_test(0, false);
    for _ in 0..(25 * 60) {
        let _ = room.tick_once(SIM_DT);
        if room.world.phase != RoundPhase::Ended {
            break;
        }
    }
    // With one connected player it goes to Lobby and immediately restarts warmup,
    // since MIN_PLAYERS_TO_START is 1 — so the observable is that it did not stay
    // Ended forever.
    assert_ne!(room.world.phase, RoundPhase::Ended);
}

#[test]
fn the_controller_is_deterministic_across_runs() {
    let run = || {
        let w = {
            let mut w = game_core::world::World::new(99, MapScale::Small);
            w.set_phase(RoundPhase::Ended);
            w
        };
        let mut r = RoundController::new(99);
        r.vote(&w, 1, true);
        r.vote(&w, 2, true);
        (r.next_seed(), r.round_number)
    };
    assert_eq!(run(), run());
    let _ = RoundOutcome::Continue;
}

#[test]
fn a_departing_player_takes_their_vote_with_them() {
    let mut room = Room::new(cfg(1.0));
    room.world.add_player(0, 0, "a".into());
    room.world.add_player(1, 0, "b".into());
    for _ in 0..(20 * 60) {
        let _ = room.tick_once(SIM_DT);
        if room.world.phase == RoundPhase::Ended {
            break;
        }
    }
    room.vote_for_test(0, true);
    room.vote_for_test(1, false);
    // The yes-voter leaves: what remains is a single no, so no restart.
    room.leave_for_test(0);
    for _ in 0..(25 * 60) {
        let _ = room.tick_once(SIM_DT);
        if room.world.phase != RoundPhase::Ended {
            break;
        }
    }
    assert_ne!(
        room.world.phase,
        RoundPhase::Warmup,
        "a departed player's vote still counted"
    );
    let _ = Duration::from_secs(1);
}
