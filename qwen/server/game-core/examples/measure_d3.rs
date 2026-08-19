//! D3 measurement: actual max adjacent-column surface delta, and surface
//! bounds, across 100 seeds x 3 scales. Not a test — a measurement harness.
use game_core::map::{surface_rows, Scale};
use game_core::rng::GameRng;

fn main() {
    for scale in Scale::ALL {
        let (width, height) = scale.dimensions();
        let h = height as f32;
        let (mut max_delta, mut worst_seed) = (0i64, 0u64);
        let (mut min_row, mut max_row) = (u32::MAX, 0u32);
        let mut over_8 = 0usize;

        for seed in 0..100u64 {
            let mut rng = GameRng::new(seed);
            let rows = surface_rows(width, height, &mut rng);
            for w in rows.windows(2) {
                let d = (w[1] as i64 - w[0] as i64).abs();
                if d > max_delta {
                    max_delta = d;
                    worst_seed = seed;
                }
                if d > 8 {
                    over_8 += 1;
                }
            }
            min_row = min_row.min(*rows.iter().min().unwrap());
            max_row = max_row.max(*rows.iter().max().unwrap());
        }

        // docs/01 §3: h clamped to [H*0.15, H*0.6]; s = H-1-round(h).
        let expected_min = (height as f32 - 1.0 - h * 0.6).round() as u32;
        let expected_max = (height as f32 - 1.0 - h * 0.15).round() as u32;
        println!(
            "{:<7} H={:<4} max_delta={:<3} (seed {:<3})  over_8={:<6} \
             rows=[{},{}] expected=[{},{}]  0.126*H={:.1}",
            scale.as_str(),
            height,
            max_delta,
            worst_seed,
            over_8,
            min_row,
            max_row,
            expected_min,
            expected_max,
            0.126 * h,
        );
    }
}
