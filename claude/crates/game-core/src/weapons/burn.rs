//! Damaging ground zones (`docs/71-amendments-v3.md` §B6, §B7 — **and §F10.2**).
//!
//! This used to be one fire system for three weapons: the flamethrower's trail,
//! a molotov's patches and a lava vent's afterburn were all the same disc, and
//! writing a second one per weapon would have been the §A24 mistake this project
//! has paid for twice.
//!
//! **§F10.2 took the fire out of it.** All three of those are flames now —
//! objects that fly, fall, settle and burn, in `weapons::flame` — because a disc
//! that damages you while you stand in it is a rule and not a fire. What is left
//! here is the **toxic grenade's cloud**, deliberately: a toxic zone that dug
//! into the ground and drifted would be a second fire, and §F12 says the toxic
//! grenade is unchanged.
//!
//! So this file is now one weapon's mechanism rather than three's. It keeps its
//! shape — `Zone`, `light_zone`, a `kind` — because collapsing it into "the
//! toxic cloud" would have to be undone by the next zone weapon, and because
//! `BurnKind` is one half of a mapping `defs::BurnZone` still checks.

use crate::math::Vec2;
use crate::weapons::explode::DamageSource;
use crate::weapons::explode::HitTarget;

/// What a patch *is*, for the client to draw. Both kinds damage identically —
/// this is the only difference, which is why it is a field on the existing patch
/// and not a second field with a second tick loop (§A24). A toxic zone is
/// burning ground with different numbers and a different colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BurnKind {
    Toxic,
}

/// One patch's numbers, kept together so they cannot be swapped at a call site.
#[derive(Debug, Clone, Copy)]
pub struct Zone {
    pub kind: BurnKind,
    pub pos: Vec2,
    pub radius: f32,
    pub dps: f32,
    pub duration: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct BurnPatch {
    pub kind: BurnKind,
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

    /// A zone of a stated kind — a molotov's fire, a toxic grenade's fallout.
    ///
    /// The numbers travel together as a `Zone` because they *are* one thing: a
    /// weapon's `Burst::Zone` is exactly this, and passing them as seven loose
    /// arguments is how a radius ends up where a dps should be.
    pub fn light_zone(&mut self, z: Zone, now: f32, source: DamageSource) {
        self.patches.push(BurnPatch {
            kind: z.kind,
            pos: z.pos,
            radius: z.radius,
            dps: z.dps,
            until: now + z.duration,
            source,
        });
    }

    /// Hash the zones (§A34). A zone is state: one that should have gone out is
    /// damage a replay would not reproduce.
    pub fn hash_into(&self, h: &mut blake3::Hasher) {
        h.update(&(self.patches.len() as u32).to_le_bytes());
        for p in &self.patches {
            h.update(&[p.kind as u8]);
            h.update(&p.pos.x.to_le_bytes());
            h.update(&p.pos.y.to_le_bytes());
            h.update(&p.radius.to_le_bytes());
            h.update(&p.dps.to_le_bytes());
            h.update(&p.until.to_le_bytes());
        }
    }

    /// Damage anyone standing in a zone, then drop the ones that have gone out.
    ///
    /// Damage is per-patch, so overlapping zones genuinely burn faster — the
    /// same rule `weapons::flame` makes for overlapping flames.
    ///
    /// **The overlap test is a circle around the body's centre plus its
    /// half-*width*, which ignores `h`.** That is safe here and only here:
    /// `TOXIC_GRENADE_RADIUS` is far larger than a body's half-height, so the
    /// extra reach hides the missing term. It is **not** safe for anything
    /// small — a 10 px flame tested this way misses a body it is resting at the
    /// feet of, which is why `flame::touching` is circle-against-box. If a
    /// tighter zone weapon is ever added, this is the line to change.
    pub fn tick(&mut self, players: &mut [HitTarget], now: f32, dt: f32) {
        for target in players.iter_mut() {
            if !target.alive {
                continue;
            }
            let p = target.pos;
            for patch in &self.patches {
                if now >= patch.until {
                    continue;
                }
                // `target.w`, not `PLAYER_W`: this slice holds birds too since
                // §C16, and `HitTarget` carries a hit box precisely so nothing
                // downstream has to assume one.
                if (p - patch.pos).len() <= patch.radius + target.w * 0.5 {
                    (target.apply_damage)(patch.dps * dt, patch.source);
                }
            }
        }
        self.patches.retain(|p| now < p.until);
    }
}
