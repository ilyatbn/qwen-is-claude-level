//! Public lobbies: fill to five, or bots after ten seconds
//! (`docs/74-amendments-v6.md` §E2).
//!
//! The rule that replaced `LOBBY_COUNTDOWN` and `MIN_PLAYERS_TO_START`. Both are
//! retired: one human plus four bots after ten seconds is a game, and two humans
//! waiting forever is not.

use std::sync::Arc;

use game_core::constants::{MapScale, LOBBY_BOT_TIMEOUT, LOBBY_CAPACITY, SIM_DT};
use game_core::world::RoundPhase;
use game_server::config::Config;
use game_server::room::{Command, Room};

fn cfg() -> Arc<Config> {
    Arc::new(Config {
        map_scale: MapScale::Small,
        bot_count: 0,
        ..Config::default()
    })
}

fn seat(room: &mut Room, name: &str) -> u8 {
    let (reply, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::Join {
        name: name.into(),
        look: Default::default(),
        reply,
    });
    rx.blocking_recv().ok().flatten().expect("seated")
}

/// Tick a lobby for `secs`, returning the elapsed seconds when it asked to start.
///
/// Returns `None` if it never did. **`tick_once`, not `tick_inline`**: what is
/// under test is *when the room asks*, and building the world would add the
/// generator's time to every measurement.
fn run_lobby(room: &mut Room, secs: f32) -> Option<f32> {
    let ticks = (secs / SIM_DT) as usize;
    for i in 0..ticks {
        room.tick_once(SIM_DT);
        if room.wants_world() {
            return Some(i as f32 * SIM_DT);
        }
    }
    None
}

/// Filling the last seat starts the match **immediately**.
///
/// The elapsed assertion is the point: "it started" on its own is satisfied by
/// the timeout firing ten seconds later, which is the opposite of the claim.
#[test]
fn a_full_lobby_starts_at_once_and_does_not_wait_out_the_timeout() {
    let mut room = Room::new(cfg());
    for i in 0..LOBBY_CAPACITY {
        seat(&mut room, &format!("p{i}"));
    }
    let at = run_lobby(&mut room, LOBBY_BOT_TIMEOUT * 2.0).expect("a full lobby never started");
    assert!(
        at < LOBBY_BOT_TIMEOUT,
        "a full lobby waited {at}s — that is the timeout firing, not the fill rule"
    );
    assert!(at < 1.0, "a full lobby took {at}s to start");
}

/// One short of capacity does **not** start on the fill rule.
///
/// The control for the test above: without it, "a full lobby starts at once"
/// also passes for a room that starts the moment anybody sits down.
#[test]
fn one_short_of_capacity_does_not_start_on_the_fill_rule() {
    let mut room = Room::new(cfg());
    for i in 0..(LOBBY_CAPACITY - 1) {
        seat(&mut room, &format!("p{i}"));
    }
    let at = run_lobby(&mut room, LOBBY_BOT_TIMEOUT - 1.0);
    assert!(
        at.is_none(),
        "a lobby one player short started at {at:?}s, before its timeout"
    );
}

/// The timeout starts a match with bots in it.
#[test]
fn a_lone_player_gets_bots_when_the_timeout_expires() {
    let with_bots = Arc::new(Config {
        bot_count: 3,
        ..(*cfg()).clone()
    });
    let mut room = Room::new(with_bots);
    seat(&mut room, "ana");
    assert_eq!(room.bot_count(), 0, "control: no bots while it is a lobby");

    let at = run_lobby(&mut room, LOBBY_BOT_TIMEOUT + 2.0).expect("the timeout never fired");
    assert!(
        (at - LOBBY_BOT_TIMEOUT).abs() < 0.5,
        "the timeout fired at {at}s, expected about {LOBBY_BOT_TIMEOUT}s"
    );

    // §C18 still holds: the timeout starts a **match**, which seats the bots.
    // They are not seated into the lobby.
    let world = room.generate_world();
    room.install_world(world);
    assert!(room.bot_count() > 0, "the match started with no bots");
    assert_eq!(room.phase(), RoundPhase::Warmup);
}

/// **The timeout does not reset when somebody else arrives.**
///
/// The whole rule, and the bug this task exists to prevent: a player who has
/// waited ten seconds is not made to wait twenty because a second player turned
/// up at second eight. Asserted as a *time*, not as "it started" — a resetting
/// timer starts too, just late.
#[test]
fn a_player_arriving_at_eight_seconds_does_not_restart_the_clock() {
    let mut room = Room::new(cfg());
    seat(&mut room, "ana");

    // Eight seconds in, ben arrives.
    let joined_at = LOBBY_BOT_TIMEOUT - 2.0;
    let early = run_lobby(&mut room, joined_at);
    assert!(early.is_none(), "started before ben even arrived");
    seat(&mut room, "ben");

    let rest = run_lobby(&mut room, LOBBY_BOT_TIMEOUT * 2.0).expect("never started");
    let total = joined_at + rest;
    assert!(
        (total - LOBBY_BOT_TIMEOUT).abs() < 0.5,
        "the match started at {total}s; expected {LOBBY_BOT_TIMEOUT}s. \
         A reset would have started it at about {}s",
        joined_at + LOBBY_BOT_TIMEOUT
    );
}

// §E2's remaining two claims — that quick match skips a **started** match, and
// that it randomises its scale seeded — are registry-level and live in
// `registry.rs`'s own test module, where the `RoomSpawner` harness they need
// already exists: `quick_match_skips_a_started_match` and
// `random_scale_is_seeded_and_actually_varies`. Named here so they are not
// looked for in this file and presumed missing.
