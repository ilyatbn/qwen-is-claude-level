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
        look: Default::default(),
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
    // With one connected player it goes back to `Lobby` and starts again once
    // §E2's bot timeout expires — so the observable is that it did not stay
    // `Ended` forever.
    assert_ne!(room.phase(), RoundPhase::Ended);
}

/// Run a started room to `Ended`, let the window close with no votes, and return
/// once it is back in `Lobby`.
fn back_to_lobby(room: &mut Room) {
    for _ in 0..(20 * 60) {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() == RoundPhase::Ended {
            break;
        }
    }
    assert_eq!(room.phase(), RoundPhase::Ended, "the round never ended");
    for _ in 0..((game_core::constants::ENDED_SECONDS + 2.0) * 60.0) as usize {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() == RoundPhase::Lobby {
            return;
        }
    }
    panic!("the vote window closed with no votes and the room is not in Lobby");
}

/// Two matches started from one room's lobby: `(seed, mask hash)` of each map.
fn two_lobby_starts(cfg: Arc<Config>) -> [(u64, String); 2] {
    let mut room = Room::new_in_room(cfg, 1);
    seat(&mut room, "a");
    begin(&mut room);
    let first = {
        let w = room.world_for_test();
        (w.seed, w.map.mask.hash_hex())
    };
    back_to_lobby(&mut room);
    assert!(room.world().is_none(), "§E1: a lobby holds no world");
    begin(&mut room);
    let second = {
        let w = room.world_for_test();
        (w.seed, w.map.mask.hash_hex())
    };
    [first, second]
}

/// T21.32 item 2. Reported from play: rounds one and two in `room=1` both logged
/// `map generated seed=222892591914436108`.
///
/// `two_rooms_with_no_fixed_seed_get_different_maps` covers two **rooms**; this
/// is one room, played twice through its lobby, which is the path a failed vote
/// takes. The mask hash is asserted as well as the seed, because the seed is an
/// input and the map is what a player sees.
#[test]
fn two_lobby_starts_in_one_room_build_different_maps() {
    let [first, second] = two_lobby_starts(cfg(1.0));
    assert_ne!(
        first.0, second.0,
        "the second match from the lobby was built on the first one's seed"
    );
    assert_ne!(
        first.1, second.1,
        "the second match from the lobby has the first one's terrain"
    );
}

/// The control for the test above, and `FIXED_SEED`'s promise (`docs/41` §5):
/// the sequence is a function of the fixed seed. Round one is built on it
/// exactly, and two rooms given it walk the same sequence afterwards — so a
/// "different map" above is not the product of something unseeded.
#[test]
fn fixed_seed_pins_the_whole_sequence_of_lobby_starts() {
    let pinned = |seed| {
        Arc::new(Config {
            fixed_seed: Some(seed),
            ..(*cfg(1.0)).clone()
        })
    };
    let a = two_lobby_starts(pinned(4242));
    let b = two_lobby_starts(pinned(4242));
    assert_eq!(a[0].0, 4242, "round one was not built on FIXED_SEED");
    assert_eq!(a, b, "FIXED_SEED did not reproduce the sequence of maps");
    assert_ne!(a[0], a[1], "FIXED_SEED froze every map to the same one");
}

/// T21.32 item 1: "Play again does nothing". The room went back to `Lobby` and
/// told nobody, so every client held the results screen until it disconnected.
///
/// The control is `Ended`'s own announcement in the same stream, so a room that
/// announced nothing at all cannot pass.
#[test]
fn returning_to_the_lobby_is_announced() {
    let mut room = Room::new(cfg(1.0));
    seat(&mut room, "a");
    begin(&mut room);
    let mut phases = Vec::new();
    for _ in 0..((game_core::constants::WARMUP_SECONDS
        + 1.0
        + game_core::constants::ENDED_SECONDS
        + 2.0)
        * 60.0) as usize
    {
        // Both streams, in the order the room task flushes them: the world's own
        // events (where `Ended` is announced) and then the controller's (where the
        // return to the lobby is). `tick_inline` returns only the second.
        let mut evs = room
            .world_mut()
            .map(|w| w.drain_events())
            .unwrap_or_default();
        evs.extend(room.tick_inline(SIM_DT));
        phases.extend(round_states(&evs).into_iter().map(|(p, _)| p));
        if room.phase() == RoundPhase::Lobby {
            break;
        }
    }
    assert_eq!(
        room.phase(),
        RoundPhase::Lobby,
        "the premise: no vote, so Lobby"
    );
    assert!(
        phases.contains(&RoundPhase::Ended),
        "the control: the round's end was never announced, so this run proves nothing"
    );
    assert_eq!(
        phases.last(),
        Some(&RoundPhase::Lobby),
        "the room went back to the lobby and told nobody: {phases:?}"
    );
}

/// Send a vote the way the socket layer does, and return the room's answer.
fn vote(room: &mut Room, id: game_core::player::state::PlayerId, restart: bool) -> bool {
    let (reply, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::VoteRestart(id, restart, reply));
    rx.blocking_recv().unwrap_or(false)
}

/// T21.32 item 1: a vote the server will not count is **answered** as not
/// counted, so the button never reads "Voted" for it. Both sides of the window,
/// and the lobby after it — the case the owner hit.
#[test]
fn a_vote_is_counted_only_inside_the_window() {
    let mut room = Room::new(cfg(1.0));
    let a = seat(&mut room, "a");
    begin(&mut room);
    assert!(
        !vote(&mut room, a, true),
        "a vote during warmup was counted"
    );
    for _ in 0..(20 * 60) {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() == RoundPhase::Ended {
            break;
        }
    }
    assert_eq!(room.phase(), RoundPhase::Ended);
    // The control: inside the window it counts, so "never counted" cannot pass.
    assert!(
        vote(&mut room, a, false),
        "a vote inside the window was refused"
    );
    back_to_lobby_from_ended(&mut room);
    assert!(
        !vote(&mut room, a, true),
        "a vote sent to a room already back in the lobby was counted"
    );
}

/// As `back_to_lobby`, for a room already in `Ended`.
fn back_to_lobby_from_ended(room: &mut Room) {
    for _ in 0..((game_core::constants::ENDED_SECONDS + 2.0) * 60.0) as usize {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() == RoundPhase::Lobby {
            return;
        }
    }
    panic!("the window closed on a single no vote and the room is not in Lobby");
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

// ---------------------------------------------------------------- T21.13

/// Every `RoundState` a run produced, as `(phase, time_left)`.
///
/// **`RoundState` had fourteen references in this repository and none in a
/// test** before T21.13 — nothing had ever asserted that the message the whole
/// round lifecycle depends on is sent at all, which is how a restart came to
/// announce nothing.
fn round_states(evs: &[game_core::world::GameEvent]) -> Vec<(RoundPhase, f32)> {
    evs.iter()
        .filter_map(|e| match e {
            game_core::world::GameEvent::RoundState {
                phase, time_left, ..
            } => Some((*phase, *time_left)),
            _ => None,
        })
        .collect()
}

/// A restarted round must announce itself (T21.13).
///
/// Reported from play: *"the match doesn't really end at 0 and like 10 seconds
/// before I already see the menu for 'play again', and after the match restarts
/// the timer has more time that was needed."*
///
/// The cause: `room.rs::restart` builds a fresh `World`, a world is **born in
/// `Warmup`**, and `set_phase(Warmup)` early-returns when the phase already
/// matches — with the `RoundState` push after that return. So round two said
/// nothing for its whole warmup, the client kept `phase == ended` and round
/// one's deadline, and the vote panel stayed up over a live round while the
/// clock jumped back up instead of counting down.
#[test]
fn a_restart_announces_the_new_round() {
    let mut room = Room::new(cfg(1.0));
    let _a = seat(&mut room, "a");
    let _b = seat(&mut room, "b");

    // **The control comes first**: round one announces its warmup, so "a
    // RoundState exists" cannot be satisfied by the first round alone.
    let mut first = Vec::new();
    room.request_start();
    for _ in 0..(30 * 60) {
        first.extend(room.tick_inline(SIM_DT));
        if room.phase() != RoundPhase::Lobby {
            break;
        }
    }
    assert!(
        round_states(&first)
            .iter()
            .any(|(p, _)| *p == RoundPhase::Warmup),
        "round one never announced its warmup, so this test cannot see round two's"
    );

    // Run to Ended and vote to restart.
    for _ in 0..(20 * 60) {
        let _ = room.tick_inline(SIM_DT);
        if room.phase() == RoundPhase::Ended {
            break;
        }
    }
    assert_eq!(room.phase(), RoundPhase::Ended);
    room.vote_for_test(0, true);
    room.vote_for_test(1, true);

    // Collect across the restart itself.
    let mut second = Vec::new();
    for _ in 0..(25 * 60) {
        second.extend(room.tick_inline(SIM_DT));
        if room.phase() == RoundPhase::Warmup {
            break;
        }
    }
    assert_eq!(
        room.phase(),
        RoundPhase::Warmup,
        "the round did not restart"
    );

    let announced = round_states(&second);
    assert!(
        announced.iter().any(|(p, _)| *p == RoundPhase::Warmup),
        "the restarted round announced no warmup: {announced:?} — a client would \
         hold the previous round's phase and deadline for the whole warmup"
    );
    // And it carries the **new** round's time, not the old one's.
    let warmup = announced
        .iter()
        .find(|(p, _)| *p == RoundPhase::Warmup)
        .expect("a warmup announcement");
    assert!(
        warmup.1 > 0.0,
        "the restarted warmup announced {} seconds left",
        warmup.1
    );
}

/// The once-a-second rebroadcast must survive a restart (T21.13).
///
/// `docs/41` §3: *"`round_state` is broadcast on every phase change and once a
/// second during `Playing`"*. `RoundController::last_state_at` is compared
/// against `world.round_time` and the controller outlives the world — so after a
/// restart the anchor held a value from the round that just ended while the new
/// clock started at zero, and the condition could never be met again. Round two
/// and every round after produced **no** periodic broadcasts at all, which also
/// removed the self-correction that would have papered over the defect above.
#[test]
fn the_periodic_round_state_survives_a_restart() {
    let mut room = Room::new(cfg(4.0));
    let _a = seat(&mut room, "a");
    let _b = seat(&mut room, "b");
    begin(&mut room);

    // The control: round one broadcasts periodically while Playing.
    let mut first = Vec::new();
    for _ in 0..(30 * 60) {
        first.extend(room.tick_inline(SIM_DT));
        if room.phase() == RoundPhase::Ended {
            break;
        }
    }
    let playing_first = round_states(&first)
        .iter()
        .filter(|(p, _)| *p == RoundPhase::Playing)
        .count();
    assert!(
        playing_first > 1,
        "round one produced {playing_first} Playing broadcasts — the control is \
         broken, so round two's count proves nothing"
    );

    room.vote_for_test(0, true);
    room.vote_for_test(1, true);
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

    // Round two, through its Playing phase.
    let mut second = Vec::new();
    for _ in 0..(30 * 60) {
        second.extend(room.tick_inline(SIM_DT));
        if room.phase() == RoundPhase::Ended {
            break;
        }
    }
    let playing_second = round_states(&second)
        .iter()
        .filter(|(p, _)| *p == RoundPhase::Playing)
        .count();
    assert!(
        playing_second > 1,
        "round two produced {playing_second} periodic broadcasts against round \
         one's {playing_first} — the rebroadcast anchor did not follow the new world"
    );
}
