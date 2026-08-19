//! `map` — generation and destruction (docs/01-map.md).
//!
//! "Most important system. Everything here is deterministic from
//! `(seed, scale)`." — docs/01 intro.

use crate::tiles::{Decor, Tile, TileKind, TILE_SIZE};
use crate::Vec2;
use serde::{Deserialize, Serialize};

/// Map scale (docs/01 §1). Chosen by the server per round.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Scale {
    Small,
    Medium,
    Large,
}

impl Scale {
    /// All scales, for exhaustive tests.
    pub const ALL: [Scale; 3] = [Scale::Small, Scale::Medium, Scale::Large];

    /// Grid size in tiles (docs/01 §1 table).
    pub const fn dimensions(self) -> (u32, u32) {
        match self {
            Scale::Small => (96, 64),
            Scale::Medium => (160, 96),
            Scale::Large => (240, 128),
        }
    }

    pub const fn width(self) -> u32 {
        self.dimensions().0
    }

    pub const fn height(self) -> u32 {
        self.dimensions().1
    }

    /// Rock pocket count (docs/01 §1 table).
    pub const fn pockets(self) -> u32 {
        match self {
            Scale::Small => 8,
            Scale::Medium => 14,
            Scale::Large => 20,
        }
    }

    /// Wire name (docs/06 §6 `scale`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Scale::Small => "small",
            Scale::Medium => "medium",
            Scale::Large => "large",
        }
    }

    /// Parse a wire name. Used by the client's `?scale=` dev param (T1.10).
    pub fn from_str(text: &str) -> Option<Scale> {
        match text {
            "small" => Some(Scale::Small),
            "medium" => Some(Scale::Medium),
            "large" => Some(Scale::Large),
            _ => None,
        }
    }
}

/// The map (docs/01 §4).
#[derive(Debug, Clone, PartialEq)]
pub struct Map {
    pub seed: u64,
    pub scale: Scale,
    /// Width in tiles.
    pub width: u32,
    /// Height in tiles.
    pub height: u32,
    /// `width * height`, row-major, y=0 top (docs/01 §1).
    pub tiles: Vec<Tile>,
    pub decor: Vec<Decor>,
    /// Tile coords, len >= 6 (docs/01 §4). See DEVIATIONS.md D9 — these are
    /// tile coordinates, converted to pixels at spawn time.
    pub spawns: Vec<Vec2>,
    /// +1 on every destruction, for client sync (docs/01 §4).
    pub version: u64,
}

impl Map {
    /// Map bounds in pixels, for the camera clamp (docs/01 §1).
    pub fn pixel_size(&self) -> (f32, f32) {
        (
            self.width as f32 * TILE_SIZE,
            self.height as f32 * TILE_SIZE,
        )
    }

    /// Row-major index, or `None` if out of bounds.
    fn index(&self, x: u32, y: u32) -> Option<usize> {
        if x < self.width && y < self.height {
            Some((y * self.width + x) as usize)
        } else {
            None
        }
    }

    /// Tile at `(x, y)`. Out of bounds reads as AIR — never panics
    /// (T1.2 step 2).
    pub fn tile(&self, x: u32, y: u32) -> Tile {
        self.index(x, y)
            .and_then(|i| self.tiles.get(i).copied())
            .unwrap_or(Tile::AIR)
    }

    /// Write a tile. Out of bounds is a silent no-op — never panics.
    pub fn set_tile(&mut self, x: u32, y: u32, tile: Tile) {
        if let Some(i) = self.index(x, y) {
            if let Some(slot) = self.tiles.get_mut(i) {
                *slot = tile;
            }
        }
    }

    /// docs/01 §2: solid iff kind != AIR. Out of bounds is not solid.
    pub fn is_solid(&self, x: u32, y: u32) -> bool {
        self.tile(x, y).is_solid()
    }

    /// Topmost solid row in a column (docs/01 §4).
    ///
    /// Returns `height` for a column with no solid tile, so callers can treat
    /// "no ground" as "ground below the map".
    pub fn surface_row(&self, x: u32) -> u32 {
        (0..self.height)
            .find(|&y| self.is_solid(x, y))
            .unwrap_or(self.height)
    }

    /// Tile coords containing a pixel position. Returns `None` outside the map.
    pub fn tile_at_pixel(&self, px: f32, py: f32) -> Option<(u32, u32)> {
        if px < 0.0 || py < 0.0 {
            return None;
        }
        let x = (px / TILE_SIZE) as u32;
        let y = (py / TILE_SIZE) as u32;
        if x < self.width && y < self.height {
            Some((x, y))
        } else {
            None
        }
    }

    /// Whether the tile containing a pixel position is solid.
    ///
    /// Outside the map is NOT solid — the sides and top are open, so a player
    /// can walk off the edge (docs/01 §6: "players can fall into holes").
    pub fn is_solid_at_pixel(&self, px: f32, py: f32) -> bool {
        match self.tile_at_pixel(px, py) {
            Some((x, y)) => self.is_solid(x, y),
            None => false,
        }
    }

    /// Center of a tile in pixels (docs/01 §3 step 5).
    pub fn tile_center(x: u32, y: u32) -> Vec2 {
        Vec2::new(
            (x as f32 + 0.5) * TILE_SIZE,
            (y as f32 + 0.5) * TILE_SIZE,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A blank map for indexing tests, bypassing generation.
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
    fn scale_table_matches_doc() {
        // docs/01 §1 table.
        assert_eq!(Scale::Small.dimensions(), (96, 64));
        assert_eq!(Scale::Medium.dimensions(), (160, 96));
        assert_eq!(Scale::Large.dimensions(), (240, 128));
        assert_eq!(Scale::Small.pockets(), 8);
        assert_eq!(Scale::Medium.pockets(), 14);
        assert_eq!(Scale::Large.pockets(), 20);
    }

    #[test]
    fn pixel_size_matches_doc() {
        // docs/01 §1: Small 1536x1024, Medium 2560x1536, Large 3840x2048.
        assert_eq!(blank(Scale::Small).pixel_size(), (1536.0, 1024.0));
        assert_eq!(blank(Scale::Medium).pixel_size(), (2560.0, 1536.0));
        assert_eq!(blank(Scale::Large).pixel_size(), (3840.0, 2048.0));
    }

    #[test]
    fn scale_wire_names_round_trip() {
        for scale in Scale::ALL {
            assert_eq!(Scale::from_str(scale.as_str()), Some(scale));
        }
        assert_eq!(Scale::from_str("huge"), None);
    }

    #[test]
    fn set_and_get_round_trip() {
        let mut map = blank(Scale::Small);
        let tile = Tile::new(TileKind::Stone);
        map.set_tile(5, 7, tile);
        assert_eq!(map.tile(5, 7), tile);
        assert!(map.is_solid(5, 7));
    }

    #[test]
    fn indexing_is_row_major_with_y0_on_top() {
        // docs/01 §1: "Grid is row-major, y=0 is the TOP row."
        let mut map = blank(Scale::Small);
        map.set_tile(0, 0, Tile::new(TileKind::Grass));
        map.set_tile(1, 0, Tile::new(TileKind::Dirt));
        map.set_tile(0, 1, Tile::new(TileKind::Stone));
        assert_eq!(map.tiles[0].kind, TileKind::Grass);
        assert_eq!(map.tiles[1].kind, TileKind::Dirt);
        assert_eq!(map.tiles[map.width as usize].kind, TileKind::Stone);
    }

    #[test]
    fn out_of_bounds_reads_as_air_and_never_panics() {
        // T1.2 step 2: "out-of-bounds = AIR, never panic".
        let mut map = blank(Scale::Small);
        let (w, h) = (map.width, map.height);
        for (x, y) in [(w, 0), (0, h), (w, h), (u32::MAX, 0), (0, u32::MAX)] {
            assert_eq!(map.tile(x, y), Tile::AIR);
            assert!(!map.is_solid(x, y));
            // Writing out of bounds is a no-op, not a panic or a wrap-around.
            map.set_tile(x, y, Tile::new(TileKind::Stone));
        }
        assert!(map.tiles.iter().all(|t| !t.is_solid()));
    }

    #[test]
    fn surface_row_finds_topmost_solid() {
        let mut map = blank(Scale::Small);
        assert_eq!(map.surface_row(3), map.height, "empty column has no surface");
        map.set_tile(3, 40, Tile::new(TileKind::Stone));
        map.set_tile(3, 20, Tile::new(TileKind::Grass));
        assert_eq!(map.surface_row(3), 20);
    }

    #[test]
    fn tile_center_is_tile_midpoint() {
        // docs/01 §3 step 5: ((x+0.5)*16, (y+0.5)*16)
        assert_eq!(Map::tile_center(0, 0), Vec2::new(8.0, 8.0));
        assert_eq!(Map::tile_center(2, 3), Vec2::new(40.0, 56.0));
    }

    #[test]
    fn pixel_lookup_maps_to_the_containing_tile() {
        let mut map = blank(Scale::Small);
        map.set_tile(2, 3, Tile::new(TileKind::Dirt));
        assert_eq!(map.tile_at_pixel(32.0, 48.0), Some((2, 3)));
        assert_eq!(map.tile_at_pixel(47.9, 63.9), Some((2, 3)));
        assert!(map.is_solid_at_pixel(40.0, 56.0));
        // Off-map in every direction is not solid, so edges stay walk-off-able.
        assert!(!map.is_solid_at_pixel(-1.0, 56.0));
        assert!(!map.is_solid_at_pixel(40.0, -1.0));
        assert_eq!(map.tile_at_pixel(-0.1, 0.0), None);
        assert_eq!(map.tile_at_pixel(1e9, 1e9), None);
    }
}
