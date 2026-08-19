# Phase 1 — Map generation & destruction

State after this phase: `Map::generate(seed, scale)` produces deterministic
Worms-style maps (terrain, pockets, decor, ≥6 spawns); `apply_blast`
destroys tiles with falloff + surface conversion; client renders the map
from `MapData` and updates on `tile_destroyed` events.

Read `docs/01-map.md` in full before starting this file (it is the spec).
Individual tasks list the exact sections they need.

---

## T1.1 — Seeded RNG wrapper [x]

**Goal**: `GameRng` in game-core; all randomness flows through it.
**Read**: `docs/00-architecture.md` §4, `docs/08-testing.md` §1 (rng row).
**Files**: `server/game-core/src/rng.rs`
**Steps**:
1. `GameRng::new(seed: u64)` wrapping `rand_chacha::ChaCha8Rng`.
2. Expose: `next_u64`, `gen_range<R: UniformRange>`, `shuffle<T>`,
   `random_unit() -> f32` (0..1).
3. Unit tests: `seeded_rng_deterministic`, `different_seeds_differ`.
**Acceptance**: two `GameRng::new(42)` produce identical 1000-value streams.
**Test**: `cd server && cargo test -p game-core rng`

---

## T1.2 — Tile grid + scale configs [x]

**Goal**: `Tile`, `Scale`, grid storage, indexing; scale table from doc.
**Read**: `docs/01-map.md` §1, §2, §4 (struct only).
**Files**: `server/game-core/src/tiles.rs`, `server/game-core/src/map.rs`
  (Scale enum + width/height table only, no generation yet)
**Steps**:
1. `Tile { kind: TileKind, hp: f32 }`; `TileKind` AIR/GRASS/DIRT/STONE/ROCK
   with `base_hp()` per doc §2 table.
2. `Map { width, height, tiles: Vec<Tile>, ... }` with `tile()`,
   `set_tile()`, `is_solid()`, bounds checks (out-of-bounds = AIR, never
   panic).
3. `Scale::Small/Medium/Large` → (96,64)/(160,96)/(240,128).
4. Tests: out-of-bounds returns AIR; set/get round-trip.
**Acceptance**: grid indexing correct row-major, y=0 top.
**Test**: `cd server && cargo test -p game-core tiles`

---

## T1.3 — Heightmap generation [x]

**Goal**: surface row per column, per doc §3 steps 1.
**Read**: `docs/01-map.md` §3 (step 1 only).
**Files**: `server/game-core/src/map.rs`
**Steps**:
1. Implement `value_noise(step, width, rng) -> Vec<f32>` (cosine interp).
2. `surface_rows(width, rng) -> Vec<u32>` per the formula, clamped to
   `[H*0.15, H*0.6]` for the height H of the scale.
3. Test `surface_within_bounds` over 100 seeds × 3 scales: every row in
   range; adjacent columns differ by ≤ 8 tiles (smoothness sanity).
**Acceptance**: identical seed → identical surface rows (determinism).
**Test**: `cd server && cargo test -p game-core map::`

---

## T1.4 — Terrain fill, pockets, decor [x]

**Goal**: full tile fill per doc §3 steps 2–4.
**Read**: `docs/01-map.md` §3 (steps 2–4).
**Files**: `server/game-core/src/map.rs`
**Steps**:
1. Fill: GRASS at surface, DIRT depth ≤3, STONE below (per column).
2. Rock pockets: random walk per doc (≤12 steps, below surface only).
   Pocket counts: 8/14/20 by scale.
3. Decor: 12% of surface tiles get bush/rock/flower (equal weight),
   stored in `decor: Vec<Decor>`.
4. Tests: `all_columns_have_ground`; `pockets_below_surface_and_sized`
   (each connected ROCK component ≤ 15 tiles, all rows > surface).
**Acceptance**: map looks like Worms terrain in a debug dump (print an
  ASCII grid in a `#[test]` for seed 1, scale Small — keep the test).
**Test**: `cd server && cargo test -p game-core map::`

---

## T1.5 — Spawn point finder [ ]

**Goal**: ≥6 well-spaced ground spawns, guaranteed.
**Read**: `docs/01-map.md` §3 (step 5).
**Files**: `server/game-core/src/map.rs`
**Steps**:
1. Candidates: GRASS tiles with 2 AIR tiles above.
2. RNG-shuffle; greedy accept with Chebyshev spacing 15; fallback 10, then 6.
3. Store `spawns: Vec<Vec2>` (tile coords).
4. Test `spawns_at_least_6` + `spawn_spacing` over 100 seeds × 3 scales.
**Acceptance**: no seed in the 100-seed suite produces < 6 spawns.
**Test**: `cd server && cargo test -p game-core spawns`

---

## T1.6 — `Map::generate` integration + determinism suite [x]

**Goal**: one entry point doing §3 in exact order; byte-identical across
runs.
**Read**: `docs/01-map.md` §3, §4, `docs/08-testing.md` §1 (map rows).
**Files**: `server/game-core/src/map.rs`, `server/game-core/tests/determinism.rs`
**Steps**:
1. `Map::generate(seed, scale)` calling surface→fill→pockets→decor→spawns
   in that order with ONE `GameRng`.
2. `tests/determinism.rs`: 100 seeds × 3 scales, generate twice, assert
   tiles+decor+spawns byte-identical (use a `Debug` dump string or
   serialize).
3. Add `surface_within_bounds` here if not already (move, don't duplicate).
**Acceptance**: suite passes; generation of Large map < 50 ms (assert in
  test with an upper bound of 200 ms to be safe).
**Test**: `cd server && cargo test -p game-core`

---

## T1.7 — Tile destruction API [x]

**Goal**: `destroy_tile` + `version` + `TileDestroyed` event type.
**Read**: `docs/01-map.md` §5 (first two bullets only).
**Files**: `server/game-core/src/tiles.rs`, `server/game-core/src/map.rs`
**Steps**:
1. `TileDestroyed { x, y, kind, item: Option<ItemId> }` (item field added
   later in T3.3 — for now `None` always; define `ItemId` as a string enum
   stub in protocol.rs if missing).
2. `destroy_tile(x, y) -> Option<TileDestroyed>`: solid→AIR, bump version.
3. Surface conversion pass (DIRT under AIR → GRASS, hp=20) after destroy.
4. Tests: `destroy_tile_returns_event`, `version_increments`,
   `surface_conversion_grass_on_air_above`.
**Acceptance**: destroying a surface DIRT column converts the new surface
  tile to GRASS.
**Test**: `cd server && cargo test -p game-core tiles`

---

## T1.8 — Blast falloff `apply_blast` [ ]

**Goal**: radius blast with linear falloff, exact doc formula.
**Read**: `docs/01-map.md` §5 (bullet 1).
**Files**: `server/game-core/src/map.rs`
**Steps**:
1. `apply_blast(cx, cy, radius, max_damage) -> Vec<TileDestroyed>`: for
   each tile center within radius: `dmg = max_damage*(1 - dist/radius)`.
2. Apply damage to tile.hp; hp ≤ 0 → destroy (via T1.7 path, so version +
   surface conversion happen).
3. Tests: `blast_falloff_center_max_edge_zero` (tile at center takes ~full
   damage; tile at distance = radius takes ~0); `blast_destroys_only_in_radius`.
**Acceptance**: a blast with max_damage < tile hp damages but does not
  destroy (hp persists on the tile).
**Test**: `cd server && cargo test -p game-core blast`

---

## T1.9 — Client terrain rendering [ ]

**Goal**: client draws the map from `MapData` and applies
`tile_destroyed` events.
**Read**: `docs/06-protocol.md` §6, `docs/07-sprites.md` §2, §5.
**Files**: `client/src/entities/Terrain.ts`, `client/src/scenes/BootScene.ts`
  (placeholder texture registration per §5 table), `client/src/scenes/GameScene.ts`
  (create Terrain from `round_started`/`joined` map data)
**Steps**:
1. BootScene: register placeholder tile textures (colored 16×16) under keys
   GRASS/DIRT/STONE/ROCK per docs/07 §5.
2. Terrain: store tile grid; render each solid tile as a 16×16 sprite
   (single Phaser texture atlas of 4×1 tiles is fine).
3. Handle `tile_destroyed`: set those tiles to AIR, remove sprites.
4. Dev hook: `?seed=123&scale=small` query params make GameScene generate a
   LOCAL placeholder map for testing (client-side JS port of the surface
   formula is NOT needed — instead GameScene accepts a `devMap` injected
   by a tiny `devmap.ts` that fetches from the server's future dev route;
   for THIS task just render a flat GRASS/DIRT/STONE test pattern so
   rendering works end-to-end).
**Acceptance**: opening the client shows the test-pattern terrain; killing
  the "server" is not needed yet — a unit test of Terrain's
  `applyDestroyed(tiles)` updates the grid correctly.
**Test**: `cd client && npm test && npm run build`

---

## T1.10 — Camera, bounds, dev map injection [ ]

**Goal**: camera follows a fixed point within map bounds; dev seed
injection works for manual playtest.
**Read**: `docs/01-map.md` §7, `docs/00-architecture.md` §6.
**Files**: `client/src/scenes/GameScene.ts`, `client/src/devmap.ts`
**Steps**:
1. Camera: `setBounds(0,0,w*16,h*16)`, follow a camera anchor at map
   center; no scroll factor surprises (world = map pixels).
2. `devmap.ts`: build a `MapData` object locally (deterministic pattern
   from a numeric seed: simple sine surface + dirt/stone fill) so the
   client can render ANY seed without a server.
3. `?seed=N&scale=small|medium|large` → devmap → Terrain renders it.
4. Manual check: drag a debug camera offset with arrow keys (dev only,
   gated behind `?dev=1`).
**Acceptance**: `npm run dev` + `?seed=777&scale=medium` renders a
  plausible Worms-style terrain; camera clamps at edges.
**Test**: `cd client && npm run build` (manual check in Acceptance)
