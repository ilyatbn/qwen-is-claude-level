# Architecture survey — how the netcode is actually built

**Taken 2026-09-24 on `claude_builds` (after T22.08D, `9d915ba`), read-only; netcode lines updated after T22.10B (`26996f5`), T22.10D, T22.10F (R89), T22.10G and T22.14C (the final M22 audit's netcode findings, 2026-09-25); staleness pass at the M22 close-out against T22.14A–E.** Written so the next session reads this
instead of re-surveying. Symbols, not line numbers. **Counts and sizes are measurements at that date — re-run the
command before repeating one** (CLAUDE.md: a status line is only valid when taken). The opinion that uses these facts
is `design_thoughts_opus55.md`; this file is facts only.

## The one-line version
Server-authoritative. **`World::step` never runs in the browser during a match.** The client's WASM (`game-wasm`
`GameCore`) holds: a single-body movement predictor for the local player, a mirror of the terrain mask carved only on
server `carve` events, a few pure functions derived from a server-sent seed/clock, and debug helpers. The sandbox is a
different story (see § 1).

## 1. What the client's WASM runs
- `crates/game-wasm/src/lib.rs::GameCore`: a `Map`, `Vec<LocalPlayer>` (body, jump, jetpack, prev_input, PlayerState),
  `Projectiles`, a weather struct, phase, gravity, the vortices and black hole **each with the input seqs it pulls
  for** (`SeqSpan`, T22.14C LOW-4), the bell's seq, and per local player a **history of the movement state after
  each applied seq** (`PREDICTION_HISTORY_TICKS`, T22.14C HIGH-1). **No `World`.** 58 `pub fn` across the two
  `#[wasm_bindgen] impl GameCore` blocks (close-out count; 57 at T22.14C — `relocate_player` is T22.14D's).
- `World::step` appears in one wasm export, `AttractCore::step` — "Frozen, and dormant since T18.01", no caller, a
  hand-copy of `room.rs::drive_bots`. Otherwise only `#[cfg(test)]`.
- **GameScene (networked match)** calls (via GameScene.ts, `net/prediction.ts`, `net/worldMirror.ts`, `render/flareFx.ts`):
  - prediction: `applyInput`, `correctPlayerState` (a reconcile's correction: the acked seq's movement state
    restored, then the snapshot; T22.14C — with the footer's stepped buttons as the previous input, T22.14D),
    `relocatePlayer` (a trip's arrival: the body and every history copy from its seq get the respawn's reset, fuel
    kept; T22.14D), `setPlayerState` (results-screen re-anchor), `playerState`,
    `addPlayer`/`removePlayer` (local), `setPhase`, `acceptsInput` (the `Predictor`'s results-screen switch,
    T22.10E), `setGravity`, `setVortices` (from `WorldMirror.pushVortices`, with seq spans since T22.14C),
    `setBlackHole` (T22.12, from seq since T22.14C), `setBell(seq | null)` (T22.12C; `clear_bell` behind `null`)
  - terrain mirror: `setMapGenerator` (map_init's generator byte, T22.14A B3 — installed before `loadMask`, and the
    one answer to "is this a space map?"), `loadMask` (map_init), `carve`, `carveCapsule` (seq-ordered events), `setTeleportPads`,
    `setGunPlatforms`, `setAsteroids`, `maskHash` (vs `mask_checksum`), `solidAt`, `takeDirtyChunks`/`maskView`
  - derived pure functions: `flarePoints`/`flareLit`/`flareTouches` (server seed + `ServerClock`), `lavaVents`,
    `itemRegistryJson`, `constants_json`, `quantize_angle`, `ambient_rain`
  - debug: `maskHash()`, `countSolid()` on `window.__game`
  - **never** `fire`, `combatStep`, `weatherStep`, `give`, `generate*` — projectiles, carving, damage, items, weather
    are drawn from server events, not predicted. `fieldAccelAt` has no production caller (the field reaches
    prediction through `attractors::env_at` inside `apply_input`).
- **SandboxScene (`?sandbox=1`)** calls `generateForScene` (client runs the generator), `applyInput`, `fire`,
  `combatStep`, `weatherStep`, `forceEffect`, `give`, `selectSlot`, `inventory`, `addBattery`, `shieldActive`,
  `irradiated`, `setMounted`, `liveProjectiles`, `playerState`, `countSolid`, `solidAt`.
  **`GameCore::combat_step` / `weather_step` are a separate mini-simulation**, not `World::step`; their comments list
  rules copied from `World::detonate`, `splash_poison`, `step_placed`, and record past forks (toxic rain, flames and
  bullets once all detonated as bazookas in the sandbox).
- GameScene.ts 3893 lines, SandboxScene.ts 1726 (T22.14C; 3594 / 1690 at the survey), both `extends Phaser.Scene`, no shared base; 186 of Sandbox's 821
  unique non-trivial lines appear verbatim in GameScene. **38 of 87 browser checks load `?sandbox=1`.**

## 2. Server loop and wire
- `SIM_HZ` 60, `SNAPSHOT_HZ` 20 (snapshot every 3 ticks), `MAX_PLAYERS` 6.
- Transport: `game-server` is axum + socketioxide; client `socket.io-client` default `io()` — TCP, reliable, ordered,
  no volatile emits. Snapshots and input batches are **base64 strings**; everything else JSON events.
- Snapshot `codec.rs::encode_snapshot`: **full every time, no delta**. 10-byte header (`SNAPSHOT_HEADER_BYTES`: tick
  u32, round_time **`f32`, the server's own, exact** since T22.14C MED-3 — it was deciseconds truncated to a u16, so
  a death countdown read "5.1s" on a 5 s respawn; darkness u8, count u8) + 28 B/player (`SNAPSHOT_PLAYER_BYTES`: id; pos/vel as **`i32` counts of `SNAPSHOT_QUANTUM` = 1/8 px (px/s), rounded**
  since T22.10H — before, `i16` whole px truncated; aim
  u16; health u8 truncated; flags; fuel; selected item; vision; battery; heals/batteries; teleport charge; move_mods)
  + 5-byte footer (`SNAPSHOT_FOOTER_BYTES`), per recipient: the ack `u32` — since T22.10F the last *simulated* seq,
  real input or stand-in, `World::last_simulated_seq` in `Room::last_seqs`; T22.10B made it the last consumed, before
  that the last received — then **the buttons the server stepped the recipient at it** `u8` (T22.14D F1,
  `World::last_stepped_buttons`: a stand-in's held buttons when the seq was one, not what was sent for it; the
  correction's previous input). 183 B at 6 players before base64 (T22.14D; 182 at T22.14C, 180 at T22.10H, 132 before it).
  Health stays the truncated u8 on purpose: `speed_multiplier` reads `health.floor()` (T22.10H).
- Inputs: `decode_input_batch`, 1..=`INPUT_REDUNDANCY` (3) × {seq u32, aim u16, buttons u8}. `fire`, `use_item`,
  `select_slot` are separate events. **Every in-match verb runs synchronously in arrival order** — `input` since
  T22.10B, and `fire`, `use_item`, `select_slot`, `move_item`, `drop_item`, `use_heal`, `use_battery`, `quick_throw`
  since T22.10D (`Ctx::send_as_player`). socketioxide runs the closure inside the ws read loop and spawns only the
  returned future; tokio ran the newest spawned first (137 dropped seqs in one match; `select_slot` then `fire` fired
  the old weapon 5 of 5 runs). Still `async`: `vote_restart`, `resync_map`, `debug_*`, `start_with_bots`.
  **Intake (T22.10D):** the room accepts up to `MAX_INPUT_QUEUE` per player per tick, now `MAX_FRAME_TICKS` =
  `ceil(MAX_FRAME_DT / SIM_DT)` = 15 (one long client frame; was 8, which dropped the newest 7 of such a frame) — a
  flood guard only. **Since T22.10F (R89) the world steps every player exactly once a tick** (`World::apply_inputs`):
  the next expected input if it has arrived, else a **stand-in** — the newest received input's held buttons and aim
  under the next seq (edges are current-vs-previous, so nothing re-fires). The expected seq is `prev_input`'s and
  advances one per simulated tick; inputs at or below it are discarded (after updating the held state, `newest_input`);
  future ones wait in a jitter buffer of `INPUT_BACKLOG_TARGET` (2), oldest excess dropped. A stand-in claims a seq only
  within `MAX_FRAME_TICKS` of the newest sent, and none before the first. Seq 0 = "numbered by the world" (bots). No
  hover, no two-step ticks; the T22.10D/E catch-up credit is gone. `Ended`: neutral ticks, seq frozen (T21.30).
  **Since T22.10G the buffer has its lead:** a client's first input waits `INPUT_BACKLOG_TARGET` ticks (`input_wait`)
  unless more are queued (a trim, which keeps the same lead), so a stand-in needs a gap longer than ~33 ms; before its
  first input a player is not stepped in `Lobby`/`Warmup` (a neutral, seq-less step in `Playing`). Seq-0 inputs start
  at once. **Measured, not guessed:** `Room`'s per-seat `StreamStats` (real / stood / still / trimmed ticks, read off
  the ack) is logged `game::net` info on leave — `GAME_LOG=warn,game::net=info` makes `harness.mjs` print it. Stood-in
  share after T22.10G: 23–28 % on `thrusters-match` (a ~4-tick frame against a 2-tick lead), 1–19 % in the other networked checks.
- Events: `events.rs::scope_of` — `Only(owner)`: Inventory; `Pair(victim, attacker)`: Damage; `Everyone`: all else
  (carves, explosions, `vortex_open`/`vortex_close`/`vortex_trip`, `teleport`, `black_hole`/`black_hole_warn`
  (T22.12, both in the join catch-up), the dev-only `relocate` (T22.12D F3), projectile spawn/move/despawn at `SNAPSHOT_HZ`, hitscan, items, birds, animals, deaths,
  effects, hazards, phase, round). Every attractor event carries its `tick`, which the mirror keys the pull's
  switch-over to (T22.14C LOW-4).
- Terrain: never diffs. `carve`/`carve_capsule` carry a shared `seq`; `worldMirror.ts::applyCarve` buffers in order; a
  gap > `CARVE_GAP_TIMEOUT_MS` (2000) → `resync_map` (full `map_init`). `mask_checksum` every
  `MASK_CHECKSUM_INTERVAL` 5 s; mismatch → resync. `map_init` (`encode_map_init_at`, magic `0x4D415031`): RLE mask +
  the generator byte after `theme` (T22.14A B3; an unknown byte refused by both decoders, bound `MAP_GENERATOR_MAX` in
  `constants_json` since T22.14D), carve_seq, spawns, pads, platforms, decorations, objects, asteroids (buried slots
  deliberately omitted). Full layout: `docs/77` §H4.
- Mid-match joins are refused (§E4); the effect catch-up (T22.08D) is dormant.

## 3. Prediction and reconciliation
- `prediction.ts::Predictor`, local player only. GameScene runs a fixed-step accumulator at `SIM_DT`; each step
  `localInput.sample(++seq)` → `pushInput` → `core.applyInput`; since T22.10B sends **every** input of the frame, in packets of ≤ `INPUT_REDUNDANCY` (no
  overlap, so no actual redundancy; `codec.ts::inputPackets` since T22.10D). A 15-tick frame (`MAX_FRAME_DT` 0.25 s,
  now also in `constants.rs` and pinned by `constants-parity.test.ts`) sends 15; since T22.10F the server has already
  stood in for them with the held input, so they arrive already simulated and are discarded. (Before T22.10B only the
  last 3 were sent.) **The fixed step runs on `performance.now()` since T22.10F**, not Phaser's `delta` (which clamps an
  unfocused page to 16.7 ms a frame — a quarter of real time at 15 fps, harmless only while the server waited for
  inputs). A frame's inputs are produced at its end, so on a slow page the server has stood in for the first of them
  and acked it before they arrive: `Predictor.standIn` runs the same stand-ins locally (last pushed buttons/aim, within
  `MAX_FRAME_TICKS`) and skips those seqs when they are pushed. The client's body therefore **trails** the server's
  by up to one frame (it used to lead it).
- `reconcile`: drop acked inputs; **since T22.10D the gate compares the prediction *at the acked input* with the
  server's state there** (position ≤ `RECONCILE_EPSILON_PX` 2.0, and velocity error × one snapshot interval ≤ the
  same), with move_mods, alive and health unchanged → do nothing; else `correctPlayerState` (since T22.14C; the acked seq's
  movement state restored, then pos, vel, grounded, fuel, health, alive, move_mods — `setPlayerState` before) and
  replay pending. (Before, it compared the *post-pending* prediction, so it almost never
  held while moving.) The render hard-snaps on how far the correction moved the body (`lastJumpPx` > `SNAP_PX`), not
  on that error. `PredictorStats.lastJumpPx`/`lastAckErrorPx` (T22.10B) are the honest rubber-band measures;
  `maxEasedJumpPx`/`maxAckErrorPx` (T22.10D) exclude relocations and are printed per client by `harness.mjs` at close;
  since T22.10E/F they also leave out (as `settled`) the first ack (an anchor), an ack gap, an `alive` flip, a repeated
  ack while the phase takes input and the first new ack after it (lost time: frames over `MAX_FRAME_DT`), a
  results-screen re-anchor past the catch-up cap, and since T22.10G an ack-0 correction with inputs pending and an ack
  that ran more seqs than server ticks (a trim). `stats.worstJump` (T22.10G) holds the worst counted jump's context
  (ack/tick step, pending, ack error, speed) and `harness.mjs` prints it. The fixed step's first frame elapses 0. `Predictor.relocate` + `RemoteInterpolator.cut` via `GameScene.onRelocated`
  handle pad `teleport`, `vortex_trip` and the dev `relocate` (T22.12D F3) — **measured at the event's tick**
  (T22.12E F1): a snapshot at or past it already carried the move; before it, the arrival is compared with the
  prediction at that tick's seq (`seqClock.ts::seqAtTick`), and a short move is marked as the event's. The core
  predicts no relocation (no pad, no trip). Render eases at
  `RENDER_SMOOTH_PER_SEC` 12, hard snap > `SNAP_PX` 64. Server position/velocity arrive rounded to 1/8 px (T22.10H;
  worst `lastAckErrorPx` per client, 2 runs: `radiation-match` 2.12–2.61 → 1.40–2.24 px, `breach-vortex` 2.02–2.25 →
  2.08–2.23 (not the wire's: its pull arm 1.00–1.09 → 0.10–0.13), `black-hole`'s pull arm 1.26 → 0.19); `JumpState` and `prev_input` are not on the wire. **Since T22.14C (HIGH-1) a
  correction restores them — with the jetpack state and `airborne_ticks` — from the mirror's copy at the acked seq**
  (`GameCore::correct_player_state`): before, the replay's first input compared its edges against the *newest* pushed
  input, so a jump pressed inside the pending window and still held lost its edge on every correction (43.5 px in
  the vitest). A dead player's input stream advances in the mirror as on the server (`prev_input`), and `alive`
  false → true resets jump, jetpack and airborne ticks as `PlayerState::respawn` does (a JUMP held through a respawn
  was a phantom jump). **Since T22.14D** the restored previous input's buttons are the snapshot's stepped buttons: a
  press sent under seqs the server stood in for (a hiccup) is stepped a stand-in late, and replayed against the
  client's own copy it was no edge (19 px off in the unit, 63 px in the review's browser run). A pad or vortex trip
  (`Predictor.relocate`) resets jump and jetpack (fuel kept) and the body, now and in the history from the trip's
  seq, as `fire_pads` / `step_vortices` (and `dev_relocate`) do.
- Remotes: `interpolation.ts::RemoteInterpolator`, `INTERP_DELAY_MS` 100, `MAX_EXTRAPOLATION_MS` 250, keyed on local
  arrival time.
- **Four clocks in GameScene:** `ClockSync` (EWMA, debug HUD only), `render/weather-math.ts::ServerClock` (monotonic,
  slews; flare), `roundTime` (extrapolated `+= dt`; since T22.14C never stepped back by a late snapshot —
  `seqClock.ts::roundClockOnSnapshot`, a restart or a lead past `MAX_FRAME_DT` adopted whole), `serverRoundTime`
  (last snapshot, exact since T22.14C). The death countdown is clamped to `RESPAWN_DELAY`.
- Every movement modifier `apply_input` reads must reach the client as a wire bit + a `GameCore` setter, or the
  predictor rubber-bands (see § 6).
- **The seq ↔ tick mapping has one spelling, `client/src/net/seqClock.ts`** (T22.14C LOW-5): a snapshot says seq
  `ack` ran on tick `snap_tick`, one seq a tick (R89), so `seqAtTick(t) = ack + t − snap_tick`; something the server
  did on tick `t` (after that tick's `apply_inputs`) first changes seq `firstSeqAfter(t) = seqAtTick(t + 1)`. Its
  readers: the bell, `Predictor.enterNeutral`/`predictionAt`, and the attractors' switch-over. `MAX_FRAME_TICKS` is
  exported through `constants_json` (it was re-derived twice in TS).
- **The bell (T22.12C F5, T22.12D, T22.14C):** from the last `Playing` `round_state`'s integer **`ends_tick`**:
  bell seq = `firstSeqAfter(ends_tick)` = `ack + ends_tick − snap_tick + 1`, re-derived on every snapshot and
  handed to `GameCore::set_bell` before the reconcile replays. **One `past_bell(seq)`** (T22.14C MED-2) zeroes the
  buttons and stops the hole's pull from that seq on — it was two copies (the pull by seq, the buttons by the heard
  phase), so a walk held across the bell was predicted walking until `ended` was heard (16.28 px at 6 ticks late in
  the Rust side-by-side). `black_hole::bell_seq` is gone; `game-core`'s
  `the_bell_predicted_at_round_start_is_the_servers` states the rule against the server for every round length.
- **The attractors switch on the right seq** (T22.14C LOW-4): `vortex_open`/`vortex_close`/`black_hole` carry
  `tick`; `WorldMirror.anchorSeqs` (every snapshot, while the phase takes input) hands the core each vortex's
  `firstSeqAfter(open)..firstSeqAfter(close)` and the hole's `firstSeqAfter(arrival)`, so a replay of a seq the
  server stepped before the event is stepped without it (a vortex heard 6 ticks late, corrected from 4 before it:
  7.07 px → 0 in the Rust side-by-side). In `Ended` (no anchor) an event switches at once, as before.
- **R100 (T22.14C):** `attractors::env_at` takes `MoveMods::flying`: a winged body in space feels no field (wells,
  vortex pull, hole pull); capture radii and the horizon are radii and still apply. Both sides pass the same
  derivation (the mirror's from the move-mod byte).

## 4. Determinism
- `docs/01-architecture.md` "Determinism, and how far it needs to go": cross-platform float determinism **not required,
  not attempted**; required only "for a given build on a given platform". (It also says clients never run the
  generator — the sandbox and preview do.)
- `World::state_hash`: replay checkpoints every `CHECKPOINT_STRIDE` 600 ticks + footer (`game-server/src/bin/replay.rs`,
  `tests/replay_run.rs`, `tests/replay.rs`) and tests. **Not exchanged client↔server** — only the mask hash is.
- **No test compares wasm vs native output**; game-wasm tests run natively. `golden.rs` is native only.
- game-core: `f32` 1820 lines, `f64` 61; 50 transcendental calls (map gen, `effects/flare.rs` 6, `world/mod.rs` 5);
  no `libm` dependency (wasm32 gets Rust's libm port, native gets glibc — they can differ in the last bit).
- Replays (`replay.rs`, magic "RPL1", `HEADER_BYTES` 46): seed + ordered `ReplayCommand`s; `REPLAY_VERSION` 26 (T22.14C; 19 at T22.10G). The
  header does not record the weather mode.

## 5. Authority and exposure
- Client sends only input bits, aim, seq, plus fire/use/select/vote/resync. Hits, damage, carving, pickups, weather
  are server-side.
- Vision is **client-side only** (`render/lightmap-math.ts::fovRadius` is the live copy; Rust `cycle::fov_radius` has
  no production caller). `encode_snapshot(world, _for_player, …)` **ignores the recipient**: every player's position,
  velocity, aim, health, selected item, heal/battery counts, battery and fuel go to everyone; projectile/item/hitscan
  events are `Everyone`. (`Inventory` is owner-only for "information disclosure", yet counts are in every snapshot.)

## 6. Where the bugs have come from (keyword counts: JOURNAL lines / task files)
sandbox 77/74 · clock 66/53 · mirror 43/52 · predict 42/53 · duplicate/second copy 27/30 · diverg 19/31 ·
desync/resync 18/16 · reconcil 9/9 · parity 10/5 · rubber-band 1/14. Representative:
T20.19 (wasm `apply_input` passed literal 1.0 for `speed_multiplier()` → permanent rubber-band when damaged);
T20.21 (u8-truncated health feeds `speed_multiplier()`); T22.11C (client had no asteroids → predicted no field);
T21.11B / T22.02 / T21.30 (mount bit, gravity, phase each had to be plumbed to the mirror or it rubber-banded);
T13.01 (GameScene never rebaked terrain — the sandbox grew every feature first); T13.06.2 (melee carve broadcast 8 px
off → every client resynced); T19.24 (lava lit in sandbox, dark in the match); T22.08D/E (flare clock from things
other than the server; TCP stall stepped it back 213 ms); T9.02 ("every addition has to be made twice");
`AttractCore::step` (unexercised hand-copy of `drive_bots`).

## 7. Scale
**Re-measured at T22.14C (2026-09-25)** — `find … -name '*.rs' | xargs cat | wc -l` and the like; the first survey's
numbers in brackets. Rust: game-core 79 522 lines (src 70 651, tests/ 8 871) [70 464], game-server 28 015 [25 485],
game-wasm 5 853 [4 628] — 113 390 total [100 577]. client/src TS 47 926 (32 847 non-test) [44 286 / 30 525]. Largest:
`world/mod.rs` 14 426, `game-wasm/lib.rs` 5 853, `constants.rs` 4 483, `room.rs` 4 072, `GameScene.ts` 3 893,
`map/meta.rs` 2 957, `session.rs` 2 298, `SandboxScene.ts` 1 726, `codec.rs` 1 672 (TS twin `codec.ts` 472,
hand-written both sides); `bots/` 5 281 over its files since T22.14B's split (`bots/mod.rs` 1 313).
Tests: Rust `^\s*#\[test\]` 1674 (+26 `#[ignore`), vitest 1110 (79 files, one run), browser checks 89 entries in
`scripts/lib/e2e-checks.mjs` [87] — **90 at the close-out** (`chunk-rebake`; `vitest` 1113 at T22.14D), 14 of them `flaky: true`.
