//! D25 evidence: T2.1's literal y formula vs the corrected one.
//! Does the body end up inside its OWN spawn tile?
use game_core::map::{Map, Scale};
use game_core::player::player_config::*;
use game_core::tiles::TILE_SIZE;

fn main() {
    println!("body {}x{} px, spawn tile is GRASS (solid)", BODY_WIDTH, BODY_HEIGHT);
    for (label, doc_formula) in [("T2.1 literal: y=(tile_y+1)*16 - half_h", true),
                                 ("corrected:    y= tile_y   *16 - half_h", false)] {
        let mut inside_own_tile = 0usize;
        let mut total = 0usize;
        for seed in 0..100u64 {
            let map = Map::generate(seed, Scale::Small);
            for id in 0..map.spawns.len().min(6) {
                let tile = map.spawns[id];
                let base = if doc_formula { (tile.y + 1.0) * TILE_SIZE } else { tile.y * TILE_SIZE };
                let centre_y = base - BODY_HALF_HEIGHT;
                let centre_x = (tile.x + 0.5) * TILE_SIZE;
                total += 1;
                // Sample the body's vertical extent in its OWN column only.
                let mut bad = false;
                let mut y = centre_y - BODY_HALF_HEIGHT + 0.5;
                while y < centre_y + BODY_HALF_HEIGHT {
                    if map.is_solid_at_pixel(centre_x, y) { bad = true }
                    y += 2.0;
                }
                if bad { inside_own_tile += 1 }
            }
        }
        println!("  {label}  body inside its own spawn column: {inside_own_tile}/{total}");
    }
}
