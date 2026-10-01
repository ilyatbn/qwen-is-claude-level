//! T23.30 B — the **Multilevel** map shape (`docs/78` §A5).
//!
//! Two grounds, one above the other: an upper band of rock with sky above it and an
//! open gap below it, and a lower ground under the gap (`tasks/M23/map-shapes/
//! multilevel.png`). No islands. Three height lines — the band's top, the band's
//! underside and the lower ground — each a gentle swell plus v2's fine wobble, filled
//! and roughened with v2's own passes; then the shared tail (smoothing, cleanup,
//! objects, surface).
//!
//! **The gate is per level** ([`analyse_levels`]). The band spans the map wall to wall,
//! so no walk, jump or jetpack crosses it — the levels join through the teleport pads,
//! which pair across them (`MapShape::level_divide`, `world::teleport`), and by digging.
//! A whole-map strongly connected set would be one level and fail the other; each
//! level is judged on its own and the component shipped is their union, so spawns
//! (farthest-point over it) land on both.

use crate::constants::{
    MapShape, FLOOR_CRUST, GROUND_CREST_HEADROOM, MIN_TRAVERSABLE_FRACTION, MULTILEVEL_BAND_FRAC,
    MULTILEVEL_LOWER_FRAC, MULTILEVEL_SWELL_FRAC, MULTILEVEL_TOP_FRAC, MULTILEVEL_WAVELENGTH_FRAC,
    SKY_MARGIN, SPAWN_COUNT_MIN, SPAWN_MIN_SEPARATION,
};
use crate::map::gen::objects::{self as gen_objects, PlacedObject, WhenStarved};
use crate::map::gen::silhouette::force_borders;
use crate::map::gen::traversal::{self, TraversalReport};
use crate::map::noise::fbm_octaves;
use crate::map::Mask;
use crate::math::Point;
use crate::rng::substream;

use super::v2::ground::{self, apply_detail, Profile};
use super::v2::V2Params;
use super::{components, objects, smooth, surface, GenOutcome};

/// One attempt, no retry.
pub fn generate_once(seed: u64, params: &V2Params) -> GenOutcome {
    let (w, h) = (params.width() as i32, params.height() as i32);
    let top = line(seed, "ml-top", w, h, MULTILEVEL_TOP_FRAC);
    let under = line(
        seed,
        "ml-under",
        w,
        h,
        MULTILEVEL_TOP_FRAC + MULTILEVEL_BAND_FRAC,
    );
    let lower = line(seed, "ml-lower", w, h, MULTILEVEL_LOWER_FRAC);

    let mut mask = Mask::new_empty(w as u32, h as u32);
    ground::fill(&mut mask, &lower);
    fill_between(&mut mask, &top, &under);
    force_borders(&mut mask);
    // v2's roughening on each line, each on its own stream (`roughen` keys its
    // sub-stream off the seed it is handed).
    ground::roughen(&mut mask, &top, seed);
    ground::roughen(&mut mask, &under, seed ^ 0x6d6c_756e_6465_7231);
    ground::roughen(&mut mask, &lower, seed ^ 0x6d6c_6c6f_7765_7232);

    let pre_carve = mask.clone();
    smooth::smooth(&mut mask);
    let sealed_pockets = components::cleanup(&mut mask);
    let placement =
        objects::stamp_objects_counted(&mut mask, seed, params.theme, params.object_count);
    let surface = surface::extract_surface(&mask);
    let divide = MapShape::Multilevel
        .level_divide(h as u32)
        .expect("multilevel has a level line");
    let report = analyse_levels(&mask, &surface, &placement.objects, divide);
    let landform = super::landform_of(pre_carve, &mask);

    GenOutcome {
        landform,
        mask,
        surface,
        report,
        spawn_points: Vec::new(),
        sealed_pockets,
        tunnel_paths: Vec::new(),
        islands: Vec::new(),
        objects: placement.objects,
        asteroids: Vec::new(),
        seed,
        requested_seed: seed,
        attempts: 1,
        used_safe_preset: false,
        generator: crate::constants::MapGenerator::V2,
        shape: MapShape::Multilevel,
    }
}

/// A gentle line at `mean_frac` of the height: a two-octave swell of
/// `MULTILEVEL_SWELL_FRAC` either side (min–max normalised, as `build_profile` does),
/// then `apply_detail`'s wobble.
fn line(seed: u64, tag: &str, w: i32, h: i32, mean_frac: f32) -> Profile {
    let nseed: u64 = {
        use rand::Rng;
        substream(seed, tag).gen()
    };
    let wavelength = (w as f32 * MULTILEVEL_WAVELENGTH_FRAC).max(1.0);
    let raw: Vec<f32> = (0..w)
        .map(|x| fbm_octaves(x as f32 / wavelength, 0.71, nseed, 2))
        .collect();
    let lo = raw.iter().copied().fold(f32::MAX, f32::min);
    let hi = raw.iter().copied().fold(f32::MIN, f32::max);
    let span = (hi - lo).max(f32::EPSILON);
    let (mean, swell) = (h as f32 * mean_frac, h as f32 * MULTILEVEL_SWELL_FRAC);
    let mut p = Profile {
        y: raw
            .iter()
            .map(|n| (mean - ((n - lo) / span - 0.5) * 2.0 * swell).round() as i32)
            .collect(),
        floor: h - FLOOR_CRUST as i32,
        ceiling: SKY_MARGIN as i32 + GROUND_CREST_HEADROOM / 2,
    };
    apply_detail(&mut p, nseed, w);
    for v in &mut p.y {
        *v = (*v).clamp(p.ceiling, p.floor);
    }
    p
}

/// Rock from `top` down to `under` in every column, row-major (as `ground::fill`).
fn fill_between(mask: &mut Mask, top: &Profile, under: &Profile) {
    let (w, h) = (mask.w as i32, mask.h as i32);
    for y in 0..h {
        let mut run: i32 = -1;
        for x in 0..w {
            let solid = top.y[x as usize] <= y && y < under.y[x as usize];
            if solid && run < 0 {
                run = x;
            } else if !solid && run >= 0 {
                mask.set_run(y, run, x - 1);
                run = -1;
            }
        }
        if run >= 0 {
            mask.set_run(y, run, w - 1);
        }
    }
}

/// The traversal gate, **one level at a time** (see the module doc): the surface
/// points above `divide` and those below it are each analysed by `traversal::analyse`;
/// the map passes when each level's own strongly connected set covers
/// `MIN_TRAVERSABLE_FRACTION` of that level and the union holds `SPAWN_COUNT_MIN`
/// separated spawns clear of objects. The shipped component is the union, as indices
/// into the whole `surface`, and the fraction is the union's share of it.
pub fn analyse_levels(
    mask: &Mask,
    surface: &[Point],
    objects: &[PlacedObject],
    divide: i32,
) -> TraversalReport {
    let mut largest: Vec<usize> = Vec::new();
    let mut levels_ok = true;
    for upper in [true, false] {
        let idx: Vec<usize> = (0..surface.len())
            .filter(|&i| (surface[i].y < divide) == upper)
            .collect();
        let pts: Vec<Point> = idx.iter().map(|&i| surface[i]).collect();
        let r = traversal::analyse(mask, &pts, objects);
        levels_ok &= !pts.is_empty() && r.traversable_fraction >= MIN_TRAVERSABLE_FRACTION;
        largest.extend(r.largest_component.iter().map(|&j| idx[j]));
    }
    largest.sort_unstable();
    let clear = gen_objects::clear_of_objects(surface, &largest, objects, WhenStarved::Reject);
    let enough =
        traversal::count_separated(surface, &clear, SPAWN_MIN_SEPARATION) >= SPAWN_COUNT_MIN;
    let n = surface.len();
    TraversalReport {
        total_points: n,
        traversable_fraction: if n == 0 {
            0.0
        } else {
            largest.len() as f32 / n as f32
        },
        largest_component: largest,
        passed: levels_ok && enough,
    }
}
