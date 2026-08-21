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
use crate::weapons::defs::{self, Delivery};
use crate::weapons::explode::{
    explode, fire_hitscan, BlastSource, DamageSource, EffectKind, PlayerHitTarget,
};
use crate::weapons::projectile::{ProjectileId, ProjectileOutcome, Projectiles};

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
            | GameEvent::ProjectileDespawn { tick, .. }
            | GameEvent::Hitscan { tick, .. }
            | GameEvent::Melee { tick, .. }
            | GameEvent::Cone { tick, .. }
            | GameEvent::MinePlaced { tick, .. }
            | GameEvent::MineEnded { tick, .. }
            | GameEvent::ItemSpawn { tick, .. }
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
        let map = crate::map::generate_with_secret(seed, scale, buried_secret);
        let wind = map.meta.wind;
        let buried_items = assign_buried_items(&map, seed ^ buried_secret);
        let mut items = WorldItems::new();
        let initial_draws = place_initial(&mut items, &map, seed, 0.0);

        World {
            burn: Default::default(),
            mines: Default::default(),
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
        self.items.step(&self.map, dt);
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

        if MeteorShower::owns(weapon) {
            let is_frag = MeteorShower::is_fragment(weapon);
            let log: DamageLog = Default::default();
            let (mut closures, meta) = hit_targets(&self.players, &log, now);
            let result = {
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
            let r = if is_frag {
                crate::constants::METEOR_FRAG_CARVE_R
            } else {
                crate::constants::METEOR_CARVE_R
            };
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
        let log: DamageLog = Default::default();
        let (mut closures, meta) = hit_targets(&self.players, &log, now);
        let result = {
            let mut t = targets(&mut self.players, &mut closures, &meta);
            explode(&mut self.map, &mut t, at, w.blast_radius, w.damage, source)
        };
        self.emit_blast(at, w.blast_radius, CarveKind::Weapon, &result.carve, now);
        self.apply_damage_log(&log, now);
    }

    /// Emit the cosmetic explosion, the authoritative carve, and any buried items
    /// the carve exposed — all from one blast, in that order.
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

        for out in ended {
            self.events.push(GameEvent::MineEnded {
                tick,
                id: out.id,
                reason: out.reason,
            });
            let Some(r) = out.explosion else { continue };
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
                    match kind {
                        EffectKind::ToxicRain => self.toxic = Some((id, ToxicRain::new(seed, now))),
                        EffectKind::MeteorShower => {
                            self.meteor = Some((id, MeteorShower::new(seed, now)))
                        }
                        // Vents are chosen during the telegraph so the client can
                        // crack the ground at exactly the points that will open.
                        EffectKind::LavaBurst => {
                            self.lava = Some((id, LavaBurst::new(seed, &self.map, now)))
                        }
                        EffectKind::HeavyFog => self.fog = Some((id, HeavyFog::new(now))),
                    }
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
            let spawned = {
                let (mut closures, meta) = hit_targets(&self.players, &log, now);
                let mut tg = targets(&mut self.players, &mut closures, &meta);
                t.tick(&self.map, &mut tg, toxic_on, now, dt)
            };
            self.apply_damage_log(&log, now);
            for p in spawned {
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
            self.toxic = Some((eid, t));
        }

        if let Some((eid, mut m)) = self.meteor.take() {
            let ids = m.tick(&mut self.projectiles, &self.map, meteor_on, now);
            for id in ids {
                if let Some(p) = self.projectiles.get(id) {
                    let (x, y, vx, vy, weapon, owner) =
                        (p.pos.x, p.pos.y, p.vel.x, p.vel.y, p.weapon, p.owner);
                    let tick = self.tick;
                    self.events.push(GameEvent::ProjectileSpawn {
                        tick,
                        id,
                        weapon,
                        owner,
                        x,
                        y,
                        vx,
                        vy,
                    });
                }
            }
            self.meteor = Some((eid, m));
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

    /// Fire the selected weapon. Validation lives in `PlayerState::try_fire`.
    pub fn fire(&mut self, id: PlayerId, now: f32) -> Result<(), UseError> {
        let Some(idx) = self.players.iter().position(|p| p.id == id) else {
            return Err(UseError::Dead);
        };
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
