# 30 — Items and inventory

Items are the reason to move. Everything you can carry — weapons, healing, the
shield generator, the flashlight — goes through one registry and one inventory.

Numbers in `02-constants.md`. Spawning is in `32-item-spawning.md`; weapon
behaviour is in `31-weapons-combat.md`.

---

## 1. The registry

A static table in `game-core/src/items/registry.rs`. A Rust table, not a data file:
v1 has 6 items, and a compile-time table means typos are compile errors and no
parser is needed. The seam for moving to RON/JSON is `ItemDef` itself — nothing
outside the registry knows where the data came from.

```rust
pub struct ItemDef {
    pub id: ItemId,               // u16, stable, never reused
    pub key: &'static str,        // "bazooka" — used for sprites and logs
    pub name: &'static str,       // "Bazooka" — shown in the UI
    pub kind: ItemKind,
    pub max_stack: u8,
    pub sprite: &'static str,     // atlas frame key
    pub spawn_weight: u16,        // 0 = never spawns randomly
    pub crate_weight: u16,        // weight inside supply crates
    pub buried_weight: u16,       // weight when buried in terrain
}

pub enum ItemKind {
    Weapon(WeaponId),
    Heal { amount: f32 },
    Shield { duration: f32 },
    Utility(UtilityId),           // Flashlight
}
```

### v1 items

| key | kind | stack | spawn | crate | buried | Effect |
|---|---|---|---|---|---|---|
| `medkit` | Heal 50 | 3 | 30 | 25 | 20 | +50 health, up to `HEALTH_CAP` |
| `shield_generator` | Shield 20 s | 2 | 12 | 18 | 15 | Halves incoming damage for 20 s |
| `flashlight` | Utility | 1 | 8 | 12 | 25 | Toggleable cone of light at night |
| `bazooka` | Weapon | 4 | 22 | 20 | 15 | Arcing rocket, 45 dmg, 42 blast |
| `grenade` | Weapon | 3 | 20 | 15 | 15 | Bouncing, 3 s fuse, 40 dmg, 36 blast |
| `smg` | Weapon | 60 | 8 | 10 | 10 | Hitscan, 8 dmg/shot, digs slightly |

`flashlight` is weighted highest in **buried** slots on purpose: the item you need
most at night is the one you have to dig for.

Weapon stack counts are ammo. Picking up a second bazooka gives you 8 rockets in
one slot, not two slots.

## 2. The inventory

```rust
pub struct Inventory {
    slots: [Option<Stack>; INVENTORY_SLOTS],   // 8
}
pub struct Stack { pub item: ItemId, pub count: u8 }
```

Rules:

- Picking up merges into an existing stack of the same item if there is room, up to
  the item's `max_stack`; otherwise it takes the first free slot.
- If every slot is full and no stack has room, the pickup is refused — the world
  item stays on the ground and the client shows "Inventory full".
- `selected_slot` is what firing and using act on. Selected with `1`–`8`, the mouse
  wheel, or by clicking in the inventory panel.
- A stack that reaches 0 clears its slot, and selection moves to the next
  non-empty slot (or none).
- On death the whole inventory is dropped as world items and cleared
  (`21-player-stats.md` §4).

Eight slots for six item types is deliberately generous: the pressure in this game
comes from ammo counts and from having to *find* things, not from managing space.

## 3. The inventory UI

**Right-click toggles the panel** — the brief's requirement. It is a client-side
overlay; opening it sends nothing to the server and does **not** pause anything.
The round keeps running while it is open, so browsing your inventory in the open is
a real risk.

- A 4×2 grid of slots at the bottom centre, each showing the item sprite, its count,
  and its hotkey number.
- The selected slot is highlighted.
- Click a slot to select it. Click a consumable to use it immediately.
- `Esc` or another right-click closes it.
- A permanently visible compact HUD strip shows the selected item and its count, so
  the panel is only needed to change loadout.

Suppress the browser context menu on the canvas.

## 4. Using items

Two verbs, and the distinction matters:

| | Trigger | Applies to | Message |
|---|---|---|---|
| **Fire** | Left mouse button | Weapons | `fire { seq, aim }` |
| **Use** | `E`, or click in the panel | Heal, Shield, Utility | `use_item { slot }` |

Both are **server-authoritative**. The client predicts nothing about item use — it
plays the animation optimistically at most, and the server's response is the truth.

Server validation on every use or fire, in order:
1. The player is alive.
2. The slot index is in range and the slot is non-empty.
3. The item's kind matches the verb (you cannot `use` a bazooka or `fire` a medkit).
4. The weapon's cooldown has elapsed.
5. Ammo/count > 0.

Any failure is ignored and logged at `debug` on target `game::items`. It is never
an error to the client — a rejected input is normal under lag.

On success: decrement the stack, apply the effect, broadcast the resulting event
(`item_used`, or a projectile spawn).

- **Heal** applies immediately, clamped to `HEALTH_CAP`.
- **Shield** sets `shield_until` (replacing, not stacking — `21-player-stats.md` §2).
- **Flashlight** is the exception: it is a *toggle*, not consumed. Using it flips
  `flashlight_on` and the stack is untouched.

## 5. World items and pickup

```rust
pub struct WorldItem {
    pub id: WorldItemId,
    pub item: ItemId,
    pub count: u8,
    pub pos: Vec2,
    pub vel: Vec2,           // non-zero for falling crates and death drops
    pub grounded: bool,
    pub spawned_at: f32,
    pub source: SpawnSource, // Initial | Periodic | Crate | Buried | Death
}
```

- World items fall under gravity and collide with the mask using the same
  sub-stepped resolver as players (`20-player-movement.md` §2), so an item dropped
  over a hole falls into it.
- Pickup is **automatic on contact**: any living player whose centre comes within
  `PICKUP_RADIUS` (20) picks it up, if the inventory has room.
- Pickup is resolved server-side, in player-id order within a tick, so two players
  arriving on the same tick cannot both get it.
- Items despawn after `WORLD_ITEM_TTL` (90 s). If the world exceeds
  `MAX_WORLD_ITEMS` (40), the oldest non-crate item despawns first.

Client shows a gentle bob and glow, plus a floating label at close range.

## 6. Replication

- `item_spawn { world_item_id, item_id, count, x, y, source }`
- `item_pickup { world_item_id, player_id }`
- `item_despawn { world_item_id }`
- `inventory` — sent **only to the owning player**, on every change: the full 8-slot
  array. It is tiny (16 bytes) and sending the whole thing removes an entire class
  of desync bug.
- Other players' inventories are never sent. What weapon someone is holding is
  visible from their sprite, which is deliberately imperfect information.

## 7. Testing

- Merging: picking up 2 grenades then 2 more gives one stack of 3 and one of 1
  (`max_stack` 3), not a stack of 4.
- A full inventory refuses a pickup and leaves the world item in place.
- Using the last item in a stack clears the slot and moves selection.
- `fire` on a medkit slot is rejected; `use_item` on a bazooka slot is rejected.
- Firing with 0 ammo is rejected and does not spawn a projectile.
- Firing inside the cooldown is rejected.
- Two players contacting the same item on the same tick: exactly one gets it.
- Death drops every stack; a player with 3 stacks produces 3 world items.
- The flashlight toggle does not consume the item.
- Registry integrity: ids are unique, every `key` is unique, every sprite key is
  non-empty, and every weapon `ItemKind::Weapon(id)` resolves in the weapon table.
- Item TTL despawn fires at 90 s and not before.

## 8. Future work

- Item rarity tiers driving spawn weight and crate contents.
- Throwable utilities (flares, mines) — a new `ItemKind` plus a projectile type.
- Dropping a selected stack manually (`G`).
- Weapon-specific ammo pickups, separate from the weapon itself.
- Moving the registry to a data file once the item count justifies it.
