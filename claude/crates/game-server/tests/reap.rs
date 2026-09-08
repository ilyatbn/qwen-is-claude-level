//! Lobbies and matches die when their humans leave (`docs/74-amendments-v6.md` §E5).
//!
//! **The rule is already true and this file asserts it rather than adding it.**
//! `RoomEntry.humans` has three writers — initialised to 0, `+= 1` in `attach`,
//! `saturating_sub(1)` in `detach_from` — and both are keyed on **socket id**.
//! A bot has no socket, so it can never enter the count. Adding a bot-filtering
//! rule to the registry would create a *second* source of truth for occupancy,
//! which is the drift this milestone has already paid for three times.
//!
//! `Room::human_count()` is a different count answering a different question
//! (the start rule). Two counts for two questions is fine; a third that
//! conflated them would not be.
//!
//! Everything here drives the **running server**, not `reap()` directly:
//! T13.06.11 is a commit in this repo named for the time the reaper had no
//! caller, and a test calling it would not have noticed.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use game_core::constants::MapScale;
use game_server::{app, config::Config, state::AppState};

mod common;
use common::Inbox;

/// Short enough that the live loop takes the room inside a test's patience.
/// `ROOM_REAP_INTERVAL` is the resolution, so a room lives for at most
/// `ttl + interval`.
const TTL_S: f32 = 1.0;

struct Harness {
    addr: SocketAddr,
    stack: app::Stack,
}

fn cfg(bots: usize, max_players: usize) -> Config {
    Config {
        map_scale: MapScale::Small,
        bot_count: bots,
        max_players,
        room_empty_ttl: TTL_S,
        ..Config::default()
    }
}

async fn spawn_server(config: Config) -> Harness {
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

/// What this suite listens for. The connect itself is `tests/common` (T20.18) —
/// seven files had a copy of it and only their event lists differed.
const EVENTS: &[&str] = &["welcome", "map_init", "room_created", "join_error"];

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

fn wait_for(inbox: &Inbox, ev: &str, n: usize, label: &str) {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
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

/// Wait for a room's human count to reach `want`.
///
/// **Waited on, not asserted at a moment.** A socket.io disconnect is not
/// synchronous with dropping the client: the server notices when its transport
/// does, which is milliseconds later and load-dependent. Asserting immediately
/// reads the count before the event that changes it — the same "quiet is not
/// finished" shape the checksum fixture was repaired for.
fn wait_for_humans(
    reg: &Arc<Mutex<game_server::registry::RoomRegistry>>,
    room: u32,
    want: usize,
    label: &str,
) {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        let now = reg.lock().expect("registry").get(room).map(|e| e.humans());
        if now == Some(want) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let now = reg.lock().expect("registry").get(room).map(|e| e.humans());
    panic!("{label}: room {room} still reads {now:?} humans, wanted {want}");
}

/// Host a private room, start it with bots, and return `(room_id, client)`.
fn host_and_start(addr: SocketAddr, name: &str) -> (u32, rust_socketio::client::Client) {
    let inbox: Inbox = Arc::default();
    // T19.26: `create_room` cannot be re-sent, so this retries only a *refused*
    // send — see `common::connect_and_emit`.
    let c = common::connect_and_emit(
        addr,
        EVENTS,
        &inbox,
        "create_room",
        serde_json::json!({ "name": name, "scale": "small" }),
    );
    wait_for(&inbox, "room_created", 1, name);
    let room_id = last(&inbox, "room_created", "room_id")
        .as_u64()
        .expect("a room id") as u32;
    c.emit("ready", serde_json::json!({})).expect("emit");
    c.emit("start_with_bots", serde_json::json!({}))
        .expect("emit");
    // The match is running when the map arrives (§E1).
    wait_for(&inbox, "map_init", 1, name);
    (room_id, c)
}

/// Bots do not hold a room open, and a human does.
///
/// **Both halves on one server, in one reaper pass.** "The abandoned room went"
/// on its own also passes for a reaper that takes everything; "the occupied room
/// stayed" on its own passes for a reaper that never runs. Only the pair says
/// the rule is about humans.
///
/// This is also what makes bot-only testing work rather than what breaks it: the
/// tester's own client is the human holding the room open, so five bots fight
/// for exactly as long as somebody is watching.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_room_whose_last_human_left_is_reaped_by_the_running_server() {
    let h = spawn_server(cfg(3, 6)).await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    let (abandoned, occupied, keeper) = tokio::task::spawn_blocking(move || {
        let (abandoned, leaver) = host_and_start(addr, "ana");
        let (occupied, keeper) = host_and_start(addr, "bo");
        // ana walks away; bo stays. `disconnect()` rather than `drop`: the
        // client's Drop does not guarantee the transport closes, and this test
        // is about what the *server* sees.
        let _ = leaver.disconnect();
        (abandoned, occupied, keeper)
    })
    .await
    .expect("blocking");

    // Both rooms are full of bots. Only one has a human.
    wait_for_humans(
        &reg,
        abandoned,
        0,
        "ana's disconnect was never seen, so the reap below would prove nothing",
    );
    let handle = {
        let r = reg.lock().expect("registry");
        assert_eq!(
            r.get(occupied).map(|e| e.humans()),
            Some(1),
            "bo is not counted as an occupant, so the control below is vacuous"
        );
        r.get(abandoned).map(|e| e.handle.clone())
    }
    .expect("the abandoned room was reaped before its human count was read");

    // The **live** reaper takes it — nothing here calls `reap`.
    let deadline = std::time::Instant::now()
        + Duration::from_secs_f32(TTL_S + game_core::constants::ROOM_REAP_INTERVAL + 5.0);
    let mut gone = false;
    while std::time::Instant::now() < deadline {
        if reg.lock().expect("registry").get(abandoned).is_none() {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        gone,
        "a room with three bots and no humans outlived its TTL: the reaper is \
         counting seats rather than humans, or it has no caller"
    );

    // The control, in the same pass: bo's room is untouched.
    assert!(
        reg.lock().expect("registry").get(occupied).is_some(),
        "the reaper took a room that still had a human in it"
    );

    // **Observably stopped, not merely deregistered.** `drop_room` sends on the
    // shutdown channel with `let _ =`, so a discarded error would leave the task
    // ticking while the registry has forgotten it — a room nobody can reach and
    // nothing can stop, which is worse than one that was never reaped.
    //
    // Asserted on the **clock**, not on `inspect`: `inspect` answers `None` for a
    // room with no world too (§E1), so it cannot tell a stopped task from a
    // lobby. A tick that stops advancing means one thing.
    //
    // **To falsify this, `std::mem::forget` the shutdown sender in
    // `RoomRegistry::drop_room` — do not delete the `let _ = tx.send(())`.**
    // Deleting the send leaves all three tests green and proves nothing: the
    // sender is dropped as the entry is destroyed, and a dropped `oneshot`
    // sender resolves its receiver just as a send does, so the room still
    // stops. Forgetting it is the only way to keep the task genuinely alive,
    // and it fails here with `Some(353) -> Some(384)`.
    let first = handle.join_info().await.map(|i| i.tick);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let second = handle.join_info().await.map(|i| i.tick);
    assert!(
        second.is_none() || second == first,
        "the room was dropped from the registry and its clock is still running \
         ({first:?} -> {second:?}): it is ticking where nothing can reach it"
    );

    drop(keeper);
    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// A lobby nobody is in dies too — §E5 is one rule, not two.
///
/// The match-start path is the one above; this is the same rule before a world
/// exists at all, which is the case §E1 created.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_abandoned_lobby_is_reaped_before_it_ever_starts() {
    let h = spawn_server(cfg(0, 6)).await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    let room_id = tokio::task::spawn_blocking(move || {
        let inbox: Inbox = Arc::default();
        let c = common::connect_and_emit(
            addr,
            EVENTS,
            &inbox,
            "create_room",
            serde_json::json!({ "name": "ana", "scale": "small" }),
        );
        wait_for(&inbox, "room_created", 1, "ana");
        let id = last(&inbox, "room_created", "room_id")
            .as_u64()
            .expect("a room id") as u32;
        // Never readied, never started: this room has no world at all.
        let _ = c.disconnect();
        id
    })
    .await
    .expect("blocking");

    let deadline = std::time::Instant::now()
        + Duration::from_secs_f32(TTL_S + game_core::constants::ROOM_REAP_INTERVAL + 5.0);
    let mut gone = false;
    while std::time::Instant::now() < deadline {
        if reg.lock().expect("registry").get(room_id).is_none() {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(gone, "an empty lobby was never reaped");

    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// A `full` refusal leaves no phantom occupant.
///
/// The last of T17.05's three detaches to be proven. `bad_name` and
/// `in_progress` refuse *before* `room.join`; `full` refuses in its `else`,
/// **after** the allocator, which is the position where a future edit most
/// easily reorders it back into a leak.
///
/// It belongs in this file because a phantom occupant is exactly a room that can
/// never be reaped — the subject of §E5 — and the assertion is on the
/// **registry**, not the wire. Asserting only that `full` came back is what let
/// this leak through in the first place.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_refusal_does_not_leave_a_phantom_occupant() {
    // One seat, so the second human fills nothing and is refused.
    let h = spawn_server(cfg(0, 1)).await;
    let addr = h.addr;
    let reg = h.stack.registry.clone();

    let (room_id, keeper) = tokio::task::spawn_blocking(move || {
        let ia: Inbox = Arc::default();
        let a = common::connect_and_emit(
            addr,
            EVENTS,
            &ia,
            "create_room",
            serde_json::json!({ "name": "ana", "scale": "small" }),
        );
        wait_for(&ia, "room_created", 1, "ana");
        let code = last(&ia, "room_created", "code")
            .as_str()
            .expect("a code")
            .to_string();
        let room_id = last(&ia, "room_created", "room_id")
            .as_u64()
            .expect("a room id") as u32;

        let ib: Inbox = Arc::default();
        let b = common::connect_and_emit(
            addr,
            EVENTS,
            &ib,
            "join_room",
            serde_json::json!({ "name": "bo", "code": code }),
        );
        wait_for(&ib, "join_error", 1, "bo");
        assert_eq!(
            last(&ib, "join_error", "reason").as_str(),
            Some("full"),
            "the refusal was for the wrong reason, so the count below is not \
             measuring the `full` path"
        );
        std::thread::sleep(Duration::from_millis(300));
        // **`forget`, not `drop`.** The refused client's socket has to stay open
        // until the registry is read: closing it triggers the disconnect
        // handler, which detaches and decrements — masking the very leak this
        // test exists to catch, and turning a real phantom occupant into a
        // green run. It looks like an oversight and is load-bearing.
        std::mem::forget(b);
        (room_id, a)
    })
    .await
    .expect("blocking");

    assert_eq!(
        reg.lock()
            .expect("registry")
            .get(room_id)
            .map(|e| e.humans()),
        Some(1),
        "a join refused as `full` is still counted as an occupant: it consumes \
         capacity and holds the room against the reaper forever"
    );

    drop(keeper);
    h.stack.shutdown_all(Duration::from_secs(2)).await;
}

/// **A refresh at the wrong half-second must not burn a room** (T20.23).
///
/// A socket that drops while `seat` is awaiting `room.join` used to leave
/// `RoomEntry::humans` at 1 for the life of the process: `on_disconnect`
/// resolved the socket through `sessions.remove_sid`, which had not been
/// written yet, so it freed nothing. A room whose `humans` never reaches zero
/// never gets an `empty_since`, and `registry.rs::reap` filters on that field —
/// so each one is permanent lost capacity against `MAX_ROOMS`, which is 32.
///
/// **Both arms on one server, in one test.** "The ghost's room reached zero"
/// alone is satisfied by a server that seats nobody; the control is the same
/// client sending the same verb and disconnecting *after* its `welcome`.
///
/// The subject is the drop taken straight after the emit, with no wait: that is
/// what a refresh is, and `room.join` is a command round-trip through a task
/// ticking at `SIM_HZ`, so the drop lands inside it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_socket_that_drops_before_it_is_seated_does_not_burn_the_room() {
    let h = spawn_server(cfg(0, 6)).await;
    let addr = h.addr;

    // The control arm.
    let control = tokio::task::spawn_blocking(move || {
        let inbox: Inbox = Arc::default();
        // **The control arm, and the one T19.26 caught.** It lost a race with its
        // own connection under a loaded gate — `AlreadyClosed` on a socket that
        // had just reported `open`. It still proves exactly what it proved
        // before: a normal join succeeding, asserted by the `wait_for` below.
        let c = common::connect_and_emit(
            addr,
            EVENTS,
            &inbox,
            "create_room",
            serde_json::json!({ "name": "ana", "private": true }),
        );
        wait_for(&inbox, "welcome", 1, "ana");
        let id = last(&inbox, "room_created", "room_id")
            .as_u64()
            .expect("a room id") as u32;
        let _ = c.disconnect();
        id
    })
    .await
    .expect("blocking half");
    wait_until_free(&h.stack.registry, control, "the control's room");

    let before = room_ids(&h.stack.registry);

    // The subject.
    tokio::task::spawn_blocking(move || {
        let inbox: Inbox = Arc::default();
        let g = common::connect_and_emit(
            addr,
            EVENTS,
            &inbox,
            "create_room",
            serde_json::json!({ "name": "ghost", "private": true }),
        );
        // No wait. This is the whole fixture.
        let _ = g.disconnect();
    })
    .await
    .expect("blocking half");

    let ghost = wait_for_a_new_room(&h.stack.registry, &before);
    wait_until_free(&h.stack.registry, ghost, "the ghost's room");

    // **Both ends, because the registry and the room are two counts of one
    // fact.** They agreed at 1 while this was broken — which is why the
    // discriminating assertion is that they both reach *zero*, not that they
    // match each other.
    let handle = h
        .stack
        .registry
        .lock()
        .expect("registry")
        .get(ghost)
        .map(|e| e.handle.clone());
    if let Some(handle) = handle {
        let roster = handle.roster().await.unwrap_or_default();
        assert!(
            roster.is_empty(),
            "the ghost's room still seats {roster:?} — the registry let go of the \
             socket and the room did not"
        );
    }
}

/// Every room the registry currently knows.
fn room_ids(reg: &Arc<Mutex<game_server::registry::RoomRegistry>>) -> Vec<u32> {
    reg.lock().expect("registry").ids().to_vec()
}

/// The one room that appeared since `before`, waited for rather than sampled:
/// `create_room` is served by the server after the client has already gone.
fn wait_for_a_new_room(
    reg: &Arc<Mutex<game_server::registry::RoomRegistry>>,
    before: &[u32],
) -> u32 {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        if let Some(id) = room_ids(reg).into_iter().find(|id| !before.contains(id)) {
            return id;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("no room was created for the dropped socket; before = {before:?}");
}

/// Wait until a room holds no humans **or has already been reaped**.
///
/// Reaped counts, and this is not a weakening: `room_empty_ttl` is `TTL_S` here,
/// so a room that reaches zero is taken within a second or two, and a test that
/// insisted on reading `Some(0)` would race the reaper it is trying to prove
/// works. The failure this guards against is the opposite one — a room that
/// stays at 1 forever and is therefore never eligible at all.
fn wait_until_free(reg: &Arc<Mutex<game_server::registry::RoomRegistry>>, room: u32, label: &str) {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        match reg.lock().expect("registry").get(room).map(|e| e.humans()) {
            None | Some(0) => return,
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let now = reg.lock().expect("registry").get(room).map(|e| e.humans());
    panic!(
        "{label}: room {room} still reads {now:?} humans after 15 s, so it has no \
         `empty_since` and `reap` can never take it"
    );
}
