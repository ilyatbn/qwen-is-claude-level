//! Writes PNGs of generated maps to `target/mapdump/`.
//!
//! Both generators, on the same seeds, so `medium-4242-v1.png` and
//! `medium-4242-v2.png` are a controlled comparison rather than two pictures.
//!
//! Run with:
//! ```sh
//! cargo test -p game-core --features dump-png --release --test dump_maps -- --nocapture
//! ```
#![cfg(feature = "dump-png")]

use game_core::constants::{MapGenerator, MapScale};
use game_core::map::dump::{dump_dir, dump_map, dump_surface};
use game_core::map::gen::{generate_once, generate_terrain_with, GenParams};
use game_core::map::generate_with;

#[test]
fn dump_one_map_per_scale_and_six_medium_seeds() {
    let dir = dump_dir();
    std::fs::create_dir_all(&dir).expect("create dump dir");

    for generator in MapGenerator::ALL {
        let g = generator.as_str();
        for scale in MapScale::ALL {
            let map = generate_with(4242, scale, generator);
            let name = format!("{}-4242-{g}.png", scale.as_str());
            dump_map(&map, &dir.join(&name)).expect("write map png");
            println!(
                "{name}: {}x{} attempts={} fraction={:.3} spawns={} buried={} solid={:.3} enclosed_air={:.3}",
                map.mask.w,
                map.mask.h,
                map.meta.attempts,
                map.meta.traversable_fraction,
                map.meta.spawn_points.len(),
                map.meta.buried_slots.len(),
                map.mask.count_solid() as f64 / (map.mask.w as f64 * map.mask.h as f64),
                enclosed_air_fraction(&map.mask),
            );
        }

        for seed in [1u64, 7, 99, 4242, 31337, 8123491234] {
            let map = generate_with(seed, MapScale::Medium, generator);
            dump_map(&map, &dir.join(format!("medium-{seed}-{g}.png"))).expect("write");
        }
    }

    // The surface/component view, which is what explains a rejected map.
    let p = GenParams::default_for(MapScale::Medium);
    let outcome = generate_once(4242, &p);
    let map = generate_with(4242, MapScale::Medium, MapGenerator::V1);
    dump_surface(
        &map,
        &outcome.report,
        &dir.join("medium-4242-v1-surface.png"),
    )
    .expect("write");

    let o2 = generate_terrain_with(4242, MapScale::Medium, MapGenerator::V2);
    let map2 = generate_with(4242, MapScale::Medium, MapGenerator::V2);
    dump_surface(&map2, &o2.report, &dir.join("medium-4242-v2-surface.png")).expect("write");

    println!("wrote PNGs to {}", dir.display());
}

/// Air a flood from the top row cannot reach, over all air. This is the number
/// behind "the map is mostly caves": it is the fraction of the map's empty space
/// that is interior rather than sky.
fn enclosed_air_fraction(mask: &game_core::map::Mask) -> f64 {
    let (w, h) = (mask.w as i32, mask.h as i32);
    let (wu, hu) = (w as usize, h as usize);
    let mut seen = vec![false; wu * hu];
    let mut stack: Vec<(i32, i32)> = Vec::new();
    for x in 0..w {
        if !mask.get(x, 0) {
            seen[x as usize] = true;
            stack.push((x, 0));
        }
    }
    let mut open = 0u64;
    while let Some((x, y)) = stack.pop() {
        open += 1;
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            let i = ny as usize * wu + nx as usize;
            if seen[i] || mask.get(nx, ny) {
                continue;
            }
            seen[i] = true;
            stack.push((nx, ny));
        }
    }
    let air = (wu * hu) as u64 - mask.count_solid();
    if air == 0 {
        return 0.0;
    }
    (air - open) as f64 / air as f64
}
