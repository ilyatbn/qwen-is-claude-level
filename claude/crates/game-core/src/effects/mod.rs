//! Weather: the scheduler and the four effects.
//!
//! Every 30–45 seconds the map turns on the players. Effects are seeded,
//! telegraphed and short — they exist to break stalemates and to make cover
//! temporary (`docs/13-weather-effects.md`).
//!
//! Everything here is simulated on the server only. Hazard positions are
//! broadcast explicitly rather than re-rolled by clients, because a client that
//! disagreed about where the lava is would put someone in fire they cannot see
//! (`docs/13-weather-effects.md` §7).

pub mod fog;
pub mod lava;
pub mod meteor;
pub mod scheduler;
pub mod toxic;

pub use scheduler::{active_duration, ActiveEffect, EffectEvent, EffectPhase, EffectScheduler};

// `EffectKind` lives in `weapons::explode` because `DamageSource` needs it and
// `explode` is the lower layer. Re-exported here so effect code reads naturally.
pub use crate::weapons::explode::EffectKind;

use crate::map::Map;
use crate::math::Vec2;

/// Is there solid terrain between `pos` and the sky (§E13)?
///
/// **One function, two callers.** §E13 asks that a toxic drop not reach a player
/// under a roof, and notes that the meteor shower needs the same rule and does
/// not have it. Written twice these would disagree the first time either was
/// tuned, so it is written once: `toxic::poison_lands` and
/// `MeteorShower::on_impact` both ask this, and neither restates it.
///
/// The scan is the player's own column, from just above `pos` to the top of the
/// map. Cheap — one `Mask::get` per row, ~500 at worst, and only for a target
/// something is actually trying to hit.
///
/// It is deliberately about the **column**, not the line to the impact point.
/// "A roof protects you" is a rule a player can see from where they are
/// standing; occlusion along a slant is one they would have to compute.
pub fn under_a_roof(map: &Map, pos: Vec2) -> bool {
    let x = pos.x.round() as i32;
    if x < 0 || x >= map.mask.w as i32 {
        return false;
    }
    let from = (pos.y.round() as i32 - 1).min(map.mask.h as i32 - 1);
    (0..=from.max(0)).rev().any(|y| map.mask.get(x, y))
}

#[cfg(test)]
mod roof_tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::meta::MapMeta;
    use crate::map::{CoarseGrid, Mask};

    fn map_with(rows: &[(i32, i32, i32)]) -> Map {
        let mut mask = Mask::new_empty(256, 256);
        for &(y, x0, x1) in rows {
            mask.set_run(y, x0, x1);
        }
        let coarse = CoarseGrid::build(&mask);
        let meta = MapMeta {
            seed: 1,
            requested_seed: 1,
            attempts: 1,
            used_safe_preset: false,
            scale: MapScale::Small,
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
        };
        Map::from_parts(mask, coarse, meta)
    }

    /// The pair. An absence assertion — "the roof stopped it" — is satisfied by a
    /// function that always says yes, so the same point with the slab removed has
    /// to say no.
    #[test]
    fn a_slab_overhead_is_a_roof_and_open_sky_is_not() {
        let roofed = map_with(&[(40, 0, 255)]);
        let open = map_with(&[]);
        let under = Vec2::new(128.0, 100.0);
        assert!(
            under_a_roof(&roofed, under),
            "a full-width slab is not a roof"
        );
        assert!(!under_a_roof(&open, under), "open sky was read as a roof");
    }

    /// The gap is the whole mechanism: a hole in the slab is what makes rain
    /// reach the floor of a cave, and the column is what decides.
    #[test]
    fn a_hole_in_the_slab_leaves_the_column_under_it_open() {
        let m = map_with(&[(40, 0, 99), (40, 121, 255)]);
        assert!(!under_a_roof(&m, Vec2::new(110.0, 100.0)), "under the hole");
        assert!(under_a_roof(&m, Vec2::new(60.0, 100.0)), "under the slab");
    }

    /// Terrain **below** you is not a roof, and the scan must not read it as one.
    #[test]
    fn ground_underfoot_is_not_a_roof() {
        let m = map_with(&[(150, 0, 255)]);
        assert!(!under_a_roof(&m, Vec2::new(128.0, 100.0)));
    }

    /// Off the map, in either direction, is open sky rather than a panic.
    #[test]
    fn a_column_outside_the_map_is_not_a_roof() {
        let m = map_with(&[(40, 0, 255)]);
        assert!(!under_a_roof(&m, Vec2::new(-10.0, 100.0)));
        assert!(!under_a_roof(&m, Vec2::new(9999.0, 100.0)));
        assert!(!under_a_roof(&m, Vec2::new(128.0, -50.0)), "above the map");
    }
}
