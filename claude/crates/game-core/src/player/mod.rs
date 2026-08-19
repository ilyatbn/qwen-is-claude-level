//! The player: input, movement rules, the jetpack, and `apply_input`.

pub mod input;
pub mod movement;

pub use input::{button, edges, Input, InputEdges};
pub use movement::{apply_horizontal, try_jump, JumpState};
