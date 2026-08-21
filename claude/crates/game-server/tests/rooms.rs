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
    // §C18: a room waits in `Lobby`, so there is no tick until a round starts.
    // This presses "Start with bots" once, the way a player does.
    let started = stack.start_default_room();
    for _ in 0..200 {
        if started.inspect(|w| w.tick).await.unwrap_or(0) > 0 {
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
    for _ in 0..200 {
        if count(inbox, ev) >= n {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "{label}: waited 10 s for {n} `{ev}`, saw {}",
        count(inbox, ev)
    );
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
        a.emit("join", serde_json::json!({ "name": "ana" }))
            .expect("emit join");
        wait_for(&inbox_a, "welcome", 1, "ana");

        // B connects, is moved into room_b, then joins.
        let before = live_sids(&io);
        let inbox_b: Inbox = Arc::default();
        let b = connect(addr, inbox_b.clone());
        assert!(
            attach_new_socket(&io, &reg, &before, room_b),
            "bo's socket never appeared"
        );
        b.emit("join", serde_json::json!({ "name": "bo" }))
            .expect("emit join");
        wait_for(&inbox_b, "welcome", 1, "bo");

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
        a.emit("join", serde_json::json!({ "name": "ana" }))
            .expect("emit join");
        wait_for(&inbox_a, "welcome", 1, "ana");

        let inbox_b: Inbox = Arc::default();
        let b = connect(addr, inbox_b.clone());
        b.emit("join", serde_json::json!({ "name": "bo" }))
            .expect("emit join");
        wait_for(&inbox_b, "welcome", 1, "bo");

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
        a.emit("join", serde_json::json!({ "name": "ana" }))
            .expect("emit join");
        wait_for(&inbox, "welcome", 1, "ana");
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
