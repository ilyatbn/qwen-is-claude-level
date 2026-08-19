# Phase 3 — Items, inventory, weapons

State after this phase: items exist (catalog from doc), all 4 spawn
sources place them, players pick up / store / use them, weapons fire
projectiles that damage players AND destroy tiles, inventory UI works.

Read `docs/04-items.md` in full before starting this file.

---

## T3.1 — Data-driven item catalog [x]

**Goal**: `ItemDef` table exactly matching docs/04 §1.
**Read**: `docs/04-items.md` §1.
**Files**: `server/game-core/src/items.rs`
**Steps**:
1. `ItemId` enum: Pistol, Shotgun, Rocket, Grenade, Medkit, Overcharge,
   ShieldGen, Flashlight (serde names: "pistol", ...).
2. `ItemDef` per doc §1; `CATALOG: [ItemDef; 8]` with the exact numbers
   from the table.
3. Weighted pick: `pick_item(rng, weights: SpawnWeights)` where
   SpawnWeights = A (base) / B (hidden, flashlight 20%) per doc §3.
4. Test `catalog_ammo_matches_doc`: assert every field of every def
   against the doc table (this test IS the doc check).
**Acceptance**: test fails if anyone changes a number without updating
  the doc.
**Test**: `cd server && cargo test -p game-core catalog`

---

## T3.2 — Source A: initial ground placement [x]

**Goal**: 10 items on surface tiles at round start, seeded.
**Read**: `docs/04-items.md` §3 (row A), §6.
**Files**: `server/game-core/src/items.rs`
**Steps**:
1. `GroundItem { id: u32, item: ItemId, x, y, crate: bool, hidden: bool }`.
2. `place_initial(map, rng) -> Vec<GroundItem>`: 10 surface tiles, ≥6 tile
   spacing (Chebyshev), weighted pick A.
3. Store in round state (round.rs stub: `round.items: Vec<GroundItem>`).
4. Test `placement_a_deterministic`: same seed → same 10 positions;
   spacing ≥ 6 for all pairs; all on GRASS tiles.
**Acceptance**: no two items on the same tile.
**Test**: `cd server && cargo test -p game-core items::initial`

---

## T3.3 — Source B: hidden items in rock [x]

**Goal**: 4 items hidden in rock pockets, uncovered on tile destruction.
**Read**: `docs/04-items.md` §3 (row B), `docs/01-map.md` §5 (hidden items).
**Files**: `server/game-core/src/items.rs`, `server/game-core/src/tiles.rs`
  (Tile gets `item: Option<ItemId>`), `server/game-core/src/map.rs`
  (destroy path emits the item)
**Steps**:
1. `place_hidden(map, rng)`: pick 4 distinct rock pockets (connected ROCK
   components), place 1 item (weights B) in a random ROCK tile of each;
   store on the tile.
2. `destroy_tile`/`apply_blast`: when a tile with an item is destroyed,
   spawn `GroundItem { hidden: false }` at tile center (pickable) and set
   `TileDestroyed.item = Some(...)`.
3. Weather destruction (lava, T4.6) passes `skip_items: true` — add the
   flag to `apply_blast` now (default false).
4. Test `hidden_items_in_rock_tiles`: all 4 items sit in ROCK tiles;
   destroying that exact tile spawns the item; destroying a neighbor does
   not.
**Acceptance**: an item can be uncovered by ANY blast (weapon or meteor).
**Test**: `cd server && cargo test -p game-core items::hidden`

---

## T3.4 — Source C: supply crates [x]

**Goal**: crate every 45 s falls from sky, lands, splits into 2 items.
**Read**: `docs/04-items.md` §3 (row C).
**Files**: `server/game-core/src/items.rs`, `server/game-core/src/round.rs`
  (timer: at ticks for t=45,90,...,225 s)
**Steps**:
1. `Crate { x, y, vy, landed, content: [ItemId; 2], expires_tick }`.
2. Spawn at random x, y = -20 (above map), fall at 200 px/s until the
   tile under it is solid → landed, sits 60 s.
3. Any player within 16 px of a landed crate → crate removed, its 2 items
   become GroundItems at crate pos, `item_spawned` events ×2.
4. Test: crate lands on the correct surface row (deterministic x → known
   surface); expiry removes it; pickup splits content.
**Acceptance**: crate never lands inside terrain (y is always ≥ surface).
**Test**: `cd server && cargo test -p game-core crate`

---

## T3.5 — Source D: timed random appearances [x]

**Goal**: 1 item every 30 s at a random surface tile.
**Read**: `docs/04-items.md` §3 (row D).
**Files**: `server/game-core/src/items.rs`, `server/game-core/src/round.rs`
**Steps**:
1. At t=30,60,...,240 s (skip if ≥ 240): spawn 1 item (weights A) at a
   random surface tile (RNG at the tick — deterministic given seed+inputs).
2. Test: over a full 240 s scripted round, exactly 7 source-D items
   spawned at the expected ticks (t=30..210).
**Acceptance**: items appear at ground level (not in the sky, not buried).
**Test**: `cd server && cargo test -p game-core items::timed`

---

## T3.6 — Pickup + 6-slot inventory [x]

**Goal**: auto-pickup with free-slot rule; inventory state in Player.
**Read**: `docs/04-items.md` §5.
**Files**: `server/game-core/src/items.rs`, `server/game-core/src/player.rs`
**Steps**:
1. `Inventory { slots: [Option<ItemId>; 6], selected: u8 }` in Player.
2. Pickup: player center within 16 px of a GroundItem → if any slot free:
   fill first free slot, remove item, emit `item_picked`. Else: item
   stays.
3. Flashlight special: picking one while already holding one → no-op
   (max 1, it's unique per player).
4. Respawn keeps inventory (assert in T4.3's test; here just don't clear
   it in the respawn path stub).
5. Tests: `pickup_requires_free_slot`, `pickup_full_inventory_leaves_item`,
   flashlight uniqueness.
**Acceptance**: 6 items picked → 7th stays on the ground.
**Test**: `cd server && cargo test -p game-core inventory`

---

## T3.7 — Item use (consumables + equip) [ ]

**Goal**: using slots applies effects; weapons equip.
**Read**: `docs/04-items.md` §5, `docs/03-player.md` §6.
**Files**: `server/game-core/src/items.rs`, `server/game-core/src/player.rs`
**Steps**:
1. `use_slot(player, slot, now)`:
   - weapon slot → `selected = slot` (equip).
   - Medkit → health += 50, clamp max_health; remove item.
   - Overcharge → max_health = 150, health = 150, 10 s timer (store
     `overcharge_until`), remove item; on expiry max_health → 100,
     health = min(health, 100).
   - ShieldGen → shield 20 s (refresh if active), remove item.
   - Flashlight → passive, selecting does nothing (always on while held).
2. Timers tick in round.step (overcharge expiry, shield expiry).
3. Tests: heal clamps; overcharge expiry clamps health to 100 (no damage);
   shield refresh; equip switches selected slot.
**Acceptance**: using a slot with no item is a no-op (no crash, no log spam).
**Test**: `cd server && cargo test -p game-core use_item`

---

## T3.8 — Weapon fire + projectiles + damage [ ]

**Goal**: fire validation, projectile stepping, player + tile damage.
**Read**: `docs/04-items.md` §2, §4, `docs/03-player.md` §6, §8.
**Files**: `server/game-core/src/items.rs` (projectiles),
  `server/game-core/src/player.rs` (apply_damage), `server/game-core/src/round.rs`
  (fire handling in step)
**Steps**:
1. Fire rule: selected slot is a weapon, ammo > 0, cooldown elapsed →
   spawn projectile(s) from player center along `facing`; decrement ammo;
   ammo 0 → remove weapon from slot.
2. Cooldowns per weapon (doc §1 table); shotgun = 5 pellets at fixed
   ±8/±4/0 degrees (no RNG).
3. Projectile step per tick: move by vel*dt; grenade: gravity + 1 bounce
   (restitution 0.4) + 1.5 s fuse; others: straight.
4. Collisions: tile under new pos solid → impact; player circle (12 px)
   overlap → damage. Impact: explosive → `map.apply_blast` + player
   falloff; non-explosive → damage hit player only.
5. `apply_damage(player, dmg, source)`: shield ×0.5, health −, death
   pipeline (score/kill event/respawn timer) per docs/03 §6.
6. Max 24 live projectiles (drop oldest).
7. Tests: `weapon_cooldown_respected` (2 fires 0.2 s apart with pistol →
   only 1 shot); `shotgun_5_pellets_fixed_spread`; `grenade_bounces_once_
   then_explodes`; `ammo_depletes_and_weapon_removed`; `damage_pipeline_
   shield_halves`; self-damage allowed, no kill credit to self.
**Acceptance**: a rocket destroys a 48 px radius of tiles (assert tile
  count in a test map) AND damages a player at 30 px with falloff.
**Test**: `cd server && cargo test -p game-core projectile && cargo test -p game-core damage`

---

## T3.9 — Inventory UI + ammo HUD [ ]

**Goal**: right-click inventory panel; keys 1–6; HUD shows health/shield/
jetpack/ammo.
**Read**: `docs/04-items.md` §5, `docs/07-sprites.md` §5.
**Files**: `client/src/hud/InventoryUi.ts`, `client/src/hud/Hud.ts`,
  `client/src/scenes/GameScene.ts`
**Steps**:
1. Right-click (or Tab) toggles a 6-slot panel (placeholder rects + item
   name + ammo count); click slot → send `use_slot`; pause? NO — game
   keeps running (real-time).
2. Keys 1–6 → `use_slot` directly.
3. HUD bar: health (green, width ∝ health/max_health), shield icon +
   seconds, jetpack fuel bar (5 s), selected weapon name + ammo.
4. All values from the latest snapshot (local player entry).
5. Vitest: panel slot→item mapping from a fixture snapshot.
**Acceptance**: picking up a medkit shows it in the panel; pressing its
  slot heals (visible in HUD) and the slot empties.
**Test**: `cd client && npm test && npm run build`
