# 40 — Network protocol

Transport is socket.io: `socketioxide` 0.18 (protocol v5) on the server,
`socket.io-client` 4.x in the browser. All traffic is on the default namespace `/`.

Two encodings, chosen per message:

- **JSON** for anything low-frequency, structural, or that a human will want to read
  in a log: joins, item events, deaths, effects, round state.
- **Binary** (`ArrayBuffer` / `Bytes`) for the hot path: inputs, snapshots, and the
  map. socket.io transports binary attachments natively, so this needs no special
  parser on either side.

All binary is **little-endian**. All positions are `i16` pixels — the largest map is
4096 × 2048, so they fit with room to spare. All times on the wire are round-time
seconds as `f32`, or ticks as `u32`.

---

## 1. Connection lifecycle

```
  client                                server
    │  connect (socket.io handshake)      │
    ├────────────────────────────────────▶│
    │                                     │  assign PlayerId
    │  "join" {name, skin_id}             │
    ├────────────────────────────────────▶│
    │                                     │  validate, seat in room
    │  "welcome" {...}                    │
    │◀────────────────────────────────────┤
    │  "map_init" <binary>                │
    │◀────────────────────────────────────┤
    │                                     │  client decodes mask, builds chunks
    │  "ready"                            │
    ├────────────────────────────────────▶│
    │                                     │  player enters the sim
    │  "input" <binary> ~60 Hz            │  "snapshot" <binary> 20 Hz
    ├────────────────────────────────────▶│◀─── events (JSON), as they happen
```

A client that never sends `ready` is seated but never simulated, and is dropped
after 30 s.

## 2. Client → server

### `join` (JSON)
```json
{ "name": "string, 1-16 chars", "skin_id": 0 }
```
Rejected with `join_error { reason }` if the room is full or the name is invalid.

### `ready` (JSON, no payload)
Sent once the map is decoded and rendered. Gates entry into the sim.

### `input` (binary, ~60 Hz)

The hot path. Carries the last `INPUT_REDUNDANCY` (3) inputs so a dropped packet
costs nothing.

```
u8   count            (1..=INPUT_REDUNDANCY)
repeat count times:
  u32  seq            monotonic per client, never reused
  u16  aim            quantised angle (22-aiming-crosshair.md §2)
  u8   buttons        bit 0 left, 1 right, 2 up, 3 down,
                      bit 4 jump(space), 5 fire(LMB), 6 flashlight_held, 7 reserved
= 1 + count * 7 bytes         (22 bytes at count 3)
```

Buttons are **held state**, not edges. The server derives edges by comparing with
the previous accepted input for that player (`20-player-movement.md` §7), which is
why a lost packet is recoverable and why the format is stateless.

The server accepts a given `seq` once and ignores duplicates and any `seq` lower
than the last accepted. At most `MAX_INPUT_QUEUE` (8) inputs per player per tick are
processed; the rest are dropped and logged at `debug` on `game::net`.

### `use_item` (JSON)
```json
{ "slot": 0 }
```
### `select_slot` (JSON)
```json
{ "slot": 0 }
```
### `toggle_flashlight` (JSON, no payload)

### `vote_restart` (JSON)
```json
{ "restart": true }
```
Only accepted during the `Ended` phase.

### `resync_map` (JSON, no payload)
Requests a fresh `map_init`. Sent when a mask checksum mismatches (§5).
Rate-limited to once per 10 s per client.

## 3. Server → client

### `welcome` (JSON)
```json
{
  "player_id": 3,
  "tick": 1840,
  "round_time": 30.6,
  "phase": "playing",
  "sim_hz": 60,
  "snapshot_hz": 20,
  "players": [ { "id": 1, "name": "ana", "skin_id": 0, "score": 2 } ],
  "seed": 8123491234,
  "scale": "medium"
}
```

### `map_init` (binary, once per round)

```
u32  magic          0x4D415031  "MAP1"
u32  width
u32  height
u64  seed
u8   scale          0 small, 1 medium, 2 large
u8   theme
f32  wind
u16  spawn_count
  repeat: i16 x, i16 y
u16  decoration_count
  repeat: u16 kind, i16 x, i16 y, u8 flags
u32  rle_byte_len
  [rle payload]
```

**RLE encoding of the mask**: runs of equal bits, scanned row-major, starting with a
run of clear. Each run is a varint (LEB128) length in *pixels*. A run longer than
the varint's practical range is split. On typical maps this compresses 1 MiB to
roughly 20–60 KB, and socket.io's permessage-deflate takes another bite. Sent once
per round, so even the worst case is a non-issue.

Buried item slots are **not** included — see `32-item-spawning.md` §5.

### `snapshot` (binary, 20 Hz)

```
u32  tick
u16  round_time_ds      round time in deciseconds
u8   darkness           quantised: darkness * 255
u8   player_count
repeat player_count times:            // 14 bytes each, SNAPSHOT_PLAYER_BYTES
  u8   player_id
  i16  x
  i16  y
  i16  vx
  i16  vy
  u16  aim
  u8   health           0..=150, clamped to u8
  u8   flags            bit 0 alive, 1 grounded, 2 jetpack_active,
                        3 shield_active, 4 flashlight_on, 5 iframes, 6-7 reserved
  u8   jetpack_fuel     fuel / JETPACK_MAX_FUEL * 255
  u8   selected_item    ItemId low byte, 255 = none
u32  last_input_seq     the last input this client sent that the server processed
```

Six players: `9 + 6*14 + 4 = 97 bytes` per snapshot, 20 times a second — under
2 KB/s down per client. The velocity fields exist so the client can extrapolate
smoothly during a dropped snapshot.

`last_input_seq` is what makes reconciliation work (`42-netcode-prediction.md`).

### Event messages (JSON)

All carry the `tick` they occurred on, so the client can order them against
snapshots.

| Event | Payload |
|---|---|
| `player_join` | `{tick, id, name, skin_id}` |
| `player_leave` | `{tick, id, reason}` |
| `carve` | `{tick, seq, x, y, r, kind}` — `kind` is cosmetic only |
| `explosion` | `{tick, x, y, r, kind}` |
| `projectile_spawn` | `{tick, id, weapon, owner, x, y, vx, vy}` |
| `projectile_despawn` | `{tick, id, reason}` |
| `hitscan` | `{tick, owner, x0, y0, x1, y1, hit}` |
| `item_spawn` | `{tick, world_item_id, item_id, count, x, y, source}` |
| `item_pickup` | `{tick, world_item_id, player_id}` |
| `item_despawn` | `{tick, world_item_id}` |
| `crate_spawn` | `{tick, world_item_id, x, y}` |
| `inventory` | `{tick, slots: [{item, count}|null; 8], selected}` — **to the owner only** |
| `damage` | `{tick, victim, attacker, amount, cause}` — to the victim and the attacker only |
| `death` | `{tick, victim, attacker, cause}` — to everyone |
| `respawn` | `{tick, id, x, y}` |
| `score` | `{tick, scores: [{id, score}]}` |
| `effect_start` | `{tick, id, kind, phase, seed, duration}` |
| `effect_phase` | `{tick, id, phase}` |
| `effect_end` | `{tick, id}` |
| `hazard_spawn` | `{tick, id, kind, x, y, r, duration}` — puddles, meteors, jets |
| `phase_change` | `{tick, day_phase}` — day/night flip |
| `round_state` | `{tick, phase, time_left, seed, scale}` |
| `round_end` | `{tick, scores, next_seed}` |
| `mask_checksum` | `{tick, hash}` — every `MASK_CHECKSUM_INTERVAL` |

**`carve` is the important one.** Every terrain change on the server produces
exactly one `carve` event with a per-round monotonic `seq`. Clients apply carves in
`seq` order to their local mask (`11-map-destruction.md` §6). Explosions emit both
an `explosion` (cosmetic) and a `carve` (authoritative) — keeping them separate
means a client that misses the pretty flash still gets the terrain right.

## 4. Bandwidth budget

Per client, steady state:

| Direction | Traffic |
|---|---|
| Up | 22 bytes × 60 Hz ≈ **1.3 KB/s** |
| Down (snapshots) | 97 bytes × 20 Hz ≈ **1.9 KB/s** |
| Down (events) | bursty; a meteor shower peaks around 6 KB/s |
| Down (round start) | 20–60 KB once |

Comfortable. There is no need for delta compression, interest management or
bit-packing in v1, and adding them early would cost far more in bugs than in bytes.

## 5. Mask divergence

Every `MASK_CHECKSUM_INTERVAL` (5 s) the server sends `mask_checksum { tick, hash }`
(blake3 of the mask words, truncated to 8 bytes). The client hashes its own mask at
the same tick and compares.

On mismatch: log loudly with the tick, the seed and both hashes, then send
`resync_map`. The server replies with a fresh `map_init` and the client rebuilds
every chunk.

This should never fire. It exists because a silent one-pixel divergence would
otherwise show up hours later as "sometimes I get shot through a wall", and this
turns that into a single unambiguous log line.

## 6. Errors and disconnects

- Any malformed binary payload: drop the message, log at `warn` with the socket id
  and byte length, do not disconnect. A malformed message is more likely a version
  skew than an attack.
- A disconnect during `Playing` removes the player at the end of the current tick
  and broadcasts `player_leave`. Their score is kept for the scoreboard until the
  round ends.
- Reconnecting is treated as a fresh join; there is no session resume in v1.
- The client shows a "reconnecting" overlay and freezes remote interpolation rather
  than extrapolating indefinitely.

## 7. Testing

- Every binary codec round-trips: `decode(encode(x)) == x`, with property tests over
  random inputs.
- Snapshot size is exactly `9 + n*14 + 4` bytes for `n` players.
- RLE round-trips for: an empty mask, a full mask, a generated map at each scale, and
  a mask of alternating single pixels (the pathological case — assert it does not
  exceed a stated size bound).
- Out-of-order and duplicate `seq` inputs are ignored.
- More than `MAX_INPUT_QUEUE` inputs in a tick drops the excess and logs.
- An `inventory` event is never delivered to a player other than its owner.
- Angle quantisation round-trips within tolerance for a full sweep.
- A truncated binary payload is rejected without panicking — fuzz the decoders with
  random byte strings.

## 8. Future work

- Delta-compressed snapshots against the last acknowledged tick.
- Interest management: only send players within extended FoV (also closes the
  see-in-the-dark hole, `14-daynight-visibility.md` §8).
- Session resume on reconnect, keyed by a token in `welcome`.
- A protocol version in the handshake, with a clear mismatch error.
- Switching socketioxide to its `msgpack` feature if JSON event volume ever matters.
