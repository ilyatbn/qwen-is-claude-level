//! `map` — generation and destruction (docs/01-map.md).
//!
//! "Most important system. Everything here is deterministic from
//! `(seed, scale)`." — docs/01 intro.

use crate::rng::GameRng;
use crate::tiles::{Decor, DecorKind, Tile, TileDestroyed, TileKind, TILE_SIZE};
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

/// Minimum spawns a map must provide (docs/01 §3 step 5).
pub const MIN_SPAWNS: usize = 6;

/// Chebyshev spacings tried in order when placing spawns (docs/01 §3 step 5).
const SPAWN_SPACINGS: [u32; 3] = [15, 10, 6];

/// Find well-spaced ground spawns (docs/01 §3 step 5).
///
/// Candidates are GRASS tiles with the 2 tiles above AIR; they are shuffled
/// with the round RNG, then greedily accepted if Chebyshev distance to every
/// already-accepted spawn is >= the spacing. Spacing falls back 15 -> 10 -> 6
/// until at least 6 are accepted.
///
/// Returns TILE coordinates (docs/01 §4, DEVIATIONS.md D9).
pub fn find_spawns(map: &Map, rng: &mut GameRng) -> Vec<Vec2> {
    let mut candidates: Vec<(u32, u32)> = Vec::new();
    for x in 0..map.width {
        for y in 0..map.height {
            if map.tile(x, y).kind != TileKind::Grass {
                continue;
            }
            // "GRASS tiles with the 2 tiles above AIR". y < 2 would put the
            // check off the top of the map, where reads reported AIR anyway.
            if y >= 1 && !map.tile(x, y - 1).is_solid() && (y < 2 || !map.tile(x, y - 2).is_solid())
            {
                candidates.push((x, y));
            }
        }
    }

    // Shuffle once, then reuse the same order for every spacing attempt: the
    // fallbacks are a relaxation of the same greedy pass, not fresh draws.
    rng.shuffle(&mut candidates);

    let mut accepted: Vec<(u32, u32)> = Vec::new();
    for spacing in SPAWN_SPACINGS {
        accepted.clear();
        for &(cx, cy) in &candidates {
            let far_enough = accepted.iter().all(|&(ax, ay)| {
                let dx = cx.abs_diff(ax);
                let dy = cy.abs_diff(ay);
                dx.max(dy) >= spacing
            });
            if far_enough {
                accepted.push((cx, cy));
            }
        }
        if accepted.len() >= MIN_SPAWNS {
            break;
        }
    }

    // docs/01 §3 step 5 says spawns are "guaranteed >= 6" and §4 declares
    // `len >= 6`. The spacing ladder alone does not guarantee that: if even
    // spacing 6 cannot place 6 spawns, the loop above falls out with whatever
    // the last pass produced. Measured minimum across 100 seeds x 3 scales is
    // 6 / 8 / 15, so this is unreachable in practice — but a 100-seed
    // observation is not an invariant, and a later change to generation could
    // make it reachable silently. Drop the spacing rule rather than the
    // guarantee: spacing is a quality heuristic, ">= 6 spawns" is a
    // correctness requirement (fewer than 6 means a 6-player round cannot
    // start).
    if accepted.len() < MIN_SPAWNS {
        for &candidate in &candidates {
            if accepted.len() >= MIN_SPAWNS {
                break;
            }
            if !accepted.contains(&candidate) {
                accepted.push(candidate);
            }
        }
    }

    debug_assert!(
        accepted.len() >= MIN_SPAWNS || candidates.len() < MIN_SPAWNS,
        "find_spawns produced {} spawns from {} candidates, below the \
         documented minimum of {MIN_SPAWNS}",
        accepted.len(),
        candidates.len(),
    );

    accepted
        .into_iter()
        .map(|(x, y)| Vec2::new(x as f32, y as f32))
        .collect()
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

        let mut map = Map {
            seed,
            scale,
            width,
            height,
            tiles,
            decor,
            spawns: Vec::new(),
            version: 0,
        };

        // 5. Spawns, last — so the draw order in docs/01 §3 stays intact.
        map.spawns = find_spawns(&map, &mut rng);
        map
    }

    /// Destroy a tile (docs/01 §5, T1.7).
    ///
    /// A solid tile becomes AIR, `version` is bumped, the surface conversion
    /// pass runs, and a [`TileDestroyed`] is returned. Destroying AIR, or a
    /// tile out of bounds, is a no-op that returns `None` and does NOT bump the
    /// version or run conversion.
    ///
    /// This is the entry point for *single* destructions and it converts, per
    /// T1.7 step 3 ("surface conversion pass after destroy"). Batch callers
    /// must NOT loop over it — see [`Map::destroy_tile_deferred`] and
    /// DEVIATIONS.md D22.
    pub fn destroy_tile(&mut self, x: u32, y: u32) -> Option<TileDestroyed> {
        let event = self.destroy_tile_deferred(x, y)?;
        // Only the tile directly below the one just removed can have become
        // exposed, so the conversion is O(1) rather than a full-grid scan, and
        // a loop over `destroy_tile` stays linear instead of quadratic.
        //
        // Equivalent to `apply_surface_conversion()` for a single destruction
        // **from an already-converted map** — i.e. one with no pre-existing
        // exposed DIRT. That holds for every caller today, because both entry
        // points leave the map converted. It does NOT hold if a caller
        // interleaves `destroy_tile_deferred` with `destroy_tile` and skips the
        // batch conversion, which would leave exposed DIRT this O(1) pass never
        // looks at. Measured differentially over 1000 randomised single
        // destructions: 0 divergences from a converted map, 10 when the
        // invariant is pre-broken. T4.6 uses both entry points — run
        // `apply_surface_conversion()` before switching from the batch path
        // back to `destroy_tile`.
        self.convert_if_exposed(x, y + 1);
        Some(event)
    }

    /// Convert one tile to GRASS if it is DIRT with AIR directly above
    /// (docs/01 §5). The single-tile form of [`Map::apply_surface_conversion`].
    fn convert_if_exposed(&mut self, x: u32, y: u32) {
        if self.tile(x, y).kind != TileKind::Dirt {
            return;
        }
        let above_is_air = y == 0 || !self.tile(x, y - 1).is_solid();
        if above_is_air {
            self.set_tile(x, y, Tile::new(TileKind::Grass));
        }
    }

    /// Destroy a tile WITHOUT running the surface conversion pass.
    ///
    /// For callers that destroy many tiles at once and run
    /// [`Map::apply_surface_conversion`] exactly once at the end. Converting
    /// inside a batch would reset an already-damaged DIRT tile's hp to 20
    /// partway through, making the result depend on tile iteration order —
    /// which would break determinism (docs/00 §2). See DEVIATIONS.md D22.
    ///
    /// Used by [`Map::apply_blast`], and by T4.6's lava `clear_area`.
    pub fn destroy_tile_deferred(&mut self, x: u32, y: u32) -> Option<TileDestroyed> {
        let tile = self.tile(x, y);
        if !tile.is_solid() {
            return None;
        }
        self.set_tile(x, y, Tile::AIR);
        self.version += 1;
        Some(TileDestroyed {
            x,
            y,
            kind: tile.kind,
            item: tile.item,
        })
    }

    /// Convert DIRT tiles that are now exposed to the sky into GRASS
    /// (docs/01 §5: "for every DIRT tile whose tile directly above is AIR →
    /// convert to GRASS (recompute hp to 20)").
    ///
    /// Runs over the whole grid. Intended for batch callers, which run it once
    /// after many destructions; [`Map::destroy_tile`] uses the O(1) single-tile
    /// form instead, so looping over it stays linear.
    pub fn apply_surface_conversion(&mut self) {
        for y in 0..self.height {
            for x in 0..self.width {
                if self.tile(x, y).kind != TileKind::Dirt {
                    continue;
                }
                // Row 0 has open sky above it.
                let above_is_air = y == 0 || !self.tile(x, y - 1).is_solid();
                if above_is_air {
                    self.set_tile(x, y, Tile::new(TileKind::Grass));
                }
            }
        }
    }

    /// Apply a radial blast, damaging and possibly destroying tiles
    /// (docs/01 §5).
    ///
    /// For each tile whose **center** is within `radius` px of the blast
    /// center: `dmg = max_damage * (1 - dist/radius)`, clamped at 0, subtracted
    /// from `tile.hp`. A tile at `hp <= 0` becomes AIR and is reported.
    /// Surface conversion runs once after the whole batch.
    ///
    /// `skip_items` suppresses hidden-item uncovery — weather destruction
    /// (lava, T4.6) passes `true` per docs/02 §5. Added here with a default of
    /// `false` as T3.3 step 3 requires.
    pub fn apply_blast(
        &mut self,
        cx: f32,
        cy: f32,
        radius: f32,
        max_damage: f32,
    ) -> Vec<TileDestroyed> {
        self.apply_blast_inner(cx, cy, radius, max_damage, false)
    }

    /// [`Map::apply_blast`] with explicit control over hidden-item uncovery.
    pub fn apply_blast_with(
        &mut self,
        cx: f32,
        cy: f32,
        radius: f32,
        max_damage: f32,
        skip_items: bool,
    ) -> Vec<TileDestroyed> {
        self.apply_blast_inner(cx, cy, radius, max_damage, skip_items)
    }

    fn apply_blast_inner(
        &mut self,
        cx: f32,
        cy: f32,
        radius: f32,
        max_damage: f32,
        skip_items: bool,
    ) -> Vec<TileDestroyed> {
        if radius <= 0.0 {
            return Vec::new();
        }

        // Only tiles whose center can fall inside the radius need testing.
        // Widen by one tile so a center just inside the boundary is not missed.
        let min_x = ((cx - radius) / TILE_SIZE).floor().max(0.0) as u32;
        let min_y = ((cy - radius) / TILE_SIZE).floor().max(0.0) as u32;
        let max_x = (((cx + radius) / TILE_SIZE).ceil() as i64)
            .clamp(0, self.width as i64) as u32;
        let max_y = (((cy + radius) / TILE_SIZE).ceil() as i64)
            .clamp(0, self.height as i64) as u32;

        let mut destroyed = Vec::new();
        for y in min_y..max_y {
            for x in min_x..max_x {
                if !self.is_solid(x, y) {
                    continue;
                }
                let center = Map::tile_center(x, y);
                let dist = ((center.x - cx).powi(2) + (center.y - cy).powi(2)).sqrt();
                if dist > radius {
                    continue;
                }

                let damage = (max_damage * (1.0 - dist / radius)).max(0.0);
                if damage <= 0.0 {
                    continue;
                }

                let mut tile = self.tile(x, y);
                tile.hp -= damage;
                if tile.hp <= 0.0 {
                    // Deferred: conversion runs once after the whole batch.
                    if let Some(mut event) = self.destroy_tile_deferred(x, y) {
                        // docs/02 §5: weather destruction "skips item uncovery"
                        // — the item stays buried rather than being destroyed,
                        // so a later weapon blast can still reveal it.
                        if skip_items && event.item.is_some() {
                            let mut tile = self.tile(x, y);
                            tile.item = event.item;
                            self.set_tile(x, y, tile);
                            event.item = None;
                        }
                        destroyed.push(event);
                    }
                } else {
                    // Damaged but surviving — hp persists on the tile.
                    self.set_tile(x, y, tile);
                }
            }
        }

        if !destroyed.is_empty() {
            self.apply_surface_conversion();
        }
        destroyed
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
    fn spawns_at_least_6() {
        // docs/08 §1 (map row) + T1.5 Acceptance: "no seed in the 100-seed
        // suite produces < 6 spawns".
        for scale in Scale::ALL {
            for seed in 0..100u64 {
                let map = Map::generate(seed, scale);
                assert!(
                    map.spawns.len() >= MIN_SPAWNS,
                    "{} seed {seed}: only {} spawns",
                    scale.as_str(),
                    map.spawns.len(),
                );
            }
        }
    }

    #[test]
    fn spawn_spacing() {
        // docs/08 §1 (map row). Spacing is 15, relaxed to 10 then 6 if fewer
        // than 6 spawns are accepted (docs/01 §3 step 5), so the guaranteed
        // floor across all seeds is the last fallback.
        for scale in Scale::ALL {
            for seed in 0..100u64 {
                let map = Map::generate(seed, scale);
                for (i, a) in map.spawns.iter().enumerate() {
                    for b in map.spawns.iter().skip(i + 1) {
                        let dx = (a.x - b.x).abs();
                        let dy = (a.y - b.y).abs();
                        let chebyshev = dx.max(dy);
                        assert!(
                            chebyshev >= SPAWN_SPACINGS[2] as f32,
                            "{} seed {seed}: spawns {a:?} and {b:?} are \
                             {chebyshev} apart, below the {} fallback",
                            scale.as_str(),
                            SPAWN_SPACINGS[2],
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn spawn_fallback_ignores_spacing_before_returning_too_few() {
        // The >=6 guarantee outranks the spacing heuristic. Build a map whose
        // GRASS candidates are all clustered so no spacing can separate 6 of
        // them, and confirm we still get 6 rather than silently returning 2.
        let (width, height) = Scale::Small.dimensions();
        let mut map = Map {
            seed: 0,
            scale: Scale::Small,
            width,
            height,
            tiles: vec![Tile::AIR; (width * height) as usize],
            decor: Vec::new(),
            spawns: Vec::new(),
            version: 0,
        };
        // A single 10-tile-wide strip of GRASS: every pair is closer than 15,
        // and only one pair could satisfy spacing 6.
        let row = height - 10;
        for x in 20..30 {
            map.set_tile(x, row, Tile::new(TileKind::Grass));
        }

        let spawns = find_spawns(&map, &mut GameRng::new(1));
        assert!(
            spawns.len() >= MIN_SPAWNS,
            "clustered candidates yielded only {} spawns",
            spawns.len(),
        );
        // All distinct.
        for (i, a) in spawns.iter().enumerate() {
            for b in spawns.iter().skip(i + 1) {
                assert_ne!((a.x, a.y), (b.x, b.y), "duplicate spawn");
            }
        }
    }

    #[test]
    fn spawns_are_on_grass_with_headroom() {
        // docs/01 §3 step 5: "candidates: GRASS tiles with the 2 tiles above AIR".
        for scale in Scale::ALL {
            for seed in 0..25u64 {
                let map = Map::generate(seed, scale);
                for spawn in &map.spawns {
                    let (x, y) = (spawn.x as u32, spawn.y as u32);
                    assert_eq!(
                        map.tile(x, y).kind,
                        TileKind::Grass,
                        "{} seed {seed}: spawn ({x},{y}) is not GRASS",
                        scale.as_str(),
                    );
                    // Guard the subtraction: a spawn at y < 2 would panic on
                    // u32 underflow instead of failing the assertion.
                    assert!(y >= 2, "spawn ({x},{y}) is too close to the map top");
                    assert!(!map.tile(x, y - 1).is_solid(), "no headroom at ({x},{y})");
                    assert!(!map.tile(x, y - 2).is_solid(), "no headroom at ({x},{y})");
                }
            }
        }
    }

    #[test]
    fn spawns_are_tile_coordinates_not_pixels() {
        // DEVIATIONS.md D9: docs/01 §4 says tile coords, §3.5 gives a pixel
        // formula. T2.1 only type-checks against tile coords.
        let map = Map::generate(1, Scale::Small);
        for spawn in &map.spawns {
            assert!(
                spawn.x < map.width as f32 && spawn.y < map.height as f32,
                "spawn {spawn:?} is outside the tile grid — looks like pixels",
            );
        }
    }

    #[test]
    fn spawns_are_deterministic() {
        for scale in Scale::ALL {
            for seed in [0u64, 7, 12345] {
                let a = Map::generate(seed, scale);
                let b = Map::generate(seed, scale);
                assert_eq!(a.spawns, b.spawns, "{} seed {seed}", scale.as_str());
            }
        }
    }

    #[test]
    fn destroy_tile_returns_event() {
        // docs/08 §1 (tiles row).
        let mut map = Map::generate(1, Scale::Small);
        let x = 10;
        let s = map.surface_row(x);
        let before = map.tile(x, s);
        assert!(before.is_solid());

        let event = map.destroy_tile(x, s).expect("destroying a solid tile");
        assert_eq!((event.x, event.y), (x, s));
        assert_eq!(event.kind, before.kind);
        assert_eq!(event.item, None, "no hidden items until T3.3");
        assert_eq!(map.tile(x, s), Tile::AIR);

        // Destroying AIR, or out of bounds, is a no-op returning None.
        assert_eq!(map.destroy_tile(x, s), None);
        assert_eq!(map.destroy_tile(map.width, 0), None);
        assert_eq!(map.destroy_tile(0, map.height), None);
    }

    #[test]
    fn version_increments() {
        // docs/08 §1 (tiles row); docs/01 §4: "+1 on every destruction".
        let mut map = Map::generate(2, Scale::Small);
        assert_eq!(map.version, 0);

        let x = 20;
        let s = map.surface_row(x);
        map.destroy_tile(x, s).unwrap();
        assert_eq!(map.version, 1);
        map.destroy_tile(x, s + 1).unwrap();
        assert_eq!(map.version, 2);

        // A no-op destruction must NOT bump the version, or clients resync for
        // nothing on every missed shot.
        let before = map.version;
        assert_eq!(map.destroy_tile(x, s), None);
        assert_eq!(map.destroy_tile(map.width + 5, 0), None);
        assert_eq!(map.version, before);
    }

    #[test]
    fn surface_conversion_grass_on_air_above() {
        // docs/08 §1 (tiles row); docs/01 §5.
        //
        // Asserts T1.7's Acceptance verbatim — "destroying a surface DIRT
        // column converts the new surface tile to GRASS" — using ONLY
        // destroy_tile. An earlier version called apply_surface_conversion()
        // explicitly, which asserted this implementation's two-step contract
        // rather than the documented behaviour. See DEVIATIONS.md D22.
        let mut map = Map::generate(3, Scale::Small);
        let x = 30;
        let s = map.surface_row(x);
        // Directly under the GRASS surface is the DIRT band.
        assert_eq!(map.tile(x, s + 1).kind, TileKind::Dirt);

        map.destroy_tile(x, s).unwrap();

        let converted = map.tile(x, s + 1);
        assert_eq!(converted.kind, TileKind::Grass, "exposed DIRT became GRASS");
        assert_eq!(converted.hp, 20.0, "docs/01 §5: recompute hp to 20");
    }

    #[test]
    fn deferred_destroy_does_not_convert_until_asked() {
        // The batch contract: destroy_tile_deferred leaves conversion pending,
        // so a blast cannot reset a damaged DIRT tile's hp partway through.
        let mut map = Map::generate(3, Scale::Small);
        let x = 31;
        let s = map.surface_row(x);
        assert_eq!(map.tile(x, s + 1).kind, TileKind::Dirt);

        map.destroy_tile_deferred(x, s).unwrap();
        assert_eq!(
            map.tile(x, s + 1).kind,
            TileKind::Dirt,
            "deferred destroy must not convert",
        );

        map.apply_surface_conversion();
        assert_eq!(map.tile(x, s + 1).kind, TileKind::Grass);
    }

    #[test]
    fn batch_conversion_does_not_reset_damaged_dirt_midway() {
        // Why the batch path exists (D22), pinned by CRATER SIZE.
        //
        // On uniform DIRT (30 hp), converting mid-blast turns an exposed DIRT
        // tile into GRASS (20 hp) — healing it *downward* — so later damage in
        // the SAME blast destroys tiles that should have survived. The result
        // is a visibly larger crater, and it depends on tile iteration order.
        //
        // An earlier version of this test asserted only "some surviving tile
        // retained blast damage", which is true under both designs and
        // therefore could not fail. Reverting apply_blast from
        // destroy_tile_deferred to destroy_tile left all 80 tests green. These
        // counts discriminate: every row below differs between the two designs.
        //
        //   max_damage | per-destruction (WRONG) | deferred (correct)
        //           25 |  0                      | 0
        //           35 |  2                      | 1
        //           45 |  2                      | 1
        //           55 |  7                      | 5
        //           65 | 10                      | 9
        const EXPECTED: [(f32, usize); 5] =
            [(25.0, 0), (35.0, 1), (45.0, 1), (55.0, 5), (65.0, 9)];

        let center = Map::tile_center(20, 20);
        for (max_damage, want) in EXPECTED {
            let mut map = solid_map(TileKind::Dirt);
            let destroyed = map.apply_blast(center.x, center.y, 48.0, max_damage);
            assert_eq!(
                destroyed.len(),
                want,
                "blast r=48 max_damage={max_damage} destroyed {} tiles, expected \
                 {want}. A larger count means surface conversion ran DURING the \
                 batch, resetting exposed DIRT (30 hp) to GRASS (20 hp) so later \
                 damage in the same blast over-killed. See DEVIATIONS.md D22.",
                destroyed.len(),
            );
            // The reported events and the resulting grid must agree.
            let air = map.tiles.iter().filter(|t| t.kind == TileKind::Air).count();
            assert_eq!(air, want, "AIR tile count disagrees with reported events");
            assert_eq!(map.version, want as u64, "version disagrees with events");
        }
    }

    #[test]
    fn blast_leaves_surviving_tiles_damaged() {
        // Sub-lethal damage must persist rather than being healed by the
        // post-batch conversion pass.
        let mut map = solid_map(TileKind::Dirt);
        let center = Map::tile_center(20, 20);
        map.apply_blast(center.x, center.y, 48.0, 25.0);
        let damaged = (0..map.height)
            .flat_map(|y| (0..map.width).map(move |x| (x, y)))
            .filter(|&(x, y)| map.tile(x, y).is_solid())
            .any(|(x, y)| {
                let t = map.tile(x, y);
                t.hp < t.kind.base_hp()
            });
        assert!(damaged, "no surviving tile retained blast damage");
    }

    #[test]
    fn surface_conversion_leaves_buried_dirt_alone() {
        // docs/01 §5 converts "every DIRT tile whose tile directly above is
        // AIR". That predicate has two halves and this covers the NEGATIVE one:
        // buried DIRT must be left alone.
        //
        // Deleted by accident in 0decceb (a slice-based edit swallowed it) and
        // restored here, strengthened. Without it, making the pass convert
        // regardless of what sits above leaves the whole suite green while
        // underground DIRT silently becomes GRASS — which matters, because
        // GRASS is 20 hp against DIRT's 30, so a rocket digs further.
        let mut map = Map::generate(4, Scale::Small);

        // Every DIRT tile with a SOLID tile directly above it.
        let buried: Vec<(u32, u32)> = (0..map.height)
            .flat_map(|y| (0..map.width).map(move |x| (x, y)))
            .filter(|&(x, y)| {
                map.tile(x, y).kind == TileKind::Dirt && y > 0 && map.tile(x, y - 1).is_solid()
            })
            .collect();
        assert!(
            buried.len() > 100,
            "only {} buried DIRT tiles — too few for this test to mean anything",
            buried.len(),
        );

        map.apply_surface_conversion();

        for (x, y) in buried {
            assert_eq!(
                map.tile(x, y).kind,
                TileKind::Dirt,
                "buried DIRT at ({x},{y}) was converted despite a solid tile above",
            );
        }
    }

    #[test]
    fn surface_conversion_preserves_damaged_buried_dirt_hp() {
        // Conversion sets hp to 20 (docs/01 §5). If it ran on buried tiles it
        // would also HEAL a damaged one from below 30 up to 20 — or reset it
        // outright — so hp is an independent witness to the same predicate.
        let mut map = solid_map(TileKind::Dirt);
        // Damage a deeply buried tile without destroying it.
        let mut damaged = map.tile(10, 30);
        damaged.hp = 7.0;
        map.set_tile(10, 30, damaged);

        map.apply_surface_conversion();

        let after = map.tile(10, 30);
        assert_eq!(after.kind, TileKind::Dirt, "buried DIRT converted");
        assert_eq!(after.hp, 7.0, "buried DIRT hp was reset by conversion");
    }

    #[test]
    fn surface_conversion_is_idempotent() {
        // Running the pass twice must not differ from running it once.
        let mut once = Map::generate(4, Scale::Small);
        once.apply_surface_conversion();
        let mut twice = Map::generate(4, Scale::Small);
        twice.apply_surface_conversion();
        twice.apply_surface_conversion();
        assert_eq!(once.tiles, twice.tiles, "conversion is not idempotent");
    }

    #[test]
    fn surface_conversion_does_not_promote_stone() {
        // Only DIRT converts (docs/01 §5). STONE exposed by digging stays STONE.
        //
        // The column is found by inspection rather than hardcoded: a fixed x
        // makes this test fail for incidental reasons whenever generation
        // changes, which masks real regressions.
        let mut map = Map::generate(5, Scale::Small);
        let x = (0..map.width)
            .find(|&x| {
                let s = map.surface_row(x);
                s + 4 < map.height && map.tile(x, s + 4).kind == TileKind::Stone
            })
            .expect("no column with STONE at depth 4");

        let s = map.surface_row(x);
        for depth in 0..=3 {
            map.destroy_tile_deferred(x, s + depth);
        }
        map.apply_surface_conversion();
        assert_eq!(map.tile(x, s + 4).kind, TileKind::Stone);
    }

    /// A fully-solid STONE map, so blast geometry is not confounded by terrain.
    fn solid_map(kind: TileKind) -> Map {
        let (width, height) = Scale::Small.dimensions();
        Map {
            seed: 0,
            scale: Scale::Small,
            width,
            height,
            tiles: vec![Tile::new(kind); (width * height) as usize],
            decor: Vec::new(),
            spawns: Vec::new(),
            version: 0,
        }
    }

    #[test]
    fn blast_falloff_center_max_edge_zero() {
        // docs/08 §1 (tiles row); docs/01 §5 formula.
        let mut map = solid_map(TileKind::Stone);
        // Blast centered exactly on the center of tile (10, 10).
        let center = Map::tile_center(10, 10);
        let radius = 48.0;
        let max_damage = 30.0; // below STONE's 60 hp, so nothing is destroyed

        map.apply_blast(center.x, center.y, radius, max_damage);

        // dist 0 -> full damage.
        assert!(
            (map.tile(10, 10).hp - (60.0 - 30.0)).abs() < 1e-3,
            "center tile took {} damage, expected {max_damage}",
            60.0 - map.tile(10, 10).hp,
        );

        // A tile whose center sits at distance ~= radius takes ~0.
        // Tile (13, 10) is 3 tiles = 48 px away, exactly at the radius.
        assert!(
            (map.tile(13, 10).hp - 60.0).abs() < 1e-3,
            "edge tile should be undamaged, hp is {}",
            map.tile(13, 10).hp,
        );

        // A tile at half the radius takes half the damage.
        // Tile (11, 10) is 16 px away: 30 * (1 - 16/48) = 20.
        let expected = 60.0 - max_damage * (1.0 - 16.0 / 48.0);
        assert!(
            (map.tile(11, 10).hp - expected).abs() < 1e-3,
            "tile at 16px has hp {}, expected {expected}",
            map.tile(11, 10).hp,
        );
    }

    #[test]
    fn blast_destroys_only_in_radius() {
        // docs/08 §1 (tiles row).
        let mut map = solid_map(TileKind::Grass); // 20 hp, easy to destroy
        let center = Map::tile_center(20, 20);
        let radius = 48.0;

        let destroyed = map.apply_blast(center.x, center.y, radius, 100.0);
        assert!(!destroyed.is_empty(), "blast destroyed nothing");

        for event in &destroyed {
            let tile_center = Map::tile_center(event.x, event.y);
            let dist = ((tile_center.x - center.x).powi(2)
                + (tile_center.y - center.y).powi(2))
            .sqrt();
            assert!(
                dist <= radius,
                "destroyed tile ({},{}) is {dist} px away, outside radius {radius}",
                event.x,
                event.y,
            );
        }

        // Nothing outside the radius became AIR.
        for y in 0..map.height {
            for x in 0..map.width {
                let tc = Map::tile_center(x, y);
                let dist =
                    ((tc.x - center.x).powi(2) + (tc.y - center.y).powi(2)).sqrt();
                if dist > radius {
                    assert!(
                        map.is_solid(x, y),
                        "tile ({x},{y}) outside the radius was destroyed",
                    );
                }
            }
        }
    }

    #[test]
    fn blast_below_tile_hp_damages_without_destroying() {
        // T1.8 Acceptance: "a blast with max_damage < tile hp damages but does
        // not destroy (hp persists on the tile)".
        let mut map = solid_map(TileKind::Stone); // 60 hp
        let center = Map::tile_center(30, 30);

        let destroyed = map.apply_blast(center.x, center.y, 48.0, 25.0);
        assert!(destroyed.is_empty(), "nothing should have been destroyed");
        assert_eq!(map.version, 0, "version must not move with no destruction");

        let hp = map.tile(30, 30).hp;
        assert!(hp < 60.0, "center tile took no damage");
        assert!(hp > 0.0, "center tile was destroyed by a sub-lethal blast");

        // Damage accumulates across repeated blasts until the tile dies.
        for _ in 0..3 {
            map.apply_blast(center.x, center.y, 48.0, 25.0);
        }
        assert_eq!(map.tile(30, 30), Tile::AIR, "repeated blasts should destroy");
        assert!(map.version > 0);
    }

    #[test]
    fn blast_runs_surface_conversion_once() {
        // A blast that opens the surface should leave exposed DIRT as GRASS.
        let mut map = Map::generate(11, Scale::Small);
        let x = 48;
        let s = map.surface_row(x);
        let center = Map::tile_center(x, s);

        let destroyed = map.apply_blast(center.x, center.y, 40.0, 500.0);
        assert!(!destroyed.is_empty());

        for col in 0..map.width {
            let top = map.surface_row(col);
            if top < map.height {
                let kind = map.tile(col, top).kind;
                assert_ne!(
                    kind,
                    TileKind::Dirt,
                    "col {col}: exposed DIRT at row {top} was not converted",
                );
            }
        }
    }

    #[test]
    fn blast_is_bounds_safe_at_map_edges() {
        // A blast centered off-map, or clipping an edge, must not panic.
        let mut map = solid_map(TileKind::Grass);
        map.apply_blast(0.0, 0.0, 64.0, 100.0);
        map.apply_blast(-500.0, -500.0, 64.0, 100.0);
        let (w, h) = map.pixel_size();
        map.apply_blast(w, h, 64.0, 100.0);
        map.apply_blast(w + 1000.0, h + 1000.0, 64.0, 100.0);
        // A degenerate radius is a no-op, not a divide-by-zero.
        assert!(map.apply_blast(100.0, 100.0, 0.0, 100.0).is_empty());
        assert!(map.apply_blast(100.0, 100.0, -5.0, 100.0).is_empty());
    }

    #[test]
    fn blast_version_bumps_once_per_destroyed_tile() {
        // docs/01 §4: "+1 on every destruction".
        let mut map = solid_map(TileKind::Grass);
        let center = Map::tile_center(25, 25);
        let destroyed = map.apply_blast(center.x, center.y, 48.0, 100.0);
        assert_eq!(map.version, destroyed.len() as u64);
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
