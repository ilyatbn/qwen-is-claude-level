//! The player record: health, shield, scoring, death and respawn.
//!
//! See `docs/21-player-stats.md`.

use crate::constants::{
    BASE_HEALTH, BATTERY_MAX, DEATH_POINTS, HEALTH_CAP, HEALTH_SPEED_MIN, KILL_POINTS,
    LASER_BATTERY_DRAIN, LASER_SHIELD_MULT, LIFESTEAL_DAMAGE_PER_HP, OVERHEAL_DECAY, RESPAWN_DELAY,
    SHIELD_DAMAGE_MULT, SHIELD_HIT_COST, SPAWN_IFRAMES, SPAWN_MIN_ENEMY_DIST,
    TOXIC_POISON_DURATION,
};
use crate::items::inventory::{Inventory, Stack};
use crate::items::registry::{def, ItemId, ItemKind, UtilityId, WeaponId};
use crate::map::gen::surface::is_standable;
use crate::map::Map;
use crate::math::{lerp, Vec2};
use crate::physics::body::Body;
use crate::player::jetpack::JetpackState;
use crate::player::movement::JumpState;
use crate::rng::{range_i32, ChaCha8Rng};
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

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DeathCause {
    Player(PlayerId),
    SelfInflicted,
    Weather,
    /// Fell out of the world (§C15). A boundary, not damage — see
    /// `World::step_void` for why it does not go through the damage funnel.
    Void,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum UseError {
    Dead,
    BadSlot,
    EmptySlot,
    WrongKind,
    OnCooldown,
    NoAmmo,
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
    pub fn shield_active(&self, now: f32) -> bool {
        let _ = now;
        self.battery > 0.0 && self.holds_shield_generator()
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
        lerp(
            HEALTH_SPEED_MIN,
            1.0,
            (self.health.floor() / BASE_HEALTH).clamp(0.0, 1.0),
        )
    }

    /// Were they thrown by something recently? See `knocked_until`.
    pub fn was_knocked(&self, now: f32) -> bool {
        now < self.knocked_until
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
    pub fn apply_damage(&mut self, amount: f32, src: DamageSource, now: f32) -> bool {
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
            DamageSource::Weather(_) | DamageSource::Fall => false,
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
        let mult = if self.shield_active(now) {
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
            DamageSource::Weather(_) => {}
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
            DeathCause::Weather | DeathCause::Void => match self.last_damaged_by {
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
    /// Slot 0 by construction: the inventory is empty at both call sites, and
    /// `add` takes the first free slot.
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
    surface_to_centre(choose_surface_point(map, living, rng))
}

/// Feet line to body centre.
pub fn surface_to_centre(p: Vec2) -> Vec2 {
    Vec2::new(p.x, p.y - crate::constants::PLAYER_H / 2.0)
}

fn choose_surface_point(map: &Map, living: &[Vec2], rng: &mut ChaCha8Rng) -> Vec2 {
    let standable = |p: &crate::math::Point| is_standable(&map.mask, p.x, p.y);

    // Prefer a listed spawn point that is still ground and far from the living.
    let mut best: Option<(f32, Vec2)> = None;
    for p in map.meta.spawn_points.iter().filter(|p| standable(p)) {
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

    // Every listed spawn has been destroyed: fall back to any still-valid surface
    // point, preferring one away from the living.
    let surface = &map.meta.surface_points;
    let mut fallback: Option<(f32, Vec2)> = None;
    for _ in 0..200 {
        if surface.is_empty() {
            break;
        }
        let p = surface[range_i32(rng, 0, surface.len() as i32 - 1) as usize];
        if !standable(&p) {
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

    // Nothing standable at all: a scan for anywhere the body fits, so respawn can
    // never place a player inside rock.
    for p in surface.iter() {
        if standable(p) {
            return Vec2::new(p.x as f32, p.y as f32);
        }
    }
    Vec2::new(map.mask.w as f32 / 2.0, crate::constants::SKY_MARGIN as f32)
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
        assert!(!p.shield_active(0.0), "a battery alone shielded a player");

        p.inventory.add(registry::SHIELD_GENERATOR, 1);
        assert!(p.shield_active(0.0), "carrying a generator did not shield");

        // **Not the active slot** — the brief is explicit. Selecting something
        // else must change nothing.
        p.inventory.select(0);
        assert!(
            p.shield_active(0.0),
            "the generator only worked while it was selected"
        );

        // And it costs nothing per second, which is the whole of the timer's
        // removal: ten seconds of standing still spends no charge.
        for i in 0..600 {
            p.tick_stats(i as f32 * SIM_DT, SIM_DT);
        }
        assert_eq!(p.battery, BATTERY_MAX, "a held generator drained over time");
        assert!(p.shield_active(10.0));
    }

    /// The brief, in one test: **25 % off each hit, one energy each time.**
    #[test]
    fn a_held_generator_takes_a_quarter_off_each_hit_for_one_energy() {
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        p.inventory.add(registry::SHIELD_GENERATOR, 1);

        let hits = 5;
        for _ in 0..hits {
            p.apply_damage(20.0, ballistic_source(), 1.0);
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
            q.apply_damage(20.0, ballistic_source(), 1.0);
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
            p.apply_damage(tick, ballistic_source(), 1.0);
        }
        let stopped = tick * ticks as f32 * (1.0 - SHIELD_DAMAGE_MULT);
        let spent = BATTERY_MAX - p.battery;
        assert!(
            (spent - stopped).abs() < 0.01,
            "a whole poisoning cost {spent} energy to stop {stopped} damage"
        );
        // And the reduction held for all of it, which is the thing the flat cost
        // broke: the generator must not run dry on a trickle.
        assert!(p.shield_active(1.0), "a trickle exhausted a full battery");
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
        q.apply_damage(20.0, ballistic_source(), 1.0);
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
        assert!(p.shield_active(0.0));

        p.apply_damage(20.0, ballistic_source(), 1.0);
        assert_eq!(p.battery, 0.0);
        assert!(
            !p.shield_active(0.0),
            "a flat battery still read as shielded"
        );

        let before = p.health;
        p.apply_damage(20.0, ballistic_source(), 1.0);
        assert!(
            (p.health - (before - 20.0)).abs() < 0.01,
            "damage at zero charge was still reduced"
        );

        // The control on the control: it comes back. Without this, "the shield
        // stops" would also pass for a generator that never worked again.
        p.add_battery(BATTERY_PACK_AMOUNT);
        assert!(p.shield_active(0.0));
        let before = p.health;
        p.apply_damage(20.0, ballistic_source(), 1.0);
        assert!((p.health - (before - 20.0 * SHIELD_DAMAGE_MULT)).abs() < 0.01);
    }

    #[test]
    fn energy_pierces_a_shield_and_ballistic_does_not() {
        // Energy: 0.85x through the shield, and it drains the victim harder.
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        p.inventory.add(registry::SHIELD_GENERATOR, 1);
        p.apply_damage(20.0, energy_source(), 5.0);
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
        q.apply_damage(20.0, ballistic_source(), 5.0);
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
            p.shield_active(1.0),
            "bit 3 must be true if anything is absorbed"
        );

        p.apply_damage(20.0, energy_source(), 1.0);
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
            !p.shield_active(1.0),
            "bit 3 must be false once there is nothing left to spend"
        );
    }

    /// The payoff: drain someone's charge and their shield goes with it.
    #[test]
    fn draining_a_victims_battery_to_zero_ends_their_shield() {
        let mut p = player();
        p.inventory.add(registry::SHIELD_GENERATOR, 1);
        p.add_battery(LASER_BATTERY_DRAIN * 2.0);
        assert!(p.shield_active(1.0));

        p.apply_damage(5.0, energy_source(), 1.0);
        assert!(p.shield_active(1.0), "one hit should not be enough here");

        p.apply_damage(5.0, energy_source(), 1.0);
        assert_eq!(p.battery, 0.0);
        assert!(
            !p.shield_active(1.0),
            "the shield outlived the charge running it"
        );

        // And the next hit lands at full strength.
        let before = p.health;
        p.apply_damage(10.0, energy_source(), 1.0);
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
        p.apply_damage(20.0, DamageSource::Weather(EffectKind::ToxicRain), 5.0);
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
            p.shield_active(0.0),
            "the fixture is not shielded to begin with"
        );
        p.respawn(Vec2::new(10.0, 10.0), 0.0);
        assert_eq!(p.battery, BATTERY_MAX, "respawn wiped the charge");
        // The generator went with the inventory, so the shield went with it
        // (T20.08) — one fact, not two.
        assert!(!p.shield_active(0.0), "the shield survived death");
        assert!(!p.holds_shield_generator());
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
