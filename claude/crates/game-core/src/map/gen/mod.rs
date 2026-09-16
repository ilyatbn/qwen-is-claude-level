//! The generation pipeline, one module per pass.
//!
//! ```text
//! 1 preset → 2 silhouette → 3 islands → 3b bridges → 4 cave network
//!         → 4b crevices → 4c voids → 5 smoothing → 6 cleanup → 6b objects
//!         → 7 validation → 8 metadata
//! ```
//!
//! Every pass draws from its own RNG sub-stream, so tuning one never disturbs
//! another (`docs/10-map-generation.md` §2). Order is from
//! `docs/70-amendments-v2.md` §A2.

pub mod blobs;
pub mod bridges;
pub mod carvings;
pub mod caves;
pub mod components;
pub mod network;
pub mod objects;
pub mod silhouette;
pub mod smooth;
pub mod spawns;
pub mod surface;
pub mod traversal;
pub mod v2;

pub use silhouette::{borders_hold, force_borders, solid_fraction, GenParams};

use crate::constants::{MapGenerator, MapScale, DEFAULT_MAP_GENERATOR, MAX_GEN_ATTEMPTS};
use crate::map::Mask;
use crate::math::Point;
use components::SealedPocket;
use traversal::TraversalReport;

/// Everything passes 1–7 produced. Pass 8 (`map::meta`) turns this into a `Map`.
#[derive(Debug)]
pub struct GenOutcome {
    pub mask: Mask,
    pub surface: Vec<Point>,
    pub report: TraversalReport,
    pub sealed_pockets: Vec<SealedPocket>,
    /// Every stamped tunnel, chamber-edge, entrance and crevice centre. T1.13
    /// places buried slots near these.
    pub tunnel_paths: Vec<Vec<Point>>,
    /// Island centres, for decoration and debugging.
    pub islands: Vec<Point>,
    /// Scenery stamped at pass 6b (§D5). Carried out so pass 8 can keep spawns
    /// clear of it and the client can draw the art (§D6).
    pub objects: Vec<objects::PlacedObject>,
    /// The seed that actually produced this map.
    pub seed: u64,
    pub requested_seed: u64,
    pub attempts: u8,
    pub used_safe_preset: bool,
    /// Which generator produced this. Carried so a dump, a log line or a test can
    /// say which of the two it is looking at without being told.
    pub generator: MapGenerator,
}

/// One attempt, no retry. Exposed for tests and for the PNG dump.
///
/// Runs the v2 pipeline in the order `docs/70-amendments-v2.md` §A2 specifies:
/// silhouette → islands → bridges → cave network → free tunnels → crevices →
/// voids → smoothing → cleanup → surface → validation.
pub fn generate_once(seed: u64, params: &GenParams) -> GenOutcome {
    let mut mask = silhouette::silhouette(seed, params);

    let islands = blobs::add_blobs(&mut mask, seed, params);
    bridges::add_bridges(&mut mask, seed, params, &islands);

    let net = network::carve_network(&mut mask, seed, params);
    let mut tunnel_paths = net.paths;
    tunnel_paths.extend(caves::carve_caves(&mut mask, seed, params));
    tunnel_paths.extend(carvings::carve_crevices(&mut mask, seed, params));
    carvings::carve_voids(&mut mask, seed, params);

    smooth::smooth(&mut mask);
    let sealed_pockets = components::cleanup(&mut mask);

    // Pass 6b (§D3): after cleanup, before surface extraction and validation.
    let placement = objects::stamp_objects(&mut mask, seed, params.scale, params.theme);

    let surface = surface::extract_surface(&mask);
    let report = traversal::analyse(&mask, &surface, &placement.objects);

    GenOutcome {
        mask,
        surface,
        report,
        sealed_pockets,
        tunnel_paths,
        islands,
        objects: placement.objects,
        seed,
        requested_seed: seed,
        attempts: 1,
        used_safe_preset: false,
        generator: MapGenerator::V1,
    }
}

/// Passes 1–7 with retries. **Never fails** — the safe preset is the floor.
///
/// The safe-preset result is returned even if it also fails validation: a round has
/// to start. `used_safe_preset` and `report.passed` are both in the outcome, so the
/// server can log a warning and tests can assert this never happens in practice. A
/// `Result` here would push an unhandleable error up into the room loop.
///
/// Does no logging — `game-core` is pure. The server logs from these fields.
pub fn generate_terrain(requested_seed: u64, scale: MapScale) -> GenOutcome {
    generate_terrain_with(requested_seed, scale, DEFAULT_MAP_GENERATOR)
}

/// `generate_terrain` against a named generator.
///
/// The two are kept side by side so the same seed can be rendered both ways —
/// `tests/dump_maps.rs` writes a v1 and a v2 PNG per seed. Everything downstream
/// of this function (spawns, buried slots, decorations, the traversal gate) is
/// shared, so the only thing that varies is the mask.
pub fn generate_terrain_with(
    requested_seed: u64,
    scale: MapScale,
    generator: MapGenerator,
) -> GenOutcome {
    match generator {
        MapGenerator::V1 => generate_terrain_v1(requested_seed, scale),
        MapGenerator::V2 => v2::generate_terrain(requested_seed, scale),
    }
}

fn generate_terrain_v1(requested_seed: u64, scale: MapScale) -> GenOutcome {
    let mut params = GenParams::default_for(scale);
    params.theme = crate::map::meta::theme_for(requested_seed);

    for attempt in 0..MAX_GEN_ATTEMPTS {
        let seed = requested_seed.wrapping_add(attempt as u64);
        let mut outcome = generate_once(seed, &params);
        if outcome.report.passed {
            outcome.requested_seed = requested_seed;
            outcome.attempts = attempt + 1;
            return outcome;
        }
    }

    let mut safe = GenParams::safe_for(scale);
    safe.theme = params.theme;
    let mut outcome = generate_once(requested_seed, &safe);
    outcome.requested_seed = requested_seed;
    outcome.attempts = MAX_GEN_ATTEMPTS;
    outcome.used_safe_preset = true;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{FLOOR_CRUST, SKY_MARGIN};

    #[test]
    fn generate_once_is_deterministic() {
        let p = GenParams::default_for(MapScale::Small);
        let first = generate_once(4242, &p);
        for _ in 0..20 {
            let again = generate_once(4242, &p);
            assert_eq!(again.mask.hash(), first.mask.hash());
            assert_eq!(again.surface, first.surface);
            assert_eq!(again.report, first.report);
            assert_eq!(again.sealed_pockets, first.sealed_pockets);
        }
    }

    #[test]
    fn generate_terrain_is_deterministic() {
        let first = generate_terrain(8123, MapScale::Small);
        for _ in 0..20 {
            let again = generate_terrain(8123, MapScale::Small);
            assert_eq!(again.mask.hash(), first.mask.hash());
            assert_eq!(again.seed, first.seed);
            assert_eq!(again.attempts, first.attempts);
        }
    }

    #[test]
    fn the_returned_seed_reflects_the_attempt_that_succeeded() {
        let o = generate_terrain(555, MapScale::Small);
        if !o.used_safe_preset {
            assert_eq!(
                o.seed,
                o.requested_seed + o.attempts as u64 - 1,
                "seed must be requested_seed + attempts - 1"
            );
        }
    }

    #[test]
    fn every_scale_produces_the_right_dimensions_with_borders_intact() {
        for scale in MapScale::ALL {
            let o = generate_terrain(99, scale);
            let p = scale.params();
            assert_eq!((o.mask.w, o.mask.h), (p.width, p.height), "{scale:?}");
            assert!(borders_hold(&o.mask), "{scale:?} borders");

            let (w, h) = (o.mask.w as i32, o.mask.h as i32);
            for y in 0..SKY_MARGIN as i32 {
                assert_eq!(o.mask.count_run(y, 0, w - 1), 0, "{scale:?} sky row {y}");
            }
            for y in (h - FLOOR_CRUST as i32)..h {
                assert_eq!(
                    o.mask.count_run(y, 0, w - 1),
                    w as u32,
                    "{scale:?} floor crust row {y}"
                );
            }
        }
    }

    #[test]
    fn a_typical_map_has_pockets_and_tunnels_for_buried_items() {
        // T1.13 needs both to place buried slots near something interesting.
        let o = generate_terrain(4242, MapScale::Medium);
        assert!(!o.tunnel_paths.is_empty(), "no tunnel paths");
        assert!(
            o.tunnel_paths.iter().any(|p| p.len() > 3),
            "tunnel paths are all stubs"
        );
    }

    #[test]
    fn the_safe_preset_is_returned_even_if_it_fails() {
        // Generation must never fail: a round has to start. Drive the safe path
        // directly and check the shape of the result.
        let mut o = generate_once(1, &GenParams::safe_for(MapScale::Small));
        o.used_safe_preset = true;
        assert!(o.mask.w > 0 && !o.surface.is_empty());
    }

    /// The tuning gate. If this fails, the generation parameters need adjusting —
    /// report it rather than loosening the assertion.
    #[test]
    #[ignore = "slow in debug; run with --release --ignored"]
    fn fifty_medium_seeds_pass_without_the_safe_preset() {
        let mut attempts_hist = [0usize; 16];
        let mut worst = 1.0f32;
        let mut safe_preset = 0;

        for seed in 0..50u64 {
            let o = generate_terrain(seed * 7919 + 13, MapScale::Medium);
            attempts_hist[o.attempts as usize] += 1;
            worst = worst.min(o.report.traversable_fraction);
            if o.used_safe_preset {
                safe_preset += 1;
            }
        }

        println!("attempts histogram (index = attempts): {attempts_hist:?}");
        println!("worst traversable fraction: {worst:.3}");
        println!("safe preset used: {safe_preset}/50");

        assert_eq!(safe_preset, 0, "the safe preset should never be needed");
        let over_three: usize = attempts_hist[4..].iter().sum();
        assert_eq!(over_three, 0, "some seeds needed more than 3 attempts");
    }

    #[test]
    #[ignore = "slow in debug; run with --release --ignored"]
    fn medium_generation_is_under_a_second() {
        use std::time::Instant;
        let t = Instant::now();
        let o = generate_terrain(4242, MapScale::Medium);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "medium generate_terrain: {ms:.0} ms, {} attempts, fraction {:.3}",
            o.attempts, o.report.traversable_fraction
        );
        assert!(ms < 1000.0, "generation took {ms:.0} ms");
    }
}
