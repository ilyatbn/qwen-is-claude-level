//! Pass 8: buried slots, decorations, `MapMeta`, and the complete [`Map`].
//!
//! [`generate`] is the whole pipeline and the only entry point the server and the
//! WASM bridge need.
//!
//! See `docs/10-map-generation.md` §1.4, §Pass 8.

use crate::constants::{
    MapScale, BURIED_ATTEMPTS, BURIED_CLEARANCE, BURIED_OFFSET_MAX, BURIED_OFFSET_MIN,
    BURIED_SEPARATION, WIND_MAX,
};
use crate::map::gen::components::SealedPocket;
use crate::map::gen::{generate_terrain, spawns::choose_spawns};
use crate::map::{CoarseGrid, Mask};
use crate::math::Point;
use crate::rng::{range_f32, range_i32, substream, ChaCha8Rng};

/// Roughly one decoration per this many surface points.
const DECOR_PER_SURFACE: usize = 10;
const DECOR_MAX: usize = 200;
/// Decoration kinds available per theme.
const DECOR_KINDS: u16 = 6;

pub const THEME_COUNT: u8 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct BuriedSlot {
    pub id: u16,
    pub pos: Point,
    pub revealed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Decoration {
    pub kind: u16,
    pub pos: Point,
    pub flip: bool,
    pub scale_tier: u8,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct MapMeta {
    pub seed: u64,
    pub requested_seed: u64,
    pub attempts: u8,
    pub used_safe_preset: bool,
    pub scale: MapScale,
    pub theme: u8,
    pub spawn_points: Vec<Point>,
    pub surface_points: Vec<Point>,
    pub buried_slots: Vec<BuriedSlot>,
    pub decorations: Vec<Decoration>,
    pub wind: f32,
    pub traversable_fraction: f32,
    /// Indices into `surface_points` forming the validated strongly connected set.
    ///
    /// Shipped because nothing downstream can otherwise tell "every cave is
    /// reachable" from "every cave is sealed" — a caller with no component to test
    /// against has to pass every index, and gets back the surface fraction under
    /// another name. See `docs/70` §A10.
    pub largest_component: Vec<u32>,
}

/// Mask, coarse index and metadata together, plus the dirty-chunk set that carve
/// (T1.14) maintains.
#[derive(Clone, Debug)]
pub struct Map {
    pub mask: Mask,
    pub coarse: CoarseGrid,
    pub meta: MapMeta,
    // Maintained by carve (`map::carve`), drained by the client renderer.
    pub(crate) dirty: Vec<bool>,
    pub(crate) dirty_list: Vec<u32>,
}

impl Map {
    /// Assemble a map from parts, sizing the dirty set from the mask.
    ///
    /// Public because the dirty set is `pub(crate)` — integration tests and the
    /// future replay/WASM paths need to build a `Map` around a hand-made or decoded
    /// mask without reaching into private fields.
    pub fn from_parts(mask: Mask, coarse: CoarseGrid, meta: MapMeta) -> Self {
        let chunks = (mask.chunks_x() * mask.chunks_y()) as usize;
        Map {
            mask,
            coarse,
            meta,
            dirty: vec![false; chunks],
            dirty_list: Vec::new(),
        }
    }

    pub fn chunks_x(&self) -> u32 {
        self.mask.chunks_x()
    }
    pub fn chunks_y(&self) -> u32 {
        self.mask.chunks_y()
    }
}

/// The full pipeline: terrain, spawns, buried slots, decorations, coarse grid.
///
/// Buried slots come from the default (zero) secret. Use `generate_with_secret`
/// on a live server so a modified client cannot recompute them (`docs/70` §A31).
pub fn generate(requested_seed: u64, scale: MapScale) -> Map {
    generate_with_secret(requested_seed, scale, 0)
}

/// As `generate`, with a per-round `buried_secret` that never crosses the wire.
///
/// Every buried slot is currently derivable by anyone holding the seed, and the
/// seed is in `welcome` — `game-core` ships as WASM, so a modified client can
/// call the same function and get all ten exactly. Hiding them from an honest
/// client is not hiding them.
///
/// The secret defaults to 0 so golden tables, the seed sweep and every existing
/// test are unaffected; only the server rolls a real one, and it goes in the
/// replay header so a round stays reproducible.
pub fn generate_with_secret(requested_seed: u64, scale: MapScale, buried_secret: u64) -> Map {
    let outcome = generate_terrain(requested_seed, scale);
    let params = scale.params();

    let theme = (substream(requested_seed, "theme").next_u64_compat() % THEME_COUNT as u64) as u8;
    let wind = range_f32(&mut substream(requested_seed, "wind"), -WIND_MAX, WIND_MAX);

    let spawn_points = choose_spawns(
        &outcome.surface,
        &outcome.report.largest_component,
        outcome.seed,
        crate::constants::SPAWN_COUNT_MIN.max(crate::constants::MAX_PLAYERS),
    );

    let buried_slots = choose_buried_slots(
        &outcome.mask,
        &outcome.sealed_pockets,
        &outcome.tunnel_paths,
        outcome.seed ^ buried_secret,
        params.buried_slots as usize,
    );

    let decorations = choose_decorations(&outcome.surface, outcome.seed, theme);

    let coarse = CoarseGrid::build(&outcome.mask);
    let chunk_count = (outcome.mask.chunks_x() * outcome.mask.chunks_y()) as usize;

    Map {
        meta: MapMeta {
            seed: outcome.seed,
            requested_seed: outcome.requested_seed,
            attempts: outcome.attempts,
            used_safe_preset: outcome.used_safe_preset,
            scale,
            theme,
            spawn_points,
            surface_points: outcome.surface,
            buried_slots,
            decorations,
            wind,
            traversable_fraction: outcome.report.traversable_fraction,
            largest_component: outcome
                .report
                .largest_component
                .iter()
                .map(|&i| i as u32)
                .collect(),
        },
        mask: outcome.mask,
        coarse,
        dirty: vec![false; chunk_count],
        dirty_list: Vec::new(),
    }
}

/// Points inside solid rock, biased toward tunnels and pockets.
///
/// Uniform random placement buries things where nobody will ever dig. Sampling
/// near a tunnel or a sealed pocket and stepping 30–80 px off it means a single
/// well-placed rocket can expose one, which is what makes digging a strategy
/// rather than a lottery.
pub fn choose_buried_slots(
    mask: &Mask,
    pockets: &[SealedPocket],
    tunnels: &[Vec<Point>],
    seed: u64,
    count: usize,
) -> Vec<BuriedSlot> {
    let mut rng = substream(seed, "buried");
    let mut anchors: Vec<Point> = Vec::new();
    for path in tunnels {
        anchors.extend(path.iter().copied());
    }
    anchors.extend(pockets.iter().map(|p| p.centroid));

    let sep_sq = (BURIED_SEPARATION as i64).pow(2);
    let mut slots: Vec<BuriedSlot> = Vec::with_capacity(count);

    for _ in 0..count {
        for _ in 0..BURIED_ATTEMPTS {
            let candidate = if anchors.is_empty() {
                Point::new(
                    range_i32(&mut rng, 0, mask.w as i32 - 1),
                    range_i32(&mut rng, 0, mask.h as i32 - 1),
                )
            } else {
                let a = anchors[range_i32(&mut rng, 0, anchors.len() as i32 - 1) as usize];
                let angle = range_f32(&mut rng, -crate::math::PI, crate::math::PI);
                let dist = range_i32(&mut rng, BURIED_OFFSET_MIN, BURIED_OFFSET_MAX) as f32;
                Point::new(
                    a.x + (angle.cos() * dist).round() as i32,
                    a.y + (angle.sin() * dist).round() as i32,
                )
            };

            if !crate::map::gen::caves::is_buried(mask, candidate, BURIED_CLEARANCE) {
                continue;
            }
            if slots.iter().any(|s| s.pos.distance_sq(candidate) < sep_sq) {
                continue;
            }

            slots.push(BuriedSlot {
                id: slots.len() as u16,
                pos: candidate,
                revealed: false,
            });
            break;
        }
    }

    slots
}

/// Cosmetic props anchored to the surface. Purely visual — a client may skip them.
pub fn choose_decorations(surface: &[Point], seed: u64, theme: u8) -> Vec<Decoration> {
    let mut rng = substream(seed, "decor");
    let want = (surface.len() / DECOR_PER_SURFACE).min(DECOR_MAX);
    let mut decorations = Vec::with_capacity(want);

    for _ in 0..want {
        let p = surface[range_i32(&mut rng, 0, surface.len() as i32 - 1) as usize];
        decorations.push(Decoration {
            // Kinds are per-theme; a theme with no art for a kind just skips it.
            kind: (theme as u16 * DECOR_KINDS)
                + range_i32(&mut rng, 0, DECOR_KINDS as i32 - 1) as u16,
            pos: p,
            flip: crate::rng::chance(&mut rng, 0.5),
            scale_tier: range_i32(&mut rng, 0, 2) as u8,
        });
    }

    decorations
}

/// `rand::RngCore::next_u64` under a name that does not collide with the trait
/// import in callers.
trait NextU64Compat {
    fn next_u64_compat(&mut self) -> u64;
}
impl NextU64Compat for ChaCha8Rng {
    fn next_u64_compat(&mut self) -> u64 {
        use rand::RngCore;
        self.next_u64()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{SPAWN_COUNT_MIN, WIND_MAX};
    use crate::map::gen::surface::extract_surface;

    #[test]
    fn determinism_of_the_whole_pipeline() {
        let first = generate(4242, MapScale::Small);
        for _ in 0..20 {
            let again = generate(4242, MapScale::Small);
            assert_eq!(again.mask.hash(), first.mask.hash());
            assert_eq!(again.meta.spawn_points, first.meta.spawn_points);
            assert_eq!(again.meta.buried_slots, first.meta.buried_slots);
            assert_eq!(again.meta.decorations, first.meta.decorations);
            assert_eq!(again.meta.theme, first.meta.theme);
            assert_eq!(again.meta.wind, first.meta.wind);
        }
    }

    #[test]
    fn sub_stream_isolation_at_the_top_level() {
        // The property the whole seeding design rests on, tested where it matters:
        // draining an unrelated stream must not change the map.
        let before = generate(777, MapScale::Small);

        let mut items = substream(777, "items");
        for _ in 0..10_000 {
            let _ = range_i32(&mut items, 0, 1000);
        }
        let mut weather = substream(777, "weather");
        for _ in 0..10_000 {
            let _ = range_i32(&mut weather, 0, 1000);
        }

        let after = generate(777, MapScale::Small);
        assert_eq!(before.mask.hash(), after.mask.hash());
        assert_eq!(before.meta.spawn_points, after.meta.spawn_points);
        assert_eq!(before.meta.buried_slots, after.meta.buried_slots);
    }

    #[test]
    fn buried_slots_are_genuinely_buried_and_separated() {
        let map = generate(31337, MapScale::Medium);
        let slots = &map.meta.buried_slots;
        assert!(!slots.is_empty(), "no buried slots placed");

        for s in slots {
            assert!(map.mask.get(s.pos.x, s.pos.y), "slot {s:?} is not in rock");
            // Walk the whole ray, not just the endpoint. Asserting the same five
            // pixels `is_buried` samples cannot catch a slot lying against a tunnel
            // wall with solid rock again 24 px beyond it — which is exactly the bug
            // this test was written to prevent (`docs/70` §A12).
            for d in 1..=BURIED_CLEARANCE {
                for (dx, dy) in [(-d, 0), (d, 0), (0, -d), (0, d)] {
                    assert!(
                        map.mask.get(s.pos.x + dx, s.pos.y + dy),
                        "slot {:?} has air {d} px away at ({dx},{dy}) — not buried",
                        s.pos
                    );
                }
            }
            assert!(!s.revealed, "slots must start unrevealed");
        }

        for (i, a) in slots.iter().enumerate() {
            for b in &slots[i + 1..] {
                let d = (a.pos.distance_sq(b.pos) as f64).sqrt();
                assert!(
                    d >= BURIED_SEPARATION as f64,
                    "slots {:?} and {:?} are {d:.0} px apart",
                    a.pos,
                    b.pos
                );
            }
        }
    }

    #[test]
    fn slot_ids_are_their_index() {
        let map = generate(11, MapScale::Small);
        for (i, s) in map.meta.buried_slots.iter().enumerate() {
            assert_eq!(s.id as usize, i);
        }
    }

    #[test]
    fn most_buried_slots_get_placed_on_real_maps() {
        let mut total = 0usize;
        let mut wanted = 0usize;
        for seed in 0..20u64 {
            let map = generate(seed * 313 + 7, MapScale::Medium);
            total += map.meta.buried_slots.len();
            wanted += MapScale::Medium.params().buried_slots as usize;
        }
        assert!(
            total * 2 >= wanted,
            "only {total} of {wanted} buried slots placed across 20 maps"
        );
    }

    #[test]
    fn decorations_sit_on_surface_points() {
        let map = generate(99, MapScale::Small);
        assert!(!map.meta.decorations.is_empty());
        for d in &map.meta.decorations {
            assert!(
                map.meta.surface_points.contains(&d.pos),
                "decoration at {:?} is not on a surface point",
                d.pos
            );
            assert!(d.scale_tier <= 2);
        }
        assert!(map.meta.decorations.len() <= DECOR_MAX);
    }

    #[test]
    fn wind_and_theme_are_in_range() {
        for seed in 0..30u64 {
            let map = generate(seed * 17, MapScale::Small);
            assert!(
                map.meta.wind.abs() <= WIND_MAX,
                "wind {} exceeds {WIND_MAX}",
                map.meta.wind
            );
            assert!(map.meta.theme < THEME_COUNT, "theme {}", map.meta.theme);
        }
    }

    #[test]
    fn themes_actually_vary_across_seeds() {
        let mut seen = std::collections::HashSet::new();
        for seed in 0..40u64 {
            seen.insert(generate(seed * 101 + 3, MapScale::Small).meta.theme);
        }
        assert!(
            seen.len() > 1,
            "every seed produced the same theme: {seen:?}"
        );
    }

    #[test]
    fn surface_points_match_the_final_mask() {
        let map = generate(4242, MapScale::Small);
        assert!(!map.meta.surface_points.is_empty());
        assert_eq!(map.meta.surface_points, extract_surface(&map.mask));
    }

    #[test]
    fn the_coarse_grid_matches_the_generated_mask() {
        for scale in MapScale::ALL {
            let map = generate(5, scale);
            assert_eq!(map.coarse.verify(&map.mask), Ok(()), "{scale:?}");
        }
    }

    #[test]
    fn every_scale_produces_a_usable_map() {
        for scale in MapScale::ALL {
            let map = generate(2024, scale);
            let p = scale.params();
            assert_eq!((map.mask.w, map.mask.h), (p.width, p.height), "{scale:?}");
            assert!(
                map.meta.spawn_points.len() >= SPAWN_COUNT_MIN,
                "{scale:?}: only {} spawns",
                map.meta.spawn_points.len()
            );
            assert!(!map.meta.surface_points.is_empty(), "{scale:?}");
            assert_eq!(
                map.dirty.len(),
                (map.chunks_x() * map.chunks_y()) as usize,
                "{scale:?} dirty set size"
            );
        }
    }

    #[test]
    fn spawn_points_are_standable_on_the_final_mask() {
        // A spawn inside rock is the single worst generation bug, so assert it
        // against the mask that actually ships rather than trusting the pipeline.
        let map = generate(8123, MapScale::Medium);
        for s in &map.meta.spawn_points {
            assert!(
                crate::map::gen::surface::is_standable(&map.mask, s.x, s.y),
                "spawn {s:?} is not standable"
            );
        }
    }
}
