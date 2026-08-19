//! The map: the occupancy mask, its coarse index, the generator and destruction.

pub mod carve;
pub mod coarse;
pub mod gen;
pub mod mask;
pub mod meta;
pub mod noise;
pub mod shape;

pub use carve::{CarveResult, ChunkId};
pub use coarse::{CellState, CoarseGrid};
pub use mask::Mask;
pub use meta::{generate, BuriedSlot, Decoration, Map, MapMeta};
pub use shape::{carve_circle_counted, stamp_capsule, stamp_circle};
