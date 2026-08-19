# Phase 0 — Scaffold

State after this phase: Rust workspace (game-core + server) compiles and
`cargo test` passes; client (Phaser+TS+Vite) runs and shows a placeholder
scene; socket.io ping/pong works between them.

Format: each task = Goal / Read / Files / Steps / Acceptance / Test.
Do ONE task at a time. Mark `[x]` when its Test passes AND the full suite
still passes.

---

## T0.1 — Rust workspace skeleton [x]

**Goal**: workspace with `game-core` (pure) and `server` (thin) that compiles.
**Read**: `docs/00-architecture.md` §1, §7.
**Files**:
- create `server/Cargo.toml` (workspace: members `game-core`, `server`;
  workspace deps: `rand`, `rand_chacha`, `rapier2d`, `serde`, `serde_json`,
  `thiserror`, `tracing`, `tracing-subscriber`, `socketioxide`, `tokio`)
- create `server/game-core/Cargo.toml` (deps: rand, rand_chacha, rapier2d,
  serde, thiserror — NO async/IO crates)
- create `server/game-core/src/lib.rs` (`pub mod rng; pub mod map; ...`
  stubs for: rng, map, tiles, physics, player, items, effects, round,
  protocol — each file exists with an empty `pub` item so it compiles)
- create `server/server/Cargo.toml` + `src/main.rs` (prints "wipgame
  server starting" and exits)
**Steps**:
1. `cargo init` the workspace per docs/00 §1 layout.
2. Add workspace deps in root Cargo.toml `[workspace.dependencies]`.
3. Create the 9 module files in game-core with minimal stubs.
4. `cargo build` in `server/`.
**Acceptance**: `cargo build` exits 0; no warnings about unused crates
  (allow unused for now is fine).
**Test**: `cd server && cargo build && cargo test`

---

## T0.2 — Protocol types (Rust + TS) [x]

**Goal**: shared message types exist in both languages, in sync.
**Read**: `docs/06-protocol.md` (all), `docs/00-architecture.md` §7.
**Files**:
- modify `server/game-core/src/protocol.rs` (full types per doc §1–§6:
  InputFrame, MapData, Snapshot, PlayerSnap, EffectData, all client→server
  and server→client payloads; `PROTOCOL_VERSION: u8 = 1`)
- create `client/package.json` (phaser ^3.80, socket.io-client, typescript,
  vite, vitest, tsx; scripts: dev, build, test)
- create `client/tsconfig.json` (strict), `client/vite.config.ts`
- create `client/src/protocol.ts` (TS mirror of every type +
  `PROTOCOL_VERSION = 1`)
- create `client/src/main.ts` + `client/index.html` (Phaser boots a single
  `BootScene` that fills the screen with a dark color and logs
  "client ready" to console)
**Steps**:
1. Write Rust serde types exactly matching the doc field names.
2. `npm install` in client.
3. Write the TS mirror; add one Vitest test asserting
   `PROTOCOL_VERSION === 1` and that a fixture snapshot object parses.
4. `npm run dev` boots the placeholder scene.
**Acceptance**: types compile in both languages; field names identical to
  the doc (spot-check 3 types).
**Test**: `cd server && cargo test -p game-core && cd ../client && npm test && npm run build`

---

## T0.3 — Socket ping/pong plumbing [ ]

**Goal**: server listens on 3001 with socket.io; client connects and
round-trips a ping.
**Read**: `docs/05-server.md` §1, §5, §7, `docs/06-protocol.md` §1–§2.
**Files**:
- modify `server/server/src/main.rs` (tokio + socketioxide listener on
  `WIPGAME_PORT`, default 3001; tracing subscriber init; handle `ping` →
  `pong`)
- create `server/server/src/net.rs` (socket handlers; log connect/disconnect
  at info with `[net]` prefix)
- create `server/server/src/tick.rs` (stub: 20 Hz tokio interval loop that
  logs `[tick] n` at debug; no rooms yet)
- modify `client/src/main.ts` (connect socket.io to `ws://localhost:3001`,
  send `ping` every 2 s, log `pong` arrival)
**Steps**:
1. Wire socketioxide in main.rs; spawn tick loop.
2. Handle `ping` → emit `pong` (per docs/06 §2).
3. Client connects, pings, logs pong.
4. Verify `RUST_LOG` env changes log level (run with `RUST_LOG=debug`).
**Acceptance**: with server running, client console shows pong replies;
  server logs `[net] client connected` / `disconnected`.
**Test**: `cd server && cargo test && cargo run -- dev` (then in another
  terminal `cd client && npm run dev`, open localhost:5173, confirm pongs
  in both consoles; then `cargo test` again for suite health)
