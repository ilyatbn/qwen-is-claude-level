//! Melee: an arc swept around the aim angle (`docs/71-amendments-v3.md` §B6).
//!
//! Melee has **no ammo**. It is the floor of the arsenal — the thing you still
//! have when everything else is empty — so it must never be worthless, and the
//! axe and hammer carve, which makes it a digging tool as well as a weapon.
//!
//! Damage goes through the same `apply_damage` closure every other source uses,
//! so shields, i-frames and attribution are the callee's business here exactly as
//! they are for an explosion (§A24: one damage path, already tested).

use crate::constants::PLAYER_W;
use crate::map::{CarveResult, Map};
use crate::math::Vec2;
use crate::physics::collide::solid_at;
use crate::weapons::defs::WeaponDef;
use crate::weapons::explode::{BlastSource, HitId, HitTarget};

/// Spacing of the line-of-sight samples between attacker and victim.
///
/// One sample per pixel would be exact and pointless: the thinnest wall the
/// generator makes is far wider than this, and a swing is at most `reach` px
/// long, so this is a handful of lookups.
const LOS_STEP: f32 = 3.0;

#[derive(Debug, Default)]
pub struct MeleeResult {
    pub carve: Option<CarveResult>,
    /// The capsule this swing actually dug — `(mouth, tip, radius)` — so the
    /// caller **announces the shape that was carved instead of deriving one of
    /// its own**.
    ///
    /// It exists because deriving it twice went wrong the first time it could:
    /// the carve became a capsule from the body edge while `World::fire` still
    /// published `Carve { x: tip, y: tip, r }`, a circle. Clients applied the
    /// circle faithfully, and `two_clients_agree_on_the_mask_after_a_hundred_carves`
    /// — the assertion the whole client/server architecture rests on — went red.
    /// `CLAUDE.md`: *return what the caller needs*, or it will be called wrong.
    pub carve_shape: Option<(Vec2, Vec2, i32)>,
    /// victim, damage dealt, impulse applied
    pub hits: Vec<(HitId, f32, Vec2)>,
    /// Everyone this swing **threw**, whether or not it hurt them — see
    /// [`crate::weapons::explode::ExplosionResult::knocked`].
    pub knocked: Vec<HitId>,
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

/// How far from the swinger's **centre** a swing of `table_reach` actually
/// reaches (§C19).
///
/// `origin` is the swinger's centre and a target's `pos` is theirs, so a hit
/// test is centre-to-centre — which is how `axe` at 40 connected with someone
/// two and a half player-widths away who was visibly not adjacent. The number in
/// §B7's table means "how far in front of me", so the half-body between the
/// centre and the front of the swinger is added to it.
///
/// It is a function, and `swing` does **not** apply it, because three places
/// need the same answer: the hit test, the `Carve` the swing broadcasts, and the
/// arc the client draws. The first version added the half-body inside `swing`,
/// which left the other two measuring from the centre — so the server dug 8 px
/// further out than the `Carve` event it sent, every client's mask diverged from
/// the server's on every axe swing, and the drawn arc was shorter than the thing
/// that hit you. A parameter that means one thing at the call site and another
/// inside the callee is CLAUDE.md's "a field that means two things", and it cost
/// a full mask resync per swing.
pub fn effective_reach(table_reach: f32) -> f32 {
    PLAYER_W * 0.5 + table_reach
}

/// Swing `def` from `origin` along `aim`.
///
/// `reach` here is **centre-to-centre** — pass `effective_reach(table_reach)`.
/// `arc` and `knockback` come from the weapon; `damage` and `blast_radius` are
/// the shared `WeaponDef` fields, so a hammer digs and a knife does not purely
/// by having a non-zero radius.
#[allow(clippy::too_many_arguments)]
pub fn swing(
    map: &mut Map,
    players: &mut [HitTarget],
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
            if HitId::Player(owner) == p.id {
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
        if impulse.len() > 0.0 {
            out.knocked.push(p.id);
        }
        if applied {
            out.hits.push((p.id, dmg, impulse));
        }
    }

    // The swing bites the terrain **from the swinger's own edge out to the tip of
    // the arc**, as a swept capsule rather than a circle dropped at the tip.
    //
    // It was a circle at the tip until 2026-09-07, and that left a lip: the near
    // face of the hole sat at `reach - blast_radius` from the centre while the
    // body's edge is at `PLAYER_W / 2`, so a shovel dug a room you could see into
    // and could not enter, with a few pixels of untouched ground between your feet
    // and the opening. Reported from play twice.
    //
    // The sweep starts at the body edge rather than at `origin` so the rule the
    // circle was protecting still holds — a swing opens the wall it is aimed at,
    // it does not drop the swinger through the floor they are standing on.
    if def.blast_radius > 0.0 {
        let dir = Vec2::new(aim.cos(), aim.sin());
        let mouth = origin + dir * (PLAYER_W * 0.5);
        let tip = origin + dir * reach;
        let r = def.blast_radius.round() as i32;
        out.carve = Some(map.carve_capsule(
            mouth.x.round() as i32,
            mouth.y.round() as i32,
            tip.x.round() as i32,
            tip.y.round() as i32,
            r,
        ));
        out.carve_shape = Some((mouth, tip, r));
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
    /// **corrected by §B23** (T11.09's measured result) and then **re-expressed
    /// from the body edge by §C19**, which is where the current reaches come
    /// from. §B7 says of
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
        ("knife", 35.0, 0.0, 12.0, 1.0, 0.35, 60.0),
        ("bat", 28.0, 0.0, 16.0, 1.4, 0.55, 260.0),
        ("whip", 22.0, 0.0, 44.0, 0.8, 0.60, 120.0),
        ("axe", 55.0, 10.0, 16.0, 1.2, 0.90, 140.0),
        ("hammer", 70.0, 16.0, 14.0, 1.1, 1.20, 340.0),
        // §F5 — the shovel, from `docs/75`'s constants table. The five rows above
        // are **retired but not deleted**: their weapons are still
        // `Delivery::Melee` and `:228` set-matches the melee roster against this
        // table, so removing a row here would fail that assertion rather than
        // describe the game.
        // **`carve` diverges from `docs/75` deliberately**: 14 there, 16 here.
        // Raised 2026-09-07 so one dig clears `PLAYER_H` plus a margin and the
        // hole is walkable on uneven ground. `docs/` is not a builder's to edit;
        // the amendment is outstanding and this row records the gap.
        ("shovel", 30.0, 16.0, 20.0, 1.2, 0.55, 150.0),
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

    /// **This assertion was inverted by §F5 and the inversion is the deliverable.**
    ///
    /// Until T19.05 it read "every melee weapon can be found on the ground, in a
    /// crate or buried". §F5 retires knife, bat, whip, axe and hammer and gives
    /// every player a shovel at spawn, so *no* melee weapon is findable any more:
    /// the five are unobtainable on purpose and the shovel would be litter on a
    /// map where everyone already has one.
    ///
    /// The presence that replaces the old obtainability check is
    /// `t1905::every_player_spawns_holding_a_shovel` — deleting this one bare
    /// would have dropped the guard that the retired five stay unreachable, and
    /// keeping it unchanged would have asserted the opposite of the spec.
    #[test]
    fn no_melee_weapon_is_findable_and_the_retired_five_still_resolve() {
        for &(key, ..) in SPEC {
            let w = defs::by_key(key).expect("weapon");
            let d = registry::by_key(key).unwrap_or_else(|| panic!("{key} is not an item"));
            assert_eq!(d.kind, ItemKind::Weapon(w.id), "{key} points elsewhere");
            assert_eq!(
                (d.spawn_weight, d.crate_weight, d.buried_weight),
                (0, 0, 0),
                "{key} is still obtainable from the world (§F5 retires melee pickups)"
            );
            assert_eq!(d.max_stack, 1, "{key} has no ammo, so it does not stack");
        }
        // Control for the three zeroes above: a build that zeroed *every* weight
        // would satisfy them. The guns are what the retired weight went to, so at
        // least one of them must still be findable.
        let pistol = registry::by_key("pistol").expect("pistol is an item");
        assert!(
            pistol.spawn_weight > 0 || pistol.crate_weight > 0 || pistol.buried_weight > 0,
            "the whole spawn table is zeroed — the melee assertion above proves nothing"
        );
        // Ids appended, never inserted (§B16). The five are retired placeholders,
        // not deletions: `registry::def` is `ITEMS.get(id as usize)`, so removing
        // them renumbers every id above and a laser resolves as a bazooka.
        for id in [KNIFE, BAT, WHIP, AXE, HAMMER] {
            assert!(registry::def(id).is_some(), "item {id} does not resolve");
        }
    }
}

/// T13.06.2 / §C19 — reach is measured from the body edge.
#[cfg(test)]
mod t130602 {
    use super::*;
    use crate::items::registry::ItemKind;
    use crate::weapons::defs::{self, Delivery};
    use crate::weapons::explode::{BlastSource, DamageSource};

    /// A sky map, so `clear_line` never rejects a hit for terrain reasons. Every
    /// assertion below is about distance, and a rock in the way answers a
    /// different question.
    fn empty_map() -> Map {
        // Empty, not carved out of a generated map: `clear_line` is the only
        // terrain question `swing` asks, and a rock in the way answers a
        // different one from the one under test.
        crate::physics::collide::tests::test_map(1024, 768, |_| {})
    }

    fn melee_of(key: &str) -> (&'static WeaponDef, f32, f32, f32) {
        let w = defs::by_key(key).unwrap_or_else(|| panic!("{key} is a weapon"));
        match w.delivery {
            Delivery::Melee {
                reach,
                arc,
                knockback,
            } => (w, reach, arc, knockback),
            other => panic!("{key} is not melee: {other:?}"),
        }
    }

    /// Swing from (200,400) straight along +x at a target `gap` px away
    /// (centre to centre). True if it connected.
    fn hits_at(key: &str, gap: f32) -> bool {
        let (w, reach, arc, kb) = melee_of(key);
        let mut map = empty_map();
        let mut vel = Vec2::new(0.0, 0.0);
        let mut hit = false;
        let mut apply = |_d: f32, _s: DamageSource| {
            hit = true;
            true
        };
        let origin = Vec2::new(200.0, 400.0);
        let mut targets = [HitTarget {
            id: HitId::Player(1),
            w: crate::constants::PLAYER_W,
            h: crate::constants::PLAYER_H,
            pos: Vec2::new(origin.x + gap, origin.y),
            vel: &mut vel,
            alive: true,
            apply_damage: &mut apply,
        }];
        let out = swing(
            &mut map,
            &mut targets,
            origin,
            0.0,
            w,
            effective_reach(reach),
            arc,
            kb,
            BlastSource::Fired {
                owner: 0,
                weapon: match crate::items::registry::by_key(key).expect("item").kind {
                    ItemKind::Weapon(id) => id,
                    _ => unreachable!("a melee weapon is a weapon"),
                },
            },
        );
        assert_eq!(out.hits.is_empty(), !hit, "hits and the callback disagree");
        hit
    }

    /// A dig must open a hole the digger can actually walk into.
    ///
    /// Both halves come from play: the hole appeared with a **lip** of untouched
    /// ground between the body and the opening, and it was exactly `PLAYER_H`
    /// tall at its best point, so it caught on any slope.
    mod digging {
        use super::*;
        use crate::constants::{PLAYER_H, PLAYER_W};

        /// Swing `key` into solid rock at `aim = 0` (straight along `+x`) and
        /// return the map. Solid everywhere first, so **any** clear pixel
        /// afterwards is one this swing made — there is nothing to inherit.
        fn dig(key: &str) -> (Map, Vec2, f32) {
            let (w, reach, arc, kb) = melee_of(key);
            let mut map = crate::physics::collide::tests::test_map(256, 256, |m| {
                for y in 0..256 {
                    for x in 0..256 {
                        m.set(x, y);
                    }
                }
            });
            let origin = Vec2::new(128.0, 128.0);
            let mut targets: [HitTarget; 0] = [];
            swing(
                &mut map,
                &mut targets,
                origin,
                0.0,
                w,
                effective_reach(reach),
                arc,
                kb,
                BlastSource::Fired {
                    owner: 0,
                    weapon: match crate::items::registry::by_key(key).expect("item").kind {
                        ItemKind::Weapon(id) => id,
                        _ => unreachable!("a melee weapon is a weapon"),
                    },
                },
            );
            (map, origin, effective_reach(reach))
        }

        /// Clear pixels running vertically through `y` at column `x`.
        fn clear_height(map: &Map, x: i32, y: i32) -> i32 {
            if map.mask.get(x, y) {
                return 0;
            }
            let mut n = 1;
            let mut up = y - 1;
            while up >= 0 && !map.mask.get(x, up) {
                n += 1;
                up -= 1;
            }
            let mut down = y + 1;
            while down < 256 && !map.mask.get(x, down) {
                n += 1;
                down += 1;
            }
            n
        }

        /// **1a — no lip.** Every pixel from the body edge to the tip is clear.
        ///
        /// The old carve was a circle centred on the tip, so its near face sat at
        /// `reach - blast_radius` and left solid ground between there and
        /// `PLAYER_W / 2`. That gap is what this walks.
        #[test]
        fn a_shovel_leaves_no_ground_between_the_body_and_the_hole() {
            let (map, origin, reach) = dig("shovel");
            let y = origin.y.round() as i32;
            let from = (origin.x + PLAYER_W * 0.5).round() as i32;
            let to = (origin.x + reach).round() as i32;
            for x in from..=to {
                assert!(
                    !map.mask.get(x, y),
                    "solid ground at x={x}, {} px from the body edge — that is the lip a \
                     player cannot walk through",
                    x - from
                );
            }
        }

        /// **1b — tall enough, all the way along.** Not just at the tip: a hole
        /// that is player-height at one point and narrower either side is a hole
        /// you catch on.
        #[test]
        fn a_single_dig_clears_a_player_sized_opening_along_its_whole_length() {
            let (map, origin, reach) = dig("shovel");
            let y = origin.y.round() as i32;
            let from = (origin.x + PLAYER_W * 0.5).round() as i32;
            let to = (origin.x + reach).round() as i32;
            let want = PLAYER_H.round() as i32 + 2;
            for x in from..=to {
                let h = clear_height(&map, x, y);
                assert!(
                    h >= want,
                    "the opening is {h} px tall at x={x} and a player is {PLAYER_H} — \
                     wanted at least {want} so it clears on uneven ground"
                );
            }
        }

        /// The control, and it is the reason the two above are not vacuous: a
        /// weapon that does not dig leaves the same span solid. Without it both
        /// assertions are satisfied by a map that was never solid to begin with.
        #[test]
        fn a_blade_digs_nothing_on_the_same_span() {
            let (map, origin, reach) = dig("knife");
            let y = origin.y.round() as i32;
            let from = (origin.x + PLAYER_W * 0.5).round() as i32;
            let to = (origin.x + reach).round() as i32;
            for x in from..=to {
                assert!(
                    map.mask.get(x, y),
                    "the knife carved at x={x}; it has no blast radius and must not dig"
                );
            }
        }
    }

    /// The subject: the edge of the swing is `PLAYER_W / 2 + reach` from the
    /// centre, and one pixel past it is a miss.
    ///
    /// Both sides, because "a target at reach is hit" alone is satisfied by a
    /// swing with infinite reach — which is the bug being fixed.
    #[test]
    fn a_target_at_the_stated_reach_is_hit_and_one_pixel_beyond_is_not() {
        for key in ["knife", "bat", "whip", "axe", "hammer"] {
            let (_, reach, ..) = melee_of(key);
            let edge = effective_reach(reach);
            assert!(
                hits_at(key, edge - 0.5),
                "{key}: a target just inside {edge} px was missed"
            );
            assert!(
                !hits_at(key, edge + 1.0),
                "{key}: a target a pixel past {edge} px was still hit"
            );
        }
    }

    /// The falsification, as a test: the **old centre-based rule** must now be
    /// visibly wrong.
    ///
    /// Under it, a target at exactly `reach` px was the last one hit. It is now
    /// comfortably inside, and a target at `reach + PLAYER_W` — which the old
    /// rule missed by a mile — is the one at the new edge. A build that reverted
    /// to centre-measured reach fails both halves.
    #[test]
    fn the_old_centre_based_rule_would_now_fail() {
        for key in ["knife", "bat", "whip", "axe", "hammer"] {
            let (_, reach, ..) = melee_of(key);
            assert!(
                hits_at(key, reach + PLAYER_W * 0.5 - 0.5),
                "{key}: the edge is no longer PLAYER_W/2 past the table's number"
            );
            assert!(
                !hits_at(key, reach + PLAYER_W),
                "{key}: a target a whole body past the table's reach connected"
            );
        }
    }

    /// The whip's identity survives the re-expression: it still out-reaches the
    /// knife by exactly the difference in the table, because both ends gained
    /// the same half-body.
    #[test]
    fn the_whip_still_out_reaches_the_knife_by_the_table_difference() {
        let (_, whip, ..) = melee_of("whip");
        let (_, knife, ..) = melee_of("knife");
        let table = whip - knife;
        assert!(table > 0.0, "the whip must out-reach the knife");

        // Measured, not read off the constants: the smallest gap each one
        // misses at, to the nearest pixel.
        let edge_of = |key: &str| {
            let mut px = 0.0f32;
            while px < 200.0 && hits_at(key, px) {
                px += 1.0;
            }
            px
        };
        let measured = edge_of("whip") - edge_of("knife");
        assert!(
            (measured - table).abs() <= 1.0,
            "the whip out-reaches the knife by {measured} px, the table says {table}"
        );
    }

    /// Immediate proximity, stated as a number rather than as an adjective.
    ///
    /// §C19's complaint was that `axe` at 40 reached "2.5 player-widths". Every
    /// melee weapon except the whip — which is *supposed* to reach — must now
    /// connect only within about one body-width in front of the swinger.
    #[test]
    fn everything_but_the_whip_is_immediate_proximity() {
        for key in ["knife", "bat", "axe", "hammer"] {
            let (_, reach, ..) = melee_of(key);
            assert!(
                reach <= PLAYER_W,
                "{key} reaches {reach} px in front of a {PLAYER_W} px body — not proximity"
            );
        }
    }
}

/// T19.05 / §F5 — the shovel: the one melee weapon, and the one everybody has.
///
/// Named so `cargo test -p game-core --lib shovel` runs the whole module.
#[cfg(test)]
mod t1905_shovel {
    use super::*;
    use crate::constants::{
        MapScale, BASE_HEALTH, INVENTORY_SLOTS, RESPAWN_DELAY, SHOVEL_CARVE, SHOVEL_DAMAGE,
        SHOVEL_REACH, SIM_DT,
    };
    use crate::items::registry::{
        self, WeightColumn, AXE, BAT, HAMMER, ITEMS, KNIFE, SHOVEL, WHIP,
    };
    use crate::items::spawning::{assign_buried_items, place_initial, roll_item};
    use crate::items::world::WorldItems;
    use crate::map::generate;
    use crate::player::state::{DeathCause, PlayerState};
    use crate::rng::substream;
    use crate::weapons::defs;
    use crate::world::{RoundPhase, World};

    /// The six ids no map may ever place: the five §F5 retired, and the shovel,
    /// which everybody already has.
    const NEVER_SPAWNS: [crate::items::registry::ItemId; 6] =
        [KNIFE, BAT, WHIP, AXE, HAMMER, SHOVEL];

    fn held(p: &PlayerState) -> Vec<(u8, u16, u8)> {
        (0..INVENTORY_SLOTS as u8)
            .filter_map(|s| p.inventory.slot(s).map(|st| (s, st.item, st.count)))
            .collect()
    }

    // ------------------------------------------------------------ the kit

    /// §F5: "every player spawns holding it, in the first quick-bar slot".
    ///
    /// This is the **presence** that replaced the obtainability assertion in
    /// `t1105` — the shovel has all three spawn weights at zero, so nothing else
    /// in the suite would notice if joining granted nothing. That was the state
    /// of the tree when this task was picked up: `respawn` granted the kit and
    /// `PlayerState::new` did not, so a player who never died never held one.
    #[test]
    fn every_player_spawns_holding_a_shovel() {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());

        let p = w.player(0).expect("ana");
        assert_eq!(
            held(p),
            vec![(0u8, SHOVEL, 1u8)],
            "a fresh player's inventory is not exactly one shovel in slot 0"
        );
        assert_eq!(
            p.inventory.selected(),
            0,
            "the shovel is not the selected quick-bar slot"
        );

        // The control the task asks for: death clears the inventory, so the kit
        // has to be re-granted rather than inherited. Through the world's own
        // respawn path, not `PlayerState::respawn` — the seam is what was already
        // wired and the join was not.
        w.player_mut(0).expect("ana").die(DeathCause::Void, 0.0);
        for _ in 0..((RESPAWN_DELAY / SIM_DT) as i32 + 20) {
            w.step(SIM_DT);
        }
        let p = w.player(0).expect("ana");
        assert!(p.alive, "the fixture never respawned");
        assert_eq!(
            held(p),
            vec![(0u8, SHOVEL, 1u8)],
            "after a death and respawn the inventory is not exactly one shovel"
        );
    }

    /// The falsifier for the assertion above: `add` is what puts it in slot 0,
    /// and a kit granted into a full inventory would silently grant nothing.
    ///
    /// Without this, "slot 0 holds a shovel" is also satisfied by an inventory
    /// that cannot hold anything else.
    #[test]
    fn the_shovel_does_not_occupy_the_whole_inventory() {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        crate::world::give(&mut w, 0, registry::PISTOL, 1);
        let p = w.player(0).expect("ana");
        assert_eq!(
            held(p).len(),
            2,
            "a shovel plus a pistol is not two slots: {:?}",
            held(p)
        );
        assert_eq!(held(p)[0].1, SHOVEL, "the shovel left slot 0");
    }

    /// §F5: "it cannot be dropped or lost".
    ///
    /// `die` returns the stacks a corpse scatters and the world turns them into
    /// pickups. Without the exemption the shovel goes with them **and** is
    /// re-granted on respawn, so every death mints one and the floor slowly fills
    /// with shovels nobody can use. The control is in the same call: what you
    /// picked up *is* dropped, so this is an exemption and not a build that
    /// stopped dropping anything.
    #[test]
    fn death_does_not_drop_the_shovel_but_does_drop_what_was_picked_up() {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        crate::world::give(&mut w, 0, registry::BAZOOKA, 1);
        let dropped = w
            .player_mut(0)
            .expect("ana")
            .die(crate::player::state::DeathCause::Void, 0.0);
        assert_eq!(
            dropped.iter().filter(|s| s.item == SHOVEL).count(),
            0,
            "the issued shovel was dropped on death"
        );
        assert_eq!(
            dropped
                .iter()
                .filter(|s| s.item == registry::BAZOOKA)
                .count(),
            1,
            "nothing was dropped at all, so the exemption above proves nothing"
        );
    }

    // ------------------------------------------------------------ digging

    /// A world with a clear horizontal lane at `at`, and both players in it.
    ///
    /// The lane is carved rather than searched for: every assertion below is
    /// about reach or about the carve, and whatever the generator happened to put
    /// between two bodies answers a different question.
    fn lane(gap: f32) -> (World, Vec2) {
        let mut w = World::new(4242, MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "ana".into());
        w.add_player(1, 0, "bo".into());
        let at = Vec2::new(300.0, 300.0);
        w.map.carve_capsule(
            at.x as i32 - 60,
            at.y as i32,
            (at.x + gap) as i32 + 60,
            at.y as i32,
            48,
        );
        w.players[0].body.pos = at;
        w.players[1].body.pos = Vec2::new(at.x + gap, at.y);
        w.players[0].aim = crate::math::quantize_angle(0.0);
        (w, at)
    }

    fn solid_in(map: &Map, cx: i32, cy: i32, r: i32) -> u32 {
        let mut n = 0;
        for y in (cy - r)..=(cy + r) {
            for x in (cx - r)..=(cx + r) {
                if solid_at(map, x, y) {
                    n += 1;
                }
            }
        }
        n
    }

    /// A swing at a wall digs; a swing at open air does not.
    ///
    /// Through `World::fire` at the player's own aim angle, not through `swing`:
    /// the task asks for the carve to be reachable from a real swing, and the
    /// unit seam cannot tell you whether `fire_from_slot` ever reaches it.
    #[test]
    fn a_shovel_swing_digs_a_wall_and_leaves_open_air_alone() {
        let reach = effective_reach(SHOVEL_REACH);
        // Wall
        let (mut w, at) = lane(400.0);
        let tip = at + Vec2::new(reach, 0.0);
        // A block comfortably wider than the carve, so the crater is bounded by
        // SHOVEL_CARVE and not by how much rock was there.
        let block = (SHOVEL_CARVE * 2.0).ceil() as i32;
        w.map
            .fill_circle(tip.x.round() as i32, tip.y.round() as i32, block);
        let probe = block + 4;
        let before = solid_in(&w.map, tip.x as i32, tip.y as i32, probe);
        w.fire(0, 1.0).expect("the swing was refused");
        let after = solid_in(&w.map, tip.x as i32, tip.y as i32, probe);
        let removed = before - after;

        // Area of the carve **capsule**, pinned to the constants. It was a disc
        // until 2026-09-07; the swing now sweeps from the body edge out to the
        // tip, and the sweep length is exactly `SHOVEL_REACH` because the mouth
        // sits at `PLAYER_W / 2` and the tip at `PLAYER_W / 2 + SHOVEL_REACH`.
        // Generous bounds: the rasteriser is not a circle and the block is not
        // infinite. **This assertion is why the shape change could not land
        // silently** — it failed the moment the carve stopped being a disc.
        let area =
            std::f32::consts::PI * SHOVEL_CARVE * SHOVEL_CARVE + 2.0 * SHOVEL_CARVE * SHOVEL_REACH;
        assert!(
            removed as f32 > area * 0.6 && (removed as f32) < area * 1.6,
            "a swing at a wall removed {removed} px, not the ~{area:.0} px a \
             SHOVEL_CARVE ({SHOVEL_CARVE}) capsule swept {SHOVEL_REACH} px is"
        );

        // Control: the same swing where there is nothing to dig removes nothing.
        // Without it "the wall lost pixels" is also true of a build that carves
        // the whole map on every fire.
        let (mut w2, at2) = lane(400.0);
        let tip2 = at2 + Vec2::new(reach, 0.0);
        let before2 = solid_in(&w2.map, tip2.x as i32, tip2.y as i32, probe);
        assert_eq!(before2, 0, "the lane was not clear, so this proves nothing");
        w2.fire(0, 1.0).expect("the swing was refused");
        let after2 = solid_in(&w2.map, tip2.x as i32, tip2.y as i32, probe);
        assert_eq!(after2, 0, "a swing at open air created rock");
    }

    // ------------------------------------------------------------ hitting

    /// Damage dealt to player 1 by one swing across `gap`, centre to centre.
    fn swing_damage(gap: f32, wall: bool) -> f32 {
        let (mut w, at) = lane(gap);
        if wall {
            let mid = at.x + gap * 0.5;
            for dy in -40..40 {
                w.map.fill_circle(mid as i32, at.y as i32 + dy, 3);
            }
        }
        // **Past `SPAWN_IFRAMES`.** `add_player` stamps them on every joiner, so a
        // swing at t=1 lands, is logged, and deals nothing — which reads exactly
        // like a reach failure and is not one.
        let before = w.players[1].health;
        w.fire(0, crate::constants::SPAWN_IFRAMES + 1.0)
            .expect("the swing was refused");
        before - w.players[1].health
    }

    #[test]
    fn a_shovel_hits_for_shovel_damage_inside_its_reach_and_nothing_outside_it() {
        let reach = effective_reach(SHOVEL_REACH);
        assert_eq!(
            swing_damage(reach - 1.0, false),
            SHOVEL_DAMAGE,
            "a target one pixel inside the reach took the wrong damage"
        );
        assert_eq!(
            swing_damage(reach + 1.0, false),
            0.0,
            "a target one pixel beyond the reach was hit anyway"
        );
        assert_eq!(
            swing_damage(reach - 1.0, true),
            0.0,
            "a target in reach but behind a wall was hit through it"
        );
        // The victim starts at full health, or "took nothing" would be true of a
        // fixture that was already dead.
        let (w, _) = lane(reach - 1.0);
        assert_eq!(
            w.players[1].health, BASE_HEALTH,
            "the fixture's victim did not start at full health"
        );
    }

    /// §F5: "no ammo, and it cannot leave the inventory".
    #[test]
    fn a_shovel_is_never_consumed_however_many_times_it_is_swung() {
        let stack = registry::def(SHOVEL).expect("shovel").max_stack;
        let (mut w, _) = lane(400.0);
        let swings = stack as u32 * 10 + 20;
        let mut t = 1.0f32;
        for _ in 0..swings {
            w.fire(0, t).expect("the swing was refused");
            t += crate::constants::SHOVEL_COOLDOWN * 2.0;
        }
        assert_eq!(
            held(w.player(0).expect("ana")),
            vec![(0u8, SHOVEL, 1u8)],
            "{swings} swings changed the inventory (max_stack is {stack})"
        );
    }

    // ------------------------------------------------------------ spawning

    /// The task's 200-seed sweep — **with the control it is missing.**
    ///
    /// "No map spawns a knife, bat, whip, axe, hammer or shovel" is an assertion
    /// of absence, and an absence passes against a build where nothing spawns at
    /// all. That is not a hypothetical here: zeroing five weights is exactly the
    /// edit that could break the draw. So every column is also counted for the
    /// *presence*, against the share its own weight predicts — the guns and
    /// grenades that inherited the retired weight must come up at the new rate.
    ///
    /// At the draw rather than through 200 generated maps: `roll_item` is the
    /// only thing that decides *which* item a map places (the map decides where),
    /// it is what `place_initial`, the crate roll and `assign_buried_items` all
    /// call, and 200 map generations would add minutes to the suite for a weaker
    /// answer. `a_generated_map_places_items_and_none_of_them_is_melee` is the
    /// arm that ties this to a real map.
    #[test]
    fn two_hundred_seeds_never_roll_a_retired_weapon_and_still_roll_everything_else() {
        const SEEDS: u64 = 200;
        const DRAWS: u32 = 200;
        for col in [
            WeightColumn::Spawn,
            WeightColumn::Crate,
            WeightColumn::Buried,
        ] {
            let mut counts = vec![0u32; ITEMS.len()];
            for seed in 0..SEEDS {
                let mut rng = substream(seed, "items");
                for _ in 0..DRAWS {
                    counts[roll_item(&mut rng, col) as usize] += 1;
                }
            }
            let total: u32 = counts.iter().sum();
            assert_eq!(total, SEEDS as u32 * DRAWS, "draws went missing");

            for id in NEVER_SPAWNS {
                assert_eq!(
                    counts[id as usize],
                    0,
                    "{col:?} rolled {} {} times in {SEEDS} seeds",
                    registry::def(id).expect("retired item still resolves").key,
                    counts[id as usize]
                );
            }

            let w = registry::weights(col);
            let wsum: f64 = w.iter().map(|&x| x as f64).sum();
            let mut present = 0;
            for (i, d) in ITEMS.iter().enumerate() {
                if w[i] == 0 {
                    continue;
                }
                present += 1;
                let expect = total as f64 * w[i] as f64 / wsum;
                let got = counts[i] as f64;
                assert!(
                    got > expect * 0.7 && got < expect * 1.3,
                    "{col:?}: {} came up {got:.0} times against the {expect:.0} its \
                     weight {} of {wsum} predicts",
                    d.key,
                    w[i]
                );
            }
            // The control on the control: a column that lost every weight would
            // satisfy the loop above vacuously.
            assert!(
                present >= 10,
                "{col:?} has only {present} items with any weight left"
            );
        }
    }

    /// The arm that ties the draw to a real map: three generated maps place items
    /// and bury items, and none of them is melee.
    ///
    /// Three seeds and one scale, because this is the *wiring* check — that
    /// `place_initial` and `assign_buried_items` draw from the columns the sweep
    /// above exhausted. Two hundred maps here would cost minutes and add nothing.
    #[test]
    fn a_generated_map_places_items_and_none_of_them_is_melee() {
        for seed in [1u64, 4242, 31337] {
            let map = generate(seed, MapScale::Small);
            let mut items = WorldItems::new();
            place_initial(&mut items, &map, seed, 0.0);
            assert!(
                !items.is_empty(),
                "seed {seed} placed no items at all, so the absence below is vacuous"
            );
            for it in items.iter() {
                assert!(
                    !NEVER_SPAWNS.contains(&it.item),
                    "seed {seed} put {} on the ground",
                    registry::def(it.item).map_or("?", |d| d.key)
                );
            }
            let buried = assign_buried_items(&map, seed);
            assert!(
                !buried.is_empty(),
                "seed {seed} buried nothing, so the absence below is vacuous"
            );
            for b in buried {
                assert!(
                    !NEVER_SPAWNS.contains(&b),
                    "seed {seed} buried {}",
                    registry::def(b).map_or("?", |d| d.key)
                );
            }
        }
    }

    /// §B16, from the other end: the shovel took the **next free** id, and the
    /// five retired ones still resolve to themselves.
    ///
    /// `t1105` asserts they resolve; this asserts they resolve *to what they
    /// were*, which is the property §B16 is actually about — a table that
    /// renumbered would still pass an `is_some()` check.
    #[test]
    fn retiring_five_weapons_renumbered_nothing() {
        for (key, id) in [
            ("knife", KNIFE),
            ("bat", BAT),
            ("whip", WHIP),
            ("axe", AXE),
            ("hammer", HAMMER),
            ("shovel", SHOVEL),
        ] {
            let d = registry::def(id).unwrap_or_else(|| panic!("item {id} does not resolve"));
            assert_eq!(d.key, key, "item id {id} now resolves to {}", d.key);
            let crate::items::registry::ItemKind::Weapon(wid) = d.kind else {
                panic!("{key} is no longer a weapon");
            };
            let w = defs::def(wid).unwrap_or_else(|| panic!("{key} has no weapon def"));
            assert_eq!(w.key, key, "weapon id {wid:?} now resolves to {}", w.key);
        }
        assert_eq!(
            SHOVEL as usize,
            ITEMS.len() - 1,
            "the shovel is not the last entry, so it was inserted rather than appended"
        );
    }
}
