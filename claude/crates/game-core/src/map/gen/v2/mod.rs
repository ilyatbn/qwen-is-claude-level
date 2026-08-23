//! `MapGenerator::V2` — the landscape generator.
//!
//! ```text
//! 1 height profile → 2 fill → 3 roughen → 4 islands → 5 caves → 6 arches
//!                  → 7 smoothing → 8 cleanup → 9 surface → 10 validation
//! ```
//!
//! v1 and v2 differ in one decision, and everything else follows from it: v1 asks
//! a 2D noise field whether each **pixel** is solid, v2 asks a 1D profile how high
//! the ground is in each **column**. A field that does not know where the ground is
//! puts as much air underground as it puts rock in the sky, so v1's output is a
//! single perforated mass — its islands are perforated too, and the renderer's
//! enclosure test quite correctly paints the lot with a cave backdrop. v2's
//! default state for a pixel is open sky, and a cave is something cut into the
//! rock afterwards.
//!
//! Passes 7–10 are shared with v1: smoothing, cleanup, surface extraction and the
//! traversal gate are about the *mask*, not about how it was made.

pub mod features;
pub mod ground;

use crate::constants::{MapGenerator, MapScale, GROUND_AMPLITUDE_FRAC, MAX_GEN_ATTEMPTS};
use crate::map::Mask;

use super::{components, smooth, surface, traversal, GenOutcome};

/// Tunables for one v2 attempt. The retry loop mutates nothing; the safe preset is
/// this struct with milder values, exactly as `GenParams` is for v1.
#[derive(Clone, Debug, PartialEq)]
pub struct V2Params {
    pub scale: MapScale,
    /// Peak-to-mean swing of the ground line, as a fraction of map height.
    pub amplitude_frac: f32,
    pub island_count: u32,
    pub chasm_count: u32,
    pub mesa_count: u32,
    pub cave_count: u32,
    pub arch_count: u32,
}

impl V2Params {
    pub fn default_for(scale: MapScale) -> Self {
        let p = scale.params();
        V2Params {
            scale,
            amplitude_frac: GROUND_AMPLITUDE_FRAC,
            island_count: p.island_count,
            chasm_count: p.chasm_count,
            mesa_count: p.mesa_count,
            cave_count: p.cave_count,
            arch_count: p.arch_count,
        }
    }

    /// The last-resort fallback: a plainer landscape that cannot fail to connect.
    ///
    /// The two passes that can strand a player are the ones that *remove* ground —
    /// chasms, which can cut the map in half, and arches, which can undercut a
    /// hill. Both go. A flatter profile does the rest.
    pub fn safe_for(scale: MapScale) -> Self {
        let d = Self::default_for(scale);
        V2Params {
            amplitude_frac: d.amplitude_frac * 0.5,
            chasm_count: 0,
            arch_count: 0,
            cave_count: d.cave_count.min(1),
            island_count: d.island_count.min(2),
            ..d
        }
    }

    pub fn width(&self) -> u32 {
        self.scale.params().width
    }

    pub fn height(&self) -> u32 {
        self.scale.params().height
    }
}

/// One attempt, no retry. Exposed for tests and for the PNG dump.
pub fn generate_once(seed: u64, params: &V2Params) -> GenOutcome {
    let profile = ground::build_profile(seed, params);

    let mut mask = Mask::new_empty(params.width(), params.height());
    ground::fill(&mut mask, &profile);
    ground::roughen(&mut mask, &profile, seed);

    // Islands are stamped after the ground is roughened and before anything is
    // carved, so nothing later punches a hole in one.
    let islands = features::add_islands(&mut mask, &profile, seed, params);

    let mut tunnel_paths = features::carve_caves(&mut mask, &profile, seed, params);
    tunnel_paths.extend(features::carve_arches(&mut mask, &profile, seed, params));

    smooth::smooth(&mut mask);
    let sealed_pockets = components::cleanup(&mut mask);

    let surface = surface::extract_surface(&mask);
    let report = traversal::analyse(&mask, &surface);

    GenOutcome {
        mask,
        surface,
        report,
        sealed_pockets,
        tunnel_paths,
        islands,
        seed,
        requested_seed: seed,
        attempts: 1,
        used_safe_preset: false,
        generator: MapGenerator::V2,
    }
}

/// The v2 half of `gen::generate_terrain`: retries, then the safe preset.
pub fn generate_terrain(requested_seed: u64, scale: MapScale) -> GenOutcome {
    let params = V2Params::default_for(scale);

    for attempt in 0..MAX_GEN_ATTEMPTS {
        let seed = requested_seed.wrapping_add(attempt as u64);
        let mut outcome = generate_once(seed, &params);
        if outcome.report.passed {
            outcome.requested_seed = requested_seed;
            outcome.attempts = attempt + 1;
            return outcome;
        }
    }

    let mut outcome = generate_once(requested_seed, &V2Params::safe_for(scale));
    outcome.requested_seed = requested_seed;
    outcome.attempts = MAX_GEN_ATTEMPTS;
    outcome.used_safe_preset = true;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{FLOOR_CRUST, SKY_MARGIN};
    use crate::map::gen::borders_hold;

    #[test]
    fn generate_once_is_deterministic() {
        let p = V2Params::default_for(MapScale::Small);
        let first = generate_once(4242, &p);
        for _ in 0..10 {
            let again = generate_once(4242, &p);
            assert_eq!(again.mask.hash(), first.mask.hash());
            assert_eq!(again.surface, first.surface);
            assert_eq!(again.islands, first.islands);
            assert_eq!(again.tunnel_paths, first.tunnel_paths);
        }
    }

    #[test]
    fn every_scale_produces_the_right_dimensions_with_borders_intact() {
        for scale in MapScale::ALL {
            let o = generate_terrain(99, scale);
            let p = scale.params();
            assert_eq!((o.mask.w, o.mask.h), (p.width, p.height), "{scale:?}");
            assert!(borders_hold(&o.mask), "{scale:?} borders");
        }
    }

    /// The property the whole refactor exists for.
    ///
    /// "Enclosed" is air that a flood from the sky cannot reach. In v1 most of the
    /// map's air is enclosed — that is what makes it read as a cave system. Here
    /// the great majority of it has to be open sky, or the change did not land.
    ///
    /// The control is the same measurement against v1 on the same seed, in
    /// `gen::tests::v2_encloses_far_less_air_than_v1`.
    #[test]
    fn nearly_all_of_the_air_is_open_sky() {
        for seed in [1u64, 4242, 31337] {
            let o = generate_terrain(seed, MapScale::Small);
            let (open, air) = open_air_fraction(&o.mask);
            let f = open as f32 / air as f32;
            assert!(f > 0.9, "seed {seed}: only {f:.3} of the air is open sky");
        }
    }

    /// Flood air from the top row down. Returns (reachable air, total air).
    pub(super) fn open_air_fraction(mask: &Mask) -> (u64, u64) {
        let (w, h) = (mask.w as i32, mask.h as i32);
        let (wu, hu) = (w as usize, h as usize);
        let mut seen = vec![false; wu * hu];
        let mut stack: Vec<(i32, i32)> = Vec::new();

        for x in 0..w {
            if !mask.get(x, 0) {
                seen[x as usize] = true;
                stack.push((x, 0));
            }
        }
        let mut open = 0u64;
        while let Some((x, y)) = stack.pop() {
            open += 1;
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (x + dx, y + dy);
                if nx < 0 || ny < 0 || nx >= w || ny >= h {
                    continue;
                }
                let i = ny as usize * wu + nx as usize;
                if seen[i] || mask.get(nx, ny) {
                    continue;
                }
                seen[i] = true;
                stack.push((nx, ny));
            }
        }
        let air = (wu * hu) as u64 - mask.count_solid();
        (open, air)
    }

    /// Rock in the sky is what makes v1 read as a cave rather than a landscape:
    /// a floating chunk at the top of the frame has to be an *island*, placed
    /// deliberately, not a leftover of the field.
    #[test]
    fn the_sky_band_is_empty_and_the_bedrock_is_solid() {
        let o = generate_terrain(4242, MapScale::Medium);
        let (w, h) = (o.mask.w as i32, o.mask.h as i32);
        for y in 0..SKY_MARGIN as i32 {
            assert_eq!(o.mask.count_run(y, 0, w - 1), 0, "sky row {y}");
        }
        for y in (h - FLOOR_CRUST as i32)..h {
            assert_eq!(o.mask.count_run(y, 0, w - 1), w as u32, "bedrock row {y}");
        }
    }

    #[test]
    fn the_safe_preset_removes_the_passes_that_cut_the_ground() {
        for scale in MapScale::ALL {
            let s = V2Params::safe_for(scale);
            assert_eq!(s.chasm_count, 0, "{scale:?}");
            assert_eq!(s.arch_count, 0, "{scale:?}");
            assert!(s.amplitude_frac < V2Params::default_for(scale).amplitude_frac);
        }
    }

    #[test]
    fn a_map_carries_islands_and_cave_paths_for_the_rest_of_the_pipeline() {
        // `map::meta` anchors buried slots on `tunnel_paths` and decorations on the
        // surface. Both must be non-empty or those passes silently degrade.
        let o = generate_terrain(4242, MapScale::Medium);
        assert!(!o.islands.is_empty(), "no islands");
        assert!(!o.tunnel_paths.is_empty(), "no cave paths");
        assert!(!o.surface.is_empty(), "no surface points");
    }
}
