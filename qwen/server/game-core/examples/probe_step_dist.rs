//! D36 evidence: how often is an upward terrain step exactly 1 tile?
use game_core::map::{Map, Scale};

fn main() {
    for scale in Scale::ALL {
        let mut hist = [0usize; 20];
        let mut total_up = 0usize;
        for seed in 0..60u64 {
            let map = Map::generate(seed, scale);
            let mut prev = map.surface_row(0);
            for x in 1..map.width {
                let cur = map.surface_row(x);
                // Surface row DECREASES going up, so prev > cur is a rise.
                if cur < prev {
                    let rise = (prev - cur) as usize;
                    total_up += 1;
                    hist[rise.min(19)] += 1;
                }
                prev = cur;
            }
        }
        let one = hist[1];
        let two_plus: usize = hist[2..].iter().sum();
        println!(
            "{:<7} upward steps={total_up:<6} 1-tile={one:<6} ({:.1}%)  >=2 tiles={two_plus:<6} ({:.1}%)",
            scale.as_str(),
            100.0 * one as f32 / total_up as f32,
            100.0 * two_plus as f32 / total_up as f32,
        );
    }
}
