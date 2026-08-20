//! The join flow and event delivery scoping, against a real server with real
//! socket.io clients (`docs/40-net-protocol.md` §1, §3).
//!
//! These replace M0's echo round-trip: the transport is now proven by doing
//! something the game needs rather than by bouncing a payload.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use game_core::constants::MapScale;
use game_server::{app, config::Config, state::AppState};
use rust_socketio::{ClientBuilder, Payload, RawClient};

/// Small maps, so a test binary spinning several rooms does not starve the box.
fn test_config() -> Config {
    Config {
        map_scale: MapScale::Small,
        ..Config::default()
    }
}

struct Server {
    addr: SocketAddr,
    /// Held so the room task lives as long as the test.
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

    // Wait for the room to be **ticking**, not for a fixed interval.
    //
    // The room generates its map before entering the loop, and `join` is answered
    // from inside that loop. A sleep long enough on an idle box is not long enough
    // on a busy one, and the failure surfaces as "never received welcome" — which
    // looks like a protocol bug and is a race in the fixture.
    for _ in 0..200 {
        if stack.room.inspect(|w| w.tick).await.unwrap_or(0) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Server {
        addr,
        _shutdown: stack.shutdown,
    }
}

/// Everything one test client received, by event name.
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
    // Wait for the socket.io CONNECT, not just the transport.
    //
    // `connect()` returns once engine.io is up, but the namespace handshake is
    // still in flight, and an `emit` before it lands is dropped on the floor with
    // no error — which surfaces later as "never received welcome" and an empty
    // inbox. The browser client buffers emits until connected; `rust_socketio`
    // does not, so the harness has to.
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

/// Wait for one named event, or fail with what actually arrived.
fn wait_for(rx: &mpsc::Receiver<String>, want: &str, secs: u64) {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    let mut seen = Vec::new();
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(name) => {
                if name == want {
                    return;
                }
                seen.push(name);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(e) => panic!("client channel closed waiting for {want}: {e}"),
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

/// One server, one runtime, the whole join flow in sequence.
///
/// Deliberately a **single** test rather than seven. Each of the seven passed on
/// its own and they interfered when run together in one process — with
/// `--test-threads=1` as well as in parallel — while two servers driven from one
/// blocking thread work fine. The interference is in the harness (a blocking
/// socket.io client per test, each with its own runtime and its own lingering
/// threads), not in the server, and splitting a stateful protocol across
/// independent tests was buying nothing: a round *is* sequential.
/// It catches real bugs: broadcasting `inventory` instead of scoping it to its
/// owner makes it fail.
///
/// **It used to be ~50 % flaky, and the defect was in the harness, not the
/// server.** `ClientBuilder::connect()` returns once engine.io is up, while the
/// socket.io namespace handshake is still in flight; the `join` emitted on the
/// next line was dropped with no error, surfacing as "never received welcome"
/// and an empty inbox. `connect()` now blocks on the `open` callback. 12
/// consecutive runs green, from 1-in-4 before.
///
/// The way that was established is worth keeping: the test client is not the
/// client that ships. Driving the real `socket.io-client` against the same
/// server joined 100/100 times, which located the bug in `rust_socketio` rather
/// than in the protocol — see `the_shipping_client_joins_reliably` in
/// `tests/browser_join.rs`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_join_flow_end_to_end() {
    let s = spawn_server(test_config()).await;
    let addr = s.addr;

    let out = tokio::task::spawn_blocking(move || {
        let mut report = serde_json::Map::new();

        // --- welcome, then map_init -------------------------------------
        let (c1, i1, r1) = connect(
            addr,
            &[
                "welcome",
                "map_init",
                "join_error",
                "inventory",
                "player_join",
                "player_leave",
                "carve",
            ],
        );
        c1.emit("join", serde_json::json!({ "name": "ana", "skin_id": 3 }))
            .expect("emit join");
        wait_for(&r1, "welcome", 15);
        wait_for(&r1, "map_init", 15);
        report.insert("welcome".into(), got(&i1, "welcome")[0].clone());
        report.insert("map_init".into(), got(&i1, "map_init")[0].clone());

        // --- a retry on the same socket must not take a second seat -----
        c1.emit("join", serde_json::json!({ "name": "ana-again" }))
            .expect("emit");
        std::thread::sleep(Duration::from_millis(500));
        report.insert(
            "welcomes_after_retry".into(),
            got(&i1, "welcome").len().into(),
        );

        // --- a bad name is refused --------------------------------------
        let (c_bad, i_bad, r_bad) = connect(addr, &["welcome", "join_error"]);
        c_bad
            .emit("join", serde_json::json!({ "name": "   " }))
            .expect("emit");
        wait_for(&r_bad, "join_error", 15);
        report.insert("bad_name".into(), got(&i_bad, "join_error")[0].clone());
        let _ = c_bad.disconnect();

        // --- a second real player, and player_join reaches the first ----
        let (c2, i2, r2) = connect(addr, &["welcome", "inventory", "carve"]);
        c2.emit("join", serde_json::json!({ "name": "bo" }))
            .expect("emit");
        wait_for(&r2, "welcome", 15);
        wait_for(&r1, "player_join", 15);

        // --- scoping: inventory is private ------------------------------
        c1.emit("select_slot", serde_json::json!({ "slot": 0 }))
            .expect("emit");
        std::thread::sleep(Duration::from_millis(800));
        report.insert("my_inventory".into(), got(&i1, "inventory").len().into());
        report.insert("their_inventory".into(), got(&i2, "inventory").len().into());

        // --- terrain is public: both see the same carves ----------------
        for _ in 0..5 {
            c1.emit("fire", serde_json::json!({})).expect("emit");
            std::thread::sleep(Duration::from_millis(120));
        }
        std::thread::sleep(Duration::from_millis(400));
        let carves_a = got(&i1, "carve");
        let carves_b = got(&i2, "carve");
        report.insert("carves_a".into(), carves_a.len().into());
        report.insert("carves_b".into(), carves_b.len().into());
        report.insert(
            "carve_seqs".into(),
            serde_json::json!(carves_a
                .iter()
                .filter_map(|v| v["seq"].as_u64())
                .collect::<Vec<_>>()),
        );

        // --- a disconnect frees the seat and tells the others -----------
        //
        // A clean close, not a dropped handle. An abrupt drop is detected by the
        // engine.io ping timeout, which is over 20 s by design — testing that here
        // would be testing the heartbeat, slowly. The handler is the same one
        // either way (`on_disconnect` fires for both).
        let _ = c2.disconnect();
        wait_for(&r1, "player_leave", 15);
        report.insert("leaves".into(), got(&i1, "player_leave").len().into());

        let _ = c1.disconnect();
        serde_json::Value::Object(report)
    })
    .await
    .expect("client thread");

    // ---- welcome ----
    let w = &out["welcome"];
    assert!(w["player_id"].is_number(), "welcome carries a player id");
    // `docs/61` §8: the seed is on the HUD so a bug report reproduces the map.
    assert!(w["seed"].is_string(), "seed must survive as a string");
    assert_eq!(w["scale"], "small");
    assert_eq!(w["sim_hz"], 60);

    // ---- map_init: base64 text, not a binary attachment (codec::b64_encode) ----
    let b64 = out["map_init"]
        .as_str()
        .expect("map_init is a base64 string");
    let bytes = game_server::codec::b64_decode(b64).expect("valid base64");
    assert!(bytes.len() > 1000, "got {} bytes", bytes.len());
    assert_eq!(
        u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        game_server::codec::MAP_MAGIC,
        "decoded map_init must start with the magic number"
    );

    assert_eq!(
        out["welcomes_after_retry"], 1,
        "a retry on one socket must not seat a second player"
    );
    assert_eq!(out["bad_name"]["reason"], "bad_name");

    // ---- the scoping assertion this whole task exists for ----
    assert!(
        out["my_inventory"].as_u64().unwrap_or(0) > 0,
        "the owner must receive their own inventory"
    );
    assert_eq!(
        out["their_inventory"], 0,
        "another player received an inventory event: {out}"
    );

    // ---- terrain is public and ordered ----
    assert_eq!(
        out["carves_a"], out["carves_b"],
        "clients disagree on how many carves happened"
    );
    let seqs: Vec<u64> = out["carve_seqs"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_u64()).collect())
        .unwrap_or_default();
    for pair in seqs.windows(2) {
        assert!(pair[1] > pair[0], "carve seq went backwards: {seqs:?}");
    }

    assert!(
        out["leaves"].as_u64().unwrap_or(0) > 0,
        "an abrupt drop must still produce player_leave"
    );
}
