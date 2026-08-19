//! D5 measurement: connected ROCK component sizes across 100 seeds x 3 scales.
use game_core::map::{Map, Scale, MAX_POCKET_TILES};
use game_core::tiles::TileKind;

/// Largest connected ROCK component (4-connectivity), by flood fill.
fn components(map: &Map) -> Vec<usize> {
    let (w, h) = (map.width as usize, map.height as usize);
    let mut seen = vec![false; w * h];
    let mut sizes = Vec::new();
    for start in 0..w * h {
        if seen[start] || map.tile((start % w) as u32, (start / w) as u32).kind != TileKind::Rock {
            continue;
        }
        let mut stack = vec![start];
        seen[start] = true;
        let mut size = 0usize;
        while let Some(i) = stack.pop() {
            size += 1;
            let (x, y) = ((i % w) as i64, (i / w) as i64);
            for (dx, dy) in [(1i64, 0i64), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (x + dx, y + dy);
                if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                    continue;
                }
                let j = ny as usize * w + nx as usize;
                if !seen[j] && map.tile(nx as u32, ny as u32).kind == TileKind::Rock {
                    seen[j] = true;
                    stack.push(j);
                }
            }
        }
        sizes.push(size);
    }
    sizes
}

fn main() {
    println!("per-pocket algorithmic max = {MAX_POCKET_TILES} tiles (1 start + 12 steps)");
    for scale in Scale::ALL {
        let (mut max_comp, mut worst_seed, mut over_15) = (0usize, 0u64, 0usize);
        let mut total = 0usize;
        for seed in 0..100u64 {
            let map = Map::generate(seed, scale);
            for size in components(&map) {
                total += 1;
                if size > max_comp {
                    max_comp = size;
                    worst_seed = seed;
                }
                if size > 15 {
                    over_15 += 1;
                }
            }
        }
        println!(
            "{:<7} pockets/map={:<3} max_component={:<4} (seed {:<3}) components>15={:<5} total_components={}",
            scale.as_str(), scale.pockets(), max_comp, worst_seed, over_15, total
        );
    }
}
