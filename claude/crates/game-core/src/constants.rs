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
/// Indestructible band at the bottom. **Zero (§C15).**
///
/// It was 24. The bottom of the map was a wall you bumped into, and every
/// "dig down" plan ended against it. §C15 removes it: the floor is now
/// `FLOOR_CRUST`, which is ordinary destructible rock, and below the map is void.
///
/// **Kept, at zero, rather than deleted.** Two different questions read this
/// number and only one of them changed:
///
/// - *"How far down does the generator lay solid rock?"* — that is `FLOOR_CRUST`,
///   and every generation pass now asks it.
/// - *"What is the lowest row `carve_circle` may touch?"* — that is this, and the
///   answer is now "all of them". `carve_circle` still computes
///   `h - BEDROCK_H`, so the clamp keeps its name and its shape and a future band
///   at the bottom is one constant away. Inlining `h` there would have deleted
///   the seam along with the value.
///
/// What keeps a dug-through map playable is `TELEPORT_PADS` (§C5): six
/// indestructible platforms that `carve_circle` skips whatever this is. The
/// walls (`WALL_W`) are unchanged — §A1's hard limits on x still hold.
pub const BEDROCK_H: u32 = 0;
/// The destructible floor the generator lays at the bottom of every map (§C15).
///
/// Sixteen rather than the old 24: it is now something you dig through rather
/// than something you stand on forever, and a thinner crust makes that a decision
/// a player can actually reach inside a round.
///
/// Everything downstream of generation that used to mean "the top of the solid
/// floor" reads this — the borders, the smoothing guard, the v2 ground profile,
/// the cave and blob keep-outs. `borders_hold` still asserts it is fully solid on
/// a freshly generated map; nothing asserts it is still there later, because the
/// whole point is that it need not be.
pub const FLOOR_CRUST: u32 = 16;
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
/// How long after being thrown a player may still fire, despite moving (§C20).
///
/// §C20 refuses a shot while you are moving under your **own** power and says
/// plainly that "being knocked around does not stop you firing — a player thrown
/// by a blast must still be able to shoot, or knockback becomes a stun". Those
/// two cannot both be read off velocity alone, because knockback *is* velocity.
///
/// So the exemption is stamped where the impulse is applied and expires on this
/// clock. It is deliberately short: long enough to cover the arc of a
/// rocket-jump, far too short to be worth chaining shots off.
///
/// It is **not** `grounded`. That was tried, and it made the whole gate
/// cosmetic: jump, release the key, and you fire at full walking speed — as does
/// anyone who steps off a ledge. `grounded` is a *consequence* of being thrown,
/// not evidence of it, and it is equally a consequence of jumping.
pub const KNOCKBACK_FIRE_GRACE: f32 = 0.6;

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
/// Walkable ground a spawn wants on **both** sides, in px.
///
/// A spawn is a standable point, and "standable" only means a body fits — it says
/// nothing about being able to go anywhere. Wedged in a crevice or against a
/// cliff you can stand, aim and fire, and you cannot walk, which reads as the
/// controls being broken. Two browser checks caught it as "held D and moved 0 px";
/// both were true reports about a legal spawn.
///
/// 48 px is three player widths — enough to tell a ledge from a slot, and small
/// enough that a terraced hillside still offers plenty of candidates.
pub const SPAWN_WALK_CLEARANCE: i32 = 48;
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
// Map generator v2 — the landscape generator
// ---------------------------------------------------------------------------

/// Which terrain generator builds a map.
///
/// v1 thresholds one warped fBm field over the whole canvas and then carves a
/// cave *network* through it. The field has no idea where the ground is, so the
/// result is a single perforated mass: the airspace it leaves is interior, the
/// floating chunks it makes are perforated too, and the whole map reads as one
/// cave system. That is faithful to `docs/10` §Pass 2 and it is not what a Worms
/// map looks like.
///
/// v2 builds the ground from a **1D height profile** instead — hills, terraces,
/// cliffs, chasms and mesas — then hangs a few solid islands in the sky above it
/// and punches one or two caves into the rock. Open sky is the default state of a
/// pixel, and a cave is a feature rather than the medium.
///
/// Both are kept so the two can be compared on the same seed; `DEFAULT_MAP_GENERATOR`
/// and the server's `MAP_GENERATOR` env var choose between them.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum MapGenerator {
    /// The original warped-noise field plus cave network (`docs/10`, `docs/70` §A2).
    V1,
    /// The height-profile landscape.
    V2,
}

impl MapGenerator {
    /// Parse the `MAP_GENERATOR` environment value.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "v1" | "V1" | "1" => Some(MapGenerator::V1),
            "v2" | "V2" | "2" => Some(MapGenerator::V2),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            MapGenerator::V1 => "v1",
            MapGenerator::V2 => "v2",
        }
    }

    pub const fn to_u8(self) -> u8 {
        match self {
            MapGenerator::V1 => 0,
            MapGenerator::V2 => 1,
        }
    }

    pub const fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(MapGenerator::V1),
            1 => Some(MapGenerator::V2),
            _ => None,
        }
    }

    pub const ALL: [MapGenerator; 2] = [MapGenerator::V1, MapGenerator::V2];
}

/// The generator you get unless `MAP_GENERATOR` says otherwise.
pub const DEFAULT_MAP_GENERATOR: MapGenerator = MapGenerator::V2;

/// Mean ground line, as a fraction of map height. 0.58 leaves the top ~52 % of
/// the canvas as sky before the profile's amplitude is applied, which is what
/// makes the silhouette read against the sky instead of filling the frame.
pub const GROUND_BASE_FRAC: f32 = 0.64;
/// Peak-to-mean swing of the ground line, as a fraction of map height.
pub const GROUND_AMPLITUDE_FRAC: f32 = 0.25;
/// Wavelength of the profile's first octave, as a fraction of map width. Roughly
/// two hills across the map before the finer octaves break them up.
pub const GROUND_WAVELENGTH_FRAC: f32 = 0.38;
/// Octaves of the 1D profile: a hill, a shoulder, a bump, and grain.
pub const GROUND_OCTAVES: u32 = 4;
/// Air kept clear between the highest ground and the sky margin, in px.
///
/// This is also a **gameplay** floor, not only a compositional one: a meteor is
/// broadcast while it is inside the map, and §C22 requires a third of a second of
/// visible descent before it can hit anything. At 80 px the tallest mesa tops
/// swallowed a meteor in five broadcasts of the required six.
pub const GROUND_CREST_HEADROOM: i32 = 240;

/// Height of one terrace step. The flat ledges in a Worms map are what you stand
/// and fight on; a purely smooth profile gives you nowhere to stop.
///
/// 48 px is below `JUMP_HEIGHT` (≈ 66 px), so a terrace edge is always climbable
/// on foot and a terraced hillside never strands anyone.
pub const TERRACE_STEP: i32 = 48;
/// Fraction of the map's width that is terraced rather than left rolling.
pub const TERRACE_FRACTION: f32 = 0.45;
/// Width of one terraced stretch, as a fraction of map width.
pub const TERRACE_RUN_FRAC: f32 = 0.16;
/// Width of a single ledge inside a terraced stretch, in px.
///
/// A terrace is built out of **ledges of this width**, not by quantising each
/// column on its own. Per-column quantisation of a slope puts one step every few
/// pixels and the hillside comes out crenellated like a castle wall — which is
/// exactly what the first v2 dump showed.
pub const LEDGE_WIDTH_MIN: i32 = 96;
pub const LEDGE_WIDTH_MAX: i32 = 280;

/// Amplitude of the fine detail added to the ground line after every feature, px.
///
/// Rock is not machined. Without this the flat ledges are *exactly* flat and the
/// cliff faces are exactly vertical, and the silhouette reads as architecture.
pub const GROUND_DETAIL_AMPLITUDE: f32 = 9.0;
/// Wavelength of that detail, in px.
pub const GROUND_DETAIL_WAVELENGTH: f32 = 42.0;

/// Chasm width, in px. A gap this wide reads as a canyon, not as a dip.
pub const CHASM_WIDTH_MIN: i32 = 130;
pub const CHASM_WIDTH_MAX: i32 = 340;
/// Width of the sloped shoulder on each side of a chasm.
pub const CHASM_SHOULDER: i32 = 70;
/// Probability a chasm cuts all the way to the bedrock rather than part way.
pub const CHASM_TO_BEDROCK_CHANCE: f32 = 0.55;
/// Depth of a chasm that stops short of bedrock, in px.
pub const CHASM_PARTIAL_DEPTH_MIN: i32 = 160;
pub const CHASM_PARTIAL_DEPTH_MAX: i32 = 420;

/// A mesa's flat top, in px. This is the tall column silhouette.
pub const MESA_WIDTH_MIN: i32 = 220;
pub const MESA_WIDTH_MAX: i32 = 560;
pub const MESA_RISE_MIN: i32 = 130;
pub const MESA_RISE_MAX: i32 = 340;
/// Width of the stepped shoulder on each side of a mesa.
pub const MESA_SHOULDER: i32 = 56;

/// Spacing of the boulders and notches placed along the ground line, in px.
///
/// Sparse on purpose. At 34 px they were a regular comb of identical semicircles
/// — battlements, not rock. The fine wobble is `GROUND_DETAIL_AMPLITUDE`'s job;
/// these are the occasional boulder and the occasional bite out of the edge.
pub const ROUGHEN_STEP: i32 = 130;
pub const ROUGHEN_RADIUS_MIN: i32 = 11;
pub const ROUGHEN_RADIUS_MAX: i32 = 34;
/// How far a roughening circle may sit off the ground line, in px.
pub const ROUGHEN_OFFSET: i32 = 18;
/// Probability a roughening circle bites in rather than bulges out.
pub const ROUGHEN_CARVE_CHANCE: f32 = 0.5;
/// Probability a roughening slot is used at all.
pub const ROUGHEN_PLACE_CHANCE: f32 = 0.62;

/// Half-height of a v2 island's slab.
///
/// An island is a horizontal **capsule** with a tapering underside, not a row of
/// equal circles: a row of equal circles is a cloud, which is what the first v2
/// dump produced. The capsule gives it the flat top you can land and fight on.
pub const ISLAND2_RADIUS_MIN: i32 = 30;
pub const ISLAND2_RADIUS_MAX: i32 = 52;
/// Slab length as a multiple of its half-height.
pub const ISLAND2_ASPECT_MIN: i32 = 3;
pub const ISLAND2_ASPECT_MAX: i32 = 7;
/// Clear air required between the underside of an island and the ground below it.
pub const ISLAND2_GROUND_CLEARANCE: i32 = 150;
/// How far either side of an island the ground clearance is measured.
///
/// Measuring only under the island's own footprint let one drop neatly into a
/// canyon: the ground directly beneath it was the canyon floor, 900 px down, while
/// the canyon walls 40 px to each side were level with the island's top.
pub const ISLAND2_CLEARANCE_MARGIN: i32 = 260;
/// Clear air required between two islands.
pub const ISLAND2_GAP: i32 = 90;
/// Air required above an island's top, below the sky margin. Shares
/// `GROUND_CREST_HEADROOM`'s reason: an island is the highest thing a meteor can
/// hit, so it has to be far enough down to be worth dodging.
pub const ISLAND2_SKY_CLEARANCE: i32 = 240;

/// v2 cave chamber radius.
pub const CAVE2_RADIUS_MIN: i32 = 44;
pub const CAVE2_RADIUS_MAX: i32 = 82;
/// Radius of the shaft that opens a v2 cave to the sky. Wide enough to fall
/// through and to climb out of.
pub const CAVE2_MOUTH_RADIUS: i32 = 22;
/// Rock a column needs below the ground line before a cave may be cut into it.
pub const CAVE2_MIN_ROCK: i32 = 260;
/// How far below the ground line a chamber's centre sits.
pub const CAVE2_DEPTH_MIN: i32 = 150;
pub const CAVE2_DEPTH_MAX: i32 = 330;
/// Clear rock required all round a chamber centre before it is accepted.
pub const CAVE2_CLEARANCE: i32 = 100;

/// Half-length of the horizontal bore that makes an arch.
pub const ARCH_HALF_LEN_MIN: i32 = 70;
pub const ARCH_HALF_LEN_MAX: i32 = 140;
pub const ARCH_RADIUS_MIN: i32 = 40;
pub const ARCH_RADIUS_MAX: i32 = 62;
/// Rock that must remain above an arch's bore for it to read as an arch.
pub const ARCH_ROOF_MIN: i32 = 70;
/// Fraction of its radius an arch bore keeps at the mouths. A constant-radius
/// bore is a rounded rectangle punched through a hill; a tapered one is a hole.
pub const ARCH_END_TAPER: f32 = 0.62;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/// The always-visible bar (§C10). `1`–`8` and the wheel select from it, and
/// **only** from it: firing and using act on the selection, so a selection that
/// could land in the backpack would mean shooting something you cannot see.
pub const QUICK_SLOTS: usize = 8;
/// Two more rows, revealed by right-click (§C10).
pub const BACKPACK_SLOTS: usize = 16;
/// The whole inventory: the quick bar first, then the backpack.
///
/// **8 → 24.** The ordering is load-bearing rather than cosmetic: `Inventory::add`
/// fills slots in index order, so quick-bar-first (§C10) falls out of laying the
/// bar at 0..QUICK_SLOTS instead of being a second rule that can disagree.
pub const INVENTORY_SLOTS: usize = QUICK_SLOTS + BACKPACK_SLOTS;
/// Per slot, same item id.
pub const MAX_STACK: u8 = 9;
/// From player centre to pickup centre.
pub const PICKUP_RADIUS: f32 = 20.0;
/// Periodic ground spawns. **20.0 → 14.0** (T11.13).
///
/// With a 24-item registry a round was showing 51 % / 58 % / 64 % of the arsenal
/// by scale — "tons of weapons" was true of the game and not of any round of it.
/// Measured over 8 seeds x 150 s at all three scales (§A19: `DEFAULT_MAP_SCALE`
/// is Large, so tuning on Small would set the number where it does not matter):
///
/// | scale | distinct before → after | peak live | 1st weapon |
/// |---|---|---|---|
/// | Small | 12.2 → 13.8 of 24 | 14 → 14 | 18 s → 13 s |
/// | Medium | 14.0 → 15.2 | 22 → 20 | 20 s → 14 s |
/// | Large | 15.4 → **16.9** | 27 → 27 | 23 s → 16 s |
///
/// **Paired with the `WORLD_ITEM_TTL` cut, so this is turnover and not
/// accumulation**: simultaneous items are flat or lower at every scale, well
/// clear of `MAX_WORLD_ITEMS`. Raising the rate alone would have pushed the live
/// count into the cap, where eviction deletes what spawned two minutes ago
/// instead of adding to it — churn that measures like density.
pub const ITEM_SPAWN_INTERVAL: f32 = 14.0;
pub const ITEM_SPAWN_BATCH_MIN: u32 = 1;
pub const ITEM_SPAWN_BATCH_MAX: u32 = 2;
pub const CRATE_INTERVAL: f32 = 35.0;
pub const CRATE_W: f32 = 24.0;
pub const CRATE_H: f32 = 24.0;
/// Horizontal drag while falling.
pub const CRATE_DRAG: f32 = 0.02;
/// Hard cap; oldest un-picked item despawns first.
pub const MAX_WORLD_ITEMS: usize = 40;
/// Seconds before an untouched ground item despawns. **90.0 → 70.0** (T11.13).
///
/// Cut alongside `ITEM_SPAWN_INTERVAL` so a faster spawn rate raises *variety*
/// without raising how many items are on the ground at once — see that
/// constant's table. Not cut further: an item you saw a minute ago and walked
/// back for should still be there, and below about a minute pickups start to
/// read as evaporating rather than as competition.
pub const WORLD_ITEM_TTL: f32 = 70.0;

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
/// Seconds between drops while the rain is active.
///
/// Was `TOXIC_PUDDLE_EVERY`. §E15 retires that name with the puddles, but the
/// **cadence is not a puddle** — §E13 keeps the scheduler and the number of
/// drops per window unchanged, so the value is carried over untouched under a
/// name that says what it times.
pub const TOXIC_DROP_EVERY: f32 = 0.4;
/// Downward speed a toxic drop leaves its cloud at (§C21).
///
/// Slow enough that the fall reads as rain rather than as artillery: from
/// `SKY_MARGIN` this gives roughly a second of visible descent on a medium map,
/// which is the point — §C21 makes the rain visible by making it fall.
pub const TOXIC_DROP_SPEED: f32 = 180.0;
/// How long a drop's poison lasts, and how hard it bites (§E13).
///
/// A re-hit **replaces** the timer; it never stacks. Same rule as the shield,
/// and for the same reason: a stacking status is a damage cliff nobody can read
/// off the screen.
pub const TOXIC_POISON_DURATION: f32 = 3.0;
pub const TOXIC_POISON_DPS: f32 = 2.0;
/// The hole a drop leaves in the ground: bullet-sized, not a crater (§E13).
pub const TOXIC_DROP_CARVE_R: f32 = 6.0;

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
/// A snapshot is therefore `8 + 18n + 4`: **120 bytes for six players**, against
/// the doc's 97. At 20 Hz that is 2.4 KB/s down rather than 1.9 — well inside the
/// budget in `docs/40` §4.
///
/// The sixteenth byte is **vision** (T11.08): the player's own FoV multiplier,
/// fog times smoke, quantised. It is authoritative because smoke is *positional* —
/// what you can see depends on which cloud you are standing in, so the client
/// cannot derive it from a global effect flag. Before it existed, `GameScene`
/// hardcoded `fogMult: 1` and `World::fog_multiplier` had **no caller at all**:
/// heavy fog was simulated every round and changed nothing anyone could see.
/// The eighteenth byte is **heals and batteries** (T14.03, §C9): heals in 2 bits
/// and batteries in 3, one byte with 3 bits spare. §C9 budgeted 16 → 17 for it;
/// it is 18 because T14.02's battery byte took 17 — see below.
///
/// The seventeenth byte is **battery** (T14.02).
///
/// §C8 puts an energy bar under the health bar and §B5 makes that bar do real
/// work — every laser shot is a shield you are not going to have, and the trade
/// is only legible if you can watch the number fall. The client cannot derive it:
/// the pool is spent by the shield tick and by energy weapons, both resolved
/// server-side.
///
/// **A spec gap, reported rather than absorbed.** §C8 asks for the bar and §C9
/// budgets `SNAPSHOT_PLAYER_BYTES` 16 → 17 for its *own* byte (the heals and
/// batteries counters, T14.03), with neither amendment saying how the energy pool
/// itself reaches the client. Both bytes are needed and they carry different
/// things, so this is 17 and T14.03 is 18.
///
/// 19 with T15.01: §C5's charge indicator is one more byte, and for the same
/// reason — the fill is a server fact (the arming latch, the cooldown and the
/// step-off reset all live in `world::teleport`), and a client timing its own two
/// seconds would be a second copy of three guards.
pub const SNAPSHOT_PLAYER_BYTES: usize = 19;
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
///
/// A **count**, not a duration — see `CHUNK_REBAKE_MS` directly below, which is
/// also 4 and means something else entirely. Anything asserting a time budget
/// wants that one.
pub const CHUNK_REBAKE_BUDGET: u32 = 4;
/// Wall-clock ceiling for **one** chunk rebake, ms. `docs/60` §6's table row.
///
/// A different number from `CHUNK_REBAKE_BUDGET` above, which is a *count* of
/// chunks per frame — the two are four and four and mean nothing alike. It lives
/// here because `docs/60` §6 states it and nothing in the codebase mirrored it,
/// so the only way to assert it was to spell `4` in a check and call that a
/// budget (`CLAUDE.md`: never hardcode a number in a test).
pub const CHUNK_REBAKE_MS: f32 = 4.0;
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
///
/// **Medium, not Large — T11.16, §B27.** §A1 chose Large so the map is something
/// you explore rather than survey, and that intent stands: at `CAMERA_ZOOM` 2.0
/// Medium is still 4.8 x 4.3 screens of world, so nothing about discovery, the
/// minimap or the cave system changes.
///
/// What changed is measured. At the shipping player count, 8 seeds x 150 s:
///
/// | scale | plrs | fought | 1st contact | in sight |
/// |---|---|---|---|---|
/// | Large  | 4 | **0/8** | 100 s | 8.6 % |
/// | Large  | 6 | 3/8 | 89 s | 33.1 % |
/// | Medium | 6 | 4/8 | 24 s | 66.5 % |
///
/// Zero of eight rounds on Large contained a fight at all. `near%` and `los%`
/// track each other everywhere (8.6 vs 8.5, 66.5 vs 64.6), so terrain is not
/// what keeps players apart — distance is — and `armed%` is flat at 28-43 %
/// across every configuration, so it is not item scarcity either.
///
/// Large is still there behind `MAP_SCALE=large` for the exploratory game §A1
/// describes. It is not the default because at four players it produces rounds
/// with no fighting in them.
pub const DEFAULT_MAP_SCALE: MapScale = MapScale::Medium;
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

/// How far above the **bottom of the map** v1's cave network keeps out.
///
/// **Deliberately not `FLOOR_CRUST`, and it is 24 because that is what v1 was
/// tuned against** — it was `BEDROCK_H` until §C15, purely because the two
/// happened to be the same number.
///
/// Uncoupling them is the fix for a measured regression, not a preference.
/// Letting the tunnel walk follow the crust down to 16 gives it 8 px more
/// vertical room at the bottom, and over 50 seeds that moved the mean absolute
/// vertical displacement of a tunnel from 217.0 px to 239.2 px against a roughly
/// unchanged horizontal 222.8 → 227.5 — enough to flip
/// `tunnels_are_meaningfully_horizontal`, whose whole point is that the heading
/// bias must beat the wander. §C15 is about whether the floor can be **dug
/// through**; it says nothing about where v1 puts its tunnels, and the two
/// questions sharing one constant is exactly the "field that means two things"
/// this codebase keeps paying for.
///
/// (The margin that assertion had was 2.6 %, which is thin. That is worth knowing
/// separately from this change, and is reported with it.)
pub const CAVE_FLOOR_KEEPOUT: u32 = 24;

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

/// Whether air inside the landmass is painted with dark rock at all.
///
/// **Off.** The backdrop's job was to stop a crater through a hillside showing
/// daylight, and it does that; what it also did was make the whole map read as one
/// cave system, because every classifier below has a false-positive rate that no
/// setting drives to zero (see `BACKDROP_MIN_HITS`' table: 2.5-16 % of open sky
/// drawn dark, depending on scale). Sky beside a v2 mesa is the worst case and it
/// is the common one.
///
/// A toggle rather than a deletion, and the same shape as `MAP_GENERATOR`: the
/// classifier is tuned, measured and unit-tested, and the two versions are worth
/// being able to put side by side. Everything below stays live and stays tested —
/// `BackdropMask` is still built and still asserted on in `backdrop-real.test.ts`.
/// This decides only whether the renderer asks for it.
///
/// Flipping it needs a wasm rebuild (`npm --prefix client run build` does it); the
/// sandbox has a checkbox that flips it without one.
pub const CAVE_BACKDROP: bool = false;

/// Rays cast from an air sample, evenly spaced from 0 rad.
/// Seconds of round left below which the HUD's round timer turns red (§C8).
///
/// A minute: long enough that seeing it turn changes what you do — go for a
/// crate or do not — and short enough that it is not red for most of the round.
pub const TIMER_WARN_SECONDS: f32 = 60.0;

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

/// Share of a cell's neighbourhood that must have rock **straight up** before its
/// air counts as interior. 0 disables the test.
///
/// The ray tests cannot separate "inside a cavern" from "outside a cliff". Beside a
/// tall sheer face the up-diagonal rays hit the cliff, the side and down rays hit
/// the cliff and the ground, and `BACKDROP_MIN_UP` — which counts any ray with
/// `dy < -0.3` — is satisfied by those same diagonals. So open sky next to a cliff
/// scores exactly like a chamber and gets painted with the cave backdrop.
///
/// It was always possible; `MAP_GENERATOR=v2` made it the common case, because a
/// mesa is a 300 px sheer face with open air beside it. A whole half-frame of sky
/// rendered as cave in the first v2 playthrough.
///
/// The discriminator is the vertical column: interior air has rock over its head,
/// air outdoors does not, however much rock is beside it. Interpolated and blurred
/// like the other two fields, so 0.5 means "most of the neighbourhood is roofed"
/// rather than snapping to the coarse lattice.
pub const BACKDROP_MIN_ROOF: f32 = 0.5;

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

/// Five, so a lone human sits in a full six-player room — T11.16, §B27.
///
/// Player count is the second lever on encounter rate and it is nearly free:
/// §B2 measured 128 concurrent rooms at 0.12 % of half a tick budget. Going 4 -> 6
/// players took time-to-first-contact from 107 s to 24 s on Medium and from
/// 100 s to 89 s on Large.
///
/// It costs a human nothing: T6.15 kicks the newest bot when a person joins a
/// full room, so five bots means five opponents alone and four once a friend
/// arrives.
pub const BOT_COUNT_DEFAULT: usize = 5;
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
/// §C20 — you cannot fire while moving under your own power.
///
/// Above this horizontal speed a **grounded** player is still walking (or still
/// coasting off a walk through `GROUND_FRICTION`) and every fire is refused.
/// Airborne speed does not count: being thrown by a blast must not stop you
/// shooting, or knockback becomes a stun.
///
/// 8 px/s against a `WALK_SPEED` of 150 is "stopped, give or take the last
/// pixel of friction" — small enough that a player who has let go and settled
/// can shoot, large enough that a float that never quite reaches zero does not
/// lock them out.
pub const FIRE_MOVE_MAX_SPEED: f32 = 8.0;

pub const ROOM_EMPTY_TTL: f32 = 30.0;
/// How often the process-level sweep asks the registry what has expired.
///
/// `ROOM_EMPTY_TTL` is the deadline; this is only the resolution at which it is
/// noticed, so a room lives for at most `ROOM_EMPTY_TTL + ROOM_REAP_INTERVAL`.
/// Sweeping every tick would take the registry lock 60 times a second to learn
/// nothing.
pub const ROOM_REAP_INTERVAL: f32 = 2.0;
pub const JOIN_CODE_LEN: usize = 6;
/// No `I`, `1`, `O` or `0` — people read these aloud. It **does** contain `L`,
/// which is why nothing folds `L` to `1`: doing so made roughly one code in six
/// unreachable.
pub const JOIN_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// §B10: there is no quick-match queue, so `QUEUE_WAIT_BEFORE_BOTS` is gone.
// Filling the fullest room with space and a human kicking the newest bot give
// the queue's outcome with no waiting state to be stuck in.
//
// §C18 corrects the rest of that reasoning: "nobody ever waits" was the wrong
// goal — a room waits in `Lobby` until there is a reason to start. §E2 then
// retired `MIN_PLAYERS_TO_START` entirely: a lobby starts when it fills to
// `LOBBY_CAPACITY`, or when `LOBBY_BOT_TIMEOUT` expires and bots take the empty
// seats. One human plus four bots after ten seconds is a game; two humans and
// an infinite wait is not.

// --- B4: death and the respawn timer ---
// RESPAWN_DELAY moved to 5.0 by §B4; it lives with the other player constants.

// --- B5: the battery ---

pub const BATTERY_MAX: f32 = 100.0;

/// Heals and battery packs a player may carry (§C9).
///
/// They are **counters, not inventory**: consumed constantly, and they should
/// never compete with a weapon for a slot. Small caps, because carrying six
/// medkits is not a decision.
pub const MAX_HEALS: u8 = 2;
pub const MAX_BATTERIES: u8 = 4;
pub const BATTERY_PACK_AMOUNT: f32 = 50.0;
/// Battery per second while a shield is up. The shield ends early at zero, so
/// every laser shot is a shield you are not going to have.
pub const SHIELD_DRAIN: f32 = 2.0;
/// Energy weapons pierce: this replaces `SHIELD_DAMAGE_MULT` for them.
pub const LASER_SHIELD_MULT: f32 = 0.85;
/// Drained from the victim on an energy hit, which cuts a shield's life directly.
pub const LASER_BATTERY_DRAIN: f32 = 8.0;

// --- B7: the arsenal ---

// Ballistic hitscan (§B7). Every one carves — §A3: nothing hits a wall without
// marking it — and the carve radius is part of what distinguishes them: a deagle
// opens a hole a pistol does not.
pub const PISTOL_DAMAGE: f32 = 14.0;
pub const PISTOL_BLAST_RADIUS: f32 = 3.0;
pub const PISTOL_RANGE: f32 = 520.0;
pub const PISTOL_COOLDOWN: f32 = 0.28;
pub const PISTOL_SPREAD: f32 = 0.020;
pub const PISTOL_AMMO: u8 = 40;

pub const REVOLVER_DAMAGE: f32 = 32.0;
pub const REVOLVER_BLAST_RADIUS: f32 = 5.0;
pub const REVOLVER_RANGE: f32 = 700.0;
pub const REVOLVER_COOLDOWN: f32 = 0.70;
pub const REVOLVER_SPREAD: f32 = 0.010;
pub const REVOLVER_AMMO: u8 = 12;

pub const DEAGLE_DAMAGE: f32 = 45.0;
pub const DEAGLE_BLAST_RADIUS: f32 = 6.0;
pub const DEAGLE_RANGE: f32 = 760.0;
pub const DEAGLE_COOLDOWN: f32 = 0.85;
pub const DEAGLE_SPREAD: f32 = 0.015;
pub const DEAGLE_AMMO: u8 = 8;

pub const MACHINEGUN_DAMAGE: f32 = 11.0;
pub const MACHINEGUN_BLAST_RADIUS: f32 = 3.0;
pub const MACHINEGUN_RANGE: f32 = 900.0;
pub const MACHINEGUN_COOLDOWN: f32 = 0.09;
pub const MACHINEGUN_SPREAD: f32 = 0.045;
pub const MACHINEGUN_AMMO: u8 = 120;

// Melee (§B7). No ammo — a cooldown instead — which is what makes melee the
// floor of the arsenal rather than a novelty: it is what you still have when you
// have nothing. Knockback is the axis that separates them, because a bat that
// launches someone off a ledge into a crater is a kill the damage number does not
// explain.
//
// Carve is 0 for the blade and blunt weapons and non-zero for the tools: an axe
// and a hammer dig, a knife does not. §A3 is about ordnance, and §B18 restates it.
pub const KNIFE_DAMAGE: f32 = 35.0;
pub const KNIFE_CARVE: f32 = 0.0;
/// §C19: every melee reach below is measured **from the body edge**, not from
/// the player's centre — `melee::swing` adds `PLAYER_W / 2`. So the number here
/// means "how far in front of me", which is what a player judges by eye.
///
/// T11.09 had raised these from the centre-measured 26/34/30/28, because reach
/// is the axis that decides whether a swing ever connects: at identical bot
/// skill on identical maps the whip (58) hit 3.0 % of swings while the knife
/// (26), axe (30) and hammer (28) hit 0.47 %, 0.38 % and 0.26 %. Reach was the
/// only thing that differed and predicted the result almost exactly.
///
/// The centre-based numbers were also why `axe` at 40 connected with someone two
/// and a half player-widths away. Re-expressed from the edge these become
/// immediate proximity; the lost hit rate is bought back with **arc and
/// cooldown**, which widen and quicken the swing without letting it connect at a
/// distance (§C19).
pub const KNIFE_REACH: f32 = 12.0;
/// §C19 says to buy melee's lost hit rate back with "a wider sweep and a faster
/// swing". **It was tried, measured, and reverted** — the numbers are in
/// `tasks/JOURNAL.md` under T13.06.2. Widening every melee arc by ~50 % and
/// cutting the cooldowns (knife 1.0→1.5 / 0.35→0.30, bat 1.4→2.0 / 0.55→0.45,
/// axe 1.2→1.8 / 0.90→0.70, hammer 1.1→1.7 / 1.20→0.95) did not recover the
/// damage share, and it made the knife markedly WORSE — 0.36 → 0.15 dmg/bot-s
/// on more swings, which nothing in a wider arc explains. `docs/71` §B23 records
/// the same outcome for the flamethrower's range: measured worse, reverted.
///
/// So these are §B7/§B23's values, unchanged, and the shortfall is reported
/// rather than tuned away.
pub const KNIFE_ARC: f32 = 1.0;
pub const KNIFE_COOLDOWN: f32 = 0.35;
pub const KNIFE_KNOCKBACK: f32 = 60.0;

pub const BAT_DAMAGE: f32 = 28.0;
pub const BAT_CARVE: f32 = 0.0;
pub const BAT_REACH: f32 = 16.0;
pub const BAT_ARC: f32 = 1.4;
pub const BAT_COOLDOWN: f32 = 0.55;
pub const BAT_KNOCKBACK: f32 = 260.0;

pub const WHIP_DAMAGE: f32 = 22.0;
pub const WHIP_CARVE: f32 = 0.0;
/// The longest reach in the melee table — that is the whip's whole identity, and
/// §C19 keeps it that way: 44 px in front of the body is still most of a body
/// length further than anything else swings.
pub const WHIP_REACH: f32 = 44.0;
pub const WHIP_ARC: f32 = 0.8;
pub const WHIP_COOLDOWN: f32 = 0.60;
pub const WHIP_KNOCKBACK: f32 = 120.0;

pub const AXE_DAMAGE: f32 = 55.0;
pub const AXE_CARVE: f32 = 10.0;
pub const AXE_REACH: f32 = 16.0;
pub const AXE_ARC: f32 = 1.2;
pub const AXE_COOLDOWN: f32 = 0.90;
pub const AXE_KNOCKBACK: f32 = 140.0;

pub const HAMMER_DAMAGE: f32 = 70.0;
pub const HAMMER_CARVE: f32 = 16.0;
pub const HAMMER_REACH: f32 = 14.0;
pub const HAMMER_ARC: f32 = 1.1;
pub const HAMMER_COOLDOWN: f32 = 1.20;
pub const HAMMER_KNOCKBACK: f32 = 340.0;

// Cone (§B7). Area denial: it carves nothing — fire does not dig (§B6) — and
// what it leaves behind is the *existing* LAVA_BURN_* hazard, not a second fire
// system. `damage` on the def mirrors the dps so the shared field means
// something; the cone reads its dps from the delivery.
pub const FLAMETHROWER_DPS: f32 = 14.0;
/// T11.09 tried 200 here and **measured it worse**: 0.37 -> 0.30 dmg/bot-s with
/// self-damage rising 0.28 -> 0.44. Range is not what holds the flamethrower
/// back. It leaves burning ground (§B6) and its user walks into it — the same
/// root cause as molotov and toxic, whose self-damage is 3x what they deal. The
/// bot blast-guard checks a blast radius and knows nothing about a hazard that
/// lingers for seconds, so a longer reach only spreads more fire to stand in.
/// A weapon-side fix would be treating the fix as the balance problem.
pub const FLAMETHROWER_RANGE: f32 = 150.0;
pub const FLAMETHROWER_ARC: f32 = 0.55;
pub const FLAMETHROWER_COOLDOWN: f32 = 0.05;
/// Fuel, spent per trigger tick — 200 at 0.05 s is 10 s of continuous fire.
pub const FLAMETHROWER_AMMO: u8 = 200;
/// How long one spray particle lives, for the client and for the burn trail.
pub const FLAMETHROWER_PARTICLE_LIFE: f32 = 0.35;

// Thrown ordnance (§B7). Four grenades that are not the grenade: one bursts
// above you, one blinds, one burns, one poisons. Three of the four leave the
// terrain untouched — what they deny is space, not rock.
pub const AIRBURST_PELLETS: u32 = 9;
/// Radians, downward.
pub const AIRBURST_FAN: f32 = 0.9;
/// Bursts at apex, or here if it is still climbing — an airburst that lands is a
/// dud, and a dud is a wasted pickup.
pub const AIRBURST_FUSE: f32 = 1.2;
pub const AIRBURST_MUZZLE_SPEED: f32 = 520.0;
pub const AIRBURST_AMMO: u8 = 2;
pub const AIRBURST_PELLET_DAMAGE: f32 = 12.0;
pub const AIRBURST_PELLET_CARVE: f32 = 4.0;
pub const AIRBURST_PELLET_RANGE: f32 = 460.0;
/// Pellets are energy (§B7): they pierce shields and drain the victim's charge,
/// which is what makes the airburst the *other* answer to someone turtling.
///
/// It is a real cost and **nobody ever pays it**. `energy_cost` drives three
/// things (§B16) and a pellet needs two of them: pierce yes, charge no. That
/// works because pellets are fired by `burst_pellets`, not by `try_fire` — the
/// only place battery is ever spent. `an_airburst_costs_the_thrower_no_battery`
/// guards the day someone routes them through the normal firing path.
pub const AIRBURST_PELLET_ENERGY: f32 = 4.0;

pub const FOV_SMOKE_MULT: f32 = 0.35;
pub const SMOKE_RADIUS: f32 = 110.0;
pub const SMOKE_DURATION: f32 = 8.0;
pub const SMOKE_FUSE: f32 = 1.5;
pub const SMOKE_MUZZLE_SPEED: f32 = 470.0;
pub const SMOKE_AMMO: u8 = 2;

/// Six patches, scattered — a molotov denies an area, not a point.
pub const MOLOTOV_PATCHES: u32 = 6;
/// **Must stay below `LAVA_BURN_RADIUS` (28).** The patches sit on a ring of this
/// radius, so a scatter wider than one patch leaves the impact point itself
/// unburnt — a molotov that lands on you and does nothing. It was 46, and the
/// control half of `smoke_deals_no_damage_...` caught it: fire that could not burn.
pub const MOLOTOV_SCATTER: f32 = 24.0;
pub const MOLOTOV_BURN_DURATION: f32 = 5.0;
pub const MOLOTOV_MUZZLE_SPEED: f32 = 470.0;
pub const MOLOTOV_AMMO: u8 = 2;

/// The thrown toxic zone's damage (§B7).
///
/// **This was `TOXIC_DPS`**, shared with the weather. §E15 retires that name as
/// "replaced by `TOXIC_POISON_DPS`", but `defs.rs` reads it for the *grenade*
/// as well, so deleting it outright would have quietly cut a §B7 weapon from
/// 6 dps to 2. A name that meant two things; the grenade keeps its number under
/// a name that is only its own.
pub const TOXIC_GRENADE_DPS: f32 = 6.0;
pub const TOXIC_GRENADE_RADIUS: f32 = 90.0;
pub const TOXIC_GRENADE_DURATION: f32 = 8.0;
pub const TOXIC_GRENADE_FUSE: f32 = 2.0;
pub const TOXIC_GRENADE_MUZZLE_SPEED: f32 = 480.0;
pub const TOXIC_GRENADE_AMMO: u8 = 2;
pub const MINE_DAMAGE: f32 = 60.0;
pub const MINE_BLAST_RADIUS: f32 = 48.0;
/// Two per pickup: a mine is a commitment, not a spray.
pub const MINE_AMMO: u8 = 2;
pub const MINE_ARM_TIME: f32 = 1.0;
pub const MINE_TRIGGER_RADIUS: f32 = 36.0;
pub const MINE_LIFETIME: f32 = 90.0;

// --- B8: tombstones ---

pub const TOMBSTONE_W: f32 = 14.0;
pub const TOMBSTONE_H: f32 = 18.0;
pub const MAX_TOMBSTONES: usize = 32;

// ---- v4 amendments ----  mirrors docs/72-amendments-v4.md

// --- C5: teleport pads ---

/// Pads chosen per map, by the same farthest-point sampling as spawn points.
///
/// Six, which is `SPAWN_COUNT_MIN` — not a coincidence and not a second number:
/// a pad is where a death puts you, so there has to be one per player or the
/// respawn choice collapses to "the pad nobody is standing on".
pub const TELEPORT_PADS: usize = 6;
/// A pad is `PAD_W` wide and `PAD_H` tall, its top flush with the surface point.
///
/// Wider than `PLAYER_W` (16) so a body lands on it rather than beside it, and
/// short enough that stamping one into a hillside does not build a tower.
pub const PAD_W: i32 = 40;
pub const PAD_H: i32 = 8;
/// How far a body's feet may sit from a pad's surface line and still count as
/// standing on it, in px.
///
/// A grounded body rests where the collision solver left it, which is near the
/// surface line rather than exactly on it, and a body walking a slope onto the
/// pad arrives a pixel or two high. An exact test makes "on the pad" true on
/// some ticks and false on others, which is a charge that never completes.
pub const PAD_TOUCH_SLACK: f32 = 4.0;
/// Seconds of standing still on a pad before it fires.
pub const TELEPORT_CHARGE: f32 = 2.0;
/// Seconds after **arriving** before a pad will charge again.
///
/// Without it the destination pad starts charging the instant you land on it and
/// you ping-pong between two pads for the rest of the round.
pub const TELEPORT_COOLDOWN: f32 = 5.0;
/// How far from where you spawned you must move before a pad arms.
///
/// Respawn puts you **on** a pad, so without this rule the first thing every
/// death does is teleport you somewhere else two seconds later — including when
/// you are stationary because you are reading the map.
pub const TELEPORT_ARM_DISTANCE: f32 = 32.0;

// --- C14: a living background ---

/// Parallax mountain layers behind the terrain, from the map seed.
///
/// Two. One reads as a flat cut-out; three is a lot of silhouette for a layer
/// nobody is meant to look at directly, and the third would have to sit below
/// 0.10 where it barely moves at all.
pub const MOUNTAIN_LAYERS: usize = 2;
/// Scroll factor per layer, far to near. **Both below `PARALLAX_FACTOR`** (0.35):
/// these sit behind everything the terrain parallax already covers, and a layer
/// that scrolled with the terrain would read as terrain.
pub const MOUNTAIN_PARALLAX: [f32; MOUNTAIN_LAYERS] = [0.10, 0.20];
/// Ridge height as a fraction of the viewport, far to near.
///
/// The near layer is taller, which is what makes the two read as distance rather
/// than as one ridge drawn twice.
pub const MOUNTAIN_HEIGHT_FRAC: [f32; MOUNTAIN_LAYERS] = [0.16, 0.24];
/// Where the ridge base sits, as a fraction of the viewport height.
///
/// Below the sun and moon arc's horizon (0.82) so the ridge line crosses the
/// gradient rather than floating in the middle of it.
pub const MOUNTAIN_BASE_FRAC: f32 = 0.86;
/// How far each layer's silhouette is faded toward the sky colour, far to near.
///
/// Aerial perspective: distance washes a silhouette out toward the colour of the
/// air in front of it. Without it two layers in the same ink are a single shape
/// with a seam in it.
pub const MOUNTAIN_HAZE: [f32; MOUNTAIN_LAYERS] = [0.62, 0.38];
/// Noise cells across one ridge. Higher is a jagged skyline, lower is rolling
/// hills; 6 is a mountain range rather than either.
pub const MOUNTAIN_CELLS: u32 = 6;
/// Octaves of value noise in the ridge profile.
pub const MOUNTAIN_OCTAVES: u32 = 3;

/// Soft blobs drifting across the sky layer.
pub const CLOUD_COUNT: usize = 12;
/// Drift speed, px/s. Slow enough that it reads as weather rather than as motion.
pub const CLOUD_DRIFT: f32 = 6.0;
/// Scroll factor for the cloud band — between the far mountains and the near.
pub const CLOUD_PARALLAX: f32 = 0.14;
/// Cloud sprite size, in px, before per-cloud scaling.
///
/// Roughly 2:1. Squatter than that and the lobes have nowhere to sit; at 256x96
/// they were clipped into a horizontal smear that read as haze, not as cloud.
pub const CLOUD_TEX_W: u32 = 220;
pub const CLOUD_TEX_H: u32 = 110;
/// Per-cloud scale range, so twelve draws of one texture do not read as twelve
/// copies of one cloud.
///
/// The top of the range is what decides how much sky one cloud eats: at 1.45 on
/// a 220 px texture a single cloud is a quarter of a 1280 px screen, which reads
/// as weather closing in rather than as a cloud passing.
///
/// **Up ~30% for §E11.** Was 0.42/0.95, and that range was chosen against a bug:
/// `parallax.ts` set a display size and then called `setScale` on the same
/// sprite, which overrides it, so a cloud was drawn at its *native atlas frame*
/// size scaled — measured, 33 to 288 px wide against the 220 this pair is
/// multiplied by. The range was tuned to a number nothing read.
pub const CLOUD_SCALE_MIN: f32 = 0.55;
pub const CLOUD_SCALE_MAX: f32 = 1.24;
/// Per-cloud brightness, as a multiplier on the phase's own colour set (§E11).
///
/// **Within the set, never across it.** §C14 decides *which* set a cloud comes
/// from — white by day, grey at dusk, black at night — and this varies how light
/// or dark one cloud is inside that choice, so the sky has depth without a white
/// cloud appearing at midnight. The top of the band is 1.0 rather than higher:
/// above it the tint would brighten past the art's own white and the darker
/// sets would start to look washed rather than varied.
pub const CLOUD_BRIGHT_MIN: f32 = 0.62;
pub const CLOUD_BRIGHT_MAX: f32 = 1.0;
/// Per-cloud opacity, as a multiplier on `CLOUD_ALPHA` (§E11).
///
/// A separate axis from brightness because they do different things: brightness
/// is how lit a cloud is, alpha is how thick. Varying only one gives twelve
/// clouds of one density in twelve shades, which still reads as a sheet.
pub const CLOUD_ALPHA_MIN: f32 = 0.7;
pub const CLOUD_ALPHA_MAX: f32 = 1.0;
/// The band of the viewport clouds occupy, as fractions of its height.
pub const CLOUD_BAND_TOP: f32 = 0.04;
pub const CLOUD_BAND_BOTTOM: f32 = 0.46;
/// Cloud opacity at full day. Night and dusk scale down from here.
pub const CLOUD_ALPHA: f32 = 0.62;
/// How far a cloud's drift speed may vary from the mean, as a fraction.
///
/// 0 makes the twelve move as one sheet, which reads as the camera panning
/// rather than as weather.
pub const CLOUD_SPEED_SPREAD: f32 = 0.6;
/// How much of the sky's own colour a cloud takes, 0 = white, 1 = the sky.
///
/// A cloud is lit by the sky it is in — see `cloudTint`, which derives the whole
/// tint from the gradient so the two cannot disagree.
pub const CLOUD_SKY_MIX: f32 = 0.55;
/// Cloud opacity at zero sky luminance, as a fraction of `CLOUD_ALPHA`.
///
/// Not 0: an unlit cloud is a silhouette against the stars, not nothing.
pub const CLOUD_ALPHA_FLOOR: f32 = 0.4;

/// Width of one baked ridge tile, in px. The profile wraps over exactly this.
pub const RIDGE_TEX_W: u32 = 1024;
/// How far the theme's rock is darkened toward black for a silhouette.
///
/// A silhouette is what the land looks like with no light on it, not the land at
/// half brightness — which is why this is well past 0.5.
pub const MOUNTAIN_INK: f32 = 0.55;

// --- C16: birds ---

/// Seconds between bird spawns.
///
/// Eighteen, so a bird is an occasional event rather than scenery. It is also the
/// supply cadence: with `BIRD_MAX` 4 alive and a crossing taking roughly a map
/// width at `BIRD_SPEED`, the sky is never empty for long on a large map and
/// never crowded on a small one.
pub const BIRD_INTERVAL: f32 = 18.0;
/// Birds alive at once. Four — the cap that keeps them cheap (§C16).
pub const BIRD_MAX: usize = 4;
/// Cruising speed, px/s. A metal bird flies at `BIRD_METAL_SPEED_MULT` of it.
pub const BIRD_SPEED: f32 = 70.0;
/// A normal bird dies to anything that touches it.
pub const BIRD_HEALTH: f32 = 1.0;
/// A metal bird takes real ordnance.
///
/// **25, which is above every single hit a normal bird dies to and below a
/// bazooka's direct damage** — so "a metal bird survives a hit that kills a
/// normal one" is a property of the numbers, not of a test fixture.
pub const BIRD_METAL_HEALTH: f32 = 25.0;
/// Share of birds that are metal.
pub const BIRD_METAL_CHANCE: f32 = 0.25;

/// The §C16 invariant, checked by the compiler rather than by a test.
///
/// "A metal bird survives a hit that kills a normal one" is a property of these
/// two numbers, and a runtime `assert!` on two constants is an assertion that
/// cannot fail — which clippy says out loud. A `const` assertion cannot compile
/// if the numbers ever cross.
const _: () = assert!(
    BIRD_METAL_HEALTH > BIRD_HEALTH,
    "a metal bird must be the tougher one (§C16)"
);
/// A metal bird is the slower one, likewise.
const _: () = assert!(BIRD_METAL_SPEED_MULT < 1.0);
/// A metal bird is slower, which is most of what makes it readable as the
/// tougher one before you have shot at it.
pub const BIRD_METAL_SPEED_MULT: f32 = 0.6;

/// The bird's hit box, and the sprite's footprint.
pub const BIRD_W: f32 = 20.0;
pub const BIRD_H: f32 = 14.0;

/// Vertical amplitude of the sine path, px.
pub const BIRD_WAVE_AMPLITUDE: f32 = 26.0;
/// Seconds per full sine cycle. Slow enough to read as gliding rather than
/// flapping through a waveform.
pub const BIRD_WAVE_PERIOD: f32 = 3.4;

/// Band the flight altitude is drawn from, as a height **above the map's median
/// surface** — not as a fraction of map height.
///
/// Measured, because the obvious version does not work. The generator clamps the
/// tallest terrain to `SKY_MARGIN` (96) at every scale, so "above all terrain" is
/// the top 96 px of the world — while the median surface sits at y=575 (small),
/// 771 (medium) and 1160 (large). At `CAMERA_ZOOM` 2 the camera shows ±180 px, so
/// a bird up there is **never on screen**, and §C16's whole point is that you
/// look up and shoot one.
///
/// So birds fly a readable distance over the ground the players are standing on,
/// and they are drawn **behind** the terrain — which is what §C16's "no collision
/// with terrain" should look like: a bird crossing a mesa slides behind it.
pub const BIRD_ALTITUDE_ABOVE_MIN: f32 = 120.0;
pub const BIRD_ALTITUDE_ABOVE_MAX: f32 = 280.0;

/// How far past the wall a bird spawns and despawns.
///
/// Wide enough that a bird is never seen appearing or vanishing: it enters and
/// leaves off-screen at every map scale.
pub const BIRD_EDGE_MARGIN: f32 = 48.0;

/// Downward speed given to a bird's drop, px/s.
///
/// Zero would work — gravity does the rest — but a small push makes the drop
/// separate from the death puff immediately, which is what makes the reward
/// legible (§C16: "the drop must visibly fall to a place you can reach").
pub const BIRD_DROP_VELOCITY: f32 = 40.0;

// ---- v5 amendments ----  mirrors docs/73-amendments-v5.md

// --- D1: a sprite's alpha becomes terrain ---

/// Alpha strictly above this is solid when a sprite is thresholded into the
/// terrain mask (§D5).
///
/// It is also the threshold `scripts/catalogue-sprites.mjs` measured the packs'
/// bounding boxes and fill ratios with, so §D0's table and the pipeline's output
/// describe the same pixels. Changing it here without regenerating the catalogue
/// would make the two disagree.
pub const OBJECT_ALPHA_THRESHOLD: u8 = 128;

// --- D4: scale is measured in player-heights ---

/// Target height of a category's **average** object, in multiples of `PLAYER_H`
/// (§D4).
///
/// The packs are already large — a mean rock is 93x67 against a 16x28 player —
/// so three of these four scale *down*, which is the opposite of the brief's
/// assumption and follows from §D0's measurements.
///
/// **One factor for the whole category**, measured as
/// `PLAYER_H * <this> / mean_opaque_height`, and then applied to every sprite's
/// own bounds. So the average object in the category lands on the target and the
/// spread around it survives: a small crystal stays small, a big rock stays big.
///
/// Dividing each sprite by *its own* height instead would put all 40 crystals on
/// exactly the target and flatten the variety the packs are here for. The mean
/// is taken from the sprites the build actually selects, not from §D0's printed
/// number — for ruins those differ, because §D0 averages 164 files including
/// four contact sheets that are not objects.
///
/// These four are the **only** place an object size lives. The factors, every
/// mask extent and the atlas are derived at build time, so adjusting one of these
/// and rerunning `scripts/build-object-masks.mjs` is the whole edit.
pub const OBJECT_TARGET_PLAYER_H_BUSH: f32 = 1.5;
/// A boulder you hide behind. §D4.
pub const OBJECT_TARGET_PLAYER_H_ROCK: f32 = 2.25;
/// A landmark you can shoot. §D4.
pub const OBJECT_TARGET_PLAYER_H_CRYSTAL: f32 = 1.5;
/// Architecture — the only category scaled up. §D4.
pub const OBJECT_TARGET_PLAYER_H_RUIN: f32 = 3.0;

// --- D5: placement ---

/// Minimum distance between two object centres, px (§D5).
///
/// Objects are stamped as solid terrain, so two that overlap become one blob with
/// no seam — which is not a bug, but it is not variety either. 64 is a little
/// under the mean scaled rock's width, so a pair can touch and interlock while a
/// clump of five cannot form.
pub const OBJECT_MIN_SEPARATION: i32 = 64;

/// Keep spawn points and teleport pads this far from an object centre, px (§D5).
///
/// **Enforced from the metadata side**, not at stamp time: pass 6b runs before
/// pass 8, so when objects are placed no spawn or pad exists yet to avoid. §D3
/// requires that order — spawns must be chosen from a surface that already has
/// the objects in it, or players spawn inside rocks. So the objects go down
/// first, and spawn and pad selection then skips any candidate within this of one.
pub const OBJECT_CLEAR_OF_SPAWN: i32 = 96;

/// Most of the map, as a fraction of its area, that objects may add (§D5).
///
/// **Measured in pixels added, not in objects placed**, because a ruin is worth
/// twenty bushes and a count cannot tell the two apart. Placement stops at the
/// cap even if the per-scale count has not been reached — which is what stops a
/// large map becoming a forest.
pub const OBJECT_PIXEL_BUDGET: f32 = 0.02;

/// Rejection-sampling attempts per object before placement gives up (`docs/32` §2).
///
/// Capped, then stop: on a heavily carved map there may be nowhere left that
/// satisfies the separation, and a loop that keeps trying never returns. Placing
/// fewer objects than asked is a fine outcome; hanging is not.
pub const OBJECT_PLACE_ATTEMPTS: u32 = 200;

/// How much of an object's own width must rest on ground, to place it (§E12).
///
/// `is_standable` tests a `PLAYER_W`-wide box, which is the right question for a
/// player and the wrong one for scenery: a rock three player-widths across has
/// its centre supported and its outer base columns over air, and that is the
/// mid-air look — worse at the sizes above, not better.
///
/// **What the rule permits, stated plainly.** The object is seated at the
/// *median* ground height under its footprint, so roughly half its base is
/// buried in the slope and half stands proud. Partial burial is correct and
/// wanted: a boulder half-sunk in a hillside is what a boulder looks like.
/// Hanging is not, so a majority of the base must be within
/// `OBJECT_SEAT_BAND` of where it is seated. A rock spanning a chasm fails this;
/// a rock on a slope passes it.
pub const OBJECT_FOOTPRINT_SUPPORT: f32 = 0.6;

/// How far the ground may deviate from an object's seated base and still count
/// as supporting it, as a fraction of the object's **own height** (§E12).
///
/// A fraction rather than a pixel count because the objects differ by 3x in
/// height: a band that reads as "nestled" under a 42 px rock reads as "floating"
/// under a 28 px bush and as "buried" under an 84 px ruin.
pub const OBJECT_SEAT_BAND: f32 = 0.25;

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
    // MapGenerator::V2 (the landscape generator). Deliberately small numbers:
    // these are *features* scattered over open ground, not the medium the map is
    // made of.
    /// Floating islands hung in the sky above the ground.
    pub island_count: u32,
    /// Canyons cut down through the ground profile.
    pub chasm_count: u32,
    /// Flat-topped columns raised out of the ground profile.
    pub mesa_count: u32,
    /// Caves cut into the rock, each with a shaft to the sky.
    pub cave_count: u32,
    /// Horizontal bores through a hill.
    pub arch_count: u32,
    /// Destructible scenery stamped into the terrain at pass 6b (§D5).
    ///
    /// **Small is 12, not §D5's 18** — measured, not guessed. A small map is
    /// 2048x1024 and yields ~50-70 standable candidates at `SURFACE_SAMPLE_STEP`;
    /// 18 objects at a 96 px `OBJECT_CLEAR_OF_SPAWN` radius blanket most of them,
    /// and six spawns `SPAWN_MIN_SEPARATION` apart will not come out of what is
    /// left. Over 333 Small seeds:
    ///
    /// | count | failed | attempts[1..5] | safe preset | smallest pool |
    /// |---|---|---|---|---|
    /// | 18 | 103 | 103, 69, 58, 35, 26 | 5 | 6 |
    /// | 15 | 26 | 209, 72, 26, 16, 6 | 0 | 9 |
    /// | **12** | **0** | **283, 46, 4, 0, 0** | **0** | **13** |
    /// | 10 | 0 | 320, 13, 0, 0, 0 | 0 | 14 |
    /// | 8 | 0 | 330, 3, 0, 0, 0 | 0 | 14 |
    ///
    /// 12 is the largest that sits alongside Medium (301, 29, 3) and Large
    /// (297, 28, 5, 3) — and it is cheaper than Large, which still spends three
    /// seeds at four attempts. Going lower buys attempts nobody was short of and
    /// costs the liveliness the feature exists for.
    ///
    /// **Large is 36, not §D5's 48**, for the same reason and measured the same
    /// way. The 999-seed sweep was clean before objects existed
    /// (Large `[0, 323, 10, 0, 0]`, `safe_preset` 0) and 48 pushed three seeds
    /// past the `attempts > 3` guard. Over 333 Large seeds:
    ///
    /// | count | failed | attempts[1..5] | safe preset | smallest pool | fraction min |
    /// |---|---|---|---|---|---|
    /// | 48 | 3 | 297, 28, 5, 3, 0 | 0 | 8 | 0.761 |
    /// | 40 | 1 | 323, 9, 0, 1, 0 | 0 | 12 | 0.754 |
    /// | **36** | **0** | **325, 8, 0, 0, 0** | **0** | **14** | **0.751** |
    /// | 32 | 0 | 323, 10, 0, 0, 0 | 0 | 26 | 0.773 |
    ///
    /// 36 is the largest clean count and lands on the baseline's own attempt
    /// distribution. 32 buys a wider `fraction min` and nothing else: validation
    /// rejects anything under `MIN_TRAVERSABLE_FRACTION` and retries, and
    /// `safe_preset` is 0, so every accepted map is above the floor by
    /// construction — the min is where the accepted tail sits, not a near-miss.
    ///
    /// Medium 30 is §D5's own number and measured clean at
    /// `[0, 301, 29, 3, 0]`.
    pub object_count: u32,
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
                island_count: 2,
                chasm_count: 1,
                mesa_count: 1,
                cave_count: 2,
                arch_count: 1,
                object_count: 9,
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
                island_count: 3,
                chasm_count: 2,
                mesa_count: 2,
                cave_count: 2,
                arch_count: 1,
                object_count: 28,
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
                island_count: 4,
                chasm_count: 3,
                mesa_count: 3,
                cave_count: 2,
                arch_count: 2,
                object_count: 36,
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

// --- E2/E5: lobbies ---

/// How many seats a lobby **fills to**, and shows.
///
/// Not the seat cap: `MAX_PLAYERS` (6) is still that, and stays the hard limit
/// (`docs/74-amendments-v6.md` §E5). This is the target §E2 fills a public lobby
/// to before starting, which is why `BOT_COUNT=5` alongside one human is a legal
/// six-seat game and needs no second capacity concept.
pub const LOBBY_CAPACITY: usize = 5;

/// Seconds a public lobby waits before filling its empty seats with bots (§E2).
///
/// Measured from the moment the **first** player is seated, and it **does not
/// reset** when others join: a player who has waited ten seconds is not made to
/// wait twenty because somebody else arrived. A private lobby has no timeout at
/// all (§E3) — it starts when everyone is ready.
pub const LOBBY_BOT_TIMEOUT: f32 = 10.0;

// --- E10: bots that explore, arm themselves and run ---

/// Health below which a bot breaks contact instead of closing (§E10).
///
/// Below `HEAL_BELOW` (40) a bot already reaches for a medkit, and this sits
/// under it on purpose: heal first if you can, run only when that has not saved
/// you. The gap is what stops a bot with a medkit in its bag running away
/// instead of using it.
pub const BOT_FLEE_HEALTH: f32 = 35.0;

/// Side of one cell in a bot's coverage grid, in map pixels (§E10).
///
/// A bot marks the cell it is standing in and heads for the nearest unmarked
/// one. **That is the whole model** — a grid of visited cells and a direction,
/// not pathfinding, and it is sized so a small map is a few dozen cells rather
/// than thousands: the grid is per-bot state carried for the whole round, and
/// five bots on a large map is 5 x 128 bits.
pub const BOT_EXPLORE_CELL: i32 = 256;

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
    fn the_floor_and_sky_fit_inside_the_smallest_map() {
        let p = MapScale::Small.params();
        assert!(FLOOR_CRUST + SKY_MARGIN < p.height);
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
