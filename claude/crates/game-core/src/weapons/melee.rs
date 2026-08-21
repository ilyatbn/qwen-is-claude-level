//! Melee: an arc swept around the aim angle (`docs/71-amendments-v3.md` §B6).
//!
//! Melee has **no ammo**. It is the floor of the arsenal — the thing you still
//! have when everything else is empty — so it must never be worthless, and the
//! axe and hammer carve, which makes it a digging tool as well as a weapon.
//!
//! Damage goes through the same `apply_damage` closure every other source uses,
//! so shields, i-frames and attribution are the callee's business here exactly as
//! they are for an explosion (§A24: one damage path, already tested).

use crate::map::{CarveResult, Map};
use crate::math::Vec2;
use crate::physics::collide::solid_at;
use crate::player::state::PlayerId;
use crate::weapons::defs::WeaponDef;
use crate::weapons::explode::{BlastSource, PlayerHitTarget};

/// Spacing of the line-of-sight samples between attacker and victim.
///
/// One sample per pixel would be exact and pointless: the thinnest wall the
/// generator makes is far wider than this, and a swing is at most `reach` px
/// long, so this is a handful of lookups.
const LOS_STEP: f32 = 3.0;

#[derive(Debug, Default)]
pub struct MeleeResult {
    pub carve: Option<CarveResult>,
    /// victim, damage dealt, impulse applied
    pub hits: Vec<(PlayerId, f32, Vec2)>,
}

/// Is `to` reachable from `from` without passing through rock?
///
/// Without this a hammer swings through a wall, which reads as being hit by
/// nothing. Sampled rather than swept: a melee arc is short, and the sub-step
/// guarantee that matters for tunnelling (§A24) is about *movement*, which a
/// swing is not.
fn clear_line(map: &Map, from: Vec2, to: Vec2) -> bool {
    let d = to - from;
    let len = d.len();
    if len <= f32::EPSILON {
        return true;
    }
    let steps = (len / LOS_STEP).ceil().max(1.0) as i32;
    for i in 1..=steps {
        let t = i as f32 / steps as f32;
        let p = from + d * t;
        if solid_at(map, p.x.round() as i32, p.y.round() as i32) {
            return false;
        }
    }
    true
}

/// Smallest absolute angle between two headings, in `0..=PI`.
fn angle_between(a: f32, b: f32) -> f32 {
    let mut d = (a - b) % std::f32::consts::TAU;
    if d > std::f32::consts::PI {
        d -= std::f32::consts::TAU;
    } else if d < -std::f32::consts::PI {
        d += std::f32::consts::TAU;
    }
    d.abs()
}

/// Swing `def` from `origin` along `aim`.
///
/// `reach`, `arc` and `knockback` come from the weapon; `damage` and
/// `blast_radius` are the shared `WeaponDef` fields, so a hammer digs and a knife
/// does not purely by having a non-zero radius.
#[allow(clippy::too_many_arguments)]
pub fn swing(
    map: &mut Map,
    players: &mut [PlayerHitTarget],
    origin: Vec2,
    aim: f32,
    def: &WeaponDef,
    reach: f32,
    arc: f32,
    knockback: f32,
    source: BlastSource,
) -> MeleeResult {
    let mut out = MeleeResult::default();

    for p in players.iter_mut() {
        if !p.alive {
            continue;
        }
        // Never hit yourself with your own swing. Unlike an explosion, where
        // self-damage is the point (`docs/31` §2), a bat that hits its wielder is
        // just a bug.
        if let BlastSource::Fired { owner, .. } = source {
            if owner == p.id {
                continue;
            }
        }

        let to = p.pos - origin;
        let dist = to.len();
        if dist > reach {
            continue;
        }
        // A target *on* the origin has no bearing; treat it as in the arc rather
        // than dividing by zero.
        if dist > f32::EPSILON && angle_between(to.y.atan2(to.x), aim) > arc * 0.5 {
            continue;
        }
        if !clear_line(map, origin, p.pos) {
            continue;
        }

        let dmg = def.damage;
        let dir = if dist > f32::EPSILON {
            to * (1.0 / dist)
        } else {
            Vec2::new(aim.cos(), aim.sin())
        };
        let impulse = dir * knockback;
        let applied = (p.apply_damage)(dmg, source.for_victim(p.id));
        // Knockback lands even when the damage did not: being thrown is not
        // damage (`docs/21` §5), and it is what makes a bat interesting — a hit
        // that puts someone off a ledge is a kill the number does not explain.
        *p.vel += impulse;
        if applied {
            out.hits.push((p.id, dmg, impulse));
        }
    }

    // The swing bites the terrain at the tip of the arc, so an axe opens the wall
    // it is swung at rather than the ground under the swinger.
    if def.blast_radius > 0.0 {
        let tip = origin + Vec2::new(aim.cos(), aim.sin()) * reach;
        out.carve = Some(map.carve_circle(
            tip.x.round() as i32,
            tip.y.round() as i32,
            def.blast_radius.round() as i32,
        ));
    }

    out
}
