//! Passes 1–2: the preset, and the organic silhouette it produces.
//!
//! The shape comes from domain-warped fractal value noise, thresholded, with a
//! vertical bias that makes the result read as a *landscape* rather than as noise:
//! near the top almost nothing clears the threshold, near the bottom almost
//! everything does, and the interesting mixed band sits in between — which is where
//! overhangs, arches and floating chunks come from.
//!
//! This is the single most expensive loop in the project. Everything invariant is
//! hoisted; nothing allocates inside it.
//!
//! See `docs/10-map-generation.md` §Pass 1, §Pass 2.

use crate::constants::{
    MapScale, FLOOR_CRUST, GRADIENT_BIAS_BOTTOM, GRADIENT_BIAS_TOP, SKY_MARGIN, SOLID_THRESHOLD,
    WALL_W,
};
use crate::map::noise::WarpField;
use crate::map::Mask;
use crate::math::{lerp, smoothstep};
use crate::rng::substream;
use rand::Rng;

/// Tunables for one generation attempt.
///
/// The safe preset (T1.11) is this struct with milder values, which is why these
/// live here rather than being read from constants at each use site.
#[derive(Clone, Debug, PartialEq)]
pub struct GenParams {
    pub scale: MapScale,
    pub solid_threshold: f32,
    pub bias_top: f32,
    pub bias_bottom: f32,
    pub blob_count: u32,
    pub cave_tunnels: u32,
    // v2 (docs/70-amendments-v2.md §A2)
    pub bridge_count: u32,
    pub cave_chambers: u32,
    pub crevice_count: u32,
    pub void_count: u32,
}

impl GenParams {
    pub fn default_for(scale: MapScale) -> Self {
        let p = scale.params();
        GenParams {
            scale,
            solid_threshold: SOLID_THRESHOLD,
            bias_top: GRADIENT_BIAS_TOP,
            bias_bottom: GRADIENT_BIAS_BOTTOM,
            blob_count: p.blob_count,
            cave_tunnels: p.cave_tunnels,
            bridge_count: p.bridge_count,
            cave_chambers: p.cave_chambers,
            crevice_count: p.crevice_count,
            void_count: p.void_count,
        }
    }

    /// The last-resort fallback: duller, but reliably connected.
    ///
    /// Lower threshold and a stronger bottom bias mean more solid rock; halved
    /// blobs and tunnels mean less of it is carved away. Per
    /// `docs/70-amendments-v2.md` §A2 the safe preset also drops voids and crevices
    /// entirely and keeps at least two bridges, since those are the passes most
    /// likely to have fragmented the map in the first place.
    pub fn safe_for(scale: MapScale) -> Self {
        let d = Self::default_for(scale);
        GenParams {
            solid_threshold: d.solid_threshold - 0.06,
            bias_bottom: 0.55,
            blob_count: d.blob_count / 2,
            cave_tunnels: d.cave_tunnels / 2,
            cave_chambers: d.cave_chambers / 2,
            crevice_count: 0,
            void_count: 0,
            bridge_count: d.bridge_count.max(2),
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

/// The one `u64` the noise functions need, drawn from the terrain sub-stream.
///
/// Drawn once and passed down rather than threading the RNG into a
/// multi-million-iteration loop: the noise functions are pure and stateless.
pub fn terrain_seed(seed: u64) -> u64 {
    substream(seed, "terrain").gen()
}

/// Pass 2. A fresh mask filled with the thresholded, biased, warped noise field,
/// with the borders forced.
pub fn silhouette(seed: u64, params: &GenParams) -> Mask {
    let (w, h) = (params.width(), params.height());
    let mut mask = Mask::new_empty(w, h);
    let tseed = terrain_seed(seed);

    let threshold = params.solid_threshold;
    let inv_h = 1.0 / h as f32;

    // The warp displacement is a very low-frequency field (its lattice cell is
    // ~333 px). Precomputing it removes two of the three fBm evaluations from the
    // per-pixel cost; see `noise::WarpField`.
    let warp = WarpField::build(w, h, tseed);

    // Row-major with a run accumulator: the mask writes whole words rather than
    // one bit at a time whenever several pixels in a row agree, which they usually
    // do. Only the field evaluation is genuinely per pixel.
    for y in 0..h as i32 {
        let t = y as f32 * inv_h;
        let bias = lerp(params.bias_top, params.bias_bottom, smoothstep(t));
        // Fold the bias into the threshold instead of adding it to every sample.
        let row_threshold = threshold - bias;
        let fy = y as f32;

        let mut run_start: i32 = -1;
        for x in 0..w as i32 {
            let solid = warp.sample(x as f32, fy, tseed) > row_threshold;
            if solid {
                if run_start < 0 {
                    run_start = x;
                }
            } else if run_start >= 0 {
                mask.set_run(y, run_start, x - 1);
                run_start = -1;
            }
        }
        if run_start >= 0 {
            mask.set_run(y, run_start, w as i32 - 1);
        }
    }

    force_borders(&mut mask);
    mask
}

/// Force the floor crust, side walls and the sky margin.
///
/// A separate public function because passes 3–6 all disturb the borders and each
/// must re-apply it. Written once here so there are not four subtly different
/// copies.
pub fn force_borders(mask: &mut Mask) {
    let (w, h) = (mask.w as i32, mask.h as i32);

    // Sky: the top band is always empty, so crates have somewhere to fall from.
    for y in 0..SKY_MARGIN as i32 {
        mask.clear_run(y, 0, w - 1);
    }

    // The floor: the bottom band always comes out of generation solid.
    //
    // It is **not** indestructible any more (§C15) — `BEDROCK_H` is 0 and
    // `carve_circle` will happily dig through this. That is the point: what this
    // guarantees is only that every map *starts* with a floor.
    for y in (h - FLOOR_CRUST as i32)..h {
        mask.set_run(y, 0, w - 1);
    }

    // Walls: both edge bands are solid, below the sky margin. Leaving them clear
    // inside the sky margin keeps the top genuinely open.
    for y in SKY_MARGIN as i32..h {
        mask.set_run(y, 0, WALL_W as i32 - 1);
        mask.set_run(y, w - WALL_W as i32, w - 1);
    }
}

/// True when every border invariant holds. Used by tests after every pass.
pub fn borders_hold(mask: &Mask) -> bool {
    let (w, h) = (mask.w as i32, mask.h as i32);
    for y in 0..SKY_MARGIN as i32 {
        if mask.count_run(y, 0, w - 1) != 0 {
            return false;
        }
    }
    for y in (h - FLOOR_CRUST as i32)..h {
        if mask.count_run(y, 0, w - 1) != w as u32 {
            return false;
        }
    }
    for y in SKY_MARGIN as i32..h {
        if mask.count_run(y, 0, WALL_W as i32 - 1) != WALL_W
            || mask.count_run(y, w - WALL_W as i32, w - 1) != WALL_W
        {
            return false;
        }
    }
    true
}

/// Solid pixels as a fraction of the whole map.
pub fn solid_fraction(mask: &Mask) -> f32 {
    mask.count_solid() as f32 / (mask.w as f32 * mask.h as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::CHUNK_SIZE;

    /// Small scale for speed. The per-pixel rule does not vary with size, and the
    /// large-scale cost is measured separately in `large_scale_generation_cost`.
    fn params() -> GenParams {
        GenParams::default_for(MapScale::Small)
    }

    #[test]
    fn determinism() {
        let p = params();
        let first = silhouette(4242, &p).hash();
        for _ in 0..20 {
            assert_eq!(silhouette(4242, &p).hash(), first);
        }
    }

    #[test]
    fn different_seeds_produce_different_masks() {
        let p = params();
        assert_ne!(silhouette(1, &p).hash(), silhouette(2, &p).hash());
    }

    #[test]
    fn dimensions_match_the_scale() {
        for scale in MapScale::ALL {
            let p = GenParams::default_for(scale);
            let m = silhouette(7, &p);
            assert_eq!((m.w, m.h), (p.width(), p.height()), "{scale:?}");
            assert!(m.w.is_multiple_of(CHUNK_SIZE) && m.h.is_multiple_of(CHUNK_SIZE));
        }
    }

    #[test]
    fn borders_hold_after_silhouette() {
        let p = params();
        for seed in 0..10 {
            let m = silhouette(seed, &p);
            assert!(borders_hold(&m), "seed {seed}");
        }
    }

    #[test]
    fn borders_are_exactly_as_specified() {
        let m = silhouette(5, &params());
        let (w, h) = (m.w as i32, m.h as i32);

        // Sky empty.
        for y in 0..SKY_MARGIN as i32 {
            for x in 0..w {
                assert!(!m.get(x, y), "sky pixel set at ({x},{y})");
            }
        }
        // The floor crust comes out of generation solid.
        for y in (h - FLOOR_CRUST as i32)..h {
            for x in 0..w {
                assert!(m.get(x, y), "floor crust pixel clear at ({x},{y})");
            }
        }
        // Walls solid below the sky margin.
        for y in SKY_MARGIN as i32..h {
            for x in 0..WALL_W as i32 {
                assert!(m.get(x, y), "left wall clear at ({x},{y})");
                assert!(
                    m.get(w - 1 - x, y),
                    "right wall clear at ({},{y})",
                    w - 1 - x
                );
            }
        }
    }

    #[test]
    fn force_borders_is_idempotent() {
        let mut m = silhouette(11, &params());
        let once = m.hash();
        force_borders(&mut m);
        assert_eq!(m.hash(), once);
        force_borders(&mut m);
        assert_eq!(m.hash(), once);
    }

    #[test]
    fn solid_fraction_is_in_a_sane_band() {
        // Outside roughly 0.25..0.65 the threshold or bias is misconfigured and
        // every later pass will struggle. Catch it here rather than in validation.
        //
        // Small scale, 12 seeds, so the routine suite stays fast; the full 50-seed
        // medium sweep the task asks for is `solid_fraction_sweep_medium` below.
        let p = params();
        for seed in 0..12 {
            let f = solid_fraction(&silhouette(seed * 7919, &p));
            assert!(
                (0.25..=0.65).contains(&f),
                "seed {seed}: solid fraction {f} outside 0.25..0.65"
            );
        }
    }

    /// The task's full sweep: 50 seeds at medium scale. 50 x 4.7 Mpx is ~100 s in a
    /// debug build and under 15 s in release, so it is release-only:
    ///
    /// ```sh
    /// cargo test -p game-core --release silhouette -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "slow in debug; run with --release --ignored"]
    fn solid_fraction_sweep_medium() {
        let p = GenParams::default_for(MapScale::Medium);
        let (mut lo, mut hi) = (f32::MAX, f32::MIN);
        for seed in 0..50 {
            let f = solid_fraction(&silhouette(seed * 7919, &p));
            assert!(
                (0.25..=0.65).contains(&f),
                "seed {seed}: solid fraction {f} outside 0.25..0.65"
            );
            lo = lo.min(f);
            hi = hi.max(f);
        }
        println!("medium solid fraction over 50 seeds: {lo:.3} .. {hi:.3}");
    }

    #[test]
    fn the_bias_makes_the_bottom_solid_and_the_top_open() {
        let p = params();
        let m = silhouette(3, &p);
        let (w, h) = (m.w as i32, m.h as i32);

        // Compare a band just below the sky margin against one just above the floor.
        let top_band = SKY_MARGIN as i32 + 8;
        let bottom_band = h - FLOOR_CRUST as i32 - 8;
        let top_solid: u32 = (0..8).map(|d| m.count_run(top_band + d, 0, w - 1)).sum();
        let bottom_solid: u32 = (0..8).map(|d| m.count_run(bottom_band - d, 0, w - 1)).sum();

        assert!(
            bottom_solid > top_solid * 2,
            "bias not applied or inverted: top {top_solid}, bottom {bottom_solid}"
        );
    }

    #[test]
    fn safe_preset_is_more_solid_than_the_default() {
        for scale in MapScale::ALL {
            let d = GenParams::default_for(scale);
            let s = GenParams::safe_for(scale);
            let seed = 8080;
            let df = solid_fraction(&silhouette(seed, &d));
            let sf = solid_fraction(&silhouette(seed, &s));
            assert!(sf > df, "{scale:?}: safe {sf} not above default {df}");
            // And it carves less away in the later passes.
            assert!(s.blob_count <= d.blob_count);
            assert!(s.cave_tunnels <= d.cave_tunnels);
            assert_eq!(s.void_count, 0);
            assert_eq!(s.crevice_count, 0);
            assert!(s.bridge_count >= 2);
        }
    }

    #[test]
    fn params_carry_the_v2_per_scale_counts() {
        let p = GenParams::default_for(MapScale::Large);
        assert_eq!(p.blob_count, 15);
        assert_eq!(p.cave_chambers, 8);
        assert_eq!(p.crevice_count, 10);
        assert_eq!(p.void_count, 8);
        assert_eq!(p.bridge_count, 6);
    }

    /// The cost check. This is the most expensive loop in the project and it runs
    /// over 8.4M pixels at large scale.
    ///
    /// Ignored by default because it is unbearable in a debug build (the noise is
    /// ~60 hash calls per pixel with no inlining). Run it with:
    ///
    /// ```sh
    /// cargo test -p game-core --release silhouette -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "slow in debug; run with --release --ignored"]
    fn large_scale_generation_cost() {
        use std::time::Instant;
        let p = GenParams::default_for(MapScale::Large);
        let t = Instant::now();
        let m = silhouette(1234, &p);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "large silhouette: {ms:.0} ms for {}x{} ({:.0} Mpx), solid {:.3}",
            m.w,
            m.h,
            (m.w as f64 * m.h as f64) / 1e6,
            solid_fraction(&m)
        );
        // docs/60-testing.md §6 budgets < 1000 ms for a medium map in release.
        // Large is ~1.8x medium, so this ceiling is generous and only catches a
        // real regression.
        assert!(ms < 4000.0, "large silhouette took {ms:.0} ms");
    }
}
