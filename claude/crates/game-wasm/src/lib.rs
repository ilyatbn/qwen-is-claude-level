//! `game-wasm` — the WebAssembly boundary.
//!
//! A thin `wasm-bindgen` shim over `game-core`. It holds no game logic of its own;
//! anything that looks like a rule belongs in `game-core` so the server runs the
//! identical code. See `docs/01-architecture.md`.
