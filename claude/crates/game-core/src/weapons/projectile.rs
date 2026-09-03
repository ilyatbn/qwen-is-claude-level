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
use crate::weapons::defs::{def, Burst, Delivery};
use crate::weapons::explode::HitId;

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
    /// Path length flown so far, in px.
    ///
    /// A bullet's life is a **distance** (`range`), not a time (§F1), and the
    /// distance has to be the one it actually flew: `speed × elapsed` is the same
    /// number only for something that never bounces and never changes speed, and
    /// encoding that assumption here would make the first projectile that does
    /// either silently immortal.
    pub travelled: f32,
    /// Has this ever been travelling upward?
    ///
    /// An airburst bursts the first tick it stops rising, and "stops rising" is
    /// not the same as "crossed zero under gravity": clipping a ceiling zeroes the
    /// velocity outright, and a sign-change test misses it. That case lands the
    /// grenade as a dud, which §B7 says must not happen.
    pub rose: bool,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ProjectileOutcome {
    Alive,
    Exploded {
        at: Vec2,
    },
    /// Stopped on a body. **`HitId`, not `PlayerId`**: birds are damageable by
    /// every weapon path there is (§C16) and they get there by sharing the target
    /// slice — an id that means two things is how a bird ends up scored as a
    /// player.
    Hit {
        at: Vec2,
        victim: HitId,
    },
    /// A bullet that flew its `range` without touching anything (§F1).
    ///
    /// **Gone, not detonated**, and distinct from `Voided` because the two are
    /// different facts: one left the map, the other ran out of range. A spent
    /// round carves nothing and hurts nobody — it is the end of a trajectory, not
    /// an impact, and `Exploded` here would put a free 3-px hole at the end of
    /// every missed shot.
    Spent {
        at: Vec2,
    },
    /// Fell out of the bottom of the world (§C15). **Gone, not detonated.**
    ///
    /// Distinct from `Exploded` because the difference is the whole point: a
    /// rocket that leaves the map must not carve or damage anything on its way
    /// out, and `Exploded { at }` below the map would ask `carve_circle` and
    /// `explode` to do exactly that. `carve_circle` would reject the centre and
    /// `explode` would find nobody down there, so the bug would be invisible
    /// until a player stood near the bottom edge.
    Voided {
        at: Vec2,
    },
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
            travelled: 0.0,
            resting: false,
            rose: false,
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
            travelled: 0.0,
            resting: false,
            rose: false,
        });
        id
    }

    /// Step every projectile and report what happened. The caller acts on the
    /// outcomes — this function never explodes anything itself, so `explode` stays
    /// the single primitive.
    /// `players` is every body a projectile can stop on. `birds` is every body a
    /// **bullet** can stop on and nothing else can.
    ///
    /// Two slices rather than one, and the split is the whole decision: §C16 says
    /// a bird stops a bullet, and it always has — that behaviour predates §F1 and
    /// must survive the guns becoming projectiles. But a rocket has never stopped
    /// on a bird; it flies past and the blast catches it. Merging the slices would
    /// silently make a grenade bounce off a seagull and a meteor stop dead in the
    /// air, which is a gameplay change nobody asked for hiding inside a rendering
    /// fix.
    pub fn step(
        &mut self,
        map: &Map,
        players: &[(HitId, Aabb)],
        birds: &[(HitId, Aabb)],
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

            // Out of the bottom of the world (§C15). Before the physics, so a
            // projectile that left the map on the previous step does no further
            // work — and before the fuse, so a grenade cannot detonate from
            // somewhere no player can be.
            //
            // Only the bottom. Ordnance goes *up* through `y = 0` constantly —
            // that is what an arc is — and it comes back down; despawning there
            // would delete every mortar shot at the top of its flight.
            if p.pos.y > map.mask.h as f32 {
                out.push(Impact {
                    id: p.id,
                    weapon: p.weapon,
                    owner: p.owner,
                    outcome: ProjectileOutcome::Voided { at: p.pos },
                });
                continue;
            }

            let Some(w) = def(p.weapon) else { continue };

            if p.resting {
                continue;
            }

            // §F1: a bullet flies **straight**. `integrate` is where that is
            // decided, for both terms — see its doc comment for why it is not
            // inline.
            let straight = matches!(w.delivery, Delivery::Bullet { .. });
            // §F10.1. See the body test below.
            let ends_only_on_its_timer = matches!(w.burst, Burst::Flame);

            p.rose |= p.vel.y < 0.0;
            // Gravity now; wind after the apex check, which is the order the
            // airburst depends on.
            p.vel.y = integrate(p.vel, w.delivery, w.gravity_scale, 0.0, 0.0, dt).y;

            // An airburst goes off the first tick it stops climbing (§B7) —
            // whether that is the top of its arc or a ceiling it just clipped.
            // Detecting the *sign change* instead misses the ceiling, because the
            // bounce sets the velocity to zero rather than crossing through it, and
            // the grenade then falls and lands as a dud.
            if matches!(w.burst, Burst::Pellets { .. }) && p.rose && p.vel.y >= 0.0 {
                out.push(Impact {
                    id: p.id,
                    weapon: p.weapon,
                    owner: p.owner,
                    outcome: ProjectileOutcome::Exploded { at: p.pos },
                });
                continue;
            }

            p.vel.x = integrate(p.vel, w.delivery, 0.0, w.wind_scale, wind, dt).x;

            // `substeps` is M2's, and it is shared for exactly one reason: when the
            // cap binds it keeps the step at 1 px and travels LESS FAR, rather than
            // dividing the delta by the capped count. Recomputing that here is how
            // this file tunnelled a rocket at 10x terminal velocity straight
            // through a 1 px wall on the first attempt.
            let (steps, step) = substeps(p.vel * dt);
            let step_len = step.len();

            let grace_ticks = PROJECTILE_OWNER_GRACE_TICKS;
            let mut outcome = ProjectileOutcome::Alive;
            for _ in 0..steps {
                // A bullet's life is its `range` (§F1). Checked before the move,
                // so it stops **at** the range rather than one substep past it,
                // and reported as `Spent` — no carve, no damage, no blast.
                if straight && p.travelled >= w.range {
                    outcome = ProjectileOutcome::Spent { at: p.pos };
                    break;
                }
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
                        // Melee, Cone and Placed never become projectiles, so
                        // nothing here can be reached by them. Named rather than
                        // caught by `_` so adding a delivery is a compile error
                        // at every site that decides what a weapon does.
                        Delivery::Melee { .. }
                        | Delivery::Cone { .. }
                        | Delivery::Placed { .. } => {
                            outcome = ProjectileOutcome::Exploded { at: next };
                        }
                        Delivery::Projectile {
                            restitution,
                            friction,
                            ..
                        } => {
                            bounce(map, p, next, restitution, friction);
                        }
                        // A bullet stops dead and marks the wall — §F1 keeps the
                        // carve the hitscan round had, so sustained fire still
                        // tunnels.
                        Delivery::Bullet { .. } | Delivery::Hitscan { .. } => {
                            outcome = ProjectileOutcome::Exploded { at: next };
                        }
                    }
                    break;
                }

                // The owner is immune for the first few ticks so the muzzle
                // offset is not needed twice.
                let owned_by_shooter =
                    |id: &HitId| *id == HitId::Player(p.owner) && p.age_ticks <= grace_ticks;
                let mut hit = None;
                // §F10.1: **a flame does not die on contact.** Its only end is
                // `FLAME_LIFE`, which is what makes it area denial rather than a
                // hit — so it flies *through* a body and keeps burning whoever
                // is standing in it. Every other projectile stops on the first
                // one it touches, and a flame that did too would be extinguished
                // by the person it set on fire.
                //
                // Keyed on `Burst::Flame` rather than on the weapon id, so the
                // property belongs to "its end is its own timer" rather than to
                // one row of the table.
                if !ends_only_on_its_timer {
                    for (id, aabb) in players {
                        if !owned_by_shooter(id) && aabb.contains_point(next) {
                            hit = Some(*id);
                            break;
                        }
                    }
                }
                // §C16: a bird stops a bullet, and only a bullet.
                if hit.is_none() && straight {
                    for (id, aabb) in birds {
                        if aabb.contains_point(next) {
                            hit = Some(*id);
                            break;
                        }
                    }
                }
                if let Some(victim) = hit {
                    outcome = ProjectileOutcome::Hit { at: next, victim };
                    break;
                }

                p.pos = next;
                p.travelled += step_len;
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

/// One tick of velocity change: gravity, then wind.
///
/// Pulled out of `step` so §F1's rule is reachable by a test with a **non-zero**
/// `gravity_scale`. Inside `step` the only bullets available are the table's,
/// whose scales are already 0.0 — so disabling the guard there changed nothing
/// and the test named after it was pinning the table, not the rule.
///
/// A bullet ignores both terms, and that is decided here rather than trusted to
/// two zeroes in the weapon table: a player's model of a gun is a line from the
/// barrel to the thing they are pointing at, and an arc they cannot predict is
/// indistinguishable from a miss.
pub fn integrate(
    vel: Vec2,
    delivery: Delivery,
    gravity_scale: f32,
    wind_scale: f32,
    wind: f32,
    dt: f32,
) -> Vec2 {
    if matches!(delivery, Delivery::Bullet { .. }) {
        return vel;
    }
    Vec2::new(
        vel.x + wind * wind_scale * dt,
        vel.y + GRAVITY * gravity_scale * dt,
    )
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

/// Where a thrown weapon will actually land — T11.15, §B26.
///
/// The bot's throw guard used to test the distance to its *target*. A molotov is
/// ballistic: thrown uphill, or into a rise, it falls short **onto the thrower**,
/// and no target-distance guard can see that. This walks the arc instead.
///
/// `docs/22-aiming-crosshair.md` §6 describes a client-side trajectory preview on
/// the same constants — it was never built, so there was no existing
/// implementation to share. What is shared instead is everything that decides
/// where a projectile goes: a real `Projectile`, M2's `substeps`, the same
/// `bounce`, the same resting rule, and the same fuse and apex checks in the same
/// order `step` applies them. The first version of this ignored bouncing and was
/// **44 px out on smoke within a minute**, which is why
/// `prediction_agrees_with_the_simulation` exists — a predictor that disagrees
/// with the simulation is worse than none, because the bot refuses safe throws
/// and takes unsafe ones with equal confidence.
///
/// Players are deliberately not modelled: the guard asks "where does the hazard
/// land", and a body in the way only ever makes it land *sooner*, which is the
/// safe direction to be wrong in.
///
/// `None` means it was still flying after `max_ticks`. A caller should read that
/// as "do not throw" — it does not know where the hazard ends up.
pub fn predict_impact(
    map: &Map,
    weapon: WeaponId,
    from: Vec2,
    aim: f32,
    wind: f32,
    max_ticks: u32,
    dt: f32,
) -> Option<Vec2> {
    let w = def(weapon)?;
    let dir = Vec2::new(aim.cos(), aim.sin());
    let fuse = match w.delivery {
        Delivery::Projectile { fuse, .. } => fuse,
        _ => None,
    };
    let mut p = Projectile {
        id: 0,
        weapon,
        owner: 0,
        pos: from + dir * MUZZLE_OFFSET,
        vel: dir * w.muzzle_speed,
        spawned_at: 0.0,
        fuse_at: fuse,
        age_ticks: 0,
        travelled: 0.0,
        resting: false,
        rose: false,
    };

    for t in 0..max_ticks {
        // `step` advances the clock before it looks at the projectile, so the
        // comparison is against the tick that has just begun.
        let now = (t + 1) as f32 * dt;
        if now >= PROJECTILE_MAX_LIFETIME {
            return Some(p.pos);
        }
        if let Some(f) = p.fuse_at {
            if now >= f {
                return Some(p.pos);
            }
        }
        if p.resting {
            continue;
        }
        p.age_ticks += 1;
        p.rose |= p.vel.y < 0.0;
        p.vel.y += GRAVITY * w.gravity_scale * dt;
        if matches!(w.burst, Burst::Pellets { .. }) && p.rose && p.vel.y >= 0.0 {
            return Some(p.pos);
        }
        p.vel.x += wind * w.wind_scale * dt;

        let (steps, step) = substeps(p.vel * dt);
        for _ in 0..steps {
            let next = p.pos + step;
            if solid_at(map, next.x.round() as i32, next.y.round() as i32) {
                match w.delivery {
                    Delivery::Projectile {
                        explode_on_contact: true,
                        ..
                    } => return Some(next),
                    Delivery::Projectile {
                        restitution,
                        friction,
                        ..
                    } => {
                        bounce(map, &mut p, next, restitution, friction);
                    }
                    // Melee, Cone, Placed and Hitscan never fly. Named rather
                    // than caught by `_` so a new delivery is a compile error
                    // here too.
                    Delivery::Melee { .. }
                    | Delivery::Cone { .. }
                    | Delivery::Placed { .. }
                    | Delivery::Hitscan { .. }
                    | Delivery::Bullet { .. } => return Some(next),
                }
                break;
            }
            p.pos = next;
        }

        if p.fuse_at.is_some()
            && p.vel.len() < GRENADE_REST_SPEED
            && solid_at(map, p.pos.x.round() as i32, (p.pos.y + 2.0).round() as i32)
        {
            p.resting = true;
            p.vel = Vec2::ZERO;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        BAZOOKA_MUZZLE_SPEED, DEAGLE_MUZZLE_SPEED, PISTOL_MUZZLE_SPEED, PISTOL_RANGE, SIM_DT,
        SMG_MUZZLE_SPEED,
    };
    use crate::map::gen::silhouette::force_borders;
    use crate::map::{CoarseGrid, Map, MapMeta, Mask};
    use crate::weapons::defs::by_key;

    fn empty_map() -> Map {
        let mut mask = Mask::new_empty(2048, 512);
        force_borders(&mut mask);
        let coarse = CoarseGrid::build(&mask);
        Map::from_parts(
            mask,
            coarse,
            MapMeta {
                seed: 1,
                requested_seed: 1,
                attempts: 1,
                used_safe_preset: false,
                scale: crate::constants::MapScale::Small,
                theme: 0,
                spawn_points: Vec::new(),
                teleport_pads: Vec::new(),
                surface_points: Vec::new(),
                objects: Vec::new(),
                buried_slots: Vec::new(),
                decorations: Vec::new(),
                wind: 0.0,
                traversable_fraction: 1.0,
                largest_component: Vec::new(),
            },
        )
    }

    /// Fly one shot until it reports something, with a bird box in the way.
    fn fly_at_a_bird(key: &str) -> Option<ProjectileOutcome> {
        let map = empty_map();
        let w = by_key(key).expect(key);
        let mut pr = Projectiles::new();
        let from = Vec2::new(200.0, 256.0);
        pr.spawn(w.id, 0, from, 0.0, 0.0);
        let bird = [(
            HitId::Bird(7),
            Aabb::from_center_size(Vec2::new(400.0, 256.0), 20.0, 14.0),
        )];
        for i in 0..120 {
            let now = i as f32 * SIM_DT;
            // A strong wind, to prove a bullet ignores it and a rocket does not.
            if let Some(im) = pr
                .step(&map, &[], &bird, 400.0, now, SIM_DT)
                .into_iter()
                .next()
            {
                return Some(im.outcome);
            }
        }
        None
    }

    /// §C16, carried across §F1: a bird stops a bullet.
    #[test]
    fn a_bullet_stops_on_a_bird() {
        match fly_at_a_bird("smg") {
            Some(ProjectileOutcome::Hit {
                victim: HitId::Bird(7),
                at,
            }) => {
                assert!(
                    (at.x - 400.0).abs() < 20.0,
                    "stopped at {at:?}, not on the bird"
                );
            }
            other => panic!("an smg round did not stop on a bird: {other:?}"),
        }
    }

    /// The control, and the reason the bird slice is separate: **a rocket does
    /// not**. It never has — a rocket flies past and the blast catches the bird.
    /// One shared slice would have made a grenade bounce off a seagull, and no
    /// existing test would have said a word.
    #[test]
    fn a_rocket_does_not_stop_on_a_bird() {
        let out = fly_at_a_bird("bazooka");
        assert!(
            !matches!(
                out,
                Some(ProjectileOutcome::Hit {
                    victim: HitId::Bird(_),
                    ..
                })
            ),
            "a rocket stopped on a bird: {out:?}"
        );
    }

    /// §F1's rule, with the guard as the **only** thing enforcing it.
    ///
    /// `gravity_scale` 1.0 and `wind_scale` 1.0 on a `Bullet`, against a real
    /// wind: every term that could bend the line is switched on, so the flat
    /// result comes from the delivery check and from nothing else. Disabling
    /// that check turns this red.
    ///
    /// This is the test `a_bullet_flies_straight_through_gravity_and_wind` was
    /// supposed to be. That one flies the table's pistol, whose scales are
    /// already 0.0, so deleting the guard left it green — it pins the table.
    /// Both are kept: one says the rule holds, the other says the data agrees.
    #[test]
    fn the_guard_is_what_keeps_a_bullet_flat_not_the_table() {
        let bullet = Delivery::Bullet {
            spread: 0.0,
            auto: false,
        };
        let rocket = Delivery::Projectile {
            fuse: None,
            restitution: 0.0,
            friction: 0.0,
            explode_on_contact: true,
        };
        let v = Vec2::new(900.0, 0.0);
        // Every term on, and the bullet still comes out unchanged.
        let after = integrate(v, bullet, 1.0, 1.0, 400.0, SIM_DT);
        assert_eq!(after, v, "a bullet was bent by gravity or wind");
        // The control, on the same numbers: the rocket is bent by both.
        let bent = integrate(v, rocket, 1.0, 1.0, 400.0, SIM_DT);
        assert!(
            bent.y > 0.0,
            "the control was not pulled down — no gravity term"
        );
        assert!(
            bent.x > v.x,
            "the control was not pushed along — no wind term"
        );
    }

    /// The table agrees with the rule: the shipped bullets carry zero scales, and
    /// a real flight through a crosswind stays flat.
    ///
    /// **This one cannot detect the guard** — the pistol's scales are already 0.0,
    /// so it passes with the guard deleted. That is what
    /// `the_guard_is_what_keeps_a_bullet_flat_not_the_table` is for; this is the
    /// end-to-end companion, and its name says what it pins.
    #[test]
    fn the_shipped_bullets_fly_flat_through_a_crosswind() {
        let map = empty_map();
        let mut pr = Projectiles::new();
        let from = Vec2::new(100.0, 256.0);
        let bullet = pr.spawn(by_key("pistol").expect("pistol").id, 0, from, 0.0, 0.0);
        let rocket = pr.spawn(by_key("bazooka").expect("bazooka").id, 0, from, 0.0, 0.0);
        for i in 0..30 {
            let now = i as f32 * SIM_DT;
            pr.step(&map, &[], &[], 400.0, now, SIM_DT);
        }
        let b = pr.get(bullet).expect("the bullet stopped in open air");
        assert_eq!(
            b.pos.y,
            from.y,
            "a bullet fell {} px in half a second",
            b.pos.y - from.y
        );
        assert_eq!(b.vel.y, 0.0, "a bullet picked up vertical velocity");
        // The control, in the same flight: the rocket did both.
        let r = pr.get(rocket).expect("the rocket stopped in open air");
        assert!(
            r.pos.y > from.y,
            "the control rocket did not fall — the fixture is not applying gravity"
        );
        assert!(
            r.vel.x > BAZOOKA_MUZZLE_SPEED,
            "the control rocket was not pushed by the wind"
        );
    }

    /// A bullet's life is a distance, and `travelled` is the distance it flew.
    #[test]
    fn a_bullet_is_spent_at_its_range() {
        let map = empty_map();
        let w = by_key("pistol").expect("pistol");
        let mut pr = Projectiles::new();
        let from = Vec2::new(100.0, 256.0);
        pr.spawn(w.id, 0, from, 0.0, 0.0);
        let mut end = None;
        for i in 0..600 {
            let now = i as f32 * SIM_DT;
            for im in pr.step(&map, &[], &[], 0.0, now, SIM_DT) {
                end = Some(im.outcome);
            }
            if end.is_some() {
                break;
            }
        }
        match end {
            Some(ProjectileOutcome::Spent { at }) => {
                let flown = at.x - from.x;
                assert!(
                    (flown - PISTOL_RANGE).abs() <= MUZZLE_OFFSET + PISTOL_MUZZLE_SPEED * SIM_DT,
                    "spent after {flown} px against a range of {PISTOL_RANGE}"
                );
            }
            other => panic!("a pistol round in open air ended as {other:?}"),
        }
    }

    /// Speeds are what make a bullet visible, so the flight has to match them.
    #[test]
    fn time_to_target_matches_the_muzzle_speed() {
        for (key, speed) in [
            ("smg", SMG_MUZZLE_SPEED),
            ("deagle", DEAGLE_MUZZLE_SPEED),
            ("pistol", PISTOL_MUZZLE_SPEED),
        ] {
            let map = empty_map();
            let w = by_key(key).expect(key);
            let mut pr = Projectiles::new();
            let from = Vec2::new(100.0, 256.0);
            let id = pr.spawn(w.id, 0, from, 0.0, 0.0);
            const DISTANCE: f32 = 300.0;
            let mut ticks = 0;
            for i in 0..600 {
                let now = i as f32 * SIM_DT;
                pr.step(&map, &[], &[], 0.0, now, SIM_DT);
                ticks += 1;
                match pr.get(id) {
                    Some(p) if p.pos.x - from.x >= DISTANCE => break,
                    Some(_) => {}
                    None => panic!("{key} vanished before it had flown {DISTANCE} px"),
                }
            }
            let want = (DISTANCE - MUZZLE_OFFSET) / speed;
            let got = ticks as f32 * SIM_DT;
            assert!(
                (got - want).abs() <= SIM_DT * 1.5,
                "{key} took {got}s to fly {DISTANCE} px, expected {want}s at {speed} px/s"
            );
        }
    }
}
