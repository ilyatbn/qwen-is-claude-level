//! Regenerates the golden seed 1 / Small ASCII grid used by
//! `tests/determinism.rs::seed1_small_ascii_dump_is_unchanged`.
//!
//! Run ONLY when generation changes deliberately:
//!   cargo run -p game-core --example dump_seed1 > game-core/tests/golden/seed1_small.txt
use game_core::map::{Map, Scale};

fn main() {
    print!("{}", Map::generate(1, Scale::Small).ascii_dump());
}
