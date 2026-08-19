# Future map features — beyond the heightmap

Not scheduled. This records two observations from looking at rendered maps, and what
it would take to act on them. Nothing here is part of qwen's design; it is all
extension work for after the six phases land.

---

## 1. Destruction leaves sealed cavities, and the terrain above never reacts

**Observed**: a rocket fired into a hillside at depth 4 produced a 5-tile pocket with
the ground above it completely unchanged — visible in `renders/map_1_small_after_rocket.png`
as a small dark speck inside the hill, with the surface intact above it.

That is *correct per spec*. docs/01 §5 damages every tile whose centre is inside the
radius and converts DIRT-under-AIR to GRASS, and nothing else. There is no notion of
support, load, or collapse. But the result is that firing into terrain mostly carves
invisible sealed rooms rather than opening the map up.

Two things compound it (both already recorded):

- **D42** — the rocket's 60 damage exactly equals STONE's 60 hp, so underground it
  destroys only the tile at dead centre. Craters below the dirt band are tiny.
- The blast is a **circle of falloff damage**, so the tiles nearest the surface — which
  are the ones that would make a crater *look* like a crater — are the furthest from an
  underground blast centre and take the least damage.

### Options, cheapest first

**(a) Unsupported-tile collapse.** After a destruction batch, flood from the map floor
upward through solid tiles; any solid region not connected to the floor becomes falling
debris or is simply removed. Cheap to implement as a connected-component pass over the
affected rows, and it makes explosions read as structural. Determinism-safe — it is a
pure function of the grid.

**(b) Ceiling shear.** Weaker and cheaper: after a batch, any solid tile with ≥3 AIR
neighbours and AIR below drops one row. Iterate until stable, capped. Produces rubble
slopes rather than clean holes.

**(c) Leave it.** Sealed pockets become caves *by design* once the generator can make
them intentionally (§2), and the tunnel-digging fantasy is served by the map rather
than by weapons. This is a legitimate choice, not a cop-out — but it should be a
decision, not an omission.

**Recommendation**: (a), gated behind a config flag, after Phase 4. It is the one that
turns "I shot a hole in a hill" into "I collapsed the hill".

---

## 2. The generator cannot express caves, arches, bridges or floating islands

**This is architectural, not a tuning problem.** `Map::generate` builds a **heightmap**:
`surface_rows(width, rng)` produces exactly one surface row per column, and
`fill_columns` then fills everything from that row to the bottom. `Map::surface_row(x)`
is documented as "topmost solid row in column".

One surface value per column means the terrain is a **function of x**. It is therefore
*structurally incapable* of representing:

- a cave (two surfaces in one column: floor and ceiling)
- an overhang (solid above air above solid)
- an arch or a natural bridge
- a floating island (solid with air below it all the way down)
- anything an ant-farm interior needs

The reference images all lean on exactly these: stacked plateaus with air beneath,
rock bridges spanning gaps, islands hanging in the sky, and hollow interiors with
multiple routes through them. None of it is reachable from a heightmap, however the
noise is tuned. `all_columns_have_ground` — an existing test — even enforces the
opposite property.

### What would have to change

The grid already supports all of it; `tiles: Vec<Tile>` is a full 2-D array and
`is_solid(x, y)` is per-tile. Only the *generator* is 1-D. So this is additive:

**Stage 1 — keep the heightmap as a base layer, then carve and add.**
Preserves every existing determinism anchor if the new passes run *after* the current
ones and draw from the same `GameRng` in a fixed order (and the golden hashes get
re-pinned deliberately in that commit, per D38).

| Feature | Approach | Notes |
|---|---|---|
| **Caves / tunnels** | Carve with a 2-D noise threshold (worley or ridged perlin) below the surface band; or random-walk "worms" of radius 1–3 tiles, which reuses the existing rock-pocket walk almost verbatim | Guarantee ≥2 exits by carving from one surface point to another. An "ant farm" is just a higher tunnel density with a connectivity pass. |
| **Overhangs** | Post-pass: pick surface points, extend solid outward horizontally by 2–5 tiles and clear beneath | Cheapest way to break the function-of-x property |
| **Arches / bridges** | Choose two surface points across a gap and carve a solid arc between them, then hollow beneath | Reads strongly in the references — a bridge over a chasm is a natural fight corridor |
| **Floating islands** | Place ellipsoid blobs of solid in the air band, grass-crust their top | Needs the jetpack, which already exists, and gives vertical play the current maps lack |

**Stage 2 — connectivity as a first-class constraint.** Once terrain is 2-D, "can a
player get from A to B" stops being obvious. A reachability pass (BFS over tiles a
28 px body fits through, allowing jump height and jetpack range) would let generation
*reject* maps that strand a spawn — which is the general form of the D26/D36 spawn
problems already recorded.

### Things it would break, and that is fine

- `all_columns_have_ground` — becomes wrong by design; floating islands and chasms
  both violate it.
- `surface_row(x)` — needs to become "topmost solid row", explicitly documented as one
  of several surfaces, with a separate `surfaces(x) -> Vec<(top, bottom)>` for anything
  that cares.
- Spawn finding — currently takes GRASS with 2 AIR above. Works unchanged on islands
  and cave floors, which is a good sign.
- The golden anchors — re-pinned deliberately, in the commit that changes generation.
- **D3 and D5's measured bounds** — both are properties of the heightmap and would need
  re-measuring.

---

## 3. Smaller things worth doing at the same time

- **Terrain is spiky.** The current noise produces needle peaks — visible at Large in
  `renders/map_12345_large.png`, and quantified by D3 (adjacent columns differ by up to
  14 tiles). The references are all broad plateaus with sheer sides, which reads better
  and plays better. A smoothing pass, or lower-frequency noise with a separate cliff
  pass, would get closer.
- **Spawn platforms are one tile wide** (measured: median 1 tile against a 24 px body,
  terrain intruding into the body span on 16 of 19 Large spawns). Flattening a 3–5 tile
  shelf under each chosen spawn would fix D26 and D36 at the source rather than at the
  physics layer.
- **Water / a kill floor.** Every reference image has water at the bottom. The current
  maps just end. A kill plane would make falling meaningful and give explosions a
  purpose beyond damage.
- **Decor is placed but never rendered** (recorded as deferred). Bushes, rocks and
  flowers exist in `map.decor` and would cheaply make the surface read as terrain
  rather than as a coloured band.

---

## Sequencing, if this is ever picked up

1. Finish Phases 4–5 as designed. None of this belongs before a playable round exists.
2. Resolve the six geometry prerequisites (D26, D35, D36, D39, D41, D42) — several
   become easier once terrain is deliberately shaped rather than emergent.
3. Unsupported-tile collapse (§1a) — small, self-contained, immediately visible.
4. Caves and overhangs (§2 stage 1) — reuses the rock-pocket walk; biggest gameplay
   change per line of code.
5. Floating islands and arches — needs the connectivity pass (§2 stage 2) to be safe.
