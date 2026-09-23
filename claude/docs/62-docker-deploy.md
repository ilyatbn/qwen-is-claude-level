# 62 — Docker and deployment

Everything runs in containers so the stack can be moved and scaled without
reinstalling toolchains. v1 is two services; the compose file is shaped so adding
Redis and Postgres later is uncommenting, not restructuring.

---

## 1. Services

| Service | Image | Port | Role |
|---|---|---|---|
| `server` | `docker/Dockerfile.server` | 3000 | axum + socketioxide game server |
| `client` | `docker/Dockerfile.client` | 8080 | nginx serving the built static client |
| ~~`redis`~~ | commented | 6379 | future: cross-process room directory |
| ~~`postgres`~~ | commented | 5432 | future: accounts, stats, persistence |

**There is no database in v1.** Room state is in-memory and dies with the round,
which is correct for a game with no accounts and no persistence. The commented
services exist so the scale-out path is written down rather than remembered.

## 2. Server image

Multi-stage, and dependency-cached so an ordinary code change rebuilds in seconds
rather than minutes:

```
FROM rust:1.97-slim AS builder
  # copy Cargo.toml/Cargo.lock and stub main.rs files first, build deps  ← cached layer
  # then copy real sources and build --release

FROM debian:bookworm-slim AS runtime
  # ca-certificates only
  # non-root user
  # COPY --from=builder /app/target/release/game-server /usr/local/bin/
  # HEALTHCHECK curl -f http://localhost:3000/healthz
  # EXPOSE 3000
  # ENTRYPOINT ["game-server"]
```

Runtime image lands around 90 MB. `debian:bookworm-slim` rather than distroless
because a shell inside the container is worth more during development than the
handful of megabytes it costs. Distroless is a later swap.

Runs as a non-root user. The process handles `SIGTERM` for clean shutdown
(`41-server-loop-rooms.md` §7), so `stop_grace_period: 10s` gives it room to flush
replay files.

## 3. Client image

```
FROM rust:1.97-slim AS wasm
  # cargo install wasm-pack; build crates/game-wasm --target web

FROM node:22-slim AS build
  # npm ci; copy wasm output into client/src/core/pkg; npm run build

FROM nginx:alpine AS runtime
  # COPY --from=build /app/client/dist /usr/share/nginx/html
  # COPY docker/nginx.conf
```

The WASM stage is separate and first so that a pure-frontend change does not
rebuild Rust.

`docker/nginx.conf`:
- serves the SPA with `try_files $uri /index.html`;
- proxies `/socket.io/` to `server:3000` with `Upgrade`/`Connection` headers set —
  **without these, WebSocket upgrade fails and socket.io silently degrades to
  long-polling**, which looks like unexplained lag rather than an error;
- `proxy_read_timeout 3600s`, so idle sockets are not culled mid-round;
- sets long cache headers on `/assets/`, and none on `index.html`.

## 4. Compose

`docker/docker-compose.yml`:

```yaml
services:
  server:
    build: { context: .., dockerfile: docker/Dockerfile.server }
    ports: ["3000:3000"]
    environment:
      BIND_ADDR: 0.0.0.0:3000
      GAME_LOG: ${GAME_LOG:-info}
      MAP_SCALE: ${MAP_SCALE:-medium}
      MAX_PLAYERS: ${MAX_PLAYERS:-6}
      ROUND_SECONDS: ${ROUND_SECONDS:-240}
      FIXED_SEED: ${FIXED_SEED:-}
      RECORD_REPLAY: ${RECORD_REPLAY:-0}
    volumes: ["../recordings:/recordings"]   # renamed, and `REPLAY_DIR` added — see `docs/76` §G9
    healthcheck: { test: ["CMD","curl","-f","http://localhost:3000/healthz"], interval: 10s }
    stop_grace_period: 10s

  client:
    build: { context: .., dockerfile: docker/Dockerfile.client }
    ports: ["8080:80"]
    depends_on: { server: { condition: service_healthy } }

  # redis:    { image: "redis:7-alpine", ports: ["6379:6379"] }
  # postgres: { image: "postgres:16-alpine", environment: {...}, volumes: ["pgdata:/var/lib/postgresql/data"] }
```

Run: `docker compose -f docker/docker-compose.yml up --build`, then
`http://localhost:8080`.

The `recordings` bind mount is what makes `RECORD_REPLAY=1` useful in Docker — without
it, the files a user is asked to send would die with the container.

> **This paragraph described a fix that was not wired — see `docs/76` §G9.** The mount
> existed and the traces died anyway: the server wrote to a *relative* `replays` under the
> container's `WORKDIR /home/game`, and `REPLAY_DIR` was never set, so nothing ever reached
> the mount. **A bind mount is not a destination until something points at it.**

## 5. Environment

`.env.example` at the project root, copied to `.env` and read by compose:

```
GAME_LOG=info
MAP_SCALE=medium
MAX_PLAYERS=6
ROUND_SECONDS=240
FIXED_SEED=
RECORD_REPLAY=0
DEBUG_DUMP=0
```

`.env` is gitignored; `.env.example` is committed. Full semantics in
`41-server-loop-rooms.md` §5.

## 6. Development without Docker

Faster, and the default while building:

```sh
cargo run -p game-server                  # :3000
npm --prefix client run dev               # :5173, proxies /socket.io to :3000
```

Vite's dev proxy must set `ws: true`, for the same reason nginx needs the upgrade
headers.

`predev` and `prebuild` hooks in `client/package.json` run `wasm-pack`, so the WASM
is never stale. If `wasm-pack` is missing, the hook must fail with an install
instruction rather than a confusing module-not-found error later.

## 7. Scaling out

Rooms are independent and share nothing (`41-server-loop-rooms.md` §1), so the path
is straightforward when it is needed:

1. Multiple rooms in one process — a `RoomRegistry`. No infrastructure change.
2. Multiple processes — a router keyed by room id, with sticky sessions. **Sticky
   routing is mandatory**: socket.io state is per-connection and per-process, and a
   round-robin load balancer will break connections in ways that look like random
   disconnects.
3. Redis pub/sub for a cross-process room directory. Uncomment the service.
4. Postgres for accounts and stats, if the game ever needs them.

Sizing: one room is one core at most (a tick is a couple of milliseconds for six
players), and about 4 KB/s per client. A modest VM hosts dozens of concurrent
rounds.

## 8. Testing

- `docker compose up --build` succeeds from a clean checkout with no local Rust or
  Node toolchain.
- `curl http://localhost:3000/healthz` returns 200.
- The client at `:8080` connects through the nginx proxy and the transport is
  `websocket`, **not** `polling` — check `socket.io` transport in the browser
  console, because the polling fallback works well enough to hide a broken proxy.
- `docker compose down` produces a clean shutdown, and a recording exists in
  `./recordings` — **on the host**, which is the half that was never checked.
- Killing the server container while a client is connected shows the reconnect
  overlay rather than a stuck frame.
- The server image runs as a non-root user (`docker exec ... whoami`).

## 9. Future work

- Distroless runtime image.
- Multi-arch builds (arm64) for cheaper hosting.
- A `docker-compose.dev.yml` overlay with bind mounts and `cargo watch`.
- CI publishing tagged images.
- TLS termination — currently assumed to be handled upstream.
