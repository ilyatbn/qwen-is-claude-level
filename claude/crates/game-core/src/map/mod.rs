//! The map: the occupancy mask, its coarse index, the generator and destruction.

pub mod coarse;
pub mod gen;
pub mod mask;
pub mod noise;
pub mod shape;

pub use coarse::{CellState, CoarseGrid};
pub use mask::Mask;
pub use shape::{carve_circle_counted, stamp_capsule, stamp_circle};
