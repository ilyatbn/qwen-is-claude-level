//! The `World`: everything the simulation owns, advanced one tick at a time.
//!
//! This is the object the server's room task owns outright and the replay binary
//! re-runs headlessly. It contains no clock — `dt` is passed in — and no I/O, so
//! the same code produces the same result at 60 Hz on a server, at full speed in a
//! replay, and in the browser through WASM (`docs/01-architecture.md`).
//!
//! See `docs/41-server-loop-rooms.md` §2 for the tick order, which is a contract.

pub mod cycle;
pub mod tombstones;

use tombstones::Tombstones;

use crate::constants::{
    MapScale, ENDED_SECONDS, MAX_INPUT_QUEUE, MAX_PLAYERS, ROUND_SECONDS, WARMUP_SECONDS,
};
use crate::items::inventory::Inventory;
use crate::items::registry::{def, ItemId, ItemKind, WeaponId};
use crate::items::spawning::{assign_buried_items, place_initial, reveal_buried, SpawnSchedule};
use crate::items::world::{SpawnSource, WorldItemId, WorldItems};
use crate::map::gen::surface::is_standable;
use crate::map::{CarveResult, Map};
use crate::math::{Aabb, Vec2};
use crate::player::apply_input;
use crate::player::input::Input;
use crate::player::state::{
    choose_respawn, surface_to_centre, DeathCause, PlayerId, PlayerState, UseError,
};
use crate::rng::{range_f32, substream, ChaCha8Rng};
use crate::weapons::burn::BurnKind;
use crate::weapons::defs::{self, BurnZone, Burst, Delivery};
use crate::weapons::explode::{
    explode, fire_hitscan, BlastSource, DamageSource, EffectKind, PlayerHitTarget,
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
            | GameEvent::ItemSpawn { tick, .. }
            | GameEvent::ItemMove { tick, .. }
            | GameEvent::ItemPickup { tick, .. }
            | GameEvent::ItemDespawn { tick, .. }
            | GameEvent::CrateSpawn { tick, .. }
            | GameEvent::Inventory { tick, .. }
            | GameEvent::Damage { tick, .. }
            | GameEvent::Death { tick, .. }
            | GameEvent::Respawn { tick, .. }
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
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum HazardKind {
    Puddle,
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

/// A player's identity as an explosion sees it: id, centre, and whether alive.
type TargetMeta = (PlayerId, Vec2, bool);

/// Build the deferred-damage closures and the per-player metadata they need.
fn hit_targets(
    players: &[PlayerState],
    log: &DamageLog,
    now: f32,
) -> (Vec<Box<DamageFn>>, Vec<TargetMeta>) {
    let meta: Vec<TargetMeta> = players
        .iter()
        .map(|p| (p.id, p.body.pos, p.alive))
        .collect();
    let closures: Vec<Box<DamageFn>> = players
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
    (closures, meta)
}

type DamageFn = dyn FnMut(f32, DamageSource) -> bool;

/// Zip the deferred closures back onto the players' velocities.
fn targets<'a>(
    players: &'a mut [PlayerState],
    closures: &'a mut [Box<DamageFn>],
    meta: &[TargetMeta],
) -> Vec<PlayerHitTarget<'a>> {
    players
        .iter_mut()
        .zip(closures.iter_mut())
        .zip(meta.iter())
        .map(|((p, c), (id, pos, alive))| PlayerHitTarget {
            id: *id,
            pos: *pos,
            vel: &mut p.body.vel,
            alive: *alive,
            apply_damage: &mut **c,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

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
    pub spawn_schedule: SpawnSchedule,
    pub effects: EffectScheduler,
    pub buried_items: Vec<ItemId>,
    pub round_time: f32,
    pub tick: u32,
    pub phase: RoundPhase,
    pub wind: f32,
    pub seed: u64,

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

        World {
            burn: Default::default(),
            mines: Default::default(),
            smoke: Default::default(),
            hazard_seq: 0,
            map,
            players: Vec::new(),
            items,
            projectiles: Projectiles::new(),
            tombstones: Tombstones::default(),
            spawn_schedule: SpawnSchedule::new(seed, 0.0, initial_draws),
            effects: EffectScheduler::new(seed, 0.0),
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
        let landed = self.items.step(&self.map, dt);
        self.emit_item_motion(&landed);
        self.tombstones.step(&self.map, dt);
        if playing {
            self.step_item_spawns(now);
        }

        // 7. pickups, ascending PlayerId.
        self.resolve_pickups(now);

        // 8. damage over time, overheal decay, shield expiry.
        for p in self.players.iter_mut() {
            p.tick_stats(now, dt);
        }

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
        let boxes: Vec<(PlayerId, Aabb)> = self
            .players
            .iter()
            .filter(|p| p.alive)
            .map(|p| (p.id, p.body.aabb()))
            .collect();
        // `weapon` and `owner` arrive with the outcome: `step` has already removed
        // the projectile, so there is nothing left to look up (see `Impact`).
        let impacts = self.projectiles.step(&self.map, &boxes, self.wind, now, dt);

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
            let at = match im.outcome {
                ProjectileOutcome::Alive => continue,
                ProjectileOutcome::Exploded { at } | ProjectileOutcome::HitPlayer { at, .. } => at,
            };
            let tick = self.tick;
            self.events.push(GameEvent::ProjectileDespawn {
                tick,
                id: im.id,
                reason: DespawnReason::Exploded,
            });
            self.detonate(im.id, im.weapon, im.owner, at, now);
        }
    }

    /// Test seam: set off a blast at a point, as a projectile of `weapon` would.
    ///
    /// A test that reaches past `detonate` is testing a different code path than
    /// the game runs — which is how `destroy_in_blast` sat with no production
    /// caller while its unit test passed.
    #[doc(hidden)]
    pub fn explode_for_test(&mut self, at: Vec2, weapon: WeaponId, owner: PlayerId, now: f32) {
        self.detonate(u32::MAX, weapon, owner, at, now);
    }

    /// Resolve one projectile going off, whatever it was.
    fn detonate(
        &mut self,
        id: ProjectileId,
        weapon: WeaponId,
        owner: PlayerId,
        at: Vec2,
        now: f32,
    ) {
        // `Projectiles::step` has already removed the projectile by the time it
        // reports an outcome, so the weapon and owner are captured alongside the
        // outcome rather than looked up here. Reading them afterwards is exactly
        // how a fragment gets mistaken for a meteor and spawns six more.

        // §C21: a drop of rain lands, it does not go off. Intercepted here —
        // before `defs::def` and before any blast — because toxic rain must
        // leave the mask byte-identical, and the way to guarantee that is for
        // the code that carves never to be reached at all.
        if crate::effects::toxic::owns(weapon) {
            if let Some((eid, mut t)) = self.toxic.take() {
                let p = t.land(at, now);
                self.toxic = Some((eid, t));
                let tick = self.tick;
                self.events.push(GameEvent::HazardSpawn {
                    tick,
                    id: p.id,
                    kind: HazardKind::Puddle,
                    x: p.pos.x,
                    y: p.pos.y,
                    r: p.radius,
                    duration: crate::constants::TOXIC_PUDDLE_LIFE,
                });
            }
            return;
        }

        if MeteorShower::owns(weapon) {
            let is_frag = MeteorShower::is_fragment(weapon);
            let log: DamageLog = Default::default();
            let (mut closures, meta) = hit_targets(&self.players, &log, now);
            let (result, fragments) = {
                let mut t = targets(&mut self.players, &mut closures, &meta);
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
            self.apply_damage_log(&log, now);
            return;
        }

        let Some(w) = defs::def(weapon) else { return };
        let source = if owner == u8::MAX {
            BlastSource::Weather(EffectKind::MeteorShower)
        } else {
            BlastSource::Fired { owner, weapon }
        };

        // The one place that decides what going off means. Matched exhaustively:
        // a new `Burst` is a compile error here rather than a weapon that silently
        // does nothing, which is how melee shipped unable to swing.
        match w.burst {
            Burst::Blast => {
                let log: DamageLog = Default::default();
                let (mut closures, meta) = hit_targets(&self.players, &log, now);
                let result = {
                    let mut t = targets(&mut self.players, &mut closures, &meta);
                    explode(&mut self.map, &mut t, at, w.blast_radius, w.damage, source)
                };
                self.note_knocked(&result.knocked, now);
                self.emit_blast(at, w.blast_radius, CarveKind::Weapon, &result.carve, now);
                self.apply_damage_log(&log, now);
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
        let mut shots = Vec::new();
        {
            let (mut closures, meta) = hit_targets(&self.players, &log, now);
            let mut t = targets(&mut self.players, &mut closures, &meta);
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
        self.apply_damage_log(&log, now);

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
        let bk = match kind {
            BurnZone::Fire => BurnKind::Fire,
            BurnZone::Toxic => BurnKind::Toxic,
        };
        let hazard = match kind {
            BurnZone::Fire => HazardKind::Fire,
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
                source.for_victim(0),
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

    /// Emit the cosmetic explosion, the authoritative carve, and any buried items
    /// the carve exposed — all from one blast, in that order.
    /// Detonate a blast at `at`, for tests that need a player genuinely thrown.
    ///
    /// It goes through `explode` and `note_knocked` exactly as a rocket does, so
    /// a test using it cannot accidentally reproduce the *state* of knockback
    /// without its provenance — which is what made the first §C20 knockback test
    /// vacuous.
    #[cfg(test)]
    pub(crate) fn blast_for_test(&mut self, at: Vec2, now: f32) {
        let log: DamageLog = Default::default();
        let (mut closures, meta) = hit_targets(&self.players, &log, now);
        let result = {
            let mut t = targets(&mut self.players, &mut closures, &meta);
            crate::weapons::explode::explode(
                &mut self.map,
                &mut t,
                at,
                crate::constants::BAZOOKA_BLAST_RADIUS,
                crate::constants::BAZOOKA_DAMAGE,
                crate::weapons::explode::BlastSource::Weather(
                    crate::weapons::explode::EffectKind::MeteorShower,
                ),
            )
        };
        self.note_knocked(&result.knocked, now);
    }

    /// Stamp everyone a blast or a swing **threw** as recently knocked (§C20).
    ///
    /// One function and one caller-visible rule, because four paths throw
    /// players — a rocket, a shotgun's pellets by way of its blast, a mine and a
    /// melee swing — and a gate that four call sites each remember to apply is a
    /// gate three of them will eventually forget (CLAUDE.md: "share the guard,
    /// or share the function").
    fn note_knocked(&mut self, ids: &[PlayerId], now: f32) {
        if ids.is_empty() {
            return;
        }
        let until = now + crate::constants::KNOCKBACK_FIRE_GRACE;
        for p in self.players.iter_mut() {
            if ids.contains(&p.id) {
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

    fn apply_damage_log(&mut self, log: &DamageLog, now: f32) {
        let entries = std::mem::take(&mut *log.borrow_mut());
        // THE warmup damage gate (`docs/41-server-loop-rooms.md` §3). Every source
        // of damage in the game — weapons, explosions, hitscan, toxic, lava —
        // funnels through this one function, so gating here gates all of them.
        // Terrain still carves: warmup is for orienting yourself, and a crater you
        // dug while waiting is harmless.
        if self.phase == RoundPhase::Warmup {
            return;
        }
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

    /// Mines fall, arm, trigger; ground fire burns and goes out.
    fn step_placed(&mut self, now: f32, dt: f32) {
        let tick = self.tick;
        let log: DamageLog = Default::default();
        let ended = {
            let (mut closures, meta) = hit_targets(&self.players, &log, now);
            let mut t = targets(&mut self.players, &mut closures, &meta);
            let ended = self.mines.step(&mut self.map, &mut t, now, dt);
            self.burn.tick(&mut t, now, dt);
            ended
        };
        self.apply_damage_log(&log, now);

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
        for ev in self.effects.tick(now, ends) {
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
            let log: DamageLog = Default::default();
            // §C21: what comes back is **drops**, not puddles. A puddle appears
            // in `detonate`, when a drop has finished falling — which is what
            // makes it impossible for one to form under a roof.
            let released = {
                let (mut closures, meta) = hit_targets(&self.players, &log, now);
                let mut tg = targets(&mut self.players, &mut closures, &meta);
                t.tick(&mut self.projectiles, &self.map, &mut tg, toxic_on, now, dt)
            };
            self.apply_damage_log(&log, now);
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
            let carves = {
                let (mut closures, meta) = hit_targets(&self.players, &log, now);
                let mut tg = targets(&mut self.players, &mut closures, &meta);
                l.tick(&mut self.map, &mut tg, lava_on, now, dt)
            };
            self.apply_damage_log(&log, now);
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
        let mut view: Vec<(PlayerId, Vec2, &mut Inventory)> = self
            .players
            .iter_mut()
            .filter(|p| p.alive)
            .map(|p| (p.id, p.body.pos, &mut p.inventory))
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

    fn resolve_deaths(&mut self, now: f32) {
        let mut drops: Vec<(Vec2, Vec<crate::items::inventory::Stack>)> = Vec::new();
        let mut credits: Vec<PlayerId> = Vec::new();
        let mut scored = false;

        for i in 0..self.players.len() {
            if self.players[i].alive && self.players[i].health <= 0.0 {
                let direct = match self.players[i].last_damaged_by {
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
                    DeathCause::Weather => None,
                };
                drops.push((pos, stacks));
                let tick = self.tick;
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
            let pos = choose_respawn(&self.map, &living, &mut self.rng);
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

    // ------------------------------------------------------------ player acts

    /// The input that governs **this** tick for `id`.
    ///
    /// Fire arrives as a command before `step` runs (`docs/30` §4), so the input
    /// the player sent alongside it is still sitting in `pending`. This picks the
    /// same one `apply_inputs` will: the lowest unconsumed `seq`, falling back to
    /// the last input actually applied when the client sent nothing new — held
    /// state persists, so the last packet is still the truth (`docs/40` §2).
    ///
    /// Shared rather than restated, so the gate below and the movement it gates
    /// can never read different inputs.
    fn input_for_tick(&self, id: PlayerId) -> Input {
        self.pending
            .iter()
            .filter(|(i, _)| *i == id)
            .min_by_key(|(_, inp)| inp.seq)
            .map(|(_, inp)| *inp)
            .or_else(|| {
                self.prev_input
                    .iter()
                    .find(|(i, _)| *i == id)
                    .map(|(_, inp)| *inp)
            })
            .unwrap_or_default()
    }

    /// §C20 — is this player moving under their own power?
    ///
    /// Two terms, and the second one is the reason this is not just a velocity
    /// check:
    ///
    ///  - **a movement key held this tick.** Without it you can fire in the one
    ///    tick between releasing a key and friction taking effect — and it is
    ///    also the only term that catches walking into a wall, where the intent
    ///    is full speed and `vel.x` is zero.
    ///  - **still sliding.** `GROUND_FRICTION` takes about five ticks to bring a
    ///    `WALK_SPEED` walk to rest, so the key check alone leaves four ticks of
    ///    firing while gliding.
    ///
    /// §C20 is explicit that "being knocked around does not stop you firing —
    /// this is about your own movement", and knockback IS velocity, so the two
    /// rules cannot both be read off `vel.x`. The exemption therefore comes from
    /// **provenance**: `knocked_until`, stamped where the impulse is applied.
    ///
    /// The first version used `grounded` instead, reasoning that a blast which
    /// throws you also puts you in the air. That made the whole gate cosmetic:
    /// hold D to `WALK_SPEED`, jump, release D, fire — no key held, not grounded,
    /// shot allowed at 150 px/s. Stepping off a ledge did it without even
    /// jumping, and bots, which are airborne constantly, were exempt most of the
    /// time. `grounded` is a *consequence* of being thrown; it is equally a
    /// consequence of jumping, and it cannot tell the two apart.
    fn moving_under_own_power(&self, now: f32, idx: usize) -> bool {
        let p = &self.players[idx];
        // The key term comes FIRST, and knockback does not excuse it. §C20 says
        // "check the input, not just the velocity", and the exemption it grants
        // is for being *thrown* — which is a velocity, not an intention. Held
        // the other way round, any blast in a firefight bought 0.6 s in which
        // you could hold a direction, run at full speed and shoot; blasts are
        // constant in a fight, so that is a recurring run-and-gun window rather
        // than an edge case.
        if self.input_for_tick(p.id).move_dir() != 0.0 {
            return true;
        }
        // Being thrown is not your own movement — and this is the ONLY thing the
        // velocity term exempts.
        if p.was_knocked(now) {
            return false;
        }
        p.body.vel.x.abs() > crate::constants::FIRE_MOVE_MAX_SPEED
    }

    /// Fire the selected weapon. Validation lives in `PlayerState::try_fire`.
    pub fn fire(&mut self, id: PlayerId, now: f32) -> Result<(), UseError> {
        let Some(idx) = self.players.iter().position(|p| p.id == id) else {
            return Err(UseError::Dead);
        };
        // §C20, before `try_fire`: a refused shot must cost neither ammo nor
        // cooldown, or standing still to shoot becomes a punishment for having
        // tried. Guarded on `alive` so a corpse still reports `Dead`, which is
        // the answer `docs/61` §3 expects.
        if self.players[idx].alive && self.moving_under_own_power(now, idx) {
            return Err(UseError::Moving);
        }
        let weapon = self.players[idx].try_fire(now)?;
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
                let result = {
                    let (mut closures, meta) = hit_targets(&self.players, &log, now);
                    let mut t = targets(&mut self.players, &mut closures, &meta);
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
                self.apply_damage_log(&log, now);
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
            // Cone: one tick of spray. It carves nothing — fire does not dig.
            Delivery::Cone {
                range, arc, dps, ..
            } => {
                let log: DamageLog = Default::default();
                {
                    let (mut closures, meta) = hit_targets(&self.players, &log, now);
                    let mut t = targets(&mut self.players, &mut closures, &meta);
                    crate::weapons::cone::spray(
                        &self.map,
                        &mut t,
                        &mut self.burn,
                        centre,
                        aim,
                        w,
                        range,
                        arc,
                        dps,
                        now,
                        crate::constants::SIM_DT,
                        BlastSource::Fired { owner: id, weapon },
                    );
                }
                self.apply_damage_log(&log, now);
                self.events.push(GameEvent::Cone {
                    tick,
                    owner: id,
                    weapon,
                    x: centre.x,
                    y: centre.y,
                    aim,
                    range,
                    arc,
                });
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
                let shots = {
                    let (mut closures, meta) = hit_targets(&self.players, &log, now);
                    let mut t = targets(&mut self.players, &mut closures, &meta);
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
                self.apply_damage_log(&log, now);

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
            h.update(&p.fire_ready_at.to_le_bytes());
            // §A34, and it is load-bearing: this timer decides whether a
            // projectile spawns (§C20's knockback exemption). Leaving a
            // fire-gating timer out of the hash is the exact shape §A34 was
            // written for — every timer was once unhashed and a deliberately
            // nondeterministic build verified green.
            h.update(&p.knocked_until.to_le_bytes());
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
        let id = drop_crate(&mut w, 300.0);
        for _ in 0..600 {
            w.step(SIM_DT);
            let _ = w.drain_events();
        }
        let resting = w.items.get(id).expect("there").pos;
        assert!(w.items.get(id).expect("there").grounded);

        // Take the floor out from under it (`docs/32` §4).
        w.map
            .carve_circle(resting.x as i32, (resting.y + CRATE_H) as i32, 60);

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
        let before = w.player_mut(0).expect("added").inventory.count_of(MEDKIT);
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
            w.player_mut(0).expect("added").inventory.count_of(MEDKIT),
            before + 1,
            "the crate's contents never reached the inventory"
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

/// T13.06.3 / §C20 — you cannot fire while moving under your own power.
#[cfg(test)]
mod fire_gate {
    use super::*;
    use crate::constants::{MapScale, FIRE_MOVE_MAX_SPEED, GROUND_FRICTION, SIM_DT, WALK_SPEED};
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
        // Settle onto the ground: the gate reads `grounded`, and a player still
        // falling from their spawn is airborne, which is a different case.
        for _ in 0..120 {
            w.queue_input(0, Input::new(0, 0, 0));
            w.step(SIM_DT);
        }
        assert!(
            w.player(0).expect("ana").body.grounded,
            "the fixture never landed, so nothing below is testing the grounded rule"
        );
        w
    }

    fn walk_for(w: &mut World, ticks: u32) {
        for _ in 0..ticks {
            w.queue_input(0, Input::new(0, button::RIGHT, 0));
            w.step(SIM_DT);
        }
    }

    /// The subject: a walking player fires nothing.
    ///
    /// Asserted on the **effect** — the projectile count — not on the returned
    /// error. A gate that returns `Moving` and spawns the rocket anyway would
    /// pass an assertion on the `Result` alone.
    #[test]
    fn firing_while_walking_is_refused_and_spawns_nothing() {
        let mut w = armed_world();
        walk_for(&mut w, 20);
        let speed = w.player(0).expect("ana").body.vel.x.abs();
        assert!(
            speed > FIRE_MOVE_MAX_SPEED,
            "the fixture is not actually walking: vel.x {speed}"
        );

        // The key is still held on the tick the fire arrives, exactly as a
        // client sends it (`docs/30` §4).
        w.queue_input(0, Input::new(1, button::RIGHT, 0));
        let before = w.projectiles.len();
        assert_eq!(w.fire(0, 1.0), Err(UseError::Moving));
        assert_eq!(
            w.projectiles.len(),
            before,
            "a refused shot still spawned a projectile"
        );
        // And it cost nothing: ammo and cooldown are untouched, or standing
        // still to shoot would punish having tried.
        assert_eq!(
            w.player(0).expect("ana").inventory.count_of(BAZOOKA),
            crate::items::registry::max_stack(BAZOOKA) as u32
        );
        assert_eq!(w.player(0).expect("ana").fire_ready_at, 0.0);
    }

    /// The control. Without it, every assertion here is satisfied by a build
    /// that can never fire at all.
    #[test]
    fn firing_while_standing_still_succeeds() {
        let mut w = armed_world();
        w.queue_input(0, Input::new(1, 0, 0));
        let before = w.projectiles.len();
        assert_eq!(w.fire(0, 1.0), Ok(()));
        assert!(
            w.projectiles.len() > before,
            "a standing player fired and no projectile appeared"
        );
    }

    /// The single tick between releasing a key and friction taking effect —
    /// the case §C20 says the velocity term exists for.
    #[test]
    fn firing_one_tick_after_releasing_the_key_is_still_refused() {
        let mut w = armed_world();
        walk_for(&mut w, 20);
        // One tick with nothing held. `GROUND_FRICTION` removes
        // GROUND_FRICTION * SIM_DT px/s per tick, so a WALK_SPEED walk needs
        // several ticks to stop — pinned to the constants rather than to a
        // number read off one run.
        let ticks_to_stop = (WALK_SPEED / (GROUND_FRICTION * SIM_DT)) as u32;
        assert!(
            ticks_to_stop > 1,
            "friction stops a walk within one tick, so this test has no window to guard"
        );
        w.queue_input(0, Input::new(1, 0, 0));
        w.step(SIM_DT);

        let p = w.player(0).expect("ana");
        assert!(
            p.body.vel.x.abs() > FIRE_MOVE_MAX_SPEED,
            "the player had already stopped, so the release window is not being tested"
        );

        w.queue_input(0, Input::new(2, 0, 0));
        let before = w.projectiles.len();
        assert_eq!(w.fire(0, 1.0), Err(UseError::Moving));
        assert_eq!(w.projectiles.len(), before);

        // ...and once friction has actually stopped them, the same player can
        // shoot. The control for the control: otherwise "still refused" would
        // pass for a player permanently locked out after one walk.
        for seq in 3..3 + ticks_to_stop + 2 {
            w.queue_input(0, Input::new(seq, 0, 0));
            w.step(SIM_DT);
        }
        w.queue_input(0, Input::new(99, 0, 0));
        assert_eq!(w.fire(0, 2.0), Ok(()));
    }

    /// Walking into a wall: full intent, no velocity.
    ///
    /// This is the case the velocity term cannot see and the key term exists
    /// for. Driven by holding a direction with the body pinned, so it is the
    /// held key alone that refuses the shot.
    #[test]
    fn holding_a_direction_refuses_even_at_zero_velocity() {
        let mut w = armed_world();
        if let Some(p) = w.player_mut(0) {
            p.body.vel.x = 0.0;
        }
        w.queue_input(0, Input::new(1, button::RIGHT, 0));
        assert_eq!(
            w.player(0).expect("ana").body.vel.x.abs(),
            0.0,
            "the fixture has velocity, so this is not testing the key term"
        );
        let before = w.projectiles.len();
        assert_eq!(w.fire(0, 1.0), Err(UseError::Moving));
        assert_eq!(w.projectiles.len(), before);
    }

    /// Being knocked around does not stop you firing (§C20).
    ///
    /// The player is thrown by a **real blast**, not by hand-setting velocity.
    /// The first version of this test wrote `vel.x = KNOCKBACK_MAX; grounded =
    /// false` directly, and the gate it was validating exempted airborne
    /// players — so the fixture was byte-identical to jump-and-shoot and the
    /// test passed against a build where the gate did nothing for anyone in the
    /// air. What separates the two cases is *provenance*, so the test has to
    /// produce the provenance.
    #[test]
    fn firing_while_knocked_back_succeeds() {
        let mut w = armed_world();
        let at = w.player(0).expect("ana").body.pos;
        // Detonate on top of them, through the same path a rocket takes.
        w.blast_for_test(at, 1.0);

        let p = w.player(0).expect("ana");
        assert!(
            p.was_knocked(1.0),
            "the blast did not mark the player as thrown, so this proves nothing"
        );

        let before = w.projectiles.len();
        assert_eq!(
            w.fire(0, 1.0),
            Ok(()),
            "knockback became a stun: a thrown player could not shoot"
        );
        assert!(w.projectiles.len() > before);
    }

    /// The discriminator: **jumping is not being thrown.**
    ///
    /// This is the test the `grounded`-based gate could not pass, and the reason
    /// that gate was wrong. Walk up to speed, leave the ground, release the key:
    /// no key is held and `grounded` is false, which is exactly the state a
    /// blast leaves you in. Under §C20 the shot must still be refused, or the
    /// gate is cosmetic — every player in this game is airborne constantly, and
    /// rocket-jumping is a documented mechanic.
    #[test]
    fn jumping_is_not_being_thrown_and_still_refuses_the_shot() {
        let mut w = armed_world();
        if let Some(p) = w.player_mut(0) {
            p.body.vel.x = crate::constants::WALK_SPEED;
            p.body.vel.y = -crate::constants::JUMP_VELOCITY;
            p.body.grounded = false;
        }
        let p = w.player(0).expect("ana");
        assert!(
            !p.was_knocked(1.0),
            "nothing threw this player, so the fixture is not a jump"
        );
        assert!(
            p.body.vel.x.abs() > FIRE_MOVE_MAX_SPEED && !p.body.grounded,
            "the fixture is not airborne at speed, so it cannot tell the two apart"
        );

        // No key held: the velocity term is the only thing that can refuse this.
        w.queue_input(0, Input::new(1, 0, 0));
        let before = w.projectiles.len();
        assert_eq!(
            w.fire(0, 1.0),
            Err(UseError::Moving),
            "a jumping player fired at walking speed — the gate is cosmetic"
        );
        assert_eq!(w.projectiles.len(), before);
    }

    /// And the exemption **expires**. A single rocket-jump must not license a
    /// whole traverse of firing on the move.
    #[test]
    fn the_knockback_exemption_expires() {
        let mut w = armed_world();
        let at = w.player(0).expect("ana").body.pos;
        w.blast_for_test(at, 1.0);
        if let Some(p) = w.player_mut(0) {
            p.body.vel.x = crate::constants::WALK_SPEED;
            p.body.grounded = false;
        }
        let after = 1.0 + crate::constants::KNOCKBACK_FIRE_GRACE + 0.01;
        assert!(
            !w.player(0).expect("ana").was_knocked(after),
            "KNOCKBACK_FIRE_GRACE never expires"
        );
        w.queue_input(0, Input::new(1, 0, 0));
        assert_eq!(
            w.fire(0, after),
            Err(UseError::Moving),
            "the exemption outlived KNOCKBACK_FIRE_GRACE"
        );
    }

    /// Bots respect it — and, crucially, still manage to shoot.
    ///
    /// A bot that walks into a refused trigger pull forever is worse than the
    /// behaviour being fixed, so the assertion is two-sided: no fire is issued
    /// while it is moving, and it does eventually fire once planted.
    #[test]
    fn a_bot_stands_still_to_shoot() {
        use crate::bots::Bot;

        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "bot".into());
        w.add_player(1, 0, "prey".into());
        give(
            &mut w,
            0,
            BAZOOKA,
            crate::items::registry::max_stack(BAZOOKA),
        );

        // Put the prey in sight but out of the blast guard.
        let bot_pos = w.player(0).expect("bot").body.pos;
        if let Some(p) = w.player_mut(1) {
            p.body.pos = Vec2::new(bot_pos.x + 200.0, bot_pos.y);
        }

        let mut bot = Bot::new(0, 4242, 0, 1.0);
        let mut fired = 0u32;
        let mut fired_while_moving = 0u32;
        for t in 0..600 {
            let now = t as f32 * SIM_DT;
            let inp = bot.think(&w, now, SIM_DT);
            w.queue_input(0, inp);
            if inp.buttons & button::FIRE != 0 {
                let me = w.player(0).expect("bot");
                // The bot's own view of the gate, checked against the world's.
                if inp.move_dir() != 0.0
                    || (me.body.grounded && me.body.vel.x.abs() > FIRE_MOVE_MAX_SPEED)
                {
                    fired_while_moving += 1;
                }
                if w.fire(0, now).is_ok() {
                    fired += 1;
                }
            }
            w.step(SIM_DT);
        }

        assert_eq!(
            fired_while_moving, 0,
            "the bot pulled the trigger {fired_while_moving} times while moving"
        );
        assert!(
            fired > 0,
            "the bot never fired at all in 10 s — §C20 turned it into a spectator"
        );
    }
}

/// T13.06.4 / §C21 — toxic rain falls, so it cannot land under a roof.
#[cfg(test)]
mod toxic_rain_falls {
    use super::*;
    use crate::constants::{MapScale, SKY_MARGIN, TOXIC_DURATION, TOXIC_PUDDLE_EVERY};
    use crate::map::{CoarseGrid, Mask};
    use crate::weapons::explode::EffectKind;

    // Multiples of CHUNK_SIZE: `Mask::new_empty` requires it.
    const W: u32 = 512;
    const H: u32 = 512;
    /// Ground level, well below `SKY_MARGIN` (96) so drops have room to fall.
    const GROUND: u32 = 400;
    /// The roof over the cave, and the cave floor under it.
    const ROOF: u32 = 250;
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
        // The cave: a roof slab, and a floor for a puddle to sit on under it.
        for x in CAVE_X0..CAVE_X1 {
            for y in ROOF..(ROOF + 12) {
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
            surface_points: Vec::new(),
            buried_slots: Vec::new(),
            decorations: Vec::new(),
            wind: 0.0,
            traversable_fraction: 1.0,
            largest_component: Vec::new(),
        };
        // The surface points the old code placed puddles on directly. Under the
        // cave the "surface" is the CAVE FLOOR — under a roof — which is exactly
        // how a puddle ended up indoors. They are still what chooses the column
        // to rain over, so both halves of the map get rained on.
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

    /// Rain on the cave map for a full active window and collect every puddle.
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

        let mut puddles = Vec::new();
        // The active window, plus time for the last drop to fall the height of
        // the map and land.
        let ticks = ((TOXIC_DURATION + 12.0) / crate::constants::SIM_DT) as u32;
        for _ in 0..ticks {
            w.step(crate::constants::SIM_DT);
            for e in w.drain_events() {
                if let GameEvent::HazardSpawn { kind, x, y, .. } = e {
                    if kind == HazardKind::Puddle {
                        puddles.push((x, y));
                    }
                }
            }
        }
        (w, puddles)
    }

    /// The subject, and its control, on one map.
    ///
    /// Aggregated over several seeds: where the rain falls is a draw, and one
    /// seed that happens to rain only on the open half would pass this without
    /// saying anything about the cave (§A27 — a population claim needs more than
    /// one draw).
    #[test]
    fn no_puddle_forms_under_a_roof_and_puddles_do_form_in_the_open() {
        let mut indoors = 0;
        let mut outdoors = 0;
        for seed in [1u64, 7, 42, 99, 4242, 12345] {
            let (w, puddles) = rain(seed);
            assert!(
                !puddles.is_empty(),
                "seed {seed}: no puddles at all — nothing here is tested"
            );
            for (x, y) in puddles {
                if has_a_roof_over_it(&w.map, x, y) {
                    indoors += 1;
                } else {
                    outdoors += 1;
                }
            }
        }
        // The control first: if nothing landed in the open, "nothing landed
        // indoors" would be satisfied by rain that never lands at all.
        assert!(
            outdoors > 0,
            "no puddle formed in the open, so the absence below proves nothing"
        );
        assert_eq!(
            indoors, 0,
            "{indoors} puddle(s) formed under a roof — rain fell through solid rock"
        );
    }

    /// The falsification for the test above, as a test.
    ///
    /// The **old** rule was "put the puddle on the surface point". This asserts
    /// that doing so on this map really would land puddles indoors — otherwise
    /// the fixture has no cave in it and the test above is green for free.
    #[test]
    fn the_old_surface_point_rule_would_have_landed_puddles_indoors() {
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
            (TOXIC_DURATION / TOXIC_PUDDLE_EVERY) as usize,
            "{released} drops"
        );
    }

    /// It still denies space rather than reshaping the map.
    ///
    /// The property most at risk from this change: a drop is now a projectile,
    /// and every other projectile in the game carves when it lands.
    #[test]
    fn a_full_toxic_rain_leaves_the_mask_byte_identical() {
        let mut w = World::new(4242, MapScale::Small);
        w.map = map_with_a_cave();
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        let before = w.map.mask.count_solid();
        let hash_before = w.map.mask.hash();
        w.force_effect(EffectKind::ToxicRain, w.round_time);

        let ticks = ((TOXIC_DURATION + 12.0) / crate::constants::SIM_DT) as u32;
        for _ in 0..ticks {
            w.step(crate::constants::SIM_DT);
            w.drain_events();
        }
        assert_eq!(w.map.mask.count_solid(), before, "toxic rain dug");
        assert_eq!(w.map.mask.hash(), hash_before, "the mask changed");
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
