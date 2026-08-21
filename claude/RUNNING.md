# Running this game

Everything below assumes you have just cloned the repo and have never seen it.

---

## 0. The short version

```sh
make            # what the targets are
make start      # server on :3000, client dev server, prints the URL
make stop       # stops both, killing the whole process group
make test       # the full gate
```

`make stop` kills the **process group**, not the direct child. `vite`,
`npm run dev` and `cargo run` all fork the process that actually holds the port,
so killing the child leaves an orphan on :3000 or :5174. Ten of those once
accumulated on this machine and were blamed for three sessions of "flaky test"
(`docs/71-amendments-v3.md` §B23). `make status` shows which pid holds each port.

Do **not** run `make test` while `make start` is up — a loaded box turns every
wall-clock assertion in the browser suite into a coin flip, which is the same
finding.

Everything below is the same thing done by hand.

---

## 1. The fastest way to see it

You do **not** need a server, Docker, or any downloaded art. The client runs
`game-core` in the browser through WASM, and every texture has a procedural
fallback.

```sh
npm --prefix client install
npm --prefix client run dev
```

Open the URL it prints — **it is usually `http://localhost:5174`, not 5173**,
because 5173 is often taken. Read the port from vite's own output rather than
assuming.

That gives you the multiplayer client, which will sit at "connecting". For
single-player with no server, use the sandbox:

```
http://localhost:5174/?sandbox=1
```

`npm run dev` rebuilds the WASM first, so a change in `crates/game-core` reaches
the browser without a separate step.

## 2. Playing it properly, with a server and bots

Two terminals:

```sh
cargo run -p game-server --release        # :3000
npm --prefix client run dev               # :5174, proxies /socket.io to :3000
```

Then open `http://localhost:5174`. Three bots are seated by default, so it is a
real deathmatch on your own.

**Controls**

| | |
|---|---|
| `A` / `D` | walk |
| `Space` | jump; **hold** it in the air for the jetpack |
| `W` `A` `S` `D` while thrusting | directional flight |
| mouse | aim — the crosshair rides a ring around you |
| left click, or `F` | fire the selected weapon |
| right click | inventory panel |
| `1`–`8`, mouse wheel | select a slot |
| `E` | use the selected item (medkit, shield, flashlight) |
| `Tab` | scoreboard |
| `M` | minimap |
| `F3` | netcode debug HUD |

In the **sandbox** (`?sandbox=1`) the bindings differ: left click carves, `F`
fires, `1`–`3` pick a slot, right click toggles the inventory readout, `M` is the
minimap, and the on-screen panel has the seed box, scale switcher, carve radius,
day/night slider and weather triggers. Arrow keys pan the camera.

## 3. With Docker

```sh
cp .env.example .env
docker compose -f docker/docker-compose.yml up --build
```

Then `http://localhost:8080`. The client is served by nginx, which proxies
`/socket.io/` to the server with the WebSocket upgrade headers set — without
those, socket.io silently falls back to long-polling, which looks like
unexplained lag rather than an error. Check the transport in the browser console
if the game feels sluggish.

`docker compose down` shuts down cleanly and flushes any replay files.

## 4. URL flags

| Flag | What it does |
|---|---|
| `?sandbox=1` | single-player dev sandbox, no server — seed box, scale switcher, click-to-carve, weather triggers, day/night slider |
| `?seed=<n>` | generate a specific map (sandbox) |
| `?scale=small\|medium\|large` | map size (sandbox) |
| `?preview=1` | bare render harness, no input |
| `?e2e=1` | exposes `window.__game`, the debug handle the automated checks read |

`window.__game.debug()` is the single most useful thing in the client: seed,
scale, traversable fraction, camera, player body, fps, darkness, checksum.

## 5. Environment variables

Server, read once at startup (`docs/41-server-loop-rooms.md` §5):

| Var | Default | Meaning |
|---|---|---|
| `BIND_ADDR` | `0.0.0.0:3000` | |
| `GAME_LOG` | `info` | `EnvFilter`, e.g. `info,game::map=debug` |
| `MAP_SCALE` | `large` | `small` \| `medium` \| `large` |
| `ROUND_SECONDS` | `240` | shorten it to test the phase machine |
| `MAX_PLAYERS` | `6` | |
| `MIN_PLAYERS_TO_START` | `1` | |
| `BOT_COUNT` | `3` | bots seated; a human is never refused a seat because of a bot |
| `BOT_SKILL` | `0.6` | 0–1, scales aim error and reaction delay |
| `FIXED_SEED` | unset | every round uses this seed |
| `RECORD_REPLAY` | `0` | write a replay per round |
| `REPLAY_DIR` | `replays` | |
| `DEBUG_DUMP` | `0` | dump `map.png`, `surface.png`, `meta.json` at round start |
| `DEV_LOADOUT` | `0` | start with weapons, for testing — finding them is the design |

Log targets: `game::map`, `game::sim`, `game::net`, `game::player`,
`game::items`, `game::weapons`, `game::effects`, `game::round`.

## 6. Reproducing a bug from a seed and a tick

This is the workflow the whole logging and replay design exists for.

**You have a seed** (it is on the F3 HUD and in `welcome`):

```sh
FIXED_SEED=8123491234 cargo run -p game-server --release
# or, for a map-generation problem, no server needed:
#   http://localhost:5174/?sandbox=1&seed=8123491234
```

`DEBUG_DUMP=1` additionally writes the terrain, the surface graph and the full
`MapMeta` to `debug/<seed>/` at round start — `surface.png` is the direct visual
answer to "why was this map rejected?".

**You have a replay** (`RECORD_REPLAY=1` writes one per round):

```sh
cargo run -p game-server --release --bin replay -- replays/<file>
```

It re-simulates the round headlessly and compares the final world hash against
the footer. If they differ it prints the **divergence tick**, which is the
fastest way to find a nondeterminism bug. It also takes `--until <tick>` to stop
at a point of interest and `--dump-map <tick>` to write a PNG of the terrain
then. So *"the map broke around two minutes in"* becomes: replay to tick 7200,
dump the PNG, look at it.

A replay is about 1.2 MB for a four-minute six-player round.

**You have neither** — ask for the seed. With the seed alone, most map and
physics bugs reproduce in under a minute.

## 7. Tests

```sh
./scripts/check.sh              # the gate: fmt, clippy -D warnings, all tests, e2e
./scripts/check.sh --fast       # skip the browser suite
node scripts/e2e.mjs            # the browser suite alone
node scripts/e2e.mjs wasd feel  # only checks matching these names
node scripts/e2e-two-clients.mjs   # two real clients against a real server
node scripts/net-smoke.mjs      # is the server or the test harness broken?
```

Every browser check writes a screenshot to `shots/`. There is no display on the
machine this was built on, so **a screenshot is the only way a failure is ever
seen** — a check that writes none is itself a failure.

`net-smoke.mjs` exists as a *control*: when the Rust integration tests go red it
tells you whether the server or the test client is at fault. `rust_socketio`'s
`connect()` returns while the socket.io namespace CONNECT is still in flight, so
its first emit is dropped — that cost a session once.

## 8. Getting the art

The game runs without it. To fetch the real sprites:

```sh
./scripts/fetch-assets.sh       # downloads the CC0 Kenney packs
node scripts/build-atlas.mjs    # packs them into assets/atlas/
```

`assets/vendor/` is gitignored (the particle pack alone is 15 MB); the built
atlases are committed, so a fresh clone already has the art. Credit to
[Kenney](https://kenney.nl) — everything is CC0.

## 9. Where things live

```
crates/game-core     pure simulation: map, physics, items, weapons, weather, bots
crates/game-server   axum + socketioxide; owns the world, one task per room
crates/game-wasm     the boundary that ships game-core to the browser
client/              Phaser 3 renderer, netcode, UI
docs/                the specification. 70-amendments-v2.md overrides the rest.
tasks/               the task list and JOURNAL.md, the running handoff log
scripts/             check.sh, the e2e suite, asset tooling
```

`game-core` has no tokio, no filesystem, no network and no ambient randomness —
seeded `ChaCha8Rng` only. That purity is what lets the browser and the server run
byte-identical simulations, which is what makes prediction and replay work.
