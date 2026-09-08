//! §F1 — a bullet is a thing that flies, and what happens when it stops.
//!
//! The five ballistic guns were `Delivery::Hitscan` for six milestones and the
//! report never stopped being *"I still cannot see gun projectiles"*. The cause
//! was upstream of the renderer: a hitscan shot is a line segment that exists for
//! one instant, and `ordnance-visible` could only photograph one by **freezing
//! the frame first**. A check that has to stop time to see a thing is telling you
//! the player cannot.
//!
//! Flight lives in `projectile.rs` — a bullet is a projectile with gravity and
//! wind switched off and a `range` for a life. This module is the other half: the
//! spread draw at the muzzle, and what a stopped bullet does.
//!
//! **Why it is not `Burst::Blast`.** `explode` measures the distance from the
//! blast centre to the victim's *centre* and falls off linearly across the
//! radius. A pistol's radius is 3 px and a body is 16 × 28, so a bullet that
//! stopped on someone's chest is 10-14 px from their centre — outside its own
//! blast. Routed through `explode`, every gun in the game would deal **zero**
//! damage while every test on the table still passed. A direct hit is not a small
//! explosion, and this is the file that says so.

use crate::constants::SELF_DAMAGE_MULT;
use crate::map::carve::CarveResult;
use crate::map::Map;
use crate::math::Vec2;
use crate::rng::{range_f32, ChaCha8Rng};
use crate::weapons::defs::{Delivery, WeaponDef};
use crate::weapons::explode::{BlastSource, DamageSource, HitId, HitTarget};

/// The muzzle angle for one trigger pull, spread included.
///
/// Drawn here rather than inside `Projectiles::spawn` so the RNG stays out of the
/// flight code — `spawn` is called by the meteor shower, the toxic rain and the
/// airburst, none of which want a draw — and so the draw happens exactly once per
/// shot, at the one site that fires.
pub fn muzzle_angle(rng: &mut ChaCha8Rng, aim: f32, spread: f32) -> f32 {
    if spread <= 0.0 {
        return aim;
    }
    aim + range_f32(rng, -spread, spread)
}

/// What a stopped bullet did.
#[derive(Debug, Default)]
pub struct BulletImpact {
    /// The hole it left, when it stopped on ground.
    ///
    /// Returned rather than discarded for the reason `HitscanShot::carve` is: a
    /// 3-px bullet carve can expose a buried slot exactly as a rocket can, and
    /// only the caller can turn `revealed` into an `item_spawn`.
    pub carve: Option<CarveResult>,
    /// Who it hit, and how much it dealt. `None` when it stopped on ground.
    pub hit: Option<(HitId, f32)>,
}

/// Resolve one bullet that has stopped.
///
/// `victim` is the body the projectile step reported it actually touched — not
/// "whoever was nearest", which is a blast by another name. `None` means terrain.
///
/// Damage goes through the target's own `apply_damage` closure, which is the same
/// single path every other source uses, so shields, i-frames and attribution
/// behave identically and a bullet cannot become the one damage source that
/// skips the warmup gate.
pub fn resolve(
    map: &mut Map,
    targets: &mut [HitTarget],
    weapon: &WeaponDef,
    at: Vec2,
    victim: Option<HitId>,
    source: BlastSource,
) -> BulletImpact {
    let mut out = BulletImpact::default();

    if let Some(v) = victim {
        for t in targets.iter_mut() {
            if t.id != v || !t.alive {
                continue;
            }
            // Full damage, once. The step `break`s on the first body it touches
            // and reports one impact, so "once per shot" is structural rather
            // than a counter somebody has to keep.
            //
            // `SELF_DAMAGE_MULT` for parity with `explode`, which applies it on
            // the same `SelfInflicted` verdict from the same `for_victim`.
            // **Unreachable today** — a round spawns `MUZZLE_OFFSET` outside its
            // owner and is immune for the owner grace — and it is applied anyway
            // because the day anything makes a bullet turn round, the divergence
            // would be a self-hit costing full damage here and reduced damage
            // through every other path. Parity now is cheaper than that.
            let src = source.for_victim(v);
            let mult = if matches!(src, DamageSource::SelfInflicted { .. }) {
                SELF_DAMAGE_MULT
            } else {
                1.0
            };
            let dealt = weapon.damage * mult;
            if (t.apply_damage)(dealt, src) {
                out.hit = Some((v, dealt));
            }
        }
        // No carve: it stopped on a body, and the ground it never reached keeps
        // its pixels.
        return out;
    }

    out.carve = Some(map.carve_circle(
        at.x.round() as i32,
        at.y.round() as i32,
        weapon.blast_radius.round() as i32,
    ));
    out
}

/// Is this weapon one that fires flying rounds?
pub fn is_bullet(w: &WeaponDef) -> bool {
    matches!(w.delivery, Delivery::Bullet { .. })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        DEAGLE_DAMAGE, MACHINEGUN_SPREAD, PISTOL_BLAST_RADIUS, PISTOL_DAMAGE, PISTOL_SPREAD,
    };
    use crate::map::gen::silhouette::force_borders;
    use crate::map::{CoarseGrid, Map, MapMeta, Mask};
    use crate::rng::substream;
    use crate::weapons::defs::by_key;
    use crate::weapons::explode::DamageSource;

    fn map_with(f: impl Fn(&mut Mask)) -> Map {
        let mut mask = Mask::new_empty(1024, 512);
        f(&mut mask);
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

    /// A bullet that stops on a body deals the weapon's **full** damage.
    ///
    /// This is the test that would have caught routing a bullet through
    /// `Burst::Blast`: with `explode`'s falloff a pistol deals 0.6 of its 14 at
    /// the edge of a body, and every table test still passes.
    #[test]
    fn a_hit_deals_full_damage_not_a_blast_falloff() {
        let mut map = map_with(|_| {});
        let w = by_key("pistol").expect("pistol");
        let mut vel = Vec2::ZERO;
        let mut dealt = Vec::new();
        let mut apply = |amount: f32, _src: DamageSource| {
            dealt.push(amount);
            true
        };
        let mut targets = vec![HitTarget {
            id: HitId::Player(1),
            pos: Vec2::new(300.0, 256.0),
            w: crate::constants::PLAYER_W,
            h: crate::constants::PLAYER_H,
            vel: &mut vel,
            alive: true,
            apply_damage: &mut apply,
        }];
        // Stopped on the body's EDGE, which is where a bullet actually stops —
        // 13 px from the centre, well outside a 3 px blast.
        let at = Vec2::new(300.0 - crate::constants::PLAYER_W / 2.0, 256.0 - 5.0);
        let r = resolve(
            &mut map,
            &mut targets,
            w,
            at,
            Some(HitId::Player(1)),
            BlastSource::Fired {
                owner: 0,
                weapon: w.id,
            },
        );
        drop(targets);
        assert_eq!(dealt, vec![PISTOL_DAMAGE], "a hit is the weapon's damage");
        assert_eq!(r.hit, Some((HitId::Player(1), PISTOL_DAMAGE)));
        assert!(r.carve.is_none(), "a bullet that stopped on a body carved");
    }

    /// A hit is applied to the body it touched and to nobody else — a bullet is
    /// not a small explosion, and a bystander one pixel away takes nothing.
    #[test]
    fn only_the_body_it_touched_is_hurt() {
        let mut map = map_with(|_| {});
        let w = by_key("deagle").expect("deagle");
        let (mut v0, mut v1) = (Vec2::ZERO, Vec2::ZERO);
        let (mut hits0, mut hits1) = (Vec::new(), Vec::new());
        {
            let mut a0 = |amount: f32, _s: DamageSource| {
                hits0.push(amount);
                true
            };
            let mut a1 = |amount: f32, _s: DamageSource| {
                hits1.push(amount);
                true
            };
            let mut targets = vec![
                HitTarget {
                    id: HitId::Player(0),
                    pos: Vec2::new(300.0, 256.0),
                    w: crate::constants::PLAYER_W,
                    h: crate::constants::PLAYER_H,
                    vel: &mut v0,
                    alive: true,
                    apply_damage: &mut a0,
                },
                HitTarget {
                    id: HitId::Player(1),
                    pos: Vec2::new(301.0, 256.0),
                    w: crate::constants::PLAYER_W,
                    h: crate::constants::PLAYER_H,
                    vel: &mut v1,
                    alive: true,
                    apply_damage: &mut a1,
                },
            ];
            resolve(
                &mut map,
                &mut targets,
                w,
                Vec2::new(300.0, 256.0),
                Some(HitId::Player(0)),
                BlastSource::Fired {
                    owner: 9,
                    weapon: w.id,
                },
            );
        }
        assert_eq!(hits0, vec![DEAGLE_DAMAGE]);
        assert!(
            hits1.is_empty(),
            "a bystander 1 px away took {hits1:?} from a bullet that hit someone else"
        );
    }

    /// A terrain stop carves `blast_radius` and damages nobody.
    #[test]
    fn a_terrain_stop_carves_and_hurts_nobody() {
        let mut map = map_with(|m| {
            for y in 200..300 {
                for x in 500..520 {
                    m.set(x, y);
                }
            }
        });
        let w = by_key("pistol").expect("pistol");
        let mut vel = Vec2::ZERO;
        let mut dealt = Vec::new();
        let before = map.mask.count_solid();
        {
            let mut apply = |amount: f32, _s: DamageSource| {
                dealt.push(amount);
                true
            };
            let mut targets = vec![HitTarget {
                id: HitId::Player(1),
                pos: Vec2::new(505.0, 250.0),
                w: crate::constants::PLAYER_W,
                h: crate::constants::PLAYER_H,
                vel: &mut vel,
                alive: true,
                apply_damage: &mut apply,
            }];
            let r = resolve(
                &mut map,
                &mut targets,
                w,
                Vec2::new(501.0, 250.0),
                None,
                BlastSource::Fired {
                    owner: 0,
                    weapon: w.id,
                },
            );
            assert!(r.carve.is_some());
            assert!(r.hit.is_none());
        }
        assert!(
            dealt.is_empty(),
            "a bullet that hit a wall damaged a player standing behind it"
        );
        let removed = before - map.mask.count_solid();
        assert!(removed > 0, "a bullet hit a wall and left no mark");
        // Pinned to the constant at both ends: a 3 px disc, not a rocket's crater.
        let area = std::f32::consts::PI * PISTOL_BLAST_RADIUS * PISTOL_BLAST_RADIUS;
        assert!(
            (removed as f32) <= area * 1.6,
            "a pistol removed {removed} px, far more than a {PISTOL_BLAST_RADIUS} px disc"
        );
    }

    /// Zero spread is exactly straight; a spread weapon stays inside its bound,
    /// actually spreads, and repeats from its seed.
    #[test]
    fn the_muzzle_angle_is_bounded_and_deterministic() {
        let draws = |seed: u64, spread: f32, n: usize| {
            let mut rng = substream(seed, "muzzle");
            (0..n)
                .map(|_| muzzle_angle(&mut rng, 0.0, spread))
                .collect::<Vec<_>>()
        };
        for a in draws(3, 0.0, 50) {
            assert_eq!(a, 0.0, "zero spread must be exactly straight, got {a}");
        }
        let mg = draws(11, MACHINEGUN_SPREAD, 1000);
        for a in &mg {
            assert!(
                a.abs() <= MACHINEGUN_SPREAD + 1e-6,
                "strayed to {a} beyond ±{MACHINEGUN_SPREAD}"
            );
        }
        // A bound test alone passes for a weapon whose spread silently became 0.
        let moved = mg.iter().filter(|a| a.abs() > 1e-9).count();
        assert!(moved > 900, "only {moved} of 1000 draws deviated");
        assert_eq!(draws(11, PISTOL_SPREAD, 100), draws(11, PISTOL_SPREAD, 100));
        assert_ne!(draws(12, PISTOL_SPREAD, 100), draws(11, PISTOL_SPREAD, 100));
    }

    /// A self-hit is scaled by `SELF_DAMAGE_MULT`, exactly as a blast is.
    ///
    /// **This test rules out nothing today.** `SELF_DAMAGE_MULT` is 1.0, so
    /// deleting the multiplier from `resolve` leaves it green — it was run that
    /// way and confirmed. It is pinned to the constant at both ends rather than
    /// to 45.0, so it becomes a real assertion the moment the constant moves off
    /// 1.0, and a future non-1.0 value cannot land applied in `explode` and
    /// missing here.
    ///
    /// The branch is also unreachable in the shipped game — the muzzle offset and
    /// the owner grace see to that — which is why it tests `resolve` directly.
    /// Two reasons it proves less than it looks like it does, both written down
    /// rather than left for the next reader to discover.
    #[test]
    fn a_self_hit_is_reduced_the_same_way_a_blast_is() {
        let mut map = map_with(|_| {});
        let w = by_key("deagle").expect("deagle");
        let mut vel = Vec2::ZERO;
        let mut dealt = Vec::new();
        let mut sources = Vec::new();
        {
            let mut apply = |amount: f32, src: DamageSource| {
                dealt.push(amount);
                sources.push(src);
                true
            };
            let mut targets = vec![HitTarget {
                id: HitId::Player(3),
                pos: Vec2::new(300.0, 256.0),
                w: crate::constants::PLAYER_W,
                h: crate::constants::PLAYER_H,
                vel: &mut vel,
                alive: true,
                apply_damage: &mut apply,
            }];
            // Owner 3 hitting player 3: `for_victim` calls that self-inflicted.
            resolve(
                &mut map,
                &mut targets,
                w,
                Vec2::new(300.0, 256.0),
                Some(HitId::Player(3)),
                BlastSource::Fired {
                    owner: 3,
                    weapon: w.id,
                },
            );
        }
        assert!(matches!(sources[0], DamageSource::SelfInflicted { .. }));
        assert_eq!(
            dealt,
            vec![DEAGLE_DAMAGE * crate::constants::SELF_DAMAGE_MULT],
            "a self-hit did not scale by SELF_DAMAGE_MULT — `explode` does, and \
             the two damage paths must not disagree"
        );
        // The control: the same shot from anyone else is not reduced.
        let mut vel2 = Vec2::ZERO;
        let mut other = Vec::new();
        {
            let mut apply = |amount: f32, _s: DamageSource| {
                other.push(amount);
                true
            };
            let mut targets = vec![HitTarget {
                id: HitId::Player(3),
                pos: Vec2::new(300.0, 256.0),
                w: crate::constants::PLAYER_W,
                h: crate::constants::PLAYER_H,
                vel: &mut vel2,
                alive: true,
                apply_damage: &mut apply,
            }];
            resolve(
                &mut map,
                &mut targets,
                w,
                Vec2::new(300.0, 256.0),
                Some(HitId::Player(3)),
                BlastSource::Fired {
                    owner: 4,
                    weapon: w.id,
                },
            );
        }
        assert_eq!(other, vec![DEAGLE_DAMAGE]);
    }

    /// The auto set is exactly the two automatics (§F3).
    #[test]
    fn only_the_automatics_are_auto() {
        let auto: Vec<&str> = crate::weapons::defs::WEAPONS
            .iter()
            .filter(|w| matches!(w.delivery, Delivery::Bullet { auto: true, .. }))
            .map(|w| w.key)
            .collect();
        assert_eq!(auto, vec!["smg", "machinegun"]);
        // The control: the semi-autos are not, and the field is what §F3's client
        // repeat will read — it is set here and consumed there.
        for key in ["pistol", "revolver", "deagle"] {
            assert!(
                matches!(
                    by_key(key).expect(key).delivery,
                    Delivery::Bullet { auto: false, .. }
                ),
                "{key} fires on hold and should not"
            );
        }
    }
}
