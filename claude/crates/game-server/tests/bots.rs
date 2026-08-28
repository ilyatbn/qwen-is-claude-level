//! Bots are seated as ordinary players (`docs/70-amendments-v2.md` §A5).
//!
//! The point of these is that a client cannot tell a bot from a person, and that
//! a person is never refused a seat because of one.

use std::net::SocketAddr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use game_core::constants::MapScale;
use game_server::{app, config::Config, state::AppState};
use rust_socketio::{ClientBuilder, Payload, RawClient};

fn config(bots: usize) -> Config {
    Config {
        map_scale: MapScale::Small,
        bot_count: bots,
        ..Config::default()
    }
}

struct Server {
    addr: SocketAddr,
    room: game_server::room::RoomHandle,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

/// A server with **no room started** (§E1/§C18).
///
/// The client's own `join` creates the lobby it sits in, and starting it is
/// what seats the bots. `spawn_server` below pre-starts a room, which is right
/// for tests that want bots already fighting — and wrong for one that wants to
/// *witness* them being announced, because that happens once and before it
/// arrives.
async fn spawn_server_unstarted(cfg: Config) -> (SocketAddr, tokio::sync::oneshot::Sender<()>) {
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
    (addr, stack.shutdown)
}

async fn spawn_server(cfg: Config) -> Server {
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
    // §C18: a room waits in `Lobby`, so there is no tick until a round starts.
    // This presses "Start with bots" once, the way a player does.
    // §E1: `inspect` answers `None` in a lobby, so `unwrap_or(0)` read 0 forever
    // and this waited for nothing. These tests want bots, which are seated at
    // match start, so the condition is "the match is running".
    let started = stack.start_default_room();
    for _ in 0..400 {
        if started.inspect(|w| w.tick).await.is_some_and(|t| t > 0) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Server {
        addr,
        room: started.clone(),
        _shutdown: stack.shutdown,
    }
}

/// As [`join`], but also hands every `player_join` payload to `on_join`.
fn join_watching(
    addr: SocketAddr,
    name: &str,
    on_join: impl Fn(serde_json::Value) + Send + 'static,
) -> (rust_socketio::client::Client, serde_json::Value) {
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    let (open_tx, open_rx) = mpsc::channel::<()>();
    let client = ClientBuilder::new(format!("http://{addr}"))
        .namespace("/")
        .on("welcome", move |p: Payload, _: RawClient| {
            if let Payload::Text(v) = p {
                let _ = tx.send(v.first().cloned().unwrap_or(serde_json::Value::Null));
            }
        })
        .on("player_join", move |p: Payload, _: RawClient| {
            if let Payload::Text(v) = p {
                if let Some(first) = v.first() {
                    on_join(first.clone());
                }
            }
        })
        .on("open", move |_: Payload, _: RawClient| {
            let _ = open_tx.send(());
        })
        .connect()
        .expect("connect");
    open_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("never opened");
    client
        .emit("join", serde_json::json!({ "name": name }))
        .expect("emit join");
    let welcome = rx
        .recv_timeout(Duration::from_secs(15))
        .expect("no welcome");
    (client, welcome)
}

/// Blocks on `open` before returning — see `docs/70-amendments-v2.md` §A28.
fn join(addr: SocketAddr, name: &str) -> (rust_socketio::client::Client, serde_json::Value) {
    let (tx, rx) = mpsc::channel::<serde_json::Value>();
    let (open_tx, open_rx) = mpsc::channel::<()>();
    let client = ClientBuilder::new(format!("http://{addr}"))
        .namespace("/")
        .on("welcome", move |p: Payload, _: RawClient| {
            if let Payload::Text(v) = p {
                let _ = tx.send(v.first().cloned().unwrap_or(serde_json::Value::Null));
            }
        })
        .on("open", move |_: Payload, _: RawClient| {
            let _ = open_tx.send(());
        })
        .connect()
        .expect("connect");
    open_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("never opened");
    client
        .emit("join", serde_json::json!({ "name": name }))
        .expect("emit join");
    let welcome = rx
        .recv_timeout(Duration::from_secs(15))
        .expect("no welcome");
    (client, welcome)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_joining_client_sees_the_bots_as_players() {
    let (addr, _shutdown) = spawn_server_unstarted(config(2)).await;
    let (welcome, joins) = tokio::task::spawn_blocking(move || {
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = seen.clone();
        let (c, w) = join_watching(addr, "human", move |v| {
            if let Some(n) = v.get("name").and_then(|n| n.as_str()) {
                sink.lock().expect("joins").push(n.to_string());
            }
        });
        // §E1: **the client has to be here before the match starts.** Bots are
        // announced by `player_join` when the round seats them (§C18), and the
        // harness's room is already playing — so a client that arrives after
        // that hears nothing. Joining creates its own lobby, and this is what
        // starts it, which is the order §E2 gives: sit in a lobby, then play.
        c.emit("start_with_bots", serde_json::json!({}))
            .expect("start_with_bots");
        // Waited on: map generation moved to match start and is seconds in a
        // debug build, so a fixed sleep here is a wait against a moved number.
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while seen.lock().expect("joins").len() < 2 {
            assert!(
                std::time::Instant::now() < deadline,
                "the bots were never announced: {:?}",
                seen.lock().expect("joins")
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = c.disconnect();
        let got = seen.lock().expect("joins").clone();
        (w, got)
    })
    .await
    .expect("client thread");

    // §E6: `welcome` no longer carries a roster — `lobby_state` does for humans,
    // and `player_join` announces the bots when the match seats them. Keeping a
    // copy on `welcome` would have put two sources of truth on one wire.
    assert!(
        welcome.get("players").is_none(),
        "welcome still carries a roster: {welcome}"
    );
    assert!(
        welcome.get("scale").is_none(),
        "welcome still carries a scale, which a host can change under it: {welcome}"
    );

    // The control, and the claim this test is named for: the client really is
    // told about the bots. Without it, "welcome has no players" passes for a
    // server that tells a client nothing at all.
    assert_eq!(
        joins.len(),
        2,
        "expected both bots announced to the client, got {joins:?}"
    );
    assert!(
        joins.iter().all(|n| !n.is_empty()),
        "a bot was announced with no name — the `p1, p2, p3` bug"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bots_actually_move() {
    let s = spawn_server(config(2)).await;

    // Positions now, and after two seconds of simulation.
    let before = s
        .room
        .inspect(|w| w.players.iter().map(|p| p.body.pos.x).collect::<Vec<_>>())
        .await
        .expect("room");
    assert_eq!(before.len(), 2, "bots were not seated");

    tokio::time::sleep(Duration::from_millis(2000)).await;

    let after = s
        .room
        .inspect(|w| w.players.iter().map(|p| p.body.pos.x).collect::<Vec<_>>())
        .await
        .expect("room");

    let moved = before
        .iter()
        .zip(after.iter())
        .filter(|(a, b)| (*a - *b).abs() > 1.0)
        .count();
    assert!(
        moved > 0,
        "no bot moved in two seconds: {before:?} -> {after:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_human_is_never_refused_a_seat_because_of_a_bot() {
    // Fill the room entirely with bots.
    let mut cfg = config(6);
    cfg.max_players = 6;
    let s = spawn_server(cfg).await;
    let addr = s.addr;

    assert_eq!(
        s.room.inspect(|w| w.players.len()).await.expect("room"),
        6,
        "the room should be full of bots"
    );

    // The human stays connected while the assertions run.
    //
    // This test used to disconnect immediately and then assert on
    // `players.len()`, which raced its own `Leave` command — 3 failures in 5
    // runs on an untouched tree. Its comment claimed the bot count avoided that
    // race, but `players.len()` counts humans too, so it was the racing quantity.
    // Parking the client removes the race instead of widening a sleep.
    let (welcome_tx, welcome_rx) = mpsc::channel::<serde_json::Value>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let human = tokio::task::spawn_blocking(move || {
        let (c, w) = join(addr, "human");
        let _ = welcome_tx.send(w);
        let _ = stop_rx.recv_timeout(Duration::from_secs(30));
        let _ = c.disconnect();
        drop(c);
    });

    let welcome = welcome_rx
        .recv_timeout(Duration::from_secs(20))
        .expect("no welcome");
    assert!(
        welcome["player_id"].as_u64().is_some(),
        "a human was refused a seat in a room full of bots: {welcome}"
    );

    // The room started full at 6 bots, the human is seated (asserted above), and
    // capacity is 6 — so a total of 6 means exactly one bot was removed to make
    // room. No bot-count accessor is needed to prove the claim.
    let seated = s.room.inspect(|w| w.players.len()).await.expect("room");
    assert_eq!(
        seated, 6,
        "expected 5 bots + 1 human; capacity was exceeded or a bot was not kicked"
    );

    let _ = stop_tx.send(());
    let _ = human.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bot_count_zero_seats_none() {
    let s = spawn_server(config(0)).await;
    assert_eq!(s.room.inspect(|w| w.players.len()).await.expect("room"), 0);
}
