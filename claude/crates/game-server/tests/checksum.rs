//! The claim the whole architecture rests on.
//!
//! `docs/01-architecture.md` bets that shipping *carves* rather than the mask
//! keeps every client bit-identical to the server, because the rasterisation is
//! integer-exact and the order is fixed. `docs/41` §8 states the test: two
//! clients' masks hash identically after 100 real carves driven by real fire
//! commands.
//!
//! If this fails, everything downstream is suspect — prediction runs against the
//! wrong terrain, and a player is shot through a wall they can still see.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use game_core::constants::MapScale;
use game_server::{app, config::Config, state::AppState};
use rust_socketio::{ClientBuilder, Payload, RawClient};

fn test_config() -> Config {
    Config {
        map_scale: MapScale::Small,
        ..Config::default()
    }
}

struct Server {
    addr: SocketAddr,
    room: game_server::room::RoomHandle,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

async fn spawn_server() -> Server {
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
    // §C18: a room waits in `Lobby`, so there is no tick until a round starts.
    // This presses "Start with bots" once, the way a player does.
    // §E2/§E4: **create the room, do not start it yet.** Quick match now skips a
    // match that has begun, so a harness that started the default room first
    // left every joining client in a *fresh* lobby while this handle still
    // pointed at the original — the two clients agreed with each other and the
    // test compared them against a mask from a room they were never in.
    //
    // The clients join the open lobby; `start()` below begins it once they are
    // seated, which is §E2's order anyway: sit in a lobby, then play.
    let started = stack.room();
    for _ in 0..200 {
        // `is_some_and`, not `unwrap_or(0)`: §E1 makes `inspect` answer `None`
        // for a lobby, so the old form read 0 forever and waited for nothing.
        if started.join_info().await.map(|i| i.tick).unwrap_or(0) > 0 {
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

type Inbox = Arc<Mutex<HashMap<String, Vec<serde_json::Value>>>>;

fn text_of(payload: Payload) -> serde_json::Value {
    match payload {
        Payload::Text(v) => v.first().cloned().unwrap_or(serde_json::Value::Null),
        #[allow(deprecated)]
        Payload::String(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::String(s)),
        Payload::Binary(b) => serde_json::json!({ "binary_len": b.len() }),
    }
}

/// A client that records what it hears.
///
/// It blocks on `open` before returning. `ClientBuilder::connect()` returns once
/// engine.io is up while the socket.io namespace CONNECT is still in flight, and
/// an emit before that lands is dropped with no error — the ~50 % flake that cost
/// a session (`docs/70-amendments-v2.md` §A28).
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
            inbox
                .lock()
                .expect("poisoned")
                .entry(name.clone())
                .or_default()
                .push(text_of(payload));
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

/// Emit, waiting out the window in which the client is open but not yet sendable.
///
/// `connect` blocks on `open`, which is §A28's fix and is still necessary — **but
/// it is not sufficient under load.** The `open` callback is dispatched from the
/// poll thread, and for a few milliseconds after it `emit` still returns
/// `IllegalActionBeforeOpen`. Measured: 8/8 passes on an idle box in isolation,
/// and one failure inside a full `cargo test --workspace`, where every test
/// binary in the repository is running at once — `a_client_flooding_inputs…`
/// panicked with `emit join: IllegalActionBeforeOpen`.
///
/// **This does not weaken anything.** It relaxes no assertion and swallows no
/// server behaviour: if the server never accepts the join, `wait_for("welcome")`
/// still fails on its own deadline, and every emit that is not accepted inside
/// `EMIT_READY_WINDOW` still panics with the error it got.
///
/// The same shape exists in the other seven test binaries, each with its own copy
/// of `connect` — see `tasks/HANDOFF-M20.md`; a shared `tests/common` module is
/// the durable fix and is a task, not a side effect of this one.
fn emit_when_ready(c: &rust_socketio::client::Client, ev: &str, payload: serde_json::Value) {
    let deadline = std::time::Instant::now() + EMIT_READY_WINDOW;
    loop {
        match c.emit(ev, payload.clone()) {
            Ok(()) => return,
            Err(e) => {
                if std::time::Instant::now() >= deadline {
                    panic!("emit {ev}: {e}");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

/// How long `emit_when_ready` will wait for a client that reported `open` to
/// become sendable. Generous, because it only elapses when something is wrong.
const EMIT_READY_WINDOW: Duration = Duration::from_secs(5);

fn wait_for(rx: &mpsc::Receiver<String>, want: &str, secs: u64) {
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    let mut seen = Vec::new();
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(250)) {
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

/// The scaffolding a hash comparison does not care about.
///
/// **The pads are not scaffolding.** They used to be filled in as `Vec::new()`
/// here alongside everything else, and it made this whole file lie: §C5 pads are
/// indestructible, so a `Map` that does not know about them carves pixels the
/// server refuses, and `replay` reported a mask the real client would never
/// produce. `replay` now installs the pads it decodes from `map_init`.
fn replay_meta() -> game_core::map::MapMeta {
    game_core::map::MapMeta {
        seed: 0,
        requested_seed: 0,
        attempts: 1,
        used_safe_preset: false,
        scale: MapScale::Small,
        theme: 0,
        spawn_points: Vec::new(),
        teleport_pads: Vec::new(),
        surface_points: Vec::new(),
        objects: Vec::new(),
        buried_slots: Vec::new(),
        decorations: Vec::new(),
        wind: 0.0,
        traversable_fraction: 1.0,
        largest_component: Vec::new(),
    }
}

/// Replay a client's `carve` stream into a local `Map` and hash it.
///
/// This is what a real client does (`WorldMirror.applyCarve`): apply in `seq`
/// order, integer-exact, against a mask decoded from the same `map_init`.
/// Replay a carve stream onto a `map_init`, the way a real client does.
///
/// **Carves at or below the mask's own `carve_seq` are skipped**, because they
/// are already baked into it (`docs/70` §A40). That is not a detail: when the
/// join-window queue overflows, `go_live` fails and the server sends a *second*
/// `map_init` stamped at the current sequence — so a client that replayed its
/// whole stream against the first mask was applying carves twice and missing the
/// ones dropped from the queue. This fixture did exactly that.
fn replay(map_init_b64: &str, carves: &[serde_json::Value]) -> String {
    let bytes = game_server::codec::b64_decode(map_init_b64).expect("map_init decodes");
    let parts = game_server::codec::decode_map_init_parts(&bytes).expect("map_init decodes");
    let baked = parts.carve_seq as u64;
    let coarse = game_core::map::CoarseGrid::build(&parts.mask);
    let mut meta = replay_meta();
    // §C5, and this is what a real client does through `Core.setTeleportPads`.
    // Without it every carve near a pad digs a patch the server refused.
    meta.teleport_pads = parts.teleport_pads;
    let mut map = game_core::map::Map::from_parts(parts.mask, coarse, meta);

    let mut ordered: Vec<&serde_json::Value> = carves
        .iter()
        .filter(|c| c["seq"].as_u64().unwrap_or(0) > baked)
        .collect();
    ordered.sort_by_key(|c| c["seq"].as_u64().unwrap_or(0));
    for c in ordered {
        let (x, y, r) = (
            c["x"].as_i64().unwrap_or(0) as i32,
            c["y"].as_i64().unwrap_or(0) as i32,
            c["r"].as_i64().unwrap_or(0) as i32,
        );
        map.carve_circle(x, y, r);
    }
    map.mask.hash_hex()
}

/// Start a room's match and wait for its world.
///
/// §E2 left `spawn_server` handing back an **unstarted** lobby, because quick
/// match skips a started match and every client would otherwise land somewhere
/// else. A test that inspects a world has to ask for one first.
async fn start_and_wait(room: &game_server::room::RoomHandle) {
    room.send(game_server::room::Command::StartWithBots(0));
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while room.inspect(|w| w.tick).await.is_none() {
        assert!(
            std::time::Instant::now() < deadline,
            "the room never started, so there is no world to inspect"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_clients_agree_on_the_mask_after_a_hundred_carves() {
    let s = spawn_server().await;
    let addr = s.addr;
    let room = s.room.clone();

    // Arm the shooter. Players spawn with an empty inventory, so without this
    // every `fire` is correctly rejected and the test measures nothing — which is
    // exactly what the carve-count control below caught on the first run.
    let arm = room.clone();

    let out = tokio::task::spawn_blocking(move || {
        let evs = ["welcome", "map_init", "carve", "mask_checksum"];
        // §E1/§E2: both clients seat into the **lobby**, and the match starts
        // once they are in. `map_init` arrives at match start, not at join, so
        // waiting for it before starting would wait forever.
        let (c1, i1, r1) = connect(addr, &evs);
        emit_when_ready(&c1, "join", serde_json::json!({ "name": "ana" }));
        wait_for(&r1, "welcome", 15);

        let (c2, i2, r2) = connect(addr, &evs);
        emit_when_ready(&c2, "join", serde_json::json!({ "name": "bo" }));
        wait_for(&r2, "welcome", 15);

        emit_when_ready(&c1, "start_with_bots", serde_json::json!({}));
        wait_for(&r1, "map_init", 30);
        wait_for(&r2, "map_init", 30);
        emit_when_ready(&c1, "ready", serde_json::json!({}));
        emit_when_ready(&c2, "ready", serde_json::json!({}));

        // Give player 0 plenty of rockets, through the room's own command
        // channel — the same serialisation point every other mutation uses.
        let handle = tokio::runtime::Handle::current();
        handle
            .block_on(arm.inspect(|w| {
                let ids: Vec<_> = w.players.iter().map(|p| p.id).collect();
                for id in ids {
                    // SMG, not bazooka: BAZOOKA_COOLDOWN is 0.9 s, so 100 real
                    // fires would take 90 s. The SMG's 0.10 s cooldown makes a
                    // hundred shots a ten-second test, and each one still carves
                    // (`docs/31` §4 — sustained fire genuinely tunnels).
                    for _ in 0..40 {
                        game_core::world::give(w, id, game_core::items::registry::SMG, 60);
                    }
                    // **In hand.** §F5 seats a shovel in slot 0 of every player
                    // and `fire` uses the selected slot, so without this the
                    // hundred "shots" below are shovel swings: they carve too,
                    // which is why this failed as `got 28` — a real carve count,
                    // from the wrong weapon, throttled by a 0.55 s melee
                    // cooldown — rather than as an obvious zero.
                    game_core::world::wield(w, id, game_core::items::registry::SMG);
                }
            }))
            .expect("room alive");

        // 100 real fires. Not synthetic carve events — the whole point is that
        // the terrain changes come from gameplay, through the same path a rocket
        // takes on a live server.
        // Aim swept across the downward hemisphere so the rays hit ground
        // rather than sky — a shot into the air carves nothing, and the carve
        // count control below would catch it, but slowly.
        for i in 0..100 {
            let t = (i as f32) / 100.0;
            let angle = std::f32::consts::PI * (0.25 + 0.5 * t); // down-right..down-left
            let q = ((angle / std::f32::consts::TAU) * 65536.0) as u16;
            let inp = game_server::codec::encode_input_batch(&[game_core::player::input::Input {
                seq: i + 1,
                aim: q,
                buttons: 0,
            }]);
            c1.emit(
                "input",
                serde_json::json!(game_server::codec::b64_encode(&inp)),
            )
            .ok();
            c1.emit("fire", serde_json::json!({})).expect("emit fire");
            std::thread::sleep(Duration::from_millis(110));
        }

        // Let the tail of the carves and at least one checksum land.
        std::thread::sleep(Duration::from_millis(1500));

        let m1 = got(&i1, "map_init");
        let m2 = got(&i2, "map_init");
        let cs = got(&i1, "mask_checksum");
        let carves1 = got(&i1, "carve");
        let carves2 = got(&i2, "carve");
        // §E1: the clients stay connected until the server's mask has been read.
        // The last human leaving now sends the room back to `Lobby`, and a lobby
        // has no world — so disconnecting here would make the server hash below
        // a read of a room that has already ended.
        (m1, m2, cs, carves1, carves2, c1, c2, i1, i2)
    })
    .await
    .expect("client thread");

    let (m1, m2, checksums, carves1, carves2, c1, c2, i1, i2) = out;

    // The control. Without carves this test proves only that two clients
    // decoded the same map, which is true of a completely broken carve stream.
    assert!(
        carves1.len() >= 50,
        "expected the fires to produce carves; got {}",
        carves1.len()
    );
    // **The last `map_init`, not the first.** A client whose join-window queue
    // overflowed is sent a second one at the current sequence, and the carves
    // held in that queue are dropped rather than flushed — so the first mask and
    // the full carve stream describe two different moments. The sibling test at
    // `:586` already asserts `m2.len() == 1`; this one never looked, so a resend
    // was invisible to it and surfaced as a mask that would not reconcile.
    let b1 = m1
        .last()
        .expect("a map_init")
        .as_str()
        .expect("base64 text");
    let b2 = m2
        .last()
        .expect("a map_init")
        .as_str()
        .expect("base64 text");

    // Compared over the window **both** clients were live for. If only one of
    // them overflowed they resume at different sequences, so the raw counts
    // differ for a correct server — the same repair `join.rs` already carries.
    let seq_of = |v: &[serde_json::Value]| -> Vec<u64> {
        v.iter().filter_map(|c| c["seq"].as_u64()).collect()
    };
    let (s1, s2) = (seq_of(&carves1), seq_of(&carves2));
    let base = s1
        .iter()
        .min()
        .copied()
        .unwrap_or(0)
        .max(s2.iter().min().copied().unwrap_or(0));
    let common = |v: &[u64]| v.iter().filter(|s| **s >= base).count();
    assert_eq!(
        common(&s1),
        common(&s2),
        "both clients must see the same carves over the window both were live for \
         (ana {} total, bo {} total, common floor seq {base})",
        s1.len(),
        s2.len()
    );

    let h1 = replay(b1, &carves1);
    let h2 = replay(b2, &carves2);
    assert_eq!(h1, h2, "two clients' masks diverged after real fire");

    // And both must match the server, which is the half a client-to-client
    // comparison cannot see: two clients replaying the same wrong stream agree
    // with each other perfectly.
    //
    // **Read at the same sequence.** The snapshots above were taken inside the
    // blocking half and the server is read here, so anything that carved in
    // between — a projectile still in flight — leaves the server ahead of both
    // clients and the comparison fails for a correct server. Both sockets are
    // still connected, so both inboxes are still filling: wait for them to reach
    // the server's sequence and compare there.
    let mut server_hash;
    let mut server_seq;
    let mut a1;
    let mut a2;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let read = room
            .inspect(|w| (w.map.mask.hash_hex(), w.carve_seq()))
            .await
            .expect("room alive");
        server_hash = read.0;
        server_seq = read.1;

        let (n1, n2) = (got(&i1, "carve"), got(&i2, "carve"));
        let max_of = |v: &[serde_json::Value]| -> u64 {
            v.iter()
                .filter_map(|c| c["seq"].as_u64())
                .max()
                .unwrap_or(0)
        };
        a1 = max_of(&n1);
        a2 = max_of(&n2);
        if a1 >= u64::from(server_seq) && a2 >= u64::from(server_seq) {
            let h = replay(b1, &n1);
            assert_eq!(
                h,
                replay(b2, &n2),
                "two clients diverged from each other at seq {server_seq}"
            );
            assert_eq!(
                h, server_hash,
                "clients agreed with each other but not with the server at \
                 seq {server_seq} — genuinely different pixels, not a client \
                 reading early"
            );
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the clients never caught up: ana {a1}, bo {a2}, server {server_seq}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    drop((c1, c2));

    // The checksum the server broadcasts must be the one a client can verify.
    assert!(
        !checksums.is_empty(),
        "no mask_checksum was broadcast in the round"
    );
    let last = checksums.last().expect("checked non-empty");
    assert!(
        last["hash"].as_str().is_some(),
        "mask_checksum carries a hash field"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_carve_stream_applied_out_of_order_diverges() {
    // The falsification for the test above: if order did not matter, the whole
    // `seq` discipline in `WorldMirror` would be dead weight.
    let s = spawn_server().await;
    // This one inspects a map rather than driving clients, so it needs a world.
    start_and_wait(&s.room).await;

    // Find a spot where a one-pixel radius increase provably bites fresh rock,
    // by carving both radii and comparing `pixels_removed` — do not assume any
    // coordinate is solid.
    //
    // Two earlier versions of this test assumed. A hardcoded (300, 700) was open
    // sky once `DEFAULT_MAP_SCALE` moved, and (300, 300) before that (T11.10).
    // The version after those nested the small circle *inside* a 40 px crater,
    // so the entire difference rode on a 1 px crescent at radius 40..41 being
    // solid — true on most maps and false on some, which became a **1-in-6 gate
    // failure** once §B13 gave every room its own seed. Before §B13 every room
    // shared one hardcoded seed, so the geometry was stable and the assumption
    // held by luck.
    //
    // The failure message made it worse: it announced that the mask hash is
    // insensitive to a single-pixel difference, when what had actually happened
    // is that no pixel differed. A control that misreports its own precondition
    // as a failure of the thing it is controlling for is worse than no control.
    let found = s
        .room
        .inspect(|w| {
            let pts = &w.map.meta.surface_points;
            // Depths, not one guess: a surface point may sit on a thin ledge.
            for depth in [60, 100, 160, 220] {
                for p in pts.iter() {
                    let (x, y) = (p.x, p.y + depth);
                    let small = w.map.clone().carve_circle(x, y, 20).pixels_removed;
                    let big = w.map.clone().carve_circle(x, y, 21).pixels_removed;
                    if big > small {
                        return Some((x, y, small, big));
                    }
                }
            }
            None
        })
        .await
        .expect("room alive");

    let (x, y, small_px, big_px) = found.expect(
        "no point on this map has solid rock in the ring between r=20 and r=21 — \
         the fixture cannot exercise a single-pixel difference, so nothing about \
         the mask hash has been tested",
    );
    assert!(
        big_px > small_px,
        "precondition: r=21 must remove more than r=20 ({big_px} vs {small_px})"
    );

    let hash_small = s
        .room
        .inspect(move |w| {
            let mut m = w.map.clone();
            m.carve_circle(x, y, 20);
            m.mask.hash_hex()
        })
        .await
        .expect("room alive");
    let hash_big = s
        .room
        .inspect(move |w| {
            let mut m = w.map.clone();
            m.carve_circle(x, y, 21); // one pixel wider, nothing else changed
            m.mask.hash_hex()
        })
        .await
        .expect("room alive");

    assert_ne!(
        hash_small, hash_big,
        "the mask hash must be sensitive to a single-pixel difference \
         ({big_px} px removed at r=21 vs {small_px} at r=20, so the masks really \
         do differ) — or the agreement test above proves nothing"
    );
}

/// §A30's exploit, end to end through a real socket.
///
/// The unit test in `game-core` proves the tick applies one input; this proves
/// the *server* does, through the codec and the command channel, which is where
/// a client would actually attempt it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_client_flooding_inputs_does_not_outrun_one_sending_normally() {
    let s = spawn_server().await;
    let addr = s.addr;
    let room = s.room.clone();

    let travelled = tokio::task::spawn_blocking(move || {
        let (c1, _i1, r1) = connect(addr, &["welcome", "map_init"]);
        emit_when_ready(&c1, "join", serde_json::json!({ "name": "flood" }));
        wait_for(&r1, "welcome", 15);
        wait_for(&r1, "map_init", 15);
        emit_when_ready(&c1, "ready", serde_json::json!({}));
        std::thread::sleep(Duration::from_millis(200));

        // Eight inputs in one batch, repeatedly — the maximum the queue accepts.
        let mut seq = 1u32;
        for _ in 0..30 {
            let batch: Vec<_> = (0..8)
                .map(|_| {
                    let i = game_core::player::input::Input {
                        seq,
                        buttons: game_core::player::input::button::RIGHT,
                        aim: 0,
                    };
                    seq += 1;
                    i
                })
                .collect();
            let bytes = game_server::codec::encode_input_batch(&batch);
            c1.emit(
                "input",
                serde_json::json!(game_server::codec::b64_encode(&bytes)),
            )
            .ok();
            std::thread::sleep(Duration::from_millis(16));
        }
        std::thread::sleep(Duration::from_millis(300));
        // Returned, not disconnected. §E1: the last human leaving sends the room
        // back to `Lobby` and a lobby has no world, so disconnecting here races
        // the read below — and won that race in three runs out of four before
        // this change made it matter.
        c1
    })
    .await;
    let c1 = travelled.expect("client thread");

    // 30 batches x 8 inputs = 240 inputs over ~30 ticks. If every queued input
    // were applied with a full dt, the player would have covered roughly eight
    // times the ground — instead the backlog is bounded and consumed one per
    // tick, so the distance is bounded by the tick count.
    let pending = room.inspect(|w| w.pending_len()).await.expect("room alive");
    assert!(
        pending <= game_core::constants::MAX_INPUT_QUEUE,
        "the input backlog grew to {pending} against a cap of {}",
        game_core::constants::MAX_INPUT_QUEUE
    );
    drop(c1);
}

/// A client that joins **while carves are happening** and delays `ready` must
/// still receive every carve after the mask it was given.
///
/// The bug (§A40): `map_init` is stamped `carve_seq = N`, so the client picks the
/// stream up at `N+1` — but broadcasts were gated on `ready`, so every carve in
/// that window was dropped. The client buffers the first one it *does* get,
/// cannot fill the hole, and refetches the whole map two seconds later
/// (`docs/42` §6). Measured on a live round: 1–2 resyncs per client.
///
/// Joining mid-firefight is a normal path (`docs/41` §4), and it is exactly when
/// the window is widest.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_joiner_that_delays_ready_still_gets_every_carve() {
    let s = spawn_server().await;
    let addr = s.addr;
    let room = s.room.clone();
    let arm = room.clone();

    let out = tokio::task::spawn_blocking(move || {
        let evs = ["welcome", "map_init", "carve"];

        // §E2 moved *when* the joiner can arrive, not what is under test.
        //
        // The claim is the **ready window**: a client that is seated and has its
        // map but has not sent `ready` must still receive every carve. That
        // window is unchanged. What changed is that a client can no longer
        // arrive mid-firefight — §E4 closes a started match, and `quick_match`
        // now skips one — so bo seats into the lobby alongside ana and simply
        // does not ready. Seated, mapped, not ready: the same three conditions,
        // reached the way §E2 lets a player reach them.
        let (c1, _i1, r1) = connect(addr, &evs);
        emit_when_ready(&c1, "join", serde_json::json!({ "name": "ana" }));
        wait_for(&r1, "welcome", 15);

        let (c2, i2, r2) = connect(addr, &evs);
        emit_when_ready(&c2, "join", serde_json::json!({ "name": "bo" }));
        wait_for(&r2, "welcome", 15);

        emit_when_ready(&c1, "start_with_bots", serde_json::json!({}));
        wait_for(&r1, "map_init", 30);
        wait_for(&r2, "map_init", 30);
        emit_when_ready(&c1, "ready", serde_json::json!({}));

        let handle = tokio::runtime::Handle::current();
        handle
            .block_on(arm.inspect(|w| {
                let ids: Vec<_> = w.players.iter().map(|p| p.id).collect();
                for id in ids {
                    for _ in 0..10 {
                        game_core::world::give(w, id, game_core::items::registry::SMG, 60);
                    }
                    // §F5's shovel is slot 0; without this the "firefight" below
                    // is a melee swing. It carves, so this fixture would still
                    // have passed — measuring the wrong weapon.
                    game_core::world::wield(w, id, game_core::items::registry::SMG);
                }
            }))
            .expect("room alive");

        let fire = |i: u32| {
            let t = (i as f32) / 40.0;
            let angle = std::f32::consts::PI * (0.25 + 0.5 * t);
            let q = ((angle / std::f32::consts::TAU) * 65536.0) as u16;
            let inp = game_server::codec::encode_input_batch(&[game_core::player::input::Input {
                seq: i + 1,
                aim: q,
                buttons: 0,
            }]);
            c1.emit(
                "input",
                serde_json::json!(game_server::codec::b64_encode(&inp)),
            )
            .ok();
            c1.emit("fire", serde_json::json!({})).ok();
        };

        // Carve the map for a while so the joiner arrives mid-firefight.
        for i in 0..12 {
            fire(i);
            std::thread::sleep(Duration::from_millis(110));
        }

        // bo is seated and mapped from here, and has **not** sent `ready` —
        // the window under test.

        // Keep shooting while bo is seated, mapped and *not* ready. Every one of
        // these is a carve that used to be dropped on the floor.
        for i in 12..32 {
            fire(i);
            std::thread::sleep(Duration::from_millis(110));
        }
        emit_when_ready(&c2, "ready", serde_json::json!({}));

        // Wait for the carve stream to **settle**, not for a fixed duration.
        //
        // This used to sleep 1200 ms and then read whatever had arrived, which
        // made it load-sensitive: with other builds running on the box the last
        // carve landed after the deadline and the replayed mask diverged, about
        // one run in four. A gate that fails on a coin flip gates nothing
        // (§A28), and "the box was busy" is not a defect in the carve stream —
        // it is a defect in how the test decides it has seen everything.
        let mut last = 0usize;
        let mut stable = 0;
        for _ in 0..120 {
            std::thread::sleep(Duration::from_millis(50));
            let n = got(&i2, "carve").len();
            if n == last && n > 0 {
                stable += 1;
                // 400 ms with nothing new, well past the 110 ms firing cadence.
                if stable >= 8 {
                    break;
                }
            } else {
                stable = 0;
                last = n;
            }
        }

        let m2 = got(&i2, "map_init");
        let carves2 = got(&i2, "carve");
        // The inbox comes back too: the socket stays connected, so it keeps
        // filling, and the comparison below waits for it to catch up with the
        // server rather than trusting the settle loop above to have caught
        // everything. Kept alive for the same reason as the test above — §E1
        // drops the world when the last human leaves.
        (m2, carves2, c1, c2, i2)
    })
    .await
    .expect("client thread");

    let (m2, carves2, c1, c2, i2) = out;
    assert_eq!(
        m2.len(),
        1,
        "the joiner got exactly one map_init, not a resync"
    );
    let b2 = m2[0].as_str().expect("map_init is base64 text");

    // The control: without carves in the window this test passes against a server
    // that drops every one of them.
    assert!(
        carves2.len() >= 10,
        "the joiner should have seen the fires during its ready window; got {}",
        carves2.len()
    );

    // No hole in the sequence. This is the property, not a count: one missing
    // `seq` is what costs a full map resync.
    let mut seqs: Vec<u64> = carves2
        .iter()
        .map(|c| c["seq"].as_u64().unwrap_or(0))
        .collect();
    seqs.sort_unstable();
    seqs.dedup();
    let first = *seqs.first().expect("checked non-empty");
    let last = *seqs.last().expect("checked non-empty");
    assert_eq!(
        seqs.len() as u64,
        last - first + 1,
        "the joiner's carve stream has a hole: {first}..={last} but only {} distinct seqs",
        seqs.len()
    );

    // And the mask it ends up with is the server's, byte for byte — the check a
    // carve count cannot make.
    // **Compared at the same instant, not at two.**
    //
    // The settle loop above waits for the client's stream to go quiet, and quiet
    // is not the same as finished: a projectile still in flight lands after it,
    // carves, and the server is then ahead of the snapshot the client took.
    // Measured, that is exactly what this was — `client at seq 116, server at
    // seq 117`, one carve behind, on about one run in eight.
    //
    // So the reads are aligned instead of hoped about: take the server's
    // sequence, wait for the client to reach it, and only then compare. That
    // asserts *more* than before — the client must actually receive everything
    // the server has — and it cannot pass by looking early.
    let mut server_hash;
    let mut server_seq;
    let mut client_hash;
    let mut client_seq;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let read = room
            .inspect(|w| (w.map.mask.hash_hex(), w.carve_seq()))
            .await
            .expect("room alive");
        server_hash = read.0;
        server_seq = read.1;

        let now = got(&i2, "carve");
        client_seq = now
            .iter()
            .filter_map(|c| c["seq"].as_u64())
            .max()
            .unwrap_or(0);
        client_hash = replay(b2, &now);

        if client_seq >= u64::from(server_seq) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the joiner never caught up: client at seq {client_seq}, server at seq {server_seq}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    assert_eq!(
        client_hash, server_hash,
        "the late-ready joiner's mask diverged from the server's at the same \
         sequence (both at {client_seq}/{server_seq}) — this is genuinely \
         different pixels, not a client reading early"
    );
    drop((c1, c2));
}

/// §C5's pads must reach the **client's core**, or every carve near one diverges.
///
/// ## Why this is here and not left to the socket tests above
///
/// `two_clients_agree_on_the_mask_after_a_hundred_carves` did catch this — once.
/// Removing the fix and re-running it passed, because whether any of that round's
/// hundred carves happened to land within a pad-width of a pad is chance. **A gate
/// that fails on a coin flip gates nothing**, so the property gets a test that
/// aims at it: the same carve, centred on a pad, applied to a server map and to
/// two client maps — one that was told about the pads and one that was not.
///
/// The second half is the control. Without it "the masks agree" is also what a
/// build with no indestructibility at all produces.
#[test]
fn a_client_that_is_not_told_about_the_pads_carves_a_different_mask() {
    use game_core::constants::PAD_W;

    let server = game_core::map::generate(4242, MapScale::Small);
    let pad = *server
        .meta
        .teleport_pads
        .first()
        .expect("the generated map has pads");

    let bytes = game_server::codec::encode_map_init(&server);
    let parts = game_server::codec::decode_map_init_parts(&bytes).expect("map_init decodes");
    assert_eq!(
        parts.teleport_pads.len(),
        server.meta.teleport_pads.len(),
        "map_init dropped pads on the way out"
    );

    // Three maps from the same mask: the server's, a client told about the pads,
    // and a client that was not.
    let build = |pads: Vec<game_core::map::meta::TeleportPad>| {
        let mask = parts.mask.clone();
        let coarse = game_core::map::CoarseGrid::build(&mask);
        let mut meta = replay_meta();
        meta.teleport_pads = pads;
        game_core::map::Map::from_parts(mask, coarse, meta)
    };
    let mut informed = build(parts.teleport_pads.clone());
    let mut ignorant = build(Vec::new());
    let mut authority = server.clone();

    // Straight over the pad, wide enough to swallow the whole rect.
    let (cx, cy, r) = (pad.pos.x, pad.pos.y + PAD_W, PAD_W * 2);
    for m in [&mut authority, &mut informed, &mut ignorant] {
        m.carve_circle(cx, cy, r);
    }

    assert_eq!(
        informed.mask.hash_hex(),
        authority.mask.hash_hex(),
        "a client told about the pads carved a different mask from the server"
    );
    assert_ne!(
        ignorant.mask.hash_hex(),
        authority.mask.hash_hex(),
        "a client with NO pads produced the same mask — so this test cannot fail, \
         and the pads are not actually indestructible"
    );
}
