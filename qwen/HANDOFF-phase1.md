# Handoff — Phase 1 (Map generation & destruction, T1.1–T1.10)

State: `Map::generate(seed, scale)` produces Worms-style maps (terrain, rock pockets,
decor, ≥6 spawns). Output is **pinned to golden hashes** for three (seed, scale) pairs
and to a literal ASCII grid for seed 1 / Small, and is separately verified
reproducible within a process over 100 seeds × 3 scales. `apply_blast` destroys tiles
with the documented falloff and surface conversion; the client renders terrain from
`MapData`, applies `tile_destroyed`, and clamps the camera to map bounds.

Commits `8a70652`(T1.1) … `5d0e381`(T1.10), one per task.

---

## Where the code lives

### `server/game-core/src/`

| File | Contents |
|---|---|
| `rng.rs` | `GameRng` — the single randomness source. Fisher–Yates shuffle, Lemire `gen_range`, `random_unit`, `weighted_index`. |
| `tiles.rs` | `TileKind` (+`base_hp`, byte encoding), `Tile { kind, hp, item }`, `TileDestroyed`, `Decor`/`DecorKind`. |
| `map.rs` | `Scale`, `Map`, generation (`value_noise`, `surface_rows`, `fill_columns`, `carve_pocket`, `place_decor`, `find_spawns`), destruction (`destroy_tile`, `destroy_tile_deferred`, `apply_surface_conversion`, `apply_blast`), `ascii_dump`. |
| `protocol.rs` | `ItemId` added (T1.7). Full catalog in T3.1. |
| `tests/determinism.rs` | Golden hashes + the 100-seed × 3-scale reproducibility suite. |
| `tests/golden/seed1_small.txt` | Pinned seed 1 / Small ASCII grid. Regenerate only via `examples/dump_seed1.rs`. |
| `examples/measure_d3.rs`, `measure_d5.rs`, `measure_spawns.rs` | Measurement harnesses backing the DEVIATIONS numbers. Not tests — run with `cargo run --example`. |

### `client/src/`

| File | Contents |
|---|---|
| `logic/terrainGrid.ts` | **Pure** grid model — decode, `applyDestroyed`, `variantAt`, `solidTiles`. Vitest-tested. |
| `logic/camera.ts` | **Pure** camera clamp maths. Vitest-tested. |
| `entities/Terrain.ts` | Thin Phaser layer over `TerrainGrid`. Not unit-tested (needs WebGL). |
| `scenes/BootScene.ts` | Placeholder tile textures (docs/07 §5 colours), then starts GameScene. |
| `scenes/GameScene.ts` | Builds terrain, sets camera bounds, `?dev=1` pan + overlay. |
| `devmap.ts` | Local `MapData` from `?seed=N&scale=...`, no server needed. |

---

## Public entry points

**`game-core`** (a real library crate)
- `Map::generate(seed, scale) -> Map` — the one generation entry point.
- `Map::{tile, set_tile, is_solid, surface_row, tile_at_pixel, is_solid_at_pixel, tile_center, pixel_size}`
- `Map::destroy_tile(x, y) -> Option<TileDestroyed>` — destroys **and** converts (D22).
- `Map::destroy_tile_deferred(x, y)` — batch path; caller runs conversion once.
- `Map::apply_blast(cx, cy, radius, max_damage) -> Vec<TileDestroyed>`
- `Map::apply_blast_with(..., skip_items: bool)` — weather passes `true` (T4.6).
- `Map::apply_surface_conversion()` — run after a batch of destructions.
- `GameRng::{new, next_u64, next_u32, gen_range, gen_range_inclusive, gen_range_f32, random_unit, shuffle, weighted_index}`
- `Scale::{dimensions, width, height, pockets, as_str, from_str, ALL}`
- Constants: `TILE_SIZE`, `MIN_SPAWNS`, `MAX_POCKET_TILES`.

**Client**
- `TerrainGrid.fromMapData(map)`, `.applyDestroyed(tiles, version?)`, `.variantAt(x,y)`, `.solidTiles()`
- `clampCamera(scrollX, scrollY, viewW, viewH, mapW, mapH)`
- `buildDevMap(seed, scale)`, `parseDevOptions(search)`
- `Terrain(scene, grid)` — `.applyDestroyed()`, `.spriteCount`, `.destroy()`

---

## What is tested

**Rust — 69 unit + 6 integration.** Names from `docs/08-testing.md` §1 verbatim:
`seeded_rng_deterministic`, `different_seeds_differ`, `generate_deterministic_100_seeds`,
`spawns_at_least_6`, `spawn_spacing`, `surface_within_bounds`,
`pockets_below_surface_and_sized`, `all_columns_have_ground`,
`blast_falloff_center_max_edge_zero`, `blast_destroys_only_in_radius`,
`surface_conversion_grass_on_air_above`, `destroy_tile_returns_event`,
`version_increments`.

**What the determinism tests do and do not prove.** `generate_deterministic_100_seeds`
generates twice in one process and compares. That proves freedom from
address-ordering, `HashMap`-ordering and uninitialised-memory nondeterminism — real
value — but it **cannot fail when the generation algorithm itself changes**, because
both sides change together. A single wasted `rng.next_u32()` in `generate()` passed it
(and every other test) until review caught it.

The anchor is `generation_matches_golden_hashes` plus
`seed1_small_ascii_dump_is_unchanged`: literal FNV-1a hashes for seed 1/Small, 42/
Medium, 12345/Large, and the seed 1/Small grid pinned as a file. **These are the tests
that fail when generation changes.** Verified by injection — see "Golden anchor" below.

Tests beyond the doc, each closing a specific gap:
- **golden hashes + pinned ASCII grid** — the algorithm anchor described above
- **interleaving** — generating other maps between two runs of the same seed must not
  perturb it, or RNG state is leaking out of the round
- **different seeds must differ** — otherwise determinism is trivially satisfiable
- **every scale produces all 5 tile kinds + decor + spawns** — a generation step that
  silently does nothing is still "deterministic"
- **shuffle `below()` call count is pinned** — one extra call shifts everything downstream
- **no-op destruction must not bump `version`** — or clients resync on every miss
- **blast bounds safety** at map edges and with zero/negative radius
- **batch conversion does not heal damaged DIRT mid-blast** (D22) — pins the exact
  destroyed-tile count for a fixed blast, which is what discriminates the two designs
- **spawn fallback ignores spacing before returning fewer than 6** (the ≥6 guarantee)

### Golden anchor — maintenance

`GOLDEN_MAPS` (`tests/determinism.rs`) and `tests/golden/seed1_small.txt` pin
generation output. If they fail, generation changed: find which draw moved. If the
change was deliberate, regenerate **in the same commit**:

```bash
# Writes the golden file itself, resolved from CARGO_MANIFEST_DIR — works from
# any directory. (An earlier version redirected stdout to a relative path, which
# silently created a nested directory when run from inside game-core/.)
cargo run -p game-core --example dump_seed1

# Then re-pin the hashes:
cargo test -p game-core --test determinism print_golden -- --ignored --nocapture
```

Never update them to turn a red build green without knowing why it moved.

FNV-1a is inlined deliberately — `DefaultHasher`'s algorithm is unstable across Rust
releases, which would make the anchor hostage to the toolchain (the coupling D19
exists to remove).

**Verified by injection** (each reverted afterwards, suite green):

| Injection | Before the guard | After |
|---|---|---|
| `let _wasted = rng.next_u32();` in `generate()` | all 75 pass | `generation_matches_golden_hashes` + `seed1_small_ascii_dump_is_unchanged` **FAIL** |
| swap `value_noise(8)` / `value_noise(3)` order | 68/69 pass (one incidental) | both anchors **FAIL**, unit suite clean |
| `apply_blast`: `destroy_tile_deferred` → `destroy_tile` (D22 hazard) | all 80 pass | `batch_conversion_does_not_reset_damaged_dirt_midway` **FAILS** |

### A recurring failure of mine: "test exists, therefore gap closed"

Three phases running, this handoff claimed coverage the tests did not provide — Phase
0's TS drift guard, Phase 1's determinism suite, and then the D22 test. Each time the
test was real, the code was right, and the claim about what was *guarded* was wrong.

The shared cause is that I verified tests **pass** and never checked they can **fail**.
A passing test is evidence the code works today; only a failing-on-injection test is
evidence of a guard. The D22 case is the sharpest: the test asserted "some surviving
tile retained blast damage", which is true under both the correct and the broken
design, so it could not discriminate — and reverting one identifier left all 80 tests
green.

The standing rule for the rest of this build: **a test described as guarding an
invariant must have been seen to fail when that invariant is violated.** If it has not
been injected against, describe it as coverage, not a guard. Injection results belong
in the table above.

**Client — 49 Vitest.** `terrainGrid` (grid, `applyDestroyed` incl. idempotence and
out-of-bounds, base64 decode, `variantAt`), `camera` (clamp incl. oversized viewport),
`devmap` (dimensions, determinism, layering, ground in every column), `protocol`.

No Phaser import reaches Vitest (D10).

---

## Deviations recorded this phase

| ID | Summary |
|---|---|
| **D3** (updated, measured) | T1.3's "adjacent columns differ by ≤8" holds only at Small. Measured max Δ 7 / 10 / 14; 0 / 13 / 296 violations. Now a scale-relative `ceil(0.13·H)`. |
| **D5** (updated, measured) | Connected ROCK components exceed the documented ≤15 at *every* scale (max 27 / 28 / 30). Asserts the real per-pocket ≤13 bound instead. |
| **D17** | T1.1 names a `UniformRange` trait that does not exist; `rand` 0.9 renamed `gen_range` → `random_range`. |
| **D18 / D20** | `rand_chacha` 0.10 and `rand` 0.9 pull incompatible `rand_core` versions. D20 records that T0.1's gate passed this anyway, because nothing imported the crates yet. |
| **D19** | `shuffle`/`random_unit` implemented here, not delegated to `rand`, so map output is not hostage to a patch bump. |
| **D21** | T1.6's wall-clock perf assertion kept (unlike D12) — 200× margin makes flake implausible. |
| **D22** | Surface conversion is per-batch, not per-destruction — converting mid-blast would reset a damaged DIRT tile's hp to 20 and make output order-dependent. `destroy_tile` converts; `destroy_tile_deferred` is the explicit batch path. |
| **D23** | `cosine_interpolate` uses platform `libm`; 1-ULP drift can survive `.round()` at a tile boundary, so maps are deterministic per-platform, not across. **A cheap compliant fix exists** — the `libm` crate (already in the tree via rapier2d) computes `cosf` portably and is still exactly cosine interpolation. Shipping platform `cos` is "not worth it yet", not "impossible". Pairs with the rapier `enhanced-determinism` decision in T2.6, where this half is the cheap one. |

---

## Deferred — carried forward

Phase 0's list items 1–11 still stand except where noted. New/updated:

| # | Item | Owner |
|---|---|---|
| 1 | `physics.rs`, `player.rs`, `items.rs`, `effects.rs`, `round.rs` are still stubs. | T2.1 on |
| 5 | Client `PROTOCOL_VERSION` mismatch warning. | T4.10 |
| 6 | `MissedTickBehavior::Skip` decouples game time from wall time. | T4.9 |
| 7 | `game-core` needs a `tracing` dep. | T4.9 |
| 8 | rapier2d `enhanced-determinism` is OFF — decide consciously. | **T2.6** |
| 12 | **`Tile.item` exists but is always `None`.** Hidden-item uncovery is wired through `destroy_tile`/`apply_blast` (the `item` field propagates) but nothing populates it. | **T3.3** |
| 13 | **`apply_blast` does no player damage.** It only touches tiles; player falloff is a separate concern. | **T3.8 / T4.5** |
| 14 | **Terrain colliders do not exist.** docs/01 §6's horizontal AABB segments are unimplemented — `Map` has no `affected_segments`. | **T2.3 / T2.7** |
| 15 | **`decor` and `spawns` are generated but never rendered or used.** Client ignores both. | T2.1 (spawns), T5.x (decor) |
| 16 | **Protocol pinning is partial by design** — 22/43 Rust, 12/30 TS types. Extend when a phase first depends on a type. An *optional* added TS field still slips through. | ongoing |

---

## Notes for Phase 2

- **Spawns are tile coords** (D9). T2.1's `y = (tile_y+1)*16 - body_half_height`
  assumes exactly that. `Map::tile_center(x, y)` converts.
- **`Map::is_solid_at_pixel`** is the tile probe T2.3 step 2 needs for ground
  detection — off-map reads as non-solid, so walking off an edge works.
- **Body is 24×28 px** (D6: T2.6's "12×14" read as half-extents).
- Blast damage to *players* is not implemented; `apply_blast` returns destroyed tiles
  only.
- **Tick the checkbox by content match, not line number.** T1.5's tick silently
  no-opped because the heading sat one line lower than assumed. Note `tasks/01-map.md`
  is now LF while the other task files are CRLF — a side effect of that repair. Edit
  the remaining task files with content-matched replacements so they are not converted
  wholesale, which makes the phase diff unreadable.
- **`destroy_tile` converts; use `destroy_tile_deferred` + one
  `apply_surface_conversion()` when destroying in bulk** (D22). T4.6's `clear_area`
  is the next batch caller. `destroy_tile`'s conversion is O(1) (only the tile directly
  below a removed tile can become exposed), so looping over it is linear, not quadratic
  — but a loop still converts per step, which is the D22 hazard. Use the batch path.
- **`golden_hash` already covers `Tile.item`**, so T3.3's hidden-item placement is
  anchored the moment it writes one. Expect `generation_matches_golden_hashes` to fail
  on the T3.3 commit; re-pin it there deliberately.
