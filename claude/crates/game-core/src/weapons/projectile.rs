//! Projectile simulation: gravity, wind, sub-stepped movement, bouncing and fuses.
//!
//! See `docs/31-weapons-combat.md` §3.

use crate::constants::{
    GRAVITY, GRENADE_REST_SPEED, MUZZLE_OFFSET, PROJECTILE_MAX_LIFETIME,
    PROJECTILE_OWNER_GRACE_TICKS,
};
use crate::items::registry::WeaponId;
use crate::map::Map;
use crate::math::{Aabb, Vec2};
use crate::physics::collide::solid_at;
use crate::physics::resolve::substeps;
use crate::weapons::defs::{def, Delivery};

pub type ProjectileId = u32;
pub type PlayerId = u8;

#[derive(Clone, Debug)]
pub struct Projectile {
    pub id: ProjectileId,
    pub weapon: WeaponId,
    pub owner: PlayerId,
    pub pos: Vec2,
    pub vel: Vec2,
    pub spawned_at: f32,
    pub fuse_at: Option<f32>,
    pub age_ticks: u32,
    /// A grenade that has stopped moving sits until its fuse expires.
    pub resting: bool,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ProjectileOutcome {
    Alive,
    Exploded { at: Vec2 },
    HitPlayer { at: Vec2, victim: PlayerId },
}

/// What `step` reports about a projectile that is now gone.
///
/// **`weapon` and `owner` travel with the outcome on purpose.** `step` removes the
/// projectile before returning, so by the time a caller sees the id there is
/// nothing left to look up — and the two things that depend on getting it right
/// are the fork-bomb guard (`MeteorShower::is_fragment(weapon)`) and §A20
/// attribution (`BlastSource::Fired { owner, weapon }`). That trap already
/// produced a fork bomb once, in M5's test harness, by reading the weapon after
/// the step. An API that asks the caller to snapshot state the API is about to
/// destroy will eventually be called wrongly, so the correct use is the only use.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Impact {
    pub id: ProjectileId,
    pub weapon: WeaponId,
    pub owner: PlayerId,
    pub outcome: ProjectileOutcome,
}

#[derive(Clone, Debug, Default)]
pub struct Projectiles {
    list: Vec<Projectile>,
    next_id: ProjectileId,
}

impl Projectiles {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn along the aim direction, `MUZZLE_OFFSET` out so you do not shoot
    /// yourself. If that point is already inside rock the projectile still spawns
    /// there and explodes on its first step — the correct punishment for firing
    /// into a wall.
    pub fn spawn(
        &mut self,
        weapon: WeaponId,
        owner: PlayerId,
        player_centre: Vec2,
        aim: f32,
        now: f32,
    ) -> ProjectileId {
        let dir = Vec2::new(aim.cos(), aim.sin());
        let speed = def(weapon).map_or(0.0, |w| w.muzzle_speed);
        let fuse = def(weapon).and_then(|w| match w.delivery {
            Delivery::Projectile { fuse, .. } => fuse,
            _ => None,
        });
        let id = self.next_id;
        self.next_id += 1;
        self.list.push(Projectile {
            id,
            weapon,
            owner,
            pos: player_centre + dir * MUZZLE_OFFSET,
            vel: dir * speed,
            spawned_at: now,
            fuse_at: fuse.map(|f| now + f),
            age_ticks: 0,
            resting: false,
        });
        id
    }

    /// Spawn with an explicit velocity — meteors, fragments and death throws.
    pub fn spawn_raw(
        &mut self,
        weapon: WeaponId,
        owner: PlayerId,
        pos: Vec2,
        vel: Vec2,
        now: f32,
    ) -> ProjectileId {
        let id = self.next_id;
        self.next_id += 1;
        let fuse = def(weapon).and_then(|w| match w.delivery {
            Delivery::Projectile { fuse, .. } => fuse,
            _ => None,
        });
        self.list.push(Projectile {
            id,
            weapon,
            owner,
            pos,
            vel,
            spawned_at: now,
            fuse_at: fuse.map(|f| now + f),
            age_ticks: 0,
            resting: false,
        });
        id
    }

    /// Step every projectile and report what happened. The caller acts on the
    /// outcomes — this function never explodes anything itself, so `explode` stays
    /// the single primitive.
    pub fn step(
        &mut self,
        map: &Map,
        players: &[(PlayerId, Aabb)],
        wind: f32,
        now: f32,
        dt: f32,
    ) -> Vec<Impact> {
        let mut out = Vec::new();

        for p in self.list.iter_mut() {
            p.age_ticks += 1;

            // Nothing leaks: after PROJECTILE_MAX_LIFETIME it goes off wherever it is.
            if now - p.spawned_at >= PROJECTILE_MAX_LIFETIME {
                out.push(Impact {
                    id: p.id,
                    weapon: p.weapon,
                    owner: p.owner,
                    outcome: ProjectileOutcome::Exploded { at: p.pos },
                });
                continue;
            }
            // A fuse fires in mid-air if the thing never touches anything.
            if let Some(t) = p.fuse_at {
                if now >= t {
                    out.push(Impact {
                        id: p.id,
                        weapon: p.weapon,
                        owner: p.owner,
                        outcome: ProjectileOutcome::Exploded { at: p.pos },
                    });
                    continue;
                }
            }

            let Some(w) = def(p.weapon) else { continue };

            if p.resting {
                continue;
            }

            p.vel.y += GRAVITY * w.gravity_scale * dt;
            p.vel.x += wind * w.wind_scale * dt;

            // `substeps` is M2's, and it is shared for exactly one reason: when the
            // cap binds it keeps the step at 1 px and travels LESS FAR, rather than
            // dividing the delta by the capped count. Recomputing that here is how
            // this file tunnelled a rocket at 10x terminal velocity straight
            // through a 1 px wall on the first attempt.
            let (steps, step) = substeps(p.vel * dt);

            let mut outcome = ProjectileOutcome::Alive;
            for _ in 0..steps {
                let next = p.pos + step;

                // Terrain first, then players. The owner is immune for the first
                // few ticks so the muzzle offset is not needed twice.
                if solid_at(map, next.x.round() as i32, next.y.round() as i32) {
                    match w.delivery {
                        Delivery::Projectile {
                            explode_on_contact: true,
                            ..
                        } => {
                            outcome = ProjectileOutcome::Exploded { at: next };
                        }
                        Delivery::Projectile {
                            restitution,
                            friction,
                            ..
                        } => {
                            bounce(map, p, next, restitution, friction);
                        }
                        Delivery::Hitscan { .. } => {
                            outcome = ProjectileOutcome::Exploded { at: next };
                        }
                    }
                    break;
                }

                let mut hit_player = None;
                if p.age_ticks > PROJECTILE_OWNER_GRACE_TICKS {
                    for (pid, aabb) in players {
                        if aabb.contains_point(next) {
                            hit_player = Some(*pid);
                            break;
                        }
                    }
                } else {
                    for (pid, aabb) in players {
                        if *pid != p.owner && aabb.contains_point(next) {
                            hit_player = Some(*pid);
                            break;
                        }
                    }
                }
                if let Some(victim) = hit_player {
                    outcome = ProjectileOutcome::HitPlayer { at: next, victim };
                    break;
                }

                p.pos = next;
            }

            // A grenade whose speed has bled away rests until its fuse expires.
            // Without this it jitters on a slope forever, which is the classic bug
            // in this system.
            if matches!(outcome, ProjectileOutcome::Alive)
                && p.fuse_at.is_some()
                && p.vel.len() < GRENADE_REST_SPEED
                && solid_at(map, p.pos.x.round() as i32, (p.pos.y + 2.0).round() as i32)
            {
                p.resting = true;
                p.vel = Vec2::ZERO;
            }

            if outcome != ProjectileOutcome::Alive {
                out.push(Impact {
                    id: p.id,
                    weapon: p.weapon,
                    owner: p.owner,
                    outcome,
                });
            }
        }

        // The caller decides what each outcome means; the projectile is gone either
        // way, so remove everything that reported one.
        for i in &out {
            self.remove(i.id);
        }
        out
    }

    pub fn remove(&mut self, id: ProjectileId) {
        self.list.retain(|p| p.id != id);
    }

    pub fn get(&self, id: ProjectileId) -> Option<&Projectile> {
        self.list.iter().find(|p| p.id == id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Projectile> {
        self.list.iter()
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }
}

/// Reflect and damp off the estimated surface normal.
fn bounce(map: &Map, p: &mut Projectile, contact: Vec2, restitution: f32, friction: f32) {
    let n = surface_normal(map, contact);
    if n.len_sq() < 1e-6 {
        p.vel = -p.vel * restitution;
        return;
    }
    let vn = p.vel.x * n.x + p.vel.y * n.y;
    p.vel -= n * ((1.0 + restitution) * vn);
    // Vec2 has no MulAssign by a scalar; this is the tangential loss.
    p.vel = p.vel * friction;
}

/// Estimate the surface normal from the mask: the negated gradient of solid
/// density over a small neighbourhood.
pub fn surface_normal(map: &Map, at: Vec2) -> Vec2 {
    const R: i32 = 3;
    let (cx, cy) = (at.x.round() as i32, at.y.round() as i32);
    let mut acc = Vec2::ZERO;
    for dy in -R..=R {
        for dx in -R..=R {
            if dx == 0 && dy == 0 {
                continue;
            }
            if solid_at(map, cx + dx, cy + dy) {
                // Point away from solid.
                acc -= Vec2::new(dx as f32, dy as f32);
            }
        }
    }
    let l = acc.len();
    if l < 1e-6 {
        Vec2::ZERO
    } else {
        acc / l
    }
}
