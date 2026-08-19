# 32 — Item spawning

Four independent sources put items into the world, exactly as the brief asks: some
placed at the start, some appearing over time, some dropped from the sky, some
buried in the ground and only found by blowing it up.

All spawning is server-side and seeded from `substream(seed, "items")`. Numbers in
`02-constants.md`; item weights in `30-items-inventory.md` §1.

---

## 1. Weighted selection

One helper serves all four sources:

```rust
fn roll_item(rng: &mut ChaCha8Rng, table: WeightTable) -> ItemId
```

`WeightTable` selects which weight column to read — `spawn_weight`,
`crate_weight`, or `buried_weight`. Items with weight 0 in that column never appear
from that source. Three columns instead of one lets crates skew toward weapons and
buried slots skew toward the flashlight without needing separate tables.

Ammo/stack count per spawn is the item's `max_stack` for weapons (a full pickup),
and 1 for consumables.

## 2. Initial placement

At round start, after map generation and before players spawn:

- `INITIAL_ITEMS` items (8 / 14 / 20 by scale).
- Positions are drawn from `MapMeta.surface_points`, so every item starts **on the
  ground** and none are floating or embedded.
- Minimum separation of 96 px between initial items, and at least 64 px from any
  spawn point — nobody should start standing on a bazooka.
- Rejection sampling, capped at 200 attempts, then place wherever fits. On a very
  small or heavily-carved map this can under-place; log at `debug` if so.

Items are spread across the whole map rather than clustered, so the first thirty
seconds are a race outward instead of a scrum in the middle.

## 3. Periodic spawns

Every `ITEM_SPAWN_INTERVAL` (20 s) during `Playing`:

- Spawn `ITEM_SPAWN_BATCH` (1–2) items at random surface points.
- **Re-validate the surface point first.** The map has been under fire; a point from
  `MapMeta.surface_points` may now be mid-air. Re-run the surface test from
  `10-map-generation.md` §7a and resample on failure. Late-round maps have far fewer
  valid surfaces than the metadata claims, and skipping this drops items into the
  void.
- Prefer points at least 200 px from any living player, so spawns are something to
  travel to rather than a gift.
- Respect `MAX_WORLD_ITEMS` (40): if at cap, despawn the oldest non-crate item first.

Announced with `item_spawn { source: Periodic }`. The client shows a brief marker
at the map edge pointing toward it — visible to everyone, so periodic spawns create
contested points.

## 4. Supply crates

Every `CRATE_INTERVAL` (35 s) during `Playing`:

- Spawn a crate at a random x (at least 200 px from the walls) and `y = SKY_MARGIN / 2`.
- It falls as a physics body: `CRATE_W` × `CRATE_H` (24 × 24) AABB, gravity, light
  horizontal drag (`CRATE_DRAG`), colliding with the mask through the same
  sub-stepped resolver players use.
- On landing it becomes a normal `WorldItem` with `source: Crate`.
- Contents are rolled from `crate_weight` when the crate **spawns**, not when it
  lands — so the roll is deterministic against the tick it was created on, and a
  replay reproduces it exactly.
- Crates hold 1 item, at full stack for weapons.

A crate is loud and visible: a parachute sprite, a beacon light, and an announcement
event. It is meant to pull players together.

**Crates never despawn on TTL** while falling or grounded — they are the reward for
contesting, and having one time out mid-fight would be maddening. They are also
exempt from the `MAX_WORLD_ITEMS` eviction.

If a crate would land on a spot that gets carved out from under it, it simply keeps
falling. If it reaches bedrock it rests there.

## 5. Buried items

The most interesting source, and the one that ties items to destruction.

At map generation (`10-map-generation.md` §8), `BURIED_SLOTS` points (6 / 10 / 16 by
scale) are chosen inside solid rock:

- at least 24 px of solid in every direction, so they are genuinely buried;
- preferring positions near tunnels and sealed pockets, so a single well-placed
  rocket can expose one;
- minimum separation 128 px.

Each slot has an item rolled from `buried_weight` at round start. Slots are
**invisible** — they are not sent to clients and there is no surface hint. Digging
is speculative.

When any carve exposes a slot's centre (`11-map-destruction.md` §5), the slot
becomes a real `WorldItem` at that position with `source: Buried`, and an
`item_spawn` event fires. The client plays a distinct sparkle and sound so the
player learns the association immediately.

Because the flashlight is weighted highest in the buried column, "dig for the
flashlight before nightfall" becomes a real strategy without ever being stated in a
tutorial.

Unrevealed slots simply never appear. At round end, some items were never found —
that is fine and intended.

## 6. Death drops

Not one of the brief's four sources, but it is the fifth way items enter the world
(`21-player-stats.md` §4).

- On death, every inventory stack becomes a `WorldItem` at the death position.
- Each gets a small random outward velocity (60–140 px/s at a random upward angle)
  so the pile scatters instead of overlapping into one unreadable heap.
- Death drops use the normal `WORLD_ITEM_TTL` (90 s) and count toward
  `MAX_WORLD_ITEMS`.
- They are pickup-locked for 1.0 s so the killer cannot instantly hoover them up
  while the victim's corpse is still on screen — and so a player who dies to their
  own grenade does not get their loot back on respawn.

## 7. Determinism and replay

Every roll comes from the `"items"` sub-stream, in a fixed order: initial placement
first, then periodic and crate rolls in tick order. Given the same seed and the
same tick timeline, the same items appear in the same places.

Buried reveals depend on where players shoot, so they are not predictable — but
they *are* reproducible from a replay, because the replay reproduces the shots.

## 8. Testing

- Initial placement produces exactly `INITIAL_ITEMS` items, all on valid surface
  points, all at least 96 px apart and 64 px from spawns.
- The same seed produces the same initial layout, 100 times.
- Adding a weather effect (a different sub-stream) does not change the item layout.
- Weighted rolls converge to the expected distribution over 100 000 samples, within
  2 %.
- A periodic spawn on a fully-carved map resamples rather than placing in mid-air —
  test by carving every surface point in a region.
- A crate falls, collides with terrain, and comes to rest grounded.
- A crate's contents are fixed at spawn time, not at landing time.
- `MAX_WORLD_ITEMS` eviction removes the oldest non-crate item and never a crate.
- A buried slot is revealed by a carve that covers it and not by one that misses by
  a pixel.
- Buried slots are not present in any message sent to clients before reveal.
- Death drops produce one world item per stack, scattered, and are unpickupable for
  1.0 s.

## 9. Future work

- Spawn weighting biased toward the losing player's half of the map, as a soft
  catch-up mechanic.
- Rare "golden crates" with guaranteed high-value contents, announced with a longer
  telegraph.
- Buried caches — clusters of 3 items in one slot, as a reward for deep digging.
- Item spawn markers on a minimap.
