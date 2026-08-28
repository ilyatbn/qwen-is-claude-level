//! T8.01 — the recorder, driven through a real `Room`.
//!
//! The unit tests in `replay.rs` cover the file format. These cover the thing the
//! format exists for: that a room actually writes one, that it contains what the
//! round did, and that it survives the ways a round ends badly.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use game_core::constants::{MapScale, SIM_DT};
use game_core::player::input::{button, Input};
use game_server::config::Config;
use game_server::replay::{self, ReplayCommand};
use game_server::room::{Command, Room};

/// A scratch directory that cleans up after itself, so a failing test does not
/// leave replay files lying around for the next run to trip over.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("replay-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        Scratch(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    /// The single replay file in the directory.
    fn only_file(&self) -> PathBuf {
        let mut files: Vec<PathBuf> = std::fs::read_dir(&self.0)
            .expect("read scratch")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e == "replay"))
            .collect();
        assert_eq!(
            files.len(),
            1,
            "expected exactly one replay in {:?}",
            self.0
        );
        files.pop().expect("one file")
    }
    fn files(&self) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(&self.0)
            .expect("read scratch")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e == "replay"))
            .collect();
        v.sort();
        v
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn cfg(record: bool) -> Arc<Config> {
    Arc::new(Config {
        map_scale: MapScale::Small,
        fixed_seed: Some(4242),
        bot_count: 0,
        record_replay: record,
        round_seconds: 8.0,
        ..Config::default()
    })
}

fn seat(room: &mut Room, name: &str) -> u8 {
    let (tx, rx) = tokio::sync::oneshot::channel();
    room.apply_for_test(Command::Join {
        name: name.to_string(),
        skin_id: 0,
        tombstone_skin_id: 0,
        reply: tx,
    });
    rx.blocking_recv()
        .ok()
        .flatten()
        .expect("a seat was available")
}

#[test]
fn a_recording_room_writes_a_file_with_a_valid_header() {
    let s = Scratch::new("header");
    let mut room = Room::new(cfg(true));
    room.start_recording(s.path(), "000000000001");
    room.finish_recording();

    let r = replay::read_file(&s.only_file()).expect("decode");
    assert_eq!(r.header.seed, 4242);
    assert_eq!(r.header.scale, MapScale::Small);
    assert_eq!(r.header.round_seconds, 8.0);
    assert_eq!(r.header.version, replay::REPLAY_VERSION);
}

#[test]
fn record_replay_off_writes_nothing_at_all() {
    let s = Scratch::new("off");
    let mut room = Room::new(cfg(false));
    room.start_recording(s.path(), "000000000001");
    let id = seat(&mut room, "ana");
    room.apply_for_test(Command::Ready(id, true));
    room.apply_for_test(Command::Fire(id));
    room.finish_recording();

    assert!(
        s.files().is_empty(),
        "RECORD_REPLAY=0 must not create a file"
    );
}

#[test]
fn the_replay_directory_is_created_if_it_does_not_exist() {
    let s = Scratch::new("mkdir");
    let nested = s.path().join("a/b/c");
    assert!(!nested.exists());
    let mut room = Room::new(cfg(true));
    room.start_recording(&nested, "000000000001");
    room.finish_recording();
    assert!(nested.exists(), "start_recording must create the directory");
}

#[test]
fn commands_are_recorded_and_the_file_grows() {
    let s = Scratch::new("grows");
    let mut room = Room::new(cfg(true));
    room.start_recording(s.path(), "000000000001");

    let id = seat(&mut room, "ana");
    room.apply_for_test(Command::Ready(id, true));
    for seq in 1..=20 {
        room.apply_for_test(Command::Input(id, vec![Input::new(seq, button::RIGHT, 0)]));
        room.tick_once(SIM_DT);
    }
    let before = room.recorded_commands();
    assert!(before >= 22, "join + ready + 20 inputs, got {before}");
    room.finish_recording();

    let r = replay::read_file(&s.only_file()).expect("decode");
    assert!(matches!(r.body[0].1, ReplayCommand::Join { .. }));
    assert!(matches!(r.body[1].1, ReplayCommand::Ready(_)));
    let inputs = r
        .body
        .iter()
        .filter(|(_, c)| matches!(c, ReplayCommand::Input(..)))
        .count();
    assert_eq!(inputs, 20);
}

/// The point of recording "as applied": a replay must not re-simulate input the
/// live round rejected.
#[test]
fn rejected_input_is_not_recorded() {
    let s = Scratch::new("rejected");
    let mut room = Room::new(cfg(true));
    room.start_recording(s.path(), "000000000001");
    let id = seat(&mut room, "ana");
    room.apply_for_test(Command::Ready(id, true));

    // seq 5 accepted, then 3 and 5 again — both stale, both must vanish.
    room.apply_for_test(Command::Input(id, vec![Input::new(5, button::RIGHT, 0)]));
    room.apply_for_test(Command::Input(
        id,
        vec![
            Input::new(3, button::LEFT, 0),
            Input::new(5, button::LEFT, 0),
        ],
    ));
    room.finish_recording();

    let r = replay::read_file(&s.only_file()).expect("decode");
    let recorded: Vec<&ReplayCommand> = r
        .body
        .iter()
        .map(|(_, c)| c)
        .filter(|c| matches!(c, ReplayCommand::Input(..)))
        .collect();
    assert_eq!(recorded.len(), 1, "only the accepted batch is recorded");
    match recorded[0] {
        ReplayCommand::Input(_, v) => {
            assert_eq!(v.len(), 1);
            assert_eq!(v[0].seq, 5);
        }
        other => panic!("wrong command {other:?}"),
    }
}

/// `sweep_unready` fires on wall-clock elapsed time. A replay has no clock, so
/// its effect must be in the file or a replayed round keeps a seat the live one
/// freed.
#[test]
fn an_unready_sweep_is_recorded_because_a_replay_has_no_clock() {
    let s = Scratch::new("sweep");
    let mut room = Room::new(cfg(true));
    room.start_recording(s.path(), "000000000001");
    let _id = seat(&mut room, "ghost");
    // Zero timeout: everyone unready is stale immediately.
    let dropped = room.sweep_unready_for_test(std::time::Duration::from_secs(0));
    assert_eq!(dropped.len(), 1, "the unready player was swept");
    room.finish_recording();

    let r = replay::read_file(&s.only_file()).expect("decode");
    assert!(
        r.body
            .iter()
            .any(|(_, c)| matches!(c, ReplayCommand::DropUnready(_))),
        "the sweep's effect is not in the file: {:?}",
        r.body
    );
}

#[test]
fn finish_writes_a_footer_with_the_world_hash_and_scores() {
    let s = Scratch::new("footer");
    let mut room = Room::new(cfg(true));
    // §E1: the recorder opens first (as the room task does), and the match is
    // started because a footer hashes a world.
    room.start_recording(s.path(), "000000000001");
    let w = room.generate_world();
    room.install_world(w);
    let id = seat(&mut room, "ana");
    room.apply_for_test(Command::Ready(id, true));
    for _ in 0..30 {
        room.tick_once(SIM_DT);
    }
    let expected_hash = room.world_for_test().state_hash();
    let expected_tick = room.world_for_test().tick;
    room.finish_recording();

    let r = replay::read_file(&s.only_file()).expect("decode");
    let f = r.footer.expect("a footer");
    assert_eq!(f.state_hash, expected_hash);
    assert_eq!(f.final_tick, expected_tick);
    assert_eq!(f.scores.len(), 1);
    assert_eq!(f.scores[0].0, id);
}

#[test]
fn a_round_with_no_commands_produces_a_valid_minimal_file() {
    let s = Scratch::new("empty");
    let mut room = Room::new(cfg(true));
    // §E1: the recorder opens at construction, as production does — but a
    // *footer* needs a world to hash, and a room that never starts has none. A
    // replay file describes a round, so this fixture starts one.
    room.start_recording(s.path(), "000000000001");
    let w = room.generate_world();
    room.install_world(w);
    for _ in 0..10 {
        room.tick_once(SIM_DT);
    }
    room.finish_recording();

    let r = replay::read_file(&s.only_file()).expect("decode");
    assert!(r.body.is_empty());
    assert!(r.footer.is_some(), "still verifiable");
}

/// A round killed without a clean shutdown still has to be readable — it is the
/// one you most want to inspect.
#[test]
fn a_file_truncated_before_its_footer_still_reads_as_a_replay() {
    let s = Scratch::new("truncated");
    let mut room = Room::new(cfg(true));
    room.start_recording(s.path(), "000000000001");
    let id = seat(&mut room, "ana");
    room.apply_for_test(Command::Ready(id, true));
    for seq in 1..=40 {
        room.apply_for_test(Command::Input(id, vec![Input::new(seq, button::RIGHT, 0)]));
        room.tick_once(SIM_DT);
    }
    room.flush_recording();
    // Drop the writer without `finish`, exactly as a SIGKILL would.
    drop(room);

    let r = replay::read_file(&s.only_file()).expect("decode");
    assert!(!r.body.is_empty(), "the flushed body survived");
    assert!(
        r.footer.is_none(),
        "no footer, so the reader must say so rather than inventing one"
    );
}

/// `docs/61` §4 estimates "a few hundred KB" for a 4-minute 6-player round. That
/// estimate is wrong, and the arithmetic is not close:
///
/// ```text
/// 240 s x 60 Hz x 6 players            = 86,400 accepted inputs
/// 4 (tick) + 1 (tag) + 1 (id) + 1 (n)
///   + 7 (seq u32, aim u16, buttons u8) = 14 bytes each
///                                      = 1.21 MB
/// ```
///
/// A client sends input every tick (`docs/40` §2) and the server accepts one per
/// player per tick (§A30), so 86,400 is the *steady state*, not a worst case.
/// Delta-encoding the tick to one byte would give 0.95 MB, and the `Input`
/// payload the simulation genuinely needs is 0.60 MB on its own — so no framing
/// change reaches "a few hundred KB". The estimate omitted the player count and
/// the input rate.
///
/// The bound this test enforces is therefore **2 MB**, which still catches the
/// thing the bound is for: snapshots or events being recorded, either of which
/// would put this in the tens of megabytes.
#[test]
fn a_four_minute_six_player_round_stays_under_the_size_bound() {
    let s = Scratch::new("size");
    let mut room = Room::new(Arc::new(Config {
        map_scale: MapScale::Small,
        fixed_seed: Some(4242),
        bot_count: 0,
        record_replay: true,
        ..Config::default()
    }));
    room.start_recording(s.path(), "000000000001");

    let ids: Vec<u8> = (0..6).map(|i| seat(&mut room, &format!("p{i}"))).collect();
    for id in &ids {
        room.apply_for_test(Command::Ready(*id, true));
    }
    // 240 s at 60 Hz, every player sending an input every tick — the worst case
    // the format has to hold, not a typical one.
    let ticks = 240 * 60;
    for t in 1..=ticks {
        for id in &ids {
            room.apply_for_test(Command::Input(
                *id,
                vec![Input::new(t, button::RIGHT, (t % 65536) as u16)],
            ));
        }
        // Stepping the world for 14400 ticks would make this test minutes long;
        // the file size is a function of the commands, not of the simulation.
        room.begin_tick_for_test();
    }
    room.finish_recording();

    let bytes = std::fs::metadata(s.only_file()).expect("stat").len();
    assert!(
        bytes < 2_000_000,
        "a 4-minute 6-player round wrote {bytes} bytes, over the 2 MB bound — \
         check nothing derived (snapshots, events) is being recorded"
    );
    // A floor too, so this cannot pass by recording nothing at all. Without it,
    // a recorder that silently stopped after the first command would look ideal.
    assert!(
        bytes > 500_000,
        "only {bytes} bytes — is anything recorded?"
    );
}

/// Recording must not show up in the tick budget.
#[test]
fn recording_costs_under_a_tenth_of_a_millisecond_per_tick() {
    let s = Scratch::new("cost");
    let mut room = Room::new(cfg(true));
    room.start_recording(s.path(), "000000000001");
    let id = seat(&mut room, "ana");
    room.apply_for_test(Command::Ready(id, true));

    let start = std::time::Instant::now();
    for seq in 1..=1000 {
        room.apply_for_test(Command::Input(id, vec![Input::new(seq, button::RIGHT, 0)]));
    }
    let per_command = start.elapsed().as_secs_f64() / 1000.0;
    room.finish_recording();

    assert!(
        per_command < 0.0001,
        "recording cost {:.4} ms per command, over the 0.1 ms bound",
        per_command * 1000.0
    );
}

/// Bots have no socket, so they can never send `ready` — and `sweep_unready`
/// drops every unready seat once the timeout elapses.
///
/// This shipped: the roster went `[0,1,2,3] -> [3]` exactly 30 s into every
/// round, with **no deaths**, and nothing in the log but "dropping: never sent
/// ready". The game quietly became single-player a minute in, which is the sort
/// of thing only playing it finds.
///
/// The control is the second half: a *human* seat that never readies must still
/// be swept, so this cannot pass by disabling the sweep.
#[test]
fn bots_survive_the_unready_sweep_and_humans_who_never_ready_do_not() {
    let mut room = Room::new(Arc::new(Config {
        map_scale: MapScale::Small,
        fixed_seed: Some(4242),
        bot_count: 3,
        round_seconds: 8.0,
        ..Config::default()
    }));
    // §C18: bots are seated when a round starts, not at construction. Without
    // this the sweep has no bots to spare and the test passes for the wrong
    // reason — `left: 0, right: 3`.
    room.request_start();
    // §E1 split "ask for a world" from "build one"; `tick_inline` does both, the
    // way the room task does across a tick and a blocking thread.
    room.tick_inline(game_core::constants::SIM_DT);
    // A human who joins and never sends `ready`.
    let ghost = seat(&mut room, "ghost");

    // Zero timeout: everything unready is stale immediately.
    let dropped = room.sweep_unready_for_test(std::time::Duration::from_secs(0));

    assert_eq!(
        dropped,
        vec![ghost],
        "exactly the unready human should be swept, not the bots"
    );
    assert_eq!(
        room.world_for_test().players.len(),
        3,
        "the three bots must still be in the world after the sweep"
    );
}
