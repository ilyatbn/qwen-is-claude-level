//! The `World`: everything the simulation owns, advanced one tick at a time.
//!
//! This is the object the server's room task owns outright and the replay binary
//! re-runs headlessly. It contains no clock — `dt` is passed in — and no I/O, so
//! the same code produces the same result at 60 Hz on a server, at full speed in a
//! replay, and in the browser through WASM (`docs/01-architecture.md`).
//!
//! See `docs/41-server-loop-rooms.md` §2 for the tick order, which is a contract.

pub mod ambient;
pub mod animals;
pub mod attractors;
pub mod birds;
pub mod cycle;
pub mod mount;
pub mod teleport;
pub mod tombstones;
pub mod vortex;

use animals::{AnimalId, AnimalKind, Animals};
use birds::{BirdId, BirdKind, Birds};
use tombstones::Tombstones;

use crate::constants::{
    GravityMode, MapScale, ENDED_SECONDS, INPUT_BACKLOG_TARGET, MAX_FRAME_TICKS, MAX_PLAYERS,
    ROUND_SECONDS, TELEPORT_PADS, WARMUP_SECONDS,
};
use crate::items::registry::{ItemId, WeaponId, WEAPON_PLATFORM_GUN};
use crate::items::spawning::{assign_buried_items, place_initial, reveal_buried, SpawnSchedule};
use crate::items::world::{SpawnSource, WorldItemId, WorldItems};
use crate::map::meta::TeleportPad;
use crate::map::{CarveResult, Map};
use crate::math::{Aabb, Point, Vec2};
use crate::player::input::Input;
use crate::player::respawn::choose_respawn_pad;
use crate::player::state::{
    choose_respawn, surface_to_centre, DeathCause, PlayerId, PlayerState, UseError,
};
use crate::player::{apply_input, MoveStep};
use crate::rng::{range_f32, substream, ChaCha8Rng};
use crate::weapons::burn::BurnKind;
use crate::weapons::defs::{self, BurnZone, Burst, Delivery};
use crate::weapons::explode::{
    explode, fire_hitscan, BlastSource, DamageSource, EffectKind, HitId, HitTarget,
};
use crate::weapons::projectile::{ProjectileId, ProjectileOutcome, Projectiles};
use crate::weapons::smoke::SmokeField;

use crate::effects::flare::SolarFlare;
use crate::effects::fog::HeavyFog;
use crate::effects::lava::LavaBurst;
use crate::effects::meteor::MeteorShower;
use crate::effects::scheduler::{EffectEvent, EffectPhase, EffectScheduler, WeatherTable};
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
    /// **Does a player's input do anything in this phase?** (T21.30)
    ///
    /// Reported from play: *"i can still move my character after the 'round
    /// over' is displayed."* The coordinator's ruling: in `Ended`, input does
    /// nothing — no movement, no firing, no digging, no item use — while bodies
    /// still settle under gravity. `Warmup` is unchanged.
    ///
    /// **One rule, read by both sides**: `World::apply_inputs` and
    /// `World::inventory_actor` on the server, and the wasm mirror's
    /// `GameCore::apply_input` on the client, which learns the phase off the
    /// same `round_state` the results screen does. A flag each side kept would
    /// be two answers that can disagree, and a disagreement here is a body that
    /// walks on screen and snaps back.
    pub fn accepts_input(self) -> bool {
        self != RoundPhase::Ended
    }

    /// The inverse of `as_str`, for the client mirror, which receives the phase
    /// as the wire's string.
    pub fn parse(s: &str) -> Option<RoundPhase> {
        [
            RoundPhase::Lobby,
            RoundPhase::Warmup,
            RoundPhase::Playing,
            RoundPhase::Ended,
        ]
        .into_iter()
        .find(|p| p.as_str() == s)
    }

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
    /// A ground animal appeared (T20.10).
    ///
    /// `kind` rides on the spawn for the reason `BirdSpawn`'s does: the two kinds
    /// carry different rewards and are worth different ammunition, and a player
    /// who cannot tell them apart cannot decide.
    AnimalSpawn {
        tick: u32,
        id: AnimalId,
        kind: u8,
        x: f32,
        y: f32,
        right: bool,
    },
    /// Where a live animal is now, at `SNAPSHOT_HZ` like every other moving thing.
    AnimalMove {
        tick: u32,
        id: AnimalId,
        x: f32,
        y: f32,
        right: bool,
    },
    /// An animal left the world. `killed` separates "shot" from "fell out of the
    /// map", which is the difference between a drop and nothing at all.
    AnimalDespawn {
        tick: u32,
        id: AnimalId,
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
        /// The health that came off — what **landed** through a suit or a
        /// generator, not what was rolled (T22.08C F4).
        amount: f32,
        cause: DeathCause,
        /// The weather effect that dealt it, when one did (T22.08E F9) — so a client
        /// can tell a flare's burn from a meteor fragment's hit, which `cause`
        /// (`Weather` for both) cannot. `None` for everything that is not weather.
        effect: Option<EffectKind>,
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
    /// T22.10: a breach in the space rim became a vortex. Everyone: it is in the
    /// world for all to see — and off the minimap (R9, point 5), which is the
    /// client's business, not the event's.
    VortexOpen {
        tick: u32,
        id: u32,
        x: f32,
        y: f32,
    },
    /// T22.10: a vortex stopped pulling — replaced by a fourth (R9, point 2).
    VortexClose {
        tick: u32,
        id: u32,
    },
    /// T22.10: vortex `vortex` took player `id` and put them at `(x, y)` — a
    /// `Teleport` in all but its source, which is why it is its own event rather
    /// than `from_pad` carrying a value that means "not a pad".
    VortexTrip {
        tick: u32,
        id: PlayerId,
        vortex: u32,
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
            | GameEvent::AnimalSpawn { tick, .. }
            | GameEvent::AnimalMove { tick, .. }
            | GameEvent::AnimalDespawn { tick, .. }
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
            | GameEvent::VortexOpen { tick, .. }
            | GameEvent::VortexClose { tick, .. }
            | GameEvent::VortexTrip { tick, .. }
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
/// The animals' half of the same deferral (T20.10), shaped exactly like `BirdLog`.
type AnimalLog = std::rc::Rc<std::cell::RefCell<Vec<(AnimalId, f32)>>>;

/// Who, if anybody, drains life from one entry in the damage log (T21.01).
///
/// **Deliberately not the `attacker` that `apply_damage_log`'s other match
/// produces.** That one names the player a *death* is credited to, and credit
/// and lifesteal are different questions with different answers on three of the
/// four variants: `SelfInflicted` and `Fall` both name a player for the kill
/// feed and must name nobody here — a rocket at your own feet healing you is the
/// exploit this exists to prevent — and `Player { id }` names its attacker for
/// credit whatever the weapon, while only a weapon that *flies* feeds a set of
/// fangs. Deriving one from the other would be the field-that-means-two-things
/// bug with an exploit on the end of it.
///
/// The weapon is resolved to a `Delivery` **through the registry**
/// (`WeaponDef::is_flying_ordnance`), never by name or id.
///
/// Matched exhaustively, so the next `DamageSource` variant is a compile error
/// here rather than a silent `None` nobody wrote down.
fn lifesteal_attacker(src: DamageSource, victim: PlayerId) -> Option<PlayerId> {
    match src {
        // `id != victim` is belt and braces beside `SelfInflicted`: `explode`
        // produces `SelfInflicted` when owner == victim, but nothing forces
        // every future caller to, and the exploit is cheap to close here.
        DamageSource::Player { id, weapon } => (id != victim
            && defs::def(weapon).is_some_and(|w| w.is_flying_ordnance()))
        .then_some(id),
        // Your own ordnance, however it is delivered.
        DamageSource::SelfInflicted { .. } => None,
        // Nobody caused it: a player standing in toxic rain is not dealing
        // damage, and `Weather` carries no player at all.
        DamageSource::Weather(_) => None,
        // T20.11's fall has no weapon — which is exactly why it is its own
        // variant and not a `SelfInflicted` — so it can never be a projectile.
        // Named rather than left to a wildcard, as that task file asks.
        DamageSource::Fall => None,
        // Space's radiation (T22.09A) has no player behind it at all.
        DamageSource::Radiation => None,
    }
}

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
    animals: &Animals,
    log: &DamageLog,
    bird_log: &BirdLog,
    animal_log: &AnimalLog,
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

    // Animals after the birds — and **the only contract is "players first"**.
    //
    // T20.10 was warned that a third class turns `targets`' two-way split into a
    // three-way one, silently zipping animal closures onto bird velocities. It
    // does not, and the reason is worth keeping: from `targets`' point of view a
    // bird and an animal are the same thing — a non-player whose velocity goes to
    // a scratch. So there is one split, at `players.len()`, and appending a fourth
    // class cannot get it wrong either.
    for a in animals.iter() {
        let (w, h) = a.size();
        meta.push((HitId::Animal(a.id), a.pos(), true, w, h));
        let id = a.id;
        let log = animal_log.clone();
        closures.push(Box::new(move |amount: f32, _src: DamageSource| {
            log.borrow_mut().push((id, amount));
            true
        }) as Box<DamageFn>);
    }

    // Neither is ever thrown: §C16 gives a bird a fixed sine path, and an animal
    // owns a `Body` this slice must not reach into mid-resolution. These exist
    // because `HitTarget` needs a `&mut Vec2`, and writing into a scratch is
    // honest about the value being discarded — the alternative is wildlife whose
    // velocity a blast has quietly edited.
    let scratch_vels = vec![Vec2::new(0.0, 0.0); birds.len() + animals.len()];
    // Count the thing at both ends: one scratch per non-player target, which is
    // the invariant `targets` splits on. Both ends documented it and neither
    // enforced it (T20.10's BLOCKER); this is the enforcement.
    debug_assert_eq!(
        scratch_vels.len(),
        meta.len() - players.len(),
        "one scratch velocity per non-player target"
    );
    (closures, meta, scratch_vels)
}

type DamageFn = dyn FnMut(f32, DamageSource) -> bool;

/// Zip the deferred closures back onto the velocities they may knock.
///
/// `meta` and `closures` are **players first, then everything else**, exactly as
/// `hit_targets` built them; the split point is `players.len()`. That is one rule
/// rather than one per entity class, which is what stops a third class (T20.10's
/// animals) from being zipped onto the second's velocities.
fn targets<'a>(
    players: &'a mut [PlayerState],
    closures: &'a mut [Box<DamageFn>],
    meta: &[TargetMeta],
    scratch_vels: &'a mut [Vec2],
) -> Vec<HitTarget<'a>> {
    let n = players.len();
    debug_assert_eq!(
        scratch_vels.len(),
        meta.len() - n,
        "one scratch velocity per non-player target"
    );
    let (player_closures, other_closures) = closures.split_at_mut(n);
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
        scratch_vels
            .iter_mut()
            .zip(other_closures.iter_mut())
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
    /// T20.10's ground animals. Public for the same reasons the birds are: the
    /// server serialises them and the state hash covers them, because killing one
    /// spawns an item and a replay that disagreed about which animals existed
    /// would disagree about the loot on the ground.
    pub animals: Animals,
    pub spawn_schedule: SpawnSchedule,
    pub effects: EffectScheduler,
    /// See [`WeatherMode`]. `Auto` everywhere but a development switch.
    pub weather_mode: WeatherMode,
    /// Which gravity this match is played under (T22.01).
    ///
    /// **Set once, at construction, from the room's `Config`** — the same shape
    /// as `weather_mode`, and set at *both* of `room.rs`'s construction sites for
    /// the same recorded reason: a room that got its setting back at the default
    /// on restart is the bug `set_round_seconds` was fixed for once already.
    ///
    /// **`Low` is read; `Space` is not yet.** T22.02 wired the low-gravity arm
    /// through `GravityMode::scale`;
    /// `gravity_tests::low_gravity_changes_the_simulation_and_space_does_not_yet`
    /// asserts both halves, and T22.03 retires the second.
    ///
    /// **The client half was not free.** The client does not run a `World`:
    /// `game-wasm`'s `GameCore` predicts by calling `player::apply_input`
    /// directly, and `apply_input` now takes the mode. It could not ride
    /// `MoveMods`, which is derived per player from the inventory — a match
    /// setting is not a modifier of the player — so `GameCore::set_gravity`
    /// carries it, which is `set_phase`'s shape.
    pub gravity: GravityMode,
    pub buried_items: Vec<ItemId>,
    /// Rounds left in each gun platform, indexed by platform id (T21.11C).
    ///
    /// **World state, not `MapMeta`.** `MapMeta` is generation output that never
    /// changes after the map is built; this is spent. It is in the state hash
    /// for the same reason: a replay whose magazine had drifted would run to a
    /// different outcome with every checkpoint agreeing.
    ///
    /// Parallel to `map.meta.gun_platforms` rather than a field on it, so
    /// nothing has to make a `MapMeta` mutable to fire a gun.
    pub platform_ammo: Vec<u16>,
    /// When each platform may fire again (T21.11C).
    ///
    /// **The platform's clock, not the rider's.** `PlayerState::fire_ready_at`
    /// belongs to whatever they are holding, and a platform sharing it would
    /// fire at the cadence of a weapon in a bag its rider cannot reach.
    pub platform_ready_at: Vec<f32>,
    /// Which barrel each platform fires next, `0..GUN_PLATFORM_BARRELS` (T21.43).
    ///
    /// Per platform rather than per rider, like the magazine: a held stream is
    /// the turret turning over, and a second rider picks it up where it stopped.
    /// Hashed — it decides where the next round leaves the muzzle.
    pub platform_barrel: Vec<u8>,
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
    /// Per-player queued inputs, parallel to `players` by id lookup: the jitter
    /// buffer, only ever seqs *after* the last simulated one (T22.10F, R89).
    pending: Vec<(PlayerId, Input)>,
    /// The input each player's last simulated tick ran — real or stand-in — so
    /// **its `seq` is the last simulated seq, the snapshot's ack** (T22.10F), and
    /// its buttons are the next tick's `edges` baseline.
    prev_input: Vec<(PlayerId, Input)>,
    /// The newest input each player has sent, simulated or not (T22.10F, R89):
    /// the held state a stand-in tick repeats when the next input has not
    /// arrived. Newer than `prev_input` exactly when a late input was discarded.
    newest_input: Vec<(PlayerId, Input)>,
    /// Ticks a player's first client-numbered input still waits before its tick
    /// (T22.10G, R89's jitter buffer): set to `INPUT_BACKLOG_TARGET` when it
    /// arrives, so the expected seq starts `INPUT_BACKLOG_TARGET` behind the
    /// newest sent — the lead the buffer exists for. See `apply_inputs`.
    input_wait: Vec<(PlayerId, usize)>,
    phase_started_at: f32,
    /// `Playing` duration. Defaults to `ROUND_SECONDS`; overridden for tests.
    round_seconds: f32,
    /// `Warmup` duration. Defaults to `WARMUP_SECONDS`; the server's
    /// `DEV_WARMUP_SECONDS` shortens it for browser checks.
    warmup_seconds: f32,
    last_day_phase: DayPhase,

    toxic: Option<(u32, ToxicRain)>,
    meteor: Option<(u32, MeteorShower)>,
    lava: Option<(u32, LavaBurst)>,
    fog: Option<(u32, HeavyFog)>,
    /// T22.08A: the flare, and the round time it was installed at — its clock
    /// starts at the telegraph, as the client's does at `effect_start`.
    flare: Option<(u32, f32, SolarFlare)>,
    /// Who radiation's log entry actually landed on **this tick** (T22.09A,
    /// `M22-RULINGS` R75) — the channel that carries the cause into
    /// `resolve_deaths`, which `R20` found does not otherwise exist.
    ///
    /// **Transient, and so not hashed**: filled by `apply_damage_log`, taken
    /// (emptied) by `resolve_deaths` in the same step, and cleared at the top
    /// of every `step` besides. Nothing reads it across a tick boundary, which
    /// `radiation_tests::the_radiation_list_never_survives_a_step` asserts.
    /// Re-deriving the cause from "in space and unsealed" was rejected (R75):
    /// every unsealed player is that, so a meteor kill would read radiation.
    irradiated_this_tick: Vec<PlayerId>,
    /// T22.10: the live breach vortices, in opening order — the order the pull is
    /// summed in, on both sides. Hashed.
    pub vortices: Vec<vortex::Vortex>,
    /// T22.10C: vortices the cap displaced — **no pull, still catching** for as
    /// long as their hole is open, which is for the round (`M22-RULINGS` R88: a
    /// hole in the rim never kills; only the pull is capped at three). Hashed.
    pub spent_vortices: Vec<vortex::Vortex>,
    /// The next vortex id. Hashed: it names the next one.
    vortex_seq: u32,
    /// Where a vortex puts people: its own stream, so a capture does not move any
    /// other roll (the pads share `rng`; a vortex is rarer and should not). Hashed
    /// by position, as `rng` is.
    vortex_rng: ChaCha8Rng,
}

/// The map cache behind `World::for_test`: one generation per
/// `(seed, scale, buried_secret)` per test binary.
///
/// One `OnceLock` per key, taken out of the mutex before generating, so two tests
/// asking for different maps generate in parallel and two asking for the same one
/// wait for a single generation. Test-only state: never compiled into a shipping
/// build, and holds nothing that affects a simulation beyond the map itself,
/// which is cloned out on every call.
#[cfg(any(test, feature = "test-support"))]
fn shared_test_map(seed: u64, scale: MapScale, buried_secret: u64) -> Map {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};
    type Key = (u64, MapScale, u64);
    type Slot = Arc<OnceLock<Map>>;
    type Slots = Mutex<HashMap<Key, Slot>>;
    static CACHE: OnceLock<Slots> = OnceLock::new();
    let slot = {
        let mut slots = CACHE
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slots
            .entry((seed, scale, buried_secret))
            .or_default()
            .clone()
    };
    slot.get_or_init(|| {
        crate::map::generate_full(
            seed,
            scale,
            buried_secret,
            crate::constants::DEFAULT_MAP_GENERATOR,
        )
    })
    .clone()
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
            GravityMode::Standard,
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
        Self::build(seed, scale, buried_secret, generator, GravityMode::Standard)
    }

    /// As `with_generator`, under a named gravity — **and the gravity decides
    /// the map** (`T22.05A`, `M22-RULINGS` R15).
    ///
    /// This exists because until it did, gravity could not reach map generation
    /// at all: the server built the world and assigned `world.gravity`
    /// *afterwards*, and `World::build` had no gravity parameter anywhere. So a
    /// host who picked space got a landscape with a floor, and nothing in the
    /// tree could have said otherwise.
    ///
    /// The derivation lives in `MapGenerator::for_gravity`, which is the single
    /// source of truth: a room that carried a gravity **and** a generator as two
    /// independent settings could be asked for space gravity on a normal map,
    /// which is *derive, do not add a fourth flag*.
    pub fn with_gravity(
        seed: u64,
        scale: MapScale,
        buried_secret: u64,
        generator: crate::constants::MapGenerator,
        gravity: GravityMode,
    ) -> Self {
        Self::build(seed, scale, buried_secret, generator, gravity)
    }

    fn build(
        seed: u64,
        scale: MapScale,
        buried_secret: u64,
        generator: crate::constants::MapGenerator,
        gravity: GravityMode,
    ) -> Self {
        let generator = crate::constants::MapGenerator::for_gravity(gravity, generator);
        let map = crate::map::generate_full(seed, scale, buried_secret, generator);
        let mut world = Self::from_map(seed, buried_secret, map);
        // Set **here**, not by the caller afterwards. The map that just got
        // built is the map this gravity asked for, and a second assignment at
        // the call site is a second place the two can disagree — which is what
        // the two construction sites in `room.rs` were before this.
        world.gravity = gravity;
        world
    }

    /// A world for a test that needs a real map and is not testing generation.
    ///
    /// Identical to `World::new(seed, scale)`, which
    /// `a_cached_world_is_the_world_new_builds` pins, but the map is generated at
    /// most once per test binary for each `(seed, scale)`. Every call gets its own
    /// clone of the map, so a carve in one test never reaches another.
    ///
    /// **Not for anything whose subject is generation, seeds or placement.** Those
    /// keep calling `World::new` or `generate_full`, so every run generates again.
    #[cfg(any(test, feature = "test-support"))]
    pub fn for_test(seed: u64, scale: MapScale) -> Self {
        Self::for_test_with_secret(seed, scale, 0)
    }

    /// `for_test` with a buried secret: the cached twin of `with_buried_secret`.
    #[cfg(any(test, feature = "test-support"))]
    pub fn for_test_with_secret(seed: u64, scale: MapScale, buried_secret: u64) -> Self {
        let map = shared_test_map(seed, scale, buried_secret);
        Self::from_map(seed, buried_secret, map)
    }

    /// Everything after generation. Shared by `build` and `for_test`, so the two
    /// cannot build different worlds from the same map.
    fn from_map(seed: u64, buried_secret: u64, map: Map) -> Self {
        let wind = map.meta.wind;
        let buried_items = assign_buried_items(&map, seed ^ buried_secret);
        let mut items = WorldItems::new();
        let initial_draws = place_initial(&mut items, &map, seed, 0.0);

        let birds = Birds::new(seed, &map);
        let animals = Animals::new(seed);
        let platforms = map.meta.gun_platforms.len();
        World {
            platform_ammo: vec![crate::constants::GUN_PLATFORM_AMMO; platforms],
            platform_ready_at: vec![0.0; platforms],
            platform_barrel: vec![0; platforms],
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
            animals,
            spawn_schedule: SpawnSchedule::new(seed, 0.0, initial_draws),
            effects: EffectScheduler::new(seed, 0.0),
            weather_mode: WeatherMode::Auto,
            gravity: GravityMode::Standard,
            buried_items,
            round_time: 0.0,
            tick: 0,
            phase: RoundPhase::Warmup,
            round_seconds: ROUND_SECONDS,
            warmup_seconds: WARMUP_SECONDS,
            wind,
            seed,
            events: Vec::new(),
            rng: substream(seed, "world"),
            carve_seq: 0,
            pending: Vec::new(),
            prev_input: Vec::new(),
            newest_input: Vec::new(),
            input_wait: Vec::new(),
            phase_started_at: 0.0,
            last_day_phase: cycle_at(0.0).phase,
            toxic: None,
            meteor: None,
            lava: None,
            fog: None,
            flare: None,
            irradiated_this_tick: Vec::new(),
            vortices: Vec::new(),
            spent_vortices: Vec::new(),
            vortex_seq: 0,
            vortex_rng: substream(seed, "vortex"),
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
        Self::issue_suit(self.gravity, &mut p);
        self.players.push(p);
        // Sorted by id, always — see the field comment.
        self.players.sort_by_key(|p| p.id);
        self.prev_input.push((id, Input::default()));
        self.prev_input.sort_by_key(|(i, _)| *i);
        self.newest_input.push((id, Input::default()));
        self.input_wait.push((id, 0));
    }

    /// A fresh spacesuit: the battery full, in a suit mode (T22.09A, R24).
    ///
    /// **Both routes into a life call it** — `add_player` and the respawn in
    /// `resolve_deaths` — the same pairing `grant_starting_kit` has for the
    /// same reason. Restoring it on respawn is what stops the death spiral: the
    /// first radiation death would otherwise guarantee the second. Here, not in
    /// `PlayerState::respawn`, because only `World` knows the mode (R26); and
    /// outside space it does nothing, so `respawn_keeps_the_battery_…` holds.
    ///
    /// **Public for the sandbox's one caller** (T22.09B, review F11):
    /// `GameCore::add_player` issues the same suit, so a sandbox player in space
    /// starts sealed as a real one does, by this function rather than a copy.
    pub fn issue_suit(gravity: GravityMode, p: &mut PlayerState) {
        if gravity.wears_suit() {
            p.battery = crate::constants::BATTERY_MAX;
        }
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
        // **`body_fits_at`, not `is_standable`** (`T22.05B`): under gravity they
        // are the same call, and in space a spawn point is open air that
        // `is_standable` refuses by definition. With the bare call here every
        // space spawn failed and every player took the respawn fallback, which
        // put them on an asteroid top rather than at the point the generator
        // chose — a whole feature computed, shipped and never used.
        if self.map.body_fits_at(p) {
            // A spawn point is a feet line, not a centre (`choose_respawn`).
            surface_to_centre(Vec2::new(p.x as f32, p.y as f32))
        } else {
            choose_respawn(&self.map, &[], &mut self.rng)
        }
    }

    pub fn remove_player(&mut self, id: PlayerId) {
        self.players.retain(|p| p.id != id);
        self.prev_input.retain(|(i, _)| *i != id);
        self.newest_input.retain(|(i, _)| *i != id);
        self.input_wait.retain(|(i, _)| *i != id);
        self.pending.retain(|(i, _)| *i != id);
    }

    pub fn player(&self, id: PlayerId) -> Option<&PlayerState> {
        self.players.iter().find(|p| p.id == id)
    }

    pub fn player_mut(&mut self, id: PlayerId) -> Option<&mut PlayerState> {
        self.players.iter_mut().find(|p| p.id == id)
    }

    /// Hand the world an input for `id`'s next ticks (T22.10F, R89).
    ///
    /// **Seq 0 is "the next one"**: a bot has no packets to order, and neither
    /// does a test that queues one input a tick, so the world numbers it after
    /// everything this player has sent. No client input can carry 0 — the room
    /// rejects any seq at or below its last received, which starts at 0
    /// (`Room::apply`'s `Command::Input`) — so the sentinel cannot collide with a
    /// real stream. Without it every such input would read as already simulated
    /// and be discarded.
    pub fn queue_input(&mut self, id: PlayerId, mut input: Input) {
        let Some(slot) = self.newest_input.iter_mut().find(|(i, _)| *i == id) else {
            return;
        };
        // T22.10G: **a client's first input waits `INPUT_BACKLOG_TARGET` ticks**
        // — the jitter buffer's lead. A world-numbered one (seq 0: a bot, a test)
        // does not: it was made in this process, on its tick, and has no network
        // to be late on.
        if slot.1.seq == 0 && input.seq != 0 {
            if let Some(w) = self.input_wait.iter_mut().find(|(i, _)| *i == id) {
                w.1 = INPUT_BACKLOG_TARGET;
            }
        }
        if input.seq == 0 {
            let last = self
                .prev_input
                .iter()
                .find(|(i, _)| *i == id)
                .map_or(0, |(_, v)| v.seq);
            input.seq = last.max(slot.1.seq) + 1;
        }
        if input.seq > slot.1.seq {
            slot.1 = input;
        }
        self.pending.push((id, input));
    }

    /// The seq of `id`'s last simulated tick — a real input's, or the one a
    /// stand-in claimed — and so **the snapshot's ack** (T22.10F, R89;
    /// `Room::last_seqs`). The state after this tick is exactly what a client
    /// that predicted every seq up to it with the inputs the server ran would
    /// hold, and every seq after it is still to be simulated.
    pub fn last_simulated_seq(&self, id: PlayerId) -> Option<u32> {
        self.prev_input
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, v)| v.seq)
    }

    /// Unconsumed inputs still queued. At most `INPUT_BACKLOG_TARGET` per player
    /// after each tick (T22.10F, R89).
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

    /// How long `Warmup` lasts. `WARMUP_SECONDS` unless the server's
    /// `DEV_WARMUP_SECONDS` says otherwise. Read only by `phase_time_left`, which
    /// is what ends the phase, so this is the whole of the change.
    pub fn set_warmup_seconds(&mut self, secs: f32) {
        self.warmup_seconds = secs.max(0.0);
    }

    /// Start this world's round clock at `t` instead of 0. The server's
    /// `DEV_ROUND_CLOCK`, for checks that photograph night or the ambient rain.
    ///
    /// **The same round, shifted.** Night, the ambient schedule and the sky are
    /// functions of `round_time`, so they arrive `t` seconds early. Everything
    /// the world had anchored at 0 moves with the clock:
    /// - the effect scheduler;
    /// - the item and crate schedule;
    /// - the initial items' `spawned_at`;
    /// - the phase anchor.
    ///
    /// Otherwise the first tick would roll a burst of effects and spawns to
    /// catch up, and despawn every starting item past `WORLD_ITEM_TTL`.
    /// `a_late_clock_is_the_same_round_shifted` pins that.
    ///
    /// Call it on a fresh world, before anyone is seated: a player's i-frames
    /// and respawn times are read off this clock when they are added.
    pub fn start_clock_at(&mut self, t: f32) {
        debug_assert!(
            self.players.is_empty() && self.round_time == 0.0,
            "start_clock_at is for a fresh world"
        );
        self.round_time = t;
        self.phase_started_at += t;
        self.last_day_phase = cycle_at(t).phase;
        self.effects.rebase(t);
        self.spawn_schedule.rebase(t);
        self.items.rebase_spawn_times(t);
    }

    pub fn round_seconds(&self) -> f32 {
        self.round_seconds
    }

    /// Tell clients what phase this world is in, **whether or not it just
    /// changed** (T21.13).
    ///
    /// `set_phase` cannot do this: it early-returns when the phase already
    /// matches, and that is correct — it is a *transition*, and announcing one
    /// that did not happen would put a phase change in the replay stream that
    /// the simulation never made.
    ///
    /// But a world is **born in `Warmup`** (see the constructor), and
    /// `room.rs::restart` builds a fresh one and then asks for `Warmup`. That is
    /// a no-op, so round two announced nothing at all: for the whole warmup the
    /// client kept `phase == ended` and the *previous* round's deadline, which
    /// is the "play again" panel sitting over a live round and a clock that
    /// jumps back up instead of counting down. Reported from play.
    ///
    /// `docs/41` §3 says `round_state` is broadcast on every phase change **and**
    /// once a second during `Playing`; the second half would normally have
    /// covered this, and `RoundController::last_state_at` meant it did not.
    pub fn announce_phase(&mut self) {
        let tick = self.tick;
        let (phase, time_left) = (self.phase, self.phase_time_left());
        self.events.push(GameEvent::RoundState {
            tick,
            phase,
            time_left,
        });
    }

    /// Move to `phase`, announcing the transition. A no-op if already there.
    ///
    /// Returns whether it changed anything, so a caller that *must* have
    /// announced can tell — see `announce_phase`.
    pub fn set_phase(&mut self, phase: RoundPhase) -> bool {
        if self.phase == phase {
            return false;
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
        true
    }

    pub fn phase_time_left(&self) -> f32 {
        let d = match self.phase {
            RoundPhase::Lobby => return f32::INFINITY,
            RoundPhase::Warmup => self.warmup_seconds,
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
        // R75: the radiation cause list is one tick's; `resolve_deaths` takes
        // it, and this makes sure a step that returned early cannot leak it.
        self.irradiated_this_tick.clear();
        let warmup = self.phase == RoundPhase::Warmup;
        let playing = self.phase == RoundPhase::Playing;

        // 1. round time and the day/night cycle.
        self.round_time += dt;
        let now = self.round_time;
        let day = cycle_at(now).phase;
        if day != self.last_day_phase {
            self.last_day_phase = day;
            // T22.06B F6: **no dawn or dusk in orbit.** `darkness` is 0 in space,
            // so the only thing this event still did there was play the
            // `phase_change` cue every half-cycle over a sky with no night. Gated
            // on the map (R58), like `wildlife_allowed`. `last_day_phase` is still
            // kept above, so the state hash — and `REPLAY_VERSION` — do not move.
            if self.map.space_geometry().is_none() {
                let tick = self.tick;
                self.events.push(GameEvent::PhaseChange {
                    tick,
                    day_phase: day,
                });
            }
        }

        // 2. player inputs, in ascending PlayerId, always.
        self.apply_inputs(now, dt);

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
        let moved = self.items.step(&self.map, self.gravity, dt);
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
        self.tombstones.step(&self.map, self.gravity, dt);
        if playing {
            self.step_item_spawns(now);
        }

        // 6b. birds (§C16). With the items, because that is what they are: a
        // moving supply drop. **After** the item step so a drop made this tick
        // is not integrated twice, and before the pickups so one that lands on
        // a player's head can be taken on the same tick it arrives.
        self.step_birds(now, dt, playing);
        self.step_animals(now, dt, playing);

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
            let animal_log: AnimalLog = Default::default();
            self.apply_damage_log(&log, &bird_log, &animal_log, now);
        }

        // 8a2. the solar flare's burn (T22.08A, R81). 8a's shape, one entry per
        // player per whole second. **Before 8c**, so a flare death on the
        // radiation tick is a `Weather` death and R75's list never names it —
        // `a_hazard_death_on_the_radiation_tick_is_not_named_radiation`'s flare
        // arm. Not the dying, for 8c's reason.
        //
        // **`Playing` only, and it is two guards** (T22.08C F1 — the first cut
        // left this ungated, "like poison", and a flare touched in the last
        // seconds burned on the results screen: five `Damage` and a `Death` in
        // `Ended`, a score changed and a kill `killer()` could credit after the
        // bell). The first guard is the schedule's, the lava way:
        // `active_duration(SolarFlare)` is the ribbon's life **plus**
        // `SOLAR_FLARE_BURN_SECONDS`, so no flare is rolled whose last burn could
        // outlive the round. This gate is the belt for the paths that do not roll —
        // `WEATHER=flare`, a forced effect, a round cut short — where a burn that
        // outlives `Playing` simply stops.
        if playing {
            let log: DamageLog = Default::default();
            {
                let mut entries = log.borrow_mut();
                for p in self.players.iter_mut().filter(|p| p.alive && !p.is_dying()) {
                    if let Some(amount) = p.burn_tick(now, dt) {
                        entries.push((p.id, amount, DamageSource::Weather(EffectKind::SolarFlare)));
                    }
                }
            }
            let bird_log: BirdLog = Default::default();
            let animal_log: AnimalLog = Default::default();
            self.apply_damage_log(&log, &bird_log, &animal_log, now);
        }

        // 8c. space's radiation (T22.09A, `M22-RULINGS` R6, R24, R25). The
        // same shape as 8a, for the same reason: a per-player standing
        // predicate, through the damage log because that is where the warmup
        // gate, the `Damage` event and the death attribution live. **One entry
        // per player per whole second, never per tick** (R25). `Playing` only:
        // the suit does not drain while the round is not live, and after the
        // bell nobody should die of the sky.
        if playing && self.gravity.wears_suit() {
            let log: DamageLog = Default::default();
            {
                let mut entries = log.borrow_mut();
                // Not the dying (F1): struck dead earlier in this tick, they
                // are `alive` until `resolve_deaths`, and one radiation entry
                // landing on them would relabel that death Radiation (R75).
                // `p.alive` is not redundant: `!is_dying()` is true for the dead
                // (`the_dead_are_neither_drained_nor_irradiated`, T22.09C F5).
                for p in self.players.iter_mut().filter(|p| p.alive && !p.is_dying()) {
                    if let Some(amount) = p.radiation_tick(now, dt) {
                        entries.push((p.id, amount, DamageSource::Radiation));
                    }
                }
            }
            let bird_log: BirdLog = Default::default();
            let animal_log: AnimalLog = Default::default();
            self.apply_damage_log(&log, &bird_log, &animal_log, now);
        }

        // 8b0. breach vortices (T22.10). **Before the void**, so a body leaving
        // through a hole is caught while it is still inside the grace band
        // (`SPACE_VOID_GRACE`'s basis) rather than killed there.
        self.step_vortices(now);

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

    /// **Nothing lives in space** — `M22-RULINGS` R14's `Animals::tick` row
    /// (*"no animals at all in space"*) and R58, which assigned it. `false`
    /// when this round's map came from the space generator, and both wildlife
    /// steppers fold it into the `active` flag they already take.
    ///
    /// **One function, because birds and animals cannot share one anywhere
    /// else.** R14 adds *"this also answers the `birds.rs` row"*, and that is
    /// true exactly one layer up from where it points: `Animals::tick` holds a
    /// `&Map` and could gate itself, `Birds::tick` holds only `map_w: f32` and
    /// could not. What the two do share is this flag, handed to them by the
    /// layer that owns the map — *share the guard, or share the function*.
    ///
    /// **Gated on the generator, never on `self.gravity`** (R58's one hazard).
    /// R15 derives `MapGenerator::Space` from the mode and makes that
    /// derivation the single source of truth; `Map::space_geometry`'s `Some` is
    /// its spelling for code holding a `&Map`. Keying on the field would be a
    /// second answer to one question, which is the drift R15 exists to prevent
    /// — and the two are not equally stable here: `World::gravity` is a public
    /// field that callers assign after construction, while `World::map` is
    /// written exactly once, in `from_map`, and no path reassigns it.
    ///
    /// **Nothing alive is ever stranded**, and that immutability is why: the
    /// subject of this guard cannot change during a round, so there is no
    /// moment at which a living animal is on the wrong side of it. A round
    /// cannot become a space round after it started.
    ///
    /// **Which side this runs on.** `T22.11C` has since landed
    /// `GameCore::set_asteroids`, so `space_geometry` is now sound on both
    /// sides and the caveat this paragraph used to cite is gone. The analysis
    /// is kept because it is what makes that irrelevant here rather than
    /// merely fixed: every live caller of `World::step` is server-side —
    /// `game-server::room` and `game-server::round`. The only other is
    /// `game-wasm::AttractCore`, which generates its own map locally through
    /// `World::new` and has been dormant since T18.01. No networked client
    /// steps a `World`, so nothing here can read a stale `meta.asteroids`.
    fn wildlife_allowed(&self) -> bool {
        self.map.space_geometry().is_none()
    }

    /// Fly the birds, and announce the ones that arrived or left.
    ///
    /// Movement is broadcast at `SNAPSHOT_HZ`, not every tick, for the reason
    /// `ProjectileMove` and `ItemMove` are: 60 Hz of positions for four birds is
    /// bandwidth spent on something nobody can see move that finely.
    fn step_birds(&mut self, now: f32, dt: f32, playing: bool) {
        let map_w = self.map.mask.w as f32;
        // R14/R58 via the one shared guard; see `wildlife_allowed`.
        let active = playing && self.wildlife_allowed();
        let step = self.birds.tick(map_w, active, now, dt);
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

    /// Walk the animals, and announce the ones that arrived or left (T20.10).
    ///
    /// The bird function's shape, with one difference stated in `animals.rs`: an
    /// animal owns a `Body` and goes through `integrate`, so its position is
    /// simulated rather than sampled. Movement is broadcast at `SNAPSHOT_HZ` for
    /// the same reason everything else is.
    fn step_animals(&mut self, now: f32, dt: f32, playing: bool) {
        // R14/R58 via the one shared guard; see `wildlife_allowed`. Computed
        // before the borrow below, which holds `&self.map`.
        let active = playing && self.wildlife_allowed();
        let step = {
            let map = &self.map;
            let gravity = self.gravity;
            self.animals.tick(map, active, gravity, now, dt)
        };
        let tick = self.tick;

        for id in &step.spawned {
            let Some(a) = self.animals.get(*id) else {
                continue;
            };
            self.events.push(GameEvent::AnimalSpawn {
                tick,
                id: *id,
                kind: a.kind.to_u8(),
                x: a.pos().x,
                y: a.pos().y,
                right: a.facing_right(),
            });
        }
        // Fell out of the world. `killed: false` — nothing drops, and the client
        // must not spray gore for an animal that simply left.
        for id in &step.gone {
            self.events.push(GameEvent::AnimalDespawn {
                tick,
                id: *id,
                killed: false,
            });
        }

        let every = (crate::constants::SIM_HZ / crate::constants::SNAPSHOT_HZ).max(1);
        if tick.is_multiple_of(every) {
            let moves: Vec<GameEvent> = self
                .animals
                .iter()
                .map(|a| GameEvent::AnimalMove {
                    tick,
                    id: a.id,
                    x: a.pos().x,
                    y: a.pos().y,
                    right: a.facing_right(),
                })
                .collect();
            self.events.extend(moves);
        }
    }

    fn apply_inputs(&mut self, now: f32, dt: f32) {
        // **T22.10F (coordinator ruling R89): every live player is simulated
        // exactly one step every tick** — the next input if it has arrived, else a
        // *stand-in* — and never more than one.
        //
        // One input is worth one tick (`docs/70-amendments-v2.md` §A30: applying
        // every queued input with a full `dt` made packet rate a speed multiplier,
        // 2.06× measured). What replaced T22.10D/E's catch-up credit is the other
        // half of the same sentence: **one tick is worth one input.** The credit
        // let a tick run two inputs to drain a burst, and three reviews each found
        // a new failure of it — a 2× dash paid for by a bank, and a burst split
        // across two ticks left standing at 13 inputs (~217 ms) forever — while a
        // player whose inputs stopped was not integrated at all: no gravity, no
        // field, hanging in the air on every other screen (a lag-switch hover).
        //
        // The model, per player, in a phase that takes input:
        // - an **expected seq** advances by one every simulated tick: the last
        //   simulated seq is `prev_input`'s, and it is the snapshot's ack;
        // - an input at or below it arrives after its tick already happened (a
        //   stand-in ran it) and is discarded — after `queue_input` has recorded
        //   it as the newest held state, so the next stand-in steers by it;
        // - inputs above it wait in `pending`, a jitter buffer of at most
        //   `INPUT_BACKLOG_TARGET` after the tick: an excess is the **oldest**
        //   dropped and the expected seq jumps past them — one bounded correction
        //   after a hitch, never a standing delay and never two steps in a tick;
        // - with nothing queued, a **stand-in**: the newest input's held buttons
        //   and aim under the next seq. Every edge (`input::edges`: jump press and
        //   release) is `current` against `prev`, so a repeated held input cannot
        //   fire one twice; `fire`, `use_item` and `select_slot` are commands, not
        //   buttons, and a stand-in never issues them.
        //
        // A stand-in claims the next seq only while it is within
        // `MAX_FRAME_TICKS` of the newest seq the player has sent, and never
        // before the first: past that the client has lost time (a hidden tab's
        // frames are capped at `MAX_FRAME_DT`), its seqs will never catch the
        // server's, and a claimed seq would discard every input it sends from
        // then on. The body still steps — the seq just stops running ahead — so
        // the client's next frame (at most `MAX_FRAME_TICKS` inputs) lands on or
        // past the expected seq. Said here because R89 does not say it: it is
        // the one place this departs from "advances by one every simulated tick".
        //
        // **T22.10G — the buffer R89 asked for, and the body before its first
        // input.** T22.10F ran a client's first input on the tick it arrived: zero
        // lead, so every later input had to beat its own tick and any jitter at
        // all was a stand-in (57 % of `teleport`'s ticks on a 59 fps page). Now
        // the expected seq starts at **newest − `INPUT_BACKLOG_TARGET`**: a
        // client's first input waits `INPUT_BACKLOG_TARGET` ticks (`input_wait`)
        // unless more than that many are already queued, which is the trim below
        // — and a trim runs newest − target and keeps the target, so it re-sets
        // the same lead. A stand-in then needs a gap longer than the lead (~33 ms).
        //
        // Before its first input a player is **not stepped** while the phase is
        // `Lobby` or `Warmup` — the pre-T22.10F behaviour, and what the client
        // predicts: it runs its first seq from the spawn it was handed, so a server
        // that had stepped the body meanwhile corrected every ack-0 snapshot (80
        // corrections in the T22.10F review, a space body drifting to its rock).
        // Bounded: joins are refused mid-match (§E4), so every join waits out at
        // most the warmup; in `Playing` a player still silent — never sent, or
        // inside its first input's wait — is stepped a neutral tick claiming no
        // seq, so nobody hangs in the air mid-round (T22.10F's point).
        self.pending.sort_by_key(|(id, inp)| (*id, inp.seq));
        let mut queued = std::mem::take(&mut self.pending);
        let mut this_tick: Vec<(PlayerId, Input)> = Vec::new();
        let seating = matches!(self.phase, RoundPhase::Lobby | RoundPhase::Warmup);
        if self.phase.accepts_input() {
            for &(id, prev) in &self.prev_input {
                let newest = self
                    .newest_input
                    .iter()
                    .find(|(i, _)| *i == id)
                    .map_or(prev, |(_, v)| *v);
                let mut mine: Vec<Input> = queued
                    .iter()
                    .filter(|(i, v)| *i == id && v.seq > prev.seq)
                    .map(|(_, v)| *v)
                    .collect();
                let excess = mine.len().saturating_sub(INPUT_BACKLOG_TARGET + 1);
                mine.drain(..excess);
                let waiting = match self.input_wait.iter_mut().find(|(i, _)| *i == id) {
                    Some((_, w)) if *w > 0 && mine.len() <= INPUT_BACKLOG_TARGET => {
                        *w -= 1;
                        true
                    }
                    Some((_, w)) => {
                        *w = 0;
                        false
                    }
                    None => false,
                };
                if newest.seq == 0 || waiting {
                    if !seating {
                        this_tick.push((id, Input::new(prev.seq, 0, prev.aim)));
                    }
                    self.pending.extend(mine.into_iter().map(|v| (id, v)));
                    continue;
                }
                let input = if mine.is_empty() {
                    let claims = newest.seq > 0 && prev.seq < newest.seq + MAX_FRAME_TICKS as u32;
                    let seq = if claims { prev.seq + 1 } else { prev.seq };
                    Input::new(seq, newest.buttons, newest.aim)
                } else {
                    mine.remove(0)
                };
                this_tick.push((id, input));
                self.pending.extend(mine.into_iter().map(|v| (id, v)));
            }
        } else {
            // **T21.30: once the round is over, input does nothing — but gravity
            // does.** Everything queued is dropped rather than kept, or it would
            // be applied the moment the next round starts, and every alive player
            // gets a **neutral** tick under the last simulated seq, so the ack
            // stands still (the client's results screen keys on the tick,
            // T22.10E F-3). The stand-in rule above is for a phase that takes
            // input; this is the neutral tick it would otherwise be.
            //
            // Through the same loop below, not a second integration path, so the
            // mount rule, the fall and the aim are treated exactly as on any tick.
            queued.clear();
            this_tick = self
                .players
                .iter()
                .filter(|p| p.alive)
                .map(|p| {
                    let seq = self.last_simulated_seq(p.id).unwrap_or(0);
                    (p.id, Input::new(seq, 0, p.aim))
                })
                .collect();
        }
        drop(queued);

        // Collected rather than applied in the loop: `apply_damage_log` takes
        // `&mut self` and the loop holds a `&mut` borrow of one player.
        let mut falls: Vec<(PlayerId, f32)> = Vec::new();
        for (id, input) in this_tick {
            let Some(idx) = self.players.iter().position(|p| p.id == id) else {
                continue;
            };
            if !self.players[idx].alive {
                // Dead, the tick still happens to the input stream: the seq
                // advances (so a respawn does not face a queue of inputs sent
                // while dead) and the body does not move.
                if let Some(slot) = self.prev_input.iter_mut().find(|(i, _)| *i == id) {
                    slot.1 = input;
                }
                continue;
            }
            let prev = self
                .prev_input
                .iter()
                .find(|(i, _)| *i == id)
                .map(|(_, v)| *v)
                .unwrap_or_default();
            // **The one derivation, and the mirror calls the same function**
            // (T21.02). It was `speed_multiplier()` — a bare `f32` the client
            // was free to supply a literal for, which is exactly what it did for
            // fifteen milestones until T20.19.
            // **The mount rule runs before `move_mods`, not after** (T21.11B).
            // `move_mods` reads `mount.mounted`, so stepping the mount after the
            // movement would apply this tick's lockout on the *next* tick — one
            // frame of a mounted player still walking, every single mount.
            self.step_mount(idx, &input, dt);
            let mods = self.players[idx].move_mods();
            // **The match's gravity, read from the world and not from the
            // player** (T22.02). Copied out before the `&mut self.players[idx]`
            // borrow below, which is also why it cannot simply be read at the
            // call: `GravityMode` is `Copy`, and this is the world's setting,
            // not a per-player modifier — `move_mods()` stays the one
            // derivation of what the *player* is carrying.
            let gravity = self.gravity;
            // **`Env` is built here, before the mutable player borrow**
            // (T22.11A, filled at T22.11B, `M22-RULINGS` R10 and R11). The
            // `let gravity = ...` line above already exists for exactly this
            // reason: the attractor sum needs the map's asteroid list *and* this
            // player's position, so this is the one point where both are visible
            // — one `Env` per player per tick.
            //
            // **`attractors::env_at` and not a composition spelled out here**,
            // because `GameCore::apply_input` has to produce the same value and a
            // second spelling is a second answer. Under `Standard` and `Low` it
            // still returns exactly `Env::field_free(gravity)`, which is what
            // makes this task a no-op for the game everyone else is playing.
            //
            // **This is also R8.4's named gate point, and T22.11B deliberately
            // does not gate here.** T21.30 froze *input* and kept physics
            // running — *"input does nothing — but gravity does"* — so in
            // `Ended` this line still runs with a neutral `Input` and the field
            // still pulls. R8.4 rules that the **black hole** must freeze then,
            // and names this construction (*"zero the `accel` when
            // `!self.phase.accepts_input()`"*) as the one place to do it. Nothing
            // rules that an **asteroid** well freezes, and one that did would
            // stop a body dead on the results screen for no reason a player could
            // read; in space there is no fall damage (R4), so a drift after the
            // bell costs nobody anything. So: no gate, said out loud rather than
            // omitted, and `T22.12` adds the condition here for its own
            // `Kind::BlackHole` when it lands.
            let (pulls, n) = vortex::centres(&self.vortices);
            let env = crate::world::attractors::env_at(
                &self.map,
                gravity,
                &pulls[..n],
                self.players[idx].body.pos,
            );
            let p = &mut self.players[idx];
            let impact = apply_input(
                &self.map,
                &mut p.body,
                &mut p.jump,
                &mut p.jetpack,
                &input,
                &prev,
                MoveStep { mods, env },
                dt,
            );
            // **The whole rule moved into `PlayerState::fall_damage`**
            // (T21.02). It was the threshold, the slope and `!was_knocked`
            // spelled out here; T20.11's exemption is unchanged inside it, and
            // the boots' scaled threshold joined it there rather than becoming a
            // second clause at this site — which is where the next fall-damage
            // site would drop one of them.
            //
            // The knockback half is still a window, so a blast that also drops
            // you off a **ledge** is not exempt from the ledge: the knockback
            // bought you 36 px of arc and the cliff gave you the other 250, and
            // by then the grace has expired on its own.
            // **`M22-RULINGS` R4 — no fall damage in space. There is no
            // fall.** Nothing accelerates a player downward, so every touchdown
            // is a drift into a rock at a speed the player chose themselves;
            // charging for it would make thrusting toward an asteroid a way to
            // hurt yourself, and `T22.03` explicitly does not get to invent
            // impact damage as the collision rule.
            //
            // **Gated here, at the site that owns the *effect*, and not by
            // zeroing the impact inside `integrate`.** `apply_input`'s doc
            // states the split: the leaf *measures* the landing and this layer
            // *applies* it, because only this layer can see the match. Zeroing
            // the measurement would make `landing_impact` mean two things — how
            // hard you hit, and what mode you are in — and the next reader of it
            // (an animation, a sound) would get the mode's answer.
            let hurt = if gravity == GravityMode::Space {
                0.0
            } else {
                p.fall_damage(impact, now)
            };
            if hurt > 0.0 {
                falls.push((id, hurt));
            }
            p.aim = input.aim;
            if let Some(slot) = self.prev_input.iter_mut().find(|(i, _)| *i == id) {
                slot.1 = input;
            }
        }

        // **Through `apply_damage_log`, not through `p.health -=`** — that is the
        // one warmup gate (`docs/41` §3), and it is also what buys the `Damage`
        // event, the i-frame check, the shield and the death bookkeeping. A
        // subtraction here would be the only damage in the game that skipped all
        // of it, which is the shape §E13's poison is written the long way to
        // avoid two hundred lines above.
        if !falls.is_empty() {
            let log: DamageLog = Default::default();
            {
                let mut entries = log.borrow_mut();
                for (id, amount) in falls {
                    entries.push((id, amount, DamageSource::Fall));
                }
            }
            let bird_log: BirdLog = Default::default();
            let animal_log: AnimalLog = Default::default();
            self.apply_damage_log(&log, &bird_log, &animal_log, now);
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
        let impacts =
            self.projectiles
                .step(&self.map, &boxes, &birds, self.wind, self.gravity, now, dt);

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
            let animal_log: AnimalLog = Default::default();
            let (mut closures, meta, mut scratch_vels) = hit_targets(
                &self.players,
                &self.birds,
                &self.animals,
                &log,
                &bird_log,
                &animal_log,
                now,
            );
            let (result, fragments) = {
                let mut t = targets(&mut self.players, &mut closures, &meta, &mut scratch_vels);
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
            self.apply_damage_log(&log, &bird_log, &animal_log, now);
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
            let animal_log: AnimalLog = Default::default();
            let impact = {
                let (mut closures, meta, mut scratch_vels) = hit_targets(
                    &self.players,
                    &self.birds,
                    &self.animals,
                    &log,
                    &bird_log,
                    &animal_log,
                    now,
                );
                let mut t = targets(&mut self.players, &mut closures, &meta, &mut scratch_vels);
                crate::weapons::bullet::resolve(&mut self.map, &mut t, w, at, victim, source)
            };
            self.apply_damage_log(&log, &bird_log, &animal_log, now);
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
                let animal_log: AnimalLog = Default::default();
                let (mut closures, meta, mut scratch_vels) = hit_targets(
                    &self.players,
                    &self.birds,
                    &self.animals,
                    &log,
                    &bird_log,
                    &animal_log,
                    now,
                );
                let result = {
                    let mut t = targets(&mut self.players, &mut closures, &meta, &mut scratch_vels);
                    explode(&mut self.map, &mut t, at, w.blast_radius, w.damage, source)
                };
                self.note_knocked(&result.knocked, now);
                self.emit_blast(at, w.blast_radius, CarveKind::Weapon, &result.carve, now);
                self.apply_damage_log(&log, &bird_log, &animal_log, now);
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
        let animal_log: AnimalLog = Default::default();
        let mut shots = Vec::new();
        {
            let (mut closures, meta, mut scratch_vels) = hit_targets(
                &self.players,
                &self.birds,
                &self.animals,
                &log,
                &bird_log,
                &animal_log,
                now,
            );
            let mut t = targets(&mut self.players, &mut closures, &meta, &mut scratch_vels);
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
        self.apply_damage_log(&log, &bird_log, &animal_log, now);

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
            self.drop_wildlife_loot(item_id, kill.at, now);
        }
    }

    /// What a killed animal leaves, through the **same** drop as a bird's.
    ///
    /// Separate from `resolve_bird_kills` because the kind→item table is the only
    /// thing that differs and `BirdKind`/`AnimalKind` are different enums — but
    /// the *drop* is shared, which is the half that carries a guard. See
    /// `drop_wildlife_loot`.
    fn resolve_animal_kills(&mut self, log: &[(AnimalId, f32)], now: f32) {
        if log.is_empty() {
            return;
        }
        for kill in self.animals.apply_damage(log) {
            let tick = self.tick;
            self.events.push(GameEvent::AnimalDespawn {
                tick,
                id: kill.id,
                killed: true,
            });
            let item_id = match kill.kind {
                AnimalKind::Spider => crate::items::registry::MEDKIT,
                AnimalKind::Beetle => crate::items::registry::BATTERY_PACK,
            };
            self.drop_wildlife_loot(item_id, kill.at, now);
        }
    }

    /// Put one item on the ground where a bird or an animal died.
    ///
    /// **Shared, and the task asked which of the two it would be** (T20.10): the
    /// *function*, not just the guard. The guard is the `make_room()` **before**
    /// `spawn` — at `MAX_WORLD_ITEMS` the spawn is the one thing that pushes the
    /// world over its cap, and `cull` only enforces `len <= MAX`, so it has
    /// nothing to do when you are exactly at it. A second loot function written
    /// beside this one would be the place that guard gets dropped, and the
    /// symptom — one silently missing drop at a cap nobody reaches in a test —
    /// is the kind nothing catches.
    fn drop_wildlife_loot(&mut self, item_id: ItemId, at: Vec2, now: f32) {
        let tick = self.tick;
        if let Some(evicted) = self.items.make_room() {
            self.events.push(GameEvent::ItemDespawn {
                tick,
                world_item_id: evicted,
            });
        }
        let id = self.items.spawn(
            item_id,
            1,
            at,
            Vec2::new(0.0, crate::constants::BIRD_DROP_VELOCITY),
            SpawnSource::Periodic,
            now,
        );
        self.events.push(GameEvent::ItemSpawn {
            tick,
            world_item_id: id,
            item_id,
            count: 1,
            x: at.x,
            y: at.y,
            source: SpawnSource::Periodic,
        });
    }

    /// Drain both logs: players, and the birds §C16 lets every weapon hit.
    ///
    /// **One function, two logs, and the signature is why.** Nine call sites
    /// damage things; a bird log they each had to remember to drain is a bird log
    /// most of them would forget, and the failure would be silent — a bird that
    /// absorbs a rocket and flies on. Taking it as a parameter makes forgetting a
    /// compile error.
    fn apply_damage_log(
        &mut self,
        log: &DamageLog,
        bird_log: &BirdLog,
        animal_log: &AnimalLog,
        now: f32,
    ) {
        let entries = std::mem::take(&mut *log.borrow_mut());
        let bird_entries = std::mem::take(&mut *bird_log.borrow_mut());
        let animal_entries = std::mem::take(&mut *animal_log.borrow_mut());
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
        // And the animals, on identical terms — same gate, same drop (T20.10).
        self.resolve_animal_kills(&animal_entries, now);

        let suit = self.gravity.wears_suit();
        for (victim, amount, src) in entries {
            let tick = self.tick;
            let Some(p) = self.players.iter_mut().find(|p| p.id == victim) else {
                continue;
            };
            // T21.01 needs two facts about the victim, and both have to be taken
            // inside this borrow.
            let health_before = p.health;
            if !p.apply_damage(amount, src, now, suit) {
                continue;
            }
            // R75: only what *landed* names the cause — an entry refused by
            // spawn i-frames must not label a death that something else causes.
            if src == DamageSource::Radiation {
                self.irradiated_this_tick.push(victim);
            }
            // **What landed, not what was rolled.** `apply_damage` scales the hit
            // by the victim's generator, so this is the health that actually came
            // off — the only number a "1 hp per 10 damage" rule can honestly be a
            // fraction of, and the difference is exactly the case the brief calls
            // out. Read off the field rather than returned: `apply_damage`'s
            // `bool` has four other callers (two in the wasm sandbox, two weather
            // paths) and widening it would touch every one of them for a value
            // only this caller wants.
            let landed = health_before - p.health;
            let victim_shielded = p.holds_shield_generator();
            let (attacker, cause) = match src {
                DamageSource::Player { id, .. } => (Some(id), DeathCause::Player(id)),
                DamageSource::SelfInflicted { .. } => (Some(victim), DeathCause::SelfInflicted),
                DamageSource::Weather(_) => (None, DeathCause::Weather),
                // The `Damage` **event**'s attribution. A fall is always your own
                // doing as far as this event is concerned; whether the *death* is
                // credited to you or to whoever put you in the air is decided by
                // `apply_damage`'s precedence rule and `killer()`, not here.
                DamageSource::Fall => (Some(victim), DeathCause::SelfInflicted),
                // Nobody's, like the weather — but its own name (R20).
                DamageSource::Radiation => (None, DeathCause::Radiation),
            };
            // Vampire fangs (T21.01). **Here, and not in `apply_damage`**:
            // that is a method on the victim's own `PlayerState` and has no way
            // to reach the attacker, so healing one player out of another's
            // damage needs the layer that owns both — this one. It also puts the
            // effect behind the warmup gate at the top of this function by
            // construction, which a rule written at the weapon would not be.
            //
            // Ordered **before** `resolve_deaths`, which runs later in the tick,
            // so an attacker who was already dead when this entry was logged is
            // still `!alive` here and `steal_life` refuses them.
            if let Some(a) = lifesteal_attacker(src, victim) {
                if let Some(att) = self.players.iter_mut().find(|p| p.id == a) {
                    att.steal_life(landed, victim_shielded);
                }
            }
            // **The event carries `landed` too** (T22.08C F4). It carried the
            // rolled `amount`, so under the suit or a generator the number over
            // your head said 8 when 6 came off. Every consumer was read first and
            // none wants the roll: the client's damage number and vignette
            // (`feelLayer`), the balance and bot reports' "damage dealt", the
            // radiation report. Lifesteal already used `landed`, above.
            let effect = match src {
                DamageSource::Weather(k) => Some(k),
                _ => None,
            };
            self.events.push(GameEvent::Damage {
                tick,
                victim,
                attacker,
                amount: landed,
                cause,
                effect,
            });
        }
    }

    /// Mines fall, arm, trigger; ground fire burns and goes out; flames burn.
    fn step_placed(&mut self, now: f32, dt: f32) {
        let tick = self.tick;
        let log: DamageLog = Default::default();
        let bird_log: BirdLog = Default::default();
        let animal_log: AnimalLog = Default::default();
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
            let (mut closures, meta, mut scratch_vels) = hit_targets(
                &self.players,
                &self.birds,
                &self.animals,
                &log,
                &bird_log,
                &animal_log,
                now,
            );
            let mut t = targets(&mut self.players, &mut closures, &meta, &mut scratch_vels);
            let ended = self
                .mines
                .step(&mut self.map, &mut t, self.gravity, now, dt);
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
        self.apply_damage_log(&log, &bird_log, &animal_log, now);

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
            EffectKind::SolarFlare => {
                let (w, h) = (self.map.mask.w as f32, self.map.mask.h as f32);
                self.flare = Some((id, now, SolarFlare::new(seed, w, h)));
            }
        }
    }

    /// **Dev seam** (T22.10B): blow a meteor-sized hole through the space rim on
    /// the ray from the centre through `toward`, through the same blast a meteor
    /// strike emits — so the `carve` event reaches every client's mirror and the
    /// breach is found by the carve chokepoint like any other (R19). The vortex opens
    /// on the next step. Returns the rim point, or `None` off a space map.
    ///
    /// Only `session.rs`'s `debug_breach` verb calls it, and only on a
    /// `DEV_PROBE=1` server: `scripts/checks/breach-vortex.mjs` needs a breach in
    /// a real match, and aiming a bazooka through asteroids at a rim thicker than
    /// its crater is a check that tests the aim.
    #[doc(hidden)]
    pub fn dev_breach_toward(&mut self, toward: Vec2) -> Option<Vec2> {
        let geo = self.map.space_geometry()?;
        let (x, y) = geo.onto_rim(toward.x, toward.y);
        let r = crate::constants::METEOR_CARVE_R;
        let carve = self.map.carve_circle(x, y, r as i32);
        let at = Vec2::new(x as f32, y as f32);
        let now = self.round_time;
        self.emit_blast(at, r, CarveKind::Meteor, &carve, now);
        Some(at)
    }

    /// **Dev seam** (T22.10B), beside [`World::dev_breach_toward`]: put player `id`
    /// at rest **inward of the hole at `hole`**, 1.5 capture radii out or more, with
    /// a **clear straight run to the capture ring** — the shape of the 12-seed idle
    /// test, so `breach-vortex.mjs` measures the pull from a known start. The first
    /// cut placed the body behind an asteroid, which the pull then pressed it into
    /// for the whole run (measured: 27 px in 10 s). Candidates: 1.5, 1.75, … capture
    /// radii, each straight inward and then turned up to ±0.6 rad. Returns where, or
    /// `None` when nothing inside the reach has a clear run.
    #[doc(hidden)]
    pub fn dev_place_inward_of(&mut self, id: PlayerId, hole: Vec2) -> Option<Vec2> {
        let geo = self.map.space_geometry()?;
        let inward = (Vec2::new(geo.cx, geo.cy) - hole).normalized();
        let r = crate::constants::VORTEX_CAPTURE_R;
        let fits = |p: Vec2| {
            !crate::physics::collide::aabb_overlaps_solid(
                &self.map,
                crate::physics::body::Body::new(p).aabb(),
            )
        };
        let clear_run = |from: Vec2| {
            let span = (from - hole).len() - r;
            let steps = (span / 4.0).ceil().max(1.0) as i32;
            (0..=steps)
                .all(|i| fits(from + (hole - from).normalized() * (span * i as f32 / steps as f32)))
        };
        let at = (0..8)
            .flat_map(|i| {
                [0.0f32, 0.3, -0.3, 0.6, -0.6].map(|turn| {
                    let (s, c) = turn.sin_cos();
                    let dir = Vec2::new(inward.x * c - inward.y * s, inward.x * s + inward.y * c);
                    hole + dir * r * (1.5 + 0.25 * i as f32)
                })
            })
            .find(|&p| clear_run(p))?;
        let p = self.player_mut(id)?;
        p.body = crate::physics::body::Body::new(at);
        Some(at)
    }

    /// Test seam: start `kind` now, through the same install the scheduler uses.
    ///
    /// The sandbox's weather controls and the effect tests both need to say
    /// "rain, now" without waiting out `EFFECT_INTERVAL_MIN`.
    #[doc(hidden)]
    pub fn force_effect(&mut self, kind: EffectKind, now: f32) -> u32 {
        let id = self.effects.force(kind, now);
        let seed = self.effect_seed(id);
        // The scheduler's record says what was installed (T22.08D F4): the join
        // catch-up re-announces running effects from it.
        self.effects.record_seed(id, seed);
        self.install_effect(id, kind, seed, now);
        id
    }

    /// **Every running effect, as the events that announced it** (T22.08D F4): its
    /// `EffectStart` at the tick it started on, with the seed it was installed with,
    /// and — once it is `Active` — its `EffectPhaseChanged` at the tick that
    /// happened. For a socket that arrives while an effect runs: the join path sends
    /// these through the same serializer as the live events, so the client starts
    /// the effect through its one start path, origin and all.
    ///
    /// The ticks are **derived**, not stored: the scheduler keeps round times, and
    /// `tick` and `round_time` advance together in `step`, so a start `k` ticks ago
    /// is `round_time − started_at ≈ k·SIM_DT`. **Approximately, and measured**: `f32`
    /// rounds every `+= SIM_DT`, one way, so over an effect's life the two disagree by
    /// up to ~5 ms below 1024 s — under the half tick (8.3 ms) the rounding needs.
    /// Past 1024 s the spacing of `f32` is 1.2e-4 s and it would not be; a round
    /// cannot get there (`ROUND_SECONDS_MAX`). `running_effects_replay_the_live_announcements`
    /// counts both ends over a whole maximum round.
    pub fn running_effects(&self) -> Vec<GameEvent> {
        let ticks_ago =
            |at: f32| ((self.round_time - at) / crate::constants::SIM_DT).round() as u32;
        let mut out = Vec::new();
        for a in self.effects.active() {
            out.push(GameEvent::EffectStart {
                tick: self.tick.saturating_sub(ticks_ago(a.started_at)),
                id: a.id,
                kind: a.kind,
                seed: a.seed,
                duration: crate::effects::scheduler::active_duration(a.kind),
            });
            if a.phase == EffectPhase::Active {
                out.push(GameEvent::EffectPhaseChanged {
                    tick: self.tick.saturating_sub(ticks_ago(a.phase_started_at)),
                    id: a.id,
                    phase: a.phase,
                });
            }
        }
        out
    }

    /// The running flare's id and **the server's own elapsed** — `now − start`, the
    /// very number stage 5's contact test hands `SolarFlare::touches`. For the
    /// `DEV_PROBE` hook (T22.08D F1), so a check compares a client's clock against
    /// the server's rather than against itself.
    pub fn flare_elapsed(&self) -> Option<(u32, f32)> {
        self.flare
            .as_ref()
            .map(|(id, start, _)| (*id, self.round_time - start))
    }

    /// Test seam: the vents the *installed* lava burst is using.
    ///
    /// Exists so a test can compare what the server simulates against what it
    /// broadcast, which is the only way to catch a seed that disagrees with
    /// itself (T19.24).
    #[doc(hidden)]
    pub fn lava_vent_positions_for_test(&self) -> Vec<(i32, i32)> {
        self.lava
            .as_ref()
            .map(|(_, l)| {
                l.vents()
                    .iter()
                    .map(|v| (v.pos.x as i32, v.pos.y as i32))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The seed a forced effect is installed with.
    ///
    /// **One derivation, two readers** (T19.24). `force_effect` installs with
    /// this, and `WeatherMode::Always` has to *broadcast* it — those were two
    /// expressions of one number, and the second was the literal `0`. Nothing
    /// read the seed on the client until lava vents were derived from it, so the
    /// mismatch was inert; the moment it was read, `WEATHER=lava` would have
    /// simulated one set of vents and told every client about another. A private
    /// method rather than the expression twice, because a number that must agree
    /// in two places should exist in one.
    fn effect_seed(&self, id: u32) -> u64 {
        self.seed ^ (id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
    }

    /// The kind `weather_mode` forces on this map, or `None` — `Auto`, `Off`, or
    /// a force this map refuses (R83: a flare off a space map). **One rule, two
    /// readers**: `step_weather` forces with it, and the server's room warns when
    /// a configured `WEATHER=` comes back refused (T22.08C F7), which was
    /// otherwise silent.
    pub fn forced_effect(&self) -> Option<EffectKind> {
        match self.weather_mode {
            WeatherMode::Always(EffectKind::SolarFlare)
                if WeatherTable::of(&self.map) != WeatherTable::Space =>
            {
                None
            }
            WeatherMode::Always(kind) => Some(kind),
            _ => None,
        }
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
        // R83: a forced flare needs a space map — the same key the roll uses
        // (R78). Refused here rather than at the parser, which cannot see the
        // map: `WEATHER=flare` on a standard round forces nothing and leaves the
        // scheduler alone.
        let table = WeatherTable::of(&self.map);
        if let Some(kind) = self.forced_effect() {
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
                    // **The seed it was actually installed with**, not `0`
                    // (T19.24). See `effect_seed`.
                    seed: self.effect_seed(id),
                    duration: crate::effects::scheduler::active_duration(kind),
                });
            }
        }
        // `Off` skips the scheduler outright rather than pausing it: nothing can
        // have started, so there is no phase to advance and no end to deliver.
        let scheduled = match self.weather_mode {
            WeatherMode::Off => Vec::new(),
            _ => self.effects.tick(now, ends, table),
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
                    if self.flare.as_ref().is_some_and(|(i, ..)| *i == id) {
                        self.flare = None;
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

        // T22.08A: the flare **touches** here and burns in stage 8a2 (R81). A
        // touch writes the deadline (R79); only `Active` touches — a telegraph is
        // a warning. The living and not-yet-dying only, as 8c asks.
        // The effect stays `Active` for the burn's tail after the ribbon has gone
        // (F1); `SolarFlare::touches` is false then (`SolarFlare::lit`).
        if let Some((_, start, f)) = self.flare.as_ref() {
            if self.effects.is_active(EffectKind::SolarFlare) {
                let elapsed = now - start;
                for p in self.players.iter_mut().filter(|p| p.alive && !p.is_dying()) {
                    if f.touches(elapsed, p.body.pos, p.body.size.x, p.body.size.y) {
                        p.burn(now);
                    }
                }
            }
        }

        if let Some((eid, mut l)) = self.lava.take() {
            let log: DamageLog = Default::default();
            let bird_log: BirdLog = Default::default();
            let animal_log: AnimalLog = Default::default();
            let carves = {
                let (mut closures, meta, mut scratch_vels) = hit_targets(
                    &self.players,
                    &self.birds,
                    &self.animals,
                    &log,
                    &bird_log,
                    &animal_log,
                    now,
                );
                let mut tg = targets(&mut self.players, &mut closures, &meta, &mut scratch_vels);
                l.tick(&mut self.map, &mut tg, lava_on, now, dt)
            };
            self.apply_damage_log(&log, &bird_log, &animal_log, now);
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
        for i in 0..self.players.len() {
            if self.players[i].alive && self.is_in_the_void(&self.players[i]) {
                self.players[i].health = 0.0;
            }
        }
    }

    /// Whether this body is below the world (§C15).
    ///
    /// The same test `step_void` kills on, so `resolve_deaths` can name the cause
    /// **without a flag to keep in sync** — the position it is reading is the one
    /// that killed them, one pass earlier in the same tick, and nothing moves a
    /// dead body until it respawns. Derive, do not add a fourth flag.
    ///
    /// **In space, the void is also outside the rim** (`M22-RULINGS` R16, T22.10):
    /// breach the left, right or top arc and `clamp_to_world` would otherwise hold a
    /// living player outside the arena for the rest of the round. Past the outer edge
    /// by `SPACE_VOID_GRACE`, measured at the body's centre — the band a vortex has
    /// to catch you in first. **Every hole has one** (R88, T22.10C): a vortex the
    /// cap displaced stops pulling but keeps catching, so no hole in the rim is an
    /// exit to this. One predicate, so `step_void` and `resolve_deaths` still
    /// cannot disagree about who fell.
    fn is_in_the_void(&self, p: &PlayerState) -> bool {
        if p.body.head_y() > self.map.mask.h as f32 {
            return true;
        }
        self.map
            .space_geometry()
            .is_some_and(|geo| geo.in_the_void(p.body.pos.x, p.body.pos.y))
    }

    /// T22.10: open a vortex at every breach the carves made this tick, then take
    /// every player a vortex has caught.
    ///
    /// **The arrival is a teleport's in everything but the destination**
    /// (`fire_pads`): a fresh `Body`, the jump and jetpack reset with **fuel
    /// surviving the trip** (R9's addendum — a reset tank turned every pad into a
    /// refuelling station, and in a mode where fuel is the economy that is worse
    /// here), and `teleport::arrive` so a pad's arming rule sees the arrival. The
    /// destination is T22.05B's picker — the one answer to *"somewhere valid on this
    /// map"*, so a vortex cannot pop you inside rock.
    ///
    /// **T22.10C (`M22-RULINGS` R86): the capture ignores the teleport cooldown**,
    /// and the destination is chosen **clear of every hole's pull**
    /// (`vortex::clearance`, through `Map::random_body_site_where`). Reading the
    /// cooldown here let a vortex *decline* a player who had just used a pad or
    /// just been taken — and a declined player is pulled through the hole into the
    /// void, which is the one thing this feature exists to stop. The far
    /// destination is what prevents the loop the cooldown was guarding against.
    /// **A caught player is always taken**: the picker falls back to the site
    /// farthest from every hole, and only a map with no open space at all — which
    /// generation refuses (R17) and carving cannot make — returns nothing.
    fn step_vortices(&mut self, now: f32) {
        let tick = self.tick;
        for (x, y) in self.map.take_breaches() {
            let at = Vec2::new(x as f32, y as f32);
            if let vortex::Opened::New { id, replaced } =
                vortex::open(&mut self.vortices, &mut self.vortex_seq, at)
            {
                if let Some(old) = replaced {
                    // R88: it stops pulling and fades; its hole still catches.
                    self.events
                        .push(GameEvent::VortexClose { tick, id: old.id });
                    // T22.10D F11: once per hole, not once per displacement.
                    vortex::retire(&mut self.spent_vortices, old);
                }
                self.events.push(GameEvent::VortexOpen {
                    tick,
                    id,
                    x: at.x,
                    y: at.y,
                });
            }
        }
        if self.vortices.is_empty() && self.spent_vortices.is_empty() {
            return;
        }
        for i in 0..self.players.len() {
            let p = &self.players[i];
            if !p.alive {
                continue;
            }
            let Some(vid) = vortex::captor(&self.vortices, &self.spent_vortices, p.body.pos) else {
                continue;
            };
            let (pulling, spent) = (&self.vortices, &self.spent_vortices);
            let clear = |site: crate::math::Point| {
                let centre = surface_to_centre(Vec2::new(site.x as f32, site.y as f32));
                vortex::clearance(pulling, spent, centre)
            };
            let Some(site) = self.map.random_body_site_where(&mut self.vortex_rng, clear) else {
                continue;
            };
            let dest = surface_to_centre(Vec2::new(site.x as f32, site.y as f32));
            let p = &mut self.players[i];
            p.body = crate::physics::body::Body::new(dest);
            p.jump = crate::player::movement::JumpState::default();
            let fuel = p.jetpack.fuel;
            p.jetpack = crate::player::jetpack::JetpackState {
                fuel,
                ..Default::default()
            };
            teleport::arrive(&mut p.teleport, dest, now);
            let id = p.id;
            self.events.push(GameEvent::VortexTrip {
                tick,
                id,
                vortex: vid,
                x: dest.x,
                y: dest.y,
            });
        }
    }

    fn resolve_deaths(&mut self, now: f32) {
        // R75: taken, so the list cannot outlive the step that filled it.
        let irradiated = std::mem::take(&mut self.irradiated_this_tick);
        let mut drops: Vec<(Vec2, Vec<crate::items::inventory::Stack>)> = Vec::new();
        let mut credits: Vec<PlayerId> = Vec::new();
        let mut scored = false;

        for i in 0..self.players.len() {
            if self.players[i].is_dying() {
                // The void wins over any recent attacker as the *direct* cause;
                // `killer` still hands the credit to whoever put you there.
                let direct = if self.is_in_the_void(&self.players[i]) {
                    DeathCause::Void
                } else if irradiated.contains(&self.players[i].id) {
                    // After the void, before the attacker (R75). `killer`
                    // below still hands a recent shooter the credit.
                    DeathCause::Radiation
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
                    DeathCause::Weather | DeathCause::Void | DeathCause::Radiation => None,
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
            Self::issue_suit(self.gravity, &mut self.players[i]);
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
            // Wings refuse the pad (owner, 2026-09-16). Read from the inventory
            // here, where the player is, rather than plumbed through `MoveMods`:
            // `apply_input` never sees this, so it is not a prediction input and
            // it does not belong in the byte T20.19's rule governs.
            //
            // **The breach vortex takes wings, and that is not a contradiction**
            // (`M22-RULINGS` R9, point 1): a pad is something you *choose to use*;
            // a vortex is a thing that happens to you (`vortex::captor`).
            let eligible =
                !self.players[i].holds_utility(crate::items::registry::UtilityId::UnicornWings);
            let fired = teleport::step(
                &mut self.players[i].teleport,
                pads,
                pos,
                grounded,
                eligible,
                now,
                dt,
            );
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
        // T21.30. Asked here as well as in `inventory_actor` because the
        // platform branch below does not go through it — the same rule, read
        // from the same function, not a second copy of it.
        if !self.phase.accepts_input() {
            return Err(UseError::RoundOver);
        }
        // **A mounted player fires the platform, not their bag** (T21.11C).
        //
        // Routed here rather than at the caller because `fire` is the one verb
        // every trigger comes through — the server command, the bots and the
        // sandbox — and a branch in one of them would be a branch the other two
        // do not have. Your own weapons stay out of reach while mounted
        // (T21.11B): the platform gun spawns without touching the inventory, so
        // nothing here reads a slot.
        if let Some(platform) = self.players.iter().find(|p| p.id == id).and_then(|p| {
            if p.alive {
                p.mount.mounted
            } else {
                None
            }
        }) {
            return self.fire_platform(id, platform, now);
        }
        self.inventory_actor(id)?;
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
        // §C11 reaches into the bag from wherever the grenade happens to be, so
        // it is exactly the action the mount lockout is about (T21.11B).
        self.inventory_actor(id)?;
        let Some(idx) = self.players.iter().position(|p| p.id == id) else {
            return Err(UseError::Dead);
        };
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
                let animal_log: AnimalLog = Default::default();
                let result = {
                    let (mut closures, meta, mut scratch_vels) = hit_targets(
                        &self.players,
                        &self.birds,
                        &self.animals,
                        &log,
                        &bird_log,
                        &animal_log,
                        now,
                    );
                    let mut t = targets(&mut self.players, &mut closures, &meta, &mut scratch_vels);
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
                self.apply_damage_log(&log, &bird_log, &animal_log, now);
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
                    // **The shape `swing` dug, not one derived here.** A melee
                    // carve is a capsule swept from the swinger's body edge to
                    // the tip, and publishing a circle at the tip instead is a
                    // silent mask divergence: the server digs one shape and every
                    // client applies another. That is exactly what happened when
                    // the carve became a capsule and this site was not changed
                    // with it.
                    let (mouth, tip, r) = result
                        .carve_shape
                        .expect("a carve without its geometry cannot be published");
                    self.carve_seq += 1;
                    let seq = self.carve_seq;
                    self.events.push(GameEvent::CarveCapsule {
                        tick,
                        seq,
                        x0: mouth.x.round() as i32,
                        y0: mouth.y.round() as i32,
                        x1: tip.x.round() as i32,
                        y1: tip.y.round() as i32,
                        r,
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
                let animal_log: AnimalLog = Default::default();
                let shots = {
                    let (mut closures, meta, mut scratch_vels) = hit_targets(
                        &self.players,
                        &self.birds,
                        &self.animals,
                        &log,
                        &bird_log,
                        &animal_log,
                        now,
                    );
                    let mut t = targets(&mut self.players, &mut closures, &meta, &mut scratch_vels);
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
                self.apply_damage_log(&log, &bird_log, &animal_log, now);

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
        let r = self.inventory_actor(id)?.use_item(slot, now);
        if r.is_ok() {
            self.events.push(GameEvent::Inventory {
                tick,
                player_id: id,
            });
        }
        r
    }

    /// Fire one round from a gun platform — one shot of a held stream (T21.43).
    ///
    /// *"Click and hold to auto fire like a machine gun."* A click is one call
    /// and one round; holding is the client repeating the call at
    /// `GUN_PLATFORM_FIRE_INTERVAL`, exactly as every automatic in the bag is
    /// held (`WeaponDef::is_auto`, `client/src/input/autoFire.ts`). The server
    /// keeps no "held" bit: its per-platform clock is the authority on cadence,
    /// so a spam-clicker and a holder fire at the same rate. It replaced
    /// T21.11C's four-round volley.
    ///
    /// **Cross-tick state, on the world beside the magazine**: `platform_ready_at`
    /// (the next-shot timer) and `platform_barrel` (which barrel fires next).
    /// Both are per platform, so a second rider picks up the stream where the
    /// first left it, and both are in `state_hash`.
    ///
    /// **One tick of grace, and only backwards.** The next shot is due
    /// `GUN_PLATFORM_FIRE_INTERVAL` after the *later* of when the last one was
    /// due and one tick ago. A repeat that arrives a tick late therefore does not
    /// push the whole stream a tick later, which is what network jitter between
    /// two client repeats would otherwise do; and a caller firing on every tick
    /// still settles at one round per interval, because the credit never exceeds
    /// one tick. The half tick on the comparison absorbs `round_time`'s float
    /// accumulation, so a shot due on a tick is not refused by rounding.
    ///
    /// **The barrels are fixed offsets, not draws** — the reason T21.11C gave for
    /// its fan still holds: `muzzle_angle` would put the gun's pattern in the
    /// same RNG stream as the item spawns and the weather.
    ///
    /// The muzzle is the **platform's**, because a mounted player does not move;
    /// the aim is still theirs.
    fn fire_platform(&mut self, id: PlayerId, platform: u8, now: f32) -> Result<(), UseError> {
        use crate::constants::{
            GUN_PLATFORM_BARRELS, GUN_PLATFORM_BARREL_GAP, GUN_PLATFORM_BARREL_SPREAD,
            GUN_PLATFORM_FIRE_INTERVAL, SIM_DT,
        };
        let i = platform as usize;
        if !self.platform_ready(platform, now) {
            return Err(UseError::OnCooldown);
        }
        let due = *self.platform_ready_at.get(i).unwrap_or(&f32::INFINITY);
        let left = *self.platform_ammo.get(i).unwrap_or(&0);
        if left == 0 {
            // **Empty is empty** — the platform keeps its collision, its cover
            // and its rider, and does nothing. Named rather than silent, so the
            // client can say why (`docs/61` §3).
            return Err(UseError::NoAmmo);
        }

        let Some(idx) = self.players.iter().position(|p| p.id == id) else {
            return Err(UseError::Dead);
        };
        let aim = crate::player::input::Input::new(0, 0, self.players[idx].aim).aim_angle();
        let hub = match self.map.meta.gun_platforms.get(i) {
            // A feet line, so the muzzle sits at the housing rather than in the
            // rock: the same fraction of the art the renderer draws the hub at.
            Some(g) => Vec2::new(
                g.pos.x as f32,
                g.pos.y as f32 - crate::constants::GUN_PLATFORM_W as f32 * 0.5,
            ),
            None => return Err(UseError::BadSlot),
        };

        // The next barrel in turn. `lane` is -1, 0, +1 for three barrels, so the
        // stream is centred on the aim both in heading and in muzzle position.
        let barrel = self.platform_barrel.get(i).copied().unwrap_or(0) % GUN_PLATFORM_BARRELS;
        let lane = barrel as f32 - (GUN_PLATFORM_BARRELS - 1) as f32 / 2.0;
        let across = Vec2::new(-aim.sin(), aim.cos());
        let origin = hub + across * (lane * GUN_PLATFORM_BARREL_GAP);
        let heading = aim + lane * GUN_PLATFORM_BARREL_SPREAD;

        let tick = self.tick;
        let pid = self
            .projectiles
            .spawn(WEAPON_PLATFORM_GUN, id, origin, heading, now);
        if let Some(p) = self.projectiles.get(pid) {
            let (x, y, vx, vy) = (p.pos.x, p.pos.y, p.vel.x, p.vel.y);
            self.events.push(GameEvent::ProjectileSpawn {
                tick,
                id: pid,
                weapon: WEAPON_PLATFORM_GUN,
                owner: id,
                x,
                y,
                vx,
                vy,
            });
        }
        // One round, one bullet. `left > 0` was checked above, so this cannot wrap.
        self.platform_ammo[i] = left - 1;
        self.platform_barrel[i] = (barrel + 1) % GUN_PLATFORM_BARRELS;
        self.platform_ready_at[i] = due.max(now - SIM_DT) + GUN_PLATFORM_FIRE_INTERVAL;
        Ok(())
    }

    /// May this platform fire a round at `now`? (T21.43)
    ///
    /// **The one copy of the platform's clock.** `fire_platform` refuses on it and
    /// a riding bot asks it before pressing, so the two cannot drift into a bot
    /// that presses on ticks the platform refuses. Half a tick of slack absorbs
    /// `round_time`'s float accumulation — see `fire_platform`. An id that is not
    /// a platform is never ready.
    pub fn platform_ready(&self, platform: u8, now: f32) -> bool {
        self.platform_ready_at
            .get(platform as usize)
            .is_some_and(|due| now + crate::constants::SIM_DT * 0.5 >= *due)
    }

    /// Rounds left in a platform, or `None` for an id that is not one.
    pub fn platform_ammo(&self, platform: u8) -> Option<u16> {
        self.platform_ammo.get(platform as usize).copied()
    }

    /// Is anybody riding this platform? (T21.11B)
    ///
    /// **Derived by scanning the players, not kept as an array on the world.**
    /// The mount already lives on the player because it is per-life state that
    /// `respawn` clears; a second record of the same fact is the third flag this
    /// project keeps paying for, and it would be the one that goes stale when a
    /// player disconnects mid-round.
    pub fn platform_occupant(&self, platform: u8) -> Option<PlayerId> {
        self.players
            .iter()
            .find(|p| p.alive && p.mount.mounted == Some(platform))
            .map(|p| p.id)
    }

    /// One tick of T21.11B's mount rule for one player.
    ///
    /// The decision is `world::mount::step`'s; what lives here is the part a
    /// player's own state cannot answer — whether the platform they just
    /// finished charging is already taken.
    fn step_mount(&mut self, idx: usize, input: &crate::player::Input, dt: f32) {
        // **Wings refuse the platform** (owner, 2026-09-16: *"you cannot interact
        // with teleports and machinegun platforms if wearing them"*).
        //
        // Expressed as "there is no platform under you" rather than as a guard on
        // the mount arm, because that is the one input `mount::step` already
        // routes **both** decisions through: a winged player cannot mount, and a
        // mounted player who picks wings up is displaced-and-dismounted by the
        // `under != Some(id)` branch that T21.14 added. One veto, both directions,
        // no second rule to keep in step with the first.
        let under =
            if self.players[idx].holds_utility(crate::items::registry::UtilityId::UnicornWings) {
                None
            } else {
                crate::world::mount::platform_underfoot(
                    &self.map.meta.gun_platforms,
                    self.players[idx].body.pos,
                )
            };
        let jump_held = input.held(crate::player::button::JUMP);
        let grounded = self.players[idx].body.grounded;
        let ev =
            crate::world::mount::step(&mut self.players[idx].mount, under, jump_held, grounded, dt);
        match ev {
            crate::world::mount::MountEvent::Nothing => {}
            crate::world::mount::MountEvent::WantsMount(platform) => {
                // **One occupant at a time**, and it is decided here because
                // this is the only layer that can see the other players.
                if self.platform_occupant(platform).is_none() {
                    self.players[idx].mount.mounted = Some(platform);
                    self.players[idx].mount.target = None;
                }
                // If it was taken, the hold has already been reset by `step` —
                // so a second player waiting on an occupied platform re-charges
                // and takes it the moment the first gets off, rather than
                // mounting instantly on a stale hold.
            }
            crate::world::mount::MountEvent::WantsDismount(_) => {
                self.players[idx].mount.mounted = None;
                // Cleared, so releasing jump on the ground you are standing on
                // does not immediately re-charge the mount you just left.
                self.players[idx].mount.target = None;
            }
        }
    }

    /// The player, if they can reach their inventory right now (T21.11B).
    ///
    /// **This is the one rule, and it is a shared function rather than a shared
    /// guard.** The coordinator's ruling was *"mounting makes the inventory
    /// inaccessible, including health"* — one rule, not a list of banned keys.
    /// Every slotless action refuses because it comes through here, so `Q`, `R`,
    /// item use and slot select are covered by one line, and a sixth action
    /// added next milestone is covered on the day it calls this instead of on
    /// the day somebody remembers to add a check to it.
    ///
    /// The alternative — a `mounted` test at the top of each verb — is four
    /// copies of one invariant, which is precisely the arrangement
    /// `CLAUDE.md` names: *share the guard, or share the function*.
    fn inventory_actor(&mut self, id: PlayerId) -> Result<&mut PlayerState, UseError> {
        // T21.30: nothing in the bag is reachable once the round is over. Here,
        // because every slot verb — use, heal, battery, drop, select, drag and
        // the grenade throw — already comes through this one function.
        if !self.phase.accepts_input() {
            return Err(UseError::RoundOver);
        }
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return Err(UseError::Dead);
        };
        if !p.alive {
            return Err(UseError::Dead);
        }
        if p.mount.is_mounted() {
            // Named rather than swallowed: `docs/61` §3's rule is that the
            // server already knows which of the answers it was, and a player
            // pressing `Q` on a platform deserves to be told the bag is out of
            // reach rather than watching nothing happen.
            return Err(UseError::WrongKind);
        }
        Ok(p)
    }

    /// `Q` (§C9). The counters are not inventory, so no `Inventory` event —
    /// they ride in the snapshot, which is 20 Hz and always current.
    pub fn use_heal(&mut self, id: PlayerId) -> Result<(), UseError> {
        self.inventory_actor(id)?.use_heal()
    }

    /// `R` (§C9).
    pub fn use_battery_pack(&mut self, id: PlayerId) -> Result<(), UseError> {
        self.inventory_actor(id)?.use_battery_pack()
    }

    /// §C10's drag, validated. The client shows intent; this decides.
    ///
    /// Returns whether anything moved, so the caller can emit `inventory` only
    /// when it did — an event for a refused move would have the client render a
    /// state the server does not have.
    pub fn move_item(&mut self, id: PlayerId, from: u8, to: u8) -> bool {
        let tick = self.tick;
        let Ok(p) = self.inventory_actor(id) else {
            return false;
        };
        if !p.inventory.move_stack(from, to) {
            return false;
        }
        self.events.push(GameEvent::Inventory {
            tick,
            player_id: id,
        });
        true
    }

    /// Put the stack in `slot` on the ground at the player's feet (T20.09).
    ///
    /// Beside `move_item` and shaped like it: the client shows intent, this
    /// decides, and the `bool` says whether anything happened so the caller
    /// emits `inventory` only when it did.
    ///
    /// **The starting kit is refused through `STARTING_KIT`, not by naming the
    /// shovel.** `PlayerState::die` already filters on that list because "you
    /// always have one" and "it cannot be dropped or lost" are one rule (§F5);
    /// writing `item == SHOVEL` here would be identical today and divergent the
    /// day the kit grows, which §F7's `all` start kit makes a live possibility.
    ///
    /// Dropped straight down with no velocity, unlike a death scatter: a death
    /// throws a pile apart so it is readable, and a drop is a placement — an
    /// item that skittered away from where you put it would be a worse gesture
    /// than the one that does nothing.
    pub fn drop_item(&mut self, id: PlayerId, slot: u8) -> bool {
        let tick = self.tick;
        let now = self.round_time;
        // The one rule (T21.11B). `inventory_actor` takes `&mut self`, so the
        // reachability question is asked and answered before the read-only walk
        // below borrows the player again.
        if self.inventory_actor(id).is_err() {
            return false;
        }
        let Some(p) = self.players.iter().find(|p| p.id == id) else {
            return false;
        };
        // Read before taking: refusing after the stack is out of the inventory
        // means putting it back, and the put-back is the step a later edit
        // forgets.
        let Some(peek) = p.inventory.slot(slot) else {
            return false;
        };
        if crate::player::state::STARTING_KIT.contains(&peek.item) {
            return false;
        }
        let pos = p.body.pos;
        let Some(p) = self.players.iter_mut().find(|p| p.id == id) else {
            return false;
        };
        let Some(stack) = p.inventory.take_slot(slot) else {
            return false;
        };
        let world_item_id = self.items.spawn(
            stack.item,
            stack.count,
            pos,
            Vec2::ZERO,
            SpawnSource::Dropped,
            now,
        );
        self.events.push(GameEvent::ItemSpawn {
            tick,
            world_item_id,
            item_id: stack.item,
            count: stack.count,
            x: pos.x,
            y: pos.y,
            source: SpawnSource::Dropped,
        });
        self.events.push(GameEvent::Inventory {
            tick,
            player_id: id,
        });
        true
    }

    pub fn select_slot(&mut self, id: PlayerId, slot: u8) {
        let tick = self.tick;
        // Through the one rule (T21.11B), like every other slotless action.
        if let Ok(p) = self.inventory_actor(id) {
            if p.inventory.select(slot) {
                self.events.push(GameEvent::Inventory {
                    tick,
                    player_id: id,
                });
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

    /// The snapshot's darkness byte, and through it every client's lightmap and
    /// field of view.
    ///
    /// **T22.06: zero in space — there is no night in orbit.** Chosen, not left: the
    /// alternatives were a permanent night (a vision penalty the owner never asked
    /// for, on a map whose backdrop is already black) or the ground cycle carrying
    /// on under a sky that no longer shows it. The client derives the same zero at
    /// `sky-math.ts::sceneDarkness`, because its fallback reads a server `0` as
    /// "no byte yet" and substitutes its own clock.
    pub fn darkness(&self) -> f32 {
        if self.gravity == GravityMode::Space {
            return 0.0;
        }
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
        // **The asteroid table, because since `T22.11B` it decides where players
        // go** (`M22-RULINGS` R36). The mask carries a rock's *shape*; nothing but
        // these four numbers carries its *pull*, and `world::attractors` reads all
        // four — `level` for the strength and the reach, `x`/`y` for the centre,
        // `r` for nothing yet but for the escape ceiling's `d_min`.
        //
        // R36 was explicit that this is owed as a red-before-green rather than as
        // a line: `level` is in `tests/golden.rs::meta_digest`, so *generation*
        // drift was already caught, but a level differing between server and
        // client **at runtime** was invisible to the one guard that would localise
        // it — see
        // `attractors::tests::an_asteroid_that_differs_between_two_worlds_moves_the_state_hash`.
        // `replay.rs`'s argument for leaving `gravity` unhashed (*"a world that ran
        // under a different gravity diverges in `players`, which is hashed"*) does
        // not cover this: a table the two sides disagree about before tick one
        // diverges from tick one, and the hash exists to say *which* tick.
        //
        // Empty on every non-space map, so the length prefix is the only cost the
        // rest of the game pays.
        h.update(&(self.map.meta.asteroids.len() as u32).to_le_bytes());
        for a in &self.map.meta.asteroids {
            h.update(&a.x.to_le_bytes());
            h.update(&a.y.to_le_bytes());
            h.update(&a.r.to_le_bytes());
            h.update(&[a.level]);
        }
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

        // T20.10's animals, hashed for exactly the reason the birds above are:
        // killing one spawns an item, so a client whose animals have drifted will
        // disagree about what is on the ground. Velocity is included where a
        // bird's is not — an animal's position is *integrated*, so two worlds can
        // agree on where one is and disagree about where it is going.
        h.update(&(self.animals.len() as u32).to_le_bytes());
        for a in self.animals.iter() {
            h.update(&a.id.to_le_bytes());
            h.update(&[a.kind.to_u8()]);
            h.update(&a.body.pos.x.to_le_bytes());
            h.update(&a.body.pos.y.to_le_bytes());
            h.update(&a.body.vel.x.to_le_bytes());
            h.update(&a.body.vel.y.to_le_bytes());
            h.update(&a.health.to_le_bytes());
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
            // `flashlight_on` was hashed here and is gone (T20.07) — which is why
            // `REPLAY_VERSION` moved: `replay.rs`'s own rule is that a change an
            // old file would "load, run, and diverge silently" on is a bump, and a
            // recording of anyone who picked up a torch diverges at the first
            // checkpoint after the pickup. Carrying one is now read off the
            // inventory, which is already hashed below.
            h.update(&[
                p.alive as u8,
                p.jetpack.active as u8,
                p.jetpack.locked_out as u8,
            ]);
            h.update(&p.jetpack.fuel.to_le_bytes());
            h.update(&p.jetpack.idle_ticks.to_le_bytes());
            h.update(&p.jetpack.ticks_since_jump.to_le_bytes());
            h.update(&p.jump.buffered_ticks.to_le_bytes());
            // `shield_until` was hashed here and is gone (T20.08) — the other half
            // of `REPLAY_VERSION` 5, shared with T20.07's `flashlight_on`. The
            // shield is derived from the inventory and the battery, both of which
            // are already hashed, so the hash lost nothing: it stopped hashing the
            // same fact twice.

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
            // T22.09A, `R74`. The radiation accumulator decides the tick a
            // radiation entry lands on, and so when someone dies of it.
            h.update(&p.radiation_exposure.to_le_bytes());
            // T22.08A, R79: the flare's burn and its accumulator, for the two
            // reasons above — a timer that deals damage, and the counter that
            // decides the tick it lands on.
            h.update(&p.burning_until.to_le_bytes());
            h.update(&p.burn_exposure.to_le_bytes());
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
            // §A34, T21.11B. Hashed for the same reason `teleport` above is:
            // this decides whether the next tick's input moves the player at
            // all. A replay whose hold had drifted by one tick would mount on a
            // different tick, and every hash before that would agree — the exact
            // shape §A34 exists to prevent. `REPLAY_VERSION` moves with it.
            // **Presence and id folded separately** (T21.14). `unwrap_or(255)`
            // collided with `mount::WIRE_MOUNTED`, which is also 255 — so
            // "unmounted" and "mounted, per the wire" hashed identically in the
            // one place built to detect divergence. Harmless today because a
            // server-side `mounted` is never 255, and precisely the trap to
            // leave for whoever next hashes a mirror-side world.
            h.update(&[
                u8::from(p.mount.mounted.is_some()),
                p.mount.mounted.unwrap_or(0),
                u8::from(p.mount.target.is_some()),
                p.mount.target.unwrap_or(0),
            ]);
            h.update(&p.mount.held.to_le_bytes());
            p.inventory.hash_into(&mut h);
        }

        // §A34, T21.11C. The magazine changes the simulation — an empty
        // platform spawns nothing — so a replay whose ammo had drifted would
        // diverge with every hash before it agreeing. `REPLAY_VERSION` 7 covers
        // this and T21.11B's mount state together; see the note there.
        h.update(&(self.platform_ammo.len() as u32).to_le_bytes());
        for (ammo, ready) in self.platform_ammo.iter().zip(&self.platform_ready_at) {
            h.update(&ammo.to_le_bytes());
            h.update(&ready.to_le_bytes());
        }
        // T21.43: the barrel a held stream fires next decides where the next
        // round leaves the muzzle, so it is state. `REPLAY_VERSION` 9.
        h.update(&(self.platform_barrel.len() as u32).to_le_bytes());
        h.update(&self.platform_barrel);

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

        // T22.10: the vortices pull and take, so they are state; their stream by
        // position, as `rng` is.
        h.update(&(self.vortices.len() as u32).to_le_bytes());
        for v in &self.vortices {
            h.update(&v.id.to_le_bytes());
            h.update(&v.pos.x.to_le_bytes());
            h.update(&v.pos.y.to_le_bytes());
        }
        h.update(&(self.spent_vortices.len() as u32).to_le_bytes());
        for v in &self.spent_vortices {
            h.update(&v.id.to_le_bytes());
            h.update(&v.pos.x.to_le_bytes());
            h.update(&v.pos.y.to_le_bytes());
        }
        h.update(&self.vortex_seq.to_le_bytes());
        let mut probe = self.vortex_rng.clone();
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

/// **T21.30 — nobody acts once the round is over.** Reported from play on
/// 2026-09-15: *"i can still move my character after the 'round over' is
/// displayed."*
///
/// Every test here runs the same thing twice, in `Playing` and in `Ended`, and
/// the `Playing` half is the control: an "input does nothing" assertion is
/// satisfied by a player who could never move, fire or use anything at all.
#[cfg(test)]
mod round_over_input {
    use super::*;
    use crate::constants::{MapScale, PLAYER_H, PLAYER_W, SIM_DT};
    use crate::items::registry::{max_stack, BAZOOKA, MEDKIT};
    use crate::player::{button, Input};

    /// One player carrying a bazooka (in hand) and a medkit, settled on the
    /// ground in `Playing`, then moved to `phase`.
    fn settled_in(phase: RoundPhase) -> World {
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        give(&mut w, 0, BAZOOKA, max_stack(BAZOOKA));
        give(&mut w, 0, MEDKIT, 1);
        wield(&mut w, 0, BAZOOKA);
        for seq in 0..120u32 {
            w.queue_input(0, Input::new(seq + 1, 0, 0));
            w.step(SIM_DT);
        }
        assert!(
            w.player(0).expect("ana").body.grounded,
            "the fixture never landed"
        );
        w.set_phase(phase);
        w.drain_events();
        w
    }

    #[test]
    fn held_input_moves_nobody_once_the_round_is_over() {
        let mut moved = Vec::new();
        for phase in [RoundPhase::Playing, RoundPhase::Ended] {
            let mut w = settled_in(phase);
            let start = w.player(0).expect("ana").body.pos;
            for i in 0..60u32 {
                w.queue_input(0, Input::new(1000 + i, button::RIGHT | button::JUMP, 0));
                w.step(SIM_DT);
            }
            let end = w.player(0).expect("ana").body.pos;
            moved.push(((end.x - start.x).abs(), (end.y - start.y).abs()));
        }
        let (playing, ended) = (moved[0], moved[1]);
        assert!(
            playing.0 > PLAYER_W,
            "the control: a second of RIGHT+JUMP in Playing moved {:.1} px",
            playing.0
        );
        assert!(
            ended.0 < 0.01 && ended.1 < 0.01,
            "a second of RIGHT+JUMP after the round ended moved the player {ended:?}"
        );
    }

    /// Fire, dig, use, drop, select, rearrange — driven through one list, the
    /// way `mounting_puts_every_slotless_action_out_of_reach` does it, so the
    /// next verb joins by being added here. Digging is a shot: every weapon
    /// carves (`weapons::defs::every_weapon_digs`), so a fired rocket aimed at
    /// the player's own feet is the dig.
    #[test]
    fn nothing_fires_digs_or_is_used_once_the_round_is_over() {
        type Verb = (&'static str, fn(&mut World) -> bool);
        let verbs: &[Verb] = &[
            ("fire (and the dig it makes)", |w| {
                if let Some(p) = w.player_mut(0) {
                    p.aim = crate::math::quantize_angle(std::f32::consts::FRAC_PI_2);
                }
                let before = w.projectiles.len();
                let now = w.round_time;
                let fired = w.fire(0, now).is_ok() && w.projectiles.len() > before;
                let mut dug = false;
                for i in 0..90u32 {
                    // Aim held at the feet, and a neutral body, so the rocket
                    // lands where it was pointed.
                    w.queue_input(
                        0,
                        Input::new(
                            2000 + i,
                            0,
                            crate::math::quantize_angle(std::f32::consts::FRAC_PI_2),
                        ),
                    );
                    w.step(SIM_DT);
                    dug |= w.drain_events().iter().any(|e| {
                        matches!(
                            e,
                            GameEvent::Carve {
                                kind: CarveKind::Weapon,
                                ..
                            }
                        )
                    });
                }
                fired && dug
            }),
            ("use_item", |w| {
                if let Some(p) = w.player_mut(0) {
                    p.health = crate::constants::BASE_HEALTH / 2.0;
                }
                let slot = w
                    .player(0)
                    .and_then(|p| p.inventory.iter().find(|(_, s)| s.item == MEDKIT))
                    .map(|(i, _)| i)
                    .expect("the fixture gave a medkit");
                let now = w.round_time;
                w.use_item(0, slot, now).is_ok()
            }),
            ("use_heal (Q)", |w| {
                // One heal to spend: a player spawns with none.
                if let Some(p) = w.player_mut(0) {
                    p.health = crate::constants::BASE_HEALTH / 2.0;
                    p.heals = 1;
                }
                w.use_heal(0).is_ok()
            }),
            ("drop_item", |w| {
                let slot = w
                    .player(0)
                    .and_then(|p| p.inventory.iter().find(|(_, s)| s.item == MEDKIT))
                    .map(|(i, _)| i)
                    .expect("the fixture gave a medkit");
                w.drop_item(0, slot)
            }),
            ("select_slot", |w| {
                let before = w.player(0).expect("ana").inventory.selected();
                let want = if before == 0 { 1 } else { 0 };
                w.select_slot(0, want);
                w.player(0).expect("ana").inventory.selected() == want
            }),
        ];
        for (name, verb) in verbs {
            let mut playing = settled_in(RoundPhase::Playing);
            assert!(
                verb(&mut playing),
                "the control: {name} did nothing in Playing"
            );
            let mut ended = settled_in(RoundPhase::Ended);
            assert!(
                !verb(&mut ended),
                "{name} still worked after the round ended"
            );
        }
    }

    /// The ruling's other half: input stops, gravity does not. A player in the
    /// air when the round ends lands — **with nothing queued**, which is what a
    /// client showing the results screen sends.
    #[test]
    fn a_player_airborne_when_the_round_ends_still_lands() {
        let mut w = settled_in(RoundPhase::Playing);
        if let Some(p) = w.player_mut(0) {
            p.body.pos.y -= PLAYER_H * 3.0;
            p.body.vel = Vec2::ZERO;
            p.body.grounded = false;
        }
        w.set_phase(RoundPhase::Ended);
        let start_y = w.player(0).expect("ana").body.pos.y;
        for _ in 0..240 {
            w.step(SIM_DT);
            if w.player(0).expect("ana").body.grounded {
                break;
            }
        }
        let p = w.player(0).expect("ana");
        assert!(
            p.body.grounded && p.body.pos.y > start_y + PLAYER_H,
            "a player three heights up when the round ended is still at y {:.1} \
             (started {start_y:.1}), grounded {}",
            p.body.pos.y,
            p.body.grounded
        );
    }
}

#[cfg(test)]
mod state_hash_tests {
    use super::*;
    use crate::constants::MapScale;

    fn world() -> World {
        let mut w = World::for_test_with_secret(4242, MapScale::Small, 7);
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

        // T22.09A, R74: the radiation accumulator.
        let mut w = world();
        w.players[0].radiation_exposure += 0.5;
        changed.push(("radiation_exposure", w.state_hash()));

        // T22.08A, R79: the flare's burn and its accumulator.
        let mut w = world();
        w.players[0].burning_until += 0.5;
        changed.push(("burning_until", w.state_hash()));
        let mut w = world();
        w.players[0].burn_exposure += 0.5;
        changed.push(("burn_exposure", w.state_hash()));

        let mut w = world();
        w.players[0].jetpack.fuel -= 0.5;
        changed.push(("jetpack fuel", w.state_hash()));

        let mut w = world();
        w.players[0].jetpack.locked_out = !w.players[0].jetpack.locked_out;
        changed.push(("jetpack lockout", w.state_hash()));

        // **The shield is not a hashed field any more** (T20.08). It was
        // `shield_until`; it is now "holds a generator and has charge", and both
        // of those are already hashed — the `inventory` case below, and the
        // `battery` case immediately here. The hash stopped carrying the same
        // fact twice.
        //
        // **That comment named `battery` before there was a case for it**, which
        // is precisely the gap this test exists to close: `state_hash` does cover
        // `p.battery` (`:3403`), but nothing in *this* list did, so half of the
        // shield's derived state could have been dropped from the hash with
        // nothing going red — and removing the `("shield", …)` case was argued on
        // the strength of that half-true sentence.
        let mut w = world();
        w.players[0].battery -= 1.0;
        changed.push(("battery", w.state_hash()));

        let mut w = world();
        w.players[0].iframes_until = 9.0;
        changed.push(("iframes", w.state_hash()));

        // T22.10: a vortex pulls and takes, so the list is state.
        let mut w = world();
        w.vortices.push(super::vortex::Vortex {
            id: 0,
            pos: Vec2::new(300.0, 200.0),
        });
        changed.push(("vortices", w.state_hash()));
        let mut w = world();
        w.spent_vortices.push(super::vortex::Vortex {
            id: 0,
            pos: Vec2::new(300.0, 200.0),
        });
        changed.push(("spent vortices", w.state_hash()));
        let mut w = world();
        w.vortex_seq = 5;
        changed.push(("vortex seq", w.state_hash()));

        let mut w = world();
        w.players[0].fire_ready_at = 9.0;
        changed.push(("cooldown", w.state_hash()));

        let mut w = world();
        w.players[0].knocked_until = 9.0;
        changed.push(("knockback grace", w.state_hash()));

        // **The flashlight is not a hashed field any more** (T20.07). It was
        // `flashlight_on`, a latch; carrying one is inventory state, and the
        // `inventory` case below already covers that — which is the point: the
        // hash lost nothing, it stopped hashing the same fact twice.

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
            animals: _,
            mines: _,
            burn: _,
            smoke: _,
            hazard_seq: _,
            spawn_schedule: _,
            effects: _,
            buried_items: _,
            // T21.11C. Both hashed: an empty platform spawns nothing and a
            // platform on cooldown spawns nothing this tick, so both decide the
            // simulation. See the fold in `state_hash`.
            platform_ammo: _,
            platform_ready_at: _,
            // T21.43. Hashed: it decides which barrel the next round leaves.
            platform_barrel: _,
            round_time: _,
            tick: _,
            phase: _,
            wind: _,
            rng: _,
            carve_seq: _,
            phase_started_at: _,
            round_seconds: _,
            // Set once at construction by a development switch and never written
            // again, like `weather_mode`. Not hashed, so a recorded replay's footer
            // does not move. What it changes, *when* `Playing` begins, is in the
            // hash through `phase` and `phase_started_at`.
            warmup_seconds: _,
            last_day_phase: _,
            toxic: _,
            meteor: _,
            lava: _,
            fog: _,
            // T22.08A: seed and start only, both the scheduler's (hashed) — the
            // ribbon is a pure function of them (`effects/flare.rs`).
            flare: _,
            // T22.10: the live vortices, the next id and the destination stream.
            vortices: _,
            spent_vortices: _,
            vortex_seq: _,
            vortex_rng: _,

            // Deliberately NOT hashed, each for a stated reason:
            // `seed` is an input, fixed for the round and carried in the replay
            // header — hashing it would only prove the header was read.
            seed: _,
            // `events` is drained every tick and delivered to clients; it is
            // output, not state, and two runs that produced identical state have
            // by construction produced identical events.
            events: _,
            // The input stream's bookkeeping (T22.10F): the jitter buffer, the
            // last simulated input and the newest sent. All three are a function
            // of the inputs and the ticks they arrived on, which the replay
            // records, and any divergence in them moves a body within a tick —
            // which *is* hashed.
            pending: _,
            prev_input: _,
            newest_input: _,
            input_wait: _,
            // `irradiated_this_tick` (T22.09A, R75) is filled and taken inside
            // one `step` and cleared at its top, so it is empty at every point a
            // hash is taken — `the_radiation_list_never_survives_a_step`.
            irradiated_this_tick: _,
            // `weather_mode` is a development switch set once at construction
            // and never written again (`WeatherMode`'s own doc says why it is
            // not in the replay header either). It is an input like `seed`: two
            // worlds that ran under different modes diverge in `effects`, which
            // *is* hashed, so hashing this as well would only prove the switch
            // was read.
            weather_mode: _,
            // `gravity` is the host's lobby choice, set once at construction and
            // never written again. It is an input like `seed`: it is carried in
            // the replay header, and two worlds that ran under different gravity
            // diverge in `players` — which *is* hashed — so hashing this as well
            // would only prove the setting was read, at the cost of moving every
            // checkpoint hash ever recorded.
            //
            // **That argument is only sound while the header carries it**, which
            // is `ReplayHeader::gravity` and `REPLAY_VERSION` 14. A future mode
            // switch that reached the world by any other route would need to be
            // hashed instead.
            gravity: _,
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
        let mut w = World::for_test(4242, MapScale::Small);
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
        let mut w = World::for_test(4242, MapScale::Small);
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
            gun_platforms: Vec::new(),
            surface_points: Vec::new(),
            objects: Vec::new(),
            buried_slots: Vec::new(),
            decorations: Vec::new(),
            wind: 0.0,
            traversable_fraction: 1.0,
            asteroids: Vec::new(),
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

    /// How many toxic drops are in the air at once, measured rather than assumed.
    ///
    /// **`TOXIC_DROPS_IN_FLIGHT` is a client-side number with a server-side
    /// meaning** (T20.05): §C6's particle emitter draws a fixed pool of 260
    /// screen-space droplets, and §C21 makes the real drops projectiles *so that
    /// the rain is visible*. Both clauses are live, and the shape that satisfies
    /// both is an emitter whose density is derived from the real rain. The
    /// derivation needs to know what a full-rate shower looks like, and the only
    /// honest source for that is this measurement — `TOXIC_DROP_SPEED`'s doc
    /// comment says "roughly a second of visible descent", which is a sentence,
    /// not a number.
    ///
    /// Across seeds and scales, because a population claim needs more than one
    /// draw. The assertion is a **band**, not the peak of one run: the constant
    /// has to be a fair description of a full-rate shower, and pinning it to a
    /// single seed's maximum would make it a fact about seed 4242.
    #[test]
    fn toxic_drops_in_flight_matches_what_a_shower_actually_puts_in_the_air() {
        let mut peaks = Vec::new();
        let mut ever_dry_mid_shower = false;
        for seed in [1u64, 4242, 90210] {
            for scale in [MapScale::Small, MapScale::Medium, MapScale::Large] {
                let mut w = World::new(seed, scale);
                w.set_phase(RoundPhase::Playing);
                w.add_player(0, 0, "ana".into());
                w.force_effect(EffectKind::ToxicRain, w.round_time);
                // The shower plus enough for the last drop to land: descent is
                // about a second, and a longer tail is only empty sky.
                let ticks = ((TOXIC_DURATION + 3.0) / crate::constants::SIM_DT) as u32;
                let mut live = Vec::new();
                for _ in 0..ticks {
                    w.step(crate::constants::SIM_DT);
                    live.push(
                        w.projectiles
                            .iter()
                            .filter(|p| p.weapon == crate::items::registry::WEAPON_TOXIC_DROP)
                            .count(),
                    );
                }
                let peak = live.iter().copied().max().unwrap_or(0);
                peaks.push(peak);

                // The property the client's `liveDrops > 0` ramp target rests on:
                // once the rain starts there is no frame with an empty sky until
                // it is over. `TOXIC_DROP_EVERY` (0.15 s) against a fall of about
                // a second is what buys that, and if the cadence ever grows past
                // the descent the sheet would strobe.
                let first = live.iter().position(|n| *n > 0).unwrap_or(0);
                let last = live.iter().rposition(|n| *n > 0).unwrap_or(0);
                if live[first..=last].contains(&0) {
                    ever_dry_mid_shower = true;
                }
            }
        }

        let lo = *peaks.iter().min().unwrap_or(&0);
        let hi = *peaks.iter().max().unwrap_or(&0);
        assert!(
            lo > 0,
            "no drop was ever in the air — the measurement is of nothing"
        );
        assert!(
            !ever_dry_mid_shower,
            "a shower had a frame with no drop in the air, so a client deriving \
             \"is it raining\" from the live count would strobe"
        );
        let full = crate::constants::TOXIC_DROPS_IN_FLIGHT as usize;
        assert!(
            (lo..=hi).contains(&full),
            "TOXIC_DROPS_IN_FLIGHT is {full}, and a shower's peak is {lo}..={hi} across \
             three seeds and three scales. The constant is what the client calls a \
             full-rate shower; outside that band the emitter is either a drizzle or \
             saturated before the rain is."
        );
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

    /// T21.26: the ambient rain **never** hurts anyone — and the control that makes
    /// that mean something is in the same test, on the same seeds, map and spot: a
    /// toxic shower does. "Nobody lost health" is otherwise satisfied by a world
    /// that deals no damage at all.
    ///
    /// The ambient schedule has no hook into `World`, so the absence half is
    /// structural; what this pins is that stepping a world straight through an
    /// ambient shower leaves a player in the open exactly as healthy as before.
    /// The horizon stops short of `EFFECT_INTERVAL_MIN`, so no hazard can start
    /// inside it and be mistaken for the rain.
    #[test]
    fn ambient_rain_never_hurts_and_a_toxic_shower_on_the_same_map_does() {
        use crate::world::ambient::ambient_rain_at;
        let horizon = crate::constants::EFFECT_INTERVAL_MIN - 2.0;
        let ticks = (horizon / crate::constants::SIM_DT) as u32;
        let stand = |w: &mut World| {
            w.map = map_with_a_cave();
            w.set_phase(RoundPhase::Playing);
            w.add_player(0, 0, "open".into());
            if let Some(p) = w.player_mut(0) {
                p.body.pos = Vec2::new(
                    (OPEN_X0 + 40) as f32,
                    GROUND as f32 - crate::constants::PLAYER_H / 2.0,
                );
            }
        };
        // Seeds whose ambient rain falls at full strength inside the horizon.
        let seeds: Vec<u64> = (0u64..400)
            .filter(|s| {
                (0..(horizon as i32 * 2)).any(|i| ambient_rain_at(*s, i as f32 * 0.5) >= 1.0)
            })
            .take(6)
            .collect();
        assert_eq!(
            seeds.len(),
            6,
            "fewer than six of 400 seeds rain ambiently inside {horizon} s"
        );

        let mut toxic_lost = 0.0f32;
        for seed in seeds.iter().copied() {
            let mut w = World::new(seed, MapScale::Small);
            stand(&mut w);
            let mut wet_ticks = 0u32;
            for _ in 0..ticks {
                if ambient_rain_at(seed, w.round_time) > 0.0 {
                    wet_ticks += 1;
                }
                w.step(crate::constants::SIM_DT);
            }
            assert!(
                wet_ticks > 0,
                "seed {seed}: the world's clock never passed through its ambient shower"
            );
            let health = w.player(0).expect("open").health;
            assert_eq!(
                health,
                crate::constants::BASE_HEALTH,
                "seed {seed}: standing in {wet_ticks} ticks of ambient rain cost {} health",
                crate::constants::BASE_HEALTH - health
            );

            // The control: same seed, same map, same spot — a toxic shower.
            let mut c = World::new(seed, MapScale::Small);
            stand(&mut c);
            c.force_effect(EffectKind::ToxicRain, c.round_time);
            for _ in 0..ticks {
                c.step(crate::constants::SIM_DT);
            }
            toxic_lost += crate::constants::BASE_HEALTH - c.player(0).expect("open").health;
        }
        assert!(
            toxic_lost > 0.0,
            "a toxic shower hurt nobody on the same six seeds — the absence above means nothing"
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
        let mut w = World::for_test(4242, MapScale::Small);
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
        let mut w = World::for_test(4242, MapScale::Small);
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
            gun_platforms: Vec::new(),
            surface_points: Vec::new(),
            objects: Vec::new(),
            buried_slots: Vec::new(),
            decorations: Vec::new(),
            wind: 0.0,
            traversable_fraction: 1.0,
            asteroids: Vec::new(),
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
        let mut w = World::for_test(4242, MapScale::Small);
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
        let mut w = World::for_test(4242, MapScale::Small);
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
                let _ = now;
                match id {
                    // A **held generator** is the shield now (T20.08); the battery
                    // that pays for it is set below.
                    1 => {
                        p.inventory.add(crate::items::registry::SHIELD_GENERATOR, 1);
                    }
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
    ///
    /// **It takes the gravity mode (T22.02, M22-RULINGS R29).** Toxic drops are
    /// projectiles, so `Projectiles::step` scales them, and under `Low` the
    /// flight time grows toward `1/sqrt(k)` — about 41 % longer at
    /// `LOW_GRAVITY_SCALE` 0.5. A ceiling computed from the **unscaled**
    /// `GRAVITY` is therefore not a load claim about a low-gravity match at all:
    /// it is ~40 % loose there, which is the whole quantity this guard exists to
    /// bound. Both modes are run, each against its own derived ceiling, and the
    /// printed bill is per mode.
    ///
    /// **Space is not in the loop, and that is not the blind spot R43 feared**
    /// (R84): toxic rain is not in space's weather table at all
    /// (`WeatherTable::Space`), and at gravity scale 0 this formula divides by
    /// zero. The load space *does* carry — meteors at constant speed — is
    /// `solar_flare_tests::a_meteor_shower_in_space_keeps_a_bounded_number_in_the_air`.
    #[test]
    fn a_shower_keeps_a_bounded_number_of_drops_in_the_air() {
        use crate::constants::{GRAVITY, SIM_DT, SKY_MARGIN, TOXIC_DROP_EVERY, TOXIC_DROP_SPEED};

        let mut peaks: Vec<(GravityMode, usize, usize)> = Vec::new();
        for gravity in [GravityMode::Standard, GravityMode::Low] {
            let mut w = World::for_test(4242, MapScale::Medium);
            w.set_phase(RoundPhase::Playing);
            w.gravity = gravity;
            w.add_player(0, 0, "ana".into());
            w.force_effect(EffectKind::ToxicRain, w.round_time);

            let mut peak = 0usize;
            // The window is the shower plus the longest flight it can leave in
            // the air, and the flight is longer under low gravity — a fixed
            // window would stop measuring before the low arm's last drops landed.
            let ticks = ((TOXIC_DURATION + 12.0 / gravity.scale()) / SIM_DT) as u32;
            for _ in 0..ticks {
                w.step(SIM_DT);
                peak = peak.max(w.projectiles.len());
            }

            // Flight time for the longest possible fall: `SKY_MARGIN` to the
            // bottom of the map, from `TOXIC_DROP_SPEED` under **this match's**
            // gravity. Solving `d = v·t + g·k·t²/2` for t.
            let d = w.map.mask.h as f32 - SKY_MARGIN as f32;
            let v = TOXIC_DROP_SPEED;
            let g = GRAVITY * gravity.scale();
            let t = ((v * v + 2.0 * g * d).sqrt() - v) / g;
            let ceiling = (t / TOXIC_DROP_EVERY).ceil() as usize + 1;
            assert!(
                peak <= ceiling,
                "{gravity:?}: {peak} drops were airborne at once against a \
                 {ceiling} the physics allows — something is releasing faster \
                 than the cadence"
            );
            // The control: without it the bound above is satisfied by a shower
            // that never released anything.
            assert!(
                peak >= 4,
                "{gravity:?}: only {peak} drop(s) were ever airborne — this \
                 measures nothing"
            );
            println!(
                "toxic rain ({gravity:?}): peak {peak} drops airborne (physics \
                 allows {ceiling}); at SNAPSHOT-rate broadcast that is {} \
                 ProjectileMove/s",
                peak * (crate::constants::SIM_HZ as usize) / 3
            );
            peaks.push((gravity, peak, ceiling));
        }

        // **The claim R29 asks this guard to be able to see.** A blind guard
        // would be satisfied by two identical numbers; the low arm has to cost
        // more, or `Projectiles::step` is not scaling the drops and the ceiling
        // above is bounding a mode nobody plays.
        let std_ceiling = peaks[0].2;
        let low_ceiling = peaks[1].2;
        assert!(
            low_ceiling > std_ceiling,
            "the low-gravity ceiling is {low_ceiling} against {std_ceiling} \
             standard — the mode is not reaching the fall, so this test is the \
             standard-gravity one twice"
        );
        let low_peak = peaks[1].1;
        assert!(
            low_peak > peaks[0].1,
            "peak {low_peak} drops airborne under low gravity against {} under \
             standard — the drops are not actually falling slower, whatever the \
             ceiling arithmetic says",
            peaks[0].1
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
                gun_platforms: Vec::new(),
                surface_points: Vec::new(),
                objects: Vec::new(),
                buried_slots: Vec::new(),
                decorations: Vec::new(),
                wind: 0.0,
                traversable_fraction: 1.0,
                asteroids: Vec::new(),
                largest_component: Vec::new(),
            };
            Map::from_parts(mask, coarse, meta)
        };

        let mut w = World::for_test(4242, MapScale::Small);
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
            let mut w = World::for_test(4242, MapScale::Small);
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
        let mut w = World::for_test(4242, MapScale::Small);
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
        let mut w = World::for_test(4242, MapScale::Small);
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
    ///
    /// **Every number above and below is a statement about `GravityMode::Standard`
    /// only, and since T22.02 that needs saying** (M22-RULINGS R29). `run_shower`
    /// builds a default world, which is `Standard`, and the derivation uses the
    /// bare `GRAVITY`. Meteors *are* projectiles and *are* scaled in production,
    /// so under `Low` the same fall takes about 41 % longer and the 0.38–1.02 s
    /// spread measured here is not the spread a low-gravity match produces. The
    /// test stays standard-only on purpose — what it gates is that a meteor
    /// obeys gravity at all, and one mode is enough for that — but it is
    /// scoped rather than silent. The load consequence of the other mode is
    /// `a_shower_keeps_a_bounded_number_of_drops_in_the_air`'s, which does take
    /// the mode.
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
        let mut w = World::for_test(4242, MapScale::Small);
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
        let mut w = World::for_test(4242, MapScale::Small);
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
        let mut w = World::for_test(4242, MapScale::Small);
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
            // Stop on arrival (T22.10F): a silent player is now stepped every
            // tick, so the ticks after it refill a grounded tank at the rate
            // that has nothing to do with the pad.
            if !teleports(&evs).is_empty() {
                break;
            }
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
        let mut w = World::for_test(4242, MapScale::Small);
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
        let mut w = World::for_test(4242, MapScale::Small);
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
        let mut w = World::for_test(4242, MapScale::Small);
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

/// The gravity setting, and which of its modes is wired to anything.
///
/// **T22.01 shipped the setting with no behaviour and this module said so;
/// T22.02 retired half of that claim.** `Low` now changes the simulation and
/// `Space` still does not, and both halves are asserted here rather than left
/// to a commit message. T22.03 is the task that turns the `Space` half red, and
/// retiring *it* then is the correct move for exactly the reason retiring the
/// `Low` half was: leaving it green would mean that task shipped nothing.
#[cfg(test)]
mod gravity_tests {
    use super::*;
    use crate::constants::{GravityMode, MapGenerator, MapScale, SIM_DT};
    use crate::player::input::{button, Input};

    /// **The gravity mode reaches map generation**, which until `T22.05A` it
    /// could not: `World::build` had no gravity parameter, so a host who picked
    /// space was given a landscape with a floor.
    ///
    /// The discriminator is `meta.asteroids`, which is empty for every generator
    /// but `Space` — see its doc comment. The control is the same call under
    /// `Standard`, without which this passes for a build that always makes space
    /// maps.
    #[test]
    fn space_gravity_builds_a_space_map_and_standard_does_not() {
        for scale in MapScale::ALL {
            let space = World::with_gravity(
                4242,
                scale,
                0,
                crate::constants::DEFAULT_MAP_GENERATOR,
                GravityMode::Space,
            );
            assert!(
                !space.map.meta.asteroids.is_empty(),
                "{scale:?}: space gravity produced a map with no asteroids"
            );
            assert_eq!(space.gravity, GravityMode::Space, "{scale:?}");

            for control in [GravityMode::Standard, GravityMode::Low] {
                let w = World::with_gravity(
                    4242,
                    scale,
                    0,
                    crate::constants::DEFAULT_MAP_GENERATOR,
                    control,
                );
                assert!(
                    w.map.meta.asteroids.is_empty(),
                    "{scale:?}: {control:?} gravity produced a space map"
                );
                assert_eq!(w.gravity, control, "{scale:?}");
            }
        }
    }

    /// **`T22.05B`: a space round actually spawns people where the generator
    /// put the spawn points.**
    ///
    /// This is the test that catches a whole feature being built and wired to
    /// nothing, and it was written because that is exactly what had happened.
    /// `spawn_for` gated the listed points on `surface::is_standable`, which
    /// demands `MIN_SUPPORT_PX` of rock directly under the body box — so an
    /// open-space spawn failed it **by definition**, every player fell through
    /// to `choose_respawn`, and `choose_respawn` filtered the same list the
    /// same way and fell through to its own surface scan. Six well-separated
    /// points in open air were chosen, validated by `analyse_space`, shipped in
    /// `MapMeta`, hashed into the golden table — and never used by anybody.
    ///
    /// Nothing else would have reported it: `every_shipped_spawn_point_is_in_
    /// open_space_inside_the_rim` asserts the list is right, not that anyone
    /// reads it. **Assert on effects, not intentions.**
    ///
    /// The control is the same assertion under standard gravity, which uses the
    /// landscape path — so this cannot pass for a `spawn_for` that ignores
    /// `body_fits_at` and returns the listed point unconditionally.
    #[test]
    fn the_shipped_spawn_points_are_the_ones_a_space_round_uses() {
        for (gravity, generator) in [
            (GravityMode::Space, MapGenerator::Space),
            (
                GravityMode::Standard,
                crate::constants::DEFAULT_MAP_GENERATOR,
            ),
        ] {
            let mut w = World::with_gravity(4242, MapScale::Medium, 0, generator, gravity);
            let want: Vec<crate::math::Point> = w.map.meta.spawn_points.clone();
            assert!(
                want.len() >= crate::constants::MAX_PLAYERS,
                "{gravity:?}: only {} spawn points",
                want.len()
            );
            for id in 0..crate::constants::MAX_PLAYERS as u8 {
                w.add_player(id, 0, format!("p{id}"));
            }
            for id in 0..crate::constants::MAX_PLAYERS as u8 {
                let body = w
                    .players
                    .iter()
                    .find(|p| p.id == id)
                    .expect("added")
                    .body
                    .pos;
                let p = want[id as usize % want.len()];
                let expect =
                    crate::player::state::surface_to_centre(Vec2::new(p.x as f32, p.y as f32));
                assert_eq!(
                    body, expect,
                    "{gravity:?}: player {id} spawned at {body:?}, not at the listed spawn \
                     point {p:?}"
                );
            }
        }
    }

    /// The other half of R15: **one source of truth**. A lobby cannot end up
    /// with space gravity on a normal map, and it cannot end up with a space map
    /// under a gravity that would drop everyone off it either.
    #[test]
    fn the_generator_cannot_disagree_with_the_gravity() {
        // Space gravity overrides whatever generator was asked for.
        for chosen in MapGenerator::ALL {
            assert_eq!(
                MapGenerator::for_gravity(GravityMode::Space, chosen),
                MapGenerator::Space,
                "space gravity did not override {chosen:?}"
            );
        }
        // And the space map cannot be reached without it. `MapGenerator::Space`
        // arriving from a wire byte or a replay header under standard gravity
        // is collapsed rather than trusted.
        for gravity in [GravityMode::Standard, GravityMode::Low] {
            assert_ne!(
                MapGenerator::for_gravity(gravity, MapGenerator::Space),
                MapGenerator::Space,
                "{gravity:?} gravity kept a space generator"
            );
        }
        // Everything else passes through untouched.
        for gravity in [GravityMode::Standard, GravityMode::Low] {
            for chosen in [MapGenerator::V1, MapGenerator::V2] {
                assert_eq!(MapGenerator::for_gravity(gravity, chosen), chosen);
            }
        }
        // And there is no environment spelling for it, so an operator cannot
        // select one beside a gravity.
        assert_eq!(MapGenerator::parse("space"), None);
        assert_eq!(MapGenerator::as_str(MapGenerator::Space), "space");
    }

    /// How long a run is, and how often the falling things are replaced.
    ///
    /// **`RESEED_TICKS` is not a free number, and reasoning about it was wrong.**
    /// A bazooka round spawned into a pristine map survives 57 ticks, so 30
    /// "obviously" leaves one in the air at tick 600. It does not: by then the
    /// run has cratered the terrain and moved the players, and a fresh round
    /// dies far sooner. Bisected against the real runner —
    /// **30, 20 and 15 all end with `projectiles = 0`; 10 does not** — so the
    /// value is the measurement, not the arithmetic.
    ///
    /// `the_runner_reaches_every_falling_subsystem` re-measures this on every
    /// run rather than trusting the paragraph above, which is the only reason it
    /// is safe to write a number here at all.
    const TICKS: u32 = 600;
    const RESEED_TICKS: u32 = 10;

    /// Where the falling things are dropped, relative to the player they follow:
    /// high enough to fall for a while, offset so a projectile's arc is not the
    /// same shape as a straight drop.
    const DROP_ABOVE: f32 = 260.0;
    const DROP_AHEAD: f32 = 120.0;

    /// What one run produced: the hash, where player 0 ended, and how many of
    /// each falling thing were live **at the moment the hash was taken**.
    ///
    /// The counts are in the return value rather than asserted inside `run`
    /// because they are the *sensitivity* of the hash, and a reader of
    /// `low_gravity_changes_the_simulation_and_space_does_not_yet` has to be
    /// able to see that
    /// something checks them.
    struct Run {
        hash: [u8; 32],
        ended_at: Vec2,
        projectiles: usize,
        mines: usize,
        tombstones: usize,
    }

    /// A round of identical inputs under `mode`, hashed at the end.
    ///
    /// Two players so the hash covers more than one body, and a held
    /// jump-and-run so every path gravity could plausibly be wired into —
    /// `apply_input`, the fall, the landing — is actually walked.
    ///
    /// **And a projectile, a mine and a grave, replaced every `RESEED_TICKS`.**
    /// The first draft ran players only and finished with
    /// `projectiles=0 mines=0 tombstones=0`, so a gravity read planted in
    /// `Projectiles::step` left this module green — and R3 schedules T22.02
    /// early *precisely* to walk the projectile gravity seam. They are replaced
    /// rather than spawned once because a mine or a grave with no sideways
    /// motion lands in the same spot under any gravity: only the time to get
    /// there changes, and `hash_into` records position, not time.
    fn run(mode: GravityMode) -> Run {
        run_driven(mode, true)
    }

    /// `drive == false` queues a neutral input every tick instead of the held
    /// run-and-jump. It exists for one assertion — that the inputs are
    /// load-bearing — and that assertion is the only honest way to make the
    /// claim: a player left alone still *moves*, because it spawns in the air
    /// and falls, and my first two attempts at this both passed with the
    /// buttons deleted (`pos != Vec2::ZERO`, then `started_at != ended_at`).
    fn run_driven(mode: GravityMode, drive: bool) -> Run {
        let mut w = World::for_test(4242, MapScale::Small);
        w.gravity = mode;
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w.add_player(1, 1, "bo".into());
        for tick in 0..TICKS {
            for id in 0..2u8 {
                w.queue_input(
                    id,
                    Input {
                        seq: tick + 1,
                        buttons: if drive {
                            button::RIGHT | if tick % 30 < 4 { button::JUMP } else { 0 }
                        } else {
                            0
                        },
                        aim: 0,
                    },
                );
            }
            if tick % RESEED_TICKS == 0 {
                seed_falling_things(&mut w);
            }
            w.step(SIM_DT);
        }
        Run {
            hash: w.state_hash(),
            ended_at: w.player(0).map(|p| p.body.pos).unwrap_or(Vec2::ZERO),
            projectiles: w.projectiles.len(),
            mines: w.mines.len(),
            tombstones: w.tombstones.len(),
        }
    }

    /// Drop one projectile, one mine and one grave above player 0.
    ///
    /// **Spawned directly rather than through an inventory**, because arming a
    /// player and making them fire is plumbing this test does not exercise and
    /// would break the moment the starting kit changes. All three go through the
    /// same public entry points production uses — `spawn_raw` for a meteor or a
    /// death throw, `place` for a mine and for a grave.
    ///
    /// The mine's three numbers come **off its own `WeaponDef`**, not from
    /// literals here: `world::use_item`'s `Delivery::Placed` arm reads exactly
    /// those, so a retune moves both together.
    fn seed_falling_things(w: &mut World) {
        use crate::items::registry::{WEAPON_BAZOOKA, WEAPON_MINE};
        use crate::weapons::defs::{def, Delivery};

        let Some(anchor) = w.player(0).map(|p| p.body.pos) else {
            return;
        };
        let now = w.round_time;
        let from = anchor + Vec2::new(0.0, -DROP_ABOVE);

        // Fired **up and sideways**, so its arc — not merely its fall time —
        // depends on gravity, and so it is still in the air a reseed later.
        // `muzzle_speed` off the def, for the reason the mine's numbers are.
        let speed = def(WEAPON_BAZOOKA).map_or(0.0, |d| d.muzzle_speed);
        w.projectiles.spawn_raw(
            WEAPON_BAZOOKA,
            0,
            from,
            Vec2::new(speed * 0.5, -speed * 0.5),
            now,
        );

        if let Some(mine) = def(WEAPON_MINE) {
            if let Delivery::Placed {
                arm_time,
                trigger_radius,
                lifetime,
            } = mine.delivery
            {
                w.mines.place(
                    0,
                    mine,
                    from + Vec2::new(DROP_AHEAD, 0.0),
                    arm_time,
                    trigger_radius,
                    lifetime,
                    now,
                );
            }
        }

        w.tombstones
            .place(0, from + Vec2::new(-DROP_AHEAD, 0.0), 0, now);
    }

    /// **`M22-RULINGS` R4 — fall damage is off in space, and the control is
    /// the identical impact under standard gravity.**
    ///
    /// *There is no fall*, so a touchdown in space is a drift into a rock at a
    /// speed the player chose. `T22.03` does not get to turn that into impact
    /// damage as the collision rule.
    ///
    /// **The velocity is set directly rather than fallen into**, for the reason
    /// this file's rules give about absences: a player in space cannot *reach*
    /// `FALL_SAFE_SPEED` under their own power — thrust tops out at
    /// `JETPACK_MAX_SPEED` = 260 against a threshold of 678.8 — so a test that
    /// dropped someone and found no damage would be satisfied by a mode that
    /// simply never gets fast enough. A knockback can put a player over it, and
    /// that is what is modelled here.
    #[test]
    fn a_hard_landing_hurts_under_gravity_and_costs_nothing_in_space() {
        let land = |mode: GravityMode| -> f32 {
            let mut w = World::for_test(4242, MapScale::Small);
            w.gravity = mode;
            w.set_phase(RoundPhase::Playing);
            w.add_player(0, 0, "ana".into());
            // Drop them in from well above the terrain, already travelling
            // faster than `FALL_SAFE_SPEED`, and let them arrive.
            {
                let Some(p) = w.player_mut(0) else {
                    return 0.0;
                };
                p.body.pos = Vec2::new(400.0, 80.0);
                p.body.vel = Vec2::new(0.0, crate::constants::FALL_SAFE_SPEED + 200.0);
                p.health = crate::constants::BASE_HEALTH;
                // `add_player` grants `SPAWN_IFRAMES`, and `apply_damage_log`
                // honours them — the first draft of this test reported its own
                // *control* as taking no damage for exactly that reason, which
                // would have read as "fall damage is off everywhere".
                p.iframes_until = -1000.0;
            }
            let before = w.player(0).map(|p| p.health).unwrap_or(0.0);
            for tick in 0..240u32 {
                w.queue_input(
                    0,
                    Input {
                        seq: tick + 1,
                        buttons: 0,
                        aim: 0,
                    },
                );
                w.step(SIM_DT);
                if w.player(0).is_some_and(|p| p.body.grounded) {
                    break;
                }
            }
            assert!(
                w.player(0).is_some_and(|p| p.body.grounded),
                "{mode:?}: the player never landed, so this measures nothing"
            );
            before - w.player(0).map(|p| p.health).unwrap_or(before)
        };

        let hurt = land(GravityMode::Standard);
        assert!(
            hurt > 0.0,
            "control: the identical impact under standard gravity cost nothing, \
             so 'no damage in space' is satisfied by a game that never hurts \
             anyone"
        );
        assert_eq!(
            land(GravityMode::Space),
            0.0,
            "space charged fall damage for a landing (the standard control cost \
             {hurt} health) — R4 rules there is no fall"
        );
    }

    #[test]
    fn a_world_is_standard_gravity_until_somebody_says_otherwise() {
        let w = World::for_test(4242, MapScale::Small);
        assert_eq!(
            w.gravity,
            GravityMode::Standard,
            "a world built without a lobby setting must play the shipped game"
        );
    }

    /// **All three modes reach the simulation, and all three differ from each
    /// other** (T22.02 for `Low`, T22.03 for `Space`).
    ///
    /// This half used to read *"`Low` reaches the simulation; `Space` still does
    /// not"*, with the `Space` arm asserted **equal** to `Standard` and a note
    /// saying it retires with T22.03's change. It has: `GravityMode::Space`
    /// now answers `0.0`, the equality went red, and the arm is pointed the
    /// other way rather than deleted — a mode that quietly collapsed back onto
    /// standard gravity still fails here.
    ///
    /// **Pairwise, not against `Standard` twice.** `Low` and `Space` must also
    /// differ from *each other*, or a build that mapped both onto the same
    /// scale would pass two inequalities and ship one mode wearing two names.
    ///
    /// **And determinism, on the same run.** `Space` is the mode where nothing
    /// damps, so a divergence does not decay: two identical runs must hash
    /// identically, and that assertion has to live where the space run already
    /// is.
    ///
    /// Asserted on the state hash rather than on a position, because the hash
    /// covers every body, every projectile, every mine, every grave and every
    /// item — a positional assertion would miss gravity applied to a rocket and
    /// not to a player.
    ///
    /// **The control for the control** is the second half, and it uses the *same
    /// seed*: a world that ran one tick must not hash the same as one that ran
    /// `TICKS`, and player 0 must have left its spawn. Both of those were broken
    /// in the first draft — the position assertion compared against `Vec2::ZERO`,
    /// which a stationary player never returns, so it only ever detected "no
    /// player existed", and it passed with the inputs zeroed.
    #[test]
    fn every_gravity_mode_changes_the_simulation_and_differs_from_the_others() {
        let standard = run(GravityMode::Standard);
        let low = run(GravityMode::Low);
        let space = run(GravityMode::Space);
        assert_ne!(
            standard.hash, low.hash,
            "low gravity hashed identically to standard over {TICKS} ticks of \
             two players running and jumping with a rocket, a mine and a grave \
             falling beside them — `World::gravity` reaches no simulation code"
        );
        assert_ne!(
            standard.hash, space.hash,
            "space hashed identically to standard over {TICKS} ticks — \
             `GravityMode::scale`'s space arm reaches no simulation code"
        );
        assert_ne!(
            low.hash, space.hash,
            "low and space hashed identically — two modes wearing one scale"
        );

        // **Determinism, in the mode where a divergence never decays.** Same
        // seed, same seats, same inputs, run twice. Under friction a
        // mispredicted velocity is pulled back to a target; here nothing pulls,
        // so a one-tick difference grows without bound — which makes this the
        // mode where an unhashed field costs the most.
        assert_eq!(
            space.hash,
            run(GravityMode::Space).hash,
            "two identical space runs hashed differently"
        );
        // And the space run actually went somewhere, or the equality above is
        // satisfied by a mode in which nothing moves.
        assert_ne!(
            space.ended_at,
            run_driven(GravityMode::Space, false).ended_at,
            "the held run-and-jump moved player 0 nowhere in space"
        );

        // A world that barely ran must not hash the same as one that ran
        // `TICKS`, or the equality above is satisfied by a runner that hashes
        // nothing. Same seed, same seats — the only difference is the running.
        let mut barely = World::for_test(4242, MapScale::Small);
        barely.set_phase(RoundPhase::Playing);
        barely.add_player(0, 0, "ana".into());
        barely.add_player(1, 1, "bo".into());
        barely.step(SIM_DT);
        assert_ne!(
            standard.hash,
            barely.state_hash(),
            "{TICKS} ticks hash the same as one, so the equality above proves nothing"
        );

        // And the held run-and-jump is load-bearing: the same run with neutral
        // input must produce a different world.
        //
        // **Asserted against a neutral run, not against the spawn position.**
        // Two weaker forms shipped and both passed with the buttons deleted:
        // `pos != Vec2::ZERO` (a stationary player returns its spawn, never
        // zero) and `started_at != ended_at` (a player left alone still falls).
        // Only comparing against a world that received no input can report the
        // input being gone.
        let neutral = run_driven(GravityMode::Standard, false);
        assert_ne!(
            standard.hash, neutral.hash,
            "the run hashes the same with the held run-and-jump as without it, \
             so the inputs drive nothing and no player gravity path is walked"
        );
        // Belt and braces on the same claim, in a form a reader can picture:
        // only `button::RIGHT` moves a body sideways.
        assert_ne!(
            standard.ended_at.x, neutral.ended_at.x,
            "player 0 ended at the same x driven and undriven ({}), so \
             `button::RIGHT` reached nothing",
            standard.ended_at.x
        );
    }

    /// Every falling subsystem gravity will be wired into is **live at the moment
    /// the hash is taken**, and this is what keeps it that way.
    ///
    /// Written because none of them were: the first draft measured
    /// `projectiles=0 mines=0 tombstones=0` after 600 ticks, so a mode read
    /// planted in `Projectiles::step` left the whole module green while looking
    /// exactly like a test that covered it.
    ///
    /// **It asserts at hash time rather than at spawn time on purpose.** A
    /// spawn-time check would stay green through the failure that actually
    /// happened, which was a rocket dying three ticks before the end. That makes
    /// this the guard on `RESEED_TICKS` against a projectile-lifetime retune.
    #[test]
    fn the_runner_reaches_every_falling_subsystem() {
        let r = run(GravityMode::Standard);
        for (name, n) in [
            ("projectiles", r.projectiles),
            ("mines", r.mines),
            ("tombstones", r.tombstones),
        ] {
            assert!(
                n > 0,
                "no {name} were live when the hash was taken, so \
                 `low_gravity_changes_the_simulation_and_space_does_not_yet` is \
                 blind to whatever \
                 gravity does to them — shorten RESEED_TICKS"
            );
        }
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
        let mut w = World::for_test(4242, MapScale::Small);
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

/// Ground animals in a real round (T20.10), following `birds_in_a_round`.
///
/// The module boundary matters: these go through `World::step`, so they exercise
/// `hit_targets`/`targets`, the shared loot drop and the warmup gate rather than
/// `Animals` in isolation — which `world::animals`' own tests already cover.
#[cfg(test)]
mod animals_in_a_round {
    use super::*;
    use crate::constants::{ANIMAL_MAX, SIM_DT};
    use crate::items::registry::{BATTERY_PACK, MEDKIT};
    use crate::world::animals::{AnimalId, AnimalKind};

    fn world() -> World {
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w
    }

    fn run(w: &mut World, seconds: f32) {
        for _ in 0..(seconds / SIM_DT) as u32 {
            w.step(SIM_DT);
        }
    }

    /// Put one animal of a known kind on the ground under a known point.
    fn plant(w: &mut World, kind: AnimalKind, x: f32) -> (AnimalId, Vec2) {
        let col = x as i32;
        let top = (0..w.map.mask.h as i32)
            .find(|y| w.map.mask.get(col, *y))
            .expect("a column with ground in it");
        let (_, h) = kind.size();
        let at = Vec2::new(x, top as f32 - h / 2.0 - 1.0);
        let id = w.animals.place_for_test(kind, at, w.round_time);
        (id, at)
    }

    #[test]
    fn animals_appear_in_an_ordinary_round() {
        // From the world, not from the event buffer (§B25/§A15).
        let mut w = world();
        run(&mut w, crate::constants::ANIMAL_INTERVAL + 1.0);
        assert!(!w.animals.is_empty(), "a round grew no animals");
    }

    #[test]
    fn an_animal_announces_itself_and_is_told_to_move() {
        // Both ends (§A39): the world has animals, and the client was told.
        let mut w = world();
        run(&mut w, crate::constants::ANIMAL_INTERVAL + 1.0);
        let spawned: Vec<AnimalId> = w
            .events
            .iter()
            .filter_map(|e| match e {
                GameEvent::AnimalSpawn { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(
            spawned.len(),
            w.animals.len(),
            "the world holds {} animals and announced {}",
            w.animals.len(),
            spawned.len()
        );
        assert!(
            w.events
                .iter()
                .any(|e| matches!(e, GameEvent::AnimalMove { .. })),
            "no animal was ever told to move — one drawn frozen at its spawn point"
        );
    }

    #[test]
    fn the_population_never_exceeds_the_cap() {
        let mut w = world();
        let mut peak = 0;
        for _ in 0..((crate::constants::ANIMAL_INTERVAL * 10.0) / SIM_DT) as u32 {
            w.step(SIM_DT);
            peak = peak.max(w.animals.len());
        }
        assert!(peak <= ANIMAL_MAX, "{peak} animals alive, cap {ANIMAL_MAX}");
        // ...and more than one was alive, or the bound is vacuous.
        assert!(peak >= 2, "only ever {peak} animal(s) alive at once");
    }

    /// Shoot the planted animal and return **its own** drop.
    ///
    /// Identified from the events at the killing tick, not by counting heals on
    /// the ground: `step_item_spawns` puts medkits and batteries out on a timer
    /// too, and that measurement error is recorded next door in
    /// `birds_in_a_round`.
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
                GameEvent::AnimalDespawn {
                    tick, killed: true, ..
                } => Some(*tick),
                _ => None,
            })
            .expect("no animal was reported killed");
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
            .expect("the animal died and dropped nothing")
    }

    #[test]
    fn shooting_a_spider_drops_exactly_one_heal_and_it_lands() {
        let mut w = world();
        let x = w.map.mask.w as f32 / 2.0;
        let (id, at) = plant(&mut w, AnimalKind::Spider, x);
        assert!(w.animals.get(id).is_some(), "the plant did not take");

        let before_items = w.items.iter().count();
        let (item, world_id) = shoot_and_take_the_drop(&mut w, at);
        assert_eq!(item, MEDKIT, "a spider dropped {item} rather than a heal");
        assert!(w.animals.get(id).is_none(), "the spider survived a rocket");
        assert_eq!(
            w.items.iter().count(),
            before_items + 1,
            "one kill put more than one thing on the ground"
        );

        // And it lands rather than falling through the world.
        run(&mut w, 3.0);
        let landed = w.items.iter().find(|i| i.id == world_id);
        assert!(landed.is_some(), "the drop vanished before it landed");
    }

    #[test]
    fn shooting_a_beetle_drops_a_battery() {
        // The control for the test above: the two kinds are worth different
        // ammunition, so "a kill drops something" is not the claim.
        let mut w = world();
        let x = w.map.mask.w as f32 / 2.0;
        let (_, at) = plant(&mut w, AnimalKind::Beetle, x);
        let (item, _) = shoot_and_take_the_drop(&mut w, at);
        assert_eq!(item, BATTERY_PACK, "a beetle dropped {item}");
    }

    /// **They never attack**, and the control is that one can itself be killed.
    ///
    /// Without the control this passes for a build where animals do not exist:
    /// an empty hillside damages nobody.
    #[test]
    fn an_animal_standing_on_a_player_never_hurts_them() {
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        let x = w.map.mask.w as f32 / 2.0;
        let (id, at) = plant(&mut w, AnimalKind::Spider, x);
        // The player, in the same place — overlapping, which is the worst case
        // any contact rule would fire on.
        if let Some(p) = w.player_mut(0) {
            p.body.pos = at;
            p.iframes_until = 0.0;
        }
        let before = w.player(0).expect("seated").health;

        // Long enough for many hops, and for a contact rule to have fired.
        run(&mut w, crate::constants::SPIDER_HOP_EVERY * 4.0);
        let after = w.player(0).expect("seated").health;
        assert_eq!(
            after,
            before,
            "an animal took {} health from a player it was standing on",
            before - after
        );

        // The control: the same animal, in the same round, dies to a rocket. So
        // "it never attacks" is about the damage direction and not about an
        // animal that was never there.
        assert!(
            w.animals.get(id).is_some(),
            "the spider left before the control"
        );
        let now_at = w.animals.get(id).expect("alive").pos();
        let (item, _) = shoot_and_take_the_drop(&mut w, now_at);
        assert_eq!(item, MEDKIT);
    }

    /// Shooting an animal must not move a bird.
    ///
    /// T20.10's BLOCKER, asserted: `hit_targets` appends animals after birds and
    /// `targets` splits once, at `players.len()`. A three-way split done wrong
    /// zips the animals' closures onto the **birds'** velocity slots, silently.
    #[test]
    fn shooting_an_animal_leaves_the_birds_untouched() {
        let mut w = world();
        run(&mut w, 1.0);
        assert!(!w.birds.is_empty(), "no bird to be wrongly hit");
        // **Health, not only position.** A misaligned zip is not visible as
        // movement: both classes' velocities go to the same scratch, so a bird
        // that took an animal's rocket stays exactly where it was and dies. The
        // observable is the bird's health, and the id list, and that nothing
        // reported a bird killed on this tick.
        let before: Vec<(BirdId, f32, f32, f32)> = w
            .birds
            .iter()
            .map(|b| (b.id, b.pos.x, b.pos.y, b.health))
            .collect();

        let x = w.map.mask.w as f32 / 2.0;
        let (_, at) = plant(&mut w, AnimalKind::Beetle, x);
        let killed = {
            let before_events = w.events.len();
            w.explode_for_test(
                at,
                crate::weapons::defs::by_key("bazooka").expect("bazooka").id,
                0,
                w.round_time,
            );
            w.events[before_events..]
                .iter()
                .any(|e| matches!(e, GameEvent::AnimalDespawn { killed: true, .. }))
        };
        // **The claim first, the control after.** A misaligned zip sends the
        // beetle's own closure to some other target, so `killed` goes false at
        // the same moment a bird takes the rocket — and asserting the control
        // first would report "the rocket missed" for a bug that is the opposite
        // of a miss. Measured: with `other_closures` rotated by one, the
        // bird-health assertion below is the honest red and `killed` is the
        // misleading one.
        //
        // Same tick, so nothing has flown anywhere on its own.
        let after: Vec<(BirdId, f32, f32, f32)> = w
            .birds
            .iter()
            .map(|b| (b.id, b.pos.x, b.pos.y, b.health))
            .collect();
        assert_eq!(before, after, "killing an animal moved or hurt a bird");
        assert!(
            !w.events
                .iter()
                .any(|e| matches!(e, GameEvent::BirdDespawn { killed: true, .. })),
            "an animal's rocket shot down a bird"
        );
        assert!(
            killed,
            "no animal was reported killed — the rocket missed, or its damage went elsewhere"
        );
    }

    #[test]
    fn nothing_drops_during_warmup() {
        // The one damage gate. An animal shot before the round starts must not
        // open a supply line early — the rule `resolve_bird_kills` sits behind.
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_phase(RoundPhase::Warmup);
        let x = w.map.mask.w as f32 / 2.0;
        let (id, at) = plant(&mut w, AnimalKind::Beetle, x);
        let before = w.items.iter().count();
        w.explode_for_test(
            at,
            crate::weapons::defs::by_key("bazooka").expect("bazooka").id,
            0,
            w.round_time,
        );
        assert!(w.animals.get(id).is_some(), "warmup killed an animal");
        assert_eq!(w.items.iter().count(), before, "warmup dropped loot");
    }

    /// The hash covers them, for the reason it covers the birds: they drop items.
    #[test]
    fn the_state_hash_notices_an_animal() {
        let mut a = world();
        let mut b = world();
        assert_eq!(a.state_hash(), b.state_hash(), "two fresh worlds differ");
        let x = a.map.mask.w as f32 / 2.0;
        plant(&mut a, AnimalKind::Spider, x);
        assert_ne!(
            a.state_hash(),
            b.state_hash(),
            "an animal appeared and the hash did not move"
        );
        // The control: planting the same animal in the other world brings them
        // back together, so the difference is the animal and not the planting.
        plant(&mut b, AnimalKind::Spider, x);
        assert_eq!(a.state_hash(), b.state_hash());
    }
}

/// **Nothing lives in space** (`T22.13`, `M22-RULINGS` R14/R58).
///
/// `R14`'s table gives `Animals::tick` → *"no animals at all in space"* and adds
/// *"this also answers the `birds.rs` row"*. These go through `World::step`,
/// because the guard lives at the layer that owns the map — see
/// `World::wildlife_allowed`.
///
/// **Birds and animals do not share a suppression point inside their own
/// modules, and that is why this module tests both.** `Animals::tick` takes a
/// `&Map`, so it could gate itself; `Birds::tick` takes only `map_w: f32` and
/// could not without a signature change. What they *do* share is the `active`
/// flag `World` hands each of them, so `R14`'s sentence is true one layer up
/// from where it points. Birds stay a simulation rule rather than moving to
/// `T22.06`'s backdrop: a bird drops a heal or a battery (`birds.rs`' module
/// doc), so a bird is a supply line, and suppressing one is a balance change
/// that a renderer must not be able to make on its own.
#[cfg(test)]
mod nothing_lives_in_space {
    use super::*;
    use crate::constants::{
        GravityMode, ANIMAL_INTERVAL, BIRD_INTERVAL, CYCLE_LENGTH, DEFAULT_MAP_GENERATOR, SIM_DT,
    };

    /// Four seeds, because a population claim needs more than one draw.
    const SEEDS: [u64; 4] = [4242, 7, 90210, 31337];

    /// Drive one round to `Playing` and report the **peak** `(animals, birds)`
    /// alive, not the count at the end — the peak is what catches a build that
    /// spawns wildlife in space and then culls it off the rim before anyone
    /// looks, which the end count would read as a clean zero.
    fn wildlife(seed: u64, gravity: GravityMode) -> (usize, usize) {
        // `with_gravity`, not `for_test`: `World::build` derives the generator
        // from the mode (`R15`), and the cached test map is a landscape one.
        let mut w = World::with_gravity(seed, MapScale::Small, 0, DEFAULT_MAP_GENERATOR, gravity);
        w.set_phase(RoundPhase::Playing);
        let seconds = ANIMAL_INTERVAL.max(BIRD_INTERVAL) + 2.0;
        let (mut peak_a, mut peak_b) = (0, 0);
        for _ in 0..(seconds / SIM_DT) as u32 {
            w.step(SIM_DT);
            peak_a = peak_a.max(w.animals.len());
            peak_b = peak_b.max(w.birds.len());
        }
        (peak_a, peak_b)
    }

    /// The ruling, **and its control in the same test**: a standard round on the
    /// very same seeds still grows both. Without that half, *"no animals in
    /// space"* is satisfied by a build that spawns none anywhere, and that build
    /// passes every assertion about space.
    #[test]
    fn a_space_round_grows_no_wildlife_and_a_standard_round_does() {
        for seed in SEEDS {
            let (a, b) = wildlife(seed, GravityMode::Space);
            assert_eq!(a, 0, "seed {seed}: {a} animals stood in a vacuum");
            assert_eq!(b, 0, "seed {seed}: {b} birds flew in a vacuum");

            // The control, on the **same** seed. Measured at 2 and 2 on each of
            // the four; asserted at 1 so a cadence landing one tick the other
            // side of the window is not a coin flip.
            let (a, b) = wildlife(seed, GravityMode::Standard);
            assert!(
                a >= 1,
                "control, seed {seed}: the standard round grew no animals \
                 either, so the assertion above holds for a build that spawns \
                 none anywhere"
            );
            assert!(
                b >= 1,
                "control, seed {seed}: the standard round grew no birds \
                 either, so the assertion above holds for a build that spawns \
                 none anywhere"
            );
        }
    }

    /// Every `PhaseChange` one world announces over a full day and a bit.
    fn day_phase_changes(gravity: GravityMode) -> usize {
        let mut w = World::with_gravity(4242, MapScale::Small, 0, DEFAULT_MAP_GENERATOR, gravity);
        let _ = w.drain_events();
        let mut n = 0;
        for _ in 0..((CYCLE_LENGTH + 2.0) / SIM_DT) as u32 {
            w.step(SIM_DT);
            n += w
                .drain_events()
                .iter()
                .filter(|e| matches!(e, GameEvent::PhaseChange { .. }))
                .count();
        }
        n
    }

    /// T22.06B F6: **space announces no dawn and no dusk** — the client plays the
    /// `phase_change` cue off this event, and there is no night in orbit. The
    /// standard world on the same seed is the control that the instrument counts
    /// the events at all.
    #[test]
    fn a_space_round_announces_no_day_phase_and_a_standard_round_does() {
        let space = day_phase_changes(GravityMode::Space);
        let standard = day_phase_changes(GravityMode::Standard);
        assert!(
            standard >= 2,
            "control: a standard world announced {standard} day phases over a whole cycle"
        );
        assert_eq!(space, 0, "a space world announced {space} day phases");
    }

    /// **The guard reads the generator, not `self.gravity`** (`R58`).
    ///
    /// The two cannot disagree on a world anyone builds —
    /// `the_generator_cannot_disagree_with_the_gravity` pins that — but
    /// `World::gravity` is a public field and several tests here assign it after
    /// construction, while `World::map` is written exactly once, in
    /// `from_map`. So this is the assertion that the suppression is keyed to the
    /// one of the two that cannot move.
    ///
    /// **It is also the answer to "is anything alive stranded by a mode
    /// change".** Nothing can be: the guard's subject is the map, and no code
    /// path reassigns `World::map` — `grep -n 'self\.map = ' world/mod.rs`
    /// returns nothing. A round cannot become a space round after it started, so
    /// there is never an animal alive at a switch to remove or to leave.
    #[test]
    fn flipping_the_gravity_field_under_a_landscape_map_does_not_suppress_wildlife() {
        let mut w = World::with_gravity(
            4242,
            MapScale::Small,
            0,
            DEFAULT_MAP_GENERATOR,
            GravityMode::Standard,
        );
        w.set_phase(RoundPhase::Playing);
        assert!(
            w.map.space_geometry().is_none(),
            "precondition: this fixture is not a space map"
        );
        w.gravity = GravityMode::Space;
        let seconds = ANIMAL_INTERVAL.max(BIRD_INTERVAL) + 2.0;
        for _ in 0..(seconds / SIM_DT) as u32 {
            w.step(SIM_DT);
        }
        assert!(
            !w.animals.is_empty() && !w.birds.is_empty(),
            "the suppression is keyed on `self.gravity`, not on the generator: \
             {} animals and {} birds on a landscape map",
            w.animals.len(),
            w.birds.len()
        );
    }
}

/// Fall damage in a real round (T20.11).
///
/// **`docs/20` §9 refuses this feature** — *"Fall damage — deliberately absent in
/// v1 so the jetpack stays forgiving"*, `docs/20-player-movement.md:235` — and
/// `docs/70`–`75` contain no override. It is built on the coordinator's direct
/// ruling of 2026-09-04; the doc is **not** amended here, because a builder does
/// not amend `docs/`. The discrepancy is journalled.
///
/// These go through `World::step`, so they exercise the warmup gate, the `Damage`
/// event and the death attribution rather than `integrate` in isolation —
/// `physics::resolve`'s own tests cover the detector.
#[cfg(test)]
mod fall_damage {
    use super::*;
    use crate::constants::{
        BOOTS_JUMP_HEIGHT_MULT, FALL_DAMAGE_PER_SPEED, FALL_SAFE_SPEED, GRAVITY, JUMP_VELOCITY,
        KNOCKBACK_FIRE_GRACE, LOW_GRAVITY_SCALE, MAX_FALL_SPEED, PLAYER_H, PLAYER_W, SIM_DT,
    };
    use crate::player::input::button;

    fn world() -> World {
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w
    }

    /// A column with flat ground either side, so a 16 px body is not embedded in
    /// a neighbour's hillside — which a first draft of the measurement was, and
    /// it reported a 50 px drop landing at one tick of gravity.
    fn flat_spot(w: &World) -> (f32, f32) {
        let surface = |c: i32| (0..w.map.mask.h as i32).find(|y| w.map.mask.get(c, *y));
        for col in 200..(w.map.mask.w as i32 - 200) {
            let Some(t) = surface(col) else { continue };
            if t < 300 {
                continue;
            }
            if (-10..=10).all(|d| surface(col + d) == Some(t)) {
                return (col as f32, t as f32);
            }
        }
        panic!("no flat spot on this map")
    }

    /// Drop player 0 from `h` px above the ground and return the health it lost.
    ///
    /// Placed and then stepped through the **world**, not through `integrate`, so
    /// everything between the two — the warmup gate, i-frames, the shield — is in
    /// the path exactly as it is in a real round.
    fn drop_player(w: &mut World, h: f32) -> f32 {
        let (x, top) = flat_spot(w);
        let Some(p) = w.player_mut(0) else {
            panic!("no player 0")
        };
        p.body.pos = Vec2::new(x, top - PLAYER_H / 2.0 - h);
        p.body.vel = Vec2::ZERO;
        p.body.grounded = false;
        p.iframes_until = 0.0;
        let before = p.health;
        // **An input every tick, because `apply_inputs` only integrates players
        // who sent one.** A player whose client goes quiet is not simulated at
        // all, so a test that just called `step` would watch a body hang in the
        // air and then assert that falling costs nothing.
        for t in 0..600u32 {
            w.queue_input(0, crate::player::input::Input::new(t + 1, 0, 0));
            w.step(SIM_DT);
            if w.player(0).is_some_and(|p| p.body.grounded) {
                break;
            }
        }
        before - w.player(0).expect("alive").health
    }

    /// The start of a stretch of ground that **descends** to the right, gently
    /// enough for `ground_snap` to hold on: `(x, surface_y)`.
    fn downhill(w: &World) -> (f32, f32) {
        let surface = |c: i32| (0..w.map.mask.h as i32).find(|y| w.map.mask.get(c, *y));
        let run = 90;
        for col in 200..(w.map.mask.w as i32 - 200 - run) {
            let Some(t0) = surface(col) else { continue };
            if t0 < 200 {
                continue;
            }
            let ok = (0..run).all(|d| match (surface(col + d), surface(col + d + 1)) {
                (Some(a), Some(b)) => b >= a && b - a < crate::constants::STEP_DOWN,
                _ => false,
            });
            if ok && surface(col + run) > Some(t0 + PLAYER_H as i32) {
                return (col as f32, t0 as f32);
            }
        }
        panic!("no descending stretch on this map")
    }

    /// What the constants say a landing at `speed` costs. Never a literal.
    fn expected(speed: f32) -> f32 {
        ((speed - FALL_SAFE_SPEED) * FALL_DAMAGE_PER_SPEED).max(0.0)
    }

    #[test]
    fn a_long_fall_hurts_and_a_short_one_does_not() {
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        // The control first, and it is the half `docs/20` §9 was protecting: a
        // drop inside the free height must cost **exactly** nothing, or every
        // ledge in the game becomes a trap.
        let free_height = FALL_SAFE_SPEED * FALL_SAFE_SPEED / (2.0 * crate::constants::GRAVITY);
        assert_eq!(
            drop_player(&mut w, free_height * 0.5),
            0.0,
            "a drop of half the free height cost health"
        );
        // And the claim.
        let hurt = drop_player(&mut w, free_height * 4.0);
        assert!(hurt > 0.0, "a fall of four times the free height was free");
    }

    #[test]
    fn the_damage_is_the_constants_arithmetic_and_not_a_number_someone_liked() {
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        let (x, top) = flat_spot(&w);
        // 200, not 400: at 400 the fall is at `MAX_FALL_SPEED` when it lands and
        // the comparison below would be against a clamp rather than against the
        // speed the body was actually travelling at.
        let h = 200.0;
        if let Some(p) = w.player_mut(0) {
            p.body.pos = Vec2::new(x, top - PLAYER_H / 2.0 - h);
            p.body.vel = Vec2::ZERO;
            p.body.grounded = false;
            p.iframes_until = 0.0;
        }
        let before = w.player(0).expect("seated").health;
        let mut impact = 0.0f32;
        for t in 0..600u32 {
            let vy = w.player(0).expect("alive").body.vel.y;
            w.queue_input(0, crate::player::input::Input::new(t + 1, 0, 0));
            w.step(SIM_DT);
            let p = w.player(0).expect("alive");
            if p.body.landing_impact > 0.0 {
                impact = p.body.landing_impact;
                // `vy` is read **before** `step`, and `integrate` applies one
                // tick of gravity before it meets the ground — so one tick of
                // gravity is the whole permissible gap, and anything wider would
                // be a different number wearing this one's name.
                let slack = crate::constants::GRAVITY * SIM_DT + 0.01;
                assert!(
                    (impact - vy).abs() <= slack,
                    "the reported impact {impact} is not the speed it was falling at \
                     {vy} (+/- {slack:.1})"
                );
                break;
            }
        }
        assert!(impact > FALL_SAFE_SPEED, "the drop was not hard enough");
        let lost = before - w.player(0).expect("alive").health;
        assert!(
            (lost - expected(impact)).abs() < 0.01,
            "a {impact:.0} px/s landing cost {lost:.2}, not {:.2}",
            expected(impact)
        );
    }

    #[test]
    fn a_harder_landing_costs_more() {
        // A single height proves the formula was applied once; two prove it
        // scales, which is the property the player is actually judging.
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        // **Both drops have to land *inside* the damaging band**, and multiples
        // of the free height stopped doing that on 2026-09-16: `resolve.rs`
        // clamps to `MAX_FALL_SPEED` at a ~400 px drop, and once the free height
        // doubled to 165 px, `free_height * 2` and `free_height * 6` both
        // saturated — two different heights, one identical 10.18 hp, and the
        // test read as "harder landings cost the same".
        //
        // So the heights are derived from the **band** rather than from the
        // threshold: a third and two thirds of the way from `FALL_SAFE_SPEED` to
        // `MAX_FALL_SPEED`. That is inside the clamp by construction, and it
        // stays inside it whatever either constant does next.
        let band = MAX_FALL_SPEED - FALL_SAFE_SPEED;
        let height_for = |v: f32| v * v / (2.0 * crate::constants::GRAVITY);
        let near = drop_player(&mut w, height_for(FALL_SAFE_SPEED + band / 3.0));
        if let Some(p) = w.player_mut(0) {
            p.health = crate::constants::BASE_HEALTH;
        }
        let far = drop_player(&mut w, height_for(FALL_SAFE_SPEED + band * 2.0 / 3.0));
        assert!(near > 0.0 && far > near, "{near} then {far}");
    }

    #[test]
    fn the_deepest_possible_fall_is_survivable_from_full_health() {
        // `docs/20` §9 refused fall damage so the jetpack would stay forgiving.
        // This is the part of that objection which stays honoured: terminal
        // velocity is a serious cost and never an instant death.
        assert!(
            expected(MAX_FALL_SPEED) < crate::constants::BASE_HEALTH,
            "a terminal-velocity landing costs {:.0} of {:.0}",
            expected(MAX_FALL_SPEED),
            crate::constants::BASE_HEALTH
        );
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        let hurt = drop_player(&mut w, 900.0);
        assert!(
            w.player(0).expect("alive").alive,
            "a fall killed a full bar"
        );
        assert!(hurt > 0.0);
    }

    /// **The owner's words, in numbers (T21.29).** Reported from play on
    /// 2026-09-15: *"fall damage is still way to high … reduce it by 300%"*,
    /// ruled as **every landing costs a third of what it did then**.
    ///
    /// A different kind of assertion from the rest of this module, on purpose:
    /// every test above is pinned to `FALL_DAMAGE_PER_SPEED`, so planting the
    /// old value back leaves them all green. This one is pinned to the rate **at
    /// the time of the report** — a historical fact, not a tunable — and to
    /// landings measured through the world, so the constant drifting back up
    /// turns it red.
    #[test]
    fn a_landing_costs_at_most_a_third_of_what_it_did_when_the_owner_reported_it() {
        /// `FALL_DAMAGE_PER_SPEED` on 2026-09-15, when the report was made. The
        /// basis of the claim, so it is a literal by necessity.
        const RATE_WHEN_REPORTED: f32 = 0.075;
        /// **`FALL_SAFE_SPEED` on 2026-09-15, and it has to be a literal for the
        /// same reason the rate is.**
        ///
        /// It was not, and that was a live defect found on 2026-09-16: `then`
        /// was computed as `(impact - FALL_SAFE_SPEED) * RATE_WHEN_REPORTED`,
        /// freezing the rate but reading the threshold from the constant. The
        /// baseline therefore moved whenever the threshold did, so "what it cost
        /// when the owner reported it" silently stopped being that — and when the
        /// threshold doubled the same day, a 112 px drop produced a **negative**
        /// baseline, clamped to zero, and the test's own control fired with "which
        /// was free anyway" about a drop that cost 6.0 hp on the day in question.
        /// Half a frozen basis is not a frozen basis.
        const THRESHOLD_WHEN_REPORTED: f32 = 480.0;
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        let mut costs: Vec<(f32, f32, f32)> = Vec::new();
        // Drops in player heights, from an ordinary ledge to past terminal
        // velocity: the "basic landings" of the report and the worst one.
        for heights in [4.0f32, 8.0, 16.0, 40.0] {
            if let Some(p) = w.player_mut(0) {
                p.health = crate::constants::BASE_HEALTH;
            }
            let (x, top) = flat_spot(&w);
            if let Some(p) = w.player_mut(0) {
                p.body.pos = Vec2::new(x, top - PLAYER_H / 2.0 - heights * PLAYER_H);
                p.body.vel = Vec2::ZERO;
                p.body.grounded = false;
                p.iframes_until = 0.0;
            }
            let before = w.player(0).expect("seated").health;
            let mut impact = 0.0f32;
            for t in 0..600u32 {
                w.queue_input(0, crate::player::input::Input::new(t + 1, 0, 0));
                w.step(SIM_DT);
                let p = w.player(0).expect("alive");
                if p.body.landing_impact > 0.0 {
                    impact = p.body.landing_impact;
                    break;
                }
            }
            let lost = before - w.player(0).expect("alive").health;
            let then = ((impact - THRESHOLD_WHEN_REPORTED) * RATE_WHEN_REPORTED).max(0.0);
            // The control: the drop is one that hurt when reported, so "costs
            // a third" is not satisfied by a landing that was always free.
            assert!(
                then > 0.0,
                "a {heights}-height drop landed at {impact:.0} px/s, which was free anyway"
            );
            assert!(
                lost <= then / 3.0 + 0.01,
                "a {heights}-height drop ({impact:.0} px/s) costs {lost:.2}; it cost \
                 {then:.2} when the owner reported it, and a third of that is {:.2}",
                then / 3.0
            );
            costs.push((heights, impact, lost));
        }

        // **`lost > 0` for every drop was removed on 2026-09-16, because the
        // owner asked for the opposite.** Doubling the free height is *meant* to
        // make the shallow end free — the 4-player-height drop that used to cost
        // 2.0 hp is the one the ask was about. Asserting every listed drop still
        // hurts would have made that requirement unimplementable.
        //
        // What replaces it pins **both ends**, which the old single assertion
        // did not: the shallow drop is free now (and reds if the threshold drifts
        // back down), and the deepest still costs (and reds if fall damage is
        // quietly deleted). An absence needs a presence beside it.
        let (_, shallow_impact, shallow_cost) = costs[0];
        assert_eq!(
            shallow_cost, 0.0,
            "a 4-player-height drop landing at {shallow_impact:.0} px/s cost \
             {shallow_cost:.2} — the owner's doubled free height is not in force"
        );
        let (_, deep_impact, deep_cost) = *costs.last().expect("four drops");
        assert!(
            deep_cost > 0.0,
            "the deepest fall ({deep_impact:.0} px/s) is free — fall damage is \
             not gentler, it is gone"
        );
    }

    #[test]
    fn walking_downhill_never_costs_anything() {
        // The `ground_snap` path, through the world this time: `physics::resolve`
        // proves the detector ignores it, and this proves nothing between the
        // detector and `health` reintroduces it.
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        let (x, top) = downhill(&w);
        if let Some(p) = w.player_mut(0) {
            p.body.pos = Vec2::new(x, top - PLAYER_H / 2.0);
            p.body.grounded = true;
        }
        let before = w.player(0).expect("seated").health;
        let start = w.player(0).expect("seated").body.pos;
        let mut seq = 0u32;
        for _ in 0..600 {
            seq += 1;
            w.queue_input(0, crate::player::input::Input::new(seq, button::RIGHT, 0));
            w.step(SIM_DT);
        }
        let end = w.player(0).expect("alive").body.pos;
        // The control, in both axes: it actually walked, and the ground it walked
        // over actually fell away. Without them the assertion below passes for a
        // player who hit a wall on the second tick — which a first draft did, on a
        // flat spot 21 columns wide, and it reported 30 px travelled.
        assert!(
            (end.x - start.x).abs() > PLAYER_W * 4.0,
            "the player only travelled {:.0} px",
            end.x - start.x
        );
        assert!(
            end.y - start.y > PLAYER_H,
            "the ground only fell {:.0} px, so this is not a downhill test",
            end.y - start.y
        );
        assert_eq!(
            w.player(0).expect("alive").health,
            before,
            "walking cost health"
        );
    }

    /// Settle player 0 on flat ground, jump **once**, and report
    /// `(health lost, landing impact, apex in px above the launch)`.
    ///
    /// The apex is here rather than in a second fixture because
    /// `a_jump_is_free_under_every_gravity_mode_booted_or_bare` needs it as its
    /// non-vacuity control and the alternative was a forty-line copy of this
    /// function that could drift from it.
    ///
    /// A real jump through `World::step`, not a body placed in the air: the
    /// exemption is gated on `ticks_since_jump`, which only a launch through
    /// `try_jump` ever resets. A test that teleported a body upward would pass
    /// for the wrong reason — or fail for one.
    ///
    /// One press and then release. A **held** JUMP engages the jetpack after
    /// `JETPACK_HOLD_DELAY` and would turn this into a measurement of thrust.
    fn jump_from_flat(w: &mut World) -> (f32, f32, f32) {
        let (x, top) = flat_spot(w);
        {
            let Some(p) = w.player_mut(0) else {
                panic!("no player 0")
            };
            p.body.pos = Vec2::new(x, top - PLAYER_H / 2.0);
            p.body.vel = Vec2::ZERO;
            p.iframes_until = 0.0;
        }
        // Seq 0, "numbered by the world" (T22.10G): a client-numbered first input
        // waits out the jitter buffer's lead, which put the jump two ticks after
        // the tick this reads it on and cut the low-gravity apex short.
        let tick = |w: &mut World, buttons: u8| {
            w.queue_input(0, crate::player::input::Input::new(0, buttons, 0));
            w.step(SIM_DT);
        };
        for _ in 0..90 {
            tick(w, 0);
        }
        assert!(
            w.player(0).expect("ana").body.grounded,
            "the fixture never settled, so it is measuring a drop and not a jump"
        );
        let before = w.player(0).expect("ana").health;
        let ground_y = w.player(0).expect("ana").body.pos.y;
        tick(w, button::JUMP);
        assert!(
            !w.player(0).expect("ana").body.grounded,
            "the jump never left the ground"
        );
        let mut peak = w.player(0).expect("ana").body.pos.y;
        // 600 ticks is ten seconds. Hang time is `2v/gk`, so half gravity doubles
        // it — 74 ticks against 37 — and this is still an order of magnitude of
        // slack rather than a wait tuned to a tunable.
        for _ in 0..600 {
            tick(w, 0);
            peak = peak.min(w.player(0).expect("ana").body.pos.y);
            if w.player(0).expect("ana").body.grounded {
                break;
            }
        }
        let p = w.player(0).expect("ana");
        assert!(p.body.grounded, "the jump never came down");
        (before - p.health, p.body.landing_impact, ground_y - peak)
    }

    /// The **boots** half of `fall_damage_exempt`, ruled narrow 2026-09-08.
    ///
    /// Four assertions, and the controls are the whole test:
    ///
    ///  - an **ordinary** jump costs nothing, which is the property the base
    ///    game has by arithmetic and the boots break;
    ///  - a **booted** jump costs nothing too;
    ///  - and it lands **past `FALL_SAFE_SPEED`**, which is what stops the line
    ///    above being vacuous. Without it the test passes for boots that never
    ///    changed the jump at all, since a 430 px/s landing is free anyway;
    ///  - a fall deep enough to beat even the **scaled** threshold still costs,
    ///    and costs less than it costs unbooted. That is what reds if anyone
    ///    writes immunity where the ruling says scale.
    #[test]
    fn a_booted_jump_lands_free_and_a_deep_fall_still_costs_but_costs_less() {
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        let (bare_cost, bare_impact, _) = jump_from_flat(&mut w);
        assert_eq!(
            bare_cost, 0.0,
            "an ordinary jump cost health — the base game's own property is gone"
        );
        assert!(
            bare_impact <= FALL_SAFE_SPEED,
            "an ordinary jump landed at {bare_impact}, past FALL_SAFE_SPEED \
             {FALL_SAFE_SPEED} — it is free by exemption, not by arithmetic"
        );

        let mut w = world();
        w.add_player(0, 0, "ana".into());
        give(&mut w, 0, crate::items::registry::IRONMAN_BOOTS, 1);
        let (booted_cost, booted_impact, _) = jump_from_flat(&mut w);
        assert_eq!(
            booted_cost, 0.0,
            "a booted jump landing at {booted_impact} px/s was charged {booted_cost} \
             health for its own landing"
        );
        // The observation the comment below rests on, stated as a number rather
        // than as prose: since 2026-09-16 the booted jump lands *under* the bare
        // threshold. If this ever stops holding, the control below is no longer
        // the only thing keeping the boots' fall half honest — read both.
        assert!(
            booted_impact < FALL_SAFE_SPEED,
            "a booted jump now lands at {booted_impact}, past the bare \
             {FALL_SAFE_SPEED} — the boots' own-jump protection is load-bearing \
             again and the note below is stale"
        );

        // **The non-vacuity control, moved off the booted jump on 2026-09-16.**
        //
        // It used to assert `booted_impact > FALL_SAFE_SPEED` — the booted jump
        // must land somewhere the base rule would charge, or "boots forgive it"
        // forgives nothing. That stopped being true the day the owner doubled the
        // free drop height: everyone is now safe to 165 px and a booted jump only
        // reaches 141, so it lands at 638 against a 678.8 threshold and is free
        // **by the base rule**. The boots are not doing the forgiving any more.
        //
        // That is worth knowing rather than asserting around, so it is stated:
        // `boots_fall_safe_speed` is currently redundant for a booted player's
        // own jump. What it still does is raise the threshold for *falls*, and
        // that is where the control belongs now — there has to exist a landing
        // the base rule charges and the booted rule does not, or the item's fall
        // half is dead weight.
        let bare_t = FALL_SAFE_SPEED;
        let boots_t = crate::constants::boots_fall_safe_speed();
        assert!(
            boots_t > bare_t,
            "boots protect to {boots_t} against a bare {bare_t} — the raised \
             threshold forgives no landing at all"
        );
        let between = (bare_t + boots_t) / 2.0;
        let h_between = between * between / (2.0 * crate::constants::GRAVITY);
        let mut wb = world();
        wb.add_player(0, 0, "ana".into());
        let charged_bare = drop_player(&mut wb, h_between);
        let mut wc = world();
        wc.add_player(0, 0, "ana".into());
        give(&mut wc, 0, crate::items::registry::IRONMAN_BOOTS, 1);
        let charged_booted = drop_player(&mut wc, h_between);
        assert!(
            charged_bare > 0.0,
            "a {h_between:.0} px drop was free even bare-footed, so the pair \
             below compares two free landings"
        );
        assert_eq!(
            charged_booted, 0.0,
            "a {h_between:.0} px drop cost a booted player {charged_booted} — \
             it sits between the two thresholds and should be free in boots"
        );

        // **A scale, not immunity.** A fall deep enough to beat even the scaled
        // threshold still costs — and costs less than it costs unbooted. This is
        // the assertion that reds if anyone writes immunity instead of a scale,
        // and the height is derived from the scaled threshold itself so it
        // cannot end up sitting on the boundary.
        let safe = crate::constants::boots_fall_safe_speed();
        let boots_free_height = safe * safe / (2.0 * crate::constants::GRAVITY);
        // Half again past the booted free height, so the drop is unambiguously
        // beyond it rather than at it.
        let deep = boots_free_height * 1.5;

        let mut bare_w = world();
        bare_w.add_player(0, 0, "ana".into());
        let bare = drop_player(&mut bare_w, deep);
        assert!(
            bare > 0.0,
            "the control drop of {deep} px cost an unbooted player nothing, so \
             the comparison below discriminates nothing"
        );

        let mut booted_w = world();
        booted_w.add_player(0, 0, "ana".into());
        give(&mut booted_w, 0, crate::items::registry::IRONMAN_BOOTS, 1);
        let booted_deep = drop_player(&mut booted_w, deep);
        assert!(
            booted_deep > 0.0,
            "a {deep} px fall cost a booted player nothing — that is immunity, \
             and the ruling is a scaled threshold"
        );
        assert!(
            booted_deep < bare,
            "boots did not reduce a deep fall at all: {booted_deep} against \
             {bare} unbooted"
        );
    }

    /// **T22.02 x T21.02 — boots under low gravity, stated rather than
    /// discovered.**
    ///
    /// `T22.02` required the boots interaction *stated*, and the commit that
    /// landed it stated only wings (`jetpack::gravity_scale`). This is the
    /// boots half.
    ///
    /// # The claim
    ///
    /// **T21.02's invariant — "you are safe from the height your own jump
    /// reaches" — is gravity-invariant, and not by luck.** You land from your
    /// own jump at exactly the speed you launched at:
    /// `sqrt(2·g·k·(v²/2·g·k)) = v`, with `k` cancelling. Both thresholds
    /// (`FALL_SAFE_SPEED`, `boots_fall_safe_speed()`) are **speeds**, and
    /// neither scales with the mode. So the margin is identical under every
    /// gravity, and what low gravity changes is only the **height** the same
    /// free landing arrives from.
    ///
    /// Arithmetic at today's constants, computed from them here rather than
    /// quoted from anywhere (`GRAVITY` 1400, `JUMP_VELOCITY` 430,
    /// `BOOTS_JUMP_HEIGHT_MULT` 2.25, `BOOTS_FALL_HEIGHT_MULT` 3.0,
    /// `FALL_SAFE_SPEED` 678.8, `LOW_GRAVITY_SCALE` 0.5):
    ///
    /// ```text
    ///                        bare    booted
    ///     launch speed        430       645   px/s   (mode-independent)
    ///     safe landing      678.8     744.8   px/s   (mode-independent)
    ///     apex, standard       66     148.5   px
    ///     apex, low           132       297   px
    ///     free drop, std      165       198   px
    ///     free drop, low      329       396   px
    /// ```
    ///
    /// Free drop beats apex in all four cells — 165 > 66, 198 > 148.5,
    /// 329 > 132, 396 > 297 — so low gravity breaks neither the booted
    /// invariant nor the bare one. A booted player in low gravity floats to
    /// **297 px** and lands for nothing; the same player needs **396 px** of
    /// *dropped* height before anything is charged.
    ///
    /// # What this test can and cannot report
    ///
    /// **The height relation is already pinned at compile time and this cannot
    /// improve on that.** Free-for-your-own-jump is exactly
    /// `BOOTS_JUMP_HEIGHT_MULT <= BOOTS_FALL_HEIGHT_MULT` (the roots cancel),
    /// which is the `const _: () = assert!(BOOTS_FALL_HEIGHT_MULT >=
    /// BOOTS_JUMP_HEIGHT_MULT)` beside `boots_fall_safe_speed`. Planting a
    /// bigger `BOOTS_JUMP_HEIGHT_MULT` fails the **build**, so it never reaches
    /// here — measured: 3.1 is `error[E0080]` on that assert, and 2.9, the
    /// largest value that still compiles, leaves this test green. Recorded
    /// because the obvious falsification is the one that proves nothing.
    ///
    /// **What it does report** is an effect, measured through `World::step`:
    /// that "jump higher in low gravity" was implemented as a *gravity* scale
    /// and not as a launch-velocity boost. A boost makes you land faster than
    /// you launched, and the thresholds do not move with it. Falsified by
    /// planting a `* 1.5` on `movement.rs::try_jump`'s
    /// `body.vel.y = -JUMP_VELOCITY * jump_multiplier`, which reds at
    /// *"landed at 638.3 px/s from a 430.0 px/s launch"*. The apex control is
    /// falsified separately, by pinning `World::apply_inputs`'s
    /// `let gravity = self.gravity` to `Standard`: *"the low-gravity apex was
    /// 62.5 px against 62.5 px standard"*.
    ///
    /// Structurally, the reason the mode cannot reach this at all today is that
    /// neither `try_jump` nor `PlayerState::fall_safe_speed` receives a
    /// `GravityMode`. **`T22.11` is about to thread the mode into four more
    /// call sites (R10/R30); if either of those two grows one, this test is
    /// where that shows up.**
    #[test]
    fn a_jump_is_free_under_every_gravity_mode_booted_or_bare() {
        let mut apexes: Vec<(GravityMode, bool, f32, f32)> = Vec::new();
        for mode in [GravityMode::Standard, GravityMode::Low] {
            for booted in [false, true] {
                let mut w = world();
                // The one seam the mode travels: `World::apply_inputs` reads it
                // off the world and hands it to `apply_input`.
                w.gravity = mode;
                w.add_player(0, 0, "ana".into());
                if booted {
                    give(&mut w, 0, crate::items::registry::IRONMAN_BOOTS, 1);
                }
                let (cost, impact, apex) = jump_from_flat(&mut w);
                let threshold = if booted {
                    crate::constants::boots_fall_safe_speed()
                } else {
                    FALL_SAFE_SPEED
                };
                assert_eq!(
                    cost, 0.0,
                    "{mode:?}, booted={booted}: a player's own jump from flat                      ground cost {cost} health, landing at {impact:.1} px/s                      against a threshold of {threshold:.1} — T21.02's                      'safe from the height your own jump reaches' is broken in                      this mode"
                );
                // The absence above needs a presence: a landing that never
                // happened also costs nothing.
                assert!(
                    impact > 0.0,
                    "{mode:?}, booted={booted}: the jump reported no landing                      impact at all, so 'it cost nothing' says nothing"
                );
                // And the real quantity, not the charge derived from it: you
                // land at the speed you launched at, whatever `k` is.
                let launch = JUMP_VELOCITY
                    * if booted {
                        crate::constants::boots_jump_velocity_mult()
                    } else {
                        1.0
                    };
                assert!(
                    impact <= launch + GRAVITY * SIM_DT,
                    "{mode:?}, booted={booted}: landed at {impact:.1} px/s from                      a {launch:.1} px/s launch — more than one tick of gravity                      over, so the mode is changing the launch and not the pull"
                );
                apexes.push((mode, booted, apex, impact));
            }
        }

        // The non-vacuity control for the low arm: low gravity really did carry
        // the same free landing up from a higher apex. Without this the four
        // assertions above are satisfied by a `Low` that reached nothing.
        for booted in [false, true] {
            let std = apexes
                .iter()
                .find(|a| a.0 == GravityMode::Standard && a.1 == booted)
                .map(|a| a.2)
                .expect("standard arm");
            let low = apexes
                .iter()
                .find(|a| a.0 == GravityMode::Low && a.1 == booted)
                .map(|a| a.2)
                .expect("low arm");
            // `v²/2gk` against `v²/2g`, less the same Euler shortfall in both,
            // so the ratio is a little under `1/k`. A tenth is slack for that.
            let want = 1.0 / LOW_GRAVITY_SCALE;
            assert!(
                low > std * (want - 0.1),
                "booted={booted}: the low-gravity apex was {low:.1} px against                  {std:.1} px standard — expected about {:.1}x, so the mode is                  not reaching the jump at all and the free landings above are                  four copies of the standard one",
                want
            );
        }

        // And the boots are still doing something in low gravity, which is the
        // interaction the task asked to be stated: the booted apex is the
        // height multiplier over the bare one, in the low mode too.
        let bare_low = apexes
            .iter()
            .find(|a| a.0 == GravityMode::Low && !a.1)
            .map(|a| a.2)
            .expect("bare low");
        let booted_low = apexes
            .iter()
            .find(|a| a.0 == GravityMode::Low && a.1)
            .map(|a| a.2)
            .expect("booted low");
        assert!(
            booted_low > bare_low * (BOOTS_JUMP_HEIGHT_MULT - 0.25),
            "in low gravity a booted jump reached {booted_low:.1} px against a              bare {bare_low:.1} — the {BOOTS_JUMP_HEIGHT_MULT}x height              multiplier did not survive the mode"
        );
    }

    #[test]
    fn a_knocked_player_lands_free_and_the_exemption_expires() {
        // **`was_knocked`, reused unchanged** — the ruling. Both halves, because
        // an exemption with no expiry test is an exemption that never ends and an
        // expiry with no control is satisfied by a fall that never hurt anyone.
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        let (x, top) = flat_spot(&w);
        // **200 px, and the height is the point.** The grace is 0.6 s and a fall
        // has to both exceed `FALL_SAFE_SPEED` *and* land inside it for the
        // exemption to be the thing under test: from rest a body passes 480 px/s
        // at 0.34 s and 200 px takes 0.53 s, landing at a measured 747. A 400 px
        // drop takes 0.75 s, expires the grace on the way down, and would test
        // nothing — which is the ruling restated as arithmetic: a blast that also
        // drops you off a real ledge is not exempt from the ledge.
        let high = 200.0;

        let place = |w: &mut World| {
            if let Some(p) = w.player_mut(0) {
                p.body.pos = Vec2::new(x, top - PLAYER_H / 2.0 - high);
                p.body.vel = Vec2::ZERO;
                p.body.grounded = false;
                p.iframes_until = 0.0;
                p.health = crate::constants::BASE_HEALTH;
            }
        };

        // Exempt: knocked at the moment the fall starts.
        place(&mut w);
        let now = w.round_time;
        if let Some(p) = w.player_mut(0) {
            p.knocked_until = now + KNOCKBACK_FIRE_GRACE;
        }
        let before = w.player(0).expect("seated").health;
        for t in 0..600u32 {
            w.queue_input(0, crate::player::input::Input::new(t + 1, 0, 0));
            w.step(SIM_DT);
            if w.player(0).is_some_and(|p| p.body.grounded) {
                break;
            }
        }
        let landed_at = w.player(0).expect("alive").body.landing_impact;
        assert_eq!(
            w.player(0).expect("alive").health,
            before,
            "a knocked player was charged for the landing"
        );

        // And the control: the same fall with the grace expired.
        place(&mut w);
        let now = w.round_time;
        if let Some(p) = w.player_mut(0) {
            p.knocked_until = now - 0.001;
        }
        let before = w.player(0).expect("seated").health;
        for t in 0..600u32 {
            w.queue_input(0, crate::player::input::Input::new(t + 1, 0, 0));
            w.step(SIM_DT);
            if w.player(0).is_some_and(|p| p.body.grounded) {
                break;
            }
        }
        assert!(
            w.player(0).expect("alive").health < before,
            "the exemption never expires"
        );
        // And the control the *first* half needs: the exempt landing was one that
        // would otherwise have been charged. Without it "no damage while knocked"
        // is satisfied by a drop too soft to hurt anybody.
        assert!(
            landed_at > FALL_SAFE_SPEED,
            "the exempt fall landed at {landed_at:.0} px/s, under the {FALL_SAFE_SPEED:.0} \
             threshold — it was free for the wrong reason"
        );
    }

    #[test]
    fn no_fall_damage_during_warmup() {
        // It goes through `apply_damage_log`, which is the one warmup gate. The
        // control is the same fall in `Playing`, above.
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_phase(RoundPhase::Warmup);
        w.add_player(0, 0, "ana".into());
        assert_eq!(drop_player(&mut w, 600.0), 0.0, "warmup charged for a fall");
    }

    #[test]
    fn a_fall_emits_a_damage_event_rather_than_editing_health_behind_everyones_back() {
        // Assert on the effect the rest of the game reads, not on the subtraction.
        // A `health -=` in `apply_inputs` would pass every test above and leave
        // the client's health bar, the kill feed and the hit marker with nothing.
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        let _ = w.drain_events();
        let hurt = drop_player(&mut w, 600.0);
        assert!(hurt > 0.0);
        let fall_damage: Vec<f32> = w
            .events
            .iter()
            .filter_map(|e| match e {
                GameEvent::Damage {
                    victim: 0, amount, ..
                } => Some(*amount),
                _ => None,
            })
            .collect();
        assert_eq!(fall_damage.len(), 1, "{fall_damage:?}");
        assert!((fall_damage[0] - hurt).abs() < 0.01);
    }

    #[test]
    fn a_fall_you_caused_yourself_is_a_self_kill_and_not_the_weather() {
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        if let Some(p) = w.player_mut(0) {
            p.health = 1.0;
        }
        let _ = w.drain_events();
        drop_player(&mut w, 600.0);
        let death = w.events.iter().find_map(|e| match e {
            GameEvent::Death { cause, .. } => Some(*cause),
            _ => None,
        });
        assert_eq!(
            death,
            Some(DeathCause::SelfInflicted),
            "a solo fall was narrated as something else"
        );
    }

    #[test]
    fn being_blasted_off_a_ledge_still_credits_the_blast() {
        // `docs/21` §4: knocking someone into a hazard rewards the knocker, and a
        // ledge is a hazard. The fall must not overwrite a live claim — which is
        // the whole reason `apply_damage`'s `Fall` arm defers rather than writing
        // itself in unconditionally.
        let mut w = world();
        w.add_player(0, 0, "ana".into());
        w.add_player(1, 0, "bo".into());
        if let Some(p) = w.player_mut(0) {
            p.health = 1.0;
        }
        let now = w.round_time;
        // Player 1 damaged them a moment ago, and the knockback grace is already
        // over — so the fall is charged and the credit is still 1's.
        if let Some(p) = w.player_mut(0) {
            p.last_damaged_by = Some((1, now));
            p.knocked_until = now - 0.001;
        }
        let _ = w.drain_events();
        drop_player(&mut w, 600.0);
        let death = w.events.iter().find_map(|e| match e {
            GameEvent::Death {
                victim: 0, cause, ..
            } => Some(*cause),
            _ => None,
        });
        assert_eq!(
            death,
            Some(DeathCause::Player(1)),
            "the blast lost its kill"
        );
    }

    #[test]
    fn the_state_hash_is_unmoved_by_a_landing_and_moved_by_the_health_it_cost() {
        // `landing_impact` is deliberately **not** hashed: it is recomputed from
        // hashed state every tick and is zero on all but one. What must be hashed
        // is the health it took, and that already is.
        let mut a = world();
        let mut b = world();
        a.add_player(0, 0, "ana".into());
        b.add_player(0, 0, "ana".into());
        assert_eq!(a.state_hash(), b.state_hash());
        if let Some(p) = a.player_mut(0) {
            p.body.landing_impact = 123.0;
        }
        assert_eq!(
            a.state_hash(),
            b.state_hash(),
            "landing_impact reached the hash"
        );
        if let Some(p) = a.player_mut(0) {
            p.health -= 1.0;
        }
        assert_ne!(a.state_hash(), b.state_hash());
    }
}

#[cfg(test)]
mod t19_24_forced_effect_seed {
    use super::*;
    use crate::effects::lava::LavaBurst;

    /// `WEATHER=lava` must broadcast the seed it is actually simulating.
    ///
    /// **This was `seed: 0` while the effect installed with
    /// `self.seed ^ id * K`.** It was inert for as long as nothing on the client
    /// read the seed; T19.24 makes the client derive vent positions from it, so
    /// the dev switch would have simulated one set of vents and told every client
    /// about a different one — fire drawn where there is none, and none where the
    /// ground is opening. Exactly the failure the cross-checks exist to prevent,
    /// arriving through the one path no cross-check covered.
    ///
    /// Asserted through the vents rather than by comparing two `u64`s: what has
    /// to agree is *where the ground opens*, and a test on the number alone would
    /// pass a build where the derivation was right and the install was wrong.
    #[test]
    fn always_lava_broadcasts_the_seed_it_simulates() {
        let mut w = World::for_test(4242, MapScale::Small);
        w.weather_mode = WeatherMode::Always(EffectKind::LavaBurst);
        w.set_phase(RoundPhase::Playing);

        let mut announced: Option<u64> = None;
        for _ in 0..8 {
            w.step(crate::constants::SIM_DT);
            for e in w.drain_events() {
                if let GameEvent::EffectStart { kind, seed, .. } = e {
                    if kind == EffectKind::LavaBurst {
                        announced = Some(seed);
                    }
                }
            }
            if announced.is_some() {
                break;
            }
        }
        let seed = announced.expect("Always(LavaBurst) never announced a start");

        let simulated = w.lava_vent_positions_for_test();
        assert!(
            !simulated.is_empty(),
            "no vents were installed — the comparison below would be two empty lists"
        );

        // What a client does with the number it was given.
        let derived: Vec<(i32, i32)> = LavaBurst::new(seed, &w.map, 0.0)
            .vents()
            .iter()
            .map(|v| (v.pos.x as i32, v.pos.y as i32))
            .collect();

        assert_eq!(
            derived, simulated,
            "the broadcast seed derives different vents than the server is simulating"
        );
    }
}

/// T21.01 — vampire fangs.
///
/// Driven through `World::apply_damage_log`, which is **the** damage funnel:
/// its own doc comment records that every source of damage in the game —
/// weapons, explosions, hitscan, toxic, lava — arrives through it, which is why
/// the warmup gate can live there. Calling it is therefore exercising the
/// production path rather than a test-only shim. Flying a real rocket would add
/// the projectile simulation and the map generator to every assertion below,
/// and those two are what make such a fixture flaky rather than informative.
#[cfg(test)]
mod vampire_fangs {
    use super::*;
    use crate::constants::{
        MapScale, BASE_HEALTH, BATTERY_MAX, LIFESTEAL_DAMAGE_PER_HP, SHIELD_DAMAGE_MULT,
    };
    use crate::items::registry::{
        SHIELD_GENERATOR, VAMPIRE_FANGS, WEAPON_BAZOOKA, WEAPON_FLAME, WEAPON_FLAMETHROWER,
        WEAPON_KNIFE, WEAPON_LASER_PISTOL,
    };
    use crate::weapons::explode::EffectKind;

    /// Attacker 0, victim 1, both past their spawn i-frames.
    fn duel() -> World {
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w.add_player(1, 1, "bo".into());
        for id in [0, 1] {
            if let Some(p) = w.player_mut(id) {
                // `SPAWN_IFRAMES` would make every hit below a no-op, and
                // `apply_damage` returning false is indistinguishable from a
                // rule that declined to heal.
                p.iframes_until = -1.0;
            }
        }
        w
    }

    fn shot(weapon: WeaponId) -> DamageSource {
        DamageSource::Player { id: 0, weapon }
    }

    /// One log entry, through the funnel.
    fn hit(w: &mut World, amount: f32, src: DamageSource) {
        let log: DamageLog = Default::default();
        log.borrow_mut().push((1, amount, src));
        w.apply_damage_log(&log, &Default::default(), &Default::default(), 1.0);
    }

    fn health(w: &World, id: PlayerId) -> f32 {
        w.player(id).expect("player").health
    }

    /// Attacker 0 with fangs and `BASE_HEALTH - room` health, so a heal has
    /// somewhere to go and is not silently swallowed by the cap.
    fn fanged(room: f32) -> World {
        let mut w = duel();
        give(&mut w, 0, VAMPIRE_FANGS, 1);
        if let Some(p) = w.player_mut(0) {
            p.health = BASE_HEALTH - room;
        }
        w
    }

    #[test]
    fn ten_damage_returns_exactly_one_health_and_no_fangs_returns_none() {
        let mut w = fanged(20.0);
        let before = health(&w, 0);
        hit(&mut w, LIFESTEAL_DAMAGE_PER_HP, shot(WEAPON_BAZOOKA));
        assert_eq!(
            health(&w, 0) - before,
            1.0,
            "the ratio is `damage / LIFESTEAL_DAMAGE_PER_HP`, so one unit of it is 1 hp"
        );

        // **The control.** Without it "health went up" is satisfied by any
        // regeneration the game might grow later, and by a rule that heals
        // everyone.
        let mut w = duel();
        if let Some(p) = w.player_mut(0) {
            p.health = BASE_HEALTH - 20.0;
        }
        let before = health(&w, 0);
        hit(&mut w, LIFESTEAL_DAMAGE_PER_HP, shot(WEAPON_BAZOOKA));
        assert_eq!(
            health(&w, 0),
            before,
            "the identical shot healed an attacker who was not wearing the fangs"
        );
    }

    /// The rounding rule, stated as a test: **there is none.**
    ///
    /// Half the ratio returns half a point, and two of those sum to exactly the
    /// same 1.0 that one whole hit gives. That equality is what makes a stored
    /// fractional carry unnecessary — and it is the assertion that would fail if
    /// somebody replaced the ratio with a `floor` at the site.
    #[test]
    fn a_partial_hit_returns_a_partial_point_and_two_halves_make_a_whole() {
        let half = LIFESTEAL_DAMAGE_PER_HP / 2.0;

        let mut w = fanged(20.0);
        let before = health(&w, 0);
        hit(&mut w, half, shot(WEAPON_BAZOOKA));
        assert_eq!(health(&w, 0) - before, 0.5);

        let mut w = fanged(20.0);
        let before = health(&w, 0);
        hit(&mut w, half, shot(WEAPON_BAZOOKA));
        hit(&mut w, half, shot(WEAPON_BAZOOKA));
        assert_eq!(
            health(&w, 0) - before,
            1.0,
            "5 damage twice must equal 10 damage once, or the rule needs a carry"
        );
    }

    /// The boundary, both sides of it, in one test — an absence needs a
    /// presence beside it or "nothing healed" is satisfied by fangs that never
    /// work at all.
    #[test]
    fn only_a_weapon_that_flies_feeds_the_fangs() {
        let d = LIFESTEAL_DAMAGE_PER_HP;
        let cases: [(&str, DamageSource, f32); 6] = [
            // Presence: a rocket flies, and so does a bullet.
            ("bazooka", shot(WEAPON_BAZOOKA), 1.0),
            // Absence: a swing never leaves your hand...
            ("knife", shot(WEAPON_KNIFE), 0.0),
            // ...a flame is a field you stand in — and note **both** ids. The
            // weapon a player carries is `WEAPON_FLAMETHROWER`, but what
            // `flame.rs` actually logs is `WEAPON_FLAME`, which is a
            // `Delivery::Projectile`. A rule keyed on the delivery alone would
            // pass the first of these and fail the second, so the second is the
            // one that guards the real path.
            ("flamethrower", shot(WEAPON_FLAMETHROWER), 0.0),
            ("one flame", shot(WEAPON_FLAME), 0.0),
            // ...a beam arrives the instant it is fired...
            ("laser pistol", shot(WEAPON_LASER_PISTOL), 0.0),
            // ...and weather has no attacker at all.
            (
                "toxic rain",
                DamageSource::Weather(EffectKind::ToxicRain),
                0.0,
            ),
        ];
        for (name, src, want) in cases {
            let mut w = fanged(20.0);
            let before = health(&w, 0);
            hit(&mut w, d, src);
            assert_eq!(
                health(&w, 0) - before,
                want,
                "{name}: expected {want} hp of lifesteal"
            );
        }
    }

    /// The exploit this note exists to prevent: a rocket at your own feet.
    #[test]
    fn self_damage_and_a_fall_never_feed_the_fangs() {
        for src in [
            DamageSource::SelfInflicted {
                weapon: WEAPON_BAZOOKA,
            },
            DamageSource::Fall,
        ] {
            let mut w = fanged(20.0);
            // The victim of a self-hit is the attacker, so aim the log at them.
            if let Some(p) = w.player_mut(0) {
                p.iframes_until = -1.0;
            }
            let log: DamageLog = Default::default();
            log.borrow_mut().push((0, LIFESTEAL_DAMAGE_PER_HP, src));
            let before = health(&w, 0);
            w.apply_damage_log(&log, &Default::default(), &Default::default(), 1.0);
            assert!(
                health(&w, 0) < before,
                "{src:?}: the fixture did not even hurt anybody"
            );
            // Hurt by exactly the damage, with nothing given back.
            assert_eq!(
                before - health(&w, 0),
                LIFESTEAL_DAMAGE_PER_HP,
                "{src:?}: hurting yourself paid you back"
            );
        }
    }

    /// The brief's second clause, and its mirror. Both directions, because
    /// "energy went up" and "health went up" are each satisfied by a rule that
    /// always does the same thing.
    #[test]
    fn a_victim_with_a_generator_pays_in_energy_and_one_without_pays_in_health() {
        let d = LIFESTEAL_DAMAGE_PER_HP;

        // With a generator on the victim.
        let mut w = fanged(20.0);
        give(&mut w, 1, SHIELD_GENERATOR, 1);
        if let Some(p) = w.player_mut(1) {
            p.battery = BATTERY_MAX;
        }
        let (h0, b0) = {
            let p = w.player(0).expect("ana");
            (p.health, p.battery)
        };
        hit(&mut w, d, shot(WEAPON_BAZOOKA));
        let p = w.player(0).expect("ana");
        assert_eq!(p.health, h0, "a shielded victim still paid in health");
        // **And the amount is what *landed*, not what was rolled.** The victim's
        // generator ate a quarter of the hit, so the fangs are a fraction of the
        // three quarters that got through — which is the "dealt or absorbed"
        // decision, asserted rather than described.
        assert_eq!(
            p.battery - b0,
            d * SHIELD_DAMAGE_MULT / LIFESTEAL_DAMAGE_PER_HP,
            "energy gained must be a fraction of the damage that landed"
        );

        // The mirror: no generator, so health and not energy.
        let mut w = fanged(20.0);
        let (h0, b0) = {
            let p = w.player(0).expect("ana");
            (p.health, p.battery)
        };
        hit(&mut w, d, shot(WEAPON_BAZOOKA));
        let p = w.player(0).expect("ana");
        assert_eq!(p.health - h0, 1.0);
        assert_eq!(p.battery, b0, "an unshielded victim paid in energy");
    }

    /// A full-health attacker banks nothing — `BASE_HEALTH`, not `HEALTH_CAP`:
    /// the fangs restore, they do not overheal.
    #[test]
    fn a_full_health_attacker_discards_the_heal_and_does_not_overheal() {
        let mut w = fanged(0.0);
        assert_eq!(health(&w, 0), BASE_HEALTH, "the fixture is not at full");
        hit(&mut w, LIFESTEAL_DAMAGE_PER_HP * 4.0, shot(WEAPON_BAZOOKA));
        assert_eq!(
            health(&w, 0),
            BASE_HEALTH,
            "the fangs overhealed past BASE_HEALTH"
        );

        // And an attacker who is *already* overhealed is not pulled back down to
        // BASE_HEALTH by landing a hit.
        let mut w = fanged(0.0);
        if let Some(p) = w.player_mut(0) {
            p.health = crate::constants::HEALTH_CAP;
        }
        hit(&mut w, LIFESTEAL_DAMAGE_PER_HP, shot(WEAPON_BAZOOKA));
        assert_eq!(
            health(&w, 0),
            crate::constants::HEALTH_CAP,
            "landing a hit cost an overhealed attacker health"
        );
    }

    #[test]
    fn a_dead_attacker_drains_nothing() {
        let mut w = fanged(20.0);
        if let Some(p) = w.player_mut(0) {
            p.alive = false;
        }
        let before = health(&w, 0);
        hit(&mut w, LIFESTEAL_DAMAGE_PER_HP, shot(WEAPON_BAZOOKA));
        assert_eq!(health(&w, 0), before, "a corpse drained life");

        // The control: the identical hit from the identical fixture, alive.
        let mut w = fanged(20.0);
        let before = health(&w, 0);
        hit(&mut w, LIFESTEAL_DAMAGE_PER_HP, shot(WEAPON_BAZOOKA));
        assert_eq!(health(&w, 0) - before, 1.0);
    }

    /// The warmup gate covers this by construction, and that is worth an
    /// assertion: the rule sits inside `apply_damage_log` **after** the phase
    /// check, so there is no second place for a "lifesteal during warmup" bug to
    /// live.
    #[test]
    fn nothing_is_drained_during_warmup() {
        let mut w = fanged(20.0);
        w.set_phase(RoundPhase::Warmup);
        let before = health(&w, 0);
        hit(&mut w, LIFESTEAL_DAMAGE_PER_HP, shot(WEAPON_BAZOOKA));
        assert_eq!(health(&w, 0), before);
        assert_eq!(health(&w, 1), BASE_HEALTH, "warmup dealt damage at all");

        // The control, so the assertion above is not satisfied by a fixture that
        // simply never hits anybody.
        w.set_phase(RoundPhase::Playing);
        hit(&mut w, LIFESTEAL_DAMAGE_PER_HP, shot(WEAPON_BAZOOKA));
        assert_eq!(health(&w, 0) - before, 1.0);
    }
}

/// T21.03 — unicorn wings.
///
/// Driven through `World::step`, because every claim here is about what
/// `apply_input` does with a player's inventory and the only honest way to ask
/// is to run a tick. The **drop** test in particular has to go through
/// `World::drop_item` (T20.09): dropping is the item's only off switch, and a
/// test that emptied the inventory by hand would be asserting against a path no
/// player can take.
#[cfg(test)]
mod unicorn_wings {
    use super::*;
    use crate::constants::{MapScale, PLAYER_H, SIM_DT, WINGS_FLY_SPEED};
    use crate::items::registry::{IRONMAN_BOOTS, UNICORN_WINGS};
    use crate::player::input::button;

    fn world() -> World {
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w
    }

    /// Put player 0 in open air, well clear of the ground, and return their y.
    ///
    /// **Airborne on purpose.** Flight and falling are both vertical, so the
    /// fixture starts where gravity has room to act — a body resting on the
    /// floor would show "did not fall" for a player with no wings at all.
    fn aloft(w: &mut World) -> f32 {
        let x = w.map.mask.w as f32 / 2.0;
        let y = w.map.mask.h as f32 / 4.0;
        let Some(p) = w.player_mut(0) else {
            panic!("no player 0")
        };
        p.body.pos = Vec2::new(x, y);
        p.body.vel = Vec2::ZERO;
        p.body.grounded = false;
        p.iframes_until = -1.0;
        y
    }

    /// `n` ticks holding `buttons`, and the y afterwards.
    fn fly(w: &mut World, buttons: u8, n: u32) -> f32 {
        for _ in 0..n {
            // Seq 0, numbered by the world (T22.10F): `t + 1` restarted per call.
            w.queue_input(0, Input::new(0, buttons, 0));
            w.step(SIM_DT);
        }
        w.player(0).expect("ana").body.pos.y
    }

    fn wings_slot(w: &World) -> u8 {
        w.player(0)
            .expect("ana")
            .inventory
            .iter()
            .find(|(_, s)| s.item == UNICORN_WINGS)
            .map(|(i, _)| i)
            .expect("the wings are in the bag")
    }

    /// The headline claim, with the control that makes it mean something.
    ///
    /// **T21.34 replaced T21.03's "rises without input and keeps rising"**,
    /// which was the bug the owner reported (*"the player keeps flying up"*).
    /// The rule now: a winged player with **no input at all** hovers — neither
    /// rising nor falling, for as long as they hold still. The control is the
    /// same fixture without the wings, which must fall: without it, "y did not
    /// change" is satisfied by a body resting on something.
    #[test]
    fn wings_hover_with_no_input_and_the_same_player_without_them_falls() {
        let mut w = world();
        give(&mut w, 0, UNICORN_WINGS, 1);
        let start = aloft(&mut w);
        let after = fly(&mut w, 0, 30);
        let p = w.player(0).expect("ana");
        assert!(
            !p.body.grounded,
            "the fixture landed, so a hover proves nothing"
        );
        assert_eq!(
            after, start,
            "a winged player with no input moved vertically: {start} -> {after}"
        );
        assert_eq!(
            p.body.vel.y, 0.0,
            "a hovering player carries vertical speed"
        );

        // And keeps hovering — one still tick could be a fixture artefact.
        let later = fly(&mut w, 0, 60);
        assert_eq!(later, start, "the hover drifted: {start} -> {later}");

        // The control.
        let mut w = world();
        let start = aloft(&mut w);
        let after = fly(&mut w, 0, 30);
        assert!(
            after > start,
            "the unwinged control did not fall: {start} -> {after}"
        );
    }

    /// `UP` climbs and `DOWN` descends, both at `WINGS_FLY_SPEED`, and both
    /// held together cancel to a hover.
    ///
    /// Pinned to the constant, which is the one knob the brief expects to be
    /// turned — *"might have to reduce it to make it more fair"*. The positions
    /// are asserted as well as the velocities, so a `vel.y` that is written and
    /// then discarded before `integrate` cannot pass.
    #[test]
    fn up_climbs_and_down_descends_at_the_wings_own_speed() {
        // y grows downward, so rising is a *decrease*.
        let mut w = world();
        give(&mut w, 0, UNICORN_WINGS, 1);
        let start = aloft(&mut w);
        let up = fly(&mut w, button::UP, 5);
        assert_eq!(
            w.player(0).expect("ana").body.vel.y,
            -WINGS_FLY_SPEED,
            "holding UP did not climb at the wings' own speed"
        );
        assert!(up < start, "holding UP did not rise: {start} -> {up}");

        // **As many ticks down as up**, so the body ends back at `aloft`'s open
        // air. Ten ticks measured `vel.y == 0.0` here: the extra five carried
        // the body below its start and onto terrain, and a landing zeroes the
        // velocity this asserts on.
        let down = fly(&mut w, button::DOWN, 5);
        assert_eq!(
            w.player(0).expect("ana").body.vel.y,
            WINGS_FLY_SPEED,
            "holding DOWN did not descend at the wings' own speed"
        );
        assert!(down > up, "holding DOWN did not descend: {up} -> {down}");

        let both = fly(&mut w, button::UP | button::DOWN, 10);
        assert_eq!(
            both, down,
            "UP and DOWN together did not cancel to a hover: {down} -> {both}"
        );
    }

    /// **Refused, not ignored** — and the control is that both work the moment
    /// the wings come off.
    ///
    /// A held JUMP is used rather than a tap, because the jetpack only engages
    /// after `JETPACK_HOLD_DELAY`; a single press would leave the jetpack half
    /// of this assertion vacuous.
    #[test]
    fn jump_and_jetpack_are_refused_while_the_wings_are_held() {
        let mut w = world();
        give(&mut w, 0, UNICORN_WINGS, 1);
        aloft(&mut w);
        // Long enough to clear the hold delay several times over.
        fly(&mut w, button::JUMP, 60);
        let p = w.player(0).expect("ana");
        assert!(
            !p.jetpack.active,
            "the jetpack engaged while the wings were held"
        );
        // Hovering: JUMP is not UP, so holding it must leave the hover alone.
        assert_eq!(
            p.body.vel.y, 0.0,
            "holding JUMP changed the hover, so something other than the wings \
             moved this player"
        );
        assert_eq!(
            p.jetpack.fuel,
            crate::constants::JETPACK_MAX_FUEL,
            "a refused jetpack still burned fuel"
        );
        // The buffered press is cleared rather than banked, so nothing fires
        // late.
        assert_eq!(p.jump.buffered_ticks, 0, "a jump was banked while flying");

        // **The control: both work once the wings are gone.** Without it this
        // test passes against a build where JUMP and the jetpack never work.
        let slot = wings_slot(&w);
        assert!(w.drop_item(0, slot), "the wings would not drop");
        aloft(&mut w);
        fly(&mut w, button::JUMP, 60);
        let p = w.player(0).expect("ana");
        assert!(
            p.jetpack.active,
            "the jetpack did not engage after the wings came off"
        );
        assert!(
            p.jetpack.fuel < crate::constants::JETPACK_MAX_FUEL,
            "the jetpack reported active without burning anything"
        );
    }

    /// **Dropping them ends the flight**, through the only path a player has.
    #[test]
    fn dropping_the_wings_ends_the_flight() {
        let mut w = world();
        give(&mut w, 0, UNICORN_WINGS, 1);
        let start = aloft(&mut w);
        let flying = fly(&mut w, button::UP, 30);
        assert!(flying < start, "the fixture never got off the ground");
        // Still flying with no input: the hover holds before the drop, so the
        // fall after it is the drop's doing.
        let held = fly(&mut w, 0, 30);
        assert_eq!(held, flying, "the hover did not hold before the drop");

        let slot = wings_slot(&w);
        assert!(w.drop_item(0, slot), "the wings would not drop");
        let before = w.player(0).expect("ana").body.pos.y;
        let after = fly(&mut w, 0, 30);
        assert!(
            after > before,
            "the player kept flying after dropping the wings: {before} -> {after}"
        );
    }

    /// Boots and wings together, **settled rather than discovered**.
    ///
    /// Wings refuse the jump, so the boots' launch multiplier is never asked
    /// for; their speed multiplier still applies, so a player wearing both flies
    /// sideways faster. Asserted because "holding both is a state somebody will
    /// reach", and an unstated interaction is one that gets rediscovered as a
    /// bug report.
    #[test]
    fn wearing_both_flies_at_the_boots_horizontal_speed_and_still_cannot_jump() {
        let mut w = world();
        give(&mut w, 0, UNICORN_WINGS, 1);
        give(&mut w, 0, IRONMAN_BOOTS, 1);
        aloft(&mut w);
        // **Short enough not to reach the ceiling.** At `WINGS_FLY_SPEED` the
        // climb covers `speed * ticks * SIM_DT` px, and `aloft` starts a quarter
        // of the map down — a longer run ends against the top of the world,
        // where `clamp_to_world` zeroes `vel.y` and the assertion below reads
        // "the wings stopped" for a fixture that simply arrived.
        fly(&mut w, button::RIGHT | button::JUMP, 30);
        let p = w.player(0).expect("ana");
        assert!(
            p.body.pos.y > 0.0,
            "the fixture reached the top of the world, so vel.y says nothing"
        );
        assert_eq!(
            p.body.vel.y, 0.0,
            "the boots' jump got through while the wings were held (no UP, so \
             the wings hover)"
        );
        assert!(
            p.body.vel.x > crate::constants::WALK_SPEED,
            "the boots' speed did not apply in the air: {} px/s",
            p.body.vel.x
        );
    }

    /// Wings are a **blanket fall-damage immunity, by construction rather than
    /// by an exemption** — you cannot arrive faster than you can fly, and
    /// `WINGS_FLY_SPEED < FALL_SAFE_SPEED` is asserted at the constant.
    ///
    /// Stated as a test because T21.02's fall rules are one file over and the
    /// next reader should not have to derive this.
    #[test]
    fn a_winged_landing_never_costs_anything() {
        let mut w = world();
        give(&mut w, 0, UNICORN_WINGS, 1);
        aloft(&mut w);
        let before = w.player(0).expect("ana").health;
        // Straight down until something stops them.
        for t in 0..600u32 {
            w.queue_input(0, Input::new(t + 1, button::DOWN, 0));
            w.step(SIM_DT);
            if w.player(0).expect("ana").body.grounded {
                break;
            }
        }
        let p = w.player(0).expect("ana");
        assert!(
            p.body.grounded,
            "the winged descent never reached the ground"
        );
        assert_eq!(p.health, before, "a winged landing cost health");
        let _ = PLAYER_H;
    }
}

/// T21.11B end to end: mounting a gun platform in a real `World`, driven by
/// `step` and by real inputs.
///
/// The unit tests in `world::mount` prove the state machine. These prove it is
/// **wired** — that `apply_inputs` calls it, that the lockout reaches
/// `apply_input`, and that the one inventory rule refuses every slotless action.
/// Twelve mechanisms on this project were built, unit-tested and connected to
/// nothing, and a state machine nobody calls looks exactly like one that works.
#[cfg(test)]
mod mount_wiring {
    use super::*;
    use crate::constants::{MapScale, GUN_PLATFORM_MOUNT_TIME, PLAYER_H, SIM_DT};
    use crate::items::registry::{BATTERY_PACK, MEDKIT};
    use crate::map::meta::GunPlatform;
    use crate::player::{button, Input};

    fn playing() -> World {
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w
    }

    fn platform(w: &World) -> GunPlatform {
        w.map.meta.gun_platforms[0]
    }

    /// Plant a player on the platform, the way a player who walked there is.
    fn plant(w: &mut World, id: PlayerId, g: &GunPlatform) {
        let centre = Vec2::new(g.pos.x as f32, g.pos.y as f32 - PLAYER_H / 2.0);
        let p = w.player_mut(id).expect("there");
        p.body.pos = centre;
        p.body.vel = Vec2::ZERO;
        p.body.grounded = true;
    }

    /// Drive `seconds` of ticks with `input`, re-planting the body each tick so
    /// the physics of standing on a slope is not what this measures.
    fn drive(w: &mut World, id: PlayerId, g: &GunPlatform, input: Input, seconds: f32) {
        let steps = (seconds / SIM_DT).ceil() as usize;
        for _ in 0..steps {
            if w.player(id).is_some_and(|p| !p.mount.is_mounted()) {
                plant(w, id, g);
            }
            // Seq 0: the world numbers it after the last (T22.10F) — `i + 1`
            // restarted at every call, and a restarted seq reads as already run.
            let mut inp = input;
            inp.seq = 0;
            w.queue_input(id, inp);
            w.step(SIM_DT);
            w.drain_events();
        }
    }

    fn held(buttons: u8) -> Input {
        Input {
            buttons,
            ..Default::default()
        }
    }

    /// Both halves: the full stand mounts, a shorter one does not.
    #[test]
    fn standing_for_the_mount_time_mounts_and_less_does_not() {
        let mut w = playing();
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 0.5,
        );
        assert!(
            !w.player(0).expect("there").mount.is_mounted(),
            "half the mount time mounted the player"
        );

        let mut w = playing();
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        assert_eq!(
            w.player(0).expect("there").mount.mounted,
            Some(g.id),
            "a full stand on platform {} did not mount",
            g.id
        );
    }

    /// The lockout, with the control that makes it mean something.
    #[test]
    fn a_mounted_player_does_not_move_and_an_unmounted_one_does() {
        let mut w = playing();
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        assert!(w.player(0).expect("there").mount.is_mounted());

        let before = w.player(0).expect("there").body.pos;
        // Hold right for half a second. No re-planting: the point is that the
        // body does not move on its own.
        for i in 0..30 {
            let mut inp = held(button::RIGHT);
            inp.seq = 1000 + i;
            w.queue_input(0, inp);
            w.step(SIM_DT);
            w.drain_events();
        }
        let after = w.player(0).expect("there").body.pos;
        assert!(
            (after.x - before.x).abs() < 1.0,
            "a mounted player walked {} px",
            (after.x - before.x).abs()
        );

        // **The control**: the same input, unmounted, moves them — or this test
        // passes against a game in which nobody can move at all.
        let mut w2 = playing();
        let g2 = platform(&w2);
        plant(&mut w2, 0, &g2);
        let start = w2.player(0).expect("there").body.pos;
        for i in 0..30 {
            let mut inp = held(button::RIGHT);
            inp.seq = 1000 + i;
            w2.queue_input(0, inp);
            w2.step(SIM_DT);
            w2.drain_events();
        }
        let moved = (w2.player(0).expect("there").body.pos.x - start.x).abs();
        assert!(
            moved > 5.0,
            "the control moved only {moved} px, so the lockout test proves nothing"
        );
    }

    /// **The one rule, asserted as one rule.** Every slotless action refuses
    /// while mounted and works when not — and they are driven through a list, so
    /// a sixth action added later joins this test by being added to the list
    /// rather than by growing a test of its own.
    #[test]
    fn mounting_puts_every_slotless_action_out_of_reach() {
        // Each entry: a name, and something that returns whether it succeeded.
        type Verb = (&'static str, fn(&mut World) -> bool);
        let verbs: &[Verb] = &[
            ("use_heal (Q)", |w| w.use_heal(0).is_ok()),
            ("use_battery_pack (R)", |w| w.use_battery_pack(0).is_ok()),
            ("use_item", |w| {
                let slot = w
                    .player(0)
                    .and_then(|p| p.inventory.iter().find(|(_, s)| s.item == MEDKIT))
                    .map(|(i, _)| i)
                    .unwrap_or(0);
                w.use_item(0, slot, 0.0).is_ok()
            }),
            ("select_slot", |w| {
                let before = w.player(0).expect("there").inventory.selected();
                let want = if before == 0 { 1 } else { 0 };
                w.select_slot(0, want);
                w.player(0).expect("there").inventory.selected() == want
            }),
            ("move_item (drag)", |w| w.move_item(0, 0, 5)),
            // **`fire` is deliberately not in this list since T21.11C.** It no
            // longer refuses while mounted — it fires the *platform's* gun,
            // which spawns without touching the inventory. The claim that
            // matters is therefore "your own weapons are untouched", and it is
            // asserted directly in `a_mounted_player_fires_the_platform_not_
            // their_own_weapon` rather than as a refusal here. Removing it from
            // this list is a change to the rule, not a weakening of the test.
        ];

        // Stock the bag so every verb has something to act on, then check each
        // verb **works** unmounted before asserting it is refused mounted. An
        // absence needs a presence.
        let stock = |w: &mut World| {
            let p = w.player_mut(0).expect("there");
            p.inventory.add(MEDKIT, 3);
            p.inventory.add(BATTERY_PACK, 3);
            p.health = 10.0;
            p.battery = 0.0;
            // `Q` and `R` spend the **counters**, not the inventory (§C9), so
            // stocking the bag alone left both refusing for want of a charge and
            // the control failed loudly — which is what it is for.
            p.heals = 2;
            p.batteries = 2;
        };

        for (name, verb) in verbs {
            let mut w = playing();
            stock(&mut w);
            assert!(
                verb(&mut w),
                "{name} does not work unmounted, so refusing it mounted proves nothing"
            );

            let mut w = playing();
            let g = platform(&w);
            stock(&mut w);
            drive(
                &mut w,
                0,
                &g,
                Input::default(),
                GUN_PLATFORM_MOUNT_TIME * 1.5,
            );
            assert!(
                w.player(0).expect("there").mount.is_mounted(),
                "{name}: the fixture failed to mount"
            );
            assert!(
                !verb(&mut w),
                "{name} still worked while mounted — the inventory is not out of reach"
            );
        }
    }

    /// Both halves, in the other direction.
    #[test]
    fn holding_jump_dismounts_and_a_shorter_hold_does_not() {
        let mut w = playing();
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        assert!(w.player(0).expect("there").mount.is_mounted());

        // Short hold: still mounted.
        drive(
            &mut w,
            0,
            &g,
            held(button::JUMP),
            GUN_PLATFORM_MOUNT_TIME * 0.5,
        );
        assert!(
            w.player(0).expect("there").mount.is_mounted(),
            "half a jump hold dismounted the player"
        );
        // Release, then hold the full time.
        drive(&mut w, 0, &g, Input::default(), SIM_DT * 2.0);
        drive(
            &mut w,
            0,
            &g,
            held(button::JUMP),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        assert!(
            !w.player(0).expect("there").mount.is_mounted(),
            "a full jump hold did not dismount"
        );
    }

    /// Dismounting must not fling the player: jump is refused while mounted, so
    /// the gesture cannot also be a launch.
    #[test]
    fn the_dismount_hold_never_launches_the_player() {
        let mut w = playing();
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        let y0 = w.player(0).expect("there").body.pos.y;
        drive(
            &mut w,
            0,
            &g,
            held(button::JUMP),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        let p = w.player(0).expect("there");
        assert!(!p.mount.is_mounted(), "the fixture did not dismount");
        assert!(
            p.body.vel.y >= -1.0,
            "the dismount launched the player upward at {} px/s",
            p.body.vel.y
        );
        assert!(
            (p.body.pos.y - y0).abs() < PLAYER_H,
            "the player moved {} px vertically getting off",
            (p.body.pos.y - y0).abs()
        );
    }

    /// One occupant at a time, and the platform frees up when they leave.
    #[test]
    fn a_second_player_cannot_mount_an_occupied_platform_and_can_once_it_is_free() {
        let mut w = playing();
        w.add_player(1, 0, "bo".into());
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        assert_eq!(w.platform_occupant(g.id), Some(0));

        drive(
            &mut w,
            1,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 3.0,
        );
        assert!(
            !w.player(1).expect("there").mount.is_mounted(),
            "two players mounted the same platform"
        );
        assert_eq!(w.platform_occupant(g.id), Some(0));

        // The first gets off; the second can then take it. **This is the
        // control** — without it, "player 1 never mounted" is also what a broken
        // mount rule produces.
        w.player_mut(0).expect("there").mount.mounted = None;
        drive(
            &mut w,
            1,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        assert_eq!(
            w.platform_occupant(g.id),
            Some(1),
            "the platform stayed locked after its occupant left"
        );
    }

    /// A corpse holding a platform is a platform nobody can use for the rest of
    /// the round, and the occupancy rule reads exactly that field.
    #[test]
    fn dying_while_mounted_frees_the_platform() {
        let mut w = playing();
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        assert_eq!(w.platform_occupant(g.id), Some(0));

        let p = w.player_mut(0).expect("there");
        p.alive = false;
        assert_eq!(
            w.platform_occupant(g.id),
            None,
            "a dead player still holds the platform"
        );
        // And respawn clears the state itself, not just the aliveness.
        w.player_mut(0)
            .expect("there")
            .respawn(Vec2::new(64.0, 64.0), 0.0);
        assert!(!w.player(0).expect("there").mount.is_mounted());
    }

    /// A mounted player is a stationary target and that is the whole trade.
    #[test]
    fn a_mounted_player_takes_damage_normally() {
        let mut w = playing();
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        assert!(w.player(0).expect("there").mount.is_mounted());
        // Through the poison funnel — a real damage path that `step` drives,
        // rather than a health subtraction that would prove only that `f32`
        // arithmetic works.
        let before = w.player(0).expect("there").health;
        {
            let now = w.round_time;
            let p = w.player_mut(0).expect("there");
            p.iframes_until = 0.0;
            p.poisoned_until = now + 1.0;
        }
        for _ in 0..30 {
            w.step(SIM_DT);
            w.drain_events();
        }
        let after = w.player(0).expect("there").health;
        assert!(
            after < before,
            "a mounted player took no damage: {before} -> {after}"
        );
        assert!(
            w.player(0).expect("there").mount.is_mounted(),
            "the damage dismounted them, which is mitigation by another name"
        );
    }

    /// **T21.14: a blast that moves you takes you off the gun — and the gun
    /// stops being yours.**
    ///
    /// The reviewed version of `mount::step` returned early while mounted and
    /// never looked at `under`, so a rocket could throw a rider clear and leave
    /// them mounted: immobile, bag locked, and still spawning rounds at the
    /// platform's muzzle from behind cover. Self-knockback made it repeatable.
    ///
    /// Knockback on a mounted player was exercised **nowhere** —
    /// `a_mounted_player_takes_damage_normally` uses poison, which applies no
    /// impulse — so this fixture moves the body directly, which is what an
    /// impulse does to it, without depending on a weapon's tuning.
    #[test]
    fn a_displaced_rider_is_dismounted_and_can_no_longer_fire_the_platform() {
        let mut w = playing();
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        assert!(w.player(0).expect("there").mount.is_mounted());
        // The control half: on the platform, they can fire it.
        w.drain_events();
        assert!(
            w.fire(0, 100.0).is_ok(),
            "the fixture cannot fire before the blast, so the assertion below proves nothing"
        );

        // Thrown clear, as an explosion's impulse does.
        {
            let p = w.player_mut(0).expect("there");
            p.body.pos.x += crate::constants::GUN_PLATFORM_W as f32 * 3.0;
        }
        w.queue_input(
            0,
            Input {
                seq: 9_000,
                ..Default::default()
            },
        );
        w.step(SIM_DT);
        w.drain_events();

        assert!(
            !w.player(0).expect("there").mount.is_mounted(),
            "a player thrown off the platform is still riding it"
        );
        assert_eq!(
            w.platform_occupant(g.id),
            None,
            "the platform is still held by someone standing somewhere else"
        );
        // And the gun is no longer theirs: firing now goes to the bag, which is
        // the shovel — never the platform gun.
        w.drain_events();
        let _ = w.fire(0, 200.0);
        let fired: Vec<WeaponId> = w
            .drain_events()
            .iter()
            .filter_map(|e| match e {
                GameEvent::ProjectileSpawn { weapon, .. } => Some(*weapon),
                _ => None,
            })
            .collect();
        assert!(
            fired
                .iter()
                .all(|wid| *wid != crate::items::registry::WEAPON_PLATFORM_GUN),
            "a displaced player still fired the platform gun: {fired:?}"
        );
    }

    /// The wire carries it, and the mirror's decode gets back what was encoded.
    #[test]
    fn the_mounted_bit_round_trips_through_the_move_mod_byte() {
        use crate::player::state::MOVE_MOD_MOUNTED;
        let mut w = playing();
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        let bits = w.player(0).expect("there").move_mod_bits();
        assert!(
            bits & MOVE_MOD_MOUNTED != 0,
            "the mounted bit is not set on the wire: {bits:#010b}"
        );

        // A fresh mirror-side player fed that byte must answer the same question
        // `apply_input` asks.
        let mut mirror = crate::player::state::PlayerState::new(9, Vec2::ZERO, 0);
        mirror.set_move_mod_bits(bits);
        assert!(
            mirror.move_mods().mounted,
            "the mirror did not learn the mount"
        );
        // And the control: the same player, unmounted.
        let clear = w.player(0).expect("there").move_mod_bits() & !MOVE_MOD_MOUNTED;
        mirror.set_move_mod_bits(clear);
        assert!(!mirror.move_mods().mounted);
    }

    /// **The hash tells "unmounted" from "mounted per the wire" apart** (T21.14).
    ///
    /// `mount.mounted` was folded as `unwrap_or(255)` and `mount::WIRE_MOUNTED`
    /// is 255, so those two states hashed identically — in the one mechanism
    /// built to detect divergence. Harmless while only servers hash (a
    /// server-side `mounted` is never 255) and exactly the trap to leave behind
    /// for whoever next hashes a mirror-side world.
    #[test]
    fn the_state_hash_distinguishes_unmounted_from_the_wire_sentinel() {
        let mut a = playing();
        let b = playing();
        assert_eq!(a.state_hash(), b.state_hash(), "the fixture worlds differ");

        a.player_mut(0).expect("there").mount.mounted = Some(crate::world::mount::WIRE_MOUNTED);
        assert_ne!(
            a.state_hash(),
            b.state_hash(),
            "a player mounted per the wire hashes the same as an unmounted one"
        );

        // And the control: a real platform id is distinguishable too, so the
        // fix did not simply stop hashing the id.
        a.player_mut(0).expect("there").mount.mounted = Some(0);
        let with_zero = a.state_hash();
        a.player_mut(0).expect("there").mount.mounted = Some(1);
        assert_ne!(with_zero, a.state_hash(), "two platforms hash the same");
    }

    /// Wings and a platform cannot both be in charge of gravity — and since
    /// 2026-09-16 the way that is guaranteed is that **a winged player never
    /// mounts at all**.
    ///
    /// **This test asserted the opposite until then**, and was right to: T21.11B
    /// resolved the clash by letting the mount win, so the old name was
    /// `mounting_takes_precedence_over_flight`. The owner replaced the rule from
    /// play — *"you cannot interact with teleports and machinegun platforms if
    /// wearing them"* — so precedence is no longer the mechanism; refusal is. The
    /// invariant underneath is unchanged and is still what the last assertion
    /// checks: never both regimes at once.
    #[test]
    fn wings_refuse_the_platform_outright() {
        let mut w = playing();
        let g = platform(&w);
        w.player_mut(0)
            .expect("there")
            .inventory
            .add(crate::items::registry::UNICORN_WINGS, 1);
        assert!(
            w.player(0).expect("there").move_mods().flying,
            "the fixture is not flying, so this asserts nothing"
        );
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        let mods = w.player(0).expect("there").move_mods();
        assert!(
            !mods.mounted,
            "a winged player mounted the platform — the refusal is not in force"
        );
        // Still flying, so the refusal did not quietly cost them the wings too.
        assert!(
            mods.flying,
            "the winged player stopped flying without mounting"
        );
        assert!(
            !(mods.mounted && mods.flying),
            "two gravity regimes at once — the invariant the old precedence rule \
             existed to protect"
        );
    }

    /// The control for the refusal: the **same fixture without wings** mounts.
    ///
    /// Without this, `wings_refuse_the_platform_outright` passes against a
    /// platform nobody can mount, a broken `drive` helper, or a fixture standing
    /// nowhere near the platform — every one of which asserts "did not mount"
    /// just as well as the rule does.
    #[test]
    fn the_same_player_without_wings_does_mount() {
        let mut w = playing();
        let g = platform(&w);
        drive(
            &mut w,
            0,
            &g,
            Input::default(),
            GUN_PLATFORM_MOUNT_TIME * 1.5,
        );
        assert!(
            w.player(0).expect("there").move_mods().mounted,
            "the bare-backed control never mounted, so the refusal above proves \
             nothing about wings"
        );
    }
}

/// The mount fixtures in `mount_wiring` prove you can get on one. These prove
/// the gun: that holding the trigger is a stream of single rounds from the
/// barrels in turn (T21.43), that they come out of the platform's magazine and
/// not the player's bag, and that an empty platform is dead scenery rather than
/// a despawned one.
#[cfg(test)]
mod platform_gun {
    use super::*;
    use crate::constants::{
        MapScale, GUN_PLATFORM_AMMO, GUN_PLATFORM_BALANCE_TOLERANCE, GUN_PLATFORM_BARRELS,
        GUN_PLATFORM_FIRE_INTERVAL, GUN_PLATFORM_FIRE_TICKS, GUN_PLATFORM_MOUNT_TIME,
        GUN_PLATFORM_SPAM_DPS_BASIS, PLAYER_H, SIM_DT,
    };
    use crate::items::registry::{BAZOOKA, WEAPON_PLATFORM_GUN};
    use crate::map::meta::GunPlatform;
    use crate::player::input::button;
    use crate::player::Input;

    fn playing() -> World {
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w
    }

    fn platform(w: &World) -> GunPlatform {
        w.map.meta.gun_platforms[0]
    }

    /// Mount the player on platform 0 by the real rule, so nothing here depends
    /// on reaching into the state machine.
    fn mounted(w: &mut World) -> GunPlatform {
        let g = platform(w);
        let steps = (GUN_PLATFORM_MOUNT_TIME * 1.5 / SIM_DT).ceil() as usize;
        for i in 0..steps {
            {
                let p = w.player_mut(0).expect("there");
                p.body.pos = Vec2::new(g.pos.x as f32, g.pos.y as f32 - PLAYER_H / 2.0);
                p.body.vel = Vec2::ZERO;
                p.body.grounded = true;
            }
            w.queue_input(0, Input::new(i as u32 + 1, 0, 0));
            w.step(SIM_DT);
            w.drain_events();
        }
        assert!(
            w.player(0).expect("there").mount.is_mounted(),
            "the fixture failed to mount"
        );
        g
    }

    /// Platform rounds in a batch of events: `(x, y, vx, vy)` each.
    fn rounds(evs: &[GameEvent]) -> Vec<(f32, f32, f32, f32)> {
        evs.iter()
            .filter_map(|e| match e {
                GameEvent::ProjectileSpawn {
                    weapon,
                    x,
                    y,
                    vx,
                    vy,
                    ..
                } if *weapon == WEAPON_PLATFORM_GUN => Some((*x, *y, *vx, *vy)),
                _ => None,
            })
            .collect()
    }

    fn spawns(evs: &[GameEvent]) -> Vec<WeaponId> {
        evs.iter()
            .filter_map(|e| match e {
                GameEvent::ProjectileSpawn { weapon, .. } => Some(*weapon),
                _ => None,
            })
            .collect()
    }

    /// **Hold the trigger for `ticks` ticks**: a `fire` on every tick, which is
    /// what the room does for a bot pressing FIRE and the fastest a client could
    /// send. `buttons` is the movement input for each tick (JUMP to dismount).
    /// Returns every platform round, in order.
    fn hold(w: &mut World, ticks: usize, buttons: u8) -> Vec<(f32, f32, f32, f32)> {
        let mut out = Vec::new();
        for _ in 0..ticks {
            let now = w.round_time;
            let _ = w.fire(0, now);
            out.extend(rounds(&w.drain_events()));
            let seq = w.tick + 10_000;
            w.queue_input(0, Input::new(seq, buttons, 0));
            w.step(SIM_DT);
            out.extend(rounds(&w.drain_events()));
        }
        out
    }

    /// **One click is one round** of the platform's own weapon — and the control
    /// for every held count below. Counted at both ends: the events, the
    /// projectile store and the magazine.
    #[test]
    fn one_click_is_one_round_of_the_platforms_own_weapon() {
        let mut w = playing();
        let g = mounted(&mut w);
        let before = w.platform_ammo(g.id).expect("a platform");
        assert_eq!(before, GUN_PLATFORM_AMMO, "a fresh platform is not full");

        let live_before = w.projectiles.iter().count();
        w.fire(0, 100.0).expect("a mounted player can fire");
        let fired = spawns(&w.drain_events());
        assert_eq!(
            fired,
            vec![WEAPON_PLATFORM_GUN],
            "one click fired {fired:?}"
        );
        assert_eq!(
            w.projectiles.iter().count() - live_before,
            1,
            "the events and the projectile store disagree about the click"
        );
        assert_eq!(w.platform_ammo(g.id), Some(before - 1));
    }

    /// **Held for N ticks, `N / GUN_PLATFORM_FIRE_TICKS` rounds (± 1), and the
    /// barrels turn over.** The control is the click above — one call, one
    /// round — so "held fires many" is the hold, not a click that fires many.
    #[test]
    fn holding_fires_a_stream_one_round_per_interval_from_the_barrels_in_turn() {
        let mut w = playing();
        let g = mounted(&mut w);
        let n = 90usize;
        let fired = hold(&mut w, n, 0);
        let want = n / GUN_PLATFORM_FIRE_TICKS as usize;
        assert!(
            fired.len().abs_diff(want) <= 1,
            "held {n} ticks and fired {} rounds, not {want} ± 1",
            fired.len()
        );
        assert_eq!(
            w.platform_ammo(g.id),
            Some(GUN_PLATFORM_AMMO - fired.len() as u16),
            "one round did not cost one bullet"
        );

        // The barrels: a heading pattern with period `GUN_PLATFORM_BARRELS`,
        // and that many distinct headings — quantised, so float noise is not
        // what makes them distinct.
        let headings: Vec<i64> = fired
            .iter()
            .map(|(_, _, vx, vy)| (vy.atan2(*vx) * 10_000.0).round() as i64)
            .collect();
        let b = GUN_PLATFORM_BARRELS as usize;
        let mut uniq = headings.clone();
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(
            uniq.len(),
            b,
            "{} headings, not one per barrel: {uniq:?}",
            uniq.len()
        );
        for k in b..headings.len() {
            assert_eq!(
                headings[k],
                headings[k - b],
                "round {k} broke the barrel cycle"
            );
        }
        for k in 1..headings.len() {
            assert_ne!(
                headings[k],
                headings[k - 1],
                "two rounds in a row left one barrel"
            );
        }
        // And from different muzzles, not one muzzle turning.
        let mut muzzles: Vec<(i64, i64)> = fired[..b]
            .iter()
            .map(|(x, y, ..)| ((x * 100.0) as i64, (y * 100.0) as i64))
            .collect();
        muzzles.dedup();
        assert_eq!(muzzles.len(), b, "the barrels share a muzzle");
    }

    /// **The platform's clock, not the player's.** Twice in a tick is one round;
    /// one interval later is another.
    #[test]
    fn the_platform_has_its_own_clock() {
        let mut w = playing();
        let g = mounted(&mut w);
        w.fire(0, 100.0).expect("first round");
        assert_eq!(
            w.fire(0, 100.0),
            Err(UseError::OnCooldown),
            "two rounds in one tick"
        );
        assert_eq!(
            w.platform_ammo(g.id),
            Some(GUN_PLATFORM_AMMO - 1),
            "a refusal spent ammo"
        );
        // The control: one interval on, it fires again.
        w.fire(0, 100.0 + GUN_PLATFORM_FIRE_INTERVAL)
            .expect("a round one interval later");
        assert_eq!(w.platform_ammo(g.id), Some(GUN_PLATFORM_AMMO - 2));
    }

    /// **A held stream stops when the magazine is empty, and stays stopped.**
    /// There is no reload and no refill (T21.11C, kept by T21.43): an empty
    /// platform is empty for the rest of the round. The control is that the
    /// same hold fired every round it had first.
    #[test]
    fn a_held_stream_stops_at_an_empty_magazine_and_does_not_reload() {
        let mut w = playing();
        let g = mounted(&mut w);
        let left = 5u16;
        w.platform_ammo[g.id as usize] = left;
        let first = hold(&mut w, 60, 0);
        assert_eq!(
            first.len(),
            left as usize,
            "a magazine of {left} fired {}",
            first.len()
        );
        assert_eq!(w.platform_ammo(g.id), Some(0), "the magazine went negative");
        // Keep holding for ten seconds: no reload rule exists, so nothing comes.
        let later = hold(&mut w, (10.0 / SIM_DT) as usize, 0);
        assert!(
            later.is_empty(),
            "an empty platform fired {} more rounds",
            later.len()
        );
        assert_eq!(w.fire(0, w.round_time), Err(UseError::NoAmmo));
    }

    /// An empty platform is dead scenery — collision, mount and all — and the
    /// whole magazine is exactly `GUN_PLATFORM_AMMO` rounds.
    #[test]
    fn an_empty_platform_is_dead_scenery_not_a_despawned_one() {
        let mut w = playing();
        let g = mounted(&mut w);
        // **Bounded by attempts, not by successes** — a build where `fire` never
        // succeeds must trip the guard, not spin (two such loops once ran for
        // eighteen hours).
        let mut fired = 0usize;
        let mut now = 100.0;
        let max_attempts = GUN_PLATFORM_AMMO as usize + 16;
        let mut attempts = 0usize;
        while w.platform_ammo(g.id) != Some(0) {
            attempts += 1;
            assert!(
                attempts <= max_attempts,
                "the magazine never emptied: {attempts} attempts, {fired} fired"
            );
            if w.fire(0, now).is_ok() {
                fired += 1;
            }
            now += GUN_PLATFORM_FIRE_INTERVAL * 1.5;
        }
        assert_eq!(fired, GUN_PLATFORM_AMMO as usize);

        w.drain_events();
        assert!(w.fire(0, now).is_err(), "an empty platform still fired");
        assert!(
            spawns(&w.drain_events()).is_empty(),
            "an empty platform spawned a round"
        );
        assert_eq!(
            w.map.meta.gun_platforms.len(),
            crate::constants::GUN_PLATFORMS
        );
        assert!(w.player(0).expect("there").mount.is_mounted());
        assert!(crate::map::gen::surface::is_standable(
            &w.map.mask,
            g.pos.x,
            g.pos.y
        ));
    }

    /// **Dismounting mid-stream stops it.** Dismounting by the real rule —
    /// holding jump for `GUN_PLATFORM_MOUNT_TIME` — while the trigger stays
    /// held the whole time. The control is that the stream was running.
    #[test]
    fn dismounting_mid_stream_stops_the_stream() {
        let mut w = playing();
        mounted(&mut w);
        let before = hold(&mut w, 20, 0);
        assert!(
            !before.is_empty(),
            "the stream never started, so its stopping proves nothing"
        );

        let limit = (GUN_PLATFORM_MOUNT_TIME * 3.0 / SIM_DT) as usize;
        let mut off = false;
        for _ in 0..limit {
            hold(&mut w, 1, button::JUMP);
            if !w.player(0).expect("there").mount.is_mounted() {
                off = true;
                break;
            }
        }
        assert!(off, "holding jump never dismounted");
        let after = hold(&mut w, 60, 0);
        assert!(
            after.is_empty(),
            "{} platform rounds after dismounting",
            after.len()
        );
    }

    /// **The round ending stops it** (T21.30 froze input in `Ended`). Control:
    /// the stream was running up to the phase change.
    #[test]
    fn the_round_ending_stops_the_stream() {
        let mut w = playing();
        mounted(&mut w);
        let before = hold(&mut w, 20, 0);
        assert!(!before.is_empty(), "the stream never started");
        w.set_phase(RoundPhase::Ended);
        let after = hold(&mut w, 60, 0);
        assert!(
            after.is_empty(),
            "{} platform rounds after the round ended",
            after.len()
        );
        assert_eq!(w.fire(0, w.round_time), Err(UseError::RoundOver));
    }

    /// **Balance, against the measured basis rather than the constant** (T21.43).
    ///
    /// `GUN_PLATFORM_SPAM_DPS_BASIS` is the damage per second T21.11C's volley
    /// gave a spam-clicker, measured before the change by this same harness —
    /// a `fire` on every tick for ten seconds. This measures the held stream the
    /// same way and asserts the ratio, so moving the interval, the damage or the
    /// grace rule out of the ±20 % band goes red here even though every other
    /// test is pinned to the constants and would move with them.
    #[test]
    fn the_held_stream_is_balanced_against_its_measured_basis() {
        let mut w = playing();
        mounted(&mut w);
        let secs = 10.0f32;
        let fired = hold(&mut w, (secs / SIM_DT).round() as usize, 0);
        let damage = crate::weapons::defs::def(WEAPON_PLATFORM_GUN)
            .expect("the platform gun")
            .damage;
        let dps = fired.len() as f32 * damage / secs;
        let ratio = dps / GUN_PLATFORM_SPAM_DPS_BASIS;
        println!(
            "held: {} rounds in {secs} s, {dps} DPS, basis {GUN_PLATFORM_SPAM_DPS_BASIS}, ratio {ratio:.3}",
            fired.len()
        );
        assert!(
            (ratio - 1.0).abs() <= GUN_PLATFORM_BALANCE_TOLERANCE,
            "held DPS {dps} is {ratio:.3}× the measured basis {GUN_PLATFORM_SPAM_DPS_BASIS}"
        );
    }

    /// Ammo is **per platform**, so a second occupant finds what the first left.
    #[test]
    fn the_magazine_belongs_to_the_platform_not_the_occupant() {
        let mut w = playing();
        w.add_player(1, 0, "bo".into());
        let g = mounted(&mut w);
        w.fire(0, 100.0).expect("fired");
        let left = w.platform_ammo(g.id).expect("a platform");
        assert!(left < GUN_PLATFORM_AMMO);

        w.player_mut(0).expect("there").mount.mounted = None;
        w.player_mut(1).expect("there").mount.mounted = Some(g.id);
        assert_eq!(w.platform_ammo(g.id), Some(left));
        w.fire(1, 200.0).expect("the second occupant fired");
        assert_eq!(
            w.platform_ammo(g.id),
            Some(left - 1),
            "the second occupant got a fresh magazine"
        );
        for other in &w.map.meta.gun_platforms {
            if other.id != g.id {
                assert_eq!(
                    w.platform_ammo(other.id),
                    Some(GUN_PLATFORM_AMMO),
                    "firing platform {} drained platform {}",
                    g.id,
                    other.id
                );
            }
        }
    }

    /// **The bag is untouched.** This is the assertion that replaced T21.11B's
    /// "fire is refused while mounted", which T21.11C supersedes.
    #[test]
    fn a_mounted_player_fires_the_platform_not_their_own_weapon() {
        let mut w = playing();
        let g = mounted(&mut w);
        w.player_mut(0).expect("there").inventory.add(BAZOOKA, 4);
        let before: Vec<_> = w
            .player(0)
            .expect("there")
            .inventory
            .iter()
            .map(|(i, s)| (i, s.item, s.count))
            .collect();

        w.fire(0, 100.0).expect("fired");
        let evs = w.drain_events();
        assert!(
            spawns(&evs).iter().all(|wid| *wid == WEAPON_PLATFORM_GUN),
            "a mounted player fired something out of their own bag"
        );
        let after: Vec<_> = w
            .player(0)
            .expect("there")
            .inventory
            .iter()
            .map(|(i, s)| (i, s.item, s.count))
            .collect();
        assert_eq!(before, after, "firing the platform spent inventory ammo");
        assert!(w.platform_ammo(g.id).expect("a platform") < GUN_PLATFORM_AMMO);

        // **The control**: unmounted, the same call fires the bazooka out of the
        // bag — so "the platform fired" is about the mount.
        let mut w2 = playing();
        w2.player_mut(0).expect("there").inventory.add(BAZOOKA, 4);
        let slot = w2
            .player(0)
            .expect("there")
            .inventory
            .iter()
            .find(|(_, s)| s.item == BAZOOKA)
            .map(|(i, _)| i)
            .expect("a bazooka");
        w2.select_slot(0, slot);
        w2.drain_events();
        w2.fire(0, 100.0).expect("the unmounted control fired");
        let fired = spawns(&w2.drain_events());
        assert!(
            !fired.is_empty() && fired.iter().all(|wid| *wid != WEAPON_PLATFORM_GUN),
            "the unmounted control fired the platform gun: {fired:?}"
        );
    }

    /// Determinism across a **held stream**: the same seed and the same inputs
    /// give the same hash after the barrels have turned over many times.
    #[test]
    fn a_held_stream_is_deterministic_across_two_identical_worlds() {
        let run = || {
            let mut w = playing();
            mounted(&mut w);
            let fired = hold(&mut w, 91, 0);
            (fired.len(), w.state_hash())
        };
        let (a, b) = (run(), run());
        assert!(
            a.0 > GUN_PLATFORM_BARRELS as usize,
            "the stream never turned the barrels over"
        );
        assert_eq!(a, b, "two identical held streams diverged");
    }

    /// The magazine is **in** the hash — asserted directly, because a field the
    /// hash forgot is exactly the §A34 failure this project has shipped.
    #[test]
    fn the_magazine_is_covered_by_the_state_hash() {
        let mut a = playing();
        let b = playing();
        assert_eq!(a.state_hash(), b.state_hash(), "the fixture worlds differ");
        a.platform_ammo[0] -= 1;
        assert_ne!(
            a.state_hash(),
            b.state_hash(),
            "spending a round left the hash unchanged"
        );
    }

    /// **The barrel is in the hash** (T21.43), like the scheduler's stream
    /// position: two worlds identical in every visible field whose turrets are
    /// on different barrels fire their next round from different muzzles.
    #[test]
    fn the_barrel_is_covered_by_the_state_hash() {
        let mut a = playing();
        let b = playing();
        assert_eq!(a.state_hash(), b.state_hash(), "the fixture worlds differ");
        a.platform_barrel[0] = (a.platform_barrel[0] + 1) % GUN_PLATFORM_BARRELS;
        assert_ne!(
            a.state_hash(),
            b.state_hash(),
            "turning the barrel left the hash unchanged"
        );
    }
}

/// `World::for_test`'s map cache: the same world as `World::new`, and nothing
/// shared between two worlds built from it.
#[cfg(test)]
mod test_map_cache {
    use super::*;

    /// What "the same world" has to cover. `state_hash` covers the mask and the
    /// simulation. It does **not** cover where the map put its buried slots, and
    /// that is exactly what a buried secret moves: a cache that generated every
    /// map with secret 0 passed a hash-only version of this test. So the slots
    /// are compared too.
    fn fingerprint(w: &World) -> ([u8; 32], String, Vec<(i32, i32)>) {
        let slots = w
            .map
            .meta
            .buried_slots
            .iter()
            .map(|b| (b.pos.x, b.pos.y))
            .collect();
        (w.state_hash(), w.map.mask.hash_hex(), slots)
    }

    /// Both halves of "identical": a first call that generates, and a second that
    /// is served from the cache. A cache handing back a different map, or a
    /// `from_map` drifting from `build`, changes the fingerprint.
    #[test]
    fn a_cached_world_is_the_world_new_builds() {
        let fresh = fingerprint(&World::new(4242, MapScale::Small));
        let first = fingerprint(&World::for_test(4242, MapScale::Small));
        let hit = fingerprint(&World::for_test(4242, MapScale::Small));
        assert_eq!(first, fresh, "the cached world differs from World::new");
        assert_eq!(hit, fresh, "the second, cache-served world differs");
        // The secret is part of the key: buried slots hang off it.
        let secret = fingerprint(&World::with_buried_secret(4242, MapScale::Small, 7));
        assert_eq!(
            fingerprint(&World::for_test_with_secret(4242, MapScale::Small, 7)),
            secret,
            "the cached world ignored its buried secret"
        );
        // Control: the secret moves the slots at all, or the line above is vacuous.
        assert_ne!(
            secret.2, fresh.2,
            "control: the secret moved no buried slot"
        );
    }

    /// A test that digs must not leave a hole in the next test's map.
    #[test]
    fn a_carve_in_one_cached_world_never_reaches_the_next() {
        let pristine = World::new(4242, MapScale::Small).map.mask.hash_hex();
        let mut dug = World::for_test(4242, MapScale::Small);
        let (cx, cy) = (dug.map.mask.w as i32 / 2, dug.map.mask.h as i32 / 2);
        dug.map.carve_circle(cx, cy, 200);
        // Control: the carve changed this world, or the check below proves nothing.
        assert_ne!(
            dug.map.mask.hash_hex(),
            pristine,
            "the carve removed nothing"
        );
        let next = World::for_test(4242, MapScale::Small);
        assert_eq!(
            next.map.mask.hash_hex(),
            pristine,
            "a carve in one cached world reached a later one"
        );
    }
}

/// `World::start_clock_at`: a round whose clock starts late is the same round,
/// shifted, with nothing bursting to catch up.
#[cfg(test)]
mod start_clock_at_tests {
    use super::*;
    use crate::constants::{
        CRATE_INTERVAL, EFFECT_INTERVAL_MAX, ITEM_SPAWN_INTERVAL, SIM_DT, WORLD_ITEM_TTL,
    };
    use crate::world::cycle::{CYCLE_LENGTH, NIGHT_START};

    /// The schedule-bearing events: their tick, and their **identity**.
    ///
    /// **Why not the whole event.** `round_time` accumulates `SIM_DT` in f32, and
    /// a clock counting up from 164 s rounds differently from one counting up
    /// from 0. Measured, twice: the same item, same id, spawned on tick 4202 in
    /// the late world and 4200 in the early one; and a later one whose `y` read
    /// 418.08 against 418.01, because what it was placed from had moved for two
    /// more ticks. So ticks are compared to a drift bound, and each event by what
    /// it *is*: which effect with which seed, which item id of which kind.
    /// Positions are left out. A burst, a mass despawn or a missing roll still
    /// misaligns these, and the ids are assigned in order, so they cannot line
    /// up by accident.
    fn scheduled(w: &mut World) -> Vec<(u64, String)> {
        w.drain_events()
            .into_iter()
            .filter_map(|e| match e {
                GameEvent::EffectStart {
                    tick,
                    id,
                    kind,
                    seed,
                    duration,
                } => Some((
                    u64::from(tick),
                    format!("EffectStart {id} {kind:?} {seed} {duration}"),
                )),
                GameEvent::ItemSpawn {
                    tick,
                    world_item_id,
                    item_id,
                    count,
                    source,
                    ..
                } => Some((
                    u64::from(tick),
                    format!("ItemSpawn {world_item_id} {item_id} {count} {source:?}"),
                )),
                GameEvent::CrateSpawn {
                    tick,
                    world_item_id,
                    ..
                } => Some((u64::from(tick), format!("CrateSpawn {world_item_id}"))),
                GameEvent::ItemDespawn {
                    tick,
                    world_item_id,
                } => Some((u64::from(tick), format!("ItemDespawn {world_item_id}"))),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_late_clock_is_the_same_round_shifted() {
        // Past every schedule `World::build` anchors at 0, so a missing rebase
        // shows up as a burst or a mass despawn on the first tick.
        let late = WORLD_ITEM_TTL + CRATE_INTERVAL + EFFECT_INTERVAL_MAX + ITEM_SPAWN_INTERVAL;
        let mut a = World::for_test(4242, MapScale::Small);
        let mut b = World::for_test(4242, MapScale::Small);
        b.start_clock_at(late);
        for w in [&mut a, &mut b] {
            w.set_phase(RoundPhase::Playing);
            let _ = w.drain_events();
        }
        // Long enough for each schedule to fire at least once in the early world.
        let span =
            WORLD_ITEM_TTL.max(CRATE_INTERVAL).max(EFFECT_INTERVAL_MAX) + ITEM_SPAWN_INTERVAL;
        let steps = (span / SIM_DT).ceil() as u32;
        // The starting items, whose despawn is a pure deadline off `spawned_at`.
        let initial: Vec<String> = a
            .items
            .iter()
            .map(|it| format!("ItemDespawn {}", it.id))
            .collect();
        let (mut ea, mut eb) = (Vec::new(), Vec::new());
        for _ in 0..steps {
            a.step(SIM_DT);
            b.step(SIM_DT);
            ea.extend(scheduled(&mut a));
            eb.extend(scheduled(&mut b));
        }

        // **What a late clock must preserve, and what it may not.** A round is
        // not literally the same round shifted: some of it is a function of
        // round time by design (the day/night cycle), and measured, an item
        // spawned 11 ticks later in the late world, beyond any f32 rounding.
        // What `start_clock_at` promises is narrower. Every *deadline* keeps
        // its offset, and nothing bursts to catch up. So the pure deadlines are
        // compared one by one: effect rolls, crate drops, the starting items'
        // lifetimes. Item spawns, whose timing moves with the clock, are
        // compared as a total.
        let deadlines = |evs: &[(u64, String)]| -> Vec<(u64, String)> {
            evs.iter()
                .filter(|(_, e)| {
                    e.starts_with("EffectStart")
                        || e.starts_with("CrateSpawn")
                        || initial.contains(e)
                })
                .cloned()
                .collect()
        };
        let (da, db) = (deadlines(&ea), deadlines(&eb));
        // Controls: each kind of deadline fired in the window, or its comparison is vacuous.
        for kind in ["EffectStart", "CrateSpawn", "ItemDespawn"] {
            assert!(
                da.iter().any(|(_, e)| e.starts_with(kind)),
                "no {kind} deadline fired in the window — widen it"
            );
        }
        // How far f32 accumulation can move a deadline, in ticks: every step can
        // round by one epsilon of the largest clock value either world reaches.
        // Derived, not chosen. A missing rebase moves a deadline by thousands of
        // ticks (an effect on tick 1, every starting item gone at once).
        let drift = (steps as f32 * f32::EPSILON * (late + span) / SIM_DT).ceil() as u64 + 1;
        // A deadline near the window's end may have its late twin just past it.
        let horizon = u64::from(steps).saturating_sub(drift);
        let early: Vec<_> = da.iter().filter(|(t, _)| *t <= horizon).collect();
        for (i, (t_early, early_ev)) in early.iter().enumerate() {
            let Some((t_late, late_ev)) = db.get(i) else {
                panic!(
                    "a clock started at {late} s lost deadline {i} of {}: {early_ev} on tick {t_early}",
                    early.len()
                );
            };
            assert!(
                late_ev == early_ev && t_late.abs_diff(*t_early) <= drift,
                "a clock started at {late} s moved a deadline rather than shifting it. \
                 Deadline {i} of {}:\n  early: tick {t_early} {early_ev}\n  late:  tick \
                 {t_late} {late_ev}\n  (ticks may differ by at most {drift}, the f32 drift bound)",
                early.len()
            );
        }
        // No burst: the same number of item spawns, give or take the one batch a
        // clock-dependent lag can push across the window's end. A schedule left at
        // 0 fires a batch every tick until it catches up: a dozen batches, not one.
        let spawns = |evs: &[(u64, String)]| {
            evs.iter()
                .filter(|(_, e)| e.starts_with("ItemSpawn"))
                .count()
        };
        let (sa, sb) = (spawns(&ea), spawns(&eb));
        assert!(sa > 0, "control: no item spawned in the window — widen it");
        assert!(
            sa.abs_diff(sb) <= crate::constants::ITEM_SPAWN_BATCH_MAX as usize,
            "a clock started at {late} s spawned {sb} items where round time 0 spawned {sa} \
             — more than one batch apart, so a schedule burst to catch up"
        );
        // The clocks themselves, to the same f32 drift bound, in seconds.
        // Measured 163.976 s apart for `late` = 164: accumulation, not a missing
        // offset, which would be off by all of `late`.
        assert!(
            (b.round_time - a.round_time - late).abs() <= drift as f32 * SIM_DT,
            "the late world's clock is not `late` ahead: {} vs {} (bound {} s)",
            b.round_time,
            a.round_time,
            drift as f32 * SIM_DT
        );
    }

    #[test]
    fn a_clock_started_at_night_is_dark() {
        let mut night = World::for_test(4242, MapScale::Small);
        night.start_clock_at(NIGHT_START * CYCLE_LENGTH);
        let day = World::for_test(4242, MapScale::Small);
        assert!(
            night.darkness() > day.darkness(),
            "control and subject agree: night {} vs day {}",
            night.darkness(),
            day.darkness()
        );
        assert!((night.darkness() - crate::constants::NIGHT_DARKNESS).abs() < 1e-3);
    }

    /// T22.06: no night in orbit. The standard world at the same moment is the
    /// control — it is dark — so this cannot pass for a clock that never reached
    /// night.
    #[test]
    fn space_has_no_night() {
        let mut space = World::for_test(4242, MapScale::Small);
        space.gravity = GravityMode::Space;
        space.start_clock_at(NIGHT_START * CYCLE_LENGTH);
        let mut ground = World::for_test(4242, MapScale::Small);
        ground.start_clock_at(NIGHT_START * CYCLE_LENGTH);
        assert!(
            ground.darkness() > 0.5 * crate::constants::NIGHT_DARKNESS,
            "control: {}",
            ground.darkness()
        );
        assert_eq!(space.darkness(), 0.0);
    }
}

/// `World::set_warmup_seconds`: the phase ends when the configured warmup does,
/// through the same `phase_time_left` the step already consults.
#[cfg(test)]
mod warmup_seconds_tests {
    use super::*;
    use crate::constants::SIM_DT;

    /// Step a fresh world until it leaves `Warmup`; the round time it did so at.
    fn warmup_ends_at(w: &mut World) -> f32 {
        let cap = ((WARMUP_SECONDS * 2.0) / SIM_DT).ceil() as u32;
        for _ in 0..cap {
            if w.phase != RoundPhase::Warmup {
                return w.round_time;
            }
            w.step(SIM_DT);
        }
        f32::INFINITY
    }

    #[test]
    fn a_shortened_warmup_hands_over_to_playing_when_it_says() {
        let short = WARMUP_SECONDS / 4.0;
        let mut w = World::for_test(4242, MapScale::Small);
        w.set_warmup_seconds(short);
        let ended = warmup_ends_at(&mut w);
        assert_eq!(w.phase, RoundPhase::Playing, "warmup never ended");
        assert!(
            (ended - short).abs() <= SIM_DT * 2.0,
            "a {short} s warmup ended at round time {ended}"
        );
        // The control: an untouched world is still warming up at that moment,
        // and ends at the shipped constant, so the setter is what moved it.
        let mut d = World::for_test(4242, MapScale::Small);
        let shipped = warmup_ends_at(&mut d);
        assert!(
            (shipped - WARMUP_SECONDS).abs() <= SIM_DT * 2.0,
            "the default warmup ended at {shipped}, not WARMUP_SECONDS"
        );
        assert!(
            shipped > ended + SIM_DT,
            "control: the setter changed nothing"
        );
    }
}

/// T22.09A — space's radiation, and the suit that seals it out (`M22-RULINGS`
/// R2, R6, R20, R24, R25, R74, R75).
///
/// **The fixture is a standard map with the mode set to space before anyone
/// joins**, not a generated space map: no asteroids means no field and no rim,
/// so nothing but radiation moves health or battery, and a body stays where it
/// spawned. `issue_suit` reads the mode at `add_player`, so the order matters.
#[cfg(test)]
mod radiation_tests {
    use super::*;
    use crate::constants::{
        BATTERY_MAX, BATTERY_PACK_AMOUNT, RADIATION_DPS, RADIATION_LOG_INTERVAL,
        RADIATION_SHIELD_COST, SIM_DT, SIM_HZ,
    };

    const ANA: PlayerId = 0;
    const BO: PlayerId = 1;
    /// Whole intervals, so "the rate" is a count of entries and not a tolerance.
    const SECONDS: u32 = 10;

    /// ana unsealed (battery flat), bo sealed (a fresh suit), both past their
    /// spawn i-frames, in `Playing`, weather off and the ground swept.
    fn world(gravity: GravityMode) -> World {
        let mut w = World::for_test(4242, MapScale::Small);
        w.weather_mode = WeatherMode::Off;
        w.gravity = gravity;
        w.set_round_seconds(600.0);
        w.set_phase(RoundPhase::Playing);
        w.add_player(ANA, 0, "ana".into());
        w.add_player(BO, 0, "bo".into());
        for p in w.players.iter_mut() {
            p.iframes_until = 0.0;
        }
        if let Some(p) = w.player_mut(ANA) {
            p.battery = 0.0;
        }
        let _ = w.drain_events();
        w
    }

    fn sweep(w: &mut World) {
        let ids: Vec<_> = w.items.iter().map(|i| i.id).collect();
        for id in ids {
            w.items.remove(id);
        }
    }

    /// Step `seconds`, returning every radiation `Damage` event and the tick it
    /// landed on.
    fn run(w: &mut World, seconds: f32) -> Vec<(u32, PlayerId, f32)> {
        let mut hits = Vec::new();
        for _ in 0..(seconds * SIM_HZ as f32).round() as u32 {
            sweep(w);
            w.step(SIM_DT);
            for e in w.drain_events() {
                if let GameEvent::Damage {
                    tick,
                    victim,
                    amount,
                    cause: DeathCause::Radiation,
                    ..
                } = e
                {
                    hits.push((tick, victim, amount));
                }
            }
        }
        hits
    }

    fn hp(w: &World, id: PlayerId) -> f32 {
        w.player(id).expect("seated").health
    }
    fn battery(w: &World, id: PlayerId) -> f32 {
        w.player(id).expect("seated").battery
    }

    /// The rate, **with a sealed control in the same world**: "ana lost health"
    /// is satisfied by a world that damages everybody.
    #[test]
    fn an_unsealed_player_loses_radiation_dps_and_a_sealed_one_loses_none() {
        let mut w = world(GravityMode::Space);
        let (a0, b0) = (hp(&w, ANA), hp(&w, BO));
        run(&mut w, SECONDS as f32);
        let lost = a0 - hp(&w, ANA);
        let want = RADIATION_DPS * SECONDS as f32;
        assert!(
            (lost - want).abs() < 1e-3,
            "unsealed for {SECONDS} s lost {lost}, not RADIATION_DPS x {SECONDS} = {want}"
        );
        assert_eq!(hp(&w, BO), b0, "the sealed control took radiation damage");
    }

    /// Both ends of the economy: the seal costs `RADIATION_SHIELD_COST` a
    /// second, and a battery pack buys it back — and buys ana out of the
    /// radiation, which is the pack's whole point in this mode.
    #[test]
    fn a_sealed_suit_drains_and_a_battery_pack_restores_it() {
        let mut w = world(GravityMode::Space);
        assert_eq!(
            battery(&w, BO),
            BATTERY_MAX,
            "bo's suit was not issued full"
        );
        run(&mut w, SECONDS as f32);
        let drained = BATTERY_MAX - battery(&w, BO);
        let want = RADIATION_SHIELD_COST * SECONDS as f32;
        assert!(
            (drained - want).abs() < 1e-2,
            "sealed for {SECONDS} s spent {drained}, not {want}"
        );
        assert_eq!(
            battery(&w, ANA),
            0.0,
            "an unsealed suit spent charge it did not have"
        );

        // The restore, on the unsealed one — from flat, so `add_battery`'s
        // clamp at `BATTERY_MAX` cannot hide it: charged, then sealed.
        if let Some(p) = w.player_mut(ANA) {
            p.batteries = 1;
        }
        assert!(w.use_battery_pack(ANA).is_ok(), "ana could not use a pack");
        assert_eq!(battery(&w, ANA), BATTERY_PACK_AMOUNT);
        let a = hp(&w, ANA);
        let hits = run(&mut w, 3.0);
        assert_eq!(hp(&w, ANA), a, "a charged suit still let radiation through");
        assert!(
            hits.is_empty(),
            "radiation events with both suits sealed: {hits:?}"
        );
    }

    /// **The transition, not the two states**: a suit with two seconds of
    /// charge holds for two seconds and then lets radiation in, and the first
    /// entry lands one log interval after the battery reads zero.
    #[test]
    fn at_zero_battery_the_seal_fails_and_radiation_starts() {
        let mut w = world(GravityMode::Space);
        let grace = 2.0;
        if let Some(p) = w.player_mut(BO) {
            p.battery = RADIATION_SHIELD_COST * grace;
        }
        let b0 = hp(&w, BO);
        let mut empty_at = None;
        let mut first_hit = None;
        for _ in 0..((grace + 3.0) * SIM_HZ as f32) as u32 {
            sweep(&mut w);
            w.step(SIM_DT);
            if empty_at.is_none() && battery(&w, BO) == 0.0 {
                empty_at = Some(w.tick);
            }
            for e in w.drain_events() {
                if let GameEvent::Damage {
                    tick, victim: BO, ..
                } = e
                {
                    first_hit.get_or_insert(tick);
                }
            }
            if empty_at.is_none() {
                assert_eq!(hp(&w, BO), b0, "bo took damage with charge in the suit");
            }
        }
        let (empty, hit) = (
            empty_at.expect("the suit never ran flat"),
            first_hit.expect("the flat suit never let radiation in"),
        );
        let interval = (RADIATION_LOG_INTERVAL * SIM_HZ as f32) as u32;
        assert!(
            hit >= empty && hit - empty <= interval + 1,
            "flat at tick {empty}, first radiation at {hit}: want within one interval ({interval} ticks)"
        );
        assert!(hp(&w, BO) < b0, "control: no damage after the seal failed");
    }

    /// **Absent outside space, with the presence control**: the same fixture
    /// and ana's same flat battery lose health in space and nothing elsewhere.
    #[test]
    fn there_is_no_radiation_outside_space() {
        let mut space = world(GravityMode::Space);
        let before = hp(&space, ANA);
        run(&mut space, 3.0);
        assert!(
            hp(&space, ANA) < before,
            "control: space did not irradiate ana"
        );
        for g in [GravityMode::Standard, GravityMode::Low] {
            let mut w = world(g);
            let (a, b, bb) = (hp(&w, ANA), hp(&w, BO), battery(&w, BO));
            let hits = run(&mut w, 3.0);
            assert!(hits.is_empty(), "{g:?}: radiation events {hits:?}");
            assert_eq!(hp(&w, ANA), a, "{g:?}: an unsealed player lost health");
            assert_eq!((hp(&w, BO), battery(&w, BO)), (b, bb), "{g:?}: bo moved");
            assert_eq!(bb, 0.0, "{g:?}: a suit was issued outside space");
        }
    }

    /// R25: one `Damage` event a second, not sixty — each worth a whole second.
    #[test]
    fn radiation_logs_one_damage_event_a_second() {
        let mut w = world(GravityMode::Space);
        let hits = run(&mut w, SECONDS as f32);
        let ana: Vec<_> = hits.iter().filter(|h| h.1 == ANA).collect();
        assert_eq!(
            ana.len() as u32,
            SECONDS,
            "{SECONDS} s unsealed gave {} radiation events",
            ana.len()
        );
        for (_, _, amount) in &ana {
            assert_eq!(*amount, RADIATION_DPS * RADIATION_LOG_INTERVAL);
        }
        assert!(
            hits.iter().all(|h| h.1 == ANA),
            "the sealed bo was logged: {hits:?}"
        );
    }

    /// R20/R75: a radiation death says so, and a recent shooter still gets the
    /// kill — the control that shows the list is not simply outranking credit.
    #[test]
    fn a_radiation_death_is_named_radiation_and_credits_a_recent_shooter() {
        let deaths = |credit: bool| {
            let mut w = world(GravityMode::Space);
            let now = w.round_time;
            if let Some(p) = w.player_mut(ANA) {
                p.health = RADIATION_DPS * RADIATION_LOG_INTERVAL * 0.5;
                if credit {
                    p.last_damaged_by = Some((BO, now));
                }
            }
            let mut out = Vec::new();
            for _ in 0..(2.0 * RADIATION_LOG_INTERVAL * SIM_HZ as f32) as u32 {
                w.step(SIM_DT);
                assert!(
                    w.irradiated_this_tick.is_empty(),
                    "R75: the radiation list survived a step"
                );
                for e in w.drain_events() {
                    if let GameEvent::Death {
                        victim: ANA, cause, ..
                    } = e
                    {
                        out.push(cause);
                    }
                }
            }
            out
        };
        assert_eq!(
            deaths(false),
            vec![DeathCause::Radiation],
            "radiation, unassisted"
        );
        assert_eq!(
            deaths(true),
            vec![DeathCause::Player(BO)],
            "radiation, bo shot her"
        );
    }

    /// **A body that took a killing blow earlier in the tick is not
    /// irradiated on it** (review of T22.09A, F1). `alive` stays true until
    /// `resolve_deaths`, so a stage-8c filter on `alive` alone let radiation
    /// land on the dying — putting them on the R75 list and relabelling a
    /// hazard death as Radiation, the one mislabel R75 exists to prevent, about
    /// one tick in sixty. The killing blow is toxic poison (stage 8a): a
    /// `DamageSource::Weather` hit landing before 8c on the same tick, the
    /// same path a meteor takes, and the only one a test can time to the tick.
    ///
    /// **The control** is the same tick with no poison: radiation does fire on
    /// it, so the absence below is the filter's and not the clock's.
    #[test]
    ///
    /// **And the flare's arm** (T22.08A, R81): a flare burn that kills on the
    /// radiation tick is a `Weather` death too, because stage 8a2 logs before 8c.
    fn a_hazard_death_on_the_radiation_tick_is_not_named_radiation() {
        use crate::constants::TOXIC_POISON_DPS;
        #[derive(Clone, Copy, PartialEq)]
        enum Hazard {
            None,
            Poison,
            Flare,
        }
        let one_tick = |hazard: Hazard| {
            let mut w = world(GravityMode::Space);
            let now = w.round_time;
            if let Some(p) = w.player_mut(ANA) {
                // One tick short of a whole interval: the next step logs.
                p.radiation_exposure = RADIATION_LOG_INTERVAL - SIM_DT;
                if hazard == Hazard::Poison {
                    p.health = TOXIC_POISON_DPS * SIM_DT * 0.5;
                    p.poisoned_until = now + 1.0;
                }
                if hazard == Hazard::Flare {
                    // Burning, one tick short of its next whole second too.
                    p.health = 1.0;
                    p.burn(now);
                    p.burn_exposure = RADIATION_LOG_INTERVAL - SIM_DT;
                }
            }
            sweep(&mut w);
            w.step(SIM_DT);
            let (mut rad, mut deaths) = (0, Vec::new());
            for e in w.drain_events() {
                match e {
                    GameEvent::Damage {
                        victim: ANA,
                        cause: DeathCause::Radiation,
                        ..
                    } => rad += 1,
                    GameEvent::Death {
                        victim: ANA, cause, ..
                    } => deaths.push(cause),
                    _ => {}
                }
            }
            (rad, deaths)
        };
        assert_eq!(
            one_tick(Hazard::None),
            (1, vec![]),
            "control: radiation did not land on the tick under test"
        );
        assert_eq!(
            one_tick(Hazard::Poison),
            (0, vec![DeathCause::Weather]),
            "poisoned dead on the radiation tick: (radiation Damage events, death causes)"
        );
        assert_eq!(
            one_tick(Hazard::Flare),
            (0, vec![DeathCause::Weather]),
            "burned dead on the radiation tick: (radiation Damage events, death causes)"
        );
    }

    /// **Stage 8c runs in `Playing` only** (review of T22.09A, F2): deleting
    /// `playing &&` once left every test green, because `apply_damage_log`'s
    /// warmup gate hides the damage — but not the *drain*, and not `Ended`.
    /// Warmup and Ended leave bo's sealed battery and ana's radiation alone;
    /// Playing, in the same test, moves both.
    #[test]
    fn radiation_and_the_seal_drain_are_playing_only() {
        for (phase, live) in [
            (RoundPhase::Warmup, false),
            (RoundPhase::Ended, false),
            (RoundPhase::Playing, true),
        ] {
            let mut w = world(GravityMode::Space);
            w.set_phase(phase);
            let _ = w.drain_events();
            let b0 = battery(&w, BO);
            let hits = run(&mut w, 3.0);
            assert_eq!(w.phase, phase, "the phase moved under the test");
            let drained = b0 - battery(&w, BO);
            if live {
                assert!(drained > 0.0, "control: Playing did not drain the seal");
                assert!(!hits.is_empty(), "control: Playing did not irradiate ana");
            } else {
                assert_eq!(drained, 0.0, "{phase:?}: the sealed suit drained");
                assert!(hits.is_empty(), "{phase:?}: radiation events {hits:?}");
            }
        }
    }

    /// Review of T22.09A/B, F5 — **refuted, and the guard it questioned had no
    /// test.** The nit read `p.alive && !p.is_dying()` as redundant because
    /// `is_dying` includes `alive`; but `!is_dying()` is *true* for the dead, so
    /// dropping `p.alive` irradiates corpses. Measured before this test: planting
    /// `filter(|p| !p.is_dying())` left every radiation test green. A dead sealed
    /// suit must not drain and a dead flat one must not accrue exposure; the
    /// Playing arm of `radiation_and_the_seal_drain_are_playing_only` is the
    /// control that the same world does both to the living.
    #[test]
    fn the_dead_are_neither_drained_nor_irradiated() {
        let mut w = world(GravityMode::Space);
        let far = w.round_time + 1000.0;
        for p in w.players.iter_mut() {
            p.alive = false;
            p.respawn_at = far;
        }
        let b0 = battery(&w, BO);
        let hits = run(&mut w, 3.0);
        assert_eq!(battery(&w, BO), b0, "a dead sealed suit drained");
        let exposure = w.player(ANA).expect("seated").radiation_exposure;
        assert_eq!(exposure, 0.0, "a dead flat suit accrued exposure");
        assert!(hits.is_empty(), "radiation events on the dead: {hits:?}");
    }

    /// R2, at the live site: `apply_damage_log` hands `apply_damage` the
    /// mode's suit, so **a charged suit softens a weapon hit by
    /// `SHIELD_DAMAGE_MULT`** exactly as a generator does — and a flat one, the
    /// control in the same blast geometry, does not.
    #[test]
    fn a_charged_suit_softens_a_weapon_hit_and_a_flat_one_does_not() {
        use crate::constants::SHIELD_DAMAGE_MULT;
        use crate::items::registry::WEAPON_BAZOOKA;
        let mut w = world(GravityMode::Space);
        let now = w.round_time;
        let mut lost = [0.0f32; 2];
        for (k, id) in [ANA, BO].into_iter().enumerate() {
            let (at, before) = {
                let p = w.player(id).expect("seated");
                (p.body.pos, p.health)
            };
            w.hit_player_for_test(at, WEAPON_BAZOOKA, id, now);
            lost[k] = before - hp(&w, id);
        }
        let [flat, sealed] = lost;
        assert!(
            flat > 0.0,
            "control: the blast did nothing to the flat suit"
        );
        assert!(
            (sealed - flat * SHIELD_DAMAGE_MULT).abs() < 0.05,
            "sealed lost {sealed}, flat {flat}: want flat x SHIELD_DAMAGE_MULT"
        );
    }

    /// R24: the suit is full at join and **restored on respawn** in space —
    /// what stops the first radiation death guaranteeing the second — and not
    /// issued at all outside space.
    #[test]
    fn the_suit_is_full_at_join_and_at_respawn_in_space_only() {
        for (g, want) in [
            (GravityMode::Space, BATTERY_MAX),
            (GravityMode::Standard, 0.0),
            // Low gravity is the other non-space mode, and the one a
            // `!= Standard` test in `issue_suit` would wrongly suit up.
            (GravityMode::Low, 0.0),
        ] {
            let mut w = World::for_test(4242, MapScale::Small);
            w.weather_mode = WeatherMode::Off;
            w.gravity = g;
            w.set_phase(RoundPhase::Playing);
            w.add_player(ANA, 0, "ana".into());
            assert_eq!(battery(&w, ANA), want, "{g:?}: at join");
            if let Some(p) = w.player_mut(ANA) {
                p.battery = 0.0;
                p.iframes_until = 0.0;
                p.health = 0.0;
            }
            let mut respawned = false;
            for _ in 0..((crate::constants::RESPAWN_DELAY + 1.0) * SIM_HZ as f32) as u32 {
                w.step(SIM_DT);
                respawned |= w
                    .drain_events()
                    .iter()
                    .any(|e| matches!(e, GameEvent::Respawn { id: ANA, .. }));
                if respawned {
                    break;
                }
            }
            assert!(respawned, "{g:?}: ana never respawned");
            assert_eq!(battery(&w, ANA), want, "{g:?}: at respawn");
        }
    }
}

/// T22.08A — solar flares, end to end through `World`: the roll on the map's
/// table, the touch, the burn and what it costs, forcing, and the meteor load in
/// space (`R84`).
#[cfg(test)]
mod solar_flare_tests {
    use super::*;
    use crate::constants::{
        MapScale, BASE_HEALTH, DEFAULT_MAP_GENERATOR, EFFECT_TELEGRAPH, METEOR_DURATION,
        METEOR_EVERY, METEOR_FRAGMENTS, METEOR_FRAG_SPEED_MIN, METEOR_SPEED,
        PROJECTILE_MAX_LIFETIME, RADIATION_SHIELD_COST, ROUND_SECONDS_MAX, SHIELD_DAMAGE_MULT,
        SHIELD_HIT_COST, SIM_DT, SOLAR_FLARE_BURN_SECONDS, SOLAR_FLARE_DPS,
    };

    const ANA: PlayerId = 0;
    const BO: PlayerId = 1;

    /// A real map of `gravity`'s generator — `with_gravity`, so a space world has
    /// asteroids and `WeatherTable::of` reads `Space` off it.
    fn world_on(gravity: GravityMode) -> World {
        let mut w = World::with_gravity(4242, MapScale::Medium, 0, DEFAULT_MAP_GENERATOR, gravity);
        w.set_round_seconds(600.0);
        w.set_phase(RoundPhase::Playing);
        w
    }

    /// Which effect kinds start over `seconds` of a real round.
    fn kinds_started(w: &mut World, seconds: f32) -> Vec<EffectKind> {
        let mut out = Vec::new();
        for _ in 0..(seconds / SIM_DT) as u32 {
            w.step(SIM_DT);
            for e in w.drain_events() {
                if let GameEvent::EffectStart { kind, .. } = e {
                    out.push(kind);
                }
            }
        }
        out
    }

    /// **The production roll reads the map** (R78): a space round rolls flares,
    /// a standard round on the same seed never does and rolls its own weather —
    /// the presence beside each absence. `WeatherTable::of` is only this test's
    /// subject through `World::step`, which is its one production caller.
    #[test]
    fn a_space_round_rolls_flares_and_a_standard_round_never_does() {
        let space = kinds_started(&mut world_on(GravityMode::Space), 400.0);
        let ground = kinds_started(&mut world_on(GravityMode::Standard), 400.0);
        assert!(
            space.contains(&EffectKind::SolarFlare),
            "a space round rolled no flare in 400 s: {space:?}"
        );
        assert!(
            space
                .iter()
                .all(|k| matches!(k, EffectKind::SolarFlare | EffectKind::MeteorShower)),
            "space rolled ground weather: {space:?}"
        );
        assert!(
            !ground.is_empty(),
            "control: the standard round rolled nothing"
        );
        assert!(
            !ground.contains(&EffectKind::SolarFlare),
            "a standard round rolled a flare: {ground:?}"
        );
    }

    /// Two players in a space round, past their i-frames; the flare forced and
    /// stepped to its first `Active` tick. Returns the world and the flare's start.
    fn flaring() -> (World, f32) {
        let mut w = world_on(GravityMode::Space);
        // Not `WeatherMode::Off`, which skips the scheduler and would leave the
        // forced flare telegraphing forever: the natural roll pushed out instead.
        w.effects.postpone_until(1.0e9);
        w.add_player(ANA, 0, "ana".into());
        w.add_player(BO, 0, "bo".into());
        for p in w.players.iter_mut() {
            p.iframes_until = 0.0;
        }
        let start = w.round_time;
        w.force_effect(EffectKind::SolarFlare, start);
        while !w.effects.is_active(EffectKind::SolarFlare) {
            w.step(SIM_DT);
        }
        let _ = w.drain_events();
        (w, start)
    }

    /// **Touching burns; standing clear does not.** ana is put on the ribbon —
    /// where `SolarFlare::points_at` says it is on the next tick — and bo on the
    /// far side of the map from it, the control. A touch writes the deadline
    /// `SOLAR_FLARE_BURN_SECONDS` out (R79).
    #[test]
    fn a_player_on_the_ribbon_burns_and_one_clear_of_it_does_not() {
        let (mut w, start) = flaring();
        // **Two ticks on the ribbon, not one**, so the deadline is asserted after
        // a re-touch: rewritten, it is still `now + N`; added to — a stacking
        // bleed, which R79 forbids — it would be twice that.
        for _ in 0..2 {
            let next = w.round_time + SIM_DT;
            let pts = w
                .flare
                .as_ref()
                .expect("installed")
                .2
                .points_at(next - start);
            let on = pts[pts.len() / 2];
            let far = Vec2::new(w.map.mask.w as f32 - on.x, w.map.mask.h as f32 - on.y);
            assert!(
                (far - on).len() > 600.0,
                "the control is not clear of the ribbon"
            );
            for (id, at) in [(ANA, on), (BO, far)] {
                let p = w.player_mut(id).expect("seated");
                p.body.pos = at;
                p.body.vel = Vec2::ZERO;
            }
            w.step(SIM_DT);
        }
        let ana = w.player(ANA).expect("seated");
        let bo = w.player(BO).expect("seated");
        assert!(
            ana.burning(w.round_time),
            "ana stood on the ribbon and is not burning"
        );
        assert!(
            (ana.burning_until - (w.round_time + SOLAR_FLARE_BURN_SECONDS)).abs() < 1e-3,
            "the deadline is {} — not now + {SOLAR_FLARE_BURN_SECONDS}",
            ana.burning_until
        );
        assert!(!bo.burning(w.round_time), "bo, across the map, is burning");
    }

    /// Flare `Damage` per victim over `seconds`, as (events, total).
    fn flare_damage(w: &mut World, seconds: f32) -> [(u32, f32); 2] {
        let mut out = [(0u32, 0.0f32); 2];
        for _ in 0..(seconds / SIM_DT).round() as u32 {
            w.step(SIM_DT);
            for e in w.drain_events() {
                if let GameEvent::Damage {
                    victim,
                    amount,
                    cause: DeathCause::Weather,
                    ..
                } = e
                {
                    let i = victim as usize;
                    out[i].0 += 1;
                    out[i].1 += amount;
                }
            }
        }
        out
    }

    /// **A full burn costs what `SOLAR_FLARE_DPS`'s basis says** (R81, R82): one
    /// touch, then nothing — exactly `SOLAR_FLARE_BURN_SECONDS` `Damage` events,
    /// one a second, `DPS × N` unsealed; sealed, `× SHIELD_DAMAGE_MULT` in health
    /// and `SHIELD_HIT_COST` a hit in energy on top of the seal's own drain.
    /// Measured on a space round, where the suit is live: ana's is flat, bo's full.
    #[test]
    fn a_full_burn_costs_what_the_basis_says() {
        let (mut w, _) = flaring();
        // Nothing else may touch them: the flare's own ribbon is ended here, so
        // the one burn below is the only one.
        w.flare = None;
        w.player_mut(ANA).expect("seated").battery = 0.0;
        // Written at the **next** tick's clock: in a match the touch (stage 5)
        // and the first burn tick (8a2) share one `now`, and a burn stamped at the
        // previous tick's clock covers one tick fewer — measured, 3 logs not 4.
        let now = w.round_time + SIM_DT;
        for id in [ANA, BO] {
            w.player_mut(id).expect("seated").burn(now);
        }
        let b0 = w.player(BO).expect("seated").battery;
        let h0 = w.player(BO).expect("seated").health;
        let got = flare_damage(&mut w, SOLAR_FLARE_BURN_SECONDS + 2.0);
        let full = SOLAR_FLARE_DPS * SOLAR_FLARE_BURN_SECONDS;
        let n = SOLAR_FLARE_BURN_SECONDS as u32;
        assert_eq!(got[ANA as usize].0, n, "unsealed: {got:?}");
        assert!(
            (got[ANA as usize].1 - full).abs() < 1e-3,
            "unsealed lost {got:?}, want {full}"
        );
        assert_eq!(got[BO as usize].0, n, "sealed: {got:?}");
        // Health is the truth — bo is sealed, so radiation takes none of it.
        let lost = h0 - w.player(BO).expect("seated").health;
        let sealed = full * SHIELD_DAMAGE_MULT;
        assert!(
            (lost - sealed).abs() < 1e-3,
            "sealed lost {lost} health, want {sealed}"
        );
        // **And the `Damage` events say so** (T22.08C F4): they carry what
        // *landed*, so the number over a sealed player's head is the health that
        // came off, not the rolled amount the suit softened.
        assert!(
            (got[BO as usize].1 - lost).abs() < 1e-3,
            "the sealed player's Damage events total {} but {lost} health came off",
            got[BO as usize].1
        );
        // The energy: the seal's drain for the whole run, plus one hit's cost per burn.
        let spent = b0 - w.player(BO).expect("seated").battery;
        let drain = RADIATION_SHIELD_COST * (SOLAR_FLARE_BURN_SECONDS + 2.0);
        let hits = SHIELD_HIT_COST * n as f32;
        assert!(
            (spent - (drain + hits)).abs() < 0.05,
            "the sealed suit spent {spent}: want the drain {drain} + the hits {hits}"
        );
    }

    /// **No flare burns after the bell** (T22.08C F1). A touch in the last
    /// seconds of `Playing`, then the round ends: not one flare `Damage` in
    /// `Ended` — a death there changes the score and `killer()` could credit a
    /// kill on the results screen. The control is the same touch left in
    /// `Playing`, which burns the full `SOLAR_FLARE_BURN_SECONDS`.
    #[test]
    fn a_flare_burn_stops_at_the_bell() {
        let burns_after = |end_the_round: bool| {
            let (mut w, start) = flaring();
            let next = w.round_time + SIM_DT;
            let pts = w
                .flare
                .as_ref()
                .expect("installed")
                .2
                .points_at(next - start);
            let p = w.player_mut(ANA).expect("seated");
            p.body.pos = pts[pts.len() / 2];
            p.body.vel = Vec2::ZERO;
            w.step(SIM_DT);
            assert!(
                w.player(ANA).expect("seated").burning(w.round_time),
                "the touch did not take"
            );
            // The ribbon gone, so the one touch above is the only burn.
            w.flare = None;
            if end_the_round {
                w.set_phase(RoundPhase::Ended);
            }
            flare_damage(&mut w, SOLAR_FLARE_BURN_SECONDS + 1.0)[ANA as usize].0
        };
        assert!(
            burns_after(false) >= SOLAR_FLARE_BURN_SECONDS as u32 - 1,
            "control: the burn in Playing logged too little to mean anything"
        );
        assert_eq!(burns_after(true), 0, "a flare burned after the bell");
    }

    /// **The burn's tail touches nobody** (F1): the effect stays `Active` for
    /// `SOLAR_FLARE_BURN_SECONDS` after the ribbon has gone, and a body standing
    /// where the ribbon's formula would put it then is not burned. The presence
    /// is `a_player_on_the_ribbon_burns_and_one_clear_of_it_does_not`, same fixture.
    #[test]
    fn nobody_is_touched_in_the_burns_tail() {
        let (mut w, start) = flaring();
        while SolarFlare::lit(w.round_time + SIM_DT - start) {
            w.step(SIM_DT);
        }
        assert!(
            w.effects.is_active(EffectKind::SolarFlare),
            "control: the effect is no longer Active, so this tests nothing"
        );
        let next = w.round_time + SIM_DT;
        let pts = w
            .flare
            .as_ref()
            .expect("installed")
            .2
            .points_at(next - start);
        let p = w.player_mut(ANA).expect("seated");
        p.body.pos = pts[pts.len() / 2];
        p.body.vel = Vec2::ZERO;
        w.step(SIM_DT);
        assert!(
            !w.player(ANA).expect("seated").burning(w.round_time),
            "a ribbon that has gone burned ana"
        );
    }

    /// `SOLAR_FLARE_DPS`'s doc claims a full unsealed burn is about a third of a
    /// health bar (`R27` §5). A claim about the value, pinned against its basis,
    /// so a retune that makes the flare a one-touch kill or a tickle is a red
    /// here and not only a changed number everywhere else.
    /// **T22.08D F4 — the catch-up says what the live events said.** A space round
    /// rolling its own weather, then `WEATHER=flare`'s path (whose seed is the one
    /// `record_seed` had to fix): at every tick an effect runs, `running_effects`
    /// must equal the live `EffectStart` / `EffectPhaseChanged` for that id — tick,
    /// kind, seed and duration. Counted at both ends: every effect that started was
    /// seen in the catch-up, and some were.
    ///
    /// **And F2's basis, on the forced arm**: a client clocks the flare as
    /// `(tick − start tick) · SIM_DT` off the snapshot tick; the server contacts at
    /// `round_time − start`. The two are asserted within half a tick over a whole
    /// maximum round of flares — measured 4.6 ms, under a pixel of the ribbon.
    #[test]
    fn running_effects_replay_the_live_announcements() {
        for forced in [false, true] {
            let mut w = world_on(GravityMode::Space);
            if forced {
                w.weather_mode = WeatherMode::Always(EffectKind::SolarFlare);
            }
            let mut starts = std::collections::BTreeMap::new();
            let mut phases = std::collections::BTreeMap::new();
            let mut seen = std::collections::BTreeSet::new();
            let (mut drift, mut clocked) = (0.0f32, 0u32);
            w.set_round_seconds(ROUND_SECONDS_MAX);
            for _ in 0..((ROUND_SECONDS_MAX + 20.0) / SIM_DT) as u32 {
                w.step(SIM_DT);
                for e in w.drain_events() {
                    match e {
                        GameEvent::EffectStart { id, .. } => {
                            starts.insert(id, e);
                        }
                        GameEvent::EffectPhaseChanged { id, .. } => {
                            phases.insert(id, e);
                        }
                        _ => {}
                    }
                }
                for e in w.running_effects() {
                    let (id, live) = match &e {
                        GameEvent::EffectStart { id, .. } => (*id, starts.get(id)),
                        GameEvent::EffectPhaseChanged { id, .. } => (*id, phases.get(id)),
                        other => panic!("the catch-up sent {other:?}"),
                    };
                    assert_eq!(
                        Some(&e),
                        live,
                        "forced {forced}: effect {id} re-announced differently"
                    );
                    seen.insert(id);
                }
                if let Some((id, elapsed)) = w.flare_elapsed() {
                    if let Some(GameEvent::EffectStart { tick, .. }) = starts.get(&id) {
                        drift = drift.max((elapsed - (w.tick - tick) as f32 * SIM_DT).abs());
                        clocked += 1;
                    }
                }
            }
            assert!(
                !seen.is_empty(),
                "forced {forced}: control — no effect ran in a round"
            );
            assert_eq!(
                seen.len(),
                starts.len(),
                "forced {forced}: {} effects started, the catch-up showed {}",
                starts.len(),
                seen.len()
            );
            assert!(
                clocked > 0,
                "forced {forced}: control — no flare was clocked"
            );
            // Measured 4.6 ms (f32 rounding every `+= SIM_DT` the same way). The bound
            // is the one `running_effects`' rounding needs; it is also under a
            // pixel of the ribbon's travel (`SOLAR_FLARE_SPEED` · 8 ms ≈ 0.75 px).
            assert!(
                drift < 0.5 * SIM_DT,
                "forced {forced}: tick·SIM_DT and round_time disagree by {drift} s about a flare's elapsed"
            );
        }
    }

    /// **`SOLAR_FLARE_CONFIRM_SECONDS`' basis** (T22.08D F3). A client shows a
    /// burn on its own contact test only until the server's word should have come;
    /// that word is the burn's first `Damage`, and it must land within
    /// `RADIATION_LOG_INTERVAL` of the touch for the window (that plus the trip) to
    /// be honest. Measured through `World::step`, so a burn cadence that drifts
    /// makes this red rather than making every client's flames go out early.
    #[test]
    fn a_burns_first_damage_lands_inside_the_clients_confirmation_window() {
        use crate::constants::{RADIATION_LOG_INTERVAL, SNAPSHOT_HZ, SOLAR_FLARE_CONFIRM_SECONDS};
        let (mut w, _) = flaring();
        w.flare = None;
        let touched = w.round_time + SIM_DT;
        w.player_mut(ANA).expect("seated").burn(touched);
        let mut first = None;
        for _ in 0..(2.0 * SOLAR_FLARE_CONFIRM_SECONDS / SIM_DT) as u32 {
            w.step(SIM_DT);
            let hit = w.drain_events().iter().any(|e| {
                matches!(
                    e,
                    GameEvent::Damage {
                        victim: ANA,
                        cause: DeathCause::Weather,
                        // T22.08E F9: the flare's own, so a client confirms flames on it
                        // and not on a meteor fragment's `Weather` hit.
                        effect: Some(crate::effects::EffectKind::SolarFlare),
                        ..
                    }
                )
            });
            if hit {
                first = Some(w.round_time);
                break;
            }
        }
        let first = first.expect("control: the burn never logged a Damage");
        let wait = first - touched;
        assert!(
            wait <= RADIATION_LOG_INTERVAL + 1e-3,
            "the burn's first Damage came {wait} s after the touch — past one log interval"
        );
        assert!(
            SOLAR_FLARE_CONFIRM_SECONDS >= wait + 1.0 / SNAPSHOT_HZ as f32,
            "the window {SOLAR_FLARE_CONFIRM_SECONDS} leaves under a snapshot for the trip after a {wait} s wait"
        );
    }

    #[test]
    fn flare_basis_is_a_third_of_a_health_bar() {
        let share = SOLAR_FLARE_DPS * SOLAR_FLARE_BURN_SECONDS / BASE_HEALTH;
        assert!(
            (0.25..=0.40).contains(&share),
            "a full burn is {share} of a health bar"
        );
    }

    /// **R83: `WEATHER=flare` needs a space map.** The same `Always` on a
    /// standard round forces nothing; on a space round it starts a flare — the
    /// presence that makes the absence mean something.
    #[test]
    fn a_forced_flare_is_refused_off_a_space_map() {
        let forced = |gravity| {
            let mut w = world_on(gravity);
            w.weather_mode = WeatherMode::Always(EffectKind::SolarFlare);
            kinds_started(&mut w, 2.0)
        };
        assert_eq!(
            forced(GravityMode::Space),
            vec![EffectKind::SolarFlare],
            "control"
        );
        assert_eq!(
            forced(GravityMode::Standard),
            vec![],
            "a standard round forced a flare"
        );
    }

    /// **R84 — the meteor load in space, the guard `R43` owed.** In space a
    /// meteor has no gravity to fall under: it crosses the map at a constant
    /// `METEOR_SPEED`, one every `METEOR_EVERY`, and every impact throws
    /// `METEOR_FRAGMENTS` at no less than `METEOR_FRAG_SPEED_MIN`. So the most
    /// that can be airborne at once is the meteors in one crossing plus the
    /// fragments of every impact inside one fragment flight — the longest of which
    /// is the map's diagonal at the slowest speed, or the lifetime cap if sooner.
    /// Asserted, with the control that the shower airborne anything at all.
    #[test]
    fn a_meteor_shower_in_space_keeps_a_bounded_number_in_the_air() {
        let mut w = world_on(GravityMode::Space);
        w.effects.postpone_until(1.0e9);
        w.force_effect(EffectKind::MeteorShower, w.round_time);
        let mut peak = 0usize;
        let window = EFFECT_TELEGRAPH + METEOR_DURATION + PROJECTILE_MAX_LIFETIME;
        for _ in 0..(window / SIM_DT) as u32 {
            w.step(SIM_DT);
            peak = peak.max(w.projectiles.len());
        }
        let (mw, mh) = (w.map.mask.w as f32, w.map.mask.h as f32);
        let flight = ((mh - crate::effects::meteor::spawn_band().0) / METEOR_SPEED)
            .min(PROJECTILE_MAX_LIFETIME);
        let frag_flight = (mw.hypot(mh) / METEOR_FRAG_SPEED_MIN).min(PROJECTILE_MAX_LIFETIME);
        let per = |t: f32| (t / METEOR_EVERY).ceil() as usize + 1;
        let ceiling = per(flight) + per(frag_flight) * METEOR_FRAGMENTS as usize;
        println!(
            "meteors in space: peak {peak} airborne (ceiling {ceiling}); {} ProjectileMove/s",
            peak * (crate::constants::SIM_HZ as usize) / 3
        );
        assert!(
            peak <= ceiling,
            "{peak} airborne against a ceiling of {ceiling}"
        );
        assert!(
            peak >= 2,
            "control: only {peak} meteor(s) ever airborne — this measures nothing"
        );
    }
}
