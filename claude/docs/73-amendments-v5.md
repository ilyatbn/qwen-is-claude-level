# 73 — Amendments v5: destructible scenery from sprites

An enhancement: turn any PNG into a destructible object, placed at map generation, so
the world has trees, rocks, crystals and ruins in it that you can blow apart.

Constants introduced here are as authoritative as `02-constants.md` and must be
mirrored in `crates/game-core/src/constants.rs` (a `v5` section).

---

## D0 — What the packs actually contain

Catalogued with `scripts/catalogue-sprites.mjs`, which writes a `CATALOGUE.md` into
each pack folder listing every file's canvas size, **opaque bounding box**, fill
ratio and soft-edge ratio. The bounding box is the number that matters: it is the
real size of the object, and most of these canvases are mostly empty.

| pack | files | distinct objects | mean opaque bounds | fill | soft |
|---|---|---|---|---|---|
| rocks | 40 | 40 | 93 × 67 | 0.61 | 0.00 |
| crystals | 40 | 40 | 77 × 57 | 0.61 | 0.00 |
| bushes | 40 | 40 | 74 × 56 | 0.61 | 0.00 |
| ruins | 164 | **40** | 68 × 68 | 0.60 | 0.06 |
| clouds | 125 | 120 + 5 lightning | 124 × 58 | 0.40 | 0.00 |

Three findings that change the design:

**Ruins is 40 objects, not 164.** `Assets`, `Assets_shadow`, `Assets_texture_shadow`
and `Assets_texture_shadow_dark` hold **identical basenames** — they are four render
variants of the same 40 assets. Ship one variant set; the others are alternates.

**They do not need zooming up — measured, they are already large.** At 1:1 a mean
rock is 93 × 67 against a 16 × 28 player: **5.8 player-widths wide and 2.4 player-
heights tall**, and 186 screen pixels at `CAMERA_ZOOM` 2 on a 1280 px screen. The
brief assumed these were small because they are small *relative to a 4096 px map*,
but the map is not what the player is standing next to. Scale is therefore expressed
in **player-heights per category** (§D4) and the typical factor is **below 1.0**, not
above.

**Clouds are not scenery.** Fill 0.40, wispy, 124 × 58 — they are clouds, and there
is a `Lightning` set beside them. They route to the sky layer (`docs/72` §C14 /
T15.03), not to the destructible-object system. Nothing is gained by stamping a cloud
into the terrain.

## D1 — A sprite's alpha becomes terrain, and the terrain clips the sprite

The whole feature rests on one idea, and it needs no new physics, no new damage path
and no new entity type:

> **Threshold the sprite's alpha into the 1-bit terrain mask at generation time.**
> From that moment the object *is* terrain — destructible for free, collidable for
> free, and carved by the same bit-exact `carve_circle` as everything else.
>
> **Then bake the sprite's art clipped by the current mask.** The chunk bake already
> does `drawImage(fill)` → `globalCompositeOperation = 'destination-in'` → stencil
> (`docs/12` §2). An object is one more `drawImage` before that same punch-out — so
> when a rocket takes half a tree, the stencil no longer covers those pixels and
> **the art disappears with the terrain, automatically.**

No per-object health, no destruction states, no swapping to a "broken" sprite. The
mask is the single source of truth for both collision and art, which is what
`docs/10` §1.1 already says it is.

## D2 — The build pipeline

`scripts/build-object-masks.mjs`, run once and committed like the atlases:

1. Read each selected PNG.
2. Threshold alpha at `OBJECT_ALPHA_THRESHOLD` (128) → 1 bit per pixel.
3. Trim to the opaque bounding box.
4. Scale by the category's integer factor (§D4), **nearest-neighbour**.
5. Emit:
   - `assets/objects/masks.bin` — packed 1-bit masks, row-major, one blob
   - `assets/objects/manifest.json` — id, key, pack, category, w, h, anchor, offset into the blob
   - `assets/atlas/objects.png` + `.json` — the art, for the client

`game-core` embeds `masks.bin` with `include_bytes!` so the crate stays pure — no
`std::fs`, per `CLAUDE.md`. The client loads the atlas normally and falls back to a
placeholder per `docs/50` §8 if it is missing.

**Only the server stamps.** The mask ships to clients wholesale via `map_init` RLE
(`docs/40` §3), so the client never re-derives a stamp and there is no opportunity
for the two to disagree. Scaling is integer nearest-neighbour precisely so that if
anything ever *does* re-derive one, it agrees bit for bit (§A24).

## D3 — Where the pass goes, and why the order is load-bearing

```
… 5 smoothing → 6 cleanup → 6b OBJECTS → 7 validation → 8 metadata
```

This position is not a preference. Each neighbour would break it:

- **After smoothing (5)**, or the cellular automaton erodes thin branches and rounds
  every object into a blob. `CA_BIRTH` 5 would eat a 2 px stem.
- **After cleanup (6)**, or components smaller than `MIN_BLOB_PX` (400) are deleted —
  which is most small crystals.
- **Before validation (7)**, or an object that seals a cave mouth or a bridge is
  never caught, and the traversability guarantee that `docs/10` §7 exists to provide
  becomes a lie.
- **Before metadata (8)**, or surface points are extracted from a map without objects
  in it — and then items spawn inside trees and players spawn inside rocks.

> Objects are solid terrain, so everything downstream of them must run after them.
> Stamping late is how you get a bush with a medkit inside it.

## D4 — Scale is measured in player-heights

`PLAYER_H` is 28. Per category, a target height, from which the build step derives
each sprite's integer scale from its own measured bounds:

| category | target height | ≈ scale at mean bounds | reads as |
|---|---|---|---|
| `bush` | 1.0 × `PLAYER_H` (28) | 0.50 | waist-high cover |
| `rock` | 1.5 × `PLAYER_H` (42) | 0.63 | a boulder you hide behind |
| `crystal` | 1.5 × `PLAYER_H` (42) | 0.74 | a landmark you can shoot |
| `ruin` | 3.0 × `PLAYER_H` (84) | 1.24 | architecture |

Only `ruin` is scaled up. The rest come **down**, which is the opposite of the
brief's assumption and follows directly from §D0's measurements.

**Horizontal flip is free and exact** on a bitmask, and doubles the apparent variety
— 40 rocks become 80 silhouettes at no cost. Rotation is not: it is neither exact nor
right for objects with a clear up direction.

## D5 — Placement

Seeded from `substream(seed, "objects")`.

| Name | Small | Medium | Large |
|---|---|---|---|
| `OBJECT_COUNT` | 18 | 30 | 48 |

| Name | Value | Notes |
|---|---|---|
| `OBJECT_MIN_SEPARATION` | 64 | between object centres |
| `OBJECT_CLEAR_OF_SPAWN` | 96 | keep spawn points and teleport pads clear |
| `OBJECT_ALPHA_THRESHOLD` | 128 | α above this is solid |
| `OBJECT_PIXEL_BUDGET` | 0.02 | max fraction of map area added; stop placing at the cap |

- Anchored to a surface point, sitting **on** the ground — walk up from the anchor
  until the base row is supported, the way `docs/50` §6 already places decorations.
- Rejection sampling, capped, then stop — never loop forever (`docs/32` §2).
- The pixel budget is what stops a large map becoming a forest, and it is a
  *measured* cap rather than a count, because a ruin adds twenty times a bush.
- Categories are weighted by theme: `grassland` favours bushes, `desert` rocks and
  ruins, `frost` crystals and rocks.

## D6 — Rendering

One extra step in the chunk bake (`docs/12` §2), between the fill and the punch-out:

```
1  build the alpha stencil from the mask slice          (unchanged)
2  draw the theme's tiling rock fill                    (unchanged)
2b draw every object whose bounds overlap this chunk    ← new
3  destination-in with the stencil                      (unchanged — clips 2 and 2b)
4  edge band                                            (unchanged)
```

- Objects are looked up per chunk from a static index built once at map load, not
  searched per bake.
- An object spanning a chunk boundary is drawn in both, offset — the same margin
  logic the edge band already uses (`docs/12` §2, "Seams").
- **The art is clipped by the live mask**, so destruction needs no per-object work at
  all. That is the payoff for §D1.

## D7 — Provenance

`docs/51` §8 is unambiguous: *"Only CC0 or explicitly-public-domain art enters this
repo"*, and *"every vendored pack keeps its `LICENSE.txt` alongside its files"*.

**`sprite_packs/` contains no licence, readme, or credit file of any kind** — I
looked. Before any of it is committed under `assets/`, its source and licence have to
be recorded in `assets/vendor/README.md` with the pack name, URL, licence and fetch
date, exactly as the Kenney packs are.

This is a note, not an obstacle: the pipeline, the generation pass and the renderer
can all be built and tested against the existing procedural fallbacks, and the art
dropped in once its provenance is written down. **T16.05 is the task that records
it**, and it gates only the commit of the art itself.

## D8 — What this deliberately does not add

- **No per-object health or dig resistance.** Objects carve like rock. `docs/11` §7
  states the no-material-resistance rule and names the seam if it ever changes;
  this feature does not open it.
- **No object physics.** A rock with the ground carved from under it floats, exactly
  as terrain does (`docs/11` §7, "no collapse"). Making objects fall would need
  per-tick connectivity over a million pixels.
- **No new entity type on the wire.** Objects are in the mask, and the mask already
  ships. The only new data is the manifest, which is client-side art.
