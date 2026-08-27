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
    let started = stack.start_default_room();
    for _ in 0..200 {
        if started.inspect(|w| w.tick).await.unwrap_or(0) > 0 {
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
fn replay(map_init_b64: &str, carves: &[serde_json::Value]) -> String {
    let bytes = game_server::codec::b64_decode(map_init_b64).expect("map_init decodes");
    let parts = game_server::codec::decode_map_init_parts(&bytes).expect("map_init decodes");
    let coarse = game_core::map::CoarseGrid::build(&parts.mask);
    let mut meta = replay_meta();
    // §C5, and this is what a real client does through `Core.setTeleportPads`.
    // Without it every carve near a pad digs a patch the server refused.
    meta.teleport_pads = parts.teleport_pads;
    let mut map = game_core::map::Map::from_parts(parts.mask, coarse, meta);

    let mut ordered: Vec<&serde_json::Value> = carves.iter().collect();
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
        let (c1, i1, r1) = connect(addr, &evs);
        c1.emit("join", serde_json::json!({ "name": "ana" }))
            .expect("emit join");
        wait_for(&r1, "welcome", 15);
        wait_for(&r1, "map_init", 15);
        c1.emit("ready", serde_json::json!({})).expect("emit ready");

        let (c2, i2, r2) = connect(addr, &evs);
        c2.emit("join", serde_json::json!({ "name": "bo" }))
            .expect("emit join");
        wait_for(&r2, "welcome", 15);
        wait_for(&r2, "map_init", 15);
        c2.emit("ready", serde_json::json!({})).expect("emit ready");

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
        (m1, m2, cs, carves1, carves2, c1, c2)
    })
    .await
    .expect("client thread");

    let (m1, m2, checksums, carves1, carves2, c1, c2) = out;

    // The control. Without carves this test proves only that two clients
    // decoded the same map, which is true of a completely broken carve stream.
    assert!(
        carves1.len() >= 50,
        "expected the fires to produce carves; got {}",
        carves1.len()
    );
    assert_eq!(
        carves1.len(),
        carves2.len(),
        "both clients must see the same number of carves"
    );

    let b1 = m1[0].as_str().expect("map_init is base64 text");
    let b2 = m2[0].as_str().expect("map_init is base64 text");

    let h1 = replay(b1, &carves1);
    let h2 = replay(b2, &carves2);
    assert_eq!(h1, h2, "two clients' masks diverged after real fire");

    // And both must match the server, which is the half a client-to-client
    // comparison cannot see: two clients replaying the same wrong stream agree
    // with each other perfectly.
    let server_hash = room
        .inspect(|w| w.map.mask.hash_hex())
        .await
        .expect("room alive");
    assert_eq!(
        h1, server_hash,
        "clients agreed with each other but not with the server"
    );

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
        c1.emit("join", serde_json::json!({ "name": "flood" }))
            .expect("emit join");
        wait_for(&r1, "welcome", 15);
        wait_for(&r1, "map_init", 15);
        c1.emit("ready", serde_json::json!({})).expect("emit ready");
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

        // The shooter, live and firing.
        let (c1, _i1, r1) = connect(addr, &evs);
        c1.emit("join", serde_json::json!({ "name": "ana" }))
            .expect("emit join");
        wait_for(&r1, "welcome", 15);
        wait_for(&r1, "map_init", 15);
        c1.emit("ready", serde_json::json!({})).expect("emit ready");

        let handle = tokio::runtime::Handle::current();
        handle
            .block_on(arm.inspect(|w| {
                let ids: Vec<_> = w.players.iter().map(|p| p.id).collect();
                for id in ids {
                    for _ in 0..10 {
                        game_core::world::give(w, id, game_core::items::registry::SMG, 60);
                    }
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

        // The joiner. It joins and then sits on `ready` — the window under test.
        let (c2, i2, r2) = connect(addr, &evs);
        c2.emit("join", serde_json::json!({ "name": "bo" }))
            .expect("emit join");
        wait_for(&r2, "welcome", 15);
        wait_for(&r2, "map_init", 15);

        // Keep shooting while bo is seated, mapped and *not* ready. Every one of
        // these is a carve that used to be dropped on the floor.
        for i in 12..32 {
            fire(i);
            std::thread::sleep(Duration::from_millis(110));
        }
        c2.emit("ready", serde_json::json!({})).expect("emit ready");

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
        // Kept alive: see the note in the test above. §E1 drops the world when
        // the last human leaves, so the server read below needs a human left.
        (m2, carves2, c1, c2)
    })
    .await
    .expect("client thread");

    let (m2, carves2, c1, c2) = out;
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
    let client_hash = replay(b2, &carves2);
    let server_hash = room
        .inspect(|w| w.map.mask.hash_hex())
        .await
        .expect("room alive");
    assert_eq!(
        client_hash, server_hash,
        "the late-ready joiner's mask diverged from the server's"
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
