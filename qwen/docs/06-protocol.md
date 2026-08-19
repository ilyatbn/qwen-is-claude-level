# 06 — Protocol (socket.io messages)

Transport: socket.io (JSON). Namespace `/game`. All messages carry a
`tick` where relevant. Rust types in `game-core/src/protocol.rs` (serde),
TS mirror in `client/src/protocol.ts`. **When a task changes a message,
it updates BOTH files.**

Conventions:
- `u64` ticks, `f32` px/seconds, ids are u8 for players (0..=5).
- Positions in px, map top-left = (0,0), y down.
- Angles in radians, 0 = right, CCW positive (client converts for mouse).

## 1. Client → Server

| Event | Payload | Notes |
|---|---|---|
| `join_room` | `{ name: string }` | name 1–12 chars, trimmed; server sanitizes |
| `ready` | `{}` | lobby → ready flag |
| `select_skin` | `{ skin: u8 }` | lobby only |
| `input` | `InputFrame` (§3) | 20 Hz, latest-wins |
| `use_slot` | `{ slot: u8 }` | 0..=5 (also sent inside InputFrame.use_slot; this is the UI path) |
| `restart` | `{}` | RoundEnd: request new round (new seed) |
| `quit` | `{}` | leave room (lobby or round) |
| `set_log_level` | `{ level: string }` | "info" or "debug"; logged as warning |
| `ping` | `{}` | → server replies `pong` (T0.3) |

## 2. Server → Client

| Event | Payload | When |
|---|---|---|
| `joined` | `{ id: u8, room: u32, seed: u64, scale: string, map: MapData, players: [LobbyPlayer; ≤6] }` | on join |
| `player_joined` | `{ id: u8, name: string, skin: u8 }` | lobby |
| `player_left` | `{ id: u8 }` | any time |
| `lobby_state` | `{ players: [LobbyPlayer; ≤6], ready: [bool; 6], countdown_in_s: Option<f32> }` | on change |
| `round_started` | `{ seed: u64, scale: string, map: MapData, spawn: { x: f32, y: f32 } }` | round begin (map re-sent each round) |
| `snapshot` | `Snapshot` (§4) | 10 Hz during round |
| `tile_destroyed` | `{ tiles: [{x: u32, y: u32}]; version: u64; item_uncovered: Option<{item: string, x: f32, y: f32}> }` | immediate |
| `item_spawned` | `{ item: string, x: f32, y: f32, crate: bool }` | sources A–D |
| `item_picked` | `{ player: u8, item: string }` | |
| `crate_dropped` | `{ x: f32 }` | crate starts falling (client animates) |
| `projectile_fired` | `{ id: u32, owner: u8, kind: string, x: f32, y: f32, angle: f32 }` | client draws |
| `explosion` | `{ x: f32, y: f32, radius: f32 }` | visual only |
| `kill` | `{ victim: u8, killer: Option<u8>, weapon: string }` | killer null = weather/self |
| `respawned` | `{ player: u8, x: f32, y: f32 }` | |
| `effect_started` | `{ kind: string, data: EffectData }` | §5 |
| `effect_ended` | `{ kind: string }` | |
| `round_ended` | `{ scores: [{ id: u8, name: string, score: i32, kills: u32, deaths: u32 }] }` | |
| `pong` | `{}` | reply to ping |
| `error` | `{ code: string, msg: string }` | `room_full`, `bad_name`, `not_in_room`, ... |

`LobbyPlayer = { id: u8, name: string, skin: u8, ready: bool }`

## 3. InputFrame (client→server, 20 Hz)

```ts
{ tick: number, left: bool, right: bool, up: bool, down: bool,
  jump: bool, aim: number, fire: bool, use_slot: (number|null) }
```

- `jump`/`use_slot`: client sends the held/pressed state; server
  edge-triggers. `use_slot` is null except on the tick it's pressed.
- `aim`: radians from player center to mouse, CCW positive.
- Client sends the SAME frame every 50 ms until keys change (latest-wins
  on server).

## 4. Snapshot (server→client, 10 Hz)

```ts
{
  tick: number,
  round_time_s: number,          // elapsed
  day_phase: number,             // 0..1 (docs/02 §1)
  fog: { active: bool, remaining_s: number },
  effect: { kind: string, remaining_s: number, data: EffectData } | null,
  map_version: number,
  players: [PlayerSnap; 6],      // missing players: alive=false, x=y=0
  items: [{ item: string, x: number, y: number, crate: bool }],
  projectiles: [{ id: number, kind: string, x: number, y: number }],
}
PlayerSnap = {
  id: number, name: string, skin: number,
  x: number, y: number, facing: number,
  health: number, max_health: number,
  shield_remaining: number,
  jetpack_fuel: number,
  fov: number,
  alive: bool, respawn_in_s: number,
  score: number,
  slots: (string|null)[6], selected: number, ammo: number[6],
}
```

## 5. EffectData (per kind)

```ts
ToxicRain:    { spots: [{ x, y, remaining_s }] }
MeteorShower: { targets: [{ x, y, fired: bool }] }
LavaBurst:    { site: { x, y }, phase: "spew"|"fire" }
HeavyFog:     {}
```

## 6. MapData (sent on join + round_started)

```ts
{
  seed: number, scale: string,
  width: number, height: number,      // tiles
  tiles: string,                      // base64 of u8 array, width*height,
                                      //   0=AIR 1=GRASS 2=DIRT 3=STONE 4=ROCK
  decor: [{ x, y, kind: string }],
  spawns: [{ x, y }],                 // tile coords
}
```

## 7. Versioning

- Protocol version constant `PROTOCOL_VERSION = 1` in both protocol files.
- Server sends it in `joined`; client warns (console + toast) on mismatch.
