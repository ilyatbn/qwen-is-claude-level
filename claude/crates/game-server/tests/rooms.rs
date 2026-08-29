//! Two rooms in one process, and the wall between them.
//!
//! `docs/71-amendments-v3.md` §B1: *"A broadcast that reaches another game is the
//! multi-room equivalent of the inventory leak in `30-items-inventory.md` §6, and
//! is tested the same way: assert the negative."*
//!
//! The negative on its own is not enough — "client A received nothing from room
//! B" also passes for a server that delivers nothing at all. Every test here
//! carries its control.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use game_core::constants::MapScale;
use game_server::registry::{QuickMatch, RoomId};
use game_server::{app, config::Config, state::AppState};
use rust_socketio::{ClientBuilder, Payload, RawClient};

fn test_config() -> Config {
    Config {
        map_scale: MapScale::Small,
        // Bots would carve terrain on their own and make "did a carve cross
        // rooms" ambiguous.
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
    // Wait for the default room to be ticking, rather than sleeping a guess.
    // §E1: `join_info`, not `inspect` — a lobby has no world, so the world-shaped
    // read answers `None`, `unwrap_or(0)` reads 0 forever, and this loop stopped
    // waiting for anything at all. The lobby's own clock is the real signal and
    // it advances as soon as the room task runs (`docs/72` §C18-clarified).
    // §E2/§E4: created, **not started**. `quick_match` skips a started match, so
    // starting here put every joining client in a different room than the handle
    // these tests inspect. Tests that need a running match press start
    // themselves, after their clients are seated.
    let started = stack.room();
    for _ in 0..400 {
        if started.join_info().await.map(|i| i.tick).unwrap_or(0) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Harness { addr, stack }
}

/// Connect, and **wait for `open` before emitting anything**.
///
/// `rust_socketio`'s `connect()` returns once engine.io is up while the socket.io
/// namespace CONNECT is still in flight, so a `join` on the next line is dropped
/// with no error. That produced a 50 % flaky suite and cost a whole session
/// (`docs/70-amendments-v2.md` §A28). `socket.io-client` buffers emits until
/// connected; this one does not.
fn connect(addr: SocketAddr, inbox: Inbox) -> rust_socketio::client::Client {
    let events = [
        "welcome",
        "map_init",
        "carve",
        "player_join",
        "player_leave",
        "explosion",
        "join_error",
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

/// Block until `ev` has arrived `n` times. Blocking, because the socket.io
/// client here owns its own runtime and every use of it must be on a blocking
/// thread — dropping a runtime inside an async context panics.
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

/// The wall-clock budget every wait in this file gets.
const BUDGET_MS: u64 = 10_000;

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
        client.emit(ev, payload.clone()).expect("emit");
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

type Registry = Arc<std::sync::Mutex<game_server::registry::RoomRegistry>>;

fn live_sids(io: &socketioxide::SocketIo) -> std::collections::HashSet<socketioxide::socket::Sid> {
    io.sockets().into_iter().map(|s| s.id).collect()
}

/// Move the socket that appeared since `before` into another room.
///
/// T10.02 gives the client a message for this; T10.01's job is the wall itself,
/// so the test reaches into the registry rather than waiting for a protocol that
/// does not exist yet.
///
/// **By set difference, not by position.** The first version took `.last()` of
/// `io.sockets()` — and that collection has no defined order, so it picked the
/// wrong socket about a third of the time and seated the second client in the
/// first client's room. That is precisely the §A11 bug the registry is built to
/// avoid, reproduced in the helper written to test for it.
fn attach_new_socket(
    io: &socketioxide::SocketIo,
    reg: &Registry,
    before: &std::collections::HashSet<socketioxide::socket::Sid>,
    room: RoomId,
) -> bool {
    for _ in 0..100 {
        let now = live_sids(io);
        let mut fresh = now.difference(before);
        if let Some(sid) = fresh.next().copied() {
            assert!(
                fresh.next().is_none(),
                "more than one new socket; the test cannot tell them apart"
            );
            reg.lock().expect("registry").attach(sid, room);
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_rooms_run_side_by_side_and_neither_hears_the_other() {
    let h = spawn_server().await;
    let room_b = {
        let mut r = h.stack.registry.lock().expect("registry");
        r.create(MapScale::Small, false).expect("under the cap").0
    };
    let (addr, io, reg) = (h.addr, h.stack.io.clone(), h.stack.registry.clone());

    let out = tokio::task::spawn_blocking(move || {
        // A joins the default room.
        let inbox_a: Inbox = Arc::default();
        let a = connect(addr, inbox_a.clone());
        emit_until(
            &a,
            &inbox_a,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );

        // B connects, is moved into room_b, then joins.
        let before = live_sids(&io);
        let inbox_b: Inbox = Arc::default();
        let b = connect(addr, inbox_b.clone());
        assert!(
            attach_new_socket(&io, &reg, &before, room_b),
            "bo's socket never appeared"
        );
        emit_until(
            &b,
            &inbox_b,
            "join",
            serde_json::json!({ "name": "bo" }),
            "welcome",
            "bo",
        );

        // §E2: ana's room is not started either now — the harness creates it and
        // leaves it open so quick match can seat into it. Both rooms are started
        // by their own occupant, which is also what makes `a_maps`/`b_maps`
        // meaningful: each client's map comes from the room it is actually in.
        a.emit("start_with_bots", serde_json::json!({}))
            .expect("start ana's room");
        wait_for(&inbox_a, "map_init", 1, "ana's map once her room starts");

        // §E1: `room_b` was created straight in the registry and never started,
        // so it is a lobby and has no map to hand out — `b_maps` below is a
        // control that bo is properly seated, and it can only mean that if bo's
        // room is a match like ana's. Ask for one, the way ana's harness did.
        b.emit("start_with_bots", serde_json::json!({}))
            .expect("start_with_bots");
        wait_for(&inbox_b, "map_init", 1, "bo's map once room_b starts");

        // Give any cross-room leak time to arrive. Asserting a negative
        // immediately would pass simply because nothing had been delivered yet.
        std::thread::sleep(Duration::from_millis(500));

        let out = serde_json::json!({
            "a_maps": count(&inbox_a, "map_init"),
            "b_maps": count(&inbox_b, "map_init"),
            "a_joins": count(&inbox_a, "player_join"),
            "b_joins": count(&inbox_b, "player_join"),
            "a_id": first(&inbox_a, "welcome", "player_id"),
            "b_id": first(&inbox_b, "welcome", "player_id"),
            "a_seed": first(&inbox_a, "welcome", "seed"),
            "b_seed": first(&inbox_b, "welcome", "seed"),
        });
        let _ = a.disconnect();
        let _ = b.disconnect();
        out
    })
    .await
    .expect("blocking half");

    // --- the control -------------------------------------------------------
    // Both are seated and both received a map. Without this, every negative
    // below is satisfied by a server that never delivers anything.
    assert_eq!(out["a_maps"], 1, "ana never got a map");
    assert_eq!(out["b_maps"], 1, "bo never got a map");

    // --- the negative ------------------------------------------------------
    // `player_join` is broadcast to everyone in the room, so two players in two
    // rooms means neither saw the other arrive.
    assert_eq!(
        out["a_joins"], 0,
        "ana was told about a join in another room"
    );
    assert_eq!(
        out["b_joins"], 0,
        "bo was told about a join in another room"
    );

    // Separate worlds: each room seats its own player 0, and each rolled its own
    // seed.
    assert_eq!(out["a_id"], out["b_id"], "each room seats its own player 0");
    assert!(out["a_seed"].is_string() && out["b_seed"].is_string());

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// The control for the test above, and the falsification of the scoping itself:
/// **two clients in the same room must hear each other.**
///
/// Without this, "neither hears the other" also passes against a server whose
/// broadcast is broken entirely.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_clients_in_one_room_do_hear_each_other() {
    let h = spawn_server().await;
    let addr = h.addr;

    let joins = tokio::task::spawn_blocking(move || {
        let inbox_a: Inbox = Arc::default();
        let a = connect(addr, inbox_a.clone());
        emit_until(
            &a,
            &inbox_a,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );

        let inbox_b: Inbox = Arc::default();
        let b = connect(addr, inbox_b.clone());
        emit_until(
            &b,
            &inbox_b,
            "join",
            serde_json::json!({ "name": "bo" }),
            "welcome",
            "bo",
        );

        // ana was already seated, so ana hears bo arrive.
        wait_for(&inbox_a, "player_join", 1, "ana hears bo");
        let n = count(&inbox_a, "player_join");
        let _ = a.disconnect();
        let _ = b.disconnect();
        n
    })
    .await
    .expect("blocking half");

    assert_eq!(
        joins, 1,
        "same-room broadcast is broken, so the negative test proves nothing"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_private_code_admits_and_hostile_input_does_not() {
    let h = spawn_server().await;
    let (id, code) = {
        let mut r = h.stack.registry.lock().expect("registry");
        r.create(MapScale::Small, true).expect("under the cap")
    };
    let code = code.expect("private rooms get a code");

    {
        let r = h.stack.registry.lock().expect("registry");
        assert_eq!(r.by_code(&code), Some(id));
        assert_eq!(r.by_code(&code.to_lowercase()), Some(id), "case folded");
        assert_eq!(r.by_code("ZZZZZZ"), None);
        // Attacker-controlled text: it must miss, and it must not panic.
        for bad in [
            "",
            " ",
            &"A".repeat(5000),
            "../../etc/passwd",
            "\u{0}\u{0}",
            "%00",
        ] {
            assert_eq!(r.by_code(bad), None, "{bad:?} resolved to a room");
        }
    }

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// `/healthz` reported a hardcoded `1`, which stops being true the moment a
/// second room exists. It reads the registry's own gauge now.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn healthz_reports_the_real_room_count() {
    let h = spawn_server().await;
    let addr = h.addr;

    let read = |addr: SocketAddr| async move {
        let body = reqwest_get(addr, "/healthz").await;
        serde_json::from_str::<serde_json::Value>(&body).expect("healthz json")
    };

    assert_eq!(read(addr).await["rooms"], 1, "the default room");

    let extra: Vec<_> = {
        let mut r = h.stack.registry.lock().expect("registry");
        (0..3)
            .map(|_| r.create(MapScale::Small, false).expect("under cap").0)
            .collect()
    };
    assert_eq!(read(addr).await["rooms"], 4, "three more were created");

    {
        let mut r = h.stack.registry.lock().expect("registry");
        for id in extra {
            r.drop_room(id);
        }
    }
    assert_eq!(read(addr).await["rooms"], 1, "and dropped again");

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// §B2's fields must exist and must move, or an operator watching a multi-room
/// server is reading a number that cannot change.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn metrics_report_the_new_room_fields() {
    let h = spawn_server().await;
    let body = reqwest_get(h.addr, "/metrics").await;
    for field in [
        "rooms_active",
        "tick_p99_ms_max_over_rooms",
        "rooms_over_budget",
    ] {
        assert!(body.contains(field), "/metrics is missing {field}:\n{body}");
    }

    // rooms_active must track the registry, not a constant.
    let before = field_of(&body, "rooms_active");
    let ids: Vec<_> = {
        let mut r = h.stack.registry.lock().expect("registry");
        (0..2)
            .map(|_| r.create(MapScale::Small, false).expect("under cap").0)
            .collect()
    };
    let after = field_of(&reqwest_get(h.addr, "/metrics").await, "rooms_active");
    assert_eq!(after, before + 2.0, "rooms_active did not move");

    // And a dropped room stops being counted, or a room that no longer exists
    // is reported as over budget forever.
    {
        let mut r = h.stack.registry.lock().expect("registry");
        for id in ids {
            r.drop_room(id);
        }
    }
    let final_body = reqwest_get(h.addr, "/metrics").await;
    assert_eq!(field_of(&final_body, "rooms_active"), before);
    assert_eq!(
        field_of(&final_body, "rooms_over_budget"),
        0.0,
        "a healthy server reported rooms over budget:\n{final_body}"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

fn field_of(body: &str, name: &str) -> f64 {
    body.lines()
        .find_map(|l| l.strip_prefix(name).and_then(|v| v.trim().parse().ok()))
        .unwrap_or_else(|| panic!("{name} not in:\n{body}"))
}

/// Minimal HTTP GET, so the test reads what an operator would actually see
/// rather than calling the handler directly.
async fn reqwest_get(addr: SocketAddr, path: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let req = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.expect("write");
    let mut buf = String::new();
    s.read_to_string(&mut buf).await.expect("read");
    buf.split("\r\n\r\n").nth(1).unwrap_or_default().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quick_match_puts_two_players_in_the_same_room() {
    let h = spawn_server().await;
    {
        let mut r = h.stack.registry.lock().expect("registry");
        // The default room is public, small and empty, so the first match fills
        // it rather than creating another.
        let first = r.quick_match(MapScale::Small, 6);
        let QuickMatch::Existing(id) = first else {
            panic!("expected the empty default room to be filled, got {first:?}");
        };
        r.attach(socketioxide::socket::Sid::new(), id);

        assert_eq!(
            r.quick_match(MapScale::Small, 6),
            QuickMatch::Existing(id),
            "quick match split two players across rooms"
        );
    }
    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// A disconnect must return the seat **and** drop the socket out of the
/// registry, or the room's human count never reaches zero and it is never
/// reaped — a leak that only appears after a server has been up a while.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn leaving_frees_the_room_for_reaping() {
    let h = spawn_server().await;
    let (addr, reg, default_room) = (h.addr, h.stack.registry.clone(), h.stack.default_room());

    let seated = tokio::task::spawn_blocking(move || {
        let inbox: Inbox = Arc::default();
        let a = connect(addr, inbox.clone());
        emit_until(
            &a,
            &inbox,
            "join",
            serde_json::json!({ "name": "ana" }),
            "welcome",
            "ana",
        );
        let seated = reg
            .lock()
            .expect("registry")
            .get(default_room)
            .map(|e| e.humans());
        let _ = a.disconnect();
        seated
    })
    .await
    .expect("blocking half");

    assert_eq!(seated, Some(1), "the join did not register a human");

    for _ in 0..100 {
        let n = h
            .stack
            .registry
            .lock()
            .expect("registry")
            .get(default_room)
            .map(|e| e.humans());
        if n == Some(0) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    {
        let mut r = h.stack.registry.lock().expect("registry");
        assert_eq!(
            r.get(default_room).map(|e| e.humans()),
            Some(0),
            "the socket never left the registry, so the room can never be reaped"
        );
        let reaped = r.reap(std::time::Instant::now() + Duration::from_secs(3600));
        assert!(reaped.contains(&default_room), "reaped {reaped:?}");
    }

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

// ---------------------------------------------------------------------------
// T13.06.11 — the reaper has a caller
// ---------------------------------------------------------------------------

/// Build a server on a custom config, without starting a round in it.
///
/// `spawn_server` presses "Start with bots" and waits for a tick, which is the
/// wrong shape here: these tests are about a room's *life*, not its round, and
/// a `Lobby` room is the state the reaper actually meets in production.
async fn spawn_server_with(config: Config) -> Harness {
    let state = AppState::new(config);
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

async fn healthz_rooms(addr: SocketAddr) -> u64 {
    let body = reqwest_get(addr, "/healthz").await;
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("rooms").and_then(|r| r.as_u64()))
        .unwrap_or(u64::MAX)
}

/// The test that would have caught it.
///
/// `RoomRegistry::reap()` was correct, tested five ways, and **called by nothing
/// outside its own `#[cfg(test)]` module** — so a live server with zero players
/// held `rooms: 2` steady for forty seconds, and a long-running one eventually
/// hits `MAX_ROOMS` and cannot start a game at all. §A39, sixteenth instance.
///
/// So nothing here calls `reap`. A real client joins over a real socket and
/// leaves, and the assertion is what `/healthz` says afterwards — **a test that
/// calls the function is not a caller**, which is exactly how this shipped.
///
/// Two further things it insists on, both of which a weaker version would miss:
///
///  - `bot_count = 3`, so the room the reaper meets is full of bots. Bots do not
///    keep a room alive (§B1), and with `bot_count = 0` this passes against a
///    build that only reaps rooms nobody ever sat in.
///  - the room's **task** is gone, not just its registry entry. Dropping the
///    handle and leaving the 60 Hz task running is the same leak one layer down,
///    and `/healthz` cannot see it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_room_whose_last_human_left_is_reaped_by_the_running_server() {
    let mut cfg = test_config();
    // Bots, because "bots do not keep a room alive" is half of §B1 and the
    // other half is untestable without them.
    cfg.bot_count = 3;
    // The TTL is the deadline the sweep watches, not the thing under test. At
    // its 30 s default this test would sleep for half a minute to learn the
    // same fact; `docs/41` §5 is why it is configurable at all.
    cfg.room_empty_ttl = 1.0;
    let h = spawn_server_with(cfg).await;
    let addr = h.addr;

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
        std::thread::sleep(Duration::from_millis(600));
        // An explicit disconnect, not a drop: `drop` does not close the socket
        // promptly, so the server never sees the leave and this test would
        // report "the room was never reaped" for the wrong reason.
        let _ = a.disconnect();
    })
    .await
    .expect("client thread");

    // The control, and the handle, both taken while the room is still there.
    // Without the control, "rooms went to 0" also passes for a server that
    // never made one.
    let (room, handle, live) = {
        let r = h.stack.registry.lock().expect("registry");
        let id = *r.ids().first().expect("the join created a room");
        (id, r.get(id).expect("room").handle.clone(), r.ids().len())
    };
    // **The control reads the registry, under the lock it already holds.**
    //
    // It used to read `/healthz`, and that is a different representation of the
    // same fact: `registry.rs` `publish_count()` stores into an `AtomicUsize`
    // gauge the endpoint serves, so the two are updated at different moments and
    // compared across an HTTP round trip. Measured, this failed about one run in
    // eight under load and never when idle — a race by construction, and the
    // two-sources-of-truth shape this project has paid for repeatedly.
    //
    // The gauge is still what the *effect* is asserted on below, and correctly:
    // that assertion waits for it to converge rather than sampling it once.
    assert_eq!(live, 1, "control: the room is there");
    assert!(
        // §E1: liveness is `join_info` answering. `inspect` answers `None` for a
        // *living* lobby, so spelling the control that way asserts the room is
        // already dead — which is what this control exists to rule out.
        handle.join_info().await.is_some(),
        "control: the room task answers before the reap"
    );

    // The TTL plus a generous number of sweep intervals. Waited on the effect
    // rather than slept: under a loaded gate a fixed sleep measures the box
    // (§A28).
    let mut rooms = u64::MAX;
    for _ in 0..200 {
        rooms = healthz_rooms(addr).await;
        if rooms == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        rooms, 0,
        "room {room} outlived its TTL: nothing in the running server calls reap()"
    );

    // And the task is gone with it. `inspect` returns `None` once the room's
    // command channel is closed, which happens when the task ends.
    //
    // Polled, not asserted on the next line: `publish_count()` updates the gauge
    // synchronously inside `drop_room`, before the room task has been scheduled
    // to notice its shutdown. Asserting immediately makes this a race that
    // passes on an idle box and fails under `cargo test --workspace` — which is
    // T13.06.10's finding, and there is no reason to add a sixteenth instance.
    let mut stopped = false;
    for _ in 0..100 {
        if handle.join_info().await.is_none() {
            stopped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        stopped,
        "the registry forgot room {room} but its 60 Hz task is still running"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// The other half: a room somebody is **in** is never reaped.
///
/// Without this, "empty rooms disappear" is also satisfied by a sweep that drops
/// every room every two seconds, which would end a game in progress.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_room_with_a_human_in_it_is_never_reaped() {
    let mut cfg = test_config();
    cfg.bot_count = 3;
    cfg.room_empty_ttl = 0.5;
    let h = spawn_server_with(cfg).await;
    let addr = h.addr;

    // The client stays connected for the whole window. It runs on a blocking
    // thread and reports back only when the watch below has finished.
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
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
        let _ = done_rx.recv_timeout(Duration::from_secs(30));
        let _ = a.disconnect();
    });

    // Wait for the join to land BEFORE watching. The first version started its
    // minimum at the same instant it spawned the client, so it sampled the
    // server during the socket.io handshake, recorded `rooms: 0` and reported
    // that the sweep had dropped an occupied room. The room has to exist before
    // "it was never reaped" means anything.
    let mut seated = false;
    for _ in 0..200 {
        if healthz_rooms(addr).await >= 1 {
            seated = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        seated,
        "the client never joined, so nothing here is a control"
    );

    // Long enough for several TTLs and several sweeps: the point is that no
    // number of sweeps removes an occupied room.
    let watched = Duration::from_secs(4);
    let started = std::time::Instant::now();
    let mut lowest = u64::MAX;
    while started.elapsed() < watched {
        lowest = lowest.min(healthz_rooms(addr).await);
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let _ = done_tx.send(());
    client.await.expect("client thread");

    assert_eq!(
        lowest, 1,
        "the sweep dropped a room with a player in it (lowest room count seen: {lowest})"
    );

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}
