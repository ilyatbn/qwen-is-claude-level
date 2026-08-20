//! Multi-client integration tests (`docs/41-server-loop-rooms.md` §8).
//!
//! **What this file deliberately does not re-test.** By the time M6 reached this
//! task, most of `docs/41` §8's list was already covered by a suite that owns it:
//!
//! | claim | where it lives |
//! |---|---|
//! | join → welcome → map_init, and event scoping | `tests/join.rs` |
//! | two clients' masks match the server's after 100 fires | `tests/checksum.rs` |
//! | packet rate is not a speed multiplier (§A30) | `tests/checksum.rs` |
//! | phase machine, warmup damage gate, restart vote | `tests/round.rs` |
//! | bots seated as ordinary players | `tests/bots.rs` |
//! | room capacity, command flood, shutdown | `tests/room.rs` |
//! | one item, two players, same tick, same winner | `game-core/tests/world_step.rs` |
//! | a seat held by a never-ready client is swept | `room.rs::sweep_unready` tests |
//!
//! Duplicating those here would buy nothing and cost minutes per run. What is
//! left is the socket-level behaviour nothing else exercises: capacity refusal
//! *over the wire*, disconnect propagation, snapshot cadence and size, input
//! acknowledgement, and malformed-payload tolerance.
//!
//! One near-miss worth recording: the `ready` timeout looked unimplemented
//! because `session.rs` never mentions `ready` expiry. It is in `room.rs`
//! (`sweep_unready`, called every tick), already tested in both directions
//! including the control that a ready player is never swept. Adding a second
//! timeout in the socket layer built a duplicate mechanism and broke
//! `tests/bots.rs` by shifting the seating race. Grep the layer that owns the
//! state, not the layer you happen to be reading.
//!
//! Every client here blocks on the socket.io `open` callback before its first
//! emit. `ClientBuilder::connect()` returns once engine.io is up while the
//! namespace CONNECT is still in flight, and an emit before that lands is dropped
//! with no error — the ~50 % flake that cost a session (§A28).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use game_core::constants::{
    MapScale, SIM_DT, SIM_HZ, SNAPSHOT_FOOTER_BYTES, SNAPSHOT_HEADER_BYTES, SNAPSHOT_HZ,
    SNAPSHOT_PLAYER_BYTES,
};
use game_server::{app, config::Config, state::AppState};
use rust_socketio::{ClientBuilder, Payload, RawClient};

/// Small maps: a test binary spinning several rooms should not starve the box.
fn test_config() -> Config {
    Config {
        map_scale: MapScale::Small,
        bot_count: 0,
        ..Config::default()
    }
}

struct Server {
    addr: SocketAddr,
    room: game_server::room::RoomHandle,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

async fn spawn_server(config: Config) -> Server {
    let state = AppState::new(config);
    let stack = app::build_stack(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    let router = stack.router;
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    // Wait for the room to be *ticking*, not for a fixed interval: the room
    // generates its map before entering the loop, and `join` is answered from
    // inside it. A sleep long enough on an idle box is not long enough on a busy
    // one, and the failure reads as a protocol bug.
    for _ in 0..200 {
        if stack.room.inspect(|w| w.tick).await.unwrap_or(0) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Server {
        addr,
        room: stack.room,
        _shutdown: stack.shutdown,
    }
}

type Inbox = Arc<Mutex<HashMap<String, Vec<serde_json::Value>>>>;

fn text_of(payload: Payload) -> serde_json::Value {
    match payload {
        Payload::Text(v) => v.first().cloned().unwrap_or(serde_json::Value::Null),
        #[allow(deprecated)]
        Payload::String(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::String(s)),
        Payload::Binary(b) => serde_json::json!({ "binary_len": b.len() }),
    }
}

/// A blocking socket.io client on its own thread, recording everything it hears.
fn connect(
    addr: SocketAddr,
    events: &[&'static str],
) -> (rust_socketio::client::Client, Inbox, mpsc::Receiver<String>) {
    let inbox: Inbox = Arc::new(Mutex::new(HashMap::new()));
    let (tx, rx) = mpsc::channel::<String>();
    let mut b = ClientBuilder::new(format!("http://{addr}")).namespace("/");
    for ev in events {
        let inbox = inbox.clone();
        let tx = tx.clone();
        let name = (*ev).to_string();
        b = b.on(*ev, move |payload: Payload, _: RawClient| {
            let v = text_of(payload);
            inbox
                .lock()
                .expect("poisoned")
                .entry(name.clone())
                .or_default()
                .push(v);
            let _ = tx.send(name.clone());
        });
    }
    let (open_tx, open_rx) = mpsc::channel::<()>();
    b = b.on("open", move |_: Payload, _: RawClient| {
        let _ = open_tx.send(());
    });
    let client = b.connect().expect("socket.io connect");
    open_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("socket.io never reported `open`");
    (client, inbox, rx)
}

/// Wait for one named event, or fail saying what actually arrived.
fn wait_for(rx: &mpsc::Receiver<String>, want: &str, secs: u64) {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    let mut seen = Vec::new();
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(name) => {
                if name == want {
                    return;
                }
                if !seen.contains(&name) {
                    seen.push(name);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    panic!("never received `{want}` within {secs}s; saw {seen:?}");
}

fn got(inbox: &Inbox, ev: &str) -> Vec<serde_json::Value> {
    inbox
        .lock()
        .expect("poisoned")
        .get(ev)
        .cloned()
        .unwrap_or_default()
}

/// Snapshot byte-lengths and `last_input_seq` values, as a client sees them.
#[derive(Clone, Default)]
struct SnapshotLog {
    sizes: Arc<Mutex<Vec<usize>>>,
    seqs: Arc<Mutex<Vec<u32>>>,
}

/// Like [`connect`], but also decodes every `snapshot` into a [`SnapshotLog`].
///
/// `rust_socketio` registers handlers on the builder, not on the connected
/// client, so this cannot be bolted on after the fact.
fn connect_logging_snapshots(
    addr: SocketAddr,
    events: &[&'static str],
) -> (
    rust_socketio::client::Client,
    Inbox,
    mpsc::Receiver<String>,
    SnapshotLog,
) {
    let inbox: Inbox = Arc::new(Mutex::new(HashMap::new()));
    let (tx, rx) = mpsc::channel::<String>();
    let log = SnapshotLog::default();
    let mut b = ClientBuilder::new(format!("http://{addr}")).namespace("/");
    for ev in events {
        let inbox = inbox.clone();
        let tx = tx.clone();
        let name = (*ev).to_string();
        b = b.on(*ev, move |payload: Payload, _: RawClient| {
            let v = text_of(payload);
            inbox
                .lock()
                .expect("poisoned")
                .entry(name.clone())
                .or_default()
                .push(v);
            let _ = tx.send(name.clone());
        });
    }
    {
        let log = log.clone();
        b = b.on("snapshot", move |payload: Payload, _: RawClient| {
            let text = match payload {
                Payload::Text(v) => v
                    .first()
                    .and_then(|x| x.as_str().map(str::to_owned))
                    .unwrap_or_default(),
                #[allow(deprecated)]
                Payload::String(s) => s.trim_matches('"').to_string(),
                Payload::Binary(_) => String::new(),
            };
            if let Some(bytes) = game_server::codec::b64_decode(&text) {
                log.sizes.lock().expect("poisoned").push(bytes.len());
                if let Ok(view) = game_server::codec::decode_snapshot(&bytes) {
                    log.seqs.lock().expect("poisoned").push(view.last_input_seq);
                }
            }
        });
    }
    let (open_tx, open_rx) = mpsc::channel::<()>();
    b = b.on("open", move |_: Payload, _: RawClient| {
        let _ = open_tx.send(());
    });
    let client = b.connect().expect("socket.io connect");
    open_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("socket.io never reported `open`");
    (client, inbox, rx, log)
}

/// Join, then wait for the map, then declare ready. The sequence every client runs.
fn join_and_ready(
    addr: SocketAddr,
    name: &str,
    events: &[&'static str],
) -> (rust_socketio::client::Client, Inbox, mpsc::Receiver<String>) {
    let mut all: Vec<&'static str> = vec!["welcome", "map_init", "join_error"];
    all.extend_from_slice(events);
    let (c, inbox, rx) = connect(addr, &all);
    c.emit("join", serde_json::json!({ "name": name }))
        .expect("emit join");
    wait_for(&rx, "welcome", 15);
    wait_for(&rx, "map_init", 15);
    c.emit("ready", serde_json::json!({})).expect("emit ready");
    (c, inbox, rx)
}

// ---------------------------------------------------------------- capacity

/// `docs/41` §4: the room is capped at `MAX_PLAYERS`, and the refusal is a
/// `join_error { reason: "full" }` rather than a dropped connection.
///
/// `tests/room.rs` asserts the cap on the `Room` directly. This asserts the
/// client is *told*, which is a different claim and the one a player experiences.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_seventh_client_is_told_the_room_is_full() {
    let cfg = Config {
        max_players: 3,
        ..test_config()
    };
    let s = spawn_server(cfg).await;
    let addr = s.addr;

    let outcome = tokio::task::spawn_blocking(move || {
        let mut held = Vec::new();
        for i in 0..3 {
            let (c, _, rx) = connect(addr, &["welcome", "join_error"]);
            c.emit("join", serde_json::json!({ "name": format!("p{i}") }))
                .expect("emit join");
            wait_for(&rx, "welcome", 15);
            held.push(c);
        }

        // The one over the line.
        let (c, inbox, rx) = connect(addr, &["welcome", "join_error"]);
        c.emit("join", serde_json::json!({ "name": "spare" }))
            .expect("emit join");
        wait_for(&rx, "join_error", 15);
        let errs = got(&inbox, "join_error");
        let welcomes = got(&inbox, "welcome");

        for c in held {
            let _ = c.disconnect();
        }
        let _ = c.disconnect();
        (errs, welcomes)
    })
    .await
    .expect("client thread");

    let (errs, welcomes) = outcome;
    assert!(
        welcomes.is_empty(),
        "a refused client must not also be welcomed: {welcomes:?}"
    );
    assert_eq!(errs.len(), 1, "expected exactly one join_error: {errs:?}");
    assert_eq!(
        errs[0].get("reason").and_then(|v| v.as_str()),
        Some("full"),
        "the reason must name the cause: {:?}",
        errs[0]
    );
}

// -------------------------------------------------------------- disconnect

/// `docs/40` §6: a disconnect removes the player and broadcasts `player_leave`.
///
/// This closes the socket explicitly. `rust_socketio`'s `Client` does not reliably
/// tear the connection down on drop, so "abrupt" here would be a claim the harness
/// cannot actually make — and a test whose name overstates what it does is worse
/// than one with a narrower name. The server takes both paths through the same
/// `on_disconnect` handler; the genuinely abrupt case (a browser tab closing) is
/// exercised by `scripts/e2e-two-clients.mjs`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_disconnect_tells_the_other_players() {
    let s = spawn_server(test_config()).await;
    let addr = s.addr;
    let room = s.room.clone();

    // The watcher is parked rather than closed, so the seat count can be read
    // while it is still connected — closing it too would make the assertion
    // trivially true for the wrong reason.
    let (left_tx, left_rx) = mpsc::channel::<Vec<serde_json::Value>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let watcher = tokio::task::spawn_blocking(move || {
        let (watcher, inbox, rx) =
            join_and_ready(addr, "watcher", &["player_leave", "player_join"]);
        let (leaver, _i, _r) = join_and_ready(addr, "leaver", &[]);
        wait_for(&rx, "player_join", 15);

        let _ = leaver.disconnect();
        drop(leaver);
        wait_for(&rx, "player_leave", 15);
        let _ = left_tx.send(got(&inbox, "player_leave"));

        let _ = stop_rx.recv_timeout(Duration::from_secs(30));
        let _ = watcher.disconnect();
        drop(watcher);
    });

    let leaves = left_rx
        .recv_timeout(Duration::from_secs(40))
        .expect("no player_leave observed");
    assert_eq!(
        leaves.len(),
        1,
        "expected exactly one player_leave: {leaves:?}"
    );
    assert!(
        leaves[0].get("id").is_some(),
        "player_leave must name who left: {:?}",
        leaves[0]
    );

    // And the seat is genuinely released, not merely announced.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let seated = room.inspect(|w| w.players.len()).await.expect("room alive");
    assert_eq!(
        seated, 1,
        "the leaver's seat was announced but not freed (the watcher should still hold one)"
    );
    let _ = stop_tx.send(());
    let _ = watcher.await;
}

// ---------------------------------------------------- snapshots and inputs

/// Snapshot cadence and size, and input acknowledgement, in one client session —
/// they need the same fixture and separating them doubles the cost for nothing.
///
/// Cadence: `SNAPSHOT_HZ` (20) against a `SIM_HZ` (60) tick, so ~1 snapshot per
/// 3 ticks. Size: exactly `8 + n*15 + 4` (§A25), pinned to the constants rather
/// than to literals (§A19).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshots_arrive_at_the_documented_rate_and_size_and_inputs_are_acknowledged() {
    let s = spawn_server(test_config()).await;
    let addr = s.addr;

    let log = tokio::task::spawn_blocking(move || {
        let (c, _inbox, rx, log) = connect_logging_snapshots(addr, &["welcome", "map_init"]);
        c.emit("join", serde_json::json!({ "name": "solo" }))
            .expect("emit join");
        wait_for(&rx, "welcome", 15);
        wait_for(&rx, "map_init", 15);
        c.emit("ready", serde_json::json!({})).expect("emit ready");

        // ~200 ticks at 60 Hz, one input per tick throughout.
        for seq in 1u32..=200 {
            let batch = [game_core::player::input::Input {
                seq,
                buttons: game_core::player::input::button::RIGHT,
                aim: 0,
            }];
            let bytes = game_server::codec::encode_input_batch(&batch);
            c.emit(
                "input",
                serde_json::json!(game_server::codec::b64_encode(&bytes)),
            )
            .ok();
            std::thread::sleep(Duration::from_secs_f32(SIM_DT));
        }
        std::thread::sleep(Duration::from_millis(400));
        let _ = c.disconnect();
        log
    })
    .await
    .expect("client thread");

    let sizes = log.sizes.lock().expect("poisoned").clone();
    let seqs = log.seqs.lock().expect("poisoned").clone();

    // --- size (§A25, pinned to constants not literals per §A19) ---
    assert!(!sizes.is_empty(), "no snapshots arrived at all");
    let expect_one_player = SNAPSHOT_HEADER_BYTES + SNAPSHOT_PLAYER_BYTES + SNAPSHOT_FOOTER_BYTES;
    for (i, n) in sizes.iter().enumerate() {
        assert_eq!(
            *n, expect_one_player,
            "snapshot {i} was {n} bytes, expected {expect_one_player} \
             (= {SNAPSHOT_HEADER_BYTES} + 1*{SNAPSHOT_PLAYER_BYTES} + {SNAPSHOT_FOOTER_BYTES})"
        );
    }

    // --- cadence ---
    // 200 ticks / 3 = ~66. A sleep loop cannot hold 60 Hz exactly on a shared
    // box, so the band is wide enough for scheduling noise and narrow enough to
    // catch a wrong divisor — "every tick" (200) or "every tenth" (20).
    let expected = 200 / (SIM_HZ / SNAPSHOT_HZ) as usize;
    assert!(
        sizes.len() >= expected / 3 && sizes.len() <= expected * 3,
        "got {} snapshots over ~200 ticks, expected around {expected}",
        sizes.len()
    );

    // --- input acknowledgement ---
    assert!(!seqs.is_empty(), "no last_input_seq values were decoded");
    let mut prev = 0;
    for s in &seqs {
        assert!(
            *s >= prev,
            "last_input_seq went backwards: {prev} then {s} (full: {seqs:?})"
        );
        prev = *s;
    }
    assert!(
        prev > 1,
        "last_input_seq never advanced past {prev}; inputs are not being processed"
    );
}

// -------------------------------------------------------------- robustness

/// `docs/40` §6: a malformed payload is logged and dropped, never a disconnect.
/// Malformed is far more likely to be version skew than an attack.
///
/// The assertion that matters is the *second* half — that the socket still works
/// afterwards. "Was not disconnected" alone passes against a server that has
/// stopped listening.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malformed_input_is_ignored_and_the_socket_keeps_working() {
    let s = spawn_server(test_config()).await;
    let addr = s.addr;
    let room = s.room.clone();

    // Parked, not closed: asserting the seat is still held while the client has
    // already disconnected races its own `Leave`. Passed alone and failed under
    // the loaded workspace run — the same race this file's `bots.rs` sibling had.
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<SnapshotLog>();
    let fuzzer = tokio::task::spawn_blocking(move || {
        let (c, _inbox, rx, log) = connect_logging_snapshots(addr, &["welcome", "map_init"]);
        c.emit("join", serde_json::json!({ "name": "fuzzer" }))
            .expect("emit join");
        wait_for(&rx, "welcome", 15);
        wait_for(&rx, "map_init", 15);
        c.emit("ready", serde_json::json!({})).expect("emit ready");
        std::thread::sleep(Duration::from_millis(200));

        // Not base64; valid base64 that is not a batch; a truncated batch; empty.
        let good = game_server::codec::encode_input_batch(&[game_core::player::input::Input {
            seq: 1,
            buttons: game_core::player::input::button::RIGHT,
            aim: 0,
        }]);
        let truncated = game_server::codec::b64_encode(&good[..good.len().saturating_sub(1)]);
        for junk in [
            "!!!! not base64 !!!!".to_string(),
            game_server::codec::b64_encode(&[0xff, 0xff, 0xff, 0xff]),
            truncated,
            String::new(),
        ] {
            c.emit("input", serde_json::json!(junk)).ok();
            std::thread::sleep(Duration::from_millis(30));
        }

        // Now well-formed ones. If the socket died, these never land.
        for seq in 100u32..130 {
            let batch = [game_core::player::input::Input {
                seq,
                buttons: game_core::player::input::button::RIGHT,
                aim: 0,
            }];
            let bytes = game_server::codec::encode_input_batch(&batch);
            c.emit(
                "input",
                serde_json::json!(game_server::codec::b64_encode(&bytes)),
            )
            .ok();
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(400));
        let _ = done_tx.send(log);
        let _ = stop_rx.recv_timeout(Duration::from_secs(30));
        let _ = c.disconnect();
        drop(c);
    });

    let log = done_rx
        .recv_timeout(Duration::from_secs(60))
        .expect("fuzzer never finished");
    let seated = room.inspect(|w| w.players.len()).await.expect("room alive");
    assert_eq!(
        seated, 1,
        "the client was disconnected by malformed input; `docs/40` §6 says log and \
         drop the message, not the socket"
    );

    let acked = log
        .seqs
        .lock()
        .expect("poisoned")
        .iter()
        .copied()
        .max()
        .unwrap_or(0);
    assert!(
        acked >= 100,
        "no well-formed input was processed after the malformed ones (last seq {acked}); \
         the socket survived but stopped listening"
    );

    let _ = stop_tx.send(());
    let _ = fuzzer.await;
}

// ------------------------------------------------------- state that predates you

/// `inventory` is pushed on pickup, use and death — and was never pushed on
/// join, so a player holding something from the first frame saw "(empty)".
///
/// Third instance of one pattern on this project: the initial world items were
/// never announced (T9.03), the score table was discarded by the client
/// (T9.06), and this. Events describe *changes*; a joiner needs the *current
/// value*, and `docs/41` §4 makes joining mid-round a normal path.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_joiner_is_told_what_it_is_already_holding() {
    let cfg = Config {
        dev_loadout: true,
        ..test_config()
    };
    let s = spawn_server(cfg).await;
    let addr = s.addr;

    let inv = tokio::task::spawn_blocking(move || {
        let (c, inbox, rx) = join_and_ready(addr, "ana", &["inventory"]);
        wait_for(&rx, "inventory", 15);
        let got = got(&inbox, "inventory");
        let _ = c.disconnect();
        got
    })
    .await
    .expect("client thread");

    assert!(
        !inv.is_empty(),
        "joined with a loadout and was never told about it"
    );
    let filled = inv[0]["slots"]
        .as_array()
        .expect("slots array")
        .iter()
        .filter(|s| !s.is_null())
        .count();
    assert!(
        filled > 0,
        "inventory arrived but every slot was empty: {}",
        inv[0]
    );
}

/// The negative half, and the one that matters for §A31's class of mistake:
/// `inventory` is owner-scoped (`docs/30` §6). A second client joining must
/// receive its **own** — and never the first client's.
///
/// Without the control above this test passes against a server that sends no
/// inventory at all, which is exactly the build it is meant to catch.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_joiner_never_receives_another_player_s_inventory() {
    let cfg = Config {
        dev_loadout: true,
        ..test_config()
    };
    let s = spawn_server(cfg).await;
    let addr = s.addr;

    let (first_id, second_id, seen) = tokio::task::spawn_blocking(move || {
        let (a, a_in, a_rx) = join_and_ready(addr, "ana", &["inventory"]);
        wait_for(&a_rx, "inventory", 15);
        let a_id = got(&a_in, "welcome")[0]["player_id"].as_i64().expect("id");

        let (b, b_in, b_rx) = join_and_ready(addr, "bo", &["inventory"]);
        wait_for(&b_rx, "inventory", 15);
        let b_id = got(&b_in, "welcome")[0]["player_id"].as_i64().expect("id");

        // Everything the second client was told about an inventory.
        let seen = got(&b_in, "inventory").len();
        let _ = a.disconnect();
        let _ = b.disconnect();
        (a_id, b_id, seen)
    })
    .await
    .expect("client thread");

    assert_ne!(first_id, second_id, "the two clients got the same id");
    assert_eq!(
        seen, 1,
        "the second client received {seen} inventory events; exactly one — its own — is correct"
    );
}
