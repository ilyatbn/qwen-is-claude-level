//! Characterise spawn/body overlap: own column vs neighbours, and depth.
use game_core::map::{Map, Scale};
use game_core::player::{player_config::*, Player};
use game_core::tiles::TILE_SIZE;

fn main() {
    for scale in Scale::ALL {
        let (mut own, mut neigh, mut total) = (0usize, 0usize, 0usize);
        let mut max_depth: f32 = 0.0;
        for seed in 0..100u64 {
            let map = Map::generate(seed, scale);
            for id in 0..map.spawns.len().min(6) as u8 {
                let Some(p) = Player::spawn(&map, id, String::new()) else { continue };
                total += 1;
                let tile = map.spawns[id as usize];
                let col = tile.x as u32;

                // Own column: is the body's vertical extent clear above the tile?
                let mut own_bad = false;
                let mut neigh_bad = false;
                let top = p.pos.y - BODY_HALF_HEIGHT + 0.5;
                let bottom = p.pos.y + BODY_HALF_HEIGHT - 0.5;
                let mut y = top;
                while y < bottom {
                    for dx in [-BODY_HALF_WIDTH + 0.5, 0.0, BODY_HALF_WIDTH - 0.5] {
                        let x = p.pos.x + dx;
                        if map.is_solid_at_pixel(x, y) {
                            let c = (x / TILE_SIZE) as u32;
                            if c == col { own_bad = true } else { neigh_bad = true }
                            // Overlap depth: how far below the neighbour's surface.
                            let surf = map.surface_row(c) as f32 * TILE_SIZE;
                            max_depth = max_depth.max(bottom - surf);
                        }
                    }
                    y += 4.0;
                }
                if own_bad { own += 1 }
                if neigh_bad { neigh += 1 }
            }
        }
        println!(
            "{:<7} total={total:<4} own_column_overlap={own:<4} neighbour_overlap={neigh:<4} max_depth={max_depth:.1}px",
            scale.as_str()
        );
    }
}
