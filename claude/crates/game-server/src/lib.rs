//! The server as a library, so integration tests can build the same router the
//! binary serves and run it on an ephemeral port.
//!
//! `main.rs` is a thin wrapper over [`app::build`].

pub mod app;
pub mod codec;
pub mod config;
pub mod events;
pub mod logging;
pub mod room;
pub mod state;
