//! The player record: health, shield, scoring, death and respawn.
//!
//! See `docs/21-player-stats.md`.

use crate::constants::{
    BASE_HEALTH, DEATH_POINTS, HEALTH_CAP, HEALTH_SPEED_MIN, KILL_POINTS, OVERHEAL_DECAY,
    RESPAWN_DELAY, SHIELD_DAMAGE_MULT, SHIELD_DURATION, SPAWN_IFRAMES, SPAWN_MIN_ENEMY_DIST,
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

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DeathCause {
    Player(PlayerId),
    SelfInflicted,
    Weather,
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
    pub inventory: Inventory,
    pub flashlight_on: bool,
    pub alive: bool,
    pub respawn_at: f32,
    pub iframes_until: f32,
    /// Signed, and it may go negative: a player who only dies ends below zero.
    pub score: i16,
    pub deaths: u16,
    pub last_damaged_by: Option<(PlayerId, f32)>,
    pub skin_id: u16,
    pub fire_ready_at: f32,
}

impl PlayerState {
    pub fn new(id: PlayerId, pos: Vec2, skin_id: u16) -> Self {
        PlayerState {
            id,
            body: Body::new(pos),
            jump: JumpState::default(),
            jetpack: JetpackState::default(),
            aim: 0,
            health: BASE_HEALTH,
            shield_until: None,
            inventory: Inventory::new(),
            flashlight_on: false,
            alive: true,
            respawn_at: 0.0,
            iframes_until: 0.0,
            score: 0,
            deaths: 0,
            last_damaged_by: None,
            skin_id,
            fire_ready_at: 0.0,
        }
    }

    pub fn shield_active(&self, now: f32) -> bool {
        self.shield_until.is_some_and(|t| now < t)
    }

    /// Replaces the timer rather than stacking it: re-applying at 2 s left gives a
    /// fresh 20 s, and never a stronger multiplier.
    pub fn apply_shield(&mut self, now: f32) {
        self.shield_until = Some(now + SHIELD_DURATION);
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

    pub fn invulnerable(&self, now: f32) -> bool {
        now < self.iframes_until
    }

    /// Overheal decay and shield expiry.
    pub fn tick_stats(&mut self, now: f32, dt: f32) {
        if self.health > BASE_HEALTH {
            // A stacked medkit is ~25 s of extra buffer, not a permanent upgrade.
            self.health = (self.health - OVERHEAL_DECAY * dt).max(BASE_HEALTH);
        }
        if let Some(t) = self.shield_until {
            if now >= t {
                self.shield_until = None;
            }
        }
    }

    /// Returns true when the damage was actually applied.
    pub fn apply_damage(&mut self, amount: f32, src: DamageSource, now: f32) -> bool {
        if !self.alive || self.invulnerable(now) {
            return false;
        }
        let mult = if self.shield_active(now) {
            SHIELD_DAMAGE_MULT
        } else {
            1.0
        };
        self.health -= amount * mult;

        if let DamageSource::Player { id, .. } = src {
            if id != self.id {
                self.last_damaged_by = Some((id, now));
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
            DeathCause::Weather => match self.last_damaged_by {
                Some((who, when)) if now - when <= ASSIST_WINDOW => DeathCause::Player(who),
                _ => DeathCause::Weather,
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
        self.flashlight_on = false;
        self.inventory.drain_all()
    }

    pub fn credit_kill(&mut self) {
        self.score += KILL_POINTS;
    }

    pub fn respawn(&mut self, pos: Vec2, now: f32) {
        self.body = Body::new(pos);
        self.health = BASE_HEALTH;
        self.shield_until = None;
        self.jetpack = JetpackState::default();
        self.jump = JumpState::default();
        self.inventory.clear();
        self.alive = true;
        self.iframes_until = now + SPAWN_IFRAMES;
        self.last_damaged_by = None;
        // The item is gone with the inventory, so the light goes with it.
        self.flashlight_on = false;
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
            ItemKind::Utility(_) => {
                // The flashlight is a toggle, not a consumable: the stack is
                // untouched.
                self.flashlight_on = !self.flashlight_on;
            }
            // You cannot `use` a bazooka.
            ItemKind::Weapon(_) => return Err(UseError::WrongKind),
        }
        Ok(stack.item)
    }

    /// Validated fire. Checks kind, cooldown and ammo; spawns nothing.
    pub fn try_fire(&mut self, now: f32) -> Result<WeaponId, UseError> {
        if !self.alive {
            return Err(UseError::Dead);
        }
        let slot = self.inventory.selected();
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
        let cooldown =
            defs::def(wid).map_or(crate::constants::FIRE_COOLDOWN_DEFAULT, |w| w.cooldown);
        self.fire_ready_at = now + cooldown;
        self.inventory.consume(slot, 1);
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
