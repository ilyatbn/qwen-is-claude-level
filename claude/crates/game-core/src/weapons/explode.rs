//! The single explosion primitive, and hitscan resolution.
//!
//! Weapons, meteors, lava and anything else that goes bang calls `explode`. It is
//! the second choke point after `carve_circle`, and like that one its value comes
//! from there being exactly one of it. See `docs/31-weapons-combat.md` §4, §5.

use crate::constants::{KNOCKBACK_MAX, MUZZLE_OFFSET, SELF_DAMAGE_MULT};
use crate::items::registry::WeaponId;
use crate::map::carve::CarveResult;
use crate::map::Map;
use crate::math::{Aabb, Vec2};
use crate::physics::collide::solid_at;
use crate::rng::{range_f32, ChaCha8Rng};
use crate::weapons::defs::{Delivery, WeaponDef};

pub type PlayerId = u8;

/// Stubbed until M5 gives weather its own kinds.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum EffectKind {
    ToxicRain,
    MeteorShower,
    LavaBurst,
    HeavyFog,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum DamageSource {
    Player {
        id: PlayerId,
        weapon: WeaponId,
    },
    /// Produced when `owner == victim`: a rocket-jump death costs you a point and
    /// gives nobody else one.
    SelfInflicted {
        weapon: WeaponId,
    },
    Weather(EffectKind),
}

/// The minimal view of a player an explosion needs, so this does not depend on the
/// full `PlayerState`.
pub struct PlayerHitTarget<'a> {
    pub id: PlayerId,
    pub pos: Vec2,
    pub vel: &'a mut Vec2,
    pub alive: bool,
    /// Returns true when the damage was actually applied (shield and i-frames are
    /// the callee's business).
    pub apply_damage: &'a mut dyn FnMut(f32, DamageSource) -> bool,
}

#[derive(Debug, Default)]
pub struct ExplosionResult {
    pub carve: CarveResult,
    /// victim, damage dealt, impulse applied
    pub hits: Vec<(PlayerId, f32, Vec2)>,
    /// Everyone this blast **threw**, whether or not it hurt them.
    ///
    /// Not the same set as `hits`: knockback lands even when the damage is
    /// refused by a shield or i-frames (`docs/21` §5), so `hits` is a subset.
    /// The caller needs this one to know who was moved by something other than
    /// their own legs — §C20 refuses a shot from a player who is moving under
    /// their own power, and being thrown must not count as that (CLAUDE.md:
    /// "return what the caller needs").
    pub knocked: Vec<PlayerId>,
}

/// How this blast should be attributed, before knowing who it hit.
///
/// `explode` turns this into a per-victim [`DamageSource`]: a `Fired` blast whose
/// owner *is* the victim becomes `SelfInflicted`, which is what makes a rocket-jump
/// death cost you a point and give nobody else one.
///
/// This is a parameter rather than a default because **every** ownerless explosion
/// used to be attributed to `MeteorShower` — so lava and toxic deaths would have
/// read "meteor" in the kill feed the moment M6 wired the event
/// (`docs/70-amendments-v2.md` §A20).
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum BlastSource {
    Fired { owner: PlayerId, weapon: WeaponId },
    Weather(EffectKind),
}

impl BlastSource {
    pub(crate) fn for_victim(self, victim: PlayerId) -> DamageSource {
        match self {
            BlastSource::Fired { owner, weapon } if owner == victim => {
                DamageSource::SelfInflicted { weapon }
            }
            BlastSource::Fired { owner, weapon } => DamageSource::Player { id: owner, weapon },
            BlastSource::Weather(kind) => DamageSource::Weather(kind),
        }
    }
}

/// Carve, then damage.
///
/// **Order matters.** The carve's `revealed` slots belong to the same moment as the
/// blast, so a rocket that exposes a buried item reports both in one result
/// (`docs/11-map-destruction.md` §5).
pub fn explode(
    map: &mut Map,
    players: &mut [PlayerHitTarget],
    at: Vec2,
    radius: f32,
    damage: f32,
    source: BlastSource,
) -> ExplosionResult {
    let carve = map.carve_circle(
        at.x.round() as i32,
        at.y.round() as i32,
        radius.round() as i32,
    );

    let mut hits = Vec::new();

    let mut knocked: Vec<PlayerId> = Vec::new();
    for p in players.iter_mut() {
        if !p.alive {
            continue;
        }
        // Distance to the player CENTRE, not the nearest AABB point: simpler,
        // symmetric, and at most 8 px different.
        let d = (p.pos - at).len();
        if d > radius {
            continue;
        }
        let t = (1.0 - d / radius).clamp(0.0, 1.0);

        let src = source.for_victim(p.id);
        let mult = if matches!(src, DamageSource::SelfInflicted { .. }) {
            SELF_DAMAGE_MULT
        } else {
            1.0
        };
        let dealt = damage * t * mult;
        // The return says whether it LANDED — i-frames and death refuse it. A hit
        // recorded at full value regardless is a phantom `damage` event on the
        // wire, and any kill attribution built on this list inherits the error
        // (`docs/70-amendments-v2.md` §A20).
        let applied = (p.apply_damage)(dealt, src);

        // Knockback is applied even through i-frames and through the shield —
        // being thrown is not damage. It is what makes rocket-jumping work and how
        // a player gets launched into a hazard (`docs/21-player-stats.md` §5).
        let dir = if d < 1e-3 {
            Vec2::new(0.0, -1.0)
        } else {
            (p.pos - at) / d
        };
        let impulse = dir * (KNOCKBACK_MAX * t);
        *p.vel += impulse;
        if impulse.len() > 0.0 {
            knocked.push(p.id);
        }

        // A victim exactly at `d == radius` takes zero and is pushed by zero.
        // Recording that is a wire event describing nothing happening.
        if applied && dealt > 0.0 {
            hits.push((p.id, dealt, impulse));
        }
    }

    ExplosionResult {
        carve,
        hits,
        knocked,
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum HitscanHit {
    Player(PlayerId),
    Terrain,
}

#[derive(Clone, Debug)]
pub struct HitscanShot {
    pub from: Vec2,
    pub to: Vec2,
    pub hit: Option<HitscanHit>,
    /// What the terrain hit removed, when there was one.
    ///
    /// Returned rather than discarded because a 3-px bullet carve can expose a
    /// buried slot exactly as a rocket can, and the caller is the only place that
    /// can turn `revealed` into an `item_spawn` event
    /// (`docs/11-map-destruction.md` §5).
    pub carve: Option<CarveResult>,
}

/// Resolve one trigger pull.
#[allow(clippy::too_many_arguments)]
///
/// The 3-px carve per bullet is the SMG's identity: sustained fire genuinely
/// tunnels through a thin wall, slowly and loudly. **No knockback** — the SMG is
/// chip damage, not displacement; that is the bazooka's job.
pub fn fire_hitscan(
    map: &mut Map,
    players: &mut [PlayerHitTarget],
    weapon: &WeaponDef,
    owner: PlayerId,
    player_centre: Vec2,
    aim: f32,
    rng: &mut ChaCha8Rng,
    _now: f32,
) -> Vec<HitscanShot> {
    let Delivery::Hitscan { shots, spread } = weapon.delivery else {
        return Vec::new();
    };

    let mut out = Vec::with_capacity(shots as usize);
    for _ in 0..shots {
        let a = aim + range_f32(rng, -spread, spread);
        let dir = Vec2::new(a.cos(), a.sin());
        let from = player_centre + dir * MUZZLE_OFFSET;

        let mut hit = None;
        let mut carve = None;
        let mut to = from + dir * weapon.range;

        // One pixel at a time, so the terrain march and the player test agree.
        let steps = weapon.range.max(1.0) as i32;
        for s in 0..=steps {
            let p = from + dir * s as f32;

            let mut who = None;
            for t in players.iter() {
                if !t.alive || t.id == owner {
                    continue;
                }
                if Aabb::from_center_size(
                    t.pos,
                    crate::constants::PLAYER_W,
                    crate::constants::PLAYER_H,
                )
                .contains_point(p)
                {
                    who = Some(t.id);
                    break;
                }
            }
            if let Some(victim) = who {
                to = p;
                hit = Some(HitscanHit::Player(victim));
                break;
            }

            if solid_at(map, p.x.round() as i32, p.y.round() as i32) {
                to = p;
                hit = Some(HitscanHit::Terrain);
                break;
            }
        }

        match hit {
            Some(HitscanHit::Player(victim)) => {
                for t in players.iter_mut() {
                    if t.id == victim {
                        (t.apply_damage)(
                            weapon.damage,
                            DamageSource::Player {
                                id: owner,
                                weapon: weapon.id,
                            },
                        );
                    }
                }
            }
            Some(HitscanHit::Terrain) => {
                carve = Some(map.carve_circle(
                    to.x.round() as i32,
                    to.y.round() as i32,
                    weapon.blast_radius.round() as i32,
                ));
            }
            None => {}
        }

        out.push(HitscanShot {
            from,
            to,
            hit,
            carve,
        });
    }
    out
}
