//! Determinism integration suite (T1.6, docs/08 §1 map row).
//!
//! docs/00 §2: "`game-core` must produce identical state for the same
//! (seed, tick count, input sequence)." docs/01 opens with "Everything here is
//! deterministic from `(seed, scale)`."
//!
//! T1.6 asks for 100 seeds x 3 scales, generated twice, asserting tiles, decor
//! and spawns are byte-identical.

use game_core::items::{place_hidden, place_initial, GroundItem, ItemIdCounter};
use game_core::map::{Map, Scale};
use game_core::protocol::ItemId;
use game_core::rng::GameRng;
use game_core::tiles::TileKind;

/// FNV-1a (64-bit), inlined.
///
/// Deliberately NOT `std::collections::hash_map::DefaultHasher`: its algorithm
/// is explicitly unstable across Rust releases, so pinning a golden value
/// computed with it would make this suite hostage to the toolchain — exactly
/// the coupling DEVIATIONS.md D19 exists to remove. FNV-1a is a fixed,
/// specified algorithm; the constants below are part of the spec.
struct Fnv1a(u64);

impl Fnv1a {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    fn new() -> Self {
        Fnv1a(Self::OFFSET_BASIS)
    }

    fn byte(&mut self, b: u8) {
        self.0 ^= b as u64;
        self.0 = self.0.wrapping_mul(Self::PRIME);
    }

    fn bytes(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.byte(b);
        }
    }

    fn u32(&mut self, v: u32) {
        self.bytes(&v.to_le_bytes());
    }

    /// f32 by bit pattern, so a 1-ULP drift is caught rather than rounded away.
    fn f32(&mut self, v: f32) {
        self.bytes(&v.to_bits().to_le_bytes());
    }

    fn finish(self) -> u64 {
        self.0
    }
}

/// A golden hash over everything `Map::generate` produces.
///
/// This is the anchor the suite was missing. `generate_deterministic_100_seeds`
/// compares two runs of the same binary, which cannot fail when the algorithm
/// itself changes — both sides change together. Pinning a literal makes any
/// change to generation output a test failure, including a single wasted RNG
/// draw.
fn golden_hash(map: &Map) -> u64 {
    let mut h = Fnv1a::new();
    h.bytes(&map.seed.to_le_bytes());
    h.bytes(map.scale.as_str().as_bytes());
    h.u32(map.width);
    h.u32(map.height);
    h.bytes(&map.version.to_le_bytes());
    for tile in &map.tiles {
        h.byte(tile.kind.to_byte());
        h.f32(tile.hp);
        // Always None from `generate` today, but T3.3's `place_hidden` writes
        // this from RNG draws, and docs/04 §6 makes hidden-item placement step
        // 5 of the determinism-critical order. Hashing it now extends the
        // anchor to cover that step for free, the moment it exists.
        match tile.item {
            None => h.byte(0),
            Some(item) => {
                h.byte(1);
                h.bytes(item.as_str().as_bytes());
            }
        }
    }
    for decor in &map.decor {
        h.u32(decor.x);
        h.u32(decor.y);
        h.bytes(decor.kind.as_str().as_bytes());
    }
    for spawn in &map.spawns {
        h.f32(spawn.x);
        h.f32(spawn.y);
    }
    h.finish()
}

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

/// Golden generation output, pinned to literals.
///
/// **This is the test that catches an algorithm change.** Everything else in
/// this file compares `Map::generate` against itself and therefore cannot fail
/// when generation changes — a single extra `rng.next_u32()` at the top of
/// `generate()` shifts every downstream value while leaving those tests green.
///
/// If this test fails, generation output changed. That is either a bug (a
/// stray draw, a reordered step, a changed constant) or a deliberate spec
/// change — in which case update these constants **in the same commit that
/// changes generation**, and say so in the message. Never update them to make
/// a red build green without knowing which draw moved.
///
/// Covers all three scales because pocket count and dimensions differ per
/// scale, so a scale-dependent bug could hide behind a single-scale anchor.
const GOLDEN_MAPS: [(u64, Scale, u64); 3] = [
    (1, Scale::Small, 0x039d_4c59_5fd7_27b6),
    (42, Scale::Medium, 0x9390_d21e_8a8f_d460),
    (12345, Scale::Large, 0x1c23_0dca_543b_d713),
];

#[test]
fn generation_matches_golden_hashes() {
    for (seed, scale, expected) in GOLDEN_MAPS {
        let map = Map::generate(seed, scale);
        let actual = golden_hash(&map);
        assert_eq!(
            actual,
            expected,
            "\ngeneration output changed for seed {seed} / {}.\n\
             expected 0x{expected:016x}, got 0x{actual:016x}\n\
             If this was intentional, update GOLDEN_MAPS in the same commit \
             that changed generation.",
            scale.as_str(),
        );
    }
}

/// The seed 1 / Small grid, pinned exactly.
///
/// T1.4 says "print an ASCII grid in a #[test] for seed 1, scale Small — keep
/// the test". Pinning it as a literal turns that debug aid into a real
/// regression anchor and doubles as the human-readable artefact: a reviewer can
/// diff this against the printed output and see *where* terrain changed, which
/// a hash cannot show.
const GOLDEN_SEED1_SMALL: &str = include_str!("golden/seed1_small.txt");

#[test]
fn seed1_small_ascii_dump_is_unchanged() {
    let map = Map::generate(1, Scale::Small);
    let actual = map.ascii_dump();
    if actual != GOLDEN_SEED1_SMALL {
        // Show the first differing row, so a failure is diagnosable.
        let mismatch = actual
            .lines()
            .zip(GOLDEN_SEED1_SMALL.lines())
            .enumerate()
            .find(|(_, (a, b))| a != b);
        if let Some((row, (got, want))) = mismatch {
            panic!(
                "seed 1 / Small terrain changed, first difference at row {row}:\n\
                 want: {want}\n got: {got}",
            );
        }
        panic!(
            "seed 1 / Small terrain changed (line count {} vs {})",
            actual.lines().count(),
            GOLDEN_SEED1_SMALL.lines().count(),
        );
    }
}

/// Helper, not a check. Prints the current constants so a deliberate
/// generation change can be re-pinned:
///   cargo test -p game-core --test determinism print_golden -- --ignored --nocapture
#[test]
#[ignore = "helper: prints golden constants for GOLDEN_MAPS"]
fn print_golden_hashes() {
    for (seed, scale, _) in GOLDEN_MAPS {
        println!(
            "    ({}, Scale::{:?}, 0x{:016x}),",
            seed,
            scale,
            golden_hash(&Map::generate(seed, scale))
        );
    }
}

// ---------------------------------------------------------------------------
// Round-start item placement (T3.3)
// ---------------------------------------------------------------------------

/// Golden hash over the round's placed items.
///
/// `generation_matches_golden_hashes` covers `Map::generate` only. Item
/// placement is a SEPARATE round-start step (docs/04 §6 steps 4–5), so adding
/// `Tile.item` to `golden_hash` did not anchor it — placement was
/// determinism-critical and unpinned. This closes that gap.
///
/// The other placement tests compare the code against itself (same seed twice,
/// or a hand-reconstructed draw sequence); only a literal can fail when the
/// algorithm changes.
fn placement_hash(items: &[GroundItem], hidden: &[(u32, u32, ItemId)]) -> u64 {
    let mut h = Fnv1a::new();
    for item in items {
        h.u32(item.id);
        h.bytes(item.item.as_str().as_bytes());
        h.f32(item.x);
        h.f32(item.y);
        h.byte(u8::from(item.is_crate));
        h.byte(u8::from(item.hidden));
    }
    for (x, y, item) in hidden {
        h.u32(*x);
        h.u32(*y);
        h.bytes(item.as_str().as_bytes());
    }
    h.finish()
}

/// Place sources A and B for a seed, in the docs/04 §6 order.
///
/// NOTE: steps 2 (shuffle spawns) and 3 (effect schedule) of that order are
/// not implemented yet — they land in T4.1 and T4.8. When they do, they will
/// consume draws BEFORE placement and these constants must be re-pinned in the
/// same commit. That is expected, not a regression.
fn place_round_items(seed: u64, scale: Scale) -> (Vec<GroundItem>, Vec<(u32, u32, ItemId)>) {
    let mut map = Map::generate(seed, scale);
    let mut rng = GameRng::new(seed);
    let mut ids = ItemIdCounter::default();
    let ground = place_initial(&map, &mut rng, &mut ids);
    let hidden = place_hidden(&mut map, &mut rng);
    (ground, hidden)
}

const GOLDEN_PLACEMENTS: [(u64, Scale, u64); 3] = [
    (1, Scale::Small, 0xacad_76a7_2f46_8258),
    (42, Scale::Medium, 0x0330_e347_3d94_df22),
    (12345, Scale::Large, 0xaa46_412c_3331_d915),
];

#[test]
fn item_placement_matches_golden_hashes() {
    for (seed, scale, expected) in GOLDEN_PLACEMENTS {
        let (ground, hidden) = place_round_items(seed, scale);
        assert_eq!(ground.len(), 10, "source A should place 10 items");
        assert_eq!(hidden.len(), 4, "source B should hide 4 items");
        let actual = placement_hash(&ground, &hidden);
        assert_eq!(
            actual, expected,
            "\nitem placement changed for seed {seed} / {}.\n\
             expected 0x{expected:016x}, got 0x{actual:016x}\n\
             If deliberate, update GOLDEN_PLACEMENTS in the same commit.",
            scale.as_str(),
        );
    }
}

/// Helper, not a check. Prints the current constants for re-pinning:
///   cargo test -p game-core --test determinism print_placement -- --ignored --nocapture
#[test]
#[ignore = "helper: prints golden constants for GOLDEN_PLACEMENTS"]
fn print_placement_hashes() {
    for (seed, scale, _) in GOLDEN_PLACEMENTS {
        let (ground, hidden) = place_round_items(seed, scale);
        println!(
            "    ({}, Scale::{:?}, 0x{:016x}),",
            seed,
            scale,
            placement_hash(&ground, &hidden)
        );
    }
}
