//! The generation pipeline, one module per pass.
//!
//! ```text
//! 1 preset → 2 silhouette → 3 islands → 3b bridges → 4 cave network
//!         → 4b crevices → 4c voids → 5 smoothing → 6 cleanup → 6b objects
//!         → 7 validation → 8 metadata
//! ```
//!
//! Every pass draws from its own RNG sub-stream, so tuning one never disturbs
//! another (`docs/10-map-generation.md` §2). Order is from
//! `docs/70-amendments-v2.md` §A2.

pub mod blobs;
pub mod bridges;
pub mod carvings;
pub mod caves;
pub mod components;
pub mod network;
pub mod objects;
pub mod silhouette;
pub mod smooth;
pub mod space;
pub mod spawns;
pub mod surface;
pub mod traversal;
pub mod v2;

pub use silhouette::{borders_hold, force_borders, solid_fraction, GenParams};

use crate::constants::{MapGenerator, MapScale, DEFAULT_MAP_GENERATOR, MAX_GEN_ATTEMPTS};
use crate::map::Mask;
use crate::math::Point;
use components::SealedPocket;
use traversal::TraversalReport;

/// Everything passes 1–7 produced. Pass 8 (`map::meta`) turns this into a `Map`.
#[derive(Debug)]
pub struct GenOutcome {
    pub mask: Mask,
    pub surface: Vec<Point>,
    pub report: TraversalReport,
    /// The spawn points this generator chose for itself, or **empty** when it
    /// leaves the choice to pass 8 (`T22.05B`).
    ///
    /// v1 and v2 leave it empty: their spawns come from `spawns::choose_spawns`
    /// over the traversable component, which does not exist until
    /// `traversal::analyse` has run and which pass 8 filters against the
    /// objects. Space fills it, because in space a spawn is a point in **open
    /// space** rather than on standable ground, and because the verdict has to
    /// be about the list that ships rather than about a count of a list thrown
    /// away (`M22-RULINGS` R35).
    ///
    /// **One list, two consumers.** `analyse_space` is handed this and
    /// `generate_full_with` ships this; there is no second call to the picker
    /// that could return something else.
    pub spawn_points: Vec<Point>,
    pub sealed_pockets: Vec<SealedPocket>,
    /// Every stamped tunnel, chamber-edge, entrance and crevice centre. T1.13
    /// places buried slots near these.
    pub tunnel_paths: Vec<Vec<Point>>,
    /// Island centres, for decoration and debugging.
    pub islands: Vec<Point>,
    /// `MapGenerator::Space`'s rocks: where they are, how big, and how hard
    /// each one pulls (`T22.05A`, `M22-RULINGS` R13).
    ///
    /// **Empty for every other generator**, which is what lets the golden meta
    /// digest fold it in without moving the 24 rows that existed before the
    /// space map did — see `tests/golden.rs::meta_digest`.
    pub asteroids: Vec<crate::map::meta::Asteroid>,
    /// Scenery stamped at pass 6b (§D5). Carried out so pass 8 can keep spawns
    /// clear of it and the client can draw the art (§D6).
    pub objects: Vec<objects::PlacedObject>,
    /// The seed that actually produced this map.
    pub seed: u64,
    pub requested_seed: u64,
    pub attempts: u8,
    pub used_safe_preset: bool,
    /// Which generator produced this. Carried so a dump, a log line or a test can
    /// say which of the two it is looking at without being told.
    pub generator: MapGenerator,
    /// `T23.05B` (M23 R17): everything that **was rock in the generator's landform** —
    /// the mask as it stood before the first carve pass, OR'd with the mask this
    /// outcome ships. So `landform ∧ ¬mask` is exactly the rock the carve passes
    /// took out and nothing refilled: the generated caves, which the M23 renderer
    /// draws as cave wall. **Render data, never read by the simulation**, and not part
    /// of `Map` — `tests/golden.rs` cannot see it. A space map carves nothing, so there
    /// it equals `mask`.
    pub landform: Mask,
}

/// `a |= b`, word for word; same dimensions (asserted — both come from one params).
fn union_into(a: &mut Mask, b: &Mask) {
    assert_eq!((a.w, a.h), (b.w, b.h), "landform and mask differ in size");
    for (x, y) in a.words_mut().iter_mut().zip(b.words()) {
        *x |= *y;
    }
}

/// The landform of a finished attempt: the pre-carve mask OR'd with the final one.
pub(crate) fn landform_of(mut pre_carve: Mask, mask: &Mask) -> Mask {
    union_into(&mut pre_carve, mask);
    pre_carve
}

/// One attempt, no retry. Exposed for tests and for the PNG dump.
///
/// Runs the v2 pipeline in the order `docs/70-amendments-v2.md` §A2 specifies:
/// silhouette → islands → bridges → cave network → free tunnels → crevices →
/// voids → smoothing → cleanup → surface → validation.
pub fn generate_once(seed: u64, params: &GenParams) -> GenOutcome {
    let mut mask = silhouette::silhouette(seed, params);

    let islands = blobs::add_blobs(&mut mask, seed, params);
    bridges::add_bridges(&mut mask, seed, params, &islands);

    // T23.05B: the landform, before any pass removes rock.
    let pre_carve = mask.clone();
    let net = network::carve_network(&mut mask, seed, params);
    let mut tunnel_paths = net.paths;
    tunnel_paths.extend(caves::carve_caves(&mut mask, seed, params));
    tunnel_paths.extend(carvings::carve_crevices(&mut mask, seed, params));
    carvings::carve_voids(&mut mask, seed, params);

    smooth::smooth(&mut mask);
    let sealed_pockets = components::cleanup(&mut mask);

    // Pass 6b (§D3): after cleanup, before surface extraction and validation.
    let placement = objects::stamp_objects(&mut mask, seed, params.scale, params.theme);

    let surface = surface::extract_surface(&mask);
    let report = traversal::analyse(&mask, &surface, &placement.objects);
    let landform = landform_of(pre_carve, &mask);

    GenOutcome {
        landform,
        mask,
        surface,
        report,
        spawn_points: Vec::new(),
        sealed_pockets,
        tunnel_paths,
        islands,
        objects: placement.objects,
        asteroids: Vec::new(),
        seed,
        requested_seed: seed,
        attempts: 1,
        used_safe_preset: false,
        generator: MapGenerator::V1,
    }
}

/// Passes 1–7 with retries. **Never fails** — the safe preset is the floor.
///
/// The safe-preset result is returned even if it also fails validation: a round has
/// to start. `used_safe_preset` and `report.passed` are both in the outcome, so the
/// server can log a warning and tests can assert this never happens in practice. A
/// `Result` here would push an unhandleable error up into the room loop.
///
/// Does no logging — `game-core` is pure. The server logs from these fields.
pub fn generate_terrain(requested_seed: u64, scale: MapScale) -> GenOutcome {
    generate_terrain_with(requested_seed, scale, DEFAULT_MAP_GENERATOR)
}

/// `generate_terrain` against a named generator.
///
/// The two are kept side by side so the same seed can be rendered both ways —
/// `tests/dump_maps.rs` writes a v1 and a v2 PNG per seed. Everything downstream
/// of this function (spawns, buried slots, decorations, the traversal gate) is
/// shared, so the only thing that varies is the mask.
pub fn generate_terrain_with(
    requested_seed: u64,
    scale: MapScale,
    generator: MapGenerator,
) -> GenOutcome {
    match generator {
        MapGenerator::V1 => generate_terrain_v1(requested_seed, scale),
        MapGenerator::V2 => v2::generate_terrain(requested_seed, scale),
        // **The one branching site in the project** (R15). `MapScale` branches
        // nothing; it is a size/parameter table. Reaching the space map any
        // other way — a `GravityMode` arm inside v2, say — would gain
        // `tests/golden.rs::cases()` nothing and ship the generator with zero
        // golden coverage.
        MapGenerator::Space => space::generate_terrain(requested_seed, scale),
    }
}

/// Re-run **the verdict that produced this outcome**, against a mask that has
/// changed since.
///
/// Pass 8 fills ground under the teleport pads and gun platforms and then has to
/// re-derive the surface and the report. v1, v2 and space do not share a
/// predicate, and calling `traversal::analyse` unconditionally there would
/// silently swap a space map's verdict for a walking one — the outcome would say
/// `passed` on space terms and `MapMeta` would carry a walk fraction, which is
/// the field-means-two-things shape at the one place the two can disagree.
///
/// Written here, beside the `match` it mirrors, so a fourth generator cannot
/// gain an arm in one and not the other.
pub fn reanalyse(
    generator: MapGenerator,
    mask: &Mask,
    surface: &[Point],
    objects: &[objects::PlacedObject],
    asteroids: &[crate::map::meta::Asteroid],
    spawn_points: &[Point],
) -> TraversalReport {
    match generator {
        MapGenerator::V1 | MapGenerator::V2 => traversal::analyse(mask, surface, objects),
        MapGenerator::Space => space::analyse_space(
            mask,
            surface,
            asteroids,
            &space::SpaceGeometry::for_dims(mask.w, mask.h),
            spawn_points,
        ),
    }
}

/// Re-derive the surface **the way this generator derives it**, from a mask
/// that has changed since.
///
/// `reanalyse`'s sibling, and here for the same reason: pass 8's ground fill
/// invalidates the surface, `game-wasm`'s `load_mask` re-extracts it from the
/// mask that arrives over the wire, and both of them used to call
/// `surface::extract_surface` outright. That is right for v1 and v2 and wrong
/// for space, where `extract_surface` also returns the full-width floor crust —
/// which lies **outside the rim**, in the band R16 kills you in (R35). A space
/// map's surface is the arena's, and this is the one spelling of that.
///
/// Written beside the `match` it mirrors so a fourth generator cannot gain an
/// arm in one and not the other.
pub fn surface_for(generator: MapGenerator, mask: &Mask) -> Vec<Point> {
    match generator {
        MapGenerator::V1 | MapGenerator::V2 => surface::extract_surface(mask),
        MapGenerator::Space => {
            space::arena_surface(mask, &space::SpaceGeometry::for_dims(mask.w, mask.h))
        }
    }
}

/// `T23.05B`: **re-run the generator from `map_init`'s own fields** — the seed the
/// map was actually generated from (`MapMeta.seed`, the attempt that passed, not the
/// requested one), its scale, generator and theme byte — and return the outcome that
/// produced the map. The client has only those fields; this is how it gets
/// [`GenOutcome::landform`] without a second RLE on the wire (R3: nothing on the wire
/// changes).
///
/// **Exact, not approximate, and the reason is the retry loop's shape.** Every
/// generator's `generate_terrain` tries `requested + k` with its default params and
/// returns the first attempt whose `report.passed`; failing all of them it runs the
/// *safe* preset at `requested`. So the seed a map carries was either a passing
/// default attempt — and the default attempt at that seed passes again, the pipeline
/// being deterministic — or the safe preset's, in which case the default attempt at
/// that seed (attempt 0) is one that *failed*. The default's verdict therefore says
/// which of the two produced the map, and no field needs adding. The theme is the one
/// other input (`theme_for(requested)`, which pass 6b stamps and the verdict reads);
/// `map_init` carries it.
///
/// Cost: one generation, two when the safe preset shipped (never, in every sweep so
/// far). Measured in `rederive_timing` (T23.05B's journal line).
pub fn rederive(seed: u64, scale: MapScale, generator: MapGenerator, theme: u8) -> GenOutcome {
    match generator {
        MapGenerator::V1 => {
            let mut p = GenParams::default_for(scale);
            p.theme = theme;
            let o = generate_once(seed, &p);
            if o.report.passed {
                return o;
            }
            let mut safe = GenParams::safe_for(scale);
            safe.theme = theme;
            generate_once(seed, &safe)
        }
        MapGenerator::V2 => {
            let mut p = v2::V2Params::default_for(scale);
            p.theme = theme;
            let o = v2::generate_once(seed, &p);
            if o.report.passed {
                return o;
            }
            let mut safe = v2::V2Params::safe_for(scale);
            safe.theme = theme;
            v2::generate_once(seed, &safe)
        }
        MapGenerator::Space => {
            let o = space::generate_once(seed, &space::SpaceParams::default_for(scale));
            if o.report.passed {
                return o;
            }
            space::generate_once(seed, &space::SpaceParams::safe_for(scale))
        }
    }
}

fn generate_terrain_v1(requested_seed: u64, scale: MapScale) -> GenOutcome {
    let mut params = GenParams::default_for(scale);
    params.theme = crate::map::meta::theme_for(requested_seed);

    for attempt in 0..MAX_GEN_ATTEMPTS {
        let seed = requested_seed.wrapping_add(attempt as u64);
        let mut outcome = generate_once(seed, &params);
        if outcome.report.passed {
            outcome.requested_seed = requested_seed;
            outcome.attempts = attempt + 1;
            return outcome;
        }
    }

    let mut safe = GenParams::safe_for(scale);
    safe.theme = params.theme;
    let mut outcome = generate_once(requested_seed, &safe);
    outcome.requested_seed = requested_seed;
    outcome.attempts = MAX_GEN_ATTEMPTS;
    outcome.used_safe_preset = true;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{FLOOR_CRUST, SKY_MARGIN};

    #[test]
    fn generate_once_is_deterministic() {
        let p = GenParams::default_for(MapScale::Small);
        let first = generate_once(4242, &p);
        for _ in 0..20 {
            let again = generate_once(4242, &p);
            assert_eq!(again.mask.hash(), first.mask.hash());
            assert_eq!(again.surface, first.surface);
            assert_eq!(again.report, first.report);
            assert_eq!(again.sealed_pockets, first.sealed_pockets);
        }
    }

    #[test]
    fn generate_terrain_is_deterministic() {
        let first = generate_terrain(8123, MapScale::Small);
        for _ in 0..20 {
            let again = generate_terrain(8123, MapScale::Small);
            assert_eq!(again.mask.hash(), first.mask.hash());
            assert_eq!(again.seed, first.seed);
            assert_eq!(again.attempts, first.attempts);
        }
    }

    #[test]
    fn the_returned_seed_reflects_the_attempt_that_succeeded() {
        let o = generate_terrain(555, MapScale::Small);
        if !o.used_safe_preset {
            assert_eq!(
                o.seed,
                o.requested_seed + o.attempts as u64 - 1,
                "seed must be requested_seed + attempts - 1"
            );
        }
    }

    #[test]
    fn every_scale_produces_the_right_dimensions_with_borders_intact() {
        for scale in MapScale::ALL {
            let o = generate_terrain(99, scale);
            let p = scale.params();
            assert_eq!((o.mask.w, o.mask.h), (p.width, p.height), "{scale:?}");
            assert!(borders_hold(&o.mask), "{scale:?} borders");

            let (w, h) = (o.mask.w as i32, o.mask.h as i32);
            for y in 0..SKY_MARGIN as i32 {
                assert_eq!(o.mask.count_run(y, 0, w - 1), 0, "{scale:?} sky row {y}");
            }
            for y in (h - FLOOR_CRUST as i32)..h {
                assert_eq!(
                    o.mask.count_run(y, 0, w - 1),
                    w as u32,
                    "{scale:?} floor crust row {y}"
                );
            }
        }
    }

    #[test]
    fn a_typical_map_has_pockets_and_tunnels_for_buried_items() {
        // T1.13 needs both to place buried slots near something interesting.
        let o = generate_terrain(4242, MapScale::Medium);
        assert!(!o.tunnel_paths.is_empty(), "no tunnel paths");
        assert!(
            o.tunnel_paths.iter().any(|p| p.len() > 3),
            "tunnel paths are all stubs"
        );
    }

    #[test]
    fn the_safe_preset_is_returned_even_if_it_fails() {
        // Generation must never fail: a round has to start. Drive the safe path
        // directly and check the shape of the result.
        let mut o = generate_once(1, &GenParams::safe_for(MapScale::Small));
        o.used_safe_preset = true;
        assert!(o.mask.w > 0 && !o.surface.is_empty());
    }

    /// T23.05B: `map_init`'s fields (the meta's seed — the attempt that passed —
    /// scale, generator, theme) re-run the generator to **the server's outcome**,
    /// mask and landform alike, on every generator and scale. The sweep must include
    /// maps that retried, or the seed-is-the-actual-one half is untested.
    /// Timings are printed (`--release -- --nocapture` for the journal), not gated.
    #[test]
    fn map_init_fields_rederive_the_servers_landform() {
        use crate::map::meta::{generate_full, theme_for};
        // One thread per (generator, scale): V1 Large is ~0.8 s a generation in release.
        let combos: Vec<(MapGenerator, MapScale)> =
            [MapGenerator::V1, MapGenerator::V2, MapGenerator::Space]
                .into_iter()
                .flat_map(|g| MapScale::ALL.into_iter().map(move |s| (g, s)))
                .collect();
        let retried: usize = std::thread::scope(|sc| {
            let hs: Vec<_> = combos
                .iter()
                .map(|&(generator, scale)| {
                    sc.spawn(move || {
                        let (mut retried, mut worst_ms) = (0usize, 0f64);
                        for k in 0..8u64 {
                            let requested = k * 7919 + 13;
                            let at = format!("{generator:?} {scale:?} requested {requested}");
                            let server = generate_terrain_with(requested, scale, generator);
                            retried += usize::from(server.attempts > 1);
                            // What `map_init` carries (`codec.rs::encode_map_init_at`):
                            // `meta.seed`, `meta.theme`. Built from the full pipeline on
                            // two seeds per combo (it is a third generation), and from
                            // the outcome's own fields — which is what `meta` copies —
                            // on the rest.
                            let (seed, theme) = if k < 2 {
                                let map = generate_full(requested, scale, k ^ 0x5eed, generator);
                                assert_eq!(map.meta.generator, generator, "{at}");
                                assert_eq!(map.meta.scale, scale, "{at}");
                                // Pass 8 only adds rock (the ground fill): everything the
                                // generator's mask has, the shipped one has.
                                let mut both = map.mask.clone();
                                union_into(&mut both, &server.mask);
                                assert_eq!(both, map.mask, "{at}: pass 8 removed rock?");
                                (map.meta.seed, map.meta.theme)
                            } else {
                                (server.seed, theme_for(requested))
                            };
                            let t = std::time::Instant::now();
                            let d = rederive(seed, scale, generator, theme);
                            worst_ms = worst_ms.max(t.elapsed().as_secs_f64() * 1e3);
                            assert_eq!(d.mask, server.mask, "{at}: mask");
                            assert_eq!(d.landform, server.landform, "{at}: landform");
                        }
                        println!("rederive {generator:?} {scale:?}: worst {worst_ms:.0} ms");
                        retried
                    })
                })
                .collect();
            hs.into_iter()
                .map(|h| h.join().expect("combo thread"))
                .sum()
        });
        assert!(
            retried > 0,
            "no map in the sweep retried — the actual-seed path is untested"
        );
        println!("maps that retried: {retried}");
    }

    /// Control for the test above: the *requested* seed does not reproduce a retried
    /// map, so carrying the actual one is load-bearing, not a coincidence.
    #[test]
    fn the_requested_seed_does_not_rederive_a_retried_map() {
        let (requested, o) = (0..64u64)
            .map(|k| {
                (
                    k * 7919 + 13,
                    generate_terrain(k * 7919 + 13, MapScale::Small),
                )
            })
            .find(|(_, o)| o.attempts > 1)
            .expect("a retried Small map in 64 seeds");
        let theme = crate::map::meta::theme_for(requested);
        let wrong = rederive(requested, MapScale::Small, o.generator, theme);
        assert_ne!(wrong.mask, o.mask);
        assert_eq!(
            rederive(o.seed, MapScale::Small, o.generator, theme).mask,
            o.mask
        );
    }

    /// R17's premise: the landform holds every px of the map, and on every scale and
    /// both carving generators the carve passes left caves (`landform ∧ ¬mask`) — 20
    /// seeds, one attempt each (the retry loop is the test above's business), threads
    /// over quarters of the seeds. Space carves nothing (landform = mask, the control).
    #[test]
    fn the_landform_covers_the_mask_and_holds_the_caves() {
        let jobs: Vec<(MapGenerator, MapScale, u64)> = [MapGenerator::V1, MapGenerator::V2]
            .into_iter()
            .flat_map(|g| MapScale::ALL.into_iter().map(move |s| (g, s)))
            .flat_map(|(g, s)| (0..4u64).map(move |q| (g, s, q)))
            .collect();
        std::thread::scope(|sc| {
            for &(generator, scale, q) in &jobs {
                sc.spawn(move || {
                    for k in (q * 5)..(q * 5 + 5) {
                        let seed = k * 104_729 + 7;
                        let o = match generator {
                            MapGenerator::V2 => {
                                v2::generate_once(seed, &v2::V2Params::default_for(scale))
                            }
                            _ => generate_once(seed, &GenParams::default_for(scale)),
                        };
                        let at = format!("{generator:?} {scale:?} seed {seed}");
                        let mut both = o.landform.clone();
                        union_into(&mut both, &o.mask);
                        assert_eq!(both, o.landform, "{at}: landform ⊉ mask");
                        // The caves are **the carved tunnels**, not smoothing crumbs: most
                        // stamped tunnel centres are cave (`landform ∧ ¬mask`). A landform
                        // snapshotted after the carve passes leaves ~80 px from smoothing and
                        // cleanup and fails this; `caves > 0` alone did not.
                        let pts: Vec<_> = o.tunnel_paths.iter().flatten().collect();
                        let cave = |p: &&Point| o.landform.get(p.x, p.y) && !o.mask.get(p.x, p.y);
                        let hit = pts.iter().filter(|p| cave(p)).count();
                        assert!(
                            !pts.is_empty() && hit * 2 > pts.len(),
                            "{at}: {hit}/{} tunnel px are cave",
                            pts.len()
                        );
                    }
                });
            }
        });
        for scale in MapScale::ALL {
            let space = generate_terrain_with(4242, scale, MapGenerator::Space);
            assert_eq!(space.landform, space.mask, "space {scale:?}");
        }
    }

    /// The tuning gate. If this fails, the generation parameters need adjusting —
    /// report it rather than loosening the assertion.
    #[test]
    #[ignore = "slow in debug; run with --release --ignored"]
    fn fifty_medium_seeds_pass_without_the_safe_preset() {
        let mut attempts_hist = [0usize; 16];
        let mut worst = 1.0f32;
        let mut safe_preset = 0;

        for seed in 0..50u64 {
            let o = generate_terrain(seed * 7919 + 13, MapScale::Medium);
            attempts_hist[o.attempts as usize] += 1;
            worst = worst.min(o.report.traversable_fraction);
            if o.used_safe_preset {
                safe_preset += 1;
            }
        }

        println!("attempts histogram (index = attempts): {attempts_hist:?}");
        println!("worst traversable fraction: {worst:.3}");
        println!("safe preset used: {safe_preset}/50");

        assert_eq!(safe_preset, 0, "the safe preset should never be needed");
        let over_three: usize = attempts_hist[4..].iter().sum();
        assert_eq!(over_three, 0, "some seeds needed more than 3 attempts");
    }

    #[test]
    #[ignore = "slow in debug; run with --release --ignored"]
    fn medium_generation_is_under_a_second() {
        use std::time::Instant;
        let t = Instant::now();
        let o = generate_terrain(4242, MapScale::Medium);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "medium generate_terrain: {ms:.0} ms, {} attempts, fraction {:.3}",
            o.attempts, o.report.traversable_fraction
        );
        assert!(ms < 1000.0, "generation took {ms:.0} ms");
    }
}
