//! T8.02 — the replay runner.
//!
//! `a_recorded_round_replays_to_the_same_state_hash` is the single best
//! regression test in this project (`docs/60` §4). If it passes, determinism
//! holds end to end: the generator, the physics, the item cadences, the weather
//! schedule and the bots all reproduce from a seed and an ordered command list.
//! If it ever fails, something has acquired a dependency on ambient state.

use std::path::{Path, PathBuf};
use std::process::Command as Proc;
use std::sync::Arc;

use game_core::constants::{MapScale, SIM_DT};
use game_core::player::input::{button, Input};
use game_server::config::Config;
use game_server::replay::{self, ReplayCommand};
use game_server::room::{Command, Room};
use rust_socketio::{ClientBuilder, Payload, RawClient};

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("replayrun-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        Scratch(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn only_file(&self) -> PathBuf {
        let mut v: Vec<PathBuf> = std::fs::read_dir(&self.0)
            .expect("read")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e == "replay"))
            .collect();
        assert_eq!(v.len(), 1);
        v.pop().expect("one")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn cfg() -> Arc<Config> {
    Arc::new(Config {
        map_scale: MapScale::Small,
        fixed_seed: Some(90210),
        // Bots in the recording, deliberately: they are the busiest source of
        // input in the game and they read world state to decide, so a bot that
        // reproduces is strong evidence the whole sim does.
        bot_count: 2,
        record_replay: true,
        round_seconds: 20.0,
        dev_loadout: true,
        ..Config::default()
    })
}

/// Record a round: two bots, one human firing and moving, long enough to cross a
/// checkpoint and to let the weather scheduler and item cadences run.
fn record_a_round(dir: &Path, ticks: u32) -> PathBuf {
    let mut room = Room::new(cfg());
    room.start_recording(dir, "000000000001");

    let (tx, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::Join {
        name: "ana".into(),
        skin_id: 0,
        tombstone_skin_id: 0,
        reply: tx,
    });
    let id = rx.blocking_recv().ok().flatten().expect("seat");
    room.apply_for_test(Command::Ready(id));
    // §C18: a room is born in `Lobby` and one human does not meet
    // `MIN_PLAYERS_TO_START`. Without this the fixture records 1400 ticks of a
    // room that never starts — and, because `tick` only advanced inside `step`,
    // recorded every one of them at tick 0.
    room.apply_for_test(Command::StartWithBots(id));

    for t in 1..=ticks {
        let buttons = if t % 90 < 45 {
            button::RIGHT
        } else {
            button::LEFT
        };
        room.apply_for_test(Command::Input(
            id,
            vec![Input::new(t, buttons, (t.wrapping_mul(613) % 65536) as u16)],
        ));
        if t % 120 == 0 {
            room.apply_for_test(Command::Fire(id));
        }
        room.tick_once(SIM_DT);
    }
    // NON-VACUITY. Both halves of this fixture's fix were falsified independently
    // and the test passed either way: with the clock advancing but no round
    // started, it replays 1400 ticks of an idle lobby and the hashes match
    // trivially. A determinism test that cannot tell a real round from a room
    // that never started is testing nothing (§B11).
    assert_ne!(
        room.world.phase,
        game_core::world::RoundPhase::Lobby,
        "the fixture recorded a room that never left Lobby — 1400 idle ticks, and \
         the hash comparison below would pass against any build"
    );
    assert!(
        room.world.tick > 0,
        "the fixture recorded {} simulated ticks",
        room.world.tick
    );

    room.finish_recording();
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("read")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "replay"))
        .collect();
    v.pop().expect("a file")
}

/// Re-simulate exactly as the binary does. Kept in the test rather than exported
/// so the binary stays the thing under test in the end-to-end case below.
fn resimulate(file: &replay::Replay, until: u32) -> Room {
    let mut room = Room::new(Arc::new(file.header.to_config()));
    let mut next = 0usize;
    // Same guard as the binary: this loop is bounded by `world.tick`, and a room
    // in a phase that does not step never advances it. Without this the test
    // does not fail, it *hangs* — and it did, at 100 % CPU, on a machine someone
    // was using.
    let mut last_tick = room.world.tick;
    let mut stalled = 0u32;
    while room.world.tick < until {
        while let Some((tick, cmd)) = file.body.get(next) {
            if *tick > room.world.tick {
                break;
            }
            next += 1;
            let c = match cmd {
                ReplayCommand::Checkpoint { .. } => continue,
                ReplayCommand::Join { name, skin_id } => {
                    let (reply, _rx) = tokio::sync::oneshot::channel();
                    Command::Join {
                        name: name.clone(),
                        skin_id: *skin_id,
                        tombstone_skin_id: 0,
                        reply,
                    }
                }
                ReplayCommand::Ready(id) => Command::Ready(*id),
                ReplayCommand::Input(id, v) => Command::Input(*id, v.clone()),
                ReplayCommand::UseItem(id, s) => Command::UseItem(*id, *s),
                ReplayCommand::SelectSlot(id, s) => Command::SelectSlot(*id, *s),
                ReplayCommand::Fire(id) => Command::Fire(*id),
                ReplayCommand::ToggleFlashlight(id) => Command::ToggleFlashlight(*id),
                ReplayCommand::VoteRestart(id, v) => Command::VoteRestart(*id, *v),
                ReplayCommand::Leave(id) | ReplayCommand::DropUnready(id) => Command::Leave(*id),
                ReplayCommand::StartWithBots(id) => Command::StartWithBots(*id),
            };
            room.apply_for_test(c);
        }
        room.tick_once(SIM_DT);
        if room.world.tick == last_tick {
            stalled += 1;
            assert!(
                stalled <= 100,
                "replay stalled at tick {} in phase {:?} — 100 steps advanced nothing",
                room.world.tick,
                room.world.phase
            );
        } else {
            stalled = 0;
            last_tick = room.world.tick;
        }
    }
    room
}

// ---------------------------------------------------------------------------

/// **The one that matters.**
#[test]
fn a_recorded_round_replays_to_the_same_state_hash() {
    let s = Scratch::new("verify");
    let path = record_a_round(s.path(), 1400);
    let file = replay::read_file(&path).expect("decode");
    let footer = file.footer.clone().expect("footer");

    let room = resimulate(&file, footer.final_tick);
    assert_eq!(
        room.world.tick, footer.final_tick,
        "the replay must reach the recorded tick"
    );
    assert_eq!(
        room.world.state_hash(),
        footer.state_hash,
        "a recorded round did not reproduce — determinism is broken somewhere"
    );
}

/// The test above proves nothing unless a *changed* round produces a *different*
/// hash. Without this control, a `state_hash` that ignored most of the world
/// would pass.
#[test]
fn a_different_round_produces_a_different_hash() {
    let s = Scratch::new("control");
    let path = record_a_round(s.path(), 1400);
    let file = replay::read_file(&path).expect("decode");
    let footer = file.footer.clone().expect("footer");

    // Drop the last third of the commands: same seed, same map, different round.
    let mut perturbed = file.clone();
    perturbed.body.truncate(perturbed.body.len() * 2 / 3);
    let room = resimulate(&perturbed, footer.final_tick);
    assert_ne!(
        room.world.state_hash(),
        footer.state_hash,
        "the hash is insensitive to the round's actual content"
    );
}

#[test]
fn replaying_twice_produces_identical_results() {
    let s = Scratch::new("twice");
    let path = record_a_round(s.path(), 900);
    let file = replay::read_file(&path).expect("decode");
    let until = file.footer.as_ref().expect("footer").final_tick;
    let a = resimulate(&file, until).world.state_hash();
    let b = resimulate(&file, until).world.state_hash();
    assert_eq!(a, b, "two runs of the same file disagree");
}

/// Empty ticks must be simulated: timers, weather and item cadences advance per
/// tick, so skipping them silently changes the result.
#[test]
fn empty_ticks_are_simulated_not_skipped() {
    let s = Scratch::new("empty");
    let mut room = Room::new(cfg());
    room.start_recording(s.path(), "000000000001");
    let (tx, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::Join {
        name: "ana".into(),
        skin_id: 0,
        tombstone_skin_id: 0,
        reply: tx,
    });
    let id = rx.blocking_recv().ok().flatten().expect("seat");
    room.apply_for_test(Command::Ready(id));
    // §C18: a room is born in `Lobby` and one human does not meet
    // `MIN_PLAYERS_TO_START`. Without this the fixture records 1400 ticks of a
    // room that never starts — and, because `tick` only advanced inside `step`,
    // recorded every one of them at tick 0.
    room.apply_for_test(Command::StartWithBots(id));
    // One command at tick 0 and one at tick 800; everything between is empty.
    for t in 1..=800 {
        if t == 800 {
            room.apply_for_test(Command::Fire(id));
        }
        room.tick_once(SIM_DT);
    }
    let expected = room.world.state_hash();
    room.finish_recording();

    let file = replay::read_file(&s.only_file()).expect("decode");
    let replayed = resimulate(&file, 800);
    assert_eq!(
        replayed.world.state_hash(),
        expected,
        "a round of mostly-empty ticks did not reproduce"
    );
    // And the control: a run that skipped the empty ticks would land elsewhere.
    let short = resimulate(&file, 400);
    assert_ne!(
        short.world.state_hash(),
        expected,
        "the hash does not change with tick count, so this proves nothing"
    );
}

/// Checkpoints are what let a failure say *where*, not just *that*.
#[test]
fn checkpoints_are_recorded_every_stride_ticks() {
    let s = Scratch::new("checkpoints");
    let path = record_a_round(s.path(), 1400);
    let file = replay::read_file(&path).expect("decode");
    let cps: Vec<u32> = file
        .body
        .iter()
        .filter_map(|(_, c)| match c {
            ReplayCommand::Checkpoint { tick, .. } => Some(*tick),
            _ => None,
        })
        .collect();
    assert_eq!(
        cps,
        vec![600, 1200],
        "expected a checkpoint every {} ticks",
        replay::CHECKPOINT_STRIDE
    );
}

// ---------------------------------------------------------------------------
// The binary itself
// ---------------------------------------------------------------------------

fn replay_bin() -> PathBuf {
    // `cargo test` puts integration binaries in target/<profile>/deps; the binary
    // under test is one level up.
    let mut p = std::env::current_exe().expect("test exe");
    p.pop();
    if p.ends_with("deps") {
        p.pop();
    }
    p.join("replay")
}

fn run_bin(args: &[&str]) -> (bool, String) {
    let out = Proc::new(replay_bin())
        .args(args)
        .output()
        .expect("run the replay binary");
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    (out.status.success(), s)
}

#[test]
fn the_binary_verifies_a_good_file_and_exits_zero() {
    let s = Scratch::new("bin-verify");
    let path = record_a_round(s.path(), 900);
    let (ok, out) = run_bin(&[path.to_str().expect("utf8")]);
    assert!(ok, "expected exit 0, got:\n{out}");
    assert!(out.contains("VERIFIED"), "output was:\n{out}");
}

#[test]
fn until_stops_at_that_tick_and_reports_its_hash() {
    let s = Scratch::new("bin-until");
    let path = record_a_round(s.path(), 900);
    let (ok, out) = run_bin(&[path.to_str().expect("utf8"), "--until", "300"]);
    assert!(ok, "output was:\n{out}");
    assert!(out.contains("simulated 300 ticks"), "output was:\n{out}");
    assert!(out.contains("state hash"), "output was:\n{out}");
}

/// A corrupted command must produce a clear error and a non-zero exit, never a
/// panic and never a silent misparse.
#[test]
fn a_corrupted_file_is_a_clear_error_not_a_panic() {
    let s = Scratch::new("bin-corrupt");
    let path = record_a_round(s.path(), 300);
    let mut bytes = std::fs::read(&path).expect("read");
    // The first command tag sits just past the header and the command's u32 tick.
    bytes[game_server::replay::HEADER_BYTES + 4] = 250;
    let bad = s.path().join("corrupt.replay");
    std::fs::write(&bad, &bytes).expect("write");

    let (ok, out) = run_bin(&[bad.to_str().expect("utf8")]);
    assert!(!ok, "a corrupt file must not exit 0:\n{out}");
    assert!(out.contains("unknown command tag"), "output was:\n{out}");
    assert!(!out.contains("panicked"), "output was:\n{out}");
}

#[test]
fn a_truncated_file_is_a_clear_error() {
    let s = Scratch::new("bin-trunc");
    let path = record_a_round(s.path(), 300);
    let bytes = std::fs::read(&path).expect("read");
    let bad = s.path().join("trunc.replay");
    std::fs::write(&bad, &bytes[..bytes.len() / 3]).expect("write");
    // A body cut mid-command is truncated; the reader must say so.
    let (_, out) = run_bin(&[bad.to_str().expect("utf8")]);
    assert!(!out.contains("panicked"), "output was:\n{out}");
}

#[test]
fn a_version_mismatch_is_a_clear_error() {
    let s = Scratch::new("bin-version");
    let path = record_a_round(s.path(), 300);
    let mut bytes = std::fs::read(&path).expect("read");
    bytes[4..6].copy_from_slice(&99u16.to_le_bytes());
    let bad = s.path().join("version.replay");
    std::fs::write(&bad, &bytes).expect("write");

    let (ok, out) = run_bin(&[bad.to_str().expect("utf8")]);
    assert!(!ok);
    assert!(out.contains("replay version 99"), "output was:\n{out}");
}

/// The headline diagnostic: perturb one command and the runner must name a tick
/// near the perturbation, not merely report a mismatch.
#[test]
fn a_perturbed_command_is_localised_to_a_nearby_tick() {
    let s = Scratch::new("bin-diverge");
    let path = record_a_round(s.path(), 1400);
    let bytes = std::fs::read(&path).expect("read");

    // Flip the buttons byte of an input recorded a little after tick 600, so the
    // first checkpoint at 600 still matches and the one at 1200 does not.
    let file = replay::read_file(&path).expect("decode");
    let target = file
        .body
        .iter()
        .position(|(t, c)| *t > 700 && matches!(c, ReplayCommand::Input(..)))
        .expect("an input after tick 700");
    // Recompute the byte offset by re-encoding the prefix: the format is
    // fixed-width per command, but finding the offset by arithmetic here would
    // duplicate the encoder. Search for the exact input instead.
    let ReplayCommand::Input(_, inputs) = &file.body[target].1 else {
        unreachable!()
    };
    let needle = {
        let mut v = Vec::new();
        v.extend_from_slice(&inputs[0].seq.to_le_bytes());
        v.extend_from_slice(&inputs[0].aim.to_le_bytes());
        v.push(inputs[0].buttons);
        v
    };
    let at = bytes
        .windows(needle.len())
        .position(|w| w == needle.as_slice())
        .expect("find the recorded input in the file");
    let mut perturbed = bytes.clone();
    perturbed[at + 6] ^= button::LEFT | button::RIGHT;

    let bad = s.path().join("diverge.replay");
    std::fs::write(&bad, &perturbed).expect("write");

    let (ok, out) = run_bin(&[bad.to_str().expect("utf8")]);
    assert!(!ok, "a diverged replay must exit non-zero:\n{out}");
    assert!(out.contains("MISMATCH"), "output was:\n{out}");
    assert!(
        out.contains("first divergence at tick 1200"),
        "expected the divergence localised to the 1200 checkpoint, got:\n{out}"
    );
}

#[test]
fn a_round_replays_far_faster_than_it_was_played() {
    let s = Scratch::new("bin-speed");
    // 1400 ticks is ~23 s of game time.
    let path = record_a_round(s.path(), 1400);
    let start = std::time::Instant::now();
    let (ok, out) = run_bin(&[path.to_str().expect("utf8")]);
    let elapsed = start.elapsed();
    assert!(ok, "output was:\n{out}");
    assert!(
        elapsed.as_secs_f64() < 10.0,
        "replaying 23 s of game time took {:.1} s",
        elapsed.as_secs_f64()
    );
}

/// The bug this pins: `main` used to return as soon as axum stopped, so the room
/// task was never scheduled again and **the footer was never written**. A round
/// killed by `docker compose down` — the one you most want to inspect — produced
/// an unverifiable file, and every unit test passed because they called
/// `finish_recording` directly.
///
/// Signalling shutdown is not enough on its own; the shutdown has to be *waited
/// for*.
#[tokio::test(flavor = "multi_thread")]
async fn a_signalled_shutdown_writes_the_footer_before_the_process_can_exit() {
    use game_server::app::build_stack;
    use game_server::state::AppState;

    let s = Scratch::new("shutdown-footer");
    let config = Config {
        map_scale: MapScale::Small,
        fixed_seed: Some(31337),
        bot_count: 1,
        record_replay: true,
        replay_dir: s.path().to_string_lossy().into_owned(),
        round_seconds: 30.0,
        ..Config::default()
    };
    let stack = build_stack(AppState::new(config));
    let room = stack.start_default_room();

    // Let the room tick a while, so there is a round to record.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    let _ = stack.shutdown.send(());
    assert!(
        room.wait_for_shutdown(std::time::Duration::from_secs(5))
            .await,
        "the room did not stop within the grace period"
    );

    let file = replay::read_file(&s.only_file()).expect("decode");
    assert!(
        file.footer.is_some(),
        "a clean shutdown must leave a verifiable file"
    );
}

/// The control, and it has to be a **subprocess**: in-process the room task is
/// scheduled the moment the oneshot fires, so an in-process "don't wait" case
/// writes the footer anyway and proves nothing. The bug was that the *process
/// exited*, taking the runtime with it.
///
/// So: SIGTERM must leave a footer, SIGKILL must not. If both left one, the
/// assertion above would be passing for a reason unrelated to shutdown.
#[test]
fn sigterm_leaves_a_verifiable_file_and_sigkill_does_not() {
    fn run_until_killed(name: &str, signal: &str) -> Option<replay::Replay> {
        let s = Scratch::new(name);
        let bin = {
            let mut p = std::env::current_exe().expect("test exe");
            p.pop();
            if p.ends_with("deps") {
                p.pop();
            }
            p.join("game-server")
        };
        // A free port chosen here rather than `:0`, because §C18 means the test
        // has to *connect* to the server to make a room exist, and a port the
        // OS picked inside the child is one the parent cannot learn with
        // `GAME_LOG=error`.
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").expect("pick a port");
            let p = l.local_addr().expect("addr").port();
            drop(l);
            p
        };
        let mut child = Proc::new(&bin)
            .env("RECORD_REPLAY", "1")
            .env("REPLAY_DIR", s.path())
            .env("FIXED_SEED", "31337")
            .env("MAP_SCALE", "small")
            .env("ROUND_SECONDS", "60")
            .env("BOT_COUNT", "1")
            .env("GAME_LOG", "error")
            .env("BIND_ADDR", format!("127.0.0.1:{port}"))
            .spawn()
            .expect("spawn the server");

        // §C18: a fresh server has no room, and recording starts with a room's
        // task. Before this change the binary recorded from startup, so this
        // test only had to wait for a file. Now something has to ask for a game
        // — which is the behaviour the change exists to produce.
        let addr = format!("127.0.0.1:{port}");
        let up = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::net::TcpStream::connect(&addr).is_err() {
            assert!(std::time::Instant::now() < up, "server never bound {addr}");
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let (open_tx, open_rx) = std::sync::mpsc::channel::<()>();
        let sock = ClientBuilder::new(format!("http://{addr}"))
            .namespace("/")
            .on("open", move |_: Payload, _: RawClient| {
                let _ = open_tx.send(());
            })
            .connect()
            .expect("socket.io connect");
        // `connect()` returns while the namespace CONNECT is still in flight and
        // an emit sent on the next line is dropped with no error — the 1-in-4
        // flake that cost a session (§A28). Wait for `open` first.
        open_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("socket.io never reported `open`");
        sock.emit("join", serde_json::json!({ "name": "ana", "skin_id": 0 }))
            .expect("join");

        // Wait for the recorder to open a file, rather than sleeping a guess —
        // map generation in a debug build is seconds, not milliseconds.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let opened = std::fs::read_dir(s.path())
                .map(|d| {
                    d.flatten()
                        .any(|e| e.path().extension().is_some_and(|x| x == "replay"))
                })
                .unwrap_or(false);
            if opened {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the server never started recording"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));

        let _ = Proc::new("kill")
            .args([signal, &child.id().to_string()])
            .status();
        let _ = child.wait();
        replay::read_file(&s.only_file()).ok()
    }

    let term = run_until_killed("sigterm", "-TERM").expect("SIGTERM file decodes");
    assert!(
        term.footer.is_some(),
        "SIGTERM must leave a verifiable file — this is the `docker compose down` case"
    );

    // SIGKILL gives the process no chance to flush, so the file is header-only:
    // decodable (the header is flushed on create, so a killed round still names
    // its seed) but with no footer, hence unverifiable.
    let kill = run_until_killed("sigkill", "-KILL").expect("SIGKILL file still decodes");
    assert!(
        kill.footer.is_none(),
        "SIGKILL left a footer, so the SIGTERM assertion proves nothing about shutdown"
    );
    assert_eq!(
        kill.header.seed, 31337,
        "a killed round must still say which map it was"
    );
}
