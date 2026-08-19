# 61 — Logging and debugging

The brief asks for enough debug logging that an AI agent can diagnose a problem
from a user's description. That is a specific requirement and it drives the design
here: logs must be **reproducible, structured, and toggleable per subsystem**, and
there must be a way to replay the exact situation the user saw.

---

## 1. Logging stack

`tracing` + `tracing-subscriber` with an `EnvFilter` read from `GAME_LOG`.

Targets, chosen so a filter can isolate one system:

| Target | Covers |
|---|---|
| `game::map` | Generation attempts, validation results, carve volume |
| `game::sim` | Tick timing, tick overruns, world step phases |
| `game::net` | Connects, joins, message rates, malformed payloads, dropped inputs |
| `game::player` | Spawns, deaths, damage, respawn point selection |
| `game::items` | Spawns, pickups, rejected uses, buried reveals |
| `game::weapons` | Fires, projectile lifetimes, explosions |
| `game::effects` | Effect scheduling, hazard spawns |
| `game::round` | Phase transitions, votes, scores |

Usage:

```sh
GAME_LOG=info                                   # normal
GAME_LOG=info,game::map=debug                   # debug map generation only
GAME_LOG=warn,game::net=trace                   # chase a protocol bug, quiet elsewhere
GAME_LOG=debug                                  # everything (loud)
```

## 2. Log discipline

**Every line inside a room carries `room` and `tick`.** Set once per room task via a
`tracing::span`, so it is automatic rather than remembered:

```
INFO game::round  room=0 tick=3600  phase transition warmup -> playing seed=8123491234
DEBUG game::items room=0 tick=3742  pickup player=2 item=bazooka count=4 world_item=17
WARN  game::sim   room=0 tick=5120  tick overrun budget_ms=16.7 actual_ms=41.2 lagging=3
```

Rules that make logs machine-readable, which is the point:

- One event per line, `key=value` fields, no multi-line dumps.
- Never log inside the per-pixel loops of map generation or carving — log the
  summary (`carve x=1024 y=512 r=42 removed=5541 chunks=2`).
- Levels mean something specific:
  - `error` — the round or connection cannot continue;
  - `warn` — recoverable but wrong (tick overrun, safe preset used, mask mismatch,
    malformed payload);
  - `info` — round-level milestones a human would want in a normal-verbosity log;
  - `debug` — per-event gameplay detail;
  - `trace` — per-tick firehose.
- Never log at `info` on a per-tick or per-input basis.

## 3. The lines that matter most

These exist specifically so a user's vague report maps onto something concrete:

| Symptom the user reports | Log line to look for |
|---|---|
| "the map was unplayable" | `game::map` generation summary: `attempts`, `traversable_fraction`, `used_safe_preset` |
| "I spawned inside a rock" | `game::player` respawn selection: chosen point, validity re-check, fallback used |
| "it felt laggy" | `game::sim` tick overruns; `game::net` snapshot cadence |
| "I got shot through a wall" | `mask_checksum` mismatch in `game::net`; carve `seq` gaps |
| "the item vanished" | `game::items` despawn: TTL vs `MAX_WORLD_ITEMS` eviction |
| "my rocket did nothing" | `game::weapons` fire rejection reason (ammo, cooldown, dead) |
| "the weather never fired" | `game::effects` schedule: next roll time and chosen kind |

Each of these is a deliberate log call, not an accident of verbosity.

## 4. The replay system — the most important debugging tool

Because the room task is single-threaded with a fixed command order
(`41-server-loop-rooms.md` §2), a round is **fully determined** by its seed plus the
ordered list of commands. So recording those reproduces the round exactly.

With `RECORD_REPLAY=1`, each round writes `replays/<timestamp>-<seed>.replay`:

```
header:  magic, version, seed, scale, sim_hz, round_seconds, player list
body:    repeated { tick: u32, command: Command }
footer:  final world state hash, final scores
```

Replay files are small — a 4-minute round with 6 players is a few hundred KB.

`cargo run -p game-server --bin replay -- replays/<file>` re-simulates headlessly at
full speed with no networking, and:

- compares the final world hash against the footer, printing a **divergence tick**
  if they differ — which is the fastest possible way to find a nondeterminism bug;
- accepts `--until <tick>` to stop at a point of interest;
- accepts `--dump-map <tick>` to write a PNG of the terrain at that tick;
- accepts `--trace <target>` to re-run with different log filters than the original
  session.

The workflow this enables: *"the map broke around two minutes in"* → run the replay
to tick 7200, dump the PNG, look at it. No guessing, no reproduction attempts.

`FIXED_SEED=<n>` makes a *fresh* round use a known seed, which covers the
map-generation half of the same problem.

## 5. Client-side debugging

- **`F3` — the debug HUD** (`42-netcode-prediction.md` §8): RTT, jitter, snapshot
  and input rates, pending-input depth, reconciliation rate and magnitude,
  interpolation buffer depth, mask checksum status, tick and clock offset.
- **`F4` — overlays**: collision boxes, coarse grid, chunk boundaries, surface
  points, FoV radius, light sources.
- **`?sandbox=1`** — the M3 sandbox scene (`60-testing.md` §5), with no server.
- **`?seed=<n>`** — in sandbox mode, generate a specific map.
- Client log level from `localStorage.gameLog`, with the same target names as the
  server, so both halves of a bug are filtered the same way.

## 6. Map dumps

`DEBUG_DUMP=1` on the server writes, at round start, to `debug/<seed>/`:

- `map.png` — the terrain, with spawn points and buried slots marked;
- `meta.json` — the full `MapMeta`;
- `surface.png` — the surface-point set and the traversal graph's largest component,
  which is the direct visual answer to "why did validation reject this?".

Off by default; it costs disk and a few hundred ms.

## 7. Metrics

`GET /metrics` returns plain text (not Prometheus format in v1):

```
uptime_s 1834
rooms 1
players 4
tick_p50_ms 1.2
tick_p99_ms 4.8
tick_overruns 3
snapshot_bytes_per_s 1940
commands_per_tick_avg 5.2
inputs_dropped 0
```

Enough to answer "is the server healthy" without wiring up an observability stack.

## 8. Reporting a bug

The template to ask a user for, and what each part unlocks:

1. **The seed** (shown on the HUD and in `welcome`) → reproduce the exact map.
2. **Roughly when** it happened → a tick to replay to.
3. **What they saw** → which target to turn up.
4. **The replay file**, if `RECORD_REPLAY` was on → everything.

With 1 and 2 alone, most map and physics bugs are reproducible in under a minute.

## 9. Testing

- The `EnvFilter` string from `GAME_LOG` is parsed at startup and an invalid value
  fails fast with a clear message rather than silently defaulting.
- Every room log line includes `room` and `tick` (assert against a captured
  subscriber in a test).
- A recorded replay re-simulates to the same final world hash — this is the
  determinism regression test from `60-testing.md` §4.
- A replay with a deliberately corrupted command is rejected with a clear error.
- `DEBUG_DUMP=1` writes all three files and does not slow the round loop (it runs
  before `Warmup` ends).
- No `info`-level line is emitted per tick during a 600-tick run.

## 10. Future work

- Structured JSON log output behind a flag, for log aggregation.
- Prometheus format on `/metrics`.
- Client-side replay: record snapshots and events, replay through the renderer to
  debug visual bugs.
- An in-game bug-report button that bundles seed, tick, HUD state and a screenshot.
