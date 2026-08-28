//! `lobby_state` on the wire (`docs/74-amendments-v6.md` §E6).
//!
//! The message that replaces `room_list`, which had never had a subscriber.
//! Every field is read back from the emitted JSON rather than from the struct
//! that built it, because the claim is about what a client receives.

use std::sync::Arc;

use game_core::constants::{MapScale, LOBBY_BOT_TIMEOUT, LOBBY_CAPACITY, SIM_DT};
use game_server::config::Config;
use game_server::events::lobby_state_payload;
use game_server::room::{Command, Room};

fn cfg() -> Arc<Config> {
    Arc::new(Config {
        map_scale: MapScale::Small,
        bot_count: 0,
        ..Config::default()
    })
}

/// Seat a player the way a socket does. §E1.1: `Seats` is the roster.
fn seat(room: &mut Room, name: &str) -> u8 {
    let (reply, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::Join {
        name: name.into(),
        skin_id: 7,
        tombstone_skin_id: 0,
        reply,
    });
    rx.blocking_recv().ok().flatten().expect("seated")
}

/// Every field survives the trip into JSON, read back off the payload.
#[test]
fn the_payload_carries_every_field_e6_names() {
    let mut room = Room::new(cfg());
    let ana = seat(&mut room, "ana");
    let p = lobby_state_payload(&room.lobby_state());

    assert_eq!(p["private"], false);
    assert_eq!(p["capacity"], LOBBY_CAPACITY);
    assert_eq!(p["scale"], "small");
    assert_eq!(p["settings_owner"], ana);

    let players = p["players"].as_array().expect("players is an array");
    assert_eq!(players.len(), 1, "the seat is the roster (§E1.1)");
    assert_eq!(players[0]["seat"], ana);
    assert_eq!(players[0]["name"], "ana");
    assert_eq!(players[0]["skin_id"], 7);
    assert_eq!(players[0]["ready"], false);
    assert_eq!(players[0]["bot"], false);
}

/// Absent, not null.
///
/// §E6 says a public lobby has no `code`. Sending `null` would be a second
/// spelling of the same absence and a client would then need to handle both.
#[test]
fn a_public_lobby_omits_the_code_rather_than_sending_null() {
    let mut room = Room::new(cfg());
    seat(&mut room, "ana");
    let p = lobby_state_payload(&room.lobby_state());
    assert!(p.get("code").is_none(), "a public lobby sent a code: {p}");

    // The control. Without it, "the field is absent" also passes for a builder
    // that never emits a code at all, which would break every private lobby.
    room.apply_for_test(Command::SetIdentity {
        code: Some("ABC234".into()),
        private: true,
    });
    let p = lobby_state_payload(&room.lobby_state());
    assert_eq!(p["code"], "ABC234");
    assert_eq!(p["private"], true);
}

/// The roster comes from `Seats` and shows bots as bots.
///
/// A roster that hid them would lie about who you are playing against.
#[test]
fn the_roster_is_the_seats_and_names_the_bots() {
    let bots = Arc::new(Config {
        bot_count: 2,
        ..(*cfg()).clone()
    });
    let mut room = Room::new(bots);
    seat(&mut room, "ana");
    // Bots are seated when the match starts (§C18), so drive it there.
    room.request_start();
    room.tick_inline(SIM_DT);

    let st = room.lobby_state();
    let humans = st.players.iter().filter(|p| !p.bot).count();
    let seated_bots = st.players.iter().filter(|p| p.bot).count();
    assert_eq!(humans, 1, "the human vanished from the roster");
    assert_eq!(seated_bots, 2, "bots are missing or not marked as bots");
    assert!(
        st.players
            .iter()
            .filter(|p| p.bot)
            .all(|p| !p.name.is_empty()),
        "a bot was announced with no name"
    );
}

/// `starts_in` is announced **once per whole second**, not sixty times.
///
/// Both bounds. The upper is the throttle; the **lower is the presence
/// control** — an upper bound alone is satisfied by a message that is never
/// sent at all. Same shape as `round_state_is_rebroadcast_about_once_a_second`.
#[test]
fn starts_in_is_announced_once_a_second_not_once_a_tick() {
    let mut room = Room::new(cfg());
    // Seating the first player starts §E2's timeout.
    seat(&mut room, "ana");
    assert!(
        room.lobby_state().starts_in.is_some(),
        "seating the first player did not start the bot timeout"
    );
    // The join itself is one update; take it so the count below is the timeout's.
    let _ = room.take_lobby_update();

    let seconds = 10.0_f32.min(LOBBY_BOT_TIMEOUT);
    let ticks = (seconds / SIM_DT) as usize;
    let mut updates = 0;
    for _ in 0..ticks {
        room.tick_once(SIM_DT);
        if room.take_lobby_update().is_some() {
            updates += 1;
        }
    }

    let cap = seconds.ceil() as usize + 2;
    assert!(
        updates <= cap,
        "the lobby broadcast {updates} updates over {seconds}s; at most {cap} are useful"
    );
    assert!(
        updates >= 2,
        "the countdown was never announced at all ({updates} updates in {seconds}s)"
    );
}

/// The timeout does not reset when somebody else arrives (§E2).
#[test]
fn a_second_player_does_not_restart_the_timeout() {
    let mut room = Room::new(cfg());
    seat(&mut room, "ana");
    let at_start = room.lobby_state().starts_in.expect("timeout started");

    for _ in 0..(3.0 / SIM_DT) as usize {
        room.tick_once(SIM_DT);
    }
    let before_join = room.lobby_state().starts_in.expect("still counting");
    assert!(before_join < at_start, "the countdown did not move");

    seat(&mut room, "ben");
    let after_join = room.lobby_state().starts_in.expect("still counting");
    assert!(
        after_join <= before_join,
        "a second player restarted the timeout: {before_join} -> {after_join}"
    );
}

/// A private lobby has no timeout at all (§E3).
#[test]
fn a_private_lobby_never_counts_down() {
    let mut room = Room::new(cfg());
    room.apply_for_test(Command::SetIdentity {
        code: Some("ZZZ999".into()),
        private: true,
    });
    seat(&mut room, "ana");
    let st = room.lobby_state();
    assert!(
        st.starts_in.is_none(),
        "a private lobby started a countdown ({:?})",
        st.starts_in
    );
    assert!(
        lobby_state_payload(&st).get("starts_in").is_none(),
        "and it put one on the wire"
    );
}

/// `set_scale` from a non-owner changes nothing and says why (§E6).
#[test]
fn set_scale_from_a_non_owner_is_refused_with_a_reason() {
    let mut room = Room::new(cfg());
    let ana = seat(&mut room, "ana");
    let ben = seat(&mut room, "ben");
    assert_eq!(
        room.lobby_state().settings_owner,
        Some(ana),
        "the longest-seated human is the owner"
    );

    let refused = {
        let (tx, rx) = tokio::sync::oneshot::channel();
        room.apply_for_test(Command::SetScale {
            by: ben,
            scale: MapScale::Large,
            reply: tx,
        });
        rx.blocking_recv().expect("answered")
    };
    assert!(refused.is_err(), "a non-owner changed the settings");
    assert_eq!(
        room.lobby_state().scale,
        MapScale::Small,
        "refused and changed it anyway"
    );

    // The control: the owner can. Without it, "refused" also passes for a
    // server that refuses everyone, which is a lobby nobody can configure.
    let allowed = {
        let (tx, rx) = tokio::sync::oneshot::channel();
        room.apply_for_test(Command::SetScale {
            by: ana,
            scale: MapScale::Large,
            reply: tx,
        });
        rx.blocking_recv().expect("answered")
    };
    assert!(allowed.is_ok(), "the owner was refused: {allowed:?}");
    assert_eq!(room.lobby_state().scale, MapScale::Large);
}

/// A settings change clears every ready flag, including the changer's (§E3).
#[test]
fn changing_the_settings_clears_everyone_s_ready() {
    let mut room = Room::new(cfg());
    let ana = seat(&mut room, "ana");
    let ben = seat(&mut room, "ben");
    room.apply_for_test(Command::Ready(ana));
    room.apply_for_test(Command::Ready(ben));
    assert!(
        room.lobby_state().players.iter().all(|p| p.ready),
        "control: both were ready before the change"
    );

    let (tx, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::SetScale {
        by: ana,
        scale: MapScale::Medium,
        reply: tx,
    });
    let _ = rx.blocking_recv();

    assert!(
        room.lobby_state().players.iter().all(|p| !p.ready),
        "a settings change left someone ready to a game they were not shown"
    );
}

/// Settings ownership moves when the host leaves; the lobby survives (§E3).
#[test]
fn the_owner_moves_on_when_the_host_leaves() {
    let mut room = Room::new(cfg());
    let ana = seat(&mut room, "ana");
    let ben = seat(&mut room, "ben");
    assert_eq!(room.lobby_state().settings_owner, Some(ana));

    room.apply_for_test(Command::Leave(ana));
    assert_eq!(
        room.lobby_state().settings_owner,
        Some(ben),
        "the lobby lost its owner rather than passing it on"
    );
    assert_eq!(room.lobby_state().players.len(), 1);
}

/// A running match is past needing a lobby broadcast.
#[test]
fn a_match_stops_producing_lobby_updates() {
    let mut room = Room::new(cfg());
    let ana = seat(&mut room, "ana");
    let _ = room.take_lobby_update();

    room.request_start();
    room.tick_inline(SIM_DT);
    assert!(room.world().is_some(), "control: the match started");

    room.apply_for_test(Command::Ready(ana));
    assert!(
        room.take_lobby_update().is_none(),
        "a running match broadcast a lobby"
    );
}

/// `room_list` is gone from the server (§E6).
///
/// A grep, as a test. The *consumer* was already dead — `MenuScene.roomInfo`
/// was never assigned and `describeRoom` had no production caller — so a clean
/// sweep of the client proves little. What matters is that the **producer** is
/// gone, because that is the line that was alive.
#[test]
fn no_room_list_producer_survives() {
    let mut found = Vec::new();
    for entry in std::fs::read_dir("src").expect("src/") {
        let path = entry.expect("dir entry").path();
        if path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let body = std::fs::read_to_string(&path).expect("read");
        for (n, line) in body.lines().enumerate() {
            // The emit, not the comment explaining why it is gone.
            if line.contains("\"room_list\"") {
                found.push(format!("{}:{}", path.display(), n + 1));
            }
        }
    }
    assert!(
        found.is_empty(),
        "a `room_list` producer survives at {found:?}"
    );

    // The control: this walk actually reads the files it claims to. Without it,
    // an empty result also means "read_dir found nothing".
    let session = std::fs::read_to_string("src/session.rs").expect("session.rs");
    assert!(
        session.contains("\"lobby_state\""),
        "the walk read session.rs but found no lobby_state either"
    );
}
