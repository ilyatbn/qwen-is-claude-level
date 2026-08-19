//! `map` — generation and destruction (docs/01-map.md).
//!
//! "Most important system. Everything here is deterministic from
//! `(seed, scale)`." — docs/01 intro.

use crate::rng::GameRng;
use crate::tiles::{Decor, DecorKind, Tile, TileKind, TILE_SIZE};
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

/// Fill each column from its surface row down (docs/01 §3 step 2).
///
/// `d = s(x) - y`: `d==0` → GRASS, `d<=3` → DIRT, else STONE. Everything
/// above `s(x)` stays AIR.
fn fill_columns(tiles: &mut [Tile], width: u32, height: u32, surface: &[u32]) {
    for x in 0..width {
        let Some(&s) = surface.get(x as usize) else {
            continue;
        };
        for y in s..height {
            let depth = y - s;
            let kind = if depth == 0 {
                TileKind::Grass
            } else if depth <= 3 {
                TileKind::Dirt
            } else {
                TileKind::Stone
            };
            if let Some(slot) = tiles.get_mut((y * width + x) as usize) {
                *slot = Tile::new(kind);
            }
        }
    }
}

/// The tiles marked by one rock-pocket random walk (docs/01 §3 step 3).
///
/// Returned rather than written directly so generation can assert the
/// per-pocket size the algorithm actually guarantees — see DEVIATIONS.md D5.
fn carve_pocket(
    width: u32,
    height: u32,
    surface: &[u32],
    rng: &mut GameRng,
) -> Vec<(u32, u32)> {
    let mut marked = Vec::new();

    // Pick a random column, and a depth d0 in [2,6] below its surface.
    let x0 = rng.gen_range(0, width);
    let d0 = rng.gen_range_inclusive(2, 6);
    let s0 = surface.get(x0 as usize).copied().unwrap_or(0);
    let y0 = (s0 + d0).min(height.saturating_sub(1));

    let mut x = x0;
    let mut y = y0;
    // The starting tile is marked unconditionally per the doc ("start at
    // (x0,y0), mark ROCK"); the walk steps then apply the below-surface rule.
    marked.push((x, y));

    // Up to 12 steps of (dx, dy) in {-1,0,1}, not both zero.
    for _ in 0..12 {
        let (dx, dy) = loop {
            let dx = rng.gen_range_inclusive(0, 2) as i64 - 1;
            let dy = rng.gen_range_inclusive(0, 2) as i64 - 1;
            if dx != 0 || dy != 0 {
                break (dx, dy);
            }
        };

        let nx = x as i64 + dx;
        let ny = y as i64 + dy;
        if nx < 0 || ny < 0 || nx >= width as i64 || ny >= height as i64 {
            continue;
        }
        let (nx, ny) = (nx as u32, ny as u32);

        // "Mark ROCK only if inside grid AND row > s(x)+1" — strictly below
        // the surface, evaluated against the column being stepped into.
        let column_surface = surface.get(nx as usize).copied().unwrap_or(0);
        if ny > column_surface + 1 {
            marked.push((nx, ny));
            x = nx;
            y = ny;
        }
    }

    marked
}

/// Place decor on surface tiles (docs/01 §3 step 4).
///
/// 12% chance per surface tile of one of bush / rock / flower, equal weight.
fn place_decor(width: u32, surface: &[u32], rng: &mut GameRng) -> Vec<Decor> {
    let mut decor = Vec::new();
    for x in 0..width {
        let Some(&y) = surface.get(x as usize) else {
            continue;
        };
        if rng.random_unit() < 0.12 {
            let kind = match rng.gen_range(0, 3) {
                0 => DecorKind::Bush,
                1 => DecorKind::Rock,
                _ => DecorKind::Flower,
            };
            decor.push(Decor { x, y, kind });
        }
    }
    decor
}

/// Maximum tiles one rock pocket can mark: the start tile plus at most 12
/// walk steps (docs/01 §3 step 3).
pub const MAX_POCKET_TILES: usize = 13;

impl Map {
    /// Generate a map (docs/01 §3, §4).
    ///
    /// The step order — surface → fill → pockets → decor → spawns — is
    /// load-bearing: docs/01 §3 says "follow it exactly or determinism tests
    /// break". One `GameRng` drives all of it.
    pub fn generate(seed: u64, scale: Scale) -> Self {
        let (width, height) = scale.dimensions();
        let mut rng = GameRng::new(seed);

        // 1. Heightmap.
        let surface = surface_rows(width, height, &mut rng);

        // 2. Fill (consumes no randomness).
        let mut tiles = vec![Tile::AIR; (width * height) as usize];
        fill_columns(&mut tiles, width, height, &surface);

        // 3. Rock pockets.
        for _ in 0..scale.pockets() {
            let marked = carve_pocket(width, height, &surface, &mut rng);
            debug_assert!(
                marked.len() <= MAX_POCKET_TILES,
                "pocket marked {} tiles, max is {MAX_POCKET_TILES}",
                marked.len(),
            );
            for (x, y) in marked {
                if let Some(slot) = tiles.get_mut((y * width + x) as usize) {
                    *slot = Tile::new(TileKind::Rock);
                }
            }
        }

        // 4. Decor.
        let decor = place_decor(width, &surface, &mut rng);

        // 5. Spawns are appended by T1.5, after decor, so the RNG order in
        // docs/01 §3 stays intact.
        Map {
            seed,
            scale,
            width,
            height,
            tiles,
            decor,
            spawns: Vec::new(),
            version: 0,
        }
    }

    /// An ASCII dump of the grid, for the debug-inspection test in T1.4.
    ///
    /// `.` AIR, `#` GRASS, `:` DIRT, `%` STONE, `@` ROCK.
    pub fn ascii_dump(&self) -> String {
        let mut out = String::with_capacity(((self.width + 1) * self.height) as usize);
        for y in 0..self.height {
            for x in 0..self.width {
                out.push(match self.tile(x, y).kind {
                    TileKind::Air => '.',
                    TileKind::Grass => '#',
                    TileKind::Dirt => ':',
                    TileKind::Stone => '%',
                    TileKind::Rock => '@',
                });
            }
            out.push('\n');
        }
        out
    }
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

    /// Connected ROCK components by 4-connected flood fill.
    fn rock_components(map: &Map) -> Vec<usize> {
        let (w, h) = (map.width as usize, map.height as usize);
        let mut seen = vec![false; w * h];
        let mut sizes = Vec::new();
        for start in 0..w * h {
            let (sx, sy) = ((start % w) as u32, (start / w) as u32);
            if seen[start] || map.tile(sx, sy).kind != TileKind::Rock {
                continue;
            }
            let mut stack = vec![start];
            seen[start] = true;
            let mut size = 0usize;
            while let Some(i) = stack.pop() {
                size += 1;
                let (x, y) = ((i % w) as i64, (i / w) as i64);
                for (dx, dy) in [(1i64, 0i64), (-1, 0), (0, 1), (0, -1)] {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let j = ny as usize * w + nx as usize;
                    if !seen[j] && map.tile(nx as u32, ny as u32).kind == TileKind::Rock {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
            sizes.push(size);
        }
        sizes
    }

    #[test]
    fn all_columns_have_ground() {
        // docs/08 §1 (map row): "every column has >=1 solid tile".
        for scale in Scale::ALL {
            for seed in 0..100u64 {
                let map = Map::generate(seed, scale);
                for x in 0..map.width {
                    assert!(
                        map.surface_row(x) < map.height,
                        "{} seed {seed} col {x} has no solid tile",
                        scale.as_str(),
                    );
                }
            }
        }
    }

    #[test]
    fn fill_follows_depth_bands() {
        // docs/01 §3 step 2: d==0 GRASS, d<=3 DIRT, else STONE; above s is AIR.
        let map = Map::generate(1, Scale::Small);
        for x in 0..map.width {
            let s = map.surface_row(x);
            for y in 0..s {
                assert_eq!(
                    map.tile(x, y).kind,
                    TileKind::Air,
                    "col {x} row {y} above surface {s} is not AIR",
                );
            }
            assert_eq!(map.tile(x, s).kind, TileKind::Grass, "col {x} surface");
            for depth in 1..=3u32 {
                let y = s + depth;
                if y >= map.height {
                    break;
                }
                // Rock pockets legally overwrite the dirt band.
                let kind = map.tile(x, y).kind;
                assert!(
                    kind == TileKind::Dirt || kind == TileKind::Rock,
                    "col {x} depth {depth} is {kind:?}, expected DIRT (or ROCK)",
                );
            }
            for depth in 4..8u32 {
                let y = s + depth;
                if y >= map.height {
                    break;
                }
                let kind = map.tile(x, y).kind;
                assert!(
                    kind == TileKind::Stone || kind == TileKind::Rock,
                    "col {x} depth {depth} is {kind:?}, expected STONE (or ROCK)",
                );
            }
        }
    }

    #[test]
    fn pockets_below_surface_and_sized() {
        // docs/08 §1 (map row) + T1.4 step 4.
        //
        // The doc asks for "each connected ROCK component <= 15 tiles". That is
        // NOT a property the algorithm provides: a walk marks at most 13 tiles,
        // but independent pockets can land adjacent and merge. Measured maxima
        // over 100 seeds are 27 / 28 / 30 for Small / Medium / Large, with
        // merged components at every scale. See DEVIATIONS.md D5.
        //
        // Asserted here: the per-pocket bound the walk really guarantees, that
        // every ROCK tile is strictly below its column's surface, and a
        // regression ceiling on merged-component size.
        const MERGED_COMPONENT_CEILING: usize = 40;

        for scale in Scale::ALL {
            for seed in 0..100u64 {
                let map = Map::generate(seed, scale);

                for x in 0..map.width {
                    let s = map.surface_row(x);
                    for y in 0..map.height {
                        if map.tile(x, y).kind == TileKind::Rock {
                            assert!(
                                y > s + 1,
                                "{} seed {seed}: ROCK at ({x},{y}) not strictly \
                                 below surface {s}",
                                scale.as_str(),
                            );
                        }
                    }
                }

                for size in rock_components(&map) {
                    assert!(
                        size <= MERGED_COMPONENT_CEILING,
                        "{} seed {seed}: ROCK component of {size} tiles exceeds \
                         the {MERGED_COMPONENT_CEILING}-tile regression ceiling",
                        scale.as_str(),
                    );
                }
            }
        }
    }

    #[test]
    fn a_single_pocket_marks_at_most_13_tiles() {
        // The property the random walk actually guarantees: 1 start + <=12
        // steps. This is what D5 asserts in place of the doc's component bound.
        let (width, height) = Scale::Large.dimensions();
        for seed in 0..200u64 {
            let mut rng = GameRng::new(seed);
            let surface = surface_rows(width, height, &mut rng);
            for _ in 0..20 {
                let marked = carve_pocket(width, height, &surface, &mut rng);
                assert!(
                    marked.len() <= MAX_POCKET_TILES,
                    "seed {seed}: pocket marked {} tiles",
                    marked.len(),
                );
                assert!(!marked.is_empty(), "pocket marked nothing");
            }
        }
    }

    #[test]
    fn decor_sits_on_surface_tiles() {
        // docs/01 §3 step 4: decor y = surface row, ~12% of surface tiles.
        let mut total_decor = 0usize;
        let mut total_columns = 0usize;
        for seed in 0..50u64 {
            let map = Map::generate(seed, Scale::Small);
            for decor in &map.decor {
                assert_eq!(
                    decor.y,
                    map.surface_row(decor.x),
                    "seed {seed}: decor at ({},{}) is not on the surface",
                    decor.x,
                    decor.y,
                );
            }
            total_decor += map.decor.len();
            total_columns += map.width as usize;
        }
        let rate = total_decor as f32 / total_columns as f32;
        assert!(
            (0.09..0.15).contains(&rate),
            "decor rate {rate:.3} is not close to the documented 12%",
        );
    }

    #[test]
    fn terrain_ascii_dump_seed1_small() {
        // T1.4 Acceptance: "map looks like Worms terrain in a debug dump
        // (print an ASCII grid in a #[test] for seed 1, scale Small — keep the
        // test)." This is an eyeball criterion, so the test prints the grid and
        // asserts only the structural invariants.
        let map = Map::generate(1, Scale::Small);
        let dump = map.ascii_dump();
        println!("--- seed 1, Small ({}x{}) ---", map.width, map.height);
        println!("{dump}");

        let lines: Vec<&str> = dump.lines().collect();
        assert_eq!(lines.len(), map.height as usize);
        for line in &lines {
            assert_eq!(line.chars().count(), map.width as usize);
        }
        // The top row is open sky and the bottom row is solid ground.
        assert!(lines[0].chars().all(|c| c == '.'), "top row is not all AIR");
        assert!(
            !lines[lines.len() - 1].contains('.'),
            "bottom row has holes before any destruction",
        );
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
