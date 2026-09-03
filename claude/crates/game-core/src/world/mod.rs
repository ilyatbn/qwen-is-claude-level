//! The `World`: everything the simulation owns, advanced one tick at a time.
//!
//! This is the object the server's room task owns outright and the replay binary
//! re-runs headlessly. It contains no clock — `dt` is passed in — and no I/O, so
//! the same code produces the same result at 60 Hz on a server, at full speed in a
//! replay, and in the browser through WASM (`docs/01-architecture.md`).
//!
//! See `docs/41-server-loop-rooms.md` §2 for the tick order, which is a contract.

pub mod birds;
pub mod cycle;
pub mod teleport;
pub mod tombstones;

use birds::{BirdId, BirdKind, Birds};
use tombstones::Tombstones;

use crate::constants::{
    MapScale, ENDED_SECONDS, MAX_INPUT_QUEUE, MAX_PLAYERS, ROUND_SECONDS, TELEPORT_PADS,
    WARMUP_SECONDS,
};
use crate::items::registry::{def, ItemId, ItemKind, WeaponId};
use crate::items::spawning::{assign_buried_items, place_initial, reveal_buried, SpawnSchedule};
use crate::items::world::{SpawnSource, WorldItemId, WorldItems};
use crate::map::gen::surface::is_standable;
use crate::map::meta::TeleportPad;
use crate::map::{CarveResult, Map};
use crate::math::{Aabb, Point, Vec2};
use crate::player::apply_input;
use crate::player::input::Input;
use crate::player::respawn::choose_respawn_pad;
use crate::player::state::{
    choose_respawn, surface_to_centre, DeathCause, PlayerId, PlayerState, UseError,
};
use crate::rng::{range_f32, substream, ChaCha8Rng};
use crate::weapons::burn::BurnKind;
use crate::weapons::defs::{self, BurnZone, Burst, Delivery};
use crate::weapons::explode::{
    explode, fire_hitscan, BlastSource, DamageSource, EffectKind, HitId, HitTarget,
};
use crate::weapons::projectile::{ProjectileId, ProjectileOutcome, Projectiles};
use crate::weapons::smoke::SmokeField;

use crate::effects::fog::HeavyFog;
use crate::effects::lava::LavaBurst;
use crate::effects::meteor::MeteorShower;
use crate::effects::scheduler::{EffectEvent, EffectPhase, EffectScheduler};
use crate::effects::toxic::ToxicRain;

pub use cycle::{cycle_at, cycle_u, darkness_at, fov_radius, CycleState, DayPhase};

// ---------------------------------------------------------------------------
// Round phase
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum RoundPhase {
    Lobby,
    Warmup,
    Playing,
    Ended,
}

impl RoundPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            RoundPhase::Lobby => "lobby",
            RoundPhase::Warmup => "warmup",
            RoundPhase::Playing => "playing",
            RoundPhase::Ended => "ended",
        }
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// One variant per row of `docs/40-net-protocol.md` §3.
///
/// `game-core` accumulates these and knows nothing about a network; the server
/// drains them and decides scope and encoding (T6.07).
#[derive(Clone, Debug, PartialEq)]
pub enum GameEvent {
    /// The authoritative terrain change. `seq` is per-round monotonic and clients
    /// apply carves in that order, which is what keeps every mask bit-identical
    /// (`docs/11-map-destruction.md` §6).
    Carve {
        tick: u32,
        seq: u32,
        x: i32,
        y: i32,
        r: i32,
        kind: CarveKind,
    },
    /// A swept-circle carve — lava channels. A separate variant because a client
    /// replaying it as a circle would end up with a different mask, and the whole
    /// point of shipping carves rather than the mask is that they match exactly.
    CarveCapsule {
        tick: u32,
        seq: u32,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
        r: i32,
    },
    /// Cosmetic. Deliberately separate from `Carve` so a client that drops the
    /// flash still gets the terrain right.
    Explosion {
        tick: u32,
        x: f32,
        y: f32,
        r: f32,
        kind: CarveKind,
    },
    ProjectileSpawn {
        tick: u32,
        id: ProjectileId,
        weapon: WeaponId,
        owner: PlayerId,
        x: f32,
        y: f32,
        vx: f32,
        vy: f32,
    },
    /// Where a live projectile is **now**.
    ///
    /// `ProjectileSpawn` carries the position a projectile was *created* at and
    /// nothing carried where it went, so every client drew every rocket, grenade
    /// and meteor frozen at its muzzle for the whole of its flight. That is
    /// §C7's crate bug one layer over — `ItemMove` is the same event for items,
    /// added for the same reason — and it is the single cause behind both §C22
    /// ("only meteor explosions are visible": a meteor spawns at `y = -32`, so
    /// it is drawn above the top of the map for its entire life) and §C23
    /// ("gun projectiles are still invisible": a rocket is drawn as a dot on the
    /// muzzle). One defect, three symptoms.
    ProjectileMove {
        tick: u32,
        id: ProjectileId,
        x: f32,
        y: f32,
    },
    ProjectileDespawn {
        tick: u32,
        id: ProjectileId,
        reason: DespawnReason,
    },
    Hitscan {
        tick: u32,
        owner: PlayerId,
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        hit: bool,
    },
    /// A melee swing (§B6). Cosmetic on the client — the damage is already in
    /// the damage events — but it is what makes a hit visible: a swing you
    /// cannot see reads as damage from nowhere.
    Melee {
        tick: u32,
        owner: PlayerId,
        weapon: WeaponId,
        x: f32,
        y: f32,
        aim: f32,
        reach: f32,
        arc: f32,
        hits: u8,
    },
    /// One tick of cone spray (§B6).
    ///
    /// **Nothing emits this since §F10.2.** `Delivery::Cone` is retired and the
    /// flamethrower spawns flames, which travel as ordinary `ProjectileSpawn`s.
    /// The variant and its client handler are left standing deliberately —
    /// T19.12's own note says to leave the client *compiling, not working*, and
    /// T19.13 is the task that removes the drawing. It is recorded here rather
    /// than left to be discovered, because a producer-less event is the
    /// "mechanism wired to nothing" shape and the next reader deserves to know
    /// it is on somebody's list.
    Cone {
        tick: u32,
        owner: PlayerId,
        weapon: WeaponId,
        x: f32,
        y: f32,
        aim: f32,
        range: f32,
        arc: f32,
    },
    /// A mine was placed (§B6). It must be *visible* at close range — invisible
    /// instant death is not fun; a trap you could have spotted is.
    MinePlaced {
        tick: u32,
        id: crate::weapons::placed::MineId,
        owner: PlayerId,
        weapon: WeaponId,
        x: f32,
        y: f32,
    },
    /// A mine left the world: detonated, timed out, or destroyed by a blast.
    MineEnded {
        tick: u32,
        id: crate::weapons::placed::MineId,
        reason: crate::weapons::placed::MineEnd,
    },
    /// A bird entered the map (§C16).
    ///
    /// `kind` is on the spawn rather than derived client-side, because the two
    /// kinds carry different rewards and a player who cannot tell them apart
    /// cannot decide whether one is worth a rocket.
    BirdSpawn {
        tick: u32,
        id: BirdId,
        kind: u8,
        x: f32,
        y: f32,
        right: bool,
    },
    /// Where a live bird is now, at `SNAPSHOT_HZ` like every other moving thing.
    BirdMove {
        tick: u32,
        id: BirdId,
        x: f32,
        y: f32,
    },
    /// A bird left the world. `killed` separates "shot down" from "flew off",
    /// which is the difference between a puff of feathers and nothing at all.
    BirdDespawn {
        tick: u32,
        id: BirdId,
        killed: bool,
    },
    ItemSpawn {
        tick: u32,
        world_item_id: WorldItemId,
        item_id: ItemId,
        count: u8,
        x: f32,
        y: f32,
        source: SpawnSource,
    },
    /// Where a falling item is now, and whether it has come to rest.
    ///
    /// `ItemSpawn` carries the position an item was *created* at, which for a
    /// crate is the sky. Nothing carried where it went, so every observer drew
    /// crates hanging at `SKY_MARGIN / 2` for the rest of the round while the
    /// real crate sat on the ground somewhere below, pickupable by anyone who
    /// walked over the spot they could not see (§C7).
    ItemMove {
        tick: u32,
        world_item_id: WorldItemId,
        x: f32,
        y: f32,
        grounded: bool,
    },
    ItemPickup {
        tick: u32,
        world_item_id: WorldItemId,
        player_id: PlayerId,
    },
    ItemDespawn {
        tick: u32,
        world_item_id: WorldItemId,
    },
    CrateSpawn {
        tick: u32,
        world_item_id: WorldItemId,
        x: f32,
        y: f32,
    },
    /// Owner only.
    Inventory {
        tick: u32,
        player_id: PlayerId,
    },
    /// Victim and attacker only.
    Damage {
        tick: u32,
        victim: PlayerId,
        attacker: Option<PlayerId>,
        amount: f32,
        cause: DeathCause,
    },
    Death {
        tick: u32,
        victim: PlayerId,
        attacker: Option<PlayerId>,
        cause: DeathCause,
    },
    Respawn {
        tick: u32,
        id: PlayerId,
        x: f32,
        y: f32,
    },
    /// A pad fired (§C5). Everyone sees it: the departure and the arrival are
    /// both things other players need to be able to react to, and a snapshot
    /// alone would show the player simply appearing somewhere else.
    Teleport {
        tick: u32,
        id: PlayerId,
        from_pad: u8,
        to_pad: u8,
        x: f32,
        y: f32,
    },
    /// A grave where someone fell (§B8).
    TombstoneSpawn {
        tick: u32,
        id: crate::world::tombstones::TombstoneId,
        owner: PlayerId,
        x: f32,
        y: f32,
        skin_id: u16,
    },
    /// Evicted by `MAX_TOMBSTONES`, oldest first.
    TombstoneDespawn {
        tick: u32,
        id: crate::world::tombstones::TombstoneId,
    },
    Score {
        tick: u32,
    },
    EffectStart {
        tick: u32,
        id: u32,
        kind: EffectKind,
        seed: u64,
        duration: f32,
    },
    EffectPhaseChanged {
        tick: u32,
        id: u32,
        phase: EffectPhase,
    },
    EffectEnd {
        tick: u32,
        id: u32,
    },
    /// A hazard that ran out. Only smoke uses it today — burn patches expire
    /// on the client's own clock from the duration they were spawned with.
    HazardEnded {
        tick: u32,
        id: u32,
    },
    HazardSpawn {
        tick: u32,
        id: u32,
        kind: HazardKind,
        x: f32,
        y: f32,
        r: f32,
        duration: f32,
    },
    PhaseChange {
        tick: u32,
        day_phase: DayPhase,
    },
    RoundState {
        tick: u32,
        phase: RoundPhase,
        time_left: f32,
    },
    RoundEnd {
        tick: u32,
    },
}

impl GameEvent {
    /// Every event carries the tick it happened on, so a client can order it
    /// against snapshots (`docs/40-net-protocol.md` §3).
    pub fn tick(&self) -> u32 {
        match self {
            GameEvent::Carve { tick, .. }
            | GameEvent::CarveCapsule { tick, .. }
            | GameEvent::Explosion { tick, .. }
            | GameEvent::ProjectileSpawn { tick, .. }
            | GameEvent::ProjectileMove { tick, .. }
            | GameEvent::ProjectileDespawn { tick, .. }
            | GameEvent::Hitscan { tick, .. }
            | GameEvent::Melee { tick, .. }
            | GameEvent::Cone { tick, .. }
            | GameEvent::MinePlaced { tick, .. }
            | GameEvent::MineEnded { tick, .. }
            | GameEvent::BirdSpawn { tick, .. }
            | GameEvent::BirdMove { tick, .. }
            | GameEvent::BirdDespawn { tick, .. }
            | GameEvent::ItemSpawn { tick, .. }
            | GameEvent::ItemMove { tick, .. }
            | GameEvent::ItemPickup { tick, .. }
            | GameEvent::ItemDespawn { tick, .. }
            | GameEvent::CrateSpawn { tick, .. }
            | GameEvent::Inventory { tick, .. }
            | GameEvent::Damage { tick, .. }
            | GameEvent::Death { tick, .. }
            | GameEvent::Respawn { tick, .. }
            | GameEvent::Teleport { tick, .. }
            | GameEvent::TombstoneSpawn { tick, .. }
            | GameEvent::TombstoneDespawn { tick, .. }
            | GameEvent::Score { tick }
            | GameEvent::EffectStart { tick, .. }
            | GameEvent::EffectPhaseChanged { tick, .. }
            | GameEvent::EffectEnd { tick, .. }
            | GameEvent::HazardEnded { tick, .. }
            | GameEvent::HazardSpawn { tick, .. }
            | GameEvent::PhaseChange { tick, .. }
            | GameEvent::RoundState { tick, .. }
            | GameEvent::RoundEnd { tick } => *tick,
        }
    }
}

/// Cosmetic only — the client picks particles from it. The terrain result is the
/// same whatever this says.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum CarveKind {
    Weapon,
    Meteor,
    Lava,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DespawnReason {
    Exploded,
    Expired,
    /// Left the bottom of the map (§C15). Neither of the other two: it did not go
    /// off, and it did not time out.
    Void,
    /// A bullet that flew its `range` and stopped (§F1).
    ///
    /// Its own word rather than `Void` or `Expired`, because it is neither: it
    /// did not leave the map and it did not run out of clock. The client removes
    /// the projectile on any reason, so this costs nothing on the wire and keeps
    /// the log honest about why a round vanished.
    Spent,
    /// A flame dropped by `FLAME_MAX_LIVE` (§F10). It did not burn out — the
    /// budget did.
    ///
    /// Its own word for the same reason `Spent` is: this is the only despawn a
    /// player can cause by holding a trigger too long, and a round where fire is
    /// vanishing early should say so in its log rather than reading as `Expired`.
    Culled,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum HazardKind {
    Meteor,
    LavaVent,
    /// Thrown ordnance (§B7). `Smoke` does no damage at all.
    Fire,
    Toxic,
    Smoke,
}

// ---------------------------------------------------------------------------
// Deferred damage
// ---------------------------------------------------------------------------

/// Damage recorded during a blast, applied afterwards.
///
/// `explode` needs `&mut Vec2` on every player's velocity *and* a callback that
/// mutates the same players' health — two mutable borrows of one slice. Recording
/// `(victim, amount, source)` and applying it after the borrow ends keeps exactly
/// one damage path: shields, i-frames and death stay in `PlayerState` rather than
/// being re-implemented per weapon and per effect.
///
/// The callback still returns the **correct** boolean, because "was it applied"
/// depends only on `alive` and `iframes_until`, both of which are `Copy` and can be
/// read before the borrow (`docs/70-amendments-v2.md` §A20).
type DamageLog = std::rc::Rc<std::cell::RefCell<Vec<(PlayerId, f32, DamageSource)>>>;

/// A damageable thing's identity as a weapon sees it: id, centre, alive, hit box.
type TargetMeta = (HitId, Vec2, bool, f32, f32);

/// Damage logged against birds this tick: `(bird, amount)`.
///
/// Separate from `DamageLog` because a bird has no shield, no i-frames and no
/// `DamageSource` to care about — folding it in would give `PlayerState`'s damage
/// path a second meaning.
type BirdLog = std::rc::Rc<std::cell::RefCell<Vec<(BirdId, f32)>>>;

/// Everything a weapon call needs to see, players **and** birds.
///
/// One function builds both, and that is the whole design: §C16 says birds take
/// damage from anything, and there are eleven call sites that damage things. A
/// bird slice each of them had to remember to pass is a bird slice eight of them
/// would forget (CLAUDE.md: share the guard, or share the function). Because
/// birds ride in the same `Vec<HitTarget>`, every weapon path — blast, ray,
/// swing, cone, mine, lava, meteor — hits them without knowing they exist.
fn hit_targets(
    players: &[PlayerState],
    birds: &Birds,
    log: &DamageLog,
    bird_log: &BirdLog,
    now: f32,
) -> (Vec<Box<DamageFn>>, Vec<TargetMeta>, Vec<Vec2>) {
    let mut meta: Vec<TargetMeta> = players
        .iter()
        .map(|p| {
            (
                HitId::Player(p.id),
                p.body.pos,
                p.alive,
                crate::constants::PLAYER_W,
                crate::constants::PLAYER_H,
            )
        })
        .collect();
    let mut closures: Vec<Box<DamageFn>> = players
        .iter()
        .map(|p| {
            let id = p.id;
            let refuses = !p.alive || p.invulnerable(now);
            let log = log.clone();
            Box::new(move |amount: f32, src: DamageSource| {
                if refuses {
                    return false;
                }
                log.borrow_mut().push((id, amount, src));
                true
            }) as Box<DamageFn>
        })
        .collect();

    // Birds after the players, and the order is the contract `targets` relies on.
    for b in birds.iter() {
        let (w, h) = b.size();
        meta.push((HitId::Bird(b.id), b.pos, true, w, h));
        let id = b.id;
        let log = bird_log.clone();
        closures.push(Box::new(move |amount: f32, _src: DamageSource| {
            log.borrow_mut().push((id, amount));
            true
        }) as Box<DamageFn>);
    }

    // A bird is never thrown: §C16 gives it a fixed sine path, so knockback has
    // nowhere to go. These exist because `HitTarget` needs a `&mut Vec2` and
    // writing into a scratch is honest about the value being discarded — the
    // alternative is a bird whose velocity a blast has quietly edited.
    let bird_vels = vec![Vec2::new(0.0, 0.0); birds.len()];
    (closures, meta, bird_vels)
}

type DamageFn = dyn FnMut(f32, DamageSource) -> bool;

/// Zip the deferred closures back onto the players' velocities.
/// Zip the deferred closures back onto the velocities they may knock.
///
/// `meta` and `closures` are players-then-birds, exactly as `hit_targets` built
/// them; the split point is `players.len()`.
fn targets<'a>(
    players: &'a mut [PlayerState],
    closures: &'a mut [Box<DamageFn>],
    meta: &[TargetMeta],
    bird_vels: &'a mut [Vec2],
) -> Vec<HitTarget<'a>> {
    let n = players.len();
    let (player_closures, bird_closures) = closures.split_at_mut(n);
    let mut out: Vec<HitTarget<'a>> = players
        .iter_mut()
        .zip(player_closures.iter_mut())
        .zip(meta.iter())
        .map(|((p, c), (id, pos, alive, w, h))| HitTarget {
            id: *id,
            w: *w,
            h: *h,
            pos: *pos,
            vel: &mut p.body.vel,
            alive: *alive,
            apply_damage: &mut **c,
        })
        .collect();
    out.extend(
        bird_vels
            .iter_mut()
            .zip(bird_closures.iter_mut())
            .zip(meta[n..].iter())
            .map(|((v, c), (id, pos, alive, w, h))| HitTarget {
                id: *id,
                w: *w,
                h: *h,
                pos: *pos,
                vel: v,
                alive: *alive,
                apply_damage: &mut **c,
            }),
    );
    out
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/// Whether this world runs the weather, and which weather.
///
/// **A development switch, in the shape `dev_poisoned` and `dev_start_health`
/// already established** (`game-server/src/config.rs`), and for the same reason
/// they exist: a browser check whose subject is a small pixel difference cannot
/// also be racing an effect that changes the whole frame. §F9's veil is
/// `FOG_SCREEN_ALPHA` — 0.8 — so a fog scales *every* colour delta in the game
/// by 0.2, and `crates`'s parachute assertion measured 66 without fog and 11-14
/// with it, three runs out of three. That check's claim is about a canopy, not
/// about the weather.
///
/// `Always` is the same switch pointed the other way, and it is what makes the
/// veil provable in a real match at all: nothing else in this codebase can make
/// a *networked* round produce a chosen effect, which is why §F9's acceptance
/// would otherwise have stopped at the sandbox — the §C1 half-fix this project
/// has paid for four times.
///
/// **Deliberately not in the replay header**, following `dev_poisoned` and
/// `dev_start_health`, which are also simulation-changing and also absent. A
/// replay of a round recorded under a dev switch is already not reproducible;
/// adding a fifth carrier for the fifth switch is a version bump per debug flag.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum WeatherMode {
    /// The scheduler picks and times effects — the shipping behaviour.
    #[default]
    Auto,
    /// No effect ever starts.
    Off,
    /// Only this kind, and it is restarted as soon as it ends.
    Always(EffectKind),
}

pub struct World {
    pub map: Map,
    /// **Kept sorted by id and iterated directly.** Never a `HashMap`: two players
    /// reaching one item on the same tick must resolve identically in a live round
    /// and in a replay, and hash iteration order makes that a coin flip that only
    /// misbehaves under load.
    pub players: Vec<PlayerState>,
    pub items: WorldItems,
    pub projectiles: Projectiles,
    /// Ground fire, shared by the flamethrower, molotovs and lava (§B6).
    pub burn: crate::weapons::burn::BurnField,
    /// Placed mines (§B6).
    pub mines: crate::weapons::placed::Mines,
    /// Smoke clouds (§B7). Vision denial only — no damage path touches this.
    pub smoke: SmokeField,
    /// One id space for every hazard a *weapon* spawns, so a cloud and a fire
    /// can never claim the same id and cancel each other on the client.
    hazard_seq: u32,
    pub tombstones: Tombstones,
    /// §C16. Public because the server serialises them and the state hash covers
    /// them; nothing outside this module mutates one.
    pub birds: Birds,
    pub spawn_schedule: SpawnSchedule,
    pub effects: EffectScheduler,
    /// See [`WeatherMode`]. `Auto` everywhere but a development switch.
    pub weather_mode: WeatherMode,
    pub buried_items: Vec<ItemId>,
    pub round_time: f32,
    pub tick: u32,
    pub phase: RoundPhase,
    pub wind: f32,
    pub seed: u64,
    /// How many times a respawn fell back off a pad (`docs/21` §4).
    ///
    /// **Zero is the claim, and it needs somewhere to be read.** `resolve_deaths`
    /// took `choose_respawn_pad(..).pos` and dropped `.pad` on the floor, so the
    /// one path §C5 says is unreachable would have fired in silence — the
    /// re-validation is only worth keeping if somebody notices it firing.
    /// T15.01 asked for exactly this assertion.
    pub respawn_fallbacks: u32,

    events: Vec<GameEvent>,
    rng: ChaCha8Rng,
    carve_seq: u32,
    /// Per-player queued inputs, parallel to `players` by id lookup.
    pending: Vec<(PlayerId, Input)>,
    prev_input: Vec<(PlayerId, Input)>,
    phase_started_at: f32,
    /// `Playing` duration. Defaults to `ROUND_SECONDS`; overridden for tests.
    round_seconds: f32,
    last_day_phase: DayPhase,

    toxic: Option<(u32, ToxicRain)>,
    meteor: Option<(u32, MeteorShower)>,
    lava: Option<(u32, LavaBurst)>,
    fog: Option<(u32, HeavyFog)>,
}

impl World {
    pub fn new(seed: u64, scale: MapScale) -> Self {
        Self::with_buried_secret(seed, scale, 0)
    }

    /// A world whose buried slots and their contents are hidden behind a secret
    /// that never crosses the wire (`docs/70-amendments-v2.md` §A31).
    ///
    /// `welcome` carries the seed and `game-core` ships as WASM, so without this
    /// a modified client recomputes every buried slot exactly. Defaults to 0
    /// everywhere except a live server, so goldens and sweeps are unaffected.
    pub fn with_buried_secret(seed: u64, scale: MapScale, buried_secret: u64) -> Self {
        Self::build(
            seed,
            scale,
            buried_secret,
            crate::constants::DEFAULT_MAP_GENERATOR,
        )
    }

    /// As `with_buried_secret`, against a named terrain generator.
    ///
    /// The server passes `MAP_GENERATOR` down here so v1 and v2 can be compared on
    /// a running box. Nothing else in the world varies with it: the generator
    /// produces a mask, and everything downstream consumes a mask.
    pub fn with_generator(
        seed: u64,
        scale: MapScale,
        buried_secret: u64,
        generator: crate::constants::MapGenerator,
    ) -> Self {
        Self::build(seed, scale, buried_secret, generator)
    }

    fn build(
        seed: u64,
        scale: MapScale,
        buried_secret: u64,
        generator: crate::constants::MapGenerator,
    ) -> Self {
        let map = crate::map::generate_full(seed, scale, buried_secret, generator);
        let wind = map.meta.wind;
        let buried_items = assign_buried_items(&map, seed ^ buried_secret);
        let mut items = WorldItems::new();
        let initial_draws = place_initial(&mut items, &map, seed, 0.0);

        let birds = Birds::new(seed, &map);
        World {
            burn: Default::default(),
            respawn_fallbacks: 0,
            mines: Default::default(),
            smoke: Default::default(),
            hazard_seq: 0,
            map,
            players: Vec::new(),
            items,
            projectiles: Projectiles::new(),
            tombstones: Tombstones::default(),
            birds,
            spawn_schedule: SpawnSchedule::new(seed, 0.0, initial_draws),
            effects: EffectScheduler::new(seed, 0.0),
            weather_mode: WeatherMode::Auto,
            buried_items,
            round_time: 0.0,
            tick: 0,
            phase: RoundPhase::Warmup,
            round_seconds: ROUND_SECONDS,
            wind,
            seed,
            events: Vec::new(),
            rng: substream(seed, "world"),
            carve_seq: 0,
            pending: Vec::new(),
            prev_input: Vec::new(),
            phase_started_at: 0.0,
            last_day_phase: cycle_at(0.0).phase,
            toxic: None,
            meteor: None,
            lava: None,
            fog: None,
        }
    }

    // ---------------------------------------------------------------- players

    pub fn add_player(&mut self, id: PlayerId, skin_id: u16, _name: String) {
        if self.players.iter().any(|p| p.id == id) {
            return;
        }
        let pos = self.spawn_for(id);
        let mut p = PlayerState::new(id, pos, skin_id);
        // A mid-round joiner is not fair game the instant they load in.
        p.iframes_until = self.round_time + crate::constants::SPAWN_IFRAMES;
        self.players.push(p);
        // Sorted by id, always — see the field comment.
        self.players.sort_by_key(|p| p.id);
        self.prev_input.push((id, Input::default()));
        self.prev_input.sort_by_key(|(i, _)| *i);
    }

    /// Where a joining player starts.
    ///
    /// Before the round is live, the point is keyed by the player's **id** rather
    /// than chosen relative to whoever is already seated. Both give well-separated
    /// spawns — `MapMeta.spawn_points` is farthest-point sampled and there are at
    /// least `MAX_PLAYERS` of them — but only the id-keyed one is independent of
    /// the order the players happened to arrive in. Choosing relative to the
    /// already-seated made a lobby that filled 1,2,3 diverge from one that filled
    /// 3,2,1, which would show up as a replay that reproduces a different round.
    ///
    /// Once `Playing`, a joiner takes the safest point given who is alive right now
    /// (`docs/41-server-loop-rooms.md` §4). That *is* order-dependent, and
    /// correctly so: a mid-round join is an input to the round, recorded with its
    /// tick in the replay.
    fn spawn_for(&mut self, id: PlayerId) -> Vec2 {
        if self.phase == RoundPhase::Playing {
            let living: Vec<Vec2> = self
                .players
                .iter()
                .filter(|p| p.alive)
                .map(|p| p.body.pos)
                .collect();
            return choose_respawn(&self.map, &living, &mut self.rng);
        }
        let pts = &self.map.meta.spawn_points;
        if pts.is_empty() {
            return choose_respawn(&self.map, &[], &mut self.rng);
        }
        let p = pts[id as usize % pts.len()];
        if is_standable(&self.map.mask, p.x, p.y) {
            // A spawn point is a feet line, not a centre (`choose_respawn`).
            surface_to_centre(Vec2::new(p.x as f32, p.y as f32))
        } else {
            choose_respawn(&self.map, &[], &mut self.rng)
        }
    }

    pub fn remove_player(&mut self, id: PlayerId) {
        self.players.retain(|p| p.id != id);
        self.prev_input.retain(|(i, _)| *i != id);
        self.pending.retain(|(i, _)| *i != id);
    }

    pub fn player(&self, id: PlayerId) -> Option<&PlayerState> {
        self.players.iter().find(|p| p.id == id)
    }

    pub fn player_mut(&mut self, id: PlayerId) -> Option<&mut PlayerState> {
        self.players.iter_mut().find(|p| p.id == id)
    }

    pub fn queue_input(&mut self, id: PlayerId, input: Input) {
        self.pending.push((id, input));
    }

    /// Unconsumed inputs still queued. Bounded by `MAX_INPUT_QUEUE` per player
    /// after each tick (`docs/70-amendments-v2.md` §A30).
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_full(&self) -> bool {
        self.players.len() >= MAX_PLAYERS
    }

    // ----------------------------------------------------------------- phases

    /// Override the `Playing` duration.
    ///
    /// `ROUND_SECONDS` is documented as an environment override "for testing"
    /// (`docs/41-server-loop-rooms.md` §5), and it was parsed into `Config` and
    /// then never reached the phase machine — the world used the constant, so
    /// `ROUND_SECONDS=5` produced a 240-second round and a test asserting on
    /// phase transitions would have hung rather than failed.
    /// The last carve `seq` this world emitted.
    ///
    /// It goes in `map_init` so a client knows which carve its mask is current
    /// as of. Without it a joiner resets its expectation to 0, the next carve
    /// arrives as `seq N`, and the gap triggers a full resync — for every carve,
    /// forever.
    pub fn carve_seq(&self) -> u32 {
        self.carve_seq
    }

    pub fn set_round_seconds(&mut self, secs: f32) {
        self.round_seconds = secs.max(0.0);
    }

    pub fn round_seconds(&self) -> f32 {
        self.round_seconds
    }

    pub fn set_phase(&mut self, phase: RoundPhase) {
        if self.phase == phase {
            return;
        }
        self.phase = phase;
        self.phase_started_at = self.round_time;
        let tick = self.tick;
        self.events.push(GameEvent::RoundState {
            tick,
            phase,
            time_left: self.phase_time_left(),
        });
        if phase == RoundPhase::Ended {
            self.events.push(GameEvent::RoundEnd { tick });
        }
    }

    pub fn phase_time_left(&self) -> f32 {
        let d = match self.phase {
            RoundPhase::Lobby => return f32::INFINITY,
            RoundPhase::Warmup => WARMUP_SECONDS,
            RoundPhase::Playing => self.round_seconds,
            RoundPhase::Ended => ENDED_SECONDS,
        };
        (self.phase_started_at + d - self.round_time).max(0.0)
    }

    /// When `Playing` ends, in round-time seconds. The effect scheduler needs it so
    /// it never starts something that would still be running at the end.
    fn round_ends_at(&self) -> f32 {
        match self.phase {
            RoundPhase::Playing => self.phase_started_at + self.round_seconds,
            _ => f32::INFINITY,
        }
    }

    // ------------------------------------------------------------------- step

    /// Advance the clock without simulating anything.
    ///
    /// A `Lobby` room does not step (`docs/72` §C18) — no bots, no timers, no
    /// scoring, no items, no weather. It must still advance `tick`, because
    /// `tick` is a **clock**, not a count of simulation steps, and two things
    /// break when it stands still:
    ///
    /// - every command recorded during a lobby lands on tick 0 and is re-applied
    ///   in one burst on replay;
    /// - `tick_once` calls stop matching `tick`, so a replay bounded by
    ///   `while tick < until` over-simulates by exactly the lobby's length. That
    ///   is how `empty_ticks_are_simulated_not_skipped` fails, and with no
    ///   recorded round at all it never terminates.
    ///
    /// The lag warning already had to be re-based around a frozen lobby clock
    /// (T13.06.1); that was the first symptom of the same thing.
    pub fn tick_idle(&mut self) {
        self.tick += 1;
    }

    /// Advance one tick. **The ordering contract** — `docs/41-server-loop-rooms.md`
    /// §2, its ten numbered sub-steps, in order.
    pub fn step(&mut self, dt: f32) {
        self.tick += 1;
        let warmup = self.phase == RoundPhase::Warmup;
        let playing = self.phase == RoundPhase::Playing;

        // 1. round time and the day/night cycle.
        self.round_time += dt;
        let now = self.round_time;
        let day = cycle_at(now).phase;
        if day != self.last_day_phase {
            self.last_day_phase = day;
            let tick = self.tick;
            self.events.push(GameEvent::PhaseChange {
                tick,
                day_phase: day,
            });
        }

        // 2. player inputs, in ascending PlayerId, always.
        self.apply_inputs(dt);

        // 3. players are integrated inside apply_input (force then move, once).

        // 3b. teleport pads (§C5). **After the integration**, because the rule is
        // about where the body ended up this tick and whether it is grounded, and
        // **before** the projectiles, so a player who has just left is not still
        // standing where a rocket is about to land.
        if playing {
            self.step_teleports(now, dt);
        }

        // 4. projectiles, their collisions and explosions.
        self.step_projectiles(now, dt);

        // 5. weather scheduler and active hazards.
        if playing {
            self.step_weather(now, dt);
        }

        // 5b. placed mines and ground fire (§B6). Ordered with the hazards
        // because that is what they are: a mine is a hazard someone chose the
        // position of, and burning ground is the lava afterburn under another
        // name. A handler with no caller is the §A39 shape, so this line and
        // the `fire` arms that create them belong in the same commit.
        self.step_placed(now, dt);

        // 6. world items and crates — and the graves, which fall the same way.
        let moved = self.items.step(&self.map, dt);
        self.emit_item_motion(&moved.landed);
        // Anything that fell out of the world is gone; say so, or every client
        // keeps drawing a crate falling forever (§C15).
        for id in &moved.voided {
            let tick = self.tick;
            self.events.push(GameEvent::ItemDespawn {
                tick,
                world_item_id: *id,
            });
        }
        self.tombstones.step(&self.map, dt);
        if playing {
            self.step_item_spawns(now);
        }

        // 6b. birds (§C16). With the items, because that is what they are: a
        // moving supply drop. **After** the item step so a drop made this tick
        // is not integrated twice, and before the pickups so one that lands on
        // a player's head can be taken on the same tick it arrives.
        self.step_birds(now, dt, playing);

        // 7. pickups, ascending PlayerId.
        self.resolve_pickups(now);

        // 8. damage over time, overheal decay, shield expiry.
        for p in self.players.iter_mut() {
            p.tick_stats(now, dt);
        }

        // 8a. toxic poison (§E13). Through the damage log, not through
        // `tick_stats`, because that is where the warmup gate is
        // (`docs/41` §3) — a subtraction from `health` inside the player would
        // be the one damage source in the game that skipped it. It also buys the
        // `Damage` event and the attacker bookkeeping for free.
        {
            let log: DamageLog = Default::default();
            {
                let mut entries = log.borrow_mut();
                for p in self.players.iter() {
                    if p.alive && p.poisoned(now) {
                        entries.push((
                            p.id,
                            crate::constants::TOXIC_POISON_DPS * dt,
                            DamageSource::Weather(EffectKind::ToxicRain),
                        ));
                    }
                }
            }
            let bird_log: BirdLog = Default::default();
            self.apply_damage_log(&log, &bird_log, now);
        }

        // 8b. the void (§C15). **Before the deaths**, because it works by putting
        // a body's health at zero and letting `resolve_deaths` do everything a
        // death does — the drop, the score, the event, the respawn timer.
        self.step_void();

        // 9. deaths and respawns.
        self.resolve_deaths(now);

        // 10. despawn expired items and projectiles.
        let despawned = self.items.cull(now);
        for id in despawned {
            let tick = self.tick;
            self.events.push(GameEvent::ItemDespawn {
                tick,
                world_item_id: id,
            });
        }

        // Phase advance last, so a tick is never half in two phases.
        if warmup && self.phase_time_left() <= 0.0 {
            self.set_phase(RoundPhase::Playing);
        } else if playing && self.phase_time_left() <= 0.0 {
            self.set_phase(RoundPhase::Ended);
        }
    }

    /// Fly the birds, and announce the ones that arrived or left.
    ///
    /// Movement is broadcast at `SNAPSHOT_HZ`, not every tick, for the reason
    /// `ProjectileMove` and `ItemMove` are: 60 Hz of positions for four birds is
    /// bandwidth spent on something nobody can see move that finely.
    fn step_birds(&mut self, now: f32, dt: f32, playing: bool) {
        let map_w = self.map.mask.w as f32;
        let step = self.birds.tick(map_w, playing, now, dt);
        let tick = self.tick;

        for id in &step.spawned {
            let Some(b) = self.birds.get(*id) else {
                continue;
            };
            self.events.push(GameEvent::BirdSpawn {
                tick,
                id: *id,
                kind: b.kind.to_u8(),
                x: b.pos.x,
                y: b.pos.y,
                right: b.facing_right(),
            });
        }
        // Flew off the far edge. `killed: false` — nothing drops, and the client
        // must not puff feathers for a bird that simply left.
        for id in &step.gone {
            self.events.push(GameEvent::BirdDespawn {
                tick,
                id: *id,
                killed: false,
            });
        }

        let every = (crate::constants::SIM_HZ / crate::constants::SNAPSHOT_HZ).max(1);
        if tick.is_multiple_of(every) {
            let moves: Vec<GameEvent> = self
                .birds
                .iter()
                .map(|b| GameEvent::BirdMove {
                    tick,
                    id: b.id,
                    x: b.pos.x,
                    y: b.pos.y,
                })
                .collect();
            self.events.extend(moves);
        }
    }

    fn apply_inputs(&mut self, dt: f32) {
        // Ascending id, and **exactly one input per player per tick**.
        //
        // Applying every queued input in one tick, each with a full `dt`, makes
        // packet rate a speed multiplier: measured over 60 ticks, 1 input/tick
        // moved 140.79 px and 2 input/tick moved 290.80 px — 2.06x, from the
        // client simply choosing to send more often. Server-authoritative
        // movement means the server decides how much time an input is worth, and
        // one input is worth one tick (`docs/70-amendments-v2.md` §A30).
        //
        // The surplus stays in `pending` as a bounded backlog and is consumed on
        // later ticks, which is also what makes a jitter burst catch up smoothly
        // instead of teleporting.
        self.pending.sort_by_key(|(id, inp)| (*id, inp.seq));

        // Take the first (lowest-seq) input for each distinct player, leaving the
        // rest queued. `pending` is sorted by (id, seq), so the first entry for an
        // id is the oldest unconsumed input for that player.
        let mut this_tick: Vec<(PlayerId, Input)> = Vec::new();
        let mut backlog: Vec<(PlayerId, Input)> = Vec::new();
        let mut taken: Vec<PlayerId> = Vec::new();
        for (id, input) in std::mem::take(&mut self.pending) {
            if taken.contains(&id) {
                backlog.push((id, input));
            } else {
                taken.push(id);
                this_tick.push((id, input));
            }
        }
        // A backlog longer than the queue cap means the client is sending faster
        // than the sim runs, indefinitely. Dropping the *oldest* keeps the player
        // responsive to their most recent intent rather than replaying stale
        // stick positions.
        for id in &taken {
            let count = backlog.iter().filter(|(i, _)| i == id).count();
            if count > MAX_INPUT_QUEUE {
                let mut excess = count - MAX_INPUT_QUEUE;
                backlog.retain(|(i, _)| {
                    if i == id && excess > 0 {
                        excess -= 1;
                        false
                    } else {
                        true
                    }
                });
            }
        }
        self.pending = backlog;

        for (id, input) in this_tick {
            let Some(idx) = self.players.iter().position(|p| p.id == id) else {
                continue;
            };
            if !self.players[idx].alive {
                continue;
            }
            let prev = self
                .prev_input
                .iter()
                .find(|(i, _)| *i == id)
                .map(|(_, v)| *v)
                .unwrap_or_default();
            let speed = self.players[idx].speed_multiplier();
            let p = &mut self.players[idx];
            apply_input(
                &self.map,
                &mut p.body,
                &mut p.jump,
                &mut p.jetpack,
                &input,
                &prev,
                speed,
                dt,
            );
            p.aim = input.aim;
            if let Some(slot) = self.prev_input.iter_mut().find(|(i, _)| *i == id) {
                slot.1 = input;
            }
        }
    }

    /// Tell everyone a projectile now exists.
    ///
    /// One function, because four things create projectiles — a fired weapon,
    /// the meteor shower's cadence, a meteor **impact's** fragments, and toxic
    /// rain's drops — and a client that is not told about one can never draw it.
    /// The fragments were exactly that: `MeteorShower::on_impact` spawned six per
    /// impact straight into the pool and only the shower's *cadence* spawns were
    /// announced, so `METEOR_FRAGMENTS` has been invisible since M5 (§A39).
    fn announce_projectiles(&mut self, ids: &[ProjectileId]) {
        let tick = self.tick;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let Some(p) = self.projectiles.get(*id) else {
                continue;
            };
            out.push(GameEvent::ProjectileSpawn {
                tick,
                id: *id,
                weapon: p.weapon,
                owner: p.owner,
                x: p.pos.x,
                y: p.pos.y,
                vx: p.vel.x,
                vy: p.vel.y,
            });
        }
        self.events.extend(out);
    }

    fn step_projectiles(&mut self, now: f32, dt: f32) {
        let boxes: Vec<(HitId, Aabb)> = self
            .players
            .iter()
            .filter(|p| p.alive)
            .map(|p| (HitId::Player(p.id), p.body.aabb()))
            .collect();
        // §C16, kept alive across §F1: a bird stops a bullet. It is a separate
        // slice because only bullets test it — see `Projectiles::step`.
        let birds: Vec<(HitId, Aabb)> = self
            .birds
            .iter()
            .map(|b| {
                let (w, h) = b.size();
                (HitId::Bird(b.id), Aabb::from_center_size(b.pos, w, h))
            })
            .collect();
        // `weapon` and `owner` arrive with the outcome: `step` has already removed
        // the projectile, so there is nothing left to look up (see `Impact`).
        let impacts = self
            .projectiles
            .step(&self.map, &boxes, &birds, self.wind, now, dt);

        // Where everything still in flight has got to. At `SNAPSHOT_HZ`, for the
        // same reason `emit_item_motion` uses it: a rocket flies for a second or
        // two and 60 Hz of positions is bandwidth spent on nothing. There is no
        // "on landing, always" case here — a projectile that lands is destroyed,
        // and `ProjectileDespawn` plus the blast is what the client needs then.
        let every = (crate::constants::SIM_HZ / crate::constants::SNAPSHOT_HZ).max(1);
        if self.tick.is_multiple_of(every) {
            let tick = self.tick;
            let moves: Vec<GameEvent> = self
                .projectiles
                .iter()
                .map(|p| GameEvent::ProjectileMove {
                    tick,
                    id: p.id,
                    x: p.pos.x,
                    y: p.pos.y,
                })
                .collect();
            self.events.extend(moves);
        }

        for im in impacts {
            let tick = self.tick;
            let (at, victim) = match im.outcome {
                ProjectileOutcome::Alive => continue,
                // Out of the world: **tell the client and stop**. No detonate,
                // so nothing is carved and nobody is hurt from below the map;
                // the despawn event still goes out, or every client keeps
                // drawing a rocket that the server has already forgotten (§C7 —
                // the same shape as a crate drawn in mid-air).
                ProjectileOutcome::Voided { .. } => {
                    self.events.push(GameEvent::ProjectileDespawn {
                        tick,
                        id: im.id,
                        reason: DespawnReason::Void,
                    });
                    continue;
                }
                // The victim travels with the outcome. §E13 needs it: a drop of
                // rain poisons **the player it hit**, and reading "who was
                // nearest" instead would be a blast by another name.
                ProjectileOutcome::Exploded { at } => (at, None),
                ProjectileOutcome::Hit { at, victim } => (at, Some(victim)),
                // §F1: a bullet that ran out of range. Told to the client and
                // dropped — no detonate, so it carves nothing and hurts nobody.
                ProjectileOutcome::Spent { .. } => {
                    self.events.push(GameEvent::ProjectileDespawn {
                        tick,
                        id: im.id,
                        reason: DespawnReason::Spent,
                    });
                    continue;
                }
            };
            self.events.push(GameEvent::ProjectileDespawn {
                tick,
                id: im.id,
                reason: DespawnReason::Exploded,
            });
            self.detonate(im.id, im.weapon, im.owner, at, victim, now);
        }
    }

    /// Test seam: set off a blast at a point, as a projectile of `weapon` would.
    ///
    /// A test that reaches past `detonate` is testing a different code path than
    /// the game runs — which is how `destroy_in_blast` sat with no production
    /// caller while its unit test passed.
    #[doc(hidden)]
    pub fn explode_for_test(&mut self, at: Vec2, weapon: WeaponId, owner: PlayerId, now: f32) {
        self.detonate(u32::MAX, weapon, owner, at, None, now);
    }

    /// Test seam: resolve a projectile that stopped **on a player**.
    ///
    /// The same `detonate` the impact loop calls, with the `victim` the shared
    /// projectile step would have reported. §E13's poison is the first outcome
    /// that depends on *who* was hit rather than on a radius, so a seam that
    /// could only say "something went off here" cannot reach it.
    #[doc(hidden)]
    pub fn hit_player_for_test(&mut self, at: Vec2, weapon: WeaponId, victim: PlayerId, now: f32) {
        self.detonate(
            u32::MAX,
            weapon,
            u8::MAX,
            at,
            Some(HitId::Player(victim)),
            now,
        );
    }

    /// The same `detonate`, for a projectile that stopped on **terrain**.
    ///
    /// The seam above can only say "it landed on this player", and §F6 moves the
    /// interesting case to the other branch: nearly every drop lands on the
    /// ground, and what it does to the people standing near it is the whole
    /// feature. A radius cannot be tested through a seam that always names a
    /// victim, and the alternative — reaching into `detonate` — is the fifth
    /// call site D-62 is about.
    #[doc(hidden)]
    pub fn land_on_terrain_for_test(&mut self, at: Vec2, weapon: WeaponId, now: f32) {
        self.detonate(u32::MAX, weapon, u8::MAX, at, None, now);
    }

    /// §F6 — poison everyone standing within `TOXIC_SPLASH_R` of where a drop
    /// landed.
    ///
    /// **The roof is asked per victim, not per drop.** §E13's call site passed
    /// the landing point to a parameter named `victim`, and the two coincided
    /// only because the drop had stopped on that player. With a radius they stop
    /// coinciding the first time two people stand a few pixels apart with a slab
    /// over one of them, and "a roof protects you" would then be decided by where
    /// the rain fell rather than by where you are standing — which is the rule
    /// backwards. `poison_lands` is the shared test (`effects/mod.rs`), the same
    /// one the meteor asks; this does not grow a second copy of it.
    ///
    /// No damage, no carve and no impulse here: the poison is a **status**, and
    /// what it costs is applied by `step`'s stage 8a through
    /// `apply_damage_log`, which is where the warmup gate lives. A subtraction
    /// from `health` in this function would be the one damage source in the game
    /// that skipped it (§E13's own note, and the reason `tick_stats` refuses it).
    fn splash_poison(&mut self, at: Vec2, now: f32) {
        let r2 = crate::constants::TOXIC_SPLASH_R * crate::constants::TOXIC_SPLASH_R;
        // Collected first, because `poison_lands` borrows the map while the
        // poison needs the players mutably.
        let caught: Vec<PlayerId> = self
            .players
            .iter()
            .filter(|p| p.alive && (p.body.pos - at).len_sq() <= r2)
            .filter(|p| crate::effects::toxic::poison_lands(&self.map, p.body.pos))
            .map(|p| p.id)
            .collect();
        for id in caught {
            if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
                p.poison(now);
            }
        }
    }

    /// Resolve one projectile going off, whatever it was.
    fn detonate(
        &mut self,
        id: ProjectileId,
        weapon: WeaponId,
        owner: PlayerId,
        at: Vec2,
        victim: Option<HitId>,
        now: f32,
    ) {
        // `Projectiles::step` has already removed the projectile by the time it
        // reports an outcome, so the weapon and owner are captured alongside the
        // outcome rather than looked up here. Reading them afterwards is exactly
        // how a fragment gets mistaken for a meteor and spawns six more.

        // §E13: a drop of rain lands, it does not go off. Intercepted here —
        // before `defs::def` and before any blast — because a drop takes a
        // bullet-sized bite out of the ground and a meteor's crater is exactly
        // what `docs/13` §3 says toxic rain must never leave.
        if crate::effects::toxic::owns(weapon) {
            // **A drop splashes** (§F6). §E13 poisoned only the body the
            // projectile point intersected — the comment that used to sit here
            // said "whoever it landed on, not everyone nearby" — and §F6 repeals
            // exactly that, because the arithmetic of a point hitting a 20 px
            // target twenty times a shower is a hazard nobody ever felt.
            //
            // Still **not** a blast, and not `explode`: that carves, deals its
            // damage instantly and throws people, which is the one thing
            // `docs/13` §3 says rain must never do. What is shared with the
            // meteor is `poison_lands`, the roof test — not the blast helper.
            self.splash_poison(at, now);
            if victim.is_some() {
                // No carve: the drop stopped on a player, and the ground it
                // never reached keeps its pixels. The splash above has already
                // run, so a drop that lands *on* someone still reaches whoever
                // is standing beside them.
                return;
            }
            let r = crate::constants::TOXIC_DROP_CARVE_R.round() as i32;
            let (x, y) = (at.x.round() as i32, at.y.round() as i32);
            let carve = self.map.carve_circle(x, y, r);
            if carve.pixels_removed > 0 {
                self.carve_seq += 1;
                let tick = self.tick;
                let seq = self.carve_seq;
                // `Weapon`, not a fourth kind: the client keys the carve's
                // *sound and dust* off this, and a bullet-sized bite is what a
                // bullet-sized bite already sounds like. §E13 asks for a small
                // hole, not a new class of hole.
                self.events.push(GameEvent::Carve {
                    tick,
                    seq,
                    x,
                    y,
                    r,
                    kind: CarveKind::Weapon,
                });
            }
            return;
        }

        if MeteorShower::owns(weapon) {
            let is_frag = MeteorShower::is_fragment(weapon);
            let log: DamageLog = Default::default();
            let bird_log: BirdLog = Default::default();
            let (mut closures, meta, mut bird_vels) =
                hit_targets(&self.players, &self.birds, &log, &bird_log, now);
            let (result, fragments) = {
                let mut t = targets(&mut self.players, &mut closures, &meta, &mut bird_vels);
                MeteorShower::on_impact(
                    &mut self.projectiles,
                    &mut self.map,
                    &mut t,
                    at,
                    is_frag,
                    self.seed ^ id as u64,
                    now,
                )
            };
            self.announce_projectiles(&fragments);
            let r = if is_frag {
                crate::constants::METEOR_FRAG_CARVE_R
            } else {
                crate::constants::METEOR_CARVE_R
            };
            self.note_knocked(&result.knocked, now);
            self.emit_blast(at, r, CarveKind::Meteor, &result.carve, now);
            self.apply_damage_log(&log, &bird_log, now);
            return;
        }

        let Some(w) = defs::def(weapon) else { return };
        let source = if owner == u8::MAX {
            BlastSource::Weather(EffectKind::MeteorShower)
        } else {
            BlastSource::Fired { owner, weapon }
        };

        // §F1: a bullet stops, it does not go off. Intercepted here — before the
        // burst match — because `Burst::Blast` cannot express a direct hit:
        // `explode` falls off from the blast *centre* to the victim's *centre*,
        // and a body is wider than a pistol's 3 px radius, so every gun in the
        // game would deal zero damage with every table test still green. The
        // reasoning is in `weapons/bullet.rs`.
        if crate::weapons::bullet::is_bullet(w) {
            let log: DamageLog = Default::default();
            let bird_log: BirdLog = Default::default();
            let impact = {
                let (mut closures, meta, mut bird_vels) =
                    hit_targets(&self.players, &self.birds, &log, &bird_log, now);
                let mut t = targets(&mut self.players, &mut closures, &meta, &mut bird_vels);
                crate::weapons::bullet::resolve(&mut self.map, &mut t, w, at, victim, source)
            };
            self.apply_damage_log(&log, &bird_log, now);
            if let Some(c) = impact.carve {
                if c.pixels_removed > 0 {
                    self.carve_seq += 1;
                    let tick = self.tick;
                    let seq = self.carve_seq;
                    self.events.push(GameEvent::Carve {
                        tick,
                        seq,
                        x: at.x.round() as i32,
                        y: at.y.round() as i32,
                        r: w.blast_radius.round() as i32,
                        kind: CarveKind::Weapon,
                    });
                }
                self.reveal(&c.revealed, now);
            }
            return;
        }

        // The one place that decides what going off means. Matched exhaustively:
        // a new `Burst` is a compile error here rather than a weapon that silently
        // does nothing, which is how melee shipped unable to swing.
        match w.burst {
            Burst::Blast => {
                let log: DamageLog = Default::default();
                let bird_log: BirdLog = Default::default();
                let (mut closures, meta, mut bird_vels) =
                    hit_targets(&self.players, &self.birds, &log, &bird_log, now);
                let result = {
                    let mut t = targets(&mut self.players, &mut closures, &meta, &mut bird_vels);
                    explode(&mut self.map, &mut t, at, w.blast_radius, w.damage, source)
                };
                self.note_knocked(&result.knocked, now);
                self.emit_blast(at, w.blast_radius, CarveKind::Weapon, &result.carve, now);
                self.apply_damage_log(&log, &bird_log, now);
            }
            Burst::Pellets { count, fan, pellet } => {
                self.burst_pellets(at, count, fan, pellet, owner, now)
            }
            Burst::Zone {
                kind,
                radius,
                dps,
                duration,
                patches,
                scatter,
            } => self.burst_zone(
                at, kind, radius, dps, duration, patches, scatter, source, now,
            ),
            Burst::Smoke { radius, duration } => self.burst_smoke(at, radius, duration, now),
            // §F10. A flame that has burned for `FLAME_LIFE` goes out, and going
            // out is not an event: no carve, no damage, no blast. Everything it
            // ever did happened while it was alive, in `weapons::flame`.
            //
            // Reached through the fuse — `Projectiles::step` reports `Exploded`
            // when `fuse_at` passes — which is why this arm exists at all rather
            // than the flame being intercepted earlier: the fuse is what gives a
            // flame its `FLAME_LIFE` and it is the same fuse a grenade uses.
            Burst::BurnsOut => {}
            // §F10.2. A molotov is a contact weapon that becomes a crowd.
            //
            // `at` and **up**: the fan is centred on straight up with a half-turn
            // of spread, which is what "outward and up from the impact" means as
            // an angle range. A fan centred on the throw direction would put
            // every flame on the far side of the impact and leave the ground the
            // bottle actually broke on clear.
            Burst::Flames { count, speed } => {
                let ids = crate::weapons::flame::light_fan(
                    &mut self.projectiles,
                    owner,
                    crate::weapons::flame::Fan {
                        at,
                        aim: -std::f32::consts::FRAC_PI_2,
                        spread: std::f32::consts::FRAC_PI_2,
                        speed,
                        count,
                    },
                    &mut self.rng,
                    now,
                );
                self.announce_flames(&ids, now);
            }
        }
    }

    /// Tell the clients about flames that have just been lit.
    ///
    /// The same `ProjectileSpawn` every other projectile gets — a flame is one,
    /// and this is what puts it on the wire and therefore on the screen. Without
    /// it the server would be full of fire nobody could see, which is the exact
    /// failure §F10.3 exists to end.
    fn announce_flames(&mut self, ids: &[crate::weapons::projectile::ProjectileId], _now: f32) {
        let tick = self.tick;
        for id in ids {
            let Some(p) = self.projectiles.get(*id) else {
                continue;
            };
            let (pos, vel, weapon, owner) = (p.pos, p.vel, p.weapon, p.owner);
            self.events.push(GameEvent::ProjectileSpawn {
                tick,
                id: *id,
                weapon,
                owner,
                x: pos.x,
                y: pos.y,
                vx: vel.x,
                vy: vel.y,
            });
        }
    }

    /// An airburst opens downward into a fan of energy pellets (§B7).
    ///
    /// Hitscan, not nine more projectiles: they read as laser bullets, they resolve
    /// on the tick they are fired, and nine grenades' worth of airbursts would
    /// otherwise put dozens of bodies in flight at once.
    fn burst_pellets(
        &mut self,
        at: Vec2,
        count: u32,
        fan: f32,
        pellet: WeaponId,
        owner: PlayerId,
        now: f32,
    ) {
        let Some(pw) = defs::def(pellet) else { return };
        let tick = self.tick;
        let log: DamageLog = Default::default();
        let bird_log: BirdLog = Default::default();
        let mut shots = Vec::new();
        {
            let (mut closures, meta, mut bird_vels) =
                hit_targets(&self.players, &self.birds, &log, &bird_log, now);
            let mut t = targets(&mut self.players, &mut closures, &meta, &mut bird_vels);
            for i in 0..count {
                // Spread evenly across the fan, centred on straight down. A random
                // fan would make the same throw behave differently twice and would
                // draw from the world RNG on a path a replay has to reproduce.
                let f = if count > 1 {
                    i as f32 / (count - 1) as f32 - 0.5
                } else {
                    0.0
                };
                let aim = std::f32::consts::FRAC_PI_2 + f * fan;
                shots.extend(fire_hitscan(
                    &mut self.map,
                    &mut t,
                    pw,
                    owner,
                    at,
                    aim,
                    &mut self.rng,
                    now,
                ));
            }
        }
        self.apply_damage_log(&log, &bird_log, now);

        self.events.push(GameEvent::Explosion {
            tick,
            x: at.x,
            y: at.y,
            r: 0.0,
            kind: CarveKind::Weapon,
        });
        for s in shots {
            self.events.push(GameEvent::Hitscan {
                tick,
                owner,
                x0: s.from.x,
                y0: s.from.y,
                x1: s.to.x,
                y1: s.to.y,
                hit: s.hit.is_some(),
            });
            if let Some(c) = s.carve {
                self.carve_seq += 1;
                self.events.push(GameEvent::Carve {
                    tick,
                    seq: self.carve_seq,
                    x: s.to.x.round() as i32,
                    y: s.to.y.round() as i32,
                    r: pw.blast_radius.round() as i32,
                    kind: CarveKind::Weapon,
                });
                self.reveal(&c.revealed, now);
            }
        }
    }

    /// Molotov and toxic: a damaging ground zone, and **no terrain damage at all**.
    ///
    /// It never reaches `explode`, so leaving the mask byte-identical is structural
    /// rather than a blast radius someone has to remember to keep at zero.
    #[allow(clippy::too_many_arguments)]
    fn burst_zone(
        &mut self,
        at: Vec2,
        kind: BurnZone,
        radius: f32,
        dps: f32,
        duration: f32,
        patches: u32,
        scatter: f32,
        source: BlastSource,
        now: f32,
    ) {
        // One arm each since §F10.2 — fire left and became flames. The match
        // stays rather than collapsing to a constant, because `BurnZone` and
        // `BurnKind` are two enums that mirror each other and a mapping written
        // as an assignment is a mapping nobody checks.
        let bk = match kind {
            BurnZone::Toxic => BurnKind::Toxic,
        };
        let hazard = match kind {
            BurnZone::Toxic => HazardKind::Toxic,
        };
        let tick = self.tick;
        for i in 0..patches.max(1) {
            // Deterministic ring rather than an RNG draw: the same throw makes the
            // same fire in a replay, and it spreads evenly instead of clumping.
            let pos = if patches <= 1 || scatter <= 0.0 {
                at
            } else {
                let a = i as f32 / patches as f32 * std::f32::consts::TAU;
                at + Vec2::new(a.cos(), a.sin()) * scatter
            };
            self.burn.light_zone(
                crate::weapons::burn::Zone {
                    kind: bk,
                    pos,
                    radius,
                    dps,
                    duration,
                },
                now,
                // A burn zone is a place, not a duel: nobody owns being stood in
                // fire, so the victim it is attributed to is the owner's own id
                // only to pick the `SelfInflicted` arm correctly for whoever lit
                // it. Zones never touch birds — they are ground fire.
                source.for_victim(HitId::Player(0)),
            );
            self.events.push(GameEvent::HazardSpawn {
                tick,
                id: self.hazard_seq,
                kind: hazard,
                x: pos.x,
                y: pos.y,
                r: radius,
                duration,
            });
            self.hazard_seq += 1;
        }
    }

    /// A smoke cloud: vision denial, no damage, no terrain change.
    fn burst_smoke(&mut self, at: Vec2, radius: f32, duration: f32, now: f32) {
        let id = self.hazard_seq;
        self.hazard_seq += 1;
        self.smoke.add(id, at, radius, duration, now);
        let tick = self.tick;
        self.events.push(GameEvent::HazardSpawn {
            tick,
            id,
            kind: HazardKind::Smoke,
            x: at.x,
            y: at.y,
            r: radius,
            duration,
        });
    }

    /// Stamp everyone a blast or a swing **threw** as recently knocked.
    ///
    /// §C20 read this to exempt a thrown player from its movement gate, and §F4
    /// repealed that gate — so `was_knocked` currently has no reader in the
    /// tree. `knocked_until` is still written by all four throwing paths and is
    /// still folded into the state hash, so it is left alone rather than removed
    /// as part of a task about firing: taking it out would change every golden
    /// hash for a reason that has nothing to do with knockback.
    ///
    /// One function and one caller-visible rule, because four paths throw
    /// players — a rocket, a shotgun's pellets by way of its blast, a mine and a
    /// melee swing — and a gate that four call sites each remember to apply is a
    /// gate three of them will eventually forget (CLAUDE.md: "share the guard,
    /// or share the function").
    /// Birds are silently skipped: `HitId::player()` is `None` for one, and a
    /// bird has no fire gate to open. Taking `&[HitId]` rather than filtering at
    /// the five call sites is the same rule this function already exists for.
    fn note_knocked(&mut self, ids: &[HitId], now: f32) {
        if ids.is_empty() {
            return;
        }
        let until = now + crate::constants::KNOCKBACK_FIRE_GRACE;
        for p in self.players.iter_mut() {
            if ids.contains(&HitId::Player(p.id)) {
                // Never shortened: two blasts in a row must not leave you
                // pinned by the earlier one's expiry.
                p.knocked_until = p.knocked_until.max(until);
            }
        }
    }

    fn emit_blast(&mut self, at: Vec2, r: f32, kind: CarveKind, carve: &CarveResult, now: f32) {
        let tick = self.tick;
        // §B6: a mine is destructible by explosions, which is what stops a map
        // filling up with them. `destroy_in_blast` existed from T11.01 with
        // **no production caller** — only tests — so mines were in fact
        // indestructible in a real round, and `MineEnd::Destroyed` was a variant
        // nothing ever constructed. This is the choke point every blast goes
        // through, so it is the one place that can be right.
        for gone in self.mines.destroy_in_blast(at, r) {
            self.events.push(GameEvent::MineEnded {
                tick,
                id: gone.id,
                reason: gone.reason,
            });
        }
        self.events.push(GameEvent::Explosion {
            tick,
            x: at.x,
            y: at.y,
            r,
            kind,
        });
        self.carve_seq += 1;
        self.events.push(GameEvent::Carve {
            tick,
            seq: self.carve_seq,
            x: at.x.round() as i32,
            y: at.y.round() as i32,
            r: r.round() as i32,
            kind,
        });
        self.reveal(&carve.revealed, now);
    }

    fn reveal(&mut self, revealed: &[u16], now: f32) {
        if revealed.is_empty() {
            return;
        }
        let ids = reveal_buried(
            &mut self.items,
            &self.map,
            &self.buried_items,
            revealed,
            now,
        );
        for id in ids {
            if let Some(it) = self.items.get(id) {
                let (item_id, count, x, y) = (it.item, it.count, it.pos.x, it.pos.y);
                let tick = self.tick;
                self.events.push(GameEvent::ItemSpawn {
                    tick,
                    world_item_id: id,
                    item_id,
                    count,
                    x,
                    y,
                    source: SpawnSource::Buried,
                });
            }
        }
    }

    /// Apply logged bird damage, and turn every kill into a drop.
    ///
    /// The drop is an **ordinary `WorldItem`** — the same physics, the same TTL,
    /// the same pickup path, and therefore the same §C9 refusal at `MAX_HEALS` /
    /// `MAX_BATTERIES` with the item left on the ground. A bespoke bird-reward
    /// item would be a second copy of all of that, free to drift.
    fn resolve_bird_kills(&mut self, log: &[(BirdId, f32)], now: f32) {
        if log.is_empty() {
            return;
        }
        for kill in self.birds.apply_damage(log) {
            let tick = self.tick;
            self.events.push(GameEvent::BirdDespawn {
                tick,
                id: kill.id,
                killed: true,
            });

            let item_id = match kill.kind {
                BirdKind::Normal => crate::items::registry::MEDKIT,
                BirdKind::Metal => crate::items::registry::BATTERY_PACK,
            };
            // Room first: at `MAX_WORLD_ITEMS` the spawn would be the one thing
            // that pushes the world over its cap, and `cull` only enforces
            // `len <= MAX` — it has nothing to do when you are exactly at it.
            if let Some(evicted) = self.items.make_room() {
                self.events.push(GameEvent::ItemDespawn {
                    tick,
                    world_item_id: evicted,
                });
            }
            let id = self.items.spawn(
                item_id,
                1,
                kill.at,
                Vec2::new(0.0, crate::constants::BIRD_DROP_VELOCITY),
                SpawnSource::Periodic,
                now,
            );
            self.events.push(GameEvent::ItemSpawn {
                tick,
                world_item_id: id,
                item_id,
                count: 1,
                x: kill.at.x,
                y: kill.at.y,
                source: SpawnSource::Periodic,
            });
        }
    }

    /// Drain both logs: players, and the birds §C16 lets every weapon hit.
    ///
    /// **One function, two logs, and the signature is why.** Nine call sites
    /// damage things; a bird log they each had to remember to drain is a bird log
    /// most of them would forget, and the failure would be silent — a bird that
    /// absorbs a rocket and flies on. Taking it as a parameter makes forgetting a
    /// compile error.
    fn apply_damage_log(&mut self, log: &DamageLog, bird_log: &BirdLog, now: f32) {
        let entries = std::mem::take(&mut *log.borrow_mut());
        let bird_entries = std::mem::take(&mut *bird_log.borrow_mut());
        // THE warmup damage gate (`docs/41-server-loop-rooms.md` §3). Every source
        // of damage in the game — weapons, explosions, hitscan, toxic, lava —
        // funnels through this one function, so gating here gates all of them.
        // Terrain still carves: warmup is for orienting yourself, and a crater you
        // dug while waiting is harmless.
        if self.phase == RoundPhase::Warmup {
            return;
        }

        // Birds first, and through the same warmup gate above: a supply line that
        // opened before the round did would let someone stockpile heals during
        // the ten seconds nobody can be hurt. Both logs were taken before that
        // return, so neither leaks into the next tick.
        self.resolve_bird_kills(&bird_entries, now);

        for (victim, amount, src) in entries {
            let tick = self.tick;
            let Some(p) = self.players.iter_mut().find(|p| p.id == victim) else {
                continue;
            };
            if !p.apply_damage(amount, src, now) {
                continue;
            }
            let (attacker, cause) = match src {
                DamageSource::Player { id, .. } => (Some(id), DeathCause::Player(id)),
                DamageSource::SelfInflicted { .. } => (Some(victim), DeathCause::SelfInflicted),
                DamageSource::Weather(_) => (None, DeathCause::Weather),
            };
            self.events.push(GameEvent::Damage {
                tick,
                victim,
                attacker,
                amount,
                cause,
            });
        }
    }

    /// Mines fall, arm, trigger; ground fire burns and goes out; flames burn.
    fn step_placed(&mut self, now: f32, dt: f32) {
        let tick = self.tick;
        let log: DamageLog = Default::default();
        let bird_log: BirdLog = Default::default();
        // §F10. **Before the burn**, so a flame that is over the cap this tick
        // never gets to damage anyone: a cap applied afterwards would let an
        // unbounded field deal unbounded damage for one tick each time, which is
        // the shape T19.03's banking bug had.
        // **Announced, not just removed.** `Projectiles::remove` is silent, and a
        // client only drops a projectile when it is told to — so before this,
        // every flame the cap dropped went on burning on every screen for the
        // rest of the round. Measured with `fire-visible`'s full field: 176 live
        // flames on the client against a cap of 160, and the surplus stayed.
        for id in crate::weapons::flame::enforce_cap(&mut self.projectiles) {
            self.events.push(GameEvent::ProjectileDespawn {
                tick,
                id,
                reason: DespawnReason::Culled,
            });
        }
        let (ended, scorches) = {
            let (mut closures, meta, mut bird_vels) =
                hit_targets(&self.players, &self.birds, &log, &bird_log, now);
            let mut t = targets(&mut self.players, &mut closures, &meta, &mut bird_vels);
            let ended = self.mines.step(&mut self.map, &mut t, now, dt);
            self.burn.tick(&mut t, now, dt);
            // Flames burn here rather than in `step_projectiles` because this is
            // where the target slice already exists and where the warmup gate
            // below already stands. A flame is a projectile that flies on the
            // shared step and *damages* like a hazard.
            let scorches =
                crate::weapons::flame::tick(&self.projectiles, &mut self.map, &mut t, now, dt);
            (ended, scorches)
        };
        // A scorch changes the mask, so it has to reach the clients as a carve
        // like any other — a hole that exists on the server and not on the screen
        // is §C0's shape, and this module has no access to the sequence counter.
        for sc in scorches {
            // A bite that took nothing is a flame resting in the hole it has
            // already eaten. `weapons::flame` reports every crossing of its
            // timer and this is where "there was rock left" is decided, so a
            // fire in a crater does not stream empty carves at `SNAPSHOT_HZ`.
            if sc.carve.pixels_removed == 0 {
                continue;
            }
            self.carve_seq += 1;
            self.events.push(GameEvent::Carve {
                tick,
                seq: self.carve_seq,
                x: sc.at.x.round() as i32,
                y: sc.at.y.round() as i32,
                r: crate::constants::FLAME_SCORCH_R.round() as i32,
                kind: CarveKind::Weapon,
            });
            self.reveal(&sc.carve.revealed, now);
        }
        self.apply_damage_log(&log, &bird_log, now);

        // A cloud that vanishes server-side and lingers on screen is worse than
        // one that never appeared, because you will trust it.
        for id in self.smoke.expire(now) {
            self.events.push(GameEvent::HazardEnded { tick, id });
        }

        for out in ended {
            self.events.push(GameEvent::MineEnded {
                tick,
                id: out.id,
                reason: out.reason,
            });
            let Some(r) = out.explosion else { continue };
            self.note_knocked(&r.knocked, now);
            // A detonation carves like any other blast, and its carve is as
            // authoritative as a rocket's: one event, in emission order.
            self.carve_seq += 1;
            let seq = self.carve_seq;
            self.events.push(GameEvent::Carve {
                tick,
                seq,
                x: out.at.x.round() as i32,
                y: out.at.y.round() as i32,
                r: out.blast_radius.round() as i32,
                kind: CarveKind::Weapon,
            });
            self.reveal(&r.carve.revealed, now);
        }
    }

    /// Construct the state an effect needs, and hang it on the world.
    ///
    /// Split out of `step_weather` so the test seam below can share it. The
    /// scheduler's `force()` pushes an effect straight onto its active list and
    /// emits **no** `Started` event, so a test that called it got an effect the
    /// scheduler agreed was running and a world that had never built one — the
    /// rain fell nowhere and every assertion about it was vacuous.
    fn install_effect(&mut self, id: u32, kind: EffectKind, seed: u64, now: f32) {
        match kind {
            EffectKind::ToxicRain => self.toxic = Some((id, ToxicRain::new(seed, now))),
            EffectKind::MeteorShower => self.meteor = Some((id, MeteorShower::new(seed, now))),
            // Vents are chosen during the telegraph so the client can crack the
            // ground at exactly the points that will open.
            EffectKind::LavaBurst => self.lava = Some((id, LavaBurst::new(seed, &self.map, now))),
            EffectKind::HeavyFog => self.fog = Some((id, HeavyFog::new(now))),
        }
    }

    /// Test seam: start `kind` now, through the same install the scheduler uses.
    ///
    /// The sandbox's weather controls and the effect tests both need to say
    /// "rain, now" without waiting out `EFFECT_INTERVAL_MIN`.
    #[doc(hidden)]
    pub fn force_effect(&mut self, kind: EffectKind, now: f32) -> u32 {
        let id = self.effects.force(kind, now);
        let seed = self.seed ^ (id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        self.install_effect(id, kind, seed, now);
        id
    }

    fn step_weather(&mut self, now: f32, dt: f32) {
        let ends = self.round_ends_at();
        // `Always` restarts its effect the moment nothing of that kind is on the
        // scheduler's list — not `is_active`, which is false during the 3 s
        // telegraph and would force a fresh effect every tick of it.
        //
        // Forced through `force_effect` **and** an `EffectStart` event, because
        // `EffectScheduler::force` deliberately emits none: the sandbox installs
        // its own effects locally and needs no event, but a networked client
        // learns that fog exists from `effect_start` alone. Forcing without the
        // event is the "correct simulation, nothing on the screen" shape twice
        // over.
        if let WeatherMode::Always(kind) = self.weather_mode {
            // Keep the scheduler's own roll out of the way, or `Always(fog)` is
            // "fog, plus whatever else the weather felt like" — which is exactly
            // what a check using the switch is trying not to have.
            self.effects
                .postpone_until(now + crate::constants::EFFECT_INTERVAL_MAX);
            if !self.effects.active().iter().any(|e| e.kind == kind) {
                let tick = self.tick;
                let id = self.force_effect(kind, now);
                self.events.push(GameEvent::EffectStart {
                    tick,
                    id,
                    kind,
                    seed: 0,
                    duration: crate::effects::scheduler::active_duration(kind),
                });
            }
        }
        // `Off` skips the scheduler outright rather than pausing it: nothing can
        // have started, so there is no phase to advance and no end to deliver.
        let scheduled = match self.weather_mode {
            WeatherMode::Off => Vec::new(),
            _ => self.effects.tick(now, ends),
        };
        for ev in scheduled {
            let tick = self.tick;
            match ev {
                EffectEvent::Started {
                    id,
                    kind,
                    seed,
                    duration,
                } => {
                    self.install_effect(id, kind, seed, now);
                    self.events.push(GameEvent::EffectStart {
                        tick,
                        id,
                        kind,
                        seed,
                        duration,
                    });
                }
                EffectEvent::PhaseChanged { id, phase } => {
                    self.events
                        .push(GameEvent::EffectPhaseChanged { tick, id, phase });
                }
                EffectEvent::Ended { id } => {
                    self.events.push(GameEvent::EffectEnd { tick, id });
                    if self.toxic.as_ref().is_some_and(|(i, _)| *i == id) {
                        self.toxic = None;
                    }
                    if self.meteor.as_ref().is_some_and(|(i, _)| *i == id) {
                        self.meteor = None;
                    }
                    if self.lava.as_ref().is_some_and(|(i, _)| *i == id) {
                        self.lava = None;
                    }
                    if self.fog.as_ref().is_some_and(|(i, _)| *i == id) {
                        self.fog = None;
                    }
                }
            }
        }

        let toxic_on = self.effects.is_active(EffectKind::ToxicRain);
        let meteor_on = self.effects.is_active(EffectKind::MeteorShower);
        let lava_on = self.effects.is_active(EffectKind::LavaBurst);

        if let Some((eid, mut t)) = self.toxic.take() {
            // §E13: the rain releases drops and does nothing else. A drop is
            // resolved in `detonate` like any other projectile — which is what
            // makes "the poison outlives the shower" free rather than a special
            // case, since the effect owns none of it.
            let living: Vec<f32> = self
                .players
                .iter()
                .filter(|p| p.alive)
                .map(|p| p.body.pos.x)
                .collect();
            let released = t.tick(&mut self.projectiles, &self.map, &living, toxic_on, now);
            self.toxic = Some((eid, t));
            self.announce_projectiles(&released);
        }

        if let Some((eid, mut m)) = self.meteor.take() {
            let ids = m.tick(&mut self.projectiles, &self.map, meteor_on, now);
            self.meteor = Some((eid, m));
            self.announce_projectiles(&ids);
        }

        if let Some((eid, mut l)) = self.lava.take() {
            let log: DamageLog = Default::default();
            let bird_log: BirdLog = Default::default();
            let carves = {
                let (mut closures, meta, mut bird_vels) =
                    hit_targets(&self.players, &self.birds, &log, &bird_log, now);
                let mut tg = targets(&mut self.players, &mut closures, &meta, &mut bird_vels);
                l.tick(&mut self.map, &mut tg, lava_on, now, dt)
            };
            self.apply_damage_log(&log, &bird_log, now);
            // §F10.2: the afterburn is flames. `lava` decides *where and when*
            // and this decides *what*, through the one `light_fan` the
            // flamethrower and the molotov also use — a second spawn site for
            // the vent is how three emitters become three fire systems again.
            //
            // Owner `u8::MAX`, which is what `detonate` already reads as "the
            // weather": a vent's fire kills nobody's kill.
            if lava_on {
                for at in l.smoulder(now, dt) {
                    let ids = crate::weapons::flame::light_fan(
                        &mut self.projectiles,
                        u8::MAX,
                        crate::weapons::flame::Fan {
                            at,
                            aim: -std::f32::consts::FRAC_PI_2,
                            spread: crate::constants::FLAME_SPREAD * 3.0,
                            speed: crate::constants::FLAME_MUZZLE_SPEED * 0.5,
                            count: 1,
                        },
                        &mut self.rng,
                        now,
                    );
                    self.announce_flames(&ids, now);
                }
            }
            // Channels open once, on the first active tick, one per vent in vent
            // order — so the carves zip onto the vents that produced them.
            let vents: Vec<Vec2> = l.vents().iter().map(|v| v.pos).collect();
            for (c, vpos) in carves.iter().zip(vents.iter()) {
                self.carve_seq += 1;
                let tick = self.tick;
                let seq = self.carve_seq;
                let r = crate::constants::LAVA_CHANNEL_R as i32;
                self.events.push(GameEvent::CarveCapsule {
                    tick,
                    seq,
                    x0: vpos.x.round() as i32,
                    y0: vpos.y.round() as i32,
                    x1: vpos.x.round() as i32,
                    y1: vpos.y.round() as i32 + 3 * r,
                    r,
                });
                let revealed = c.revealed.clone();
                self.reveal(&revealed, now);
            }
            self.lava = Some((eid, l));
        }
    }

    fn step_item_spawns(&mut self, now: f32) {
        let positions: Vec<Vec2> = self
            .players
            .iter()
            .filter(|p| p.alive)
            .map(|p| p.body.pos)
            .collect();
        let ids = self
            .spawn_schedule
            .tick_items(&mut self.items, &self.map, &positions, now);
        for id in ids {
            if let Some(it) = self.items.get(id) {
                let (item_id, count, x, y) = (it.item, it.count, it.pos.x, it.pos.y);
                let tick = self.tick;
                self.events.push(GameEvent::ItemSpawn {
                    tick,
                    world_item_id: id,
                    item_id,
                    count,
                    x,
                    y,
                    source: SpawnSource::Periodic,
                });
            }
        }
        if let Some(id) = self
            .spawn_schedule
            .tick_crates(&mut self.items, &self.map, now)
        {
            if let Some(it) = self.items.get(id) {
                let (x, y) = (it.pos.x, it.pos.y);
                let tick = self.tick;
                self.events.push(GameEvent::CrateSpawn {
                    tick,
                    world_item_id: id,
                    x,
                    y,
                });
            }
        }
    }

    /// Tell observers where the falling items are.
    ///
    /// Two rules, and the second is the one that matters:
    ///
    ///   * while airborne, at `SNAPSHOT_HZ` rather than every tick — a crate
    ///     falls for seconds and 60 Hz of positions for a thing nobody is
    ///     aiming at is bandwidth spent on nothing;
    ///   * **on landing, always**, off the cadence. The resting position is the
    ///     only one that lasts, and a periodic broadcast lands on it only by
    ///     luck. Skip it and the crate is drawn a few pixels above the ground
    ///     forever, which is the same bug in a smaller font.
    fn emit_item_motion(&mut self, landed: &[WorldItemId]) {
        let tick = self.tick;
        let every = (crate::constants::SIM_HZ / crate::constants::SNAPSHOT_HZ).max(1);
        let due = tick.is_multiple_of(every);
        let mut out: Vec<GameEvent> = Vec::new();
        for it in self.items.iter() {
            // A landed item is no longer airborne, so these two never overlap.
            if !(landed.contains(&it.id) || (due && !it.grounded)) {
                continue;
            }
            out.push(GameEvent::ItemMove {
                tick,
                world_item_id: it.id,
                x: it.pos.x,
                y: it.pos.y,
                grounded: it.grounded,
            });
        }
        self.events.extend(out);
    }

    fn resolve_pickups(&mut self, now: f32) {
        // Ascending id: `players` is kept sorted, so this is already the order.
        let mut view: Vec<crate::items::world::PickupTarget<'_>> = self
            .players
            .iter_mut()
            .filter(|p| p.alive)
            .map(|p| crate::items::world::PickupTarget {
                id: p.id,
                pos: p.body.pos,
                inventory: &mut p.inventory,
                heals: &mut p.heals,
                batteries: &mut p.batteries,
            })
            .collect();
        let taken = self.items.resolve_pickups(&mut view, now);
        for (world_item_id, player_id) in taken {
            let tick = self.tick;
            self.events.push(GameEvent::ItemPickup {
                tick,
                world_item_id,
                player_id,
            });
            self.events.push(GameEvent::Inventory { tick, player_id });
        }
    }

    /// §C15: below the map is nothing, and a body that reaches it dies.
    ///
    /// **The top edge, not the centre or the feet.** The rule has to be one a
    /// player cannot be halfway through: a body whose feet have passed `y = h` is
    /// still on screen with its head above the line, and killing it there would
    /// look like dying in mid-air. Once the *top* edge is past, the whole body is
    /// out of the world and there is nothing left to draw.
    ///
    /// ## Why this is not damage
    ///
    /// Everything that hurts a player funnels through `apply_damage_log`, and
    /// this deliberately does not. Three things in that path would each let a
    /// body survive outside the world, and all three would be right to:
    ///
    /// - the **warmup gate** returns before applying anything, and you can carve
    ///   during warmup — so a hole dug in the first ten seconds would drop you
    ///   into an eternal fall;
    /// - **spawn invulnerability** makes `apply_damage` return false outright;
    /// - a **shield** multiplies the damage down, and no finite amount is
    ///   guaranteed to finish someone at `HEALTH_CAP` through one.
    ///
    /// The void is a boundary, not a weapon (the task file says so in as many
    /// words: "the void is not fall damage, it is a boundary"), so it sets the
    /// health directly and lets `resolve_deaths` attribute it.
    fn step_void(&mut self) {
        let floor = self.map.mask.h as f32;
        for p in self.players.iter_mut() {
            if p.alive && p.body.head_y() > floor {
                p.health = 0.0;
            }
        }
    }

    /// Whether this body is below the world (§C15).
    ///
    /// The same test `step_void` kills on, so `resolve_deaths` can name the cause
    /// **without a flag to keep in sync** — the position it is reading is the one
    /// that killed them, one pass earlier in the same tick, and nothing moves a
    /// dead body until it respawns. Derive, do not add a fourth flag.
    fn is_in_the_void(&self, p: &PlayerState) -> bool {
        p.body.head_y() > self.map.mask.h as f32
    }

    fn resolve_deaths(&mut self, now: f32) {
        let mut drops: Vec<(Vec2, Vec<crate::items::inventory::Stack>)> = Vec::new();
        let mut credits: Vec<PlayerId> = Vec::new();
        let mut scored = false;

        for i in 0..self.players.len() {
            if self.players[i].alive && self.players[i].health <= 0.0 {
                // The void wins over any recent attacker as the *direct* cause;
                // `killer` still hands the credit to whoever put you there.
                let direct = if self.is_in_the_void(&self.players[i]) {
                    DeathCause::Void
                } else {
                    match self.players[i].last_damaged_by {
                        Some((who, when)) if now - when <= crate::player::state::ASSIST_WINDOW => {
                            // `who` may be the victim: self-damage is recorded too,
                            // and a self-kill is not a player kill (`docs/21` §6 —
                            // −1 to them, +0 to everyone).
                            if who == self.players[i].id {
                                DeathCause::SelfInflicted
                            } else {
                                DeathCause::Player(who)
                            }
                        }
                        _ => DeathCause::Weather,
                    }
                };
                let cause = self.players[i].killer(direct, now);
                let pos = self.players[i].body.pos;
                let victim = self.players[i].id;
                let stacks = self.players[i].die(cause, now);
                let attacker = match cause {
                    DeathCause::Player(a) if a != victim => {
                        credits.push(a);
                        Some(a)
                    }
                    DeathCause::Player(a) => Some(a),
                    DeathCause::SelfInflicted => Some(victim),
                    DeathCause::Weather | DeathCause::Void => None,
                };
                drops.push((pos, stacks));
                let tick = self.tick;
                // **Tell the owner their inventory is gone.**
                //
                // `die` empties it — every stack is on the ground a line below —
                // and nothing said so. `GameEvent::Inventory` exists for exactly
                // this and is pushed by `add`, `select` and `consume`; death is
                // the largest change of all and was the one that did not push it,
                // so the client kept rendering the pre-death loadout until the
                // next pickup happened to correct it.
                //
                // Measured: a player killed by a molotov was still listed as
                // holding four rockets, sixty smg rounds and two molotovs five
                // seconds later, and the e2e harness — which looks up a weapon's
                // slot index in that view before pressing its hotkey — was
                // selecting by a map of an inventory that no longer existed.
                self.events.push(GameEvent::Inventory {
                    tick,
                    player_id: victim,
                });
                self.events.push(GameEvent::Death {
                    tick,
                    victim,
                    attacker,
                    cause,
                });
                // A grave where they fell (§B8). Cosmetic, and it falls if the
                // ground under it goes.
                let skin = self.players[i].tombstone_skin_id;
                let (stone, evicted) = self.tombstones.place(victim, pos, skin, now);
                if let Some(gone) = evicted {
                    self.events
                        .push(GameEvent::TombstoneDespawn { tick, id: gone });
                }
                self.events.push(GameEvent::TombstoneSpawn {
                    tick,
                    id: stone.id,
                    owner: victim,
                    x: stone.pos.x,
                    y: stone.pos.y,
                    skin_id: stone.skin_id,
                });
                scored = true;
            }
        }

        for a in credits {
            if let Some(p) = self.players.iter_mut().find(|p| p.id == a) {
                p.credit_kill();
            }
        }

        for (pos, stacks) in drops {
            for s in stacks {
                // Scattered, so the pile is readable rather than one heap.
                let a = range_f32(&mut self.rng, -std::f32::consts::PI, 0.0);
                let sp = range_f32(&mut self.rng, 60.0, 140.0);
                let id = self.items.spawn(
                    s.item,
                    s.count,
                    pos,
                    Vec2::new(a.cos() * sp, a.sin() * sp),
                    SpawnSource::Death,
                    now,
                );
                let tick = self.tick;
                self.events.push(GameEvent::ItemSpawn {
                    tick,
                    world_item_id: id,
                    item_id: s.item,
                    count: s.count,
                    x: pos.x,
                    y: pos.y,
                    source: SpawnSource::Death,
                });
            }
        }

        if scored {
            let tick = self.tick;
            self.events.push(GameEvent::Score { tick });
        }

        // Respawns.
        let living: Vec<Vec2> = self
            .players
            .iter()
            .filter(|p| p.alive)
            .map(|p| p.body.pos)
            .collect();
        for i in 0..self.players.len() {
            if self.players[i].alive || now < self.players[i].respawn_at {
                continue;
            }
            // §C5: the pad furthest from the nearest living player. `pad` is
            // `None` only if every pad failed re-validation, which indestructible
            // pads make unreachable — `a_pad_respawn_never_falls_back_on_a_map_
            // carved_to_pieces` is the assertion that it stays that way.
            let choice = choose_respawn_pad(&self.map, &living, &mut self.rng);
            if choice.pad.is_none() {
                self.respawn_fallbacks += 1;
            }
            let pos = choice.pos;
            self.players[i].respawn(pos, now);
            let (id, tick) = (self.players[i].id, self.tick);
            self.events.push(GameEvent::Respawn {
                tick,
                id,
                x: pos.x,
                y: pos.y,
            });
        }
    }

    /// §C5's pads, one player at a time in ascending id.
    ///
    /// Ascending id like every other per-player loop in `step`, so two players
    /// completing a charge on the same tick resolve in a fixed order and the
    /// round replays identically.
    fn step_teleports(&mut self, now: f32, dt: f32) {
        // **Copied onto the stack, not taken out of the map.** `teleport::step`
        // needs `&[TeleportPad]` while the loop holds `&mut self.players`, and a
        // `clone()` here would be a heap allocation on every tick of every room
        // for six `Copy` structs that never change during a round.
        //
        // The obvious alternative — `mem::take` and put back — leaves the map
        // with **no pads at all** for the duration of `fire_pads`, and
        // `carve_circle` reads its pad list to decide what it must not dig. Today
        // nothing in `fire_pads` carves; the day something does, a rocket fired
        // from a pad would dig the pad away and the §C5 guarantee that keeps a
        // dug-through map survivable would fail silently. A stack copy costs the
        // same and cannot open that window (CLAUDE.md: share the guard, or share
        // the function — this one shares the map).
        let mut buf = [TeleportPad {
            id: 0,
            pos: Point { x: 0, y: 0 },
        }; TELEPORT_PADS];
        let n = self.map.meta.teleport_pads.len().min(TELEPORT_PADS);
        buf[..n].copy_from_slice(&self.map.meta.teleport_pads[..n]);
        if n >= 2 {
            self.fire_pads(&buf[..n], now, dt);
        }
    }

    /// The body of `step_teleports`, with the pads copied onto the caller's stack.
    fn fire_pads(&mut self, pads: &[TeleportPad], now: f32, dt: f32) {
        for i in 0..self.players.len() {
            if !self.players[i].alive {
                continue;
            }
            let (pos, grounded) = (self.players[i].body.pos, self.players[i].body.grounded);
            let fired = teleport::step(&mut self.players[i].teleport, pads, pos, grounded, now, dt);
            let teleport::TeleportStep::Fire(from) = fired else {
                continue;
            };
            let Some(to) = teleport::destination(pads, from, &mut self.rng) else {
                continue;
            };

            let dest = pads
                .iter()
                .find(|p| p.id == to)
                .map(|p| surface_to_centre(Vec2::new(p.pos.x as f32, p.pos.y as f32)));
            let Some(dest) = dest else { continue };

            // A fresh `Body`, not a position write: carrying the old velocity
            // through means a player who teleports while running arrives running
            // and slides off the destination pad, which looks like the teleport
            // put them in the wrong place.
            self.players[i].body = crate::physics::body::Body::new(dest);
            self.players[i].jump = crate::player::movement::JumpState::default();
            // **Fuel survives the trip.** The rest of the jetpack state is reset
            // for the same reason the body is — arriving mid-thrust, or still
            // locked out from a tank you emptied somewhere else, is arriving in a
            // state you did not choose. Fuel is not that: `JetpackState::default()`
            // sets it to `JETPACK_MAX_FUEL`, so a plain reset handed out a free
            // full tank on every teleport and turned every pad into a refuelling
            // station. §C5 says nothing about fuel, and the pads are already the
            // one ground nobody can dig away.
            let fuel = self.players[i].jetpack.fuel;
            self.players[i].jetpack = crate::player::jetpack::JetpackState {
                fuel,
                ..Default::default()
            };
            teleport::arrive(&mut self.players[i].teleport, dest, now);

            let (id, tick) = (self.players[i].id, self.tick);
            self.events.push(GameEvent::Teleport {
                tick,
                id,
                from_pad: from,
                to_pad: to,
                x: dest.x,
                y: dest.y,
            });
        }
    }

    // ------------------------------------------------------------ player acts

    /// Fire the selected weapon. Validation lives in `PlayerState::try_fire`.
    pub fn fire(&mut self, id: PlayerId, now: f32) -> Result<(), UseError> {
        let Some(idx) = self.players.iter().position(|p| p.id == id) else {
            return Err(UseError::Dead);
        };
        let slot = self.players[idx].inventory.selected();
        self.fire_from_slot(id, idx, slot, now)
    }

    /// §C11's `E`: throw the first grenade-class item you are carrying, from
    /// wherever it is, **without changing the selected slot**.
    ///
    /// This is what makes twenty weapons usable — you stop losing fights while
    /// opening a panel. It is a command like fire and use (`docs/30` §4) and it
    /// goes down the same path, so alive, has-one and cooldown are checked in the
    /// same order and it cannot be used to sidestep `fire_ready_at`.
    pub fn quick_throw(&mut self, id: PlayerId, now: f32) -> Result<(), UseError> {
        let Some(idx) = self.players.iter().position(|p| p.id == id) else {
            return Err(UseError::Dead);
        };
        if !self.players[idx].alive {
            return Err(UseError::Dead);
        }
        let Some(slot) = self.players[idx].quick_throw_slot() else {
            // Rejected with no effect, and named: `docs/61` §3's rule is that the
            // server already knows which of the six answers it was.
            return Err(UseError::NoAmmo);
        };
        let before = self.players[idx].inventory.selected();
        let r = self.fire_from_slot(id, idx, slot, now);
        // Belt and braces: `fire_from_slot` does not touch the selection, but
        // `consume` re-selects when it empties a stack, and the amendment is
        // explicit that the selected slot is unchanged afterwards.
        if self.players[idx].inventory.slot(before).is_some() {
            self.players[idx].inventory.select(before);
        }
        r
    }

    fn fire_from_slot(
        &mut self,
        id: PlayerId,
        idx: usize,
        slot: u8,
        now: f32,
    ) -> Result<(), UseError> {
        let weapon = self.players[idx].try_fire_slot(slot, now)?;
        let aim = crate::player::input::Input::new(0, 0, self.players[idx].aim).aim_angle();
        let centre = self.players[idx].body.pos;
        let tick = self.tick;
        self.events.push(GameEvent::Inventory {
            tick,
            player_id: id,
        });

        let Some(w) = defs::def(weapon) else {
            return Ok(());
        };
        match w.delivery {
            // §F1: a round that flies. The spread is drawn here — at the one site
            // that fires — so the flight code stays free of the RNG and the
            // meteor shower, the toxic rain and the airburst, which all spawn
            // projectiles, never draw from it.
            Delivery::Bullet { spread, .. } => {
                let a = crate::weapons::bullet::muzzle_angle(&mut self.rng, aim, spread);
                let pid = self.projectiles.spawn(weapon, id, centre, a, now);
                if let Some(p) = self.projectiles.get(pid) {
                    let (x, y, vx, vy) = (p.pos.x, p.pos.y, p.vel.x, p.vel.y);
                    self.events.push(GameEvent::ProjectileSpawn {
                        tick,
                        id: pid,
                        weapon,
                        owner: id,
                        x,
                        y,
                        vx,
                        vy,
                    });
                }
            }
            Delivery::Projectile { .. } => {
                let pid = self.projectiles.spawn(weapon, id, centre, aim, now);
                if let Some(p) = self.projectiles.get(pid) {
                    let (x, y, vx, vy) = (p.pos.x, p.pos.y, p.vel.x, p.vel.y);
                    self.events.push(GameEvent::ProjectileSpawn {
                        tick,
                        id: pid,
                        weapon,
                        owner: id,
                        x,
                        y,
                        vx,
                        vy,
                    });
                }
            }
            // Melee: an arc, no ammo, and it carves if the weapon has a radius
            // (§B6). Routed through the same damage log as everything else, so
            // shields, i-frames and attribution behave identically.
            Delivery::Melee {
                reach,
                arc,
                knockback,
            } => {
                // §C19: the table's number is measured from the body edge.
                // Converted **once**, here, and then used by all three of the
                // hit test, the broadcast carve and the arc the client draws —
                // see `melee::effective_reach` for what happened when only the
                // hit test knew about it.
                let reach = crate::weapons::melee::effective_reach(reach);
                let log: DamageLog = Default::default();
                let bird_log: BirdLog = Default::default();
                let result = {
                    let (mut closures, meta, mut bird_vels) =
                        hit_targets(&self.players, &self.birds, &log, &bird_log, now);
                    let mut t = targets(&mut self.players, &mut closures, &meta, &mut bird_vels);
                    crate::weapons::melee::swing(
                        &mut self.map,
                        &mut t,
                        centre,
                        aim,
                        w,
                        reach,
                        arc,
                        knockback,
                        BlastSource::Fired { owner: id, weapon },
                    )
                };
                self.note_knocked(&result.knocked, now);
                self.apply_damage_log(&log, &bird_log, now);
                self.events.push(GameEvent::Melee {
                    tick,
                    owner: id,
                    weapon,
                    x: centre.x,
                    y: centre.y,
                    aim,
                    reach,
                    arc,
                    hits: result.hits.len() as u8,
                });
                if let Some(c) = result.carve {
                    let tip = centre + Vec2::new(aim.cos(), aim.sin()) * reach;
                    self.carve_seq += 1;
                    let seq = self.carve_seq;
                    self.events.push(GameEvent::Carve {
                        tick,
                        seq,
                        x: tip.x.round() as i32,
                        y: tip.y.round() as i32,
                        r: w.blast_radius.round() as i32,
                        kind: CarveKind::Weapon,
                    });
                    self.reveal(&c.revealed, now);
                }
            }
            // §F10.2. One press, `count` flames, along the aim.
            //
            // The muzzle offset is the same one `Projectiles::spawn` uses, so a
            // flame does not start inside its own thrower — `light_fan` takes an
            // explicit position because a molotov's burst and a vent's smoulder
            // have no muzzle at all.
            Delivery::Flames {
                count,
                speed,
                spread,
            } => {
                let muzzle =
                    centre + Vec2::new(aim.cos(), aim.sin()) * crate::constants::MUZZLE_OFFSET;
                let ids = crate::weapons::flame::light_fan(
                    &mut self.projectiles,
                    id,
                    crate::weapons::flame::Fan {
                        at: muzzle,
                        aim,
                        spread,
                        speed,
                        count,
                    },
                    &mut self.rng,
                    now,
                );
                self.announce_flames(&ids, now);
            }
            // Placed: drop it at your feet, armed shortly.
            Delivery::Placed {
                arm_time,
                trigger_radius,
                lifetime,
            } => {
                let mine = self
                    .mines
                    .place(id, w, centre, arm_time, trigger_radius, lifetime, now);
                self.events.push(GameEvent::MinePlaced {
                    tick,
                    id: mine,
                    owner: id,
                    weapon,
                    x: centre.x,
                    y: centre.y,
                });
            }
            Delivery::Hitscan { .. } => {
                let log: DamageLog = Default::default();
                let bird_log: BirdLog = Default::default();
                let shots = {
                    let (mut closures, meta, mut bird_vels) =
                        hit_targets(&self.players, &self.birds, &log, &bird_log, now);
                    let mut t = targets(&mut self.players, &mut closures, &meta, &mut bird_vels);
                    fire_hitscan(
                        &mut self.map,
                        &mut t,
                        w,
                        id,
                        centre,
                        aim,
                        &mut self.rng,
                        now,
                    )
                };
                self.apply_damage_log(&log, &bird_log, now);

                for s in shots {
                    self.events.push(GameEvent::Hitscan {
                        tick,
                        owner: id,
                        x0: s.from.x,
                        y0: s.from.y,
                        x1: s.to.x,
                        y1: s.to.y,
                        hit: s.hit.is_some(),
                    });
                    // A bullet carve is as authoritative as a rocket's: one event
                    // each, in emission order, never coalesced.
                    if let Some(c) = s.carve {
                        self.carve_seq += 1;
                        let seq = self.carve_seq;
                        self.events.push(GameEvent::Carve {
                            tick,
                            seq,
                            x: s.to.x.round() as i32,
                            y: s.to.y.round() as i32,
                            r: w.blast_radius.round() as i32,
                            kind: CarveKind::Weapon,
                        });
                        self.reveal(&c.revealed, now);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn use_item(&mut self, id: PlayerId, slot: u8, now: f32) -> Result<ItemId, UseError> {
        let tick = self.tick;
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return Err(UseError::Dead);
        };
        let r = p.use_item(slot, now);
        if r.is_ok() {
            self.events.push(GameEvent::Inventory {
                tick,
                player_id: id,
            });
        }
        r
    }

    /// `Q` (§C9). The counters are not inventory, so no `Inventory` event —
    /// they ride in the snapshot, which is 20 Hz and always current.
    pub fn use_heal(&mut self, id: PlayerId) -> Result<(), UseError> {
        match self.players.iter_mut().find(|p| p.id == id) {
            Some(p) => p.use_heal(),
            None => Err(UseError::Dead),
        }
    }

    /// `R` (§C9).
    pub fn use_battery_pack(&mut self, id: PlayerId) -> Result<(), UseError> {
        match self.players.iter_mut().find(|p| p.id == id) {
            Some(p) => p.use_battery_pack(),
            None => Err(UseError::Dead),
        }
    }

    /// §C10's drag, validated. The client shows intent; this decides.
    ///
    /// Returns whether anything moved, so the caller can emit `inventory` only
    /// when it did — an event for a refused move would have the client render a
    /// state the server does not have.
    pub fn move_item(&mut self, id: PlayerId, from: u8, to: u8) -> bool {
        let tick = self.tick;
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return false;
        };
        if !p.alive || !p.inventory.move_stack(from, to) {
            return false;
        }
        self.events.push(GameEvent::Inventory {
            tick,
            player_id: id,
        });
        true
    }

    pub fn select_slot(&mut self, id: PlayerId, slot: u8) {
        let tick = self.tick;
        if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
            if p.inventory.select(slot) {
                self.events.push(GameEvent::Inventory {
                    tick,
                    player_id: id,
                });
            }
        }
    }

    pub fn toggle_flashlight(&mut self, id: PlayerId) {
        if let Some(p) = self.players.iter_mut().find(|p| p.id == id) {
            // Only if they actually have one — it is found, not owned.
            let has = p
                .inventory
                .iter()
                .any(|(_, s)| matches!(def(s.item).map(|d| d.kind), Some(ItemKind::Utility(_))));
            if has && p.alive {
                p.flashlight_on = !p.flashlight_on;
            }
        }
    }

    // ----------------------------------------------------------------- events

    /// The events accumulated this tick, without taking them.
    ///
    /// The server logs from these (`docs/61` §3) and then flushes them to
    /// clients; draining to log would mean the log and the wire could not both
    /// see the same event.
    pub fn events_so_far(&self) -> &[GameEvent] {
        &self.events
    }

    pub fn drain_events(&mut self) -> Vec<GameEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn push_event(&mut self, e: GameEvent) {
        self.events.push(e);
    }

    pub fn darkness(&self) -> f32 {
        darkness_at(cycle_u(self.round_time))
    }

    pub fn fog_multiplier(&self) -> f32 {
        self.fog
            .as_ref()
            .map_or(1.0, |(_, f)| f.fov_multiplier(self.round_time))
    }

    /// One player's field-of-view multiplier: fog times the smoke they are in.
    ///
    /// Multiplicative like every other FoV modifier (`docs/14` §3), so a smoke
    /// cloud in heavy fog at night composes without a special case — and it is the
    /// value `fov_radius` already takes as `fog_mult`, so no signature and no
    /// cross-language check has to change.
    pub fn vision_multiplier(&self, p: &PlayerState) -> f32 {
        self.fog_multiplier() * self.smoke.multiplier_at(p.body.pos, self.round_time)
    }

    /// blake3 over every piece of mutable simulation state.
    ///
    /// The footer of a replay file (T8.01) and the fastest way to locate a
    /// determinism regression: the first tick where two runs disagree is the tick
    /// the bug is on.
    ///
    /// **Coverage is the whole point.** An earlier version hashed the mask, the
    /// tick, and player positions — and a probe that leaked `SystemTime` into
    /// `wind` every tick replayed *green*, because `wind` was not hashed and no
    /// projectile happened to be in flight at the final tick. A determinism test
    /// with blind spots certifies the parts nobody was worried about.
    ///
    /// So: every field of `World` that a tick can change is folded in here, and
    /// the subsystems with private state hash themselves (`hash_into`) so the
    /// obligation sits next to the fields rather than in this function.
    pub fn state_hash(&self) -> [u8; 32] {
        let mut h = blake3::Hasher::new();
        h.update(&self.map.mask.hash());
        h.update(&self.tick.to_le_bytes());
        h.update(&self.round_time.to_le_bytes());
        h.update(&self.wind.to_le_bytes());
        h.update(&self.carve_seq.to_le_bytes());
        h.update(&[self.phase as u8, self.last_day_phase as u8]);
        h.update(&self.phase_started_at.to_le_bytes());
        h.update(&self.round_seconds.to_le_bytes());

        // §C16, and §A34's rule applies: birds drop items, so a client whose
        // birds have drifted will disagree about what is on the ground. Every
        // timer that changes the simulation belongs here, and a bird's position
        // decides where a heal lands.
        h.update(&(self.birds.len() as u32).to_le_bytes());
        for b in self.birds.iter() {
            h.update(&b.id.to_le_bytes());
            h.update(&[b.kind.to_u8()]);
            h.update(&b.pos.x.to_le_bytes());
            h.update(&b.pos.y.to_le_bytes());
            h.update(&b.health.to_le_bytes());
        }

        h.update(&(self.players.len() as u32).to_le_bytes());
        for p in &self.players {
            h.update(&[p.id]);
            h.update(&p.body.pos.x.to_le_bytes());
            h.update(&p.body.pos.y.to_le_bytes());
            h.update(&p.body.vel.x.to_le_bytes());
            h.update(&p.body.vel.y.to_le_bytes());
            h.update(&[p.body.grounded as u8]);
            h.update(&p.aim.to_le_bytes());
            h.update(&p.health.to_le_bytes());
            h.update(&p.score.to_le_bytes());
            h.update(&p.deaths.to_le_bytes());
            h.update(&[
                p.alive as u8,
                p.flashlight_on as u8,
                p.jetpack.active as u8,
                p.jetpack.locked_out as u8,
            ]);
            h.update(&p.jetpack.fuel.to_le_bytes());
            h.update(&p.jetpack.idle_ticks.to_le_bytes());
            h.update(&p.jetpack.ticks_since_jump.to_le_bytes());
            h.update(&p.jump.buffered_ticks.to_le_bytes());
            h.update(&p.shield_until.unwrap_or(f32::NAN).to_le_bytes());
            h.update(&p.respawn_at.to_le_bytes());
            h.update(&p.iframes_until.to_le_bytes());
            // §A34, §E13. **Hashed, deliberately.** It is a timer that changes
            // the simulation — two health points a second, for three seconds,
            // and a player who dies of it drops their inventory where they fell.
            // Leaving it out would make a poison divergence invisible to the one
            // guarantee that would catch it, which is precisely the shape §A34
            // was written for. Nothing stored depends on this hash — replay
            // checkpoints are computed on both sides of the same run — so the
            // cost of folding it in is nil.
            h.update(&p.poisoned_until.to_le_bytes());
            h.update(&p.fire_ready_at.to_le_bytes());
            // §A34, and it is load-bearing: this timer decides whether a
            // projectile spawns (§C20's knockback exemption). Leaving a
            // fire-gating timer out of the hash is the exact shape §A34 was
            // written for — every timer was once unhashed and a deliberately
            // nondeterministic build verified green.
            h.update(&p.knocked_until.to_le_bytes());
            // §A34 again, and `battery` was already missing before §C9 added the
            // other two. All three change the simulation: the battery gates every
            // energy shot and ends a shield early (§B5), and the two counters
            // gate `Q` and `R`. A replay whose battery had drifted would run to a
            // different outcome and the checkpoint hashes would agree the whole
            // way, which is the exact shape §A34 exists to prevent.
            h.update(&p.battery.to_le_bytes());
            h.update(&[p.heals, p.batteries]);
            // §A34, §C5. Every one of these decides where the player will be in
            // two seconds' time: `armed` and `spawn_pos` gate the pad, `charging`
            // is how far through it is, and `ready_at` is the cooldown. A replay
            // whose charge had drifted by one tick would teleport a player on a
            // different tick and every hash before that would agree.
            h.update(&[p.teleport.armed as u8]);
            h.update(&p.teleport.spawn_pos.x.to_le_bytes());
            h.update(&p.teleport.spawn_pos.y.to_le_bytes());
            h.update(&[p.teleport.charging.map_or(255, |(id, _)| id)]);
            h.update(
                &p.teleport
                    .charging
                    .map_or(f32::NAN, |(_, t)| t)
                    .to_le_bytes(),
            );
            h.update(&p.teleport.ready_at.to_le_bytes());
            p.inventory.hash_into(&mut h);
        }

        h.update(&(self.items.len() as u32).to_le_bytes());
        for it in self.items.iter() {
            h.update(&it.id.to_le_bytes());
            h.update(&it.item.to_le_bytes());
            h.update(&[it.count, it.grounded as u8]);
            h.update(&it.pos.x.to_le_bytes());
            h.update(&it.pos.y.to_le_bytes());
            h.update(&it.vel.x.to_le_bytes());
            h.update(&it.vel.y.to_le_bytes());
        }

        self.mines.hash_into(&mut h);
        self.burn.hash_into(&mut h);
        self.smoke.hash_into(&mut h);
        h.update(&self.hazard_seq.to_le_bytes());

        h.update(&(self.projectiles.len() as u32).to_le_bytes());
        for p in self.projectiles.iter() {
            h.update(&p.id.to_le_bytes());
            h.update(&p.weapon.0.to_le_bytes());
            h.update(&[p.owner, p.resting as u8]);
            h.update(&p.pos.x.to_le_bytes());
            h.update(&p.pos.y.to_le_bytes());
            h.update(&p.vel.x.to_le_bytes());
            h.update(&p.vel.y.to_le_bytes());
            h.update(&p.age_ticks.to_le_bytes());
            h.update(&p.fuse_at.unwrap_or(f32::NAN).to_le_bytes());
        }

        for slot in &self.buried_items {
            h.update(&slot.to_le_bytes());
        }

        self.effects.hash_into(&mut h);
        self.spawn_schedule.hash_into(&mut h);
        self.tombstones.hash_into(&mut h);

        // The world's own stream, by position — see `EffectScheduler::hash_into`.
        let mut probe = self.rng.clone();
        h.update(&rand::RngCore::next_u64(&mut probe).to_le_bytes());

        *h.finalize().as_bytes()
    }
}

/// Give a player an item. Tests and the sandbox only — in a real round everything
/// is found.
pub fn give(world: &mut World, id: PlayerId, item: ItemId, count: u8) {
    if let Some(p) = world.player_mut(id) {
        p.inventory.add(item, count);
    }
}

/// Put an item a player is already carrying **in their hand**.
///
/// The companion to `give`, and §F5 is why it exists. Every player now spawns
/// holding a shovel in slot 0 and `give` appends to the first *free* slot, so
/// `give(w, 0, BAZOOKA, 4)` followed by `w.fire(0, t)` swings a shovel. That does
/// not fail loudly — a swing sets the same FIRE bit, spawns no projectile and
/// hits nothing at range — so three bot fixtures went on passing while measuring
/// the wrong weapon, one of them reporting a molotov throw it never made.
///
/// Panics rather than returning a bool: a fixture that wields something it was
/// never given is broken, and a silent `false` is how it stays broken.
pub fn wield(world: &mut World, id: PlayerId, item: ItemId) {
    let slot = (0..crate::constants::INVENTORY_SLOTS as u8)
        .find(|s| {
            world
                .player(id)
                .and_then(|p| p.inventory.slot(*s))
                .is_some_and(|st| st.item == item)
        })
        .unwrap_or_else(|| panic!("player {id} is not carrying item {item}"));
    world.select_slot(id, slot);
}

#[cfg(test)]
mod state_hash_tests {
    use super::*;
    use crate::constants::MapScale;

    fn world() -> World {
        let mut w = World::with_buried_secret(4242, MapScale::Small, 7);
        w.add_player(0, 0, "ana".into());
        w.add_player(1, 0, "bo".into());
        w
    }

    /// Every field a tick can change must move the hash.
    ///
    /// This exists because it did not. An earlier `state_hash` covered the mask,
    /// the tick and player positions, and a probe that leaked `SystemTime` into
    /// `wind` on every tick replayed **green** — the determinism test that guards
    /// this entire project had blind spots over most of the simulation.
    ///
    /// Each case below is a field that was unhashed then. A new field added to
    /// `World` without a line in `state_hash` will not be caught automatically —
    /// Rust has no reflection here — so add a case when you add a field.
    #[test]
    fn the_hash_is_sensitive_to_every_field_a_tick_can_change() {
        let base = world().state_hash();

        let mut changed: Vec<(&str, [u8; 32])> = Vec::new();

        let mut w = world();
        w.wind += 0.0001;
        changed.push(("wind", w.state_hash()));

        let mut w = world();
        w.carve_seq += 1;
        changed.push(("carve_seq", w.state_hash()));

        let mut w = world();
        w.phase = RoundPhase::Ended;
        changed.push(("phase", w.state_hash()));

        let mut w = world();
        w.round_seconds += 1.0;
        changed.push(("round_seconds", w.state_hash()));

        let mut w = world();
        w.players[0].aim = w.players[0].aim.wrapping_add(1);
        changed.push(("aim", w.state_hash()));

        // §E13's status is a timer, and every other timer here is in the hash
        // for the reason §A34 records.
        let mut w = world();
        w.players[0].poisoned_until += 0.5;
        changed.push(("poisoned_until", w.state_hash()));

        let mut w = world();
        w.players[0].jetpack.fuel -= 0.5;
        changed.push(("jetpack fuel", w.state_hash()));

        let mut w = world();
        w.players[0].jetpack.locked_out = !w.players[0].jetpack.locked_out;
        changed.push(("jetpack lockout", w.state_hash()));

        let mut w = world();
        w.players[0].shield_until = Some(12.0);
        changed.push(("shield", w.state_hash()));

        let mut w = world();
        w.players[0].iframes_until = 9.0;
        changed.push(("iframes", w.state_hash()));

        let mut w = world();
        w.players[0].fire_ready_at = 9.0;
        changed.push(("cooldown", w.state_hash()));

        let mut w = world();
        w.players[0].knocked_until = 9.0;
        changed.push(("knockback grace", w.state_hash()));

        let mut w = world();
        w.players[0].flashlight_on = true;
        changed.push(("flashlight", w.state_hash()));

        let mut w = world();
        w.players[0].deaths += 1;
        changed.push(("deaths", w.state_hash()));

        let mut w = world();
        crate::world::give(&mut w, 0, crate::items::registry::MEDKIT, 1);
        changed.push(("inventory", w.state_hash()));

        let mut w = world();
        w.buried_items[0] = crate::items::registry::MEDKIT;
        changed.push(("buried items", w.state_hash()));

        // Draining the world RNG changes only its stream position — nothing
        // visible — which is exactly the divergence a position probe exists to
        // catch.
        let mut w = world();
        let _ = rand::RngCore::next_u64(&mut w.rng);
        changed.push(("world rng position", w.state_hash()));

        for (what, h) in changed {
            assert_ne!(h, base, "changing `{what}` did not change the state hash");
        }
    }

    /// The control: an untouched world must hash the same twice, or the test
    /// above would pass for the wrong reason.
    #[test]
    fn the_hash_is_stable_for_an_untouched_world() {
        assert_eq!(world().state_hash(), world().state_hash());
    }

    /// The scheduler's stream position is state even when its visible fields are
    /// identical: two schedulers that have drawn a different number of times will
    /// roll different effects next.
    #[test]
    fn the_hash_covers_scheduler_stream_position() {
        let mut a = world();
        let b = world();
        a.effects.drain_one_for_test();
        assert_ne!(
            a.state_hash(),
            b.state_hash(),
            "advancing the weather stream left the hash unchanged"
        );
    }
}

#[cfg(test)]
mod state_hash_coverage {
    use super::*;

    /// A **compile-time** tripwire for `state_hash` silently narrowing.
    ///
    /// `the_hash_is_sensitive_to_every_field_a_tick_can_change` proves the fields
    /// that exist today are covered. It cannot prove a field added tomorrow is.
    ///
    /// So this destructures `World` exhaustively — no `..`. Rust requires every
    /// field to be named, so **adding a field to `World` makes this stop
    /// compiling**, and the author has to come here and decide whether their new
    /// field belongs in the hash. That is the only question this file exists to
    /// force.
    ///
    /// I tried pinning `size_of::<World>()` first. It does not work: I added a
    /// `u64` probe field and the size stayed 2304, because it landed in existing
    /// padding. A tripwire that fails its own falsification is decoration.
    ///
    /// This exists because leaking `SystemTime` into `world.wind` on every tick
    /// once replayed **green** — the determinism guarantee for the whole project
    /// rested on a hash covering a fraction of the simulation.
    #[test]
    fn every_field_of_world_has_been_considered_for_the_state_hash() {
        let w = World::new(1, crate::constants::MapScale::Small);
        let World {
            // Hashed: a tick can change these, so they are part of the state a
            // replay must reproduce.
            map: _,
            players: _,
            items: _,
            projectiles: _,
            tombstones: _,
            birds: _,
            mines: _,
            burn: _,
            smoke: _,
            hazard_seq: _,
            spawn_schedule: _,
            effects: _,
            buried_items: _,
            round_time: _,
            tick: _,
            phase: _,
            wind: _,
            rng: _,
            carve_seq: _,
            phase_started_at: _,
            round_seconds: _,
            last_day_phase: _,
            toxic: _,
            meteor: _,
            lava: _,
            fog: _,

            // Deliberately NOT hashed, each for a stated reason:
            // `seed` is an input, fixed for the round and carried in the replay
            // header — hashing it would only prove the header was read.
            seed: _,
            // `events` is drained every tick and delivered to clients; it is
            // output, not state, and two runs that produced identical state have
            // by construction produced identical events.
            events: _,
            // `pending` and `prev_input` are consumed within the tick that fills
            // them (§A30: one input per player per tick), so they are empty at
            // every point a hash is taken.
            pending: _,
            prev_input: _,
            // `weather_mode` is a development switch set once at construction
            // and never written again (`WeatherMode`'s own doc says why it is
            // not in the replay header either). It is an input like `seed`: two
            // worlds that ran under different modes diverge in `effects`, which
            // *is* hashed, so hashing this as well would only prove the switch
            // was read.
            weather_mode: _,
            // `respawn_fallbacks` counts a condition §C5 says cannot happen. It
            // is an assertion aid, not state: the choice it records is already
            // reflected in the respawned body's position, which *is* hashed, so
            // a divergence would show up in `players` first and hashing this
            // would only prove the counter was incremented twice the same way.
            respawn_fallbacks: _,
        } = w;
    }
}

/// T13.05 — a crate that falls where anyone watching can see it fall.
///
/// The bug (§C7) was reported as two: crates appear in mid-air, and crates cannot
/// be picked up. Sampling the simulation first showed it is **one**, and not in
/// the simulation at all: the crate falls correctly and a player standing on it
/// picks it up correctly. What never existed was any way for an observer to learn
/// that the crate had moved since it was created, so every client drew it at
/// `y = SKY_MARGIN / 2` for the rest of the round and "cannot pick it up" meant
/// "cannot pick it up *there*".
#[cfg(test)]
mod crate_motion_tests {
    use super::*;
    use crate::constants::{MapScale, CRATE_H, SIM_DT};
    use crate::items::registry::MEDKIT;

    fn world() -> World {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w
    }

    /// Drop a crate from the sky, the way `tick_crates` does.
    /// The radius the crate test digs with.
    const CARVE_R: i32 = 60;

    /// An x near `want` whose ground no teleport pad protects.
    ///
    /// A pad rect is `PAD_W` wide and indestructible, so a carve of radius `r`
    /// centred within `r + PAD_W / 2` of a pad's centre is partly refused. Walking
    /// outward from `want` finds the nearest usable column rather than hardcoding
    /// one that a future generator change would invalidate.
    fn drop_x_clear_of_pads(w: &World, want: f32, r: i32) -> f32 {
        let clearance = r as f32 + crate::constants::PAD_W as f32 / 2.0 + 8.0;
        let clear = |x: f32| {
            w.map
                .meta
                .teleport_pads
                .iter()
                .all(|p| (x - p.pos.x as f32).abs() > clearance)
        };
        if clear(want) {
            return want;
        }
        for step in 1..200 {
            for dir in [1.0f32, -1.0] {
                let x = want + dir * step as f32 * 16.0;
                if x > 64.0 && x < w.map.mask.w as f32 - 64.0 && clear(x) {
                    return x;
                }
            }
        }
        panic!("nowhere on this map is clear of the teleport pads");
    }

    fn drop_crate(w: &mut World, x: f32) -> WorldItemId {
        w.items.spawn(
            MEDKIT,
            1,
            Vec2::new(x, (crate::constants::SKY_MARGIN / 2) as f32),
            Vec2::ZERO,
            SpawnSource::Crate,
            0.0,
        )
    }

    fn moves(evs: &[GameEvent], want: WorldItemId) -> Vec<(f32, f32, bool)> {
        evs.iter()
            .filter_map(|e| match e {
                GameEvent::ItemMove {
                    world_item_id,
                    x,
                    y,
                    grounded,
                    ..
                } if *world_item_id == want => Some((*x, *y, *grounded)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_falling_crate_is_reported_moving_and_then_reported_landed() {
        let mut w = world();
        let id = drop_crate(&mut w, 300.0);

        let mut evs = Vec::new();
        for _ in 0..600 {
            w.step(SIM_DT);
            evs.extend(w.drain_events());
        }

        let m = moves(&evs, id);
        assert!(
            m.len() > 3,
            "a crate fell the height of the map and produced {} position reports — \
             an observer cannot draw a fall it is never told about",
            m.len()
        );
        // It went down. Reported y must increase (screen coords) until it stops.
        for pair in m.windows(2) {
            assert!(
                pair[1].1 >= pair[0].1,
                "reported y went up: {} then {}",
                pair[0].1,
                pair[1].1
            );
        }
        assert!(m[m.len() - 1].1 > m[0].1 + 20.0, "it barely moved");

        // The landing is reported, and it is the LAST word.
        let last = *m.last().expect("at least one");
        assert!(
            last.2,
            "the crate landed and nobody was told it had stopped"
        );
        // Landing is reported twice, not once, and that is the truth rather
        // than a bug: it comes to rest, the footprint probe finds no support for
        // a single step, and it settles 0.39 px onto its final resting place.
        // A settle, not a bounce — the second landing is *below* the first and
        // within a pixel of it. `a_resting_crate_is_reported_once_and_then_
        // never_again` is what pins that it does stop.
        let landings: Vec<_> = m.iter().filter(|e| e.2).collect();
        assert!(
            landings.len() <= 3,
            "reported landing {} times — that is a bounce, not a settle",
            landings.len()
        );
        for pair in landings.windows(2) {
            assert!(
                pair[1].1 >= pair[0].1 && pair[1].1 - pair[0].1 < 1.0,
                "settled from {} to {}, which is a bounce",
                pair[0].1,
                pair[1].1
            );
        }

        // And the last reported position is where the crate actually is. This is
        // the assertion the cadence alone cannot pass: emitting only every third
        // tick lands on the resting position by luck, and missing it leaves every
        // observer drawing the crate a few pixels above the ground forever.
        let it = w.items.get(id).expect("still there");
        assert!(
            (last.0 - it.pos.x).abs() < 0.01 && (last.1 - it.pos.y).abs() < 0.01,
            "last reported ({}, {}) but the crate is at {:?}",
            last.0,
            last.1,
            it.pos
        );
    }

    /// The control for the test above. A grounded item that nothing disturbs must
    /// generate no traffic at all — otherwise "it reports while falling" would
    /// pass for something that reports forever, and the cadence would be a lie.
    #[test]
    fn a_resting_crate_is_reported_once_and_then_never_again() {
        let mut w = world();
        let id = drop_crate(&mut w, 300.0);
        for _ in 0..600 {
            w.step(SIM_DT);
            let _ = w.drain_events();
        }
        assert!(w.items.get(id).expect("there").grounded, "never landed");

        let mut evs = Vec::new();
        for _ in 0..300 {
            w.step(SIM_DT);
            evs.extend(w.drain_events());
        }
        assert!(
            moves(&evs, id).is_empty(),
            "a crate that is not moving reported {} positions in 5 s",
            moves(&evs, id).len()
        );
    }

    #[test]
    fn a_crate_whose_ground_is_carved_away_falls_again_and_says_so() {
        let mut w = world();
        // **Not a fixed x.** Teleport pads (§C5) are indestructible, so a crate
        // that happens to land on one has ground that cannot be carved away, and
        // this test would report the crate hanging in the air when the truth is
        // that the carve was correctly refused. Ask the map where the pads are.
        let x = drop_x_clear_of_pads(&w, 300.0, CARVE_R);
        let id = drop_crate(&mut w, x);
        for _ in 0..600 {
            w.step(SIM_DT);
            let _ = w.drain_events();
        }
        let resting = w.items.get(id).expect("there").pos;
        assert!(w.items.get(id).expect("there").grounded);

        // Take the floor out from under it (`docs/32` §4).
        let removed = w
            .map
            .carve_circle(resting.x as i32, (resting.y + CRATE_H) as i32, CARVE_R)
            .pixels_removed;
        assert!(
            removed > 0,
            "the carve under the crate at {resting:?} removed nothing, so this \
             test is about the fixture rather than the crate"
        );

        let mut evs = Vec::new();
        for _ in 0..600 {
            w.step(SIM_DT);
            evs.extend(w.drain_events());
        }
        let after = w.items.get(id).expect("there");
        assert!(
            after.pos.y > resting.y + 5.0,
            "the crate hung over the crater at {:?} (was {resting:?})",
            after.pos
        );
        let m = moves(&evs, id);
        assert!(!m.is_empty(), "it fell again and nobody was told");
        assert!(
            m.last().expect("some").2,
            "it came to rest again and nobody was told"
        );
    }

    /// The pickup, end to end and at both ends (§A39): the item enters an
    /// inventory **and** leaves the world. Asserting only the first would pass for
    /// a crate that is picked up infinitely.
    #[test]
    fn a_player_standing_on_a_landed_crate_picks_it_up() {
        let mut w = world();
        let id = drop_crate(&mut w, 300.0);
        for _ in 0..600 {
            w.step(SIM_DT);
            let _ = w.drain_events();
        }
        let at = w.items.get(id).expect("there").pos;
        assert!(w.items.get(id).expect("there").grounded, "never landed");

        w.add_player(0, 0, "ana".into());
        // A medkit lands in §C9's **counter**, not in a slot, so this reads
        // `heals` and not `count_of` — the inventory version went on asserting
        // `0 == 0 + 1` and failing for the right reason the moment §C9 landed.
        let before = w.player_mut(0).expect("added").heals;
        // Standing where the crate is — which, before this task, is a place no
        // player could know to stand.
        w.player_mut(0).expect("added").body.pos = at;

        let mut evs = Vec::new();
        for _ in 0..10 {
            w.step(SIM_DT);
            evs.extend(w.drain_events());
        }

        assert!(
            evs.iter().any(|e| matches!(
                e,
                GameEvent::ItemPickup { world_item_id, player_id, .. }
                    if *world_item_id == id && *player_id == 0
            )),
            "no pickup event"
        );
        assert_eq!(
            w.player_mut(0).expect("added").heals,
            before + 1,
            "the crate's contents never reached the player"
        );
        assert!(
            w.items.get(id).is_none(),
            "picked up and still lying in the world"
        );
    }

    /// The control for the pickup: out of range, nothing happens. Without it,
    /// "walking onto it picks it up" passes for an item that is picked up from
    /// anywhere on the map.
    #[test]
    fn a_player_across_the_map_picks_up_nothing() {
        let mut w = world();
        let id = drop_crate(&mut w, 300.0);
        for _ in 0..600 {
            w.step(SIM_DT);
            let _ = w.drain_events();
        }
        let at = w.items.get(id).expect("there").pos;

        w.add_player(0, 0, "ana".into());
        w.player_mut(0).expect("added").body.pos = Vec2::new(at.x + 400.0, at.y);
        for _ in 0..10 {
            w.step(SIM_DT);
            let _ = w.drain_events();
        }
        assert!(w.items.get(id).is_some(), "picked up from 400 px away");
    }
}

/// §F4 — you fire while moving. §C20 is repealed.
///
/// **This module replaces the one that proved the opposite.** It asserted
/// `Err(UseError::Moving)` from a walk, from the tick after a key release, and
/// from mid-air; all of that is deleted, because it is a description of a design
/// that no longer exists. An absence needs a presence (`CLAUDE.md`), and these
/// are the presence: the shot that used to be refused now leaves the barrel.
#[cfg(test)]
mod fire_while_moving {
    use super::*;
    use crate::constants::{MapScale, SIM_DT};
    use crate::items::registry::BAZOOKA;
    use crate::player::input::button;

    /// One armed player, standing on the ground, in `Playing`.
    fn armed_world() -> World {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        give(
            &mut w,
            0,
            BAZOOKA,
            crate::items::registry::max_stack(BAZOOKA),
        );
        // In hand, not merely in the bag: §F5 seats a shovel in slot 0, and a
        // fixture called `armed_world` that fires a shovel is measuring nothing
        // it claims to.
        wield(&mut w, 0, BAZOOKA);
        // Settle onto the ground, so "at a run" and "mid-air" are distinguishable
        // rather than both being "still falling from spawn".
        for _ in 0..120 {
            w.queue_input(0, Input::new(0, 0, 0));
            w.step(SIM_DT);
        }
        assert!(
            w.player(0).expect("ana").body.grounded,
            "the fixture never landed, so nothing below distinguishes running from falling"
        );
        w
    }

    /// "Actually running", as a fraction of the walk the fixture is holding.
    ///
    /// Pinned to `WALK_SPEED` rather than written as a number: at 150.0 a literal
    /// `100.0` is two thirds of a walk, but it is two thirds only until somebody
    /// retunes the constant. Cut `WALK_SPEED` to 90 and a hardcoded 100 is
    /// unreachable — `run_until_moving` spins its full 240 ticks, returns 0.0,
    /// and every test built on it goes quietly vacuous rather than red
    /// (`CLAUDE.md`: never hardcode a tunable in a test).
    const RUNNING: f32 = crate::constants::WALK_SPEED * 2.0 / 3.0;

    /// Walk right until actually moving, and report the speed reached.
    ///
    /// Waited on rather than counted: a spawn is not promised flat ground, and
    /// how many ticks it takes to reach walk speed depends on where the
    /// generator put you.
    ///
    /// Returns **0.0** if it never got going, which every caller must assert on
    /// — see `RUNNING`.
    fn run_until_moving(w: &mut World) -> f32 {
        for _ in 0..240 {
            w.queue_input(0, Input::new(0, button::RIGHT, 0));
            w.step(SIM_DT);
            let vx = w.player(0).expect("ana").body.vel.x.abs();
            if vx > RUNNING {
                return vx;
            }
        }
        0.0
    }

    #[test]
    fn a_player_at_a_full_run_fires() {
        let mut w = armed_world();
        let vx = run_until_moving(&mut w);
        assert!(vx > RUNNING, "the fixture never got moving ({vx} px/s)");
        // Still holding the key: this is the exact input §C20 refused.
        w.queue_input(0, Input::new(0, button::RIGHT, 0));
        assert_eq!(
            w.fire(0, 1.0),
            Ok(()),
            "a player running at {vx} px/s could not fire"
        );
    }

    /// **Jumping *while running*, not jumping on the spot.**
    ///
    /// A straight-up jump holds no direction key and carries no horizontal
    /// speed, so §C20 would have allowed that shot too — a test built on it
    /// discriminates nothing. The reported complaint is firing while moving
    /// through the air, so the fixture holds RIGHT throughout and the assertions
    /// below prove it really is airborne *and* really is moving.
    #[test]
    fn a_player_jumping_while_running_fires() {
        let mut w = armed_world();
        run_until_moving(&mut w);
        for _ in 0..12 {
            w.queue_input(0, Input::new(0, button::RIGHT | button::JUMP, 0));
            w.step(SIM_DT);
        }
        let p = w.player(0).expect("ana");
        assert!(
            !p.body.grounded,
            "the fixture never left the ground, so this is not the mid-air case"
        );
        assert!(
            p.body.vel.x.abs() > RUNNING,
            "airborne but barely moving ({} px/s) — §C20 would have allowed this shot",
            p.body.vel.x.abs()
        );
        // Still holding the direction key, which is the term §C20 checked first.
        w.queue_input(0, Input::new(0, button::RIGHT | button::JUMP, 0));
        assert_eq!(
            w.fire(0, 1.0),
            Ok(()),
            "a player running through the air could not fire"
        );
    }

    /// Jetpacking **sideways** — the case the report named in as many words.
    #[test]
    fn a_player_under_jetpack_thrust_fires() {
        let mut w = armed_world();
        // Held JUMP past the jump itself is thrust (`jetpack::apply_thrust`
        // requires JUMP), and RIGHT is what makes it movement rather than a
        // hover §C20 would not have refused anyway.
        for _ in 0..40 {
            w.queue_input(
                0,
                Input::new(0, button::RIGHT | button::JUMP | button::UP, 0),
            );
            w.step(SIM_DT);
        }
        let p = w.player(0).expect("ana");
        assert!(!p.body.grounded, "the fixture never left the ground");
        assert!(
            p.jetpack.fuel < crate::constants::JETPACK_MAX_FUEL,
            "no fuel was spent, so the jetpack never engaged and this is not the thrust case"
        );
        assert!(
            p.body.vel.x.abs() > RUNNING,
            "thrusting but barely moving ({} px/s) — §C20 would have allowed this shot",
            p.body.vel.x.abs()
        );
        w.queue_input(
            0,
            Input::new(0, button::RIGHT | button::JUMP | button::UP, 0),
        );
        assert_eq!(
            w.fire(0, 1.0),
            Ok(()),
            "a player jetpacking sideways could not fire"
        );
    }

    /// The repeal removes one gate and **only** one.
    #[test]
    fn firing_at_a_run_still_respects_the_cooldown() {
        let mut w = armed_world();
        // Asserted, not discarded. `run_until_moving` returns 0.0 when it never
        // gets going, and without this the test degenerates into "a *standing*
        // player's second shot is refused" — which `try_fire` did before §F4 and
        // which rules nothing out about firing on the move.
        let vx = run_until_moving(&mut w);
        assert!(vx > RUNNING, "the fixture never got moving ({vx} px/s)");
        w.queue_input(0, Input::new(0, button::RIGHT, 0));
        assert_eq!(w.fire(0, 1.0), Ok(()), "the first shot was refused");
        // Inside the weapon's own cooldown, pinned to the constant.
        let second = w.fire(0, 1.0 + crate::constants::BAZOOKA_COOLDOWN * 0.5);
        assert_eq!(
            second,
            Err(UseError::OnCooldown),
            "a second shot inside BAZOOKA_COOLDOWN was allowed: the repeal removed \
             more than the movement gate"
        );
    }

    /// A moving player's shot goes where they aimed.
    ///
    /// The obvious way to "support firing while moving" is to add the body's
    /// velocity to the muzzle velocity. Nobody asked for that, and it would make
    /// a running player's rocket faster than a standing player's — so it is
    /// asserted against rather than left to taste.
    #[test]
    fn a_moving_players_shot_does_not_inherit_their_velocity() {
        let mut w = armed_world();
        // Asserted, not discarded — a stalled fixture would make this compare a
        // standing shot against a standing shot, which is a tautology that
        // passes with the whole feature deleted.
        let vx = run_until_moving(&mut w);
        assert!(vx > RUNNING, "the fixture never got moving ({vx} px/s)");
        w.queue_input(0, Input::new(0, button::RIGHT, 0));

        // **The shot just fired, not the oldest one alive.** `.iter().next()`
        // reads whichever projectile the collection yields first, which is the
        // right answer only while nothing else is in flight — true here solely
        // because `EFFECT_INTERVAL_MIN` is 30 s against a ~6 s fixture, so no
        // meteor or rain drop can have spawned. That is a load-bearing tie to a
        // tunable this test has nothing to do with; index past what was already
        // there instead.
        let before = w.projectiles.len();
        assert_eq!(w.fire(0, 1.0), Ok(()));
        assert_eq!(
            w.projectiles.len(),
            before + 1,
            "the running shot did not add exactly one projectile"
        );
        let moving = w
            .projectiles
            .iter()
            .nth(before)
            .expect("the running shot spawned no projectile")
            .vel;

        // The control: the same weapon, the same aim, from a standstill.
        let mut still = armed_world();
        let still_before = still.projectiles.len();
        assert_eq!(still.fire(0, 1.0), Ok(()));
        let stationary = still
            .projectiles
            .iter()
            .nth(still_before)
            .expect("the standing shot spawned no projectile")
            .vel;

        assert!(
            (moving.x - stationary.x).abs() < 1.0 && (moving.y - stationary.y).abs() < 1.0,
            "a running player's shot left at {moving:?} against a standing player's \
             {stationary:?} — the muzzle velocity inherited the body's"
        );
    }
}

/// T13.06.4 / §C21 / §E13 — toxic rain falls, so it cannot land under a roof,
/// and what it lands on it bites rather than cratering.
#[cfg(test)]
mod toxic_rain_falls {
    use super::*;
    use crate::constants::{MapScale, SKY_MARGIN, TOXIC_DURATION};
    use crate::items::registry::WEAPON_TOXIC_DROP;
    use crate::map::{CoarseGrid, Mask};
    use crate::weapons::explode::EffectKind;

    // Multiples of CHUNK_SIZE: `Mask::new_empty` requires it.
    const W: u32 = 512;
    const H: u32 = 512;
    /// Ground level, well below `SKY_MARGIN` (96) so drops have room to fall.
    const GROUND: u32 = 400;
    /// The roof over the cave, and the cave floor under it.
    const ROOF: u32 = 250;
    /// How thick that roof is.
    ///
    /// **It was 12, and §F6 made 12 too thin to be cover.** A drop takes a
    /// `TOXIC_DROP_CARVE_R` (6 px) bite out of whatever it lands on, and at the
    /// new cadence 54 of them fall in a shower: measured, a 12 px slab was dug
    /// through inside one window and the "sheltered" player then lost 30.7
    /// health to rain coming in through the hole they were standing under. That
    /// is the game working — you can dig a roof off someone — and it is useless
    /// in a fixture whose subject is cover, so the slab is now thick enough to
    /// survive a shower. Nothing else here depends on the number.
    const ROOF_THICKNESS: u32 = 40;
    const CAVE_FLOOR: u32 = 340;
    /// The cave's x range, and an open column beside it.
    const CAVE_X0: u32 = 80;
    const CAVE_X1: u32 = 180;
    const OPEN_X0: u32 = 300;
    const OPEN_X1: u32 = 400;

    /// A map with a **roofed cave** on the left and open ground on the right.
    ///
    /// Hand-built, not generated: this test needs a known roof at a known height,
    /// and `generate()` gives a realistic map rather than a legible one. The two
    /// halves are the test and its control, on one map, so nothing about the
    /// terrain differs between them except the roof.
    fn map_with_a_cave() -> Map {
        let mut mask = Mask::new_empty(W, H);
        // Solid from GROUND down: the floor of the world.
        for y in GROUND..H {
            for x in 0..W {
                mask.set(x as i32, y as i32);
            }
        }
        // The cave: a roof slab, and a floor under it for a drop to land on.
        for x in CAVE_X0..CAVE_X1 {
            for y in ROOF..(ROOF + ROOF_THICKNESS) {
                mask.set(x as i32, y as i32);
            }
            for y in CAVE_FLOOR..GROUND {
                mask.set(x as i32, y as i32);
            }
        }
        let coarse = CoarseGrid::build(&mask);
        let mut meta = crate::map::MapMeta {
            seed: 1,
            requested_seed: 1,
            attempts: 1,
            used_safe_preset: false,
            scale: MapScale::Small,
            theme: 0,
            spawn_points: Vec::new(),
            teleport_pads: Vec::new(),
            surface_points: Vec::new(),
            objects: Vec::new(),
            buried_slots: Vec::new(),
            decorations: Vec::new(),
            wind: 0.0,
            traversable_fraction: 1.0,
            largest_component: Vec::new(),
        };
        // The surface points the pre-§C21 code placed the hazard on directly.
        // Under the cave the "surface" is the CAVE FLOOR — under a roof — which
        // is exactly how rain ended up indoors. They are still what chooses the
        // column to rain over, so both halves of the map get rained on.
        for x in (CAVE_X0..CAVE_X1).step_by(4) {
            meta.surface_points.push(crate::math::Point {
                x: x as i32,
                y: CAVE_FLOOR as i32,
            });
        }
        for x in (OPEN_X0..OPEN_X1).step_by(4) {
            meta.surface_points.push(crate::math::Point {
                x: x as i32,
                y: GROUND as i32,
            });
        }
        Map::from_parts(mask, coarse, meta)
    }

    /// Is `(x, y)` under solid rock — i.e. is there a roof between it and the sky?
    fn has_a_roof_over_it(map: &Map, x: f32, y: f32) -> bool {
        let xi = x.round() as i64;
        if xi < 0 || xi >= W as i64 {
            return false;
        }
        let top = y.round() as i64;
        (0..top).any(|py| map.mask.get(xi as i32, py as i32))
    }

    /// Rain on the cave map for a full active window and collect every place a
    /// drop **landed**, read off the carve it left.
    ///
    /// The carve is the evidence now that there is no puddle to count: §E13 gives
    /// a drop a `TOXIC_DROP_CARVE_R` bite of the ground it stops on, and this
    /// fixture fires no weapons, so every carve in it is a raindrop.
    fn rain(seed: u64) -> (World, Vec<(f32, f32)>) {
        let mut w = World::new(seed, MapScale::Small);
        w.map = map_with_a_cave();
        w.set_phase(RoundPhase::Playing);
        // One player, in the middle, so the half-of-the-map bias does not send
        // every drop to one side and starve the other of samples.
        w.add_player(0, 0, "ana".into());
        if let Some(p) = w.player_mut(0) {
            p.body.pos = Vec2::new(W as f32 / 2.0, GROUND as f32 - 20.0);
        }
        w.force_effect(EffectKind::ToxicRain, w.round_time);

        let mut landings = Vec::new();
        // The active window, plus time for the last drop to fall the height of
        // the map and land.
        let ticks = ((TOXIC_DURATION + 12.0) / crate::constants::SIM_DT) as u32;
        for _ in 0..ticks {
            w.step(crate::constants::SIM_DT);
            for e in w.drain_events() {
                if let GameEvent::Carve { x, y, .. } = e {
                    landings.push((x as f32, y as f32));
                }
            }
        }
        (w, landings)
    }

    /// §F6's acceptance, in one run: **stand in it and lose health**.
    ///
    /// This is the assertion the whole task exists for, and it is deliberately
    /// not a hand-placed drop. §E13's unit tests all hit the player on purpose —
    /// `hit_player_for_test` — which is why they stayed green for a milestone
    /// while a real shower could be stood in from start to finish. Here the
    /// scheduler releases the rain, the drops fall, and whether any of them
    /// reaches anybody is the question.
    ///
    /// The control is in the same run, on the same map, in the same shower: a
    /// second player under the cave roof. Without it "the open player lost
    /// health" is satisfied by rain that poisons everyone regardless of cover,
    /// which is precisely the rule §E13 added and §F6 keeps.
    ///
    /// Aggregated over seeds, because where the rain falls is a draw and the
    /// claim is about a population (§A27). The claim is **not** "every seed hits
    /// him" — it is that standing in a shower now costs health, which one dry
    /// seed does not refute.
    #[test]
    fn a_shower_hurts_the_player_in_the_open_and_never_the_one_under_rock() {
        let seeds = [1u64, 7, 42, 99, 4242, 12345];
        let mut wet_seeds = 0;
        let mut total_lost = 0.0f32;
        for seed in seeds {
            let mut w = World::new(seed, MapScale::Small);
            w.map = map_with_a_cave();
            w.set_phase(RoundPhase::Playing);
            // Open sky, and standing on the ground rather than floating: the
            // splash is a distance from the landing point and a body in the air
            // is a different question.
            w.add_player(0, 0, "open".into());
            if let Some(p) = w.player_mut(0) {
                p.body.pos = Vec2::new(
                    (OPEN_X0 + 40) as f32,
                    GROUND as f32 - crate::constants::PLAYER_H / 2.0,
                );
            }
            // Under twelve pixels of rock, on the cave floor.
            w.add_player(1, 0, "sheltered".into());
            if let Some(p) = w.player_mut(1) {
                p.body.pos = Vec2::new(
                    ((CAVE_X0 + CAVE_X1) / 2) as f32,
                    CAVE_FLOOR as f32 - crate::constants::PLAYER_H / 2.0,
                );
            }
            w.force_effect(EffectKind::ToxicRain, w.round_time);

            // The window, plus the fall and the last poison's full duration —
            // the damage is a status that outlives the shower.
            let ticks = ((TOXIC_DURATION + 16.0) / crate::constants::SIM_DT) as u32;
            for _ in 0..ticks {
                w.step(crate::constants::SIM_DT);
            }
            let open = w.player(0).expect("open").health;
            let dry = w.player(1).expect("sheltered").health;
            assert_eq!(
                dry,
                crate::constants::BASE_HEALTH,
                "seed {seed}: the sheltered player lost {} health under \
                 {ROOF_THICKNESS} pixels of rock",
                crate::constants::BASE_HEALTH - dry
            );
            if open < crate::constants::BASE_HEALTH {
                wet_seeds += 1;
                total_lost += crate::constants::BASE_HEALTH - open;
            }
        }
        // §F6's whole point: a player who stands in it is hit. Before the change
        // the expectation was 0.26 hits a shower; this asserts the population,
        // not one lucky draw.
        assert!(
            wet_seeds * 2 > seeds.len(),
            "the player in the open was hit in only {wet_seeds} of {} showers — \
             this is the lottery §F6 exists to end",
            seeds.len()
        );
        // And the hits cost what the constants say: at least one full poison on
        // average, pinned rather than written as a number.
        let per_shower = total_lost / seeds.len() as f32;
        let one_hit = crate::constants::TOXIC_POISON_DPS * crate::constants::TOXIC_POISON_DURATION;
        assert!(
            per_shower >= one_hit,
            "a shower cost {per_shower:.1} health on average, less than the \
             {one_hit:.1} a single hit is worth"
        );
    }

    /// The subject, and its control, on one map.
    ///
    /// Aggregated over several seeds: where the rain falls is a draw, and one
    /// seed that happens to rain only on the open half would pass this without
    /// saying anything about the cave (§A27 — a population claim needs more than
    /// one draw).
    #[test]
    fn rain_reaches_the_open_ground_and_a_cave_floor_is_the_rare_exception() {
        let mut indoors = 0;
        let mut outdoors = 0;
        for seed in [1u64, 7, 42, 99, 4242, 12345] {
            let (w, landings) = rain(seed);
            assert!(
                !landings.is_empty(),
                "seed {seed}: nothing landed at all — nothing here is tested"
            );
            for (x, y) in landings {
                if has_a_roof_over_it(&w.map, x, y) {
                    indoors += 1;
                } else {
                    outdoors += 1;
                }
            }
        }
        // **This asserted `indoors == 0` until §F6, and that assertion was
        // wrong** — not weakened here, replaced, because the thing it claimed is
        // not what the code promises.
        //
        // A drop has `wind_scale` 1.0 and drift is a feature (`toxic.rs`'s own
        // header says so): one that slides in through a cave mouth lands on the
        // cave floor having passed through no rock at all. The zero held only
        // because 20 drops a shower almost never drift that far; §F6's cadence
        // makes it 54 and it fails at 2 of ~324 landings. A gate that turns on
        // how often a rare drift lands is a coin flip, and the rule it was
        // reaching for lives one layer down anyway: **whoever is under that roof
        // is not poisoned**, which `a_sheltered_player_takes_nothing_from_a_
        // whole_shower` asserts against the real scheduler.
        //
        // What stays true and is worth pinning is the presence: rain reaches the
        // open ground on every one of these seeds, and overwhelmingly so.
        assert!(
            outdoors > 0,
            "nothing landed in the open — the rain is not reaching the ground"
        );
        assert!(
            outdoors > indoors * 10,
            "{indoors} of {} landings were on a cave floor; drift is rare and this \
             is not drift — rain is getting inside",
            indoors + outdoors
        );
    }

    /// The falsification for the test above, as a test.
    ///
    /// The **old** rule was "put the hazard on the surface point". This asserts
    /// that doing so on this map really would land it indoors — otherwise the
    /// fixture has no cave in it and the test above is green for free.
    #[test]
    fn the_old_surface_point_rule_would_have_landed_rain_indoors() {
        let map = map_with_a_cave();
        let indoors = map
            .meta
            .surface_points
            .iter()
            .filter(|p| has_a_roof_over_it(&map, p.x as f32, p.y as f32))
            .count();
        assert!(
            indoors > 0,
            "the fixture has no roofed surface point, so the cave test cannot fail"
        );
    }

    /// Drop count is unchanged by making them fall.
    #[test]
    fn the_number_of_drops_still_matches_duration_over_cadence() {
        let mut w = World::new(4242, MapScale::Small);
        w.map = map_with_a_cave();
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        let forced = w.force_effect(EffectKind::ToxicRain, w.round_time);

        // Counted for **one** active window only. The world keeps scheduling
        // weather, so a fixed 20 s run picks up the next toxic rain the
        // scheduler starts on its own and reports 28 — which looks like a broken
        // cadence and is actually two correct ones.
        let mut released = 0;
        let mut ended = false;
        let ticks = ((TOXIC_DURATION + 12.0) / crate::constants::SIM_DT) as u32;
        for _ in 0..ticks {
            w.step(crate::constants::SIM_DT);
            for e in w.drain_events() {
                match e {
                    GameEvent::ProjectileSpawn { weapon, .. }
                        if crate::effects::toxic::owns(weapon) && !ended =>
                    {
                        released += 1;
                    }
                    // By id, not by kind: `EffectEnd` carries only the id, and
                    // the one that matters is the effect this test started.
                    GameEvent::EffectEnd { id, .. } if id == forced => ended = true,
                    _ => {}
                }
            }
            if ended {
                break;
            }
        }
        assert!(
            ended,
            "the forced rain never finished, so the count is partial"
        );
        assert_eq!(
            released,
            crate::effects::toxic::drops_per_window(),
            "{released} drops"
        );
    }

    /// §E13 gives the rain a **bullet-sized** bite, and the risk is that it
    /// quietly becomes a second meteor shower.
    ///
    /// Pinned at both ends, to constants rather than to numbers: every carve the
    /// rain emits is `TOXIC_DROP_CARVE_R`, and that radius is far under
    /// `METEOR_CARVE_R`. A test asserting only "it carves something" passes for a
    /// drop that digs a 50 px crater, which is the one outcome `docs/13` §3
    /// forbids.
    ///
    /// The **control is that it carves at all**: this exact test used to assert a
    /// byte-identical mask, and inverting an assertion without checking that the
    /// new direction actually happens is how "no puddles form" would have been
    /// satisfied by rain that never fell.
    #[test]
    fn every_drop_takes_a_bullet_sized_bite_and_never_a_crater() {
        let mut w = World::new(4242, MapScale::Small);
        w.map = map_with_a_cave();
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        let before = w.map.mask.count_solid();
        w.force_effect(EffectKind::ToxicRain, w.round_time);

        let mut radii: Vec<i32> = Vec::new();
        let ticks = ((TOXIC_DURATION + 12.0) / crate::constants::SIM_DT) as u32;
        for _ in 0..ticks {
            w.step(crate::constants::SIM_DT);
            for e in w.drain_events() {
                if let GameEvent::Carve { r, .. } = e {
                    radii.push(r);
                }
            }
        }
        assert!(
            !radii.is_empty(),
            "the rain carved nothing at all, so 'never a crater' is free"
        );
        assert!(
            w.map.mask.count_solid() < before,
            "{} carve event(s) and the mask is unchanged — the events are announcing \
             work that did not happen",
            radii.len()
        );
        let want = crate::constants::TOXIC_DROP_CARVE_R.round() as i32;
        assert!(
            radii.iter().all(|&r| r == want),
            "a drop carved at radii {radii:?}, not all {want}"
        );
        assert!(
            (want as f32) < crate::constants::METEOR_CARVE_R,
            "a drop's bite ({want}) is not smaller than a meteor's crater ({})",
            crate::constants::METEOR_CARVE_R
        );
    }

    /// A map whose **only** surface point is one column of open ground.
    ///
    /// `pick_column` draws from `surface_points`, so a map with one of them rains
    /// on one column every time. That turns "does a drop ever hit a player" from
    /// a coin flip — 54 drops across thousands of pixels, and 20 before §F6 —
    /// into a fact, without reaching past the projectile step to arrange it.
    fn map_with_one_rain_column(x: u32) -> Map {
        let mut mask = Mask::new_empty(W, H);
        for y in GROUND..H {
            for px in 0..W {
                mask.set(px as i32, y as i32);
            }
        }
        let coarse = CoarseGrid::build(&mask);
        let mut meta = crate::map::MapMeta {
            seed: 1,
            requested_seed: 1,
            attempts: 1,
            used_safe_preset: false,
            scale: MapScale::Small,
            theme: 0,
            spawn_points: Vec::new(),
            teleport_pads: Vec::new(),
            surface_points: Vec::new(),
            objects: Vec::new(),
            buried_slots: Vec::new(),
            decorations: Vec::new(),
            wind: 0.0,
            traversable_fraction: 1.0,
            largest_component: Vec::new(),
        };
        meta.surface_points.push(crate::math::Point {
            x: x as i32,
            y: GROUND as i32,
        });
        Map::from_parts(mask, coarse, meta)
    }

    /// §E13, end to end: rain that falls on you poisons you, and rain that falls
    /// somewhere else does not.
    ///
    /// Through the real projectile step, not through a seam — the whole claim is
    /// that a **drop** reaches a player, and a test that hands `detonate` a
    /// victim has assumed the part that can be wrong. The control is a second
    /// player standing well clear of the one column it rains on: without them,
    /// "poisoned" would be satisfied by a world that poisons everybody.
    #[test]
    fn a_drop_that_lands_on_a_player_poisons_them_and_a_bystander_is_untouched() {
        let mut w = World::new(4242, MapScale::Small);
        w.map = map_with_one_rain_column(OPEN_X0);
        // The generated map's wind came with the `World`, and replacing the map
        // does not replace it. A drop has `wind_scale` 1.0, so eleven pixels of
        // drift is the difference between landing on a 16 px player and beside
        // them — measured, that is exactly what happened here first.
        w.wind = 0.0;
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w.add_player(1, 1, "bo".into());
        if let Some(p) = w.player_mut(0) {
            p.body.pos = Vec2::new(OPEN_X0 as f32, GROUND as f32 - 16.0);
        }
        if let Some(p) = w.player_mut(1) {
            p.body.pos = Vec2::new(OPEN_X1 as f32, GROUND as f32 - 16.0);
        }
        w.force_effect(EffectKind::ToxicRain, w.round_time);

        let mut rained_on = false;
        let mut bystander = false;
        let ticks = ((TOXIC_DURATION + 12.0) / crate::constants::SIM_DT) as u32;
        for _ in 0..ticks {
            w.step(crate::constants::SIM_DT);
            w.drain_events();
            let now = w.round_time;
            rained_on |= w.player(0).is_some_and(|p| p.poisoned(now));
            bystander |= w.player(1).is_some_and(|p| p.poisoned(now));
        }
        assert!(
            rained_on,
            "eight seconds of rain fell on the column this player is standing in \
             and never poisoned them"
        );
        assert!(
            !bystander,
            "a player {} px from the only column it rained on was poisoned",
            OPEN_X1 - OPEN_X0
        );
    }

    /// The arithmetic, pinned to the constants at both ends.
    ///
    /// One hit, then run past the duration: the total lost is
    /// `TOXIC_POISON_DPS × TOXIC_POISON_DURATION`. A number instead of the
    /// constants would stay green against a drifted implementation, and the
    /// tolerance is one tick of poison because the last tick straddles the
    /// deadline.
    #[test]
    fn one_hit_costs_exactly_dps_times_duration_and_then_stops() {
        use crate::constants::{TOXIC_POISON_DPS, TOXIC_POISON_DURATION};
        let (mut w, before) = poisoned_world();
        run_for(&mut w, TOXIC_POISON_DURATION + 1.0);

        let lost = before - w.player(0).expect("ana").health;
        let want = TOXIC_POISON_DPS * TOXIC_POISON_DURATION;
        assert!(
            (lost - want).abs() <= TOXIC_POISON_DPS * crate::constants::SIM_DT * 2.0,
            "lost {lost}, expected {want}"
        );
        assert!(
            !w.player(0).expect("ana").poisoned(w.round_time),
            "the poison outlived TOXIC_POISON_DURATION"
        );

        // The control: a second full duration costs nothing more. Without it,
        // "exactly one duration" is satisfied by a poison that never expires and
        // happened to be measured at the right moment.
        let settled = w.player(0).expect("ana").health;
        run_for(&mut w, TOXIC_POISON_DURATION + 1.0);
        assert_eq!(
            w.player(0).expect("ana").health,
            settled,
            "the poison was still ticking after it expired"
        );
    }

    /// §E13: a second hit **resets** the timer, it does not stack.
    ///
    /// **The total is the only thing that tells them apart.** Reading
    /// `poisoned_until` would assert the implementation back to itself, and
    /// "still poisoned after the second hit" is true of both rules. Two hits half
    /// a duration apart cost one and a half durations if the timer resets, and
    /// two full ones at double rate if it stacks — so the assertion is an upper
    /// bound at the reset total, with the stacking total named in the message.
    #[test]
    fn a_second_hit_resets_the_timer_rather_than_stacking() {
        use crate::constants::{TOXIC_POISON_DPS, TOXIC_POISON_DURATION};
        let (mut w, before) = poisoned_world();
        run_for(&mut w, TOXIC_POISON_DURATION / 2.0);
        let at = Vec2::new(OPEN_X0 as f32, GROUND as f32 - 16.0);
        w.hit_player_for_test(at, WEAPON_TOXIC_DROP, 0, w.round_time);
        run_for(&mut w, TOXIC_POISON_DURATION * 2.0);

        let lost = before - w.player(0).expect("ana").health;
        let reset = TOXIC_POISON_DPS * TOXIC_POISON_DURATION * 1.5;
        let stacked = TOXIC_POISON_DPS * TOXIC_POISON_DURATION * 2.0;
        assert!(
            (lost - reset).abs() <= TOXIC_POISON_DPS * crate::constants::SIM_DT * 4.0,
            "two hits half a duration apart cost {lost}; a timer that resets costs \
             {reset} and one that stacks costs {stacked}"
        );
    }

    /// **The successor to `a_shielded_player_takes_half_and_iframes_take_none`.**
    ///
    /// That test was deleted with the puddles, and it should not have been: its
    /// claim was never about puddles. It said **weather damage respects the
    /// shield and i-frames**, and §E13 changed what the weather does, not who it
    /// spares. The behaviour survives by construction — poison goes through
    /// `apply_damage_log` into `apply_damage`, which returns early on
    /// `invulnerable(now)` and applies the multiplier centrally — and a rule that
    /// is true with nothing asserting it is one refactor from being false in
    /// silence.
    ///
    /// Three players, one poison, one run: plain, shielded, invulnerable. The
    /// plain one is the control — without it "the shielded player took less" is
    /// satisfied by a poison that does nothing to anybody.
    #[test]
    fn poison_respects_the_shield_and_i_frames() {
        use crate::constants::{SHIELD_DAMAGE_MULT, TOXIC_POISON_DURATION};
        let mut w = World::new(4242, MapScale::Small);
        w.map = map_with_one_rain_column(OPEN_X0);
        w.wind = 0.0;
        w.set_phase(RoundPhase::Playing);
        for id in 0..3u8 {
            w.add_player(id, id as u16, format!("p{id}"));
        }
        let at = Vec2::new(OPEN_X0 as f32, GROUND as f32 - 16.0);
        let before: Vec<f32> = (0..3)
            .map(|id| {
                let now = w.round_time;
                let p = w.player_mut(id).expect("seated");
                p.body.pos = at;
                p.iframes_until = 0.0;
                match id {
                    1 => p.shield_until = Some(now + TOXIC_POISON_DURATION * 4.0),
                    // Longer than the run, so it is i-frames and not their
                    // expiry that decides.
                    2 => p.iframes_until = now + TOXIC_POISON_DURATION * 4.0,
                    _ => {}
                }
                p.health
            })
            .collect();
        // The battery keeps the shield up: §B5 drains it while it is raised, and
        // a shield that ran out mid-run would make the halving look partial.
        if let Some(p) = w.player_mut(1) {
            p.battery = crate::constants::BATTERY_MAX;
        }
        for id in 0..3u8 {
            w.hit_player_for_test(at, WEAPON_TOXIC_DROP, id, w.round_time);
        }
        run_for(&mut w, TOXIC_POISON_DURATION + 1.0);

        let lost: Vec<f32> = (0..3)
            .map(|id| before[id as usize] - w.player(id).expect("seated").health)
            .collect();

        // The control. Everything below is a comparison against this number.
        assert!(
            lost[0] > 0.0,
            "the unprotected player lost nothing to a full duration of poison — \
             the two comparisons below would hold for a poison that does nothing"
        );
        assert!(
            (lost[1] - lost[0] * SHIELD_DAMAGE_MULT).abs() <= lost[0] * 0.05,
            "shielded lost {}, unprotected {} — SHIELD_DAMAGE_MULT is {}",
            lost[1],
            lost[0],
            SHIELD_DAMAGE_MULT
        );
        assert_eq!(
            lost[2], 0.0,
            "an invulnerable player lost {} to poison",
            lost[2]
        );
    }

    /// Set up a player who has just been hit by a drop, and report their health
    /// before the poison starts biting.
    /// §F6 asked for the load to be **measured, not assumed** — so this measures
    /// it, and asserts the number it found.
    ///
    /// 2.6× the drops means 2.6× the live projectiles, and drops ride the same
    /// per-projectile broadcast every other piece of ordnance does. Two things
    /// were checked and are recorded here because the task asked for both:
    ///
    /// - **There is no projectile cap to check.** No `MAX_PROJECTILES` exists in
    ///   `constants.rs` or `weapons/projectile.rs`; the collection grows and
    ///   `PROJECTILE_MAX_LIFETIME` is what bounds it. Its absence is the finding.
    /// - **The cost is an event cost, not a snapshot cost.** Projectiles are not
    ///   in the binary snapshot; `ProjectileMove` is emitted for every live one
    ///   every third tick, so the bill is `peak × SIM_HZ / 3` messages a second.
    ///
    /// The bound below is derived, not chosen: a drop falls from `SKY_MARGIN`
    /// under gravity and one is released every `TOXIC_DROP_EVERY`, so the most
    /// that can be in the air at once is the flight time over the cadence. It is
    /// asserted rather than printed because a print is not a guard.
    #[test]
    fn a_shower_keeps_a_bounded_number_of_drops_in_the_air() {
        use crate::constants::{GRAVITY, SIM_DT, SKY_MARGIN, TOXIC_DROP_EVERY, TOXIC_DROP_SPEED};
        let mut w = World::new(4242, MapScale::Medium);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w.force_effect(EffectKind::ToxicRain, w.round_time);

        let mut peak = 0usize;
        let ticks = ((TOXIC_DURATION + 12.0) / SIM_DT) as u32;
        for _ in 0..ticks {
            w.step(SIM_DT);
            peak = peak.max(w.projectiles.len());
        }

        // Flight time for the longest possible fall: `SKY_MARGIN` to the bottom
        // of the map, from `TOXIC_DROP_SPEED` under full gravity. Solving
        // `d = v·t + g·t²/2` for t.
        let d = w.map.mask.h as f32 - SKY_MARGIN as f32;
        let v = TOXIC_DROP_SPEED;
        let t = ((v * v + 2.0 * GRAVITY * d).sqrt() - v) / GRAVITY;
        let ceiling = (t / TOXIC_DROP_EVERY).ceil() as usize + 1;
        assert!(
            peak <= ceiling,
            "{peak} drops were airborne at once against a {ceiling} the physics \
             allows — something is releasing faster than the cadence"
        );
        // The control: without it the bound above is satisfied by a shower that
        // never released anything.
        assert!(
            peak >= 4,
            "only {peak} drop(s) were ever airborne — this measures nothing"
        );
        println!(
            "toxic rain: peak {peak} drops airborne (physics allows {ceiling}); \
             at SNAPSHOT-rate broadcast that is {} ProjectileMove/s",
            peak * (crate::constants::SIM_HZ as usize) / 3
        );
    }

    /// **The roof is asked of each victim, not of the drop.**
    ///
    /// This is the test the sweep predicted nothing would catch: add a radius and
    /// leave `poison_lands(&self.map, at)` alone, and the rule silently becomes
    /// "was it raining where the drop fell" instead of "is there rock over your
    /// head". Every other test here stays green through that, because no other
    /// one puts two players at **different roof states inside one splash**.
    ///
    /// Two bodies 20 px apart on flat ground with a slab covering only one of
    /// them, and a drop landing between them just clear of the slab's edge. The
    /// landing point is under open sky, so a landing-point roof test poisons
    /// both; a per-victim one poisons only the exposed player.
    #[test]
    fn the_roof_rule_asks_about_the_victim_and_not_about_the_drop() {
        // Flat ground everywhere, and a slab over the left half only.
        const SLAB_X1: u32 = 256;
        let map = {
            let mut mask = Mask::new_empty(W, H);
            for y in GROUND..H {
                for px in 0..W {
                    mask.set(px as i32, y as i32);
                }
            }
            for y in 100..140u32 {
                for px in 0..SLAB_X1 {
                    mask.set(px as i32, y as i32);
                }
            }
            let coarse = CoarseGrid::build(&mask);
            let meta = crate::map::MapMeta {
                seed: 1,
                requested_seed: 1,
                attempts: 1,
                used_safe_preset: false,
                scale: MapScale::Small,
                theme: 0,
                spawn_points: Vec::new(),
                teleport_pads: Vec::new(),
                surface_points: Vec::new(),
                objects: Vec::new(),
                buried_slots: Vec::new(),
                decorations: Vec::new(),
                wind: 0.0,
                traversable_fraction: 1.0,
                largest_component: Vec::new(),
            };
            Map::from_parts(mask, coarse, meta)
        };

        let mut w = World::new(4242, MapScale::Small);
        w.map = map;
        w.set_phase(RoundPhase::Playing);
        let y = GROUND as f32 - 16.0;
        // 0 is under the slab, 1 is a step past its edge.
        w.add_player(0, 0, "sheltered".into());
        w.add_player(1, 0, "exposed".into());
        for (id, x) in [(0u8, SLAB_X1 as f32 - 10.0), (1, SLAB_X1 as f32 + 10.0)] {
            if let Some(p) = w.player_mut(id) {
                p.body.pos = Vec2::new(x, y);
                p.iframes_until = 0.0;
            }
        }
        // Between them, and out from under the slab by a pixel.
        let at = Vec2::new(SLAB_X1 as f32 + 1.0, y);
        assert!(
            crate::effects::toxic::poison_lands(&w.map, at),
            "the fixture's landing point is itself under the slab, so this cannot \
             tell the two rules apart"
        );
        for id in [0u8, 1] {
            let p = w.player(id).expect("seated");
            assert!(
                (p.body.pos - at).len() < crate::constants::TOXIC_SPLASH_R,
                "player {id} is outside the splash, so the roof is not what \
                 decides their outcome"
            );
        }

        w.land_on_terrain_for_test(at, WEAPON_TOXIC_DROP, w.round_time);

        assert!(
            w.player(1).expect("exposed").poisoned(w.round_time),
            "the exposed player was not poisoned — the splash did not reach them \
             and nothing below means anything"
        );
        assert!(
            !w.player(0).expect("sheltered").poisoned(w.round_time),
            "the sheltered player was poisoned through 40 px of rock: the roof is \
             being asked about the drop, not about the victim"
        );
    }

    /// §F6's radius, at both ends and at the live binding site.
    ///
    /// A drop that lands on **terrain** one pixel inside `TOXIC_SPLASH_R` of a
    /// standing player poisons them; one pixel outside it does not. The pair is
    /// the test: either half alone passes for a rule that always answers the same
    /// way, and "outside does not poison" alone is satisfied by rain that
    /// poisons nobody — which is exactly the game §F6 replaced.
    ///
    /// Landed on the ground, not on the player, because that is where §F6 lives:
    /// a 20 px body on a 1536 px map means nearly every drop takes the terrain
    /// branch, and §E13 poisoned nobody from it.
    #[test]
    fn a_drop_poisons_inside_the_splash_and_not_a_pixel_outside_it() {
        use crate::constants::TOXIC_SPLASH_R;
        let poisoned_at = |gap: f32| {
            let mut w = World::new(4242, MapScale::Small);
            w.map = map_with_one_rain_column(OPEN_X0);
            w.set_phase(RoundPhase::Playing);
            w.add_player(0, 0, "ana".into());
            let me = Vec2::new(OPEN_X0 as f32, GROUND as f32 - 16.0);
            if let Some(p) = w.player_mut(0) {
                p.body.pos = me;
                p.iframes_until = 0.0;
            }
            // Straight along x from the body's centre, which is what
            // `splash_poison` measures from.
            let at = Vec2::new(me.x + gap, me.y);
            w.land_on_terrain_for_test(at, WEAPON_TOXIC_DROP, w.round_time);
            w.player(0).expect("ana").poisoned(w.round_time)
        };
        assert!(
            poisoned_at(TOXIC_SPLASH_R - 1.0),
            "a drop landing one pixel inside TOXIC_SPLASH_R ({TOXIC_SPLASH_R}) \
             poisoned nobody"
        );
        assert!(
            !poisoned_at(TOXIC_SPLASH_R + 1.0),
            "a drop landing one pixel outside TOXIC_SPLASH_R ({TOXIC_SPLASH_R}) \
             poisoned somebody anyway"
        );
    }

    fn poisoned_world() -> (World, f32) {
        let mut w = World::new(4242, MapScale::Small);
        w.map = map_with_one_rain_column(OPEN_X0);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        let at = Vec2::new(OPEN_X0 as f32, GROUND as f32 - 16.0);
        if let Some(p) = w.player_mut(0) {
            p.body.pos = at;
            // Past the spawn i-frames, or every tick of poison is refused and the
            // total is zero for a reason that has nothing to do with the rule.
            p.iframes_until = 0.0;
        }
        let before = w.player(0).expect("ana").health;
        w.hit_player_for_test(at, WEAPON_TOXIC_DROP, 0, w.round_time);
        assert!(
            w.player(0).expect("ana").poisoned(w.round_time),
            "the fixture's own hit did not poison anyone"
        );
        (w, before)
    }

    fn run_for(w: &mut World, seconds: f32) {
        let ticks = (seconds / crate::constants::SIM_DT) as u32;
        for _ in 0..ticks {
            w.step(crate::constants::SIM_DT);
            w.drain_events();
        }
    }

    /// A drop is visible on its way down: it is released in open sky and the
    /// world broadcasts where it has got to.
    ///
    /// This is the simulation half of §C2's rendered assertion — the browser
    /// check samples pixels, and this makes sure there is something to sample.
    #[test]
    fn a_falling_drop_is_broadcast_moving_downward() {
        let mut w = World::new(4242, MapScale::Small);
        w.map = map_with_a_cave();
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w.force_effect(EffectKind::ToxicRain, w.round_time);

        let mut first: Option<(u32, f32)> = None;
        let mut ys: Vec<f32> = Vec::new();
        let ticks = ((TOXIC_DURATION + 12.0) / crate::constants::SIM_DT) as u32;
        for _ in 0..ticks {
            w.step(crate::constants::SIM_DT);
            for e in w.drain_events() {
                match e {
                    GameEvent::ProjectileSpawn { id, weapon, y, .. }
                        if crate::effects::toxic::owns(weapon) && first.is_none() =>
                    {
                        assert_eq!(y, SKY_MARGIN as f32, "a drop did not start at the cloud");
                        first = Some((id, y));
                    }
                    GameEvent::ProjectileMove { id, y, .. }
                        if first.is_some_and(|(fid, _)| fid == id) =>
                    {
                        ys.push(y);
                    }
                    _ => {}
                }
            }
            if ys.len() >= 3 {
                break;
            }
        }
        let (_, y0) = first.expect("no drop was ever announced");
        assert!(
            ys.len() >= 3,
            "a drop's position was broadcast {} time(s) during its fall — the client \
             would draw it frozen at the cloud",
            ys.len()
        );
        assert!(
            ys.windows(2).all(|p| p[1] >= p[0]),
            "a drop moved upward: {ys:?}"
        );
        assert!(
            ys[ys.len() - 1] > y0 + 8.0,
            "a drop was announced but had not moved: {y0} -> {:?}",
            ys.last()
        );
    }
}

/// T13.06.5 / §C22 — a meteor you can see and dodge.
#[cfg(test)]
mod meteors_are_visible {
    use super::*;
    use crate::constants::{MapScale, METEOR_FRAGMENTS};
    use crate::effects::meteor::MeteorShower;
    use crate::weapons::explode::EffectKind;

    /// Run a shower on a real medium map, collecting the projectile traffic a
    /// client would receive.
    struct Traffic {
        /// meteor id -> (spawn round_time, spawn y)
        spawned: std::collections::BTreeMap<u32, (f32, f32)>,
        /// meteor id -> positions broadcast during flight
        moves: std::collections::BTreeMap<u32, Vec<(f32, f32)>>,
        /// meteor id -> round_time it despawned
        despawned: std::collections::BTreeMap<u32, f32>,
        /// which of those were fragments
        fragments: std::collections::BTreeSet<u32>,
        /// peak live projectiles the world held
        peak_live: usize,
    }

    fn run_shower(seed: u64, seconds: f32) -> Traffic {
        let mut w = World::new(seed, MapScale::Medium);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        let forced = w.force_effect(EffectKind::MeteorShower, w.round_time);

        let mut t = Traffic {
            spawned: Default::default(),
            moves: Default::default(),
            despawned: Default::default(),
            fragments: Default::default(),
            peak_live: 0,
        };
        let mut ended = false;
        let ticks = (seconds / crate::constants::SIM_DT) as u32;
        for _ in 0..ticks {
            w.step(crate::constants::SIM_DT);
            t.peak_live = t.peak_live.max(w.projectiles.len());
            for e in w.drain_events() {
                match e {
                    GameEvent::ProjectileSpawn { id, weapon, y, .. }
                        if MeteorShower::owns(weapon) =>
                    {
                        t.spawned.insert(id, (w.round_time, y));
                        if MeteorShower::is_fragment(weapon) {
                            t.fragments.insert(id);
                        }
                    }
                    GameEvent::ProjectileMove { id, x, y, .. } => {
                        if t.spawned.contains_key(&id) {
                            t.moves.entry(id).or_default().push((x, y));
                        }
                    }
                    GameEvent::ProjectileDespawn { id, .. } => {
                        if t.spawned.contains_key(&id) {
                            t.despawned.insert(id, w.round_time);
                        }
                    }
                    GameEvent::EffectEnd { id, .. } if id == forced => ended = true,
                    _ => {}
                }
            }
            if ended && w.projectiles.is_empty() {
                break;
            }
        }
        t
    }

    /// The flight is exactly as long as the constants say it should be.
    ///
    /// **This is not the assertion the task asked for, and the difference is a
    /// spec defect, reported not absorbed.** T13.06.5 asks for "time from spawn
    /// to impact is >= 1.5 s on a medium map", from §C22's "at `METEOR_SPEED`
    /// 700 it crosses a 1536 px map in about two seconds". That figure is
    /// `1536 / 700 = 2.19`, which assumes **constant speed** — but `docs/13` §4
    /// says in the same paragraph that meteors "fall under gravity". Under
    /// `GRAVITY` 1400 from an initial 700 px/s, a full 1536 px fall takes
    /// **1.06 s**, and no meteor falls the full height: it stops at the terrain.
    ///
    /// Measured on seed 4242, medium, 20 completed flights:
    /// min 0.38 s, p25 0.45 s, median 0.55 s, max 1.02 s.
    ///
    /// So >= 1.5 s is unreachable without changing `METEOR_SPEED`, `GRAVITY` or
    /// the spawn height, all of which are fixed by `docs/13` §4. Asserting it
    /// would be a permanently red gate; asserting a threshold picked to match
    /// what happens to be true today would be a number nobody chose (§A19).
    ///
    /// What IS worth gating is that a meteor falls the way the constants say —
    /// which catches a wrong spawn height, a wrong speed, gravity not being
    /// applied, or the sub-stepped collision letting one through the ground.
    #[test]
    fn a_meteor_falls_exactly_as_fast_as_gravity_and_its_speed_imply() {
        let t = run_shower(4242, 30.0);
        let mut checked = 0;
        for (id, gone) in &t.despawned {
            if t.fragments.contains(id) {
                continue;
            }
            let Some((born, spawn_y)) = t.spawned.get(id).copied() else {
                continue;
            };
            let Some(ms) = t.moves.get(id) else { continue };
            let Some(&(_, last_y)) = ms.last() else {
                continue;
            };
            // Where it was last seen, which is within one broadcast period of
            // the impact — so the expected time is a lower bound on the real one.
            let fell = last_y - spawn_y;
            if fell <= 0.0 {
                continue;
            }
            let g = crate::constants::GRAVITY;
            let v0 = crate::constants::METEOR_SPEED;
            let expected = (-v0 + (v0 * v0 + 2.0 * g * fell).sqrt()) / g;
            let observed = gone - born;
            assert!(
                observed >= expected - 0.05,
                "meteor {id} fell {fell:.0} px in {observed:.2} s; gravity says that \
                 takes at least {expected:.2} s — it is not falling under gravity"
            );
            // One broadcast period of slack on the other side, plus a tick.
            let slack = 1.0 / crate::constants::SNAPSHOT_HZ as f32 + crate::constants::SIM_DT;
            assert!(
                observed <= expected + slack + 0.05,
                "meteor {id} took {observed:.2} s to fall {fell:.0} px; gravity says \
                 {expected:.2} s — it is being slowed by something"
            );
            checked += 1;
        }
        assert!(
            checked >= 5,
            "only {checked} meteors completed a measurable flight"
        );
    }

    /// It is on screen long enough to react to.
    ///
    /// The property §C22 is actually about, asserted as **visible descent**
    /// rather than as a wall-clock threshold the constants cannot produce: a
    /// meteor's position is broadcast repeatedly while it is inside the map, so
    /// there is a falling star to see and dodge rather than an explosion out of
    /// nowhere. The number of broadcasts is `SNAPSHOT_HZ`-derived, so this says
    /// "for a real fraction of a second", pinned to the constants.
    #[test]
    fn a_meteor_is_broadcast_inside_the_map_for_long_enough_to_react_to() {
        let t = run_shower(4242, 30.0);
        let per_second = crate::constants::SNAPSHOT_HZ as usize;
        let mut worst = usize::MAX;
        let mut checked = 0;
        for (id, ms) in &t.moves {
            if t.fragments.contains(id) {
                continue;
            }
            let inside = ms.iter().filter(|(_, y)| *y > 0.0).count();
            worst = worst.min(inside);
            checked += 1;
        }
        assert!(checked >= 5, "only {checked} meteors to measure");
        // A third of a second of visible descent inside the map, at minimum.
        let floor = per_second / 3;
        assert!(
            worst >= floor,
            "the least visible meteor was broadcast inside the map only {worst} time(s) \
             at {per_second} Hz, i.e. under {:.2} s of visible fall",
            worst as f32 / per_second as f32
        );
    }

    /// Both ends: every meteor the world has alive is one the client was told
    /// about, and it is told **where it is** all the way down.
    ///
    /// This is the assertion that fails against the shipped build. Meteors spawn
    /// at `y = -32`, above the top of the map, and `projectile_spawn` was the
    /// only position ever sent — so the client drew every meteor off-screen for
    /// its whole flight and only the explosion was ever visible, which is §C22
    /// as reported.
    #[test]
    fn every_meteor_is_announced_and_then_tracked_all_the_way_down() {
        let t = run_shower(4242, 30.0);
        assert!(!t.spawned.is_empty(), "no meteors at all");

        let meteors: Vec<u32> = t
            .spawned
            .keys()
            .cloned()
            .filter(|id| !t.fragments.contains(id))
            .collect();
        assert!(meteors.len() >= 5, "only {} meteors", meteors.len());

        for id in &meteors {
            let (_, spawn_y) = t.spawned[id];
            let moves = t.moves.get(id).cloned().unwrap_or_default();
            assert!(
                moves.len() >= 3,
                "meteor {id} was announced at y={spawn_y} and its position was broadcast \
                 {} time(s) — a client can only draw it where it was born, which is above \
                 the top of the map",
                moves.len()
            );
            // It is tracked all the way into the ground, not just for a frame.
            let last_y = moves.last().expect("checked non-empty").1;
            assert!(
                last_y > spawn_y,
                "meteor {id} never moved: {spawn_y} -> {last_y}"
            );
            assert!(
                moves.windows(2).all(|p| p[1].1 >= p[0].1 - 0.5),
                "meteor {id} was reported moving upward"
            );
        }

        // And it is visible INSIDE the map, not only above it. A meteor tracked
        // only while at y<0 is still one nobody can see.
        let seen_in_map = meteors.iter().any(|id| {
            t.moves
                .get(id)
                .map(|ms| ms.iter().any(|(_, y)| *y > 0.0))
                .unwrap_or(false)
        });
        assert!(
            seen_in_map,
            "no meteor was ever broadcast at a position inside the map"
        );
    }

    /// Fragments are announced too.
    ///
    /// `METEOR_FRAGMENTS` (6) per impact were spawned straight into the shared
    /// pool by `on_impact` and never broadcast — only the shower's cadence
    /// spawns were. Six glowing embers per impact that no client has ever been
    /// told exist (§A39).
    #[test]
    fn impact_fragments_are_announced_to_clients() {
        let t = run_shower(4242, 30.0);
        let impacts = t
            .despawned
            .keys()
            .filter(|id| !t.fragments.contains(id))
            .count();
        assert!(impacts > 0, "no meteor ever landed");
        assert!(
            !t.fragments.is_empty(),
            "{impacts} meteor(s) landed and not one fragment was announced"
        );
        // Roughly METEOR_FRAGMENTS per impact. Not exactly: the run is cut off
        // when the shower ends, so the last impacts' fragments may be clipped.
        assert!(
            t.fragments.len() >= METEOR_FRAGMENTS as usize,
            "only {} fragments from {impacts} impacts, expected ~{} each",
            t.fragments.len(),
            METEOR_FRAGMENTS
        );
    }

    /// Fragments do not spawn fragments.
    ///
    /// The recursion guard is the only thing between six fragments and 36, then
    /// 216. The run's peak live count is the effect being asserted, not the flag.
    #[test]
    fn fragments_do_not_recurse() {
        let t = run_shower(4242, 30.0);
        assert!(
            t.peak_live < 200,
            "{} projectiles alive at once — fragments are spawning fragments",
            t.peak_live
        );
    }
}

#[cfg(test)]
mod death_tells_you_your_inventory_is_gone {
    use super::*;
    use crate::constants::{MapScale, SIM_DT};
    use crate::items::registry::BAZOOKA;

    /// **A found defect, not a new feature.**
    ///
    /// `die` empties the inventory — every stack is scattered on the ground a few
    /// lines later — and pushed no `Inventory` event, so the owner's client kept
    /// rendering the pre-death loadout until some later pickup happened to
    /// correct it. Measured in a browser: a player killed by a molotov was still
    /// listed as holding four rockets five seconds after dying, and the e2e
    /// harness, which looks a weapon's slot index up in that view before pressing
    /// its hotkey, was selecting from a map of an inventory that no longer
    /// existed.
    #[test]
    fn a_death_pushes_an_inventory_event_for_the_victim() {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        crate::world::give(&mut w, 0, BAZOOKA, 4);
        let _ = w.drain_events();

        // Control: the inventory really is populated before the kill, so what is
        // asserted below is a *change* and not an empty box staying empty.
        assert_eq!(
            w.player_mut(0).expect("there").inventory.count_of(BAZOOKA),
            4,
        );

        w.player_mut(0).expect("there").health = 0.0;
        w.step(SIM_DT);
        let evs = w.drain_events();

        let told = evs
            .iter()
            .any(|e| matches!(e, GameEvent::Inventory { player_id, .. } if *player_id == 0));
        let died = evs
            .iter()
            .any(|e| matches!(e, GameEvent::Death { victim, .. } if *victim == 0));
        assert!(died, "the fixture did not produce a death");
        assert!(
            told,
            "the player died and was never told their inventory had gone",
        );
        // And the state the event announces is the empty one.
        assert_eq!(
            w.player_mut(0).expect("there").inventory.count_of(BAZOOKA),
            0,
        );
    }
}

#[cfg(test)]
mod quickthrow {
    use super::*;
    use crate::constants::{MapScale, SIM_DT};
    use crate::items::registry::{
        AIRBURST, BAZOOKA, GRENADE, MOLOTOV, SMOKE, TOXIC_GRENADE, WEAPON_GRENADE, WEAPON_MOLOTOV,
    };

    fn armed(items: &[(crate::items::registry::ItemId, u8)]) -> World {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        for (item, n) in items {
            crate::world::give(&mut w, 0, *item, *n);
        }
        // Settle, so §C20 does not refuse the throw for movement — the point of
        // this test is the choice of weapon, not the fire gate.
        for _ in 0..120 {
            w.step(SIM_DT);
        }
        let _ = w.drain_events();
        w
    }

    fn thrown(evs: &[GameEvent]) -> Vec<crate::items::registry::WeaponId> {
        evs.iter()
            .filter_map(|e| match e {
                GameEvent::ProjectileSpawn { weapon, .. } => Some(*weapon),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn e_throws_a_grenade_along_the_aim_and_spends_that_stack() {
        let mut w = armed(&[(BAZOOKA, 4), (GRENADE, 3)]);
        assert_eq!(w.quick_throw(0, w.round_time), Ok(()));
        let evs = w.drain_events();
        assert_eq!(thrown(&evs), vec![WEAPON_GRENADE], "the wrong thing flew");
        let p = w.player_mut(0).expect("there");
        assert_eq!(
            p.inventory.count_of(GRENADE),
            2,
            "the grenade stack is untouched"
        );
        assert_eq!(p.inventory.count_of(BAZOOKA), 4, "it spent the wrong stack");
    }

    /// §C11's documented order: grenade, molotov, toxic, smoke, airburst — and
    /// the order is the **list's**, not the inventory's.
    #[test]
    fn with_several_kinds_it_picks_the_documented_first_one() {
        // Seeded in reverse, so a "first slot wins" implementation picks the
        // airburst and this fails.
        let mut w = armed(&[(AIRBURST, 2), (SMOKE, 2), (TOXIC_GRENADE, 2), (MOLOTOV, 2)]);
        assert_eq!(w.quick_throw(0, w.round_time), Ok(()));
        assert_eq!(thrown(&w.drain_events()), vec![WEAPON_MOLOTOV]);
        assert_eq!(
            w.player_mut(0).expect("there").inventory.count_of(MOLOTOV),
            1,
        );
    }

    #[test]
    fn with_none_it_is_rejected_and_spawns_nothing() {
        let mut w = armed(&[(BAZOOKA, 4)]);
        assert_eq!(w.quick_throw(0, w.round_time), Err(UseError::NoAmmo));
        // The effect, not the return value: a rejection that threw anyway would
        // satisfy the line above on its own.
        assert!(thrown(&w.drain_events()).is_empty());
        assert_eq!(
            w.player_mut(0).expect("there").inventory.count_of(BAZOOKA),
            4
        );
    }

    #[test]
    fn the_selected_slot_is_unchanged_afterwards() {
        let mut w = armed(&[(BAZOOKA, 4), (GRENADE, 1)]);
        // Select the bazooka, throw the grenade — which empties its stack, the
        // case where `consume` re-selects.
        w.select_slot(0, 0);
        let before = w.player_mut(0).expect("there").inventory.selected();
        assert_eq!(w.quick_throw(0, w.round_time), Ok(()));
        let p = w.player_mut(0).expect("there");
        assert_eq!(
            p.inventory.selected(),
            before,
            "the throw moved the selection"
        );
        assert_eq!(
            p.inventory.count_of(GRENADE),
            0,
            "the grenade was not spent"
        );
    }

    /// It shares the per-player cooldown, so it cannot be used to bypass one.
    #[test]
    fn it_respects_and_shares_the_fire_cooldown() {
        let mut w = armed(&[(GRENADE, 3)]);
        let now = w.round_time;
        assert_eq!(w.quick_throw(0, now), Ok(()));
        // Immediately again: refused, and nothing spent.
        assert_eq!(w.quick_throw(0, now), Err(UseError::OnCooldown));
        assert_eq!(
            w.player_mut(0).expect("there").inventory.count_of(GRENADE),
            2
        );

        // ...and the *other* direction, which is the one that matters: a
        // quick-throw puts `fire` on cooldown too. `fire_ready_at` is per player
        // by design, and a second timer would be a way round the first.
        let ready = w.player_mut(0).expect("there").fire_ready_at;
        assert!(ready > now, "the throw set no cooldown at all");
        assert_eq!(w.fire(0, now), Err(UseError::OnCooldown));
    }
}

/// §C5 end to end: a pad in a real `World`, driven by `step`.
///
/// The unit tests in `world::teleport` prove the state machine. These prove it is
/// **wired** — that `step` calls it, that respawn lands on a pad, and that the
/// event reaches an observer. Twelve mechanisms on this project were built,
/// unit-tested and connected to nothing (`CLAUDE.md`), and a state machine nobody
/// calls looks exactly like one that works.
#[cfg(test)]
mod teleport_wiring {
    use super::*;
    use crate::constants::{
        MapScale, DEATH_POINTS, JETPACK_MAX_FUEL, JETPACK_REFILL, PLAYER_H, SIM_DT,
        TELEPORT_ARM_DISTANCE, TELEPORT_CHARGE, TELEPORT_COOLDOWN,
    };
    use crate::map::meta::TeleportPad;

    fn playing() -> World {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w
    }

    /// Put the player on `pad` with the arming rule already satisfied, exactly as
    /// a player who had walked there would be.
    fn stand_on(w: &mut World, pad: &TeleportPad) {
        let centre = Vec2::new(pad.pos.x as f32, pad.pos.y as f32 - PLAYER_H / 2.0);
        let p = w.player_mut(0).expect("there");
        p.body.pos = centre;
        p.body.vel = Vec2::ZERO;
        p.body.grounded = true;
        p.teleport.spawn_pos = Vec2::new(centre.x - TELEPORT_ARM_DISTANCE * 4.0, centre.y);
        p.teleport.armed = true;
        p.teleport.charging = None;
        p.teleport.ready_at = 0.0;
    }

    fn teleports(evs: &[GameEvent]) -> Vec<(u8, u8)> {
        evs.iter()
            .filter_map(|e| match e {
                GameEvent::Teleport {
                    from_pad, to_pad, ..
                } => Some((*from_pad, *to_pad)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn standing_on_a_pad_in_a_real_round_teleports_and_says_so() {
        let mut w = playing();
        let pad = w.map.meta.teleport_pads[0];
        stand_on(&mut w, &pad);

        let mut evs = Vec::new();
        // Re-plant every tick: gravity and the collision solver would otherwise
        // walk the body off a pad on a slope, and this test is about the wiring,
        // not about the physics of standing still.
        for _ in 0..((TELEPORT_CHARGE * 2.0 / SIM_DT) as i32) {
            if teleports(&evs).is_empty() {
                let p = w.player_mut(0).expect("there");
                p.body.pos = Vec2::new(pad.pos.x as f32, pad.pos.y as f32 - PLAYER_H / 2.0);
                p.body.grounded = true;
            }
            w.step(SIM_DT);
            evs.extend(w.drain_events());
        }

        let t = teleports(&evs);
        assert_eq!(t.len(), 1, "expected exactly one teleport, got {t:?}");
        let (from, to) = t[0];
        assert_eq!(from, pad.id);
        assert_ne!(to, from);

        // And the player is actually there, not merely told about it.
        let dest = w.map.meta.teleport_pads[to as usize];
        let p = w.player(0).expect("there");
        assert!(
            (p.body.pos.x - dest.pos.x as f32).abs() < 1.0,
            "the event said pad {to} at {:?} but the player is at {:?}",
            dest.pos,
            p.body.pos
        );
    }

    /// **The production path**, not `choose_respawn_pad` in isolation.
    ///
    /// `player::respawn`'s own `a_pad_respawn_never_falls_back_on_a_map_carved_to_
    /// pieces` calls the chooser directly. That is not the same claim: it proves
    /// the function returns a pad, not that the thing wired into the round asks
    /// it for one and uses the answer. `resolve_deaths` took `.pos` and discarded
    /// `.pad`, so the §4 fallback would have fired in silence.
    ///
    /// Fifty deaths through `World::step` on a map carved to pieces, asserting
    /// both the landing **and** `respawn_fallbacks`, which is the counter that
    /// makes the silence impossible.
    #[test]
    fn a_real_round_never_respawns_off_a_pad() {
        let mut w = World::new(8123, MapScale::Medium);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());

        // Carve the whole map, exactly as `respawn.rs`'s fixture does.
        let (mw, mh) = (w.map.mask.w as i32, w.map.mask.h as i32);
        let mut y = 0;
        while y < mh {
            let mut x = 0;
            while x < mw {
                w.map.carve_circle(x, y, 90);
                x += 120;
            }
            y += 120;
        }

        let mut now = 0.0f32;
        for i in 0..50 {
            {
                let p = w.player_mut(0).expect("there");
                if p.alive {
                    p.die(DeathCause::Void, now);
                }
            }
            // Step past RESPAWN_DELAY.
            for _ in 0..((crate::constants::RESPAWN_DELAY / SIM_DT) as i32 + 20) {
                w.step(SIM_DT);
                now += SIM_DT;
            }
            // Checked first, and inside the loop: this is the cause, and the
            // position below is the symptom. Asserting it after fifty deaths
            // would report the fiftieth landing rather than the first fallback.
            assert_eq!(
                w.respawn_fallbacks, 0,
                "death {i}: the `docs/21` §4 re-validation fired — §C5 says a death \
                 puts you on a pad, and indestructible pads make that reachable"
            );
            let p = w.player(0).expect("there");
            assert!(p.alive, "death {i}: never respawned by {now}");
            let pads = &w.map.meta.teleport_pads;
            let on = pads.iter().any(|pad| {
                (p.body.pos.x - pad.pos.x as f32).abs() < 40.0
                    && (p.body.pos.y - (pad.pos.y as f32 - PLAYER_H / 2.0)).abs() < 40.0
            });
            assert!(
                on,
                "death {i}: respawned at {:?}, which is no pad. Pads: {:?}",
                p.body.pos,
                pads.iter().map(|q| q.pos).collect::<Vec<_>>()
            );
        }

        // The control for the loop's own assertions: fifty deaths really did
        // happen, so "no fallback fired" is not the truth about an empty loop.
        assert_eq!(w.player(0).expect("there").score, 50 * DEATH_POINTS);
    }

    /// A teleport is not a refuelling station.
    ///
    /// `fire_pads` resets the jetpack alongside the body, and
    /// `JetpackState::default()` sets `fuel: JETPACK_MAX_FUEL` — so the plain reset
    /// handed out a **full tank on every trip**. §C5 says nothing about fuel, and
    /// the pads are already the one ground nobody can dig away.
    ///
    /// Found by `hud-bars`, which performs the recipe by accident: holding `Space`
    /// jumps first (past `TELEPORT_ARM_DISTANCE`), which arms the pad the player
    /// is standing on, and the hold then outlasts `TELEPORT_CHARGE`.
    #[test]
    fn a_teleport_does_not_refill_the_jetpack() {
        let mut w = playing();
        let pad = w.map.meta.teleport_pads[0];
        stand_on(&mut w, &pad);

        // Spend most of the tank first, or the assertion below is satisfied by a
        // player who happened to arrive with the fuel they left with — full.
        let spent = JETPACK_MAX_FUEL * 0.25;
        w.player_mut(0).expect("there").jetpack.fuel = spent;

        let mut evs = Vec::new();
        for _ in 0..((TELEPORT_CHARGE * 2.0 / SIM_DT) as i32) {
            if teleports(&evs).is_empty() {
                let p = w.player_mut(0).expect("there");
                p.body.pos = Vec2::new(pad.pos.x as f32, pad.pos.y as f32 - PLAYER_H / 2.0);
                p.body.grounded = true;
                // Re-plant the fuel too: the refill would otherwise top it up over
                // the two seconds of charging and hide the reset.
                p.jetpack.fuel = spent;
            }
            w.step(SIM_DT);
            evs.extend(w.drain_events());
        }
        assert_eq!(teleports(&evs).len(), 1, "the fixture never teleported");

        let after = w.player(0).expect("there").jetpack.fuel;
        assert!(
            (after - spent).abs() < JETPACK_REFILL * SIM_DT * 4.0,
            "arrived with {after} of {JETPACK_MAX_FUEL} after leaving with {spent} — \
             the teleport refilled the tank"
        );
    }

    /// The absence, with the presence above as its control: the *only* difference
    /// is that this player has not moved since spawning.
    #[test]
    fn a_player_who_has_not_moved_since_spawning_never_teleports() {
        let mut w = playing();
        let pad = w.map.meta.teleport_pads[0];
        let centre = Vec2::new(pad.pos.x as f32, pad.pos.y as f32 - PLAYER_H / 2.0);
        {
            let p = w.player_mut(0).expect("there");
            p.body.pos = centre;
            p.body.grounded = true;
            p.teleport = crate::world::teleport::TeleportState::new(centre, 0.0);
        }

        let mut evs = Vec::new();
        for _ in 0..((TELEPORT_CHARGE * 4.0 / SIM_DT) as i32) {
            let p = w.player_mut(0).expect("there");
            p.body.pos = centre;
            p.body.grounded = true;
            w.step(SIM_DT);
            evs.extend(w.drain_events());
        }
        assert!(
            teleports(&evs).is_empty(),
            "an unarmed player was teleported: {:?}",
            teleports(&evs)
        );
    }

    #[test]
    fn a_death_respawns_the_player_standing_on_a_pad() {
        let mut w = playing();
        let now = w.round_time;
        w.player_mut(0)
            .expect("there")
            .die(DeathCause::Weather, now);

        // Past the respawn delay.
        for _ in 0..((crate::constants::RESPAWN_DELAY / SIM_DT) as i32 + 30) {
            w.step(SIM_DT);
            let _ = w.drain_events();
        }

        let p = w.player(0).expect("there");
        assert!(p.alive, "the player never came back");
        let feet = p.body.pos.y + PLAYER_H / 2.0;
        let on = w.map.meta.teleport_pads.iter().any(|pad| {
            (p.body.pos.x - pad.pos.x as f32).abs() < 1.0 && (feet - pad.pos.y as f32).abs() < 1.0
        });
        assert!(
            on,
            "respawned at {:?} (feet {feet}), which is no pad: {:?}",
            p.body.pos, w.map.meta.teleport_pads
        );
    }

    /// §C5's cooldown, in the world rather than the state machine: a player
    /// re-planted on the destination pad does not bounce straight back.
    #[test]
    fn arriving_does_not_immediately_send_you_back() {
        let mut w = playing();
        let pad = w.map.meta.teleport_pads[0];
        stand_on(&mut w, &pad);

        let mut evs = Vec::new();
        let ticks = ((TELEPORT_CHARGE + TELEPORT_COOLDOWN) * 2.0 / SIM_DT) as i32;
        for _ in 0..ticks {
            // Keep them planted on whichever pad they are nearest, so the only
            // thing that can stop a second teleport is the cooldown.
            let pos = w.player(0).expect("there").body.pos;
            if let Some(under) = w
                .map
                .meta
                .teleport_pads
                .iter()
                .min_by(|a, b| {
                    (pos.x - a.pos.x as f32)
                        .abs()
                        .total_cmp(&(pos.x - b.pos.x as f32).abs())
                })
                .copied()
            {
                let p = w.player_mut(0).expect("there");
                p.body.pos = Vec2::new(under.pos.x as f32, under.pos.y as f32 - PLAYER_H / 2.0);
                p.body.grounded = true;
            }
            w.step(SIM_DT);
            evs.extend(w.drain_events());
        }

        let t = teleports(&evs);
        assert_eq!(
            t.len(),
            1,
            "the cooldown did not hold: {} teleports in {:.1} s — {t:?}",
            t.len(),
            (TELEPORT_CHARGE + TELEPORT_COOLDOWN) * 2.0
        );
    }

    #[test]
    fn the_teleport_state_is_in_the_state_hash() {
        // §A34: a timer that decides the simulation and is not hashed makes a
        // divergent replay verify green.
        let mut a = playing();
        let mut b = playing();
        assert_eq!(a.state_hash(), b.state_hash());
        a.player_mut(0).expect("there").teleport.charging = Some((0, 1.0));
        assert_ne!(
            a.state_hash(),
            b.state_hash(),
            "a charging pad is invisible to the state hash"
        );
        b.player_mut(0).expect("there").teleport.charging = Some((0, 1.0));
        assert_eq!(a.state_hash(), b.state_hash());
        a.player_mut(0).expect("there").teleport.armed = true;
        assert_ne!(
            a.state_hash(),
            b.state_hash(),
            "the arming latch is invisible to the state hash"
        );
    }
}

/// §C15 — below the map is death.
///
/// The name is `void` because that is what the Done-when filters on
/// (`cargo test -p game-core --lib void`).
#[cfg(test)]
mod void {
    use super::*;
    use crate::constants::{MapScale, DEATH_POINTS, PLAYER_H, SIM_DT, WALL_W};

    fn playing() -> World {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w
    }

    /// Put the body's **top edge** `beyond` px past `y = h`. Negative is above it.
    fn put_at_void_edge(w: &mut World, beyond: f32) {
        let h = w.map.mask.h as f32;
        let mid = w.map.mask.w as f32 / 2.0;
        let p = w.player_mut(0).expect("there");
        p.body.pos = Vec2::new(mid, h + PLAYER_H / 2.0 + beyond);
        p.body.vel = Vec2::ZERO;
        // Spawn i-frames are real and would swallow a damage-shaped kill. Clearing
        // them is not what makes this pass — `spawn_invulnerability` below is the
        // test that says so — but leaving them on would make every other case here
        // pass for the wrong reason.
        p.iframes_until = -1000.0;
    }

    fn deaths(evs: &[GameEvent]) -> Vec<DeathCause> {
        evs.iter()
            .filter_map(|e| match e {
                GameEvent::Death { cause, .. } => Some(*cause),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_body_past_the_bottom_dies_once_with_the_right_cause_and_score() {
        let mut w = playing();
        let score_before = w.player(0).expect("there").score;
        put_at_void_edge(&mut w, 1.0);

        w.step(SIM_DT);
        let evs = w.drain_events();
        assert_eq!(
            deaths(&evs),
            vec![DeathCause::Void],
            "one death, attributed to the void"
        );
        let p = w.player(0).expect("there");
        assert!(!p.alive);
        assert_eq!(p.score, score_before + DEATH_POINTS);
        assert_eq!(p.deaths, 1);

        // **Exactly once.** A corpse still lies below the map for the whole
        // respawn delay, and `step_void` runs every tick — without the `alive`
        // guard this would decrement the score sixty times a second.
        for _ in 0..30 {
            w.step(SIM_DT);
        }
        let after = w.drain_events();
        assert!(
            deaths(&after).is_empty(),
            "the void killed the same body again: {:?}",
            deaths(&after)
        );
        let p = w.player(0).expect("there");
        assert_eq!(
            p.score,
            score_before + DEATH_POINTS,
            "score decremented twice"
        );
        assert_eq!(p.deaths, 1, "counted as two deaths");
    }

    /// The control. Without it every assertion above is satisfied by a build that
    /// kills the player wherever they are.
    #[test]
    fn a_body_just_above_the_line_lives() {
        let mut w = playing();
        put_at_void_edge(&mut w, -1.0);
        w.step(SIM_DT);
        assert!(
            w.player(0).expect("there").alive,
            "a body whose top edge is 1 px above y = h was killed"
        );
        assert!(deaths(&w.drain_events()).is_empty());
    }

    /// §C15 says the **top** edge, and the difference is a whole body height.
    #[test]
    fn feet_past_the_line_is_not_enough() {
        let mut w = playing();
        let h = w.map.mask.h as f32;
        {
            let p = w.player_mut(0).expect("there");
            // Feet 2 px below the line, head still well above it.
            p.body.pos = Vec2::new(100.0, h - PLAYER_H / 2.0 + 2.0);
            p.body.vel = Vec2::ZERO;
            p.iframes_until = -1000.0;
        }
        w.step(SIM_DT);
        assert!(
            w.player(0).expect("there").alive,
            "killed while the head was still inside the map"
        );
    }

    /// The reason the void is not routed through `apply_damage_log`: that path
    /// returns early during warmup, and you can carve during warmup.
    #[test]
    fn the_void_kills_during_warmup_too() {
        let mut w = World::new(4242, MapScale::Small);
        w.add_player(0, 0, "ana".into());
        assert_eq!(w.phase, RoundPhase::Warmup, "fixture is not in warmup");
        put_at_void_edge(&mut w, 1.0);
        w.step(SIM_DT);
        assert_eq!(deaths(&w.drain_events()), vec![DeathCause::Void]);
        assert!(!w.player(0).expect("there").alive);
    }

    /// ...and the second reason: spawn invulnerability makes `apply_damage`
    /// return false outright, so a damage-shaped void would leave a fresh spawn
    /// falling forever.
    #[test]
    fn spawn_invulnerability_does_not_save_you_from_the_void() {
        let mut w = playing();
        let h = w.map.mask.h as f32;
        {
            let p = w.player_mut(0).expect("there");
            p.body.pos = Vec2::new(100.0, h + PLAYER_H);
            p.body.vel = Vec2::ZERO;
            p.iframes_until = 10_000.0;
        }
        // The control: they really are invulnerable right now.
        assert!(
            w.player(0).expect("there").invulnerable(w.round_time),
            "fixture is not actually invulnerable, so this proves nothing"
        );
        w.step(SIM_DT);
        assert_eq!(deaths(&w.drain_events()), vec![DeathCause::Void]);
    }

    /// `docs/21` §4: an environmental kill still credits whoever put you there.
    #[test]
    fn being_blasted_into_the_void_credits_the_shooter() {
        let mut w = playing();
        w.add_player(1, 1, "bo".into());
        {
            let now = w.round_time;
            let p = w.player_mut(0).expect("there");
            p.last_damaged_by = Some((1, now));
        }
        put_at_void_edge(&mut w, 1.0);
        w.step(SIM_DT);
        assert_eq!(
            deaths(&w.drain_events()),
            vec![DeathCause::Player(1)],
            "the assist window did not credit the shooter"
        );
    }

    /// ...and falling in under your own power credits nobody.
    #[test]
    fn falling_in_alone_credits_nobody() {
        let mut w = playing();
        w.add_player(1, 1, "bo".into());
        let before = w.player(1).expect("there").score;
        put_at_void_edge(&mut w, 1.0);
        w.step(SIM_DT);
        assert_eq!(deaths(&w.drain_events()), vec![DeathCause::Void]);
        assert_eq!(
            w.player(1).expect("there").score,
            before,
            "someone was credited for a solo fall"
        );
    }

    #[test]
    fn a_projectile_past_the_bottom_despawns_without_detonating() {
        let mut w = playing();
        let h = w.map.mask.h as f32;
        let solid_before = w.map.mask.count_solid();

        let id = w.projectiles.spawn_raw(
            crate::items::registry::WEAPON_BAZOOKA,
            0,
            Vec2::new(300.0, h + 4.0),
            Vec2::new(0.0, 200.0),
            w.round_time,
        );
        assert_eq!(w.projectiles.len(), 1, "fixture did not spawn one");

        w.step(SIM_DT);
        assert_eq!(w.projectiles.len(), 0, "the projectile is still in the air");

        let reasons: Vec<DespawnReason> = w
            .drain_events()
            .iter()
            .filter_map(|e| match e {
                GameEvent::ProjectileDespawn {
                    id: got, reason, ..
                } if *got == id => Some(*reason),
                _ => None,
            })
            .collect();
        assert_eq!(
            reasons,
            vec![DespawnReason::Void],
            "the client was not told, or was told the wrong thing"
        );
        // It must not have gone off on the way out: a bazooka detonating below
        // the map would still carve the rows just above it.
        assert_eq!(
            w.map.mask.count_solid(),
            solid_before,
            "a voided rocket carved the map"
        );
    }

    /// The control, and it is placed **four pixels above the line** rather than
    /// somewhere safely far away: the rule is a comparison against `y = h`, and a
    /// control in the sky margin would pass for an off-by-a-whole-map error.
    ///
    /// Getting air down there needs the floor carved out first — which is the
    /// feature — so this is also the only test here that exercises both halves of
    /// §C15 at once.
    #[test]
    fn a_projectile_just_inside_the_bottom_is_not_voided() {
        let mut w = playing();
        let h = w.map.mask.h as i32;
        let x = 300;
        w.map.carve_circle(x, h - 30, 120);
        // The control's own control: that really is air now.
        assert!(
            !w.map.mask.get(x, h - 4),
            "the fixture failed to open the floor, so this proves nothing"
        );

        w.projectiles.spawn_raw(
            crate::items::registry::WEAPON_BAZOOKA,
            0,
            Vec2::new(x as f32, h as f32 - 4.0),
            Vec2::ZERO,
            w.round_time,
        );
        w.step(SIM_DT);
        assert_eq!(
            w.projectiles.len(),
            1,
            "a rocket 4 px above y = h was treated as out of the world"
        );
    }

    #[test]
    fn a_world_item_past_the_bottom_despawns() {
        let mut w = playing();
        let h = w.map.mask.h as f32;
        let id = w.items.spawn(
            crate::items::registry::MEDKIT,
            1,
            Vec2::new(300.0, h + 100.0),
            Vec2::ZERO,
            crate::items::world::SpawnSource::Periodic,
            w.round_time,
        );
        assert!(w.items.get(id).is_some(), "fixture did not place it");

        w.step(SIM_DT);
        assert!(w.items.get(id).is_none(), "the item is still falling");

        let despawned: Vec<u32> = w
            .drain_events()
            .iter()
            .filter_map(|e| match e {
                GameEvent::ItemDespawn { world_item_id, .. } => Some(*world_item_id),
                _ => None,
            })
            .collect();
        assert!(
            despawned.contains(&id),
            "removed without telling anyone: {despawned:?}"
        );
    }

    /// The control for the item case.
    #[test]
    fn a_world_item_inside_the_map_is_not_voided() {
        let mut w = playing();
        let h = w.map.mask.h as f32;
        let id = w.items.spawn(
            crate::items::registry::MEDKIT,
            1,
            Vec2::new(300.0, h - 400.0),
            Vec2::ZERO,
            crate::items::world::SpawnSource::Periodic,
            w.round_time,
        );
        w.step(SIM_DT);
        assert!(w.items.get(id).is_some(), "an item inside the map vanished");
    }

    /// The T15.01 guarantee, under the condition §C15 creates: a map with its
    /// floor blown out still has six standable pads to respawn on.
    #[test]
    fn a_map_dug_through_to_the_void_still_has_six_standable_pads() {
        use crate::map::gen::surface::is_standable;
        for scale in MapScale::ALL {
            let mut map = crate::map::generate(31337, scale);
            let (w, h) = (map.mask.w as i32, map.mask.h as i32);

            // Blow the entire floor out, in overlapping bites.
            let mut x = 0;
            while x <= w {
                map.carve_circle(x, h - 8, 90);
                x += 80;
            }

            let bottom_solid: u32 = ((h - 4)..h).map(|y| map.mask.count_run(y, 0, w - 1)).sum();
            // The control: the carve really did remove the floor, so what follows
            // is a claim about the pads and not about a map that never changed.
            // Only the wall columns should be left.
            assert!(
                bottom_solid <= 4 * 2 * WALL_W,
                "{scale:?}: the floor did not come out — {bottom_solid} px left"
            );

            let standing = map
                .meta
                .teleport_pads
                .iter()
                .filter(|p| is_standable(&map.mask, p.pos.x, p.pos.y))
                .count();
            assert_eq!(
                standing,
                crate::constants::TELEPORT_PADS,
                "{scale:?}: only {standing} pads survived the floor coming out"
            );
        }
    }
}

/// §C16 — birds in a **real round**, driven through `World::step`.
///
/// The unit tests in `world::birds` pin the flight and the cadence. These pin the
/// wiring: that `step` actually runs the spawner, that a weapon fired the way the
/// game fires it reaches a bird, and that the drop is an ordinary item on the
/// ground. A spawner nobody calls and a drop nobody can pick up both pass every
/// test in that other module (§A15).
#[cfg(test)]
mod birds_in_a_round {
    use super::*;
    use crate::constants::{
        BIRD_INTERVAL, BIRD_MAX, BIRD_METAL_HEALTH, MAX_BATTERIES, MAX_HEALS, SIM_DT,
    };
    use crate::items::registry::{BATTERY_PACK, MEDKIT};

    fn world() -> World {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w
    }

    fn run(w: &mut World, seconds: f32) {
        for _ in 0..(seconds / SIM_DT) as u32 {
            w.step(SIM_DT);
        }
    }

    /// Put one bird of a known kind in the sky, at a known place.
    ///
    /// The natural spawn is off the edge of the map and takes half a minute to
    /// arrive; these tests are about what happens when you hit one.
    fn plant(w: &mut World, kind: BirdKind, at: Vec2) -> BirdId {
        run(w, SIM_DT * 2.0); // let the spawner produce its first bird
        let id = w.birds.iter().next().expect("a bird").id;
        w.birds.place_for_test(id, kind, at);
        id
    }

    #[test]
    fn birds_appear_in_the_world_during_an_ordinary_round() {
        // §B25/§A15: asserted from the world, not from the event buffer. A
        // count of events misses everything created before anyone was watching.
        let mut w = world();
        run(&mut w, 1.0);
        assert!(
            !w.birds.is_empty(),
            "a second into a live round and the sky is empty"
        );
    }

    #[test]
    fn over_a_long_round_the_count_never_exceeds_bird_max() {
        let mut w = world();
        let mut peak = 0;
        for _ in 0..((BIRD_INTERVAL * 10.0) / SIM_DT) as u32 {
            w.step(SIM_DT);
            peak = peak.max(w.birds.len());
        }
        assert!(peak <= BIRD_MAX, "{peak} birds alive, cap {BIRD_MAX}");
        // ...and several were alive at once, or the bound above is vacuous — a
        // spawner that produced one bird and stopped would satisfy it.
        //
        // Not `== BIRD_MAX`: measured, a small map peaks at 3. A crossing is
        // `map_w / BIRD_SPEED` (~30 s here) against an 18 s cadence, so the cap
        // is only pressed on a wider map. `world::birds` pins the cap itself on a
        // medium one; this asserts the cap is not the thing limiting a small map.
        assert!(peak >= 2, "only ever {peak} bird(s) alive at once");
    }

    #[test]
    fn a_bird_announces_itself_and_its_departure() {
        // Both ends (§A39): the world has birds, and the client was told.
        let mut w = world();
        run(&mut w, 1.0);
        let spawned: Vec<BirdId> = w
            .events
            .iter()
            .filter_map(|e| match e {
                GameEvent::BirdSpawn { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(
            spawned.len(),
            w.birds.len(),
            "the world holds {} birds and announced {}",
            w.birds.len(),
            spawned.len()
        );
        assert!(
            w.events
                .iter()
                .any(|e| matches!(e, GameEvent::BirdMove { .. })),
            "no bird was ever told to move — a bird drawn at its spawn point"
        );
    }

    /// Shoot the planted bird and return **its own** drop.
    ///
    /// The drop is identified from the events, not by scanning the ground for a
    /// heal: `step_item_spawns` puts medkits and batteries out on a timer too, so
    /// "count the heals in the world" measures the periodic spawner as much as
    /// the bird. That is what the first version of these tests did, and it failed
    /// with "a normal bird dropped a battery" — which it had not.
    fn shoot_and_take_the_drop(w: &mut World, at: Vec2) -> (ItemId, WorldItemId) {
        let before = w.events.len();
        w.explode_for_test(
            at,
            crate::weapons::defs::by_key("bazooka").expect("bazooka").id,
            0,
            w.round_time,
        );
        let killed_tick = w.events[before..]
            .iter()
            .find_map(|e| match e {
                GameEvent::BirdDespawn {
                    tick, killed: true, ..
                } => Some(*tick),
                _ => None,
            })
            .expect("no bird was reported killed");
        w.events[before..]
            .iter()
            .find_map(|e| match e {
                GameEvent::ItemSpawn {
                    tick,
                    world_item_id,
                    item_id,
                    ..
                } if *tick == killed_tick => Some((*item_id, *world_item_id)),
                _ => None,
            })
            .expect("the bird died and dropped nothing")
    }

    #[test]
    fn shooting_a_normal_bird_drops_exactly_one_heal_and_it_lands() {
        let mut w = world();
        let x = w.map.mask.w as f32 / 2.0;
        let id = plant(&mut w, BirdKind::Normal, Vec2::new(x, 200.0));

        let (item, drop_id) = shoot_and_take_the_drop(&mut w, Vec2::new(x, 200.0));
        assert!(w.birds.get(id).is_none(), "the bird survived a direct hit");
        assert_eq!(
            item, MEDKIT,
            "a normal bird dropped item {item}, not a heal"
        );

        // Exactly one: a kill must not emit two drops.
        let mine = w
            .events
            .iter()
            .filter(|e| matches!(e, GameEvent::ItemSpawn { world_item_id, .. } if *world_item_id == drop_id))
            .count();
        assert_eq!(mine, 1, "the drop was announced {mine} times");

        run(&mut w, 6.0);
        let drop = w
            .items
            .iter()
            .find(|i| i.id == drop_id)
            .expect("the drop vanished");
        assert!(drop.grounded, "the drop never landed");
    }

    #[test]
    fn shooting_a_metal_bird_drops_exactly_one_battery() {
        let mut w = world();
        let x = w.map.mask.w as f32 / 2.0;
        let id = plant(&mut w, BirdKind::Metal, Vec2::new(x, 200.0));

        let (item, drop_id) = shoot_and_take_the_drop(&mut w, Vec2::new(x, 200.0));
        assert!(
            w.birds.get(id).is_none(),
            "the metal bird survived a rocket"
        );
        assert_eq!(
            item, BATTERY_PACK,
            "a metal bird dropped item {item}, not a battery"
        );
        run(&mut w, 6.0);
        assert!(
            w.items.iter().any(|i| i.id == drop_id && i.grounded),
            "the battery never landed"
        );
    }

    #[test]
    fn a_metal_bird_survives_the_blast_that_kills_a_normal_one() {
        // The same weapon, at the same distance, twice — so the only difference
        // is the bird. A grenade at the edge of its blast.
        let grenade = crate::weapons::defs::by_key("grenade").expect("grenade");
        let offset = grenade.blast_radius * 0.75;
        assert!(
            grenade.damage * 0.25 < BIRD_METAL_HEALTH,
            "the fixture's chosen falloff must not one-shot a metal bird"
        );

        let mut outcome = Vec::new();
        for kind in [BirdKind::Normal, BirdKind::Metal] {
            let mut w = world();
            let x = w.map.mask.w as f32 / 2.0;
            let id = plant(&mut w, kind, Vec2::new(x, 200.0));
            w.explode_for_test(Vec2::new(x + offset, 200.0), grenade.id, 0, w.round_time);
            outcome.push(w.birds.get(id).is_some());
        }
        assert_eq!(
            outcome,
            vec![false, true],
            "normal survived={} metal survived={} — expected the normal one to die",
            outcome[0],
            outcome[1]
        );
    }

    #[test]
    fn a_drop_is_refused_at_max_and_stays_on_the_ground() {
        // §C9, through the bird's drop rather than a hand-placed item: the whole
        // point of routing the reward through `WorldItem` is that it obeys the
        // rules every other item obeys.
        //
        // **Both counters, not one.** The first version covered the heal and
        // ended on `let _ = MAX_BATTERIES;` to quiet the unused import — which is
        // the tell that half the case was written and half was left. They share
        // `counter_for`/`bump`, so the risk is low and the cost of covering it is
        // a loop.
        for (kind, item, cap) in [
            (BirdKind::Normal, MEDKIT, MAX_HEALS),
            (BirdKind::Metal, BATTERY_PACK, MAX_BATTERIES),
        ] {
            let mut w = world();
            w.add_player(0, 0, "ana".into());
            let x = w.map.mask.w as f32 / 2.0;
            plant(&mut w, kind, Vec2::new(x, 200.0));
            let (dropped, drop_id) = shoot_and_take_the_drop(&mut w, Vec2::new(x, 200.0));
            assert_eq!(dropped, item, "{kind:?} dropped the wrong item");
            run(&mut w, 6.0);
            let drop = w
                .items
                .iter()
                .find(|i| i.id == drop_id)
                .unwrap_or_else(|| panic!("{kind:?}: the drop vanished"));
            let (dx, dy) = (drop.pos.x, drop.pos.y);

            // **Clear every other item first.** Both assertions below read a
            // counter, and a counter says only that *an* item was taken — the
            // world has periodic spawns in it, and whether one of them lands
            // within `PICKUP_RADIUS` of this drop depends on the map. Measured:
            // the medkit case reached `cap` from a spawned medkit while the
            // bird's own drop was still lying somewhere else. With everything
            // else gone, the counter can only have come from `drop_id`.
            let others: Vec<_> = w
                .items
                .iter()
                .map(|i| i.id)
                .filter(|&i| i != drop_id)
                .collect();
            for id in others {
                w.items.remove(id);
            }

            /// Read the counter this item routes to.
            fn counter(p: &PlayerState, item: ItemId) -> u8 {
                if item == MEDKIT {
                    p.heals
                } else {
                    p.batteries
                }
            }

            // Full up, and standing on it.
            if item == MEDKIT {
                w.players[0].heals = cap;
            } else {
                w.players[0].batteries = cap;
            }
            w.players[0].body.pos = Vec2::new(dx, dy);
            run(&mut w, 0.5);

            assert_eq!(
                counter(&w.players[0], item),
                cap,
                "{kind:?}: the counter went past its cap"
            );
            assert!(
                w.items.iter().any(|i| i.id == drop_id),
                "{kind:?}: the drop was consumed by a player who could not use it"
            );

            // The control: with room, the same player standing in the same place
            // does take it — so the assertion above is about the cap, not about a
            // pickup path that never fires.
            if item == MEDKIT {
                w.players[0].heals = cap - 1;
            } else {
                w.players[0].batteries = cap - 1;
            }
            w.players[0].body.pos = Vec2::new(dx, dy);
            run(&mut w, 0.5);
            assert_eq!(
                counter(&w.players[0], item),
                cap,
                "{kind:?}: it was not taken"
            );
            assert!(
                !w.items.iter().any(|i| i.id == drop_id),
                "{kind:?}: the drop was still refused when there was room for it"
            );
        }
    }

    #[test]
    fn a_bullet_kills_a_bird() {
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        let me = w.players[0].body.pos;
        // Level with the player and well inside SMG_RANGE, so the geometry is
        // trivial and only the hit test matters — but fired **toward the map**,
        // not blindly right.
        //
        // It was always `me.x + 200`. Pass 6b moved spawn 0 to x=1968 on a
        // 2048-wide map, which put the bird outside the world and made this read
        // as "the ray does not test birds". A fixture pinned to where the
        // generator happens to put a spawn.
        let reach = 200.0;
        let room_right = me.x + reach < w.map.mask.w as f32 - crate::constants::WALL_W as f32;
        let (at, aim) = if room_right {
            (Vec2::new(me.x + reach, me.y), 0.0)
        } else {
            (Vec2::new(me.x - reach, me.y), std::f32::consts::PI)
        };
        // Clear the lane: since 6b there is scenery on the map, and a rock
        // between the muzzle and the bird stops the round — correct behaviour,
        // and not what this test is about.
        w.map
            .carve_capsule(me.x as i32, me.y as i32, at.x as i32, at.y as i32, 12);
        let id = plant(&mut w, BirdKind::Normal, at);
        assert!(w.birds.get(id).is_some());

        // Through `fire`, not through a hit-test helper: §F1 turned the round
        // into a projectile, so the only thing that proves a bird still stops one
        // is the path the game runs — spawn, fly, collide, resolve. The old
        // version called `fire_hitscan` directly and would now pass or fail for
        // reasons that have nothing to do with a real shot.
        crate::world::give(&mut w, 0, crate::items::registry::SMG, 10);
        // §F5: slot 0 is the shovel now, and `fire` uses the selected slot.
        crate::world::wield(&mut w, 0, crate::items::registry::SMG);
        w.players[0].aim = crate::math::quantize_angle(aim);
        w.fire(0, w.round_time).expect("the shot was refused");
        // Fly it. The bird is 200 px away and an SMG round covers 800 px/s, so a
        // quarter second is the whole flight with room to spare.
        for _ in 0..30 {
            let t = w.round_time;
            w.step_projectiles(t, crate::constants::SIM_DT);
            if w.birds.get(id).is_none() {
                break;
            }
        }
        assert!(
            w.birds.get(id).is_none(),
            "the bird survived an SMG round — a bullet is not testing birds"
        );
    }
    #[test]
    fn six_hundred_ticks_are_deterministic() {
        let hash = |seed: u64| {
            let mut w = World::new(seed, MapScale::Small);
            w.set_phase(RoundPhase::Playing);
            for _ in 0..600 {
                w.step(SIM_DT);
            }
            (w.state_hash(), w.birds.len())
        };
        let (a, na) = hash(31337);
        let (b, _) = hash(31337);
        assert_eq!(a, b, "600 ticks diverged on the same seed");
        assert!(na > 0, "no birds existed, so the hash proves nothing here");
        // The control: a different seed must not produce the same state.
        let (c, _) = hash(999);
        assert_ne!(a, c, "two seeds produced identical state");
    }

    #[test]
    fn a_bird_is_in_the_state_hash() {
        // §A34, falsifiable: move a bird and the hash must move with it.
        let mut w = world();
        run(&mut w, 1.0);
        assert!(!w.birds.is_empty());
        let before = w.state_hash();
        let id = w.birds.iter().next().expect("a bird").id;
        let at = w.birds.get(id).expect("a bird").pos;
        w.birds
            .place_for_test(id, BirdKind::Normal, at + Vec2::new(17.0, 0.0));
        assert_ne!(before, w.state_hash(), "a bird moved and the hash did not");
    }
}

#[cfg(test)]
mod weather_mode_tests {
    use super::*;
    use crate::constants::{
        MapScale, EFFECT_INTERVAL_MAX, EFFECT_TELEGRAPH, FOG_DURATION, SIM_DT, WARMUP_SECONDS,
    };
    use crate::weapons::explode::EffectKind;

    struct Run {
        started: Vec<(u32, EffectKind)>,
        /// The **thickest** fog seen at any point in the window.
        ///
        /// Sampled every tick rather than read at the end, because the end of a
        /// window is an arbitrary moment: a fog that has just been restarted is
        /// three seconds of telegraph and two of `FOG_RAMP` away from being
        /// thick, and the final tick has a one-in-four chance of landing there.
        /// A single reading would be a coin flip dressed as an assertion.
        min_fog_mult: f32,
    }

    /// Run a round past the warmup for `secs`, recording what the weather did.
    fn run(mode: WeatherMode, secs: f32) -> Run {
        let mut w = World::new(4242, MapScale::Small);
        w.weather_mode = mode;
        let mut r = Run {
            started: Vec::new(),
            min_fog_mult: 1.0,
        };
        let n = ((WARMUP_SECONDS + secs) / SIM_DT).ceil() as i32;
        for _ in 0..n {
            w.step(SIM_DT);
            r.min_fog_mult = r.min_fog_mult.min(w.fog_multiplier());
            for e in w.drain_events() {
                if let GameEvent::EffectStart { id, kind, .. } = e {
                    r.started.push((id, kind));
                }
            }
        }
        r
    }

    /// The window is longer than `EFFECT_INTERVAL_MAX`, so `Auto` is guaranteed
    /// to have had the chance the other two are being denied.
    const WINDOW: f32 = EFFECT_INTERVAL_MAX + EFFECT_TELEGRAPH + 5.0;

    #[test]
    fn off_never_starts_an_effect_and_auto_does() {
        let none = run(WeatherMode::Off, WINDOW).started;
        assert!(
            none.is_empty(),
            "WEATHER=off started {} effect(s): {none:?}",
            none.len()
        );
        // The control, and it is the whole test: an assertion that nothing
        // happened is satisfied by a scheduler that never works. Same seed, same
        // window, only the mode differs.
        let some = run(WeatherMode::Auto, WINDOW).started;
        assert!(
            !some.is_empty(),
            "the control started nothing either, so the absence above proves nothing"
        );
    }

    #[test]
    fn always_runs_that_kind_immediately_and_only_that_kind() {
        let started = run(WeatherMode::Always(EffectKind::HeavyFog), WINDOW).started;
        assert!(!started.is_empty(), "WEATHER=fog started no effect at all");
        for (_, kind) in &started {
            assert_eq!(*kind, EffectKind::HeavyFog, "a forced fog let {kind:?} in");
        }
        // Immediately, not after `EFFECT_INTERVAL_MIN`: the point of the switch
        // is that a check does not have to wait 30 s for its subject.
        //
        // And restarted: the window is longer than one `FOG_DURATION`, so a
        // switch that forced a single fog and stopped would leave the second
        // half of the window clear — which is exactly the state a check would
        // sample and blame on the renderer.
        assert!(
            started.len() >= 2,
            "the fog was not restarted: {} start(s) over {WINDOW} s of a {FOG_DURATION} s effect",
            started.len()
        );
    }

    #[test]
    fn a_forced_effect_is_announced_and_not_merely_installed() {
        // `EffectScheduler::force` emits no `Started` event by design — the
        // sandbox installs its own effects and needs none. A networked client
        // learns that fog exists from `effect_start` alone, so forcing without
        // the event is a world that is foggy and a screen that is not: the exact
        // divergence §F9 exists to end.
        let r = run(WeatherMode::Always(EffectKind::HeavyFog), WINDOW);
        assert!(!r.started.is_empty(), "no effect_start reached the room");
        // Both ends: the events say fog started, and the world's own
        // `fog_multiplier` — the number §F9's veil shares a `strength()` with —
        // agrees it was foggy. Either alone is a number rather than evidence.
        assert!(
            r.min_fog_mult <= crate::constants::FOV_FOG_MULT + 0.01,
            "the events announced a fog the world never had: thickest fog_multiplier \
             was {} against FOV_FOG_MULT {}",
            r.min_fog_mult,
            crate::constants::FOV_FOG_MULT
        );
        // The control: with no forced fog the same window never gets there.
        let clear = run(WeatherMode::Off, WINDOW);
        assert_eq!(
            clear.min_fog_mult, 1.0,
            "the control was foggy too, so the assertion above is about nothing"
        );
    }
}
