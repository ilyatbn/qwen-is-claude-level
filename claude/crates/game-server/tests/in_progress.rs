//! A live match is closed (`docs/74-amendments-v6.md` §E4).
//!
//! §E4 closes joins **by phase, not by verb**. T17.03 gated `quick_match` alone,
//! and `join_room` by code walked past it into a running match — `by_code` is a
//! bare map lookup. The refusal now lives in the one function all four verbs
//! reach, so there is no path left that seats into a started room.
//!
//! Every refusal here carries a control that a *lobby* join still succeeds.
//! Without it, "bo did not get in" also passes for a server that seats nobody.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use game_core::constants::MapScale;
use game_server::{app, config::Config, state::AppState};
use rust_socketio::{ClientBuilder, Payload, RawClient};

const BUDGET_MS: u64 = 30_000;

type Inbox = Arc<Mutex<HashMap<String, Vec<serde_json::Value>>>>;

struct Harness {
    addr: SocketAddr,
    stack: app::Stack,
}

fn test_config() -> Config {
    Config {
        map_scale: MapScale::Small,
        // A match that starts must have something to start with.
        bot_count: 1,
        ..Config::default()
    }
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
    Harness { addr, stack }
}

fn connect(addr: SocketAddr, inbox: Inbox) -> rust_socketio::client::Client {
    let events = [
        "welcome",
        "map_init",
        "room_created",
        "lobby_state",
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
        .ok()
        .and_then(|g| g.get(ev).map(|v| v.len()))
        .unwrap_or(0)
}

fn last(inbox: &Inbox, ev: &str, field: &str) -> serde_json::Value {
    inbox
        .lock()
        .ok()
        .and_then(|g| g.get(ev).and_then(|v| v.last().cloned()))
        .and_then(|v| v.get(field).cloned())
        .unwrap_or(serde_json::Value::Null)
}

fn summary(inbox: &Inbox) -> String {
    inbox
        .lock()
        .ok()
        .map(|g| {
            let mut k: Vec<String> = g.iter().map(|(k, v)| format!("{k}x{}", v.len())).collect();
            k.sort();
            k.join(" ")
        })
        .unwrap_or_default()
}

/// A wall-clock deadline, not a loop count — under load an iteration budget
/// silently stretches and the number in the failure message becomes a fiction.
fn wait_for(inbox: &Inbox, ev: &str, n: usize, label: &str) {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_millis(BUDGET_MS) {
        if count(inbox, ev) >= n {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "{label}: waited {} s for {n} `{ev}`, saw {} (inbox: {})",
        BUDGET_MS / 1000,
        count(inbox, ev),
        summary(inbox)
    );
}

/// Host a private room and start it, returning `(code, room_id)`.
fn host_and_start(addr: SocketAddr, inbox: &Inbox) -> (String, u32, rust_socketio::client::Client) {
    let a = connect(addr, inbox.clone());
    a.emit(
        "create_room",
        serde_json::json!({ "name": "ana", "scale": "small" }),
    )
    .expect("emit");
    wait_for(inbox, "room_created", 1, "ana");
    let code = last(inbox, "room_created", "code")
        .as_str()
        .expect("a code on the wire")
        .to_string();
    let room_id = last(inbox, "room_created", "room_id")
        .as_u64()
        .expect("a room id on the wire") as u32;
    a.emit("ready", serde_json::json!({})).expect("emit");
    a.emit("start_with_bots", serde_json::json!({}))
        .expect("emit");
    // The match has begun when the map arrives: `map_init` is sent at match
    // start (§E1), so it is the wire's own answer to "has this started".
    wait_for(inbox, "map_init", 1, "ana");
    (code, room_id, a)
}

/// The refusal, its control, and the seat count at both ends.
///
/// One test rather than three because the control has to be the *same server*:
/// a lobby join succeeding on a different server would not rule out a server
/// that had simply stopped seating into started rooms and into everything else.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_join_by_code_into_a_started_match_is_refused_and_seats_nobody() {
    let h = spawn_server().await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    let out = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let (code, room_id, _a) = host_and_start(addr, &ia);
        let joins_before = count(&ia, "player_join");

        // bo has the right code for a room that has begun.
        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        b.emit(
            "join_room",
            serde_json::json!({ "name": "bo", "code": code }),
        )
        .expect("emit");
        wait_for(&ib, "join_error", 1, "bo");
        let reason = last(&ib, "join_error", "reason");

        // bo must not have been seated by any measure: no welcome to bo, and no
        // `player_join` announced to ana. An error arriving is not the same as
        // a seat not being taken.
        std::thread::sleep(Duration::from_millis(300));
        let bo_welcomes = count(&ib, "welcome");
        let joins_after = count(&ia, "player_join");

        // The control: a *lobby* on the same server still admits a joiner. If
        // this fails, the refusal above says nothing about phase.
        let ic: Inbox = Arc::default();
        let c = connect(addr, ic.clone());
        c.emit(
            "create_room",
            serde_json::json!({ "name": "cass", "scale": "small" }),
        )
        .expect("emit");
        wait_for(&ic, "room_created", 1, "cass");
        let open_code = last(&ic, "room_created", "code")
            .as_str()
            .expect("a code")
            .to_string();

        let id: Inbox = Arc::default();
        let d = connect(addr, id.clone());
        d.emit(
            "join_room",
            serde_json::json!({ "name": "dee", "code": open_code }),
        )
        .expect("emit");
        wait_for(&id, "welcome", 1, "dee");

        (
            reason,
            bo_welcomes,
            joins_before,
            joins_after,
            room_id,
            _a,
            b,
            c,
            d,
        )
    })
    .await
    .expect("blocking");

    let (reason, bo_welcomes, joins_before, joins_after, room_id, ..) = out;

    assert_eq!(
        reason.as_str(),
        Some("in_progress"),
        "a join by code into a started match was refused for the wrong reason \
         (or allowed): §E4 distinguishes `in_progress` from `full`, because a \
         full lobby will have room later and a started match will not"
    );
    assert_eq!(
        bo_welcomes, 0,
        "bo was refused and welcomed: the refusal seated a player anyway"
    );
    assert_eq!(
        joins_after, joins_before,
        "a `player_join` was announced for a refused joiner, so a seat was \
         allocated before the refusal"
    );

    // The started room's human count is unchanged, read from the registry
    // rather than from the wire — the other end of the same claim.
    let humans = reg
        .lock()
        .expect("registry")
        .get(room_id)
        .map(|e| e.humans());
    assert_eq!(
        humans,
        Some(1),
        "the started room's human count moved: bo was refused on the wire and \
         seated in the registry anyway"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// A refusal detaches, so the registry does not count a player it turned away.
///
/// Every verb calls `ctx.attach` *before* the seat path runs, and attach
/// increments the room's human count. A refusal that returns without detaching
/// leaves a phantom occupant: it counts against capacity and holds the room
/// against the reaper.
///
/// Exercised through `bad_name` because it is the cheapest of the four refusals
/// to reach — but the leak is the shape of the path, not of the reason, and
/// `in_progress` is proven by the test above reading the registry directly.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_join_leaves_no_phantom_occupant() {
    let h = spawn_server().await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    let room_id = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        a.emit(
            "create_room",
            serde_json::json!({ "name": "ana", "scale": "small" }),
        )
        .expect("emit");
        wait_for(&ia, "room_created", 1, "ana");
        let code = last(&ia, "room_created", "code")
            .as_str()
            .expect("a code")
            .to_string();
        let room_id = last(&ia, "room_created", "room_id")
            .as_u64()
            .expect("a room id") as u32;

        // An empty name is refused by `sanitise_name`.
        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        b.emit("join_room", serde_json::json!({ "name": "", "code": code }))
            .expect("emit");
        wait_for(&ib, "join_error", 1, "bo");
        assert_eq!(
            last(&ib, "join_error", "reason").as_str(),
            Some("bad_name"),
            "the refusal was for the wrong reason, so the count below is not \
             measuring what this test claims"
        );
        std::thread::sleep(Duration::from_millis(300));
        std::mem::forget((a, b));
        room_id
    })
    .await
    .expect("blocking");

    assert_eq!(
        reg.lock()
            .expect("registry")
            .get(room_id)
            .map(|e| e.humans()),
        Some(1),
        "a refused join is still counted as an occupant: it will consume \
         capacity and hold the room against the reaper"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// Quick match cannot reach a started room either — the T17.03 gate still holds
/// now that the refusal has moved into the shared path.
///
/// Without this, moving the check into `seat` could have silently replaced
/// quick-match's *skip* with a *refusal*, which is a worse outcome: a player who
/// asked for any game would be told no instead of being given a new lobby.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quick_match_makes_a_new_lobby_rather_than_being_refused() {
    let h = spawn_server().await;
    let addr = h.addr;

    let out = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        // A public room that has started.
        let a = connect(addr, ia.clone());
        a.emit(
            "quick_match",
            serde_json::json!({ "name": "ana", "scale": "small" }),
        )
        .expect("emit");
        wait_for(&ia, "welcome", 1, "ana");
        a.emit("ready", serde_json::json!({})).expect("emit");
        a.emit("start_with_bots", serde_json::json!({}))
            .expect("emit");
        wait_for(&ia, "map_init", 1, "ana");

        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        b.emit(
            "quick_match",
            serde_json::json!({ "name": "bo", "scale": "small" }),
        )
        .expect("emit");
        wait_for(&ib, "welcome", 1, "bo");
        (count(&ib, "join_error"), a, b)
    })
    .await
    .expect("blocking");

    assert_eq!(
        out.0, 0,
        "quick match refused a player instead of making them a new lobby: the \
         phase check must skip for quick match, not reject"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}
