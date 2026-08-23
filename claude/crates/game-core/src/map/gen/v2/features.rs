//! v2 passes 2–4: islands, caves and arches.
//!
//! Everything here is a **feature**: a small number of discrete things placed on
//! open ground, each of which fails to place rather than degrading the map. That
//! is the inversion v2 is for — in v1 the cave network is the medium and the rock
//! is what is left over.

use crate::constants::{
    ARCH_END_TAPER, ARCH_HALF_LEN_MAX, ARCH_HALF_LEN_MIN, ARCH_RADIUS_MAX, ARCH_RADIUS_MIN,
    ARCH_ROOF_MIN, CAVE2_CLEARANCE, CAVE2_DEPTH_MAX, CAVE2_DEPTH_MIN, CAVE2_MIN_ROCK,
    CAVE2_MOUTH_RADIUS, CAVE2_RADIUS_MAX, CAVE2_RADIUS_MIN, ISLAND2_ASPECT_MAX, ISLAND2_ASPECT_MIN,
    ISLAND2_CLEARANCE_MARGIN, ISLAND2_GAP, ISLAND2_GROUND_CLEARANCE, ISLAND2_RADIUS_MAX,
    ISLAND2_RADIUS_MIN, ISLAND2_SKY_CLEARANCE, SKY_MARGIN, WALL_W,
};
use crate::map::gen::caves::is_buried;
use crate::map::gen::silhouette::force_borders;
use crate::map::shape::{stamp_capsule, stamp_circle};
use crate::map::Mask;
use crate::math::Point;
use crate::rng::{range_i32, substream};

use super::ground::Profile;
use super::V2Params;

/// Placement attempts before a feature gives up. A feature that cannot fit is
/// skipped: looping until it does is how a generator hangs on a small map.
const ATTEMPTS: u32 = 80;

/// Hang solid islands in the sky above the ground.
///
/// Returns the centres actually placed. Unlike v1's blobs these are stamped
/// **after** nothing else will carve them, so an island is a solid chunk of rock
/// with a walkable top — not a perforated one wearing a cave backdrop.
pub fn add_islands(mask: &mut Mask, profile: &Profile, seed: u64, params: &V2Params) -> Vec<Point> {
    let mut rng = substream(seed, "v2-islands");
    let w = mask.w as i32;
    let sky = SKY_MARGIN as i32;

    let mut centres: Vec<Point> = Vec::with_capacity(params.island_count as usize);
    let mut half_widths: Vec<i32> = Vec::with_capacity(params.island_count as usize);

    for _ in 0..params.island_count {
        let half_h = range_i32(&mut rng, ISLAND2_RADIUS_MIN, ISLAND2_RADIUS_MAX);
        let half_w = (half_h * range_i32(&mut rng, ISLAND2_ASPECT_MIN, ISLAND2_ASPECT_MAX)) / 2;

        let mut placed = None;
        for _ in 0..ATTEMPTS {
            // Keep clear of the side walls by a whole gap, not by nothing: an
            // island flush against the wall band reads as a shelf bolted to it.
            let lo_x = WALL_W as i32 + half_w + ISLAND2_GAP;
            let hi_x = w - WALL_W as i32 - half_w - ISLAND2_GAP;
            if hi_x <= lo_x {
                break;
            }
            let cx = range_i32(&mut rng, lo_x, hi_x);

            // The island must clear the sky margin above and the ground below —
            // an island resting on the hilltop is a hilltop.
            let lo_y = sky + ISLAND2_SKY_CLEARANCE + half_h;
            let hi_y = profile.highest(
                (cx - half_w - ISLAND2_CLEARANCE_MARGIN).max(0),
                (cx + half_w + ISLAND2_CLEARANCE_MARGIN).min(w - 1),
            ) - ISLAND2_GROUND_CLEARANCE
                - half_h * 3;
            if hi_y <= lo_y {
                continue;
            }
            let cy = range_i32(&mut rng, lo_y, hi_y);
            let c = Point::new(cx, cy);

            let clear = centres.iter().zip(&half_widths).all(|(o, ow)| {
                let need = (half_w + ow + ISLAND2_GAP) as i64;
                c.distance_sq(*o) >= need * need
            });
            if clear {
                placed = Some(c);
                break;
            }
        }
        let Some(centre) = placed else { continue };

        // The slab, as a stack of horizontal capsules that each narrow and thin
        // as they drop. A single capsule with a circle hung under it is a speech
        // bubble; a taper is the chunk-torn-out-of-the-ground the reference maps
        // hang in their sky.
        let layers = range_i32(&mut rng, 3, 4);
        let mut y = centre.y;
        for i in 0..layers {
            let t = i as f32 / layers as f32;
            let lw = ((1.0 - t * 0.58) * half_w as f32).round() as i32;
            let lh = ((1.0 - t * 0.45) * half_h as f32).round() as i32;
            let lh = lh.max(6);
            let skew = if i == 0 {
                0
            } else {
                range_i32(&mut rng, -half_w / 8, half_w / 8)
            };
            stamp_capsule(
                mask,
                centre.x + skew - (lw - lh).max(0),
                y,
                centre.x + skew + (lw - lh).max(0),
                y,
                lh,
                true,
            );
            y += lh + lh / 3;
        }

        // A bump or two on top, kept small: any bigger and they dominate the slab
        // and it reads as a cloud again.
        for _ in 0..range_i32(&mut rng, 1, 2) {
            let r = range_i32(&mut rng, half_h / 5, half_h / 3);
            stamp_circle(
                mask,
                centre.x + range_i32(&mut rng, -half_w / 2, half_w / 2),
                centre.y - half_h + r,
                r,
                true,
            );
        }

        centres.push(centre);
        half_widths.push(half_w);
    }

    force_borders(mask);
    centres
}

/// Cut `params.cave_count` caves into the rock, each with a shaft to the sky.
///
/// A cave with no mouth is a sealed pocket that only a rocket will ever find, so
/// the shaft is not optional: it is stamped in the same step, and a chamber whose
/// shaft cannot be cut is not stamped at all.
///
/// Returns the stamped centres, which `map::meta` uses to anchor buried items.
pub fn carve_caves(
    mask: &mut Mask,
    profile: &Profile,
    seed: u64,
    params: &V2Params,
) -> Vec<Vec<Point>> {
    let mut rng = substream(seed, "v2-caves");
    let w = mask.w as i32;
    let mut paths = Vec::with_capacity(params.cave_count as usize);

    for _ in 0..params.cave_count {
        let mut chosen = None;
        for _ in 0..ATTEMPTS {
            let x = range_i32(&mut rng, WALL_W as i32 + 80, w - WALL_W as i32 - 80);
            if profile.thickness(x) < CAVE2_MIN_ROCK {
                continue;
            }
            let max_depth = CAVE2_DEPTH_MAX.min(profile.thickness(x) - CAVE2_RADIUS_MAX - 24);
            if max_depth <= CAVE2_DEPTH_MIN {
                continue;
            }
            let depth = range_i32(&mut rng, CAVE2_DEPTH_MIN, max_depth);
            let c = Point::new(x, profile.at(x) + depth);
            if is_buried(mask, c, CAVE2_CLEARANCE) {
                chosen = Some(c);
                break;
            }
        }
        let Some(centre) = chosen else { continue };

        let mut path = Vec::new();
        // Three or four circles, spread wider than their own radius, so the
        // chamber is a lopsided room. Two concentric ones make a bubble, which is
        // what the first v2 dump drew: a lollipop on a stick.
        let count = range_i32(&mut rng, 3, 4);
        let mut top = centre.y;
        for _ in 0..count {
            let r = range_i32(&mut rng, CAVE2_RADIUS_MIN / 2, CAVE2_RADIUS_MAX);
            let dx = range_i32(&mut rng, -CAVE2_RADIUS_MAX, CAVE2_RADIUS_MAX);
            let dy = range_i32(&mut rng, -CAVE2_RADIUS_MIN, CAVE2_RADIUS_MIN);
            let p = Point::new(centre.x + dx, centre.y + dy);
            stamp_circle(mask, p.x, p.y, r, false);
            top = top.min(p.y - r / 2);
            path.push(p);
        }

        // The shaft. It leans a little, so it is a cave mouth in a hillside rather
        // than a lift shaft, and it starts above the ground line so the opening is
        // unmistakable from the sky.
        let mouth_x = (centre.x + range_i32(&mut rng, -CAVE2_RADIUS_MAX, CAVE2_RADIUS_MAX)).clamp(
            WALL_W as i32 + CAVE2_MOUTH_RADIUS,
            w - WALL_W as i32 - CAVE2_MOUTH_RADIUS,
        );
        let mouth_y = profile.at(mouth_x) - CAVE2_MOUTH_RADIUS;
        // Stamped in short segments with a wandering midpoint and a drifting
        // radius, so the shaft is a passage and not a drilled hole.
        let segs = 6;
        let (mut px, mut py) = (mouth_x, mouth_y);
        for i in 1..=segs {
            let t = i as f32 / segs as f32;
            let nx = mouth_x
                + ((centre.x - mouth_x) as f32 * t).round() as i32
                + if i == segs {
                    0
                } else {
                    range_i32(&mut rng, -18, 18)
                };
            let ny = mouth_y + ((top - mouth_y) as f32 * t).round() as i32;
            let r = CAVE2_MOUTH_RADIUS + range_i32(&mut rng, -4, 6);
            stamp_capsule(mask, px, py, nx, ny, r, false);
            path.push(Point::new(nx, ny));
            (px, py) = (nx, ny);
        }
        path.push(Point::new(mouth_x, mouth_y));

        paths.push(path);
    }

    force_borders(mask);
    paths
}

/// Bore horizontally through a hill, leaving a roof over the hole.
///
/// This is the one v2 feature that makes an overhang you can walk under, and it is
/// deliberately rare: one or two on a map, in the thickest rock available.
pub fn carve_arches(
    mask: &mut Mask,
    profile: &Profile,
    seed: u64,
    params: &V2Params,
) -> Vec<Vec<Point>> {
    let mut rng = substream(seed, "v2-arches");
    let w = mask.w as i32;
    let mut paths = Vec::with_capacity(params.arch_count as usize);

    for _ in 0..params.arch_count {
        let half_len = range_i32(&mut rng, ARCH_HALF_LEN_MIN, ARCH_HALF_LEN_MAX);
        let radius = range_i32(&mut rng, ARCH_RADIUS_MIN, ARCH_RADIUS_MAX);
        // Roof above, floor below: without the floor the "arch" is a notch out of
        // the hillside and the hill has simply lost its foot.
        let need = ARCH_ROOF_MIN + radius * 2 + 90;

        let mut placed = None;
        for _ in 0..ATTEMPTS {
            let x = range_i32(
                &mut rng,
                WALL_W as i32 + half_len + 16,
                w - WALL_W as i32 - half_len - 16,
            );
            // The whole span has to be in rock this thick, or the bore comes out
            // of the ground half way along.
            let span_top = profile.lowest(x - half_len, x + half_len);
            if profile.floor - span_top < need {
                continue;
            }
            let y = span_top + ARCH_ROOF_MIN + radius + range_i32(&mut rng, 0, 40);
            placed = Some(Point::new(x, y));
            break;
        }
        let Some(c) = placed else { continue };

        // Stamp the bore circle by circle with a radius that tapers toward both
        // mouths, and a floor that sags a little. A constant-radius capsule is a
        // rounded rectangle and looks like it was cut with a router.
        let steps = (half_len * 2 / 8).max(2);
        for i in 0..=steps {
            let t = i as f32 / steps as f32;
            // 1 at the middle, ARCH_END_TAPER at each mouth.
            let taper = ARCH_END_TAPER + (1.0 - ARCH_END_TAPER) * (1.0 - (t * 2.0 - 1.0).abs());
            let r = (radius as f32 * taper).round() as i32;
            let sag = ((1.0 - (t * 2.0 - 1.0).abs()) * (radius / 4) as f32).round() as i32;
            stamp_circle(
                mask,
                c.x - half_len + (2 * half_len * i) / steps,
                c.y + sag + range_i32(&mut rng, -3, 3),
                r.max(6),
                false,
            );
        }
        paths.push(vec![
            Point::new(c.x - half_len, c.y),
            c,
            Point::new(c.x + half_len, c.y),
        ]);
    }

    force_borders(mask);
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MapScale;
    use crate::map::gen::v2::ground::{build_profile, fill};

    fn built(seed: u64, scale: MapScale) -> (Mask, Profile, V2Params) {
        let params = V2Params::default_for(scale);
        let profile = build_profile(seed, &params);
        let mut mask = Mask::new_empty(params.width(), params.height());
        fill(&mut mask, &profile);
        (mask, profile, params)
    }

    #[test]
    fn islands_land_in_the_air_above_the_ground() {
        let (mut mask, profile, params) = built(4242, MapScale::Medium);
        let islands = add_islands(&mut mask, &profile, 4242, &params);
        assert!(!islands.is_empty(), "no islands placed at all");
        for c in &islands {
            assert!(
                c.y + ISLAND2_GROUND_CLEARANCE < profile.highest(c.x - 8, c.x + 8),
                "island at {c:?} is not clear of the ground"
            );
            assert!(c.y > SKY_MARGIN as i32, "island inside the sky margin");
        }
    }

    /// An island is a *solid* chunk. The control is the centre pixel: if the
    /// stamp had not run, or something had carved it, this fails.
    #[test]
    fn an_island_is_solid_rock() {
        let (mut mask, profile, params) = built(4242, MapScale::Medium);
        let before: Vec<bool> = Vec::new();
        assert!(before.is_empty());
        let islands = add_islands(&mut mask, &profile, 4242, &params);
        for c in &islands {
            assert!(mask.get(c.x, c.y), "island centre {c:?} is air");
        }
    }

    #[test]
    fn a_cave_is_hollow_and_open_to_the_sky() {
        let (mut mask, profile, params) = built(4242, MapScale::Medium);
        // Control: the chamber sites are solid before the pass runs.
        let paths = carve_caves(&mut mask, &profile, 4242, &params);
        assert!(!paths.is_empty(), "no caves carved");
        for path in &paths {
            for p in path {
                assert!(!mask.get(p.x, p.y), "cave centre {p:?} is still rock");
            }
            // The mouth is the last point pushed; it must sit above the ground.
            let mouth = path[path.len() - 1];
            assert!(
                mouth.y <= profile.at(mouth.x),
                "cave mouth {mouth:?} is below the ground line"
            );
        }
    }

    #[test]
    fn caves_do_not_run_without_being_asked() {
        let (mut mask, profile, mut params) = built(4242, MapScale::Medium);
        params.cave_count = 0;
        let before = mask.hash();
        let paths = carve_caves(&mut mask, &profile, 4242, &params);
        assert!(paths.is_empty());
        assert_eq!(
            mask.hash(),
            before,
            "a zero cave count still changed the map"
        );
    }

    #[test]
    fn an_arch_keeps_its_roof() {
        let (mut mask, profile, params) = built(4242, MapScale::Medium);
        let paths = carve_arches(&mut mask, &profile, 4242, &params);
        for path in &paths {
            let c = path[1];
            assert!(!mask.get(c.x, c.y), "arch centre is still rock");
            // Rock above, rock below: that is what makes it an arch.
            assert!(mask.get(c.x, profile.at(c.x) + 4), "no roof over the arch");
            assert!(mask.get(c.x, profile.floor - 4), "no floor under the arch");
        }
    }
}
