# 70 — Amendments v2

Design changes requested after the spec was written. This document **overrides**
the earlier docs where they conflict. Everything not mentioned here stands exactly
as written in `00`–`62`.

Constants introduced here are as authoritative as `02-constants.md` and must be
mirrored in `crates/game-core/src/constants.rs` (v2 section) exactly as below.

---

## A1 — A bigger world, a closer camera

The whole map used to fit on screen. It no longer should: the map is something you
**explore**, and the camera travels with you.

| Name | Value | Notes |
|---|---|---|
| `DEFAULT_MAP_SCALE` | `Large` | 4096 × 2048. `MAP_SCALE=medium` still works. |
| `CAMERA_ZOOM` | `2.0` | Phaser camera zoom. Visible world = 640 × 360 px. |
| `CAMERA_DEADZONE_W` | `120` | camera does not move while the player is inside it |
| `CAMERA_DEADZONE_H` | `90` | |
| `CAMERA_LOOKAHEAD` | `70` | px of aim-direction lead added to the follow target |
| `CAMERA_LOOKAHEAD_LERP` | `0.06` | smoothing on the lookahead offset |

- Visible world area is `VIEWPORT_W / CAMERA_ZOOM` × `VIEWPORT_H / CAMERA_ZOOM`.
  A large map is therefore 6.4 screens wide and 5.7 tall.
- The camera is clamped to the map bounds **using the zoomed viewport**, so the
  view never shows outside the world.
- `FOV_DAY` (640) is now larger than the visible width; in daylight the lightmap is
  effectively off, which is intended. Night (220) is a little over a third of the
  screen width, which is the point.

### World limits are hard

The map is a bounded arena, and reaching its edge stops you.

- Left/right: the `WALL_W` (8) indestructible columns already do this. In addition
  the body's centre is clamped to `[WALL_W + PLAYER_W/2, w - WALL_W - PLAYER_W/2]`
  and `vel.x` is zeroed on contact.
- Top: a hard ceiling at `y = 0`. A body whose top edge reaches `y <= 0` is clamped
  and `vel.y` is set to `max(vel.y, 0)`. Jetpacks cannot leave the world.
- Bottom: `BEDROCK_H` is indestructible, so the floor already stops everything.
- Projectiles that reach any world limit despawn (they do not bounce off the sky).

## A2 — Map generation v2

The generator gains four new passes. The pipeline becomes:

```
1 preset → 2 silhouette → 3 islands → 3b bridges → 4 cave network
        → 4b crevices → 4c voids → 5 smoothing → 6 cleanup
        → 7 validation → 8 metadata
```

Every new pass draws from its own sub-stream (`10-map-generation.md` §2). New tags:
`"bridges"`, `"crevices"`, `"voids"`, `"chambers"`.

### Per-scale table (extends `02-constants.md`)

| Scale | `CAVE_CHAMBERS` | `CREVICE_COUNT` | `VOID_COUNT` | `BRIDGE_COUNT` | `BLOB_COUNT` (was) |
|---|---|---|---|---|---|
| Small | 3 | 4 | 3 | 2 | 6 (was 4) |
| Medium | 5 | 7 | 5 | 4 | 10 (was 7) |
| Large | 8 | 10 | 8 | 6 | 15 (was 11) |

`BLOB_COUNT` is raised because floating islands are now a headline feature.

### Pass 3 — Islands (amends `10-map-generation.md` Pass 3)

An island must read as a **mesa** — a chunk torn out of the ground — not as a
planet. The first map dumps showed the original rule producing near-perfect discs
with a notch bitten out, and the flat-top requirement made it worse by pulling the
whole cluster onto one centre line.

Each island rolls a **base radius** first and derives everything from it:

| Name | Value |
|---|---|
| `BASE_RADIUS_MIN` | `BLOB_RADIUS_MIN + 5` = 45 |
| `BASE_RADIUS_MAX` | `BLOB_RADIUS_MAX * 5 / 8` = 81 |
| top circles | 4–6, spaced **one base radius** apart along a line |
| underside circles | 2–4, at `base_r/3 .. base_r/2` below, radius `base_r/3 .. 2·base_r/3` |
| `ISLAND_GAP` | 40 px of clear air between two islands |

- **Spacing equals the base radius.** Any wider and adjacent circles stop
  overlapping, and the plateau silently becomes a dotted line of separate
  components — invisible until you flood-fill one island and find it is four.
- **Circles are distributed along the span, not sampled independently.** Five
  independent draws from ±130 routinely land within 100 px of each other, which is
  how the disc came back.
- The top circles still share the centre's `y` (±8), keeping the walkable plateau
  that bridges anchor on. Radii vary ±20 % so the top is bumpy.
- Separation is checked against the two islands' **actual** half-widths. A single
  worst-case figure placed only 3 of a small map's 6 islands; per-island widths
  place 5–6 of 6, 9–10 of 10 and 14–15 of 15.
- The chosen centres are returned (`Vec<Point>`) — pass 3b needs them.

### Pass 3b — Bridges

Floating islands you cannot reach on foot are scenery. Bridges make them a route.

| Name | Value |
|---|---|
| `BRIDGE_THICKNESS` | 14 |
| `BRIDGE_MIN_SPAN` | 90 |
| `BRIDGE_MAX_SPAN` | 460 |
| `BRIDGE_SAG` | 18 |
| `BRIDGE_MAX_SLOPE` | 0.45 |

`BRIDGE_THICKNESS` was 7 and `BRIDGE_MAX_SLOPE` did not exist. The first map dumps
showed why both were wrong: a 7 px span across a 3072 px map reads as a hanging
wire rather than a bridge, and with no slope limit two islands 200 px apart
horizontally and 340 px apart vertically were joined by a near-vertical thread.
A bridge is a route you walk, so it is now thick enough to see and flat enough to
use.

For up to `BRIDGE_COUNT` pairs: take island centres sorted by x, and for each
island find the nearest other island whose horizontal distance is within
`BRIDGE_MIN_SPAN..=BRIDGE_MAX_SPAN` and which is not already bridged to it. Find
each end's **top surface** (walk up from the centre until air), then stamp a solid
band from end to end, sagging by up to `BRIDGE_SAG` px at mid-span
(quadratic), with thickness `BRIDGE_THICKNESS`. Use the shared `stamp_circle` along
the path so the result is bit-identical to every other solid stamp.

Bridges are ordinary terrain: they are destructible, and blowing one up strands
whoever is on the far side until they find another way. That is a feature.

### Pass 4 — The cave network (replaces `10-map-generation.md` Pass 4)

Caves are no longer independent worms. They form an **ant farm**: chambers joined
by tunnels, with loops, and with several mouths open to the sky.

| Name | Value |
|---|---|
| `CHAMBER_RADIUS_MIN` | 26 |
| `CHAMBER_RADIUS_MAX` | 62 |
| `CHAMBER_MIN_SEPARATION` | 220 |
| `CAVE_ENTRANCES_MIN` | 2 |
| `CAVE_ENTRANCES_MAX` | 4 |
| `ENTRANCE_RADIUS` | 15 | corrected in §A9 |
| `CAVE_EXTRA_EDGE_FRACTION` | 0.5 | extra loop edges as a fraction of chamber count |

1. **Chambers.** Pick `CAVE_CHAMBERS` centres inside solid rock (at least 40 px of
   solid around them), min separation `CHAMBER_MIN_SEPARATION`, y in
   `SKY_MARGIN + 120 .. h - BEDROCK_H - 40`. Stamp each as a cluster of 2–4 empty
   circles of radius `CHAMBER_RADIUS_MIN..=CHAMBER_RADIUS_MAX`.
2. **Spanning tree.** Connect the chambers with a nearest-neighbour spanning tree
   (Prim's, ties broken by index so it is deterministic).
3. **Loops.** Add `round(CAVE_CHAMBERS * CAVE_EXTRA_EDGE_FRACTION)` extra edges
   between random non-adjacent chamber pairs, shortest-first. Loops are what make a
   cave system readable and escapable rather than a dead-end maze.
4. **Tunnels.** Each edge is carved by the existing random walk, but *steered*: at
   each step the heading is turned toward the bearing to the target by at most
   `TUNNEL_TURN_MAX`, plus a random jitter of up to `TUNNEL_TURN_MAX * 0.6`, so it
   wanders but always arrives. Radius varies as before. The walk ends when within
   one radius of the target, or after `3 × direct distance / TUNNEL_STEP` steps.
5. **Entrances.** Choose `CAVE_ENTRANCES_MIN..=CAVE_ENTRANCES_MAX` distinct chambers
   and carve a shaft from each **upward to open sky**: a steered walk with the
   target directly above at `y = SKY_MARGIN`, radius `ENTRANCE_RADIUS`, stopping as
   soon as the stamp reaches air that connects to the sky region (in practice, when
   `y <= SKY_MARGIN` or 32 consecutive stamped pixels were already air).
6. **Free tunnels.** Then carve `CAVE_TUNNELS` unsteered wandering tunnels exactly
   as the original Pass 4 described, for texture and for pockets.

All stamped centres from every step are returned as `Vec<Vec<Point>>`, still used
by T1.13 to place buried slots near tunnels.

### Pass 4b — Crevices

Narrow cracks that open the surface into the rock. They are how you fall into a
cave without meaning to.

| Name | Value |
|---|---|
| `CREVICE_WIDTH_MIN` | 12 | corrected in §A9 |
| `CREVICE_WIDTH_MAX` | 36 | corrected in §A9 |
| `CREVICE_DEPTH_MIN` | 90 |
| `CREVICE_DEPTH_MAX` | 430 |
| `CREVICE_WANDER` | 0.16 | max heading change per step, radians, around straight down |
| `CREVICE_STEP` | 6 |

Start at a random x, walk **down** from the first solid pixel in that column,
stamping empty circles of radius `width / 2` every `CREVICE_STEP` px for a total
depth in `CREVICE_DEPTH_MIN..=CREVICE_DEPTH_MAX`. Width tapers linearly to 60 % at
the bottom. Stop at bedrock. A crevice that starts over open air is skipped.

### Pass 4c — Voids

Big irregular holes punched through the mass. They create chasms, arches, and —
after cleanup deletes what is left dangling — genuine islands.

| Name | Value |
|---|---|
| `VOID_RADIUS_MIN` | 70 |
| `VOID_RADIUS_MAX` | 155 |
| `VOID_MIN_SEPARATION` | 260 |

Each void is a cluster of 3–6 empty circles jittered around a centre by up to
`VOID_RADIUS_MAX / 2`, in `y ∈ SKY_MARGIN .. h - BEDROCK_H - 60`.

### Validation

Pass 7 is unchanged and still binding. With islands, voids and crevices the
generator will fail validation more often; `MAX_GEN_ATTEMPTS` (12) is unchanged and
the safe preset now also sets `void_count = 0`, `crevice_count = 0`,
`bridge_count = max(bridge_count, 2)`.

Because the traversal graph counts jetpack edges, islands connect. Bridges exist so
that they connect on foot as well.

## A3 — Every shot is visible, and every shot digs

- **All three weapons already carve** (42 / 36 / 3 px). No change, but it is now a
  stated requirement rather than an emergent property: nothing in this game hits a
  wall without marking it.
- **Projectiles** (bazooka, grenade, meteors, fragments) render as a sprite with a
  fading motion trail and, at night, as a moving light source.
- **Hitscan is drawn.** The `hitscan` event already carries `x0,y0,x1,y1`. The
  client draws a bright tracer along that segment plus an impact spark and a small
  dust puff at the hit point.

| Name | Value |
|---|---|
| `TRACER_LIFETIME` | 0.09 | seconds a tracer segment stays visible |
| `TRACER_WIDTH` | 2.0 | px, at zoom 1 |
| `PROJECTILE_TRAIL_LEN` | 12 | trail sample points |

## A4 — A real sky: five phases, a sun and a moon

`darkness` and everything gameplay-facing in `14-daynight-visibility.md` is
**unchanged** — the server formula and its tests stand. What changes is that the
sky is no longer a static gradient with a dark overlay on top.

The cycle length is `DAY_DURATION + NIGHT_DURATION` = 120 s. Let
`u = (round_time / 120) mod 1`.

| Phase | `u` range |
|---|---|
| `Morning` | 0.00 – 0.15 |
| `Day` | 0.15 – 0.40 |
| `Afternoon` | 0.40 – 0.50 |
| `Evening` | 0.50 – 0.62 |
| `Night` | 0.62 – 0.90 |
| `Dawn` | 0.90 – 1.00 |

`phase_change` (`40-net-protocol.md`) now carries one of these six names rather
than `day`/`night`.

### Sky gradient keyframes

Interpolated in linear RGB between adjacent keyframes, wrapping at 1.0:

| `u` | top | bottom |
|---|---|---|
| 0.00 | `#1b2a5e` | `#f2a15c` |
| 0.12 | `#3f7fd0` | `#bfe3f5` |
| 0.30 | `#2f7fd8` | `#a8d8f0` |
| 0.45 | `#3a6fb8` | `#f0c07a` |
| 0.55 | `#4a2c6b` | `#e2723b` |
| 0.64 | `#221041` | `#6b2f5c` |
| 0.78 | `#030616` | `#0d1a3a` |
| 0.92 | `#050a1c` | `#10204a` |
| 0.96 | `#101a44` | `#6a4a6e` | *(added during T3.12 — see below)*

The `0.96` keyframe was **not** in the original table and was added when T3.12
measured the gradient's continuity: without it the sky went from near-black at 0.92
straight to a bright sunrise at 0.0, putting the whole of dawn into 9 seconds and
producing a visible step. Interpolation is in **linear** RGB, which is also why the
step was worst there — near black, a small linear change is a large sRGB one.

### Sun and moon

Both travel a semicircular arc across the sky layer, drawn at a parallax factor of
`SKY_BODY_PARALLAX` so they drift slowly relative to the world.

```
sun visible for u in [0.00, 0.55];  p = u / 0.55
moon visible for u in [0.50, 1.00]; p = (u - 0.50) / 0.50
x = lerp(-0.1, 1.1, p) * viewport_w
y = horizon_y - sin(p * π) * SKY_BODY_ARC_H
```

| Name | Value |
|---|---|
| `SUN_RADIUS` | 34 |
| `MOON_RADIUS` | 26 |
| `SKY_BODY_ARC_H` | 300 |
| `SKY_BODY_PARALLAX` | 0.08 |
| `STAR_COUNT` | 220 |
| `STAR_FADE_START` | 0.58 | `u` at which stars begin to appear |

The sun is drawn with an additive glow tinted toward orange near the horizon; the
moon is a pale disc with a faint halo. Stars fade in with `darkness / NIGHT_DARKNESS`
and twinkle with a per-star seeded phase.

## A5 — Bots

A deathmatch with one human is not a deathmatch. The server can seat AI players.

| Var | Default | Meaning |
|---|---|---|
| `BOT_COUNT` | `3` | bots seated in the room, up to `MAX_PLAYERS` total |
| `BOT_SKILL` | `0.6` | 0..1; scales reaction time and aim error |

Bots are ordinary `PlayerState` entries driven by a `game-core` controller that
produces an `Input` each tick, so they go through exactly the same `apply_input`,
the same weapons and the same damage path as a human. They are not special-cased
anywhere in the sim, which means a bug that affects bots affects players.

Bot behaviour (`game-core/src/bots/`): pick a target (nearest visible living
player, or the nearest item if unarmed or low), walk/jump/jetpack toward it using
the surface graph as a coarse guide, fire the selected weapon when the target is
within range and roughly in line of sight, and use a medkit below 40 health.
Deterministic: one `ChaCha8Rng` sub-stream per bot, `substream(seed, "bot0")` …

Bots are what makes the game testable end to end without six browsers, and they
are what makes it fun to open on your own.

## A6 — Minimap

A small map in the top-right corner showing terrain that has been within your FoV
this round, with your position, item pings and the map bounds. It is the payoff for
exploration and it makes a large map legible.

| Name | Value |
|---|---|
| `MINIMAP_W` | 200 |
| `MINIMAP_H` | 100 |
| `MINIMAP_ALPHA` | 0.75 |
| `MINIMAP_REVEAL_R` | 260 | world px revealed around the player each tick |

Toggled with `M`. Client-only; it reveals from the client's own mask, so it costs
the server nothing.

## A7 — Constants the original spec stated in prose only

`docs/02-constants.md` §Weapons gives these as sentences rather than table rows,
which makes "every number lives in a table" unverifiable. They are now rows. The
values are unchanged — this is bookkeeping, not tuning.

| Name | Value | Source |
|---|---|---|
| `SMG_SHOTS` | 1 | `31-weapons-combat.md` §1 — the smg fires one ray per trigger pull; `Delivery::Hitscan { shots }` needs a number |
| `SMG_GRAVITY_SCALE` | 0.0 | `31-weapons-combat.md` §1 table row "Gravity scale — 0" |
| `SMG_WIND_SCALE` | 0.0 | `31-weapons-combat.md` §1 table row "Wind scale — 0" |
| `GRENADE_REST_SPEED` | 30.0 | `31-weapons-combat.md` §3 — "below ~30 px/s ... stop it" |
| `PROJECTILE_OWNER_GRACE_TICKS` | 3 | `31-weapons-combat.md` §3 — "excluding the owner during the first 3 ticks" |

## A8 — Client test layout: pure logic never imports Phaser

Phaser cannot be imported under vitest on this project: `environment: 'node'` fails
with `window is not defined`, and `jsdom` fails inside `CanvasFeatures` because
jsdom's `getContext('2d')` returns null. Making it work would mean the native
`canvas` package and a C toolchain, which is not worth it.

So the rule is structural, and it applies to **every** client module with testable
logic in it:

> A module that imports `phaser` exports no pure function that a test needs.
> Pure logic lives in a sibling Phaser-free module, and the Phaser class imports
> *it* — never the reverse.

Concretely, replacing the single-file deliverables in the v2 task files:

| Task | Phaser-free (tested) | Phaser (untested, eyeballed) |
|---|---|---|
| T3.12 | `client/src/render/sky-math.ts` — `cycleU`, `skyPhase`, `skyColors`, `bodyPositions`, `starField` | `client/src/render/sky.ts` — `SkyLayer` |
| T4.15 | `client/src/render/ordnance-state.ts` — tracer/trail/impact bookkeeping, `lights()` | `client/src/render/ordnance.ts` — `OrdnanceLayer` |
| T8.06 | `client/src/ui/minimap-math.ts` — reveal grid, world↔minimap mapping | `client/src/ui/minimap.ts` — `Minimap` |
| T8.08 | `client/src/render/feel-math.ts` — trauma decay; `client/src/ui/killfeed-state.ts` — the queue | `client/src/render/feel.ts`, `client/src/ui/killfeed.ts` |

`vitest` keeps `environment: 'node'`. Any test file that needs the Phaser namespace
for a type only may `import type` it, which is erased at compile time and safe.

## A9 — Tunnel bores were sized against the wrong body dimension

**This corrects an arithmetic error in `02-constants.md` and in §A2 above.**

A *horizontal* tunnel's clear bore is its diameter, and the player is
`PLAYER_H` = 28 px tall. So a horizontal tunnel admits the player only at
radius ≥ 14. The original values do not:

| Constant | Was | Bore | Verdict |
|---|---|---|---|
| `TUNNEL_RADIUS_MIN` | 10 | 20 px | too tight |
| `ENTRANCE_RADIUS` | 13 | 26 px | too tight |

Measured consequence at the old values: a 1-px flood fill reaches 100 % of cave
chambers from the sky, but a **16 × 28 body** flood reaches only 76 %, and every
chamber is body-reachable on just 6 of 20 seeds. 16 % of all carved air on a map
cannot hold the player box. The cave system was a quarter decoration.

The M0 constants test missed it because it asserted
`TUNNEL_RADIUS_MIN * 2 >= PLAYER_W` — 20 ≥ 16 passes. For a horizontal bore the
binding dimension is `PLAYER_H`, not `PLAYER_W`.

### Corrected values

| Name | Value | Notes |
|---|---|---|
| `TUNNEL_RADIUS_MIN` | 15 | bore 30 px: 28 + 2 px of margin for CA erosion |
| `TUNNEL_RADIUS_MAX` | 26 | raised from 22 so the min→max variation still reads as pinch-and-widen |
| `ENTRANCE_RADIUS` | 15 | entrance shafts wander, so size them for the horizontal case too |
| `CREVICE_WIDTH_MIN` | 12 | see below |
| `CREVICE_WIDTH_MAX` | 36 | |

Crevices are the deliberate exception. They are vertical, so their binding
dimension is `PLAYER_W` (16) and the taper to 60 % at the bottom must still clear
it. Widening the range rather than raising the floor gives a **mix**: narrow ones
are cracks that let light and grenades through, wide ones are a way in. Both are
wanted; a map where every crack is an entrance is as flat as one where none are.

### The rule this comes from

> Any passage the player is meant to traverse is sized against **`PLAYER_H` for a
> horizontal bore and `PLAYER_W` for a vertical one**, plus 2 px of margin for CA
> erosion — and the test that guards it asserts against that dimension by name.

Consequently `air_reachable_from_sky` and any later reachability check must flood
**body clearance**, not single pixels. A test that certifies 1-px connectivity is
certifying something no player can use.

## A10 — Traversability must be mutual

**This corrects `10-map-generation.md` §7b.**

The traversal graph as specified is undirected, and the `NavRegions` model built on
it treats the open sky as one region, so every sky-exposed surface point is unioned
with every other regardless of distance. Measured consequences on adversarial masks:

| mask | old verdict | correct |
|---|---|---|
| 1900 px smooth shaft, open to sky, no ledges | traversable, fraction 1.000 | **no** |
| undercut pit, 600 px deep | connected | **no** |
| two plateaus 1600 px apart, open sky | connected | **no** |

A player who falls down that shaft needs 1901 px of unbroken climb. A full jetpack
gives roughly `JETPACK_MAX_SPEED * JETPACK_MAX_FUEL` ≈ 1300 px, and there is nowhere
to land and refuel. The map is certified playable and is a hole you die in.

The error is treating "can get from A to B" as symmetric. Falling is free; climbing
is not.

### The rule

> Edges in the traversal graph are **directed**, and validation measures the largest
> **strongly connected** set — the points that can reach each other *both ways*.

| Move | Direction |
|---|---|
| Walk | both ways |
| Drop | **downward only** |
| Jump | both ways when the rise is within the jump envelope; downward only otherwise |
| Jetpack | both ways when the rise is ≤ `JETPACK_CLIMB_BUDGET`; downward only otherwise |
| Nav-region union through open air | subject to the same rise test — it is not a free pass |

| Name | Value | Notes |
|---|---|---|
| `JETPACK_CLIMB_BUDGET` | 780 | `JETPACK_MAX_SPEED * JETPACK_MAX_FUEL * 0.6`, the conservative range already used for jetpack edges |
| `LEDGE_REFUEL_RISE` | 780 | a climb longer than this is only permitted if it passes within `STEP_UP` of a standable surface point, which is where you land and refuel |

`MIN_TRAVERSABLE_FRACTION` (0.75) is unchanged but now measures
`largest_scc / total_surface_points`. This is a strictly stronger gate, so expect the
attempt distribution to worsen; if the safe-preset rate rises above ~1 %, report the
numbers rather than lowering the threshold.

### Metadata

`MapMeta` gains `largest_component: Vec<u32>` — the indices into `surface_points`
that form the validated SCC. Without it, nothing downstream can tell "every cave is
reachable" from "every cave is sealed", because a caller with no component to test
against will pass every index and get an answer that is only the surface fraction
under another name. That is precisely what the 999-seed sweep was reporting: a real
88.2 % measured as 91.6 %.

## A11 — Determinism: no `HashMap` iteration, ever, in the generator

`traversal.rs` selected the largest component with `HashMap::into_values().max_by_key()`.
`std::collections::HashMap` is randomly seeded **per process**, and `max_by_key`
returns the last of several equal maxima — so on a size tie the chosen component
varied run to run. Reproduced: same binary, same input, 12 processes, 8 chose one
component and 4 chose the other.

`largest_component` feeds spawn selection, so one seed could produce different spawn
points in different processes — breaking the replay and golden guarantees in
`01-architecture.md`. **The golden table hashes only the mask, so it can never catch
this class of bug.**

The rule, which is now absolute:

> No iteration over a `HashMap` or `HashSet` anywhere a generated result depends on
> the order. Key-lookup use is fine. Where a tie is possible, break it explicitly on
> a stable integer — never leave it to `max_by_key`'s last-wins.

Golden tests must cover `MapMeta` (spawn points, buried slots, component size), not
only the mask.

## A12 — Corrections to earlier docs found in review

- `11-map-destruction.md` §8 says the dirty-chunk set "exactly equals the set of
  chunks whose bits actually changed". The implementation marks the carve circle's
  bounding box, which is a **superset** by at most four chunks. Over-reporting costs
  one free rebake and under-reporting corrupts the render, so the implementation is
  right and the doc is wrong. The requirement is: **the dirty set is a superset of
  the changed set, and never omits a changed chunk.**
- `BURIED_CLEARANCE` (24), `BURIED_SEPARATION` (128), `BURIED_OFFSET_MIN`,
  `BURIED_OFFSET_MAX` and `BURIED_ATTEMPTS` belong in `constants.rs` like every other
  tunable, not as file-local consts in `map/gen/meta.rs`.
- `is_buried` samples the centre and four points at exactly ±clearance, never the ray
  between, so a slot can sit against a tunnel wall while the pixel 24 px out is solid
  (measured: 2 of 400 slots). Its test asserts the *same five pixels*, so it cannot
  catch it. Both must sample the full ray. The same weakness governs chamber
  placement at `CHAMBER_CLEARANCE`.

## A13 — The sunset must happen while the sky is showing a sunset

**This corrects §A4 above and `14-daynight-visibility.md` §1.**

The two were specified independently and they disagree on pacing. `darkness` ramps
0 → `NIGHT_DARKNESS` over `CYCLE_TRANSITION` (8 s) centred on the day/night
boundary at t = 60, so the world is already fully dark at **t = 64**. §A4's
`evening` phase runs u 0.50–0.62, i.e. **t = 60 → 74.4**. So roughly ten of
evening's fourteen seconds play at full darkness, with the orange sunset keyframe
(u = 0.55) displayed underneath a black overlay.

The player sees the sky say "sunset" while the world says "midnight". Both clocks
are correct about the time and wrong about each other.

The fix is to derive darkness from the **same phase table the sky uses**, so there
is one description of the day and everything reads from it:

```
darkness(u) =
  0                                              u <  0.50          day
  NIGHT_DARKNESS * smoothstep((u-0.50)/0.12)     0.50 <= u < 0.62    dusk ramp
  NIGHT_DARKNESS                                 0.62 <= u < 0.90    night
  NIGHT_DARKNESS * (1 - smoothstep((u-0.90)/0.10)) 0.90 <= u < 1.00  dawn ramp
```

Dusk is therefore 14.4 s and dawn 12 s, both matching their phases exactly, and
`CYCLE_TRANSITION` is no longer used for darkness. It stays in `constants.rs` as
the audio/UI cue lead time.

`14-daynight-visibility.md` §7's tests are superseded on two rows: darkness at
t = 64 is now ~0.31 rather than `NIGHT_DARKNESS`, and full darkness is first
reached at t = 74.4. The properties that still hold and must still be tested are
the ones that matter: darkness is 0 at t = 0, continuous everywhere (no jump
larger than one tick's worth), monotonic within each ramp, and a 240 s round
contains exactly two nights.

## A14 — The cave backdrop is seeded from the sky, not from the border

**This corrects the backdrop rule in §A2's implementation notes.**

Flooding "outside" from all four borders and gating passage on a `REACH_PX` = 28
disc means any chamber joined to open air by a passage wider than 56 px floods and
renders as **open sky**. Measured: a 312 × 360 px cavern went from 0 % sky pixels
to 84 % after the blockiness fix. Tunnels (bore 30–52 px) stay under the threshold
and still render correctly, which is exactly why it looked fine at first glance —
the failure is confined to voids (140–310 px) and large chambers (up to 124 px),
which is to say to the biggest holes on the map.

A hole through the mountain that shows sky is worse than the axis-aligned artifact
it replaced.

The disc test answers "is this passage wide enough to be a mouth", which is the
right question for crack width and the wrong one for "is this the sky". So:

> Seed the flood from **genuine sky only** — air connected to the top border, or
> above `SKY_MARGIN` — never from all four borders. Keep the disc purely as the
> width gate on what the flood may pass through.

The rejected alternative stays rejected: a per-column "everything above the
highest rock is exterior" clip paints bright sky down every crevice, because a
crack open at the top has no rock above it either. Width is the distinction, and
only the disc measures width.

## A15 — Instrument effects, not intentions

`docs/14` §7 asks to verify the lightmap does zero work in daylight. It was
instrumented with a counter incremented **once per erased light** and never for the
fill, so it reads 0 in two unrelated situations: the pass was skipped, and the pass
ran at full darkness with no light on screen. A night frame reported
`lightmap draws 0` while a night sky was on screen.

Worse, the same measurement said `draws: 1` at night while terrain pixels were
**bit-identical** to daylight — the pass ran and composited nothing.

> A counter that reports that work was *attempted* is not evidence the work
> *happened*. Where a test can assert on the rendered result, it must.

So: the daylight-skip assertion is on a `filled` flag set when the fill actually
executes, and the night-darkness assertion is on **sampled pixels** — terrain
materially darker at night than at day, and lighter near the player than at the
screen corner. Note that a whole-frame luminance mean does **not** work: the sky
dominates the average and reports a healthy day→night drop while the world stays
lit. Sample terrain.

## A16 — The FoV radii were authored for a 1× camera

**This corrects the FoV rows of `02-constants.md`, and it is the cause of "night
does not darken the world".**

`FOV_DAY` (640) and `FOV_NIGHT` (220) are world-pixel radii, chosen when the
viewport showed `VIEWPORT_W × VIEWPORT_H` = 1280 × 720 **world** pixels. §A1 then
set `CAMERA_ZOOM = 2.0`, so the viewport now shows 640 × 360 world pixels — and
every FoV radius covers **twice the fraction of the screen** it was designed to.

Measured at zoom 2, seed 4242, terrain pixels on the row through the player:

| distance from player | day | night |
|---|---|---|
| 60 px | 76 | 77 |
| 124 px | 70 | 68 |
| 188 px | 70 | 55 |

The lit circle is 220 × 2 = **440 screen px** in radius on a 1280 × 720 screen,
whose half-diagonal is 734. The player is always at the centre of it, so at night
they see a pool of light covering 60 % of the way to the corners. The design
intended 220 / 734 = 30 %.

Nothing was wrong with the lightmap; it was faithfully rendering a radius that is
twice as generous as intended. This is why the effect survived a `drawsLastFrame`
check, a `darkness` check and an FoV-formula check — every number was correct
except the one nobody stated: the radius **relative to what is on screen**.

### Corrected values

| Name | Was | Now | Notes |
|---|---|---|---|
| `FOV_DAY` | 640 | 320 | still larger than the visible half-width, so daylight stays effectively unrestricted |
| `FOV_NIGHT` | 220 | 110 | restores the intended 30 % of the screen half-diagonal |
| `FLASHLIGHT_RANGE` | 520 | 260 | the cone keeps its advantage over ambient sight at the same ratio |

### The rule

> A radius that exists to control **what the player can see** is meaningless
> without the zoom it is seen at. Any future change to `CAMERA_ZOOM` must scale
> `FOV_DAY`, `FOV_NIGHT` and `FLASHLIGHT_RANGE` with it, and the test that guards
> night visibility must assert on **sampled terrain pixels at a known screen
> distance from the player**, never on the radius alone.

## A17 — The cave backdrop is an enclosure test, not a connectivity test

**This supersedes §A14, which was correctly implemented and aimed at the wrong
question.**

§A14 made sealed air render as cave backdrop, and it does: measured over a real
generated map, 27,420 sealed air pixels, **zero** drawn as sky. But sealed air was
never the problem. Measured on the same map:

| | px | share |
|---|---|---|
| roofed air (rock somewhere above it in its column) | 1,122,382 | — |
| …drawn as **sky** | **552,848** | **49.3 %** |

Half of all roofed air renders as open daylight. The player stands under a rock
ceiling and sees sky above them. On a map whose headline features are voids
140–310 px across and an ant-farm cave system, the sky region reaches deep into the
terrain through every wide mouth, so "is this air connected to the sky" is not a
proxy for "is this outdoors".

Neither is roofedness on its own: air under a **floating island** is roofed, and it
is unambiguously sky. That is the case that kills the simple fix, and it is why two
rounds of work on this have not landed it.

### The rule

What separates a cavern from the space under an island is **enclosure**, not roof.
A cavern has rock in most directions; under an island there is rock above and open
air below and to the sides.

> Cast `BACKDROP_RAYS` rays from an air sample in evenly spaced directions. Count
> how many strike solid within `BACKDROP_RAY_LEN`. The sample is **interior** when
> at least `BACKDROP_MIN_HITS` of them do, or when its air component is sealed
> (§A14's rule, kept as an `OR`).

| Name | Value | Notes |
|---|---|---|
| `BACKDROP_RAYS` | 8 | evenly spaced, starting at 0 rad |
| `BACKDROP_RAY_LEN` | 320 | world px |
| `BACKDROP_MIN_HITS` | 4 | of 8 — see §A18, then §A19 |

Checked against every case on the map:

| case | rays hitting | verdict |
|---|---|---|
| cavern interior, tunnel, chamber | 8 | interior ✓ |
| crevice (open above, rock on both sides and below) | 6–7 | interior ✓ |
| under a floating island | 1–3 | sky ✓ |
| just above the ground surface | 1–2 | sky ✓ |
| open sky | 0 | sky ✓ |

### Resolution, and the blockiness trap

Eight rays per pixel over 8.4 M pixels is too slow, and computing the decision on
the coarse grid is what produced the axis-aligned rectangles in the first place.
So: evaluate the **hit count per coarse cell**, then **bilinearly interpolate** that
field to pixel resolution and threshold there. The field is smooth, so the
boundary follows the rock rather than the grid. The `EDGE_BAND_PX` proximity bound
from §A14's test still applies.

### The test that would have caught all of this

`BackdropMask` has only ever been tested against a synthetic hand-built mask, and
every defect in it has lived exclusively in real generated terrain. So the test is:
generate a real map, then assert on measured shares —

- enclosed air drawn as sky: **< 2 %**
- open sky drawn as backdrop: **< 2 %**
- the specific case: sample air 60 px below a floating island, assert it is sky
- longest axis-aligned interior/exterior boundary run: **< 40 px** (the original
  defect produced ~100 px runs; the §A14 implementation measured 35 px, so this
  bound holds the line already won)

## A18 — `BACKDROP_MIN_HITS` is 5, and the two error rates trade against each other

§A17 set `BACKDROP_MIN_HITS` = 6 and asked for **both** enclosed-air-drawn-as-sky
and open-sky-drawn-as-backdrop under 2 %. Measured on a real medium map (seed 4242,
every 4th pixel), no value of the threshold achieves both:

| `BACKDROP_MIN_HITS` | enclosed air drawn as sky | open sky drawn as backdrop |
|---|---|---|
| 4 | 0.0 % | 7.3 % |
| **5** | **0.9 %** | **2.5 %** |
| 6 (as specified) | 4.4 % | 0.7 % |

The two failures are not equally bad. **Enclosed air drawn as sky** is the defect
that has now recurred three times: the player stands inside a cavern and sees
daylight through the rock, which is the thing this whole mechanism exists to
prevent. **Open sky drawn as backdrop** darkens a patch of sky, which reads as haze
and which nobody has ever reported.

So the threshold is **5**, and the acceptance bounds become: enclosed-as-sky
**< 2 %**, open-as-backdrop **< 3 %**. That is a deliberate bias toward the failure
that is merely cosmetic, and away from the one that is confusing.

### Two implementation notes, both found by measuring

- **The field must be smoothed before it is interpolated.** Ray counts are integers
  and the threshold is an integer, so where adjacent cells read 5 and 6 the
  bilinear crossing lands *exactly* on the cell edge. Measured: **88 %** of
  interior/exterior boundary transitions sat on the 8 px lattice, against a **52 %**
  control measured on the terrain silhouette itself — which is generated from noise
  and cannot be grid-aligned. A centre-weighted 3×3 average fixes it.
- **Always take that control.** The first version of the alignment test measured
  run length instead, and on real terrain that mostly measures how flat the map is:
  a plateau produces a long constant run legitimately. The control is what proved
  the second metric was measuring the boundary rather than itself.

## A19 — `BACKDROP_MIN_HITS` is 4, and the bound is enforced at every scale

§A18 chose 5 from a table measured on **one medium map**. §A1 sets
`DEFAULT_MAP_SCALE = Large`. Measured independently across four seed/scale
combinations (enclosed air drawn as sky, 44 k–70 k samples each):

| case | 4 | 5 | 6 |
|---|---|---|---|
| medium/4242 | 0.00 % | 0.85 % | 4.43 % |
| medium/12345 | 0.00 % | 0.11 % | 2.00 % |
| small/777 | 0.00 % | 0.02 % | 0.31 % |
| **large/99** | **0.53 %** | **2.85 %** | 7.25 % |

At Large — the scale the game actually ships — 5 gives 2.85 % against §A18's own
2 % bound. **4 passes both bounds at every scale** (worst case 0.53 % enclosed-as-sky,
1.67 % sky-as-backdrop). `BACKDROP_MIN_HITS` is therefore **4**, and §A18's choice
of 5 is superseded.

The tuning error is the interesting part, not the value:

> A threshold measured on one map is tuned to one map. Any constant chosen by
> measurement is measured at **every scale the game can ship**, and the acceptance
> test covers all of them — otherwise the bound is enforced where it does not
> matter and unenforced where it does.

Two consequences that are now rules:

- `BackdropMask` takes `minHits` with **no default**. A default that disagreed with
  the shipped constant is what let the synthetic tests sit at 6 while production ran
  at 5, and at the shipped value two of those tests fail — one of them violating
  §A17's own `EDGE_BAND_PX` proximity bound at 13 px.
- Tests pin to `C().BACKDROP_MIN_HITS`, never to a literal. A test pinned to a value
  the game does not use is testing a build nobody runs.

## A20 — Report damage that was applied, and name the source that caused it

Two defects in `explode`, both latent today and both expensive once M6 wires the
`damage` event (`40-net-protocol.md` §3).

**Report what was applied.** `apply_damage` returns whether the damage landed, and
the return is discarded — a hit is recorded at full value even when the callee
refused it. A player under `SPAWN_IFRAMES` therefore emits a stream of phantom
damage events, and any kill attribution built on that list inherits the error.
Knockback still applying is correct and stays. Also: a player at exactly
`d == radius` currently produces an entry of `(id, 0.0, zero impulse)` — a spurious
event for a no-op, which should not be recorded at all.

**Name the source.** The fallback arm hardcodes
`DamageSource::Weather(EffectKind::MeteorShower)`, so every ownerless explosion is
attributed to a meteor — and an owner passed without a weapon is also swallowed,
losing `SelfInflicted`. Lava and toxic rain both route through `explode`, so
without this every environmental death in the kill feed reads "meteor". `explode`
takes the `DamageSource` from its caller.

## A21 — Interior air has something above it

§A19's *value* is withdrawn. It was measured against a **stale WASM build** — the
client suite had no `pretest` hook, so Rust constant changes were invisible to it
and every backdrop number measured from the client was reading an old binary. That
is fixed (the hook now rebuilds), and it invalidates §A18's and §A19's tables
alike. Re-measure everything from a fresh build.

Re-measured, no `BACKDROP_MIN_HITS` passes both of §A17's bounds at all three
scales. The reason is structural rather than a bad threshold: an exposed **crest**
— a hilltop with sky on three sides — still collects enough side and downward ray
hits to cross the threshold, so it wears a halo of backdrop along its skyline
(measured mean 3.4–6.3 px at the shipped value).

The missing constraint is the one thing every cave, tunnel, chamber and crevice
has and no crest does:

> Interior air must have **rock above it**. At least one of the upward rays must
> strike solid, in addition to the `BACKDROP_MIN_HITS` total.

This is a conjunct, not a replacement — roofedness alone fails on floating islands
(§A17), and enclosure alone fails on crests. Together they are exactly the
statement "you are inside the rock": something over your head, and rock most of the
way around you.

Adopting it: re-measure the table at 4, 5 and 6 **with the conjunct, at all three
scales, against a fresh WASM build**, and take the value that satisfies both bounds.
If none does, take the one whose worse failure is the milder one — enclosed air
showing daylight reads as a hole through the world, sky drawn dark reads as haze
(§A18) — and write the numbers down.

## A22 — Two process defects worth more than the bugs they hid

**The client suite was testing a stale WASM build.** There was no `pretest` hook,
so `game-core` constant changes did not reach the client tests, and every
measurement taken through the client was reading an old binary. `docs/62` §6 says
`predev`/`prebuild` must run `wasm-pack` "so the WASM is never stale" — it did not
say `pretest`, and that gap silently invalidated two rounds of threshold tuning.
Any hook that keeps a build fresh must cover **every** entry point that consumes
it, tests included.

**A screenshot that does not contain its subject is not evidence.** A lava run was
photographed against an empty hillside while three vents erupted off-camera, and it
looked like a clean pass. Where a screenshot is the proof, the assertion is on the
frame containing the thing — point the camera at it, and assert something numeric
about those pixels as well.

## A23 — "Never twice in a row" means never

`13-weather-effects.md` §1 asks for two incompatible things: *"never repeat the
same effect twice in a row"* and *"re-roll once if it comes up again"*. A single
re-roll still repeats with probability `w_i / total` — 9 % per step for the
weight-3 kinds, so over a 1000-effect run a repeat is certain.

The rule that satisfies the intent: **zero the previous kind's weight and draw
once.** Repeats become impossible by construction rather than improbable, and the
draw stays unbiased, because a single draw from the remaining weights *is* the
conditional distribution given "not the last kind". Stationary distribution
0.284 / 0.284 / 0.216 / 0.216 for weights 3/3/2/2, and the test asserts both that
and that those shares are distinguishable from the raw weights — otherwise it
would pass against a plain weighted draw.

## A24 — Make the correct use the only use

Two bugs in M5 were the same bug wearing different clothes, and both were found
after they had already caused a failure once.

`ProjectileSet::step` removes each projectile before returning
`Vec<(ProjectileId, ProjectileOutcome)>`, so the weapon and owner of anything that
exploded are unrecoverable by the time the caller sees the outcome. Every caller
must snapshot `(id → weapon, owner)` first, and nothing in the signature says so.
Two things depend on getting it right: the fragment fork-bomb guard
(`is_fragment(p.weapon)`) and §A20's kill attribution. The trap had already
produced an actual fork bomb in a test harness before anyone noticed the API
invited it.

`Map::carve_capsule` reimplemented `carve_circle`'s entry path and dropped its
deliberate i64 overflow guard — a guard that exists because M1 measured
`cy + dy` silently wrapping in release and carving a crater in an unrelated part
of the map. The sibling function is a fresh opportunity to make the same mistake
the original already fixed.

> An API that requires the caller to preserve state the API is about to destroy
> will eventually be called incorrectly. Return what the caller needs.
>
> A second function that touches the same invariant reimplements the entry path,
> and reimplementing an entry path is how a hard-won guard gets dropped. Share the
> guard, or share the function.

The practical rule for this codebase: anything that writes to the mask goes
through one guarded entry point, and anything that reports an event carries the
identity of what caused it rather than a handle to something already freed.

## A25 — The snapshot is 8 + n·15 + 4 bytes

`40-net-protocol.md` §3's snapshot block is internally inconsistent in two places,
and the field lists are right where the totals are wrong.

**Header.** `u32 tick` + `u16 round_time_ds` + `u8 darkness` + `u8 player_count`
= **8 bytes**. The doc's total says 9.

**Per player.** `u8 id` + `i16 x` + `i16 y` + `i16 vx` + `i16 vy` + `u16 aim` +
`u8 health` + `u8 flags` + `u8 jetpack_fuel` + `u8 selected_item` = **15 bytes**.
The doc's total and `SNAPSHOT_PLAYER_BYTES` say 14.

Reaching 14 means deleting a field the client needs. The velocities exist so the
client can extrapolate through a dropped snapshot (`42-netcode-prediction.md` §4),
and aim is fixed at `u16` by `22-aiming-crosshair.md` §2. Quantising velocity to
`i8` would fit, but buys two bytes per player at the cost of a scale factor and a
rounding rule on the one field whose whole job is smoothness.

So the field lists stand and the totals are corrected:

```
snapshot = 8 + player_count * 15 + 4        (footer: u32 last_input_seq)
```

`SNAPSHOT_PLAYER_BYTES` is **15**, with `SNAPSHOT_HEADER_BYTES` 8 and
`SNAPSHOT_FOOTER_BYTES` 4 beside it, and the size tests pin to the constants
rather than to literals (§A19). Six players is **102 bytes**, so 2.0 KB/s at
20 Hz — unchanged in substance from the doc's 1.9 KB/s estimate and far inside the
bandwidth budget in §4.

## A26 — A position means nothing without its frame of reference

`is_standable(x, y)` asks whether the box whose **bottom edge** is at `y` fits.
`Body::new(pos)` takes a **centre**. `MapMeta.spawn_points` are produced by the
first and were being fed to the second, so a spawned player was buried to the waist
in rock.

The failure is quiet in every way that matters: they spawn *alive*, *grounded*, at a
plausible-looking position, and the only symptom is that they cannot move at all —
every horizontal step already overlaps solid, and step-up cannot clear it. No
assertion about position, health or grounding detects it. Only asking the player to
walk does.

It survived because the convention was implicit: the M4 respawn test had been
compensating by hand with `at.y - PLAYER_H / 2.0`, which is exactly how an unstated
convention gets encoded in one place and got wrong in the next.

> Any function returning a position states its frame of reference in its name or
> its type — `feet`, `centre`, `top_left` — and the two are never interchangeable
> just because both are `Point`.

`choose_respawn` and every spawn-selection path return a **centre**, and say so.
The general test for this class: it is not enough to assert a spawned body is not
overlapping solid; assert it can **walk**.

Related, and the reason this section exists rather than a one-line fix: the same
milestone found a warmup-damage test that passed against a build with no damage
gate at all, because `SPAWN_IFRAMES` refuses damage for the first two seconds
regardless. A test asserting an absence needs a control asserting the presence —
"no damage during warmup" is satisfied by a game that never deals damage.

## A27 — Binary payloads travel base64, not as socket.io attachments

`40-net-protocol.md` §3 specifies `map_init` and `snapshot` as socket.io binary
attachments. On this stack they do not work, and the failure mode is far worse
than a dropped message.

A payload containing `0x1e` — engine.io's packet separator — corrupts the stream
so completely that the client receives **nothing further on that socket, not even
later plain-text events**. It presents as a dead connection rather than a bad
message, which is what made it expensive to find. Isolated, in order:

| payload | result |
|---|---|
| `vec![7u8; 13433]` | arrives fine |
| real map bytes, 13,491 with 48 separator bytes | lost |
| `vec![0x1e; 64]` | loses even the text event sent *before* it |
| same, websocket-only transport | fails identically |

Every generated map contains separator bytes, so this is the normal case, not an
edge case.

Both payloads are therefore **base64 text**. The cost is a third more bytes:
`map_init` ~13 KB → ~18 KB once per round, and a six-player snapshot 102 → 136
bytes, i.e. 2.7 KB/s at 20 Hz. `40-net-protocol.md` §4's budget has room several
times over, and correctness on the one channel that carries the map is worth more
than 34 bytes a snapshot.

The binary framing in §3 stands as the *encoding*; only the transport wrapper
changes. If a future socketioxide release fixes attachment handling, dropping the
base64 layer is a one-line change on each side and the wire format underneath is
unaffected.

## A28 — A flaky gate is worse than a failing one

The join-flow end-to-end test fails about half the time with an empty inbox. It is
`#[ignore]`d with its diagnosis rather than left to gate the build, which is
correct: a gate that fails on a coin flip teaches people to re-run it, and after
that it gates nothing.

That is a holding position, not a resolution. What is already excluded: map
generation blocking a tokio worker, the fixture racing the room, snapshot and
`map_init` interleaving mid-handshake, raw binary attachments (§A27), and two
servers in one process. A notable clue: all seven original tests passed
*individually* and interfered when run together — in parallel **and** under
`--test-threads=1` — which points at process-global state rather than concurrency.

**The test client is not the client that ships.** The product uses
`socket.io-client` 4.x in a browser, which buffers emits until the handshake
completes; the integration tests use `rust_socketio`, which may not. Before
spending another session on the harness, establish which side is actually broken
by driving the real browser client through Playwright against the same server. If
the browser joins reliably a hundred times, the defect is in the test client and
the product is sound — and that is a very different bug from the same symptom in
shipping code.

## A29 — Where the Kenney download URL actually lives

`51-assets.md` §3 says the fetch script should extract "the first `.zip` href from
the HTML". There is no `.zip` href in the page body — the visible Download button
is `<a href='#inline-download' data-lity>`, which opens a donation modal. The real
URL is inside that modal:

```html
<a id='donate-text' href='https://kenney.nl/media/pages/assets/<slug>/<hash>-<ts>/kenney_<slug>.zip'
   onclick='initiateDownload()' data-lity-close>Continue without donating...</a>
```

Two traps, both of which cost probes to find:

- **The page uses single-quoted attributes.** A regex written for `href="..."`
  matches nothing at all and looks exactly like "the site restructured". Match both
  quote styles.
- The path carries a content hash and timestamp, so it must be scraped rather than
  constructed — `51-assets.md` §3 was right about that, and the guessable patterns
  (`/media/pages/assets/<slug>/downloads.zip`, `/data/downloads/<slug>.zip`) both
  404.

Verified reachable, with sizes:

| pack | bytes |
|---|---|
| platformer-characters | 1,433,917 |
| particle-pack | 15,001,764 |
| pixel-platformer | 260,312 |
| ui-pack | 1,229,750 |

The particle pack alone exceeds `51-assets.md` §7's 12 MB total-committed budget, so
take §7's own escape hatch: **`assets/vendor/` is gitignored** and only the built
atlases under `assets/atlas/` are committed. The fetch script stays the reproducible
path back to the raw art, and `assets/vendor/README.md` records each pack's source
URL, licence and fetch date as §8 requires.

The procedural fallback in §5 is **not** thereby optional. It is what makes a fresh
clone run without network access, and it has been carrying the whole project since
M3.

## A30 — One input per player per tick

**This corrects `40-net-protocol.md` §2.**

The world applied *every* queued input for a player in one tick, each with a full
`dt`. `MAX_INPUT_QUEUE` (8) bounds how many are accepted, so a client that simply
sends more packets — with increasing sequence numbers, which is all the validation
checks — moves several times faster. Measured over 60 ticks on a medium map:

| inputs sent per tick | displacement |
|---|---|
| 1 | 140.79 px |
| 2 | 290.80 px (2.06×) |
| 4 | 451.95 px (3.2×, then hit terrain) |

This is server-authoritative movement defeated by the client choosing its own
packet rate, which is the one thing the authority exists to prevent. `docs/40` §2's
"at most `MAX_INPUT_QUEUE` inputs per player per tick are processed" was written as
a flood guard and read as a licence: round time advances by one `dt` per tick
regardless, so the surplus buys distance per unit of *game* time.

> A tick advances each player by exactly **one** input. Surplus inputs go to a
> bounded per-player backlog and are consumed on later ticks.

`MAX_INPUT_QUEUE` then bounds the backlog rather than the per-tick application,
which is also what makes a jitter burst catch up correctly instead of teleporting:
the packets that arrive late are still simulated, just in order and one per tick.
A backlog at its cap drops the oldest and logs at `debug` on `game::net`.

This is load-bearing for `42-netcode-prediction.md`: reconciliation replays pending
inputs one per tick, so the client's replay only matches the server's simulation if
the server consumes them the same way.

## A31 — Buried slots are hidden from an honest client, not from the wire

`32-item-spawning.md` §5 says buried slots "are not sent to clients and there is no
surface hint. Digging is speculative." The first half is true and verified: no slot
coordinate appears in `map_init`, `welcome`, any snapshot, or any event before
reveal.

But `welcome` and `map_init` both carry the round seed, and `game-core` ships to the
browser as WASM — so a modified client recomputes the generator and gets every slot
exactly:

```
server slots: [(1530,1320), (2192,932), (2467,913), (689,964)]
client slots: [(1530,1320), (2192,932), (2467,913), (689,964)]   10 of 10 exact
```

Shipping the generator to the client is what makes prediction work, so the seed
cannot be withheld. The fix is to move the secret out of the seed:

> Buried slot positions and contents derive from `substream(seed ^ buried_secret,
> "buried")`, where `buried_secret` is a `u64` rolled per round on the server and
> **never sent**.

It is recorded in the replay header so a round stays reproducible, and defaults to
`0` in tests so golden tables and the seed sweep are unaffected. Three lines, and it
closes the hole rather than documenting it.

The comparable compromise in `14-daynight-visibility.md` §5 — a modified client can
see players in the dark — stays accepted for v1, because closing it needs
server-side visibility culling rather than a different sub-stream. The difference
worth naming: §5 documents its hole and §32 believed it had none.

## A32 — Enclosure is measured at the scale of a cave

The residual backdrop error accepted in §A19 — about 6 % of open sky drawn as cave
backdrop — was judged tolerable on the `grassland` theme, where the backdrop is
darker than the sky and a misclassified patch reads as shadow. On `frost` the
backdrop is *lighter* than the sky, and the same 6 % renders as large flat
polygons hanging in the air. Nothing changed but the palette; the defect was
always there and was being hidden by a colour choice.

Two corrections, and the first is the real one.

**`BACKDROP_RAY_LEN` 320 → 160.** A ray that reaches 320 px finds terrain from
half a screen away, so air beside and below a floating island's flank collects
enough hits to pass — which is exactly where the residual concentrates. But the
things the test is meant to identify are cave-sized: tunnels bore 30–52 px,
chambers reach 124 px, voids 140–310 px. Enclosure should be sampled at the scale
of the space you are standing in, not at the scale of the screen. Re-measure the
§A19 table at 160 across all three scales and both themes; the expectation is that
sky-as-backdrop falls sharply while enclosed-as-sky barely moves, because a cave
wall is close by definition.

**A theme's backdrop is never lighter than its sky.** `theme.json` gains no new
field — this is a constraint on the values, asserted by a test: the backdrop tint's
luminance must be below `skyBottom`'s by a stated margin, for every theme. Then a
residual misclassification degrades into shadow rather than into a hole in the
world, on every theme, permanently.

The lesson is the one worth keeping:

> An error rate signed off on one theme was signed off on one *palette*. A defect
> that is invisible because of a colour choice is not fixed, and the next colour
> choice will reveal it.

Same shape as §A19 (a threshold tuned on one map at a scale the game does not
ship) and §A22 (a measurement taken against a stale build). Every one of these was
a number that looked settled because the conditions it was measured under were
narrower than the conditions it would ship under.

### A32 — corrected

**Change 1 (`BACKDROP_RAY_LEN` 320 → 160) is withdrawn**, and its stated premise
was false. Measured before changing, across three scales
(enclosed-as-sky % / sky-as-backdrop %):

| scale | 160 | 240 | 320 |
|---|---|---|---|
| small/777 | 5.63 / 0.90 | 0.43 / 7.16 | 0.00 / 16.42 |
| medium/4242 | 13.70 / 0.46 | 4.58 / 2.42 | 1.42 / 5.86 |
| large/99 | 10.85 / 0.11 | 5.35 / 2.75 | 2.49 / 7.18 |

It is a clean monotonic trade, not a free win: shortening the ray does cut
sky-as-backdrop, but raises enclosed-as-sky **5–10×** — making the failure §A18
ranked *worse* dramatically worse. "A cave wall is close by definition" holds for
tunnels at 30–52 px bore, but the dominant features are voids 140–310 px across,
and the middle of one is beyond a 160 px ray. **320 stays.**

**The observation that prompted this section was also wrong, and it was mine.**
Frost's backdrop is not lighter than its sky. Sampled from the frame:

| | rgb | lum |
|---|---|---|
| "light polygon in the sky" | `100,104,132` | 106 |
| clear sky, same row | `100,104,132` | **106, identical** |
| other "polygon" | `117,113,133` | 116 |
| terrain fill near the player | `104,118,136` | **116, identical** |
| actual backdrop | `27,33,41` | 32 |

Two populations, sky and terrain. The backdrop is dark and nowhere near either.
The angular shapes are **island silhouettes**, and I misread the frame.

**Change 2 stands and is the useful half.** Every theme's backdrop must be darker
than its daytime sky by more than 30 lum, asserted across the whole theme table so
it holds for themes added later. Measured margins: grassland 171, desert 140,
frost 142. Falsified — a bright frost backdrop fails the test.

**What the measurement did find**, and it is a real defect of a different kind:
frost's terrain (116) and frost's sky (106) are within 10 lum of each other, so the
land barely reads against the sky. That is a **contrast** problem in the palette,
not a classification problem in the mask. `frost`'s `fill` and `skyBottom` want
separating — and the same assertion shape as change 2 applies: **terrain fill must
differ from the daytime sky by a stated margin, per theme.**

The correction is worth more than the amendment was. A defect reported from a
screenshot read by eye sent a builder to re-measure a subsystem that was working,
and only measuring the pixels settled it. Report what you sampled, not what you saw.

## A33 — A replay is about 1.2 MB, not "a few hundred KB"

`61-logging-debug.md` §4 estimates a 4-minute six-player replay at "a few hundred
KB". The arithmetic omits both the player count and the input rate:

```
240 s x 60 Hz x 6 players = 86,400 accepted inputs
86,400 x 14 bytes         = 1.21 MB
```

Delta-encoding the tick brings it to 0.95 MB, and the `Input` payload alone is
0.60 MB, so no framing change reaches the doc's figure. The estimate was wrong by
roughly 4×, and it is the kind of wrong that only surfaces when someone records a
full round rather than a test fixture.

The bound is **2 MB**, with a **500 KB floor** so the test also fails if recording
silently stops — an upper bound alone is satisfied by writing nothing. The
arithmetic goes in the test, so the next person who changes the input format sees
why the number is what it is.

Nothing else about replays changes. `61-logging-debug.md` §4's claim that they are
small enough to attach to a bug report still holds at 1.2 MB.

## A34 — A hash is only worth what it covers

`state_hash` is the footer of every replay and the whole basis of the determinism
guarantee in `60-testing.md` §4. Its doc comment claimed it covered "every mutable
piece of simulation state". It hashed the mask, the tick, round time and player
positions.

Probed by leaking `SystemTime` into `world.wind` on every tick — deliberately
making the simulation nondeterministic — the replay verified **green**.

Unhashed: wind, `carve_seq`, phase, every timer (shield, i-frames, respawn,
cooldown), jetpack and jump state, aim, inventories, buried items, the effect
scheduler, the spawn schedule, and every RNG stream position. The best regression
test in the project was certifying the parts nobody was worried about.

Two rules come out of it:

> A subsystem hashes **itself**, via a `hash_into` next to its private fields.
> A hash written from outside covers what the author happened to remember.

> **RNG streams are hashed by cloning and drawing.** Two schedulers with identical
> visible fields but different draw counts are not equivalent, and the difference
> is invisible to any structural comparison.

The test that would have caught it is the probe itself: deliberately introduce
nondeterminism and require the verifier to go red. That belongs in the suite
permanently, because a hash silently narrowing again is exactly as undetectable as
this was.

Related, same milestone, same shape: **SIGTERM never wrote the replay footer.**
`main` returned as soon as axum stopped, so the room task was never scheduled again
— the `docker compose down` path `41-server-loop-rooms.md` §7 exists for. Every
unit test passed, because they call `finish_recording()` directly. And the control
for the fix had to be a **subprocess** `SIGKILL`: in-process, the room is scheduled
the instant the oneshot fires, so a "don't wait" control writes the footer anyway
and proves nothing.

## A35 — Screen space is not world space with the scrolling switched off

Third instance of the §A16 class on this project: a quantity correct in world units
and wrong relative to what is on screen.

The game-feel layer computed correct values — trauma 0.79, one damage number,
vignette 0.11, health 100 → 75 — and drew **nothing**. A Phaser object with
`setScrollFactor(0)` still has the camera's **zoom** applied, so at
`CAMERA_ZOOM = 2` every screen-space element landed off-viewport.

The two earlier instances were the same mistake in different clothes: §A16, where
every FoV radius covered twice the screen fraction it was designed for; and §A26,
where a feet line was fed to something expecting a centre. In all three the
arithmetic was right and the frame of reference was unstated.

> Anything positioned in **screen space** is rendered by something that does not
> inherit the world camera's zoom — a dedicated UI camera at zoom 1, or the DOM.
> `scrollFactor(0)` alone is not screen space; it is world space that does not
> scroll.

This codebase already had the answer and it was missed: the HUD strip and
scoreboard are DOM, where world → screen is just `(x - scrollX) * zoom` with no
engine quirk. Phaser's own idiom is a second camera that renders only UI objects,
with `cameras.main.ignore(ui)` and `uiCam.ignore(world)`.

Either is acceptable. What is **not** acceptable is verifying a screen-space
element at zoom 1: it works at zoom 1 by construction, and this game does not run
at zoom 1. Every screen-space element is verified by screenshot **at
`CAMERA_ZOOM`**.

And the meta-lesson, from a probe that failed to converge: when two candidate
mappings both produce nothing, the model is wrong and guessing a third will not
help. Go and find what already works in the codebase.

## A36 — `ping_rtt`, and the number that was a constant

`42-netcode-prediction.md` §7 says RTT "is measured from socket.io's own
ping/pong". That measurement is not reachable from the application layer in this
client, so `ClockSync` was fed `addSample(..., 0)` — it had the whole estimator and
nothing ever supplied a sample. The debug HUD's headline number was a hardcoded
zero, and it looked like a working readout.

`40-net-protocol.md` §2 gains one message pair:

| direction | event | payload |
|---|---|---|
| client → server | `ping_rtt` | `{ id: u32 }` |
| server → client | `pong_rtt` | `{ id: u32 }` |

The client stamps a send time per `id`, echoes are matched on it, and the round
trip feeds `ClockSync`. Sent at 1 Hz — RTT changes far more slowly than anything
else on the wire, and the debug HUD is the only consumer. Reads 9.8–14.0 ms on
loopback.

`42-netcode-prediction.md` §7's design is unchanged: an exponentially-weighted mean
that rejects samples more than 3σ out. It just has an input now.

The general point is the one §A15 already made and this repeats in a new place:
**a readout that cannot fail is not a readout.** A zero RTT is indistinguishable
from a perfect connection, which is exactly what it looked like.

## A37 — Backdrop is bounded by distance to rock

Sampled from the finished M9 frame (`shots/m9-grassland-day.png`), hard-edged dark
rectangles hang in open sky near the bottom of the viewport:

| sample | rgb |
|---|---|
| rectangle in the sky | `35,29,24` |
| island underside (cave backdrop) | `35,29,24` — identical |
| terrain fill | `91,77,61` |
| clear sky | `108,167,225` |

That is the ~6 % sky-as-backdrop residual §A19 accepted, and §A32 argued it would
"degrade into shadow" on a dark-backdrop theme. It does not. A hard-edged dark
rectangle in open sky reads as a rendering glitch, not as shade.

The enclosure test alone cannot fix it, and three rounds have now proved that:
`BACKDROP_MIN_HITS` = 4 of 8 is a low bar, and air a couple of hundred pixels below
a floating island collects an upward hit from the island plus enough side hits from
whatever is off-screen to pass — the exact "under a floating island" case §A17's own
table promised would read as sky.

The missing constraint is not about direction at all. It is about **distance**:

> The cave backdrop exists to fill holes **in** the rock. An air pixel further than
> `BACKDROP_MAX_DIST_TO_SOLID` from any solid pixel is sky, unconditionally,
> whatever the enclosure test says.

| Name | Value | Notes |
|---|---|---|
| `BACKDROP_MAX_DIST_TO_SOLID` | 160 | world px, to the nearest solid pixel |

This is a conjunct on top of §A17's enclosure and §A21's roofedness, and it is
sound by construction for every case the earlier rounds struggled with:

| case | nearest rock | verdict |
|---|---|---|
| tunnel (bore 30–52) | ≤ 26 px | interior ✓ |
| chamber (to 124 across) | ≤ 62 px | interior ✓ |
| void (to 310 across) | ≤ 155 px | interior ✓ |
| crevice | ≤ 18 px | interior ✓ |
| air 200 px under an island | > 160 px | **sky ✓** |
| open sky | far | sky ✓ |

A void at `VOID_RADIUS_MAX` is the binding case at 155 px, which is why the bound
is 160 and not lower — it is set from the widest hole the generator can produce,
not from taste.

Implementation: a distance transform over the **coarse grid** (already maintained
exactly by every carve), bilinearly interpolated and thresholded at pixel
resolution, exactly as §A17 does for the hit count — so the boundary follows the
rock rather than the 8 px lattice.

**Measure it the way §A19 requires**: all three scales, all three themes, from a
fresh WASM build, reporting enclosed-air-drawn-as-sky and open-sky-drawn-as-backdrop
for each. If the residual does not fall well below 1 %, the hypothesis is wrong —
say so with the numbers rather than tuning the constant.
