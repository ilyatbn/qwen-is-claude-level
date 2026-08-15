# 11 — Map destruction

Everything that damages terrain funnels through one small API. Weapons, meteors
and lava do not touch the mask directly; they call `carve`. That single choke
point is what makes destruction easy to replicate on clients, easy to record for
replays, and easy to test.

---

## 1. The API

```rust
pub struct CarveResult {
    pub pixels_removed: u32,
    pub dirty_chunks: SmallVec<[ChunkId; 16]>,
    pub revealed: SmallVec<[BuriedSlotId; 4]>,   // buried items exposed by this carve
}

impl Map {
    /// Clear a filled circle. Returns what changed. Bedrock and walls are never touched.
    pub fn carve_circle(&mut self, cx: i32, cy: i32, r: i32) -> CarveResult;

    /// Clear a thick line (drills, beams, lava channels). Implemented as a swept circle.
    pub fn carve_capsule(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, r: i32) -> CarveResult;

    /// Add solid rock back. Not used in v1 gameplay; exists for tests and future tools.
    pub fn fill_circle(&mut self, cx: i32, cy: i32, r: i32) -> CarveResult;
}
```

`carve_capsule` is not needed until M5 (lava vents). Implement it then, not before.

## 2. Rasterisation

Integer midpoint-circle span fill, not floating-point distance tests:

```
for dy in -r ..= r:
    y = cy + dy
    if y outside the carveable band: continue
    dx = isqrt(r*r - dy*dy)
    clear bits [cx-dx, cx+dx] on row y
```

Whole-word clearing for the interior of each span, masked writes for the two
partial words at the ends. Integer arithmetic throughout, so the result is
bit-identical on every platform — which is exactly what the client needs in order
to replay carves and match the server (`01-architecture.md`).

**Bedrock and walls are excluded by clamping the span**, not by testing per pixel:
rows `>= h - BEDROCK_H` are skipped entirely, and every span is clamped to
`[WALL_W, w - WALL_W)`. A rocket at the base of a wall therefore digs a
half-crater, which is the correct behaviour.

## 3. Maintaining the coarse grid

The coarse grid (`10-map-generation.md` §1.2) must stay exact — physics trusts it.
Rather than recount whole cells, count bits removed per touched cell during the
span fill and subtract:

```
for each 8-px-aligned segment of a cleared span:
    removed = popcount(old_bits & segment_mask)
    coarse[cell] -= removed
```

Invariant, asserted in debug builds: `coarse[cell] == popcount of that cell's 64
bits`, for every cell. A test does a few hundred random carves and then verifies
the whole grid from scratch.

## 4. Dirty chunks

`carve_circle` marks every chunk the circle's bounding box overlaps. The map owns
a `dirty: FixedBitSet` over chunk indices plus a small vec of ids for iteration.

Two independent consumers drain it:

- **the client renderer**, which re-bakes at most `CHUNK_REBAKE_BUDGET` chunks per
  frame so a large explosion cannot cause a frame spike;
- **nothing on the server** — the server does not render, and does not send dirty
  chunks. It sends the *carve events themselves*, which are far smaller.

So on the server the dirty set is only used by tests and by the PNG dump.

## 5. Revealing buried items

`MapMeta.buried_slots` holds points inside solid rock, each with an item rolled at
round start (`32-item-spawning.md`). After a carve, any slot whose centre is now
**air** becomes a real world pickup:

```
for slot in buried_slots where !slot.revealed:
    if carve circle contains slot.pos:
        slot.revealed = true
        result.revealed.push(slot.id)
```

The caller (the world step) turns each revealed id into a `WorldItem` and emits an
`item_spawn` event with `source: Buried`, which the client renders with a brief
sparkle so players learn that digging pays.

Checking every slot per carve is fine — there are at most 16 of them.

## 6. Ordering and replication

Carves are applied in a strict order on the server: within a tick, in the order the
events were generated, and ticks are processed in order. Each carve broadcast to
clients carries the tick it happened on and a per-round monotonic sequence number.

Clients apply carves in sequence order. Because rasterisation is integer-exact and
the order is fixed, every client's mask is bit-identical to the server's.

To catch any bug in that chain, the server hashes its mask every
`MASK_CHECKSUM_INTERVAL` (5 s) and sends the hash. A client whose hash differs
requests a full resync and reloads the mask. This should never fire; if it does,
it is a real bug and the log line carries the tick, the seed and both hashes.

## 7. What destruction deliberately does *not* do

- **No collapse.** Rock carved free of its support floats, exactly as in Worms.
  Simulating collapse would need per-tick connectivity analysis over a million
  pixels and would make the map unpredictable to replicate. Out of scope for v1.
- **No terrain regrowth.** Damage is permanent for the round.
- **No per-material dig resistance.** All rock carves identically. The seam for
  adding it is here: `carve_circle` would consult a material layer before clearing.

## 8. Testing

- Carving outside the map bounds is a no-op and does not panic.
- Carving the same circle twice: the second returns `pixels_removed == 0` and no
  dirty chunks (idempotent).
- A carve overlapping bedrock removes nothing below `h - BEDROCK_H`.
- A carve overlapping a wall removes nothing outside `[WALL_W, w - WALL_W)`.
- Coarse grid matches a from-scratch recount after 500 random carves.
- Dirty chunk set exactly equals the set of chunks whose bits actually changed.
- A carve covering a buried slot reveals it; a carve one pixel short does not.
- Radius 0 and radius 1 behave sensibly (a single pixel, and a plus-shape).

## 9. Future work

- Material layers with different dig resistance, per the seam in §7.
- `carve_polygon` for beam and laser weapons.
- Debris particles spawned from `pixels_removed` and the carve centre — a client
  cosmetic, needs no server support.
