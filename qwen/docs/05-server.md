# 05 — Server (rooms, rounds, sync, logging, docker)

`server/` is a thin IO layer over `game-core`. It contains NO game logic —
every rule lives in `game-core` so it stays unit-testable without sockets.

## 1. Crate split (locked)

- `game-core`: pure. `Round::step(&mut self, tick, inputs) -> (Snapshot, Vec<Event>)`
  is the main entry. No async, no IO, no clock (tick number is the clock).
- `server`: socket.io via `socketioxide`, room management, the 20 Hz tick
  loop, input queue, snapshot/event broadcast, logging, docker.

## 2. Rooms & match flow

- Server hosts multiple rooms (each room = one match). v1: one room per
  server instance is enough, but the code is room-keyed (`RoomId = u32`)
  so scaling later is trivial.
- Room lifecycle:

```
Lobby (0..6 players, names+skins, ready)
  └─ all present players ready OR 6 players joined → 3 s countdown
Round (240 s = 4 min, fixed tick 20 Hz)
  └─ time up → RoundEnd (scores, 10 s)
       ├─ any player sends "restart" → new seed → new Lobby (same players)
       └─ players may send "quit" → removed; if room empty → room closed
```

- Join: client connects → `join_room { name }` → server assigns id 0..5,
  sends `joined { id, seed, map_scale, map_data }`.
- `map_data` = full tile grid (kinds only, no hp) + decor + spawns, sent
  once at round start (client renders terrain locally; destruction events
  update it). hp values stay server-side.
- Leave: `quit` or socket disconnect → player marked gone; if in round,
  their body is removed and they can't respawn.
- Max 6 players; 7th joiner gets `error { code: "room_full" }`.

## 3. Tick loop (server/src/tick.rs)

```
loop every 50 ms (tokio interval):
  for each room:
    inputs = drain input queue (latest frame per player)
    (snapshot, events) = room.round.step(tick, inputs)
    tick += 1
    if tick % 2 == 0: broadcast snapshot to room
    broadcast events immediately
    if round ended: switch room state → RoundEnd, broadcast
```

- Input queue: `net.rs` pushes `(player_id, InputFrame)` as they arrive;
  tick loop takes the LATEST frame per player (drops older).
- Snapshot cadence 10 Hz (every 2nd tick). Events: immediate.

## 4. Snapshot & events

- Exact shapes in `docs/06-protocol.md`. Snapshot is the FULL state
  (6 players × ~12 fields + items + effects) — small enough to send 10 Hz
  to 6 clients without compression.
- Events (immediate): `tile_destroyed`, `item_spawned`, `item_picked`,
  `crate_dropped`, `projectile_fired`, `explosion`, `kill`, `effect_started`,
  `effect_ended`, `round_started`, `round_ended`, `player_joined`,
  `player_left`, `respawned`.

## 5. Debug logging (for AI-agent debugging)

- `tracing` + `tracing-subscriber`, env `RUST_LOG` controls level
  (default `info`; dev: `wipgame=debug`).
- **Runtime toggle**: socket message `set_log_level { level }` (admin,
  v1: any connected client can send it; logged as a warning). Lets the
  user/agent flip to debug live without restart.
- Debug log points (each tagged `[tick=NNN room=ID]`):
  - every round state transition (lobby→countdown→round→end)
  - join/leave/quit with player id + name
  - every damage application: `[dmg] victim=P2 src=P1(rocket) 60→12`
  - every tile destruction batch: `[tiles] blast@(x,y) r=48 destroyed=14`
  - every effect start/end with seed-derived schedule index
  - input frames: NOT logged per-frame (too noisy); log only frame drops
    (`[input] P3 dropped 4 frames`) and aim/fire edges at debug.
  - snapshot size in bytes every 100 ticks (`[net] snap=1.2kB clients=4`)
- Logs go to stdout (docker captures). No log files in v1.
- Every log line includes `tick` and `room` so an agent can correlate a
  user-reported bug ("player 2 died at 2:14") to the exact tick.

## 6. Docker

- `Dockerfile`: multi-stage — build workspace (cargo build --release),
  copy binary into `debian:bookworm-slim`, expose 3001.
- `docker-compose.yml`:
  ```yaml
  services:
    game:
      build: .
      ports: ["3001:3001"]
      environment:
        - WIPGAME_PORT=3001
        - RUST_LOG=info        # set to wipgame=debug for agent debugging
      # redis:                # placeholder for v2 persistence
      #   image: redis:7
  ```
- No DB in v1 (state is in-memory per room).

## 7. Server entry (main.rs)

- Parse env: `WIPGAME_PORT` (default 3001), `WIPGAME_SEED` (optional u64
  dev override — if set, ALL rounds use this seed), `RUST_LOG`.
- Init tracing subscriber, start socket.io listener, spawn tick loop.
- Graceful shutdown on SIGINT: log active rooms, exit.
