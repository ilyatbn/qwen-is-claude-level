//! The lobby protocol (`docs/71-amendments-v3.md` §B9): create, join by code,
//! quick match, leave.
//!
//! Every negative here carries a control, because "the client did not end up in
//! that room" also passes for a server that seats nobody anywhere.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use game_core::constants::MapScale;
use game_server::{app, config::Config, state::AppState};
use rust_socketio::{ClientBuilder, Payload, RawClient};

fn test_config() -> Config {
    Config {
        map_scale: MapScale::Small,
        bot_count: 0,
        ..Config::default()
    }
}

type Inbox = Arc<Mutex<HashMap<String, Vec<serde_json::Value>>>>;

struct Harness {
    addr: SocketAddr,
    stack: app::Stack,
}

async fn spawn_server() -> Harness {
    let state = AppState::new(test_config());
    let stack = app::build_stack(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    let router = stack.router.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    // §C18: there is no room at startup and a `Lobby` room does not tick, so
    // there is no tick to wait for. Waiting for the listener is the whole
    // readiness condition now — and a test that waited on a tick would hang
    // forever, which is how this one found the change.
    Harness { addr, stack }
}

/// Waits for `open` before returning — see `tests/rooms.rs` and §A28.
fn connect(addr: SocketAddr, inbox: Inbox) -> rust_socketio::client::Client {
    let events = [
        "welcome",
        "map_init",
        "room_created",
        "room_list",
        "room_left",
        "join_error",
        "player_join",
    ];
    let mut b = ClientBuilder::new(format!("http://{addr}")).namespace("/");
    for ev in events {
        let inbox = inbox.clone();
        let name = ev.to_string();
        b = b.on(ev, move |payload: Payload, _: RawClient| {
            let v = match payload {
                Payload::Text(v) => v.first().cloned().unwrap_or(serde_json::Value::Null),
                #[allow(deprecated)]
                Payload::String(s) => {
                    serde_json::from_str(&s).unwrap_or(serde_json::Value::String(s))
                }
                Payload::Binary(b) => serde_json::json!({ "binary_len": b.len() }),
            };
            if let Ok(mut g) = inbox.lock() {
                g.entry(name.clone()).or_default().push(v);
            }
        });
    }
    let (open_tx, open_rx) = std::sync::mpsc::channel::<()>();
    b = b.on("open", move |_: Payload, _: RawClient| {
        let _ = open_tx.send(());
    });
    let client = b.connect().expect("socket.io connect");
    open_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("socket.io never reported `open`");
    client
}

fn count(inbox: &Inbox, ev: &str) -> usize {
    inbox
        .lock()
        .map(|g| g.get(ev).map(|v| v.len()).unwrap_or(0))
        .unwrap_or(0)
}

fn first(inbox: &Inbox, ev: &str, field: &str) -> serde_json::Value {
    inbox
        .lock()
        .ok()
        .and_then(|g| g.get(ev).and_then(|v| v.first().cloned()))
        .and_then(|v| v.get(field).cloned())
        .unwrap_or(serde_json::Value::Null)
}

/// Poll for `n` copies of `ev`.
///
/// The budget is 30 s and that is not padding for a flake. §C18 made a bare
/// `join` **create the room**, and creating a room generates a map — §B2
/// measured that at 0.6–1.1 s on an idle box, and it is several times that when
/// the whole gate is compiling and running beside it. Before, the room already
/// existed at server startup and `join` was a lookup, which is what the old
/// 10 s budget was sized for. This test passed standalone and failed inside the
/// gate for exactly that reason.
fn wait_for(inbox: &Inbox, ev: &str, n: usize, label: &str) {
    for _ in 0..600 {
        if count(inbox, ev) >= n {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "{label}: waited 30 s for {n} `{ev}`, saw {}",
        count(inbox, ev)
    );
}

/// Create a private room, read the code **off the wire**, and join it with a
/// second client. Both must land in the same world.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_client_joins_a_private_room_by_its_code() {
    let h = spawn_server().await;
    let addr = h.addr;

    let out = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        a.emit(
            "create_room",
            serde_json::json!({ "name": "ana", "scale": "small", "private": true }),
        )
        .expect("emit");
        wait_for(&ia, "room_created", 1, "ana");
        wait_for(&ia, "welcome", 1, "ana");

        let code = first(&ia, "room_created", "code")
            .as_str()
            .unwrap_or_default()
            .to_string();

        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        b.emit(
            "join_room",
            serde_json::json!({ "name": "bo", "code": code.clone() }),
        )
        .expect("emit");
        wait_for(&ib, "welcome", 1, "bo");
        // ana was already there, so ana hears bo arrive — the control that the
        // two really are in one room rather than two.
        wait_for(&ia, "player_join", 1, "ana hears bo");

        let out = serde_json::json!({
            "code": code,
            "a_seed": first(&ia, "welcome", "seed"),
            "b_seed": first(&ib, "welcome", "seed"),
            "b_id": first(&ib, "welcome", "player_id"),
            "b_errors": count(&ib, "join_error"),
        });
        let _ = a.disconnect();
        let _ = b.disconnect();
        out
    })
    .await
    .expect("blocking half");

    assert_eq!(out["code"].as_str().map(|c| c.len()), Some(6), "{out}");
    assert_eq!(out["b_errors"], 0, "bo was refused: {out}");
    assert_eq!(
        out["a_seed"], out["b_seed"],
        "same code, different worlds: {out}"
    );
    assert_eq!(
        out["b_id"], 1,
        "bo should be the second player in ana's room"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// The negative: a code nobody owns is refused with a reason, and hostile input
/// never reaches a lookup.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unknown_or_hostile_code_is_refused_with_a_reason() {
    let h = spawn_server().await;
    let addr = h.addr;

    let out = tokio::task::spawn_blocking(move || {
        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        for bad in [
            serde_json::json!({ "name": "bo", "code": "ZZZZZZ" }),
            serde_json::json!({ "name": "bo", "code": "" }),
            serde_json::json!({ "name": "bo", "code": "A".repeat(5000) }),
            serde_json::json!({ "name": "bo", "code": "../../etc/passwd" }),
            serde_json::json!({ "name": "bo", "code": 12345 }),
            serde_json::json!({ "name": "bo" }),
            serde_json::json!({}),
        ] {
            b.emit("join_room", bad).expect("emit");
        }
        std::thread::sleep(Duration::from_millis(800));
        let out = serde_json::json!({
            "errors": count(&ib, "join_error"),
            "welcomes": count(&ib, "welcome"),
            "reason": first(&ib, "join_error", "reason"),
        });
        let _ = b.disconnect();
        out
    })
    .await
    .expect("blocking half");

    assert_eq!(out["welcomes"], 0, "a bad code seated somebody: {out}");
    assert_eq!(out["errors"], 7, "every attempt needs an answer: {out}");
    assert_eq!(out["reason"], "unknown_code", "{out}");

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// Quick match must put two waiting players **together**, not in two rooms —
/// the whole point of matchmaking.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quick_match_seats_two_clients_in_one_room() {
    let h = spawn_server().await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    let out = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        a.emit(
            "quick_match",
            serde_json::json!({ "name": "ana", "scale": "small" }),
        )
        .expect("emit");
        wait_for(&ia, "welcome", 1, "ana");

        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        b.emit(
            "quick_match",
            serde_json::json!({ "name": "bo", "scale": "small" }),
        )
        .expect("emit");
        wait_for(&ib, "welcome", 1, "bo");
        wait_for(&ia, "player_join", 1, "ana hears bo");

        let out = serde_json::json!({
            "a_room": first(&ia, "room_list", "room_id"),
            "b_room": first(&ib, "room_list", "room_id"),
            // §B10: what the lobby reports is who is in there, not an ETA.
            "b_players": first(&ib, "room_list", "players"),
            "b_capacity": first(&ib, "room_list", "capacity"),
            "b_bots": first(&ib, "room_list", "bots"),
            "a_seed": first(&ia, "welcome", "seed"),
            "b_seed": first(&ib, "welcome", "seed"),
        });
        let _ = a.disconnect();
        let _ = b.disconnect();
        out
    })
    .await
    .expect("blocking half");

    assert_eq!(
        out["a_room"], out["b_room"],
        "quick match split them: {out}"
    );
    assert_eq!(out["a_seed"], out["b_seed"], "{out}");
    // And it filled the existing default room rather than spawning another.
    assert_eq!(
        reg.lock().expect("registry").len(),
        1,
        "quick match created a room instead of filling the empty one"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// `leave_room` must free the seat, and the client must then be able to join
/// somewhere else on the same socket without reconnecting.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn leaving_frees_the_seat_and_the_socket_can_join_again() {
    let h = spawn_server().await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();
    let default_room = h.stack.default_room();

    let out = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        a.emit(
            "quick_match",
            serde_json::json!({ "name": "ana", "scale": "small" }),
        )
        .expect("emit");
        wait_for(&ia, "welcome", 1, "ana");

        a.emit("leave_room", serde_json::json!({})).expect("emit");
        wait_for(&ia, "room_left", 1, "ana leaves");

        // Same socket, a brand new private room.
        a.emit(
            "create_room",
            serde_json::json!({ "name": "ana", "scale": "small", "private": true }),
        )
        .expect("emit");
        wait_for(&ia, "room_created", 1, "ana creates");
        wait_for(&ia, "welcome", 2, "ana is seated again");

        let out = serde_json::json!({
            "welcomes": count(&ia, "welcome"),
            "errors": count(&ia, "join_error"),
        });
        let _ = a.disconnect();
        out
    })
    .await
    .expect("blocking half");

    assert_eq!(out["errors"], 0, "rejoining failed: {out}");
    assert_eq!(out["welcomes"], 2, "the second seat never happened: {out}");
    // The room it left must show no humans, or a hopping client holds two seats
    // and the first room can never be reaped.
    assert_eq!(
        reg.lock()
            .expect("registry")
            .get(default_room)
            .map(|e| e.humans()),
        Some(0),
        "the old seat was never freed"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// `tombstone_skin_id` rides alongside `skin_id` (§B9) and is echoed to other
/// players, because they draw your grave.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_tombstone_skin_is_carried_and_echoed() {
    let h = spawn_server().await;
    let addr = h.addr;

    let echoed = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        a.emit("join", serde_json::json!({ "name": "ana" }))
            .expect("emit");
        wait_for(&ia, "welcome", 1, "ana");

        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        b.emit(
            "join",
            serde_json::json!({ "name": "bo", "skin_id": 2, "tombstone_skin_id": 7 }),
        )
        .expect("emit");
        wait_for(&ib, "welcome", 1, "bo");
        wait_for(&ia, "player_join", 1, "ana hears bo");

        let out = serde_json::json!({
            "skin": first(&ia, "player_join", "skin_id"),
            "stone": first(&ia, "player_join", "tombstone_skin_id"),
        });
        let _ = a.disconnect();
        let _ = b.disconnect();
        out
    })
    .await
    .expect("blocking half");

    assert_eq!(echoed["skin"], 2, "{echoed}");
    assert_eq!(echoed["stone"], 7, "{echoed}");

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

// ---------------------------------------------------------------------------
// §C18 — no battle exists until players ask for one
// ---------------------------------------------------------------------------

/// The bug as reported: connecting used to drop you into a running battle.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fresh_server_has_no_rooms_and_nothing_ticking() {
    let h = spawn_server().await;
    let reg = h.stack.registry.clone();

    let ids = {
        let r = reg.lock().expect("registry");
        r.ids().to_vec()
    };
    assert!(
        ids.is_empty(),
        "a fresh server already had rooms: {ids:?} — a player connecting would \
         land in whatever they are doing"
    );

    // And it stays that way: nothing creates one on a timer.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let ids = {
        let r = reg.lock().expect("registry");
        r.ids().to_vec()
    };
    assert!(ids.is_empty(), "a room appeared on its own: {ids:?}");

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// The control for the test above **and** the one below: a room does get made,
/// and it does hold a map. Without this, "no rooms" also passes for a server
/// that cannot create one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn joining_creates_a_room_that_holds_a_map_and_does_not_tick() {
    let h = spawn_server().await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        a.emit("join", serde_json::json!({ "name": "ana" }))
            .expect("emit");
        wait_for(&ia, "welcome", 1, "ana");
        std::thread::sleep(Duration::from_millis(600));
        a
    })
    .await
    .expect("client thread");

    let id = {
        let r = reg.lock().expect("registry");
        *r.ids().first().expect("joining created a room")
    };
    let handle = {
        let r = reg.lock().expect("registry");
        r.get(id).expect("room").handle.clone()
    };

    let (tick, surface, phase) = handle
        .inspect(|w| (w.tick, w.map.meta.surface_points.len(), w.phase))
        .await
        .expect("room alive");

    assert!(
        surface > 0,
        "a lobby room has no map; players cannot see what they are about to play"
    );
    assert_eq!(
        phase,
        game_core::world::RoundPhase::Lobby,
        "a room with one human is not in a lobby"
    );
    assert_eq!(
        tick, 0,
        "a lobby room is simulating — {tick} ticks with one human in it"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// One human waits; "Start with bots" is what starts them (§C18's solo path).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_human_waits_until_they_ask_for_bots() {
    let h = spawn_server().await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    let client = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        a.emit("join", serde_json::json!({ "name": "ana" }))
            .expect("emit");
        wait_for(&ia, "welcome", 1, "ana");
        a
    })
    .await
    .expect("client thread");

    let handle = {
        let r = reg.lock().expect("registry");
        let id = *r.ids().first().expect("room");
        r.get(id).expect("room").handle.clone()
    };

    // Twice the countdown. If it were going to start on its own, it has.
    tokio::time::sleep(Duration::from_secs_f32(
        game_core::constants::LOBBY_COUNTDOWN * 2.0,
    ))
    .await;
    let phase = handle.inspect(|w| w.phase).await.expect("alive");
    assert_eq!(
        phase,
        game_core::world::RoundPhase::Lobby,
        "one human alone started a battle"
    );

    // The control: asking does start it.
    tokio::task::spawn_blocking(move || {
        client
            .emit("start_with_bots", serde_json::json!({}))
            .expect("emit");
        std::thread::sleep(Duration::from_millis(800));
    })
    .await
    .expect("client thread");

    let (phase, tick) = handle.inspect(|w| (w.phase, w.tick)).await.expect("alive");
    assert_ne!(
        phase,
        game_core::world::RoundPhase::Lobby,
        "start_with_bots did nothing"
    );
    assert!(tick > 0, "the round started but nothing is ticking");

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// Two humans start on their own, after the countdown.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_humans_start_on_their_own() {
    let h = spawn_server().await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    let clients = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        a.emit(
            "quick_match",
            serde_json::json!({ "name": "ana", "scale": "small" }),
        )
        .expect("emit");
        wait_for(&ia, "welcome", 1, "ana");
        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        b.emit(
            "quick_match",
            serde_json::json!({ "name": "bo", "scale": "small" }),
        )
        .expect("emit");
        wait_for(&ib, "welcome", 1, "bo");
        (a, b)
    })
    .await
    .expect("client thread");

    let handle = {
        let r = reg.lock().expect("registry");
        let id = *r.ids().first().expect("room");
        r.get(id).expect("room").handle.clone()
    };

    // Countdown plus slack for the socket round trips.
    tokio::time::sleep(Duration::from_secs_f32(
        game_core::constants::LOBBY_COUNTDOWN + 2.0,
    ))
    .await;
    let (phase, tick) = handle.inspect(|w| (w.phase, w.tick)).await.expect("alive");
    assert_ne!(
        phase,
        game_core::world::RoundPhase::Lobby,
        "two humans did not start a round"
    );
    assert!(tick > 0, "the round started but nothing is ticking");

    drop(clients);
    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// The humans-vs-seats distinction, at the only layer where it is observable.
///
/// `round.rs`'s unit tests pass `humans == connected`, so they **cannot** tell
/// the two apart — falsifying `humans` to `connected` there leaves them all
/// green. Bots hold seats, so the distinction only exists once a round has
/// started, which is here.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_room_whose_last_human_leaves_goes_back_to_lobby_despite_its_bots() {
    let mut cfg = test_config();
    cfg.bot_count = 3;
    let state = AppState::new(cfg);
    let stack = app::build_stack(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let router = stack.router.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let reg = stack.registry.clone();

    tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        a.emit("join", serde_json::json!({ "name": "ana" }))
            .expect("emit");
        wait_for(&ia, "welcome", 1, "ana");
        a.emit("start_with_bots", serde_json::json!({}))
            .expect("emit");
        std::thread::sleep(Duration::from_millis(900));
        // Leaving: an explicit disconnect, not a drop. `drop` does not close
        // the socket promptly, so the server never sees the leave and the test
        // reports "the room kept playing" for the wrong reason.
        let _ = a.disconnect();
        std::thread::sleep(Duration::from_millis(1200));
    })
    .await
    .expect("client thread");

    let handle = {
        let r = reg.lock().expect("registry");
        let id = *r.ids().first().expect("room");
        r.get(id).expect("room").handle.clone()
    };
    let (phase, seats, bots) = {
        let p = handle.inspect(|w| w.phase).await.expect("alive");
        let (seats, bots) = handle.status().await.unwrap_or((99, 99));
        (p, seats, bots)
    };
    assert_eq!(
        phase,
        game_core::world::RoundPhase::Lobby,
        "a room with {seats} seats ({bots} of them bots) kept playing a match \
         with no humans in it"
    );
    assert_eq!(bots, 0, "a lobby room still has {bots} bots seated");

    stack.shutdown_all(Duration::from_secs(2)).await;
}

/// A `Lobby` room has **no bots**.
///
/// This needs `bot_count > 0` to mean anything: `test_config()` sets it to 0, so
/// every other test here passes just as happily against a build that seats bots
/// at construction — which is the bug §C18 exists to fix. Falsified by restoring
/// `seat_bots` to `Room::new_async`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lobby_room_has_no_bots() {
    let mut cfg = test_config();
    cfg.bot_count = 4;
    let state = AppState::new(cfg);
    let stack = app::build_stack(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let router = stack.router.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let reg = stack.registry.clone();

    let client = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        a.emit("join", serde_json::json!({ "name": "ana" }))
            .expect("emit");
        wait_for(&ia, "welcome", 1, "ana");
        std::thread::sleep(Duration::from_millis(600));
        a
    })
    .await
    .expect("client thread");

    let handle = {
        let r = reg.lock().expect("registry");
        let id = *r.ids().first().expect("room");
        r.get(id).expect("room").handle.clone()
    };
    let phase = handle.inspect(|w| w.phase).await.expect("alive");
    let (seats, bots) = handle.status().await.unwrap_or((99, 99));
    assert_eq!(phase, game_core::world::RoundPhase::Lobby, "not a lobby");
    assert_eq!(
        bots, 0,
        "a lobby room seated {bots} bots (of {seats} seats) before anyone asked \
         for a battle"
    );

    // The control: they arrive when the round does, or "no bots" also passes
    // for a build that never seats any.
    tokio::task::spawn_blocking(move || {
        client
            .emit("start_with_bots", serde_json::json!({}))
            .expect("emit");
        std::thread::sleep(Duration::from_millis(900));
    })
    .await
    .expect("client thread");
    let (_, bots) = handle.status().await.unwrap_or((0, 0));
    assert!(bots > 0, "starting the round seated no bots");

    stack.shutdown_all(Duration::from_secs(2)).await;
}
