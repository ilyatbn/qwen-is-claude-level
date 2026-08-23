//! The map: the occupancy mask, its coarse index, the generator and destruction.

pub mod carve;
pub mod coarse;
#[cfg(feature = "dump-png")]
pub mod dump;
pub mod gen;
pub mod mask;
pub mod meta;
pub mod noise;
pub mod rle;
pub mod shape;

pub use carve::{CarveResult, ChunkId};
pub use coarse::{CellState, CoarseGrid};
pub use mask::Mask;
pub use meta::{
    generate, generate_full, generate_with, generate_with_secret, BuriedSlot, Decoration, Map,
    MapMeta,
};
pub use shape::{carve_circle_counted, stamp_capsule, stamp_circle};
