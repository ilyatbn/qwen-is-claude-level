//! `game-core` — the pure simulation.
//!
//! Compiled twice: natively into `game-server` (the authority) and to WebAssembly
//! for the browser client (the predictor). It contains no I/O, no networking, no
//! filesystem access and no ambient randomness — every random draw comes from a
//! seeded [`rand_chacha::ChaCha8Rng`] passed in explicitly.
//!
//! See `docs/01-architecture.md`.

pub mod constants;
