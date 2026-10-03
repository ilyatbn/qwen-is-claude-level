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
//!
//! **Round two and later carry their roster** (T23.29 item 2, `REPLAY_VERSION` 40). `Room::restart` opens a **new
//! file** per round, and until v40 nothing in it said who was seated: the `Join`s and `JoinSpectator`s were in round
//! one's file, so a later round's replay seated nobody and its bots took other ids. Every header now ends with a
//! [`RoundRoster`] — empty for a file opened at room construction (the body seats everyone), the seats, the id pool and
//! the bot counter for one opened by a restart — and `Room::for_replay` rebuilds the round from it.

use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use game_core::constants::{
    GravityMode, MapGenerator, MapScale, MapShape, StartKit, WorldLook, SIM_HZ,
};
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
/// bot_skill 4, dev_loadout 1, bots_enabled 1, start_kit 1, gravity 1, map_shape 1
/// (T23.30, v38 — a v37 header is one byte shorter), world_look 1 (T23.31, v39 — a
/// v38 header is one byte shorter).
///
/// **The fixed part only** since v40: a [`RoundRoster`] follows it, [`V40_TAIL_BYTES`] long for a round-one
/// file — so a round-one body starts at `HEADER_BYTES + V40_TAIL_BYTES`.
///
/// Public because the body starts here, and a test that wants to corrupt the
/// first command has to know where it is. Two of them used to carry the number
/// inline and both broke the moment the header grew a field.
pub const HEADER_BYTES: usize = 48;

/// T23.29: what v40 appends for a round-one file — the warmup 4, then an empty [`RoundRoster`]: restart 1,
/// private 1, bot_seq 4, next 2, free count 1, seat count 1.
pub const V40_TAIL_BYTES: usize = 14;

/// **2**: the header gained `generator`. A v1 round replayed against v2 (or the
/// reverse) rebuilds a different map and diverges on the first shot that touches
/// terrain, so the generator is simulation state and belongs here. Version 1 files
/// are rejected rather than silently assumed to be v1 terrain.
///
/// **3 (§F5)**: the item registry changed shape. Commands carry `SelectSlot(u8)`
/// and no item ids, so retiring five weapons *looks* safe — but `place_initial`
/// and `assign_buried_items` draw over the `spawn_weight`/`buried_weight` columns
/// across the whole of `ITEMS`, and zeroing five of them reshuffles every draw.
/// A v2 file would load, run, and diverge silently on the first item anybody
/// picked up. The header does not record the registry, so the version is the only
/// place that difference can live. Every player also now starts holding a shovel,
/// which moves the slot every `SelectSlot` in an old file refers to.
///
/// **4 (§F7)**: the header gained `bots_enabled` and `start_kit`. Appended after
/// `dev_loadout`, so nothing already in the header moved — but a v3 file is two
/// bytes short and the two new fields have to come from somewhere, and guessing
/// the defaults is exactly the bug this fixes. They are header fields rather than
/// commands because `restart()` writes a **new** header and a new file for round
/// two: the host's lobby change is in round one's stream, so from round two the
/// header is the only carrier. Recorded as `Room` fields first, and round two
/// then replayed with bots the live round never seated.
///
/// **5 (T20.07, and T20.08 shares it)**: `Player::flashlight_on` left the state
/// hash. It was hashed in `world/mod.rs`'s per-player block, and the flashlight is
/// passive now — carrying one is the whole state and the snapshot's bit 4 is
/// derived from the inventory at the encode site. A v4 recording of anyone who
/// picked up a torch would load, run, and **diverge silently** at the first
/// checkpoint after the pickup, which is precisely the v3 case above. Tag 7,
/// `ToggleFlashlight`, retires with it and its number is left as a hole: no file
/// that could contain a 7 will ever get past the version check.
///
/// **One bump, two tasks.** T20.08 removes `shield_until` from the same hashed
/// block for the same reason, and a version is not a changelog — bumping twice for
/// one release would reject every recording twice over for a single break in
/// compatibility. **Check `HEAD` before bumping**: T20.09 landed a new *command*
/// in this window and correctly did **not** bump, because a new tag leaves an old
/// file replaying byte for byte. Same-sounding question, opposite answers.
/// **6 (fall-damage retune, 2026-09-07)**: `FALL_DAMAGE_PER_SPEED` halved,
/// 0.15 → 0.075, at the coordinator's instruction. No layout change and no new
/// tag — this is the **silent divergence** case, which is the one the version
/// exists for. Any v5 recording in which somebody took a fall would load, run,
/// and disagree at the first state hash after the landing, because the same
/// inputs now cost half the health.
///
/// **And T20.21 shares it — one bump, two breaks.** `PlayerState::speed_multiplier`
/// now reads `health.floor()`, and `world::apply_inputs` calls that, so **server
/// movement changed too**: the same inputs move a player at fractional health a
/// different distance. That is a second silent divergence, and it landed after
/// this bump without one of its own. **Sharing is correct** — the precedent is
/// T20.07 and T20.08 sharing 5, and a version is not a changelog, so bumping
/// twice inside one unreleased window would reject every recording twice for
/// what is a single break in compatibility. **But the note has to name both**, or
/// the next person debugging a v6-era divergence reads "fall damage" and rules
/// out movement. Corrected 2026-09-07; an earlier draft of this line said "one
/// bump for one break", which was true when written and false an hour later.
///
/// **7 (T21.11B)**: `MountState` joined the per-player hashed block. Three
/// fields — the platform being ridden, the one being charged toward, and the
/// hold in seconds — all of which decide whether the next input moves the player
/// at all. A v6 recording would load, run, and disagree at the **first**
/// checkpoint rather than at the first mount, because the hash folds the new
/// bytes in whether or not anybody ever stood on a platform. That is the silent
/// divergence case, so it is a bump.
///
/// **T21.11C shares it.** The platforms' ammo is world state and goes into the
/// same hash, in the same unreleased window; a version is not a changelog and
/// bumping twice would reject every recording twice for one break in
/// compatibility. The precedent is T20.07/T20.08 sharing 5 and T20.21 sharing 6
/// — and, as the note above records, **the entry has to name both** or whoever
/// debugs a v7-era divergence reads "mounting" and rules out the magazine.
///
/// **No new tag.** Mounting is driven entirely by the existing input stream —
/// standing still, then holding jump — so an old file's commands are unchanged
/// in shape. T20.09 is the precedent for the opposite case: a new command tag
/// leaves an old file replaying byte for byte and correctly did not bump.
///
/// **8 (T21.29, fall damage cut to a third, 2026-09-15)**: `FALL_DAMAGE_PER_SPEED`
/// 0.075 → 0.025. No layout change and no new tag — the silent divergence case,
/// exactly as 6 was for the previous retune: a v7 recording in which anybody took
/// a fall would load, run, and disagree at the first state hash after the landing.
///
/// **T21.30 shares it — one bump, two breaks, and the note names both.** In
/// `Ended` the world now drops queued input and integrates every alive player
/// on a neutral input, and `fire`/`use_item`/`drop_item` refuse. A v7 recording
/// of any round that reached `Ended` with input still arriving would diverge at
/// the first hash inside the results window.
///
/// **9 (T21.39, toxic rain switched off, 2026-09-15)**: `TOXIC_RAIN_ENABLED` is false,
/// so the weather scheduler's roll zeroes toxic rain's weight and the same seed now
/// draws a different sequence of effects; the scheduler also hashes the switch. The
/// silent divergence case: a v8 recording would disagree at the first effect roll.
///
/// **10 (T21.38, a new round needs every human, 2026-09-15)**: the restart vote now
/// resolves **early**, on the tick every seated human has voted yes, where it used to
/// wait for the `Ended` window to close. A recording file ends at `restart`, so a v9
/// file in which everyone said yes early carries checkpoints and a footer from after
/// the vote, and the v10 room replaces the world before reaching them. No layout
/// change and no new tag — the silent divergence case.
///
/// **The same task changed the rule too — the note names both.** A majority of the
/// votes cast used to restart; now every seated human must say yes, or the room goes
/// to the lobby. On its own that changes only what follows a file's last tick, which
/// no replay checks, but whoever debugs a v10-era divergence around a round's end
/// should know both moved.
///
/// **11 (T21.43, the gun platform fires while held)**: a mounted `Fire` spawns one
/// round from the next barrel every `GUN_PLATFORM_FIRE_INTERVAL` instead of a
/// volley of four every 0.12 s, and `platform_barrel` joined the hashed platform
/// block. No new tag — the same `Fire` commands — so it is the silent divergence
/// case: a v10 recording would disagree at the **first** checkpoint, because the
/// hash folds the barrel bytes in whether or not anyone mounted. Its own number
/// rather than sharing, because T21.39 (9) and T21.38 (10) had each already
/// landed on `claude_builds` in a separate commit.
///
/// **12 (T21.40, gates 20 % smaller and seated or not placed, 2026-09-15)**: the same
/// seed now places different teleport pads and gun platforms, sometimes fewer or none
/// (only seated spots, islands included), and fills different ground under them;
/// `PAD_W` 40 → 32 changes which rock a carve may not remove. The map is regenerated
/// from the header's seed, so a v11 recording would load onto a different map and
/// disagree at the first checkpoint. No new tag. **T21.28 moved placement the same
/// way without a bump**: it landed after T21.29's 8 (11:32 → 12:54 that day), so a v8
/// recording made in that window replayed onto a different map. T21.39's 9 retired
/// those; every v9–v11 recording postdates T21.28, and this number covers T21.40.
/// **13 (the owner's 2026-09-16 play session)**: six changes in one bump, because they
/// landed in one sitting and every one of them is the silent divergence case — no new
/// tag, no layout change, a v12 recording simply disagrees at the first checkpoint.
///
///  - **Fall damage.** `FALL_SAFE_SPEED` 480 → 678.8 (the free drop height doubled,
///    82 → 165 px) and `FALL_DAMAGE_PER_SPEED` 0.025 → 0.046 to keep the deepest fall
///    above the tenth-of-a-bar floor. Every landing in the file is charged differently.
///  - **Boots.** `BOOTS_JUMP_HEIGHT_MULT` 3.0 → 2.25, so the same input reaches a
///    different apex from the first jump. Fall protection split out as
///    `BOOTS_FALL_HEIGHT_MULT` and kept at 3.0, so the threshold itself is unchanged.
///  - **Wings.** `WINGS_SPEED_MULT` 0.9 multiplies into `speed_multiplier`, so a
///    winged player's horizontal position diverges on the first tick they move.
///  - **Wings refuse pads and platforms.** `teleport::step` gains an `eligible`
///    argument and `step_mount` sees no platform under a winged player — a v12 file
///    in which anyone teleported or mounted while carrying wings replays differently.
///  - **Lava switched off.** `LAVA_ENABLED` is false, so the scheduler zeroes lava's
///    weight and the same seed draws a different sequence of effects. With toxic rain
///    already off this leaves two kinds, which never-repeat turns into a strict
///    alternation — the sequence is not merely reweighted, it is deterministic.
///  - **The scheduler's hash changed shape.** `toxic_enabled` (one byte) became
///    `enabled: [bool; 4]` (four), so every checkpoint hash moves even in a round
///    where no effect ever rolled.
///
/// **14 (T22.01, the gravity match setting)**: the header gained `gravity`, one
/// byte, appended after `start_kit`. This is the **layout** case rather than the
/// silent-divergence one: a v13 file is a byte short, so a decoder that skipped
/// the bump would read the body's first `u32` tick misaligned and report a
/// corrupt command stream on a file that is fine. Nothing already in the header
/// moved.
///
/// **No new hashed state, and that is deliberate.** `World::gravity` is not in
/// `state_hash` — it is an input like `seed`, carried here, and a world that ran
/// under a different gravity diverges in `players`, which *is* hashed. So every
/// checkpoint in a v13 file would still match byte for byte; the version moves
/// for the header's length alone.
///
/// **Tag 23, `SetGravity`, appends with it** and would not have needed a bump on
/// its own — T20.09's precedent, restated at `SetBots`: an old file never
/// contains the tag, so it decodes exactly as before.
///
/// **15 (T22.11B, the asteroid gravity wells)**: the silent-divergence case, the
/// same shape as 13's *"the scheduler's hash changed shape"* bullet, twice over.
/// No new tag and no layout change.
///
///  - **`World::state_hash` gained the asteroid table** (`M22-RULINGS` R36). It
///    folds in a `u32` length and then `x`/`y`/`r`/`level` per rock, so **every
///    checkpoint hash moves**, including in a round on a map with no asteroids
///    where only the zero length is folded. A v14 file disagrees at the first
///    checkpoint on a map it would otherwise reproduce exactly.
///  - **Space gravity is no longer weightless.** `world::attractors` gives every
///    player in a space match a summed field and a terminal speed, so a v14 space
///    recording replays to different positions from its first tick.
///
/// The `gravity` note above still stands for the setting itself: it is an input
/// carried in the header, and it is what the *field* is derived from rather than
/// being hashed on its own.
///
/// **16 (T22.09A, radiation — `M22-RULINGS` R77)**: the same silent-divergence
/// shape as 15, ratified on 15's reasoning (R61). No new tag, no layout change.
///
///  - **`World::state_hash` gained `PlayerState::radiation_exposure`** (R74), so
///    every checkpoint hash moves, in every mode — a standard round folds in a
///    zero it did not fold before.
///  - **A space round is a different simulation**: the suit starts full, drains
///    a unit a second, radiation lands on the unsealed, and the battery pack
///    spawns twice as often, so a v15 space recording diverges at its first
///    initial item roll.
///
/// **17 (T22.08A, solar flares — `R85`)**: the silent-divergence shape again. No
/// new tag, no layout change.
///
///  - **The scheduler's hash grew**: `enabled` folds five switches, not four, so
///    every checkpoint hash moves in every mode.
///  - **`World::state_hash` gained `PlayerState::burning_until` and
///    `burn_exposure`** (R79).
///  - **A space round rolls different weather**: meteor and flare alternate where
///    it used to roll fog (R43, R78). A standard round's *schedule* is unchanged —
///    `the_flare_does_not_move_the_grounds_schedule` — but its hashes still move.
///
/// **18 (T22.10F, one step per player per tick — R89)**: the silent-divergence
/// shape. No new tag, no layout change, no new hashed field. **The same recorded
/// inputs simulate differently**: a tick with no input for a player is now a
/// stand-in step (the held state) where v17 did not integrate the player at all;
/// an input at or below the last simulated seq is discarded where v17 queued it;
/// the jitter buffer drops its oldest past `INPUT_BACKLOG_TARGET` where v17 ran
/// two a tick against catch-up credit. A v17 recording with any late or missing
/// input diverges at that tick.
///
/// **19 (T22.10G, the jitter buffer's lead)**: the silent-divergence shape. No
/// new tag, no layout change, no new hashed field. A client's first input now
/// waits `INPUT_BACKLOG_TARGET` ticks before its tick, and a player who has sent
/// nothing is not stepped in `Lobby`/`Warmup` (v18 stood in a neutral step), so
/// every v18 recording of a client diverges from its first input.
///
/// **20 (T22.12, the black hole)**: a new hashed field (`World::black_hole`), and
/// every space round now gains a hole in its last minute that pulls, kills and
/// carves — a v19 space recording diverges at the arrival, and its hashes differ
/// from the first tick. No new tag, no layout change.
///
/// **21 (T22.12C, the black-hole review)**: the silent-divergence shape again — the
/// pull is right-sized (R90), the wells are muted inside its reach (R91), a death in
/// it drops nothing (R92), and it is telegraphed first (R93: a new hashed state,
/// `BlackHole::Warned`, and a window scaled on short rounds). A v20 space recording
/// diverges at the telegraph. No new tag, no layout change.
///
/// **22 (T22.12D, R94: rounds counted in ticks)**: the round clock is derived from
/// the step count, not an `f32` sum, and every phase ends on its deadline tick — so
/// `round_time` differs in the last bits from the first tick (it is hashed), weather
/// and the day/night cycle move by the old drift (−6..+1 ticks over 600 s), and a
/// 240/300/600 s round ends 1/2/6 ticks sooner. Every v21 recording diverges. No new
/// tag, no layout change.
///
/// **23 (T22.03G, R96: the summed wells are capped)**: the silent-divergence shape.
/// The asteroid wells' sum is clamped at `SPACE_WELL_ACCEL_MAX` (bit-identical
/// wherever it was under it), so a v22 space recording diverges the first tick a
/// body sits where two or more wells piled past 675 px/s². Standard and low
/// recordings are unchanged, but the version is per file, not per mode. No new tag,
/// no layout change.
///
/// **24 (T22.03I, R97: the wells and the vortices are capped together)**: the same
/// shape. Every live vortex's pull joins the wells inside the one clamp, so a v23
/// space recording diverges the first tick a body sits where a vortex and the wells
/// together passed 675 px/s² outside the capture radius. No new tag, no layout change.
///
/// **25 (T22.14A, the final audit's hazards)**: the silent-divergence shape. Inside
/// the black hole's reach no vortex pulls (H1), so a v24 space recording diverges the
/// first tick a body sits inside the reach while a vortex's pull reached it; a
/// respawn, join or vortex trip during the telegraph keeps clear of where the hole
/// will open (H2); weather damage is refused after the bell and a meteor shower's
/// `Active` window covers its fall, so a shower rolled within its fall time of the bell
/// is refused (H3; one row of the standard weather golden); and in space a shower's
/// meteors start inside the rim, fly at the asteroids, and despawn at the rim without
/// carving (R99) — a v24 space recording diverges at its first shower. No new tag, no
/// layout change.
///
/// **26 (T22.14C, R100 and the placement clearance)**: the silent-divergence shape. A
/// winged player in space feels no field — no well, no vortex pull, no black-hole pull
/// (capture and the horizon still apply) — so a v25 space recording diverges the first
/// tick a winged body sits in any field; and a respawn or mid-round join keeps clear of
/// every vortex's `VORTEX_REACH / 2` as a trip's destination does, so one diverges at
/// the first placement a vortex would have refused. No new tag, no layout change (the
/// snapshot header's exact round time is the wire's, not a replay's: replays store
/// inputs).
///
/// **27 (T22.17, R103 + R104)**: the space map moved. A replay stores the seed, scale,
/// generator and gravity and **regenerates** the map, so a v26 space recording
/// replayed on this build is played on a different arena — the rim is a
/// square-cornered rectangle inset from every edge instead of an ellipse, and every
/// asteroid draws up to 20 % extra mass on its own sub-stream — and diverges at the
/// first tick anything touches the map. Standard and low-gravity maps are unchanged
/// (their golden rows did not move), but the version is one number for every
/// recording. No new tag, no layout change.
///
/// **28 (T22.15, R101: short-range wells)**: the silent-divergence shape. An asteroid
/// pulls at its level's full strength out to one `WELL_SURFACE_BAND` of air past its
/// rock and not at all beyond (it reached up to a climb budget, falling off), so a
/// v27 space recording diverges on the first tick of any space round — a player at a
/// spawn was pulled then and is not now. No new tag, no layout change.
///
/// Bumped to 29 by T22.16 (R102, asteroid cores): the state hash covers each rock's
/// `core_intact`, a carved core crumbles and drops a battery, and a well's band is
/// measured from the rock's round body (refinement B) — a v28 space recording
/// diverges on the first tick a player stands in a band that moved, or the first
/// carve that reaches a core. No new tag, no layout change.
///
/// Bumped to 30 by T22.18 (R105, R106, R108): the vortex's capture and pull radii are a
/// quarter of what they were and a body past the rim's outer edge is taken by the
/// nearest vortex, the black hole pulls to twice the distance, the sealed suit drains
/// at half the rate, and a destroyed core's battery may float where a body can reach —
/// a v29 space recording diverges on the first tick a sealed suit drains. No new tag,
/// no layout change.
///
/// Bumped to 31 by T22.18B (F1): a well's band follows the rock's generated outline
/// (its lumps), and the state hash covers the lumps — a v30 space recording diverges on
/// the first tick a player is over a lump. No new tag, no layout change.
///
/// Bumped to 32 by T22.20 (R109): the thrusters push at `SPACE_THRUST_SCALE` (half) in
/// space, and the wells' cap, the vortex's pull, the black hole's pull and the bots' brake
/// halve with them — a v31 space recording diverges on the first tick anyone thrusts.
/// No new tag, no layout change.
///
/// Bumped to 33 by T22.21's R109b: `SPACE_MAX_SPEED` 1350 → 450 (and the void band,
/// two ticks of it, 45 → 15 px) — a v32 space recording diverges on the first tick a
/// body passes 450 px/s. No new tag, no layout change.
///
/// Bumped to 34 by T22.21 (R110–R113): the space map moved (rocks a quarter bigger,
/// fewer, two iron rocks seated first, the level jitter drawn per candidate), a carve
/// bites asteroid rock at half its radius and never iron, a core refuses carves until
/// its third hit, and meteors aim at open space — a v33 space recording is played on a
/// different arena and diverges at the first tick anything touches it. The state hash
/// covers each rock's `iron` and `core_hits`. No new tag, no layout change.
///
/// Bumped to 35 by T22.22 (R109c): in space an axis of thrust against the body's
/// travel pushes at `SPACE_BRAKE_SCALE` until that axis stops — a v34 space recording
/// that ever counter-thrusts diverges on that tick. No new tag, no layout change.
///
/// Bumped to 36 by T22.22B: a carve counts as a core hit only at `CORE_HIT_MIN_R` or
/// wider (R112b), the brake is `SPACE_BRAKE_SCALE` 1.1, and a map whose iron would be
/// over `SPACE_IRON_SHARE_MAX` of its rock shrinks its iron (`cap_iron_share`) — a v35
/// space recording diverges at its first small carve on a core, its first brake, or its
/// arena. No new tag, no layout change.
///
/// Bumped to 37 by T22.22C (R113b): Small's iron is drawn at 99..100 px and never shrunk
/// under 1.125 × its map's largest ordinary rock — a v36 Small space recording is
/// played on a different arena. No new tag, no layout change.
///
/// Bumped to 38 by T23.30 (`docs/78` §A5): the header gains the **map shape** byte,
/// appended after gravity, and tag 25 `SetMapShape` joins the stream. **A v37 file
/// still reads** — it predates shapes, so its shape is `Random`, which generates
/// today's map byte for byte (`golden.rs` unmoved); `decode` accepts exactly
/// [`REPLAY_VERSION_NO_SHAPE`] besides this one.
///
/// Bumped to 39 by T23.31 (`docs/78` §A7): the header gains the **world look** byte,
/// appended after the map shape — a record of how the round was drawn (render-only:
/// nothing replayed reads it). **v37 and v38 files still read**, as `Classic` — they
/// predate looks, and every round they recorded was drawn classic.
///
/// Bumped to 40 by T23.29 item 2: the header gains the **round roster** ([`RoundRoster`]), appended after the look —
/// so a file a restart opened replays from its own header. **v37–v39 files still read**, with an empty roster: their
/// round-one files replay as before, and their later rounds stay as unreplayable as they always were.
pub const REPLAY_VERSION: u16 = 40;

/// The last version without the round roster (T23.29) — read with an empty one.
pub const REPLAY_VERSION_NO_ROSTER: u16 = 39;

/// The last version without the world-look byte (T23.31) — read as `Classic`.
pub const REPLAY_VERSION_NO_LOOK: u16 = 38;

/// The last version without the map-shape byte (T23.30) — read as `Random`
/// (and, having no look byte either, `Classic`).
pub const REPLAY_VERSION_NO_SHAPE: u16 = 37;

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
    /// T23.27 (`docs/78` §A1): a **spectator** was seated — no body. Tag 24, appended: no older file contains it, and
    /// `Join` (tag 1) is untouched, so every recording replays as before. Recorded at all because the seat takes an
    /// id from the pool: a replay that skipped it would hand the next joiner a different id and diverge.
    JoinSpectator {
        name: String,
    },
    /// A player who was ready and is not any more (§E3).
    ///
    /// **A new tag rather than a bool on `Ready`.** Tag 2 is one byte of player
    /// id in every file already written; widening it would let those files pass
    /// the version check and then read the rest of the round one byte short.
    /// An old file never contains this tag, so adding one costs nothing.
    ///
    /// It has to be recorded at all because a private lobby starts when every
    /// human is ready: a replay that dropped the un-ready would start the match
    /// early and diverge on the first tick.
    Unready(PlayerId),
    /// The host changed the map size before the match began (§E3).
    ///
    /// **The header's `scale` is written when the room is constructed, and the
    /// world is now built at match start** — so between those two moments the
    /// host can change the map and the header no longer describes what was
    /// generated. Recording the change is what closes that: the replay runner
    /// applies commands into a real `Room`, so the config it generates from is
    /// the one the live room had.
    SetScale(PlayerId, MapScale),
    /// The host changed one of §F7's three private-lobby settings.
    ///
    /// **Appended tags, and that is why no version bump is needed**: no file
    /// written before today contains tag 19, 20 or 21, so an old replay decodes
    /// exactly as it did. Widening an existing tag instead would let those files
    /// pass the version check and then read the rest of the round misaligned —
    /// the reason `Unready` is tag 17 rather than a bool on `Ready`.
    ///
    /// They have to be recorded for `SetScale`'s reason, twice over: `bots`
    /// changes how many players the round has, `start_kit` changes what every
    /// one of them is holding on tick one, and `round_seconds` changes when it
    /// ends. `ReplayHeader` carries `bot_count` and `round_seconds` — but it is
    /// written when the room is *constructed*, so it describes the room's birth
    /// and these describe the match. **The commands are authoritative.**
    SetBots(PlayerId, bool),
    SetStartKit(PlayerId, StartKit),
    SetRoundSeconds(PlayerId, f32),
    /// The host changed the gravity before the match began (T22.01).
    ///
    /// Recorded for `SetScale`'s reason and on `SetBots`'s terms: an appended
    /// tag, so no file written before today contains it. The header carries the
    /// setting too, and which of the two is authoritative depends on the round —
    /// see `SetBots` above, which states the rule once for all four.
    SetGravity(PlayerId, GravityMode),
    /// T23.30: the lobby's map shape. Tag 25.
    SetMapShape(PlayerId, MapShape),
    /// T23.29 item 4: the room learned whether it is **private** (`Command::SetIdentity`). Tag 26, appended.
    ///
    /// The owner's recorded round did not replay because this was missing. The header is written when the room is
    /// constructed and the registry tells the room its identity a moment later, so nothing in the file said the room
    /// was private — and a replayed public room refuses every lobby setting (`check_settings_change`): the host's
    /// `SetStartKit(All)` was dropped, the human held only the shovel, and the lobby started on the public bot timeout
    /// rather than on consent. Files older than this tag get the flag back by inference (`infer_privacy`).
    SetPrivate(bool),
    /// Already filtered: duplicates and stale sequences are dropped before they
    /// reach here, so a replay applies exactly the input the live round did.
    Input(PlayerId, Vec<Input>),
    UseItem(PlayerId, u8),
    SelectSlot(PlayerId, u8),
    Fire(PlayerId),
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
    /// T20.09: one slot's stack put on the ground.
    ///
    /// **Tag 22, and `REPLAY_VERSION` does not move.** The policy this file
    /// records across all three prior bumps is: bump when the *header layout*
    /// changes (v2, v4) or when an old file "would load, run, and diverge
    /// silently" (v3). A new tag does neither — the header is untouched, and a
    /// v4 file simply contains no tag-22 commands, so it replays byte for byte.
    /// Bumping "to be safe" would reject every recording anyone already has,
    /// because `decode` refuses any version mismatch outright.
    DropItem(PlayerId, u8),
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
            ReplayCommand::VoteRestart(..) => 8,
            ReplayCommand::Leave(_) => 9,
            ReplayCommand::DropUnready(_) => 10,
            ReplayCommand::Checkpoint { .. } => 11,
            ReplayCommand::StartWithBots(_) => 12,
            ReplayCommand::UseHeal(_) => 13,
            ReplayCommand::UseBatteryPack(_) => 14,
            ReplayCommand::QuickThrow(_) => 15,
            ReplayCommand::MoveItem(..) => 16,
            ReplayCommand::Unready(_) => 17,
            ReplayCommand::SetScale(..) => 18,
            ReplayCommand::SetBots(..) => 19,
            ReplayCommand::SetStartKit(..) => 20,
            ReplayCommand::SetRoundSeconds(..) => 21,
            ReplayCommand::DropItem(..) => 22,
            ReplayCommand::SetGravity(..) => 23,
            ReplayCommand::SetMapShape(..) => 25,
            ReplayCommand::JoinSpectator { .. } => 24,
            ReplayCommand::SetPrivate(_) => 26,
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
    /// §F7's two private-lobby settings. See `REPLAY_VERSION` 4 for why they are
    /// here and not only in the command stream.
    pub bots_enabled: bool,
    pub start_kit: StartKit,
    /// T22.01's gravity. Here and not only in the command stream for §F7's
    /// reason, restated at `REPLAY_VERSION` 4: `restart()` writes a fresh header
    /// for round two, so from round two this is the **only** carrier of a
    /// setting the host chose in round one's lobby.
    pub gravity: GravityMode,
    /// T23.30's map shape — the header carries it for gravity's reason above.
    pub map_shape: MapShape,
    /// T23.31's world look: how the round was drawn. **A record, not an input** —
    /// derived from the seed by the generator's own rule (`world_look_for`), and
    /// nothing in a replay run reads it; `Classic` for files older than v39.
    pub world_look: WorldLook,
    /// T23.29 item 2: the warmup's length (`DEV_WARMUP_SECONDS`). Simulation input — it decides the tick `Playing`
    /// begins on — and missing from every header before v40, which read as the default `WARMUP_SECONDS` (all a
    /// live server without the dev switch ever ran). Found by the round-two test, whose 1 s warmup replayed as 10.
    pub warmup_seconds: f32,
    /// T23.29 item 2: who the round began with, when a restart opened the file. Empty (the default) for a file opened
    /// at room construction and for every file older than v40.
    pub roster: RoundRoster,
}

/// T23.29 item 2: the state a restart hands the next round, as `Room::restart` holds it **after** freeing the bot
/// seats and **before** seating new bots — so `Room::for_replay` can run the same `open_round` on it and reach the
/// same ids, the same bots and the same bodies.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RoundRoster {
    /// `false`: the file was opened at room construction, and its body seats everyone — nothing else here is read.
    pub restart: bool,
    /// The room's privacy, which a restart's file has no `SetPrivate` for (round one's body carried it).
    pub private: bool,
    /// The bot counter: a bot's name and its `Bot::new` index come off it.
    pub bot_seq: u32,
    /// The id pool: the next fresh id, and the freed ids **in stack order** (`Seats::alloc_any` pops the last).
    pub next: u16,
    pub free: Vec<PlayerId>,
    /// The seated humans and spectators, in seat order.
    pub seats: Vec<RosterSeat>,
}

/// One seat of a [`RoundRoster`]: what `populate_world` reads off it. Hats and glasses are not here — cosmetic, and
/// excluded from `state_hash` for `Join`'s reason.
#[derive(Debug, Clone, PartialEq)]
pub struct RosterSeat {
    pub id: PlayerId,
    pub spectator: bool,
    pub name: String,
    pub skin_id: u16,
    pub tombstone_skin_id: u16,
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
            bots_enabled: config.bots_enabled,
            start_kit: config.start_kit,
            gravity: config.gravity,
            map_shape: config.map_shape,
            // The map's own rule on the map's own inputs (the generator as gravity
            // derives it, R15), so the header says what `map_init` sent.
            world_look: game_core::map::meta::world_look_for(
                seed,
                MapGenerator::for_gravity(config.gravity, config.map_generator),
            ),
            warmup_seconds: config.warmup_seconds,
            roster: RoundRoster::default(),
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
            bots_enabled: self.bots_enabled,
            start_kit: self.start_kit,
            gravity: self.gravity,
            map_shape: self.map_shape,
            warmup_seconds: self.warmup_seconds,
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
    BadStartKit(u8),
    BadGravity(u8),
    /// T23.30: a map-shape byte naming no shape.
    BadMapShape(u8),
    /// T23.31: a world-look byte naming no look.
    BadWorldLook(u8),
    /// A byte that is neither 0 nor 1 where a flag was written. Its own variant
    /// rather than a lenient `!= 0`, because a corrupt file that decodes as
    /// `true` replays a setting the round never had and then diverges somewhere
    /// else entirely.
    BadBool(&'static str, u8),
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
            ReplayError::BadStartKit(k) => write!(f, "unknown starting kit {k}"),
            ReplayError::BadGravity(g) => write!(f, "unknown gravity {g}"),
            ReplayError::BadMapShape(m) => write!(f, "unknown map shape {m}"),
            ReplayError::BadWorldLook(l) => write!(f, "unknown world look {l}"),
            ReplayError::BadBool(field, b) => write!(f, "{field} is {b}, not 0 or 1"),
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

/// Whether `RECORD_REPLAY` can actually write into `dir`, asked **once at
/// startup** (T21.35). Returns the directory as an absolute path when it can.
///
/// Rooms open their recorders at construction, so without this an unwritable
/// directory surfaced as one `could not start replay: Permission denied` per
/// room, and only after a player had already joined one. In Docker that is the
/// bind mount: the host directory replaces the image's `/recordings`, and a host
/// directory Docker created for the mount is `root:root 755` — the container's
/// `game` user can read it and write nothing.
///
/// It really creates and removes a file rather than reading permission bits: a
/// read-only filesystem, an ACL or a user-namespace remap all pass a mode check
/// and fail the write.
pub fn probe_writable(dir: &Path) -> Result<PathBuf, ReplayError> {
    fs::create_dir_all(dir)?;
    let probe = dir.join(format!(".write-probe-{}", std::process::id()));
    File::create(&probe)?;
    fs::remove_file(&probe)?;
    Ok(fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf()))
}

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
    // **Appended**, after every field that already existed. Inserting either of
    // these earlier would move `bot_count`, `bot_skill` and `dev_loadout` — the
    // failure the note above records having already happened once.
    w.write_all(&[u8::from(h.bots_enabled)])?;
    w.write_all(&[h.start_kit.as_u8()])?;
    // T22.01, appended after everything above for the reason the note on the two
    // §F7 fields gives: inserting it earlier would move every field after it.
    w.write_all(&[h.gravity.as_u8()])?;
    // T23.30, appended for the same reason.
    w.write_all(&[h.map_shape.to_u8()])?;
    // T23.31, appended for the same reason.
    w.write_all(&[h.world_look.to_u8()])?;
    // T23.29, appended for the same reason: the warmup, then the roster.
    put_f32(w, h.warmup_seconds)?;
    let r = &h.roster;
    w.write_all(&[u8::from(r.restart), u8::from(r.private)])?;
    put_u32(w, r.bot_seq)?;
    put_u16(w, r.next)?;
    let free = &r.free[..r.free.len().min(255)];
    w.write_all(&[free.len() as u8])?;
    w.write_all(free)?;
    let seats = &r.seats[..r.seats.len().min(255)];
    w.write_all(&[seats.len() as u8])?;
    for seat in seats {
        w.write_all(&[seat.id, u8::from(seat.spectator)])?;
        put_u16(w, seat.skin_id)?;
        put_u16(w, seat.tombstone_skin_id)?;
        let bytes = seat.name.as_bytes();
        let n = bytes.len().min(255);
        w.write_all(&[n as u8])?;
        w.write_all(&bytes[..n])?;
    }
    Ok(())
}

/// A strict flag byte (every field since v4 is strict — see `decode`'s note on `dev_loadout`).
fn strict_bool(c: &mut Cursor, what: &'static str) -> Result<bool, ReplayError> {
    match c.u8()? {
        0 => Ok(false),
        1 => Ok(true),
        b => Err(ReplayError::BadBool(what, b)),
    }
}

/// T23.29: the [`RoundRoster`] a v40 header ends with.
fn read_roster(c: &mut Cursor) -> Result<RoundRoster, ReplayError> {
    let restart = strict_bool(c, "restart")?;
    let private = strict_bool(c, "private")?;
    let bot_seq = c.u32()?;
    let next = c.u16()?;
    let n = c.u8()? as usize;
    let free = c.take(n)?.to_vec();
    let n = c.u8()? as usize;
    let mut seats = Vec::with_capacity(n);
    for _ in 0..n {
        let id = c.u8()?;
        let spectator = strict_bool(c, "spectator")?;
        let skin_id = c.u16()?;
        let tombstone_skin_id = c.u16()?;
        let len = c.u8()? as usize;
        let name = std::str::from_utf8(c.take(len)?)
            .map_err(|_| ReplayError::BadUtf8)?
            .to_string();
        seats.push(RosterSeat {
            id,
            spectator,
            name,
            skin_id,
            tombstone_skin_id,
        });
    }
    Ok(RoundRoster {
        restart,
        private,
        bot_seq,
        next,
        free,
        seats,
    })
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
        ReplayCommand::JoinSpectator { name } => {
            let bytes = name.as_bytes();
            let n = bytes.len().min(255);
            w.write_all(&[n as u8])?;
            w.write_all(&bytes[..n])?;
        }
        ReplayCommand::Ready(id)
        | ReplayCommand::Unready(id)
        | ReplayCommand::Fire(id)
        | ReplayCommand::Leave(id)
        | ReplayCommand::DropUnready(id)
        | ReplayCommand::StartWithBots(id)
        | ReplayCommand::UseHeal(id)
        | ReplayCommand::UseBatteryPack(id)
        | ReplayCommand::QuickThrow(id) => w.write_all(&[*id])?,
        ReplayCommand::SetScale(id, scale) => {
            w.write_all(&[*id])?;
            w.write_all(&[scale_byte(*scale)])?;
        }
        ReplayCommand::SetBots(id, on) => {
            w.write_all(&[*id])?;
            w.write_all(&[u8::from(*on)])?;
        }
        ReplayCommand::SetStartKit(id, kit) => {
            w.write_all(&[*id])?;
            w.write_all(&[kit.as_u8()])?;
        }
        ReplayCommand::SetRoundSeconds(id, secs) => {
            w.write_all(&[*id])?;
            put_f32(w, *secs)?;
        }
        ReplayCommand::SetGravity(id, gravity) => {
            w.write_all(&[*id])?;
            w.write_all(&[gravity.as_u8()])?;
        }
        ReplayCommand::SetMapShape(id, shape) => {
            w.write_all(&[*id])?;
            w.write_all(&[shape.to_u8()])?;
        }
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
        ReplayCommand::DropItem(id, slot) => w.write_all(&[*id, *slot])?,
        ReplayCommand::VoteRestart(id, v) => w.write_all(&[*id, u8::from(*v)])?,
        ReplayCommand::SetPrivate(on) => w.write_all(&[u8::from(*on)])?,
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

/// The inverse, shared by the header and `SetScale`.
///
/// One function because there are now two places a scale byte is read, and two
/// copies of a wire mapping is the drift `CLAUDE.md` names: the next scale added
/// would land in one of them.
fn scale_from_byte(b: u8) -> Result<MapScale, ReplayError> {
    match b {
        0 => Ok(MapScale::Small),
        1 => Ok(MapScale::Medium),
        2 => Ok(MapScale::Large),
        other => Err(ReplayError::BadScale(other)),
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
    if !(REPLAY_VERSION_NO_SHAPE..=REPLAY_VERSION).contains(&version) {
        return Err(ReplayError::BadVersion {
            found: version,
            expected: REPLAY_VERSION,
        });
    }
    let header = ReplayHeader {
        version,
        seed: c.u64()?,
        buried_secret: c.u64()?,
        scale: scale_from_byte(c.u8()?)?,
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
        // **`dev_loadout` is lenient and everything added since is strict, and
        // that is the rule rather than an oversight.** `!= 0` is the convention
        // v1 shipped with; retrofitting it would reject files that are fine, to
        // gain nothing. Fields added from v4 on are decoded strictly, because a
        // corrupt byte that reads as `true` replays a setting the round never
        // had and then diverges somewhere else entirely — and this header is
        // the **authoritative** carrier for both of these from round two, so a
        // wrong value here is not caught by anything downstream.
        dev_loadout: c.u8()? != 0,
        bots_enabled: {
            let b = c.u8()?;
            match b {
                0 => false,
                1 => true,
                _ => return Err(ReplayError::BadBool("bots_enabled", b)),
            }
        },
        start_kit: {
            let b = c.u8()?;
            StartKit::from_u8(b).ok_or(ReplayError::BadStartKit(b))?
        },
        // Strict, like everything added since v4: a corrupt byte that read as a
        // mode the round never played would replay a different game.
        gravity: {
            let b = c.u8()?;
            GravityMode::from_u8(b).ok_or(ReplayError::BadGravity(b))?
        },
        // T23.30: strict like gravity; absent before v38, where it can only be Random.
        map_shape: if version == REPLAY_VERSION_NO_SHAPE {
            MapShape::Random
        } else {
            let b = c.u8()?;
            MapShape::from_u8(b).ok_or(ReplayError::BadMapShape(b))?
        },
        // T23.31: strict; absent before v39, where every round was drawn classic.
        world_look: if version < REPLAY_VERSION_NO_ROSTER {
            WorldLook::Classic
        } else {
            let b = c.u8()?;
            WorldLook::from_u8(b).ok_or(ReplayError::BadWorldLook(b))?
        },
        // T23.29: both absent before v40 — the default warmup, and no roster.
        warmup_seconds: if version < REPLAY_VERSION {
            game_core::constants::WARMUP_SECONDS
        } else {
            c.f32()?
        },
        roster: if version < REPLAY_VERSION {
            RoundRoster::default()
        } else {
            read_roster(&mut c)?
        },
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

    infer_privacy(&mut body);
    Ok(Replay {
        header,
        body,
        footer,
    })
}

/// T23.29 item 4: give a file recorded before `SetPrivate` (tag 26) existed the privacy its room had.
///
/// **The inference is sound in one direction only.** A private-only setting (`SetBots`, `SetStartKit`,
/// `SetRoundSeconds`, `SetGravity`, `SetMapShape`) is recorded only when `check_settings_change` accepted it, and that
/// refuses every public room — so one in the file proves the room was private, and a `SetPrivate(true)` at tick 0
/// (where the registry's `SetIdentity` landed, before any seat) is what the live room had. A private lobby whose host
/// changed nothing leaves no trace and stays unrecoverable. A file that carries any `SetPrivate` is left alone.
fn infer_privacy(body: &mut Vec<(u32, ReplayCommand)>) {
    let said = body
        .iter()
        .any(|(_, c)| matches!(c, ReplayCommand::SetPrivate(_)));
    let private_only = body.iter().any(|(_, c)| {
        matches!(
            c,
            ReplayCommand::SetBots(..)
                | ReplayCommand::SetStartKit(..)
                | ReplayCommand::SetRoundSeconds(..)
                | ReplayCommand::SetGravity(..)
                | ReplayCommand::SetMapShape(..)
        )
    });
    if !said && private_only {
        body.insert(0, (0, ReplayCommand::SetPrivate(true)));
    }
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
        24 => {
            let n = c.u8()? as usize;
            let name = std::str::from_utf8(c.take(n)?)
                .map_err(|_| ReplayError::BadUtf8)?
                .to_string();
            ReplayCommand::JoinSpectator { name }
        }
        2 => ReplayCommand::Ready(c.u8()?),
        17 => ReplayCommand::Unready(c.u8()?),
        18 => ReplayCommand::SetScale(c.u8()?, scale_from_byte(c.u8()?)?),
        // A byte that is not 0 or 1 is a corrupt file, not a `true`: decoding it
        // leniently would replay a setting the round never had.
        19 => ReplayCommand::SetBots(
            c.u8()?,
            match c.u8()? {
                0 => false,
                1 => true,
                b => return Err(ReplayError::BadBool("bots", b)),
            },
        ),
        20 => ReplayCommand::SetStartKit(c.u8()?, {
            let b = c.u8()?;
            StartKit::from_u8(b).ok_or(ReplayError::BadStartKit(b))?
        }),
        21 => ReplayCommand::SetRoundSeconds(c.u8()?, c.f32()?),
        23 => ReplayCommand::SetGravity(c.u8()?, {
            let b = c.u8()?;
            GravityMode::from_u8(b).ok_or(ReplayError::BadGravity(b))?
        }),
        25 => ReplayCommand::SetMapShape(c.u8()?, {
            let b = c.u8()?;
            MapShape::from_u8(b).ok_or(ReplayError::BadMapShape(b))?
        }),
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
        // Strict, like every flag added since v4.
        26 => ReplayCommand::SetPrivate(match c.u8()? {
            0 => false,
            1 => true,
            b => return Err(ReplayError::BadBool("private", b)),
        }),
        4 => ReplayCommand::UseItem(c.u8()?, c.u8()?),
        5 => ReplayCommand::SelectSlot(c.u8()?, c.u8()?),
        6 => ReplayCommand::Fire(c.u8()?),
        // 7 was `ToggleFlashlight`, retired with the toggle in T20.07. The tag is
        // left as a hole rather than reused: `REPLAY_VERSION` moved in the same
        // change, so no file that could contain a 7 will ever reach this match,
        // and renumbering the tags below it would make every other command's
        // encoding depend on this one's removal.
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
        22 => ReplayCommand::DropItem(c.u8()?, c.u8()?),
        other => return Err(ReplayError::BadTag(other)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("probe-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// The presence half: a writable directory (created if missing) passes,
    /// comes back absolute, and the probe leaves nothing in it.
    #[test]
    fn probe_writable_accepts_a_writable_dir_and_leaves_it_empty() {
        let dir = scratch("ok").join("nested");
        let abs = probe_writable(&dir).expect("a fresh temp dir is writable");
        assert!(abs.is_absolute(), "{abs:?} is not absolute");
        assert_eq!(fs::read_dir(&dir).expect("created").count(), 0);
        let _ = fs::remove_dir_all(dir.parent().expect("parent"));
    }

    /// The absence half. A directory under a regular *file* cannot be created
    /// by anyone, root included — a mode-bit fixture would pass for a test run
    /// as root and prove nothing.
    #[test]
    fn probe_writable_rejects_a_dir_that_cannot_be_written() {
        let base = scratch("bad");
        fs::create_dir_all(&base).expect("base");
        let file = base.join("not-a-dir");
        fs::write(&file, b"x").expect("file");
        let err = probe_writable(&file.join("recordings"));
        assert!(matches!(err, Err(ReplayError::Io(_))), "{err:?}");
        let _ = fs::remove_dir_all(&base);
    }

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
            // Both off the default, for the reason above.
            bots_enabled: false,
            start_kit: StartKit::All,
            // Off the default too, for the reason above.
            gravity: GravityMode::Space,
            // T23.30: off the default too.
            map_shape: MapShape::Flat,
            // T23.31: off the default too.
            world_look: WorldLook::Volcanic,
            // T23.29: the default — a v37/v38/v39 fixture cut from this reads it back as that.
            warmup_seconds: game_core::constants::WARMUP_SECONDS,
            // T23.29: a round-one file's — the v37/v38/v39 fixtures below cut `V40_TAIL_BYTES` off it.
            roster: RoundRoster::default(),
        }
    }

    fn every_command() -> Vec<ReplayCommand> {
        vec![
            ReplayCommand::Join {
                name: "ana".into(),
                skin_id: 3,
            },
            ReplayCommand::JoinSpectator {
                name: "watcher".into(),
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
            ReplayCommand::VoteRestart(5, true),
            ReplayCommand::VoteRestart(5, false),
            ReplayCommand::Leave(5),
            ReplayCommand::DropUnready(4),
            ReplayCommand::Checkpoint {
                tick: 600,
                hash: [7u8; 32],
            },
            ReplayCommand::StartWithBots(0),
            ReplayCommand::UseHeal(1),
            ReplayCommand::UseBatteryPack(1),
            ReplayCommand::QuickThrow(2),
            ReplayCommand::MoveItem(2, 3, 4),
            ReplayCommand::DropItem(2, 5),
            ReplayCommand::Unready(0),
            ReplayCommand::SetScale(0, MapScale::Large),
            ReplayCommand::SetBots(0, false),
            ReplayCommand::SetBots(0, true),
            ReplayCommand::SetStartKit(0, StartKit::Basic),
            ReplayCommand::SetStartKit(0, StartKit::All),
            ReplayCommand::SetRoundSeconds(0, 300.0),
            ReplayCommand::SetGravity(0, GravityMode::Low),
            ReplayCommand::SetGravity(0, GravityMode::Space),
            ReplayCommand::SetMapShape(0, MapShape::Hill),
            ReplayCommand::SetMapShape(0, MapShape::Random),
            ReplayCommand::SetPrivate(true),
            ReplayCommand::SetPrivate(false),
        ]
    }

    /// Forces `every_command` to stay complete.
    ///
    /// It was not: tags 12–16 (`StartWithBots` through `MoveItem`) were added
    /// without being added here, so five commands had never been round-tripped
    /// and a bad encoder for any of them would have shipped green. A list whose
    /// name is "every" and which is not is worse than no list, because it is the
    /// one a reader trusts.
    ///
    /// This is a `match` rather than a count so the compiler names the missing
    /// variant instead of a test reporting a number.
    #[test]
    fn every_command_really_is_every_command() {
        fn assert_listed(c: &ReplayCommand) {
            match c {
                ReplayCommand::Join { .. }
                | ReplayCommand::JoinSpectator { .. }
                | ReplayCommand::Ready(_)
                | ReplayCommand::Unready(_)
                | ReplayCommand::SetScale(..)
                | ReplayCommand::SetBots(..)
                | ReplayCommand::SetStartKit(..)
                | ReplayCommand::SetRoundSeconds(..)
                | ReplayCommand::Input(..)
                | ReplayCommand::UseItem(..)
                | ReplayCommand::SelectSlot(..)
                | ReplayCommand::Fire(_)
                | ReplayCommand::VoteRestart(..)
                | ReplayCommand::Leave(_)
                | ReplayCommand::DropUnready(_)
                | ReplayCommand::Checkpoint { .. }
                | ReplayCommand::StartWithBots(_)
                | ReplayCommand::UseHeal(_)
                | ReplayCommand::UseBatteryPack(_)
                | ReplayCommand::QuickThrow(_)
                | ReplayCommand::MoveItem(..)
                | ReplayCommand::DropItem(..)
                | ReplayCommand::SetGravity(..)
                | ReplayCommand::SetMapShape(..)
                | ReplayCommand::SetPrivate(_) => {}
            }
        }
        let all = every_command();
        for c in &all {
            assert_listed(c);
        }

        // **The count sits here, next to the match, on purpose.** The two guard
        // different things: the `match` guards the *enum*, and this guards
        // `every_command`'s *coverage* of it. Adding a 19th variant breaks the
        // build above — but whoever fixes that compile error can still forget to
        // extend `every_command`, and a count living in another test would then
        // read 18 against a returned 18 and pass. Sitting here, the number is in
        // front of the person holding the error.
        let tags: std::collections::BTreeSet<u8> = all.iter().map(|c| c.tag()).collect();
        // 22, and **tag 7 is a hole**: `ToggleFlashlight` retired with the toggle
        // in T20.07, and its number was not reused. The count is a coverage check
        // on `every_command`, not an assertion that the tags are contiguous —
        // renumbering would have made every later command's encoding depend on
        // this one's removal, for nothing.
        // T23.27: 23 with `JoinSpectator` (tag 24). T23.30: 24 with `SetMapShape` (25). T23.29: 25 with `SetPrivate` (26).
        assert_eq!(
            tags.len(),
            25,
            "`every_command` returns {} distinct tags, not 25 — a variant was \
             added to the match above without being added to the list: {tags:?}",
            tags.len()
        );
        assert!(
            !tags.contains(&7),
            "tag 7 came back: it is `ToggleFlashlight`'s retired number (T20.07) \
             and reusing it would make a v5 file's 7 mean something a reader of \
             this code would not expect"
        );
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

    /// T23.29 item 4: a file from before `SetPrivate` that holds a private-only setting decodes **private** — the
    /// owner's round's shape — and one with no such setting, or one that says its privacy, is left exactly as written.
    #[test]
    fn a_file_from_before_set_private_gets_its_privacy_back() {
        let old = [
            (
                0,
                ReplayCommand::Join {
                    name: "ana".into(),
                    skin_id: 0,
                },
            ),
            (231, ReplayCommand::SetStartKit(0, StartKit::All)),
        ];
        let got = decode(&encode_round(&header(), &old)).expect("decode");
        assert_eq!(
            got.body.first(),
            Some(&(0, ReplayCommand::SetPrivate(true)))
        );
        assert_eq!(&got.body[1..], &old[..], "the recorded commands moved");
        // Controls: nothing private-only, and a file that names its privacy itself.
        let public = [(
            0,
            ReplayCommand::Join {
                name: "ana".into(),
                skin_id: 0,
            },
        )];
        assert_eq!(
            decode(&encode_round(&header(), &public))
                .expect("decode")
                .body,
            public
        );
        let said = [
            (0, ReplayCommand::SetPrivate(false)),
            (231, ReplayCommand::SetStartKit(0, StartKit::All)),
        ];
        assert_eq!(
            decode(&encode_round(&header(), &said))
                .expect("decode")
                .body,
            said
        );
    }

    #[test]
    fn a_round_with_no_commands_is_valid_and_minimal() {
        let h = header();
        let bytes = encode_round(&h, &[]);
        let r = decode(&bytes).expect("decode");
        assert_eq!(r.header, h);
        assert!(r.body.is_empty());
        assert_eq!(
            bytes.len(),
            HEADER_BYTES + V40_TAIL_BYTES,
            "header size is pinned"
        );
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

    /// T23.30: a **v37** file — written before the shape byte — still reads, as
    /// Random, with its body intact; a v38 header carries the shape (the fixture's
    /// `Flat`, off the default); and a shape byte naming no shape is refused.
    /// T23.29 item 2: **a restart's roster round-trips** — seats (a spectator among them), the id pool in stack order and
    /// the bot counter, every field off its default — and a v39 file (no roster) still reads, as an empty one, with its
    /// body aligned. Strict flags: a `2` in `restart` is a corrupt file.
    #[test]
    fn a_v40_header_carries_the_round_roster_and_a_v39_file_reads_without_one() {
        let mut h = header();
        h.warmup_seconds = 1.5;
        h.roster = RoundRoster {
            restart: true,
            private: true,
            bot_seq: 70_000,
            next: 9,
            free: vec![7, 3, 5],
            seats: vec![
                RosterSeat {
                    id: 0,
                    spectator: false,
                    name: "ana".into(),
                    skin_id: 4,
                    tombstone_skin_id: 2,
                },
                RosterSeat {
                    id: 6,
                    spectator: true,
                    name: "watcher".into(),
                    skin_id: 0,
                    tombstone_skin_id: 0,
                },
            ],
        };
        let body = [(3u32, ReplayCommand::Ready(1))];
        let got = decode(&encode_round(&h, &body)).expect("v40");
        assert_eq!(got.header, h, "the roster did not round-trip");
        assert_eq!(got.body, body);

        let empty = encode_round(&header(), &body);
        let mut v39 = empty.clone();
        v39.drain(HEADER_BYTES..HEADER_BYTES + V40_TAIL_BYTES);
        v39[4..6].copy_from_slice(&REPLAY_VERSION_NO_ROSTER.to_le_bytes());
        let old = decode(&v39).expect("a v39 file must still read");
        assert_eq!(old.header.roster, RoundRoster::default());
        assert_eq!(
            old.header.world_look,
            WorldLook::Volcanic,
            "v39 header misaligned"
        );
        assert_eq!(old.body, body, "v39 body misaligned");

        let mut bad = empty;
        bad[HEADER_BYTES + 4] = 2;
        assert!(matches!(
            decode(&bad),
            Err(ReplayError::BadBool("restart", 2))
        ));
    }

    #[test]
    fn a_v37_file_reads_as_random_and_a_v38_header_carries_the_shape() {
        let h = header();
        let body = [(3u32, ReplayCommand::Ready(1))];
        let v38 = encode_round(&h, &body);
        let now = decode(&v38).expect("v38");
        assert_eq!(now.header.map_shape, MapShape::Flat);
        assert_eq!(now.header.version, REPLAY_VERSION);

        // The same round as v37 wrote it: no shape byte (nor T23.31's look), version 37.
        let mut v37 = v38.clone();
        v37.drain(HEADER_BYTES - 2..HEADER_BYTES + V40_TAIL_BYTES);
        v37[4..6].copy_from_slice(&REPLAY_VERSION_NO_SHAPE.to_le_bytes());
        let old = decode(&v37).expect("a v37 file must still read");
        assert_eq!(old.header.map_shape, MapShape::Random);
        assert_eq!(old.header.gravity, h.gravity, "v37 header misaligned");
        assert_eq!(old.body, now.body, "v37 body misaligned");

        assert_eq!(old.header.world_look, WorldLook::Classic);

        let mut bad = v38;
        bad[HEADER_BYTES - 2] = 0xEE;
        assert!(matches!(decode(&bad), Err(ReplayError::BadMapShape(0xEE))));
    }

    /// T23.31: a **v38** file — written before the look byte — still reads, as
    /// Classic, with its shape and body intact; a v39 header carries the look (the
    /// fixture's `Volcanic`, off the default); a look byte naming no look is refused.
    #[test]
    fn a_v38_file_reads_as_classic_and_a_v39_header_carries_the_look() {
        let h = header();
        let body = [(3u32, ReplayCommand::Ready(1))];
        let v39 = encode_round(&h, &body);
        let now = decode(&v39).expect("v39");
        assert_eq!(now.header.world_look, WorldLook::Volcanic);
        assert_eq!(now.header.version, REPLAY_VERSION);

        let mut v38 = v39.clone();
        v38.drain(HEADER_BYTES - 1..HEADER_BYTES + V40_TAIL_BYTES);
        v38[4..6].copy_from_slice(&REPLAY_VERSION_NO_LOOK.to_le_bytes());
        let old = decode(&v38).expect("a v38 file must still read");
        assert_eq!(old.header.world_look, WorldLook::Classic);
        assert_eq!(old.header.map_shape, h.map_shape, "v38 header misaligned");
        assert_eq!(old.body, now.body, "v38 body misaligned");

        let mut bad = v39;
        bad[HEADER_BYTES - 1] = 0xEE;
        assert!(matches!(decode(&bad), Err(ReplayError::BadWorldLook(0xEE))));
    }

    /// T23.31: a recording's header says the look `map_init` sent — the map's own
    /// rule on the header's seed, for seeds of each look; a space round, `Classic`.
    #[test]
    fn a_header_records_the_look_the_map_was_drawn_in() {
        let mut seen = Vec::new();
        for seed in 1u64..=16 {
            let c = Config {
                fixed_seed: Some(seed),
                map_scale: MapScale::Small,
                ..Config::default()
            };
            let h = ReplayHeader::from_config(&c, seed, 0);
            let map = game_core::map::generate_full_shaped(
                seed,
                c.map_scale,
                0,
                MapGenerator::for_gravity(c.gravity, c.map_generator),
                c.map_shape,
            );
            assert_eq!(h.world_look, map.meta.look, "seed {seed}");
            if !seen.contains(&h.world_look) {
                seen.push(h.world_look);
            }
        }
        assert_eq!(
            seen.len(),
            WorldLook::ALL.len(),
            "16 seeds recorded only {seen:?}"
        );
        for seed in 1u64..=16 {
            let c = Config {
                gravity: GravityMode::Space,
                ..Config::default()
            };
            assert_eq!(
                ReplayHeader::from_config(&c, seed, 0).world_look,
                WorldLook::Classic
            );
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
        // Pinned to the constant: this was the literal `9`, which went on meaning "a
        // version that is not this one" right up until T21.39 made 9 the current one.
        wrong_version[4..6].copy_from_slice(&(REPLAY_VERSION + 1).to_le_bytes());
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
        // T23.31: the look is not a setting — `from_config` derives it from the seed
        // the way the map does (space: none), so it is the rule's, not the fixture's.
        assert_eq!(
            again.world_look,
            game_core::map::meta::world_look_for(
                h.seed,
                MapGenerator::for_gravity(h.gravity, h.generator)
            )
        );
        let h = ReplayHeader {
            min_players_to_start: 0,
            world_look: again.world_look,
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
        // Coverage is asserted by `every_command_really_is_every_command`, which
        // holds both the exhaustive match and the count. This test owns one
        // thing: that no two variants share a tag.
        //
        // The count used to live here and had gone stale — it said 11 while the
        // enum had grown to 16, and its message still said 10, so it passed
        // while the thing it guarded moved underneath it. Splitting the two
        // claims is what stops that recurring: a number far from what it counts
        // is a number nobody updates.
        assert!(
            !one_of_each.is_empty(),
            "every_command() returned nothing, so uniqueness below is vacuous"
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
    ///
    /// **The version field is the one value taken from the constant** (§F5 moved
    /// it to 3). Everything after it is still a hand-written literal, which is
    /// what this fixture is for: a shift in `bot_count`/`bot_skill`/`dev_loadout`
    /// is exactly what it catches, and the version is not one of those fields —
    /// it is the gate in front of them, and a fixture pinned to an old version
    /// only ever tests the gate.
    fn header_bytes(version: u16) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&REPLAY_MAGIC.to_le_bytes());
        v.extend_from_slice(&version.to_le_bytes()); // version
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
        v.push(0); // bots_enabled — off, so it is not the default
        v.push(1); // start_kit — Basic, so it is not the default
        v.push(2); // gravity — Space, so it is not the default
                   // T23.30: the map shape — Hill, off the default — from v38 on.
        if version != REPLAY_VERSION_NO_SHAPE {
            v.push(1);
        }
        // T23.31: the world look — Volcanic, off the default — from v39 on.
        if version >= REPLAY_VERSION_NO_ROSTER {
            v.push(1);
        }
        // T23.29: an empty round roster from v40 on.
        if version == REPLAY_VERSION {
            v.extend_from_slice(&2.5f32.to_le_bytes()); // warmup — off the default
            v.extend_from_slice(&[0; V40_TAIL_BYTES - 4]);
        }
        v
    }

    #[test]
    fn a_header_written_by_hand_still_parses_field_for_field() {
        let bytes = header_bytes(REPLAY_VERSION);
        assert_eq!(
            bytes.len(),
            HEADER_BYTES + V40_TAIL_BYTES,
            "the hand-written header is not HEADER_BYTES + V40_TAIL_BYTES long, so this fixture \
             cannot detect a shift in the real one"
        );

        // Header plus an empty body: `decode` tolerates a file with no commands
        // and no footer, which is what a round killed at tick 0 leaves.
        let r = decode(&bytes).expect("a current header must parse");
        let h = r.header;
        assert_eq!(h.version, REPLAY_VERSION);
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
        // §F7's two, appended after everything above. Both written off their
        // defaults, so a decoder that stopped short and left them at
        // `Default::default()` would read `true`/`None` and fail here.
        assert!(!h.bots_enabled, "bots_enabled did not read");
        assert_eq!(h.start_kit, StartKit::Basic, "start_kit did not read");
        // T22.01, appended after those two and written off *its* default for the
        // same reason: a decoder that stopped short would leave this `Standard`.
        assert_eq!(h.gravity, GravityMode::Space, "gravity did not read");
        assert_eq!(h.map_shape, MapShape::Hill, "map_shape did not read");
        assert_eq!(h.world_look, WorldLook::Volcanic, "world_look did not read");
        assert_eq!(h.warmup_seconds, 2.5, "warmup_seconds did not read");
    }

    /// The v4 fields are decoded **strictly**, and `dev_loadout` is not.
    ///
    /// Both halves, because the point is the boundary rather than either rule:
    /// a `2` in a v4 flag is a corrupt file and must say so, and a `2` in
    /// `dev_loadout` is the convention v1 shipped with and must still parse.
    /// Without the second half this passes for a decoder that rejected
    /// everything, which would invalidate every file ever recorded.
    #[test]
    fn a_v4_flag_byte_that_is_not_zero_or_one_is_an_error_and_dev_loadout_is_not() {
        let at = |i: usize, b: u8| {
            let mut v = header_bytes(REPLAY_VERSION);
            v[i] = b;
            decode(&v)
        };
        // The four strict-or-lenient bytes before the map shape (T23.30) and the
        // world look (T23.31, the last byte): dev_loadout, bots_enabled, start_kit,
        // gravity — in that order.
        let n = HEADER_BYTES - 2;
        match at(n - 3, 2) {
            Err(ReplayError::BadBool("bots_enabled", 2)) => {}
            other => panic!("a bots_enabled of 2 must be refused, got {other:?}"),
        }
        match at(n - 2, 9) {
            Err(ReplayError::BadStartKit(9)) => {}
            other => panic!("a start_kit of 9 must be refused, got {other:?}"),
        }
        match at(n - 1, 9) {
            Err(ReplayError::BadGravity(9)) => {}
            other => panic!("a gravity of 9 must be refused, got {other:?}"),
        }
        // The control, and the older convention: `dev_loadout` still takes any
        // non-zero as true, so a file written before v4 keeps parsing.
        let lenient = at(n - 4, 2).expect("a dev_loadout of 2 must still parse");
        assert!(
            lenient.header.dev_loadout,
            "the lenient field read 2 as false"
        );
    }

    /// **A pre-§F5 replay does not load, and that is the intended answer.**
    ///
    /// The task's rule is "a replay that no longer loads is acceptable; a replay
    /// that loads and resolves a knife as something else is not". Nothing in the
    /// header records the item registry, so a v2 file has no way to say that its
    /// round was drawn from a table with five more weighted entries in it —
    /// `place_initial` and `assign_buried_items` would deal a different hand and
    /// the divergence would be silent. The version is where that difference is
    /// declared, and this is the assertion that it is declared at all: the
    /// existing `a_version_mismatch_is_a_clear_error_not_a_misparse` only tests a
    /// version *newer* than this build, which no shipped file ever is.
    #[test]
    fn a_replay_from_the_previous_version_is_refused_rather_than_replayed() {
        // T23.30: v37 is the one older version that reads (`REPLAY_VERSION_NO_SHAPE`
        // — `a_v37_file_reads_as_random_…`), so "the previous version" is the one
        // before it.
        let old = REPLAY_VERSION_NO_SHAPE - 1;
        match decode(&header_bytes(old)) {
            Err(ReplayError::BadVersion { found, expected }) => {
                assert_eq!((found, expected), (old, REPLAY_VERSION));
            }
            other => panic!("a v{old} replay was accepted by a v{REPLAY_VERSION} build: {other:?}"),
        }
        // The control: the same bytes at the current version do parse, so the
        // refusal above is about the version and not about the fixture.
        assert!(
            decode(&header_bytes(REPLAY_VERSION)).is_ok(),
            "the fixture does not parse at any version"
        );
    }
}
