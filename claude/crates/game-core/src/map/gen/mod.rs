//! The generation pipeline, one module per pass.
//!
//! ```text
//! 1 preset → 2 silhouette → 3 islands → 3b bridges → 4 cave network
//!         → 4b crevices → 4c voids → 5 smoothing → 6 cleanup
//!         → 7 validation → 8 metadata
//! ```
//!
//! Every pass draws from its own RNG sub-stream, so tuning one never disturbs
//! another (`docs/10-map-generation.md` §2). Order is from
//! `docs/70-amendments-v2.md` §A2.

pub mod blobs;
pub mod bridges;
pub mod caves;
pub mod network;
pub mod silhouette;

pub use silhouette::{borders_hold, force_borders, solid_fraction, GenParams};
