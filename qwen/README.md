# Worms-style 2D Deathmatch ("WIP Game")

Real-time free-for-all deathmatch, up to 6 players, on randomly generated,
fully destructible Worms-style maps. Phaser 3 client, Rust server, socket.io
transport. Server-authoritative simulation.

## How this repo works (for AI agents)

This repo starts as **design docs + a task list. No game code yet.**
A small-context model executes the tasks one at a time.

Rules for the executing agent:
1. Pick the next uncompleted task from the task files in `tasks/` (in order).
2. Each task lists exactly which docs to read. Read only those sections.
3. Do the work, run the task's Test command, mark the task `[x]` in its file.
4. Do not start the next task until the current one is marked done.
5. If a task fails its test twice, stop and report the failure.

## Docs

| File | Contents |
|---|---|
| `docs/00-architecture.md` | Repo layout, tick model, data flow, ports, conventions |
| `docs/01-map.md` | Seeded map generation, scales, tiles, destruction |
| `docs/02-map-effects.md` | Weather, toxic rain, meteors, lava, fog, day/night |
| `docs/03-player.md` | Movement, jump, jetpack, aim, health, shield, FOV |
| `docs/04-items.md` | Item catalog, spawn sources, inventory, weapons |
| `docs/05-server.md` | Rooms, round flow, snapshots, logging, Docker |
| `docs/06-protocol.md` | All socket.io messages, field by field |
| `docs/07-sprites.md` | Asset structure, Kenney packs, skin system |
| `docs/08-testing.md` | Test strategy per module |

## Tasks (status legend: `[ ]` todo, `[x]` done)

| File | Phase | Tasks |
|---|---|---|
| `tasks/00-setup.md` | Scaffold | T0.1 – T0.3 |
| `tasks/01-map.md` | Map generation + destruction | T1.1 – T1.10 |
| `tasks/02-player.md` | Player movement + physics | T2.1 – T2.10 |
| `tasks/03-items.md` | Items, inventory, weapons | T3.1 – T3.9 |
| `tasks/04-rounds.md` | Rounds, effects, multiplayer | T4.1 – T4.10 |
| `tasks/05-sprites.md` | Assets, skins, ops | T5.1 – T5.5 |

## Stack (locked)

- **Server**: Rust workspace. `game-core` = pure simulation crate (no IO,
  no async). `server` = thin socket.io IO layer.
- **Physics**: `rapier2d` inside `game-core`, driven at a fixed 20 Hz tick.
- **Transport**: socket.io via `socketioxide`. Protocol in `docs/06-protocol.md`.
- **Client**: Phaser 3 + TypeScript + Vite. Sends inputs at 20 Hz,
  interpolates 10 Hz server snapshots.
- **Assets**: placeholder shapes first; Kenney packs fetched in T5.1.
- **Docker**: `docker-compose.yml` runs the server (T5.5). No DB in v1.

## How to run (after tasks are done)

```bash
# server (dev)
cd server && cargo run -- dev
# client (dev)
cd client && npm install && npm run dev
# open http://localhost:5173
```
