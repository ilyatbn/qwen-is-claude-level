//! T23.30 C — the **Islands** map shape (`docs/78` §A5): no ground, only floating
//! islands high in the clouds; fall off one and you die in the void under the map
//! (`World::body_in_the_void`, unchanged). `tasks/M23/map-shapes/islands.png`.
//!
//! Islands are laid one per cell of a jittered grid (`ISLANDS_CELL_W` × `_H`) over
//! the band from the sky margin to `ISLANDS_LOWEST_FRAC`, each cell filled with
//! `ISLANDS_FILL_CHANCE`: an elongated blob ([`stamp_island`] — circles along a gently
//! bent spine, fat in the middle, with a keel hung under it), half of them with a second
//! offset lobe for the reference's hooks and bananas. **No floor crust and no side walls** — the
//! map's sides are held by the body clamp (`physics::resolve`), and anything with
//! rock under it to the bottom row would be ground. Then the shared tail: smoothing,
//! cleanup, objects, surface and the traversal gate, which is what decides that every
//! island can be reached from the others (`traversal::analyse`'s jetpack edges).

use crate::constants::{
    MapGenerator, MapShape, FLOOR_CRUST, ISLANDS_CELL_H, ISLANDS_CELL_W, ISLANDS_FILL_CHANCE,
    ISLANDS_HALF_H_MAX, ISLANDS_HALF_H_MIN, ISLANDS_HALF_W_MAX, ISLANDS_HALF_W_MIN,
    ISLANDS_LOBE_CHANCE, ISLANDS_LOWEST_FRAC, ISLANDS_TOP_CLEARANCE, SKY_MARGIN, WALL_W,
};
use crate::map::shape::stamp_circle;
use crate::map::Mask;
use crate::math::Point;
use crate::rng::{chance, range_f32, range_i32, substream, ChaCha8Rng};

use super::v2::V2Params;
use super::{components, objects, smooth, surface, traversal, GenOutcome};

/// One attempt, no retry.
pub fn generate_once(seed: u64, params: &V2Params) -> GenOutcome {
    let (w, h) = (params.width() as i32, params.height() as i32);
    let mut mask = Mask::new_empty(w as u32, h as u32);
    let mut rng = substream(seed, "islands");

    let top = SKY_MARGIN as i32 + ISLANDS_TOP_CLEARANCE;
    let bottom = (h as f32 * ISLANDS_LOWEST_FRAC) as i32;
    let cols = (w / ISLANDS_CELL_W).max(1);
    let rows = ((bottom - top) / ISLANDS_CELL_H).max(1);
    let (cw, ch) = (w / cols, (bottom - top) / rows);
    let mut centres = Vec::new();
    for row in 0..rows {
        for col in 0..cols {
            if !chance(&mut rng, ISLANDS_FILL_CHANCE) {
                continue;
            }
            let half_w =
                range_i32(&mut rng, ISLANDS_HALF_W_MIN, ISLANDS_HALF_W_MAX).min(cw / 2 - 24);
            let half_h = range_i32(&mut rng, ISLANDS_HALF_H_MIN, ISLANDS_HALF_H_MAX);
            let x0 = col * cw + half_w + 24;
            let x1 = (col + 1) * cw - half_w - 24;
            let y0 = top + row * ch + half_h;
            let y1 = top + (row + 1) * ch - half_h * 3;
            let c = Point::new(
                range_i32(&mut rng, x0, x1.max(x0)),
                range_i32(&mut rng, y0, y1.max(y0)),
            );
            stamp_island(&mut mask, &mut rng, c, half_w, half_h);
            if chance(&mut rng, ISLANDS_LOBE_CHANCE) {
                // A smaller lobe overlapping one end, up or down a little: the slab
                // grows a hook rather than a twin.
                let side = if chance(&mut rng, 0.5) { 1 } else { -1 };
                let lw = half_w / 2;
                let lh = (half_h * 3) / 4;
                let lc = Point::new(
                    c.x + side * (half_w - lw / 2),
                    c.y + range_i32(&mut rng, -half_h / 2, half_h / 2),
                );
                stamp_island(&mut mask, &mut rng, lc, lw, lh);
            }
            centres.push(c);
        }
    }
    // The sky margin stays open (crates fall from it); there is no floor and no wall.
    for y in 0..SKY_MARGIN as i32 {
        mask.clear_run(y, 0, w - 1);
    }

    let pre_carve = mask.clone();
    smooth::smooth(&mut mask);
    let sealed_pockets = components::cleanup(&mut mask);
    // Smoothing and cleanup re-lay the floor crust and the walls (`force_borders`);
    // this shape has neither, so they come out again before anything stands on them.
    clear_borders(&mut mask);
    let placement =
        objects::stamp_objects_counted(&mut mask, seed, params.theme, params.object_count);
    let surface = surface::extract_surface(&mask);
    let report = traversal::analyse(&mask, &surface, &placement.objects);
    let landform = super::landform_of(pre_carve, &mask);

    GenOutcome {
        landform,
        mask,
        surface,
        report,
        spawn_points: Vec::new(),
        sealed_pockets,
        tunnel_paths: Vec::new(),
        islands: centres,
        objects: placement.objects,
        asteroids: Vec::new(),
        seed,
        requested_seed: seed,
        attempts: 1,
        used_safe_preset: false,
        generator: MapGenerator::V2,
        shape: MapShape::Islands,
    }
}

/// An island: circles along a spine `2·half_w` long, bent by a random sag, their radius
/// fattest mid-span (`half_h`) and tapering to a third at the tips, with a keel of
/// smaller circles hung under the middle — the reference's long, rounded slabs rather
/// than a stack of layers.
fn stamp_island(mask: &mut Mask, rng: &mut ChaCha8Rng, c: Point, half_w: i32, half_h: i32) {
    let steps = (2 * half_w / (half_h / 2).max(8)).max(4);
    let sag = range_f32(rng, -0.6, 0.6) * half_h as f32;
    let tilt = range_f32(rng, -0.25, 0.25) * half_h as f32;
    for i in 0..=steps {
        let t = i as f32 / steps as f32; // 0..1 along the spine
        let u = 2.0 * t - 1.0; // −1..1
        let x = c.x as f32 + u * (half_w - half_h / 3) as f32;
        let y = c.y as f32 + sag * (1.0 - u * u) + tilt * u;
        let r = half_h as f32 * (0.35 + 0.65 * (1.0 - u * u).sqrt()) * range_f32(rng, 0.85, 1.1);
        stamp_circle(
            mask,
            x.round() as i32,
            y.round() as i32,
            r.round() as i32,
            true,
        );
    }
    // The keel: rock hanging under the middle, so the island has depth.
    let keel = range_i32(rng, 2, 4);
    for k in 0..keel {
        let u = range_f32(rng, -0.5, 0.5);
        let r = half_h as f32 * range_f32(rng, 0.5, 0.8) * (1.0 - k as f32 * 0.15);
        let x = c.x as f32 + u * half_w as f32;
        let y = c.y as f32 + sag * (1.0 - u * u) + half_h as f32 * (0.4 + 0.35 * k as f32);
        stamp_circle(
            mask,
            x.round() as i32,
            y.round() as i32,
            r.round() as i32,
            true,
        );
    }
}

/// Air where `force_borders` lays the floor crust and the side walls.
fn clear_borders(mask: &mut Mask) {
    let (w, h) = (mask.w as i32, mask.h as i32);
    for y in (h - FLOOR_CRUST as i32).max(0)..h {
        mask.clear_run(y, 0, w - 1);
    }
    for y in 0..h {
        mask.clear_run(y, 0, WALL_W as i32 - 1);
        mask.clear_run(y, w - WALL_W as i32, w - 1);
    }
}
