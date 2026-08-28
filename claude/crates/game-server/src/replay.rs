//! Round recording, so a bug can be reproduced from a file instead of a story.
//!
//! This works for exactly one reason: the room task is single-threaded and
//! applies commands in a fixed order (`docs/41-server-loop-rooms.md` §1–§2), so a
//! round is fully determined by its seed plus the ordered command list. Record
//! those and the round replays exactly.
//!
//! The footer's world hash is the thing that keeps that true. If some future
//! change introduces another source of nondeterminism, it shows up here as a
//! mismatch rather than as an unreproducible bug report six months later.
//!
//! **Not recorded:** snapshots and outbound events. They are derived from the
//! state the commands produce, and writing them would multiply the file size for
//! no diagnostic value.

use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use game_core::constants::{MapGenerator, MapScale, SIM_HZ};
use game_core::player::input::Input;
use game_core::player::state::PlayerId;
use game_core::world::World;

use crate::config::Config;

/// `"RPL1"`. A version skew must fail loudly rather than misparse.
pub const REPLAY_MAGIC: u32 = 0x5250_4C31;
/// `"RPLE"` — the footer marker, so a truncated body is distinguishable from a
/// complete file. Without it a file cut short mid-body would read as a valid
/// round that simply ended early, which is the one file you most want to know is
/// broken.
pub const FOOTER_MAGIC: u32 = 0x5250_4C45;
/// Bytes a header occupies on disk: magic 4, version 2, seed 8, buried secret 8,
/// scale 1, generator 1, sim_hz 4, round_seconds 4, max_players 2,
/// min_players_to_start 2 (retired §E2; still written, as 0), bot_count 2,
/// bot_skill 4, dev_loadout 1.
///
/// Public because the body starts here, and a test that wants to corrupt the
/// first command has to know where it is. Two of them used to carry the number
/// inline and both broke the moment the header grew a field.
pub const HEADER_BYTES: usize = 43;

/// **2**: the header gained `generator`. A v1 round replayed against v2 (or the
/// reverse) rebuilds a different map and diverges on the first shot that touches
/// terrain, so the generator is simulation state and belongs here. Version 1 files
/// are rejected rather than silently assumed to be v1 terrain.
pub const REPLAY_VERSION: u16 = 2;

/// Ticks between recorded state hashes — 10 seconds at 60 Hz.
///
/// The runner bisects between the last matching checkpoint and the first failing
/// one, so this bounds how much of the round has to be re-simulated to localise
/// a divergence, not how precisely it can be reported.
pub const CHECKPOINT_STRIDE: u32 = 600;

// ---------------------------------------------------------------------------
// The recordable command
// ---------------------------------------------------------------------------

/// The serialisable subset of [`crate::room::Command`].
///
/// `Command` itself cannot be recorded: `Join` carries a `oneshot::Sender` and
/// `Inspect` carries a closure. Both are transport and test plumbing rather than
/// simulation input, so the boundary is drawn here rather than by making the room
/// hold something serialisable it does not otherwise need.
#[derive(Debug, Clone, PartialEq)]
pub enum ReplayCommand {
    Join {
        name: String,
        skin_id: u16,
    },
    Ready(PlayerId),
    /// Already filtered: duplicates and stale sequences are dropped before they
    /// reach here, so a replay applies exactly the input the live round did.
    Input(PlayerId, Vec<Input>),
    UseItem(PlayerId, u8),
    SelectSlot(PlayerId, u8),
    Fire(PlayerId),
    ToggleFlashlight(PlayerId),
    VoteRestart(PlayerId, bool),
    Leave(PlayerId),
    /// A periodic state hash written by the recorder.
    ///
    /// Not a command — it changes nothing when replayed. It exists because the
    /// footer alone can only say *that* a replay diverged, never *where*, and
    /// "where" is the number that names the subsystem. One 32-byte hash every
    /// `CHECKPOINT_STRIDE` ticks is ~800 bytes for a full round.
    Checkpoint {
        tick: u32,
        hash: [u8; 32],
    },
    /// A player dropped by `sweep_unready`.
    ///
    /// This one is not a client command at all, and it is the reason the enum is
    /// not simply a mirror of `Command`. The sweep fires on **wall-clock**
    /// elapsed time, which a replay has none of, so its effect has to be recorded
    /// or a replayed round keeps a seat the live round freed.
    DropUnready(PlayerId),
    /// `Q` and `R` (§C9). Slotless: heals and batteries are counters, not
    /// inventory, so there is no slot index to record.
    UseHeal(PlayerId),
    UseBatteryPack(PlayerId),
    /// `E` (§C11). Slotless: the slot is chosen by the documented order.
    QuickThrow(PlayerId),
    /// §C10's drag.
    MoveItem(PlayerId, u8, u8),
    /// A player pressed "Start with bots" (§C18).
    ///
    /// It has to be recorded: it seats bots and begins the round, so a replay
    /// that skipped it would sit in an empty lobby for four minutes and diverge
    /// on the first tick.
    StartWithBots(PlayerId),
}

impl ReplayCommand {
    fn tag(&self) -> u8 {
        match self {
            ReplayCommand::Join { .. } => 1,
            ReplayCommand::Ready(_) => 2,
            ReplayCommand::Input(..) => 3,
            ReplayCommand::UseItem(..) => 4,
            ReplayCommand::SelectSlot(..) => 5,
            ReplayCommand::Fire(_) => 6,
            ReplayCommand::ToggleFlashlight(_) => 7,
            ReplayCommand::VoteRestart(..) => 8,
            ReplayCommand::Leave(_) => 9,
            ReplayCommand::DropUnready(_) => 10,
            ReplayCommand::Checkpoint { .. } => 11,
            ReplayCommand::StartWithBots(_) => 12,
            ReplayCommand::UseHeal(_) => 13,
            ReplayCommand::UseBatteryPack(_) => 14,
            ReplayCommand::QuickThrow(_) => 15,
            ReplayCommand::MoveItem(..) => 16,
        }
    }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/// Everything the runner needs to rebuild an identical room.
///
/// This is deliberately the *simulation* half of `Config` and nothing else. A
/// field that cannot change the outcome (`bind_addr`, `game_log`) is not here,
/// because a header field that does not affect replay invites someone to assume
/// it does.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayHeader {
    pub version: u16,
    pub seed: u64,
    /// §A31 — buried slots hang off this, so without it a replay generates a
    /// different set of buried items and diverges the moment one is dug up.
    pub buried_secret: u64,
    pub scale: MapScale,
    /// Which terrain generator built the map. See `REPLAY_VERSION`.
    pub generator: MapGenerator,
    pub sim_hz: u32,
    pub round_seconds: f32,
    pub max_players: usize,
    /// **Retired** (`docs/74` §E2), kept so the format does not move.
    ///
    /// A header records the config that produced *that* round, and files
    /// recorded before §E2 carry a real value here. Dropping the field would
    /// bump `REPLAY_VERSION` and invalidate every one of them to remove a number
    /// nothing reads — the wrong trade. Written as 0 by anything recorded since.
    pub min_players_to_start: usize,
    pub bot_count: usize,
    pub bot_skill: f32,
    pub dev_loadout: bool,
}

impl ReplayHeader {
    pub fn from_config(config: &Config, seed: u64, buried_secret: u64) -> Self {
        ReplayHeader {
            version: REPLAY_VERSION,
            seed,
            buried_secret,
            scale: config.map_scale,
            generator: config.map_generator,
            sim_hz: SIM_HZ,
            round_seconds: config.round_seconds,
            max_players: config.max_players,
            min_players_to_start: 0,
            bot_count: config.bot_count,
            bot_skill: config.bot_skill,
            dev_loadout: config.dev_loadout,
        }
    }

    /// A `Config` that reproduces this round. The transport fields keep their
    /// defaults; nothing in the simulation reads them.
    pub fn to_config(&self) -> Config {
        Config {
            map_scale: self.scale,
            map_generator: self.generator,
            round_seconds: self.round_seconds,
            max_players: self.max_players,
            fixed_seed: Some(self.seed),
            bot_count: self.bot_count,
            bot_skill: self.bot_skill,
            dev_loadout: self.dev_loadout,
            record_replay: false,
            ..Config::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayFooter {
    pub state_hash: [u8; 32],
    pub scores: Vec<(PlayerId, i16)>,
    pub final_tick: u32,
}

/// A whole file, decoded.
#[derive(Debug, Clone, PartialEq)]
pub struct Replay {
    pub header: ReplayHeader,
    pub body: Vec<(u32, ReplayCommand)>,
    /// `None` when the file was truncated before its footer — a crash or a kill
    /// -9 rather than a clean shutdown. Still replayable; just unverifiable.
    pub footer: Option<ReplayFooter>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum ReplayError {
    Io(io::Error),
    BadMagic(u32),
    /// Deliberately distinct from `BadMagic`: a version skew is a routine
    /// consequence of upgrading, and telling someone "this is not a replay file"
    /// when it is one from last week sends them looking in the wrong place.
    BadVersion {
        found: u16,
        expected: u16,
    },
    Truncated {
        need: usize,
        had: usize,
    },
    BadTag(u8),
    BadScale(u8),
    BadGenerator(u8),
    BadUtf8,
}

impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReplayError::Io(e) => write!(f, "io error: {e}"),
            ReplayError::BadMagic(m) => {
                write!(
                    f,
                    "not a replay file (magic {m:#010x}, expected {REPLAY_MAGIC:#010x})"
                )
            }
            ReplayError::BadVersion { found, expected } => write!(
                f,
                "replay version {found}, this build reads version {expected} — \
                 re-record, or check out the build that wrote it"
            ),
            ReplayError::Truncated { need, had } => {
                write!(f, "truncated: needed {need} bytes, had {had}")
            }
            ReplayError::BadTag(t) => write!(f, "unknown command tag {t}"),
            ReplayError::BadScale(s) => write!(f, "unknown map scale {s}"),
            ReplayError::BadGenerator(g) => write!(f, "unknown map generator {g}"),
            ReplayError::BadUtf8 => f.write_str("player name is not valid utf-8"),
        }
    }
}

impl std::error::Error for ReplayError {}

impl From<io::Error> for ReplayError {
    fn from(e: io::Error) -> Self {
        ReplayError::Io(e)
    }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

pub struct ReplayWriter {
    file: BufWriter<File>,
    path: PathBuf,
    pub commands: u64,
}

impl ReplayWriter {
    /// `replays/<timestamp>-<seed>.replay`.
    ///
    /// The timestamp is the caller's, not `SystemTime::now()` here: a recorder
    /// that reads a clock is a recorder that cannot be tested for the same file
    /// name twice, and the runner has no clock at all.
    pub fn create(dir: &Path, stamp: &str, header: &ReplayHeader) -> Result<Self, ReplayError> {
        fs::create_dir_all(dir)?;
        let path = dir.join(format!("{stamp}-{:016x}.replay", header.seed));
        let mut file = BufWriter::new(File::create(&path)?);
        write_header(&mut file, header)?;
        // Flushed immediately, so a round killed with SIGKILL still leaves a file
        // that names its seed and scale. A zero-byte replay tells you nothing at
        // all; a header tells you which map to regenerate.
        file.flush()?;
        Ok(ReplayWriter {
            file,
            path,
            commands: 0,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn record(&mut self, tick: u32, cmd: &ReplayCommand) -> Result<(), ReplayError> {
        put_u32(&mut self.file, tick)?;
        write_command(&mut self.file, cmd)?;
        self.commands += 1;
        Ok(())
    }

    /// Flush without closing — called on phase transitions so a round that dies
    /// mid-`Playing` still has its warmup on disk.
    pub fn flush(&mut self) -> Result<(), ReplayError> {
        self.file.flush()?;
        Ok(())
    }

    pub fn finish(
        mut self,
        world: &World,
        scores: &[(PlayerId, i16)],
    ) -> Result<PathBuf, ReplayError> {
        put_u32(&mut self.file, FOOTER_MAGIC)?;
        put_u32(&mut self.file, world.tick)?;
        self.file.write_all(&world.state_hash())?;
        put_u16(&mut self.file, scores.len() as u16)?;
        for (id, score) in scores {
            self.file.write_all(&[*id])?;
            put_i16(&mut self.file, *score)?;
        }
        self.file.flush()?;
        Ok(self.path)
    }
}

fn write_header(w: &mut impl Write, h: &ReplayHeader) -> Result<(), ReplayError> {
    put_u32(w, REPLAY_MAGIC)?;
    put_u16(w, h.version)?;
    put_u64(w, h.seed)?;
    put_u64(w, h.buried_secret)?;
    w.write_all(&[scale_byte(h.scale)])?;
    w.write_all(&[h.generator.to_u8()])?;
    put_u32(w, h.sim_hz)?;
    put_f32(w, h.round_seconds)?;
    put_u16(w, h.max_players as u16)?;
    // Retired (§E2) but **still in the format**. Written as 0 now; a v2 file
    // recorded before the retirement carries a real value and still parses.
    // Removing the field would shift `bot_count`, `bot_skill` and `dev_loadout`
    // two bytes while `REPLAY_VERSION` still read 2 — the version check would
    // pass and the file would silently misparse.
    put_u16(w, h.min_players_to_start as u16)?;
    put_u16(w, h.bot_count as u16)?;
    put_f32(w, h.bot_skill)?;
    w.write_all(&[u8::from(h.dev_loadout)])?;
    Ok(())
}

fn write_command(w: &mut impl Write, c: &ReplayCommand) -> Result<(), ReplayError> {
    w.write_all(&[c.tag()])?;
    match c {
        ReplayCommand::Join { name, skin_id } => {
            let bytes = name.as_bytes();
            // Names are validated to 1..=16 chars on join; the cap here is a
            // decoder bound, not a policy.
            let n = bytes.len().min(255);
            w.write_all(&[n as u8])?;
            w.write_all(&bytes[..n])?;
            put_u16(w, *skin_id)?;
        }
        ReplayCommand::Ready(id)
        | ReplayCommand::Fire(id)
        | ReplayCommand::ToggleFlashlight(id)
        | ReplayCommand::Leave(id)
        | ReplayCommand::DropUnready(id)
        | ReplayCommand::StartWithBots(id)
        | ReplayCommand::UseHeal(id)
        | ReplayCommand::UseBatteryPack(id)
        | ReplayCommand::QuickThrow(id) => w.write_all(&[*id])?,
        ReplayCommand::Input(id, inputs) => {
            w.write_all(&[*id])?;
            let n = inputs.len().min(255);
            w.write_all(&[n as u8])?;
            for i in &inputs[..n] {
                put_u32(w, i.seq)?;
                put_u16(w, i.aim)?;
                w.write_all(&[i.buttons])?;
            }
        }
        ReplayCommand::UseItem(id, slot) | ReplayCommand::SelectSlot(id, slot) => {
            w.write_all(&[*id, *slot])?
        }
        ReplayCommand::MoveItem(id, from, to) => w.write_all(&[*id, *from, *to])?,
        ReplayCommand::VoteRestart(id, v) => w.write_all(&[*id, u8::from(*v)])?,
        ReplayCommand::Checkpoint { tick, hash } => {
            put_u32(w, *tick)?;
            w.write_all(hash)?;
        }
    }
    Ok(())
}

fn scale_byte(s: MapScale) -> u8 {
    match s {
        MapScale::Small => 0,
        MapScale::Medium => 1,
        MapScale::Large => 2,
    }
}

fn put_u16(w: &mut impl Write, v: u16) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}
fn put_i16(w: &mut impl Write, v: i16) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}
fn put_u32(w: &mut impl Write, v: u32) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}
fn put_u64(w: &mut impl Write, v: u64) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}
fn put_f32(w: &mut impl Write, v: f32) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// A cursor that never indexes without checking.
///
/// Same rule as `codec.rs`: this parses a file a user hands us, and a panic in a
/// parser is a crash in the tool people reach for *because* something is already
/// wrong.
struct Cursor<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], ReplayError> {
        if self.at + n > self.b.len() {
            return Err(ReplayError::Truncated {
                need: self.at + n,
                had: self.b.len(),
            });
        }
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, ReplayError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, ReplayError> {
        let s = self.take(2)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn i16(&mut self) -> Result<i16, ReplayError> {
        let s = self.take(2)?;
        Ok(i16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self) -> Result<u32, ReplayError> {
        let s = self.take(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64(&mut self) -> Result<u64, ReplayError> {
        let s = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        Ok(u64::from_le_bytes(a))
    }
    fn f32(&mut self) -> Result<f32, ReplayError> {
        let s = self.take(4)?;
        Ok(f32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn remaining(&self) -> usize {
        self.b.len().saturating_sub(self.at)
    }
}

pub fn read_file(path: &Path) -> Result<Replay, ReplayError> {
    decode(&fs::read(path)?)
}

pub fn decode(bytes: &[u8]) -> Result<Replay, ReplayError> {
    let mut c = Cursor { b: bytes, at: 0 };

    let magic = c.u32()?;
    if magic != REPLAY_MAGIC {
        return Err(ReplayError::BadMagic(magic));
    }
    let version = c.u16()?;
    if version != REPLAY_VERSION {
        return Err(ReplayError::BadVersion {
            found: version,
            expected: REPLAY_VERSION,
        });
    }
    let header = ReplayHeader {
        version,
        seed: c.u64()?,
        buried_secret: c.u64()?,
        scale: match c.u8()? {
            0 => MapScale::Small,
            1 => MapScale::Medium,
            2 => MapScale::Large,
            other => return Err(ReplayError::BadScale(other)),
        },
        generator: {
            let b = c.u8()?;
            match MapGenerator::from_u8(b) {
                Some(g) => g,
                None => return Err(ReplayError::BadGenerator(b)),
            }
        },
        sim_hz: c.u32()?,
        round_seconds: c.f32()?,
        max_players: c.u16()? as usize,
        min_players_to_start: c.u16()? as usize,
        bot_count: c.u16()? as usize,
        bot_skill: c.f32()?,
        dev_loadout: c.u8()? != 0,
    };

    let mut body = Vec::new();
    let mut footer = None;
    loop {
        if c.remaining() == 0 {
            break;
        }
        // A footer and a body entry both start with a u32. The footer marker is
        // not a plausible tick (it is ~1.38e9, or 266 days of round time), so
        // this is unambiguous in practice — and the version field is what
        // protects it in principle.
        let first = c.u32()?;
        if first == FOOTER_MAGIC {
            let final_tick = c.u32()?;
            let mut hash = [0u8; 32];
            hash.copy_from_slice(c.take(32)?);
            let n = c.u16()? as usize;
            let mut scores = Vec::with_capacity(n.min(256));
            for _ in 0..n {
                scores.push((c.u8()?, c.i16()?));
            }
            footer = Some(ReplayFooter {
                state_hash: hash,
                scores,
                final_tick,
            });
            break;
        }
        body.push((first, read_command(&mut c)?));
    }

    Ok(Replay {
        header,
        body,
        footer,
    })
}

fn read_command(c: &mut Cursor) -> Result<ReplayCommand, ReplayError> {
    let tag = c.u8()?;
    Ok(match tag {
        1 => {
            let n = c.u8()? as usize;
            let name = std::str::from_utf8(c.take(n)?)
                .map_err(|_| ReplayError::BadUtf8)?
                .to_string();
            ReplayCommand::Join {
                name,
                skin_id: c.u16()?,
            }
        }
        2 => ReplayCommand::Ready(c.u8()?),
        3 => {
            let id = c.u8()?;
            let n = c.u8()? as usize;
            let mut v = Vec::with_capacity(n);
            for _ in 0..n {
                v.push(Input {
                    seq: c.u32()?,
                    aim: c.u16()?,
                    buttons: c.u8()?,
                });
            }
            ReplayCommand::Input(id, v)
        }
        4 => ReplayCommand::UseItem(c.u8()?, c.u8()?),
        5 => ReplayCommand::SelectSlot(c.u8()?, c.u8()?),
        6 => ReplayCommand::Fire(c.u8()?),
        7 => ReplayCommand::ToggleFlashlight(c.u8()?),
        8 => ReplayCommand::VoteRestart(c.u8()?, c.u8()? != 0),
        9 => ReplayCommand::Leave(c.u8()?),
        10 => ReplayCommand::DropUnready(c.u8()?),
        11 => {
            let tick = c.u32()?;
            let mut hash = [0u8; 32];
            hash.copy_from_slice(c.take(32)?);
            ReplayCommand::Checkpoint { tick, hash }
        }
        12 => ReplayCommand::StartWithBots(c.u8()?),
        13 => ReplayCommand::UseHeal(c.u8()?),
        14 => ReplayCommand::UseBatteryPack(c.u8()?),
        15 => ReplayCommand::QuickThrow(c.u8()?),
        16 => ReplayCommand::MoveItem(c.u8()?, c.u8()?, c.u8()?),
        other => return Err(ReplayError::BadTag(other)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> ReplayHeader {
        ReplayHeader {
            version: REPLAY_VERSION,
            seed: 0xDEAD_BEEF_1234_5678,
            buried_secret: 0x0BAD_C0DE,
            scale: MapScale::Small,
            // Not the default: a fixture that happens to match the default cannot
            // tell "the field round-trips" from "the field is never read".
            generator: MapGenerator::V1,
            sim_hz: SIM_HZ,
            round_seconds: 12.5,
            max_players: 6,
            min_players_to_start: 1,
            bot_count: 2,
            bot_skill: 0.6,
            dev_loadout: true,
        }
    }

    fn every_command() -> Vec<ReplayCommand> {
        vec![
            ReplayCommand::Join {
                name: "ana".into(),
                skin_id: 3,
            },
            ReplayCommand::Ready(0),
            ReplayCommand::Input(
                1,
                vec![
                    Input {
                        seq: 1,
                        aim: 1000,
                        buttons: 0b0000_0011,
                    },
                    Input {
                        seq: 2,
                        aim: 65535,
                        buttons: 0xFF,
                    },
                ],
            ),
            ReplayCommand::UseItem(2, 7),
            ReplayCommand::SelectSlot(2, 0),
            ReplayCommand::Fire(3),
            ReplayCommand::ToggleFlashlight(4),
            ReplayCommand::VoteRestart(5, true),
            ReplayCommand::VoteRestart(5, false),
            ReplayCommand::Leave(5),
            ReplayCommand::DropUnready(4),
            ReplayCommand::Checkpoint {
                tick: 600,
                hash: [7u8; 32],
            },
        ]
    }

    fn encode_round(h: &ReplayHeader, body: &[(u32, ReplayCommand)]) -> Vec<u8> {
        let mut buf = Vec::new();
        write_header(&mut buf, h).expect("header");
        for (tick, c) in body {
            put_u32(&mut buf, *tick).expect("tick");
            write_command(&mut buf, c).expect("cmd");
        }
        buf
    }

    #[test]
    fn every_command_round_trips() {
        let h = header();
        let body: Vec<(u32, ReplayCommand)> = every_command()
            .into_iter()
            .enumerate()
            .map(|(i, c)| (i as u32 * 7, c))
            .collect();
        let bytes = encode_round(&h, &body);
        let r = decode(&bytes).expect("decode");
        assert_eq!(r.header, h);
        assert_eq!(r.body, body);
        assert_eq!(r.footer, None, "no footer was written");
    }

    #[test]
    fn a_round_with_no_commands_is_valid_and_minimal() {
        let h = header();
        let bytes = encode_round(&h, &[]);
        let r = decode(&bytes).expect("decode");
        assert_eq!(r.header, h);
        assert!(r.body.is_empty());
        assert_eq!(bytes.len(), HEADER_BYTES, "header size is pinned");
    }

    #[test]
    fn a_version_mismatch_is_a_clear_error_not_a_misparse() {
        let h = header();
        let mut bytes = encode_round(&h, &[(0, ReplayCommand::Ready(0))]);
        // Bump the version in place.
        bytes[4..6].copy_from_slice(&(REPLAY_VERSION + 1).to_le_bytes());
        match decode(&bytes) {
            Err(ReplayError::BadVersion { found, expected }) => {
                assert_eq!((found, expected), (REPLAY_VERSION + 1, REPLAY_VERSION));
            }
            other => panic!("expected BadVersion, got {other:?}"),
        }
    }

    #[test]
    fn a_foreign_file_is_rejected_by_magic() {
        let bytes = b"this is not a replay file at all, not even close".to_vec();
        assert!(matches!(decode(&bytes), Err(ReplayError::BadMagic(_))));
    }

    /// The distinction matters: telling someone "this is not a replay file" when
    /// it is one from last week sends them to the wrong problem.
    #[test]
    fn bad_magic_and_bad_version_are_different_errors() {
        let h = header();
        let good = encode_round(&h, &[]);
        let mut wrong_magic = good.clone();
        wrong_magic[0] ^= 0xFF;
        let mut wrong_version = good;
        wrong_version[4..6].copy_from_slice(&9u16.to_le_bytes());
        assert!(matches!(
            decode(&wrong_magic),
            Err(ReplayError::BadMagic(_))
        ));
        assert!(matches!(
            decode(&wrong_version),
            Err(ReplayError::BadVersion { .. })
        ));
    }

    #[test]
    fn an_unknown_command_tag_is_an_error_not_a_panic() {
        let h = header();
        let mut bytes = encode_round(&h, &[(0, ReplayCommand::Ready(0))]);
        let tag_at = bytes.len() - 2;
        bytes[tag_at] = 200;
        assert!(matches!(decode(&bytes), Err(ReplayError::BadTag(200))));
    }

    #[test]
    fn an_unknown_scale_is_an_error() {
        let h = header();
        let mut bytes = encode_round(&h, &[]);
        bytes[22] = 9; // the scale byte
        assert!(matches!(decode(&bytes), Err(ReplayError::BadScale(9))));
    }

    /// Every truncation of a real file must be an error, never a panic. This is
    /// the same standard `codec.rs` holds, for the same reason: the parser runs
    /// on a file someone sends us *because* something already went wrong.
    #[test]
    fn every_truncation_is_an_error_and_never_panics() {
        let h = header();
        let body: Vec<(u32, ReplayCommand)> = every_command()
            .into_iter()
            .enumerate()
            .map(|(i, c)| (i as u32, c))
            .collect();
        let full = encode_round(&h, &body);
        for cut in 0..full.len() {
            let _ = decode(&full[..cut]);
        }
        assert!(decode(&full).is_ok(), "the full file still decodes");
    }

    #[test]
    fn every_single_byte_corruption_is_handled_without_panicking() {
        let h = header();
        let full = encode_round(
            &h,
            &[(3, ReplayCommand::Input(1, vec![Input::new(1, 0, 0)]))],
        );
        for i in 0..full.len() {
            for bit in 0..8 {
                let mut c = full.clone();
                c[i] ^= 1 << bit;
                let _ = decode(&c);
            }
        }
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut state = 0x1234_5678_9ABC_DEF0u64;
        for len in [0usize, 1, 7, 43, 200, 1000] {
            for _ in 0..200 {
                let bytes: Vec<u8> = (0..len)
                    .map(|_| {
                        state = state
                            .wrapping_mul(6364136223846793005)
                            .wrapping_add(1442695040888963407);
                        (state >> 33) as u8
                    })
                    .collect();
                let _ = decode(&bytes);
            }
        }
    }

    /// A name longer than the 255-byte length prefix must not silently corrupt
    /// the stream — the write clamps, so the read must agree with the write.
    #[test]
    fn an_overlong_name_is_clamped_consistently() {
        let h = header();
        let long = "x".repeat(400);
        let bytes = encode_round(
            &h,
            &[(
                0,
                ReplayCommand::Join {
                    name: long,
                    skin_id: 1,
                },
            )],
        );
        let r = decode(&bytes).expect("decode");
        match &r.body[0].1 {
            ReplayCommand::Join { name, .. } => assert_eq!(name.len(), 255),
            other => panic!("wrong command {other:?}"),
        }
    }

    #[test]
    fn header_config_round_trips_the_simulation_fields() {
        let h = header();
        let c = h.to_config();
        let again = ReplayHeader::from_config(&c, h.seed, h.buried_secret);
        // §E2 retired `min_players_to_start`: `Config` no longer has one, so a
        // header cannot round-trip through it and nothing should pretend it can.
        // The slot stays in the format — see the field's own comment — and is
        // written as 0 from here on, which is what this asserts.
        assert_eq!(
            again.min_players_to_start, 0,
            "the retired slot was populated"
        );
        let h = ReplayHeader {
            min_players_to_start: 0,
            ..h
        };
        assert_eq!(again, h, "a header must survive a trip through Config");
    }

    /// `write_command` and `read_command` must agree on tags. A duplicate tag is
    /// the classic serialiser bug: it round-trips in the same build and breaks
    /// across versions, because the reader picks whichever arm it sees first.
    ///
    /// Deduplicated by discriminant, not by value — `every_command()` carries two
    /// `VoteRestart`s on purpose, to exercise both bools.
    #[test]
    fn tags_are_unique_across_every_variant() {
        let one_of_each: Vec<ReplayCommand> = {
            let mut seen_discriminants = std::collections::HashSet::new();
            every_command()
                .into_iter()
                .filter(|c| seen_discriminants.insert(std::mem::discriminant(c)))
                .collect()
        };
        assert_eq!(
            one_of_each.len(),
            11,
            "every_command() must cover all 10 variants, or this proves less than it claims"
        );
        let mut seen = std::collections::BTreeSet::new();
        for c in one_of_each {
            assert!(seen.insert(c.tag()), "duplicate tag {} for {c:?}", c.tag());
        }
    }
}

#[cfg(test)]
mod format_tests {
    use super::*;

    /// A v2 header this suite did **not** write, parsed byte for byte.
    ///
    /// Every other test here generates a file and reads it back, so a writer and
    /// a reader that moved together agree with each other perfectly — the shape
    /// `checksum.rs` already names. `HEADER_BYTES` cannot catch it either: it is
    /// compared against the writer, so moving both keeps it green.
    ///
    /// This is the fixture the suite has never had. §E2 retired
    /// `min_players_to_start`; taking it out of the format without bumping
    /// `REPLAY_VERSION` would shift `bot_count`, `bot_skill` and `dev_loadout`
    /// two bytes each while the version check still passed. The field was kept
    /// for exactly that reason, and this asserts it stayed.
    fn v2_header_bytes() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&REPLAY_MAGIC.to_le_bytes());
        v.extend_from_slice(&2u16.to_le_bytes()); // version
        v.extend_from_slice(&0x0123_4567_89AB_CDEFu64.to_le_bytes()); // seed
        v.extend_from_slice(&0xFEDC_BA98_7654_3210u64.to_le_bytes()); // buried_secret
        v.push(0); // scale: Small
        v.push(0); // generator
        v.extend_from_slice(&60u32.to_le_bytes()); // sim_hz
        v.extend_from_slice(&240.0f32.to_le_bytes()); // round_seconds
        v.extend_from_slice(&6u16.to_le_bytes()); // max_players
        v.extend_from_slice(&2u16.to_le_bytes()); // min_players_to_start (retired)
        v.extend_from_slice(&3u16.to_le_bytes()); // bot_count
        v.extend_from_slice(&0.6f32.to_le_bytes()); // bot_skill
        v.push(1); // dev_loadout
        v
    }

    #[test]
    fn a_v2_header_written_by_hand_still_parses_field_for_field() {
        let bytes = v2_header_bytes();
        assert_eq!(
            bytes.len(),
            HEADER_BYTES,
            "the hand-written header is not HEADER_BYTES long, so this fixture \
             cannot detect a shift in the real one"
        );

        // Header plus an empty body: `decode` tolerates a file with no commands
        // and no footer, which is what a round killed at tick 0 leaves.
        let r = decode(&bytes).expect("a v2 header must parse");
        let h = r.header;
        assert_eq!(h.version, 2);
        assert_eq!(h.seed, 0x0123_4567_89AB_CDEF);
        assert_eq!(h.buried_secret, 0xFEDC_BA98_7654_3210);
        assert_eq!(h.sim_hz, 60);
        assert_eq!(h.round_seconds, 240.0);
        assert_eq!(h.max_players, 6);
        assert_eq!(h.min_players_to_start, 2, "the retired slot still reads");
        // The three fields that would shift if the retired slot were removed
        // without bumping the version. This is the whole point of the fixture.
        assert_eq!(h.bot_count, 3, "bot_count shifted");
        assert_eq!(h.bot_skill, 0.6, "bot_skill shifted");
        assert!(h.dev_loadout, "dev_loadout shifted");
    }
}
