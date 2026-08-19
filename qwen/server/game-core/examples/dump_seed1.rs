//! Regenerates the golden seed 1 / Small ASCII grid used by
//! `tests/determinism.rs::seed1_small_ascii_dump_is_unchanged`.
//!
//! Run ONLY when generation changes deliberately:
//!   cargo run -p game-core --example dump_seed1
//!
//! Writes the file itself, resolved from `CARGO_MANIFEST_DIR`, so it updates
//! the real anchor regardless of the working directory. Redirecting stdout to a
//! relative path (the previous instructions) silently created a nested
//! directory when run from inside `game-core/` instead of the workspace root.
use game_core::map::{Map, Scale};
use std::path::Path;

fn main() {
    let target = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
        .join("seed1_small.txt");
    let dump = Map::generate(1, Scale::Small).ascii_dump();
    std::fs::write(&target, &dump).expect("writing the golden dump");
    eprintln!("wrote {} ({} bytes)", target.display(), dump.len());
}
