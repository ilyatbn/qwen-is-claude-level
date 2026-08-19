# 04 — Items (catalog, spawn, inventory, weapons)

Item logic in `game-core/src/items.rs`. All placement is seeded (round
RNG, after map generation, before round start — order in §6).

## 1. Item catalog (v1, data-driven)

```rust
pub struct ItemDef {
    pub id: ItemId,
    pub kind: ItemKind,      // Weapon | Health | Shield | Utility
    pub name: &'static str,
    pub max_stack: u8,       // 1 for all v1 items
    // weapon-only:
    pub ammo: Option<u8>,
    pub damage: Option<f32>,
    pub range: Option<f32>,      // px, projectile lifetime distance
    pub impact_radius: Option<f32>, // px, blast radius (0 = none)
    pub cooldown_s: Option<f32>,
    pub projectile_speed: Option<f32>, // px/s
    pub explosive: Option<bool>,
}
```

| Item | Kind | Ammo | Dmg | Range | Radius | Cooldown | Speed | Notes |
|---|---|---|---|---|---|---|---|---|
| Pistol | Weapon | 30 | 12 | 600 | 0 | 0.25 s | 700 | basic, non-explosive |
| Shotgun | Weapon | 12 | 7 ×5 pellets | 260 | 0 | 0.8 s | 600 | 5 pellets, ±8° spread |
| Rocket | Weapon | 6 | 60 | 900 | 48 | 1.0 s | 500 | explosive, destroys tiles |
| Grenade | Weapon | 4 | 45 | 400 (throw) | 40 | 1.2 s | 400 | arcs with gravity, bounces 1× |
| Medkit | Health | — | +50 hp | — | — | — | — | clamp to max_health |
| Overcharge | Health | — | max 150 / 10 s | — | — | — | — | docs/03 §6 |
| Shield Gen | Shield | — | 50% dmg red, 20 s | — | — | — | — | docs/03 §6 |
| Flashlight | Utility | — | FOV at night | — | — | — | — | active while in inventory slot 0? NO — see §5 |

Flashlight rule: once picked up it is **always on** for the holder (no
slot juggling in v1); it occupies 1 inventory slot and persists through
respawn.

## 2. Projectiles (server-simulated)

- Each projectile: `{ id, owner, pos, vel, kind, ttl, damage, radius }`.
- Stepped per tick: move, check tile collision (tile under new pos solid →
  impact), check player hit (circle vs player body 12 px radius → damage).
- Impact (explosive): `map.apply_blast(pos, radius, damage)` + player
  falloff damage (same as docs/01 §5 formula). Non-explosive: damage the
  hit player, disappear.
- Projectile hitting its owner: allowed (self-damage), no kill credit.
- Max 24 live projectiles per round (drop oldest if exceeded).

## 3. Item spawn sources (4)

| Source | When | Count (per round) |
|---|---|---|
| A. Initial ground | round start | 10 items |
| B. Hidden in rock | round start (in pockets) | 4 items |
| C. Supply crates | every 45 s (t=45, 90, 135, 180, 225) | 1 crate = 2 items |
| D. Timed random | every 30 s (t=30, 60, ...) | 1 item |

- **A**: pick 10 random surface tiles (RNG, ≥ 6 tile spacing), place item
  at tile center. Weighted pick: weapons 50% (pistol 30 / shotgun 20 /
  rocket 15 / grenade 15), medkit 20%, shield 10%, overcharge 10%,
  flashlight 10%.
- **B**: pick 4 rock pockets (RNG) that are ≥ 2 tiles; place one item in a
  random ROCK tile of the pocket (item hidden until that tile destroyed,
  docs/01 §5). Weights: same as A but flashlight 20%.
- **C**: crate falls from top of map at a random x (RNG), lands on the
  surface (simple drop until it hits a solid tile, then sits for 60 s or
  until picked up by any player → splits into its 2 items). Crate content:
  2 weighted items (same weights as A).
- **D**: 1 item appears at a random surface tile (same weights as A).
- All placements recorded in the round's item list; snapshot carries
  ground items: `[(item_id, x, y, crate: bool)]`.

## 4. Weapon firing rules (server)

- Player must have the weapon in inventory (equipped = selected slot).
- Cooldown per player per weapon (resets on respawn).
- Ammo decrements on fire; 0 ammo → weapon removed from inventory.
- Fire origin: player center, direction = aim angle.
- Shotgun: 5 pellets, angles `aim + [-8,-4,0,4,8]` degrees (fixed, no RNG —
  deterministic), each pellet damage 7, range 260.
- Grenade: initial vel = aim direction × 400 px/s, gravity applies,
  bounces once (restitution 0.4) on terrain, explodes after 1.5 s or on
  second touch.

## 5. Inventory

- 6 slots, each holds 1 item (v1: no stacking).
- Pickup: walking over a ground item (16 px radius) auto-picks it up IF a
  slot is free; else the item stays (no swap in v1).
- Selection: client sends `use_slot` (keys 1–6 also map to slots).
  Selecting a weapon slot equips it; selecting a consumable slot USES it
  (medkit/overcharge/shield) immediately; flashlight is passive.
- Right-click opens the inventory UI (client, T3.9): shows 6 slots, item
  names, ammo counts; click slot = same as `use_slot`.
- Respawn: inventory KEPT (docs/03 §2).
- Snapshot carries per player: `slots: [Option<ItemId>; 6]`,
  `selected: u8`, `ammo: [u8; 6]`.

## 6. Determinism order (round start)

```
1. Map::generate(seed, scale)
2. Shuffle spawns (RNG)
3. Build effect schedule (docs/02 §8)
4. Place source-A items (RNG)
5. Place source-B hidden items (RNG)
6. (C and D are scheduled by round timer, RNG draws happen at their ticks)
```
