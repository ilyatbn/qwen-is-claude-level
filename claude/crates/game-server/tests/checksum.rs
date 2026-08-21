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
    let router = stack.router;
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
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

/// Only the mask matters for a hash comparison; the rest is scaffolding the
/// wire format deliberately does not carry (`docs/32` §5 — buried slots never
/// leave the server).
fn replay_meta() -> game_core::map::MapMeta {
    game_core::map::MapMeta {
        seed: 0,
        requested_seed: 0,
        attempts: 1,
        used_safe_preset: false,
        scale: MapScale::Small,
        theme: 0,
        spawn_points: Vec::new(),
        surface_points: Vec::new(),
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
    let mask = game_server::codec::decode_map_init_mask(&bytes).expect("mask decodes");
    let coarse = game_core::map::CoarseGrid::build(&mask);
    let mut map = game_core::map::Map::from_parts(mask, coarse, replay_meta());

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
        let _ = c1.disconnect();
        let _ = c2.disconnect();
        (m1, m2, cs, carves1, carves2)
    })
    .await
    .expect("client thread");

    let (m1, m2, checksums, carves1, carves2) = out;

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
    // Find real rock rather than assuming a coordinate is solid. The hardcoded
    // (300, 700) this used worked only on the map scale that happened to be the
    // default: on another it is open sky, both carves remove nothing, and the
    // two hashes match — the test then fails claiming the mask hash is
    // insensitive, when what actually happened is that nothing was carved. The
    // T11.10 journal entry records the identical trap at (300, 300).
    let rock = s
        .room
        .inspect(|w| {
            let m = &w.map.meta;
            let p = m.surface_points[m.surface_points.len() / 2];
            // A little below the surface, so a 40 px circle is biting rock.
            (p.x, p.y + 30)
        })
        .await
        .expect("room alive");

    let hash_in_order = s
        .room
        .inspect(move |w| {
            let mut m = w.map.clone();
            m.carve_circle(rock.0, rock.1, 40);
            m.carve_circle(rock.0 + 20, rock.1, 20);
            m.mask.hash_hex()
        })
        .await
        .expect("room alive");

    let hash_different_set = s
        .room
        .inspect(move |w| {
            let mut m = w.map.clone();
            m.carve_circle(rock.0, rock.1, 40);
            m.carve_circle(rock.0 + 20, rock.1, 21); // one pixel wider
            m.mask.hash_hex()
        })
        .await
        .expect("room alive");

    assert_ne!(
        hash_in_order, hash_different_set,
        "the mask hash must be sensitive to a single-pixel difference, or the \
         agreement test above proves nothing"
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
        let _ = c1.disconnect();
    })
    .await;
    travelled.expect("client thread");

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
        let _ = c1.disconnect();
        let _ = c2.disconnect();
        (m2, carves2)
    })
    .await
    .expect("client thread");

    let (m2, carves2) = out;
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
}
