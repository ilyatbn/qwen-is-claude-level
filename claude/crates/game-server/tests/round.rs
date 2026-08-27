//! The phase machine on a shortened round (`docs/41-server-loop-rooms.md` §3, §8).

use std::sync::Arc;
use std::time::Duration;

use game_core::constants::{MapScale, SIM_DT};
use game_core::world::RoundPhase;
use game_server::config::Config;
use game_server::room::{Command, Room};
use game_server::round::{RoundController, RoundOutcome};

/// Seat a player the way a socket does.
///
/// §E1.1: `Seats` is the single source of seat identity and the world is created
/// **from** it at match start — so a test can no longer reach into
/// `world.add_player`, because in a lobby there is no world to reach into. This
/// is also closer to what production does, which is the better reason.
fn seat(room: &mut Room, name: &str) -> game_core::player::state::PlayerId {
    let (reply, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::Join {
        name: name.into(),
        skin_id: 0,
        tombstone_skin_id: 0,
        reply,
    });
    rx.blocking_recv().ok().flatten().expect("seated")
}

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
    // §E1: a lobby has no world, so the override is read off the world the match
    // builds — which is the one the phase machine actually runs on.
    let mut room = Room::new(cfg(5.0));
    let w = room.generate_world();
    room.install_world(w);
    assert_eq!(room.world_for_test().round_seconds(), 5.0);

    let mut default_room = Room::new(cfg(game_core::constants::ROUND_SECONDS));
    let w = default_room.generate_world();
    default_room.install_world(w);
    assert_eq!(
        default_room.world_for_test().round_seconds(),
        game_core::constants::ROUND_SECONDS,
        "the default must still be the constant"
    );
}

/// Take a freshly-built room out of `Lobby`.
///
/// §C18: a room is born in `Lobby` and starts a round only when asked. These
/// tests are about the phase machine *after* a round begins, so they say so
/// explicitly instead of relying on a room that used to start itself — which is
/// the behaviour §C18 removed.
fn begin(room: &mut Room) {
    room.request_start();
    for _ in 0..(30 * 60) {
        // `tick_inline`, not `tick_once`: §E1 moved map generation to match
        // start, and the tick only *asks* for a world. In production the room
        // task builds it on a blocking thread; a test drives the same trio
        // inline.
        let _ = room.tick_inline(SIM_DT);
        if room.phase() != RoundPhase::Lobby {
            return;
        }
    }
    panic!("the room never left Lobby");
}

#[test]
fn the_phase_machine_advances_warmup_then_playing_then_ended() {
    let mut room = Room::new(cfg(3.0));
    begin(&mut room);
    let mut seen: Vec<RoundPhase> = vec![room.phase()];

    // Warmup (10 s) + Playing (3 s) + a margin, at 60 Hz.
    for _ in 0..(20 * 60) {
        let _ = room.tick_inline(SIM_DT);
        if *seen.last().expect("non-empty") != room.phase() {
            seen.push(room.phase());
        }
        if room.phase() == RoundPhase::Ended {
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
/// through a longer pipe; what is worth checking at this level is that a started
/// round enters Warmup rather than skipping it into Playing.
///
/// The room no longer *starts* in Warmup — §C18 made it start in `Lobby` — so
/// the control matters more than it used to: a fresh room must be in `Lobby`,
/// and only asking for a round moves it to `Warmup`. Asserting only the second
/// half would pass for a room that skipped the lobby entirely.
#[test]
fn a_started_round_enters_warmup_and_a_fresh_room_does_not() {
    let mut room = Room::new(cfg(5.0));
    assert_eq!(
        room.phase(),
        RoundPhase::Lobby,
        "a fresh room must hold a lobby, not a battle nobody asked for"
    );
    assert!(
        room.world().is_none(),
        "§E1: a lobby holds no world at all, not an unused one"
    );
    begin(&mut room);
    assert_eq!(room.phase(), RoundPhase::Warmup);
}

#[test]
fn a_majority_restart_starts_a_new_round_on_a_new_seed_with_zeroed_scores() {
    let mut room = Room::new(cfg(1.0));
    let a = seat(&mut room, "a");
    let _b = seat(&mut room, "b");

    begin(&mut room);

    // Give someone a score, so the reset is observable. After the match starts,
    // because §E1 means there was nowhere to put one before it.
    if let Some(p) = room.world_for_test().player_mut(a) {
        p.score = 7;
    }
    let first_seed = room.world_for_test().seed;
    // Run to Ended.
    for _ in 0..(20 * 60) {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() == RoundPhase::Ended {
            break;
        }
    }
    assert_eq!(room.phase(), RoundPhase::Ended);

    room.vote_for_test(0, true);
    room.vote_for_test(1, true);

    // Run the 20 s vote window out.
    for _ in 0..(25 * 60) {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() == RoundPhase::Warmup {
            break;
        }
    }

    assert_eq!(
        room.phase(),
        RoundPhase::Warmup,
        "the round did not restart"
    );
    assert_ne!(
        room.world_for_test().seed,
        first_seed,
        "restarted on the same seed"
    );
    assert_eq!(
        room.world_for_test().player(0).map(|p| p.score),
        Some(0),
        "scores were not reset"
    );
    assert_eq!(
        room.world_for_test().players.len(),
        2,
        "seated players were dropped by the restart"
    );
}

#[test]
fn without_a_majority_the_room_returns_to_lobby() {
    let mut room = Room::new(cfg(1.0));
    seat(&mut room, "a");
    begin(&mut room);
    for _ in 0..(20 * 60) {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() == RoundPhase::Ended {
            break;
        }
    }
    room.vote_for_test(0, false);
    for _ in 0..(25 * 60) {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() != RoundPhase::Ended {
            break;
        }
    }
    // With one connected player it goes to Lobby and immediately restarts warmup,
    // since MIN_PLAYERS_TO_START is 1 — so the observable is that it did not stay
    // Ended forever.
    assert_ne!(room.phase(), RoundPhase::Ended);
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
    seat(&mut room, "a");
    seat(&mut room, "b");
    begin(&mut room);
    for _ in 0..(20 * 60) {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() == RoundPhase::Ended {
            break;
        }
    }
    room.vote_for_test(0, true);
    room.vote_for_test(1, false);
    // The yes-voter leaves: what remains is a single no, so no restart.
    room.leave_for_test(0);
    for _ in 0..(25 * 60) {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() != RoundPhase::Ended {
            break;
        }
    }
    assert_ne!(
        room.phase(),
        RoundPhase::Warmup,
        "a departed player's vote still counted"
    );
    let _ = Duration::from_secs(1);
}
