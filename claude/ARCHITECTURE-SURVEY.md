# Architecture survey — how the netcode is actually built

**Taken 2026-09-24 on `claude_builds` (after T22.08D, `9d915ba`), read-only.** Written so the next session reads this
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
  `Projectiles`, a weather struct, phase, gravity. **No `World`.** 49 `pub fn` in `impl GameCore`.
- `World::step` appears in one wasm export, `AttractCore::step` — "Frozen, and dormant since T18.01", no caller, a
  hand-copy of `room.rs::drive_bots`. Otherwise only `#[cfg(test)]`.
- **GameScene (networked match)** calls (via GameScene.ts, `net/prediction.ts`, `net/worldMirror.ts`, `render/flareFx.ts`):
  - prediction: `applyInput`, `setPlayerState` (Predictor), `playerState`, `addPlayer`/`removePlayer` (local), `setPhase`, `setGravity`
  - terrain mirror: `loadMask` (map_init), `carve`, `carveCapsule` (seq-ordered events), `setTeleportPads`,
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
- GameScene.ts 3594 lines, SandboxScene.ts 1690, both `extends Phaser.Scene`, no shared base; 186 of Sandbox's 821
  unique non-trivial lines appear verbatim in GameScene. **38 of 87 browser checks load `?sandbox=1`.**

## 2. Server loop and wire
- `SIM_HZ` 60, `SNAPSHOT_HZ` 20 (snapshot every 3 ticks), `MAX_PLAYERS` 6.
- Transport: `game-server` is axum + socketioxide; client `socket.io-client` default `io()` — TCP, reliable, ordered,
  no volatile emits. Snapshots and input batches are **base64 strings**; everything else JSON events.
- Snapshot `codec.rs::encode_snapshot`: **full every time, no delta**. 8-byte header (tick u32, round_time deciseconds
  u16, darkness u8, count u8) + 20 B/player (`SNAPSHOT_PLAYER_BYTES`: id; pos/vel as i16 **truncated `as i16`**; aim
  u16; health u8 truncated; flags; fuel; selected item; vision; battery; heals/batteries; teleport charge; move_mods)
  + 4-byte footer (per-recipient `last_input_seq`). 132 B at 6 players before base64. (Its doc comment still says 102.)
- Inputs: `decode_input_batch`, 1..=`INPUT_REDUNDANCY` (3) × {seq u32, aim u16, buttons u8}. `fire`, `use_item`,
  `select_slot` are separate events. `World::apply_inputs` consumes one input per player per tick, backlog capped at
  `MAX_INPUT_QUEUE` 8; **no input that tick → not integrated**.
- Events: `events.rs::scope_of` — `Only(owner)`: Inventory; `Pair(victim, attacker)`: Damage; `Everyone`: all else
  (carves, explosions, projectile spawn/move/despawn at `SNAPSHOT_HZ`, hitscan, items, birds, animals, deaths,
  effects, hazards, phase, round).
- Terrain: never diffs. `carve`/`carve_capsule` carry a shared `seq`; `worldMirror.ts::applyCarve` buffers in order; a
  gap > `CARVE_GAP_TIMEOUT_MS` (2000) → `resync_map` (full `map_init`). `mask_checksum` every
  `MASK_CHECKSUM_INTERVAL` 5 s; mismatch → resync. `map_init` (`encode_map_init_at`, magic `0x4D415031`): RLE mask +
  pads, platforms, asteroids, objects, carve_seq (buried slots deliberately omitted).
- Mid-match joins are refused (§E4); the effect catch-up (T22.08D) is dormant.

## 3. Prediction and reconciliation
- `prediction.ts::Predictor`, local player only. GameScene runs a fixed-step accumulator at `SIM_DT`; each step
  `localInput.sample(++seq)` → `pushInput` → `core.applyInput`; sends `batch.slice(-INPUT_REDUNDANCY)` once per frame.
  **Accumulator cap `MAX_FRAME_DT` 0.25 s (15 ticks) but only the last 3 inputs are sent** — a hitch > 3 ticks applies
  inputs locally that the server never receives.
- `reconcile`: drop acked inputs; if error ≤ `RECONCILE_EPSILON_PX` (2.0) and move_mods unchanged do nothing; else
  `setPlayerState` (pos, vel, grounded, fuel, health, alive, move_mods) and replay pending. Render eases at
  `RENDER_SMOOTH_PER_SEC` 12, hard snap > `SNAP_PX` 64. Server state is i16-truncated; `JumpState` and `prev_input`
  are not on the wire.
- Remotes: `interpolation.ts::RemoteInterpolator`, `INTERP_DELAY_MS` 100, `MAX_EXTRAPOLATION_MS` 250, keyed on local
  arrival time.
- **Four clocks in GameScene:** `ClockSync` (EWMA, debug HUD only), `render/weather-math.ts::ServerClock` (monotonic,
  slews; flare), `roundTime` (extrapolated `+= dt`), `serverRoundTime` (last snapshot).
- Every movement modifier `apply_input` reads must reach the client as a wire bit + a `GameCore` setter, or the
  predictor rubber-bands (see § 6).

## 4. Determinism
- `docs/01-architecture.md` "Determinism, and how far it needs to go": cross-platform float determinism **not required,
  not attempted**; required only "for a given build on a given platform". (It also says clients never run the
  generator — the sandbox and preview do.)
- `World::state_hash`: replay checkpoints every `CHECKPOINT_STRIDE` 600 ticks + footer (`game-server/src/bin/replay.rs`,
  `tests/replay_run.rs`, `tests/replay.rs`) and tests. **Not exchanged client↔server** — only the mask hash is.
- **No test compares wasm vs native output**; game-wasm tests run natively. `golden.rs` is native only.
- game-core: `f32` 1820 lines, `f64` 61; 50 transcendental calls (map gen, `effects/flare.rs` 6, `world/mod.rs` 5);
  no `libm` dependency (wasm32 gets Rust's libm port, native gets glibc — they can differ in the last bit).
- Replays (`replay.rs`, magic "RPL1", `HEADER_BYTES` 46): seed + ordered `ReplayCommand`s; `REPLAY_VERSION` 17. The
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
Rust: game-core 70 464 lines (tests/ 7 577), game-server 25 485, game-wasm 4 628 (~2 550 tests) — 100 577 total.
client/src TS 44 286 (30 525 non-test). Largest: `world/mod.rs` 13 178, `game-wasm/lib.rs` 4 628, `constants.rs` 4 124,
`room.rs` 3 759, `GameScene.ts` 3 594, `bots/mod.rs` 2 936, `map/meta.rs` 2 927, `session.rs` 2 152,
`SandboxScene.ts` 1 690, `codec.rs` 1 497 (TS twin `codec.ts` 434, hand-written both sides).
Tests: Rust `#[test]` 1559 (+25 ignored), vitest ~981 calls, browser checks 87 (38 sandbox, 14 flaky/disabled).
