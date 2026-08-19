//! Golden mask hashes: a regression detector, not a specification.
//!
//! Any unintended change to the generator breaks this loudly. When a change is
//! intentional, regenerate with:
//!
//! ```sh
//! GOLDEN_UPDATE=1 cargo test -p game-core --release --test golden
//! ```
//!
//! and say so explicitly in the report — the entire value of the table is that an
//! *unintentional* change cannot pass silently.

use std::fmt::Write as _;
use std::path::PathBuf;

use game_core::constants::MapScale;
use game_core::map::gen::generate_terrain;
use game_core::map::generate;

fn table_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden_hashes.txt")
}

/// The 12 fixed pairs the table covers.
fn cases() -> Vec<(u64, MapScale)> {
    let mut v = Vec::new();
    for &seed in &[1u64, 4242, 31337, 8123491234] {
        for scale in MapScale::ALL {
            v.push((seed, scale));
        }
    }
    v
}

/// A stable digest of everything in `MapMeta` that gameplay depends on.
///
/// The mask hash alone cannot catch a metadata regression, and one class of bug
/// lives entirely here: the largest-component tie-break used to come out of a
/// `HashMap`, so the *same mask* could yield different spawn points in different
/// processes (`docs/70` §A11). Hashing spawns, buried slots and the component size
/// is what makes that visible.
fn meta_digest(seed: u64, scale: MapScale) -> String {
    let map = generate(seed, scale);
    let m = &map.meta;
    let mut h = blake3::Hasher::new();
    h.update(&m.theme.to_le_bytes());
    h.update(&m.wind.to_le_bytes());
    h.update(&m.attempts.to_le_bytes());
    h.update(&[m.used_safe_preset as u8]);
    h.update(&(m.spawn_points.len() as u32).to_le_bytes());
    for p in &m.spawn_points {
        h.update(&p.x.to_le_bytes());
        h.update(&p.y.to_le_bytes());
    }
    h.update(&(m.buried_slots.len() as u32).to_le_bytes());
    for b in &m.buried_slots {
        h.update(&b.pos.x.to_le_bytes());
        h.update(&b.pos.y.to_le_bytes());
    }
    h.update(&(m.surface_points.len() as u32).to_le_bytes());
    h.update(&(m.largest_component.len() as u32).to_le_bytes());
    h.finalize().to_hex()[..16].to_string()
}

fn compute() -> String {
    let mut out = String::new();
    out.push_str("# seed scale blake3(mask) blake3(meta)\n");
    out.push_str("# regenerate: GOLDEN_UPDATE=1 cargo test -p game-core --release --test golden\n");
    for (seed, scale) in cases() {
        let o = generate_terrain(seed, scale);
        let _ = writeln!(
            out,
            "{seed} {} {} {}",
            scale.as_str(),
            o.mask.hash_hex(),
            meta_digest(seed, scale)
        );
    }
    out
}

#[test]
fn generated_masks_match_the_golden_table() {
    let current = compute();

    if std::env::var("GOLDEN_UPDATE").is_ok() {
        std::fs::write(table_path(), &current).expect("write golden table");
        println!("golden table rewritten at {}", table_path().display());
        return;
    }

    let expected = match std::fs::read_to_string(table_path()) {
        Ok(s) => s,
        Err(e) => panic!(
            "golden table missing ({e}). Create it with:\n  \
             GOLDEN_UPDATE=1 cargo test -p game-core --release --test golden"
        ),
    };

    if current != expected {
        // Show the first differing line rather than dumping both files.
        for (i, (a, b)) in expected.lines().zip(current.lines()).enumerate() {
            if a != b {
                panic!(
                    "golden mismatch at line {}:\n  expected: {a}\n  actual:   {b}\n\n\
                     If this change is intentional, regenerate with:\n  \
                     GOLDEN_UPDATE=1 cargo test -p game-core --release --test golden\n  \
                     and say so in the report.",
                    i + 1
                );
            }
        }
        panic!(
            "golden table differs in length: expected {} lines, got {}",
            expected.lines().count(),
            current.lines().count()
        );
    }
}
