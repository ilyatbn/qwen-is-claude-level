//! Physics: the body, collision queries against the mask, and movement resolution.
//!
//! Everything here is a pure function of `(state, map, dt)` — no I/O, no ambient
//! randomness. That is what lets the server run it as the authority and the browser
//! run the identical compiled code as a predictor (`docs/42-netcode-prediction.md`).

pub mod body;

pub use body::{move_state, Body, MoveState, COYOTE_TICKS};
