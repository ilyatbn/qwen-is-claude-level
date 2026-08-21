//! Cone delivery — the flamethrower (`docs/71-amendments-v3.md` §B6).
//!
//! Damages everything inside a cone each tick and leaves burning ground behind.
//! It **carves nothing**: fire does not dig, and that is exactly what stops it
//! being strictly better than the arsenal it competes with. Area denial is the
//! point — the ground you leave burning shapes where people can walk next.

use crate::map::Map;
use crate::math::Vec2;
use crate::physics::collide::solid_at;
use crate::player::state::PlayerId;
use crate::weapons::burn::BurnField;
use crate::weapons::defs::WeaponDef;
use crate::weapons::explode::{BlastSource, PlayerHitTarget};

/// Spacing of the line-of-sight samples. Same reasoning as melee's.
const LOS_STEP: f32 = 4.0;

/// How far apart the trail's burn patches are laid.
///
/// Closer together and a one-second burst lights dozens of overlapping discs,
/// each of which damages independently — which would make the flamethrower's
/// residue deadlier than the flame.
const TRAIL_SPACING: f32 = 26.0;

/// Radius and life of one trail patch. Smaller and shorter than a molotov's,
/// because this is spray, not a thrown incendiary.
const TRAIL_RADIUS: f32 = 20.0;
const TRAIL_LIFE: f32 = 2.0;

#[derive(Debug, Default)]
pub struct ConeResult {
    /// victim, damage dealt this tick
    pub hits: Vec<(PlayerId, f32)>,
    pub lit: usize,
}

fn angle_between(a: f32, b: f32) -> f32 {
    let mut d = (a - b) % std::f32::consts::TAU;
    if d > std::f32::consts::PI {
        d -= std::f32::consts::TAU;
    } else if d < -std::f32::consts::PI {
        d += std::f32::consts::TAU;
    }
    d.abs()
}

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

/// Spray for one tick.
///
/// `dt` scales the damage, so the cone deals `dps` per second regardless of tick
/// rate — the same discipline the weather hazards follow.
#[allow(clippy::too_many_arguments)]
pub fn spray(
    map: &Map,
    players: &mut [PlayerHitTarget],
    burn: &mut BurnField,
    origin: Vec2,
    aim: f32,
    def: &WeaponDef,
    range: f32,
    arc: f32,
    dps: f32,
    now: f32,
    dt: f32,
    source: BlastSource,
) -> ConeResult {
    let mut out = ConeResult::default();

    for p in players.iter_mut() {
        if !p.alive {
            continue;
        }
        if let BlastSource::Fired { owner, .. } = source {
            if owner == p.id {
                continue;
            }
        }
        let to = p.pos - origin;
        let dist = to.len();
        if dist > range {
            continue;
        }
        if dist > f32::EPSILON && angle_between(to.y.atan2(to.x), aim) > arc * 0.5 {
            continue;
        }
        if !clear_line(map, origin, p.pos) {
            continue;
        }
        let dmg = dps * dt;
        if (p.apply_damage)(dmg, source.for_victim(p.id)) {
            out.hits.push((p.id, dmg));
        }
    }

    // Lay burning ground where the flame lands: march the centre line until it
    // meets rock, and light the last clear point. Fire pools on the floor it hits
    // rather than hanging in the air where it was sprayed.
    let dir = Vec2::new(aim.cos(), aim.sin());
    let mut walked = TRAIL_SPACING;
    while walked <= range {
        let at = origin + dir * walked;
        if solid_at(map, at.x.round() as i32, at.y.round() as i32) {
            break;
        }
        walked += TRAIL_SPACING;
    }
    let landing = origin + dir * (walked - TRAIL_SPACING).max(0.0);
    if walked > TRAIL_SPACING {
        burn.light_for(
            landing,
            TRAIL_RADIUS,
            dps * 0.5,
            TRAIL_LIFE,
            now,
            source.for_victim(u8::MAX),
        );
        out.lit = 1;
    }
    let _ = def;
    out
}
