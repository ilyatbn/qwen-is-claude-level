//! `map` — generation and destruction (docs/01-map.md).
//!
//! "Most important system. Everything here is deterministic from
//! `(seed, scale)`." — docs/01 intro.

use crate::rng::GameRng;
use crate::tiles::{Decor, Tile, TILE_SIZE};
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

// ---------------------------------------------------------------------------
// Generation — docs/01 §3. Order is load-bearing: "follow it exactly or
// determinism tests break."
// ---------------------------------------------------------------------------

/// 1-D value noise with cosine interpolation (docs/01 §3 step 1).
///
/// Builds a random value array `v[i] in [-1,1]` for
/// `i in 0..=ceil(width/step)+1` using the RNG, then samples at integer tile
/// columns, interpolating between `v[i]` and `v[i+1]`.
pub fn value_noise(step: u32, width: u32, rng: &mut GameRng) -> Vec<f32> {
    assert!(step > 0, "value_noise: step must be non-zero");

    // docs/01 §3 step 1: i in 0..=ceil(width/step)+1  =>  ceil+2 entries.
    let control_count = width.div_ceil(step) + 2;
    let control: Vec<f32> = (0..control_count)
        .map(|_| rng.random_unit() * 2.0 - 1.0)
        .collect();

    (0..width)
        .map(|x| {
            let scaled = x as f32 / step as f32;
            let i = (x / step) as usize;
            let frac = scaled - (x / step) as f32;
            let a = control.get(i).copied().unwrap_or(0.0);
            let b = control.get(i + 1).copied().unwrap_or(0.0);
            cosine_interpolate(a, b, frac)
        })
        .collect()
}

/// Cosine interpolation between `a` and `b` (docs/01 §3 step 1).
fn cosine_interpolate(a: f32, b: f32, t: f32) -> f32 {
    let smoothed = (1.0 - (t * std::f32::consts::PI).cos()) * 0.5;
    a * (1.0 - smoothed) + b * smoothed
}

/// Surface row per column (docs/01 §3 step 1).
///
/// `h(x) = H*0.35 + H*0.22 * (0.7*noise(step=8)(x) + 0.3*noise(step=3)(x))`,
/// clamped to `[H*0.15, H*0.6]`, then `s(x) = H - 1 - round(h(x))`.
///
/// Both noise octaves are drawn before either is sampled, in the order the
/// formula writes them (step=8 then step=3), because draw order fixes the
/// whole downstream sequence.
pub fn surface_rows(width: u32, height: u32, rng: &mut GameRng) -> Vec<u32> {
    let h = height as f32;
    let coarse = value_noise(8, width, rng);
    let fine = value_noise(3, width, rng);

    (0..width as usize)
        .map(|x| {
            let c = coarse.get(x).copied().unwrap_or(0.0);
            let f = fine.get(x).copied().unwrap_or(0.0);
            let mut height_value = h * 0.35 + h * 0.22 * (0.7 * c + 0.3 * f);
            height_value = height_value.clamp(h * 0.15, h * 0.6);
            // s(x) = H - 1 - round(h(x)); saturating so a degenerate clamp
            // cannot underflow the u32.
            let rounded = height_value.round() as i64;
            (height as i64 - 1 - rounded).clamp(0, height as i64 - 1) as u32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::TileKind;

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

    /// Expected surface-row range for a scale, derived from docs/01 §3 step 1:
    /// `h` is clamped to `[H*0.15, H*0.6]`, and `s(x) = H - 1 - round(h(x))`.
    fn expected_surface_range(height: u32) -> (u32, u32) {
        let h = height as f32;
        let lowest = height - 1 - (h * 0.6).round() as u32;
        let highest = height - 1 - (h * 0.15).round() as u32;
        (lowest, highest)
    }

    /// The doc's fixed "adjacent columns differ by <= 8 tiles" (T1.3 step 3)
    /// is unsatisfiable above Small — the worst-case single-column delta is
    /// ~0.126*H, i.e. 8.1 / 12.1 / 16.1 tiles. Measured maxima over 100 seeds
    /// are 7 / 10 / 14. See DEVIATIONS.md D3.
    fn smoothness_bound(height: u32) -> i64 {
        (0.13 * height as f32).ceil() as i64
    }

    #[test]
    fn surface_within_bounds() {
        // docs/08 §1 (map row) + T1.3 step 3: 100 seeds x 3 scales.
        for scale in Scale::ALL {
            let (width, height) = scale.dimensions();
            let (lowest, highest) = expected_surface_range(height);
            let bound = smoothness_bound(height);

            for seed in 0..100u64 {
                let mut rng = GameRng::new(seed);
                let rows = surface_rows(width, height, &mut rng);
                assert_eq!(rows.len(), width as usize);

                for (x, &row) in rows.iter().enumerate() {
                    assert!(
                        (lowest..=highest).contains(&row),
                        "{} seed {seed} col {x}: surface {row} outside [{lowest},{highest}]",
                        scale.as_str(),
                    );
                }

                for (x, pair) in rows.windows(2).enumerate() {
                    let delta = (pair[1] as i64 - pair[0] as i64).abs();
                    assert!(
                        delta <= bound,
                        "{} seed {seed} cols {x}..{}: delta {delta} exceeds {bound}",
                        scale.as_str(),
                        x + 1,
                    );
                }
            }
        }
    }

    #[test]
    fn surface_rows_are_deterministic() {
        // T1.3 Acceptance: "identical seed -> identical surface rows".
        for scale in Scale::ALL {
            let (width, height) = scale.dimensions();
            for seed in [0u64, 1, 42, 777, u64::MAX] {
                let a = surface_rows(width, height, &mut GameRng::new(seed));
                let b = surface_rows(width, height, &mut GameRng::new(seed));
                assert_eq!(a, b, "{} seed {seed}", scale.as_str());
            }
        }
    }

    #[test]
    fn surface_rows_differ_between_seeds() {
        let (width, height) = Scale::Small.dimensions();
        let a = surface_rows(width, height, &mut GameRng::new(1));
        let b = surface_rows(width, height, &mut GameRng::new(2));
        assert_ne!(a, b);
    }

    #[test]
    fn value_noise_is_bounded_and_sized() {
        let mut rng = GameRng::new(5);
        for step in [1u32, 3, 8, 16] {
            let noise = value_noise(step, 96, &mut rng);
            assert_eq!(noise.len(), 96);
            for (i, &v) in noise.iter().enumerate() {
                assert!(
                    (-1.0..=1.0).contains(&v),
                    "step {step} index {i}: {v} outside [-1,1]"
                );
            }
        }
    }

    #[test]
    fn cosine_interpolation_hits_its_endpoints() {
        assert!((cosine_interpolate(-1.0, 1.0, 0.0) - -1.0).abs() < 1e-6);
        assert!((cosine_interpolate(-1.0, 1.0, 1.0) - 1.0).abs() < 1e-6);
        // Symmetric about the midpoint.
        assert!((cosine_interpolate(0.0, 1.0, 0.5) - 0.5).abs() < 1e-6);
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
