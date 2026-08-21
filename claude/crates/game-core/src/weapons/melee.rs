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

/// T11.05 — the five melee weapons (§B7).
#[cfg(test)]
mod t1105 {
    use crate::constants::INVENTORY_SLOTS;
    use crate::items::registry::{self, ItemKind, AXE, BAT, HAMMER, KNIFE, WHIP};
    use crate::weapons::defs::{self, Delivery};
    use crate::world::{give, RoundPhase, World};

    /// `(key, dmg, carve, reach, arc, cd, knockback)` — §B7's melee table as
    /// **corrected by §B23**, which is T11.09's measured result. §B7 says of
    /// itself that it is "a starting point, not a result", and the reaches are
    /// the part measurement moved: 26/34/30/28 put four of the five below half
    /// the arsenal median, and the whip at 58 — untouched — is the control that
    /// showed reach was the cause.
    ///
    /// Literals here on purpose, and this is the one place §A19's "pin to the
    /// constant, never a literal" does not apply: the job of this table is to
    /// assert that the code agrees with a *document*, and pinning it to the
    /// constants it is checking would make it compare each value to itself.
    const SPEC: &[(&str, f32, f32, f32, f32, f32, f32)] = &[
        ("knife", 35.0, 0.0, 36.0, 1.0, 0.35, 60.0),
        ("bat", 28.0, 0.0, 40.0, 1.4, 0.55, 260.0),
        ("whip", 22.0, 0.0, 58.0, 0.8, 0.60, 120.0),
        ("axe", 55.0, 10.0, 40.0, 1.2, 0.90, 140.0),
        ("hammer", 70.0, 16.0, 38.0, 1.1, 1.20, 340.0),
    ];

    /// The table is the test, and the set must match — a melee weapon with no
    /// numbers here fails rather than going silently uncovered.
    #[test]
    fn every_melee_weapon_matches_the_spec_table() {
        for &(key, dmg, carve, reach, arc, cd, kb) in SPEC {
            let w = defs::by_key(key).unwrap_or_else(|| panic!("{key} is not a weapon"));
            assert_eq!(w.damage, dmg, "{key} damage");
            assert_eq!(w.blast_radius, carve, "{key} carve");
            assert_eq!(w.cooldown, cd, "{key} cooldown");
            match w.delivery {
                Delivery::Melee {
                    reach: r,
                    arc: a,
                    knockback: k,
                } => {
                    assert_eq!(r, reach, "{key} reach");
                    assert_eq!(a, arc, "{key} arc");
                    assert_eq!(k, kb, "{key} knockback");
                }
                other => panic!("{key} is not melee: {other:?}"),
            }
        }
        let mut have: Vec<&str> = defs::WEAPONS
            .iter()
            .filter(|w| matches!(w.delivery, Delivery::Melee { .. }))
            .map(|w| w.key)
            .collect();
        let mut want: Vec<&str> = SPEC.iter().map(|&(k, ..)| k).collect();
        have.sort_unstable();
        want.sort_unstable();
        assert_eq!(have, want, "a melee weapon exists with no numbers in §B7");
    }

    /// **Melee never runs out.** It is the floor of the arsenal (§B7), and it is
    /// worthless the moment a swing costs you the weapon.
    ///
    /// This is not hypothetical: `try_fire` consumed a stack for everything that
    /// was not an energy weapon, so a knife (`max_stack: 1`) deleted itself on its
    /// first swing. Measured before the fix: `count after one swing = None`.
    #[test]
    fn a_melee_weapon_is_never_consumed_by_using_it() {
        for &(key, ..) in SPEC {
            let item = registry::by_key(key).expect("item").id;
            let mut w = World::new(4242, crate::constants::MapScale::Small);
            w.set_phase(RoundPhase::Playing);
            w.add_player(0, 0, "p".into());
            give(&mut w, 0, item, 1);
            let slot = (0..INVENTORY_SLOTS as u8)
                .find(|s| {
                    w.player(0)
                        .and_then(|p| p.inventory.slot(*s))
                        .is_some_and(|st| st.item == item)
                })
                .expect("slot");
            w.select_slot(0, slot);
            let mut t = 1.0f32;
            for _ in 0..20 {
                let _ = w.fire(0, t);
                t += 2.0; // past any cooldown in the table
            }
            let left = w
                .player(0)
                .and_then(|p| p.inventory.slot(slot))
                .map(|s| s.count);
            assert_eq!(left, Some(1), "{key} was consumed by swinging it 20 times");
        }
    }

    /// Control for the above: a *ballistic* weapon in the same harness must run
    /// dry. Without it, "melee is never consumed" also passes for a build where
    /// nothing is ever consumed.
    #[test]
    fn a_ballistic_weapon_in_the_same_harness_does_run_dry() {
        let item = registry::by_key("pistol").expect("pistol").id;
        let mut w = World::new(4242, crate::constants::MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "p".into());
        give(&mut w, 0, item, 3);
        let slot = (0..INVENTORY_SLOTS as u8)
            .find(|s| {
                w.player(0)
                    .and_then(|p| p.inventory.slot(*s))
                    .is_some_and(|st| st.item == item)
            })
            .expect("slot");
        w.select_slot(0, slot);
        let mut t = 1.0f32;
        for _ in 0..10 {
            let _ = w.fire(0, t);
            t += 2.0;
        }
        let left = w
            .player(0)
            .and_then(|p| p.inventory.slot(slot))
            .map(|s| s.count);
        assert!(
            left.is_none() || left == Some(0),
            "a pistol with 3 rounds survived 10 shots: {left:?}"
        );
    }

    /// Reach and knockback are what separate these five; the whip reaches
    /// furthest and the hammer throws hardest, and that ordering is the design.
    #[test]
    fn reach_and_knockback_are_the_axes_that_separate_them() {
        let reach = |k: &str| match defs::by_key(k).expect("w").delivery {
            Delivery::Melee { reach, .. } => reach,
            _ => unreachable!(),
        };
        let kb = |k: &str| match defs::by_key(k).expect("w").delivery {
            Delivery::Melee { knockback, .. } => knockback,
            _ => unreachable!(),
        };
        assert!(
            reach("whip") > reach("bat") && reach("bat") > reach("knife"),
            "the whip must out-reach the bat, and the bat the knife"
        );
        assert!(
            kb("hammer") > kb("bat") && kb("bat") > kb("knife"),
            "the hammer must throw harder than the bat, and the bat than the knife"
        );
        // The tools dig and the blades do not — that is what makes melee a
        // tunnelling option rather than only a last resort.
        for k in ["axe", "hammer"] {
            assert!(
                defs::by_key(k).expect("w").blast_radius > 0.0,
                "{k} must dig"
            );
        }
        for k in ["knife", "bat", "whip"] {
            assert_eq!(
                defs::by_key(k).expect("w").blast_radius,
                0.0,
                "{k} must not dig"
            );
        }
    }

    #[test]
    fn every_melee_weapon_is_an_item_you_can_find() {
        for &(key, ..) in SPEC {
            let w = defs::by_key(key).expect("weapon");
            let d = registry::by_key(key).unwrap_or_else(|| panic!("{key} is not an item"));
            assert_eq!(d.kind, ItemKind::Weapon(w.id), "{key} points elsewhere");
            assert!(
                d.spawn_weight > 0 || d.crate_weight > 0 || d.buried_weight > 0,
                "{key} can never be obtained"
            );
            assert_eq!(d.max_stack, 1, "{key} has no ammo, so it does not stack");
        }
        // Ids appended, never inserted (§B16).
        for id in [KNIFE, BAT, WHIP, AXE, HAMMER] {
            assert!(registry::def(id).is_some(), "item {id} does not resolve");
        }
    }
}
