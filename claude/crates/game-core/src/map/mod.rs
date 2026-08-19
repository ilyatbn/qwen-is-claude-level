//! The map: the occupancy mask, its coarse index, the generator and destruction.

pub mod coarse;
pub mod gen;
pub mod mask;
pub mod noise;

pub use coarse::{CellState, CoarseGrid};
pub use mask::Mask;
