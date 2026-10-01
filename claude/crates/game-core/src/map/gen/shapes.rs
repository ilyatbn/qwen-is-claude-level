//! T23.30 — map shapes (`docs/78` §A5): the lobby's silhouettes beside Random.
//!
//! **The seam is v2's height profile** (`v2::generate_from_profile`). The owner
//! asked for Hill and Mostly flat to differ from today's maps in the *ground line*
//! and in nothing else — "items, objects and islands as usual" — and v2 is the
//! generator that already thinks in a ground line per column. So a shape builds a
//! [`Profile`] and hands it to the same passes Random runs (fill, roughen, islands,
//! caves, smoothing, cleanup, objects, surface, traversal), which is why nothing a
//! ground map relies on has to be re-proved for it. v1 has no ground line to bend —
//! its field puts rock everywhere — so a shaped map is always built on v2's passes,
//! whatever `MAP_GENERATOR` says; `Random` keeps the configured generator.
//!
//! Every shape is still generated per seed, on its own RNG sub-streams.

use crate::constants::{
    MapScale, MapShape, FLAT_BASE_FRAC, FLAT_UNDULATION_FRAC, FLAT_UNDULATION_WAVELENGTH_FRAC,
    FLOOR_CRUST, GROUND_CREST_HEADROOM, HILL_BASE_FRAC, HILL_COUNT_MAX, HILL_COUNT_MIN,
    HILL_HALF_WIDTH_FRAC_MAX, HILL_HALF_WIDTH_FRAC_MIN, HILL_RISE_FRAC_MAX, HILL_RISE_FRAC_MIN,
    HILL_UNDULATION_FRAC, HILL_UNDULATION_WAVELENGTH_FRAC, MAX_GEN_ATTEMPTS, SHAPE_OBJECT_SHARE,
    SKY_MARGIN, WALL_W,
};
use crate::map::noise::fbm_octaves;
use crate::rng::{range_f32, range_i32, substream};

use super::v2::ground::{apply_detail, Profile};
use super::v2::{self, V2Params};
use super::GenOutcome;

/// The passes a shape keeps and the ones it drops.
///
/// Chasms, mesas and arches are **profile features of Random** — the canyon, the
/// tower and the undercut are exactly the "random" the owner wants a choice away
/// from — so a shaped map has none. **No caves either** (builder's call, reversible
/// here): §A5's shapes exist to be "simpler for bots to play", §A6 has bots routing
/// *out* of caves, and the owner's references have none. Buried items still place —
/// `choose_buried_slots` falls back to uniform rock when there are no tunnel anchors.
/// Islands are kept at the scale's count (§A5: "still some floating islands",
/// "islands as usual").
pub fn params_for(scale: MapScale, _shape: MapShape) -> V2Params {
    let d = V2Params::default_for(scale);
    V2Params {
        chasm_count: 0,
        mesa_count: 0,
        arch_count: 0,
        cave_count: 0,
        object_count: (d.object_count as f32 * SHAPE_OBJECT_SHARE).round() as u32,
        ..d
    }
}

/// The last resort, as `V2Params::safe_for` is for Random: fewer islands.
pub fn safe_for(scale: MapScale, shape: MapShape) -> V2Params {
    let d = params_for(scale, shape);
    V2Params {
        island_count: d.island_count.min(2),
        ..d
    }
}

/// One attempt, no retry.
pub fn generate_once(seed: u64, params: &V2Params, shape: MapShape) -> GenOutcome {
    let mut o = match shape {
        // Never reached through `generate_terrain_shaped` (Random keeps its own
        // generator); here so the match is total and a direct caller gets v2.
        MapShape::Random => v2::generate_once(seed, params),
        MapShape::Hill | MapShape::Flat => {
            let profile = shaped_profile(seed, params, shape);
            v2::generate_from_profile(seed, params, &profile)
        }
    };
    o.shape = shape;
    o
}

/// Retries, then the safe preset — `v2::generate_terrain`'s loop, for a shape.
pub fn generate_terrain(requested_seed: u64, scale: MapScale, shape: MapShape) -> GenOutcome {
    let mut params = params_for(scale, shape);
    params.theme = crate::map::meta::theme_for(requested_seed);

    for attempt in 0..MAX_GEN_ATTEMPTS {
        let seed = requested_seed.wrapping_add(attempt as u64);
        let mut outcome = generate_once(seed, &params, shape);
        if outcome.report.passed {
            outcome.requested_seed = requested_seed;
            outcome.attempts = attempt + 1;
            return outcome;
        }
    }

    let mut safe = safe_for(scale, shape);
    safe.theme = params.theme;
    let mut outcome = generate_once(requested_seed, &safe, shape);
    outcome.requested_seed = requested_seed;
    outcome.attempts = MAX_GEN_ATTEMPTS;
    outcome.used_safe_preset = true;
    outcome
}

/// `gen::rederive` for a shape: the default attempt at the shipped seed if it
/// passes, else the safe preset there — the same argument `rederive`'s doc makes.
pub fn rederive(seed: u64, scale: MapScale, shape: MapShape, theme: u8) -> GenOutcome {
    let mut p = params_for(scale, shape);
    p.theme = theme;
    let o = generate_once(seed, &p, shape);
    if o.report.passed {
        return o;
    }
    let mut safe = safe_for(scale, shape);
    safe.theme = theme;
    generate_once(seed, &safe, shape)
}

/// The ground line for Hill and Mostly flat.
///
/// Both are a **plain**: a base height with a long, low fBm swell (min–max
/// normalised, as `build_profile` does, so the fraction means what it says). Hill
/// then raises `HILL_COUNT_MIN..=HILL_COUNT_MAX` smooth hills out of it — raised
/// cosines with independent left and right flanks, so a hill can lean like the
/// reference's peak — combined by `max`, so two that overlap make a ridge rather
/// than a spike. `apply_detail`'s fine wobble goes on last, as for Random.
fn shaped_profile(seed: u64, params: &V2Params, shape: MapShape) -> Profile {
    let (w, h) = (params.width() as i32, params.height() as i32);
    let floor = h - FLOOR_CRUST as i32;
    let ceiling = SKY_MARGIN as i32 + GROUND_CREST_HEADROOM;

    let (base_frac, swell_frac, wavelength_frac) = match shape {
        MapShape::Hill => (
            HILL_BASE_FRAC,
            HILL_UNDULATION_FRAC,
            HILL_UNDULATION_WAVELENGTH_FRAC,
        ),
        _ => (
            FLAT_BASE_FRAC,
            FLAT_UNDULATION_FRAC,
            FLAT_UNDULATION_WAVELENGTH_FRAC,
        ),
    };
    let base = h as f32 * base_frac;
    let swell = h as f32 * swell_frac;
    let wavelength = (w as f32 * wavelength_frac).max(1.0);

    let nseed: u64 = {
        use rand::Rng;
        substream(seed, "shape-profile").gen()
    };
    // Two octaves: a swell, and a shoulder on it. Off-lattice second coordinate for
    // `build_profile`'s reason.
    let raw: Vec<f32> = (0..w)
        .map(|x| fbm_octaves(x as f32 / wavelength, 0.53, nseed, 2))
        .collect();
    let lo = raw.iter().copied().fold(f32::MAX, f32::min);
    let hi = raw.iter().copied().fold(f32::MIN, f32::max);
    let span = (hi - lo).max(f32::EPSILON);
    let mut y: Vec<f32> = raw
        .iter()
        .map(|n| base - ((n - lo) / span - 0.5) * 2.0 * swell)
        .collect();

    if shape == MapShape::Hill {
        let lift = hills(seed, w, h);
        for (v, l) in y.iter_mut().zip(&lift) {
            *v -= l;
        }
    }

    let mut profile = Profile {
        y: y.iter().map(|v| v.round() as i32).collect(),
        floor,
        ceiling,
    };
    apply_detail(&mut profile, nseed, w);
    for v in &mut profile.y {
        *v = (*v).clamp(ceiling, floor);
    }
    profile
}

/// Per column, how far Hill's hills lift the plain, in px.
fn hills(seed: u64, w: i32, h: i32) -> Vec<f32> {
    let mut rng = substream(seed, "shape-hills");
    let mut lift = vec![0.0f32; w as usize];
    let count = range_i32(&mut rng, HILL_COUNT_MIN, HILL_COUNT_MAX);
    let margin = WALL_W as i32;
    for _ in 0..count {
        let half =
            w as f32 * range_f32(&mut rng, HILL_HALF_WIDTH_FRAC_MIN, HILL_HALF_WIDTH_FRAC_MAX);
        // Lean: each flank its own width, 0.7–1.3 of the half-width.
        let left = half * range_f32(&mut rng, 0.7, 1.3);
        let right = half * range_f32(&mut rng, 0.7, 1.3);
        let rise = h as f32 * range_f32(&mut rng, HILL_RISE_FRAC_MIN, HILL_RISE_FRAC_MAX);
        let cx = range_i32(&mut rng, margin, w - 1 - margin) as f32;
        for (x, l) in lift.iter_mut().enumerate() {
            let d = x as f32 - cx;
            let t = if d < 0.0 { -d / left } else { d / right };
            if t < 1.0 {
                let bump = 0.5 * (1.0 + (std::f32::consts::PI * t).cos());
                *l = l.max(rise * bump);
            }
        }
    }
    lift
}

/// The **ground line** of a finished mask, per column: the first air pixel going up
/// from the bottom row. Islands — rock with air under it — are ignored, which is
/// what "ground height" means in §A5's tests. Test and dump instrument.
pub fn ground_line(mask: &crate::map::Mask) -> Vec<i32> {
    let (w, h) = (mask.w as i32, mask.h as i32);
    (0..w)
        .map(|x| {
            let mut y = h - 1;
            while y >= 0 && mask.get(x, y) {
                y -= 1;
            }
            y + 1
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapGenerator, MIN_TRAVERSABLE_FRACTION};
    use crate::map::gen::generate_terrain_shaped;

    const SEEDS: [u64; 8] = [1, 7, 4242, 31337, 8123, 99, 271_828, 1_000_003];

    /// Interior columns' ground lines — walls excluded, and **columns under a placed
    /// object** too: a tree on flat ground is scenery standing on the ground line, not
    /// the ground line, and counting it measured the trees.
    fn interior(o: &GenOutcome) -> Vec<f32> {
        let g = ground_line(&o.mask);
        let m = WALL_W as usize + 1;
        let under_object = |x: usize| {
            o.objects
                .iter()
                .any(|ob| (x as i32) >= ob.x && (x as i32) < ob.x + ob.w as i32)
        };
        (m..g.len() - m)
            .filter(|&x| !under_object(x))
            .map(|x| g[x] as f32)
            .collect()
    }

    fn median(v: &[f32]) -> f32 {
        let mut s = v.to_vec();
        s.sort_by(f32::total_cmp);
        s[s.len() / 2]
    }

    /// Share of columns within `band` px of the median ground line.
    fn near_median(v: &[f32], band: f32) -> f32 {
        let m = median(v);
        v.iter().filter(|&&y| (y - m).abs() <= band).count() as f32 / v.len() as f32
    }

    /// Mostly flat, by its silhouette: across seeds and scales, **every** column's
    /// ground line within the undulation (plus roughening's reach) of the median —
    /// and Random on the same seeds is the control that the measure can fail.
    #[test]
    fn mostly_flat_is_flat_and_random_is_not() {
        for scale in MapScale::ALL {
            let h = scale.params().height as f32;
            // The swell either side, the detail wobble and a roughening circle.
            let band = h * FLAT_UNDULATION_FRAC * 2.0 + h * 0.06;
            let (mut flat_worst, mut random_best) = (1.0f32, 0.0f32);
            for seed in SEEDS {
                let flat = generate_terrain_shaped(seed, scale, MapGenerator::V2, MapShape::Flat);
                assert_eq!(flat.shape, MapShape::Flat);
                flat_worst = flat_worst.min(near_median(&interior(&flat), band));
                let random =
                    generate_terrain_shaped(seed, scale, MapGenerator::V2, MapShape::Random);
                random_best = random_best.max(near_median(&interior(&random), band));
            }
            println!("{scale:?}: flat worst {flat_worst:.3}, random best {random_best:.3} within {band:.0} px");
            assert!(
                flat_worst >= 0.97,
                "{scale:?}: a Flat map strays from flat ({flat_worst:.3})"
            );
            assert!(
                random_best < 0.9,
                "{scale:?}: control — Random reads as flat ({random_best:.3})"
            );
        }
    }

    /// Hill, by its silhouette: **mostly a plain** (most columns near the median) and
    /// **hills** (a peak well above it) — the two halves of "mostly flat ground with a
    /// few hills". Flat is the control for the second half: it has no peak.
    #[test]
    fn hill_is_a_plain_with_hills() {
        for scale in MapScale::ALL {
            let h = scale.params().height as f32;
            let band = h * 0.06;
            for seed in SEEDS {
                let hill = generate_terrain_shaped(seed, scale, MapGenerator::V2, MapShape::Hill);
                let g = interior(&hill);
                let m = median(&g);
                let peak = m - g.iter().copied().fold(f32::MAX, f32::min);
                let plain = near_median(&g, band);
                assert!(
                    peak >= h * HILL_RISE_FRAC_MIN * 0.8,
                    "{scale:?} seed {seed}: highest hill only {peak:.0} px over the plain"
                );
                assert!(
                    plain >= 0.4,
                    "{scale:?} seed {seed}: only {plain:.2} of the map is plain"
                );
                let flat = generate_terrain_shaped(seed, scale, MapGenerator::V2, MapShape::Flat);
                let f = interior(&flat);
                let flat_peak = median(&f) - f.iter().copied().fold(f32::MAX, f32::min);
                assert!(
                    flat_peak < peak,
                    "{scale:?} seed {seed}: control — Flat out-peaks Hill"
                );
            }
        }
    }

    /// The rest of the pipeline still runs: islands hang over both shapes, the
    /// traversal gate passes (no safe preset) and enough spawns exist.
    #[test]
    fn shaped_maps_keep_islands_and_pass_the_gate() {
        for shape in [MapShape::Hill, MapShape::Flat] {
            for scale in MapScale::ALL {
                for seed in SEEDS {
                    let o = generate_terrain_shaped(seed, scale, MapGenerator::V2, shape);
                    let at = format!("{shape:?} {scale:?} seed {seed}");
                    assert!(!o.islands.is_empty(), "{at}: no islands");
                    assert!(o.report.passed, "{at}: gate failed");
                    assert!(!o.used_safe_preset, "{at}: safe preset");
                    assert!(
                        o.report.traversable_fraction >= MIN_TRAVERSABLE_FRACTION,
                        "{at}"
                    );
                    assert_eq!(o.generator, MapGenerator::V2, "{at}");
                }
            }
        }
    }

    /// Same seed, same mask; different seed, different mask — per shape.
    #[test]
    fn shapes_are_deterministic_and_vary_by_seed() {
        for shape in [MapShape::Hill, MapShape::Flat] {
            let a = generate_terrain_shaped(4242, MapScale::Small, MapGenerator::V2, shape);
            let b = generate_terrain_shaped(4242, MapScale::Small, MapGenerator::V2, shape);
            // Far from 4242: a failed attempt retries on `requested + 1`, so 4243 can be
            // the very map 4242 shipped.
            let c = generate_terrain_shaped(9_999_991, MapScale::Small, MapGenerator::V2, shape);
            assert_eq!(a.mask, b.mask, "{shape:?}");
            assert_eq!(a.landform, b.landform, "{shape:?}");
            assert_ne!(a.mask, c.mask, "{shape:?}");
        }
        // And the shapes are different maps from each other on one seed.
        let hill = generate_terrain_shaped(4242, MapScale::Small, MapGenerator::V2, MapShape::Hill);
        let flat = generate_terrain_shaped(4242, MapScale::Small, MapGenerator::V2, MapShape::Flat);
        assert_ne!(hill.mask, flat.mask);
    }

    /// Space ignores the shape (§A5), and Random under v1 stays v1.
    #[test]
    fn space_and_random_ignore_the_shape_machinery() {
        let space =
            generate_terrain_shaped(7, MapScale::Small, MapGenerator::Space, MapShape::Hill);
        assert_eq!(space.generator, MapGenerator::Space);
        assert_eq!(space.shape, MapShape::Random);
        let plain = crate::map::gen::generate_terrain_with(7, MapScale::Small, MapGenerator::Space);
        assert_eq!(space.mask, plain.mask);
        let v1 = generate_terrain_shaped(7, MapScale::Small, MapGenerator::V1, MapShape::Random);
        assert_eq!(v1.generator, MapGenerator::V1);
    }
}
