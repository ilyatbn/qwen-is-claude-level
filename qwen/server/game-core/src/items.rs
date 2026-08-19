//! `items` — catalog, placement, pickup, use, inventory (docs/04-items.md).
//!
//! T2.1 needs [`Inventory`] because `Player` embeds it (docs/03 §1). The
//! catalog (T3.1), placement (T3.2–T3.5), pickup (T3.6) and weapons (T3.8)
//! arrive in Phase 3.

use crate::map::Map;
use crate::protocol::ItemId;
use crate::rng::GameRng;
use crate::tiles::{TileKind, TILE_SIZE};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Catalog (T3.1, docs/04 §1)
// ---------------------------------------------------------------------------

/// docs/04 §1: `Weapon | Health | Shield | Utility`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Weapon,
    Health,
    Shield,
    Utility,
}

/// docs/04 §1. Weapon-only fields are `None` for non-weapons.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ItemDef {
    pub id: ItemId,
    pub kind: ItemKind,
    pub name: &'static str,
    /// docs/04 §1: "1 for all v1 items".
    pub max_stack: u8,
    pub ammo: Option<u8>,
    pub damage: Option<f32>,
    /// Px — projectile lifetime distance.
    pub range: Option<f32>,
    /// Px — blast radius. `Some(0.0)` means non-explosive but still a weapon.
    pub impact_radius: Option<f32>,
    pub cooldown_s: Option<f32>,
    /// Px/s.
    pub projectile_speed: Option<f32>,
    pub explosive: Option<bool>,
}

impl ItemDef {
    /// A non-weapon entry: every weapon-only field is absent.
    const fn consumable(id: ItemId, kind: ItemKind, name: &'static str) -> Self {
        ItemDef {
            id,
            kind,
            name,
            max_stack: 1,
            ammo: None,
            damage: None,
            range: None,
            impact_radius: None,
            cooldown_s: None,
            projectile_speed: None,
            explosive: None,
        }
    }
}

/// The v1 item catalog, exactly per the docs/04 §1 table.
///
/// `catalog_ammo_matches_doc` asserts every field of every entry against
/// literals transcribed from the doc — per T3.1's Acceptance, "test fails if
/// anyone changes a number without updating the doc". Do not rewrite that test
/// to compare against these constants; it would then check nothing.
pub const CATALOG: [ItemDef; 8] = [
    ItemDef {
        id: ItemId::Pistol,
        kind: ItemKind::Weapon,
        name: "Pistol",
        max_stack: 1,
        ammo: Some(30),
        damage: Some(12.0),
        range: Some(600.0),
        impact_radius: Some(0.0),
        cooldown_s: Some(0.25),
        projectile_speed: Some(700.0),
        explosive: Some(false),
    },
    ItemDef {
        id: ItemId::Shotgun,
        kind: ItemKind::Weapon,
        name: "Shotgun",
        max_stack: 1,
        ammo: Some(12),
        // Per PELLET; 5 pellets fire per shot (docs/04 §4).
        damage: Some(7.0),
        range: Some(260.0),
        impact_radius: Some(0.0),
        cooldown_s: Some(0.8),
        projectile_speed: Some(600.0),
        explosive: Some(false),
    },
    ItemDef {
        id: ItemId::Rocket,
        kind: ItemKind::Weapon,
        name: "Rocket",
        max_stack: 1,
        ammo: Some(6),
        damage: Some(60.0),
        range: Some(900.0),
        impact_radius: Some(48.0),
        cooldown_s: Some(1.0),
        projectile_speed: Some(500.0),
        explosive: Some(true),
    },
    ItemDef {
        id: ItemId::Grenade,
        kind: ItemKind::Weapon,
        name: "Grenade",
        max_stack: 1,
        ammo: Some(4),
        damage: Some(45.0),
        range: Some(400.0),
        impact_radius: Some(40.0),
        cooldown_s: Some(1.2),
        projectile_speed: Some(400.0),
        explosive: Some(true),
    },
    ItemDef::consumable(ItemId::Medkit, ItemKind::Health, "Medkit"),
    ItemDef::consumable(ItemId::Overcharge, ItemKind::Health, "Overcharge"),
    ItemDef::consumable(ItemId::ShieldGen, ItemKind::Shield, "Shield Gen"),
    ItemDef::consumable(ItemId::Flashlight, ItemKind::Utility, "Flashlight"),
];

/// Look up an item's definition.
pub fn def(id: ItemId) -> &'static ItemDef {
    // ItemId::ALL and CATALOG are declared in the same order; asserted by
    // `catalog_is_indexed_by_item_id`.
    &CATALOG[id as usize]
}

/// Which spawn-weight table to draw from (docs/04 §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnWeights {
    /// Sources A, C and D — ground, crates, timed.
    Ground,
    /// Source B — hidden in rock. Same as [`SpawnWeights::Ground`] but
    /// flashlight is twice as likely.
    Hidden,
}

impl SpawnWeights {
    /// Weights in `ItemId::ALL` order (docs/04 §3 rows A and B).
    ///
    /// These are relative WEIGHTS, not percentages — see DEVIATIONS.md D37.
    pub const fn table(self) -> [u32; 8] {
        match self {
            //          pistol shotgun rocket grenade medkit overch shield flash
            SpawnWeights::Ground => [30, 20, 15, 15, 20, 10, 10, 10],
            SpawnWeights::Hidden => [30, 20, 15, 15, 20, 10, 10, 20],
        }
    }
}

/// Draw one item from a weight table (docs/04 §3).
///
/// All randomness goes through the round `GameRng` (docs/00 §4). One draw per
/// call — the draw count is part of the determinism contract (D19).
pub fn pick_item(rng: &mut GameRng, weights: SpawnWeights) -> ItemId {
    let table = weights.table();
    let index = rng
        .weighted_index(&table)
        .expect("spawn weight table is non-empty and has a positive total");
    ItemId::ALL[index]
}

/// Inventory slot count (docs/04 §5: "6 slots, each holds 1 item").
pub const SLOT_COUNT: usize = 6;

/// A player's inventory (docs/04 §5).
///
/// Pickup, use and the flashlight rule land in T3.6/T3.7; this is the state
/// `Player` carries from T2.1 onward.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inventory {
    /// docs/04 §5: `slots: [Option<ItemId>; 6]`.
    pub slots: [Option<ItemId>; SLOT_COUNT],
    /// Index of the selected slot, 0..=5.
    pub selected: u8,
}

impl Default for Inventory {
    fn default() -> Self {
        Inventory {
            slots: [None; SLOT_COUNT],
            selected: 0,
        }
    }
}

impl Inventory {
    pub fn new() -> Self {
        Self::default()
    }

    /// The item in the selected slot, if any.
    pub fn selected_item(&self) -> Option<ItemId> {
        self.slots.get(self.selected as usize).copied().flatten()
    }

    /// Index of the first free slot (docs/04 §5: "fill first free slot").
    pub fn first_free_slot(&self) -> Option<usize> {
        self.slots.iter().position(|slot| slot.is_none())
    }

    /// Whether any slot is free.
    pub fn has_free_slot(&self) -> bool {
        self.first_free_slot().is_some()
    }

    /// Whether the inventory already holds `item`.
    pub fn contains(&self, item: ItemId) -> bool {
        self.slots.iter().any(|slot| *slot == Some(item))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_starts_empty_with_six_slots() {
        // docs/04 §5.
        let inv = Inventory::new();
        assert_eq!(inv.slots.len(), SLOT_COUNT);
        assert!(inv.slots.iter().all(|s| s.is_none()));
        assert_eq!(inv.selected, 0);
        assert_eq!(inv.selected_item(), None);
        assert_eq!(inv.first_free_slot(), Some(0));
        assert!(inv.has_free_slot());
    }

    #[test]
    fn first_free_slot_skips_filled_slots() {
        let mut inv = Inventory::new();
        inv.slots[0] = Some(ItemId::Pistol);
        inv.slots[1] = Some(ItemId::Medkit);
        assert_eq!(inv.first_free_slot(), Some(2));
        assert!(inv.contains(ItemId::Pistol));
        assert!(!inv.contains(ItemId::Rocket));
    }

    #[test]
    fn full_inventory_reports_no_free_slot() {
        let mut inv = Inventory::new();
        inv.slots = [Some(ItemId::Pistol); SLOT_COUNT];
        assert_eq!(inv.first_free_slot(), None);
        assert!(!inv.has_free_slot());
    }

    #[test]
    fn selected_item_is_bounds_safe() {
        // A selected index past the end must read as empty, not panic.
        let mut inv = Inventory::new();
        inv.slots[0] = Some(ItemId::Rocket);
        inv.selected = 99;
        assert_eq!(inv.selected_item(), None);
    }
}

// ---------------------------------------------------------------------------
// Ground items and placement (T3.2, docs/04 §3)
// ---------------------------------------------------------------------------

/// Source-A placement count (docs/04 §3 row A: "10 items").
pub const SOURCE_A_COUNT: usize = 10;
/// Minimum Chebyshev tile spacing between source-A items (docs/04 §3 row A).
pub const SOURCE_A_SPACING: u32 = 6;
/// Auto-pickup radius, px (docs/04 §5: "walking over a ground item (16 px)").
pub const PICKUP_RADIUS: f32 = 16.0;

/// An item lying on the ground, pickable (T3.2 step 1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GroundItem {
    pub id: u32,
    pub item: ItemId,
    /// Px, tile centre.
    pub x: f32,
    pub y: f32,
    /// True while this is an unopened supply crate (docs/04 §3 row C).
    pub is_crate: bool,
    /// True while still concealed inside a ROCK tile (docs/04 §3 row B).
    pub hidden: bool,
}

/// Allocates the `id` field of [`GroundItem`], monotonically within a round.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ItemIdCounter(u32);

impl ItemIdCounter {
    pub fn next(&mut self) -> u32 {
        let id = self.0;
        self.0 += 1;
        id
    }
}

/// Surface tiles eligible to hold a ground item.
///
/// docs/04 §3 row A says "random surface tiles"; docs/01 §3 makes the surface
/// tile of every column GRASS. Scanned in column order so the candidate list
/// is deterministic before the RNG ever sees it.
fn surface_candidates(map: &Map) -> Vec<(u32, u32)> {
    (0..map.width)
        .filter_map(|x| {
            let y = map.surface_row(x);
            (y < map.height && map.tile(x, y).kind == TileKind::Grass).then_some((x, y))
        })
        .collect()
}

/// Place the round's source-A items (docs/04 §3 row A, T3.2 step 2).
///
/// "pick 10 random surface tiles (RNG, >= 6 tile spacing), place item at tile
/// centre. Weighted pick: [row A weights]."
///
/// Draw order per item is **position, then item kind** — recorded because the
/// order fixes the whole downstream sequence (docs/04 §6, D19).
pub fn place_initial(map: &Map, rng: &mut GameRng, ids: &mut ItemIdCounter) -> Vec<GroundItem> {
    let mut candidates = surface_candidates(map);
    rng.shuffle(&mut candidates);

    let mut placed: Vec<GroundItem> = Vec::with_capacity(SOURCE_A_COUNT);
    let mut accepted: Vec<(u32, u32)> = Vec::with_capacity(SOURCE_A_COUNT);

    for &(cx, cy) in &candidates {
        if placed.len() == SOURCE_A_COUNT {
            break;
        }
        let far_enough = accepted
            .iter()
            .all(|&(ax, ay)| cx.abs_diff(ax).max(cy.abs_diff(ay)) >= SOURCE_A_SPACING);
        if !far_enough {
            continue;
        }
        accepted.push((cx, cy));
        let item = pick_item(rng, SpawnWeights::Ground);
        let centre = Map::tile_center(cx, cy);
        placed.push(GroundItem {
            id: ids.next(),
            item,
            x: centre.x,
            y: centre.y,
            is_crate: false,
            hidden: false,
        });
    }

    placed
}

/// Source-B placement count (docs/04 §3 row B: "4 hidden in rock").
pub const SOURCE_B_COUNT: usize = 4;
/// Minimum pocket size eligible to hide an item (docs/04 §3 row B: ">= 2 tiles").
pub const SOURCE_B_MIN_POCKET: usize = 2;

/// Connected ROCK components, 4-connected, each a list of tile coords.
///
/// Scanned in row-major order and each component's tiles collected in a
/// deterministic order, so the pocket list the RNG sees never depends on
/// hashing or address order (docs/00 §2).
pub fn rock_pockets(map: &Map) -> Vec<Vec<(u32, u32)>> {
    let (w, h) = (map.width as usize, map.height as usize);
    let mut seen = vec![false; w * h];
    let mut pockets = Vec::new();

    for start in 0..w * h {
        let (sx, sy) = ((start % w) as u32, (start / w) as u32);
        if seen[start] || map.tile(sx, sy).kind != TileKind::Rock {
            continue;
        }
        // Breadth-first from a fixed start in a fixed neighbour order.
        let mut queue = std::collections::VecDeque::from([start]);
        seen[start] = true;
        let mut tiles = Vec::new();
        while let Some(index) = queue.pop_front() {
            let (x, y) = ((index % w) as u32, (index / w) as u32);
            tiles.push((x, y));
            for (dx, dy) in [(0i32, -1i32), (-1, 0), (1, 0), (0, 1)] {
                let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue;
                }
                let next = ny as usize * w + nx as usize;
                if !seen[next] && map.tile(nx as u32, ny as u32).kind == TileKind::Rock {
                    seen[next] = true;
                    queue.push_back(next);
                }
            }
        }
        pockets.push(tiles);
    }
    pockets
}

/// Hide source-B items inside rock pockets (docs/04 §3 row B, T3.3 step 1).
///
/// "pick 4 rock pockets (RNG) that are >= 2 tiles; place one item in a random
/// ROCK tile of the pocket (item hidden until that tile destroyed)."
///
/// The item is stored **on the tile**, so any blast that destroys it uncovers
/// the item — weapon fire or a meteor alike (T3.3 Acceptance).
///
/// Draw order per pocket: which tile, then which item.
pub fn place_hidden(map: &mut Map, rng: &mut GameRng) -> Vec<(u32, u32, ItemId)> {
    let mut eligible: Vec<Vec<(u32, u32)>> = rock_pockets(map)
        .into_iter()
        .filter(|p| p.len() >= SOURCE_B_MIN_POCKET)
        .collect();

    // Shuffle once, then take the first N — "pick 4 pockets" without replacement.
    rng.shuffle(&mut eligible);

    let mut placed = Vec::new();
    for pocket in eligible.iter().take(SOURCE_B_COUNT) {
        let tile_index = rng.gen_range(0, pocket.len() as u32) as usize;
        let (x, y) = pocket[tile_index];
        let item = pick_item(rng, SpawnWeights::Hidden);

        let mut tile = map.tile(x, y);
        tile.item = Some(item);
        map.set_tile(x, y, tile);
        placed.push((x, y, item));
    }
    placed
}

// ---------------------------------------------------------------------------
// Source C: supply crates (T3.4, docs/04 §3 row C)
// ---------------------------------------------------------------------------

/// Crate drop times, seconds into the round (docs/04 §3 row C:
/// "every 45 s (t=45, 90, 135, 180, 225)").
pub const CRATE_DROP_TIMES_S: [f32; 5] = [45.0, 90.0, 135.0, 180.0, 225.0];
/// Crate fall speed, px/s (T3.4 step 2).
pub const CRATE_FALL_SPEED: f32 = 200.0;
/// How long a landed crate sits before expiring, seconds (docs/04 §3 row C).
pub const CRATE_LIFETIME_S: f32 = 60.0;
/// Items a crate yields when opened (docs/04 §3 row C: "1 crate = 2 items").
pub const CRATE_CONTENTS: usize = 2;
/// Spawn height, px above the map top (T3.4 step 2: "y = -20").
pub const CRATE_SPAWN_Y: f32 = -20.0;

/// A falling or landed supply crate (T3.4 step 1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Crate {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    /// Px/s. Zero once landed.
    pub vy: f32,
    pub landed: bool,
    pub content: [ItemId; CRATE_CONTENTS],
    /// Tick at which an unopened crate disappears. Set on landing.
    pub expires_tick: Option<u64>,
}

/// Spawn a crate above the map at a random column (docs/04 §3 row C).
///
/// Draw order: column, then the two contents in order.
pub fn spawn_crate(map: &Map, rng: &mut GameRng, ids: &mut ItemIdCounter) -> Crate {
    let column = rng.gen_range(0, map.width);
    let first = pick_item(rng, SpawnWeights::Ground);
    let second = pick_item(rng, SpawnWeights::Ground);
    Crate {
        id: ids.next(),
        x: (column as f32 + 0.5) * TILE_SIZE,
        y: CRATE_SPAWN_Y,
        vy: CRATE_FALL_SPEED,
        landed: false,
        content: [first, second],
        expires_tick: None,
    }
}

/// Advance a crate one tick (T3.4 step 2).
///
/// "fall at 200 px/s until the tile under it is solid → landed, sits 60 s".
///
/// The fall is stepped and then **clamped to the surface** rather than left
/// wherever the tick boundary happened to land, so a crate never comes to rest
/// inside terrain (T3.4 Acceptance) regardless of tick size — at 200 px/s a
/// tick covers 10 px, which is most of a 16 px tile.
pub fn step_crate(crate_: &mut Crate, map: &Map, tick: u64, dt: f32) {
    if crate_.landed {
        return;
    }

    let next_y = crate_.y + crate_.vy * dt;

    // The column this crate is falling down.
    let Some(column) = map.tile_at_pixel(crate_.x, 0.0).map(|(x, _)| x) else {
        // Off-map horizontally: nothing to land on.
        crate_.y = next_y;
        return;
    };

    // Only tiles the crate actually PASSES THROUGH this tick can stop it.
    // Searching the whole column below would teleport the crate to the surface
    // on its first step, ignoring the documented 200 px/s fall entirely.
    let from_row = if crate_.y < 0.0 { 0 } else { (crate_.y / TILE_SIZE) as u32 };
    let to_row = if next_y < 0.0 {
        0
    } else {
        ((next_y / TILE_SIZE) as u32).min(map.height.saturating_sub(1))
    };

    let landing_row = if next_y < 0.0 {
        // Still above the map: nothing to hit.
        None
    } else {
        (from_row..=to_row).find(|&row| map.is_solid(column, row))
    };

    match landing_row {
        Some(row) => {
            // Rest on top of that tile. Clamping rather than leaving the crate
            // wherever the tick boundary fell keeps it out of terrain
            // (T3.4 Acceptance) — a tick covers 10 px of a 16 px tile.
            crate_.y = row as f32 * TILE_SIZE;
            crate_.vy = 0.0;
            crate_.landed = true;
            crate_.expires_tick = Some(tick + (CRATE_LIFETIME_S / dt) as u64);
        }
        None => {
            crate_.y = next_y;
        }
    }
}

/// Open a landed crate, turning it into its two ground items (T3.4 step 3).
pub fn open_crate(crate_: &Crate, ids: &mut ItemIdCounter) -> Vec<GroundItem> {
    crate_
        .content
        .iter()
        .map(|item| GroundItem {
            id: ids.next(),
            item: *item,
            x: crate_.x,
            y: crate_.y,
            is_crate: false,
            hidden: false,
        })
        .collect()
}

/// Whether a player at `(px, py)` is close enough to open a landed crate
/// (docs/04 §3 row C, using the §5 pickup radius).
pub fn player_reaches_crate(crate_: &Crate, px: f32, py: f32) -> bool {
    crate_.landed && (crate_.x - px).hypot(crate_.y - py) <= PICKUP_RADIUS
}

/// T3.1 catalog tests.
///
/// Named `catalog_tests` so T3.1's Test command, `cargo test -p game-core
/// catalog`, selects them (D27).
#[cfg(test)]
mod catalog_tests {
    use super::*;

    #[test]
    fn catalog_ammo_matches_doc() {
        // docs/08 §1 (items row) + T3.1 step 4: "assert every field of every
        // def against the doc table (this test IS the doc check)".
        //
        // Every expected value below is a LITERAL transcribed from
        // docs/04-items.md §1. Comparing against CATALOG's own constants would
        // make this test vacuous — it would pass for any table whatsoever.
        //
        // (id, kind, ammo, damage, range, impact_radius, cooldown_s, speed, explosive)
        type Row = (
            ItemId,
            ItemKind,
            Option<u8>,
            Option<f32>,
            Option<f32>,
            Option<f32>,
            Option<f32>,
            Option<f32>,
            Option<bool>,
        );
        let doc: [Row; 8] = [
            // | Pistol | Weapon | 30 | 12 | 600 | 0 | 0.25 s | 700 | non-explosive |
            (ItemId::Pistol, ItemKind::Weapon, Some(30), Some(12.0), Some(600.0),
             Some(0.0), Some(0.25), Some(700.0), Some(false)),
            // | Shotgun | Weapon | 12 | 7 x5 pellets | 260 | 0 | 0.8 s | 600 |
            (ItemId::Shotgun, ItemKind::Weapon, Some(12), Some(7.0), Some(260.0),
             Some(0.0), Some(0.8), Some(600.0), Some(false)),
            // | Rocket | Weapon | 6 | 60 | 900 | 48 | 1.0 s | 500 | explosive |
            (ItemId::Rocket, ItemKind::Weapon, Some(6), Some(60.0), Some(900.0),
             Some(48.0), Some(1.0), Some(500.0), Some(true)),
            // | Grenade | Weapon | 4 | 45 | 400 | 40 | 1.2 s | 400 | explosive |
            (ItemId::Grenade, ItemKind::Weapon, Some(4), Some(45.0), Some(400.0),
             Some(40.0), Some(1.2), Some(400.0), Some(true)),
            // | Medkit | Health | - | +50 hp | - | - | - | - |
            (ItemId::Medkit, ItemKind::Health, None, None, None, None, None, None, None),
            // | Overcharge | Health | - | max 150 / 10 s | - | - | - | - |
            (ItemId::Overcharge, ItemKind::Health, None, None, None, None, None, None, None),
            // | Shield Gen | Shield | - | 50% dmg red, 20 s | - | - | - | - |
            (ItemId::ShieldGen, ItemKind::Shield, None, None, None, None, None, None, None),
            // | Flashlight | Utility | - | FOV at night | - | - | - | - |
            (ItemId::Flashlight, ItemKind::Utility, None, None, None, None, None, None, None),
        ];

        assert_eq!(CATALOG.len(), 8, "docs/04 §1 lists 8 items");
        for (id, kind, ammo, damage, range, radius, cooldown, speed, explosive) in doc {
            let entry = def(id);
            assert_eq!(entry.id, id, "{id:?}: wrong id");
            assert_eq!(entry.kind, kind, "{id:?}: kind");
            assert_eq!(entry.ammo, ammo, "{id:?}: ammo");
            assert_eq!(entry.damage, damage, "{id:?}: damage");
            assert_eq!(entry.range, range, "{id:?}: range");
            assert_eq!(entry.impact_radius, radius, "{id:?}: impact_radius");
            assert_eq!(entry.cooldown_s, cooldown, "{id:?}: cooldown_s");
            assert_eq!(entry.projectile_speed, speed, "{id:?}: projectile_speed");
            assert_eq!(entry.explosive, explosive, "{id:?}: explosive");
            // docs/04 §1: "max_stack: 1 for all v1 items".
            assert_eq!(entry.max_stack, 1, "{id:?}: max_stack");
        }
    }

    #[test]
    fn catalog_is_indexed_by_item_id() {
        // `def()` indexes CATALOG by the enum discriminant; that is only valid
        // while the two are declared in the same order.
        for (index, id) in ItemId::ALL.iter().enumerate() {
            assert_eq!(CATALOG[index].id, *id, "CATALOG[{index}] is not {id:?}");
            assert_eq!(def(*id).id, *id);
        }
    }

    #[test]
    fn only_weapons_carry_weapon_fields() {
        // The structural half of docs/04 §1: weapon-only fields exist for
        // weapons and for nothing else.
        for entry in CATALOG {
            let is_weapon = entry.kind == ItemKind::Weapon;
            assert_eq!(
                entry.ammo.is_some(), is_weapon,
                "{:?}: ammo presence should match weapon-ness", entry.id,
            );
            assert_eq!(entry.cooldown_s.is_some(), is_weapon, "{:?}: cooldown", entry.id);
            assert_eq!(
                entry.projectile_speed.is_some(), is_weapon,
                "{:?}: projectile_speed", entry.id,
            );
        }
    }

    #[test]
    fn explosive_weapons_are_exactly_rocket_and_grenade() {
        // docs/04 §1 notes: rocket "explosive, destroys tiles", grenade
        // "arcs with gravity, bounces 1x"; pistol/shotgun "non-explosive".
        let explosive: Vec<ItemId> = CATALOG
            .iter()
            .filter(|d| d.explosive == Some(true))
            .map(|d| d.id)
            .collect();
        assert_eq!(explosive, vec![ItemId::Rocket, ItemId::Grenade]);
        // An explosive weapon must have a non-zero blast radius, and a
        // non-explosive one must not.
        for entry in CATALOG {
            if let Some(explodes) = entry.explosive {
                let radius = entry.impact_radius.unwrap_or(0.0);
                assert_eq!(
                    explodes, radius > 0.0,
                    "{:?}: explosive={explodes} but impact_radius={radius}", entry.id,
                );
            }
        }
    }

    #[test]
    fn spawn_weights_match_doc() {
        // docs/04 §3 row A: "pistol 30 / shotgun 20 / rocket 15 / grenade 15,
        // medkit 20%, shield 10%, overcharge 10%, flashlight 10%".
        // Row B: "same as A but flashlight 20%".
        //
        // Literals in ItemId::ALL order, transcribed from the doc.
        assert_eq!(
            SpawnWeights::Ground.table(),
            [30, 20, 15, 15, 20, 10, 10, 10],
            "source A/C/D weights",
        );
        assert_eq!(
            SpawnWeights::Hidden.table(),
            [30, 20, 15, 15, 20, 10, 10, 20],
            "source B weights (flashlight doubled)",
        );
        // B differs from A in exactly one entry: flashlight.
        let (a, b) = (SpawnWeights::Ground.table(), SpawnWeights::Hidden.table());
        let differing: Vec<usize> = (0..8).filter(|&i| a[i] != b[i]).collect();
        assert_eq!(differing, vec![7], "only flashlight should differ");
    }

    #[test]
    fn pick_item_follows_the_weights() {
        let mut rng = GameRng::new(1);
        let mut counts = [0u32; 8];
        const DRAWS: u32 = 130_000;
        for _ in 0..DRAWS {
            let id = pick_item(&mut rng, SpawnWeights::Ground);
            counts[ItemId::ALL.iter().position(|c| *c == id).unwrap()] += 1;
        }
        // Total weight is 130, so a weight-30 item should land ~30/130 of the
        // time. Allow 15% relative slack.
        let table = SpawnWeights::Ground.table();
        let total: u32 = table.iter().sum();
        for (i, &weight) in table.iter().enumerate() {
            let expected = DRAWS as f32 * weight as f32 / total as f32;
            let actual = counts[i] as f32;
            assert!(
                (actual - expected).abs() < expected * 0.15,
                "{:?}: drew {actual} times, expected ~{expected}",
                ItemId::ALL[i],
            );
        }
    }

    #[test]
    fn hidden_weights_make_flashlight_twice_as_likely() {
        let mut ground = GameRng::new(7);
        let mut hidden = GameRng::new(7);
        let (mut g, mut h) = (0u32, 0u32);
        for _ in 0..60_000 {
            if pick_item(&mut ground, SpawnWeights::Ground) == ItemId::Flashlight {
                g += 1;
            }
            if pick_item(&mut hidden, SpawnWeights::Hidden) == ItemId::Flashlight {
                h += 1;
            }
        }
        // 10/130 vs 20/140 -> ratio ~1.86, not exactly 2, because the total
        // weight grows too. Assert the direction and a plausible band.
        let ratio = h as f32 / g as f32;
        assert!(
            (1.6..2.1).contains(&ratio),
            "flashlight ratio hidden/ground was {ratio}, expected ~1.86",
        );
    }

    #[test]
    fn pick_item_is_deterministic() {
        let draw = |seed: u64| {
            let mut rng = GameRng::new(seed);
            (0..50).map(|_| pick_item(&mut rng, SpawnWeights::Ground)).collect::<Vec<_>>()
        };
        assert_eq!(draw(42), draw(42));
        assert_ne!(draw(1), draw(2));
    }

    #[test]
    fn pick_item_consumes_one_draw() {
        // Draw count is part of the determinism contract (D19): if pick_item
        // consumed a variable number of words, every later draw in the round
        // would shift depending on which item came out.
        let mut probe = GameRng::new(11);
        let _ = pick_item(&mut probe, SpawnWeights::Ground);
        let after = probe.next_u64();

        let mut manual = GameRng::new(11);
        let _ = manual.weighted_index(&SpawnWeights::Ground.table());
        assert_eq!(manual.next_u64(), after);
    }
}

/// T3.2 source-A placement tests.
///
/// Named `initial_tests` so T3.2's Test command,
/// `cargo test -p game-core items::initial`, selects them (D27).
#[cfg(test)]
mod initial_tests {
    use super::*;
    use crate::map::Scale;
    use crate::tiles::TILE_SIZE;

    fn place(seed: u64, scale: Scale) -> (Map, Vec<GroundItem>) {
        let map = Map::generate(seed, scale);
        let mut rng = GameRng::new(seed);
        let mut ids = ItemIdCounter::default();
        let items = place_initial(&map, &mut rng, &mut ids);
        (map, items)
    }

    #[test]
    fn placement_a_deterministic() {
        // docs/08 §1 (items row) + T3.2 step 4: "same seed -> same 10
        // positions; spacing >= 6 for all pairs; all on GRASS tiles".
        for scale in Scale::ALL {
            for seed in [1u64, 42, 777, 12345] {
                let (_, first) = place(seed, scale);
                let (_, second) = place(seed, scale);
                assert_eq!(first, second, "{} seed {seed} placed differently", scale.as_str());
            }
        }
        // Different seeds must differ, or "deterministic" is trivially true.
        let (_, a) = place(1, Scale::Small);
        let (_, b) = place(2, Scale::Small);
        assert_ne!(a, b);
    }

    #[test]
    fn placement_a_places_ten_items() {
        // docs/04 §3 row A: "10 items".
        for scale in Scale::ALL {
            for seed in 0..20u64 {
                let (_, items) = place(seed, scale);
                assert_eq!(
                    items.len(), 10,
                    "{} seed {seed} placed {} items", scale.as_str(), items.len(),
                );
            }
        }
    }

    #[test]
    fn placement_a_respects_six_tile_spacing() {
        // docs/04 §3 row A: ">= 6 tile spacing".
        for scale in Scale::ALL {
            for seed in 0..20u64 {
                let (_, items) = place(seed, scale);
                for (i, a) in items.iter().enumerate() {
                    for b in items.iter().skip(i + 1) {
                        let (ax, ay) = ((a.x / TILE_SIZE) as u32, (a.y / TILE_SIZE) as u32);
                        let (bx, by) = ((b.x / TILE_SIZE) as u32, (b.y / TILE_SIZE) as u32);
                        let chebyshev = ax.abs_diff(bx).max(ay.abs_diff(by));
                        assert!(
                            chebyshev >= 6,
                            "{} seed {seed}: items {} tiles apart, need 6",
                            scale.as_str(), chebyshev,
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn placement_a_sits_on_grass_tile_centres() {
        // "place item at tile center", and the surface tile is GRASS.
        for seed in 0..20u64 {
            let (map, items) = place(seed, Scale::Small);
            for item in &items {
                let (tx, ty) = ((item.x / TILE_SIZE) as u32, (item.y / TILE_SIZE) as u32);
                assert_eq!(
                    map.tile(tx, ty).kind, TileKind::Grass,
                    "seed {seed}: item at ({tx},{ty}) is not on GRASS",
                );
                let centre = Map::tile_center(tx, ty);
                assert!((item.x - centre.x).abs() < 1e-3, "item x is not a tile centre");
                assert!((item.y - centre.y).abs() < 1e-3, "item y is not a tile centre");
                assert_eq!(ty, map.surface_row(tx), "item is not on the surface row");
            }
        }
    }

    #[test]
    fn no_two_items_share_a_tile() {
        // T3.2 Acceptance. Implied by the 6-tile spacing, but asserted
        // separately: a spacing bug that let two items coincide would be
        // invisible in a pairwise-distance check that used >= 0.
        for seed in 0..20u64 {
            let (_, items) = place(seed, Scale::Small);
            for (i, a) in items.iter().enumerate() {
                for b in items.iter().skip(i + 1) {
                    assert!(
                        (a.x - b.x).abs() > 1e-3 || (a.y - b.y).abs() > 1e-3,
                        "seed {seed}: two items share a position",
                    );
                }
            }
        }
    }

    #[test]
    fn ground_items_get_distinct_ids() {
        let (_, items) = place(1, Scale::Small);
        let mut ids: Vec<u32> = items.iter().map(|i| i.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "ground item ids are not distinct");
    }

    #[test]
    fn placed_items_are_visible_and_not_crates() {
        // Source A places loose items, not crates (row C) and not hidden
        // items (row B).
        let (_, items) = place(3, Scale::Small);
        assert!(items.iter().all(|i| !i.is_crate), "source A placed a crate");
        assert!(items.iter().all(|i| !i.hidden), "source A placed a hidden item");
    }

    #[test]
    fn placement_draws_position_then_item() {
        // The draw ORDER is part of the determinism contract (docs/04 §6).
        // Reconstruct it by hand and confirm the RNG ends in the same state.
        let map = Map::generate(5, Scale::Small);

        let mut probe = GameRng::new(5);
        let mut ids = ItemIdCounter::default();
        let items = place_initial(&map, &mut probe, &mut ids);
        let after = probe.next_u64();

        let mut manual = GameRng::new(5);
        let mut candidates = surface_candidates(&map);
        manual.shuffle(&mut candidates);
        // Reconstruct the ITEMS too, not just the draw count. Checking only
        // the count cannot tell which weight table was used, because
        // weighted_index consumes one draw either way — source A silently
        // drawing from the source-B (Hidden) table failed zero tests until
        // this reconstruction was added.
        let mut expected_items = Vec::new();
        for _ in 0..items.len() {
            let index = manual.weighted_index(&SpawnWeights::Ground.table()).unwrap();
            expected_items.push(ItemId::ALL[index]);
        }
        assert_eq!(
            manual.next_u64(), after,
            "place_initial consumed a different number of draws than \
             shuffle-then-one-pick-per-item",
        );

        let actual_items: Vec<ItemId> = items.iter().map(|i| i.item).collect();
        assert_eq!(
            actual_items, expected_items,
            "source A must draw from the row-A (Ground) weight table",
        );
    }

    #[test]
    fn source_a_uses_the_ground_weight_table() {
        // docs/04 §3: row A is the Ground table; row B (flashlight doubled) is
        // for hidden items only. Statistically distinguishable over many maps.
        let mut flashlights = 0usize;
        let mut total = 0usize;
        for seed in 0..400u64 {
            let map = Map::generate(seed, Scale::Small);
            let mut rng = GameRng::new(seed);
            let mut ids = ItemIdCounter::default();
            for item in place_initial(&map, &mut rng, &mut ids) {
                total += 1;
                if item.item == ItemId::Flashlight {
                    flashlights += 1;
                }
            }
        }
        let rate = flashlights as f32 / total as f32;
        // Ground: 10/130 = 0.0769.  Hidden: 20/140 = 0.1429.
        assert!(
            (0.055..0.100).contains(&rate),
            "flashlight rate {rate:.4} suggests the wrong weight table \
             (Ground = 0.077, Hidden = 0.143)",
        );
    }
}

/// T3.3 source-B hidden-item tests.
///
/// Named `hidden_tests` so T3.3's Test command,
/// `cargo test -p game-core items::hidden`, selects them (D27).
#[cfg(test)]
mod hidden_tests {
    use super::*;
    use crate::map::Scale;

    fn hide(seed: u64, scale: Scale) -> (Map, Vec<(u32, u32, ItemId)>) {
        let mut map = Map::generate(seed, scale);
        let mut rng = GameRng::new(seed);
        let placed = place_hidden(&mut map, &mut rng);
        (map, placed)
    }

    #[test]
    fn hidden_items_in_rock_tiles() {
        // docs/08 §1 (items row) + T3.3 step 4: "all 4 items sit in ROCK tiles".
        for scale in Scale::ALL {
            for seed in 0..20u64 {
                let (map, placed) = hide(seed, scale);
                assert_eq!(
                    placed.len(), 4,
                    "{} seed {seed} hid {} items, expected 4",
                    scale.as_str(), placed.len(),
                );
                for (x, y, item) in &placed {
                    let tile = map.tile(*x, *y);
                    assert_eq!(
                        tile.kind, TileKind::Rock,
                        "{} seed {seed}: hidden item at ({x},{y}) is in {:?}, not ROCK",
                        scale.as_str(), tile.kind,
                    );
                    assert_eq!(
                        tile.item, Some(*item),
                        "{} seed {seed}: tile ({x},{y}) does not carry its item",
                        scale.as_str(),
                    );
                }
            }
        }
    }

    #[test]
    fn hidden_items_go_in_distinct_pockets_of_at_least_two_tiles() {
        // docs/04 §3 row B: "pick 4 rock pockets (RNG) that are >= 2 tiles".
        for seed in 0..20u64 {
            let (map, placed) = hide(seed, Scale::Small);
            let pockets = rock_pockets(&map);
            let mut used: Vec<usize> = Vec::new();
            for (x, y, _) in &placed {
                let index = pockets
                    .iter()
                    .position(|p| p.contains(&(*x, *y)))
                    .expect("hidden item is not in any rock pocket");
                assert!(
                    pockets[index].len() >= SOURCE_B_MIN_POCKET,
                    "seed {seed}: pocket has {} tiles, need >= 2",
                    pockets[index].len(),
                );
                assert!(
                    !used.contains(&index),
                    "seed {seed}: two items hidden in the same pocket",
                );
                used.push(index);
            }
        }
    }

    #[test]
    fn destroying_the_exact_tile_uncovers_the_item() {
        // T3.3 step 4: "destroying that exact tile spawns the item;
        // destroying a neighbour does not".
        let (mut map, placed) = hide(1, Scale::Small);
        let (x, y, item) = placed[0];

        // A neighbouring ROCK tile in the same pocket must NOT yield the item.
        let pockets = rock_pockets(&map);
        let pocket = pockets.iter().find(|p| p.contains(&(x, y))).unwrap().clone();
        if let Some(&(nx, ny)) = pocket.iter().find(|&&t| t != (x, y)) {
            let event = map.destroy_tile(nx, ny).expect("neighbour is solid");
            assert_eq!(event.item, None, "a neighbour tile yielded the hidden item");
        }

        let event = map.destroy_tile(x, y).expect("the hidden tile is solid");
        assert_eq!(event.item, Some(item), "destroying the tile did not uncover it");
        assert_eq!(map.tile(x, y).item, None, "the item stayed on the destroyed tile");
    }

    #[test]
    fn any_blast_can_uncover_a_hidden_item() {
        // T3.3 Acceptance: "an item can be uncovered by ANY blast (weapon or
        // meteor)" — the item lives on the tile, so nothing needs to know
        // where items are hidden.
        let (mut map, placed) = hide(2, Scale::Small);
        let (x, y, item) = placed[0];
        let centre = Map::tile_center(x, y);

        let destroyed = map.apply_blast(centre.x, centre.y, 48.0, 500.0);
        let uncovered: Vec<ItemId> = destroyed.iter().filter_map(|e| e.item).collect();
        assert!(
            uncovered.contains(&item),
            "a blast over the hidden tile did not uncover the item",
        );
    }

    #[test]
    fn weather_destruction_leaves_the_item_buried() {
        // T3.3 step 3 / docs/02 §5: lava passes skip_items = true, and
        // "weather destruction skips item uncovery".
        //
        // The item must stay BURIED, not be destroyed with the tile — a later
        // weapon blast should still be able to reveal it.
        let (mut map, placed) = hide(3, Scale::Small);
        let (x, y, item) = placed[0];
        let centre = Map::tile_center(x, y);

        let destroyed = map.apply_blast_with(centre.x, centre.y, 48.0, 500.0, true);
        assert!(!destroyed.is_empty(), "the weather blast destroyed nothing");
        assert!(
            destroyed.iter().all(|e| e.item.is_none()),
            "weather destruction uncovered an item",
        );
        assert_eq!(
            map.tile(x, y).item,
            Some(item),
            "the item was lost rather than left buried",
        );
    }

    #[test]
    fn hidden_placement_is_deterministic() {
        for scale in Scale::ALL {
            for seed in [1u64, 42, 999] {
                let (_, a) = hide(seed, scale);
                let (_, b) = hide(seed, scale);
                assert_eq!(a, b, "{} seed {seed}", scale.as_str());
            }
        }
        let (_, a) = hide(1, Scale::Small);
        let (_, b) = hide(2, Scale::Small);
        assert_ne!(a, b);
    }

    #[test]
    fn hidden_items_use_the_source_b_weight_table() {
        // docs/04 §3 row B: "same as A but flashlight 20%". Ground gives a
        // 7.7% flashlight rate, Hidden 14.3% — statistically separable.
        let mut flashlights = 0usize;
        let mut total = 0usize;
        for seed in 0..500u64 {
            let (_, placed) = hide(seed, Scale::Small);
            for (_, _, item) in placed {
                total += 1;
                if item == ItemId::Flashlight {
                    flashlights += 1;
                }
            }
        }
        let rate = flashlights as f32 / total as f32;
        assert!(
            (0.110..0.180).contains(&rate),
            "flashlight rate {rate:.4} suggests the wrong weight table \
             (Hidden = 0.143, Ground = 0.077)",
        );
    }

    #[test]
    fn placement_draws_tile_then_item_per_pocket() {
        // Draw order and count, per docs/04 §6 and D19.
        let mut map = Map::generate(5, Scale::Small);
        let mut probe = GameRng::new(5);
        let placed = place_hidden(&mut map, &mut probe);
        let after = probe.next_u64();

        let reference = Map::generate(5, Scale::Small);
        let mut manual = GameRng::new(5);
        let mut eligible: Vec<Vec<(u32, u32)>> = rock_pockets(&reference)
            .into_iter()
            .filter(|p| p.len() >= SOURCE_B_MIN_POCKET)
            .collect();
        manual.shuffle(&mut eligible);
        let mut expected = Vec::new();
        for pocket in eligible.iter().take(SOURCE_B_COUNT) {
            let index = manual.gen_range(0, pocket.len() as u32) as usize;
            let (x, y) = pocket[index];
            let item_index = manual.weighted_index(&SpawnWeights::Hidden.table()).unwrap();
            expected.push((x, y, ItemId::ALL[item_index]));
        }
        assert_eq!(manual.next_u64(), after, "place_hidden used a different draw count");
        assert_eq!(placed, expected, "place_hidden drew tile-then-item differently");
    }
}

/// T3.4 supply-crate tests.
///
/// Named `supply_crate_tests` so T3.4's Test command,
/// `cargo test -p game-core crate`, selects them (D27). A module literally
/// named `crate` is impossible — it is a Rust keyword.
#[cfg(test)]
mod supply_crate_tests {
    use super::*;
    use crate::map::Scale;
    use crate::player::DT;

    fn drop_crate(seed: u64) -> (Map, Crate, ItemIdCounter) {
        let map = Map::generate(seed, Scale::Small);
        let mut rng = GameRng::new(seed);
        let mut ids = ItemIdCounter::default();
        let c = spawn_crate(&map, &mut rng, &mut ids);
        (map, c, ids)
    }

    fn fall_until_landed(c: &mut Crate, map: &Map) -> u64 {
        for tick in 0..1000u64 {
            step_crate(c, map, tick, DT);
            if c.landed {
                return tick;
            }
        }
        panic!("crate never landed");
    }

    #[test]
    fn crate_lands_on_surface() {
        // docs/08 §1 (items row) + T3.4 step 4: "crate lands on the correct
        // surface row (deterministic x -> known surface)".
        for seed in 0..30u64 {
            let (map, mut c, _) = drop_crate(seed);
            let column = (c.x / TILE_SIZE) as u32;
            let expected_surface = map.surface_row(column);
            fall_until_landed(&mut c, &map);

            assert!(c.landed);
            assert_eq!(c.vy, 0.0, "a landed crate is still moving");
            assert_eq!(
                c.y,
                expected_surface as f32 * TILE_SIZE,
                "seed {seed}: crate rested at y={} but column {column}'s surface \
                 row is {expected_surface}",
                c.y,
            );
        }
    }

    #[test]
    fn crate_never_lands_inside_terrain() {
        // T3.4 Acceptance: "crate never lands inside terrain (y is always >=
        // surface)". At 200 px/s a tick covers 10 px of a 16 px tile, so an
        // unclamped fall would routinely stop below the surface.
        for seed in 0..50u64 {
            let (map, mut c, _) = drop_crate(seed);
            fall_until_landed(&mut c, &map);
            let column = (c.x / TILE_SIZE) as u32;
            let surface_y = map.surface_row(column) as f32 * TILE_SIZE;
            assert!(
                c.y <= surface_y + 1e-3,
                "seed {seed}: crate at y={} is below the surface {surface_y}",
                c.y,
            );
            // And it is actually resting ON something, not floating.
            assert!(
                map.is_solid_at_pixel(c.x, c.y + 1.0),
                "seed {seed}: crate is not resting on a solid tile",
            );
        }
    }

    #[test]
    fn crate_falls_at_the_documented_speed() {
        // T3.4 step 2: "fall at 200 px/s".
        let map = Map::generate(1, Scale::Small);
        let mut c = Crate {
            id: 0,
            x: 320.0,
            y: -20.0,
            vy: CRATE_FALL_SPEED,
            landed: false,
            content: [ItemId::Pistol, ItemId::Medkit],
            expires_tick: None,
        };
        let before = c.y;
        step_crate(&mut c, &map, 0, DT);
        assert!(
            (c.y - before - 10.0).abs() < 1e-3,
            "one tick moved the crate {} px, expected 10 (200 px/s * 0.05 s)",
            c.y - before,
        );
    }

    #[test]
    fn landing_sets_a_sixty_second_expiry() {
        // docs/04 §3 row C: "sits for 60 s".
        let (map, mut c, _) = drop_crate(3);
        let landed_tick = fall_until_landed(&mut c, &map);
        // 60 s at 20 Hz = 1200 ticks.
        assert_eq!(
            c.expires_tick,
            Some(landed_tick + 1200),
            "expiry should be 60 s (1200 ticks) after landing",
        );
    }

    #[test]
    fn opening_a_crate_yields_its_two_items() {
        // T3.4 step 3 + step 4: "pickup splits content".
        let (map, mut c, mut ids) = drop_crate(5);
        fall_until_landed(&mut c, &map);

        let items = open_crate(&c, &mut ids);
        assert_eq!(items.len(), 2, "a crate holds 2 items (docs/04 §3 row C)");
        assert_eq!(items[0].item, c.content[0]);
        assert_eq!(items[1].item, c.content[1]);
        for item in &items {
            assert_eq!(item.x, c.x, "items should drop at the crate position");
            assert_eq!(item.y, c.y);
            assert!(!item.is_crate, "opened contents are loose items");
            assert!(!item.hidden);
        }
        assert_ne!(items[0].id, items[1].id, "contents need distinct ids");
    }

    #[test]
    fn a_player_within_sixteen_pixels_reaches_a_landed_crate() {
        // docs/04 §3 row C: "until picked up by any player".
        let (map, mut c, _) = drop_crate(7);
        fall_until_landed(&mut c, &map);

        assert!(player_reaches_crate(&c, c.x, c.y), "a player on the crate");
        assert!(player_reaches_crate(&c, c.x + 15.0, c.y), "15 px away");
        assert!(!player_reaches_crate(&c, c.x + 17.0, c.y), "17 px is too far");
        assert!(!player_reaches_crate(&c, c.x, c.y + 40.0), "40 px below");
    }

    #[test]
    fn a_falling_crate_cannot_be_opened() {
        // Only a LANDED crate is pickable — otherwise a player standing under
        // the drop point collects it in mid-air.
        let (_, c, _) = drop_crate(9);
        assert!(!c.landed);
        assert!(
            !player_reaches_crate(&c, c.x, c.y),
            "a falling crate should not be reachable",
        );
    }

    #[test]
    fn a_landed_crate_does_not_move() {
        let (map, mut c, _) = drop_crate(11);
        fall_until_landed(&mut c, &map);
        let resting = (c.x, c.y);
        for tick in 0..100u64 {
            step_crate(&mut c, &map, tick, DT);
        }
        assert_eq!((c.x, c.y), resting, "a landed crate drifted");
    }

    #[test]
    fn crate_drop_schedule_matches_doc() {
        // docs/04 §3 row C: "every 45 s (t=45, 90, 135, 180, 225)".
        // Literals, not a computed sequence.
        assert_eq!(CRATE_DROP_TIMES_S, [45.0, 90.0, 135.0, 180.0, 225.0]);
        // All within the 240 s round (docs/05 §2).
        assert!(CRATE_DROP_TIMES_S.iter().all(|&t| t < 240.0));
    }

    #[test]
    fn crate_spawn_is_deterministic() {
        let draw = |seed: u64| {
            let map = Map::generate(seed, Scale::Small);
            let mut rng = GameRng::new(seed);
            let mut ids = ItemIdCounter::default();
            (0..5).map(|_| spawn_crate(&map, &mut rng, &mut ids)).collect::<Vec<_>>()
        };
        assert_eq!(draw(42), draw(42));
        assert_ne!(draw(1), draw(2));
    }

    #[test]
    fn crate_spawn_draws_column_then_two_contents() {
        // Draw order and count (docs/04 §6, D19).
        let map = Map::generate(5, Scale::Small);
        let mut probe = GameRng::new(5);
        let mut ids = ItemIdCounter::default();
        let c = spawn_crate(&map, &mut probe, &mut ids);
        let after = probe.next_u64();

        let mut manual = GameRng::new(5);
        let column = manual.gen_range(0, map.width);
        let a = manual.weighted_index(&SpawnWeights::Ground.table()).unwrap();
        let b = manual.weighted_index(&SpawnWeights::Ground.table()).unwrap();
        assert_eq!(manual.next_u64(), after, "spawn_crate used a different draw count");
        assert_eq!(c.x, (column as f32 + 0.5) * TILE_SIZE);
        assert_eq!(c.content, [ItemId::ALL[a], ItemId::ALL[b]], "contents drew differently");
    }

    #[test]
    fn crate_contents_use_the_ground_weight_table() {
        // docs/04 §3 row C: "Crate content: 2 weighted items (same weights as
        // A)". Row B (flashlight doubled) is for hidden items only.
        //
        // The draw-order test cannot catch this: weighted_index consumes one
        // draw from either table, so the RNG state matches. Found by injection,
        // same shape as the source-A gap in T3.2.
        let mut flashlights = 0usize;
        let mut total = 0usize;
        for seed in 0..400u64 {
            let map = Map::generate(seed, Scale::Small);
            let mut rng = GameRng::new(seed);
            let mut ids = ItemIdCounter::default();
            for _ in 0..3 {
                let c = spawn_crate(&map, &mut rng, &mut ids);
                for item in c.content {
                    total += 1;
                    if item == ItemId::Flashlight {
                        flashlights += 1;
                    }
                }
            }
        }
        let rate = flashlights as f32 / total as f32;
        // Ground: 10/130 = 0.077.  Hidden: 20/140 = 0.143.
        assert!(
            (0.055..0.100).contains(&rate),
            "crate flashlight rate {rate:.4} suggests the wrong weight table \
             (Ground = 0.077, Hidden = 0.143)",
        );
    }

    #[test]
    fn a_crate_holds_exactly_two_items() {
        // docs/04 §3 row C: "1 crate = 2 items". The array type enforces this
        // at compile time; asserted here so the requirement is visible in the
        // test output rather than only in a type signature.
        assert_eq!(CRATE_CONTENTS, 2);
        let (_, c, _) = drop_crate(1);
        assert_eq!(c.content.len(), 2);
    }

    #[test]
    fn crates_spawn_within_the_map() {
        for seed in 0..50u64 {
            let (map, c, _) = drop_crate(seed);
            let (w, _) = map.pixel_size();
            assert!(c.x >= 0.0 && c.x < w, "seed {seed}: crate x={} is off-map", c.x);
            assert_eq!(c.y, CRATE_SPAWN_Y, "crates start above the map");
        }
    }
}
