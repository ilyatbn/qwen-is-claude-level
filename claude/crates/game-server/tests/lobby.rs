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
        // §E6: `room_list` is deleted — it had no subscriber anywhere in the
        // app. `lobby_state` is what replaces it, and it is read.
        "lobby_state",
        "lobby_error",
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

/// A field from the **last** occurrence of `ev`, or `Null`.
///
/// `first()` is right for a message sent once; it is wrong for one that is
/// re-broadcast on every change, where the claim is about the latest state.
fn last(inbox: &Inbox, ev: &str, field: &str) -> serde_json::Value {
    inbox
        .lock()
        .ok()
        .and_then(|g| g.get(ev).and_then(|v| v.last().cloned()))
        .and_then(|v| v.get(field).cloned())
        .unwrap_or(serde_json::Value::Null)
}

/// The names in the **last** `lobby_state` a client received.
///
/// The last, not the first: a later arrival re-broadcasts, and it is that
/// message which must name everyone. Shared by the two tests that ask "was this
/// client told who is in the room", so they cannot drift apart on the answer.
fn names_in(inbox: &Inbox) -> Vec<String> {
    inbox
        .lock()
        .ok()
        .and_then(|g| g.get("lobby_state").and_then(|v| v.last().cloned()))
        .and_then(|w| w.get("players").cloned())
        .and_then(|p| p.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|p| {
            p.get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("<no name>")
                .to_string()
        })
        .collect()
}

fn count(inbox: &Inbox, ev: &str) -> usize {
    inbox
        .lock()
        .map(|g| g.get(ev).map(|v| v.len()).unwrap_or(0))
        .unwrap_or(0)
}

/// The wall-clock budget every wait in this file gets.
const BUDGET_MS: u64 = 30_000;

/// Emit `ev` and **keep emitting** until `expect` comes back.
///
/// T13.06.10. Measured, over ten `cargo test -p game-server` runs: **1 in 10
/// failed**, and the failure is always the same shape — `waited 30 s for 1
/// `welcome`, saw 0 (inbox: empty)`. Not one event of any kind, on a socket
/// whose `open` callback had already fired. Thirty seconds of silence is not a
/// busy box; the emit was never delivered.
///
/// §A28 records the mechanism: `rust_socketio`'s `connect()` returns while the
/// socket.io namespace CONNECT is still in flight, so an emit on the next line
/// is dropped **with no error**. Waiting for `open` — which is what that session
/// added — narrows the window without closing it.
///
/// So this is the task's third option, waiting on the effect with an adaptive
/// bound, and not its first. Raising the budget would be treating the symptom
/// twice over: it is already five times the observed need (the worst real wait
/// across a full workspace run used 24 % of it), and no budget fixes a message
/// that was never sent.
///
/// Re-emitting is safe because the server defines it so: "a second join on one
/// socket is ignored, not a second player: a client that retries must not
/// consume two seats" (`session.rs`). **Only for emits with that guarantee** —
/// `create_room` has none, and retrying it would create a second room.
fn emit_until(
    client: &rust_socketio::client::Client,
    inbox: &Inbox,
    ev: &str,
    payload: serde_json::Value,
    expect: &str,
    label: &str,
) {
    emit_until_dropping(client, inbox, ev, payload, expect, label, 0)
}

/// `emit_until`, with the first `drop_first` attempts sent to an event name no
/// handler exists for — i.e. delivered nowhere.
///
/// This exists so the retry can be **falsified deterministically**. The failure
/// it guards against showed up once in ten `cargo test -p game-server` runs, and
/// across twenty-five runs afterwards the retry never fired at all — so "0/25
/// failures" says the flake did not recur, not that the retry works. A rate that
/// low cannot be measured with the runs anyone will actually sit through, and a
/// metric with no control is a number rather than evidence.
///
/// Simulating the drop is faithful to the real mechanism: §A28's race loses the
/// emit silently, which is indistinguishable from sending it somewhere nothing
/// is listening.
#[allow(clippy::too_many_arguments)]
fn emit_until_dropping(
    client: &rust_socketio::client::Client,
    inbox: &Inbox,
    ev: &str,
    payload: serde_json::Value,
    expect: &str,
    label: &str,
    drop_first: usize,
) {
    let budget = Duration::from_millis(BUDGET_MS);
    // Well above the normal latency, or the retry IS the bug. Measured on this
    // box, a healthy `welcome` takes 1.7-1.9 s (worst observed 2.4 s), and a
    // first cut of this retried every 1.5 s — under the normal wait, so every
    // healthy run double-joined and the failure rate went from **1/10 to 10/10**.
    // The server's duplicate guard is `sessions.player_of(sid).is_some()`, which
    // is only set once `room.join()` has completed, so a second join inside that
    // window is not deduplicated at all.
    //
    // A third of the budget, floored at 5 s: it never fires in a healthy run and
    // fires two or three times in a genuinely silent one.
    let retry_every = Duration::from_millis((BUDGET_MS / 3).max(5_000));
    let started = std::time::Instant::now();
    let mut sent = 0;
    while started.elapsed() < budget {
        let target = if sent < drop_first {
            "join_that_goes_nowhere"
        } else {
            ev
        };
        client.emit(target, payload.clone()).expect("emit");
        sent += 1;
        let until = std::time::Instant::now() + retry_every;
        while std::time::Instant::now() < until {
            if count(inbox, expect) >= 1 {
                if sent > 1 {
                    eprintln!("EMIT_RETRY {label}/{ev}: delivered on attempt {sent}");
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    panic!(
        "{label}: emitted `{ev}` {sent} time(s) over {:.0} s and never saw `{expect}` (inbox: {})",
        budget.as_secs_f32(),
        inbox_summary(inbox)
    );
}

/// What actually arrived. "saw 0" alone reads as a broken handshake; knowing
/// whether a `join_error` came back or nothing at all separates a server that
/// refused from a message that was never delivered (§B23 — a false failure is
/// the expensive kind).
fn inbox_summary(inbox: &Inbox) -> String {
    inbox
        .lock()
        .map(|g| {
            let mut v: Vec<String> = g
                .iter()
                .map(|(k, xs)| format!("{k}x{}", xs.len()))
                .collect();
            v.sort();
            if v.is_empty() {
                "empty".to_string()
            } else {
                v.join(" ")
            }
        })
        .unwrap_or_else(|_| "poisoned".to_string())
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
    let budget = Duration::from_millis(BUDGET_MS);
    let started = std::time::Instant::now();
    loop {
        if count(inbox, ev) >= n {
            // T13.06.10: report the MARGIN, not just success. A pass/fail rate
            // samples a coin flip; the fraction of the budget actually consumed
            // says how close to one the gate is. `WAIT_MARGIN=1` prints it.
            if std::env::var("WAIT_MARGIN").is_ok() {
                eprintln!(
                    "WAIT_MARGIN {label}/{ev} {:.2}s of {:.0}s ({:.0}%)",
                    started.elapsed().as_secs_f32(),
                    budget.as_secs_f32(),
                    100.0 * started.elapsed().as_secs_f32() / budget.as_secs_f32(),
                );
            }
            return;
        }
        // A wall-clock deadline, not a loop count. `for _ in 0..200 { sleep(50) }`
        // counts ITERATIONS: under load each takes longer than 50 ms, so the real
        // budget silently stretched — which is part of why this usually passed
        // and why, when it did not, the number in the message was a fiction.
        if started.elapsed() >= budget {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "{label}: waited {:.0} s for {n} `{ev}`, saw {} (inbox: {})",
        budget.as_secs_f32(),
        count(inbox, ev),
        inbox_summary(inbox)
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

        // §E6: these read `room_list`, which is deleted — and `first()` answers
        // `Value::Null` for an event that never arrived, so the assertion whose
        // message names the claim had become `assert_eq!(Null, Null)` and could
        // not fail. The test still caught a split through `a_seed == b_seed`, so
        // it passed for the right reason by accident.
        //
        // `lobby_state` says the same thing and is a **stronger** witness: two
        // clients in one room see the same roster, which a room id cannot tell
        // you and which is the thing quick match is actually being asked for.
        let out = serde_json::json!({
            "a_names": names_in(&ia),
            "b_names": names_in(&ib),
            "b_capacity": first(&ib, "lobby_state", "capacity"),
            "a_seed": first(&ia, "welcome", "seed"),
            "b_seed": first(&ib, "welcome", "seed"),
        });
        let _ = a.disconnect();
        let _ = b.disconnect();
        out
    })
    .await
    .expect("blocking half");

    // Both clients see both players, which is only true if they are in one room.
    let mut a_names: Vec<String> =
        serde_json::from_value(out["a_names"].clone()).unwrap_or_default();
    let mut b_names: Vec<String> =
        serde_json::from_value(out["b_names"].clone()).unwrap_or_default();
    a_names.sort();
    b_names.sort();
    assert_eq!(
        a_names,
        vec!["ana".to_string(), "bo".to_string()],
        "quick match split them: {out}"
    );
    assert_eq!(
        a_names, b_names,
        "the two clients saw different rooms: {out}"
    );
    // The control: these came from a message that actually arrived, not from
    // `first()`'s `Null` for one that did not.
    assert!(
        out["b_capacity"].is_number(),
        "no lobby_state reached bo, so the rosters above are vacuous: {out}"
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
        emit_until(
            &a,
            &ia,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );

        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        emit_until(
            &b,
            &ib,
            "join",
            serde_json::json!({ "name": "bo", "skin_id": 2, "tombstone_skin_id": 7 }),
            "welcome",
            "bo",
        );
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
async fn joining_creates_a_lobby_that_holds_no_map_and_does_not_simulate() {
    let h = spawn_server().await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        emit_until(
            &a,
            &ia,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );
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

    // §E1 **inverted this test.** It used to assert `surface > 0` — "a lobby
    // room has no map; players cannot see what they are about to play". A lobby
    // now deliberately has no map, because that is what lets a private lobby
    // offer map size as a setting: there is nothing yet to contradict.
    //
    // `inspect` is the world-shaped read, and this is the assertion that a
    // lobby answers it rather than panicking on it.
    let peek = handle.inspect(|w| w.map.meta.surface_points.len()).await;
    assert!(
        peek.is_none(),
        "a lobby answered a question about a map it does not have ({peek:?})"
    );

    let info = handle.join_info().await.expect("room alive");
    assert!(
        info.map.is_none(),
        "a lobby handed out a map; §E1 says the map is built when the match starts"
    );
    assert_eq!(
        info.phase, "lobby",
        "a room with one human is not in a lobby"
    );
    // `round_time` is the strict witness for "nothing has been simulated": it
    // advances only inside `World::step`. `tick` is a *clock* and runs in a
    // lobby too (`docs/72` §C18-clarified), which the next test asserts.
    assert_eq!(
        info.round_time, 0.0,
        "a lobby room is simulating — round_time {} with one human in it",
        info.round_time
    );

    // The roster is the seats now (§E1.1), and it still holds the one human.
    let roster = handle.roster().await.expect("room alive");
    assert_eq!(
        roster.len(),
        1,
        "the lobby holds its roster: expected the one human who joined"
    );
    assert_eq!(roster[0].1, "ana", "the seat lost the name it joined under");

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// The clock runs while the simulation does not.
///
/// `docs/72` §C18-clarified, and §C27 records a determinism test that could not
/// tell a round from an empty lobby. Freezing `tick` made every command recorded
/// during a lobby land on tick 0; this is the pair of assertions that keeps both
/// halves true at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lobby_ticks_but_does_not_simulate() {
    let h = spawn_server().await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        emit_until(
            &a,
            &ia,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );
        std::thread::sleep(Duration::from_millis(400));
        a
    })
    .await
    .expect("client thread");

    let handle = {
        let r = reg.lock().expect("registry");
        let id = *r.ids().first().expect("joining created a room");
        r.get(id).expect("room").handle.clone()
    };

    let first = handle.join_info().await.expect("room alive");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let second = handle.join_info().await.expect("room alive");

    assert!(
        second.tick > first.tick,
        "the lobby clock stopped: tick {} then {} half a second later",
        first.tick,
        second.tick
    );
    // The control. Without it "the clock runs" also passes for a lobby that is
    // quietly simulating a round nobody asked for.
    assert_eq!(
        second.round_time, 0.0,
        "the lobby stepped the world: round_time {}",
        second.round_time
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// One human waits; "Start with bots" is what starts them (§C18's solo path).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_human_waits_a_while_before_the_bots_arrive() {
    let h = spawn_server().await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    let client = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        emit_until(
            &a,
            &ia,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );
        a
    })
    .await
    .expect("client thread");

    let handle = {
        let r = reg.lock().expect("registry");
        let id = *r.ids().first().expect("room");
        r.get(id).expect("room").handle.clone()
    };

    // Half the bot timeout: long enough that a countdown-era start would have
    // fired, short enough that §E2's timeout has not.
    tokio::time::sleep(Duration::from_secs_f32(
        game_core::constants::LOBBY_BOT_TIMEOUT / 2.0,
    ))
    .await;
    // §E1: `join_info`, not `inspect` — a lobby has no world for a
    // world-shaped read to reach, and `None` there would read as a dead room.
    let phase = handle.join_info().await.expect("alive").phase;
    // §E2 **changed this claim.** One human alone used to wait forever for a
    // second — `MIN_PLAYERS_TO_START` was 2 — and "Start with bots" was the only
    // way out. Now the bot timeout is, and a solo player gets a game after
    // `LOBBY_BOT_TIMEOUT` whether they ask or not. What is still true, and what
    // this asserts, is that it does not start *immediately*: half the timeout in,
    // they are still in a lobby.
    assert_eq!(phase, "lobby", "one human alone started a battle instantly");

    // The control: asking does start it.
    tokio::task::spawn_blocking(move || {
        client
            .emit("start_with_bots", serde_json::json!({}))
            .expect("emit");
    })
    .await
    .expect("client thread");

    // Waited on, not slept. §E1 moved map generation to match start, so the gap
    // between asking and the phase changing is however long the generator takes
    // — 0.3-1.1 s in release and several times that in a debug build under
    // `cargo test --workspace`, where this failed while passing alone.
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    let phase = loop {
        let p = handle.join_info().await.expect("alive").phase;
        if p != "lobby" {
            break p;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "start_with_bots did nothing: still {p} after 60 s"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_ne!(phase, "lobby", "start_with_bots did nothing");
    let tick = handle.join_info().await.expect("alive").tick;
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

    // The bot timeout plus slack for the socket round trips and generation.
    tokio::time::sleep(Duration::from_secs_f32(
        game_core::constants::LOBBY_BOT_TIMEOUT + 3.0,
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
        emit_until(
            &a,
            &ia,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );
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
        let p = handle.join_info().await.expect("alive").phase;
        let (seats, bots) = handle.status().await.unwrap_or((99, 99));
        (p, seats, bots)
    };
    assert_eq!(
        phase, "lobby",
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
        emit_until(
            &a,
            &ia,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );
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
    let phase = handle.join_info().await.expect("alive").phase;
    let (seats, bots) = handle.status().await.unwrap_or((99, 99));
    assert_eq!(phase, "lobby", "not a lobby");
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

/// The bots you are about to fight are **announced**, not just simulated.
///
/// A socket learns the roster from its own `welcome` and thereafter from
/// `player_join` (`docs/40` §3). Bots used to be seated when the room was
/// constructed, so a human's `welcome` already listed them. §C18 moved seating
/// into `begin_round`, which happens with the human already connected — and
/// nothing announced them. Snapshots carried three players while the scoreboard
/// held one, so the results screen at the end of a round against bots named
/// nobody but you. `round-end` caught it as "the screen lists 1 players, the
/// server has 3".
///
/// The control is the second half: **no** `player_join` arrives while the room
/// is still a lobby. Without it this passes for a server that announces three
/// bots the moment anybody connects, which is the §C18 bug wearing a hat.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn starting_a_round_announces_the_bots_it_seats() {
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

    let (in_lobby, after_start) = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        emit_until(
            &a,
            &ia,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );
        // Long enough for LOBBY_COUNTDOWN to have elapsed twice over had one
        // been running: the control is that nothing was announced *because*
        // nothing was seated, not because we looked too early.
        std::thread::sleep(Duration::from_millis(1200));
        let in_lobby = count(&ia, "player_join");

        a.emit("start_with_bots", serde_json::json!({}))
            .expect("emit");
        // Waited on, not counted. §E1 moved map generation to match start, so
        // the gap between asking and the bots being announced is now however
        // long the generator takes — 0.3-1.1 s in release and several times that
        // in debug. The old `sleep(1200)` was a wait hardcoded against a
        // duration that this change moved, which is a test that expires.
        wait_for(&ia, "player_join", 3, "bots announced at match start");
        let names: Vec<String> = ia
            .lock()
            .ok()
            .and_then(|g| g.get("player_join").cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
            .collect();
        let _ = a.disconnect();
        (in_lobby, names)
    })
    .await
    .expect("client thread");

    assert_eq!(
        in_lobby, 0,
        "the lobby announced {in_lobby} player(s) before the round started — a Lobby room \
         has no bots (§C18)"
    );
    assert_eq!(
        after_start.len(),
        3,
        "BOT_COUNT is 3 and the client was told about {}: {after_start:?}",
        after_start.len()
    );
    // Named, not anonymous. `World::add_player` drops the name it is given and
    // the `welcome` roster carries none, so an announcement without one leaves
    // the scoreboard printing `p1`, `p2`, `p3`.
    for n in &after_start {
        assert!(
            n.starts_with("Bot "),
            "a bot was announced as {n:?} — the scoreboard will show an id, not a name"
        );
    }

    stack.shutdown_all(Duration::from_secs(2)).await;
}

/// `welcome` tells you what everybody is called — **including you**.
///
/// `World::add_player` takes a name and drops it, and nothing else retained one,
/// so the roster in `welcome` carried ids, skins and scores and no names. The
/// only place a name ever appeared was the `player_join` broadcast, which
/// `broadcast_except` sends to everyone *but* the player who joined. Two
/// player-visible consequences, both of them permanent for the round: your own
/// scoreboard row read `p0`, and a client joining a room already in progress saw
/// every player already in it as `p1`, `p2`… forever.
///
/// The second client is the control. Without it, "the roster has names" also
/// passes for a server that only ever names the one player it is talking to.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lobby_state_names_everyone_in_the_room_including_yourself() {
    let h = spawn_server().await;
    let addr = h.addr;

    let (a_names, b_names) = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        emit_until(
            &a,
            &ia,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );

        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        emit_until(
            &b,
            &ib,
            "join",
            serde_json::json!({ "name": "bo" }),
            "welcome",
            "bo",
        );
        // Let bo's join reach ana: the room broadcasts on the next tick.
        std::thread::sleep(Duration::from_millis(600));

        let out = (names_in(&ia), names_in(&ib));
        let _ = a.disconnect();
        let _ = b.disconnect();
        out
    })
    .await
    .expect("client thread");

    let mut a_sorted = a_names.clone();
    a_sorted.sort();
    assert_eq!(
        a_sorted,
        vec!["ana".to_string(), "bo".to_string()],
        "ana was not re-told the roster when bo arrived: {a_names:?}"
    );
    let mut got = b_names.clone();
    got.sort();
    assert_eq!(
        got,
        vec!["ana".to_string(), "bo".to_string()],
        "a client joining a room in progress was not told who was already in it: {b_names:?}"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// T13.06.10 — the retry recovers a join that was never delivered, and seats
/// exactly one player doing it.
///
/// This is the falsification the rate comparison cannot provide. Before the
/// change, `cargo test -p game-server` failed **1 run in 10**, always as
/// `waited 30 s for 1 `welcome`, saw 0 (inbox: empty)` — no event of any kind
/// on a socket whose `open` had already fired, which is a lost emit, not a slow
/// box (§A28). After it, **0 in 25** — but the retry never fired once in those
/// 25 runs, so that number says the flake did not recur, not that the fix
/// works. At a rate that low nobody can run enough iterations to tell the two
/// apart, so the mechanism is exercised directly instead.
///
/// The first emit goes to an event name with no handler, which is exactly what
/// the race produces: a message sent and silently delivered nowhere.
///
/// **Both halves matter.** A retry that recovers the join but seats the player
/// twice would trade a flake for a duplicate-seat bug — and the server's
/// duplicate guard (`sessions.player_of(sid).is_some()`) is only set once
/// `room.join()` has completed, so a retry inside that window is *not*
/// deduplicated. That is not hypothetical: a first cut of this retried every
/// 1.5 s, under the 1.7-1.9 s a healthy `welcome` actually takes, so every
/// healthy run double-joined and the failure rate went from 1/10 to **10/10**.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_join_that_is_never_delivered_is_retried_until_it_is() {
    let h = spawn_server().await;
    let addr = h.addr;

    // The client stays connected until the seat count has been read: leaving is
    // what frees a seat, so disconnecting first would read 0 and report a
    // double-seat guard passing for the wrong reason.
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let (welcome_tx, welcome_rx) = std::sync::mpsc::channel::<usize>();
    let client = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        // The first attempt is swallowed. Without the retry this waits out the
        // whole budget and panics with `inbox: empty` — the real failure.
        emit_until_dropping(
            &a,
            &ia,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
            1,
        );
        let _ = welcome_tx.send(count(&ia, "welcome"));
        let _ = done_rx.recv_timeout(Duration::from_secs(30));
        let _ = a.disconnect();
    });

    let welcomes = welcome_rx
        .recv_timeout(Duration::from_secs(60))
        .expect("the client thread never reported a welcome");
    assert_eq!(
        welcomes, 1,
        "the recovered join produced {welcomes} welcomes"
    );

    // Exactly one seat. `status()` counts seats and bots; `test_config` sets
    // `bot_count` to 0, so this is humans.
    let handle = {
        let r = h.stack.registry.lock().expect("registry");
        let id = *r.ids().first().expect("the join created a room");
        r.get(id).expect("room").handle.clone()
    };
    let (seats, bots) = handle.status().await.unwrap_or((99, 99));
    let _ = done_tx.send(());
    client.await.expect("client thread");
    assert_eq!(bots, 0, "the fixture seated bots, so `seats` is not humans");
    assert_eq!(
        seats, 1,
        "the retried join seated {seats} players — a retry that double-seats trades \
         a flake for a worse bug"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

// ---------------------------------------------------------------------------
// §E1: the map arrives when the match starts, not when you sit down.
// ---------------------------------------------------------------------------

/// Seating sends `welcome` and **no** `map_init`; starting the match sends one.
///
/// Both halves in one test on purpose. "No `map_init` at join" is satisfied by a
/// server that never sends one at all — which is a broken game, not a lobby — so
/// the presence control is the second half, on the same socket.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lobby_sends_no_map_init_and_the_match_start_sends_exactly_one() {
    let h = spawn_server().await;
    let addr = h.addr;

    let (before, after) = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        emit_until(
            &a,
            &ia,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );
        // Long enough that a `map_init` sent at seat time would have landed.
        std::thread::sleep(Duration::from_millis(700));
        let before = count(&ia, "map_init");

        // The solo path (§C18), which is the manual form of §E2's timeout.
        a.emit("start_with_bots", serde_json::json!({}))
            .expect("start_with_bots");
        wait_for(&ia, "map_init", 1, "map_init after the match started");
        // Settle, so a second copy would be counted.
        std::thread::sleep(Duration::from_millis(700));
        let after = count(&ia, "map_init");
        drop(a);
        (before, after)
    })
    .await
    .expect("client thread");

    assert_eq!(
        before, 0,
        "a player seated in a lobby was sent a map; §E1 says the map does not exist yet"
    );
    assert_eq!(
        after, 1,
        "expected exactly one map_init once the match started, got {after}"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// Everyone seated at the moment the match starts gets the map — not just the
/// player who asked for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_seated_socket_gets_the_map_when_the_match_starts() {
    let h = spawn_server().await;
    let addr = h.addr;

    let (a_maps, b_maps) = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        emit_until(
            &a,
            &ia,
            "quick_match",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );
        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        emit_until(
            &b,
            &ib,
            "quick_match",
            serde_json::json!({ "name": "ben" }),
            "welcome",
            "ben",
        );
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(count(&ia, "map_init"), 0, "ana had a map while in a lobby");
        assert_eq!(count(&ib, "map_init"), 0, "ben had a map while in a lobby");

        a.emit("start_with_bots", serde_json::json!({}))
            .expect("start_with_bots");
        wait_for(&ia, "map_init", 1, "ana's map at match start");
        wait_for(&ib, "map_init", 1, "ben's map at match start");
        std::thread::sleep(Duration::from_millis(500));
        let out = (count(&ia, "map_init"), count(&ib, "map_init"));
        drop((a, b));
        out
    })
    .await
    .expect("client thread");

    assert_eq!(a_maps, 1, "ana got {a_maps} maps, expected exactly one");
    assert_eq!(
        b_maps, 1,
        "ben sat in the same lobby and got {b_maps} maps — the broadcast reached only the asker"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// Two lobbies started with the same settings play different maps.
///
/// `docs/71` §B13's rule, re-asserted **through the new lifecycle**: the seed is
/// still mixed per room at construction, and moving generation to match start
/// must not have moved it to something shared. Testing `mix_seed` alone would
/// not catch that, because it never exercises the decision about when the seed
/// is taken.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_lobbies_started_with_the_same_settings_get_different_maps() {
    use game_server::room::Room;
    let cfg = Arc::new(Config {
        bot_count: 0,
        ..test_config()
    });

    let mut a = Room::new_in_room(cfg.clone(), 0);
    let mut b = Room::new_in_room(cfg, 1);
    assert!(
        a.world().is_none() && b.world().is_none(),
        "§E1: a freshly built room is a lobby and holds no world"
    );

    let wa = a.generate_world();
    a.install_world(wa);
    let wb = b.generate_world();
    b.install_world(wb);

    let ha = a.world_for_test().map.mask.hash();
    let hb = b.world_for_test().map.mask.hash();
    assert_ne!(
        ha, hb,
        "two lobbies generated the same map at match start; the per-room seed was lost"
    );
}

/// The tick loop never generates.
///
/// `docs/71` §B2 measured generation at 0.3–1.1 s against a 16.7 ms tick, so
/// `tick_once` may only *ask* for a world. This is the assertion that keeps the
/// generator off the loop: after the start condition fires, the tick has
/// returned and there is still no world.
#[test]
fn the_tick_asks_for_a_world_and_does_not_build_one() {
    use game_core::constants::SIM_DT;
    use game_server::room::Room;
    let cfg = Arc::new(Config {
        bot_count: 0,
        ..test_config()
    });
    let mut room = Room::new_in_room(cfg, 0);

    room.request_start();
    let _ = room.tick_once(SIM_DT);

    assert!(
        room.wants_world(),
        "the start condition fired and the room did not ask for a world"
    );
    assert!(
        room.world().is_none(),
        "the tick built a map; §E1 keeps 0.3-1.1 s of generator off a 16.7 ms loop"
    );

    // The control: the same trio the room task runs does produce one, so
    // "no world" above is the tick declining rather than a room that cannot
    // start at all.
    let w = room.generate_world();
    room.install_world(w);
    assert!(
        room.world().is_some(),
        "installing a generated world left the room without one"
    );
    assert_eq!(
        room.phase(),
        game_core::world::RoundPhase::Warmup,
        "installing the world did not begin the round"
    );
}

/// A refused `set_scale` reaches the socket that sent it (§E6).
///
/// The command layer's refusal is tested in `lobby_state.rs`; what this asserts
/// is the half that a Rust-side test cannot see — that the reason **arrives**.
/// A silent no-op is indistinguishable from a lost message at the client, and
/// `join_error` could not carry it: `connection.ts` registers that handler
/// during the connect handshake behind `if (settled) return`, so a refusal sent
/// after seating is dropped before anything reads it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_set_scale_tells_the_sender_why() {
    let h = spawn_server().await;
    let addr = h.addr;

    let (owner_errs, other_errs, scale_after) = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = connect(addr, ia.clone());
        emit_until(
            &a,
            &ia,
            "quick_match",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );
        let ib: Inbox = Arc::default();
        let b = connect(addr, ib.clone());
        emit_until(
            &b,
            &ib,
            "quick_match",
            serde_json::json!({ "name": "bo" }),
            "welcome",
            "bo",
        );
        std::thread::sleep(Duration::from_millis(400));

        // bo is not the longest-seated human, so bo may not change the settings.
        b.emit("set_scale", serde_json::json!({ "scale": "large" }))
            .expect("emit");
        wait_for(
            &ib,
            "lobby_error",
            1,
            "bo is told why the change was refused",
        );
        std::thread::sleep(Duration::from_millis(400));

        // The control: ana is the owner, so ana's change is accepted — and
        // silently, with no error. Without it, "bo got an error" also passes for
        // a server that refuses everybody, which is a lobby nobody can set up.
        let owner_before = count(&ia, "lobby_error");
        a.emit("set_scale", serde_json::json!({ "scale": "large" }))
            .expect("emit");
        std::thread::sleep(Duration::from_millis(600));

        let out = (
            count(&ia, "lobby_error") - owner_before,
            count(&ib, "lobby_error"),
            last(&ia, "lobby_state", "scale"),
        );
        let _ = a.disconnect();
        let _ = b.disconnect();
        out
    })
    .await
    .expect("client thread");

    assert_eq!(
        other_errs, 1,
        "the refusal never reached the socket that sent it"
    );
    assert_eq!(
        owner_errs, 0,
        "the owner was refused their own settings change"
    );
    assert_eq!(
        scale_after, "large",
        "the owner's change was accepted but never announced"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}
