//! The room task, running for real (`docs/41-server-loop-rooms.md` §1–§2).
//!
//! Every test here uses a **multi-thread** runtime. `#[tokio::test]` defaults to
//! the current-thread flavour, and a room task sharing one thread with the test
//! future starves it — that trap cost an afternoon in M0 and presented as a
//! flaky socket handshake.

use std::sync::Arc;
use std::time::Duration;

use game_core::constants::{PLAYER_W, SIM_HZ, STEP_UP, WALK_SPEED, WALL_W};
use game_core::map::Map;
use game_core::physics::body::Body;
use game_core::player::input::{button, Input};
use game_server::config::Config;
use game_server::room::{spawn_room, Command, RoomHandle};
use game_server::state::AppState;
use socketioxide::SocketIo;
use tokio::sync::oneshot;

mod common;

/// A **Small** map on a **stated seed**, not the shipped defaults.
///
/// `DEFAULT_MAP_SCALE` is Large (§A1), so a room built from `Config::default()`
/// generates 4096x2048 and then steps that world at 60 Hz for the lifetime of the
/// test binary. Cargo runs test binaries in parallel, and several of those at once
/// starved the M0 socket handshake into a 10 s timeout — a failure in an unrelated
/// suite, caused entirely by how expensive these fixtures were.
///
/// `bot_count` is 0 for the same class of reason: `BOT_COUNT` defaults to 3
/// (§A5), and these tests count seats and players. Bot seating has its own
/// suite in `tests/bots.rs`.
///
/// **What `common::TEST_SEED` buys this file in particular** (T20.20). All eight
/// fixtures used to reach `fixed_seed: None` through `..Config::default()`, so
/// every run generated a different map and put the player somewhere different on
/// it — which is what made `commands_sent_between_ticks_are_all_applied` a D-58
/// flaky-list entry. On a seed that spawns against a wall the held input is a
/// no-op; on a seed that spawns in a pocket there is nowhere to walk at all.
/// Measured while fixing it, with the direction probe already in place: **one
/// unseeded run in sixteen found 5 px of room in the better direction**, against
/// a 16 px body. The terrain is that tight: scanning the mask of
/// `World::new(common::TEST_SEED, MapScale::Small)` for a level, clear stretch as
/// long as a body plus a quarter-second walk found **none, on any row** — the
/// same result T20.19 got before it gave up and built its own shelf. At this seed
/// the probe reports **the full `reach` of clear room, 38 px**, on three runs out
/// of three.
///
/// **The seed is not on its own the fix.** It makes the spawn reproducible; it
/// does not make walking *right* correct, and the next map change re-rolls which
/// seeds are walkable. `room_for` below is what makes the direction right.
pub fn test_config() -> Config {
    Config {
        bot_count: 0,
        ..common::test_config()
    }
}

/// A room with no HTTP server around it: `SocketIo` is built and dropped into the
/// task, which is all the room needs to emit.
fn room() -> (RoomHandle, oneshot::Sender<()>) {
    let config = Arc::new(test_config());
    let (_layer, io) = SocketIo::new_layer();
    let (tx, rx) = oneshot::channel();
    let handle = spawn_room(io, config, rx);
    (handle, tx)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_room_ticks_at_approximately_sim_hz() {
    let (room, _shut) = room();
    // Let it settle, then measure a clean window.
    // The **lobby's** clock, which is the room's (`docs/72` §C18-clarified, and
    // §E1: there is no world to hold one). That a room waiting for players still
    // ticks at SIM_HZ is the property this asserts.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t0 = room.join_info().await.expect("alive").tick;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let t1 = room.join_info().await.expect("alive").tick;

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
    let id = room
        .join("ana".into(), Default::default())
        .await
        .expect("seated");
    // §E1.1: the seats **are** the roster in a lobby — there is no world holding
    // a player list to count. `status` answers in both states.
    let (n, _bots) = room.status().await.expect("alive");
    assert_eq!(n, 1);

    room.send(Command::Leave(id));
    tokio::time::sleep(Duration::from_millis(80)).await;
    let (n, _bots) = room.status().await.expect("alive");
    assert_eq!(n, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_seventh_join_is_refused() {
    let (room, _shut) = room();
    for i in 0..6 {
        assert!(
            room.join(format!("p{i}"), Default::default())
                .await
                .is_some(),
            "player {i} should be seated"
        );
    }
    assert!(room
        .join("seventh".into(), Default::default())
        .await
        .is_none());
}

/// Get a room out of `Lobby` and into a running round.
///
/// §C18: a room is born in `Lobby`, so a test that joins one player and expects
/// movement is testing a room that never steps. §E2 would start it on its own
/// after `LOBBY_BOT_TIMEOUT`; `StartWithBots` is the manual form and does not
/// wait, which is why this uses it — there is no countdown left to sit through,
/// really does take about five seconds.
async fn start_round(room: &RoomHandle, id: u8) {
    // §E1: `join_info`, not `inspect`. A lobby has no world, so the world-shaped
    // read answers `None` — which `expect` then reports as a dead room while the
    // room is alive and waiting, exactly as asked.
    room.send(Command::StartWithBots(id));
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let phase = room
            .join_info()
            .await
            .expect("room alive while waiting for the round to start")
            .phase;
        if phase != "lobby" {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the round never started; still {phase} after 30 s"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// How far the body can walk in `dir` (`1.0` right, `-1.0` left) before terrain
/// stops it, in pixels, capped at `reach`.
///
/// **`scripts/checks/audio.mjs::roomFor` ported, not re-invented** (T20.20).
/// That check hit the identical problem on the browser side — a fixture that
/// held one hardcoded direction and reported an audio fault about a player
/// standing against terrain — and solved it by asking whether there is room
/// before pushing.
///
/// Two differences from the JavaScript, both because Rust can see the real
/// geometry: the sampled column is the body's own `head_y()..feet_y()` rather
/// than three fractions of a nominal height, and the bottom `STEP_UP` pixels
/// are excluded because `physics/resolve.rs::move_x` climbs those rather than
/// stopping at them — a step up is a slope the body walks, not a wall.
fn room_for(map: &Map, body: &Body, dir: f32, reach: i32) -> i32 {
    let half_w = body.size.x / 2.0;
    let top = body.head_y().ceil() as i32;
    let bottom = (body.feet_y() - STEP_UP as f32).floor() as i32;
    for step in 1..=reach {
        let x = (body.pos.x + dir * (half_w + step as f32)).round() as i32;
        if (top..=bottom).any(|y| map.mask.get(x, y)) {
            return step - 1;
        }
    }
    reach
}

/// What a held quarter-second of input did: the direction chosen, the room the
/// probe found in it, and where the player was before and after.
///
/// **One function, two tests** — the wall test below must exercise the same
/// direction choice this one does, or "the fixture survives a spawn against the
/// wall" would be a claim about a second implementation.
async fn walk_where_there_is_room(room: &RoomHandle, id: u8) -> (f32, i32, f32, f32) {
    // Held state, at the sim rate, for a quarter second.
    let ticks = SIM_HZ / 4;
    let tick = Duration::from_secs_f32(1.0 / SIM_HZ as f32);
    // The furthest that hold can carry the body, which is as far as it is worth
    // probing.
    let reach = (WALK_SPEED * ticks as f32 / SIM_HZ as f32).ceil() as i32;

    // **Which way is there room to walk?** This fixture used to hold RIGHT
    // unconditionally, with `test_config` inheriting `fixed_seed: None` so that
    // the spawn moved run to run. On a seed that spawns the player at
    // `MAP_SMALL_W - WALL_W - PLAYER_W / 2` — the right wall —
    // `physics/resolve.rs::clamp_to_world` holds `vel.x <= 0`, so holding RIGHT
    // is a no-op by construction and the test failed "from 2032 to 2032". It was
    // carried as a load flake on D-58's list; it is not flaky, it is a fixture
    // that assumed a direction (T20.20). `min_x` and `max_x` are one expression
    // in `clamp_to_world` with the velocity clamp mirrored, so the left wall at
    // `WALL_W + PLAYER_W / 2` is the same trap. The wall test below reproduces
    // the original failure message on demand, on every seed.
    let (dir, room_px) = room
        .inspect(move |w| {
            let body = w
                .player(id)
                .map(|p| p.body)
                .expect("the player is in the world");
            let right = room_for(&w.map, &body, 1.0, reach);
            let left = room_for(&w.map, &body, -1.0, reach);
            if right >= left {
                (1.0f32, right)
            } else {
                (-1.0f32, left)
            }
        })
        .await
        .expect("alive");

    // **The control on the probe**, so the fix cannot decay into "push whichever
    // way happens to work". D-29: say which situation was unavailable rather
    // than measuring a worse one — a body wedged with walls both sides is a
    // fixture with nowhere to walk, not a command path that dropped inputs.
    assert!(
        room_px >= PLAYER_W as i32,
        "nowhere to walk: {room_px} px of room in the better direction, against \
         a {PLAYER_W} px body — no held input could move this player, so this \
         test would say nothing about the command path"
    );

    let held = if dir > 0.0 {
        button::RIGHT
    } else {
        button::LEFT
    };
    let before = room
        .inspect(move |w| w.player(id).map(|p| p.body.pos.x).unwrap_or(0.0))
        .await
        .expect("alive");

    for seq in 1..=ticks {
        room.send(Command::Input(id, vec![Input::new(seq, held, 0)]));
        tokio::time::sleep(tick).await;
    }
    let after = room
        .inspect(move |w| w.player(id).map(|p| p.body.pos.x).unwrap_or(0.0))
        .await
        .expect("alive");

    (dir, room_px, before, after)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commands_sent_between_ticks_are_all_applied() {
    let (room, _shut) = room();
    let id = room
        .join("ana".into(), Default::default())
        .await
        .expect("seated");
    start_round(&room, id).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let (dir, room_px, before, after) = walk_where_there_is_room(&room, id).await;

    // Displacement, not instantaneous velocity: GROUND_FRICTION zeroes vel.x
    // within ~0.1 s of the last input, so a velocity assertion measured after the
    // sleep reads 0 whether or not the inputs ever arrived.
    //
    // Signed by the direction that was chosen, so pushing left and drifting
    // right cannot pass.
    assert!(
        (after - before) * dir > 1.0,
        "held {} with {room_px} px of room and moved the player from {before} to {after}",
        if dir > 0.0 { "right" } else { "left" }
    );
}

/// **The failure the test above carried on D-58's list, staged deliberately.**
///
/// A pinned seed alone would make that test pass without making it correct: the
/// next map change re-rolls the spawn, and nothing would notice until the flake
/// came back. This puts the player *on* the wall on every run and every seed, so
/// the direction probe is exercised in the state that used to break it rather
/// than in whatever state the seed happened to hand over.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_player_spawned_against_the_wall_is_still_walked() {
    let (room, _shut) = room();
    let id = room
        .join("ana".into(), Default::default())
        .await
        .expect("seated");
    start_round(&room, id).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Push the body well past the right edge and let the production clamp put
    // it where it belongs — restating `clamp_to_world`'s arithmetic here would
    // be a second copy of the thing under discussion.
    let width = room
        .inspect(move |w| {
            let w_px = w.map.mask.w as f32;
            if let Some(p) = w.player_mut(id) {
                p.body.pos.x = w_px * 2.0;
                p.body.vel = game_core::math::Vec2::ZERO;
            }
            w_px
        })
        .await
        .expect("alive");
    // `World::step` integrates a player inside `apply_input`, so a player with
    // nothing queued is never moved and never clamped: the empty inputs are what
    // makes the clamp run.
    let tick = Duration::from_secs_f32(1.0 / SIM_HZ as f32);
    for seq in 1..=SIM_HZ / 10 {
        room.send(Command::Input(id, vec![Input::new(seq, 0, 0)]));
        tokio::time::sleep(tick).await;
    }
    let at_wall = room
        .inspect(move |w| w.player(id).map(|p| p.body.pos.x).unwrap_or(0.0))
        .await
        .expect("alive");
    // The number the original failure reported, derived rather than typed: on a
    // Small map this is 2048 - 8 - 8 = 2032.
    assert_eq!(
        at_wall,
        width - WALL_W as f32 - PLAYER_W / 2.0,
        "the clamp did not put the body on the right wall, so this test is not \
         standing where the failure stood"
    );

    let (dir, room_px, before, after) = walk_where_there_is_room(&room, id).await;

    assert!(
        dir < 0.0,
        "the probe chose RIGHT with the right wall {room_px} px away"
    );
    assert!(
        (after - before) * dir > 1.0,
        "held left off the right wall with {room_px} px of room and moved the \
         player from {before} to {after}"
    );
}

/// One noisy client must not be able to stop the world.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_flood_of_commands_does_not_stall_the_tick_loop() {
    let (room, _shut) = room();
    let id = room
        .join("ana".into(), Default::default())
        .await
        .expect("seated");
    let before = room.join_info().await.expect("alive").tick;

    for seq in 1..=10_000u32 {
        room.send(Command::Input(id, vec![Input::new(seq, 0, 0)]));
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = room.join_info().await.expect("alive").tick;

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
    // "Alive" is `join_info` answering, not `inspect`. §E1 makes `inspect`
    // answer `None` for a *living* lobby, so spelling liveness that way asserts
    // the room is dead the moment it is behaving correctly.
    assert!(room.join_info().await.is_some(), "running");

    let _ = shut.send(());
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The task is gone, so `inspect` can no longer be answered.
    let answered = tokio::time::timeout(Duration::from_millis(300), room.join_info())
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
    room.join("ana".into(), Default::default())
        .await
        .expect("seated");
    // AppState is untouched by a join: the room is the authority, and the count is
    // maintained by the socket layer (T6.03), not by the room.
    assert_eq!(state.players(), 0);
}

/// **The seed is stated, not inherited** (T20.18/T20.20).
#[test]
fn the_fixture_states_its_seed() {
    common::assert_seed_is_stated(&test_config());
}
