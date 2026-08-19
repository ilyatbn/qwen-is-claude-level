//! Determinism integration suite (T1.6, docs/08 §1 map row).
//!
//! docs/00 §2: "`game-core` must produce identical state for the same
//! (seed, tick count, input sequence)." docs/01 opens with "Everything here is
//! deterministic from `(seed, scale)`."
//!
//! T1.6 asks for 100 seeds x 3 scales, generated twice, asserting tiles, decor
//! and spawns are byte-identical.

use game_core::map::{Map, Scale};
use game_core::tiles::TileKind;

/// A compact, total fingerprint of everything `Map::generate` produces.
///
/// Compared instead of `Map` itself so a mismatch reports which field drifted
/// rather than dumping two full grids.
fn fingerprint(map: &Map) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "seed={} scale={} {}x{} version={}\n",
        map.seed,
        map.scale.as_str(),
        map.width,
        map.height,
        map.version
    ));
    // Tiles: kind AND hp, so a wrong starting hp is caught too.
    for tile in &map.tiles {
        out.push_str(&format!("{}:{};", tile.kind.to_byte(), tile.hp));
    }
    out.push('\n');
    for decor in &map.decor {
        out.push_str(&format!("{},{},{};", decor.x, decor.y, decor.kind.as_str()));
    }
    out.push('\n');
    for spawn in &map.spawns {
        out.push_str(&format!("{},{};", spawn.x, spawn.y));
    }
    out
}

#[test]
fn generate_deterministic_100_seeds() {
    // docs/08 §1: "100 seeds x 3 scales: two generations byte-identical".
    for scale in Scale::ALL {
        for seed in 0..100u64 {
            let first = Map::generate(seed, scale);
            let second = Map::generate(seed, scale);
            assert_eq!(
                fingerprint(&first),
                fingerprint(&second),
                "{} seed {seed} generated differently on a second run",
                scale.as_str(),
            );
        }
    }
}

#[test]
fn generation_is_order_independent_across_interleaving() {
    // Generating other maps in between must not perturb a later generation —
    // it would mean state is leaking out of the per-round GameRng.
    for scale in Scale::ALL {
        let baseline = fingerprint(&Map::generate(42, scale));
        for other in [0u64, 1, 999] {
            let _ = Map::generate(other, Scale::Large);
        }
        assert_eq!(
            baseline,
            fingerprint(&Map::generate(42, scale)),
            "{} seed 42 drifted after generating other maps",
            scale.as_str(),
        );
    }
}

#[test]
fn different_seeds_produce_different_maps() {
    for scale in Scale::ALL {
        let a = fingerprint(&Map::generate(1, scale));
        let b = fingerprint(&Map::generate(2, scale));
        assert_ne!(a, b, "{} seeds 1 and 2 produced identical maps", scale.as_str());
    }
}

#[test]
fn every_scale_produces_all_tile_kinds() {
    // A generation step silently doing nothing (e.g. pockets never placed)
    // would still be "deterministic". Assert the output is actually populated.
    for scale in Scale::ALL {
        let map = Map::generate(7, scale);
        for kind in [
            TileKind::Air,
            TileKind::Grass,
            TileKind::Dirt,
            TileKind::Stone,
            TileKind::Rock,
        ] {
            assert!(
                map.tiles.iter().any(|t| t.kind == kind),
                "{} produced no {kind:?} tiles",
                scale.as_str(),
            );
        }
        assert!(!map.decor.is_empty(), "{} produced no decor", scale.as_str());
        assert!(!map.spawns.is_empty(), "{} produced no spawns", scale.as_str());
    }
}

#[test]
fn generated_map_has_expected_dimensions() {
    for scale in Scale::ALL {
        let map = Map::generate(3, scale);
        let (width, height) = scale.dimensions();
        assert_eq!((map.width, map.height), (width, height));
        assert_eq!(map.tiles.len(), (width * height) as usize);
        assert_eq!(map.seed, 3);
        assert_eq!(map.scale, scale);
        assert_eq!(map.version, 0, "a fresh map should be at version 0");
    }
}

#[test]
fn large_map_generation_is_fast_enough() {
    // T1.6 Acceptance: "generation of Large map < 50 ms (assert in test with an
    // upper bound of 200 ms to be safe)".
    //
    // This is a wall-clock assertion and therefore load-sensitive; the doc's own
    // 4x headroom is kept deliberately. See DEVIATIONS.md D21 — it is retained
    // as written rather than dropped, but it gates on the generous bound.
    let start = std::time::Instant::now();
    let map = Map::generate(1, Scale::Large);
    let elapsed = start.elapsed();
    assert_eq!(map.tiles.len(), 240 * 128);
    assert!(
        elapsed.as_millis() < 200,
        "Large map generation took {elapsed:?}, over the 200 ms bound",
    );
    println!("Large map generated in {elapsed:?} (doc target < 50 ms)");
}
