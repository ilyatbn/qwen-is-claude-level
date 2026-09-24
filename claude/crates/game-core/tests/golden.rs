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

use game_core::constants::{MapGenerator, MapScale};
use game_core::map::gen::generate_terrain_with;
use game_core::map::generate_with;

fn table_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden_hashes.txt")
}

/// The 36 fixed cases the table covers: 4 seeds x 3 scales x **every**
/// generator.
///
/// **Every** generator, not just the default. v1 is still shipped behind
/// `MAP_GENERATOR=v1`, and a table that only pinned whichever one happens to be
/// the default would silently stop guarding the other the moment the default
/// moved — which is exactly what happened when v2 landed.
///
/// **It was 24 until `MapGenerator::Space` joined `ALL`** (`T22.05A`, R15), and
/// the twelve new rows cost nothing to write because this function iterates the
/// list. That is the whole reason the space map is a third variant rather than a
/// `GravityMode` branch inside an existing generator: the branch would have
/// gained this table nothing, and the space generator would have shipped with
/// **zero** golden coverage while `T22.05A`'s "most important test" — *existing
/// hashes unchanged when the mode is off* — stayed green for a build in which
/// the generator was never called.
fn cases() -> Vec<(u64, MapScale, MapGenerator)> {
    let mut v = Vec::new();
    for generator in MapGenerator::ALL {
        for &seed in &[1u64, 4242, 31337, 8123491234] {
            for scale in MapScale::ALL {
                v.push((seed, scale, generator));
            }
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
fn meta_digest(seed: u64, scale: MapScale, generator: MapGenerator) -> String {
    let map = generate_with(seed, scale, generator);
    let m = &map.meta;
    let mut h = blake3::Hasher::new();
    h.update(&m.theme.to_le_bytes());
    h.update(&m.wind.to_le_bytes());
    h.update(&m.attempts.to_le_bytes());
    h.update(&[m.used_safe_preset as u8]);
    // Objects are gameplay: they are collision, they move spawns, and they are
    // what the client draws (§D1, §D6). A digest that skipped them would let 6b
    // change silently on any seed whose mask hash happened not to move.
    h.update(&(m.objects.len() as u32).to_le_bytes());
    for o in &m.objects {
        h.update(&o.id.to_le_bytes());
        h.update(&o.x.to_le_bytes());
        h.update(&o.y.to_le_bytes());
        h.update(&[o.flip as u8]);
    }
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
    // **T21.28: the pads, the gun platforms and the finished mask.** Everything
    // above is terrain or chosen before the pads, and the mask column of the table
    // is `generate_terrain_with`'s — the mask *before* pass 8. So until this block
    // a change that moved every pad, every platform, or anything pass 8 stamps
    // into the rock left the table green; measured by planting a 1 px pad offset,
    // which passed. Pads and platforms are gameplay (where you respawn, what you
    // mount) and the finished mask is what the client collides with.
    h.update(&(m.teleport_pads.len() as u32).to_le_bytes());
    for p in &m.teleport_pads {
        h.update(&p.pos.x.to_le_bytes());
        h.update(&p.pos.y.to_le_bytes());
    }
    h.update(&(m.gun_platforms.len() as u32).to_le_bytes());
    for g in &m.gun_platforms {
        h.update(&g.pos.x.to_le_bytes());
        h.update(&g.pos.y.to_le_bytes());
    }
    // **T22.05A: the asteroids, and only when there are any.** The mask carries
    // a rock's *shape*; nothing but `level` carries its *pull*, so a digest that
    // skipped this field would let the whole level assignment change with every
    // row still green — the shape this file's own T21.28 note is about.
    //
    // Guarded on non-empty so the 24 rows that predate the space map do not
    // move: for v1 and v2 the list is always empty, so hashing nothing and
    // hashing a zero length are the same claim about them, and only one of the
    // two keeps *existing golden hashes unchanged when the mode is off*. If a
    // v1 or v2 map ever did grow asteroids, its digest would move — which is
    // what you want.
    if !m.asteroids.is_empty() {
        h.update(&(m.asteroids.len() as u32).to_le_bytes());
        for a in &m.asteroids {
            h.update(&a.x.to_le_bytes());
            h.update(&a.y.to_le_bytes());
            h.update(&a.r.to_le_bytes());
            h.update(&[a.level]);
        }
    }
    h.update(map.mask.hash_hex().as_bytes());
    h.finalize().to_hex()[..16].to_string()
}

fn compute() -> String {
    let mut out = String::new();
    out.push_str("# generator seed scale blake3(mask) blake3(meta)\n");
    out.push_str("# regenerate: GOLDEN_UPDATE=1 cargo test -p game-core --release --test golden\n");
    for (seed, scale, generator) in cases() {
        let o = generate_terrain_with(seed, scale, generator);
        let _ = writeln!(
            out,
            "{} {seed} {} {} {}",
            generator.as_str(),
            scale.as_str(),
            o.mask.hash_hex(),
            meta_digest(seed, scale, generator)
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

// --- The weather schedule (T22.08C F2) -----------------------------------------

fn weather_table_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden_weather.txt")
}

/// **Every effect a standard round starts, as (tick, kind, seed)**, for three
/// seeds over a 1200 s round, through `World::step` — the live path, table read
/// off the map and all.
///
/// Why a golden and not a comparison: T22.08A's
/// `the_flare_does_not_move_the_grounds_schedule` compared the shipped ground
/// table against the ground table with the flare switched off — both sides ran
/// the same `roll_kind`, so an extra RNG draw planted there moved both together
/// and every test stayed green (the review of `9535325`). A table recorded
/// **before** the flare existed (`9535325^`, built in a scratch worktree) is the
/// only thing that can say the ground's weather did not move. An extra draw
/// shifts every later seed and interval, so the first differing line is where it
/// landed.
fn compute_weather() -> String {
    use game_core::constants::{GravityMode, DEFAULT_MAP_GENERATOR, SIM_DT};
    use game_core::world::{GameEvent, RoundPhase, World};
    const ROUND: f32 = 1200.0;
    let mut out = String::new();
    out.push_str("# seed tick kind effect-seed — standard mode, 1200 s round\n");
    out.push_str(
        "# regenerated at 4dfc5a5 (T22.12D, R94: rounds counted in ticks); regenerate only on an\n",
    );
    out.push_str(
        "# T22.14A H3 removed one row: a shower's Active covers its fall (METEOR_FALL_TIME), so\n",
    );
    out.push_str(
        "# seed 90210's last shower, rolled 24.2 s before the bell, no longer fits the round\n",
    );
    out.push_str("# intended schedule change: GOLDEN_UPDATE=1 cargo test -p game-core --release --test golden\n");
    for seed in [1u64, 4242, 90210] {
        let mut w = World::with_gravity(
            seed,
            MapScale::Medium,
            0,
            DEFAULT_MAP_GENERATOR,
            GravityMode::Standard,
        );
        w.set_round_seconds(ROUND);
        w.set_phase(RoundPhase::Playing);
        for _ in 0..(ROUND / SIM_DT) as u32 {
            w.step(SIM_DT);
            for e in w.drain_events() {
                if let GameEvent::EffectStart {
                    tick,
                    kind,
                    seed: s,
                    ..
                } = e
                {
                    let _ = writeln!(out, "{seed} {tick} {kind:?} {s}");
                }
            }
        }
    }
    out
}

#[test]
fn the_standard_weather_schedule_matches_the_golden_table() {
    let current = compute_weather();
    if std::env::var("GOLDEN_UPDATE").is_ok() {
        std::fs::write(weather_table_path(), &current).expect("write weather table");
        return;
    }
    let expected = std::fs::read_to_string(weather_table_path()).expect("golden_weather.txt");
    // The control: the table holds a real schedule, not a header.
    let rows = expected.lines().filter(|l| !l.starts_with('#')).count();
    assert!(rows >= 60, "the golden weather table has only {rows} rows");
    for (i, (a, b)) in expected.lines().zip(current.lines()).enumerate() {
        assert_eq!(a, b, "golden weather mismatch at line {}", i + 1);
    }
    assert_eq!(
        expected.lines().count(),
        current.lines().count(),
        "golden weather table differs in length"
    );
}
