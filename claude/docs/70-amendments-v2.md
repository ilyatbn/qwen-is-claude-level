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

Unchanged, except:

- Each cluster stamps 3–6 circles where **at least half share the same centre `y`
  (±8 px)**, so the island reads as a plateau with a flat-ish walkable top rather
  than a lumpy ball.
- The chosen centres are returned (`Vec<Point>`) — pass 3b needs them.

### Pass 3b — Bridges

Floating islands you cannot reach on foot are scenery. Bridges make them a route.

| Name | Value |
|---|---|
| `BRIDGE_THICKNESS` | 7 |
| `BRIDGE_MIN_SPAN` | 90 |
| `BRIDGE_MAX_SPAN` | 460 |
| `BRIDGE_SAG` | 18 |

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
| `ENTRANCE_RADIUS` | 13 |
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
| `CREVICE_WIDTH_MIN` | 7 |
| `CREVICE_WIDTH_MAX` | 17 |
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
