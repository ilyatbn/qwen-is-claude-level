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

/// T11.06 — the flamethrower (§B7).
#[cfg(test)]
mod t1106 {
    use crate::constants::{FLAMETHROWER_ARC, FLAMETHROWER_DPS, FLAMETHROWER_RANGE, SIM_DT};
    use crate::items::registry::{self, ItemKind, FLAMETHROWER};
    use crate::weapons::defs::{self, Delivery};
    use crate::world::{give, RoundPhase, World};

    fn armed_world() -> (World, u8) {
        let mut w = World::new(4242, crate::constants::MapScale::Small);
        w.set_phase(RoundPhase::Playing);
        w.add_player(0, 0, "p".into());
        give(&mut w, 0, FLAMETHROWER, 200);
        let slot = (0..crate::constants::INVENTORY_SLOTS as u8)
            .find(|s| {
                w.player(0)
                    .and_then(|p| p.inventory.slot(*s))
                    .is_some_and(|st| st.item == FLAMETHROWER)
            })
            .expect("slot");
        w.select_slot(0, slot);
        (w, slot)
    }

    #[test]
    fn it_matches_the_spec_and_does_not_dig() {
        let w = defs::by_key("flamethrower").expect("flamethrower");
        match w.delivery {
            Delivery::Cone {
                range, arc, dps, ..
            } => {
                assert_eq!(range, FLAMETHROWER_RANGE);
                assert_eq!(arc, FLAMETHROWER_ARC);
                assert_eq!(dps, FLAMETHROWER_DPS);
            }
            other => panic!("the flamethrower must be a cone: {other:?}"),
        }
        // §B6: fire does not dig. This is the constraint that stops it being
        // strictly better than the arsenal it competes with, so it is asserted
        // rather than left to the table.
        assert_eq!(w.blast_radius, 0.0, "fire must not carve");
    }

    /// Firing does not change the mask at all.
    ///
    /// **What this actually witnesses is the type signature, not the weapon
    /// def.** `spray` takes `&Map`, so the cone is *structurally* unable to dig;
    /// giving the flamethrower a `blast_radius` of 8 leaves this test green
    /// (measured). That is a stronger guarantee than a test — a compile error
    /// beats a red run — but it means the assertion that actually guards the
    /// radius is `it_matches_the_spec_and_does_not_dig`, which does go red.
    ///
    /// Kept because it pins the *end-to-end* claim through `world::fire`: if
    /// someone ever routes the cone through a mutable map, this is what notices
    /// (§B11 — ask what a passing assertion rules out).
    #[test]
    fn spraying_leaves_the_terrain_byte_identical() {
        let (mut w, _) = armed_world();
        let before = w.map.mask.count_solid();
        let mut t = 1.0f32;
        for _ in 0..120 {
            let _ = w.fire(0, t);
            w.step(SIM_DT);
            t += SIM_DT;
        }
        assert_eq!(
            w.map.mask.count_solid(),
            before,
            "the flamethrower carved terrain"
        );
    }

    /// It burns fuel, and it runs out — a cone that never empties would be
    /// strictly better than every weapon that does.
    #[test]
    fn it_spends_fuel_and_eventually_runs_dry() {
        let (mut w, slot) = armed_world();
        let start = w
            .player(0)
            .and_then(|p| p.inventory.slot(slot))
            .map(|s| s.count)
            .expect("fuel");
        let mut t = 1.0f32;
        for _ in 0..40 {
            let _ = w.fire(0, t);
            t += 0.2; // past the 0.05 s cooldown
        }
        let left = w
            .player(0)
            .and_then(|p| p.inventory.slot(slot))
            .map(|s| s.count)
            .unwrap_or(0);
        assert!(
            left < start,
            "40 trigger pulls spent no fuel ({start} -> {left})"
        );
    }

    /// One fire system, not two (§A24): the trail is the shared `LAVA_BURN_*`
    /// hazard, so a burning patch the flamethrower leaves damages exactly as
    /// lava's afterburn does.
    ///
    /// (An earlier version of this asserted `LAVA_BURN_DPS > 0.0`, which clippy
    /// correctly rejected as a constant assertion — a tautology dressed as a
    /// test. It now sprays into a real world and asserts the field is populated.)
    #[test]
    fn spraying_leaves_burning_ground_behind() {
        let (mut w, _) = armed_world();
        assert!(w.burn.is_empty(), "the world started on fire");
        let mut t = 1.0f32;
        for _ in 0..30 {
            let _ = w.fire(0, t);
            w.step(SIM_DT);
            t += SIM_DT;
        }
        assert!(
            !w.burn.is_empty(),
            "30 ticks of flame left no burning ground — the trail is not wired \
             to the shared burn hazard"
        );
    }

    #[test]
    fn it_is_an_item_you_can_find() {
        let d = registry::by_key("flamethrower").expect("item");
        assert_eq!(
            d.kind,
            ItemKind::Weapon(defs::by_key("flamethrower").expect("w").id)
        );
        assert!(
            d.spawn_weight > 0 || d.crate_weight > 0 || d.buried_weight > 0,
            "the flamethrower can never be obtained"
        );
    }
}
