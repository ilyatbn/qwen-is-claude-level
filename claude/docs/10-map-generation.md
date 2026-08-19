# 10 — Map generation

The most important system in the game. A round is only as good as its map: it has
to look organic and hand-drawn like a Worms level, differ meaningfully every time,
and yet be **guaranteed traversable** — no player may ever spawn somewhere they
cannot leave, and no large region may be unreachable.

Numbers referenced here live in `02-constants.md`.

---

## 1. Representation

### 1.1 The mask

Terrain is a **1-bit-per-pixel occupancy mask**. Bit set = solid rock. Bit clear =
air. Nothing else. Every visual detail (material texture, grass edge, decorations)
is derived from this mask at render time; the mask itself carries no colour.

```rust
pub struct Mask {
    pub w: u32,             // multiple of CHUNK_SIZE
    pub h: u32,             // multiple of CHUNK_SIZE
    words: Vec<u64>,        // (w * h + 63) / 64, row-major, no per-row padding
}
```

Indexing: `bit = y * w + x`, `word = bit >> 6`, `shift = bit & 63`.
`w` is always a multiple of 256 so a row always starts on a word boundary
(`256 % 64 == 0`), which makes row-slicing and RLE straightforward.

Memory at the largest scale: 4096 × 2048 bits = **1 MiB**. Trivial.

### 1.2 The coarse grid

A parallel `Vec<u8>` at `COARSE_CELL` (8 px) resolution, one byte per 8×8 cell
holding the count of solid pixels in that cell (0–64). It is maintained
incrementally by every carve.

It gives two cheap answers used constantly by physics:

- `count == 0` → the whole cell is air, skip it;
- `count == 64` → the whole cell is solid, an AABB overlapping it definitely collides.

Only partially-filled cells (1–63) need per-pixel testing. On a typical map, well
over 90 % of cells are one of the two extremes, so collision rarely touches bits.

### 1.3 Chunks

The map is divided into `CHUNK_SIZE` (256 px) square chunks purely for
**rendering and dirty-tracking**. Chunks have no gameplay meaning. A carve marks
every chunk it touched dirty; the renderer re-bakes only those.

```
MAP_SMALL   2048 × 1024  =  8 × 4  =  32 chunks
MAP_MEDIUM  3072 × 1536  = 12 × 6  =  72 chunks
MAP_LARGE   4096 × 2048  = 16 × 8  = 128 chunks
```

### 1.4 The generator's output

```rust
pub struct GeneratedMap {
    pub mask: Mask,
    pub coarse: CoarseGrid,
    pub meta: MapMeta,
}

pub struct MapMeta {
    pub seed: u64,               // the seed that actually produced this map
    pub requested_seed: u64,     // what the caller asked for; differs if attempts were needed
    pub attempts: u8,            // how many regenerations it took
    pub used_safe_preset: bool,  // true if it fell back
    pub scale: MapScale,
    pub theme: ThemeId,          // visual theme, chosen from the seed
    pub spawn_points: Vec<Point>,     // >= SPAWN_COUNT_MIN, well separated
    pub surface_points: Vec<Point>,   // the walkable-surface sample set
    pub buried_slots: Vec<Point>,     // hidden item locations inside rock
    pub decorations: Vec<Decoration>, // cosmetic props anchored to the surface
    pub wind: f32,                    // this round's lateral wind, |wind| <= WIND_MAX
}
```

## 2. Seeding

One `u64` seed per round. Every subsystem draws from its **own** RNG stream,
derived from the round seed:

```rust
pub fn substream(seed: u64, tag: &str) -> ChaCha8Rng {
    ChaCha8Rng::seed_from_u64(seed ^ fnv1a64(tag))
}
```

Tags in use: `"terrain"`, `"blobs"`, `"caves"`, `"spawns"`, `"buried"`, `"items"`,
`"weather"`, `"decor"`, `"theme"`, `"wind"`.

This matters more than it looks. If everything drew from one stream, adding a
single extra item spawn would shift every later draw and change the terrain for
the same seed — silently invalidating every golden test and every bug report.
With sub-streams, terrain is stable no matter what happens elsewhere.

**`ChaCha8Rng` only.** `StdRng` is explicitly not reproducible across `rand`
versions, and `thread_rng` is not reproducible at all.

## 3. The generation pipeline

Eight passes, run in order. Each is a separate function, separately unit tested.

```
  seed ──▶ 1 preset ──▶ 2 silhouette ──▶ 3 blobs ──▶ 4 caves
                                                        │
      ┌─────────────────────────────────────────────────┘
      ▼
  5 smoothing ──▶ 6 cleanup ──▶ 7 validation ──┬── pass ──▶ 8 metadata ──▶ map
                                               │
                                               └── fail ──▶ retry with seed+1
```

### Pass 1 — Preset

`MapScale` selects width, height, `BLOB_COUNT`, `CAVE_TUNNELS`, `BURIED_SLOTS`
and `INITIAL_ITEMS` from the per-scale table in `02-constants.md`. The theme and
this round's wind are also rolled here, from their own sub-streams.

### Pass 2 — Silhouette

The organic shape comes from **domain-warped fractal value noise**, thresholded.

For each pixel `(x, y)`:

1. Warp the sample point so the result is not obviously grid-aligned:
   ```
   wx = x + WARP_STRENGTH * fbm(x * S * 0.5, y * S * 0.5, seed_a)
   wy = y + WARP_STRENGTH * fbm(x * S * 0.5, y * S * 0.5, seed_b)
   ```
2. Sample the main field: `v = fbm(wx * S, wy * S, seed_main)`, normalised to 0..1,
   using `NOISE_OCTAVES`, `NOISE_LACUNARITY`, `NOISE_GAIN`, `S = NOISE_BASE_SCALE`.
3. Apply the vertical bias so the top of the map is sky and the bottom is ground:
   ```
   t    = y / h                                    // 0 at top, 1 at bottom
   bias = lerp(GRADIENT_BIAS_TOP, GRADIENT_BIAS_BOTTOM, smoothstep(t))
   solid = (v + bias) > SOLID_THRESHOLD
   ```
4. Force the borders: rows below `h - BEDROCK_H` are solid; columns within
   `WALL_W` of either edge are solid; rows above `SKY_MARGIN` are cleared.

The bias is what makes the result read as a *landscape* rather than as noise: near
the top almost nothing clears the threshold, near the bottom almost everything
does, and the interesting mixed band sits in between, producing overhangs, arches
and floating chunks naturally.

**Value noise, not Perlin or Simplex, and hand-written** (`map/noise.rs`, ~80
lines): integer-hash lattice + smoothstep interpolation. It has no licensing
questions, is trivially deterministic, and is directly unit-testable (same input →
same output; output stays within 0..1; adjacent samples differ by less than a
bound, i.e. it is actually smooth).

### Pass 3 — Blobs

Adds `BLOB_COUNT` floating islands so the airspace is not empty and jetpack
traversal has destinations. Each blob is a **metaball-ish cluster**: pick a centre
in the upper two thirds of the map, then stamp 3–6 overlapping filled circles with
radii in `BLOB_RADIUS_MIN..BLOB_RADIUS_MAX`, jittered around the centre. Enforce a
minimum centre separation of `2 * BLOB_RADIUS_MAX` so islands stay distinct.

### Pass 4 — Caves

Carves `CAVE_TUNNELS` winding tunnels through the solid mass. Each is a random
walk: start at a random solid pixel with a lot of rock around it, pick a heading,
then repeatedly step `TUNNEL_STEP` px, turning by at most `TUNNEL_TURN_MAX`
radians, stamping an empty circle of radius `TUNNEL_RADIUS_MIN..MAX` at each step,
for `TUNNEL_LENGTH_MIN..MAX` px total. Bias the heading gently toward the
horizontal so tunnels do not immediately drill out of the bottom.

Tunnels do three jobs: they hollow the interior so the map is not a solid brick,
they create the pockets that hide buried items, and they give explosions somewhere
interesting to break into.

### Pass 5 — Smoothing

`CA_ITERATIONS` passes of a cellular automaton over the mask:

```
n = count of solid pixels among the 8 neighbours
solid' = if solid { n >= CA_SURVIVE } else { n >= CA_BIRTH }
```

Out-of-bounds neighbours count as solid, which keeps edges stable. This removes
single-pixel speckle and ragged one-pixel spurs, and rounds the silhouette into
something that reads as rock rather than as static. Double-buffer — do not smooth
in place.

Borders are re-forced after smoothing.

### Pass 6 — Cleanup

Two-pass connected-component labelling (4-connectivity, iterative flood fill with
an explicit stack — never recursion, the maps are too big).

- **Solid components** smaller than `MIN_BLOB_PX` are deleted. This removes floating
  gravel that would look like rendering noise and would be pointless to shoot.
- **Air components** smaller than `MIN_POCKET_PX` are filled. These are sealed
  bubbles too small to matter.
- **Larger sealed air pockets** (≥ `MIN_POCKET_PX` but not connected to the sky
  region) are kept — they are legitimate caves, and they are where buried items
  go. They are recorded in `sealed_pockets` for pass 8. They are *not* used for
  spawns.

The "sky region" is the air component containing pixel `(w/2, 0)`.

### Pass 7 — Playability validation

This pass is the reason the map is never unplayable, and it is the most valuable
thing in this document to get right.

**7a. Extract the walkable surface.**
A pixel `(x, y)` is a *surface point* when:
- `(x, y)` is air, and
- `(x, y+1)` is solid, and
- the `PLAYER_W × PLAYER_H` AABB standing on it is entirely air, and
- there is at least `HEAD_CLEARANCE` px of air directly above.

Scan columns at `SURFACE_SAMPLE_STEP` (16 px) spacing, and within each column take
every qualifying y. This yields ledges, cave floors and island tops, not just the
outer skin — which is correct, since players walk on all of them.

**7b. Build the traversal graph.**
Nodes are surface points. Connect node `a` to node `b` when any of:

| Move | Condition |
|---|---|
| Walk | `|ax − bx| <= SURFACE_SAMPLE_STEP` and `|ay − by| <= STEP_UP` and the AABB sweep between them is clear |
| Drop | `bx` within one step of `ax`, `by > ay`, clear vertical fall corridor |
| Jump | `b` lies inside the ballistic envelope of a jump from `a` (`JUMP_VELOCITY`, `WALK_SPEED`, `GRAVITY`) and a sampled arc between them is clear of solid |
| Jetpack | Euclidean distance ≤ the conservative jetpack range (`JETPACK_MAX_SPEED * JETPACK_MAX_FUEL * 0.6`) and the straight line between them is clear |

The jump check samples the arc at 8 px intervals and tests the player AABB at each
sample. Conservative is fine — a false negative just makes validation stricter.

**7c. Assert the invariants.**
```
largest_component_size / total_surface_points  >=  MIN_TRAVERSABLE_FRACTION  (0.75)
valid spawn points inside that component       >=  SPAWN_COUNT_MIN           (6)
```
A "valid spawn point" is a surface point in the largest component, at least
`SPAWN_MIN_SEPARATION` from every other chosen spawn, and not inside a sealed
pocket.

**7d. On failure, retry.**
Regenerate with `seed + attempt`, up to `MAX_GEN_ATTEMPTS` (12). If all attempts
fail, generate once more with the **safe preset** — fewer caves, fewer blobs, a
lower `SOLID_THRESHOLD`, and a stronger bottom bias — which produces a duller but
reliably connected map. Set `used_safe_preset = true` and log at `warn` level with
the seed, so it can be reproduced and the parameters tuned.

`MapMeta.attempts` and `used_safe_preset` are how we know whether the tuning is
good: in a healthy configuration a proptest sweep over 1000 seeds should almost
never need more than one or two attempts and should never hit the safe preset.

### Pass 8 — Metadata

- **Spawn points**: farthest-point sampling over the valid candidates, so the six
  spawns are as spread out as possible rather than clustered.
- **Buried slots**: `BURIED_SLOTS` points chosen inside solid rock, each with at
  least 24 px of solid in every direction, preferring positions near (but not
  inside) sealed pockets and tunnels so that a single decent explosion can expose
  them. Minimum separation 128 px.
- **Decorations**: cosmetic props (rocks, tufts, bones — see `50-sprites-skins.md`)
  anchored to random surface points, with a surface-normal estimate so they sit
  flat. Purely visual; the client may ignore them.
- **Theme and wind**: rolled in pass 1, copied here.

## 4. Cost

At medium scale the pipeline touches ~4.7 M pixels several times. Budget: **well
under 300 ms** single-threaded in release mode, which is fine at round start
(there is a 10 s warmup). If it ever becomes a problem the CA and labelling passes
parallelise by row bands, but do not optimise before measuring.

The generator must never be called on the render thread or inside a tick.

## 5. Testing

Full detail in `60-testing.md`; the map-specific ones:

- **Determinism**: same seed → identical mask hash, 100 times.
- **Stream isolation**: changing the `"items"` sub-stream does not change the mask.
- **Border invariants**: bedrock rows always solid, wall columns always solid, sky
  rows always empty — asserted after every pass, not just at the end.
- **Proptest sweep** over 1000 random seeds at all three scales asserting the pass-7
  invariants hold, `attempts <= 3`, and `used_safe_preset == false`.
- **Golden hashes**: a small table of `(seed, scale) → blake3(mask)` committed to
  the repo. Any unintended change to the generator breaks it loudly. When a change
  is intentional, the task must regenerate the table and say so.
- **PNG dump**: `cargo test --features dump-png` writes every generated test map to
  `target/mapdump/`. This is the fastest way to answer "does it look like Worms?" —
  no browser needed.

## 6. Future work

- Biome bands (rock below, soil above) driving different material textures per
  depth, and different dig resistance.
- Water at the bottom instead of bedrock, with a rising level as the round ages.
- Hand-authored map templates blended with noise, for a "curated random" feel.
- Symmetric map mode for competitive play.
