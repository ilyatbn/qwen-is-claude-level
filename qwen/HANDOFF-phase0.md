# Handoff — Phase 0 (Scaffold, T0.1–T0.3)

State: Rust workspace compiles and tests clean; client builds under `tsc --noEmit`
plus Vite; socket.io ping/pong round-trips over the `/game` namespace at a measured
20.00 Hz tick.

Commits: `7ec5646` (T0.1), `2575e51` (T0.2), `bf88218` (T0.3), `e9bf4ff` (review fixes).

---

## Where the code lives

### `server/` — Rust workspace (members: `game-core`, `server`)

| Path | Contents |
|---|---|
| `Cargo.toml` | Workspace root. `[workspace.dependencies]` split into a pure block (usable by `game-core`) and an IO/async block (server only). |
| `game-core/src/lib.rs` | Module declarations + `Vec2` (D8). |
| `game-core/src/protocol.rs` | **Everything real in Phase 0.** All of docs/06 §1–§6. |
| `game-core/src/{rng,map,tiles,physics,player,items,effects,round}.rs` | Doc-comment stubs. Filled from T1.1 on. |
| `server/src/main.rs` | Env parsing, tracing init w/ reload handle, axum+socketioxide serve, SIGINT shutdown. |
| `server/src/net.rs` | `/game` namespace registration; `ping`→`pong`; `set_log_level`; connect/disconnect logging. |
| `server/src/tick.rs` | 20 Hz interval loop; `[tick] n` at debug. No rooms yet. |

`game-core` dependencies are pure only — rand, rand_chacha, rapier2d, serde,
thiserror, base64. **No async/IO/network crates** (docs/00 §7). `serde_json` is a
dev-dependency (tests only).

### `client/` — Phaser 3 + TS + Vite

| Path | Contents |
|---|---|
| `src/protocol.ts` | TS mirror of `protocol.rs`. |
| `src/protocol.test.ts` | The TS/Rust drift guard (docs/08 §3). |
| `src/main.ts` | Phaser bootstrap + `connect()` (socket.io, pings every 2 s). |
| `src/scenes/BootScene.ts` | Dark fill, logs "client ready". |
| `scripts/ping-check.mjs` | Headless replacement for T0.3's browser check (D14). |

TS is `strict` + `noUncheckedIndexedAccess`, **zero `any`**. Pinned `phaser ^3.80`
(resolved 3.90.0) per the locked stack — deliberately not Phaser 4.

---

## Public entry points

**`game-core` — a real library, importable by other crates**
- `game_core::protocol::{PROTOCOL_VERSION, NAMESPACE}` — `1` and `"/game"`.
- `game_core::protocol::{c2s, s2c}` — every event-name string constant. Use these;
  never re-type a literal, or Rust and TS will drift on the wire names.
- `game_core::Vec2` — minimal vector type (D8).

**`server` — internal map, NOT public API.** `server/` is a bin-only crate: no
`[lib]` target, no `lib.rs`, and `main.rs` declares `mod net;` / `mod tick;` as
private. Nothing outside the binary can import these; they are listed only so the
next task knows where the code is.
- `net::register(&io, log_level)` — installs the namespace and handlers.
- `tick::{run, TICK_HZ, TICK_DURATION, TICK_DT}` — `TICK_DT` is `#[allow(dead_code)]`
  until T2.x consumes it.
- `LogLevelHandle::set(&str)` — live tracing filter reload (docs/05 §5).

**TypeScript**
- `PROTOCOL_VERSION`, `NAMESPACE`, `C2S`, `S2C` — mirrors of the above.
- `Six<T>` — the fixed 6-tuple used for `players`, `slots`, `ammo`, `ready`.
- `connect(url?)` from `main.ts` — returns a live `Socket`.

---

## What is tested

**Rust — 14 tests, `cargo test`**
- `Vec2` arithmetic.
- Serialized field names checked against docs/06 for `InputFrame`, `PlayerSnap`,
  `MapData` (T0.2 asks for 3 spot-checks), plus `Kill.killer` nullability and the
  `crate` wire-name rename.
- `Snapshot` round-trip; tile-kind byte encoding; namespace; `PROTOCOL_VERSION == 1`.
- **Fixed cardinalities**: a 5-player snapshot and a 2-wide `ready` array must fail
  to deserialize, not silently truncate.
- **`EffectData` strictness**: garbage objects, a typo'd field, and a
  missing-field payload must all error rather than falling through to `HeavyFog`;
  all four documented shapes still map to the right variant.

**Coverage is partial, by design.** Where a test constructs a struct literal, a field
rename *is* a compile error — that is genuinely protective. But it only covers the
types a test actually builds. As of Phase 1's T1.7 that is **22 of 43 Rust types**;
the remainder (e.g. `LobbyPlayer`, `ScoreEntry`, `Joined`, `EffectStarted`) have no
constructing test and would drift silently. The same holds in TS: **12 of 30 types**
are pinned by an annotated fixture.

Types pinned so far are the ones Phases 0–2 depend on: `Snapshot`, `PlayerSnap`,
`MapData`, `InputFrame`, `TileDestroyedMsg`, `ProjectileSnap`, `GroundItemSnap`,
`Kill`, `EffectData` (all four shapes), `LobbyState.ready`, `ItemId`. Pinning the
rest is deliberately deferred rather than forgotten — extend coverage when a phase
first depends on a type, not speculatively.

One gap worth knowing: a *required* field added to a TS interface is caught (the
fixture no longer satisfies it), but an **optional** one is not — `server_time_ms?:
number` compiles clean against every existing fixture.

**TypeScript — 13 tests, `npm test`**
- Same field-name checks, driven from a `Snapshot`-annotated fixture.
- 6-player / 6-slot / 6-ammo cardinality; `crate` flag; event-name tables.

> **The `: Snapshot` annotation on `SNAPSHOT_FIXTURE` is load-bearing.** Without it
> the fixture is a structurally-inferred literal, every assertion checks the fixture
> against itself, and `protocol.ts` is checked against nothing — a field rename
> compiles and passes. This was a real defect found in review. Verified fixed:
> renaming `Snapshot.day_phase` now fails `tsc --noEmit` with TS2561. **Do not
> reintroduce a cast in its place.**

**End-to-end**: `client/scripts/ping-check.mjs` — real socket.io client, `/game`
namespace, asserts `pong`, exits 0/1.

Verified manually this phase: websocket + polling handshakes; `WIPGAME_PORT=3999`
override; `RUST_LOG` info-vs-debug behaviour; tick cadence 20.00 Hz over 11 s.

---

## Deviations recorded

D7 (base64 dep), D8 (`Vec2` undefined), D14 (T0.3's Test line is a manual browser
procedure, replaced headlessly), D15 (effect-kind wire casing invented — snake_case
chosen without spec authority), D16 (`protocol_version` mandated by docs/06 §7 but
absent from §2's `joined` table).

`crate` → `is_crate` with `#[serde(rename)]` is **not** a deviation: the wire format
is unchanged and a test pins it.

---

## Deferred — must not be lost

| # | Item | Owner |
|---|---|---|
| 1 | 8 `game-core` modules are stubs (rng, map, tiles, physics, player, items, effects, round). | T1.1 on |
| 2 | `tick.rs` has no rooms and never calls `Round::step`. | T4.1 / T4.9 |
| 3 | `WIPGAME_SEED` is parsed and warned about; nothing consumes it. | T4.1 |
| 4 | Client is BootScene-only — no Lobby/Game/RoundEnd scenes, entities, or HUD. | T1.9+ |
| 5 | **Client must warn on `PROTOCOL_VERSION` mismatch (console + toast, docs/06 §7).** `main.ts` logs the version but never compares it to `joined.protocol_version`; no `joined` handler exists yet. | **T4.10 (LobbyScene)** |
| 6 | **`MissedTickBehavior::Skip` decouples game time from wall time.** Skipped ticks are never made up, so a 240 s round runs long under load. docs/05 §1 makes the tick counter the only clock. Revisit deliberately — the alternative (`Burst`) runs the sim faster than real time to catch up, which is worse. | **T4.9** |
| 7 | `game-core` needs a `tracing` crate dependency (the workspace dep exists; the crate does not use it). T4.9 requires `[dmg]`/`[tiles]`/`[effect]` lines from game-core. | T4.9 |
| 8 | **rapier2d `enhanced-determinism` feature is OFF.** Fine for single-machine play, but cross-platform determinism is the headline requirement (docs/00 §2). Make it a conscious call when rapier is first used. | **T2.6** |
| 9 | `LavaBurstData.phase` is `String` in Rust and `string` in TS (deliberately widened so the client cannot reject a legal server value). Narrow both to a shared `'spew' \| 'fire'` union together. | T4.6 |
| 10 | `SERVER_URL` is hardcoded to `ws://localhost:3001/game` in `main.ts`. Needs to be configurable. | T5.5 |
| 11 | Effect-kind wire strings (D15) are declared in `protocol.ts` only. `game-core`'s `EffectKind` serde names must match when created. | T4.4–T4.8 |

---

## Notes for the next phase

- **`rand` 0.9 renamed `gen_range` → `random_range`.** T1.1's `GameRng` wrapper spec
  names `gen_range`; the underlying API has moved. Keep the wrapper's method named per
  the task and delegate.
- `docs/06` §4's "missing players: alive=false, x=y=0" is now enforced by the type —
  `Snapshot.players` is `[PlayerSnap; 6]`, so the round must always emit 6 entries.
- Vite resolved to 7.x and Vitest to 3.x (not 8.x/4.x); both work with this peer set.
