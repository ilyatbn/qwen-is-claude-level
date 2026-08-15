# Deathmatch — 2D destructible-terrain multiplayer shooter

A real-time free-for-all deathmatch for up to 6 players on a randomly generated,
fully destructible map in the style of the classic Worms games. Rounds last four
minutes; a kill is +1, a death is −1. Rust authoritative server, Phaser client,
socket.io between them.

**Status: design complete, implementation not started.** See `tasks/TASKS.md`.

---

## Layout

| Path | What it is |
|---|---|
| `prompt.md` | The operating instructions for the model implementing this. Paste it at the start of every session. |
| `docs/` | The specification. One file per system. Read-only during implementation. |
| `tasks/` | The work backlog: 90 small tasks across 9 milestones, plus `JOURNAL.md`. |
| `crates/game-core/` | Pure Rust: map generation, destruction, physics, items, effects. No I/O. |
| `crates/game-server/` | axum + socketioxide + tokio. Owns rooms, ticks the core, broadcasts state. |
| `crates/game-wasm/` | wasm-bindgen shim exposing `game-core` to the browser. |
| `client/` | Vite + TypeScript + Phaser 3.90 + socket.io-client. |
| `assets/` | Kenney CC0 art, terrain themes, skin registry. |
| `docker/` | Server and client images, compose stack. |
| `scripts/` | `check.sh` (the gate), `fetch-assets.sh`. |

Everything except `docs/` and `tasks/` is created by the tasks themselves.

## Why the core is one shared crate

Map generation, collision and player physics exist in exactly one place:
`crates/game-core`. It compiles natively for the server and to WebAssembly for the
browser. The server is authoritative; the client runs the *same compiled code* to
predict its own movement, so prediction can never drift from the server because of
a mismatched reimplementation. It also means milestones 1–3 are playable in the
browser with no server running at all.

## Start here

**If you are the model doing the work:** read `prompt.md`. It is the whole
instruction — the session loop, the rules, and what to do when you run low on
context. Everything else follows from it.

**If you are driving that model:** paste `prompt.md` at the start of each session.
Work is one task per session; the model ticks its box in `tasks/TASKS.md` and
leaves a handoff note in `tasks/JOURNAL.md`, so a refreshed session picks up
exactly where the last one stopped. When it prints `SESSION REFRESH NEEDED`, start
a new session and paste the prompt again — nothing is lost.

## Running it (once the milestones land)

| After | Command | You get |
|---|---|---|
| M0 | `cargo run -p game-server` + `npm --prefix client run dev` | Client connects, echoes a ping |
| M1 | `cargo test -p game-core --features dump-png` | Generated maps as PNGs in `target/mapdump/` |
| M3 | `npm --prefix client run dev` | Single-player browser sandbox: real map, real movement, no server |
| M6 | `docker compose -f docker/docker-compose.yml up` | Full 6-player multiplayer round |

## Verification gate

`./scripts/check.sh` runs `cargo fmt --check`, `cargo clippy -- -D warnings`,
`cargo test`, `tsc --noEmit` and `vitest run`. It must be green before any task is
considered done.

## Licensing

Art is Kenney CC0 (`assets/vendor/kenney/**`, each pack keeps its `LICENSE`).
Terrain material textures are generated or hand-made in-repo — see `docs/51-assets.md`.
