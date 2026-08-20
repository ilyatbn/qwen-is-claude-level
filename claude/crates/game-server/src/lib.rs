//! The server as a library, so integration tests can build the same router the
//! binary serves and run it on an ephemeral port.
//!
//! `main.rs` is a thin wrapper over [`app::build`].

pub mod app;
pub mod codec;
pub mod config;
pub mod events;
pub mod logging;
pub mod metrics;
pub mod registry;
pub mod replay;
pub mod room;
pub mod round;
pub mod session;
pub mod state;

/// `SIM_HZ` as a float, for the millisecond arithmetic in `metrics`.
pub const SIM_HZ_F: f64 = game_core::constants::SIM_HZ as f64;
