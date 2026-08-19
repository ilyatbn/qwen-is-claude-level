//! Writes PNGs of generated maps to `target/mapdump/`.
//!
//! Run with:
//! ```sh
//! cargo test -p game-core --features dump-png --release --test dump_maps -- --nocapture
//! ```
#![cfg(feature = "dump-png")]

use game_core::constants::MapScale;
use game_core::map::dump::{dump_dir, dump_map, dump_surface};
use game_core::map::gen::{generate_once, GenParams};
use game_core::map::generate;

#[test]
fn dump_one_map_per_scale_and_six_medium_seeds() {
    let dir = dump_dir();
    std::fs::create_dir_all(&dir).expect("create dump dir");

    for scale in MapScale::ALL {
        let map = generate(4242, scale);
        let name = format!("{}-4242.png", scale.as_str());
        dump_map(&map, &dir.join(&name)).expect("write map png");
        println!(
            "{name}: {}x{} attempts={} fraction={:.3} spawns={} buried={} theme={} solid={:.3}",
            map.mask.w,
            map.mask.h,
            map.meta.attempts,
            map.meta.traversable_fraction,
            map.meta.spawn_points.len(),
            map.meta.buried_slots.len(),
            map.meta.theme,
            map.mask.count_solid() as f64 / (map.mask.w as f64 * map.mask.h as f64),
        );
    }

    for seed in [1u64, 7, 99, 4242, 31337, 8123491234] {
        let map = generate(seed, MapScale::Medium);
        dump_map(&map, &dir.join(format!("medium-{seed}.png"))).expect("write");
    }

    // The surface/component view, which is what explains a rejected map.
    let p = GenParams::default_for(MapScale::Medium);
    let outcome = generate_once(4242, &p);
    let map = generate(4242, MapScale::Medium);
    dump_surface(&map, &outcome.report, &dir.join("medium-4242-surface.png")).expect("write");

    println!("wrote PNGs to {}", dir.display());
}
