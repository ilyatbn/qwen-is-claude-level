# Implement the qwen design — context dump & execution plan

> **STATUS: PAUSED before any code was written.** The user is moving the whole
> project into WSL and will re-run from there. Nothing has been installed,
> nothing has been created. This file is the shortcut so the next session does
> not re-read 15 markdown files or re-derive the toolchain situation.

---

## Context

`C:\Users\ilya\code\qwen-is-claude-level` is a comparison repo: the same 68-line
brief (`initial_prompt.txt` — a Worms-style 2D destructible multiplayer
deathmatch) was given to two models, and each produced a design + task list and
no code:

- `claude/` — 121 files, 12,614 lines, 22 docs, 90 one-per-session task files.
- `qwen/` — 16 files, 2,115 lines, 9 docs, 6 task files.

The repo README's thesis is that qwen's output is nowhere near Claude-level.
Current branch is **`claude_builds_qwen`** — the job is for Claude to *implement
qwen's design*, exactly as written, to see whether it survives contact with a
compiler.

**Task**: execute qwen's 5 coding phases (map, player, items, rounds, sprites),
plus its Phase 0 scaffold. Do not deviate from the plan unless something is a
critical mistake that prevents the code from running; when that happens, record
it in a separate deviations file rather than silently "improving" the design.

**Confirmed decisions (from the user):**

| Question | Answer |
|---|---|
| Rust toolchain | rustup, **GNU toolchain only** (`stable-x86_64-pc-windows-gnu`) — no multi-GB Visual Studio install. *Superseded by the WSL move; in WSL use the normal `x86_64-unknown-linux-gnu`.* |
| Docker / environment | User is **relocating the project to WSL** with everything installed, and will re-run. Do not install anything on Windows. |
| Where code goes | **Inside `qwen/`**, exactly per `docs/00-architecture.md` §1 (`qwen/server/`, `qwen/client/`, `qwen/assets/`, `qwen/docker-compose.yml`). Every task file's paths then match verbatim, no remapping needed. |

---

## Toolchain state as measured on Windows (2026-08-19)

| Tool | Result |
|---|---|
| node | **v24.19.0** ✅ |
| npm | **11.17.0** ✅ |
| rustc / cargo / rustup | **absent** — not on PATH, no `%USERPROFILE%\.cargo\bin` |
| MSVC build tools | **absent** — `vswhere.exe` not present, no VS install |
| docker | **absent** |
| wasm-pack | absent (not needed — qwen's design has no WASM; that's claude's design) |
| winget | present |
| python | absent (Store alias stub only) |

**In WSL, verify before starting:**

```bash
node --version && npm --version          # need >= 18; 24.x is what Windows had
rustc --version && cargo --version       # need stable, x86_64-unknown-linux-gnu
cc --version                             # build-essential, for ring/rapier build scripts
pkg-config --version
docker --version && docker compose version   # only needed for T5.5
```

If Rust is missing in WSL: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`
plus `sudo apt install -y build-essential pkg-config`.

---

## The design, digested

Everything below is already read and summarised — the next session should only
need to re-open a specific doc when implementing the task that cites it.

### Locked stack (`qwen/README.md`)

- **Server**: Rust workspace at `qwen/server/`. `game-core` = pure simulation
  crate (no IO, no async, no network). `server` = thin socketioxide IO layer.
- **Physics**: `rapier2d` inside `game-core`, fixed 20 Hz tick.
- **Transport**: socket.io via `socketioxide`, JSON, namespace `/game`.
- **Client**: Phaser 3 (^3.80) + TypeScript (strict, no `any`) + Vite + Vitest.
  Inputs at 20 Hz, interpolates 10 Hz snapshots with 100 ms delay.
- **Ports**: server 3001 (`WIPGAME_PORT`), Vite 5173. No DB in v1.
- Env: `WIPGAME_PORT`, `WIPGAME_SEED` (dev seed pin), `RUST_LOG`.

### File layout to create (docs/00 §1)

```
qwen/server/Cargo.toml                 workspace: members = game-core, server
qwen/server/game-core/src/             lib.rs rng.rs map.rs tiles.rs physics.rs
                                       player.rs items.rs effects.rs round.rs protocol.rs
qwen/server/game-core/tests/           determinism.rs, full_round.rs
qwen/server/server/src/                main.rs rooms.rs tick.rs net.rs
qwen/client/                           package.json tsconfig.json vite.config.ts index.html
qwen/client/src/                       main.ts protocol.ts devmap.ts
qwen/client/src/scenes/                BootScene LobbyScene GameScene RoundEndScene
qwen/client/src/entities/              PlayerSprite Terrain Projectile
qwen/client/src/hud/                   Hud InventoryUi
qwen/client/src/logic/                 interpolation.ts fov.ts      (pure, unit-tested)
qwen/client/src/assets/manifest.json
qwen/assets/                           kenney/ + processed/
qwen/Dockerfile, qwen/docker-compose.yml, qwen/.dockerignore
```

### Core numbers (so they don't need re-lookup)

**Map** (`docs/01`): tile 16 px, row-major, y=0 top. Scales
Small 96×64 / 8 pockets, Medium 160×96 / 14, Large 240×128 / 20.
Tile HP: AIR 0, GRASS 20, DIRT 30, STONE 60, ROCK 80. Solid iff kind != AIR.

Generation order (exact — determinism depends on it):
1. Heightmap: `h(x) = H*0.35 + H*0.22 * (0.7*noise(step=8)(x) + 0.3*noise(step=3)(x))`,
   1-D value noise with cosine interpolation, clamp `h` to `[H*0.15, H*0.6]`,
   surface row `s(x) = H - 1 - round(h(x))`.
2. Fill per column from `s(x)` down: d==0 GRASS, d<=3 DIRT, else STONE.
3. Rock pockets: random column, depth `d0 ∈ [2,6]` below surface, random walk
   ≤12 steps, `dx,dy ∈ {-1,0,1}` not both 0, only rows `> s(x)+1`.
4. Decor: 12% of surface tiles get bush/rock/flower (equal weight).
5. Spawns: GRASS tiles with 2 AIR above → shuffle → greedy Chebyshev ≥15,
   fallback 10, then 6. Guarantee ≥6.

Destruction: `dmg = max_damage * (1 - dist/radius)` for tiles whose **center**
is in radius; hp≤0 → AIR + `TileDestroyed`. Then surface conversion: DIRT with
AIR directly above → GRASS, hp=20. Every destruction bumps `map.version`.
Colliders = horizontal AABB runs per row, rebuilt only for affected rows.

**Player** (`docs/03`): `MOVE_SPEED 140`, `AIR_ACCEL 600`, `AIR_MAX 140`,
`GRAVITY 900`, `JUMP_VY -330`, `JUMP_DIR_BIAS 0.5`, `JETPACK_THRUST 1100` up,
W/S ±300 in flight, fuel 5.0 s, burn 1.0/s, recharge 0.5/s, cannot start on
ground. Ground detection = 2 px **tile probe**, not a rapier raycast.
Damage: shield ×0.5 → health −. Medkit +50 clamped. Overcharge max 150 for 10 s
then clamp back to 100. Shield 20 s, refreshable. Death: −1 victim, +1 killer
(none for weather/self), respawn 3 s at spawn farthest from living players,
**inventory KEPT**, health 100, shield cleared, jetpack full.
FOV: `420 * night_factor * fog_factor * health_factor`; night lerps 1.0→0.45 by
day_phase, fog 0.45, health<50 → 0.7, flashlight forces night_factor 1.0.
Crosshair ring r=60 px, aim radians, 0 = right, CCW positive.

**Items** (`docs/04`), exact catalog:

| Item | Kind | Ammo | Dmg | Range | Radius | CD | Speed |
|---|---|---|---|---|---|---|---|
| Pistol | Weapon | 30 | 12 | 600 | 0 | 0.25 | 700 |
| Shotgun | Weapon | 12 | 7 ×5 pellets | 260 | 0 | 0.8 | 600 |
| Rocket | Weapon | 6 | 60 | 900 | 48 | 1.0 | 500 |
| Grenade | Weapon | 4 | 45 | 400 | 40 | 1.2 | 400 |
| Medkit | Health | — | +50 hp | — | — | — | — |
| Overcharge | Health | — | 150 / 10 s | — | — | — | — |
| Shield Gen | Shield | — | 50% red, 20 s | — | — | — | — |
| Flashlight | Utility | — | FOV at night | — | — | — | — |

Shotgun spread fixed `aim + [-8,-4,0,4,8]°` (no RNG). Grenade: gravity, bounce
once (restitution 0.4), 1.5 s fuse. Max 24 live projectiles (drop oldest).
Inventory 6 slots, auto-pickup at 16 px if a slot is free, no swap.
Spawn weights (source A/C/D): pistol 30, shotgun 20, rocket 15, grenade 15,
medkit 20, shield 10, overcharge 10, flashlight 10. Source B: same but
flashlight 20.
Sources: A = 10 items at round start on surface, ≥6 tile spacing;
B = 4 hidden in rock pockets; C = crate every 45 s (t=45,90,135,180,225),
falls 200 px/s, sits 60 s, splits into 2 items; D = 1 item every 30 s
(t=30..210 → 7 items in a 240 s round).

Round-start determinism order: generate map → shuffle spawns → build effect
schedule → place A → place B. C and D draw at their ticks.

**Effects** (`docs/02`): day/night `c = t mod 120`; day full `c<55`, transition
55–60, night 60–115, transition 115–120. `day_phase` 0..1 in snapshot.
Toxic rain 8 s, 5 spots r=40 px staggered `i*1.2 s`, 4 s each, 10 hp/s.
Meteor shower: 3 targets at `i*0.8 s`, `apply_blast(r=48, max_dmg=60)`,
player falloff same formula.
Lava burst: 3×3 dig (skip_items=true), 0–5 s spew (2 particles/tick, 150 px/s,
1 s life), 5–8 s ground fire, 15 hp/s in both phases; hole persists.
Heavy fog: 15 s, FOV ×0.45, no damage.
Scheduler: first effect `t ∈ [10,20] s`, gaps `[18,32] s`, weights toxic 30 /
meteor 25 / lava 25 / fog 20, stop when `t > 240−15`. One effect at a time.

**Server** (`docs/05`): `Round::step(&mut self, tick, inputs) -> (Snapshot, Vec<Event>)`
is the single game-core entry. 20 Hz tick, snapshot every 2nd tick, events
immediate. Room lifecycle Lobby → 3 s countdown → Round 240 s → RoundEnd 10 s →
restart (new seed) / quit. Max 6 players, 7th gets `error{code:"room_full"}`.
Logging via `tracing`, every line tagged `[tick=NNN room=ID]`, runtime toggle
via `set_log_level` socket message.

**Protocol** (`docs/06`): `PROTOCOL_VERSION = 1` in both `protocol.rs` and
`protocol.ts`; a task that changes a message updates BOTH. Full C→S and S→C
event tables are in that doc — re-read it for T0.2. `MapData.tiles` is
**base64 of a u8 array** (0=AIR 1=GRASS 2=DIRT 3=STONE 4=ROCK).

**Sprites** (`docs/07`): placeholder-first. Placeholder colours GRASS `#4a8f3c`,
DIRT `#7a5230`, STONE `#6b6b6b`, ROCK `#8a7f6a`; player 24×28 rect; crosshair
r=60; night overlay alpha ≤0.85. Tile variant = `(seed + x + y) % 3`.
Manifest-driven; a missing asset must fall back to the placeholder, never break.

**Testing** (`docs/08`): all meaningful tests are Rust in `game-core`; client
Vitest covers only pure logic (`interpolation.ts`, `fov.ts`, `protocol.ts`).
The doc lists exact test *names* per module — use them verbatim. A task is done
only when its Test command passes, the full suite still passes, and the box is
ticked `[x]` in its task file.

---

## Spec defects found while reading (write these to `qwen/DEVIATIONS.md`)

These are real problems in qwen's design. Per the user's instruction, implement
around them and document each one; do not silently redesign.

1. **T4.5 meteor damage arithmetic is wrong.** The task says a player at 20 px
   from a 48 px / 60 dmg blast "takes ~45 (60*(1-20/48))". That expression
   evaluates to **35**, not 45. Implement the documented formula; assert 35.

2. **T2.6 cites a rapier API that does not exist.** "`world.integrate_forces`"
   is not how rapier2d steps — it is `PhysicsPipeline::step(...)` with the
   island manager, broad/narrow phase, and islands. Also, rapier's solver will
   not reproduce the exact-value assertions in T2.3–T2.5 (`Δx == 70 px` over 10
   ticks, apex 58–63 px). Resolution: keep the **pure** step functions from
   T2.3–T2.5 as the authority for movement and for those tests, and use rapier
   only for collision resolution against terrain colliders, per T2.6 step 3
   which already says to use the tile probe for ground detection.

3. **T1.3's "adjacent columns differ by ≤ 8 tiles" is mathematically unsafe.**
   With `h = H*0.22*(0.7*n8 + 0.3*n3)` and cosine interpolation, the worst-case
   single-column delta is ≈ `0.126*H` → ~8.1 (Small), ~12.1 (Medium), ~16.1
   (Large). Over 100 seeds × 3 scales the assertion will very likely fail on
   Medium/Large. Verify empirically first; if it fails, relax the bound to a
   scale-relative one (e.g. `≤ ceil(0.13*H)`) and document.

4. **Toxic rain window is inconsistent.** docs/02 §3 says 5 spots staggered
   `i*1.2 s`, each lasting 4 s, inside an 8 s effect — but spot 4 would run
   4.8→8.8 s. T4.4 asserts "spot 4 ends at 8 s". Resolution: clamp every spot's
   life to the 8 s effect window (spot 4 lives 3.2 s).

5. **Pocket size assertion can fail from merging.** T1.4 asserts each connected
   ROCK component is ≤15 tiles, but a ≤12-step random walk yields up to 13 tiles
   *per pocket* and 20 pockets on a Large map may land adjacent and merge into
   one larger component. Either assert per-pocket size at generation time or
   raise the component bound; document whichever.

6. **Player body dimensions conflict.** T2.6 says a "12×14 px rectangle",
   docs/07 §5 says the player placeholder is a "24×28 rect", docs/04 §2 says the
   player hit circle is 12 px radius. Read 12×14 as **half-extents** (→ 24×28
   full body), which reconciles all three.

7. **`base64` is needed but not in the dependency list.** `MapData.tiles` is
   base64 (docs/06 §6) yet T0.1's `game-core` deps are rand, rand_chacha,
   rapier2d, serde, thiserror. Add the `base64` crate (it is pure, no IO — does
   not violate the "no async/IO crates" rule) or hand-roll ~20 lines.

8. **`Vec2` is used but never defined and no math module is listed.** docs/01 §4
   has `spawns: Vec<Vec2>` and docs/03 §1 has `pos`/`vel` as `Vec2`, but T0.1's
   module list is rng/map/tiles/physics/player/items/effects/round/protocol.
   Define a minimal `Vec2` in `lib.rs` (or reuse rapier's `Vector<f32>`).

9. **Spawn coordinate units are ambiguous.** docs/01 §4 says `spawns` are tile
   coords; §3.5 then gives a pixel formula. T2.1 computes
   `y = (tile_y+1)*16 - body_half_height`, which only works if spawns are tile
   coords — so store **tile coords** and convert at spawn time.

10. **T1.9's Terrain unit test needs Phaser-free logic.** docs/08 §3 says client
    tests cover pure logic only, but T1.9 wants a unit test of
    `Terrain.applyDestroyed()`. Split Terrain into a pure grid model
    (unit-tested) plus a thin Phaser rendering layer, so Vitest never imports
    Phaser.

11. **T5.1's Kenney URLs are almost certainly dead.** `https://kenney.nl/media/pages/packs/tiny-dungeon.zip`
    is not Kenney's real URL shape (their downloads live under hashed
    `/media/pages/assets/<pack>/<hash>/kenney_<pack>.zip` paths). Also "Pixel
    Adventure 1" is not a Kenney pack. Expect 404s; the manifest's
    placeholder-fallback path (docs/07 §2) is the designed escape hatch, so the
    game must still boot with zero assets.

12. **T4.9's "10 Hz ±1 over a 10 s window" is a wall-clock test** and will be
    flaky in CI/containers. Prefer asserting the tick→snapshot ratio
    (`tick % 2 == 0`) deterministically, and keep the timing check as a
    non-gating manual observation.

13. **T5.5 (Docker) was unverifiable on Windows** — no Docker installed. In WSL
    this should be testable; if not, write the Dockerfile/compose per docs/05 §6
    and mark the build/run verification as unperformed.

---

## Execution process (per the user's instruction)

For **each** of the 5 phases (plus the Phase 0 scaffold, done first as prep for
the Map phase):

1. **Coding agent** — one agent writes the phase's code, following the task file
   task by task, reading only the doc sections each task cites.
2. **Harsh reviewer** — a *different* agent, persona of a blunt senior engineer,
   reviews the diff against the spec. Looks for: deviation from documented
   numbers, determinism violations (any randomness not through `GameRng`),
   IO/async leaking into `game-core`, missing bounds checks, tests that assert
   nothing, and TS `any`.
3. **Loop** — reviewer's findings go back to the coding agent; repeat until the
   reviewer signs off.
4. **Tests** — the coding agent then writes and runs the phase's unit tests
   using the exact test names from `docs/08-testing.md`, and runs each task's
   own Test command plus the full suite.
5. **Handoff file** — write a short `qwen/HANDOFF-<phase>.md`: where each piece
   of code lives, the public entry points, what's tested, what's deferred.

Task-file bookkeeping: tick each task `[ ]` → `[x]` in its `qwen/tasks/*.md`
file as it lands, per qwen's own agent rules. Stop and report if a task's test
fails twice.

### Phase order and gates

| Phase | Tasks | Gate |
|---|---|---|
| 0 — Scaffold | T0.1–T0.3 | `cd qwen/server && cargo build && cargo test`; `cd qwen/client && npm test && npm run build`; ping/pong round-trips |
| 1 — Map | T1.1–T1.10 | `cargo test -p game-core`; determinism over 100 seeds × 3 scales; client renders terrain |
| 2 — Player | T2.1–T2.10 | `cargo test -p game-core` (movement, jump, jetpack, physics, rebuild, fov); `npm test` |
| 3 — Items | T3.1–T3.9 | `cargo test -p game-core` (catalog, items, inventory, projectile, damage); `npm test` |
| 4 — Rounds | T4.1–T4.10 | `cargo test` (whole workspace, incl. `-p server`); two-client integration test |
| 5 — Sprites | T5.1–T5.5 | `npm test && npm run build`; `cargo test -p server`; Docker if available |

---

## Verification

```bash
# Rust — from qwen/server/
cargo build
cargo test                      # whole workspace
cargo test -p game-core         # the main test surface
cargo test -p game-core rng     # per-task narrowing, e.g. rng / map:: / tiles / blast
                                #   spawns / movement / jump / jetpack / physics / rebuild
                                #   fov / catalog / inventory / projectile / damage
                                #   round / day_night / toxic / meteor / lava / fog / schedule
cargo test -p server            # rooms + two-client integration

# Client — from qwen/client/
npm install
npm test                        # Vitest: interpolation, fov, protocol
npm run build                   # tsc + vite build
npm run dev                     # http://localhost:5173

# End to end
cd qwen/server && cargo run -- dev          # server on :3001
# then in another shell: cd qwen/client && npm run dev
#   ?seed=777&scale=medium  → deterministic map
#   ?dev=1                  → debug camera / scripted snapshot feed

# Docker (T5.5, from qwen/)
docker compose up --build -d && sleep 8
curl -s 'http://localhost:3001/socket.io/?EIO=4&transport=polling' | head -c 200
```

Manual checks the design calls for: terrain looks Worms-like (T1.4 keeps an
ASCII dump test for seed 1 / Small); camera clamps at map edges; a rocket digs a
visible crater; two browser tabs agree on player positions; night without a
flashlight hides a player at 400 px.

---

## First actions for the next session (in WSL)

1. Verify the toolchain with the commands in the toolchain section above.
2. Create `qwen/DEVIATIONS.md` seeded with the 13 defects listed here.
3. Start Phase 0 (T0.1) — Rust workspace skeleton under `qwen/server/`.
