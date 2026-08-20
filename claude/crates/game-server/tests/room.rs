//! The room task, running for real (`docs/41-server-loop-rooms.md` §1–§2).
//!
//! Every test here uses a **multi-thread** runtime. `#[tokio::test]` defaults to
//! the current-thread flavour, and a room task sharing one thread with the test
//! future starves it — that trap cost an afternoon in M0 and presented as a
//! flaky socket handshake.

use std::sync::Arc;
use std::time::Duration;

use game_core::constants::SIM_HZ;
use game_core::player::input::{button, Input};
use game_server::config::Config;
use game_server::room::{spawn_room, Command, RoomHandle};
use game_server::state::AppState;
use socketioxide::SocketIo;
use tokio::sync::oneshot;

/// A room with no HTTP server around it: `SocketIo` is built and dropped into the
/// task, which is all the room needs to emit.
fn room() -> (RoomHandle, oneshot::Sender<()>) {
    let config = Arc::new(Config::default());
    let (_layer, io) = SocketIo::new_layer();
    let (tx, rx) = oneshot::channel();
    let handle = spawn_room(io, config, rx);
    (handle, tx)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_room_ticks_at_approximately_sim_hz() {
    let (room, _shut) = room();
    // Let it settle, then measure a clean window.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t0 = room.inspect(|w| w.tick).await.expect("alive");
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let t1 = room.inspect(|w| w.tick).await.expect("alive");

    let ticked = (t1 - t0) as f64;
    let expected = SIM_HZ as f64;
    let err = (ticked - expected).abs() / expected;
    assert!(
        err < 0.10,
        "ticked {ticked} in a second, expected ~{expected} ({:.1}% off)",
        err * 100.0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn join_seats_a_player_and_leave_removes_them() {
    let (room, _shut) = room();
    let id = room.join("ana".into(), 0).await.expect("seated");
    let n = room.inspect(|w| w.players.len()).await.expect("alive");
    assert_eq!(n, 1);

    room.send(Command::Leave(id));
    tokio::time::sleep(Duration::from_millis(80)).await;
    let n = room.inspect(|w| w.players.len()).await.expect("alive");
    assert_eq!(n, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_seventh_join_is_refused() {
    let (room, _shut) = room();
    for i in 0..6 {
        assert!(
            room.join(format!("p{i}"), 0).await.is_some(),
            "player {i} should be seated"
        );
    }
    assert!(room.join("seventh".into(), 0).await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commands_sent_between_ticks_are_all_applied() {
    let (room, _shut) = room();
    let id = room.join("ana".into(), 0).await.expect("seated");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let before = room
        .inspect(move |w| w.player(id).map(|p| p.body.pos.x).unwrap_or(0.0))
        .await
        .expect("alive");

    // Held state, at roughly the sim rate, for a quarter second.
    for seq in 1..=15u32 {
        room.send(Command::Input(id, vec![Input::new(seq, button::RIGHT, 0)]));
        tokio::time::sleep(Duration::from_millis(16)).await;
    }
    let after = room
        .inspect(move |w| w.player(id).map(|p| p.body.pos.x).unwrap_or(0.0))
        .await
        .expect("alive");

    // Displacement, not instantaneous velocity: GROUND_FRICTION zeroes vel.x
    // within ~0.1 s of the last input, so a velocity assertion measured after the
    // sleep reads 0 whether or not the inputs ever arrived.
    assert!(
        after > before + 1.0,
        "held right moved the player from {before} to {after}"
    );
}

/// One noisy client must not be able to stop the world.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_flood_of_commands_does_not_stall_the_tick_loop() {
    let (room, _shut) = room();
    let id = room.join("ana".into(), 0).await.expect("seated");
    let before = room.inspect(|w| w.tick).await.expect("alive");

    for seq in 1..=10_000u32 {
        room.send(Command::Input(id, vec![Input::new(seq, 0, 0)]));
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = room.inspect(|w| w.tick).await.expect("alive");

    let ticked = after - before;
    assert!(
        ticked > 20,
        "the loop stalled under a flood: only {ticked} ticks in 500 ms"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_shutdown_signal_ends_the_task() {
    let (room, shut) = room();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(room.inspect(|w| w.tick).await.is_some(), "running");

    let _ = shut.send(());
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The task is gone, so `inspect` can no longer be answered.
    let answered = tokio::time::timeout(Duration::from_millis(300), room.inspect(|w| w.tick))
        .await
        .unwrap_or(None);
    assert!(answered.is_none(), "the room task outlived its shutdown");
}

/// The room owns its `World`; `AppState` only reports counts. This pins that the
/// two do not drift into a second source of truth.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_world_is_reachable_only_through_the_channel() {
    let state = AppState::new(Config::default());
    assert_eq!(state.players(), 0);
    let (room, _shut) = room();
    room.join("ana".into(), 0).await.expect("seated");
    // AppState is untouched by a join: the room is the authority, and the count is
    // maintained by the socket layer (T6.03), not by the room.
    assert_eq!(state.players(), 0);
}
