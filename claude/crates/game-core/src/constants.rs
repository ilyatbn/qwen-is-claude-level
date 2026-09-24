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
// Zero-g locomotion (T22.03)
// ---------------------------------------------------------------------------

/// How long a jump-off-a-rock burns the thrusters for, in space.
///
/// **A burn time, not a bare fraction of the tank**, so that
/// [`SPACE_JUMP_FUEL`] below is literally *"what holding the thrusters for this
/// long costs"* and a retune of `JETPACK_DRAIN` moves both together. The owner:
/// *"Jumping and even moving now takes jetpack energy."*
pub const SPACE_JUMP_BURN_SECONDS: f32 = 0.5;

/// What one jump costs the tank in space.
///
/// # The value, against a basis that does not move with it
///
/// Pinning every test to this constant would leave nothing able to report the
/// *value* being wrong (`CLAUDE.md`), so here is what it has to be true of, in
/// terms of numbers that are not derived from it:
///
///  - **a full tank buys 10 jumps**, and
///  - **one jump is bought back by 1.0 s of not thrusting**, on top of
///    `JETPACK_REFILL_DELAY`.
///
/// Both are **literals** in `player::space::a_full_tank_buys_ten_jumps_and_a_dry_one_refuses`,
/// which counts jumps until one is refused and counts the ticks until the tank
/// is full again. They were written as `JETPACK_MAX_FUEL / SPACE_JUMP_FUEL` and
/// `SPACE_JUMP_FUEL / JETPACK_REFILL` — *the division this comment claimed the
/// test did not restate*. Measured: planting `SPACE_JUMP_BURN_SECONDS` 0.5 →
/// 0.25 left **all 1166 game-core tests passing**, because both expectations
/// halved with the behaviour. That is the `CLAUDE.md` lesson happening again,
/// inside the doc comment written to avoid it.
///
/// # What ten jumps buys, measured by driving the simulation
///
/// **Ten is ten *launches*, and a launch only gets you somewhere if something
/// stops you at the far end.** R1 gives you that for free when you arrive
/// against a rock. When you have to arrest your own momentum, the return leg
/// costs about as much as the jump did:
///
/// | manoeuvre | measured, on one tank |
/// |---|---|
/// | pushes off a rock | **10** |
/// | jump-and-return round trips (jump, thrust back, land) | **3** |
/// | the same wearing Ironman boots | **2** |
///
/// Arresting a bare 430 px/s launch at `JETPACK_THRUST_DOWN` costs 0.478 s of
/// burn, and a booted 645 px/s one costs 0.717 s — so boots buy height per jump
/// and cost range per tank (`M22-RULINGS` R41). An earlier version of this
/// comment said ten pushes meant *"traversing an asteroid field on legs alone is
/// a real option"*; that was never measured, and the round-trip number is what
/// was. The three is asserted alongside the ten.
pub const SPACE_JUMP_FUEL: f32 = JETPACK_DRAIN * SPACE_JUMP_BURN_SECONDS;

// ---------------------------------------------------------------------------
// The thruster plume (T22.04) — drawing only
// ---------------------------------------------------------------------------
//
// **No new fuel constant.** T22.04 asked for *"one constant"* for the thrust
// cost; `T22.03` had already landed it as `JETPACK_DRAIN`, charged through the
// one `JetpackState` the space thrusters share with the jetpack
// (`player::space::tests::thrusting_costs_fuel_walking_on_a_rock_does_not_and_gravity_is_free`).
// A `SPACE_THRUST_DRAIN` equal to it would be a second author of the same rate.
// The escape ceiling `T22.11` feared this number would set is against thrust
// *acceleration* (`M22-RULINGS` R46, `SPACE_WELL_ACCEL_MAX`), not against fuel.

/// T22.04: the plume's length from the edge of the body outward, px. Longer than
/// the body, so the burst reads past the head it starts behind (the drawn sprite
/// overshoots `PLAYER_H` and covers the nozzle end).
pub const THRUSTER_PLUME_LENGTH: f32 = PLAYER_H * 1.4;
/// T22.04: the plume's width at its base, px — one body width, so a sideways
/// plume is no taller than the legs it comes out beside.
pub const THRUSTER_PLUME_WIDTH: f32 = PLAYER_W;
/// T22.04: below this speed, px/s, velocity has no direction worth drawing and
/// the plume points down — see `thrusterPlume-math.ts::plumeDir`. One tick of the
/// weakest thrust (`JETPACK_THRUST_DOWN * SIM_DT` = 15 px/s) clears it.
pub const THRUSTER_PLUME_MIN_SPEED: f32 = 1.0;

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
/// Damage multiplier while a shield generator is **held and paying** (T20.08).
///
/// **`docs/21` is reversed here and `docs/` is not amended** — the coordinator
/// asked for it directly and the discrepancy is journalled, not edited away:
/// `:16` declares `shield_until`, `:46` describes the 20 s timer a use starts,
/// `:51` says the shield is *"a flat damage reduction, **not a pool** — it has no
/// hit points"*, and `:158` describes re-application replacing the timer. A
/// generator that is carried and spends energy per hit is exactly a pool.
/// **`:129` is unaffected**: knockback still applies through a shield.
///
/// `docs/21:82` — *"Multiply by `SHIELD_DAMAGE_MULT` if the shield is active"* —
/// stays true, so the **name** is honest and only the value moves, 0.5 → 0.75.
/// That is the brief's *"reduces damage by 25 % for each hit"*.
pub const SHIELD_DAMAGE_MULT: f32 = 0.75;
/// Energy spent by a held generator to absorb **one** hit (T20.08).
///
/// The old shield was a 20 s timer draining `SHIELD_DRAIN`/s, so its cost was a
/// function of how long you kept it up. The cost is per **hit** now, which is
/// what makes it a pool: `BATTERY_MAX` of 100 buys a hundred absorptions, and
/// every one of them is a laser shot you cannot fire.
pub const SHIELD_HIT_COST: f32 = 1.0;
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
/// What **carrying** a flashlight does to your sight radius at night (T20.07).
///
/// **This reverses `docs/72` §C13 and the task file records the override.** The
/// old `FLASHLIGHT_AMBIENT_MULT` was 0.65: the light *shrank* ambient sight and
/// bought a cone, a trade. The coordinator asked for the opposite and for it to
/// be passive — *"when picked up, it increases your view/light radius by 50 % at
/// night… It doesn't have to be the active item, just in the inventory."*
///
/// **Gated on night.** `fov_radius` lerps `FOV_DAY` → `FOV_NIGHT` by darkness, and
/// this multiplies only where that lerp has somewhere to go: a torch at noon is
/// not a telescope, and an unconditional 1.5x would make the flashlight the
/// strongest item in the game during the phase it is least needed.
pub const FLASHLIGHT_FOV_MULT: f32 = 1.5;
/// What carrying one does to §F9's fog veil (T20.07).
///
/// The brief says *"makes the heavy fog background 20 % more visible"*, which is
/// three different pictures, and the task file asks for a choice with a reason.
/// `FOG_SCREEN_ALPHA` is 0.8, so:
///
///  - **alpha x 0.8 → 0.64.** The veil is 20 % less opaque. **Chosen.**
///  - alpha − 0.2 → 0.6. Additive, and it inverts: at a light fog of alpha 0.15 a
///    flashlight would erase the effect entirely, and below that go negative. A
///    rule that can cancel the thing it modifies is the wrong rule.
///  - 20 % more *transmitted* light (`1 − a`: 0.2 → 0.24, alpha 0.76). Defensible
///    in optics and **unassertable here**: the fog arm of `fog-visible` measures a
///    sky delta of ~64 for a full veil, so 0.04 of alpha is ~3.2 units against a
///    noise floor near 5. A rule nobody can measure is a rule that breaks quietly,
///    which is the §A15 failure this project keeps paying for.
///
/// Multiplicative also keeps the benefit proportional as the fog's own ramp
/// climbs, rather than being everything at the start and nothing at the peak.
pub const FLASHLIGHT_FOG_VEIL_MULT: f32 = 0.8;
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
/// The bounds a **private lobby's** host may set the round length between, and
/// the step the panel moves in (`docs/75-amendments-v7.md` §F7).
///
/// These bound the *setting*, not `ROUND_SECONDS`, and the distinction is the
/// whole safety of §F7. `ROUND_SECONDS` is the room's default and the
/// `ROUND_SECONDS` env var overrides it; seven browser checks set that env var
/// to values far below `ROUND_SECONDS_MIN` (20 s in `round-end`, 90 s in
/// `hud-timer`) and derive their assertions from it. A private host who never
/// touches the setting keeps whatever the room was made with; only an explicit
/// `set_round_seconds` is held to this range.
///
/// `MIN` equals `ROUND_SECONDS` in the shipped configuration, which is why the
/// task table can call `MIN` the default — but they are two numbers and a
/// deployment that changes one does not change the other.
pub const ROUND_SECONDS_MIN: f32 = 240.0;
pub const ROUND_SECONDS_MAX: f32 = 600.0;
pub const ROUND_SECONDS_STEP: f32 = 60.0;
/// Grenades in §F7's `basic` starting kit. The pistol's half of that kit is
/// `PISTOL_AMMO`; this is the number that had nowhere else to live.
pub const START_KIT_GRENADES: u8 = 2;
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
    /// The zero-gravity arena: a closed elliptical rim with asteroids inside it
    /// (M22, `T22.05A`, `M22-RULINGS` R13/R15).
    ///
    /// **Derived from [`GravityMode::Space`], never chosen beside it** — see
    /// [`MapGenerator::for_gravity`]. Two independent fields would let a lobby
    /// pick space gravity and a normal map, which is *derive, do not add a
    /// fourth flag* at the largest scale in the milestone.
    Space,
}

impl MapGenerator {
    /// Parse the `MAP_GENERATOR` environment value.
    ///
    /// **There is deliberately no spelling for [`MapGenerator::Space`].** It is
    /// derived from the gravity mode (R15), and an environment variable that
    /// could select it alongside standard gravity is exactly the second source
    /// of truth the ruling forbids — players would fall off the asteroids into
    /// a void with no vortex to catch them. `config.rs` already names the valid
    /// values as *"one of: v1, v2"*, so a `MAP_GENERATOR=space` fails loudly
    /// with that message rather than half-working.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "v1" | "V1" | "1" => Some(MapGenerator::V1),
            "v2" | "V2" | "2" => Some(MapGenerator::V2),
            _ => None,
        }
    }

    /// The generator a round is played on, given its gravity and the lobby's
    /// own choice. **The one derivation** (`M22-RULINGS` R15).
    ///
    /// Space gravity means the space map and nothing else. Any other gravity
    /// gets the lobby's generator — except `Space`, which cannot be reached
    /// through `parse` and is collapsed here rather than trusted, so a value
    /// arriving from a replay header or a wire byte cannot produce a space map
    /// under standard gravity.
    pub const fn for_gravity(gravity: GravityMode, chosen: MapGenerator) -> MapGenerator {
        match (gravity, chosen) {
            (GravityMode::Space, _) => MapGenerator::Space,
            (_, MapGenerator::Space) => DEFAULT_MAP_GENERATOR,
            (_, g) => g,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            MapGenerator::V1 => "v1",
            MapGenerator::V2 => "v2",
            MapGenerator::Space => "space",
        }
    }

    pub const fn to_u8(self) -> u8 {
        match self {
            MapGenerator::V1 => 0,
            MapGenerator::V2 => 1,
            MapGenerator::Space => 2,
        }
    }

    pub const fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(MapGenerator::V1),
            1 => Some(MapGenerator::V2),
            2 => Some(MapGenerator::Space),
            _ => None,
        }
    }

    /// **`Space` is in here on purpose** (R15). `tests/golden.rs::cases()`
    /// iterates this list x 4 seeds x `MapScale::ALL`, so the golden table grows
    /// 24 -> 36 rows the moment the variant lands, and `tests/dump_maps.rs`
    /// follows. A `GravityMode` branch inside an existing generator would have
    /// gained `cases()` nothing and shipped the space map with **zero** golden
    /// coverage.
    pub const ALL: [MapGenerator; 3] = [MapGenerator::V1, MapGenerator::V2, MapGenerator::Space];
}

/// The generator you get unless `MAP_GENERATOR` says otherwise.
pub const DEFAULT_MAP_GENERATOR: MapGenerator = MapGenerator::V2;

// ---------------------------------------------------------------------------
// The space map (M22 `T22.05A`, `M22-RULINGS` R13). `map/gen/space.rs`.
// ---------------------------------------------------------------------------

/// Nominal thickness of the space map's rim, in px — the diameter of the discs
/// [`crate::map::gen::space::stamp_rim`] lays on the centreline.
///
/// **What the mask delivers is 29.75-30.00 px, not 32**, and the gap is a
/// property of the construction rather than noise: the disc chain steps in
/// ellipse parameter, so its spacing varies 2:1 and it scallops between
/// centres. `stamp_rim`'s doc derives the number and
/// `space.rs::the_rim_is_thicker_than_one_minimap_cell` measures it off the
/// mask and asserts the window. **This constant is what is asked for; that test
/// is what is got** (R34 — the commit that landed the rim recorded this value
/// as the measurement).
///
/// **The floor is one minimap cell.** `Minimap::resampleTerrain` point-samples
/// `core.solidAt` once per cell, so a rim thinner than `mapW / MINIMAP_W` —
/// 10.24 px on Small, 15.36 on Medium, **20.48 on Large** — aliases into a
/// broken dashed ring or vanishes (R13, point 2). The delivered 29.75 px clears
/// the worst of those by 45 %, which is the margin that makes the shortfall a
/// documentation bug rather than a geometry one.
pub const SPACE_RIM_THICKNESS: u32 = 32;

/// Clear space between an asteroid's surface and the rim's inner edge, px.
///
/// **Four player widths** (`PLAYER_W` = 16), the same basis as its neighbour
/// `SPACE_ASTEROID_GAP_MIN` — so the lane along the rim is four bodies wide and
/// the lane between two rocks is five. (An earlier comment here said *"two
/// player heights"*, which is 56, not 64.) A rock flush against the rim would
/// close the lane a player flies down to follow the boundary, and `T22.10`'s
/// vortex needs that lane to work in.
///
/// `space.rs::no_asteroid_pixel_touches_the_rim` measures the lane off the
/// mask, so this number is an assertion about pixels rather than about floats.
pub const SPACE_RIM_CLEARANCE: f32 = 64.0;

/// Asteroid bounding radius, px. Drawn **uniformly** on this band.
///
/// Uniform rather than biased small, and that is the whole reason the five
/// gravity levels are meetable: the level is monotone in radius, so a
/// small-biased radius distribution makes level 5 a once-a-session curiosity.
/// The lower bound is set by `MIN_BLOB_PX`: at `SPACE_ASTEROID_CORE_FRAC` the
/// smallest rock's core disc is pi*18^2 = 1018 px, 2.5x the 400 px speck
/// threshold that `components::cleanup` — a pass the space pipeline skips —
/// would otherwise have enforced.
pub const SPACE_ASTEROID_R_MIN: i32 = 24;
pub const SPACE_ASTEROID_R_MAX: i32 = 64;

/// Minimum clear gap between two asteroid **surfaces**, px.
///
/// Five player widths (`PLAYER_W` = 16). Surface to surface rather than centre
/// to centre, so the lane a player floats down does not depend on the sizes of
/// the two rocks that happen to bound it. Far below `JETPACK_CLIMB_BUDGET`
/// (780 px), which is what makes every lane crossable.
pub const SPACE_ASTEROID_GAP_MIN: f32 = 80.0;

/// Rejection-sampling tries per asteroid asked for — a **shared pool**, not a
/// per-rock budget.
///
/// `place_asteroids` loops `0..(asteroid_count * SPACE_ASTEROID_TRIES)` with one
/// `break` when the target is met, so a rock that seats on its first draw hands
/// its unspent 39 tries to the rest. That is the right shape for sequential
/// adsorption — late rocks are much harder to seat than early ones, so the
/// budget has to be spendable where the difficulty is — but it is a flat total
/// and the doc here used to say the opposite.
pub const SPACE_ASTEROID_TRIES: u32 = 40;

/// The core disc of an asteroid, as a fraction of its bounding radius.
///
/// Under 1 so the lumps have somewhere to stick out to without leaving the
/// bounding radius — which has to stay the true bound, because it is what rocks
/// are spaced by, what reach is measured by, and what `T22.11` sizes a well
/// from.
pub const SPACE_ASTEROID_CORE_FRAC: f32 = 0.75;

/// Lumps stamped on an asteroid's core, and their radii as a fraction of the
/// bounding radius. Enough to break the silhouette; not so many that the union
/// fills the bounding disc back out to a circle.
pub const SPACE_LUMPS_MIN: u32 = 2;
pub const SPACE_LUMPS_MAX: u32 = 4;
pub const SPACE_LUMP_R_MIN_FRAC: f32 = 0.30;
pub const SPACE_LUMP_R_MAX_FRAC: f32 = 0.45;

/// The highest asteroid gravity level. Levels run `1..=SPACE_LEVEL_MAX`.
pub const SPACE_LEVEL_MAX: u8 = 5;

/// Jitter on the radius-to-level map, in levels.
///
/// R13 requires the correlation to be **monotone with jitter**: a big rock with
/// a weak pull reads as wrong, but a map that is exactly a size lookup makes
/// level 5 mean nothing but "the biggest rock on this map". 0.6 moves a rock by
/// at most one level and the correlation survives — asserted by
/// `space.rs::a_bigger_rock_pulls_harder_on_average`.
pub const SPACE_LEVEL_JITTER: f32 = 0.6;

/// Grid step the open-space spawn candidates are walked on, px.
///
/// A quarter of `SPAWN_MIN_SEPARATION` (256), so the sampler that picks six of
/// them from the grid is not limited by the grid's own resolution.
pub const SPACE_SPAWN_GRID: i32 = 64;

/// Rejection-sampling attempts for one point in open space (`T22.05B`).
///
/// `map::gen::space::random_open_space` draws uniformly from the rim ellipse's
/// **bounding box** and keeps the first point a player box fits in — so a draw
/// fails on the box corners outside the rim as well as on rock.
///
/// **The basis is a measured rate, not a round number.** Over 60 seeds x 3
/// scales, `space::tests::the_open_space_hit_rate` reports a single draw
/// succeeding **0.534 / 0.569 / 0.592** of the time on Small / Medium / Large.
/// At the worst of those, 24 attempts all miss with probability **1.1e-8** —
/// against roughly one crate a minute, one item batch every
/// `ITEM_SPAWN_INTERVAL`, and a round measured in minutes.
///
/// `random_open_space_finds_a_point_on_every_seed` re-derives that probability
/// from the rate it measures, so this number is checked against the map rather
/// than against itself. **If it ever fires, this constant is the wrong end to
/// change it from** — the arena got crowded, and the crate has nowhere to go
/// whatever the budget is.
pub const SPACE_OPEN_SPACE_TRIES: u32 = 24;

// ---------------------------------------------------------------------------
// Asteroid gravity wells (T22.11B, `M22-RULINGS` R46 and R47)
// ---------------------------------------------------------------------------
//
// The field itself, its summation and every assertion below live in
// `world::attractors`. These four numbers are the whole tunable surface.

/// How much of the jetpack's **weakest** axis a level-[`SPACE_LEVEL_MAX`] well
/// is allowed to spend, at the closest a player body can get to a rock.
///
/// **The weakest axis is `JETPACK_THRUST_DOWN` (900), not `JETPACK_THRUST_UP`
/// (2200)** — `M22-RULINGS` R46, which overturns R18 and the design record on
/// exactly this point. The pack is anisotropic, so the binding case is a player
/// who has come to rest on the **underside** of a rock and must push *downward*
/// to leave it. A well pinned to the up-thrust would pass a guard named *"escape
/// is possible"* while trapping that player forever, with nothing on screen
/// saying why.
///
/// 0.75 leaves a quarter of the down-thrust as net outward acceleration in the
/// worst case the generator can produce, which
/// `world::attractors::tests::no_well_traps_a_player_on_the_underside_of_a_rock`
/// measures over the whole table rather than at one radius.
pub const SPACE_WELL_ESCAPE_MARGIN: f32 = 0.75;

/// The pull at the **centre** of a level-[`SPACE_LEVEL_MAX`] asteroid, px/s².
///
/// A player can never be at the centre — the core disc is solid — so the pull
/// they actually feel is this number times the falloff at
/// `SPACE_ASTEROID_CORE_FRAC * r + PLAYER_H / 2.0`, which is what R46's
/// inequality bounds and what the test named above asserts.
///
/// For scale: `GRAVITY` is 1400, so the deepest rock in the game pulls at
/// roughly half of ordinary gravity at its surface, and the shallowest at about
/// a thirteenth.
pub const SPACE_WELL_ACCEL_MAX: f32 = JETPACK_THRUST_DOWN * SPACE_WELL_ESCAPE_MARGIN;

/// The reach of a level-[`SPACE_LEVEL_MAX`] well, centre to centre, px.
///
/// **Exactly one climb budget** (`M22-RULINGS` R47, point 2), which makes the
/// reach a sentence a player can feel: *a full tank always clears the deepest
/// well*. `JETPACK_CLIMB_BUDGET` already carries its own basis — *"the furthest
/// a player can climb in one unbroken effort"* — and R18 asked for the level
/// table to be derived from a measured quantity rather than from five literals.
/// This is that quantity.
pub const SPACE_WELL_REACH_MAX: f32 = JETPACK_CLIMB_BUDGET;

/// Terminal **speed** in space, px/s — a clamp on `|vel|`, applied through
/// `physics::resolve::Forces::max_speed`.
///
/// Not `MAX_FALL_SPEED`, which clamps `vel.y` downward only and means a
/// different thing (`M22-RULINGS` R10). This mode damps nothing, so without a
/// bound a player crossing a chain of wells accumulates speed with nothing to
/// give it back.
///
/// **Basis, and it is computed rather than asserted.** The fastest a *single*
/// well can make you is a free fall from its own cutoff to the closest a body
/// can get, which for the deepest well works out at **695.8 px/s** —
/// integrated, not remembered, by
/// `world::attractors::tests::space_max_speed_carries_its_basis`, which also
/// checks the two bounds R10 names: above the 367.7 px/s a diagonal jetpack burn
/// already reaches (below it, the clamp re-introduces the *"controls fighting
/// you"* complaint `jetpack::apply_thrust` refuses in as many words), and below
/// the 3840 px/s `MAX_SUBSTEPS * MAX_SUBSTEP_PX / SIM_DT` already imposes (above
/// it, the clamp is inert). 1350 is 1.94x the single-well dive, so it never
/// fires on an honest fall toward one rock and still bounds the runaway.
pub const SPACE_MAX_SPEED: f32 = 1350.0;

// ---------------------------------------------------------------------------
// T22.10: the breach vortex, and R16's void outside the rim
// ---------------------------------------------------------------------------
//
// **The rim is the only thing keeping players in the arena, and a hole in it is a
// way out.** The vortex is what makes that not true: breaching the rim does not
// let you leave, it recycles you. It is **containment dressed as a reward**, not
// decoration — a build that makes it optional ships a player floating off the map.

/// How far past the rim's **outer edge** a body may be before the void takes it,
/// px (`M22-RULINGS` R16's grace band).
///
/// **Two ticks at the fastest a body moves in space**: `SPACE_MAX_SPEED · SIM_DT`
/// is 22.5 px a tick, so a body leaving through a hole is sampled at least twice
/// between the outer edge and the void — room for the vortex's capture to run
/// first. Less than one tick's travel and a fast body could cross the band between
/// two samples; the void would then be the answer to a breach, which is the one
/// thing R16 forbids.
pub const SPACE_VOID_GRACE: f32 = 2.0 * SPACE_MAX_SPEED * SIM_DT;

/// At most this many vortices **pull** at once (`M22-RULINGS` R9, point 2). A
/// fourth breach replaces the **oldest**, which stops pulling and fades — **but
/// keeps catching** for as long as its hole is open, which is the round (R88,
/// T22.10C): a hole never heals (R9, point 3), and a hole in the rim never kills.
/// Only the pull is capped; `World::spent_vortices` holds the rest.
pub const MAX_ACTIVE_VORTICES: usize = 3;

/// A player whose centre comes within this of a vortex is taken, px — and a breach
/// this close to a live vortex is the same hole, not a new one.
///
/// **Basis (R16: capture must exceed the rim thickness plus the band):** the widest
/// single carve (`METEOR_CARVE_R`, the hole's half-width across the rim) plus the
/// whole rim thickness plus the void band. A body leaving through any part of a
/// one-carve hole is inside this disc from the rim's inner edge until it is past
/// the band: `sqrt(50² + (16 + 45)²)` = 79 px at the far corner, against 127. A
/// hole widened by more carves is still covered, because a carve that lands
/// further than this from every vortex makes its own (`World::open_vortex`).
pub const VORTEX_CAPTURE_R: f32 = METEOR_CARVE_R + SPACE_RIM_THICKNESS as f32 + SPACE_VOID_GRACE;

/// A vortex's pull at its centre, px/s² — **twice the strongest thrust**
/// (`JETPACK_THRUST_DOWN`), so it sucks. It falls off linearly to
/// [`VORTEX_REACH`] (R47's shape, through `world::attractors`), so thrust wins
/// beyond half the reach and loses inside it: the no-escape radius is exactly
/// `VORTEX_REACH / 2`.
pub const VORTEX_ACCEL_MAX: f32 = 2.0 * JETPACK_THRUST_DOWN;

/// How far a vortex pulls, centre to cutoff, px. **Four capture radii**, so the
/// no-escape radius (half the reach) is twice the capture radius: a player who
/// drifts into the band where thrust no longer wins has a capture radius of warning
/// — the swirl — before they are taken.
pub const VORTEX_REACH: f32 = 4.0 * VORTEX_CAPTURE_R;

/// Most breaches a map holds for the world to drain in one tick. The world drains
/// every tick; a client's copy of the map carves too and never drains, so the list
/// is bounded rather than trusted to be emptied.
pub const MAX_PENDING_BREACHES: usize = 8;

// --- T22.12: the black hole (`M22-RULINGS` R8, R11, R21) --------------------
//
// One per space round, arriving at a seeded moment inside the last minute, eating
// one asteroid, and staying. **A fixed size** (R8.2): one horizon, one pull, set
// here and never grown.

/// The black hole arrives inside the last this-many seconds of `Playing` (R8.1:
/// *"appears randomly at the last minute"* — every round, random timing).
///
/// **On a round shorter than this plus [`BLACK_HOLE_TELEGRAPH`]** (a dev
/// `ROUND_SECONDS`, T22.12C F8) the window is **scaled**, not clipped: it becomes
/// the round's length less the telegraph, and [`BLACK_HOLE_LATEST`] shrinks in the
/// same proportion — so the hole still arrives in the same *share* of the round and
/// its telegraph always fits after the phase begins (`black_hole::roll`). A clipped
/// window piled every short round's arrival onto the first tick of `Playing`.
pub const BLACK_HOLE_WINDOW: f32 = 60.0;

/// …and no later than this many seconds before the bell. **A builder's call,
/// recorded for the coordinator:** an arrival in the final instant is a hazard no
/// player ever meets, which reads as "it never came" — R8.1's own objection to a
/// hole that some rounds never see. So the arrival is uniform over the first
/// `BLACK_HOLE_WINDOW - BLACK_HOLE_LATEST` seconds of the last minute.
pub const BLACK_HOLE_LATEST: f32 = 10.0;

/// How long before its arrival the hole is telegraphed at the spot it will
/// open, s (R93). Sent as `black_hole_warn`: the client cannot know the arrival
/// time (the roll is the server's), so the warning is an event, not a derivation.
pub const BLACK_HOLE_TELEGRAPH: f32 = 2.0;

/// The event horizon, centre to a body's centre, px: inside it you are dead —
/// **a state change, not a force** (T22.12). The size of the largest asteroid, so
/// the hole it leaves where a rock was reads as having swallowed any rock.
/// **It is the only line the rule draws** (R90): outside it every thrust escapes,
/// inside it you are dead — the ring on screen is the whole rule.
pub const BLACK_HOLE_HORIZON_R: f32 = SPACE_ASTEROID_R_MAX as f32;

/// The pull at the horizon as a share of the **weakest** thrust (R90). Under 1, so
/// a player one pixel outside the horizon holding the thrust that points away
/// still climbs out — the asteroid wells' own rule (`SPACE_WELL_ESCAPE_MARGIN`),
/// with less headroom, because this one is meant to be nearly a trap.
pub const BLACK_HOLE_ESCAPE_MARGIN: f32 = 0.9;

/// The pull at the horizon, px/s²: `JETPACK_THRUST_DOWN × BLACK_HOLE_ESCAPE_MARGIN`
/// = 810 (R90). **DOWN, because it is the weakest thrust** (UP 2200, SIDE 1100,
/// DOWN 900) — the review's correction: sizing against UP + SIDE (T22.12A) put the
/// no-escape line at a different radius on every side, so the ring drawn at it
/// promised a rule the physics did not keep. A single-axis thrust off the radial by
/// up to the bots'/tests' diagonal threshold still carries `900 · cos 16.7° ≈ 862`
/// of it outward, above this.
pub const BLACK_HOLE_EDGE_PULL: f32 = JETPACK_THRUST_DOWN * BLACK_HOLE_ESCAPE_MARGIN;

/// How far the hole pulls, centre to cutoff, px: four horizons (R90), 256 at
/// `SPACE_ASTEROID_R_MAX` 64. **Within it the asteroid wells do not pull — only the
/// hole does** (R91, `attractors::env_at`): neighbouring rocks summed to 745 px/s²
/// at the horizon and trapped 20 of 208 flights that the hole alone lets go.
pub const BLACK_HOLE_REACH: f32 = 4.0 * BLACK_HOLE_HORIZON_R;

/// The pull at the centre, px/s²: whatever makes the linear falloff (the law every
/// attractor shares, R47) equal [`BLACK_HOLE_EDGE_PULL`] **at the horizon** —
/// `EDGE_PULL / (1 − HORIZON_R / REACH)` = 810 / 0.75 = 1080. Nobody alive is ever
/// nearer the centre than the horizon, so the number past it is never felt.
pub const BLACK_HOLE_ACCEL_MAX: f32 =
    BLACK_HOLE_EDGE_PULL / (1.0 - BLACK_HOLE_HORIZON_R / BLACK_HOLE_REACH);

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
/// **8 → 24.** The ordering is load-bearing rather than cosmetic: the bar is the
/// low indices, so `Inventory::placement_order` expresses "prefer the bar" and
/// "prefer the backpack" as two halves of one range rather than as a second rule
/// that can disagree with §C10 about which slots are selectable.
///
/// A pickup no longer simply takes the lowest free index (T21.09): a **passive**
/// item prefers the backpack, because those are the slots `select` cannot reach
/// and a passive item never needs selecting. Everything else still prefers the
/// bar, and either falls back to the other region.
pub const INVENTORY_SLOTS: usize = QUICK_SLOTS + BACKPACK_SLOTS;
/// Per slot, same item id.
pub const MAX_STACK: u8 = 9;
/// From player centre to pickup centre.
pub const PICKUP_RADIUS: f32 = 20.0;
/// A deliberately dropped item cannot be picked up again for this long (T20.09).
///
/// **Not optional, and not a nicety.** `resolve_pickups` collects anything within
/// `PICKUP_RADIUS` and a drop lands at the player's feet, so without a lock the
/// item is back in the bag on the same tick and the gesture does nothing at all.
///
/// Longer than `DEATH_DROP_LOCK`, and for a different reason: a death lock stops
/// the *killer* hoovering a corpse, while this one has to outlast the player
/// walking away from what they just put down. A second is long enough to get
/// clear at `WALK_SPEED` and short enough that a fight over a dropped weapon is
/// still a fight.
///
/// It lives **here** rather than beside `DEATH_DROP_LOCK` in `items/world.rs`,
/// which is where a new constant would naturally have gone: that one is a
/// pre-existing violation of "every numeric tunable lives in `constants.rs`"
/// (`STARTING_KIT` at `player/state.rs` is the same class), and putting a second
/// one next to it would have replicated it rather than noticed it.
pub const DROP_PICKUP_LOCK: f32 = 1.5;
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

/// **Toxic rain is switched off** (T21.39). The owner, 2026-09-15: *"Disable toxic rain
/// completely for now its not working properly."* The rewrite is parked as
/// `tasks/parking-lot/T21.41-rewrite-toxic-rain.md`.
///
/// The one switch: the scheduler never rolls it (`scheduler.rs::roll_kind`),
/// `WEATHER=toxic` is refused (`game-server/src/config.rs`), the sandbox cannot force
/// it (`game-wasm::force_effect`), and the browser checks that need it read this and
/// skip. Every line of the effect is kept, so un-parking is this flag plus the rewrite.
pub const TOXIC_RAIN_ENABLED: bool = false;

/// **Lava bursts are switched off** (2026-09-16). The owner, from play: *"the lava
/// burst is coming out of weird places. i dont like it. disable it too for now."*
///
/// The same one-switch shape `TOXIC_RAIN_ENABLED` established and for the same
/// reason: every line of the effect is kept, so switching it back on is this flag
/// plus whatever fixes the placement. The scheduler zeroes its weight, `WEATHER=lava`
/// is refused at parse, the sandbox cannot force it, and the browser checks that
/// need it read this and skip.
///
/// **Two of the four kinds are now off**, which leaves meteor showers and heavy fog
/// as the whole weather table. `roll_kind` also zeroes the kind that just ran, so
/// three of four weights can be zero at once — `a_draw_is_always_possible` is the
/// guard that this still leaves something to draw.
pub const LAVA_ENABLED: bool = false;

pub const TOXIC_DURATION: f32 = 8.0;
/// Seconds between drops while the rain is active.
///
/// Was `TOXIC_PUDDLE_EVERY`. §E15 retires that name with the puddles, but the
/// **cadence is not a puddle** — §E13 kept the scheduler and the number of drops
/// per window unchanged, so the value was carried over untouched under a name
/// that says what it times.
///
/// **§F6 moved it, 0.4 → 0.15**, which is the one number in this family that
/// changes how much rain there is: `TOXIC_DURATION / TOXIC_DROP_EVERY` goes from
/// 20 drops a shower to 54. Anything that quotes 20 is stale.
pub const TOXIC_DROP_EVERY: f32 = 0.15;
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
pub const TOXIC_POISON_DPS: f32 = 6.0;
/// How far from a landed drop the poison reaches (§F6).
///
/// **This is what makes the rain a hazard rather than a lottery.** §E13 poisoned
/// only the body the projectile point intersected, and the arithmetic of that is
/// in §F6: one drop every 0.4 s scattered across the map, against a 20 px-wide
/// player, is a shower you can stand in and statistically never be hit by.
/// Widening the target from 20 px to 20 + 2×28 and shortening the cadence takes
/// the expected hits per shower from **0.26 to 2.6** — measured as a count, not
/// as a feeling.
///
/// It is **not** a blast. `explode` carves, deals its damage instantly and throws
/// people; rain does none of those (`docs/13` §3), so this radius is used by a
/// plain distance test beside the roof rule and nothing else.
pub const TOXIC_SPLASH_R: f32 = 28.0;
/// The hole a drop leaves in the ground: bullet-sized, not a crater (§E13).
pub const TOXIC_DROP_CARVE_R: f32 = 6.0;
/// Drops in the air at once during a **full-rate** shower (§C6 × §C21, T20.05).
///
/// **The number that makes one rain out of two.** §C6 says the droplets are "a
/// particle emitter, not per-drop entities" and §C21 makes a drop a projectile
/// *"so that the rain is visible"* — two live clauses, and for five milestones
/// the game satisfied both separately: a 260-droplet screen-space sheet on a seed
/// of its own, and an unrelated set of real drops that did the carving and the
/// poisoning. A player saw a downpour and was hit by a drizzle.
///
/// The emitter's density is derived from the live drop count now, and this is
/// what that count is divided by. It is **not** `TOXIC_DURATION /
/// TOXIC_DROP_EVERY` — 54 is the cumulative count for a whole shower, against a
/// *live* on-screen figure. What is comparable is how many are in the air at one
/// instant, which is the cadence times the descent.
///
/// **Measured** (`toxic_drops_in_flight_matches_what_a_shower_actually_puts_in_the_air`),
/// three seeds x three scales: peaks run **6..=10**, with a mean of 3.9/4.3/5.8
/// while it is raining on small/medium/large at seed 4242. 7 is the medium-map
/// peak, and the test asserts the constant stays inside the measured band rather
/// than pinning one draw. `TOXIC_DROP_SPEED`'s "roughly a second of visible descent" is where this
/// number used to be guessed from; a sentence is not a measurement.
pub const TOXIC_DROPS_IN_FLIGHT: f32 = 7.0;

// --- T21.26: ambient rain — harmless, not an event ---

/// Ambient rain's schedule is cut into windows this long, each rolled on its own.
///
/// The day/night shape rather than the hazard scheduler's (`world/ambient.rs`): a
/// pure function of seed and round time, so no stream state, no telegraph and no
/// replay change. 45 s is long enough that a shower and a dry spell both register.
pub const AMBIENT_RAIN_WINDOW: f32 = 45.0;
/// Share of windows that rain. With `AMBIENT_RAIN_MIN..MAX` this is roughly a
/// sixth of the round — weather you notice, not weather you live in.
pub const AMBIENT_RAIN_CHANCE: f32 = 0.35;
/// How long one ambient shower lasts, seconds. Always shorter than the window, so
/// a shower sits wholly inside it.
pub const AMBIENT_RAIN_MIN: f32 = 12.0;
pub const AMBIENT_RAIN_MAX: f32 = 30.0;
/// Fade in and out, seconds, so the sheet never pops.
pub const AMBIENT_RAIN_RAMP: f32 = 3.0;
/// Droplets in the ambient sheet's pool. **Fewer than the toxic sheet's 260**, so
/// the harmless rain reads as a lighter rain as well as a different colour — a
/// player must not have to study the hue to know whether to run.
pub const AMBIENT_RAIN_DROPS: u32 = 160;
/// Ambient droplet colour, 0xRRGGBB: a cold grey-blue, as far from the toxic
/// sheet's `0x7fe04a` as a rain colour can sit.
pub const AMBIENT_RAIN_COLOUR: u32 = 0x9d_b8_d6;
/// Peak stroke opacity of an ambient droplet. No full-screen cast at all: the
/// toxic sheet's green wash is part of what says "acid", and this rain says nothing.
pub const AMBIENT_RAIN_ALPHA: f32 = 0.5;
/// Fall speed of an ambient droplet, world px/s (T21.31).
///
/// Was `AMBIENT_RAIN_SPEED`, a multiple (0.55) of the toxic sheet's 420..800 — and that
/// sheet is gone: toxic rain is drawn at the server's real drops now. Same speeds, as
/// numbers of their own.
pub const AMBIENT_RAIN_FALL_MIN: f32 = 231.0;
pub const AMBIENT_RAIN_FALL_MAX: f32 = 440.0;
/// Streak length of an ambient droplet, world px.
pub const AMBIENT_RAIN_STREAK_MIN: f32 = 12.0;
pub const AMBIENT_RAIN_STREAK_MAX: f32 = 26.0;
/// Stroke width of an ambient droplet, world px.
pub const AMBIENT_RAIN_WIDTH: f32 = 1.5;
/// How far down its cloud a droplet leaves from, as a fraction of the cloud's height
/// (T21.31): from the underside, so no rain is ever drawn above a cloud.
pub const AMBIENT_RAIN_SPAWN_DEPTH: f32 = 0.8;
/// Longest a droplet waits before leaving a cloud again, seconds — so a shower starts
/// as a scatter rather than one line of drops under every cloud.
pub const AMBIENT_RAIN_STAGGER: f32 = 1.2;
/// How far a raining cloud is greyed toward `CLOUD_RAIN_GREY` at full ambient rain.
pub const CLOUD_RAIN_DARKEN: f32 = 0.45;
pub const CLOUD_RAIN_GREY: u32 = 0x8e_96_9f;

// --- T21.31: toxic rain, drawn where the real drops are ---

/// The streak drawn behind each real toxic drop, world px. The drop itself is the
/// ordnance layer's dot; this is what makes it read as rain.
pub const TOXIC_STREAK_LEN: f32 = 18.0;
pub const TOXIC_STREAK_WIDTH: f32 = 2.0;
pub const TOXIC_STREAK_ALPHA: f32 = 0.9;
/// The green cast over the whole view while a shower is on, and its fade, seconds.
/// Screen-wide on purpose: "it is raining acid" is a fact about the round.
pub const TOXIC_CAST_ALPHA: f32 = 0.1;
pub const TOXIC_CAST_RAMP: f32 = 1.5;
/// The sickly deck a shower's drops leave from, along `SKY_MARGIN` (T21.31): one cloud
/// per this many world px of map width, tinted this colour, faded in with the cast.
pub const TOXIC_DECK_SPACING: f32 = 70.0;
pub const TOXIC_CLOUD_TINT: u32 = 0x8f_ae_5e;

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
/// How long a vent keeps making flames after its jet stops (§F10.2).
///
/// Kept while `LAVA_BURN_DPS` and `LAVA_BURN_RADIUS` are retired: the afterburn
/// is now a stream of flames rather than a disc, so the *window* still means
/// something and the disc's numbers do not. `effects::scheduler` reads it.
pub const LAVA_BURN_DURATION: f32 = 3.0;
/// Flames a venting mouth emits per second during that window.
pub const LAVA_FLAMES_PER_SECOND: f32 = 6.0;

pub const FOG_DURATION: f32 = 15.0;
/// Fade in and out.
pub const FOG_RAMP: f32 = 2.0;
/// Opacity of the screen-space fog veil at `strength() == 1.0` (§F9).
///
/// 0.8 is a heavy veil by design: 80 % of visibility gone is the point of an
/// effect whose whole complaint was that `FOV_FOG_MULT` alone is close to
/// invisible in daylight, which is when fog is supposed to matter.
pub const FOG_SCREEN_ALPHA: f32 = 0.8;
/// The grey the veil is filled with, `0xRRGGBB` (§F9).
///
/// A colour rather than a black scrim: fog scatters light, so it *raises* the
/// black point and flattens contrast. Darkening is night's job and it has its
/// own layer.
pub const FOG_SCREEN_COLOUR: u32 = 0x009A_A0A6;

// --- T22.08A: solar flares (`M22-RULINGS` R12, R27, R43; T22.08's R78–R85) ---
//
// A space-only weather kind: a prominence loop — a fiery ribbon arched between two
// footpoints — that wanders the map and **burns whoever it touches for
// `SOLAR_FLARE_BURN_SECONDS`**, the owner's "burns players touching it for N seconds
// (default to 4)". Its shape is a pure function of (effect seed, elapsed, map size)
// in `effects/flare.rs`, so the client re-derives it through wasm (`R80`).

/// The owner's `N`: how long a touch keeps burning you after you leave the ribbon.
/// Re-touching **rewrites** the deadline, `poison()`'s rule (`R79`) — a status you
/// can wait out, never a stacking bleed.
pub const SOLAR_FLARE_BURN_SECONDS: f32 = 4.0;
/// Burn damage per second (`R27` §5). **A full burn is `8 × 4` = 32 unsealed** —
/// about a third of `BASE_HEALTH`, dodgeable and survivable beside radiation.
/// **Sealed** (`R82`, the suit's softening per `R2`): each logged second is one hit
/// through `apply_damage`, so 32 × `SHIELD_DAMAGE_MULT` = **24 health**, and the
/// four hits cost `SHIELD_HIT_COST` each = **4 energy** — plus the 4 the seal drains
/// over those same 4 s anyway (`RADIATION_SHIELD_COST`), which is where `R82`'s
/// "24 + 8 energy" comes from. `world::solar_flare_tests::a_full_burn_costs_what_the_basis_says`
/// measures both totals, and `…::flare_basis_is_a_third_of_a_health_bar` pins the claim.
pub const SOLAR_FLARE_DPS: f32 = 8.0;
/// Seconds a flare stays `Active` after its telegraph — a little longer than a
/// meteor shower (10 s), because a flare you can see coming is a flare you can
/// leave: its danger is where it wanders, not how fast it hits.
pub const SOLAR_FLARE_DURATION: f32 = 12.0;
/// The flare's weight in the scheduler's table. With two live kinds in space and
/// never-repeat, the table alternates meteor and flare whatever this is
/// (`two_live_kinds_alternate`); it is meteor's 3 so a third live kind would start
/// from an even draw.
pub const SOLAR_FLARE_WEIGHT: u16 = 3;
/// The ribbon's half-width, world px: a body whose box comes within this of the
/// sampled centre line is touching it.
pub const SOLAR_FLARE_RIBBON_R: f32 = 14.0;
/// Distance between the loop's two footpoints, and how high it arches, world px.
pub const SOLAR_FLARE_SPAN: f32 = 300.0;
pub const SOLAR_FLARE_HEIGHT: f32 = 170.0;
/// Points the centre line is sampled at, footpoint to footpoint. Enough that two
/// neighbours are never farther apart than `SOLAR_FLARE_RIBBON_R`, so no body slips
/// between samples — `flare::tests::no_gap_between_samples_is_wider_than_the_ribbon`.
pub const SOLAR_FLARE_SAMPLES: u32 = 48;
/// The loop's centre wanders the map at this speed, world px/s — under
/// `WALK_SPEED` (150), so a player on foot can outpace it and the danger is being
/// caught by the sweep, not by the chase.
pub const SOLAR_FLARE_SPEED: f32 = 90.0;
/// The radius of the arc the loop's centre rides at `SOLAR_FLARE_SPEED`, world px,
/// or less where the map is too small for it (`effects/flare.rs`). At 90 px/s a
/// 360 px arc turns a quarter-radian a second: a 12 s flare sweeps most of a circle
/// the width of a screen, which reads as a wander rather than a lap.
pub const SOLAR_FLARE_ORBIT: f32 = 360.0;
/// How fast the loop's axis turns, radians/s: a slow roll, so the arch sweeps the
/// space around it rather than sliding past like a bar.
pub const SOLAR_FLARE_TURN: f32 = 0.35;
/// **Drawing only** (T22.08B): how far past the ribbon's contact radius the painted
/// glow reaches, world px. The body inside `SOLAR_FLARE_RIBBON_R` is painted solid in
/// both render paths — a player must not be burned by fire they cannot see — and
/// this is the soft halo outside it, which burns nobody.
pub const SOLAR_FLARE_GLOW: f32 = 34.0;
/// **Client only** (T22.08D F3): how long a client shows a body on fire on the
/// strength of its own contact test before the server has said so. The contact is
/// tested on predicted and interpolated positions, which can disagree with the
/// server's for a whole burn; the server's word is a `weather` `damage` (to you) or
/// a health drop in the snapshot (anyone else). A burn is logged once per
/// `RADIATION_LOG_INTERVAL` from the touch (`PlayerState::burn_tick`), so a real
/// burn's first word arrives within that, plus its trip — budgeted at two snapshot
/// intervals. Flames with no word by then go out.
pub const SOLAR_FLARE_CONFIRM_SECONDS: f32 = RADIATION_LOG_INTERVAL + 2.0 / SNAPSHOT_HZ as f32;

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
/// 20 with T21.02: the passive-movement byte. **`docs/40` §3 does not describe
/// it and the amendment is owed**, like the byte above it.
///
/// A byte of its own rather than the flags byte's last spare bit, because §3
/// leaves exactly one (bit 7) and M21 needs at least two — ironman boots and
/// T21.03's unicorn wings — with T21.08's spacesuit behind them. Spending the
/// last reserved bit on the first of them would have made the second a wire
/// break instead of a field addition.
///
/// **28 with T22.10H**: position and velocity went from four `i16` of whole px
/// (truncated) to four `i32` counted in [`SNAPSHOT_QUANTUM`]s (rounded) — +8.
/// Six players: 8 + 6·28 + 4 = 180 bytes before base64, 240 after, 4.8 KB/s at
/// `SNAPSHOT_HZ` — still far inside `docs/40` §4.
pub const SNAPSHOT_PLAYER_BYTES: usize = 28;
/// **The snapshot's position and velocity quantum** (T22.10H): px for a position,
/// px/s for a velocity. The codec sends `round(v / SNAPSHOT_QUANTUM)` and the
/// decoder (`codec.rs::decode_snapshot`, `codec.ts::decodeSnapshot`) multiplies
/// back, so one rounded value is within **half a quantum per axis** of the
/// server's `f32` — and any check that charges the prediction for the wire's
/// rounding (`scripts/checks/black-hole.mjs`) derives its slack from this, not a
/// literal. One constant for both, the way the old wire had one (whole px, px/s).
///
/// **Why an eighth, and why `i32`** — the range arithmetic:
/// - an `i16` of eighths spans ±4095.875: short of `MAP_LARGE_W` (4096) before a
///   single pixel of void margin, so a position cannot be `i16` at this quantum;
///   `i32` spans ±268 435 455.875 px, which no map approaches (`dimensions_are_sane`
///   caps a side at 8192).
/// - an `i16` of eighths of a px/s would span ±4095.875 px/s — above
///   `SPACE_MAX_SPEED` (1350) and `MAX_FALL_SPEED` (900), but upward velocity is not
///   clamped (`apply_gravity`: knockback still launches) and knockback stacks, so a
///   velocity could clamp where the body did not. `i32` costs 4 bytes a player and
///   never clamps a velocity the simulation can produce.
/// - `1/8` is exact in binary, so `v / SNAPSHOT_QUANTUM` is a multiply by 8 with no
///   rounding of its own, and every multiple of it up to 2²¹ px is exact in `f32`.
///
/// Why finer at all (`docs/77-owed` point 6): a free-flying body re-anchored on a
/// truncated whole-px/s velocity drifted past `RECONCILE_EPSILON_PX` within ~1.5 s,
/// and whole-px positions cost the black hole's check √2 px of slack.
pub const SNAPSHOT_QUANTUM: f32 = 1.0 / 8.0;
const _: () = assert!(MAP_LARGE_W as f32 / SNAPSHOT_QUANTUM > i16::MAX as f32);
const _: () = assert!(8192.0 / SNAPSHOT_QUANTUM < i32::MAX as f32);
/// Header bytes before the player array: tick, round_time_ds, darkness, count.
pub const SNAPSHOT_HEADER_BYTES: usize = 8;
/// Trailing `last_input_seq`.
pub const SNAPSHOT_FOOTER_BYTES: usize = 4;
/// The longest frame a client steps, seconds: a tab that stalled for ten seconds
/// is not simulated ten seconds forward in one frame. **The client's
/// `input/autoFire.ts::MAX_FRAME_DT` is this number** — exported through
/// `constants_json` and pinned there by `constants-parity.test.ts` (T22.10D), because
/// the server now sizes its input intake from it.
pub const MAX_FRAME_DT: f32 = 0.25;
/// The most inputs one client frame produces: `ceil(MAX_FRAME_DT / SIM_DT)` = 15
/// (T22.10D F4). A frame that long sends every one of them in the same instant, so
/// this is the burst an honest client can put into one server tick — and, since
/// T22.10F, how far a stand-in tick's seq may run ahead of the newest a player has
/// sent (`World::apply_inputs`): the frame after a stall is at most this many.
pub const MAX_FRAME_TICKS: usize = {
    let exact = MAX_FRAME_DT * SIM_HZ as f32;
    let whole = exact as usize;
    if (whole as f32) < exact {
        whole + 1
    } else {
        whole
    }
};
/// The jitter buffer: future inputs a player may keep queued after a tick
/// (T22.10F, R89; T22.10D F4 introduced it as a catch-up target). Past it the
/// **oldest** are dropped and the expected seq jumps past them — one bounded
/// correction after a hitch, never a standing delay (`World::apply_inputs`).
///
/// **Two, not zero:** a client sending one input per frame over TCP delivers
/// them in uneven clumps — two one tick, none the next. Two held let such a
/// clump be run on the ticks it was meant for, where zero would drop one of
/// every clump; at most ~33 ms of delay, and only while clumps keep arriving.
pub const INPUT_BACKLOG_TARGET: usize = 2;
/// The flood guard on input, per player: the most the room accepts in one tick
/// (`Room::apply`'s `Command::Input`); excess is dropped and logged. (The world
/// keeps at most `INPUT_BACKLOG_TARGET` since T22.10F.)
///
/// **`MAX_FRAME_TICKS`, derived, not a number of its own** (T22.10D F4, the
/// coordinator's ruling). It was 8 — below the 15 inputs one long client frame
/// sends at once — so the room dropped the newest 7 of every such frame (never
/// re-sent), and the world kept the other 7 as a standing queue. A guard that
/// honest traffic trips is not a guard; at one frame's worth it bites only a
/// client sending faster than any frame could, and the *backlog* policy is
/// `INPUT_BACKLOG_TARGET`'s. `docs/40` §2 and `docs/70` §A30 still say 8 — the
/// amendment is owed (`tasks/M22/DOCS-77-OWED.md`).
pub const MAX_INPUT_QUEUE: usize = MAX_FRAME_TICKS;

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

/// px, at zoom 1. The beam's width, and since §F2 the bullet streak's too.
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

// --- T22.06: the space backdrop ---
//
// Presentation only: nothing here reaches the simulation or the state hash. Sizes
// are **camera px** — the space the sky is laid out in, which `CAMERA_ZOOM` then
// doubles on screen. Every body moves on the **round's** clock, so two players in
// one round see one sky.

/// The earth, camera px. 128 screen px across at `CAMERA_ZOOM` 2: the largest thing
/// in the sky by far, which is what makes it read as the planet you are above.
pub const SPACE_EARTH_RADIUS: f32 = 64.0;
pub const SPACE_MOON_RADIUS: f32 = 15.0;
/// The sun's disc; its glow is `SPACE_SUN_GLOW` times this.
pub const SPACE_SUN_RADIUS: f32 = 12.0;
pub const SPACE_SUN_GLOW: f32 = 9.0;
/// The half-extents of the sun's and the earth's elliptical paths across the view,
/// as fractions of it (the centres stay in `spaceSky-math.ts`: they are composition —
/// the sun high, the earth low). Here because a body's **speed** is its path's length
/// over its period, so `SPACE_EARTH_PERIOD`'s pace below is a claim about both
/// (T22.06B F5); `spaceSky-math.test.ts` measures that pace off the function.
pub const SPACE_SUN_PATH_RX: f32 = 0.36;
pub const SPACE_SUN_PATH_RY: f32 = 0.1;
pub const SPACE_EARTH_PATH_RX: f32 = 0.28;
pub const SPACE_EARTH_PATH_RY: f32 = 0.08;
/// Seconds per lap of each body's path. **The owner asked that they move**, so each
/// is sized against a round (`ROUND_SECONDS` 240): the moon laps the earth twice,
/// the earth crosses a good third of its path — at `SPACE_EARTH_PATH_RX`/`_RY` of the
/// view, ~3 camera px/s, ~6 on screen, which is slow enough to be scenery and fast
/// enough that a player sees it has moved.
pub const SPACE_SUN_PERIOD: f32 = 900.0;
pub const SPACE_EARTH_PERIOD: f32 = 420.0;
pub const SPACE_MOON_PERIOD: f32 = 120.0;
/// The moon's orbit about the earth's centre, camera px. Squashed vertically by
/// `SPACE_MOON_TILT` so the orbit reads as a ring seen edge-on and the moon passes
/// in front of the earth and behind it.
pub const SPACE_MOON_ORBIT: f32 = 118.0;
pub const SPACE_MOON_TILT: f32 = 0.32;
/// The star field's sideways drift, camera px/s — the whole sky turning slowly.
pub const SPACE_STAR_DRIFT: f32 = 2.0;
pub const SPACE_STAR_COUNT: u32 = 320;
/// Scroll factors: far things barely move with the camera, and the stars are
/// farther than the bodies. Both are well under `SKY_BODY_PARALLAX`'s 0.08, because
/// a space map is flown in every direction and a larger factor walks the earth off
/// the screen before you reach a rim.
pub const SPACE_BODY_PARALLAX: f32 = 0.04;
pub const SPACE_STAR_PARALLAX: f32 = 0.015;

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
/// T21.19: a dropped crate blinks on the minimap — lit for `MINIMAP_CRATE_ON`
/// seconds at the start of every `MINIMAP_CRATE_PERIOD`.
///
/// **The brief, deliberately** (*"for half a second, every 3 seconds"*). A glance at
/// the minimap misses the dot about five times in six; that makes crates findable
/// without turning the minimap into a permanent treasure map, and rewards watching.
/// If it feels wrong in play, these two numbers are the whole decision.
///
/// Driven by the **round clock**, so every client blinks together and in step with
/// the server's time, and every crate blinks in unison: one ping says "crates are
/// here". `beaconPulse` (the in-world glow) is a 1 Hz sine on its own clock and is
/// not the right shape for an on/off blink.
pub const MINIMAP_CRATE_PERIOD: f32 = 3.0;
pub const MINIMAP_CRATE_ON: f32 = 0.5;
/// The beacon dot's colour, 0xRRGGBB — red, as asked; redder and darker than a
/// remote player's `#ff5a5a`, and it blinks where a player's dot does not.
pub const MINIMAP_CRATE_COLOUR: u32 = 0xff_2a_2a;
/// The beacon dot's size, in minimap cells.
pub const MINIMAP_CRATE_DOT: u32 = 3;

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
///
/// **Halved from 30 on 2026-09-08 at the coordinator's instruction**: an empty
/// room is worth nothing and T20.24 measured the cost of holding them — 32 rooms,
/// 192 seats, **0 humans**, while 8542 joins were refused `server_full`. The room
/// table was exhausted entirely by rooms nobody was in.
///
/// **This applies to a lobby and to a running match alike**, and deliberately: a
/// room *is* the lobby and then becomes the match, and the reaper asks only how
/// long it has been empty. There was never a distinction to preserve.
///
/// **This is not the disconnection grace, and must not be sized as though it
/// were.** A lagged client is not "gone" until the socket layer says so —
/// `engineioxide`'s defaults are a 25 s ping interval and a 20 s ping timeout, so
/// a dropped connection takes **up to 45 s** to be noticed, and only then does
/// this clock start. A cleanly closed tab is immediate. So the real grace for a
/// blip is ~45 s regardless of this number; shortening it costs a returning
/// player nothing they had.
pub const ROOM_EMPTY_TTL: f32 = 15.0;
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

// --- T22.09A: radiation and the suit (`M22-RULINGS` R6, R24, R25) ---
//
// **The exchange rate is the design** (R24): one energy buys one damage
// avoided, and `BATTERY_MAX` equals `BASE_HEALTH`, so the suit battery is a
// second health bar that radiation eats first. A full suit is `BATTERY_MAX /
// RADIATION_SHIELD_COST` = 100 s of grace, a pack `BATTERY_PACK_AMOUNT /
// RADIATION_SHIELD_COST` = 50 s more, and at zero the suit fails and radiation
// starts on health at the same rate. **A starting point with a stated basis,
// not a measurement** — `tests/balance.rs::space_radiation_report` is the
// 8-seed run R24 owes, and its numbers are in the journal for T22.09A.

/// Damage per second to a player in space whose suit is not sealed (R6: the
/// owner's number, "1 damage per second"). Ambient and constant — `R6`.
pub const RADIATION_DPS: f32 = 1.0;
/// Battery per second a sealed suit spends keeping radiation out (R24).
///
/// **Equal to `RADIATION_DPS` on purpose**: one energy for one damage is the
/// sentence a player learns by dying once. It is radiation's cost, not the
/// shield's — T20.08 deleted the per-second shield drain and R24 rules that
/// it stays deleted; a generator outside space still costs nothing a second.
pub const RADIATION_SHIELD_COST: f32 = 1.0;
/// Radiation is logged once per this many seconds, never once a tick (R25).
///
/// At `SIM_HZ` one entry per tick per player is 360 `Damage` events a second
/// at `MAX_PLAYERS`, each a floating number, a red vignette and a hit sound on
/// the client. One a second is the rate the owner described.
pub const RADIATION_LOG_INTERVAL: f32 = 1.0;
/// `BATTERY_PACK`'s natural spawn weight is multiplied by this in space (R24,
/// R76): its share of `items::registry::weights(WeightColumn::Spawn)` goes from
/// `w / total` to `m·w / (total + (m − 1)·w)`, `m` being this — roughly `m`
/// times while the pack is a small part of the column. No figures here on purpose: the column is the source,
/// and `spawning.rs::the_battery_pack_is_doubled_on_the_space_spawn_column_only`
/// re-derives the share from it. **Spawn column only** — crates are a separate
/// economy (R76).
pub const BATTERY_PACK_SPACE_WEIGHT_MULT: u16 = 2;
// `SHIELD_DURATION` and `SHIELD_DRAIN` are **gone** (T20.08). One was the timer's
// length and the other its per-second cost, and there is no timer: a generator is
// held, and it spends `SHIELD_HIT_COST` per hit. Left in place they would be
// tunables nothing reads, which is the shape this file exists to prevent.
/// Energy weapons pierce: this replaces `SHIELD_DAMAGE_MULT` for them.
pub const LASER_SHIELD_MULT: f32 = 0.85;
/// Energy the generator spends absorbing **one energy hit** (§B5, T20.08).
///
/// Eight times a normal hit, which is what "energy weapons pierce" costs the
/// victim beyond the weaker multiplier above.
///
/// **This is the number that made bit 3 lie**, and the fix is in `apply_damage`
/// rather than here. `shield_active` is "holds a generator with charge", so a
/// player with 4 energy reads as shielded and the client draws the bubble — and
/// then a laser hit finds the battery cannot pay 8. Charging `min(battery, cost)`
/// and scaling the reduction by the fraction paid makes the boolean exactly true
/// whenever *any* absorption happens, at either cost.
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

/// §F5 — the shovel. The one melee weapon anybody actually carries: every player
/// spawns holding it and it can never leave the inventory, so these six numbers
/// are the melee floor of the whole arsenal rather than one option among five.
///
/// It **digs**, and `SHOVEL_CARVE` is sized for that job rather than chosen: at
/// `PLAYER_H / 2 + 2` one swing opens a `PLAYER_H + 4` gap, so a single click
/// clears a hole a player fits through with a couple of pixels to spare on uneven
/// ground. Raised from 14 on 2026-09-07 — at 14 the opening was exactly `PLAYER_H`
/// and caught on any slope. It ties `HAMMER_CARVE` for the largest melee carve.
/// **`docs/75`'s table still says 14; the amendment is outstanding.** Damage sits between the bat and the
/// axe: it must be a real answer at touching distance without making the guns
/// pointless for anyone who closes.
pub const SHOVEL_DAMAGE: f32 = 30.0;
pub const SHOVEL_CARVE: f32 = PLAYER_H * 0.5 + 2.0;
pub const SHOVEL_REACH: f32 = 20.0;
pub const SHOVEL_ARC: f32 = 1.2;
pub const SHOVEL_COOLDOWN: f32 = 0.55;
pub const SHOVEL_KNOCKBACK: f32 = 150.0;

// The flamethrower (§F10.2). **No longer a cone.** It emits flames — objects
// that fly, fall, settle and burn — so `FLAMETHROWER_DPS`, `_ARC`, `_RANGE` and
// `_PARTICLE_LIFE` are all retired: there is no arc to check, no dps on the
// weapon, and reach is now emergent from speed x life rather than a number.
//
// T11.09's finding survives the change and is worth keeping: it tried a range of
// 200 and **measured it worse** (0.37 -> 0.30 dmg/bot-s, self-damage 0.28 ->
// 0.44), because the flamethrower's problem was never reach — it was that its
// user walks into the fire it leaves. §F10 is that finding's actual fix: fire
// you can see, at a place you chose, that a bot's hazard guard can read.
pub const FLAMETHROWER_COOLDOWN: f32 = 0.05;
/// Fuel, spent per trigger tick — 200 at 0.05 s is 10 s of continuous fire.
pub const FLAMETHROWER_AMMO: u8 = 200;
/// Flames per press. At `FLAMETHROWER_COOLDOWN` 0.05 that is 40 a second, which
/// is what makes a held trigger a *stream* rather than a burst.
pub const FLAMETHROWER_FLAMES_PER_SHOT: u32 = 2;
/// How fast a flame leaves the flamethrower, px/s.
pub const FLAME_MUZZLE_SPEED: f32 = 320.0;
/// Radians of jitter either side of the aim.
///
/// A draw, not an even fan: two flames a press at 20 presses a second would
/// otherwise lay down two perfectly straight lines. The draw is from the world's
/// seeded `ChaCha8Rng`, so a replay reproduces it exactly.
pub const FLAME_SPREAD: f32 = 0.18;

// --- F10: a flame is an object ---------------------------------------------
//
// Fire used to be two things and neither was a fire: an arc that was *checked*
// each tick, and static discs of "burning ground". You could not see where fire
// would go, you could not push it, and it did not behave like the thing on the
// screen. A flame is now a projectile on the shared step — it flies, it falls
// slowly, it bounces, it settles, it burns what it touches, and its only end is
// `FLAME_LIFE`.
//
// **These are the flame's own numbers.** What *makes* flames — the flamethrower,
// the molotov, the lava vent — is §F10.2 and carries its own counts and speeds.

/// Seconds a flame burns before it goes out. Its **only** end: a flame does not
/// die on contact, which is what makes it area denial rather than a hit.
pub const FLAME_LIFE: f32 = 5.0;
/// Health per second, to everyone inside one — including whoever lit it, once
/// the owner grace has passed. Continuous, so two overlapping flames burn twice
/// as fast; that is what makes a crowd of them dangerous.
pub const FLAME_DPS: f32 = 12.0;
/// Damage and collision radius, px.
pub const FLAME_RADIUS: f32 = 10.0;
/// Well under 1.0, so a flame drifts down and settles rather than dropping like
/// a grenade.
pub const FLAME_GRAVITY_SCALE: f32 = 0.35;
/// Bounce, and bleed off speed until `GRENADE_REST_SPEED` puts it to rest.
pub const FLAME_RESTITUTION: f32 = 0.25;
pub const FLAME_FRICTION: f32 = 0.60;
/// Seconds between a resting flame's terrain bites. **A timer, not a tick**: a
/// flame that carved every tick would eat a crater in a second, and this is
/// meant to be a slow burn.
pub const FLAME_SCORCH_EVERY: f32 = 0.5;
/// Radius of one such bite, px. Over five seconds a crowd of flames eats a real
/// hole, which is the digging the fire weapons never had.
pub const FLAME_SCORCH_R: f32 = 3.0;
/// Global cap on live flames, oldest dropped first.
///
/// A molotov plus a held flamethrower trigger can otherwise put hundreds of
/// objects on the wire: projectiles are broadcast **per object** at
/// `SNAPSHOT_HZ`, so this number is a bandwidth ceiling as much as a gameplay
/// one.
pub const FLAME_MAX_LIVE: usize = 160;

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
/// T21.18: a smoke cloud's shader quad, as a multiple of the cloud's radius — its
/// half-width. The flat path's lobes reach `0.22 r + 0.78 r` = r from the centre;
/// the painted cloud's eaten edge billows past that, so the quad leaves room for it.
/// **Purely drawing**: what a player inside can see is `FOV_SMOKE_MULT` at
/// `SMOKE_RADIUS`, decided by the server either way.
pub const SMOKE_SHADER_SCALE: f32 = 1.35;
/// T21.18: how many smoke clouds at once get a shader quad. Past it the rest are
/// drawn with the flat lobes — a cap, never a cloud dropped.
pub const SMOKE_SHADER_POOL: u32 = 8;
pub const SMOKE_DURATION: f32 = 8.0;
pub const SMOKE_FUSE: f32 = 1.5;
pub const SMOKE_MUZZLE_SPEED: f32 = 470.0;
pub const SMOKE_AMMO: u8 = 2;

/// Six patches, scattered — a molotov denies an area, not a point.
/// How many flames a molotov becomes (§F10.2). It is a *crowd*, not a disc: the
/// picture the M19 brief asks for is individual flames scattering along the
/// ground so you can see the shape of the area that has become dangerous.
pub const MOLOTOV_FLAMES: u32 = 24;
/// How fast they leave the impact, px/s — outward and up.
pub const MOLOTOV_FLAME_SPEED: f32 = 220.0;
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
/// A mine's own collision box, in pixels. Small enough to sit in a doorway.
///
/// Moved here from `weapons/placed.rs` (T21.35), where it was the one pair of
/// mine numbers outside this file. Server-only: the client draws a mine from
/// its position and never reads the box.
pub const MINE_W: f32 = 10.0;
pub const MINE_H: f32 = 6.0;

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
///
/// **T21.40: 40 → 32**, with the gate. The owner, 2026-09-15: *"reduce its size by
/// 20% its kinda large"*. The strip is the gate's footing, so it shrinks with the
/// drawn gate (`PAD_ART_W`) by the same 80 %.
pub const PAD_W: i32 = 32;
pub const PAD_H: i32 = 8;
/// The fewest pads a map may carry, unless it carries none (T21.40).
///
/// A pad sends you to any *other* pad (`world/teleport.rs::destination`), so one
/// pad alone is a gate that charges and goes nowhere. The owner's ruling: *"just
/// dont place any more if there's no proper space"* — a map that can seat only one
/// gets none.
pub const TELEPORT_PADS_MIN: usize = 2;
/// How wide the teleport gate is **drawn**, in px (T21.28).
///
/// **T21.40: 64 → 51**, 80 % — *"reduce its size by 20% its kinda large"* (the
/// owner, 2026-09-15). Height follows the art's aspect, so the gate is not squashed.
///
/// Not `PAD_W`: the pad is the `PAD_W` strip you stand on and the rock
/// `carve_circle` protects, and the gate standing on it is wider — a stone arch
/// with 12 px of base overhang each side. The two were never the same number, and
/// the generator only knew the narrow one, so it seated gates whose stone base hung
/// over a slope — reported from play with a screenshot: *"a couple pixels are
/// touching it in the center but the rest are in the air"*.
///
/// **One number, read by all three sides**: the generator fills ground under this
/// many columns (`map/meta.rs::fill_standing_ground`), `build-gate-sprite.mjs`
/// builds the art this wide, and `pads.ts` displays it at this width. T21.28's 64
/// was what the build already produced (`PAD_W` × 1.6); T21.40's 51 is 80 % of it,
/// rebuilt by `build-gate-sprite.mjs`, and `gate-ground` measures the drawn gate
/// against the art rather than against this number.
pub const PAD_ART_W: i32 = 51;
/// How far below a pad's or a gun platform's drawn base the ground may be
/// extended up to meet it, in px (T21.28).
///
/// **A pixel count, not `OBJECT_GROUND_FILL_DEPTH`'s fraction of a height.** That
/// rule measures against an object's own collision mask, whose height the
/// generator has; a gate's drawn height is derived by the sprite build from the
/// art's aspect ratio and nothing in `game-core` knows it, so reusing the fraction
/// would need a second art constant that could drift from the picture.
///
/// **One player height**: across T21.28's 64 px base that closes a slope of about 40°
/// either side, which is the ground a player walks up. Measured at HEAD over 36
/// maps, 54 % of pads had every drawn column within 28 px and 29 % had one past
/// 71 — a cliff edge, and those placements are refused rather than propped on a
/// pillar (`meta.rs::generate_full_with`).
pub const STANDING_GROUND_FILL_DEPTH: i32 = PLAYER_H as i32;

/// The widest a decoration's **opaque base** can be drawn, in px (T21.28).
///
/// Coordinator's ruling: a decoration is drawn only with rock under every column
/// of its drawn base, and the generator chooses spots where that holds. The
/// generator does not know the per-frame art, so it seats every decoration against
/// this one conservative width: the widest opaque bottom row across
/// `assets/atlas/decor.json` (18 px, `decor_8` and `decor_11`, measured) at the
/// largest scale tier (1.25, `decorations-math.ts::SCALE_TIERS`), rounded up.
/// `decorations-real.test.ts` asserts the atlas never exceeds it, so new art wider
/// than this fails a test instead of floating.
pub const DECOR_BASE_W: i32 = 23;
/// How far below a decoration's base rock may start and still count as the ground
/// it stands on, in px (T21.28, the coordinator's "within 1–2 px"). Read by the
/// generator here and asserted equal to `decorations-math.ts::DECOR_GROUND_SLACK_PX`.
pub const DECOR_GROUND_SLACK: i32 = 2;
/// How far a body's feet may sit from a pad's surface line and still count as
/// standing on it, in px.
///
/// A grounded body rests where the collision solver left it, which is near the
/// surface line rather than exactly on it, and a body walking a slope onto the
/// pad arrives a pixel or two high. An exact test makes "on the pad" true on
/// some ticks and false on others, which is a charge that never completes.
pub const PAD_TOUCH_SLACK: f32 = 4.0;
/// Seconds of standing still on a pad before it fires.
///
/// 2.0 until §F8. Everyone can shoot while running now (§F4), so two seconds of
/// standing on a lit pad was a long time to be a target.
pub const TELEPORT_CHARGE: f32 = 1.5;
/// Seconds after **arriving** before a pad will charge again.
///
/// Without it the destination pad starts charging the instant you land on it and
/// you ping-pong between two pads for the rest of the round.
pub const TELEPORT_COOLDOWN: f32 = 5.0;
/// How far from where you spawned you must move before a pad arms.
///
/// Respawn puts you **on** a pad, so without this rule the first thing every
/// death does is teleport you somewhere else a `TELEPORT_CHARGE` later —
/// including when you are stationary because you are reading the map.
pub const TELEPORT_ARM_DISTANCE: f32 = 32.0;

// --- M21 T21.11: gun platforms ---

/// Static gun emplacements per map, chosen the way teleport pads are.
///
/// **Three, from the coordinator.** A platform is a map resource worth fighting
/// over rather than a weapon everyone gets a turn with, and the count is what
/// makes that true: six would put one within reach of every spawn, one would make
/// the round about a single tile.
pub const GUN_PLATFORMS: usize = 3;
/// A platform is `GUN_PLATFORM_W` wide and `GUN_PLATFORM_H` tall, its top flush
/// with the surface point — `PAD_W`/`PAD_H`'s meaning exactly, and the rock in
/// that rect is indestructible for the same reason.
///
/// Wider than `PAD_W` because a platform is a thing you stand *on and behind*:
/// the art is a tripod, and a footprint narrower than the silhouette would let a
/// rocket dig out ground the picture is still standing on. The coordinator's
/// requirement was *"a couple pixels of ground you cannot destroy under it"*, and
/// `GUN_PLATFORM_H` is those pixels.
pub const GUN_PLATFORM_W: i32 = 48;
pub const GUN_PLATFORM_H: i32 = 10;
/// How far a platform must sit from a teleport pad, in px.
///
/// **Derived from the two footprints, not chosen**: half of each width, so the
/// protected rects can touch but never overlap. A fourth number here would be a
/// number that disagrees with the rects the moment either width moves.
///
/// This exists because a separate RNG sub-stream is **not** enough, which was
/// measured rather than assumed: `choose_separated` is farthest-point sampling
/// over the same surface set, so the two draws converge on the same extremal
/// points regardless of stream — seed 4242 put platform 1 exactly on pad 1 at
/// (2800, 472). Two stand-to-activate features on one tile is a gameplay
/// conflict (mount versus teleport), not a cosmetic one.
pub const GUN_PLATFORM_PAD_CLEARANCE: i32 = (PAD_W + GUN_PLATFORM_W) / 2;
/// How far a platform must sit from a **spawn point**, in px (T21.14).
///
/// **Smaller than the pad clearance, and derived from a different question.**
/// `GUN_PLATFORM_PAD_CLEARANCE` keeps two *footprints* from overlapping, which
/// is what two protected rects need. A spawn has no footprint: what must not
/// happen is a player materialising inside the platform's **mount region**, so
/// the requirement is `GunPlatform::underfoot` being false for a body standing
/// on the spawn — half a platform width, plus half a body so a pixel of drift
/// cannot reach it.
///
/// Reusing the pad number here starved the sampler outright: 6 pads plus 6
/// spawns at 44 px left Medium/seed 0 with two platforms instead of three.
pub const GUN_PLATFORM_SPAWN_CLEARANCE: i32 = GUN_PLATFORM_W / 2 + PLAYER_W as i32 / 2;
/// Seconds of standing on a platform before it mounts you — **and** seconds of
/// holding jump before it lets you off (T21.11B).
///
/// **One constant for both directions, because it is one mechanism.** The mount
/// timer runs backwards to dismount; a second constant would be a second thing
/// to tune and the two would drift into "quick to get on, slow to get off" with
/// nobody having decided that.
///
/// A second, matching `TELEPORT_CHARGE`'s neighbourhood (1.5): long enough that
/// walking over a platform does not seize you, short enough that mounting under
/// fire is a real choice rather than a suicide.
pub const GUN_PLATFORM_MOUNT_TIME: f32 = 1.0;
/// Rounds a platform holds, for the whole round (T21.11C).
///
/// **500, and the number is the design rather than a tuning knob.** The
/// coordinator's ruling: *"a map resource worth fighting over, not a free weapon
/// three times a round"*. At one round per `GUN_PLATFORM_FIRE_INTERVAL` that is
/// about 17 s of the trigger held down (T21.43) — a long time holding one
/// position, which is the trade, and a finite enough supply that taking a
/// platform late in a round can mean taking an empty one.
///
/// **When it is empty it is empty**: the platform keeps its collision, its cover
/// and its mount, and does nothing. It does not despawn, because the coordinator
/// wants a refill item later and "empty forever" baked into the shape is what
/// would have to be undone for it. **There is no reload**: one magazine per
/// platform per round, and T21.43 kept that rule.
pub const GUN_PLATFORM_AMMO: u16 = 500;
/// Ticks between two platform rounds while the trigger is held (T21.43).
///
/// *"Click and hold to auto fire like a machine gun"* — the owner, 2026-09-15.
/// It replaced T21.11C's volley of four rounds every 0.12 s.
///
/// **Counted in ticks, because the server can only fire on one.** Every
/// accepted shot lands on a tick, so a cadence between two tick counts is a beat
/// against the tick rate, not a rate. Two ticks is the only value whose held
/// damage lands inside ±20 % of the volley it replaced: see
/// `GUN_PLATFORM_SPAM_DPS_BASIS`.
pub const GUN_PLATFORM_FIRE_TICKS: u32 = 2;
/// `GUN_PLATFORM_FIRE_TICKS` in seconds — the platform's own clock, and the
/// cadence the client repeats `fire` at while the button is held.
///
/// **The platform's own cooldown, not the player's.** `try_fire_slot` gates on
/// `PlayerState::fire_ready_at`, which belongs to whatever the player happens to
/// be holding — a platform sharing it would fire at the cadence of the weapon in
/// a bag its rider cannot even reach.
pub const GUN_PLATFORM_FIRE_INTERVAL: f32 = GUN_PLATFORM_FIRE_TICKS as f32 * SIM_DT;
/// The turret's barrels, fired in turn — the reference art has three (T21.43).
pub const GUN_PLATFORM_BARRELS: u8 = 3;
/// Angle between two neighbouring barrels' rounds, radians (T21.43).
///
/// A fixed per-barrel offset, not a random draw: the stream is the same shape
/// every time from the same inputs, and firing costs the world's RNG nothing.
/// Three barrels span 2 × this = 0.06 rad, tighter than T21.11C's 0.10 fan,
/// because a stream is aimed and a volley was thrown.
pub const GUN_PLATFORM_BARREL_SPREAD: f32 = 0.03;
/// Muzzle separation between two neighbouring barrels, px, across the aim.
pub const GUN_PLATFORM_BARREL_GAP: f32 = 4.0;
/// **The measured basis the held stream is balanced against** (T21.43), in
/// damage per second. A value that matters: `platform_gun::
/// the_held_stream_is_balanced_against_its_measured_basis` asserts it.
///
/// Measured at `dd2acc6`, before the change, by firing a mounted platform
/// **every tick** for 10 s — the fastest cadence the server accepts from a
/// spam-clicker: **300 rounds in 600 ticks**, i.e. a volley of 4 every 8 ticks
/// (0.12 s rounds up to 8 ticks of 1/60 s), × 6 damage ÷ 10 s = **180 DPS**.
///
/// After: one round every 2 ticks × 6 damage = **180 DPS held**, ratio 1.00
/// (measured by the same test: 301 rounds in 600 ticks, the extra one being the
/// one-tick grace in `World::fire_platform`). The allowed band is
/// `GUN_PLATFORM_BALANCE_TOLERANCE`.
pub const GUN_PLATFORM_SPAM_DPS_BASIS: f32 = 180.0;
/// How far the held stream's DPS may sit from `GUN_PLATFORM_SPAM_DPS_BASIS`,
/// as a fraction — the coordinator's ±20 %.
pub const GUN_PLATFORM_BALANCE_TOLERANCE: f32 = 0.20;
/// Damage per round from the platform gun (T21.11C).
///
/// Below `MACHINEGUN_DAMAGE`, because the platform's power is its **rate**: a
/// round every `GUN_PLATFORM_FIRE_INTERVAL` is far more damage per second than
/// any carried weapon, and matching a rifle per round as well would make the
/// trade no trade at all.
pub const GUN_PLATFORM_DAMAGE: f32 = 6.0;
/// How far a platform round flies before it stops, px.
///
/// Long: the whole point of giving up mobility is reaching across the map.
pub const GUN_PLATFORM_RANGE: f32 = 900.0;
/// Muzzle speed of a platform round, px/s.
pub const GUN_PLATFORM_MUZZLE_SPEED: f32 = 1500.0;

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
/// Ridge height, far to near, as a fraction of `VIEWPORT_H` **in world pixels**.
///
/// The near layer is taller, which is what makes the two read as distance rather
/// than as one ridge drawn twice.
///
/// **T21.20 changed the basis, not the values.** This was a fraction of the
/// camera's *visible* height, so at `CAMERA_ZOOM` 2 a ridge was half the world
/// size these numbers read as — reported from play as "very small". Now it is
/// `VIEWPORT_H × frac` world px (115 and 173), which is what the ridge texture was
/// always baked at: zoom scales it like the terrain beside it, and cannot shrink it.
pub const MOUNTAIN_HEIGHT_FRAC: [f32; MOUNTAIN_LAYERS] = [0.16, 0.24];
/// Where the ridge base sits **in the world**, as a fraction of the map's height.
///
/// **T21.20: world space, not screen space.** It was 0.86 of the visible rect, so
/// the ridge rode with the camera while the terrain stayed put — climb or jetpack
/// and the skyline hung in mid-air ("the mountains are in the air"). A world
/// height stays put against the ground; the ridge still parallaxes horizontally by
/// `MOUNTAIN_PARALLAX`.
///
/// **Tied to `GROUND_BASE_FRAC`** — the mean line the ground profile is built
/// around — so the ridge meets the land where the land usually is, and a change to
/// the terrain's height moves the skyline with it rather than leaving it behind.
pub const MOUNTAIN_BASE_FRAC: f32 = GROUND_BASE_FRAC;
/// Where the ridge base sits on the **title screen**, as a fraction of the viewport.
///
/// The title has a sky and no map, so there is no world to anchor to; it keeps the
/// screen layout the game used before T21.20 (0.86, below the sun and moon's
/// horizon). A separate name because one constant meaning "of the map" in one scene
/// and "of the screen" in another is a field that means two things.
pub const MOUNTAIN_TITLE_BASE_FRAC: f32 = 0.86;
/// World px over which the near ridge's foot fades from its tint to nothing, below
/// its base (T21.20).
///
/// **A fade, not a solid skirt — measured.** World-anchored, the ridge base is a
/// world row, and where the ground dips below it the sprite ended in a straight
/// line with sky under it. A solid fill to the bottom of the screen fixed that edge
/// and turned the whole sky into a flat wall wherever the camera sat below the base
/// (`skins-ingame`'s frames: a brown sky, and a ground difference of 55-58 where it
/// had been 37). Ninety px of haze softens the edge and leaves the sky below it.
pub const MOUNTAIN_FOOT_FADE: f32 = 90.0;
/// The sun and moon's horizon, as a fraction of the viewport height.
///
/// Was an inline `0.82` in `sky.ts` (T21.20 moved it here). **Screen space on
/// purpose**: the bodies scroll at `SKY_BODY_PARALLAX` — nearly pinned to the
/// camera, as far things are — so their horizon is a line on the screen. The
/// world-anchored ridge covers them where the two overlap, which reads as the sun
/// going down behind the mountains.
pub const SKY_HORIZON_FRAC: f32 = 0.82;
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

/// Drift speed, px/s, before a cloud's own `CLOUD_SPEED_MIN..MAX` and the wind.
/// Slow enough that it reads as weather rather than as motion.
///
/// **T21.31: the clouds are world objects now**, so this is world px/s and there is
/// no `CLOUD_PARALLAX` — rain falls from under a cloud, and a cloud that slid with
/// the camera would drag its rain across the ground with it.
pub const CLOUD_DRIFT: f32 = 6.0;
/// Extra drift per unit of the round's wind (`MapMeta::wind`, px/s² up to
/// `WIND_MAX`), px/s. At `WIND_MAX` a cloud gains 7 px/s in the wind's direction.
pub const CLOUD_WIND_GAIN: f32 = 0.08;
/// One cloud per this many world px of map width (T21.31): 20 over a medium map,
/// which at `CAMERA_ZOOM` 2 is three or four across the view — "many, small".
pub const CLOUD_SPACING: f32 = 150.0;
/// A cloud's width, world px. The owner's report was *"too large"*: the widest is
/// under a quarter of the 640 px a zoomed camera shows.
pub const CLOUD_W_MIN: f32 = 44.0;
pub const CLOUD_W_MAX: f32 = 150.0;
/// Height as a fraction of width — flat streaks to heaped puffs.
pub const CLOUD_ASPECT_MIN: f32 = 0.32;
pub const CLOUD_ASPECT_MAX: f32 = 0.62;
/// Lobes per cloud: the silhouette. Three is a small puff, eight a long bank.
pub const CLOUD_LOBES_MIN: u32 = 3;
pub const CLOUD_LOBES_MAX: u32 = 8;
/// Per-cloud multiple of the drift speed, so no two clouds keep station.
pub const CLOUD_SPEED_MIN: f32 = 0.5;
pub const CLOUD_SPEED_MAX: f32 = 1.6;
/// Per-cloud brightness, multiplied into the phase's tint.
pub const CLOUD_BRIGHT_MIN: f32 = 0.74;
pub const CLOUD_BRIGHT_MAX: f32 = 1.0;
/// The two ends a cloud's own tint is drawn between, 0xRRGGBB: cool and warm white.
pub const CLOUD_TINT_COOL: u32 = 0xdd_e8_ff;
pub const CLOUD_TINT_WARM: u32 = 0xff_ee_d8;
/// Per-cloud opacity, as a multiple of the phase's `cloudTint` alpha.
pub const CLOUD_OPACITY_MIN: f32 = 0.65;
pub const CLOUD_OPACITY_MAX: f32 = 1.0;
/// How far a cloud's base floats above the **sky floor**, world px.
///
/// The sky floor is the highest rock within `CLOUD_FLOOR_WINDOW` of the cloud, so
/// a cloud is never inside rock however it drifts — and it is measured from the
/// land under it rather than from the top of the world, which at `CAMERA_ZOOM` 2 is
/// never on screen (`BIRD_ALTITUDE_ABOVE_MIN`'s lesson).
pub const CLOUD_ALTITUDE_MIN: f32 = 50.0;
pub const CLOUD_ALTITUDE_MAX: f32 = 200.0;
/// Width of the window the sky floor takes its highest rock over, world px.
///
/// **Must exceed `CLOUD_W_MAX + CLOUD_FLOOR_SMOOTH`**: the floor is a max-height
/// filter over this window smoothed over `CLOUD_FLOOR_SMOOTH`, and what that is
/// guaranteed to clear is the rock within `(WINDOW - SMOOTH) / 2` of the centre —
/// which has to cover half the widest cloud. Asserted in the tests below.
pub const CLOUD_FLOOR_WINDOW: f32 = 440.0;
/// Smoothing of the sky floor, world px, so a cloud rises over a mesa rather than
/// jumping when the mesa enters its window.
pub const CLOUD_FLOOR_SMOOTH: f32 = 120.0;
/// Column step of the scan for the highest rock, world px.
pub const CLOUD_FLOOR_STEP: u32 = 2;
/// Nearest a cloud's top may come to the top of the world, world px.
pub const CLOUD_TOP_MIN: f32 = 4.0;
/// Soft rings each lobe is painted with. **Both paths are plain filled circles**,
/// so they draw on Phaser's Canvas renderer too (T21.31: the owner plays there);
/// High Quality only paints more, fainter rings, which is a softer edge.
pub const CLOUD_RINGS: u32 = 3;
pub const CLOUD_RINGS_HQ: u32 = 6;
/// The title screen has no map: its sky floor is this fraction of the viewport.
pub const CLOUD_TITLE_FLOOR_FRAC: f32 = 0.46;
/// Cloud opacity at full day. Night and dusk scale down from here.
pub const CLOUD_ALPHA: f32 = 0.62;
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

// ---------------------------------------------------------------------------
// Fall damage (T20.11)
// ---------------------------------------------------------------------------
//
// **`docs/20` §9 refuses this feature** — *"Fall damage — deliberately absent in
// v1 so the jetpack stays forgiving"* (`docs/20-player-movement.md:235`) — and
// `docs/70`–`75` contain no override. The coordinator asked for it directly on
// 2026-09-04 and that ruling is what unblocks the task; **the doc has not been
// amended and a builder does not amend it**, so the discrepancy is journalled and
// `docs/` is untouched. An amendment is the durable home for this block.
//
// The numbers below are **measured, not chosen**, on a flat spot of
// `generate(4242, Small)` with `PLAYER_H` = 28 and one tick of `SIM_DT`:
//
//     plain jump (JUMP_VELOCITY 430)   lands at  410 px/s, peak 62.5 px
//     drop  50 px                      lands at  373 px/s
//     drop 100 px                      lands at  537 px/s
//     drop 200 px                      lands at  747 px/s
//     drop 400 px and beyond           lands at  900 px/s  (MAX_FALL_SPEED)

/// Below this landing speed a fall costs nothing, px/s.
///
/// **Was 480, because a plain jump lands at a measured 410** and a jump that
/// hurt would make the game unplayable rather than punishing. That put the free
/// drop height at `480² / (2 x GRAVITY)` = **82 px**, about three player heights.
///
/// **Doubled to a 165 px free drop, owner 2026-09-16**, reported from play:
/// *"add a minimum height for fall damage to work (or if it already exists,
/// double it)"*. The minimum already existed and it is this constant — but it is
/// written as a **speed**, and the owner asked about a **height**. Height goes as
/// `v²/2g`, so doubling the height is `sqrt(2)` on the speed, not 2:
/// `480 x sqrt(2)` = **678.8**, for `678.8² / (2 x GRAVITY)` = **164.6 px**,
/// exactly twice the 82.3 px above. Doubling the *speed* instead would have
/// quadrupled the height to 329 px, which is not what was asked.
///
/// **This shrinks the damaging band from 420 px/s wide to 221**, and everything
/// downstream of that is why `FALL_DAMAGE_PER_SPEED` had to move with it — see
/// the ruling recorded there. `boots_fall_safe_speed` is *not* affected: it is
/// derived from `JUMP_VELOCITY`, never from this.
pub const FALL_SAFE_SPEED: f32 = 678.8;

/// Health lost per px/s of landing speed **above** `FALL_SAFE_SPEED`.
///
/// Linear rather than quadratic: the quantity a player can judge is *how far down
/// it looks*, and a quadratic curve turns a small misjudgement near the top of the
/// range into a death. At 0.025 a terminal-velocity landing costs
/// `(900 - 480) x 0.025` = **10.5** of `BASE_HEALTH` 100 — the deepest fall in the
/// game costs about a tenth of a full bar, which is a penalty for flying rather
/// than a second void.
///
/// **Halved from 0.15 on 2026-09-07 at the coordinator's instruction** — it was
/// too aggressive in play. The old value cost 63 of 100 on the same landing, so
/// the deepest fall was survivable only above two thirds health and any prior
/// chip damage made it lethal. `FALL_SAFE_SPEED` is untouched, so the free drop
/// height is unchanged at 82 px and only the slope past it moved.
///
/// **`docs/` does not state a value to diverge from — it refuses the feature.**
/// `docs/20-player-movement.md:235` still reads *"Fall damage — deliberately
/// absent in v1 so the jetpack stays forgiving."* That divergence predates this
/// change: it opened when T20.11 built fall damage on the 2026-09-04 ruling with
/// no override in `docs/70`–`75`, and the amendment has been outstanding since.
/// This retune changes a number inside that gap rather than opening a new one.
///
/// **Cut to a third, 0.075 → 0.025, on 2026-09-15 (T21.29)** — reported from
/// play: *"fall damage is still way to high. im doing pretty basic landings and it
/// does quite a lot of damange. reduce it by 300%. its not fun."* A 300 %
/// reduction is not a number; the coordinator's ruling reads it as **every
/// landing costs a third of what it did**. `FALL_SAFE_SPEED` is unchanged again,
/// so *which* landings hurt is the same and only *how much* moved. A 112 px drop
/// (4 player heights) went from 6.0 to 2.0; the deepest fall from 31.5 to 10.5.
///
/// **This value is held by a test of a different kind**:
/// `world::fall_damage::a_landing_costs_at_most_a_third_of_what_it_did_when_the_owner_reported_it`
/// measures landings through the world against the rate at the time of the
/// report, so it is the one test that sees this constant move back up.
///
/// **Raised 0.025 -> 0.046 on 2026-09-16, and it is a consequence, not a
/// retune.** The owner doubled the free drop height (see `FALL_SAFE_SPEED`),
/// which shrank the damaging band from 420 px/s to 221 — so at an unchanged rate
/// the deepest fall the game can produce would have cost 5.53 hp and breached
/// the tenth-of-a-bar floor asserted below. Asked which should give, the owner
/// chose **"keep the worst fall meaningful"** over "keep falls gentle": you fall
/// twice as far for nothing, and past that line it hurts properly.
///
/// **The window here is narrow and both ends bind at terminal velocity.** The
/// floor below needs `221.2 x rate > 10`, so `rate > 0.04521`; T21.29's ruling
/// that no landing costs more than a third of the 0.075 it did when reported
/// needs `221.2 x rate <= 420 x 0.025 = 10.5`, so `rate <= 0.04747`. 0.046 sits
/// between them with 1.7 % and 3.1 % of margin. It is a tight fit and it is
/// deliberate — the two guards are what keep this a discount rather than a
/// removal, and a value outside that range fails one of them at build time or in
/// `world::fall_damage`.
///
/// ```text
///                        before (480 / 0.025)   after (678.8 / 0.046)
///     free drop height             82 px                165 px
///     112 px drop (4 heights)     2.0 hp                   0 hp   (now free)
///     224 px drop (8 heights)     7.5 hp                 4.7 hp
///     deepest fall               10.5 hp                10.2 hp
/// ```
pub const FALL_DAMAGE_PER_SPEED: f32 = 0.046;

// A plain jump must be free, or the whole game becomes a limp. The measured
// landing speed is 410 against `JUMP_VELOCITY` 430; guarding against the constant
// rather than the measurement means a faster jump moves this too.
const _: () = assert!(FALL_SAFE_SPEED > JUMP_VELOCITY);
// ...and terminal velocity must not be free, or the rule does nothing at all.
const _: () = assert!(FALL_SAFE_SPEED < MAX_FALL_SPEED);
const _: () = assert!(FALL_DAMAGE_PER_SPEED > 0.0);
// **The deepest possible fall must not kill from full health.** `docs/20` §9's
// reason for refusing fall damage was that the jetpack should stay forgiving; a
// fall that is instantly lethal is the version of this feature that clause was
// right about.
const _: () = assert!((MAX_FALL_SPEED - FALL_SAFE_SPEED) * FALL_DAMAGE_PER_SPEED < BASE_HEALTH);
// And it must be worth avoiding: less than a tenth of a health bar is a rule
// nobody notices, which is the same defect as not having one.
const _: () =
    assert!((MAX_FALL_SPEED - FALL_SAFE_SPEED) * FALL_DAMAGE_PER_SPEED > BASE_HEALTH * 0.1);
// The exemption is `KNOCKBACK_FIRE_GRACE`, reused unchanged (T20.11's ruling): a
// rocket-jump's round trip is `2 x KNOCKBACK_MAX / GRAVITY` = 0.457 s, inside the
// 0.6 s grace, so the doc comment there is true and no second timer is needed.
const _: () = assert!(2.0 * KNOCKBACK_MAX / GRAVITY < KNOCKBACK_FIRE_GRACE);

// ---------------------------------------------------------------------------
// Ground animals (T20.10)
// ---------------------------------------------------------------------------
//
// **No doc governs these.** `grep -i "animal|spider|wildlife|creature"` over
// `docs/` and `tasks/` returns nothing — birds are `docs/72` §C16 and this has no
// counterpart. The task file says so and asks that the gap be flagged: **an
// amendment would be the durable home for this block.**
//
// The shape follows the birds' constants deliberately, so the two read as one
// family: a cadence, a cap, a size, a health, and relationship guards below.

/// Seconds between spawn attempts. Slower than `BIRD_INTERVAL` on purpose:
/// ground animals persist — they do not cross the map and leave — so the cadence
/// only has to refill what players shoot.
pub const ANIMAL_INTERVAL: f32 = 12.0;
/// How many may be alive at once.
pub const ANIMAL_MAX: usize = 5;
/// Chance a spawn is a spider rather than a beetle.
pub const ANIMAL_SPIDER_CHANCE: f32 = 0.6;

/// A spider's hit box, px. Small: it is a thing you notice and have to aim at.
pub const SPIDER_W: f32 = 12.0;
pub const SPIDER_H: f32 = 8.0;
/// One shot from anything.
pub const SPIDER_HEALTH: f32 = 1.0;
/// Seconds between hops.
pub const SPIDER_HOP_EVERY: f32 = 1.6;
/// Upward and sideways impulse of a hop, px/s.
pub const SPIDER_HOP_UP: f32 = 170.0;
pub const SPIDER_HOP_SIDE: f32 = 60.0;

/// A beetle is bigger, slower and tougher — the other end of the same trade.
pub const BEETLE_W: f32 = 16.0;
pub const BEETLE_H: f32 = 10.0;
pub const BEETLE_HEALTH: f32 = 12.0;
/// Ground speed, px/s. Walks rather than hops.
pub const BEETLE_SPEED: f32 = 26.0;
/// Seconds before a beetle reconsiders which way it is walking.
pub const BEETLE_TURN_EVERY: f32 = 4.0;

/// Kept clear of the map edges, like `BIRD_EDGE_MARGIN`.
pub const ANIMAL_EDGE_MARGIN: f32 = 40.0;
/// An animal that ends up below this many px of the world bottom is removed:
/// a void map can swallow one, and a corpse falling forever is a leak.
pub const ANIMAL_DESPAWN_BELOW: f32 = 64.0;

// The relationships, in the shape `BIRD_METAL_HEALTH > BIRD_HEALTH` established.
// A spider that outlived a beetle, or a beetle smaller than a spider, would make
// the two kinds the same decision with different art.
const _: () = assert!(BEETLE_HEALTH > SPIDER_HEALTH);
const _: () = assert!(BEETLE_W > SPIDER_W && BEETLE_H > SPIDER_H);
// The spider must actually leave the ground, or "jumping spiders" is a name.
const _: () = assert!(SPIDER_HOP_UP > 0.0);
// And it must not out-run the beetle sideways *and* hop: the beetle's only
// advantage is being harder to kill.
const _: () = assert!(SPIDER_HOP_SIDE > BEETLE_SPEED);
// A cap of zero would make every assertion about animals vacuous.
const _: () = assert!(ANIMAL_MAX > 1);
const _: () = assert!(ANIMAL_INTERVAL > 0.0);
// Both kinds must be reachable, or one of them is unreachable art.
const _: () = assert!(ANIMAL_SPIDER_CHANCE > 0.0 && ANIMAL_SPIDER_CHANCE < 1.0);

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
/// **What the rule permits, stated plainly.** `seat` places the base at *this*
/// percentile of the ground depths under the footprint — not the median this once
/// said, which measured 51 % contact against a 60 % rule — and refuses the object
/// unless that much of its base is within `OBJECT_SEAT_BAND` of the seat. A rock
/// spanning a chasm fails this; a rock on a slope passes it. The old wording here
/// called the rest "partial burial, correct and wanted"; it was reported from play
/// as floating (T21.21), and the report won.
///
/// **Since T21.21 this is the backstop, not the whole answer.** `fill_under` extends
/// the ground up to meet every base column within `OBJECT_GROUND_FILL_DEPTH`, so what
/// this still permits is a base perched over a cliff or a cave mouth deeper than
/// that, on up to 40 % of its width.
pub const OBJECT_FOOTPRINT_SUPPORT: f32 = 0.6;
/// T21.21: how far below an object's base the ground may be extended up to meet
/// it, as a fraction of the object's height.
///
/// Measured before the fill existed, over six seeds at three scales: 21.9 % of base
/// columns touched nothing, with gaps of median 6 px, 90th percentile 224 and a tail
/// past 1000 — hovering, then cliffs. One object-height closes the hover and the
/// shallow step under an overhang, and refuses to grow a pillar into a chasm.
pub const OBJECT_GROUND_FILL_DEPTH: f32 = 1.0;

/// How far the ground may deviate from an object's seated base and still count
/// as supporting it, as a fraction of the object's **own height** (§E12).
///
/// A fraction rather than a pixel count because the objects differ by 3x in
/// height: a band that reads as "nestled" under a 42 px rock reads as "floating"
/// under a 28 px bush and as "buried" under an 84 px ruin.
pub const OBJECT_SEAT_BAND: f32 = 0.25;

// ---------------------------------------------------------------------------
// Starting kit (a private-lobby setting, §F7)
// ---------------------------------------------------------------------------

/// What a private lobby arms every player with at spawn **and respawn** (§F7).
///
/// It lives beside `MapScale` because it is the same kind of thing: a value the
/// host picks in the lobby that crosses the socket, the replay and the client,
/// so one spelling of each name has to be shared by all three. The *contents*
/// of each kit are the server's (`room::kit_items`) — this is only the choice.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum StartKit {
    /// The shovel every player is issued (§F5) and nothing else.
    #[default]
    None,
    /// A pistol at `PISTOL_AMMO` and `START_KIT_GRENADES` grenades.
    Basic,
    /// Every weapon that is not retired, at `max_stack`, plus a full battery.
    All,
}

impl StartKit {
    /// Parse the wire value. `None` for anything else, so the caller can refuse
    /// with a reason rather than clamping (§E6, `docs/61` §3).
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "none" => Some(StartKit::None),
            "basic" => Some(StartKit::Basic),
            "all" => Some(StartKit::All),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            StartKit::None => "none",
            StartKit::Basic => "basic",
            StartKit::All => "all",
        }
    }

    /// Wire encoding for the replay, which is bytes and not JSON.
    pub const fn as_u8(self) -> u8 {
        match self {
            StartKit::None => 0,
            StartKit::Basic => 1,
            StartKit::All => 2,
        }
    }

    pub const fn from_u8(b: u8) -> Option<Self> {
        match b {
            0 => Some(StartKit::None),
            1 => Some(StartKit::Basic),
            2 => Some(StartKit::All),
            _ => None,
        }
    }

    /// Every value, in panel order — the list T19.08's stepper walks.
    pub const ALL: [StartKit; 3] = [StartKit::None, StartKit::Basic, StartKit::All];
}

// ---------------------------------------------------------------------------
// Gravity (a private-lobby setting, T22.01)
// ---------------------------------------------------------------------------

/// Low gravity's multiplier on [`GRAVITY`] (T22.02, M22-RULINGS R3).
///
/// **A multiplier and not a second `GRAVITY`.** `map/gen/traversal.rs`'s
/// `JUMP_HEIGHT` and `JUMP_REACH` are compile-time consts of `JUMP_VELOCITY`,
/// `WALK_SPEED` and `GRAVITY`, and they decide which maps the generator accepts.
/// A runtime scale leaves the generator judging reachability at standard
/// gravity while the player moves under low gravity — which is the safe
/// asymmetry, because every scale below 1.0 makes the player jump *higher and
/// further* than the generator assumed. The alternative regenerates every map in
/// the game and moves the golden table.
///
/// **The value is bracketed by `tests::low_gravity_carries_its_basis`**, not by
/// the assertions that merely pin it: a suite pinned to a constant cannot report
/// the constant moving, so that test asserts the two things the *number* has to
/// be true of — the jump is visibly floatier, and a fall can still kill you.
pub const LOW_GRAVITY_SCALE: f32 = 0.5;

/// Which gravity a match is played under, as the host picks it in the lobby.
///
/// It lives beside [`StartKit`] and [`MapScale`] because it is the same kind of
/// thing: a value chosen in the lobby that crosses the socket, the replay header
/// and the client, so one spelling of each name has to be shared by all three.
///
/// **`Space`, not `None`.** The brief asked for *"gravity: standard, low, none"*,
/// but the third mode is not "no gravity": it is a different map, a different
/// backdrop, its own hazards and a suit. Naming the variant after the single
/// physical property it changes is how map generation ends up hanging off a word
/// that means gravity, so the value is named after the mode instead.
///
/// **`Low` stays** — M22-RULINGS R3. If it is ever dropped, this enum becomes
/// `Standard | Space` and the wire bytes below renumber with it.
///
/// **`Low` (T22.02) and `Space` (T22.03) are both live.**
/// [`GravityMode::scale`] is the one place the mode becomes a number, and it
/// answers `LOW_GRAVITY_SCALE` and `0.0` respectively. `world::gravity_tests`
/// is where both claims are asserted.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum GravityMode {
    /// `GRAVITY` as every other mode has always used it. The default, and the
    /// value every existing test runs under.
    #[default]
    Standard,
    /// A lighter pull. Floatier jumps, slower falls, the same map (T22.02).
    Low,
    /// The space mode: its own map, backdrop, hazards and suit (T22.03 onward).
    Space,
}

impl GravityMode {
    /// Parse the wire value. `None` for anything else, so the caller can refuse
    /// with a reason rather than clamping — `MapScale::parse`'s rule (§E6,
    /// `docs/61` §3).
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "standard" => Some(GravityMode::Standard),
            "low" => Some(GravityMode::Low),
            "space" => Some(GravityMode::Space),
            _ => None,
        }
    }

    /// Does this mode issue the spacesuit — and so the radiation it seals out?
    /// (T22.09A, `M22-RULINGS` R2/R6/R26.)
    ///
    /// **The one place the mode becomes the `suit` bit.** `R26` has the callers
    /// of `PlayerState::shield_active` supply it because `PlayerState` has no
    /// route to the mode; every production caller asks this, so "is there a
    /// suit" cannot be answered two ways. Radiation, the suit battery at spawn
    /// and the pack's doubled spawn weight all key off it too — one mode, one
    /// bit, and `Low` is not a space mode.
    pub const fn wears_suit(self) -> bool {
        matches!(self, GravityMode::Space)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            GravityMode::Standard => "standard",
            GravityMode::Low => "low",
            GravityMode::Space => "space",
        }
    }

    /// Wire encoding for the replay, which is bytes and not JSON.
    pub const fn as_u8(self) -> u8 {
        match self {
            GravityMode::Standard => 0,
            GravityMode::Low => 1,
            GravityMode::Space => 2,
        }
    }

    pub const fn from_u8(b: u8) -> Option<Self> {
        match b {
            0 => Some(GravityMode::Standard),
            1 => Some(GravityMode::Low),
            2 => Some(GravityMode::Space),
            _ => None,
        }
    }

    /// The multiplier this mode puts on [`GRAVITY`], everywhere gravity is
    /// integrated.
    ///
    /// **This is the single place the mode becomes a number**, and every site
    /// that asks it is a site that moves something: `physics::resolve::
    /// apply_gravity` (through `player::jetpack::gravity_scale`, for players),
    /// `physics::resolve::Forces::falling` (T22.11A, for every non-player body),
    /// `weapons::projectile::integrate`, `weapons::projectile::predict_impact`
    /// and `bots::zone_reach`. None of them decides for itself.
    ///
    /// **Since T22.11A it is the answer for everything that falls**, which it
    /// was not for the length of M22's batch 2. Four fallers reached
    /// `integrate` with a literal `1.0`; `M22-RULINGS` R30 and R48 name the
    /// consequence and the section below records what it looked like, because a
    /// comment that quietly starts being true is a comment nobody re-reads.
    ///
    /// **`Space` answers `0.0` since T22.03**, which is what *"there is no
    /// global gravity"* means here: `physics::resolve::apply_gravity` returns
    /// before it touches `vel.y`, so nothing accelerates a player downward and
    /// `MAX_FALL_SPEED` never binds. It reaches the same four sites as `Low`,
    /// and the consequence at three of them is deliberate — **a projectile in
    /// space flies straight**, because `weapons::projectile` multiplies each
    /// weapon's own `gravity_scale` by this one. The fourth,
    /// `bots::zone_reach`, **divides** by it, and its `const _` assertion was
    /// the compile-time trap that made this change name it; see the
    /// `FLAME_LIFE` bound there.
    ///
    /// **This is not a fourth gravity regime.** `player::jetpack::gravity_scale`
    /// still names exactly three — wings, jetpack, ordinary — and multiplies
    /// this in front of all of them, so `0.0 * anything` is no gravity and no
    /// player can be in two regimes at once.
    ///
    /// # The four fallers it did not reach until T22.11A
    ///
    /// `weapons::placed::Mines::step`, `items::world::WorldItems::step`,
    /// `world::tombstones::Tombstones::step` and `world::animals::Animals::tick`
    /// each passed a literal `1.0`, so they fell at standard gravity under
    /// `Low` **and under `Space`**. In a low-gravity match a dropped weapon and
    /// a tombstone fell twice as fast as the person who dropped them — a real
    /// inconsistency, visible in ordinary play — and in space a player floated
    /// while their dropped rifle fell to the bottom of the arena.
    ///
    /// **All four now take the mode and go through
    /// `physics::resolve::Forces::falling`**, which is the single place the mode
    /// becomes a non-player body's scale *and* its zero-g contact rules (R14).
    /// `items::world::a_dropped_item_falls_at_the_players_rate_in_every_gravity_mode`
    /// is the cross-subsystem assertion — it drives the item through
    /// `WorldItems::step` and the player through `player::apply_input` and
    /// compares the two falls — and the other three steppers each carry their
    /// own `Low`-and-`Space` test beside their own code.
    ///
    /// **The reason it took until T22.11A was scheduling, not shape.** An
    /// earlier version of this comment said their signatures *"cannot see the
    /// match setting (`(map, …, dt)`)"*, which is a description rather than a
    /// reason: T22.02 widened `Projectiles::step`'s signature for exactly this.
    /// The honest sentence is that `M22-RULINGS` R10 assigned those four
    /// signature changes to `T22.11` along with the `Forces` refactor they ride
    /// on, and doing them earlier would have made that merge a rewrite of a
    /// rewrite.
    ///
    /// # Two interactions that are stated rather than left to be found
    ///
    /// - **Wings (T21.03) make this irrelevant while they are out** — the third
    ///   gravity regime, named in `player::jetpack::gravity_scale` so nothing can
    ///   be in two of them at once.
    /// - **Boots (T21.02) are unaffected by the mode, and cannot be.** You land
    ///   from your own jump at the speed you launched at whatever `k` is, and
    ///   both fall thresholds are speeds that do not scale with it, so T21.02's
    ///   "safe from the height your own jump reaches" holds identically in every
    ///   mode — a booted player just floats to 297 px instead of 148 first.
    ///   `world::fall_damage::a_jump_is_free_under_every_gravity_mode_booted_or_bare`
    ///   carries the arithmetic and the measurement.
    pub const fn scale(self) -> f32 {
        match self {
            GravityMode::Standard => 1.0,
            GravityMode::Low => LOW_GRAVITY_SCALE,
            // **T22.03.** Zero-g is a *scale* of zero, never a `GRAVITY` of
            // zero: the const assertion at `KNOCKBACK_FIRE_GRACE` divides by
            // `GRAVITY`, and `JUMP_HEIGHT`/`JUMP_REACH` go infinite with it, so
            // a zero constant does not compile. A zero scale is a shipped path
            // — `apply_gravity` has returned early on it since T21.03's wings.
            GravityMode::Space => 0.0,
        }
    }

    /// Every value, in panel order.
    ///
    /// **Nothing in Rust walks this in production** — the lobby's stepper is
    /// `GRAVITIES` in `client/src/net/lobby.ts`, and the panel is TypeScript. An
    /// earlier version of this comment claimed the stepper walked it, which a
    /// reader would have believed.
    ///
    /// What it is actually for: the exhaustiveness loop in
    /// `constants::tests::gravity_parses_and_round_trips`, and
    /// `game-wasm`'s `constants_json`, which exports these spellings as
    /// `GRAVITY_MODES` so `lobby.test.ts` can assert the TypeScript list equals
    /// this one. **That export is the only thing keeping the two in step**, so a
    /// variant added here without one there fails in the client's tests.
    pub const ALL: [GravityMode; 3] = [GravityMode::Standard, GravityMode::Low, GravityMode::Space];
}

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
    /// `MapGenerator::Space`: asteroids asked for inside the rim.
    ///
    /// **Asked for, not guaranteed.** Placement is rejection sampling against
    /// `SPACE_ASTEROID_GAP_MIN` and the rim clearance, so a map may come out
    /// with fewer; `space.rs::asteroids_exist_and_are_separated` pins the floor
    /// and `density_and_gap_report` prints the achieved distribution.
    ///
    /// Chosen so the rocks cover ~7 % of the rim ellipse at every scale —
    /// *"tons of tiny islands ... enough space to float between them, like
    /// stars"*. Small is the binding one: its ellipse is 880x440 and, after the
    /// rim clearance is taken off, sequential adsorption at this gap saturates
    /// at roughly 18 rocks, so 14 is a count it reaches rather than a target it
    /// misses.
    pub asteroid_count: u32,
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
                asteroid_count: 14,
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
                asteroid_count: 34,
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
                asteroid_count: 64,
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

// --- T22.03B: bots in space (M22-RULINGS R5) ---

/// The speed a bot flies at in space, px/s. Under `JETPACK_MAX_SPEED` so the
/// thrust that reaches it is short and the tank refills while it coasts — nothing
/// damps in space, so cruising costs no fuel once the speed is bought.
pub const BOT_SPACE_CRUISE: f32 = 200.0;
/// The deceleration a flying bot plans its arrival with, px/s²: the speed it may
/// still carry `d` px from where it is going is `√(2 · BOT_SPACE_BRAKE · d)`.
/// **The weakest thrust less the strongest well** — the one brake a bot can count
/// on in every direction and next to any rock — so an arrival planned with it is
/// one the bot can actually stop for.
pub const BOT_SPACE_BRAKE: f32 = JETPACK_THRUST_DOWN - SPACE_WELL_ACCEL_MAX;
/// How far a flying bot's velocity may miss the one it wants, per axis, before it
/// thrusts, px/s. The dead band is what lets it coast (and refill) instead of
/// firing the thrusters every tick over a rounding error.
pub const BOT_SPACE_DEADBAND: f32 = 40.0;
/// Fuel a flying bot keeps back, s of burn: it cruises and brakes only above it,
/// and spends it only to get out of something that kills (the black hole, a
/// vortex's pull, a flare).
pub const BOT_SPACE_FUEL_RESERVE: f32 = 1.5;
/// How far outside a hazard's edge a bot in space starts leaving it, px — the
/// black hole's reach (and its telegraph), a vortex's no-escape disc, a flare's
/// ribbon.
pub const BOT_SPACE_HAZARD_MARGIN: f32 = 64.0;
/// A bot in a suit goes for a battery pack in sight when its battery is at or
/// below this fraction of `BATTERY_MAX` and it carries none — past a visible
/// enemy: an unsealed suit loses `RADIATION_DPS` for the rest of the round.
pub const BOT_SUIT_SHOP_BELOW: f32 = 0.5;

// ---- v7 amendments ----  mirrors docs/75-amendments-v7.md

// --- F1: a bullet is a thing that flies ---

/// Muzzle speeds for the five ballistic guns, px/s (§F1).
///
/// A hitscan shot does not exist for long enough to be seen — the check that
/// photographed one had to **freeze the frame first**, which is the measurement
/// saying a player cannot. These are the speeds that turn a line segment into an
/// object: at 900 px/s a bullet crosses a 1536 px map in 1.7 s, which is ~15 px
/// per frame — a streak that moves, not a flicker.
///
/// They are also the only thing that decides how far a bullet reaches per tick,
/// so they are what `PROJECTILE_OWNER_GRACE_TICKS` (3) has to clear: the fastest
/// of them is 17.5 px a tick against a `MUZZLE_OFFSET` of 18 and a half-body of
/// 8, so a bullet is already outside its owner at spawn and 52 px away before the
/// grace ends.
pub const PISTOL_MUZZLE_SPEED: f32 = 900.0;
pub const REVOLVER_MUZZLE_SPEED: f32 = 1000.0;
pub const DEAGLE_MUZZLE_SPEED: f32 = 1050.0;
pub const MACHINEGUN_MUZZLE_SPEED: f32 = 850.0;
pub const SMG_MUZZLE_SPEED: f32 = 800.0;

// --- F2: you can see what you fired ---

/// The drawn streak: length along the velocity, width across it (§F2).
///
/// A **streak, not a dot**. At 850 px/s a round crosses 14 px between frames, so
/// a circle reads as a flicker with no direction in it; a segment reads as a line
/// going somewhere, which is the information a player actually needs.
pub const BULLET_LENGTH: f32 = 10.0;
pub const BULLET_WIDTH: f32 = 2.0;

/// Seconds a **beam** stays visible (§F2). Was `TRACER_LIFETIME` 0.09.
///
/// That path serves the two energy weapons only now — the five ballistic guns
/// fire objects that fly (§F1). 0.09 s is five frames, which is why
/// `ordnance-visible` could only photograph one by stopping time first: a check
/// that has to freeze the frame to see a thing is telling you the player cannot.
pub const BEAM_LIFETIME: f32 = 0.35;
/// T21.18: the world-px thickness of the quad a laser beam is painted on under
/// High Quality — the halo's full spread, not the core's. The flat path's widest
/// pass is `TRACER_WIDTH × 5`; the shader fades to nothing inside this.
pub const BEAM_SHADER_WIDTH: f32 = 22.0;
/// T21.18: how many beams at once get a shader quad. Past it, the rest are drawn
/// with the flat lines — a cap, never a beam dropped.
pub const BEAM_SHADER_POOL: u32 = 12;
/// T21.18: a flame's shader quad half-width, in damage radii (`FLAME_RADIUS`). The
/// painted body is solid out to 1.1 damage radii and ragged a little past it, so this
/// leaves room for the rag. **The quad must never be what bounds the fire smaller than
/// the damage** — `fire-shader` samples every flame's damage circle to hold that.
pub const FLAME_SHADER_SCALE: f32 = 1.8;
/// T21.18: the quad's height over its width — room above the flame for the tongue
/// and the heat-haze column.
pub const FLAME_SHADER_ASPECT: f32 = 2.2;
/// T21.18: where the flame's centre (its damage centre) sits up the quad, 0 bottom, 1 top.
pub const FLAME_SHADER_BASE: f32 = 0.3;
/// T21.18: how many flames at once get a shader quad. Past it, the rest are drawn with
/// the flat circles — a cap, never a flame dropped. Under `FLAME_MAX_LIVE` on purpose:
/// every quad is its own draw call.
pub const FLAME_SHADER_POOL: u32 = 48;
/// T21.18: seconds a High Quality explosion is painted for — the flash, the front and
/// then the soot that lingers. Longer than the flat flash (0.35 s) on purpose; the
/// light and the crater are unchanged.
pub const BLAST_SHADER_LIFE: f32 = 1.1;
/// T21.18: a blast's shader quad half-width, in blast radii. The front runs past the
/// blast radius and the soot beyond it, so the quad leaves room for both.
pub const BLAST_SHADER_SCALE: f32 = 1.8;
/// T21.18: how many blasts at once get a shader quad; past it, the flat flash.
pub const BLAST_SHADER_POOL: u32 = 16;

// ---------------------------------------------------------------------------
// Special items (M21)
// ---------------------------------------------------------------------------
//
// **No doc section governs these.** `grep -rin "vampire\|fangs\|ironman\|unicorn"`
// over `docs/` returns nothing: T21.01–T21.03 were asked for directly and every
// task file says an amendment is the durable home for this block. Reported, not
// absorbed — a builder does not write `docs/`.

/// Damage a vampire-fang carrier must deal to gain **one** point of life
/// (T21.01) — *"you heal for 1 hp for every 10 damage you cause with projectile
/// weapons"*.
///
/// Applied as a **ratio and never as a threshold**, which is what removes the
/// need for a stored fractional carry: 10 damage returns exactly 1.0, and 5
/// damage twice returns 0.5 twice, which is also exactly 1.0. A "lifesteal
/// pending" accumulator would be a fourth field on `PlayerState`, and every
/// field there is hashed into `World::state_hash` and would cost a
/// `REPLAY_VERSION` bump for a number that is already derivable.
pub const LIFESTEAL_DAMAGE_PER_HP: f32 = 10.0;

/// Ironman boots (T21.02): *"makes you run twice as fast"*.
///
/// Multiplies into `PlayerState::speed_multiplier`, the seam `apply_input`
/// already threads to `apply_horizontal` — where it scales the **target speed**
/// and not the acceleration, so a booted player is faster rather than twitchier
/// (`movement.rs` states that design).
pub const BOOTS_SPEED_MULT: f32 = 2.0;

/// Unicorn wings (T21.03): the vertical speed of constant flight, px/s.
///
/// **Explicitly not `JETPACK_MAX_SPEED`, and that is the brief's own
/// instruction**: *"a custom speed separate from jetpacking since I don't know
/// how balanced this item is — might have to reduce it to make it more fair."*
/// An alias would have to be split the first time either number moved, so it is
/// its own constant from the start and this is the one knob that tuning turns.
///
/// 200 against the jetpack's 260 is a first setting with a reason rather than a
/// placeholder: a jetpack is a **short, fast** climb bought with fuel, and wings
/// are a **slow, endless** one. If they climbed faster as well as forever the
/// jetpack would have nothing left to be.
///
/// **Wings are unlimited, and that is a balance decision hiding inside "you just
/// fly constantly".** `JETPACK_MAX_FUEL` is what makes the jetpack's flight
/// finite; the brief mentions no fuel and none is charged, so the only cost of
/// wings is the inventory slot and the jump they refuse.
pub const WINGS_FLY_SPEED: f32 = 200.0;

/// Horizontal speed multiplier while unicorn wings are carried.
///
/// **Owner, 2026-09-16, from play:** *"wings should also slow you down by an
/// additional 10%"*. *Additional* is why this multiplies rather than replaces —
/// it lands on top of the health term and of `BOOTS_SPEED_MULT`, so a booted,
/// winged, healthy player moves at `2.0 x 0.9` = 1.8x and a hurt one is slower
/// still. Every other reading makes one of the three rules silently stop
/// mattering, which is the shape `speed_multiplier` was already written against.
///
/// It is a **cost paid for unlimited flight**, and it is the second one: the
/// first is that wings refuse the jump. Both are what keep `WINGS_FLY_SPEED`'s
/// "slow and endless" story true against a jetpack that is fast and finite.
pub const WINGS_SPEED_MULT: f32 = 0.9;

// Flight that does not climb is not flight.
const _: () = assert!(WINGS_FLY_SPEED > 0.0);
// A slow is a slow. Nothing here reads as a speed *boost* hiding in a name that
// says otherwise, and a multiplier of 1.0 would be the item quietly not doing it.
const _: () = assert!(WINGS_SPEED_MULT < 1.0);
const _: () = assert!(WINGS_SPEED_MULT > 0.0);
// The design claim above, asserted rather than described: a jetpack burst must
// stay the faster of the two, or "slow and endless" is only a comment. This is
// the number the brief expects to be retuned, so the guard is here to be met.
const _: () = assert!(WINGS_FLY_SPEED < JETPACK_MAX_SPEED);
// And a winged descent must be gentler than a hurtful landing, which is what
// makes wings a blanket fall-damage immunity **by construction** rather than by
// an exemption anyone had to write (T20.11, T21.02): you cannot arrive faster
// than you can fly.
const _: () = assert!(WINGS_FLY_SPEED < FALL_SAFE_SPEED);

/// *"and jump three times higher"* — **height**, and the name says so because
/// the next reader will otherwise assume it is the velocity (T21.02).
///
/// Height goes as `v² / 2g`, so three times the height is **√3 ≈ 1.732** times
/// the launch velocity. Writing 3.0 into `JUMP_VELOCITY` would give nine times
/// the height. `boots_jump_velocity_mult` is the only place that conversion
/// exists.
///
/// **Cut 3.0 -> 2.25 on 2026-09-16**, owner, reported from play: *"jumping power
/// of boots is way too high. reduce by 25%"*. Read as 25 % off the **height**,
/// which is what this constant is — 187 px of apex becomes 141 px.
///
/// **This no longer drives the fall threshold.** It used to: `boots_fall_safe_speed`
/// was `JUMP_VELOCITY * sqrt(BOOTS_JUMP_HEIGHT_MULT)`, so cutting the jump cut the
/// protection with it, and against the same day's doubled `FALL_SAFE_SPEED` that
/// would have left booted players *more* fragile than bare-footed ones — an
/// inversion `the_deepest_fall_still_costs_a_booted_player_a_third_of_an_unbooted_one`
/// catches on its `bare > deepest` control. Asked, the owner chose **"cut the
/// jump, leave fall protection alone"**, so the protection moved to
/// `BOOTS_FALL_HEIGHT_MULT` and kept its 3.0.
pub const BOOTS_JUMP_HEIGHT_MULT: f32 = 2.25;

/// The drop height ironman boots make free, as a multiple of a plain jump's.
///
/// **Split from `BOOTS_JUMP_HEIGHT_MULT` on 2026-09-16** and holds that
/// constant's old 3.0, so the fall protection is exactly what it was before the
/// jump was cut. See the ruling recorded there.
///
/// **The cost of the split, stated plainly:** boots no longer protect you from
/// precisely the height they throw you to. They now over-protect — 198 px of
/// free fall against a 141 px apex — so the old "safe from your own jump, by
/// construction" story is gone, and what replaces it is an assertion:
/// `boots_fall_safe_speed() >= JUMP_VELOCITY * boots_jump_velocity_mult()`,
/// which used to be an identity and is now a real inequality with 100 px/s in
/// it. That assertion is the only thing keeping a booted jump from charging
/// itself, so it is not decoration.
pub const BOOTS_FALL_HEIGHT_MULT: f32 = 3.0;

/// The launch-velocity multiplier `BOOTS_JUMP_HEIGHT_MULT` implies.
///
/// A function rather than a second constant because `f32::sqrt` is not `const`,
/// and derived rather than written out as `1.7320508` so the two can never
/// disagree — a hand-written root would keep the old height silently the day the
/// height constant is retuned.
pub fn boots_jump_velocity_mult() -> f32 {
    BOOTS_JUMP_HEIGHT_MULT.sqrt()
}

/// The landing speed below which a fall costs a **booted** player nothing, px/s.
///
/// It is the booted launch speed itself, and that is the whole design: the free
/// drop height is then `v²/2g`, which **is** the height a booted jump reaches.
/// 198 px both, by construction — not "about".
///
/// # The property being restored
///
/// `JUMP_VELOCITY` 430 against `FALL_SAFE_SPEED` 480 means your own jump never
/// hurts you — by arithmetic, with no exemption anywhere. Boots push the
/// identical act to `sqrt(3) x 430` = 744.8 px/s, past the threshold, so a
/// full-height jump would cost 19.9 health (at the 0.075 rate of the time; 6.6
/// at today's 0.025). This restores the property rather
/// than granting a new one, and `(impact - threshold)` still rises smoothly from
/// zero, so there is **no edge anywhere** — which is the base game's shape.
///
/// # Three rulings, two reversed — meet them here rather than repeat them
///
/// **Rejected 1: a time-bounded exemption**, gated on `ticks_since_jump` over a
/// window derived from the jump's round trip. Rejected because *an exemption
/// worth 19.9 health has an edge worth 19.9 health wherever it ends*, and no
/// derivation moves that edge somewhere a player will not meet it: measured, a
/// booted jump landing 30 px below its own launch — one ledge, ordinary terrain
/// — cost **23.9 health with nothing on screen to explain it** (at the 0.075
/// rate of the time; the same edge is 8.0 at T21.29's 0.025, still unexplained).
///
/// **Rejected 2: `FALL_SAFE_SPEED * boots_jump_velocity_mult()`** (831.4).
/// Rejected on two measurements. First, `resolve.rs::integrate` clamps `vel.y`
/// to `MAX_FALL_SPEED` **before** the impact is captured, so no landing in the
/// game exceeds 900 px/s and every fall past 289 px is the same landing — the
/// deepest fall the game can produce would have cost a booted player **5.15
/// health**. Second, that breaches the floor this file asserts about itself a
/// few lines above — *"less than a tenth of a health bar is a rule nobody
/// notices"* — and the compile-time guard could not see it, because it is
/// written over `FALL_SAFE_SPEED` and a booted fall never touches that value.
/// It would also have put the free drop height at 247 px against a 198 px apex,
/// so the "safe from the height it launches you to" story was approximate.
///
/// # What this one measures out at
///
/// At `FALL_DAMAGE_PER_SPEED` 0.025 (T21.29; the 0.075 figures were exactly three
/// times these):
///
/// ```text
///                        unbooted   booted
///     free drop height      82 px   198 px   (= the booted jump apex)
///     own jump            6.62 hp     0 hp
///     30 px below launch  7.98 hp  1.36 hp   (smooth: no edge)
///     deepest fall       10.50 hp  3.88 hp   (booted floor: a third of 10.50)
/// ```
pub fn boots_fall_safe_speed() -> f32 {
    // `BOOTS_FALL_HEIGHT_MULT`, not `BOOTS_JUMP_HEIGHT_MULT`: the two were one
    // constant until 2026-09-16 and the split is recorded at both of them.
    JUMP_VELOCITY * BOOTS_FALL_HEIGHT_MULT.sqrt()
}

// **The floor above, mirrored for the booted path — and it needs its own assert
// because the one above cannot see this path.** `FALL_SAFE_SPEED` does not
// appear anywhere in a booted player's fall; their threshold is the launch
// speed, so a guard written over `FALL_SAFE_SPEED` is blind to every retune of
// `BOOTS_JUMP_HEIGHT_MULT`. That is `docs/76` §G6 one path over, and it is the
// exact shape that would have shipped a 5.15 health deepest fall.
//
// **Restated as a ratio by T21.29 (coordinator-approved, 2026-09-15).** It used
// to be the absolute "more than a tenth of a bar", and the owner's cut of the
// rate to a third put the booted deepest fall at 3.88 hp and failed it — an
// absolute floor in hp was a builder's claim, and the owner's report overrules
// it. What the guard exists to stop is boots quietly becoming fall immunity, and
// that is a claim about the *discount*, which no retune of the rate can move:
// **a booted player's deepest fall must cost at least a third of an unbooted
// one's.** Written out,
// `(MAX_FALL_SPEED - launch) * 3 > MAX_FALL_SPEED - FALL_SAFE_SPEED` with
// `launch = JUMP_VELOCITY * sqrt(BOOTS_FALL_HEIGHT_MULT)`, i.e.
// `launch < MAX_FALL_SPEED - (MAX_FALL_SPEED - FALL_SAFE_SPEED) / 3`.
//
// `sqrt` is not `const`, so the root is squared away instead. Both sides are
// positive (the right-hand side because `FALL_SAFE_SPEED < MAX_FALL_SPEED` is
// asserted above), so squaring preserves the inequality, and `launch²` is
// `JUMP_VELOCITY² * BOOTS_FALL_HEIGHT_MULT` with no root left in it.
//
// **Headroom is thin and the number is the point: this fails at
// `BOOTS_FALL_HEIGHT_MULT` 3.69.** It used to fail at 3.12; the crossing moved
// out when `FALL_SAFE_SPEED` doubled on 2026-09-16 and shrank the unbooted band
// this is measured against. Today's 3.0 has 19 % to spare. **The constant this
// reads is the fall one, not the jump one** — since the split, raising
// `BOOTS_JUMP_HEIGHT_MULT` cannot reach this guard at all, which is why the
// assertion below about a booted jump charging itself had to become real.
const _: () = assert!(
    JUMP_VELOCITY * JUMP_VELOCITY * BOOTS_FALL_HEIGHT_MULT
        < (MAX_FALL_SPEED - (MAX_FALL_SPEED - FALL_SAFE_SPEED) / 3.0)
            * (MAX_FALL_SPEED - (MAX_FALL_SPEED - FALL_SAFE_SPEED) / 3.0)
);

// Boots must actually do something in both directions, or the item is art.
const _: () = assert!(BOOTS_SPEED_MULT > 1.0);
const _: () = assert!(BOOTS_JUMP_HEIGHT_MULT > 1.0);
const _: () = assert!(BOOTS_FALL_HEIGHT_MULT > 1.0);
// **A booted jump must not charge itself.** This was an identity while the two
// multipliers were one constant; since the 2026-09-16 split it is the only thing
// asserting that the protection still covers the launch it exists for.
const _: () = assert!(BOOTS_FALL_HEIGHT_MULT >= BOOTS_JUMP_HEIGHT_MULT);
// `boots_fall_safe_speed` is only meaningful while the base game's property
// holds. If `FALL_SAFE_SPEED` ever drops below `JUMP_VELOCITY` an ordinary jump
// starts hurting, and scaling a threshold that no longer clears the jump it is
// scaled from would describe something untrue. `FALL_SAFE_SPEED > JUMP_VELOCITY`
// is already asserted where those two are defined; this is a second reader of it.
//
// `JUMP_HEIGHT`/`JUMP_REACH` in `map/gen/traversal.rs` are compile-time consts
// derived from `JUMP_VELOCITY`, and they drive the **map generator's**
// traversability check. Boots let a player clear gaps the map was not built to
// require — more mobility rather than less, so nothing becomes unreachable, and
// the generator is deliberately left alone: it must keep generating maps a
// player *without* boots can cross.
// A fang that returned more life than the damage it dealt would make trading
// hits strictly profitable, which is a different item from the one asked for.
const _: () = assert!(LIFESTEAL_DAMAGE_PER_HP > 1.0);
// T21.31: the sky floor clears the rock within `(WINDOW - SMOOTH) / 2` of a cloud's
// centre, and that has to reach both ends of the widest cloud, or a wide cloud
// drifting past a narrow spire can put its edge inside the rock.
const _: () = assert!(CLOUD_FLOOR_WINDOW - CLOUD_FLOOR_SMOOTH >= CLOUD_W_MAX);
// A cloud has to fit under the lowest altitude the ground could ever allow:
// `GROUND_CREST_HEADROOM` of air above the highest ground, below `SKY_MARGIN`.
const _: () = assert!(
    CLOUD_TOP_MIN + CLOUD_W_MAX * CLOUD_ASPECT_MAX + CLOUD_ALTITUDE_MIN
        <= (SKY_MARGIN as f32) + (GROUND_CREST_HEADROOM as f32)
);

#[cfg(test)]
// Every assertion in this module is deliberately over compile-time constants —
// checking the relationships between them is the entire purpose of the file.
#[allow(clippy::assertions_on_constants)]
mod tests {
    use super::*;

    /// **The landmine past the floor** (T21.02).
    ///
    /// The compile-time assert beside `boots_fall_safe_speed` is the guard that
    /// actually binds — it fails at `BOOTS_JUMP_HEIGHT_MULT` **3.12**. This is
    /// the backstop behind it, and it names the second crossing: at **4.38** the
    /// booted launch speed reaches `MAX_FALL_SPEED` and the boots stop being a
    /// raised threshold and become **silent fall immunity**, because no landing
    /// the game can produce clears 900 px/s (`resolve.rs::integrate` clamps
    /// `vel.y` before the impact is captured).
    ///
    /// Two guards rather than one because they fail differently: past 3.12 the
    /// rule is merely too weak to notice, and past 4.38 it is gone. Whoever
    /// retunes that constant should meet both numbers rather than an assertion.
    #[test]
    fn the_boots_fall_threshold_never_reaches_terminal_velocity() {
        assert!(
            boots_fall_safe_speed() < MAX_FALL_SPEED,
            "a booted player is safe below {} px/s against a terminal velocity of              {MAX_FALL_SPEED} — no landing in the game can clear that, so boots              are fall immunity. BOOTS_JUMP_HEIGHT_MULT crosses here at 4.38, and              the compile-time floor beside `boots_fall_safe_speed` already fails              at 3.12",
            boots_fall_safe_speed()
        );
        // And it must clear the jump it exists for, or the item still hurts
        // itself. Equivalent to `FALL_SAFE_SPEED > JUMP_VELOCITY` scaled, but
        // asserted on the value actually used rather than on the pair it came
        // from.
        assert!(
            boots_fall_safe_speed() >= JUMP_VELOCITY * boots_jump_velocity_mult(),
            "a booted jump launches at {} and is safe only below {} — its own              landing is charged, which is the whole thing this exists to stop",
            JUMP_VELOCITY * boots_jump_velocity_mult(),
            boots_fall_safe_speed()
        );
    }

    /// The floor, measured through the same arithmetic the game runs, as the
    /// readable companion to the squared compile-time assert.
    ///
    /// **A ratio since T21.29**: the booted deepest fall keeps at least a third
    /// of the unbooted one's cost, whatever the rate is. The const assert proves
    /// it at build time with the root squared away; this states it in the form
    /// the sentence is written in, so a reader can check the two agree.
    #[test]
    fn the_deepest_fall_still_costs_a_booted_player_a_third_of_an_unbooted_one() {
        let deepest = (MAX_FALL_SPEED - boots_fall_safe_speed()) * FALL_DAMAGE_PER_SPEED;
        let bare = (MAX_FALL_SPEED - FALL_SAFE_SPEED) * FALL_DAMAGE_PER_SPEED;
        assert!(
            deepest * 3.0 > bare,
            "the deepest fall the game can produce costs a booted player              {deepest} health against {bare} unbooted — under a third, so boots are              drifting into fall immunity"
        );
        // The control: it is a *discount*, not a removal. An unbooted player
        // must still pay more for the same landing, or the two rules have
        // collapsed into one.
        assert!(
            bare > deepest,
            "boots did not reduce the deepest fall at all ({bare} against {deepest})"
        );
    }

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

    /// `GravityMode`'s three spellings agree with each other, both ways.
    ///
    /// The loop is over `ALL`, so a fourth variant that forgot an arm fails
    /// here rather than at whichever of the socket, the replay and the panel
    /// reads it first. The three assertions after it are the control: a parser
    /// that returned `Some(Standard)` for everything would satisfy the loop.
    #[test]
    fn gravity_parses_and_round_trips() {
        for g in GravityMode::ALL {
            assert_eq!(GravityMode::parse(g.as_str()), Some(g));
            assert_eq!(GravityMode::from_u8(g.as_u8()), Some(g));
        }
        assert_eq!(GravityMode::parse("SPACE"), Some(GravityMode::Space));
        assert_eq!(
            GravityMode::parse("none"),
            None,
            "the third mode is `space`"
        );
        assert_eq!(GravityMode::from_u8(3), None);
        // The default is what every existing match plays under, and T22.01's
        // whole claim is that nothing changes without the host asking.
        assert_eq!(GravityMode::default(), GravityMode::Standard);
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

    /// §F1: a bullet must be outside its own shooter before the owner grace
    /// ends, or the fastest gun in the game kills whoever fires it.
    ///
    /// The grace is a *tick count*, so the thing it has to clear is a distance
    /// per tick — and the fastest muzzle speed is the binding case. Asserted
    /// rather than reasoned about in a comment, because the failure is a weapon
    /// that kills its owner and looks like a physics bug.
    #[test]
    fn a_bullet_clears_its_owner_before_the_grace_ends() {
        let fastest = DEAGLE_MUZZLE_SPEED
            .max(REVOLVER_MUZZLE_SPEED)
            .max(PISTOL_MUZZLE_SPEED)
            .max(MACHINEGUN_MUZZLE_SPEED)
            .max(SMG_MUZZLE_SPEED);
        // It spawns at MUZZLE_OFFSET, which must already be outside the body.
        assert!(
            MUZZLE_OFFSET > PLAYER_W / 2.0,
            "a bullet spawns inside its owner: MUZZLE_OFFSET {MUZZLE_OFFSET} vs half-body {}",
            PLAYER_W / 2.0
        );
        // And by the end of the grace it is far enough that no plausible body
        // could still contain it.
        let after_grace = MUZZLE_OFFSET + fastest * SIM_DT * PROJECTILE_OWNER_GRACE_TICKS as f32;
        assert!(
            after_grace > PLAYER_W.max(PLAYER_H),
            "a bullet is still inside its owner when the grace ends: {after_grace} px"
        );
    }

    #[test]
    fn jump_apex_matches_the_documented_height() {
        // docs/20-player-movement.md §4 claims ~66 px.
        let apex = JUMP_VELOCITY * JUMP_VELOCITY / (2.0 * GRAVITY);
        assert!((apex - 66.0).abs() < 1.0, "apex was {apex}");
    }

    /// Every mode's multiplier, and the three are pairwise different.
    ///
    /// The `Space` arm used to be asserted **equal to `Standard`**, as a claim
    /// T22.03 had to break on purpose rather than a gap someone could close by
    /// accident. T22.03 broke it; the arm stays named, pointed the other way,
    /// so a build that quietly restored standard gravity to the space mode
    /// still fails here.
    #[test]
    fn every_gravity_mode_has_a_multiplier() {
        assert_eq!(GravityMode::Standard.scale(), 1.0);
        assert_eq!(GravityMode::Low.scale(), LOW_GRAVITY_SCALE);
        assert_eq!(
            GravityMode::Space.scale(),
            0.0,
            "space is no global gravity — a scale of zero, never a GRAVITY of zero"
        );
        // Pairwise distinct, so no two modes can collapse into each other
        // without this failing.
        for (a, b) in [
            (GravityMode::Standard, GravityMode::Low),
            (GravityMode::Standard, GravityMode::Space),
            (GravityMode::Low, GravityMode::Space),
        ] {
            assert_ne!(a.scale(), b.scale(), "{a:?} and {b:?} scale the same");
        }
    }

    /// What `LOW_GRAVITY_SCALE`'s **value** has to be true of.
    ///
    /// **Everything else about low gravity is pinned to this constant**, which
    /// means everything else moves with it and none of it can report the
    /// constant being wrong (`CLAUDE.md`, "a suite pinned to the constant cannot
    /// detect the constant changing"). This is the assertion of the other kind:
    /// two bounds derived from things that do *not* move with it, so the value
    /// is bracketed rather than merely restated. It is
    /// `capacity.rs::max_rooms_carries_its_basis`'s shape.
    ///
    /// **The floor — it has to be visible.** Low gravity that nobody can see is
    /// a lobby row that does nothing. The apex has to gain at least a whole
    /// player height, which puts the ceiling at `k <= 0.702`.
    ///
    /// **The ceiling — a fall must still be able to kill you.** Impact is
    /// `sqrt(2 * g * k * h)` and `PlayerState::fall_damage` subtracts a *fixed*
    /// `FALL_SAFE_SPEED` before scaling, so a small enough `k` makes the longest
    /// fall the smallest map can hold land under the safe speed and do literally
    /// zero damage — fall damage becomes dead code in this mode and nothing else
    /// in the suite would say so. That puts the floor at `k > 0.161`.
    ///
    /// The full map height is the honest bound to use: it is an **upper** bound
    /// on any fall that can happen, so requiring it to hurt is the weakest form
    /// of the claim.
    #[test]
    fn low_gravity_carries_its_basis() {
        assert!(
            LOW_GRAVITY_SCALE < 1.0 && LOW_GRAVITY_SCALE > 0.0,
            "low gravity must be a reduction: {LOW_GRAVITY_SCALE}"
        );

        // Floor: visibly floatier. Apex is v^2 / 2gk, so the gain over standard
        // is the standard apex times (1/k - 1).
        let standard_apex = JUMP_VELOCITY * JUMP_VELOCITY / (2.0 * GRAVITY);
        let gained = standard_apex * (1.0 / LOW_GRAVITY_SCALE - 1.0);
        assert!(
            gained >= PLAYER_H,
            "low gravity adds only {gained:.1} px to a {standard_apex:.1} px jump — \
             less than the {PLAYER_H} px player it is supposed to be visible on"
        );

        // Ceiling: the longest fall the smallest map can hold still hurts.
        // `MAX_FALL_SPEED` caps the impact, which is why this is not simply
        // monotone in `k` — a tall enough fall reaches terminal velocity under
        // any gravity, and then only the *height needed* moves.
        let drop = MAP_SMALL_H as f32;
        let impact = (2.0 * GRAVITY * LOW_GRAVITY_SCALE * drop)
            .sqrt()
            .min(MAX_FALL_SPEED);
        assert!(
            impact > FALL_SAFE_SPEED,
            "under low gravity a {drop:.0} px fall — the whole height of the \
             smallest map — lands at {impact:.0} px/s against a safe speed of \
             {FALL_SAFE_SPEED}, so no fall anywhere in the game can hurt anyone"
        );
    }
}
