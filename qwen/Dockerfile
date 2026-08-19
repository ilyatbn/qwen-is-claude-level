# Multi-stage build (docs/05 §6). Build context is the repo root.
#
# Server only: the client is a static Vite build served separately (see
# .dockerignore and README "How to run"), and docs/05 §6 lists no client
# service.

# Latest stable 1.x. The socket handlers use async closures, stable since
# 1.85, so an older toolchain will not build this even though the workspace is
# edition 2021. There is no rust-toolchain.toml, so the image tracks whatever
# 1.x is current at build time.
FROM rust:1-slim-bookworm AS build
WORKDIR /src

# Manifests first, so a source-only change does not re-download and re-build
# every dependency. The dummy sources give cargo something to compile against.
COPY server/Cargo.toml server/Cargo.lock ./server/
COPY server/game-core/Cargo.toml ./server/game-core/
COPY server/server/Cargo.toml ./server/server/
RUN mkdir -p server/game-core/src server/server/src \
    && echo 'fn main() {}' > server/server/src/main.rs \
    && echo '' > server/game-core/src/lib.rs \
    && cd server && cargo build --release -p server \
    && rm -rf game-core/src server/src

COPY server/ ./server/
# cargo skips a rebuild when only mtimes changed, and the dummy build above
# left artefacts for these two crates.
RUN cd server && touch game-core/src/lib.rs server/src/main.rs \
    && cargo build --release -p server

FROM debian:bookworm-slim
# Non-root (T5.5 step 1). A fixed uid keeps bind-mounted files predictable.
RUN useradd --system --uid 10001 --create-home wipgame
COPY --from=build /src/server/target/release/server /usr/local/bin/wipgame-server
USER wipgame
ENV WIPGAME_PORT=3001 \
    RUST_LOG=info
EXPOSE 3001
CMD ["/usr/local/bin/wipgame-server"]
