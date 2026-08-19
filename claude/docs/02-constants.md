# 02 — Constants

**This file is the single source of truth for every tunable number in the game.**

`crates/game-core/src/constants.rs` mirrors it exactly, one `pub const` per row,
same name, same value, same unit. Nothing else in the codebase may declare a
magic number. If a task needs a number that is not here, that is a spec gap —
stop and report it rather than inventing a value.

Units: distances are **pixels**, times are **seconds**, speeds are **px/s**,
accelerations are **px/s²**, angles are **radians** unless stated.

---

## World and map

| Name | Value | Notes |
|---|---|---|
| `MAP_SMALL` | 2048 × 1024 | fast encounters |
| `MAP_MEDIUM` | 3072 × 1536 | default |
| `MAP_LARGE` | 4096 × 2048 | slow, exploratory |
| `CHUNK_SIZE` | 256 | render/dirty granularity; all map sizes are multiples |
| `COARSE_CELL` | 8 | coarse occupancy cell edge, in px |
| `BEDROCK_H` | 24 | indestructible band at the bottom |
| `WALL_W` | 8 | indestructible band on left and right edges |
| `SKY_MARGIN` | 96 | guaranteed-empty band at the top (crates fall through it) |

## Simulation

| Name | Value | Notes |
|---|---|---|
| `SIM_HZ` | 60 | fixed timestep |
| `SIM_DT` | 1/60 | derived |
| `SNAPSHOT_HZ` | 20 | every 3rd tick |
| `MAX_SUBSTEP_PX` | 1.0 | movement is split so no step exceeds this — makes tunnelling impossible |
| `MAX_SUBSTEPS` | 64 | safety cap per body per tick |

## Player body

| Name | Value | Notes |
|---|---|---|
| `PLAYER_W` | 16 | AABB width |
| `PLAYER_H` | 28 | AABB height |
| `STEP_UP` | 6 | max height climbed by walking into it |
| `STEP_DOWN` | 8 | ground snap distance when walking down a slope |
| `HEAD_CLEARANCE` | 32 | headroom required for a surface point to count as spawnable |

## Movement

| Name | Value | Notes |
|---|---|---|
| `GRAVITY` | 1400 | |
| `MAX_FALL_SPEED` | 900 | terminal velocity |
| `WALK_SPEED` | 150 | base max horizontal speed on ground |
| `WALK_ACCEL` | 1200 | |
| `GROUND_FRICTION` | 1600 | decel when no input on ground |
| `AIR_ACCEL_FACTOR` | 0.55 | air accel = `WALK_ACCEL * this` |
| `AIR_DRAG` | 120 | decel when no input in air |
| `JUMP_VELOCITY` | 430 | apex ≈ 66 px ≈ 2.3 × player height |
| `JUMP_H_BOOST` | 60 | added to horizontal speed if a direction is held at takeoff |
| `COYOTE_TIME` | 0.10 | grace period to jump after leaving ground |
| `JUMP_BUFFER` | 0.12 | grace period for a jump pressed just before landing |

## Jetpack

| Name | Value | Notes |
|---|---|---|
| `JETPACK_MAX_FUEL` | 5.0 | seconds of continuous thrust |
| `JETPACK_DRAIN` | 1.0 | fuel per second while thrusting |
| `JETPACK_REFILL` | 0.5 | fuel per second while idle → 2 s to refill 1 s of use |
| `JETPACK_REFILL_DELAY` | 0.5 | idle time before refill starts |
| `JETPACK_MIN_FUEL_TO_ENGAGE` | 0.3 | prevents stutter-thrust at empty |
| `JETPACK_THRUST_UP` | 2200 | |
| `JETPACK_THRUST_SIDE` | 1100 | |
| `JETPACK_THRUST_DOWN` | 900 | |
| `JETPACK_MAX_SPEED` | 260 | speed clamp while thrusting |
| `JETPACK_GRAVITY_SCALE` | 0.35 | gravity multiplier while thrusting |
| `JETPACK_HOLD_DELAY` | 0.18 | hold time after a jump before the jetpack engages |

## Aiming

| Name | Value | Notes |
|---|---|---|
| `AIM_RADIUS` | 48 | crosshair ring radius around the player |
| `AIM_DEADZONE` | 8 | mouse closer than this keeps the previous angle |

## Health, shield, respawn

| Name | Value | Notes |
|---|---|---|
| `BASE_HEALTH` | 100 | |
| `HEALTH_CAP` | 150 | overheal ceiling |
| `OVERHEAL_DECAY` | 2.0 | health/s decayed while above `BASE_HEALTH` |
| `MEDKIT_HEAL` | 50 | |
| `SHIELD_DURATION` | 20.0 | |
| `SHIELD_DAMAGE_MULT` | 0.5 | incoming damage multiplier while shielded |
| `RESPAWN_DELAY` | 3.0 | |
| `SPAWN_IFRAMES` | 2.0 | invulnerable window after respawn |
| `SPAWN_MIN_ENEMY_DIST` | 384 | preferred distance from living players when picking a respawn |
| `HEALTH_SPEED_MIN` | 0.75 | speed multiplier at 0 health, lerped to 1.0 at `BASE_HEALTH` |
| `KNOCKBACK_MAX` | 320 | impulse (px/s) at an explosion epicentre |

## Field of view and light

| Name | Value | Notes |
|---|---|---|
| `FOV_DAY` | 640 | visible radius in daylight, clear weather, full health |
| `FOV_NIGHT` | 220 | visible radius at full night without a flashlight |
| `FOV_FOG_MULT` | 0.45 | multiplier while heavy fog is active |
| `FOV_HEALTH_MIN_MULT` | 0.80 | multiplier at 0 health, lerped to 1.0 at `BASE_HEALTH` |
| `FOV_EDGE_SOFTNESS` | 0.35 | fraction of the radius used for the gradient falloff |
| `FLASHLIGHT_RANGE` | 520 | |
| `FLASHLIGHT_CONE_DEG` | 55 | full cone angle |
| `FLASHLIGHT_AMBIENT_MULT` | 0.65 | your non-cone FoV shrinks by this while the light is on |
| `NIGHT_DARKNESS` | 0.82 | overlay alpha at full night |
| `DAY_DARKNESS` | 0.0 | |

## Day/night cycle

| Name | Value | Notes |
|---|---|---|
| `DAY_DURATION` | 60.0 | |
| `NIGHT_DURATION` | 60.0 | |
| `CYCLE_TRANSITION` | 8.0 | dusk and dawn ramp, inside the durations above |

## Round

| Name | Value | Notes |
|---|---|---|
| `MAX_PLAYERS` | 6 | |
| `WARMUP_SECONDS` | 10 | |
| `ROUND_SECONDS` | 240 | |
| `ENDED_SECONDS` | 20 | vote window |
| `KILL_POINTS` | +1 | |
| `DEATH_POINTS` | −1 | applies to self-kills and deaths to weather too |
| `MIN_PLAYERS_TO_START` | 1 | 1 for development; raise later |

## Map generation

| Name | Value | Notes |
|---|---|---|
| `MAX_GEN_ATTEMPTS` | 12 | regenerations with `seed+n` before falling back to the safe preset |
| `MIN_TRAVERSABLE_FRACTION` | 0.75 | of all surface points must be in one connected component |
| `MIN_BLOB_PX` | 400 | solid components smaller than this are deleted |
| `MIN_POCKET_PX` | 250 | air pockets smaller than this are filled |
| `SURFACE_SAMPLE_STEP` | 16 | spacing of surface graph nodes |
| `SPAWN_MIN_SEPARATION` | 256 | between chosen spawn points |
| `SPAWN_COUNT_MIN` | 6 | must find at least this many valid spawns |
| `NOISE_OCTAVES` | 5 | fBm octaves for the silhouette |
| `NOISE_LACUNARITY` | 2.0 | |
| `NOISE_GAIN` | 0.5 | |
| `NOISE_BASE_SCALE` | 0.006 | frequency at octave 0, in 1/px |
| `WARP_STRENGTH` | 48.0 | domain warp displacement in px |
| `SOLID_THRESHOLD` | 0.52 | fBm value above which a pixel is solid, before the gradient bias |
| `GRADIENT_BIAS_TOP` | −0.35 | added to the field at y = 0 (pushes toward empty) |
| `GRADIENT_BIAS_BOTTOM` | +0.40 | added at y = height (pushes toward solid) |
| `CA_ITERATIONS` | 3 | cellular-automata smoothing passes |
| `CA_BIRTH` | 5 | solid neighbours (of 8) needed to become solid |
| `CA_SURVIVE` | 4 | solid neighbours needed to stay solid |

### Per-scale generation parameters

| Scale | `BLOB_COUNT` | `CAVE_TUNNELS` | `BURIED_SLOTS` | `INITIAL_ITEMS` |
|---|---|---|---|---|
| Small | 4 | 6 | 6 | 8 |
| Medium | 7 | 10 | 10 | 14 |
| Large | 11 | 16 | 16 | 20 |

| Name | Value | Notes |
|---|---|---|
| `BLOB_RADIUS_MIN` | 40 | |
| `BLOB_RADIUS_MAX` | 130 | |
| `TUNNEL_RADIUS_MIN` | 10 | |
| `TUNNEL_RADIUS_MAX` | 22 | |
| `TUNNEL_STEP` | 8 | random-walk step length |
| `TUNNEL_LENGTH_MIN` | 240 | |
| `TUNNEL_LENGTH_MAX` | 900 | |
| `TUNNEL_TURN_MAX` | 0.35 | max heading change per step, radians |

## Items

| Name | Value | Notes |
|---|---|---|
| `INVENTORY_SLOTS` | 8 | |
| `MAX_STACK` | 9 | per slot, same item id |
| `PICKUP_RADIUS` | 20 | from player centre to pickup centre |
| `ITEM_SPAWN_INTERVAL` | 20.0 | periodic ground spawns |
| `ITEM_SPAWN_BATCH` | 1..=2 | inclusive random count per interval |
| `CRATE_INTERVAL` | 35.0 | supply drop cadence |
| `CRATE_W` | 24 | crate AABB |
| `CRATE_H` | 24 | |
| `CRATE_DRAG` | 0.02 | horizontal drag while falling |
| `MAX_WORLD_ITEMS` | 40 | hard cap; oldest un-picked item despawns first |
| `WORLD_ITEM_TTL` | 90.0 | seconds before an untouched ground item despawns |

## Weapons

| Weapon | Kind | Damage | Blast radius | Ammo per pickup | Other |
|---|---|---|---|---|---|
| `bazooka` | projectile | 45 | 42 | 4 | muzzle 620 px/s, full gravity, wind-affected |
| `grenade` | projectile | 40 | 36 | 3 | 3.0 s fuse, restitution 0.45, friction 0.75 |
| `smg` | hitscan | 8 / shot | 3 (dig) | 60 | 10 shots/s, range 700, spread 0.03 rad |

| Name | Value | Notes |
|---|---|---|
| `MUZZLE_OFFSET` | 18 | projectiles spawn this far along the aim direction, so you do not shoot yourself |
| `EXPLOSION_FALLOFF` | linear | `dmg * (1 − dist/radius)`, clamped at 0 |
| `SELF_DAMAGE_MULT` | 1.0 | you take full damage from your own explosives |
| `PROJECTILE_MAX_LIFETIME` | 8.0 | despawn guard |
| `WIND_MAX` | 90 | px/s² lateral, re-rolled each round |
| `FIRE_COOLDOWN_DEFAULT` | 0.35 | between shots unless the weapon overrides it |

## Weather effects

| Name | Value | Notes |
|---|---|---|
| `EFFECT_INTERVAL_MIN` | 30.0 | |
| `EFFECT_INTERVAL_MAX` | 45.0 | |
| `EFFECT_TELEGRAPH` | 3.0 | warning before an effect activates |
| `TOXIC_DURATION` | 8.0 | |
| `TOXIC_PUDDLE_EVERY` | 0.4 | |
| `TOXIC_PUDDLE_RADIUS` | 40 | |
| `TOXIC_PUDDLE_LIFE` | 3.0 | |
| `TOXIC_DPS` | 6.0 | |
| `METEOR_DURATION` | 10.0 | |
| `METEOR_EVERY` | 0.5 | |
| `METEOR_SPEED` | 700 | initial downward speed |
| `METEOR_CARVE_R` | 50 | |
| `METEOR_DAMAGE` | 55 | |
| `METEOR_FRAGMENTS` | 6 | per impact |
| `METEOR_FRAG_SPEED` | 320..=520 | |
| `METEOR_FRAG_CARVE_R` | 14 | |
| `METEOR_FRAG_DAMAGE` | 18 | |
| `LAVA_VENTS_MIN` | 3 | |
| `LAVA_VENTS_MAX` | 6 | |
| `LAVA_CHANNEL_R` | 24 | carved when a vent opens |
| `LAVA_JET_DURATION` | 3.0 | |
| `LAVA_JET_DPS` | 10.0 | |
| `LAVA_BURN_DURATION` | 3.0 | ground fire left behind |
| `LAVA_BURN_DPS` | 8.0 | |
| `LAVA_BURN_RADIUS` | 28 | |
| `FOG_DURATION` | 15.0 | |
| `FOG_RAMP` | 2.0 | fade in and out |

## Networking

| Name | Value | Notes |
|---|---|---|
| `INTERP_DELAY_MS` | 100 | render remote players this far in the past |
| `INPUT_REDUNDANCY` | 3 | resend the last N inputs each packet |
| `RECONCILE_EPSILON_PX` | 2.0 | position error above which the client re-simulates |
| `MASK_CHECKSUM_INTERVAL` | 5.0 | seconds between server mask hashes |
| `SNAPSHOT_PLAYER_BYTES` | 14 | see `40-net-protocol.md` |
| `MAX_INPUT_QUEUE` | 8 | per player per tick; excess is dropped and logged |

## Rendering

| Name | Value | Notes |
|---|---|---|
| `VIEWPORT_W` | 1280 | design resolution; scales to fit |
| `VIEWPORT_H` | 720 | |
| `CHUNK_REBAKE_BUDGET` | 4 | chunks re-baked per frame, to avoid hitches |
| `EDGE_BAND_PX` | 5 | thickness of the grass/edge highlight on terrain |
| `PARALLAX_FACTOR` | 0.35 | background scroll rate relative to camera |
| `CAMERA_LERP` | 0.12 | camera follow smoothing |

## Future work

Values in this file are first-pass and expected to move during playtesting. When
they do, change them here **and** in `constants.rs` in the same commit — a task
that finds them out of sync should report it rather than picking a side.
