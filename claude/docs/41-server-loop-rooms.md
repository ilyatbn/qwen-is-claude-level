# 41 — Server loop and rounds

The server is the authority on everything: positions, health, items, terrain, the
clock and the weather. Clients render and predict; they never decide.

`crates/game-server/`. Numbers in `02-constants.md`.

---

## 1. Concurrency model

**One tokio task per room, owning its `World` outright.** No `Mutex` on game state,
no `Arc<RwLock<World>>`, no shared mutable anything.

```
   socket handler task ──┐
   socket handler task ──┼──▶ mpsc<Command> ──▶ ┌──────────────┐
   socket handler task ──┘                      │  Room task   │
                                                │  60 Hz loop  │
   all sockets  ◀── SocketIo::to(room).emit() ──│  owns World  │
                                                └──────────────┘
```

Socket handlers are cheap: they parse a message into a `Command` and push it into
the channel. Everything else happens in the room task, single-threaded, in a
defined order. This makes the whole simulation trivially deterministic given the
same command sequence — which is what makes the replay system in
`61-logging-debug.md` possible at all.

```rust
enum Command {
    Join { socket: SocketRef, name: String, skin_id: u16, reply: oneshot::Sender<PlayerId> },
    Ready(PlayerId),
    Input(PlayerId, InputBatch),
    UseItem(PlayerId, u8),
    SelectSlot(PlayerId, u8),
    ToggleFlashlight(PlayerId),
    VoteRestart(PlayerId, bool),
    ResyncMap(PlayerId),
    Leave(PlayerId),
}
```

Outbound broadcasts go through the `SocketIo` handle, which is `Clone` and
thread-safe, so the room task emits directly.

## 2. The tick loop

```rust
let mut ticker = tokio::time::interval(Duration::from_secs_f64(1.0 / SIM_HZ));
ticker.set_missed_tick_behavior(MissedTickBehavior::Burst);
loop {
    ticker.tick().await;
    drain_commands(&mut rx, &mut world);   // 1
    world.step(SIM_DT);                    // 2
    flush_events(&io, &mut world);         // 3
    if tick % 3 == 0 { broadcast_snapshot(&io, &world); }   // 4
    maybe_send_checksum(&io, &world);      // 5
}
```

`MissedTickBehavior::Burst` matters: if the process is descheduled for 50 ms, the
loop catches up rather than silently running slow, so round time stays true to
wall-clock. If it ever falls more than 10 ticks behind, log at `warn` on
`game::sim` with the lag — that is the signal that the tick is too expensive.

### Fixed order inside a tick

Order is part of the contract, not an accident. It is:

1. **Drain commands** — apply joins/leaves, queue inputs (at most `MAX_INPUT_QUEUE`
   per player), apply item uses and slot selections.
2. **`world.step(dt)`**, itself strictly ordered:
   1. advance round time and the day/night cycle;
   2. apply player inputs (in ascending `PlayerId`, always — never `HashMap` order);
   3. integrate players;
   4. integrate projectiles, resolve their collisions and explosions;
   5. tick the weather scheduler and all active hazards;
   6. integrate world items and crates;
   7. resolve pickups (ascending `PlayerId`);
   8. apply damage-over-time, overheal decay, shield expiry;
   9. resolve deaths and respawns;
   10. despawn expired items and projectiles.
3. **Flush events** — the `Vec<GameEvent>` the world accumulated this tick.
4. **Snapshot** every 3rd tick (20 Hz).
5. **Checksum** every `MASK_CHECKSUM_INTERVAL`.

Iterating players in `PlayerId` order rather than hash order is a small discipline
that removes a genuinely nasty class of nondeterminism — two players reaching the
same item on the same tick must always resolve the same way, in a replay as in the
live round.

## 3. Round state machine

```
              lobby full, or the bot timeout expired (74 E2)
   ┌────────┐──────────────────────────────▶┌────────┐
   │ Lobby  │                               │ Warmup │  10 s
   └────────┘◀───── everyone left ──────────└────────┘
        ▲                                        │ map generated, items placed,
        │                                        │ players spawned, no damage
        │                                        ▼
   ┌────────┐   20 s vote window          ┌─────────┐
   │ Ended  │◀────────────────────────────│ Playing │  240 s
   └────────┘                             └─────────┘
        │  majority restart → new seed, scores reset, back to Warmup
        └──────────────────────────────────────────┘
```

| Phase | Duration | Behaviour |
|---|---|---|
| `Lobby` | — | Waiting to fill, or for `LOBBY_BOT_TIMEOUT` (`docs/74` §E2). **No world at all** (§E1). |
| `Warmup` | `WARMUP_SECONDS` (10) | Map generated and sent; players spawned and can move; **no damage, no weather, no item spawns**. Time to load and orient. |
| `Playing` | `ROUND_SECONDS` (240) | Everything live. Day/night runs. Weather rolls. |
| `Ended` | `ENDED_SECONDS` (20) | Sim frozen except rendering. Scoreboard shown, votes collected. |

`round_state` is broadcast on every phase change and once a second during `Playing`
so a client that missed a transition self-corrects.

### The restart vote

During `Ended`, each player sends `vote_restart { restart: bool }`. At the end of
the window:

- majority of connected players voted restart → new round on a **new seed**
  (`next_seed = hash(current_seed, round_number)`, so the sequence is itself
  reproducible), scores reset to 0, phase → `Warmup`;
- otherwise → `Lobby`, and clients show the quit/menu screen.

Non-voters count as abstentions, not as "no". A player who alt-tabs should not veto
the round.

## 4. Joining mid-round

Allowed, and it needs to be — a 4-minute round is long enough that waiting is worse.

A player joining during `Playing`:
- receives `welcome` and `map_init` reflecting the **current, already-damaged** map,
  not the pristine generated one;
- gets a full `inventory` (empty) and the current `score` table;
- spawns at the safest valid spawn point (`21-player-stats.md` §4) with
  `SPAWN_IFRAMES`;
- starts at score 0.

The room is capped at `MAX_PLAYERS` (6). A join beyond that gets
`join_error { reason: "full" }`.

## 5. Room configuration

From environment, read once at startup:

| Var | Default | Meaning |
|---|---|---|
| `BIND_ADDR` | `0.0.0.0:3000` | |
| `GAME_LOG` | `info` | `EnvFilter` string, e.g. `info,game::sim=debug` |
| `MAP_SCALE` | `medium` | `small` \| `medium` \| `large` |
| `ROUND_SECONDS` | `240` | overrides the constant, for testing |
| `MAX_PLAYERS` | `6` | |
| `FIXED_SEED` | unset | if set, every round uses this seed — invaluable for debugging |
| `RECORD_REPLAY` | `0` | write a replay file per round (`61-logging-debug.md`) |

`FIXED_SEED` is the one that gets used most: "reproduce the bug" becomes
`FIXED_SEED=8123491234 cargo run -p game-server`.

## 6. Health and observability

- `GET /healthz` → `200 OK` with `{ status, uptime_s, rooms, players }`.
- `GET /metrics` (v1: plain text, not Prometheus) → tick duration p50/p99, commands
  drained per tick, snapshot bytes sent, connected sockets.
- Every log line inside a room carries `room` and `tick` fields
  (`61-logging-debug.md`).

## 7. Shutdown

On `SIGTERM`/`SIGINT`: stop accepting connections, broadcast
`round_end { reason: "server_shutdown" }`, flush replay files, give sockets 2 s to
drain, then exit. Docker sends `SIGTERM` on `docker compose down`, so a clean path
here keeps replay files intact.

## 8. Testing

Integration tests in `crates/game-server/tests/`, using a real server on an
ephemeral port and the `rust_socketio` client:

- A client connects, joins, receives `welcome` then `map_init`, and decodes a mask
  whose dimensions match the requested scale.
- Six clients join; a seventh gets `join_error { reason: "full" }`.
- Sending inputs for 200 ticks yields ~66 snapshots (20 Hz), each the expected size.
- Two clients' masks hash identically after 100 random carves driven by real fire
  commands.
- The phase machine advances Lobby → Warmup → Playing → Ended on a shortened
  `ROUND_SECONDS=5`, with `round_state` emitted at each transition.
- No damage is applied during `Warmup`.
- A majority restart vote starts a new round with a different seed and zeroed scores.
- A client disconnecting mid-tick does not panic the room task and emits
  `player_leave`.
- Player iteration order is by id: two players contacting one item on the same tick
  always resolve to the same winner across 100 runs.

## 9. Future work

- **Multiple rooms**: a `RoomRegistry` of `room_id → mpsc::Sender<Command>`, and
  socket.io rooms for scoping broadcasts. The room task is already isolated, so this
  is additive.
- Matchmaking and a lobby browser.
- Session resume on reconnect.
- Redis pub/sub for a cross-process room directory, and sticky routing by room id —
  the commented services in `docker-compose.yml` are placed for this.
- Additional modes: the phase machine is shared; only scoring and spawn rules differ.
