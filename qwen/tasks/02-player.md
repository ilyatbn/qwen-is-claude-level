# Phase 2 — Player movement, physics, stats

State after this phase: a player body lives in the rapier world, walks
(A/D), jumps (space, direction-biased, air control), jetpacks (hold space
in air, fuel + recharge), aims with the mouse, and the client renders it
with 100 ms interpolation. FOV formula + darkness overlay work.

Read `docs/03-player.md` in full before starting this file.

---

## T2.1 — Player state + spawn [x]

**Goal**: `Player` struct per doc §1; spawn at map spawns.
**Read**: `docs/03-player.md` §1, §2, `docs/01-map.md` §3 (step 5).
**Files**: `server/game-core/src/player.rs`
**Steps**:
1. `Player` + `ShieldState` + `JetpackState` exactly per doc §1.
2. `spawn_player(map, id, rng) -> Player`: shuffle `map.spawns` with rng
   ONCE per round (do the shuffle in round.rs later; here: assign
   spawn[id] directly), place feet on tile top: `y = (tile_y+1)*16 -
   body_half_height`.
3. Defaults: health 100, max_health 100, jetpack fuel 5.0, alive, score 0.
4. Tests: spawn position y is exactly on the ground (feet within 1 px of
   tile top); 6 players get 6 distinct spawns.
**Acceptance**: spawn math matches doc §2 (feet on tile top, x = tile
  center).
**Test**: `cd server && cargo test -p game-core player::spawn`

---

## T2.2 — Input frame model [x]

**Goal**: `InputFrame` applied per tick with latest-wins + edge triggers.
**Read**: `docs/03-player.md` §3, `docs/00-architecture.md` §2.
**Files**: `server/game-core/src/player.rs` (or `input.rs` if cleaner —
  note it in the file header)
**Steps**:
1. `InputFrame` per doc §3 (already in protocol.rs from T0.2 — reuse).
2. `PlayerInputState { last: Option<InputFrame>, prev_jump: bool,
   prev_use_slot: Option<u8> }` with `apply(frame)` returning
   `JumpPressed: bool` and `UseSlotPressed: Option<u8>` (rising edges).
3. Missing frame → repeat last. First tick with no frame → all false.
4. Tests: edge detection (jump held 3 ticks → 1 press); latest-wins
   (two frames same tick → second wins, test at queue level in T4.x —
   here just assert `apply` overwrites).
**Acceptance**: holding space for 10 ticks yields exactly 1 jump edge.
**Test**: `cd server && cargo test -p game-core input`

---

## T2.3 — Ground movement [x]

**Goal**: A/D sets horizontal velocity on ground; ground probe works.
**Read**: `docs/03-player.md` §4.
**Files**: `server/game-core/src/physics.rs`, `server/game-core/src/player.rs`
**Steps**:
1. Build a rapier world helper: `PhysicsWorld::new(map)` — gravity 900,
   terrain colliders per docs/01 §6 (horizontal AABB segments).
2. `on_ground(player, map) -> bool`: 2 px downward probe from feet —
   check tile under `(x, y + half_h + 2)` is solid (tile-based, no raycast).
3. `step_ground(player, input, dt)`: on ground + left → vel.x = -140;
   right → +140; neither → 0. (No ground accel — snappy.)
4. Integrate position by vel*dt for THIS task (rapier body comes in T2.6);
   keep a pure `step` function so it's unit-testable without rapier.
5. Tests: `player_walks_on_ground` (x changes, y stays on surface);
   walking off a cliff → next tick on_ground false.
**Acceptance**: movement speed is exactly 140 px/s (assert Δx over 10 ticks
  = 70 px).
**Test**: `cd server && cargo test -p game-core movement`

---

## T2.4 — Jump (bias + air control) [x]

**Goal**: space on ground = jump with direction bias; A/D steers in air.
**Read**: `docs/03-player.md` §4 (jump + air rules).
**Files**: `server/game-core/src/player.rs`
**Steps**:
1. On jump edge + on_ground: vel.y = -330; if A/D held vel.x = ±70
   (140 * 0.5 bias).
2. In air: vel.x moves toward ±140 at 600 px/s² (A/D), else keeps vel.x
   (no air drag in v1).
3. Gravity: vel.y += 900*dt always (except when jetpack thrusting, T2.5).
4. Tests: `jump_arc` (from rest: apex ≈ 330²/(2*900) ≈ 60.5 px above
   start, within 2 px; lands back on ground); jump while holding D →
   initial vel.x = +70; mid-air A flips direction within 1 tick.
**Acceptance**: standing jump height ≈ 60 px (assert 58–63).
**Test**: `cd server && cargo test -p game-core jump`

---

## T2.5 — Jetpack [x]

**Goal**: hold space in air = thrust; fuel 5 s; recharge 0.5/s.
**Read**: `docs/03-player.md` §5.
**Files**: `server/game-core/src/player.rs`
**Steps**:
1. Jetpack active iff: in air AND space held AND fuel > 0 (jump edge
   already consumed on ground).
2. Thrust: vel.y -= 1100*dt (net upward vs gravity 900 → 200 px/s² up).
3. W/S in flight: extra ±300 px/s² (W up, S down).
4. Fuel: burn 1.0/s while thrusting; recharge 0.5/s while not; cap 5.0.
5. Tests: `jetpack_rises_and_fuel_drains` (1 s thrust → fuel 4.0, net
   upward velocity); `jetpack_recharge_rate` (2 s idle → +1.0 fuel,
   capped at 5.0); jetpack does NOT start on ground.
**Acceptance**: fuel math exact to 0.01 over a 10 s scripted sequence.
**Test**: `cd server && cargo test -p game-core jetpack`

---

## T2.6 — Rapier integration [x]

**Goal**: player bodies in a real rapier world vs terrain colliders.
**Read**: `docs/00-architecture.md` §5, `docs/01-map.md` §6.
**Files**: `server/game-core/src/physics.rs`
**Steps**:
1. `PhysicsWorld`: create rapier `World`, insert terrain colliders
   (AABB segments per doc), one dynamic rigid body per player (12×14 px
   rectangle, density tuned so gravity feels right, linear damping 0).
2. Each tick: set body velocity from the pure step's intended velocity
   (T2.3–T2.5 output), `world.integrate_forces`, read back positions.
3. Ground detection now: rapier contact OR the T2.3 tile probe — use the
   tile probe (deterministic, doc §4).
4. Test `player_falls_and_lands`: spawn 100 px above ground → within 2 s
   vel.y ≈ 0 and resting on surface (±1 px).
5. Test `player_falls_into_hole`: destroy the 3 tiles under a player →
   player falls through.
**Acceptance**: no tunneling at max fall speed (terminal velocity cap
  900 px/s — assert body never moves > 45 px in one tick).
**Test**: `cd server && cargo test -p game-core physics`

---

## T2.7 — Terrain collider rebuild on destruction [x]

**Goal**: destroyed tiles → colliders rebuilt so players fall through.
**Read**: `docs/01-map.md` §6, §5.
**Files**: `server/game-core/src/physics.rs`, `server/game-core/src/map.rs`
  (expose `affected_segments(tiles)`)
**Steps**:
1. `PhysicsWorld::rebuild_segments(map, destroyed: &[TileDestroyed])`:
   find row-segments containing any destroyed tile, remove their
   colliders, recompute contiguous runs, insert new ones.
2. Only affected rows are touched (assert in a test: collider count
   changes only for affected rows).
3. Test: blast under a standing player → player falls; blast elsewhere →
   collider count unchanged.
**Acceptance**: rebuild of a 160-wide row < 1 ms (assert < 5 ms).
**Test**: `cd server && cargo test -p game-core rebuild`

---

## T2.8 — Aim + crosshair [ ]

**Goal**: server stores aim; client draws circle + crosshair.
**Read**: `docs/03-player.md` §8.
**Files**: `server/game-core/src/player.rs` (facing update),
  `client/src/hud/Hud.ts` (crosshair), `client/src/scenes/GameScene.ts`
  (mouse → aim radians, CCW positive per docs/06 §3)
**Steps**:
1. Server: `facing = input.aim` each tick (no validation).
2. Client: mouse position → angle from player center; draw faint circle
   r=60 around player + cross at the point on the circle.
3. Angle convention test (client vitest): mouse right of player → 0;
   above → +π/2 (CCW positive).
**Acceptance**: crosshair sits on the circle at the mouse angle;
  server `facing` matches client-sent aim (snapshot check in T4.10).
**Test**: `cd client && npm test && npm run build`

---

## T2.9 — Client player render + interpolation [ ]

**Goal**: remote players rendered from snapshots with 100 ms lerp; local
input at 20 Hz.
**Read**: `docs/00-architecture.md` §2, `docs/06-protocol.md` §3–§4,
  `docs/08-testing.md` §3.
**Files**: `client/src/entities/PlayerSprite.ts`,
  `client/src/logic/interpolation.ts`, `client/src/scenes/GameScene.ts`
  (input capture → `input` events at 20 Hz)
**Steps**:
1. `interpolation.ts`: keep last 2 snapshots per player; render pos =
   lerp(prev, next, (now - next.time)/100ms), clamped 0..1.
2. `PlayerSprite.ts`: placeholder rect (color per id, docs/07 §5), weapon
   stub rect at `facing`, name label.
3. GameScene: keyboard (WASD+space) + mouse → InputFrame every 50 ms;
   `use_slot` on keys 1–6 / right-click UI (T3.9).
4. Vitest for interpolation per docs/08 §3 (t=0 → prev, t=1 → next,
   same-snapshot → same point).
**Acceptance**: with a fake snapshot feed (dev hook `?dev=1` emitting
  scripted snapshots), a remote player moves smoothly at 60 fps.
**Test**: `cd client && npm test && npm run build`

---

## T2.10 — FOV + darkness overlay [ ]

**Goal**: server computes per-player FOV; client renders night/fog mask.
**Read**: `docs/03-player.md` §7, `docs/02-map-effects.md` §1, §6.
**Files**: `server/game-core/src/player.rs` (`compute_fov`),
  `client/src/logic/fov.ts`, `client/src/scenes/GameScene.ts` (overlay)
**Steps**:
1. Server `compute_fov(day_phase, fog_active, health, flashlight) -> f32`
   per doc §7 formula (base 420; night 1.0→0.45 lerp; fog ×0.45;
   health<50 ×0.7; flashlight → night_factor 1.0).
2. Include `fov` in PlayerSnap (protocol already has the field).
3. Client `fov.ts`: same math (vitest asserts identical values for 5
   cases incl. flashlight).
4. Overlay: black rect alpha 0.85 over world, circular hole (Phaser
   `RECT` mask or a generated radial texture) of radius = local player's
   fov, centered on local player. Remote players use THEIR fov only for
   their own visibility? NO — v1: the mask is for the LOCAL player only
   (your eyes). Remote players are drawn normally under the mask.
**Acceptance**: at full night without flashlight, a player 400 px away is
  invisible; with flashlight, visible.
**Test**: `cd server && cargo test -p game-core fov && cd ../client && npm test`
