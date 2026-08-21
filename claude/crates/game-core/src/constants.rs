//! Every tunable number in the game.
//!
//! This file mirrors `docs/02-constants.md` row for row, plus the v2 section at the
//! bottom mirroring `docs/70-amendments-v2.md`. Same names, same values, same units.
//! Nothing else in the codebase may declare a magic number.
//!
//! Units: distances are pixels, times are seconds, speeds px/s, accelerations px/s²,
//! angles radians unless stated.

// ---------------------------------------------------------------------------
// World and map
// ---------------------------------------------------------------------------

pub const MAP_SMALL_W: u32 = 2048;
pub const MAP_SMALL_H: u32 = 1024;
pub const MAP_MEDIUM_W: u32 = 3072;
pub const MAP_MEDIUM_H: u32 = 1536;
pub const MAP_LARGE_W: u32 = 4096;
pub const MAP_LARGE_H: u32 = 2048;

/// Render / dirty granularity. All map sizes are multiples of this.
pub const CHUNK_SIZE: u32 = 256;
/// Coarse occupancy cell edge, in px.
pub const COARSE_CELL: u32 = 8;
/// Indestructible band at the bottom.
pub const BEDROCK_H: u32 = 24;
/// Indestructible band on the left and right edges.
pub const WALL_W: u32 = 8;
/// Guaranteed-empty band at the top (crates fall through it).
pub const SKY_MARGIN: u32 = 96;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

pub const SIM_HZ: u32 = 60;
pub const SIM_DT: f32 = 1.0 / SIM_HZ as f32;
pub const SNAPSHOT_HZ: u32 = 20;
/// Movement is split so no step exceeds this — makes tunnelling impossible.
pub const MAX_SUBSTEP_PX: f32 = 1.0;
/// Safety cap per body per tick.
pub const MAX_SUBSTEPS: u32 = 64;

// ---------------------------------------------------------------------------
// Player body
// ---------------------------------------------------------------------------

pub const PLAYER_W: f32 = 16.0;
pub const PLAYER_H: f32 = 28.0;
/// Max height climbed by walking into it.
pub const STEP_UP: i32 = 6;
/// Ground snap distance when walking down a slope.
pub const STEP_DOWN: i32 = 8;
/// Headroom required for a surface point to count as spawnable.
pub const HEAD_CLEARANCE: i32 = 32;

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

pub const GRAVITY: f32 = 1400.0;
pub const MAX_FALL_SPEED: f32 = 900.0;
pub const WALK_SPEED: f32 = 150.0;
pub const WALK_ACCEL: f32 = 1200.0;
pub const GROUND_FRICTION: f32 = 1600.0;
pub const AIR_ACCEL_FACTOR: f32 = 0.55;
pub const AIR_DRAG: f32 = 120.0;
/// Apex ≈ 66 px ≈ 2.3 × player height.
pub const JUMP_VELOCITY: f32 = 430.0;
/// Added to horizontal speed if a direction is held at takeoff.
pub const JUMP_H_BOOST: f32 = 60.0;
pub const COYOTE_TIME: f32 = 0.10;
pub const JUMP_BUFFER: f32 = 0.12;

// ---------------------------------------------------------------------------
// Jetpack
// ---------------------------------------------------------------------------

pub const JETPACK_MAX_FUEL: f32 = 5.0;
pub const JETPACK_DRAIN: f32 = 1.0;
pub const JETPACK_REFILL: f32 = 0.5;
pub const JETPACK_REFILL_DELAY: f32 = 0.5;
pub const JETPACK_MIN_FUEL_TO_ENGAGE: f32 = 0.3;
pub const JETPACK_THRUST_UP: f32 = 2200.0;
pub const JETPACK_THRUST_SIDE: f32 = 1100.0;
pub const JETPACK_THRUST_DOWN: f32 = 900.0;
pub const JETPACK_MAX_SPEED: f32 = 260.0;
pub const JETPACK_GRAVITY_SCALE: f32 = 0.35;
pub const JETPACK_HOLD_DELAY: f32 = 0.18;

// ---------------------------------------------------------------------------
// Aiming
// ---------------------------------------------------------------------------

pub const AIM_RADIUS: f32 = 48.0;
pub const AIM_DEADZONE: f32 = 8.0;

// ---------------------------------------------------------------------------
// Health, shield, respawn
// ---------------------------------------------------------------------------

pub const BASE_HEALTH: f32 = 100.0;
pub const HEALTH_CAP: f32 = 150.0;
/// Health/s decayed while above `BASE_HEALTH`.
pub const OVERHEAL_DECAY: f32 = 2.0;
pub const MEDKIT_HEAL: f32 = 50.0;
pub const SHIELD_DURATION: f32 = 20.0;
pub const SHIELD_DAMAGE_MULT: f32 = 0.5;
/// §B4 raised this from 3.0. It is a **felt** number and the one constant in
/// this file most likely to want playtesting: five seconds of watching the fight
/// continue is a long time, and the overlay deliberately does not pause the
/// round behind it.
pub const RESPAWN_DELAY: f32 = 5.0;
pub const SPAWN_IFRAMES: f32 = 2.0;
pub const SPAWN_MIN_ENEMY_DIST: f32 = 384.0;
/// Speed multiplier at 0 health, lerped to 1.0 at `BASE_HEALTH`.
pub const HEALTH_SPEED_MIN: f32 = 0.75;
/// Impulse (px/s) at an explosion epicentre.
pub const KNOCKBACK_MAX: f32 = 320.0;

// ---------------------------------------------------------------------------
// Field of view and light
// ---------------------------------------------------------------------------

/// Corrected for CAMERA_ZOOM 2.0 — see docs/70 §A16.
pub const FOV_DAY: f32 = 320.0;
pub const FOV_NIGHT: f32 = 110.0;
pub const FOV_FOG_MULT: f32 = 0.45;
pub const FOV_HEALTH_MIN_MULT: f32 = 0.80;
/// Fraction of the radius used for the gradient falloff.
pub const FOV_EDGE_SOFTNESS: f32 = 0.35;
pub const FLASHLIGHT_RANGE: f32 = 260.0;
pub const FLASHLIGHT_CONE_DEG: f32 = 55.0;
pub const FLASHLIGHT_AMBIENT_MULT: f32 = 0.65;
pub const NIGHT_DARKNESS: f32 = 0.82;
pub const DAY_DARKNESS: f32 = 0.0;

// ---------------------------------------------------------------------------
// Day/night cycle
// ---------------------------------------------------------------------------

pub const DAY_DURATION: f32 = 60.0;
pub const NIGHT_DURATION: f32 = 60.0;
/// Dusk and dawn ramp, inside the durations above.
pub const CYCLE_TRANSITION: f32 = 8.0;

// ---------------------------------------------------------------------------
// Round
// ---------------------------------------------------------------------------

pub const MAX_PLAYERS: usize = 6;
pub const WARMUP_SECONDS: f32 = 10.0;
pub const ROUND_SECONDS: f32 = 240.0;
pub const ENDED_SECONDS: f32 = 20.0;
pub const KILL_POINTS: i16 = 1;
/// Applies to self-kills and deaths to weather too.
pub const DEATH_POINTS: i16 = -1;
/// 1 for development; raise later.
pub const MIN_PLAYERS_TO_START: usize = 1;
/// Seconds a seated socket may go without sending `ready` before its seat is
/// swept (`room::sweep_unready`).
///
/// `docs/40-net-protocol.md` §1 states this in prose ("dropped after 30 s") and
/// not as a table row, so it is here for the same reason as the §A7 constants:
/// a number that lives only in a sentence cannot be checked against the code.
pub const READY_TIMEOUT_SECS: f32 = 30.0;

/// Broadcast events held for a socket between `map_init` being sent and `ready`
/// arriving (`docs/70-amendments-v2.md` §A40).
///
/// A client cannot be sent carves until it has a mask to apply them to, but the
/// carves that land in that window must not be *dropped*: they carry a monotonic
/// `seq` the client applies in order, so a hole in the sequence costs a full map
/// resync two seconds later. They are queued instead, and flushed in order once
/// the map is on the wire.
///
/// Bounded because a client that never sends `ready` holds its seat for
/// `READY_TIMEOUT_SECS`, and a busy round produces hundreds of carves. On
/// overflow the queue is dropped and the socket is sent a fresh `map_init`
/// instead — which is the same full resync the gap would have caused, taken
/// deliberately rather than two seconds late.
pub const JOIN_EVENT_QUEUE_MAX: usize = 4096;

// ---------------------------------------------------------------------------
// Map generation
// ---------------------------------------------------------------------------

/// Regenerations with `seed+n` before falling back to the safe preset.
pub const MAX_GEN_ATTEMPTS: u8 = 12;
/// Of all surface points, the fraction that must be in one **strongly connected**
/// component — points that can reach each other *both* ways. See `docs/70` §A10.
pub const MIN_TRAVERSABLE_FRACTION: f32 = 0.75;
/// Solid components smaller than this are deleted.
pub const MIN_BLOB_PX: u32 = 400;
/// Air pockets smaller than this are filled.
pub const MIN_POCKET_PX: u32 = 250;
/// Spacing of surface graph nodes.
pub const SURFACE_SAMPLE_STEP: i32 = 16;
pub const SPAWN_MIN_SEPARATION: f32 = 256.0;
pub const SPAWN_COUNT_MIN: usize = 6;

pub const NOISE_OCTAVES: u32 = 5;
pub const NOISE_LACUNARITY: f32 = 2.0;
pub const NOISE_GAIN: f32 = 0.5;
/// Frequency at octave 0, in 1/px.
pub const NOISE_BASE_SCALE: f32 = 0.006;
/// Domain warp displacement in px.
pub const WARP_STRENGTH: f32 = 48.0;
/// fBm value above which a pixel is solid, before the gradient bias.
pub const SOLID_THRESHOLD: f32 = 0.52;
/// Added to the field at y = 0 (pushes toward empty).
pub const GRADIENT_BIAS_TOP: f32 = -0.35;
/// Added at y = height (pushes toward solid).
pub const GRADIENT_BIAS_BOTTOM: f32 = 0.40;

pub const CA_ITERATIONS: u32 = 3;
/// Solid neighbours (of 8) needed to become solid.
pub const CA_BIRTH: u32 = 5;
/// Solid neighbours needed to stay solid.
pub const CA_SURVIVE: u32 = 4;

pub const BLOB_RADIUS_MIN: i32 = 40;
pub const BLOB_RADIUS_MAX: i32 = 130;
pub const TUNNEL_RADIUS_MIN: i32 = 17;
pub const TUNNEL_RADIUS_MAX: i32 = 26;
/// Random-walk step length.
pub const TUNNEL_STEP: i32 = 8;
pub const TUNNEL_LENGTH_MIN: i32 = 240;
pub const TUNNEL_LENGTH_MAX: i32 = 900;
/// Max heading change per step, radians.
pub const TUNNEL_TURN_MAX: f32 = 0.35;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

pub const INVENTORY_SLOTS: usize = 8;
/// Per slot, same item id.
pub const MAX_STACK: u8 = 9;
/// From player centre to pickup centre.
pub const PICKUP_RADIUS: f32 = 20.0;
pub const ITEM_SPAWN_INTERVAL: f32 = 20.0;
pub const ITEM_SPAWN_BATCH_MIN: u32 = 1;
pub const ITEM_SPAWN_BATCH_MAX: u32 = 2;
pub const CRATE_INTERVAL: f32 = 35.0;
pub const CRATE_W: f32 = 24.0;
pub const CRATE_H: f32 = 24.0;
/// Horizontal drag while falling.
pub const CRATE_DRAG: f32 = 0.02;
/// Hard cap; oldest un-picked item despawns first.
pub const MAX_WORLD_ITEMS: usize = 40;
/// Seconds before an untouched ground item despawns.
pub const WORLD_ITEM_TTL: f32 = 90.0;

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

pub const BAZOOKA_DAMAGE: f32 = 45.0;
pub const BAZOOKA_BLAST_RADIUS: f32 = 42.0;
pub const BAZOOKA_MUZZLE_SPEED: f32 = 620.0;
pub const BAZOOKA_COOLDOWN: f32 = 0.9;
pub const BAZOOKA_AMMO: u8 = 4;
pub const BAZOOKA_GRAVITY_SCALE: f32 = 1.0;
pub const BAZOOKA_WIND_SCALE: f32 = 1.0;

pub const GRENADE_DAMAGE: f32 = 40.0;
pub const GRENADE_BLAST_RADIUS: f32 = 36.0;
pub const GRENADE_MUZZLE_SPEED: f32 = 480.0;
pub const GRENADE_COOLDOWN: f32 = 0.9;
pub const GRENADE_AMMO: u8 = 3;
pub const GRENADE_FUSE: f32 = 3.0;
pub const GRENADE_RESTITUTION: f32 = 0.45;
pub const GRENADE_FRICTION: f32 = 0.75;
pub const GRENADE_GRAVITY_SCALE: f32 = 1.0;
pub const GRENADE_WIND_SCALE: f32 = 0.5;
/// Below this speed, a grenade resting on ground stops instead of jittering.
pub const GRENADE_REST_SPEED: f32 = 30.0;

pub const SMG_DAMAGE: f32 = 8.0;
/// Also the carve radius — sustained fire genuinely tunnels.
pub const SMG_BLAST_RADIUS: f32 = 3.0;
pub const SMG_RANGE: f32 = 700.0;
pub const SMG_COOLDOWN: f32 = 0.10;
pub const SMG_AMMO: u8 = 60;
pub const SMG_SPREAD: f32 = 0.03;
/// Rays per trigger pull. `docs/70-amendments-v2.md` §A7.
pub const SMG_SHOTS: u8 = 1;
pub const SMG_GRAVITY_SCALE: f32 = 0.0;
pub const SMG_WIND_SCALE: f32 = 0.0;

// --- Energy weapons (§B5, §B7) -------------------------------------------
// Their ammo is the battery, so they carry an `energy_cost` rather than an
// ammo count. The defs live in T11.02 with the resource they spend, because
// §B5's mechanic cannot be tested without one; T11.04 adds the registry items,
// the sprites and the tracer styling.
pub const LASER_PISTOL_DAMAGE: f32 = 22.0;
pub const LASER_PISTOL_BLAST_RADIUS: f32 = 4.0;
pub const LASER_PISTOL_RANGE: f32 = 900.0;
pub const LASER_PISTOL_COOLDOWN: f32 = 0.35;
pub const LASER_PISTOL_SPREAD: f32 = 0.0;
pub const LASER_PISTOL_ENERGY: f32 = 6.0;

pub const LASER_SMG_DAMAGE: f32 = 9.0;
pub const LASER_SMG_BLAST_RADIUS: f32 = 2.0;
pub const LASER_SMG_RANGE: f32 = 1000.0;
pub const LASER_SMG_COOLDOWN: f32 = 0.08;
pub const LASER_SMG_SPREAD: f32 = 0.02;
pub const LASER_SMG_ENERGY: f32 = 2.0;

/// Projectiles spawn this far along the aim direction, so you do not shoot yourself.
pub const MUZZLE_OFFSET: f32 = 18.0;
/// You take full damage from your own explosives.
pub const SELF_DAMAGE_MULT: f32 = 1.0;
/// Despawn guard.
pub const PROJECTILE_MAX_LIFETIME: f32 = 8.0;
/// px/s² lateral, re-rolled each round.
pub const WIND_MAX: f32 = 90.0;
/// Between shots unless the weapon overrides it.
pub const FIRE_COOLDOWN_DEFAULT: f32 = 0.35;
/// A projectile cannot hit its owner for this many ticks after spawning.
pub const PROJECTILE_OWNER_GRACE_TICKS: u32 = 3;

// ---------------------------------------------------------------------------
// Weather effects
// ---------------------------------------------------------------------------

pub const EFFECT_INTERVAL_MIN: f32 = 30.0;
pub const EFFECT_INTERVAL_MAX: f32 = 45.0;
/// Warning before an effect activates.
pub const EFFECT_TELEGRAPH: f32 = 3.0;

pub const TOXIC_DURATION: f32 = 8.0;
pub const TOXIC_PUDDLE_EVERY: f32 = 0.4;
pub const TOXIC_PUDDLE_RADIUS: f32 = 40.0;
pub const TOXIC_PUDDLE_LIFE: f32 = 3.0;
pub const TOXIC_DPS: f32 = 6.0;

pub const METEOR_DURATION: f32 = 10.0;
pub const METEOR_EVERY: f32 = 0.5;
/// Initial downward speed.
pub const METEOR_SPEED: f32 = 700.0;
pub const METEOR_CARVE_R: f32 = 50.0;
pub const METEOR_DAMAGE: f32 = 55.0;
/// Per impact.
pub const METEOR_FRAGMENTS: u32 = 6;
pub const METEOR_FRAG_SPEED_MIN: f32 = 320.0;
pub const METEOR_FRAG_SPEED_MAX: f32 = 520.0;
pub const METEOR_FRAG_CARVE_R: f32 = 14.0;
pub const METEOR_FRAG_DAMAGE: f32 = 18.0;

pub const LAVA_VENTS_MIN: u32 = 3;
pub const LAVA_VENTS_MAX: u32 = 6;
/// Carved when a vent opens.
pub const LAVA_CHANNEL_R: f32 = 24.0;
pub const LAVA_JET_DURATION: f32 = 3.0;
pub const LAVA_JET_DPS: f32 = 10.0;
/// Ground fire left behind.
pub const LAVA_BURN_DURATION: f32 = 3.0;
pub const LAVA_BURN_DPS: f32 = 8.0;
pub const LAVA_BURN_RADIUS: f32 = 28.0;

pub const FOG_DURATION: f32 = 15.0;
/// Fade in and out.
pub const FOG_RAMP: f32 = 2.0;

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/// Render remote players this far in the past.
pub const INTERP_DELAY_MS: f32 = 100.0;
/// Resend the last N inputs each packet.
pub const INPUT_REDUNDANCY: usize = 3;
/// Position error above which the client re-simulates.
pub const RECONCILE_EPSILON_PX: f32 = 2.0;
/// Seconds between server mask hashes.
pub const MASK_CHECKSUM_INTERVAL: f32 = 5.0;
/// Bytes per player in a snapshot.
///
/// **15, not the 14 in `docs/02-constants.md` and `docs/40-net-protocol.md` §3.**
/// The doc's own field list is
/// `u8 id, i16 x, i16 y, i16 vx, i16 vy, u16 aim, u8 health, u8 flags,
///  u8 jetpack_fuel, u8 selected_item`
/// which sums to 1+2+2+2+2+2+1+1+1+1 = **15**. The same block has a second slip:
/// its header list (`u32 tick, u16 round_time_ds, u8 darkness, u8 player_count`)
/// sums to **8** while the stated total uses 9.
///
/// The field lists are authoritative because they are complete and typed; the
/// totals are arithmetic. Hitting 14 would mean dropping a field the client needs
/// — velocities are required for extrapolation through a dropped snapshot
/// (`docs/42` §4), and aim is fixed at `u16` by `docs/22` §2.
///
/// A snapshot is therefore `8 + 15n + 4`: **102 bytes for six players**, against
/// the doc's 97. At 20 Hz that is 2.0 KB/s down rather than 1.9 — well inside the
/// budget in `docs/40` §4.
pub const SNAPSHOT_PLAYER_BYTES: usize = 15;
/// Header bytes before the player array: tick, round_time_ds, darkness, count.
pub const SNAPSHOT_HEADER_BYTES: usize = 8;
/// Trailing `last_input_seq`.
pub const SNAPSHOT_FOOTER_BYTES: usize = 4;
/// Per player per tick; excess is dropped and logged.
pub const MAX_INPUT_QUEUE: usize = 8;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// Design resolution; scales to fit.
pub const VIEWPORT_W: u32 = 1280;
pub const VIEWPORT_H: u32 = 720;
/// Chunks re-baked per frame, to avoid hitches.
pub const CHUNK_REBAKE_BUDGET: u32 = 4;
/// Thickness of the grass/edge highlight on terrain.
pub const EDGE_BAND_PX: i32 = 5;
/// Background scroll rate relative to camera.
pub const PARALLAX_FACTOR: f32 = 0.35;
/// Camera follow smoothing.
pub const CAMERA_LERP: f32 = 0.12;

// ===========================================================================
// ---- v2 amendments ----  mirrors docs/70-amendments-v2.md
// ===========================================================================

// --- A1: a bigger world, a closer camera ---

/// The map you get unless `MAP_SCALE` says otherwise.
pub const DEFAULT_MAP_SCALE: MapScale = MapScale::Large;
/// Phaser camera zoom. Visible world = VIEWPORT / this.
pub const CAMERA_ZOOM: f32 = 2.0;
/// The camera does not move while the player is inside this box.
pub const CAMERA_DEADZONE_W: f32 = 120.0;
pub const CAMERA_DEADZONE_H: f32 = 90.0;
/// px of aim-direction lead added to the follow target.
pub const CAMERA_LOOKAHEAD: f32 = 70.0;
pub const CAMERA_LOOKAHEAD_LERP: f32 = 0.06;

// --- A2: map generation v2 ---

pub const BRIDGE_THICKNESS: i32 = 14;
/// A bridge may rise or fall by at most this fraction of its horizontal span.
/// Without it, islands at wildly different heights get joined by a near-vertical
/// thread that is neither walkable nor recognisable as a bridge.
pub const BRIDGE_MAX_SLOPE: f32 = 0.45;
pub const BRIDGE_MIN_SPAN: i32 = 90;
pub const BRIDGE_MAX_SPAN: i32 = 460;
pub const BRIDGE_SAG: i32 = 18;

pub const CHAMBER_RADIUS_MIN: i32 = 26;
pub const CHAMBER_RADIUS_MAX: i32 = 62;
pub const CHAMBER_MIN_SEPARATION: i32 = 220;
pub const CAVE_ENTRANCES_MIN: u32 = 2;
pub const CAVE_ENTRANCES_MAX: u32 = 4;
pub const ENTRANCE_RADIUS: i32 = 17;
/// Extra loop edges as a fraction of chamber count.
pub const CAVE_EXTRA_EDGE_FRACTION: f32 = 0.5;

pub const CREVICE_WIDTH_MIN: i32 = 12;
pub const CREVICE_WIDTH_MAX: i32 = 36;
pub const CREVICE_DEPTH_MIN: i32 = 90;
pub const CREVICE_DEPTH_MAX: i32 = 430;
/// Max heading change per step, radians, around straight down.
pub const CREVICE_WANDER: f32 = 0.16;
pub const CREVICE_STEP: i32 = 6;

pub const VOID_RADIUS_MIN: i32 = 70;
pub const VOID_RADIUS_MAX: i32 = 155;
pub const VOID_MIN_SEPARATION: i32 = 260;

// --- A10: traversability is mutual ---

/// The furthest a player can climb in one unbroken effort:
/// `JETPACK_MAX_SPEED * JETPACK_MAX_FUEL * 0.6`. Falling is free; climbing is not,
/// which is why traversal edges are directed.
pub const JETPACK_CLIMB_BUDGET: f32 = JETPACK_MAX_SPEED * JETPACK_MAX_FUEL * 0.6;
/// A climb longer than this is only possible if it passes a standable surface point
/// on the way — that is where you land and refuel.
pub const LEDGE_REFUEL_RISE: f32 = JETPACK_CLIMB_BUDGET;

// --- A12: buried slots (moved out of map/gen/meta.rs) ---

/// Solid rock required in every direction for a slot to be genuinely buried rather
/// than just under the skin. Sampled along the whole ray, not at the endpoint.
pub const BURIED_CLEARANCE: i32 = 24;
pub const BURIED_SEPARATION: i32 = 128;
/// How far off a tunnel or pocket a candidate slot is placed.
pub const BURIED_OFFSET_MIN: i32 = 30;
pub const BURIED_OFFSET_MAX: i32 = 80;
/// Placement attempts per slot before giving up on that one.
pub const BURIED_ATTEMPTS: u32 = 200;

// --- A17: the cave backdrop is an enclosure test ---

/// Rays cast from an air sample, evenly spaced from 0 rad.
pub const BACKDROP_RAYS: u32 = 8;
/// How far a ray looks for rock, in world px.
pub const BACKDROP_RAY_LEN: f32 = 320.0;
/// Rays that must strike solid for the sample to count as enclosed.
///
/// **4, with `BACKDROP_MIN_UP` as a conjunct (§A21).** §A18's 5 and §A19's 4 were
/// both measured against a stale WASM build and are withdrawn.
///
/// Re-measured from a fresh build at every scale (enclosed-air-drawn-as-sky /
/// open-sky-drawn-as-backdrop / mean backdrop halo above an exposed crest):
///
/// | hits/up | small/777 | medium/4242 | large/99 |
/// |---|---|---|---|
/// | 4 / 0.5 | 0.00 / 16.42 / 3.3 | 1.42 / 5.86 / 4.7 | 2.49 / 7.18 / 3.9 |
/// | 4 / 1.0 | 0.01 / 14.97 / 0.7 | 2.76 / 5.41 / 1.8 | 3.65 / 6.84 / 1.4 |
/// | 5 / 1.0 | 0.02 / 9.20 / 0.7 | 2.78 / 2.36 / 1.3 | 4.74 / 2.43 / 0.9 |
/// | 6 / any | 0.31 / 2.69 / 0.3 | 4.43 / 0.73 / 0.5 | 7.25 / 0.47 / 0.5 |
///
/// No configuration satisfies both of §A17's bounds (2 % / 3 %) at all three
/// scales, so this takes the milder failure per §A21: enclosed air showing
/// daylight reads as a hole through the world, sky drawn dark reads as haze.
/// 4/0.5 has the lowest worst-case enclosed-as-sky of any row (2.49 %) and keeps
/// the halo inside `EDGE_BAND_PX`.
///
/// The residual sky-as-backdrop is concentrated at **small** scale, and is air
/// beside and below a floating island's flank — reached by a diagonal upward ray
/// while the column overhead is clear. Drawing that slightly dark is defensible;
/// it is the same "under the eave" geometry the conjunct is meant to catch.
pub const BACKDROP_MIN_HITS: u32 = 4;
/// Upward ray hits required in addition to the total (§A21).
///
/// Interior air has rock above it. Without this an exposed crest collects enough
/// side and downward hits to cross any workable total and wears a backdrop halo
/// along its skyline — 30.2 px mean at `BACKDROP_MIN_HITS` 4, cut to 3.3 px by
/// this one term. Roofedness alone is not sufficient either (§A17: air under a
/// floating island is roofed and is plainly sky), which is why it is a conjunct.
///
/// Fractional because the ray-count field is blurred before thresholding.
pub const BACKDROP_MIN_UP: f32 = 0.5;
/// Air further than this from the nearest solid pixel is sky, whatever the
/// enclosure and roofedness tests say (§A37).
///
/// The cave backdrop exists to fill holes **in** the rock, so the bound is set by
/// the widest hole the generator can make: a void at `VOID_RADIUS_MAX` (155) puts
/// its centre 155 px from a wall. Lowering it starts drawing void centres as sky,
/// the failure §A18 ranked worst.
///
/// **This does not move the aggregate residual**, and §A37 predicted that it
/// would. Measured, the sky-as-backdrop share barely shifts (small 16.42 % →
/// 16.42 %, medium 5.86 % → 5.23 %, large 7.18 % → 6.66 %) because most false
/// positives sit 45–160 px from rock, overlapping genuinely enclosed air. What it
/// does remove is the far tail — the large contiguous regions hanging clear of any
/// terrain, which are the ones that read as rectangles in the sky rather than as
/// shadow. It costs 0.11–0.13 points of enclosed-as-sky, which is why it is worth
/// keeping despite the aggregate.
pub const BACKDROP_MAX_DIST_TO_SOLID: f32 = 160.0;

// --- A3: visible ordnance ---

/// Seconds a tracer segment stays visible.
pub const TRACER_LIFETIME: f32 = 0.09;
/// px, at zoom 1.
pub const TRACER_WIDTH: f32 = 2.0;
pub const PROJECTILE_TRAIL_LEN: usize = 12;

// --- A4: sky, sun and moon ---

/// One full day. `u = (round_time / CYCLE_LENGTH) mod 1`.
pub const CYCLE_LENGTH: f32 = DAY_DURATION + NIGHT_DURATION;
pub const SUN_RADIUS: f32 = 34.0;
pub const MOON_RADIUS: f32 = 26.0;
pub const SKY_BODY_ARC_H: f32 = 300.0;
pub const SKY_BODY_PARALLAX: f32 = 0.08;
pub const STAR_COUNT: u32 = 220;
/// `u` at which stars begin to appear.
pub const STAR_FADE_START: f32 = 0.58;

// --- A5: bots ---

pub const BOT_COUNT_DEFAULT: usize = 3;
pub const BOT_SKILL_DEFAULT: f32 = 0.6;

// --- A6: minimap ---

pub const MINIMAP_W: u32 = 200;
pub const MINIMAP_H: u32 = 100;
pub const MINIMAP_ALPHA: f32 = 0.75;
/// World px revealed around the player each tick.
pub const MINIMAP_REVEAL_R: f32 = 260.0;

// ---- v3 amendments ----  mirrors docs/71-amendments-v3.md

// --- B1: multiple concurrent rooms ---

/// Measured, T10.07. **Tick cost is not what bounds this.**
///
/// §B2 asked for the room count at which tick p99 crosses half the 16.67 ms
/// budget. It never crosses: on 16 logical cores, release build, medium scale,
/// 6 firing bots per room and 45 s of warm-up so the terrain is genuinely chewed
/// up, p99 is flat from 1 room to 128 —
///
/// | rooms | p50 ms | p99 ms | max ms |
/// |---|---|---|---|
/// | 1 | 0.002 | 0.004 | 0.009 |
/// | 8 | 0.002 | 0.009 | 0.051 |
/// | 32 | 0.002 | 0.008 | 0.541 |
/// | 128 | 0.003 | 0.010 | 0.518 |
///
/// At 128 rooms the p99 uses **0.12 %** of half a tick budget, and per-room cost
/// is flat (8 rooms cost 1.01x per room versus 1). Control drift 1.5 %, so the
/// box was idle and these are numbers about the code (§A38).
///
/// So the cap comes from what *is* bounded, with the sim measured well clear:
/// terrain is 648 KiB per room at medium and ~1.2 MiB at large, and **room
/// creation** — not ticking — is the expensive operation at roughly 0.6 s
/// (medium) to 1.1 s (large) of map generation, which is why it runs off the
/// tokio workers. 32 rooms is ~38 MiB of terrain at large scale and leaves a 4x
/// margin below the highest count actually measured.
///
/// **Not measured:** the socket layer at that scale (32 rooms is up to 192
/// concurrent clients), and memory under real load rather than by arithmetic.
/// If either turns out to bind first, this is the number to lower.
pub const MAX_ROOMS: usize = 32;
/// Seconds after the last **human** leaves before the room is dropped. Bots do
/// not keep a room alive.
pub const ROOM_EMPTY_TTL: f32 = 30.0;
pub const JOIN_CODE_LEN: usize = 6;
/// No `I`, `1`, `O` or `0` — people read these aloud. It **does** contain `L`,
/// which is why nothing folds `L` to `1`: doing so made roughly one code in six
/// unreachable.
pub const JOIN_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// §B10: there is no quick-match queue, so `QUEUE_WAIT_BEFORE_BOTS` is gone.
// Filling the fullest room with space, MIN_PLAYERS_TO_START = 1, and a human
// kicking the newest bot already give the queue's outcome with no waiting state
// to be stuck in.

// --- B4: death and the respawn timer ---
// RESPAWN_DELAY moved to 5.0 by §B4; it lives with the other player constants.

// --- B5: the battery ---

pub const BATTERY_MAX: f32 = 100.0;
pub const BATTERY_PACK_AMOUNT: f32 = 50.0;
/// Battery per second while a shield is up. The shield ends early at zero, so
/// every laser shot is a shield you are not going to have.
pub const SHIELD_DRAIN: f32 = 2.0;
/// Energy weapons pierce: this replaces `SHIELD_DAMAGE_MULT` for them.
pub const LASER_SHIELD_MULT: f32 = 0.85;
/// Drained from the victim on an energy hit, which cuts a shield's life directly.
pub const LASER_BATTERY_DRAIN: f32 = 8.0;

// --- B7: the arsenal ---

pub const AIRBURST_PELLETS: u32 = 9;
/// Radians, downward.
pub const AIRBURST_FAN: f32 = 0.9;
pub const FOV_SMOKE_MULT: f32 = 0.35;
pub const SMOKE_RADIUS: f32 = 110.0;
pub const SMOKE_DURATION: f32 = 8.0;
pub const MINE_ARM_TIME: f32 = 1.0;
pub const MINE_TRIGGER_RADIUS: f32 = 36.0;
pub const MINE_LIFETIME: f32 = 90.0;

// --- B8: tombstones ---

pub const TOMBSTONE_W: f32 = 14.0;
pub const TOMBSTONE_H: f32 = 18.0;
pub const MAX_TOMBSTONES: usize = 32;

// ---------------------------------------------------------------------------
// Map scale and its per-scale parameter table
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum MapScale {
    Small,
    Medium,
    Large,
}

/// Everything the generator reads off the scale. The `v2` fields come from
/// `docs/70-amendments-v2.md` §A2.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct ScaleParams {
    pub width: u32,
    pub height: u32,
    pub blob_count: u32,
    pub cave_tunnels: u32,
    pub buried_slots: u32,
    pub initial_items: u32,
    // v2
    pub cave_chambers: u32,
    pub crevice_count: u32,
    pub void_count: u32,
    pub bridge_count: u32,
}

impl MapScale {
    pub const fn params(self) -> ScaleParams {
        match self {
            MapScale::Small => ScaleParams {
                width: MAP_SMALL_W,
                height: MAP_SMALL_H,
                blob_count: 6, // v2: was 4
                cave_tunnels: 6,
                buried_slots: 6,
                initial_items: 8,
                cave_chambers: 3,
                crevice_count: 4,
                void_count: 3,
                bridge_count: 2,
            },
            MapScale::Medium => ScaleParams {
                width: MAP_MEDIUM_W,
                height: MAP_MEDIUM_H,
                blob_count: 10, // v2: was 7
                cave_tunnels: 10,
                buried_slots: 10,
                initial_items: 14,
                cave_chambers: 5,
                crevice_count: 7,
                void_count: 5,
                bridge_count: 4,
            },
            MapScale::Large => ScaleParams {
                width: MAP_LARGE_W,
                height: MAP_LARGE_H,
                blob_count: 15, // v2: was 11
                cave_tunnels: 16,
                buried_slots: 16,
                initial_items: 20,
                cave_chambers: 8,
                crevice_count: 10,
                void_count: 8,
                bridge_count: 6,
            },
        }
    }

    /// Parse the `MAP_SCALE` environment value. Returns `None` for anything else,
    /// so the caller can fail loudly with the bad value.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "small" => Some(MapScale::Small),
            "medium" => Some(MapScale::Medium),
            "large" => Some(MapScale::Large),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            MapScale::Small => "small",
            MapScale::Medium => "medium",
            MapScale::Large => "large",
        }
    }

    /// Wire encoding: 0 small, 1 medium, 2 large (`docs/40-net-protocol.md`).
    pub const fn as_u8(self) -> u8 {
        match self {
            MapScale::Small => 0,
            MapScale::Medium => 1,
            MapScale::Large => 2,
        }
    }

    pub const fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(MapScale::Small),
            1 => Some(MapScale::Medium),
            2 => Some(MapScale::Large),
            _ => None,
        }
    }

    pub const ALL: [MapScale; 3] = [MapScale::Small, MapScale::Medium, MapScale::Large];
}

#[cfg(test)]
// Every assertion in this module is deliberately over compile-time constants —
// checking the relationships between them is the entire purpose of the file.
#[allow(clippy::assertions_on_constants)]
mod tests {
    use super::*;

    #[test]
    fn sim_dt_matches_sim_hz() {
        assert!((SIM_DT * SIM_HZ as f32 - 1.0).abs() < 1e-6);
    }

    #[test]
    fn snapshots_land_on_whole_ticks() {
        assert_eq!(SIM_HZ % SNAPSHOT_HZ, 0);
        assert_eq!(SIM_HZ / SNAPSHOT_HZ, 3);
    }

    #[test]
    fn every_map_size_is_a_multiple_of_chunk_size() {
        for scale in MapScale::ALL {
            let p = scale.params();
            assert_eq!(p.width % CHUNK_SIZE, 0, "{scale:?} width");
            assert_eq!(p.height % CHUNK_SIZE, 0, "{scale:?} height");
        }
    }

    #[test]
    fn map_rows_start_on_a_word_boundary() {
        // The Mask packs 64 bits per word with no per-row padding, so a row must
        // start on a word boundary for row slicing and RLE to stay simple.
        for scale in MapScale::ALL {
            assert_eq!(scale.params().width % 64, 0, "{scale:?}");
        }
    }

    #[test]
    fn jetpack_obeys_the_two_to_one_refill_rule() {
        // 5 s of thrust costs 10 s of refill.
        assert!((JETPACK_MAX_FUEL * JETPACK_DRAIN / JETPACK_REFILL - 10.0).abs() < 1e-6);
    }

    #[test]
    fn overheal_ceiling_is_above_base_health() {
        assert!(HEALTH_CAP > BASE_HEALTH);
        // Overheal decays from the cap to base in exactly 25 s.
        assert!(((HEALTH_CAP - BASE_HEALTH) / OVERHEAL_DECAY - 25.0).abs() < 1e-6);
    }

    #[test]
    fn effect_interval_is_a_valid_range() {
        assert!(EFFECT_INTERVAL_MIN < EFFECT_INTERVAL_MAX);
        assert!(METEOR_FRAG_SPEED_MIN < METEOR_FRAG_SPEED_MAX);
        assert!(LAVA_VENTS_MIN < LAVA_VENTS_MAX);
        assert!(ITEM_SPAWN_BATCH_MIN <= ITEM_SPAWN_BATCH_MAX);
        assert!(BLOB_RADIUS_MIN < BLOB_RADIUS_MAX);
        assert!(TUNNEL_RADIUS_MIN < TUNNEL_RADIUS_MAX);
        assert!(TUNNEL_LENGTH_MIN < TUNNEL_LENGTH_MAX);
        assert!(CHAMBER_RADIUS_MIN < CHAMBER_RADIUS_MAX);
        assert!(CREVICE_WIDTH_MIN < CREVICE_WIDTH_MAX);
        assert!(CREVICE_DEPTH_MIN < CREVICE_DEPTH_MAX);
        assert!(VOID_RADIUS_MIN < VOID_RADIUS_MAX);
        assert!(BRIDGE_MIN_SPAN < BRIDGE_MAX_SPAN);
        assert!(CAVE_ENTRANCES_MIN < CAVE_ENTRANCES_MAX);
    }

    #[test]
    fn traversable_fraction_is_a_fraction() {
        assert!(MIN_TRAVERSABLE_FRACTION > 0.0 && MIN_TRAVERSABLE_FRACTION <= 1.0);
    }

    #[test]
    fn cycle_length_covers_a_day_and_a_night() {
        assert!((CYCLE_LENGTH - (DAY_DURATION + NIGHT_DURATION)).abs() < 1e-6);
        // A 240 s round contains exactly two full cycles.
        assert!((ROUND_SECONDS / CYCLE_LENGTH - 2.0).abs() < 1e-6);
        // The transition fits inside each phase with room to spare.
        assert!(CYCLE_TRANSITION < DAY_DURATION);
    }

    #[test]
    fn bedrock_and_sky_fit_inside_the_smallest_map() {
        let p = MapScale::Small.params();
        assert!(BEDROCK_H + SKY_MARGIN < p.height);
        assert!(WALL_W * 2 < p.width);
    }

    #[test]
    fn scale_parses_and_round_trips() {
        for scale in MapScale::ALL {
            assert_eq!(MapScale::parse(scale.as_str()), Some(scale));
            assert_eq!(MapScale::from_u8(scale.as_u8()), Some(scale));
        }
        assert_eq!(MapScale::parse("MEDIUM"), Some(MapScale::Medium));
        assert_eq!(MapScale::parse("huge"), None);
        assert_eq!(MapScale::from_u8(3), None);
    }

    #[test]
    fn v2_raises_the_island_count_at_every_scale() {
        // The v2 amendment makes floating islands a headline feature.
        assert_eq!(MapScale::Small.params().blob_count, 6);
        assert_eq!(MapScale::Medium.params().blob_count, 10);
        assert_eq!(MapScale::Large.params().blob_count, 15);
    }

    #[test]
    fn zoomed_viewport_is_smaller_than_the_smallest_map() {
        // The whole point of A1: you never see the whole map at once.
        let visible_w = VIEWPORT_W as f32 / CAMERA_ZOOM;
        let visible_h = VIEWPORT_H as f32 / CAMERA_ZOOM;
        let p = MapScale::Small.params();
        assert!(visible_w < p.width as f32);
        assert!(visible_h < p.height as f32);
    }

    /// Margin over the binding body dimension, for pixels the CA nibbles off the
    /// walls of a freshly carved passage.
    const BORE_MARGIN: f32 = 2.0;

    #[test]
    fn horizontal_bores_are_sized_against_player_height() {
        // A HORIZONTAL tunnel's clear bore is its diameter, and the player is
        // PLAYER_H (28) tall — NOT PLAYER_W. Asserting against PLAYER_W is what let
        // a 20 px bore ship: 20 >= 16 passes while the player does not fit.
        // See docs/70-amendments-v2.md §A9.
        assert!(
            (TUNNEL_RADIUS_MIN * 2) as f32 >= PLAYER_H + BORE_MARGIN,
            "TUNNEL_RADIUS_MIN bore {} must clear PLAYER_H {PLAYER_H} + {BORE_MARGIN}",
            TUNNEL_RADIUS_MIN * 2
        );
        assert!(
            (ENTRANCE_RADIUS * 2) as f32 >= PLAYER_H + BORE_MARGIN,
            "ENTRANCE_RADIUS bore {} must clear PLAYER_H {PLAYER_H} + {BORE_MARGIN} \
             (entrance shafts wander, so they are horizontal in places)",
            ENTRANCE_RADIUS * 2
        );
        assert!(
            (CHAMBER_RADIUS_MIN * 2) as f32 >= PLAYER_H + BORE_MARGIN,
            "CHAMBER_RADIUS_MIN bore {} must clear PLAYER_H {PLAYER_H} + {BORE_MARGIN}",
            CHAMBER_RADIUS_MIN * 2
        );
    }

    #[test]
    fn a_circular_bore_admits_the_box_across_its_full_width() {
        // Sharper than the diameter rule. The bore is a CIRCLE, so at the box's
        // left and right edges — PLAYER_W/2 off the centre line — the vertical
        // clearance is only 2*sqrt(r^2 - (PLAYER_W/2)^2), not 2r. At r=15 that is
        // 25.4 px and a 28-tall body does not fit, even though the diameter is 30.
        //
        // Swept tunnels are capsules and do give the full 2r along their length, so
        // r=16 happens to measure 100% chamber reachability — but single circles at
        // bends and junctions bind, and a guarantee that holds by luck is not one.
        let half_w = PLAYER_W / 2.0;
        for (name, r) in [
            ("TUNNEL_RADIUS_MIN", TUNNEL_RADIUS_MIN),
            ("ENTRANCE_RADIUS", ENTRANCE_RADIUS),
            ("CHAMBER_RADIUS_MIN", CHAMBER_RADIUS_MIN),
        ] {
            let edge_clearance = 2.0 * ((r * r) as f32 - half_w * half_w).sqrt();
            assert!(
                edge_clearance >= PLAYER_H + BORE_MARGIN,
                "{name} = {r}: clearance at the box edge is {edge_clearance:.1} px, \
                 which must reach PLAYER_H {PLAYER_H} + {BORE_MARGIN}"
            );
        }
    }

    #[test]
    fn vertical_bores_are_sized_against_player_width() {
        // A crevice is VERTICAL, so its binding dimension is PLAYER_W (16). The
        // width tapers to 60% at the bottom, and that tapered width is what must
        // still admit the player for a crevice to be a way down.
        const TAPER: f32 = 0.6;
        assert!(
            CREVICE_WIDTH_MAX as f32 * TAPER >= PLAYER_W + BORE_MARGIN,
            "the widest crevice tapers to {} which must clear PLAYER_W {PLAYER_W} + {BORE_MARGIN}",
            CREVICE_WIDTH_MAX as f32 * TAPER
        );
        // The narrow end is deliberately impassable: a crack that lets light and
        // grenades through is wanted, so this asserts the MIX exists rather than
        // that every crevice is an entrance.
        assert!(
            (CREVICE_WIDTH_MIN as f32) < PLAYER_W,
            "the narrowest crevice should stay a crack, not a doorway"
        );
    }

    #[test]
    fn jump_apex_matches_the_documented_height() {
        // docs/20-player-movement.md §4 claims ~66 px.
        let apex = JUMP_VELOCITY * JUMP_VELOCITY / (2.0 * GRAVITY);
        assert!((apex - 66.0).abs() < 1.0, "apex was {apex}");
    }
}
