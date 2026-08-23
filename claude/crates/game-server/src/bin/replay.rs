//! Re-simulate a recorded round headlessly. No networking, no clock, no sleeping.
//!
//! This is the payoff for every determinism decision in the project. The workflow
//! it exists for is *"the map broke around two minutes in"* → replay to tick 7200,
//! dump the PNG, look at it. That replaces a reproduction attempt with an
//! observation.
//!
//! When the hash does not match, the useful output is not "mismatch" — it is the
//! **tick where the two runs first diverge**, which usually names the subsystem
//! on its own.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use game_core::constants::SIM_DT;
use game_server::replay::{self, Replay, ReplayCommand};
use game_server::room::{Command, Room};

/// Steps that may advance nothing before the runner calls it a stall.
///
/// Generous on purpose: a real phase transition can leave the clock still for a
/// step or two, and a false stall would be worse than the hang it replaces —
/// it would blame a recording that is fine.
const STALL_LIMIT: u32 = 100;

const USAGE: &str = "\
usage: replay <file> [flags]

  --until <tick>     stop at this tick and report the state hash there
  --dump-map <tick>  write a PNG of the terrain at this tick (needs dump-png)
  --trace <filter>   re-run under a different GAME_LOG filter
  --verify           compare the final hash against the footer (the default)
  --stats            per-tick timing and command counts
  -h, --help         this
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }

    let opts = match Opts::parse(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("error: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    // `--trace` is a large part of the value: a bug can be investigated at trace
    // level without the original session having been running verbose.
    let filter = opts.trace.clone().unwrap_or_else(|| "warn".to_string());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .try_init();

    match run(&opts) {
        Ok(true) => ExitCode::SUCCESS,
        // A verification failure must be non-zero, so this can gate CI as a
        // determinism regression test.
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}

struct Opts {
    file: PathBuf,
    until: Option<u32>,
    dump_map: Option<u32>,
    trace: Option<String>,
    stats: bool,
}

impl Opts {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut o = Opts {
            file: PathBuf::new(),
            until: None,
            dump_map: None,
            trace: None,
            stats: false,
        };
        let mut i = 0;
        while i < args.len() {
            let a = &args[i];
            let mut value = |what: &str| -> Result<String, String> {
                i += 1;
                args.get(i)
                    .cloned()
                    .ok_or_else(|| format!("{what} needs a value"))
            };
            match a.as_str() {
                "--until" => o.until = Some(parse_tick(&value("--until")?)?),
                "--dump-map" => o.dump_map = Some(parse_tick(&value("--dump-map")?)?),
                "--trace" => o.trace = Some(value("--trace")?),
                "--stats" => o.stats = true,
                // The default; accepted so a script can be explicit.
                "--verify" => {}
                other if other.starts_with('-') => return Err(format!("unknown flag {other}")),
                path => o.file = PathBuf::from(path),
            }
            i += 1;
        }
        if o.file.as_os_str().is_empty() {
            return Err("no replay file given".into());
        }
        Ok(o)
    }
}

fn parse_tick(s: &str) -> Result<u32, String> {
    s.parse::<u32>()
        .map_err(|_| format!("`{s}` is not a tick number"))
}

/// Returns whether verification passed.
fn run(opts: &Opts) -> Result<bool, Box<dyn std::error::Error>> {
    let file = replay::read_file(&opts.file)?;
    let h = &file.header;

    println!(
        "replay {}\n  seed {:#018x}  scale {:?}  round {:.0}s  bots {}  commands {}",
        opts.file.display(),
        h.seed,
        h.scale,
        h.round_seconds,
        h.bot_count,
        file.body.len()
    );

    let stop_at = opts
        .until
        .or(opts.dump_map)
        .or_else(|| file.footer.as_ref().map(|f| f.final_tick))
        .unwrap_or_else(|| file.body.last().map_or(0, |(t, _)| *t));

    let started = std::time::Instant::now();
    let (room, applied) = simulate(&file, stop_at, opts.dump_map, opts.stats)?;
    let elapsed = started.elapsed();

    let hash = room.world.state_hash();
    println!(
        "  simulated {} ticks, applied {} commands in {:.2}s",
        room.world.tick,
        applied,
        elapsed.as_secs_f64()
    );
    println!("  state hash {}", hex(&hash));

    if opts.until.is_some() {
        // Stopping early is a legitimate use, not a failed verification: the
        // footer describes the end of the round, and we did not get there.
        return Ok(true);
    }

    let Some(footer) = &file.footer else {
        println!("  no footer — the round did not shut down cleanly, so there is nothing to verify against");
        return Ok(true);
    };

    if hash == footer.state_hash {
        println!("  VERIFIED — matches the footer");
        return Ok(true);
    }

    println!("  MISMATCH");
    println!("    expected {}", hex(&footer.state_hash));
    println!("    got      {}", hex(&hash));
    match find_divergence(&file, footer.final_tick) {
        Some(tick) => println!(
            "    first divergence at tick {tick} \
             (re-run with --until {tick} --dump-map {tick} to look at it)"
        ),
        None => println!("    could not localise the divergence — it is not reproducible run to run, which points at ambient state rather than at a recorded command"),
    }
    Ok(false)
}

/// Build the room and feed it the recorded commands at their recorded ticks.
///
/// **Every tick is stepped, including empty ones.** Timers, the weather schedule
/// and item cadences all advance per tick, so skipping the ticks with no commands
/// silently changes the result.
fn simulate(
    file: &Replay,
    stop_at: u32,
    dump_at: Option<u32>,
    stats: bool,
) -> Result<(Room, usize), Box<dyn std::error::Error>> {
    let config = Arc::new(file.header.to_config());
    let mut room = Room::new(config);
    let mut applied = 0usize;
    let mut next = 0usize;
    let mut slowest = (0u32, 0.0f64);

    // Commands recorded at tick 0 land before the first step, which is where a
    // join at the very start of a round belongs.
    //
    // The loop is bounded by `world.tick`, so anything that stops advancing it
    // spins here at 100 % CPU forever rather than failing. That is not
    // hypothetical: a `Lobby` room did not step, `tick` is incremented inside
    // `step`, and two of these runners were found alive at ~97 % CPU for 35
    // minutes on a machine someone was playing on. A guard costs one comparison
    // per tick and turns a silent spin into a named error.
    let mut last_tick = room.world.tick;
    let mut stalled = 0u32;
    while room.world.tick < stop_at {
        while let Some((tick, cmd)) = file.body.get(next) {
            if *tick > room.world.tick {
                break;
            }
            next += 1;
            if matches!(cmd, ReplayCommand::Checkpoint { .. }) {
                continue;
            }
            room.apply_for_test(to_command(cmd));
            applied += 1;
        }

        if Some(room.world.tick) == dump_at {
            dump(&room, room.world.tick)?;
        }

        let t0 = std::time::Instant::now();
        room.tick_once(SIM_DT);
        if stats {
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if ms > slowest.1 {
                slowest = (room.world.tick, ms);
            }
        }

        // A few stalled iterations are legitimate — nothing here advances the
        // clock during a phase transition — but a hundred means it never will.
        if room.world.tick == last_tick {
            stalled += 1;
            if stalled > STALL_LIMIT {
                return Err(format!(
                    "replay stalled at tick {} in phase {:?} after {STALL_LIMIT} steps that \
                     advanced nothing — the recording never starts a round, or the room is \
                     in a phase that does not tick ({} of {} commands applied)",
                    room.world.tick,
                    room.world.phase,
                    next,
                    file.body.len()
                )
                .into());
            }
        } else {
            stalled = 0;
            last_tick = room.world.tick;
        }
    }

    // A dump requested at the final tick, after the loop has stopped there.
    if Some(room.world.tick) == dump_at {
        dump(&room, room.world.tick)?;
    }

    if stats {
        println!(
            "  slowest tick {} at {:.2} ms; {} commands remain unapplied",
            slowest.0,
            slowest.1,
            file.body.len() - next
        );
    }
    Ok((room, applied))
}

/// The first recorded checkpoint the runner fails to reproduce.
///
/// The footer alone can only say *that* a replay diverged. The recorded
/// checkpoints (`ReplayCommand::Checkpoint`, one every `CHECKPOINT_STRIDE`
/// ticks) say **where**, and that number usually names the subsystem on its own.
///
/// One pass: simulate, and at each recorded checkpoint tick compare. The first
/// mismatch is the answer, bounded to the `CHECKPOINT_STRIDE` ticks before it.
fn find_divergence(file: &Replay, final_tick: u32) -> Option<u32> {
    let expected: Vec<(u32, [u8; 32])> = file
        .body
        .iter()
        .filter_map(|(_, c)| match c {
            ReplayCommand::Checkpoint { tick, hash } => Some((*tick, *hash)),
            _ => None,
        })
        .collect();
    if expected.is_empty() {
        return None;
    }

    let config = Arc::new(file.header.to_config());
    let mut room = Room::new(config);
    let mut next = 0usize;
    let mut check = 0usize;

    while room.world.tick < final_tick && check < expected.len() {
        while let Some((tick, cmd)) = file.body.get(next) {
            if *tick > room.world.tick {
                break;
            }
            next += 1;
            if matches!(cmd, ReplayCommand::Checkpoint { .. }) {
                continue;
            }
            room.apply_for_test(to_command(cmd));
        }
        room.tick_once(SIM_DT);

        let (at, want) = expected[check];
        if room.world.tick == at {
            if room.world.state_hash() != want {
                return Some(at);
            }
            check += 1;
        }
    }
    // Every checkpoint reproduced but the final hash did not: the divergence is
    // in the tail, after the last checkpoint.
    expected.last().map(|(t, _)| *t)
}

fn dump(room: &Room, tick: u32) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "dump-png")]
    {
        let path = std::path::PathBuf::from(format!("replay-tick-{tick}.png"));
        game_core::map::dump::dump_map(&room.world.map, &path)?;
        println!("  wrote {}", path.display());
        Ok(())
    }
    #[cfg(not(feature = "dump-png"))]
    {
        let _ = (room, tick);
        // Named explicitly rather than failing obscurely three frames deeper.
        Err(
            "this binary was built without the `dump-png` feature; rebuild with \
             `cargo build -p game-server --bin replay --features dump-png`"
                .into(),
        )
    }
}

fn to_command(c: &ReplayCommand) -> Command {
    match c {
        ReplayCommand::Join { name, skin_id } => {
            // The reply goes nowhere: the runner has no socket waiting on an id,
            // and seat allocation is deterministic from the command order, so the
            // replayed room assigns the same id the live one did.
            let (reply, _rx) = tokio::sync::oneshot::channel();
            Command::Join {
                name: name.clone(),
                skin_id: *skin_id,
                // Not recorded, and not needed: a grave's skin is cosmetic and
                // is excluded from `state_hash` for the same reason
                // `PlayerState.skin_id` is. A replay reproduces the simulation,
                // not the palette.
                tombstone_skin_id: 0,
                reply,
            }
        }
        ReplayCommand::Ready(id) => Command::Ready(*id),
        ReplayCommand::Input(id, v) => Command::Input(*id, v.clone()),
        ReplayCommand::UseItem(id, s) => Command::UseItem(*id, *s),
        ReplayCommand::SelectSlot(id, s) => Command::SelectSlot(*id, *s),
        ReplayCommand::UseHeal(id) => Command::UseHeal(*id),
        ReplayCommand::UseBatteryPack(id) => Command::UseBatteryPack(*id),
        ReplayCommand::QuickThrow(id) => Command::QuickThrow(*id),
        ReplayCommand::Fire(id) => Command::Fire(*id),
        ReplayCommand::ToggleFlashlight(id) => Command::ToggleFlashlight(*id),
        ReplayCommand::VoteRestart(id, v) => Command::VoteRestart(*id, *v),
        // A sweep and a leave have the same effect on the world; the distinction
        // is only in why it happened, which the recorder keeps for the reader.
        ReplayCommand::Leave(id) | ReplayCommand::DropUnready(id) => Command::Leave(*id),
        // §C18. Named rather than folded into a catch-all: a `_ =>` here would
        // silently drop the command that *starts the round*, and the replay
        // would sit in an empty lobby and diverge on tick one.
        ReplayCommand::StartWithBots(id) => Command::StartWithBots(*id),
        // Unreachable: filtered out before this is called, because a checkpoint
        // is an observation rather than an input. Mapping it to a no-op command
        // would be a quiet lie about what the file contains.
        ReplayCommand::Checkpoint { .. } => unreachable!("checkpoints are not commands"),
    }
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
