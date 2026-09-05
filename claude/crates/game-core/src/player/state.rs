//! The player record: health, shield, scoring, death and respawn.
//!
//! See `docs/21-player-stats.md`.

use crate::constants::{
    BASE_HEALTH, BATTERY_MAX, DEATH_POINTS, HEALTH_CAP, HEALTH_SPEED_MIN, KILL_POINTS,
    LASER_BATTERY_DRAIN, LASER_SHIELD_MULT, OVERHEAL_DECAY, RESPAWN_DELAY, SHIELD_DAMAGE_MULT,
    SHIELD_DRAIN, SHIELD_DURATION, SPAWN_IFRAMES, SPAWN_MIN_ENEMY_DIST, TOXIC_POISON_DURATION,
};
use crate::items::inventory::{Inventory, Stack};
use crate::items::registry::{def, ItemId, ItemKind, WeaponId};
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
    pub shield_until: Option<f32>,
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
            shield_until: None,
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

    pub fn shield_active(&self, now: f32) -> bool {
        self.shield_until.is_some_and(|t| now < t)
    }

    /// Replaces the timer rather than stacking it: re-applying at 2 s left gives a
    /// fresh 20 s, and never a stronger multiplier.
    pub fn apply_shield(&mut self, now: f32) {
        self.shield_until = Some(now + SHIELD_DURATION);
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

    /// At full health you move at `WALK_SPEED`; at 1 health, 75 % of it. Overheal
    /// does **not** make you faster — the ratio is clamped at 1.
    pub fn speed_multiplier(&self) -> f32 {
        lerp(
            HEALTH_SPEED_MIN,
            1.0,
            (self.health / BASE_HEALTH).clamp(0.0, 1.0),
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
    pub fn tick_stats(&mut self, now: f32, dt: f32) {
        if self.health > BASE_HEALTH {
            // A stacked medkit is ~25 s of extra buffer, not a permanent upgrade.
            self.health = (self.health - OVERHEAL_DECAY * dt).max(BASE_HEALTH);
        }
        if let Some(t) = self.shield_until {
            if now >= t {
                self.shield_until = None;
            } else {
                // An active shield runs off the battery (§B5). `SHIELD_DURATION`
                // stays the maximum; the battery is what usually ends it first,
                // and that is the whole tension — the charge keeping you alive is
                // the charge your laser wants.
                self.battery = (self.battery - SHIELD_DRAIN * dt).max(0.0);
                if self.battery <= 0.0 {
                    self.shield_until = None;
                }
            }
        }
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
            DamageSource::Weather(_) => false,
        };
        let mult = if self.shield_active(now) {
            if energy {
                // Drains the victim's charge as well as piercing, which cuts the
                // shield's remaining life directly — that is the payoff, not a
                // side effect.
                self.battery = (self.battery - LASER_BATTERY_DRAIN).max(0.0);
                if self.battery <= 0.0 {
                    self.shield_until = None;
                }
                LASER_SHIELD_MULT
            } else {
                SHIELD_DAMAGE_MULT
            }
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
        self.shield_until = None;
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
        self.shield_until = None;
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
        // Nothing to clear for the flashlight: it is the *item* now, and `clear()`
        // above took it with the rest of the inventory (T20.07).
    }

    /// Validated item use, in the documented order.
    pub fn use_item(&mut self, slot: u8, now: f32) -> Result<ItemId, UseError> {
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
            ItemKind::Shield { .. } => {
                self.apply_shield(now);
                self.inventory.consume(slot, 1);
            }
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
    use crate::constants::{BATTERY_MAX, BATTERY_PACK_AMOUNT, SHIELD_DRAIN, SIM_DT};
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

    #[test]
    fn a_full_battery_lets_a_shield_run_its_whole_duration() {
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        p.apply_shield(0.0);
        let mut t = 0.0;
        while t < SHIELD_DURATION - SIM_DT {
            t += SIM_DT;
            p.tick_stats(t, SIM_DT);
        }
        assert!(
            p.shield_active(t),
            "the shield died early on a full battery"
        );
    }

    /// The early end is the point, not the duration.
    #[test]
    fn a_shield_on_ten_charge_dies_at_five_seconds() {
        let mut p = player();
        p.add_battery(10.0);
        p.apply_shield(0.0);
        let mut t = 0.0;
        let mut died_at = None;
        while t < SHIELD_DURATION {
            t += SIM_DT;
            p.tick_stats(t, SIM_DT);
            if died_at.is_none() && !p.shield_active(t) {
                died_at = Some(t);
            }
        }
        let died = died_at.expect("the shield never ran out of charge");
        let want = 10.0 / SHIELD_DRAIN;
        assert!(
            (died - want).abs() < 0.1,
            "shield died at {died}, expected about {want}"
        );
    }

    #[test]
    fn energy_pierces_a_shield_and_ballistic_does_not() {
        // Energy: 0.85x through the shield, and it drains the victim.
        let mut p = player();
        p.add_battery(BATTERY_MAX);
        p.apply_shield(0.0);
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

        // Ballistic: 0.5x, and the battery is untouched. The control that makes
        // the above mean something — without it, "energy is special" would also
        // pass for a build where every hit pierces.
        let mut q = player();
        q.add_battery(BATTERY_MAX);
        q.apply_shield(0.0);
        q.apply_damage(20.0, ballistic_source(), 5.0);
        assert!(
            (q.health - (BASE_HEALTH - 20.0 * SHIELD_DAMAGE_MULT)).abs() < 0.01,
            "ballistic damage was not halved: health {}",
            q.health
        );
        assert_eq!(q.battery, BATTERY_MAX, "a bullet drained the battery");
    }

    /// The payoff: drain someone's charge and their shield dies with it.
    #[test]
    fn draining_a_victims_battery_to_zero_ends_their_shield() {
        let mut p = player();
        p.add_battery(LASER_BATTERY_DRAIN * 2.0);
        p.apply_shield(0.0);
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
        p.apply_shield(0.0);
        p.apply_damage(20.0, DamageSource::Weather(EffectKind::ToxicRain), 5.0);
        assert_eq!(p.battery, BATTERY_MAX, "weather drained the battery");
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
        p.apply_shield(0.0);
        p.respawn(Vec2::new(10.0, 10.0), 0.0);
        assert_eq!(p.battery, BATTERY_MAX, "respawn wiped the charge");
        assert!(p.shield_until.is_none(), "the shield survived death");
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
