//! Which spawn spacing actually gets used, and how many spawns result.
use game_core::map::{find_spawns, Map, Scale, MIN_SPAWNS};
use game_core::rng::GameRng;

fn main() {
    for scale in Scale::ALL {
        let (mut min_n, mut max_n, mut total) = (usize::MAX, 0usize, 0usize);
        let mut min_cheb = f32::MAX;
        for seed in 0..100u64 {
            let map = Map::generate(seed, scale);
            let n = map.spawns.len();
            min_n = min_n.min(n);
            max_n = max_n.max(n);
            total += n;
            for (i, a) in map.spawns.iter().enumerate() {
                for b in map.spawns.iter().skip(i + 1) {
                    min_cheb = min_cheb.min((a.x - b.x).abs().max((a.y - b.y).abs()));
                }
            }
        }
        println!(
            "{:<7} spawns min={:<3} max={:<3} mean={:<6.1} min_chebyshev={:<4} (floor {})",
            scale.as_str(), min_n, max_n, total as f32 / 100.0, min_cheb, MIN_SPAWNS
        );
    }
    // Confirm find_spawns is a pure function of (map, rng state).
    let map = Map::generate(1, Scale::Small);
    let a = find_spawns(&map, &mut GameRng::new(99));
    let b = find_spawns(&map, &mut GameRng::new(99));
    println!("find_spawns reproducible: {}", a == b);
}
