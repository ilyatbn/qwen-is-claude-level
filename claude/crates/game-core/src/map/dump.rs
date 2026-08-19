//! PNG dumps of generated maps. Feature-gated behind `dump-png`.
//!
//! This is the fastest way to answer "does it look like Worms?" — no browser, no
//! client, no server. It is also the direct visual answer to "why did validation
//! reject this map?".
//!
//! The `png` crate is deliberately **not** a default dependency: `game-core` is
//! compiled to WebAssembly and a PNG encoder has no business in the browser bundle.
//!
//! See `docs/61-logging-debug.md` §6.

use std::fs::{self, File};
use std::io::BufWriter;
use std::path::Path;

use crate::constants::{BEDROCK_H, WALL_W};
use crate::map::gen::traversal::TraversalReport;
use crate::map::Map;
use crate::math::Point;

const AIR: [u8; 3] = [0x9c, 0xc7, 0xe8];
const ROCK: [u8; 3] = [0x4a, 0x40, 0x3a];
const EDGE: [u8; 3] = [0x6f, 0x9e, 0x4c];
const BORDER: [u8; 3] = [0x24, 0x20, 0x1c];
// Magenta, not green: the terrain's own edge band is green, and a green cross on
// a green rim is invisible — which is exactly what the first dump showed.
const SPAWN: [u8; 3] = [0xff, 0x30, 0xc0];
const BURIED: [u8; 3] = [0xf0, 0xd0, 0x30];
const ISLAND_TOP: [u8; 3] = [0x8a, 0xb0, 0x60];

const SURFACE_ALL: [u8; 3] = [0xff, 0xff, 0xff];
const SURFACE_MAIN: [u8; 3] = [0x40, 0xe0, 0x60];
const SURFACE_ORPHAN: [u8; 3] = [0xe0, 0x40, 0x40];

fn write_png(path: &Path, w: u32, h: u32, rgb: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let file = File::create(path)?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header()?;
    writer.write_image_data(rgb)?;
    Ok(())
}

#[inline]
fn put(rgb: &mut [u8], w: u32, x: i32, y: i32, c: [u8; 3]) {
    if x < 0 || y < 0 {
        return;
    }
    let i = (y as usize * w as usize + x as usize) * 3;
    if i + 2 < rgb.len() {
        rgb[i..i + 3].copy_from_slice(&c);
    }
}

fn cross(rgb: &mut [u8], w: u32, p: Point, size: i32, c: [u8; 3]) {
    for d in -size..=size {
        put(rgb, w, p.x + d, p.y, c);
        put(rgb, w, p.x, p.y + d, c);
    }
}

fn dot(rgb: &mut [u8], w: u32, p: Point, size: i32, c: [u8; 3]) {
    for dy in -size..=size {
        for dx in -size..=size {
            if dx * dx + dy * dy <= size * size {
                put(rgb, w, p.x + dx, p.y + dy, c);
            }
        }
    }
}

/// Terrain, with spawn points as green crosses and buried slots as yellow dots.
pub fn dump_map(map: &Map, path: &Path) -> std::io::Result<()> {
    let (w, h) = (map.mask.w, map.mask.h);
    let mut rgb = vec![0u8; (w as usize) * (h as usize) * 3];

    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let solid = map.mask.get(x, y);
            let in_border = x < WALL_W as i32
                || x >= w as i32 - WALL_W as i32
                || y >= h as i32 - BEDROCK_H as i32;

            let c = if !solid {
                AIR
            } else if in_border {
                BORDER
            } else if !map.mask.get(x, y - 1) {
                // Sky-facing surface: the grass rim, which is what makes the
                // silhouette readable as ground rather than as a blob.
                EDGE
            } else if !map.mask.get(x, y - 4) {
                ISLAND_TOP
            } else {
                ROCK
            };
            put(&mut rgb, w, x, y, c);
        }
    }

    for s in &map.meta.spawn_points {
        cross(&mut rgb, w, *s, 14, SPAWN);
        dot(&mut rgb, w, *s, 4, SPAWN);
    }
    for b in &map.meta.buried_slots {
        dot(&mut rgb, w, b.pos, 6, BURIED);
    }

    write_png(path, w, h, &rgb)
}

/// The surface point set: white for all points, green for the largest traversable
/// component, red for orphans. The direct visual answer to a rejected map.
pub fn dump_surface(map: &Map, report: &TraversalReport, path: &Path) -> std::io::Result<()> {
    let (w, h) = (map.mask.w, map.mask.h);
    let mut rgb = vec![0u8; (w as usize) * (h as usize) * 3];

    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let c = if map.mask.get(x, y) {
                [0x28, 0x28, 0x28]
            } else {
                [0x10, 0x14, 0x1c]
            };
            put(&mut rgb, w, x, y, c);
        }
    }

    let in_main: std::collections::HashSet<usize> =
        report.largest_component.iter().copied().collect();

    for (i, p) in map.meta.surface_points.iter().enumerate() {
        let c = if in_main.contains(&i) {
            SURFACE_MAIN
        } else {
            SURFACE_ORPHAN
        };
        dot(&mut rgb, w, *p, 3, c);
        put(&mut rgb, w, p.x, p.y - 4, SURFACE_ALL);
    }

    write_png(path, w, h, &rgb)
}

/// Where the dumps go.
pub fn dump_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/mapdump")
        .components()
        .collect()
}
