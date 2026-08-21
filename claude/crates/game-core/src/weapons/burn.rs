//! Burning ground (`docs/71-amendments-v3.md` §B6, §B7).
//!
//! One fire system, not three. The flamethrower's trail, a molotov's patches and
//! a lava vent's afterburn are the same thing — a disc that damages anyone
//! standing in it for a while — and they use the same `LAVA_BURN_*` numbers from
//! `docs/13` §5. Writing a second one per weapon is the §A24 mistake this project
//! has already paid for twice.

use crate::constants::{LAVA_BURN_DPS, LAVA_BURN_DURATION, LAVA_BURN_RADIUS, PLAYER_W};
use crate::math::Vec2;
use crate::weapons::explode::DamageSource;
use crate::weapons::explode::PlayerHitTarget;

#[derive(Debug, Clone, Copy)]
pub struct BurnPatch {
    pub pos: Vec2,
    pub radius: f32,
    pub dps: f32,
    pub until: f32,
    /// Who lit it, so a burn kill is attributed to them and not to the map (§A20).
    pub source: DamageSource,
}

/// Ground fire, shared by everything that sets it.
#[derive(Debug, Default)]
pub struct BurnField {
    patches: Vec<BurnPatch>,
}

impl BurnField {
    pub fn len(&self) -> usize {
        self.patches.len()
    }

    pub fn is_empty(&self) -> bool {
        self.patches.is_empty()
    }

    pub fn patches(&self) -> &[BurnPatch] {
        &self.patches
    }

    /// Light a patch with the standard numbers.
    pub fn light(&mut self, pos: Vec2, now: f32, source: DamageSource) {
        self.light_for(
            pos,
            LAVA_BURN_RADIUS,
            LAVA_BURN_DPS,
            LAVA_BURN_DURATION,
            now,
            source,
        );
    }

    /// Light a patch with its own radius, rate and life — a flamethrower's trail
    /// is smaller and shorter-lived than a molotov's.
    pub fn light_for(
        &mut self,
        pos: Vec2,
        radius: f32,
        dps: f32,
        duration: f32,
        now: f32,
        source: DamageSource,
    ) {
        self.patches.push(BurnPatch {
            pos,
            radius,
            dps,
            until: now + duration,
            source,
        });
    }

    /// Hash the burning ground (§A34). Fire is state: a patch that should have
    /// gone out is damage a replay would not reproduce.
    pub fn hash_into(&self, h: &mut blake3::Hasher) {
        h.update(&(self.patches.len() as u32).to_le_bytes());
        for p in &self.patches {
            h.update(&p.pos.x.to_le_bytes());
            h.update(&p.pos.y.to_le_bytes());
            h.update(&p.radius.to_le_bytes());
            h.update(&p.dps.to_le_bytes());
            h.update(&p.until.to_le_bytes());
        }
    }

    /// Damage anyone standing in fire, then drop the patches that have gone out.
    ///
    /// Damage is per-patch, so overlapping fire genuinely burns faster. That is
    /// the behaviour a player expects from walking into the middle of a molotov,
    /// and capping it would make the centre of a fire no worse than its edge.
    pub fn tick(&mut self, players: &mut [PlayerHitTarget], now: f32, dt: f32) {
        for target in players.iter_mut() {
            if !target.alive {
                continue;
            }
            let p = target.pos;
            for patch in &self.patches {
                if now >= patch.until {
                    continue;
                }
                if (p - patch.pos).len() <= patch.radius + PLAYER_W * 0.5 {
                    (target.apply_damage)(patch.dps * dt, patch.source);
                }
            }
        }
        self.patches.retain(|p| now < p.until);
    }
}
