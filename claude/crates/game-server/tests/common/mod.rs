//! The fixture the `game-server` integration binaries share (T20.18).
//!
//! **Seven copies of `connect` and eight of `test_config`.** T20.10 needed one
//! behaviour change in one of them and had to choose between fixing one copy and
//! fixing seven; this module is so the next fix lands once.
//!
//! **The seven `connect` copies had not drifted.** Checked before merging: the
//! four that take an `Inbox` (`in_progress`, `lobby`, `reap`, `rooms`) are
//! byte-identical apart from their event lists, and the three that also announce
//! each arrival on an `mpsc` channel (`checksum`, `integration`, `join`) are
//! identical apart from whitespace. All seven declare the same `Inbox` type and
//! the same payload decode, so no behaviour had to win — the only real difference
//! is whether the caller wants the channel, and that is now a second entry point
//! over the same core rather than a second copy.
//!
//! **What is deliberately NOT here: `BUDGET_MS`.** Three files declare a wait
//! budget and all three were exactly a shipped constant — see T20.20's D-58
//! entry. A seed's job is to be identical everywhere; a budget's job is to be
//! *unlike* the boundary it waits on, so one shared literal would have
//! centralised the second problem while fixing the first. `budget_past` is the
//! shared *rule*; each file still states its own boundaries.
#![allow(dead_code)] // each test binary uses a subset

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use game_core::constants::MapScale;
use game_server::config::Config;
use rust_socketio::{ClientBuilder, Payload, RawClient};

/// Every event a client received, newest last, keyed by event name.
pub type Inbox = Arc<Mutex<HashMap<String, Vec<serde_json::Value>>>>;

/// **The map these fixtures run on, stated rather than inherited** (T20.20).
///
/// All eight copies of `test_config` reached `fixed_seed: None` through
/// `..Config::default()`, so the map layout — and therefore where a player
/// spawns and whether there is anywhere to walk — was re-rolled on every run.
/// That is what put `commands_sent_between_ticks_are_all_applied` on D-58's
/// flaky list for a milestone: on a seed that spawns against a wall, holding a
/// direction is a no-op by construction.
///
/// The same value `replay.rs` has pinned since M13. Those two files pin their
/// seeds inline at the call site and define no `test_config` at all, which is
/// exactly why they never needed one and never went flaky.
pub const TEST_SEED: u64 = 4242;

/// The two settings every integration fixture agreed on, and the one none of
/// them stated.
///
/// **Only these two.** `bot_count` and `dev_loadout` stay with the caller: three
/// files deliberately leave `bot_count` at its default and one sets it to 1, so
/// a shared value here would change three suites while claiming to consolidate
/// them. Spread over it — `Config { bot_count: 0, ..common::test_config() }`.
pub fn test_config() -> Config {
    Config {
        map_scale: MapScale::Small,
        fixed_seed: Some(TEST_SEED),
        ..Config::default()
    }
}

/// **The guard the consolidation needs, because the grep that used to do it can
/// no longer see through the delegation** (T20.18).
///
/// T20.18's gate counted the string `fixed_seed` inside each `test_config`
/// body — which was the right instrument for eight independent copies and reads
/// **zero for all eight** once they spread over this module instead. A criterion
/// that a task's own deliverable makes unsatisfiable has to be replaced by one
/// that reads the value rather than the source, and this reads the value.
///
/// Each file calls it on **its own** `test_config`, not on this one: the point
/// is that the seed survives whatever the caller spreads over the base, and a
/// file that goes back to `..Config::default()` fails here rather than going
/// quietly flaky a milestone later.
pub fn assert_seed_is_stated(cfg: &Config) {
    assert!(
        cfg.fixed_seed.is_some(),
        "this fixture reached `fixed_seed: None`, so its map — and therefore \
         where a player spawns and whether there is anywhere to walk — is \
         re-rolled on every run. Spread over `common::test_config()`, not over \
         `Config::default()`. See T20.20's D-58 entry for the bill."
    );
}

/// Headroom over the longest boundary a wait has to outlast.
///
/// Added rather than multiplied: a multiplier makes the budget move with the
/// constant, which is how one of these landed exactly on a boundary in the first
/// place.
pub const BUDGET_MARGIN_S: f32 = 7.0;

/// A wall-clock budget that outlasts every boundary it names and **equals none
/// of them**.
///
/// `rooms.rs::BUDGET_MS` was `10_000` while `LOBBY_BOT_TIMEOUT` and
/// `WARMUP_SECONDS` are both `10.0`, and `lobby.rs`/`in_progress.rs` were
/// `30_000` against `READY_TIMEOUT_SECS` and `ROOM_EMPTY_TTL` at `30.0`. A wait
/// that ran its budget out therefore gave up on precisely the tick the room it
/// was watching changed state under it.
///
/// T20.20 measured that this was **not** what failed them — 277 waits over 13
/// full-suite runs, the worst using 17 % of its budget — so this is a
/// readability and robustness fix, not a bug fix. Deriving it also retires the
/// separate hazard: a budget typed as a literal expires the day the boundary it
/// was chosen against is retuned upwards.
pub fn budget_past(boundaries: &[f32]) -> u64 {
    let longest = boundaries.iter().copied().fold(0.0f32, f32::max);
    ((longest + BUDGET_MARGIN_S) * 1000.0) as u64
}

/// One socket.io payload as JSON, however the transport delivered it.
pub fn text_of(payload: Payload) -> serde_json::Value {
    match payload {
        Payload::Text(v) => v.first().cloned().unwrap_or(serde_json::Value::Null),
        #[allow(deprecated)]
        Payload::String(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::String(s)),
        Payload::Binary(b) => serde_json::json!({ "binary_len": b.len() }),
    }
}

/// A builder pointed at a running server, before any subscription.
///
/// Exposed separately from `connect` so a caller that needs one handler of its
/// own — `integration.rs` decodes snapshots — extends this rather than keeping a
/// second copy of the whole function.
pub fn builder(addr: SocketAddr) -> ClientBuilder {
    ClientBuilder::new(format!("http://{addr}")).namespace("/")
}

/// File `events` into `inbox`, and announce each arrival by name on `tx` if one
/// is given.
pub fn subscribe(
    mut b: ClientBuilder,
    events: &[&'static str],
    inbox: &Inbox,
    tx: Option<mpsc::Sender<String>>,
) -> ClientBuilder {
    for ev in events {
        let inbox = inbox.clone();
        let tx = tx.clone();
        let name = (*ev).to_string();
        b = b.on(*ev, move |payload: Payload, _: RawClient| {
            let v = text_of(payload);
            if let Ok(mut g) = inbox.lock() {
                g.entry(name.clone()).or_default().push(v);
            }
            if let Some(tx) = &tx {
                let _ = tx.send(name.clone());
            }
        });
    }
    b
}

static NEXT_CLIENT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// T22.00E instrument: `SOCKET_TRACE=1` prints the server's engine.io / socket.io tracing into the test's
/// captured output (shown only for a failing test).
fn trace_init() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if std::env::var("SOCKET_TRACE").is_ok() {
            let _ = tracing_subscriber::fmt()
                .with_test_writer()
                .with_env_filter("engineioxide=trace,socketioxide=debug,game=debug")
                .try_init();
        }
    });
}

/// How long a client is given to report `open` before the fixture gives up.
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);

/// How many fresh sessions `open` tries before it gives up. Each failed attempt is a session the server
/// closed at its first heartbeat (below); measured at 3 in 1 920 connects on a loaded box, so two in a row
/// is already about one in 400 000 and five is a server that is really refusing.
const OPEN_ATTEMPTS: usize = 5;

/// Connect, and return only a session that has **answered a round trip**.
///
/// Two waits, each for a failure measured here:
///
/// 1. **`open`** — `rust_socketio`'s `connect()` returns once engine.io is up while the socket.io
///    namespace CONNECT is still in flight, so an emit on the next line was dropped with no error (a
///    50 % flaky suite, `docs/70-amendments-v2.md` §A28). `socket.io-client` buffers emits until
///    connected; this one does not.
/// 2. **A `ping_rtt` → `pong_rtt` echo** (T22.00E) — the R40 socket-flake family (`tasks/flaky-test.md`).
///    `rust_engineio` 0.6 sends an unsolicited Pong the moment it connects *and* answers the server's
///    first Ping (sent at t = 0) with another; `engineioxide` 0.17 queues pongs in a channel of
///    **capacity one** and treats a full channel as `HeartbeatTimeout`. When the server's heartbeat
///    task has not taken the first pong before the second arrives — a loaded box — it closes the
///    session in the same millisecond as the CONNECT (traced: `error when handling packet:
///    HeartbeatTimeout`, `close_session{reason=HeartbeatTimeout}`). The test then emitted into a closed
///    socket (`AlreadyClosed`, `SendAfterClosing`), or its event was dropped (`cannot find socketio
///    socket`) and `rust_socketio` silently reconnected a fresh, unjoined session (`saw []`, an empty
///    inbox). The shipping browser client sends no unsolicited Pong, so this is the test client's,
///    not the game's. Both pongs are on the wire before `open` fires (the client handles the Ping
///    before the CONNECT ack that follows it), and the server reads our echo after them — so an
///    answered echo is a session that survived; an unanswered one is replaced by a fresh session
///    before the test has sent anything. `reconnect(false)`: a session that dies later fails loudly
///    instead of being swapped for an empty one.
///
/// `open` owns `pong_rtt` on the builder it is given (a caller subscribing to it would be overwritten).
///
/// **`make` builds a fresh builder per attempt.** A `ClientBuilder`'s callbacks live behind an `Arc`
/// its clones share, so a retry off a clone re-registered this attempt's `close` on the dead
/// session's map too, and the dead one's late close ended the live one's wait (measured in
/// `open_replaces_a_session_closed_at_connect`: every attempt after the first "closed" in 1.4 ms).
pub fn open(make: impl Fn() -> ClientBuilder) -> rust_socketio::client::Client {
    trace_init();
    let mut last = String::new();
    for attempt in 1..=OPEN_ATTEMPTS {
        let id = NEXT_CLIENT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let t0 = Instant::now();
        let (open_tx, open_rx) = mpsc::channel::<()>();
        let (pong_tx, pong_rx) = mpsc::channel::<serde_json::Value>();
        // A close of this session ends the wait for its echo at once.
        let (dead_tx, dead_rx) = mpsc::channel::<()>();
        let client = make()
            .reconnect(false)
            .on("open", move |_: Payload, _: RawClient| {
                let _ = open_tx.send(());
            })
            .on("pong_rtt", move |p: Payload, _: RawClient| {
                let _ = pong_tx.send(text_of(p));
            })
            .on("error", move |p: Payload, _: RawClient| {
                // Not a death signal: `rust_engineio` reports benign errors while it connects.
                println!("[socket#{id} +{:?}] error: {}", t0.elapsed(), text_of(p));
            })
            .on("close", move |_: Payload, _: RawClient| {
                println!("[socket#{id} +{:?}] close", t0.elapsed());
                let _ = dead_tx.send(());
            })
            .connect()
            .expect("socket.io connect");
        // A session closed before its CONNECT was read is never acked — inferred to be the same close one
        // step earlier, not traced
        // (measured: `socket.io never reported open` once in 240 runs once the echo was in). Retried
        // like the rest — nothing has been sent on it.
        if open_rx.recv_timeout(OPEN_TIMEOUT).is_err() {
            let e = format!("no `open` in {}s", OPEN_TIMEOUT.as_secs());
            println!(
                "OPEN_RETRY socket#{id} attempt {attempt}: session did not survive connect: {e}"
            );
            last = e;
            let _ = client.disconnect();
            continue;
        }
        let nonce = serde_json::json!(format!("open#{id}"));
        let echoed = match emit_ready(&client, "ping_rtt", &nonce) {
            Err(e) => Err(format!("the echo could not be sent: {e}")),
            Ok(()) => {
                let deadline = Instant::now() + OPEN_TIMEOUT;
                loop {
                    if dead_rx.try_recv().is_ok() {
                        break Err("the session closed before the echo came back".to_string());
                    }
                    match pong_rx.recv_timeout(Duration::from_millis(20)) {
                        Ok(v) if v == nonce => break Ok(()),
                        Ok(_) => continue,
                        Err(_) if Instant::now() >= deadline => {
                            break Err(format!("no echo in {}s", OPEN_TIMEOUT.as_secs()))
                        }
                        Err(_) => continue,
                    }
                }
            }
        };
        match echoed {
            Ok(()) => return client,
            Err(e) => {
                // Printed, not silent: `--nocapture` counts how often the fixture had to do this.
                println!("OPEN_RETRY socket#{id} attempt {attempt}: session did not survive connect: {e}");
                last = e;
                let _ = client.disconnect();
            }
        }
    }
    panic!("no socket.io session survived its connect in {OPEN_ATTEMPTS} attempts; last: {last}");
}

/// `emit`, waiting out only the client's own not-yet-sendable window, and returning any other error.
#[allow(clippy::result_large_err)] // rust_socketio's own error type
fn emit_ready(
    c: &rust_socketio::client::Client,
    ev: &str,
    payload: &serde_json::Value,
) -> Result<(), rust_socketio::Error> {
    let deadline = Instant::now() + EMIT_READY_WINDOW;
    loop {
        match c.emit(ev, payload.clone()) {
            Err(rust_socketio::Error::IllegalActionBeforeOpen()) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            r => return r,
        }
    }
}

/// The shape four files had a copy of: subscribe into an inbox the caller owns.
pub fn connect(
    addr: SocketAddr,
    events: &[&'static str],
    inbox: &Inbox,
) -> rust_socketio::client::Client {
    open(|| subscribe(builder(addr), events, inbox, None))
}

/// The shape the other three had: the inbox plus a channel that names each
/// arrival, so a test can wait on the *next* event rather than poll a count.
pub fn connect_watching(
    addr: SocketAddr,
    events: &[&'static str],
) -> (rust_socketio::client::Client, Inbox, mpsc::Receiver<String>) {
    let inbox: Inbox = Arc::default();
    let (tx, rx) = mpsc::channel::<String>();
    let client = open(|| subscribe(builder(addr), events, &inbox, Some(tx.clone())));
    (client, inbox, rx)
}

/// How long `emit_when_ready` will wait for a client that reported `open` to
/// become sendable. Generous, because it only elapses when something is wrong.
const EMIT_READY_WINDOW: Duration = Duration::from_secs(5);

/// Emit, waiting out the window in which the client is open but not yet
/// sendable.
///
/// `open` blocks on the namespace handshake, which is §A28's fix and is still
/// necessary — **but it is not sufficient under load.** The `open` callback is
/// dispatched from the poll thread, and for a few milliseconds after it `emit`
/// still returns `IllegalActionBeforeOpen`. Measured by T20.10: 8/8 passes on an
/// idle box in isolation, and one failure inside a full `cargo test --workspace`
/// — `a_client_flooding_inputs…` panicked with `emit join:
/// IllegalActionBeforeOpen`.
///
/// **Only that error is retried** (T20.18). T20.10's version retried any `Err`,
/// which weakened nothing — `wait_for` keeps its own deadline — but cost a
/// genuinely refused emit five seconds before it said so, and reported it as the
/// last error rather than the first. This is the one error the window exists
/// for; anything else is a fault and is raised at once.
pub fn emit_when_ready(c: &rust_socketio::client::Client, ev: &str, payload: serde_json::Value) {
    let deadline = Instant::now() + EMIT_READY_WINDOW;
    loop {
        match c.emit(ev, payload.clone()) {
            Ok(()) => return,
            Err(rust_socketio::Error::IllegalActionBeforeOpen()) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => panic!("emit {ev}: {e}"),
        }
    }
}

/// Connect, then send a verb that **must not be sent twice** — retrying the
/// connection only when the send is *refused*.
///
/// **`emit_until` cannot serve this window and says so itself.**
/// `rooms.rs::emit_until` re-emits until the expected event arrives, and its own
/// comment rules it out here: *"Only for emits with that guarantee —
/// `create_room` has none, and retrying it would create a second room."* So this
/// retries strictly less. It retries only when `emit` returns `Err`, which means
/// the socket carried nothing: there is no room to duplicate, and re-sending is
/// provably safe rather than probably safe.
///
/// **A new socket per attempt, not a retry on the old one.** T19.26 caught this
/// inside a loaded gate as
/// `IncompleteResponseFromEngineIo(WebsocketError(AlreadyClosed))` on a freshly
/// connected client — `docs/70` §A28's window seen from the transport side.
/// `AlreadyClosed` means that connection is gone, so re-emitting on it can only
/// fail the same way; the connection is what has to be rebuilt.
///
/// **It does not wait for a reply and must not.** The caller's own
/// `wait_for(..., "welcome", ...)` is the assertion; swallowing a genuine refusal
/// here and reporting it as a timeout there would trade one race for a blind
/// spot, which is the thing T19.26 exists to avoid.
pub fn connect_and_emit(
    addr: SocketAddr,
    events: &[&'static str],
    inbox: &Inbox,
    ev: &'static str,
    payload: serde_json::Value,
) -> rust_socketio::client::Client {
    let deadline = Instant::now() + EMIT_READY_WINDOW;
    let mut last;
    loop {
        let client = connect(addr, events, inbox);
        match client.emit(ev, payload.clone()) {
            Ok(()) => return client,
            Err(e) => {
                last = e.to_string();
                let _ = client.disconnect();
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    panic!(
        "emit {ev}: refused for the whole {}s window; last error {}",
        EMIT_READY_WINDOW.as_secs(),
        last
    );
}
