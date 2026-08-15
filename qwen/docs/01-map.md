# 01 — Map (generation, tiles, destruction)

Most important system. Everything here is deterministic from `(seed, scale)`.

## 1. Tile grid & scales

- Tile size: **16 px**. Grid is row-major, `y=0` is the TOP row.
- Scales (affect encounter frequency; chosen by server per round):

| Scale | Tiles (W×H) | Pixels (W×H) | Pockets |
|---|---|---|---|
| Small | 96 × 64 | 1536 × 1024 | 8 |
| Medium | 160 × 96 | 2560 × 1536 | 14 |
| Large | 240 × 128 | 3840 × 2048 | 20 |

- Map bounds for camera clamp: `(width*16, height*16)`.

## 2. Tile kinds

| Kind | HP | Notes |
|---|---|---|
| AIR | 0 | empty |
| GRASS | 20 | surface tiles |
| DIRT | 30 | 1–3 tiles under surface |
| STONE | 60 | deep fill |
| ROCK | 80 | rock pockets (may contain hidden items) |

Tile struct: `{ kind, hp }`. A tile is SOLID iff kind != AIR.

## 3. Generation algorithm (exact, deterministic)

All randomness via the round `GameRng` (§4 of docs/00). Order matters —
follow it exactly or determinism tests break.

1. **Heightmap** (1D value noise, 2 octaves):
   - `noise(step)`: build a random value array `v[i] in [-1,1]` for
     `i in 0..=ceil(width/step)+1` using the RNG; sample at integer tile
     columns with cosine interpolation between `v[i]` and `v[i+1]`.
   - `h(x) = H*0.35 + H*0.22 * (0.7*noise(step=8)(x) + 0.3*noise(step=3)(x))`
   - clamp `h` to `[H*0.15, H*0.6]`. Surface row `s(x) = H - 1 - round(h(x))`.
2. **Fill**: for each column x, for each row y from bottom (y=H-1) up to
   `s(x)`: depth `d = s(x) - y`. `d==0` → GRASS, `d<=3` → DIRT, else STONE.
   Everything above `s(x)` stays AIR.
3. **Rock pockets** (count from table in §1): for each pocket:
   - pick random column `x0`, depth `d0 in [2,6]` below surface:
     `y0 = s(x0) + d0` (clamped to grid).
   - random walk: start at `(x0,y0)`, mark ROCK. Then up to 12 steps:
     next = prev + (dx,dy) where dx,dy in {-1,0,1} not both 0, chosen by RNG.
     Mark ROCK only if inside grid AND row > s(x)+1 (strictly below surface).
4. **Decor** (visual only, non-solid): for each surface tile, 12% chance
   (RNG) of one decor: bush / rock / flower (equal weight). Stored as
   `Vec<(x, y, kind)>` where y = surface row.
5. **Spawns** (guaranteed ≥ 6):
   - candidates: GRASS tiles with the 2 tiles above AIR.
   - shuffle candidates with the RNG; greedily accept a candidate if its
     Chebyshev distance to every already-accepted spawn is ≥ 15 tiles.
   - if fewer than 6 accepted, re-run with spacing 10, then 6.
   - spawn position (pixels) = tile center: `((x+0.5)*16, (y+0.5)*16)`,
     player placed so its feet rest on the tile top.

## 4. Map struct (game-core/src/map.rs)

```rust
pub struct Map {
    pub seed: u64,
    pub scale: Scale,          // Small | Medium | Large
    pub width: u32,            // tiles
    pub height: u32,
    pub tiles: Vec<Tile>,      // width*height, row-major, y=0 top
    pub decor: Vec<Decor>,
    pub spawns: Vec<Vec2>,     // tile coords, len >= 6
    pub version: u64,          // +1 on every destruction (client sync)
}
impl Map {
    pub fn generate(seed: u64, scale: Scale) -> Self;   // §3, exact order
    pub fn tile(&self, x: u32, y: u32) -> Tile;
    pub fn set_tile(&mut self, x: u32, y: u32, t: Tile);
    pub fn is_solid(&self, x: u32, y: u32) -> bool;
    pub fn surface_row(&self, x: u32) -> u32;  // topmost solid row in column
    pub fn apply_blast(&mut self, cx: f32, cy: f32, radius: f32,
                       max_damage: f32) -> Vec<TileDestroyed>;  // §5
    pub fn destroy_tile(&mut self, x: u32, y: u32) -> Option<TileDestroyed>;
}
```

## 5. Destruction rules

- **Blast falloff**: for each tile whose CENTER is within `radius` px of
  blast center: `dmg = max_damage * (1.0 - dist/radius)` (clamped ≥ 0),
  subtract from tile.hp. hp ≤ 0 → tile becomes AIR, emit `TileDestroyed`.
- **Surface conversion**: after any destruction, for every DIRT tile whose
  tile directly above is AIR → convert to GRASS (recompute hp to 20).
- **Hidden items**: a ROCK tile may hold one hidden item (set in T3.3).
  When that tile is destroyed, its item spawns at the tile center as a
  pickable ground item and is reported in the `tile_destroyed` event.
- **Weather destruction**: meteors (§2 of docs/02) call `apply_blast`.
  Toxic rain / lava / fog do NOT destroy tiles.
- Every destruction bumps `map.version` and emits events; the server
  broadcasts them immediately (not via snapshot).

## 6. Terrain colliders (physics)

- Solid tiles merged into **horizontal AABB segments**: scan each row,
  group consecutive solid tiles into segments; one rapier fixed collider
  per segment (half-extents from segment length × 16 px).
- Rebuild on destruction: `apply_blast`/`destroy_tile` return destroyed
  tiles; physics rebuilds only segments that contained any destroyed tile
  (recompute contiguous run, remove old collider, insert new ones).
- Air gaps are walkable/destroyable; players can fall into holes (that's
  the Worms feel). No pit-limits in v1.

## 7. Dev & test hooks

- `Map::generate` is pure → unit tested for determinism (100 seeds × 3
  scales: identical bytes), spawn count ≥ 6, spawn spacing, surface
  height bounds, pocket size bounds (≤ 15 tiles, all below surface).
- Dev: server env `WIPGAME_SEED` and client `?seed=` force a seed so any
  map can be replayed (T1.10).
- Map texture variant (visual only, T5.2): `seed % 3` selects a texture set.
