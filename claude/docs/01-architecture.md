# 01 — Architecture

## The central idea

Map generation, terrain destruction, collision and player physics live in **one
Rust crate, `game-core`**, which is compiled twice:

- **natively**, and linked into `game-server` — this is the authority;
- **to WebAssembly**, and loaded by the browser client — this is the predictor.

The client therefore never reimplements physics. There is no "keep the TypeScript
version in sync with the Rust version" problem, because there is no TypeScript
version. A change to jump height is one edit to one constant in one file.

A useful side effect: `game-core` runs perfectly well with no server at all, so
milestones 1–3 produce a playable single-player browser sandbox before any
networking exists.

## Crates and folders

```
claude/
├── Cargo.toml                     workspace: game-core, game-server, game-wasm
├── crates/
│   ├── game-core/                 PURE. no tokio, no fs, no net, no ambient rng
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── constants.rs       mirrors docs/02-constants.md — the only place numbers live
│   │       ├── rng.rs             ChaCha8Rng helpers, sub-seed derivation
│   │       ├── map/               mask, coarse grid, noise, generator passes, carve, rle
│   │       ├── physics/           body, collision queries, movement resolve
│   │       ├── player/            state, stats, input application
│   │       ├── items/             registry, inventory, spawning, pickups
│   │       ├── weapons/           projectiles, hitscan, explosions
│   │       ├── effects/           weather scheduler and the four effects
│   │       └── world.rs           World: owns map + players + items + effects, steps once per tick
│   ├── game-server/               axum + socketioxide + tokio + tracing
│   │   └── src/
│   │       ├── main.rs            config from env, build router, serve
│   │       ├── room.rs            one room actor = one tokio task running the tick loop
│   │       ├── session.rs         per-socket state, join/leave
│   │       ├── codec.rs           binary encode/decode of snapshots, inputs, map init
│   │       ├── events.rs          socket.io event handler registration
│   │       └── replay.rs          record/replay of (seed, inputs) for debugging
│   └── game-wasm/                 wasm-bindgen shim; thin, no logic of its own
├── client/
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.ts                Phaser game config, scene registration
│       ├── core/                  generated wasm-pack output (gitignored) + a typed wrapper
│       ├── net/                   socket.io client, codec, prediction, interpolation
│       ├── render/                terrain chunks, lightmap, parallax, particles
│       ├── scenes/                Boot, Sandbox (M3), Game (M6), UI overlay
│       └── ui/                    inventory, HUD, scoreboard, debug panel
├── assets/
├── docker/
└── scripts/
```

## Data flow

```
        browser                                       server
  ┌──────────────────────┐                    ┌────────────────────────┐
  │ Phaser scene         │                    │  Room task (60 Hz)     │
  │   ▲             │    │   input (bin) ───▶ │    ▲            │      │
  │   │             ▼    │                    │    │            ▼      │
  │ render      game-core│                    │  inputs      game-core │
  │ (chunks,    (wasm)   │ ◀── snapshot (bin) │  mpsc        (native)  │
  │  lightmap)  predicts │      20 Hz         │              AUTHORITY │
  │             own body │                    │                        │
  │                      │ ◀── events (json)  │                        │
  └──────────────────────┘   carve, spawn,    └────────────────────────┘
                             death, effect
```

The server owns the truth. The client owns *presentation* plus a prediction of its
own body, corrected on every snapshot (`42-netcode-prediction.md`).

## What crosses the wire

- **Once per round:** the full terrain mask, RLE-compressed, as a binary blob, plus
  map metadata and the seed.
- **20 Hz:** a binary snapshot — every player's position, velocity, aim, health,
  shield and flags. About 14 bytes per player.
- **On change:** events — a carve, an explosion, an item spawned or picked up, a
  death, a weather effect starting, a day/night phase change.
- **Never:** the map is not re-sent. Clients apply the same `carve(cx, cy, r)`
  operations the server applied, in the same order, and end up with a
  bit-identical mask. A checksum every 5 seconds catches any divergence and
  triggers a resync.

## Determinism, and how far it needs to go

Full cross-platform floating-point determinism is **not** required, and not
attempted. It would be expensive (fixed-point maths everywhere) and it buys
nothing here, because:

- **The map** is generated only on the server and shipped as data. Clients never
  run the generator, so generator floats never need to match across platforms.
- **Terrain edits** are integer circle rasterisation — bit-exact everywhere by
  construction.
- **Player physics** is predicted with `f32`, and any drift is corrected by
  reconciliation within a frame or two.

What *is* required, and is testable: the generator must be deterministic **for a
given build on a given platform**, so that a seed reproduces a map in tests, in
replays, and in bug reports. That is guaranteed by using `ChaCha8Rng` exclusively
and never touching ambient randomness.

## Build pipeline

```
cargo build -p game-server            → native binary
wasm-pack build crates/game-wasm      → client/src/core/pkg/  (gitignored)
   --target web --out-dir ../../client/src/core/pkg
npm --prefix client run dev           → vite dev server, proxies /socket.io to :3000
```

`client/package.json` gets a `prebuild`/`predev` hook that runs `wasm-pack` so the
WASM is never stale. `scripts/check.sh` runs the whole gate.

## Library choices

| Need | Choice | Why |
|---|---|---|
| socket.io server | `socketioxide` 0.18 | Only mature Rust socket.io server; tower layer, drops straight into axum. Protocol v5 ↔ `socket.io-client` v4.x |
| HTTP / WS host | `axum` + `tokio` | `socketioxide` is built for it |
| Logging | `tracing` + `tracing-subscriber` | Structured fields, `EnvFilter` for per-target toggles |
| RNG | `rand` + `rand_chacha` | `ChaCha8Rng` is reproducible across versions; `StdRng` is not |
| Client engine | Phaser **3.90.0**, pinned | Last v3 release. Canvas/RenderTexture APIs this project depends on are heavily documented |
| Client transport | `socket.io-client` 4.x | Matches socketioxide's protocol v5 |
| Client build | Vite + TypeScript strict | Fast, first-class WASM support |
| Property tests | `proptest` | Sweeping map gen over thousands of seeds |
| Map dumps | `png` (dev-dependency, behind a feature) | Eyeball generated maps without a browser |

Deliberately **not** used: any Rust physics engine (Rapier and friends assume
polygon colliders; a pixel mask wants a custom sub-stepped resolver, which is
~200 lines and fully testable), and any ECS (six players does not need one).

## Threading model

One tokio task per room, owning its `World` outright — no locks on game state.
Socket handlers are separate tasks that push `(player_id, Input)` into an `mpsc`
channel the room drains at the top of each tick, and receive a broadcast handle to
send outbound frames. Scaling out means more room tasks, and eventually more
processes behind a router keyed by room id.

## Future work

- Multiple rooms: `RoomRegistry` mapping room id → channel handle. The room actor
  is already isolated, so this is additive.
- Horizontal scale: rooms are independent and hold no shared state, so a Redis
  pub/sub for room directory plus sticky routing is enough. `docker-compose.yml`
  keeps a commented Redis service for exactly this.
- Server-side visibility culling: filter the snapshot per recipient using the same
  FoV maths already in `game-core`.
