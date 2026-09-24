//! The player record: health, shield, scoring, death and respawn.
//!
//! See `docs/21-player-stats.md`.

use crate::constants::{
    boots_fall_safe_speed, boots_jump_velocity_mult, BASE_HEALTH, BATTERY_MAX, BOOTS_SPEED_MULT,
    DEATH_POINTS, FALL_DAMAGE_PER_SPEED, FALL_SAFE_SPEED, HEALTH_CAP, HEALTH_SPEED_MIN,
    KILL_POINTS, LASER_BATTERY_DRAIN, LASER_SHIELD_MULT, LIFESTEAL_DAMAGE_PER_HP, OVERHEAL_DECAY,
    RADIATION_DPS, RADIATION_LOG_INTERVAL, RADIATION_SHIELD_COST, RESPAWN_DELAY,
    SHIELD_DAMAGE_MULT, SHIELD_HIT_COST, SOLAR_FLARE_BURN_SECONDS, SOLAR_FLARE_DPS, SPAWN_IFRAMES,
    SPAWN_MIN_ENEMY_DIST, TOXIC_POISON_DURATION, WINGS_SPEED_MULT,
};
use crate::items::inventory::{Inventory, Stack};
use crate::items::registry::{def, ItemId, ItemKind, UtilityId, WeaponId};
use crate::map::Map;
use crate::math::{lerp, Vec2};
use crate::physics::body::Body;
use crate::player::jetpack::JetpackState;
use crate::player::movement::JumpState;
use crate::player::MoveMods;
use crate::rng::ChaCha8Rng;
use crate::weapons::defs;
use crate::weapons::explode::DamageSource;

pub type PlayerId = u8;

/// How long after being damaged by a player an environmental kill still credits
/// them. Without it, shooting someone off a ledge into lava rewards nobody.
pub const ASSIST_WINDOW: f32 = 5.0;

/// What every player is issued at spawn (§F5).
///
/// **One list, two readers, because they are one rule.** `grant_starting_kit`
/// puts it in the inventory and `die` refuses to drop it: "you always have a
/// shovel" and "a shovel cannot be dropped" are the same sentence, and a kit that
/// dropped would be re-granted on respawn while the corpse's copy stayed on the
/// ground — a shovel minted per death. Two lists would eventually disagree.
pub const STARTING_KIT: [ItemId; 1] = [crate::items::registry::SHOVEL];

/// Snapshot bit for T21.02's ironman boots.
pub const MOVE_MOD_BOOTS: u8 = 1 << 0;
/// Snapshot bit for T21.03's unicorn wings.
pub const MOVE_MOD_WINGS: u8 = 1 << 1;
/// Snapshot bit for T21.11B's mounted-on-a-gun-platform.
///
/// **Outside `MOVE_MOD_BITS`, deliberately.** That table maps a bit to a
/// `UtilityId` because every passive in it is an item you carry; mounting is not
/// an item and has no `UtilityId` to key on. Forcing it into the table would
/// have meant inventing a utility nobody can pick up — so it is encoded and
/// decoded explicitly beside the table, in the same two functions, and the
/// table keeps meaning exactly one thing.
pub const MOVE_MOD_MOUNTED: u8 = 1 << 2;

/// The wire's bit assignment for the passives `apply_input` reads (T21.02).
///
/// **A table, and that is not the hand-kept list this project warns against.** A
/// wire format is inherently a table: bit numbers have to be stable across
/// versions, and nothing can derive *which bit* from an `ItemKind`. What must
/// never be a list is the **behaviour**, and it is not — `move_mods` asks
/// `holds_utility`, so a second item granting the same utility needs no entry
/// here, and `item_for_utility` finds the item back out of `ITEMS` by kind.
///
/// Encode (`move_mod_bits`) and decode (`set_move_mod_bits`) both walk this one
/// table, so they cannot disagree about a bit.
const MOVE_MOD_BITS: &[(u8, UtilityId)] = &[
    (MOVE_MOD_BOOTS, UtilityId::IronmanBoots),
    (MOVE_MOD_WINGS, UtilityId::UnicornWings),
];

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DeathCause {
    Player(PlayerId),
    SelfInflicted,
    Weather,
    /// Fell out of the world (§C15). A boundary, not damage — see
    /// `World::step_void` for why it does not go through the damage funnel.
    Void,
    /// Space's radiation, on an unsealed suit (T22.09A, `M22-RULINGS` R20).
    ///
    /// Named by `World`'s per-tick list of who radiation hit (`R75`), not
    /// re-derived from "in space and unsealed" — that would name a meteor
    /// death radiation. Credits a recent attacker exactly as `Weather` does.
    Radiation,
    /// T22.12: inside the black hole's event horizon. Re-derived from the
    /// position, as `Void` is (`world::black_hole::in_horizon`); credits a recent
    /// attacker as `Void` does — shot into it is the shooter's kill.
    BlackHole,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum UseError {
    Dead,
    BadSlot,
    EmptySlot,
    WrongKind,
    OnCooldown,
    NoAmmo,
    /// The round is over (T21.30, `RoundPhase::accepts_input`).
    RoundOver,
}

#[derive(Clone, Debug)]
pub struct PlayerState {
    pub id: PlayerId,
    pub body: Body,
    pub jump: JumpState,
    pub jetpack: JetpackState,
    pub aim: u16,
    pub health: f32,
    // **No `shield_until`** (T20.08). It was the timer a `use` started; a
    // generator is *carried* now and pays per hit, so "is the shield up" is a
    // derived question with two inputs that are already state — the inventory and
    // the battery. A field beside them would be a third answer that can disagree.
    // **The suit is not a field either** (`M22-RULINGS` R26): it is the mode,
    // and the caller of `shield_active` supplies it.
    /// Shared by shields and energy weapons (§B5): every laser shot is a shield
    /// you are not going to have.
    pub battery: f32,
    /// Heals carried, 0..=`MAX_HEALS` (§C9).
    ///
    /// **Not inventory.** They are consumed constantly and should never compete
    /// with a weapon for a slot, so they are counters beside the health bar and
    /// `Q`/`R` spend them wherever the selection happens to be.
    pub heals: u8,
    /// Battery packs carried, 0..=`MAX_BATTERIES` (§C9).
    pub batteries: u8,
    pub inventory: Inventory,
    // **No `flashlight_on`** (T20.07). It was a latch that only `use_item` set
    // and that nothing outside the snapshot's bit 4 ever read, and the flashlight
    // is passive now: carrying one is the whole state, and the encode site derives
    // the bit from `inventory`. Keeping the field would have left a second answer
    // to "does this player have light" that could disagree with the first.
    pub alive: bool,
    pub respawn_at: f32,
    pub iframes_until: f32,
    /// Until when toxic rain is still eating them (§E13).
    ///
    /// **The first per-player status the UI shows.** A re-hit writes this again
    /// rather than adding to it, which is what "resets, does not stack" means in
    /// one line — the same shape as `shield_until` and for the same reason.
    ///
    /// A timestamp rather than a countdown: a countdown has to be decremented by
    /// exactly the right `dt` in exactly one place, and a deadline is correct
    /// however the caller ticks. It is compared against the same `now` every
    /// other timer here uses.
    pub poisoned_until: f32,
    /// Seconds of unsealed exposure to space's radiation not yet logged as
    /// damage (T22.09A, `M22-RULINGS` R25, R74).
    ///
    /// **A field, against this struct's "derive, do not store" comments above,
    /// because `R25` names it** — *"Reverse it by: the accumulator"* — and `R74`
    /// rules it outranks them. It is not a second answer to anything: nothing
    /// else knows how far into the current second of exposure a player is.
    /// Radiation logs once per `RADIATION_LOG_INTERVAL`, never per tick, and
    /// this is what counts to it. Hashed (`World::state_hash`); cleared by
    /// `respawn`. **Kept across a seal**, so a suit flickering on and off at the
    /// edge of an empty battery cannot dodge the tick by resetting it.
    pub radiation_exposure: f32,
    /// Until when a solar flare is still burning them (T22.08A, `R79`).
    ///
    /// `poisoned_until`'s shape and rule — a deadline, rewritten by a touch, never
    /// added to — and **not** `poisoned_until` itself, which would light the
    /// snapshot's poison bit (6) and put a toxic-rain status on the HUD for a
    /// flare. Hashed; cleared by `die` and `respawn`.
    pub burning_until: f32,
    /// Seconds of burn not yet logged as damage — radiation's accumulator, for
    /// the flare (`R81` = `R25`'s cadence: one `Damage` a second, never one a
    /// tick). A second field beside `burning_until` because the deadline alone
    /// cannot say how far into the current second the burn is: a body standing in
    /// the ribbon rewrites its deadline every tick. Hashed; cleared with it.
    pub burn_exposure: f32,
    /// Until when this player counts as **thrown** rather than walking (§C20).
    ///
    /// Stamped wherever an impulse is applied to them — `explode` and
    /// `melee::swing` report who they threw, and `World` writes the stamp. The
    /// fire gate reads it so knockback does not become a stun. Server-side only:
    /// it is not on the wire and the client does not predict firing.
    pub knocked_until: f32,
    /// Signed, and it may go negative: a player who only dies ends below zero.
    pub score: i16,
    pub deaths: u16,
    pub last_damaged_by: Option<(PlayerId, f32)>,
    pub skin_id: u16,
    /// The grave they leave (§B8). Like `skin_id`, the server never knows what
    /// it looks like (`docs/50` §1) — it is one `u16` carried for the client.
    pub tombstone_skin_id: u16,
    /// T20.12's accessories. Cosmetic `u16`s exactly like the two above: the
    /// server carries them and never interprets them, and they are **not** in the
    /// snapshot or the replay — appearance arrives once, on join.
    pub hat_id: u16,
    pub glasses_id: u16,
    pub fire_ready_at: f32,
    /// Pad arming, charge and cooldown for **this life** (§C5).
    ///
    /// Reset by `respawn`, which is the whole point: the arming rule is "you have
    /// moved since you spawned", and it has to mean *this* spawn.
    pub teleport: crate::world::teleport::TeleportState,
    /// T21.11B's gun platform. Per player and per life, like `teleport` beside
    /// it and for the same reason: a global record of who is on what would arm
    /// every platform for everyone the moment one player stood still.
    pub mount: crate::world::mount::MountState,
}

impl PlayerState {
    pub fn new(id: PlayerId, pos: Vec2, skin_id: u16) -> Self {
        let mut p = PlayerState {
            id,
            body: Body::new(pos),
            jump: JumpState::default(),
            jetpack: JetpackState::default(),
            aim: 0,
            health: BASE_HEALTH,
            battery: 0.0,
            heals: 0,
            batteries: 0,
            inventory: Inventory::new(),
            alive: true,
            respawn_at: 0.0,
            iframes_until: 0.0,
            poisoned_until: 0.0,
            radiation_exposure: 0.0,
            burning_until: 0.0,
            burn_exposure: 0.0,
            knocked_until: 0.0,
            tombstone_skin_id: 0,
            hat_id: 0,
            glasses_id: 0,
            score: 0,
            deaths: 0,
            last_damaged_by: None,
            skin_id,
            fire_ready_at: 0.0,
            teleport: crate::world::teleport::TeleportState::new(pos, 0.0),
            mount: crate::world::mount::MountState::new(),
        };
        // §F5 — join is the other route into the world. `respawn` grants the same
        // kit; both must, or a player who never dies never gets one.
        p.grant_starting_kit();
        p
    }

    /// Is damage against this player being reduced right now? (T20.08)
    ///
    /// **Derived, not stored.** It used to be `shield_until > now`; it is now
    /// *"holds a generator, and has charge to spend"*. Both inputs are already
    /// player state, and deriving is what keeps them from disagreeing — the rule
    /// this repo has paid for as *"derive, do not add a fourth flag"*.
    ///
    /// **The threshold is `battery > 0`, not `>= SHIELD_HIT_COST`, and that is
    /// deliberate.** `apply_damage` charges `min(battery, cost)` and scales the
    /// reduction by the fraction it could pay, so *any* charge buys *some*
    /// absorption. Bit 3 on the wire is this boolean, so it is exactly true
    /// whenever an absorption happens — including against a laser, whose cost is
    /// eight times a normal hit. That equality is the whole point: the earlier
    /// design would have had bit 3 say "shielded" at 4 energy and then found the
    /// battery could not pay `LASER_BATTERY_DRAIN`, and the wire would have lied.
    ///
    /// `now` is unused and kept: bit 3's encoder passes it, every caller has it,
    /// and a signature that loses it would have to grow it back the first time
    /// the rule wants a clock again.
    ///
    /// # `suit`: the second source (T22.09A, `M22-RULINGS` R2, R26)
    ///
    /// **One predicate, two ways to satisfy it**: a generator in the bag, *or*
    /// the spacesuit — and either way only while the battery has charge. `suit`
    /// comes from the caller because `PlayerState` has no route to the mode, and
    /// every production caller derives it from `GravityMode::wears_suit`.
    ///
    /// **The suit therefore also multiplies weapon damage by
    /// `SHIELD_DAMAGE_MULT`, and that is a feature, not a side effect** (R2): a
    /// spacesuit that softens a hit is the right reading of a spacesuit, and it
    /// gives the battery a second reason to matter. Do not file it as a bug.
    ///
    /// **Bit 3 on the wire passes `suit = false`** (R26): the bubble means "is
    /// carrying a generator", and under the suit every player in space would
    /// wear one all round. The suit's seal shows as bit 7 instead.
    ///
    /// **Reverse it by** (R2): split this into `shield_absorbs()` and
    /// `shield_seals()` and give the suit only the second.
    pub fn shield_active(&self, now: f32, suit: bool) -> bool {
        let _ = now;
        self.battery > 0.0 && (suit || self.holds_shield_generator())
    }

    /// Took a killing blow and `World::resolve_deaths` has not run yet.
    ///
    /// **`alive` stays true until then**, so "alive" and "can still be hurt
    /// into a new cause of death" are different questions inside a tick. The
    /// one predicate for the second: `resolve_deaths` picks its dead with it,
    /// and stage 8c skips them with it — a body poisoned or struck dead
    /// earlier in the tick must not also be irradiated, or R75's list names
    /// radiation for a death it did not cause (review of T22.09A, F1).
    pub fn is_dying(&self) -> bool {
        self.alive && self.health <= 0.0
    }

    /// Is space's radiation getting through to this player right now?
    /// (T22.09A, `M22-RULINGS` R6.) Snapshot bit 7, and `GameCore::irradiated`.
    ///
    /// **One function for both ends**, so the networked client and the sandbox
    /// cannot disagree about when to show it. `suit` is the mode's
    /// `wears_suit()`; outside space there is no radiation and this is false
    /// whatever the battery says.
    pub fn irradiated(&self, now: f32, suit: bool) -> bool {
        suit && self.alive && !self.shield_active(now, true)
    }

    /// One tick of space's radiation (T22.09A, `M22-RULINGS` R24, R25). Returns
    /// the damage to **log** this tick — `Some` once per whole
    /// `RADIATION_LOG_INTERVAL` of unsealed exposure, `None` otherwise.
    ///
    /// Only `World::step`'s stage 8c calls it, and only in a suit mode, alive,
    /// in `Playing` — so the seal is asked with `suit = true`.
    ///
    /// **Sealed, the battery pays `RADIATION_SHIELD_COST` a second**; unsealed,
    /// exposure accumulates and nothing is spent. The damage is *returned*, not
    /// applied: it has to go through `World::apply_damage_log`, where the warmup
    /// gate, the `Damage` event and the death attribution live (R25).
    ///
    /// **Half a tick early, and that is not a tolerance on the rate.** Sixty
    /// `f32` sums of `SIM_DT` land either side of 1.0, and a strict `>=` would
    /// log some seconds on tick 61. Comparing at the tick *nearest* the whole
    /// interval and then subtracting exactly one interval keeps the long-run
    /// rate at `RADIATION_DPS` with no drift.
    pub fn radiation_tick(&mut self, now: f32, dt: f32) -> Option<f32> {
        if self.shield_active(now, true) {
            self.battery = (self.battery - RADIATION_SHIELD_COST * dt).max(0.0);
            return None;
        }
        self.radiation_exposure += dt;
        if self.radiation_exposure + 0.5 * dt >= RADIATION_LOG_INTERVAL {
            self.radiation_exposure -= RADIATION_LOG_INTERVAL;
            return Some(RADIATION_DPS * RADIATION_LOG_INTERVAL);
        }
        None
    }

    /// Is a shield generator anywhere in the bag? (T20.08)
    ///
    /// *"Not the active one"* is the brief, so this scans every slot rather than
    /// asking about the selection. By `ItemKind`, never by naming
    /// `SHIELD_GENERATOR`: identical today and divergent the day a second
    /// generator exists — the same rule `drop_item` follows for `STARTING_KIT`.
    pub fn holds_shield_generator(&self) -> bool {
        self.inventory
            .iter()
            .any(|(_, s)| matches!(def(s.item).map(|d| d.kind), Some(ItemKind::Shield)))
    }

    /// Is a particular passive utility anywhere in the bag? (T21.01)
    ///
    /// The generalisation of `holds_shield_generator`, and it follows the same
    /// two rules. It scans **every slot**, because the passives are held rather
    /// than selected — *"not the active one"* is the brief for all of them. And
    /// it asks the `ItemKind`, never an id: `ItemKind::Utility(_)` **is** the
    /// passive family (`use_item` refuses the whole variant), so a second pair
    /// of fangs or a second torch is covered by construction. A hand-kept list
    /// of effect-item ids goes stale on the sixth one, and T21.09 sorts the
    /// backpack by kind for exactly that reason.
    pub fn holds_utility(&self, which: UtilityId) -> bool {
        self.inventory.iter().any(|(_, s)| {
            matches!(def(s.item).map(|d| d.kind), Some(ItemKind::Utility(u)) if u == which)
        })
    }

    /// Vampire fangs (T21.01): turn damage **this player just dealt** into life.
    ///
    /// `damage` is what actually **landed** on the victim, not what the weapon
    /// rolled — the two differ by exactly the victim's generator, and that is
    /// the case the brief singles out. Feeding on the rolled number would pay
    /// the attacker for the quarter the generator ate.
    ///
    /// **Nothing is stored and nothing is rounded.** The return is
    /// `damage / LIFESTEAL_DAMAGE_PER_HP`, so two 5-damage hits return the same
    /// 1.0 that one 10-damage hit does and no fractional carry has to live
    /// anywhere. Health is already fractional everywhere else here — poison,
    /// overheal decay and fall damage all write fractions.
    ///
    /// `victim_shielded` is *"the opponent **has** a shield generator"*, which
    /// is `holds_shield_generator` and deliberately **not** `shield_active`:
    /// the brief asks about the item, and `shield_active` would additionally
    /// require charge, so draining someone's battery would silently switch your
    /// own reward back to health mid-fight.
    ///
    /// The guard lives here rather than at the call site so that the second
    /// caller cannot drop it (`CLAUDE.md`: share the guard, or share the
    /// function).
    pub fn steal_life(&mut self, damage: f32, victim_shielded: bool) {
        // A corpse drains nothing. `apply_damage_log` runs before
        // `resolve_deaths`, so an attacker killed earlier in this same tick is
        // still `alive` here — but one killed on an earlier tick is not, and
        // this is the guard that separates them.
        if damage <= 0.0 || !self.alive || !self.holds_utility(UtilityId::VampireFangs) {
            return;
        }
        let gain = damage / LIFESTEAL_DAMAGE_PER_HP;
        if victim_shielded {
            // Clamped at `BATTERY_MAX` by `add_battery`, like a battery pack.
            self.add_battery(gain);
        } else {
            // **`BASE_HEALTH`, not `HEALTH_CAP`.** `heal` overheals to 150 and
            // decays back; fangs restore rather than buffer, so a full-health
            // attacker banks nothing. `max` rather than a bare `min` so that an
            // already-overhealed attacker is not *pulled down* to 100 by a hit
            // they landed.
            self.health = self.health.max((self.health + gain).min(BASE_HEALTH));
        }
    }

    /// Take a heal into the counter. **False when already at `MAX_HEALS`** — the
    /// caller must leave the item on the ground, the same rule a full inventory
    /// gets (`docs/30` §2). A bare `()` here would silently destroy pickups.
    pub fn take_heal(&mut self) -> bool {
        if self.heals >= crate::constants::MAX_HEALS {
            return false;
        }
        self.heals += 1;
        true
    }

    /// Take a battery pack into the counter. False at `MAX_BATTERIES`.
    pub fn take_battery_pack(&mut self) -> bool {
        if self.batteries >= crate::constants::MAX_BATTERIES {
            return false;
        }
        self.batteries += 1;
        true
    }

    /// `Q`: spend a heal for `MEDKIT_HEAL`, clamped to `HEALTH_CAP` by `heal`.
    ///
    /// Rejected with no effect at zero — and *rejected*, not silently ignored, so
    /// the server can say why (`docs/61` §3's rule for every refused action).
    pub fn use_heal(&mut self) -> Result<(), UseError> {
        if !self.alive {
            return Err(UseError::Dead);
        }
        if self.heals == 0 {
            return Err(UseError::EmptySlot);
        }
        self.heals -= 1;
        self.heal(crate::constants::MEDKIT_HEAL);
        Ok(())
    }

    /// `R`: spend a battery pack for `BATTERY_PACK_AMOUNT`.
    pub fn use_battery_pack(&mut self) -> Result<(), UseError> {
        if !self.alive {
            return Err(UseError::Dead);
        }
        if self.batteries == 0 {
            return Err(UseError::EmptySlot);
        }
        self.batteries -= 1;
        self.add_battery(crate::constants::BATTERY_PACK_AMOUNT);
        Ok(())
    }

    /// The slot §C11's `E` throws from, or `None` when you have nothing to throw.
    ///
    /// **A fixed order, documented and shared** — grenade, molotov, toxic, smoke,
    /// airburst — so the same key does the same thing every time. A "best" pick
    /// or a random one would make the key unusable, which is the whole reason the
    /// amendment names an order at all.
    ///
    /// The order is the list's order, not the inventory's: a grenade in slot 8
    /// beats a molotov in slot 1.
    pub fn quick_throw_slot(&self) -> Option<u8> {
        use crate::items::registry::{AIRBURST, GRENADE, MOLOTOV, SMOKE, TOXIC_GRENADE};
        const ORDER: [crate::items::registry::ItemId; 5] =
            [GRENADE, MOLOTOV, TOXIC_GRENADE, SMOKE, AIRBURST];
        for want in ORDER {
            for (slot, stack) in self.inventory.iter() {
                if stack.item == want && stack.count > 0 {
                    return Some(slot);
                }
            }
        }
        None
    }

    /// Add battery, clamped. A pack at 80 gives `BATTERY_MAX`, not 130.
    pub fn add_battery(&mut self, amount: f32) {
        self.battery = (self.battery + amount).clamp(0.0, BATTERY_MAX);
    }

    /// Spend battery if there is enough. Returns false and spends nothing
    /// otherwise — a partial charge must not fire a partial shot.
    pub fn spend_battery(&mut self, amount: f32) -> bool {
        if self.battery + f32::EPSILON < amount {
            return false;
        }
        self.battery = (self.battery - amount).max(0.0);
        true
    }

    pub fn heal(&mut self, amount: f32) {
        self.health = (self.health + amount).min(HEALTH_CAP);
    }

    /// At full health you move at `WALK_SPEED`; at 0 health, `HEALTH_SPEED_MIN`
    /// of it. Overheal does **not** make you faster — the ratio is clamped at 1.
    ///
    /// **Whole health, because whole health is what both sides have** (T20.21).
    /// `codec.rs` sends `p.health.clamp(0.0, HEALTH_CAP) as u8` and `codec.ts`
    /// reads it back with `r.u8()`, and `as u8` **truncates**. Server health is
    /// routinely fractional — fall damage is `(impact - FALL_SAFE_SPEED) *
    /// FALL_DAMAGE_PER_SPEED`, poison and overheal decay are per-second rates —
    /// so the mirror sat up to 1.0 health below the server, permanently and
    /// always in the same direction. At `(1 - HEALTH_SPEED_MIN) / BASE_HEALTH`
    /// per point that is 0.375 px/s, which crosses `RECONCILE_EPSILON_PX` every
    /// 5.33 s and never converges: T20.19's 50x improvement had a floor under it.
    ///
    /// **Flooring here makes the two sides equal by construction rather than by
    /// precision**, which is the property the rule wants. The alternative —
    /// widening the field — spends bandwidth per player per snapshot at
    /// `SNAPSHOT_HZ` to buy sub-integer resolution in a number nothing renders,
    /// which is the same trade `codec.rs` already refuses for `poisoned`. The
    /// cost is that a player at 99.9 health walks at the 99 speed: 0.375 px/s,
    /// the very difference this removes from the wire.
    ///
    /// Only movement reads this, so nothing else sees the rounding — damage, the
    /// HUD and death all still use the true fractional health.
    pub fn speed_multiplier(&self) -> f32 {
        let health = lerp(
            HEALTH_SPEED_MIN,
            1.0,
            (self.health.floor() / BASE_HEALTH).clamp(0.0, 1.0),
        );
        // T21.02 — ironman boots, **multiplied in here rather than added as a
        // ninth argument to `apply_input`**. The seam already exists: this value
        // is what `apply_horizontal` scales the *target speed* by, and
        // `movement.rs` states that design in its own comment. Opening a second
        // one would give two answers to "how fast is this player", and the wasm
        // mirror already calls this exact function.
        //
        // Multiplicative with the health term rather than replacing it: a hurt
        // player in boots is faster than a hurt player without them and slower
        // than a healthy one in them, which is the only reading under which both
        // rules still mean something.
        let booted = if self.holds_utility(UtilityId::IronmanBoots) {
            health * BOOTS_SPEED_MULT
        } else {
            health
        };
        // T21.03's wings, slowed on 2026-09-16 — *"an additional 10%"*, so it
        // multiplies the two terms above rather than replacing either. It lands
        // here and not in `movement.rs` for the reason the boots clause gives:
        // this function is the one answer to "how fast is this player", the wasm
        // mirror calls it, and `prediction.ts` predicts through the same
        // `MoveMods.speed` this feeds. A slow the client did not know about
        // ships as rubber-banding, not as a slower player.
        if self.holds_utility(UtilityId::UnicornWings) {
            booted * WINGS_SPEED_MULT
        } else {
            booted
        }
    }

    /// This player's **launch-velocity** multiplier (T21.02).
    ///
    /// `boots_jump_velocity_mult()` and not `BOOTS_JUMP_HEIGHT_MULT`: the
    /// constant is a height and height goes as `v²/2g`, so the velocity is its
    /// square root. Written once, there, so this cannot be the place the two
    /// drift apart.
    pub fn jump_multiplier(&self) -> f32 {
        if self.holds_utility(UtilityId::IronmanBoots) {
            boots_jump_velocity_mult()
        } else {
            1.0
        }
    }

    /// Everything `apply_input` needs about this player beyond their body.
    ///
    /// **The single derivation, and both sides call it** — `World::apply_inputs`
    /// on the server and `GameCore::apply_input` in the wasm mirror. That is
    /// what makes T20.19/T20.21's rule structural: there is no literal for
    /// either side to pass instead.
    pub fn move_mods(&self) -> MoveMods {
        MoveMods {
            speed: self.speed_multiplier(),
            jump: self.jump_multiplier(),
            // T21.03. **Carrying them is flying** — there is no toggle, and
            // `use_item` refuses the whole `Utility` variant, so dropping them
            // is the only off switch (T20.09's `World::drop_item`).
            //
            // **Boots and wings together, settled rather than discovered.**
            // Wings refuse the jump outright, so `jump` above is simply unused
            // while this is true — the boots' launch multiplier is not
            // overridden, it never gets asked. `speed` still applies, so a
            // player wearing both flies sideways at twice the rate. That is the
            // only reading under which neither item silently stops working.
            // **`and not mounted`, so the two regimes cannot both be true.**
            // `jetpack::gravity_scale` names one gravity regime at a time, and a
            // player who mounted while wearing wings would otherwise be flying
            // and bolted down at once — which reads on screen as a platform that
            // launches you. Mounting wins: you chose it this second, and
            // dropping the wings is still the only way to stop flying otherwise.
            flying: self.mount.mounted.is_none() && self.holds_utility(UtilityId::UnicornWings),
            mounted: self.mount.mounted.is_some(),
        }
    }

    /// The passive-movement bits for the snapshot (T21.02).
    ///
    /// **A byte of its own rather than the flags byte's last bit.** `docs/40` §3
    /// leaves exactly one flag spare (bit 7) and M21 needs at least two — boots
    /// and T21.03's wings — with T21.08's spacesuit behind them. Spending the
    /// last reserved bit on the first of them would have made the second a wire
    /// break instead of a field addition. **`docs/40` §3 does not describe this
    /// byte; the amendment is owed.**
    ///
    /// **Why it is on the wire at all**, when T20.07 concluded the flashlight
    /// needed no more than a derived flag: because `apply_input` reads this and
    /// does not read that. A flashlight changes what you can *see*, which
    /// nothing predicts, so it stays at bit 4. This byte is exactly the set
    /// T20.19's rule covers — *everything `apply_input` reads must be identical
    /// on both sides* — and nothing else belongs in it.
    ///
    /// Derived at the encode site from the inventory, so **nothing is stored,
    /// nothing is hashed, and `REPLAY_VERSION` does not move** (T20.07's
    /// conclusion, applied).
    pub fn move_mod_bits(&self) -> u8 {
        let items = MOVE_MOD_BITS.iter().fold(0u8, |acc, (bit, u)| {
            if self.holds_utility(*u) {
                acc | bit
            } else {
                acc
            }
        });
        // T21.11B rides the same byte and is *not* an item — see
        // `MOVE_MOD_MOUNTED`. It is derived here rather than stored on the wire
        // for the same reason the rest of this byte is: one source, read at the
        // encode site.
        if self.mount.is_mounted() {
            items | MOVE_MOD_MOUNTED
        } else {
            items
        }
    }

    /// Make this player's inventory agree with a `move_mod_bits` byte off the
    /// wire. **The client mirror's only route to the passives** (T21.02).
    ///
    /// It writes the **inventory**, not a field, and that is the whole point:
    /// `move_mods` derives from the inventory on both sides, so there is one
    /// rule and the mirror cannot answer differently from the server. A
    /// `passives: u8` field beside it would be a second answer to "is this
    /// player wearing boots" — the third flag that `shield_until` and
    /// `flashlight_on` were both deleted for.
    ///
    /// Never called server-side: there the inventory *is* the truth.
    pub fn set_move_mod_bits(&mut self, bits: u8) {
        // T21.11B, first: the mount lockout changes what `apply_input` does with
        // every other bit in this byte, so a mirror that applied the passives
        // and then the mount would run one tick with the wrong regime.
        self.mount.set_from_wire(bits & MOVE_MOD_MOUNTED != 0);
        for (bit, u) in MOVE_MOD_BITS {
            let want = bits & bit != 0;
            if want == self.holds_utility(*u) {
                continue;
            }
            let Some(item) = crate::items::registry::item_for_utility(*u) else {
                continue;
            };
            if want {
                let _ = self.inventory.add(item, 1);
                continue;
            }
            // Bound before the `if let`, so `iter`'s borrow has ended by the
            // time `take_slot` wants a mutable one.
            let slot = self
                .inventory
                .iter()
                .find(|(_, s)| s.item == item)
                .map(|(i, _)| i);
            if let Some(slot) = slot {
                self.inventory.take_slot(slot);
            }
        }
    }

    /// Were they thrown by something recently? See `knocked_until`.
    pub fn was_knocked(&self, now: f32) -> bool {
        now < self.knocked_until
    }

    /// The landing speed below which a fall costs **this** player nothing, px/s.
    ///
    /// `FALL_SAFE_SPEED` for everybody, scaled by `boots_fall_safe_speed()` for a
    /// player carrying ironman boots (T21.02). Exposed separately from
    /// `fall_damage` so the scale is one expression to read, to change, and to
    /// pin a test to without restating it.
    pub fn fall_safe_speed(&self) -> f32 {
        if self.holds_utility(UtilityId::IronmanBoots) {
            boots_fall_safe_speed()
        } else {
            FALL_SAFE_SPEED
        }
    }

    /// What this player's landing costs them, in health (T20.11, T21.02).
    ///
    /// **One function at the one site.** `World::apply_inputs` is the only
    /// caller today, and the second one to appear is exactly where a clause left
    /// loose at a call site gets dropped — so this answers the whole question,
    /// threshold and exemption and slope, rather than handing the caller two of
    /// the three. Share the guard, or share the function.
    ///
    /// **The knockback exemption is T20.11's, unchanged.** A rocket jump already
    /// bought its arc with a blast and charging for the landing as well was
    /// rejected; the arithmetic is in `constants.rs`, where the 0.457 s round
    /// trip sits inside a 0.6 s `KNOCKBACK_FIRE_GRACE`. It stays a **boolean**
    /// exemption because a blast is not a fall the player chose the height of.
    ///
    /// **The boots raise the threshold and exempt nothing.** `(impact -
    /// threshold)` still rises smoothly from zero, so there is no edge anywhere
    /// — which is the base game's own shape, and a faithful restoration of the
    /// property the boots broke rather than a new power bolted beside it.
    ///
    /// **Three rulings were taken on this and two were reversed; all three, with
    /// the measurements that decided them, are recorded at
    /// `constants.rs::boots_fall_safe_speed`** — deliberately in one place, so
    /// two copies cannot drift. Read it before changing anything here: the
    /// obvious alternative (exempt the landing outright) was tried and rejected
    /// for a 23.9 health cliff edge 30 px below the player's own launch (at the
    /// 0.075 rate of the time; 8.0 at T21.29's 0.025 — smaller, still an edge).
    ///
    /// The two shapes therefore differ on purpose: knockback is a *window*
    /// because it is momentary, and boots are a *threshold* because they are a
    /// standing property of the player.
    ///
    /// **Server-side only.** Health is not predicted: `apply_input` measures the
    /// impact and deliberately does nothing with it, which is what keeps it
    /// pure, and the wasm mirror has no fall-damage path at all — it reads
    /// `landing_impact` only to scale a landing sound.
    pub fn fall_damage(&self, impact: f32, now: f32) -> f32 {
        // `impact` is 0.0 on every tick that is not a landing (`integrate`), so
        // this is also the "did anything land" test and there is no second one.
        if impact <= 0.0 || self.was_knocked(now) {
            return 0.0;
        }
        ((impact - self.fall_safe_speed()) * FALL_DAMAGE_PER_SPEED).max(0.0)
    }

    pub fn invulnerable(&self, now: f32) -> bool {
        now < self.iframes_until
    }

    /// Is toxic rain still working on them (§E13)?
    pub fn poisoned(&self, now: f32) -> bool {
        now < self.poisoned_until
    }

    /// Start — or **restart** — the poison.
    ///
    /// Writing the deadline is the whole rule. Adding to it would stack, and two
    /// drops in three seconds would then kill through a full health bar; §E13
    /// asks for a status you can wait out, not a stacking bleed.
    pub fn poison(&mut self, now: f32) {
        self.poisoned_until = now + TOXIC_POISON_DURATION;
    }

    /// Is a solar flare still burning them (T22.08A)? The plain deadline — the
    /// question a HUD would ask. `burn_tick` asks it at the tick's middle.
    pub fn burning(&self, now: f32) -> bool {
        now < self.burning_until
    }

    /// Start — or **restart** — the flare's burn: `poison()`'s rule, the deadline
    /// written, never added to (R79).
    pub fn burn(&mut self, now: f32) {
        self.burning_until = now + SOLAR_FLARE_BURN_SECONDS;
    }

    /// One tick of the flare's burn (R81). Returns the damage to **log** this tick
    /// — `Some` once per whole `RADIATION_LOG_INTERVAL` of burning, `None`
    /// otherwise — for `World::step` to put through `apply_damage_log`, where the
    /// warmup gate, the suit and the death attribution live.
    ///
    /// **Burning is judged at the tick's middle**, `now + dt/2 < deadline`: a burn
    /// written at tick `k` then covers exactly `SOLAR_FLARE_BURN_SECONDS / dt`
    /// ticks however the `f32` clock rounds, where a strict `now <` can land on
    /// one tick fewer and lose the last second's log.
    ///
    /// `radiation_tick`'s arithmetic, for the same reason: compare at the tick
    /// nearest the whole interval and subtract exactly one, so a full burn logs
    /// exactly `SOLAR_FLARE_BURN_SECONDS` entries. The interval is radiation's
    /// constant because it is one rule — *one `Damage` a second* — not two.
    pub fn burn_tick(&mut self, now: f32, dt: f32) -> Option<f32> {
        if now + 0.5 * dt >= self.burning_until {
            return None;
        }
        self.burn_exposure += dt;
        if self.burn_exposure + 0.5 * dt >= RADIATION_LOG_INTERVAL {
            self.burn_exposure -= RADIATION_LOG_INTERVAL;
            return Some(SOLAR_FLARE_DPS * RADIATION_LOG_INTERVAL);
        }
        None
    }

    /// Overheal decay and shield expiry.
    ///
    /// **Poison is not here.** It deals damage, and every source of damage in the
    /// game goes through `World::apply_damage_log` — which is where the warmup
    /// gate lives (`docs/41` §3). A subtraction from `health` in this function
    /// would be the one source that skipped it, and "toxic rain hurt me during
    /// warmup" would be a bug with no single place to fix.
    ///
    /// `now` is unused since T20.08 took the shield's timer out and kept: every
    /// caller has it, it is the natural signature for a per-tick stats hook, and
    /// the next status effect with a clock would have to grow it back.
    pub fn tick_stats(&mut self, now: f32, dt: f32) {
        let _ = now;
        if self.health > BASE_HEALTH {
            // A stacked medkit is ~25 s of extra buffer, not a permanent upgrade.
            self.health = (self.health - OVERHEAL_DECAY * dt).max(BASE_HEALTH);
        }
        // **No shield block here any more** (T20.08). It expired a timer and
        // subtracted `SHIELD_DRAIN * dt` while it ran; a held generator costs
        // nothing per second and `SHIELD_HIT_COST` per hit, so the whole of the
        // shield's cost now lives in `apply_damage` — one place, charged at the
        // moment it does its work. The tension §B5 wanted is unchanged and
        // sharper: the charge keeping you alive is the charge your laser wants.
        let _ = dt;
    }

    /// Returns true when the damage was actually applied.
    ///
    /// `suit` is the mode's `GravityMode::wears_suit()` — see `shield_active`.
    pub fn apply_damage(&mut self, amount: f32, src: DamageSource, now: f32, suit: bool) -> bool {
        if !self.alive || self.invulnerable(now) {
            return false;
        }
        // Energy weapons pierce (§B5). The rule lives here, next to the shield
        // rule it modifies, and reads the weapon out of the `DamageSource` the
        // caller already supplies — so there is still exactly one damage path and
        // no caller has to remember to pass a "this was a laser" flag.
        let energy = match src {
            DamageSource::Player { weapon, .. } | DamageSource::SelfInflicted { weapon } => {
                defs::def(weapon).is_some_and(|w| w.is_energy())
            }
            // Neither has a weapon, so neither can pierce a shield. A fall is
            // stopped by a generator exactly as a rocket is, which is the
            // answer that needs no new rule.
            DamageSource::Weather(_) | DamageSource::Fall | DamageSource::Radiation => false,
        };
        // §B5 and T20.08: a held generator spends energy **per hit** and reduces
        // what gets through. This is the only place the shield costs anything.
        //
        // **Partial payment, proportional effect.** The two costs differ by 8x, so
        // an all-or-nothing charge would make `shield_active` — and bit 3, and the
        // bubble — true at 4 energy and then do nothing against a laser. Paying
        // what the battery has and lerping the multiplier toward 1.0 by the
        // fraction paid keeps the boolean and the charge in agreement at both
        // costs, and degrades a dying generator smoothly instead of cutting it off
        // at a threshold nobody can see.
        let mult = if self.shield_active(now, suit) {
            let full = if energy {
                LASER_SHIELD_MULT
            } else {
                SHIELD_DAMAGE_MULT
            };
            // What the generator would stop if it paid in full.
            let absorbed = amount * (1.0 - full);
            let cost = if energy {
                // **Flat, and not capped by the damage.** The energy drain is the
                // *weapon's* effect on the battery, not the generator's fee —
                // `docs/21`/§B5 make it the payoff for firing a laser at someone
                // charged, and a laser that drained less against a glancing hit
                // would make that payoff a function of the damage roll.
                LASER_BATTERY_DRAIN
            } else {
                // **The generator never spends more charge than the damage it
                // stopped** (T20.08). The brief says one energy per hit, and a
                // flat charge per call is not the same thing: poison is applied as
                // `TOXIC_POISON_DPS * dt` **every tick** (`world/mod.rs`), so 3 s
                // of it is 180 calls absorbing 0.025 damage each. A flat cost
                // charged 180 energy for 4.5 damage stopped, flattened a full
                // battery on one drop, and — measured — left the reduction at 14 %
                // instead of 25 % because the shield died halfway. Capping by the
                // absorption leaves a real hit at exactly `SHIELD_HIT_COST` (a
                // 20-damage hit stops 5) and makes a trickle cost a trickle.
                SHIELD_HIT_COST.min(absorbed)
            };
            // **Partial payment, proportional effect.** The two costs differ by
            // 8x, so an all-or-nothing charge would leave `shield_active` — and
            // bit 3, and the bubble — true at 4 energy while a laser landed in
            // full. Paying what there is and scaling toward 1.0 by the fraction
            // funded keeps the boolean and the charge in agreement at both costs,
            // and lets a dying generator fade instead of cutting out at a
            // threshold nobody can see.
            let paid = self.battery.min(cost);
            self.battery -= paid;
            let funded = if cost > 0.0 { paid / cost } else { 0.0 };
            1.0 + (full - 1.0) * funded
        } else {
            1.0
        };
        self.health -= amount * mult;

        // Remember who did it, **including yourself**.
        //
        // Recording only `Player` left `last_damaged_by` empty after a rocket at
        // your own feet, so `resolve_deaths` saw no recent attacker and fell
        // through to `Weather`: a self-kill reported as "killed by the map".
        // Scoring hid it — a self-kill and a weather death are both −1 with no
        // credit (`docs/21` §6) — so only the death *cause* was ever wrong, and
        // nothing read the cause until the death overlay did.
        match src {
            DamageSource::Player { id, .. } => self.last_damaged_by = Some((id, now)),
            DamageSource::SelfInflicted { .. } => self.last_damaged_by = Some((self.id, now)),
            // Radiation names nobody, like the weather: nobody caused it, and a
            // recent attacker's claim must survive it for `killer` to credit them.
            DamageSource::Weather(_) | DamageSource::Radiation => {}
            // **A fall names you only when nobody else has a claim** (T20.11).
            //
            // Neither of the two obvious arms is right on its own. Writing
            // yourself in unconditionally would overwrite the player who blasted
            // you off the ledge, and `docs/21` §4 says in as many words that
            // knocking someone into a hazard must reward the knocker — the ledge
            // is the hazard here and the ruling is deliberate that a rocket-jump
            // does **not** exempt you from it. Writing nothing would leave a solo
            // fall with an empty `last_damaged_by`, and `resolve_deaths` would
            // narrate it as `Weather`: "the map killed you" for a player who
            // walked off a cliff under their own power.
            //
            // So: defer to a live claim, and take the blame when there is none.
            // One rule, derived from the field that already exists, and it needs
            // no fifth `DeathCause` and no second timer.
            DamageSource::Fall => {
                let claimed = self
                    .last_damaged_by
                    .is_some_and(|(_, when)| now - when <= ASSIST_WINDOW);
                if !claimed {
                    self.last_damaged_by = Some((self.id, now));
                }
            }
        }
        true
    }

    /// Who gets credit if this player dies right now.
    ///
    /// An environmental kill still credits whoever shot them within
    /// `ASSIST_WINDOW`, because otherwise knocking someone into lava rewards
    /// nobody (`docs/21` §4).
    pub fn killer(&self, direct: DeathCause, now: f32) -> DeathCause {
        match direct {
            DeathCause::Player(_) | DeathCause::SelfInflicted => direct,
            // `last_damaged_by` can now name *you* (see `apply_damage`), so the
            // assist window has to distinguish "someone shot me into the lava"
            // from "I rocketed myself and then the lava finished it". The first
            // credits them; the second credits nobody.
            //
            // `Void` shares this arm on purpose. Being blasted off the edge of
            // the world is the same shape as being blasted into lava — the
            // rocket did it, and `docs/21` §4's reason applies word for word.
            // Falling in under your own power still credits nobody, because
            // `last_damaged_by` is then empty and the fallthrough returns the
            // cause unchanged.
            // `Radiation` too (T22.09A): shot to 3 health and finished by the
            // sky is the shooter's kill, by the same reason word for word.
            DeathCause::Weather
            | DeathCause::Void
            | DeathCause::Radiation
            | DeathCause::BlackHole => match self.last_damaged_by {
                Some((who, when)) if now - when <= ASSIST_WINDOW => {
                    if who == self.id {
                        DeathCause::SelfInflicted
                    } else {
                        DeathCause::Player(who)
                    }
                }
                _ => direct,
            },
        }
    }

    /// Kill the player and drop their inventory. Returns the dropped stacks.
    pub fn die(&mut self, _cause: DeathCause, now: f32) -> Vec<Stack> {
        if !self.alive {
            // A second damage call on a corpse must not double-decrement the score.
            return Vec::new();
        }
        self.alive = false;
        self.health = 0.0;
        self.respawn_at = now + RESPAWN_DELAY;
        self.score += DEATH_POINTS;
        self.deaths += 1;
        // Nothing to clear for the shield (T20.08): the generator drops with the
        // rest of the bag below, and a corpse has no battery to spend.
        // Death clears it, like the shield: a corpse is not poisoned, and a
        // status that survived into the next life would tick down against a
        // player who was never rained on.
        self.poisoned_until = 0.0;
        // The flare's burn, for the same reason (R79).
        self.burning_until = 0.0;
        self.burn_exposure = 0.0;
        // **Heals and batteries are dropped too, and deliberately.**
        //
        // §C9 asks for the decision to be made and written down. They are not
        // inventory, so nothing forced it either way; dropping them is the
        // consistent answer. Everything else you were carrying lands where you
        // fell and can be taken by whoever killed you (`docs/30` §5) — a pair of
        // consumables that survived death would be the only thing in the game
        // that a kill does not put back into play, and "kill someone before they
        // heal" is a real decision that keeping them would delete.
        //
        // They are **not** re-spawned as world items: `die` returns inventory
        // stacks and the drop loop scatters those, and a medkit on the ground is
        // already a thing the item spawner makes. Zeroing them here is the whole
        // effect.
        self.heals = 0;
        self.batteries = 0;
        // **Except the starting kit** (§F5): "no ammo, and it cannot be dropped
        // or lost". Dropped, a shovel would scatter with everything else, be
        // re-granted on respawn anyway, and the map would fill with shovels
        // nobody can use — every death minting one more. Filtered here rather
        // than skipped in `drain_all`, because the inventory has no business
        // knowing which items are issued; that list lives beside the grant.
        self.inventory
            .drain_all()
            .into_iter()
            .filter(|s| !STARTING_KIT.contains(&s.item))
            .collect()
    }

    pub fn credit_kill(&mut self) {
        self.score += KILL_POINTS;
    }

    /// §F5 — the starting kit: a shovel in the first quick-bar slot.
    ///
    /// **One function, two callers**, because a player arrives in the world by
    /// two routes — `PlayerState::new` on join and `respawn` after death — and a
    /// kit granted on only one of them is the half-wired shape this project keeps
    /// paying for. `respawn` clears the inventory, so it must re-grant rather than
    /// inherit.
    ///
    /// Slot 0 by construction: the inventory is empty at both call sites, the
    /// kit is a weapon, and `add` gives a weapon the lowest free **quick-bar**
    /// slot (T21.09).
    fn grant_starting_kit(&mut self) {
        for item in STARTING_KIT {
            self.inventory.add(item, 1);
        }
    }

    pub fn respawn(&mut self, pos: Vec2, now: f32) {
        self.body = Body::new(pos);
        // Before anything else can read it: respawn lands you **on** a pad, and
        // an arming rule measuring from the previous life's spawn would fire it
        // two seconds later (§C5).
        self.teleport = crate::world::teleport::TeleportState::new(pos, now);
        // **Cleared with the rest of the life** (T21.11B). A corpse left holding
        // a platform is a platform nobody can use for the rest of the round, and
        // the occupancy rule derives from exactly this field — so not clearing it
        // would be a soft lock with no other symptom.
        self.mount = crate::world::mount::MountState::new();
        self.health = BASE_HEALTH;
        self.jetpack = JetpackState::default();
        self.jump = JumpState::default();
        self.inventory.clear();
        // Re-granted, not inherited: `clear()` above took the last life's shovel
        // with everything else.
        self.grant_starting_kit();
        self.alive = true;
        self.iframes_until = now + SPAWN_IFRAMES;
        self.poisoned_until = 0.0;
        // Per life, like the poison: a new body has had no exposure yet.
        self.radiation_exposure = 0.0;
        self.burning_until = 0.0;
        self.burn_exposure = 0.0;
        self.last_damaged_by = None;
        // Nothing to clear for the flashlight or the shield: both are *items* now,
        // and `clear()` above took them with the rest of the inventory
        // (T20.07, T20.08).
    }

    /// Validated item use, in the documented order.
    pub fn use_item(&mut self, slot: u8, now: f32) -> Result<ItemId, UseError> {
        // `now` became unused when the shield stopped starting a timer (T20.08).
        // Kept for the same reason `tick_stats` keeps its own: this is the item
        // verb, and the next timed item wants the clock back.
        let _ = now;
        if !self.alive {
            return Err(UseError::Dead);
        }
        let stack = self.inventory.slot(slot).ok_or(
            if slot as usize >= crate::constants::INVENTORY_SLOTS {
                UseError::BadSlot
            } else {
                UseError::EmptySlot
            },
        )?;
        let d = def(stack.item).ok_or(UseError::BadSlot)?;
        match d.kind {
            ItemKind::Heal { amount } => {
                self.heal(amount);
                self.inventory.consume(slot, 1);
            }
            // **A generator is held, not used** (T20.08). Refused for the same
            // reason a `Utility` is: it protects you while it is in the bag, so
            // there is no verb, and a no-op `Ok` would consume the press and tell
            // the client something happened. `docs/21:46` describes the use this
            // removes; the discrepancy is journalled, not edited away.
            ItemKind::Shield => return Err(UseError::WrongKind),
            ItemKind::Battery { amount } => {
                self.add_battery(amount);
                self.inventory.consume(slot, 1);
            }
            // **A utility is not usable** (T20.07). The flashlight used to toggle
            // here; it is passive now — carrying one is what does the work, so
            // there is nothing for `use` to do. Refused rather than silently
            // succeeding: a no-op `Ok` would tell the client the press landed and
            // leave the player pressing `G` at a torch forever.
            ItemKind::Utility(_) => return Err(UseError::WrongKind),
            // You cannot `use` a bazooka.
            ItemKind::Weapon(_) => return Err(UseError::WrongKind),
        }
        Ok(stack.item)
    }

    /// Validated fire. Checks kind, cooldown and ammo; spawns nothing.
    pub fn try_fire(&mut self, now: f32) -> Result<WeaponId, UseError> {
        self.try_fire_slot(self.inventory.selected(), now)
    }

    /// The same thing, from a **named slot** rather than the selection.
    ///
    /// Quick-throw (§C11) fires from wherever the grenade happens to be without
    /// moving the selection, and it must take the same validation in the same
    /// order — alive, has one, cooldown — or it becomes a way round a cooldown
    /// (`fire_ready_at` is per player by design). Sharing the function rather
    /// than the guard is what makes that true by construction.
    pub fn try_fire_slot(&mut self, slot: u8, now: f32) -> Result<WeaponId, UseError> {
        if !self.alive {
            return Err(UseError::Dead);
        }
        let stack = self.inventory.slot(slot).ok_or(UseError::EmptySlot)?;
        let d = def(stack.item).ok_or(UseError::BadSlot)?;
        // You cannot `fire` a medkit.
        let ItemKind::Weapon(wid) = d.kind else {
            return Err(UseError::WrongKind);
        };
        if now < self.fire_ready_at {
            return Err(UseError::OnCooldown);
        }
        if stack.count == 0 {
            return Err(UseError::NoAmmo);
        }
        let wdef = defs::def(wid);
        // Energy weapons spend battery instead of a stack count (§B5): a laser
        // with no charge is a paperweight, and the rejection has to happen in the
        // same place and the same order as the ammo one (`docs/30` §4).
        let cost = wdef.map_or(0.0, |w| w.energy_cost);
        if cost > 0.0 && !self.spend_battery(cost) {
            return Err(UseError::NoAmmo);
        }
        let cooldown = wdef.map_or(crate::constants::FIRE_COOLDOWN_DEFAULT, |w| w.cooldown);
        self.fire_ready_at = now + cooldown;
        // Not every weapon spends a stack: an energy weapon's stack *is* the
        // weapon (charge is its ammo, §B5) and melee has no ammo at all (§B7).
        // `spends_stack` derives that from the def, so the rule cannot disagree
        // with the delivery kind.
        if wdef.is_none_or(|w| w.spends_stack()) {
            self.inventory.consume(slot, 1);
        }
        Ok(wid)
    }
}

/// Choose a respawn point that is **still valid on the damaged map**.
///
/// The map has been getting blown up, and a point from `MapMeta` may now be
/// mid-air or inside a crater. Skipping this check is how players end up spawning
/// inside rock (`docs/21` §4), so it is not optional.
///
/// **Returns a body CENTRE, not a surface point.** Surface points are feet lines —
/// `is_standable(x, y)` means "the box whose bottom edge is at `y` fits" — so
/// handing one straight to `Body::new` buries the lower half of the player in
/// rock, and they cannot move at all. That is not hypothetical: it is exactly what
/// happened when `World` first called this, and it was invisible until a player
/// was asked to walk. The conversion lives here so no caller has to remember it.
pub fn choose_respawn(map: &Map, living: &[Vec2], rng: &mut ChaCha8Rng) -> Vec2 {
    choose_respawn_clear(map, living, rng, &|_| true)
}

/// [`choose_respawn`], refusing any site whose body centre `clear` rejects —
/// T22.12's black hole, which a respawn must never offer. The same picker with a
/// filter, not a second one (*share the function*); `choose_respawn` is this with
/// a filter that accepts everything, and draws exactly what it always drew.
pub fn choose_respawn_clear(
    map: &Map,
    living: &[Vec2],
    rng: &mut ChaCha8Rng,
    clear: &dyn Fn(Vec2) -> bool,
) -> Vec2 {
    surface_to_centre(choose_surface_point(map, living, rng, clear))
}

/// Feet line to body centre.
pub fn surface_to_centre(p: Vec2) -> Vec2 {
    Vec2::new(p.x, p.y - crate::constants::PLAYER_H / 2.0)
}

fn choose_surface_point(
    map: &Map,
    living: &[Vec2],
    rng: &mut ChaCha8Rng,
    clear: &dyn Fn(Vec2) -> bool,
) -> Vec2 {
    // **`Map::body_fits_at`, not `is_standable`** (`T22.05B`). The two are the
    // same function under gravity. In space a spawn point is open air, which
    // `is_standable` refuses by definition — so with the bare call here, every
    // listed spawn on a space map failed this filter and every respawn fell
    // through to the surface scan below. The points would have been chosen,
    // shipped and hashed, and never used.
    let usable = |p: &crate::math::Point| {
        map.body_fits_at(*p) && clear(surface_to_centre(Vec2::new(p.x as f32, p.y as f32)))
    };

    // Prefer a listed spawn point that is still ground and far from the living.
    let mut best: Option<(f32, Vec2)> = None;
    for p in map.meta.spawn_points.iter().filter(|p| usable(p)) {
        let v = Vec2::new(p.x as f32, p.y as f32);
        let nearest = living
            .iter()
            .map(|q| (v - *q).len())
            .fold(f32::INFINITY, f32::min);
        if nearest >= SPAWN_MIN_ENEMY_DIST {
            return v;
        }
        if best.is_none_or(|(d, _)| nearest > d) {
            best = Some((nearest, v));
        }
    }
    if let Some((_, v)) = best {
        return v;
    }

    // Every listed spawn has been destroyed: fall back to any still-valid site,
    // preferring one away from the living.
    //
    // `Map::random_body_site` is a surface point under gravity — the same
    // single draw this loop always made — and a point in open air inside the
    // rim in space (R14: you do not land to spawn, and there is no ground line
    // to fall back onto).
    let surface = &map.meta.surface_points;
    let mut fallback: Option<(f32, Vec2)> = None;
    for _ in 0..200 {
        let Some(p) = map.random_body_site(rng) else {
            break;
        };
        if !usable(&p) {
            continue;
        }
        let v = Vec2::new(p.x as f32, p.y as f32);
        let nearest = living
            .iter()
            .map(|q| (v - *q).len())
            .fold(f32::INFINITY, f32::min);
        if nearest >= SPAWN_MIN_ENEMY_DIST {
            return v;
        }
        if fallback.is_none_or(|(d, _)| nearest > d) {
            fallback = Some((nearest, v));
        }
    }
    if let Some((_, v)) = fallback {
        return v;
    }

    // Nothing usable at all: a scan for anywhere the body fits, so respawn can
    // never place a player inside rock.
    for p in surface.iter() {
        if usable(p) {
            return Vec2::new(p.x as f32, p.y as f32);
        }
    }
    // And the last resort, which is **map-shaped** (`T22.05B`). It was
    // `(w / 2, SKY_MARGIN)` unconditionally — the top of the sky band, which on
    // a space map is *above the rim's top arc*, i.e. outside the boundary in
    // the band R16 kills you in. The arena's centre is inside the rim by
    // construction. Neither is checked against the mask, because by this point
    // nothing on the map has passed a check; the difference is that one of them
    // is at least on the playable side of the wall.
    match map.space_geometry() {
        Some(geo) => Vec2::new(geo.cx, geo.cy),
        None => Vec2::new(map.mask.w as f32 / 2.0, crate::constants::SKY_MARGIN as f32),
    }
}

#[cfg(test)]
mod respawn_tests {
    use super::*;
    use crate::constants::{MapGenerator, MapScale};
    use crate::rng::substream;

    /// **`T22.05B`: respawn in space returns a listed spawn point, not the
    /// surface fallback.**
    ///
    /// `choose_surface_point`'s first pass filters `MapMeta.spawn_points`
    /// through `Map::body_fits_at`. Before this task that was a bare
    /// `is_standable`, which an open-space point fails by definition — so every
    /// space respawn silently skipped the whole list and took the fallback
    /// scan, landing players on asteroid tops. Nothing reported it, because the
    /// fallback returns a perfectly valid position.
    ///
    /// The assertion is therefore on **which** point comes back, not on whether
    /// it is a legal one: *assert on effects, not intentions*, and "somewhere a
    /// body fits" is what the broken version also delivered.
    ///
    /// The control is the same call on a landscape map, which has always taken
    /// the listed points — so this cannot pass for a build that returns
    /// `spawn_points[0]` unconditionally.
    #[test]
    fn a_space_respawn_uses_a_listed_spawn_point() {
        for generator in [MapGenerator::Space, crate::constants::DEFAULT_MAP_GENERATOR] {
            let map = crate::map::generate_with(4242, MapScale::Medium, generator);
            let listed: Vec<Vec2> = map
                .meta
                .spawn_points
                .iter()
                .map(|p| surface_to_centre(Vec2::new(p.x as f32, p.y as f32)))
                .collect();
            assert!(!listed.is_empty(), "{generator:?}: no spawn points");
            let mut rng = substream(4242, "respawn");
            for i in 0..12 {
                let v = choose_respawn(&map, &[], &mut rng);
                assert!(
                    listed.contains(&v),
                    "{generator:?} draw {i}: respawned at {v:?}, which is not any of the \
                     {} listed spawn points — the fallback scan ran",
                    listed.len()
                );
            }
        }
    }
}

#[cfg(test)]
mod battery_tests {
    use super::*;
    use crate::constants::{BATTERY_MAX, BATTERY_PACK_AMOUNT, SIM_DT};
    use crate::items::registry;
    use crate::items::registry::BATTERY_PACK;
    use crate::items::registry::{WEAPON_LASER_PISTOL, WEAPON_SMG};
    use crate::weapons::explode::EffectKind;

    fn player() -> PlayerState {
        PlayerState::new(1, Vec2::new(100.0, 100.0), 0)
    }

    /// A **real** energy weapon. The first version of this used an unregistered
    /// id, and `def()` returned `None`, so `is_energy()` was false and the pierce
    /// silently never fired — the test failed for the right reason and told me
    /// the rule is a no-op for any weapon not in the registry.
    const ENERGY: WeaponId = WEAPON_LASER_PISTOL;

    fn energy_source() -> DamageSource {
        DamageSource::Player {
            id: 9,
            weapon: ENERGY,
        }
    }

    fn ballistic_source() -> DamageSource {
        DamageSource::Player {
            id: 9,
            weapon: WEAPON_SMG,
        }
    }

    #[test]
    fn battery_clamps_at_both_ends() {
        let mut p = player();
        p.add_battery(80.0);
        p.add_battery(BATTERY_PACK_AMOUNT);
        assert_eq!(p.battery, BATTERY_MAX, "a pack at 80 must not give 130");
        p.battery = 3.0;
        assert!(!p.spend_battery(10.0), "spent charge it did not have");
        assert_eq!(p.battery, 3.0, "a refused spend must cost nothing");
        assert!(p.spend_battery(3.0));
        assert_eq!(p.battery, 0.0);
    }

    #[test]
    fn a_battery_pack_charges_and_is_consumed() {
        let mut p = player();
        p.inventory.add(BATTERY_PACK, 1);
        // **Not slot 0.** §F5 seats a shovel there on `PlayerState::new`, so the
        // pack lands in the first free slot after it and a hardcoded 0 used the
        // shovel — which `use_item` correctly refuses. Found, not assumed, so
        // this does not break again the next time the starting kit grows.
        let slot = (0..crate::constants::INVENTORY_SLOTS as u8)
            .find(|s| {
                p.inventory
                    .slot(*s)
                    .is_some_and(|st| st.item == BATTERY_PACK)
            })
            .expect("the pack went nowhere");
        p.inventory.select(slot);
        assert!(p.use_item(slot, 0.0).is_ok());
        assert_eq!(p.battery, BATTERY_PACK_AMOUNT);
        assert!(
            p.inventory.slot(slot).is_none(),
            "the pack was not consumed"
        );
    }

    /// Carrying one, and having charge, **is** the shield (T20.08).
    ///
    /// **Replaces `a_full_battery_lets_a_shield_run_its_whole_duration` and
    /// `a_shield_on_ten_charge_dies_at_five_seconds`**, which timed a 20 s window
    /// and a 5 s early death. There is no window: `docs/21`'s timer is reversed
    /// here on the coordinator's instruction, journalled rather than edited.
    #[test]
    fn a_shield_is_carrying_one_with_charge_and_nothing_else() {
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        // A full battery and no generator is **not** a shield. The control that
        // stops every assertion below passing for a player who is simply charged.
        assert!(
            !p.shield_active(0.0, false),
            "a battery alone shielded a player"
        );

        p.inventory.add(registry::SHIELD_GENERATOR, 1);
        assert!(
            p.shield_active(0.0, false),
            "carrying a generator did not shield"
        );

        // **Not the active slot** — the brief is explicit. Selecting something
        // else must change nothing.
        p.inventory.select(0);
        assert!(
            p.shield_active(0.0, false),
            "the generator only worked while it was selected"
        );

        // And it costs nothing per second, which is the whole of the timer's
        // removal: ten seconds of standing still spends no charge.
        for i in 0..600 {
            p.tick_stats(i as f32 * SIM_DT, SIM_DT);
        }
        assert_eq!(p.battery, BATTERY_MAX, "a held generator drained over time");
        assert!(p.shield_active(10.0, false));
    }

    /// T22.09A, `M22-RULINGS` R2/R26: **the suit is the second source of the
    /// one shield** — charged and in space, a player with no generator is
    /// shielded, absorbs a weapon hit exactly as a generator does (R2 calls
    /// that a feature), and is not irradiated. Flat, it is none of those.
    #[test]
    fn the_suit_is_a_shield_while_charged_and_nothing_when_flat() {
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        assert!(!p.holds_shield_generator(), "fixture: no generator");
        // The control: the same charge outside space shields nothing.
        assert!(
            !p.shield_active(0.0, false),
            "a charged bag shielded outside space"
        );
        assert!(!p.irradiated(0.0, false), "irradiated outside space");
        assert!(p.shield_active(0.0, true), "a charged suit did not shield");
        assert!(!p.irradiated(0.0, true), "a charged suit let radiation in");

        p.apply_damage(20.0, ballistic_source(), 1.0, true);
        assert!(
            (p.health - (BASE_HEALTH - 20.0 * SHIELD_DAMAGE_MULT)).abs() < 0.01,
            "the suit did not absorb like a generator: health {}",
            p.health
        );

        let mut q = player();
        assert!(!q.shield_active(0.0, true), "a flat suit shielded");
        assert!(
            q.irradiated(0.0, true),
            "a flat suit in space is not irradiated"
        );
        q.alive = false;
        assert!(!q.irradiated(0.0, true), "a corpse is irradiated");
    }

    /// The brief, in one test: **25 % off each hit, one energy each time.**
    #[test]
    fn a_held_generator_takes_a_quarter_off_each_hit_for_one_energy() {
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        p.inventory.add(registry::SHIELD_GENERATOR, 1);

        let hits = 5;
        for _ in 0..hits {
            p.apply_damage(20.0, ballistic_source(), 1.0, false);
        }
        // Both ends, against each other: energy spent versus hits absorbed.
        assert!(
            (p.battery - (BATTERY_MAX - SHIELD_HIT_COST * hits as f32)).abs() < 0.01,
            "{hits} absorbed hits cost {} energy, not {}",
            BATTERY_MAX - p.battery,
            SHIELD_HIT_COST * hits as f32
        );
        assert!(
            (p.health - (BASE_HEALTH - 20.0 * SHIELD_DAMAGE_MULT * hits as f32)).abs() < 0.01,
            "health {}",
            p.health
        );

        // **The control**: the same hits, no generator, full damage and no charge
        // spent. Without it the reduction above is satisfied by any multiplier.
        let mut q = player();
        q.add_battery(BATTERY_MAX);
        for _ in 0..hits {
            q.apply_damage(20.0, ballistic_source(), 1.0, false);
        }
        assert!(
            (q.health - (BASE_HEALTH - 20.0 * hits as f32)).abs() < 0.01,
            "an unshielded player did not take the whole hit: {}",
            q.health
        );
        assert_eq!(
            q.battery, BATTERY_MAX,
            "a player with no generator paid for one"
        );
        assert!(q.health < p.health, "the generator did not help at all");
    }

    /// **A trickle costs a trickle** (T20.08), and this is the test that pins it.
    ///
    /// Poison is `TOXIC_POISON_DPS * dt` applied **every tick**, so a flat
    /// `SHIELD_HIT_COST` per call charged 180 energy for the 4.5 damage a 3 s
    /// poisoning stops. Measured before the cap: the shielded player lost 15.5
    /// where the unprotected one lost 18.0 — a 14 % reduction against the 25 % the
    /// constant promises, because the generator died halfway through.
    #[test]
    fn a_generator_never_spends_more_charge_than_the_damage_it_stopped() {
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        p.inventory.add(registry::SHIELD_GENERATOR, 1);

        // One poison tick's worth of damage, 180 times over.
        let tick = crate::constants::TOXIC_POISON_DPS * SIM_DT;
        let ticks = (crate::constants::TOXIC_POISON_DURATION / SIM_DT) as usize;
        for _ in 0..ticks {
            p.apply_damage(tick, ballistic_source(), 1.0, false);
        }
        let stopped = tick * ticks as f32 * (1.0 - SHIELD_DAMAGE_MULT);
        let spent = BATTERY_MAX - p.battery;
        assert!(
            (spent - stopped).abs() < 0.01,
            "a whole poisoning cost {spent} energy to stop {stopped} damage"
        );
        // And the reduction held for all of it, which is the thing the flat cost
        // broke: the generator must not run dry on a trickle.
        assert!(
            p.shield_active(1.0, false),
            "a trickle exhausted a full battery"
        );
        assert!(
            (p.health - (BASE_HEALTH - tick * ticks as f32 * SHIELD_DAMAGE_MULT)).abs() < 0.01,
            "health {}",
            p.health
        );

        // **The control: a real hit still costs exactly one energy.** Without it
        // the cap above is satisfied by a generator that is free.
        let mut q = player();
        q.add_battery(BATTERY_MAX);
        q.inventory.add(registry::SHIELD_GENERATOR, 1);
        q.apply_damage(20.0, ballistic_source(), 1.0, false);
        assert!(
            (BATTERY_MAX - q.battery - SHIELD_HIT_COST).abs() < 0.01,
            "a 20-damage hit cost {} energy, not {SHIELD_HIT_COST}",
            BATTERY_MAX - q.battery
        );
    }

    /// At zero charge the generator is inert, and a battery pack revives it.
    #[test]
    fn the_reduction_stops_at_zero_charge_and_resumes_after_a_pack() {
        let mut p = player();
        p.inventory.add(registry::SHIELD_GENERATOR, 1);
        p.add_battery(SHIELD_HIT_COST);
        assert!(p.shield_active(0.0, false));

        p.apply_damage(20.0, ballistic_source(), 1.0, false);
        assert_eq!(p.battery, 0.0);
        assert!(
            !p.shield_active(0.0, false),
            "a flat battery still read as shielded"
        );

        let before = p.health;
        p.apply_damage(20.0, ballistic_source(), 1.0, false);
        assert!(
            (p.health - (before - 20.0)).abs() < 0.01,
            "damage at zero charge was still reduced"
        );

        // The control on the control: it comes back. Without this, "the shield
        // stops" would also pass for a generator that never worked again.
        p.add_battery(BATTERY_PACK_AMOUNT);
        assert!(p.shield_active(0.0, false));
        let before = p.health;
        p.apply_damage(20.0, ballistic_source(), 1.0, false);
        assert!((p.health - (before - 20.0 * SHIELD_DAMAGE_MULT)).abs() < 0.01);
    }

    #[test]
    fn energy_pierces_a_shield_and_ballistic_does_not() {
        // Energy: 0.85x through the shield, and it drains the victim harder.
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        p.inventory.add(registry::SHIELD_GENERATOR, 1);
        p.apply_damage(20.0, energy_source(), 5.0, false);
        assert!(
            (p.health - (BASE_HEALTH - 20.0 * LASER_SHIELD_MULT)).abs() < 0.01,
            "energy did not pierce: health {}",
            p.health
        );
        assert!(
            (p.battery - (BATTERY_MAX - LASER_BATTERY_DRAIN)).abs() < 0.01,
            "energy did not drain the victim: battery {}",
            p.battery
        );

        // Ballistic: `SHIELD_DAMAGE_MULT`, and one energy rather than eight. The
        // control that makes the above mean something — without it, "energy is
        // special" would also pass for a build where every hit pierces.
        let mut q = player();
        q.add_battery(BATTERY_MAX);
        q.inventory.add(registry::SHIELD_GENERATOR, 1);
        q.apply_damage(20.0, ballistic_source(), 5.0, false);
        assert!(
            (q.health - (BASE_HEALTH - 20.0 * SHIELD_DAMAGE_MULT)).abs() < 0.01,
            "ballistic damage was not reduced: health {}",
            q.health
        );
        assert!(
            (q.battery - (BATTERY_MAX - SHIELD_HIT_COST)).abs() < 0.01,
            "a bullet cost {} energy, not {SHIELD_HIT_COST}",
            BATTERY_MAX - q.battery
        );
    }

    /// **The bit-3 problem, settled.** `shield_active` is `battery > 0`, and a
    /// laser costs eight. An all-or-nothing charge would leave the wire saying
    /// "shielded" at 4 energy while the hit landed in full; paying what there is
    /// and scaling the reduction by the fraction paid keeps the two in agreement.
    #[test]
    fn a_laser_against_a_nearly_flat_battery_is_paid_for_in_part() {
        let mut p = player();
        p.inventory.add(registry::SHIELD_GENERATOR, 1);
        p.add_battery(LASER_BATTERY_DRAIN / 2.0);
        assert!(
            p.shield_active(1.0, false),
            "bit 3 must be true if anything is absorbed"
        );

        p.apply_damage(20.0, energy_source(), 1.0, false);
        // Half the cost paid, so half the reduction: the multiplier sits midway
        // between `LASER_SHIELD_MULT` and taking it whole.
        let want = 1.0 + (LASER_SHIELD_MULT - 1.0) * 0.5;
        assert!(
            (p.health - (BASE_HEALTH - 20.0 * want)).abs() < 0.01,
            "health {} against a half-funded absorption",
            p.health
        );
        assert_eq!(p.battery, 0.0, "the partial payment left charge behind");
        assert!(
            !p.shield_active(1.0, false),
            "bit 3 must be false once there is nothing left to spend"
        );
    }

    /// The payoff: drain someone's charge and their shield goes with it.
    #[test]
    fn draining_a_victims_battery_to_zero_ends_their_shield() {
        let mut p = player();
        p.inventory.add(registry::SHIELD_GENERATOR, 1);
        p.add_battery(LASER_BATTERY_DRAIN * 2.0);
        assert!(p.shield_active(1.0, false));

        p.apply_damage(5.0, energy_source(), 1.0, false);
        assert!(
            p.shield_active(1.0, false),
            "one hit should not be enough here"
        );

        p.apply_damage(5.0, energy_source(), 1.0, false);
        assert_eq!(p.battery, 0.0);
        assert!(
            !p.shield_active(1.0, false),
            "the shield outlived the charge running it"
        );

        // And the next hit lands at full strength.
        let before = p.health;
        p.apply_damage(10.0, energy_source(), 1.0, false);
        assert!(
            (p.health - (before - 10.0)).abs() < 0.01,
            "damage after the shield died was still reduced"
        );
    }

    #[test]
    fn weather_never_counts_as_energy() {
        // Weather has no weapon, so it must take the ordinary shield rule.
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        p.inventory.add(registry::SHIELD_GENERATOR, 1);
        p.apply_damage(
            20.0,
            DamageSource::Weather(EffectKind::ToxicRain),
            5.0,
            false,
        );
        // One energy, the ordinary cost — not `LASER_BATTERY_DRAIN` (T20.08).
        assert!((p.battery - (BATTERY_MAX - SHIELD_HIT_COST)).abs() < 0.01);
        assert!((p.health - (BASE_HEALTH - 20.0 * SHIELD_DAMAGE_MULT)).abs() < 0.01);
    }

    /// `docs/21` §4 clears the inventory on respawn and says nothing about
    /// charge. Stated explicitly here so the answer is a decision rather than an
    /// accident: the battery is **kept**, exactly like the score and unlike the
    /// items — you respawn with the charge you had, and no weapon to spend it on.
    #[test]
    fn respawn_keeps_the_battery_and_clears_the_shield() {
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        p.inventory.add(registry::SHIELD_GENERATOR, 1);
        assert!(
            p.shield_active(0.0, false),
            "the fixture is not shielded to begin with"
        );
        p.respawn(Vec2::new(10.0, 10.0), 0.0);
        assert_eq!(p.battery, BATTERY_MAX, "respawn wiped the charge");
        // The generator went with the inventory, so the shield went with it
        // (T20.08) — one fact, not two.
        assert!(!p.shield_active(0.0, false), "the shield survived death");
        assert!(!p.holds_shield_generator());
    }

    /// T22.08A, R79: **a flare's burn dies with you**, at `die` and again at
    /// `respawn` — each checked separately, since either alone would leave a
    /// burn ticking against a body that was never touched. The control is the
    /// burn being live before each.
    #[test]
    fn death_and_respawn_each_put_out_the_flares_burn() {
        let lit = |p: &mut PlayerState| {
            p.burn(0.0);
            p.burn_exposure = 0.5;
            assert!(p.burning(0.0), "control: the burn did not take");
        };
        let mut p = player();
        lit(&mut p);
        let _ = p.die(DeathCause::Weather, 0.0);
        assert!(!p.burning(0.0), "a corpse is still burning");
        assert_eq!(p.burn_exposure, 0.0, "a corpse kept its burn exposure");

        let mut p = player();
        lit(&mut p);
        p.respawn(Vec2::new(10.0, 10.0), 0.0);
        assert!(!p.burning(0.0), "the burn survived the respawn");
        assert_eq!(p.burn_exposure, 0.0, "the exposure survived the respawn");
    }
}

#[cfg(test)]
mod consumables {
    use super::*;
    use crate::constants::{
        BASE_HEALTH, BATTERY_MAX, BATTERY_PACK_AMOUNT, HEALTH_CAP, MAX_BATTERIES, MAX_HEALS,
        MEDKIT_HEAL,
    };

    fn player() -> PlayerState {
        let mut p = PlayerState::new(0, crate::math::Vec2::new(100.0, 100.0), 0);
        p.alive = true;
        p
    }

    #[test]
    fn a_pickup_at_max_is_refused_and_one_below_max_is_not() {
        let mut p = player();
        // The control: below the cap it succeeds, so the refusal below is about
        // the cap and not about the function never working (§A26).
        for i in 0..MAX_HEALS {
            assert!(p.take_heal(), "heal {i} was refused below the cap");
        }
        assert_eq!(p.heals, MAX_HEALS);
        assert!(!p.take_heal(), "a heal was taken at MAX_HEALS");
        assert_eq!(
            p.heals, MAX_HEALS,
            "a refused pickup still moved the counter"
        );

        for i in 0..MAX_BATTERIES {
            assert!(p.take_battery_pack(), "pack {i} was refused below the cap");
        }
        assert!(!p.take_battery_pack());
        assert_eq!(p.batteries, MAX_BATTERIES);
    }

    #[test]
    fn q_and_r_are_rejected_at_zero_and_change_nothing() {
        let mut p = player();
        p.health = BASE_HEALTH / 2.0;
        p.battery = 0.0;
        let (h0, b0) = (p.health, p.battery);

        assert_eq!(p.use_heal(), Err(UseError::EmptySlot));
        assert_eq!(p.use_battery_pack(), Err(UseError::EmptySlot));
        // Asserted on the **effect**, not on the return: a rejection that healed
        // you anyway would satisfy the first line alone.
        assert_eq!(p.health, h0);
        assert_eq!(p.battery, b0);
        assert_eq!((p.heals, p.batteries), (0, 0));
    }

    #[test]
    fn q_heals_exactly_medkit_heal_and_clamps_to_the_cap() {
        let mut p = player();
        p.heals = 1;
        p.health = BASE_HEALTH / 2.0;
        assert_eq!(p.use_heal(), Ok(()));
        assert_eq!(p.health, BASE_HEALTH / 2.0 + MEDKIT_HEAL);
        assert_eq!(p.heals, 0);

        // ...and clamped, not overflowed.
        p.heals = 1;
        p.health = HEALTH_CAP - 1.0;
        assert_eq!(p.use_heal(), Ok(()));
        assert_eq!(p.health, HEALTH_CAP);
    }

    #[test]
    fn r_adds_exactly_battery_pack_amount_and_clamps() {
        let mut p = player();
        p.batteries = 1;
        p.battery = 0.0;
        assert_eq!(p.use_battery_pack(), Ok(()));
        assert_eq!(p.battery, BATTERY_PACK_AMOUNT);

        p.batteries = 1;
        p.battery = BATTERY_MAX - 1.0;
        assert_eq!(p.use_battery_pack(), Ok(()));
        assert_eq!(p.battery, BATTERY_MAX);
    }

    #[test]
    fn a_corpse_cannot_use_either() {
        let mut p = player();
        p.heals = MAX_HEALS;
        p.batteries = MAX_BATTERIES;
        p.alive = false;
        assert_eq!(p.use_heal(), Err(UseError::Dead));
        assert_eq!(p.use_battery_pack(), Err(UseError::Dead));
        assert_eq!((p.heals, p.batteries), (MAX_HEALS, MAX_BATTERIES));
    }

    /// §C9 asks for the death decision to be made deliberately. It is: they go.
    #[test]
    fn death_takes_the_counters_with_it() {
        let mut p = player();
        p.heals = MAX_HEALS;
        p.batteries = MAX_BATTERIES;
        p.die(DeathCause::Weather, 10.0);
        assert_eq!((p.heals, p.batteries), (0, 0));
    }
}
