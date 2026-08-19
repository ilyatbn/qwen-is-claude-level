//! `physics` — terrain colliders and the rapier world (docs/00 §5, docs/01 §6).
//!
//! ## Division of responsibility (DEVIATIONS.md D2)
//!
//! T2.6 says to drive players with `world.integrate_forces`, which is not a
//! rapier API, and the exact-value assertions in T2.3–T2.5 (`Δx == 70 px` over
//! 10 ticks, apex 58–63 px, fuel exact to 0.01) are not reproducible through a
//! constraint solver. So:
//!
//! - **Movement is the pure step functions'** (`player::step_*`). They own the
//!   documented numbers and their tests.
//! - **Rapier resolves collisions** against terrain colliders only.
//! - **Ground detection is the 2 px tile probe**, which T2.6 step 3 itself
//!   mandates as "deterministic, doc §4".

use crate::map::Map;
use crate::tiles::TILE_SIZE;

/// One horizontal run of solid tiles in a row (docs/01 §6).
///
/// "Solid tiles merged into horizontal AABB segments: scan each row, group
/// consecutive solid tiles into segments; one rapier fixed collider per
/// segment."
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub row: u32,
    /// First solid tile column, inclusive.
    pub start_x: u32,
    /// Last solid tile column, inclusive.
    pub end_x: u32,
}

impl Segment {
    /// Tile count in this run.
    pub fn len(&self) -> u32 {
        self.end_x - self.start_x + 1
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    /// Half-extents in pixels (docs/01 §6: "half-extents from segment length ×
    /// 16 px").
    pub fn half_extents(&self) -> (f32, f32) {
        (self.len() as f32 * TILE_SIZE / 2.0, TILE_SIZE / 2.0)
    }

    /// Centre of the segment's AABB, in pixels.
    pub fn centre(&self) -> (f32, f32) {
        let x = (self.start_x as f32 + self.len() as f32 / 2.0) * TILE_SIZE;
        let y = (self.row as f32 + 0.5) * TILE_SIZE;
        (x, y)
    }
}

/// Collect the horizontal solid runs of one row (docs/01 §6).
pub fn row_segments(map: &Map, row: u32) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut start: Option<u32> = None;

    for x in 0..map.width {
        if map.is_solid(x, row) {
            start.get_or_insert(x);
        } else if let Some(s) = start.take() {
            segments.push(Segment {
                row,
                start_x: s,
                end_x: x - 1,
            });
        }
    }
    // A run reaching the right edge is closed here.
    if let Some(s) = start {
        segments.push(Segment {
            row,
            start_x: s,
            end_x: map.width - 1,
        });
    }
    segments
}

/// Every terrain segment in the map, row by row (docs/01 §6).
pub fn all_segments(map: &Map) -> Vec<Segment> {
    (0..map.height).flat_map(|row| row_segments(map, row)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::Scale;
    use crate::tiles::{Tile, TileKind};

    fn blank(scale: Scale) -> Map {
        let (width, height) = scale.dimensions();
        Map {
            seed: 0,
            scale,
            width,
            height,
            tiles: vec![Tile::AIR; (width * height) as usize],
            decor: Vec::new(),
            spawns: Vec::new(),
            version: 0,
        }
    }

    #[test]
    fn row_segments_merges_consecutive_solid_tiles() {
        // docs/01 §6.
        let mut map = blank(Scale::Small);
        for x in 3..=7 {
            map.set_tile(x, 10, Tile::new(TileKind::Stone));
        }
        for x in 20..=21 {
            map.set_tile(x, 10, Tile::new(TileKind::Dirt));
        }
        let segments = row_segments(&map, 10);
        assert_eq!(
            segments,
            vec![
                Segment { row: 10, start_x: 3, end_x: 7 },
                Segment { row: 10, start_x: 20, end_x: 21 },
            ],
        );
        assert_eq!(segments[0].len(), 5);
    }

    #[test]
    fn a_gap_of_one_tile_splits_a_segment() {
        // The case that matters after a blast: one destroyed tile must break
        // the run, or the player walks on air.
        let mut map = blank(Scale::Small);
        for x in 0..10 {
            map.set_tile(x, 5, Tile::new(TileKind::Stone));
        }
        assert_eq!(row_segments(&map, 5).len(), 1);
        map.destroy_tile(4, 5);
        assert_eq!(
            row_segments(&map, 5),
            vec![
                Segment { row: 5, start_x: 0, end_x: 3 },
                Segment { row: 5, start_x: 5, end_x: 9 },
            ],
        );
    }

    #[test]
    fn a_run_reaching_the_right_edge_is_closed() {
        // Off-by-one guard: the loop closes runs when it sees AIR, so a run
        // ending at the last column needs explicit handling.
        let mut map = blank(Scale::Small);
        let last = map.width - 1;
        for x in (last - 3)..=last {
            map.set_tile(x, 7, Tile::new(TileKind::Stone));
        }
        assert_eq!(
            row_segments(&map, 7),
            vec![Segment { row: 7, start_x: last - 3, end_x: last }],
        );
    }

    #[test]
    fn an_empty_row_has_no_segments() {
        let map = blank(Scale::Small);
        assert!(row_segments(&map, 0).is_empty());
    }

    #[test]
    fn segment_geometry_matches_tile_bounds() {
        // docs/01 §6: half-extents from segment length x 16 px.
        let seg = Segment { row: 2, start_x: 4, end_x: 7 };
        assert_eq!(seg.len(), 4);
        assert_eq!(seg.half_extents(), (32.0, 8.0));
        // Centre must sit at the middle of tiles 4..=7 => x 64..128 -> 96.
        assert_eq!(seg.centre(), (96.0, 40.0));
        let (hx, hy) = seg.half_extents();
        let (cx, cy) = seg.centre();
        assert_eq!(cx - hx, 4.0 * TILE_SIZE, "left edge is the first tile's left");
        assert_eq!(cx + hx, 8.0 * TILE_SIZE, "right edge is the last tile's right");
        assert_eq!(cy - hy, 2.0 * TILE_SIZE);
    }

    #[test]
    fn all_segments_covers_every_solid_tile_exactly_once() {
        // The invariant that makes collider rebuild safe: segments partition
        // the solid tiles — no gaps, no double cover.
        let map = Map::generate(3, Scale::Small);
        let mut covered = vec![0u8; (map.width * map.height) as usize];
        for seg in all_segments(&map) {
            for x in seg.start_x..=seg.end_x {
                covered[(seg.row * map.width + x) as usize] += 1;
            }
        }
        for y in 0..map.height {
            for x in 0..map.width {
                let n = covered[(y * map.width + x) as usize];
                let solid = map.is_solid(x, y);
                assert_eq!(
                    n,
                    u8::from(solid),
                    "tile ({x},{y}) solid={solid} covered {n} times",
                );
            }
        }
    }
}
