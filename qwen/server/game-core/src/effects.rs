//! `effects` — weather, toxic rain, meteors, lava, fog, day/night (docs/02).
//!
//! T4.1 needs [`EffectSchedule`] because docs/04 §6 puts "build effect
//! schedule" at step 3 of the round-start determinism order, before item
//! placement. The scheduler itself is T4.8; day/night is T4.2; the four
//! effects are T4.4–T4.7.

use crate::map::Map;
use crate::rng::GameRng;

/// docs/02 §7.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectKind {
    ToxicRain,
    MeteorShower,
    LavaBurst,
    HeavyFog,
}

impl EffectKind {
    /// Wire name (docs/06 §2 `effect_started.kind`). Snake_case per D15.
    pub const fn as_str(self) -> &'static str {
        match self {
            EffectKind::ToxicRain => "toxic_rain",
            EffectKind::MeteorShower => "meteor_shower",
            EffectKind::LavaBurst => "lava_burst",
            EffectKind::HeavyFog => "heavy_fog",
        }
    }
}

/// Day/night cycle length, seconds (docs/02 §1: "60 s day + 60 s night").
pub const CYCLE_S: f32 = 120.0;
/// Full-day window ends here (docs/02 §1: "day: c < 55 (full)").
pub const DAY_FULL_END_S: f32 = 55.0;
/// Night begins (docs/02 §1: "transition to night 55..60").
pub const NIGHT_START_S: f32 = 60.0;
/// Full-night window ends (docs/02 §1: "night: 60 <= c < 115").
pub const NIGHT_FULL_END_S: f32 = 115.0;

/// Day/night phase at round time `t` (docs/02 §1, T4.2 step 1).
///
/// `c = t mod 120`; 0 = full day, 1 = full night, with 5 s linear transitions
/// at each change.
pub fn day_phase(round_time_s: f32) -> f32 {
    let c = round_time_s.rem_euclid(CYCLE_S);
    if c < DAY_FULL_END_S {
        0.0
    } else if c < NIGHT_START_S {
        // 55 -> 60: day into night.
        (c - DAY_FULL_END_S) / (NIGHT_START_S - DAY_FULL_END_S)
    } else if c < NIGHT_FULL_END_S {
        1.0
    } else {
        // 115 -> 120: night back into day.
        1.0 - (c - NIGHT_FULL_END_S) / (CYCLE_S - NIGHT_FULL_END_S)
    }
}

// ---------------------------------------------------------------------------
// Toxic rain (T4.4, docs/02 §3)
// ---------------------------------------------------------------------------

/// Effect duration, seconds (docs/02 §2 table).
pub const TOXIC_DURATION_S: f32 = 8.0;
/// Spot count (docs/02 §3: "pick 5 random spots").
pub const TOXIC_SPOTS: usize = 5;
/// Spot radius, px (docs/02 §3).
pub const TOXIC_SPOT_RADIUS: f32 = 40.0;
/// How long each spot lasts, seconds (docs/02 §3), before the D4 clamp.
pub const TOXIC_SPOT_LIFE_S: f32 = 4.0;
/// Stagger between spots, seconds (docs/02 §3: "spot i starts at i*1.2 s").
pub const TOXIC_SPOT_STAGGER_S: f32 = 1.2;
/// Damage per second inside a spot (docs/02 §2, §3).
pub const TOXIC_DPS: f32 = 10.0;

/// One toxic-rain spot (docs/02 §3).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ToxicSpot {
    pub x: f32,
    pub y: f32,
    /// Seconds after effect start at which this spot becomes active.
    pub start_s: f32,
    /// Seconds after effect start at which it stops.
    ///
    /// **Clamped to the 8 s effect window** (DEVIATIONS.md D4): docs/02 §3
    /// gives every spot a 4 s life and staggers spot 4 to 4.8 s, which would
    /// run to 8.8 s, but T4.4 asserts "spot 4 ends at 8 s". The window wins,
    /// so spot 4 lives 3.2 s.
    pub end_s: f32,
}

impl ToxicSpot {
    pub fn active_at(&self, elapsed_s: f32) -> bool {
        elapsed_s >= self.start_s && elapsed_s < self.end_s
    }

    /// Seconds of life remaining, for the snapshot (docs/02 §3).
    pub fn remaining_s(&self, elapsed_s: f32) -> f32 {
        (self.end_s - elapsed_s).max(0.0)
    }
}

/// Choose the 5 spots for a toxic-rain effect (docs/02 §3, T4.4 step 1).
///
/// "pick 5 random spots (RNG) on solid ground (tile center of a random solid
/// tile, not AIR)".
pub fn build_toxic_spots(map: &Map, rng: &mut GameRng) -> Vec<ToxicSpot> {
    // Surface tiles are the solid tiles a player can actually stand on;
    // picking any solid tile would place most spots deep underground where no
    // player can be, making the effect mostly inert.
    let mut columns: Vec<u32> = (0..map.width)
        .filter(|&x| map.surface_row(x) < map.height)
        .collect();
    if columns.is_empty() {
        return Vec::new();
    }

    let mut spots = Vec::with_capacity(TOXIC_SPOTS);
    for index in 0..TOXIC_SPOTS {
        let pick = rng.gen_range(0, columns.len() as u32) as usize;
        let column = columns[pick];
        let row = map.surface_row(column);
        let centre = Map::tile_center(column, row);
        let start_s = index as f32 * TOXIC_SPOT_STAGGER_S;
        spots.push(ToxicSpot {
            x: centre.x,
            y: centre.y,
            start_s,
            // D4: clamp to the effect window.
            end_s: (start_s + TOXIC_SPOT_LIFE_S).min(TOXIC_DURATION_S),
        });
        let _ = &mut columns;
    }
    spots
}

/// Damage a player at `(px, py)` should take this tick from active spots
/// (docs/02 §3: "10 hp/s (applied per tick: 10 * dt)").
///
/// Overlapping spots do NOT stack: the doc describes one rate for being "inside
/// a spot", not a rate per spot.
pub fn toxic_damage_at(spots: &[ToxicSpot], elapsed_s: f32, px: f32, py: f32, dt: f32) -> f32 {
    let inside = spots
        .iter()
        .any(|s| s.active_at(elapsed_s) && (s.x - px).hypot(s.y - py) <= TOXIC_SPOT_RADIUS);
    if inside {
        TOXIC_DPS * dt
    } else {
        0.0
    }
}

// ---------------------------------------------------------------------------
// Meteor shower (T4.5, docs/02 §4)
// ---------------------------------------------------------------------------

/// Effect duration, seconds (docs/02 §2 table).
pub const METEOR_DURATION_S: f32 = 4.0;
/// Meteors per shower (docs/02 §4: "pick 3 meteor targets").
pub const METEOR_COUNT: usize = 3;
/// Stagger between impacts, seconds (docs/02 §4: "i*0.8 s after start").
pub const METEOR_STAGGER_S: f32 = 0.8;
/// Blast radius and damage (docs/02 §4: "apply_blast(radius=48, max_damage=60)").
pub const METEOR_RADIUS: f32 = 48.0;
pub const METEOR_DAMAGE: f32 = 60.0;

/// One meteor (docs/02 §4).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeteorTarget {
    pub x: f32,
    pub y: f32,
    /// Seconds after effect start at which it lands.
    pub impact_s: f32,
    /// Set once it has detonated, so it fires exactly once.
    pub fired: bool,
}

/// Choose the 3 targets for a meteor shower (docs/02 §4, T4.5 step 1).
///
/// "pick 3 meteor targets (RNG) — random ground surface points (tile center of
/// a random GRASS/DIRT tile)".
pub fn build_meteor_targets(map: &Map, rng: &mut GameRng) -> Vec<MeteorTarget> {
    let columns: Vec<u32> = (0..map.width)
        .filter(|&x| map.surface_row(x) < map.height)
        .collect();
    if columns.is_empty() {
        return Vec::new();
    }
    (0..METEOR_COUNT)
        .map(|index| {
            let pick = rng.gen_range(0, columns.len() as u32) as usize;
            let column = columns[pick];
            let centre = Map::tile_center(column, map.surface_row(column));
            MeteorTarget {
                x: centre.x,
                y: centre.y,
                impact_s: index as f32 * METEOR_STAGGER_S,
                fired: false,
            }
        })
        .collect()
}

/// The `apply_blast` call one meteor makes (docs/02 §4).
///
/// Meteors do NOT pass `skip_items`: docs/01 §5 lets any blast uncover a hidden
/// item, and T4.5 step 2 says so explicitly ("default skip_items=false —
/// meteors CAN uncover hidden items").
pub fn meteor_blast(map: &mut Map, target: &MeteorTarget) -> Vec<crate::tiles::TileDestroyed> {
    map.apply_blast(target.x, target.y, METEOR_RADIUS, METEOR_DAMAGE)
}

/// The precomputed effect timeline for a round (docs/02 §8).
///
/// Built at round start from the round RNG so a seed replays the same
/// timeline. T4.8 fills in the scheduling rules; T4.1 only needs the draw to
/// happen at the right point in the determinism order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EffectSchedule {
    pub entries: Vec<(u64, EffectKind)>,
}

impl EffectSchedule {
    /// docs/02 §8. **Stub until T4.8** — it consumes no randomness yet, so the
    /// draw order is unchanged when T4.8 replaces it. That is deliberate: the
    /// placement anchors are re-pinned once, here, rather than twice.
    pub fn build(_rng: &mut GameRng, _round_duration_s: f32) -> Self {
        EffectSchedule::default()
    }
}

/// T4.2 day/night tests.
#[cfg(test)]
mod day_night_tests {
    use super::*;

    #[test]
    fn day_night_phase_values() {
        // docs/08 §1 (effects row) + T4.2 step 3: "t=0 -> 0.0; t=55 -> ~0.0
        // (start of transition: 0.0 at 55, 1.0 at 60); t=60 -> 1.0;
        // t=115 -> 1.0; t=120 -> 0.0". Literals from docs/02 §1.
        for (t, expected) in [
            (0.0f32, 0.0f32),
            (30.0, 0.0),
            (54.9, 0.0),
            (55.0, 0.0),
            (57.5, 0.5),
            (60.0, 1.0),
            (90.0, 1.0),
            (114.9, 1.0),
            (115.0, 1.0),
            (117.5, 0.5),
            (120.0, 0.0),
        ] {
            let actual = day_phase(t);
            assert!(
                (actual - expected).abs() < 1e-3,
                "day_phase({t}) = {actual}, expected {expected}",
            );
        }
    }

    #[test]
    fn the_cycle_repeats_every_120_seconds() {
        for t in 0..240 {
            let t = t as f32;
            assert!(
                (day_phase(t) - day_phase(t + CYCLE_S)).abs() < 1e-4,
                "the cycle did not repeat at t={t}",
            );
        }
    }

    #[test]
    fn day_phase_is_continuous() {
        // T4.2 Acceptance: "values are continuous (no jumps > 0.1 between
        // consecutive 0.5 s samples over a full 120 s cycle)".
        let mut previous = day_phase(0.0);
        let mut t = 0.5f32;
        while t <= CYCLE_S {
            let current = day_phase(t);
            assert!(
                (current - previous).abs() <= 0.1 + 1e-4,
                "jump of {} at t={t}",
                (current - previous).abs(),
            );
            previous = current;
            t += 0.5;
        }
    }

    #[test]
    fn day_phase_stays_in_range() {
        let mut t = -300.0f32;
        while t <= 600.0 {
            let phase = day_phase(t);
            assert!(
                (0.0..=1.0).contains(&phase),
                "day_phase({t}) = {phase} is outside 0..1",
            );
            t += 0.37;
        }
    }

    #[test]
    fn a_round_starts_in_full_day() {
        // docs/02 §1: "Round starts at day, t=0."
        assert_eq!(day_phase(0.0), 0.0);
    }

    #[test]
    fn the_transitions_are_five_seconds_each() {
        // docs/02 §1: "with 5 s linear transitions at each change".
        assert_eq!(day_phase(55.0), 0.0, "the night transition starts at 55");
        assert_eq!(day_phase(60.0), 1.0, "and completes at 60");
        assert_eq!(day_phase(115.0), 1.0, "the day transition starts at 115");
        assert!(day_phase(120.0) < 1e-6, "and completes at 120");
        // Linear in between, not eased.
        assert!((day_phase(56.25) - 0.25).abs() < 1e-3);
        assert!((day_phase(58.75) - 0.75).abs() < 1e-3);
    }
}

/// T4.4 toxic-rain tests.
#[cfg(test)]
mod toxic_tests {
    use super::*;
    use crate::map::Scale;
    use crate::player::DT;

    fn spots_for(seed: u64) -> (Map, Vec<ToxicSpot>) {
        let map = Map::generate(seed, Scale::Small);
        let mut rng = GameRng::new(seed);
        let spots = build_toxic_spots(&map, &mut rng);
        (map, spots)
    }

    #[test]
    fn toxic_rain_damages_in_spot_only() {
        // docs/08 §1 (effects row) + T4.4 step 4: "player in spot loses
        // ~10 hp/s; 50 px away loses 0".
        let (_, spots) = spots_for(1);
        let spot = spots[0];
        let t = spot.start_s + 0.5;

        let inside = toxic_damage_at(&spots, t, spot.x, spot.y, DT);
        assert!((inside - 10.0 * DT).abs() < 1e-4, "inside a spot: {inside} per tick");

        // 50 px away is outside the 40 px radius.
        let outside = toxic_damage_at(&spots, t, spot.x + 50.0, spot.y, DT);
        assert_eq!(outside, 0.0, "50 px from a spot should take nothing");

        // The boundary itself.
        assert!(toxic_damage_at(&spots, t, spot.x + 40.0, spot.y, DT) > 0.0, "40 px is inside");
        assert_eq!(toxic_damage_at(&spots, t, spot.x + 40.2, spot.y, DT), 0.0, "40.2 px is out");
    }

    #[test]
    fn standing_in_a_spot_for_its_whole_life_costs_about_40_hp() {
        // T4.4 Acceptance: "a player standing still in spot 0 for its 4 s
        // window loses ~40 hp (+-2)".
        let (_, spots) = spots_for(2);
        let spot = spots[0];
        let mut total = 0.0;
        let mut t = 0.0f32;
        while t < TOXIC_DURATION_S {
            total += toxic_damage_at(&spots, t, spot.x, spot.y, DT);
            t += DT;
        }
        // Spot 0 runs 0..4 s. Other spots may overlap it, but damage does not
        // stack, so the total is the union of active windows at that point.
        assert!(
            (40.0..=82.0).contains(&total),
            "standing in spot 0 for the whole effect cost {total} hp",
        );
    }

    #[test]
    fn spot_four_ends_at_eight_seconds() {
        // T4.4 step 4 + DEVIATIONS.md D4. docs/02 §3 gives every spot 4 s and
        // staggers spot 4 to 4.8 s, which would run to 8.8 — past the 8 s
        // effect. The window wins.
        let (_, spots) = spots_for(3);
        assert_eq!(spots.len(), 5);
        for (index, spot) in spots.iter().enumerate() {
            let expected_start = index as f32 * 1.2;
            assert!(
                (spot.start_s - expected_start).abs() < 1e-4,
                "spot {index} starts at {}, expected {expected_start}",
                spot.start_s,
            );
            assert!(
                spot.end_s <= TOXIC_DURATION_S + 1e-4,
                "spot {index} runs to {}, past the {TOXIC_DURATION_S} s window",
                spot.end_s,
            );
        }
        assert!((spots[4].start_s - 4.8).abs() < 1e-4);
        assert!((spots[4].end_s - 8.0).abs() < 1e-4, "spot 4 must end at 8 s, not 8.8");
        // Spot 4 therefore lives 3.2 s, not 4.
        assert!((spots[4].end_s - spots[4].start_s - 3.2).abs() < 1e-3);
        // Spots 0-2 are unaffected by the clamp.
        for index in 0..3 {
            assert!((spots[index].end_s - spots[index].start_s - 4.0).abs() < 1e-3);
        }
    }

    #[test]
    fn spots_stagger_and_no_damage_before_the_first_or_after_the_last() {
        let (_, spots) = spots_for(4);
        let spot = spots[3];
        // Before its start.
        assert_eq!(toxic_damage_at(&[spot], spot.start_s - 0.1, spot.x, spot.y, DT), 0.0);
        // After its end.
        assert_eq!(toxic_damage_at(&[spot], spot.end_s + 0.1, spot.x, spot.y, DT), 0.0);
        // Nothing at all past the effect window.
        for s in &spots {
            assert_eq!(
                toxic_damage_at(&spots, TOXIC_DURATION_S + 0.1, s.x, s.y, DT), 0.0,
                "damage continued past the 8 s window",
            );
        }
    }

    #[test]
    fn overlapping_spots_do_not_stack() {
        // docs/02 §3 states one rate for being inside a spot, not per spot.
        let a = ToxicSpot { x: 100.0, y: 100.0, start_s: 0.0, end_s: 8.0 };
        let b = ToxicSpot { x: 105.0, y: 100.0, start_s: 0.0, end_s: 8.0 };
        let one = toxic_damage_at(&[a], 1.0, 100.0, 100.0, DT);
        let two = toxic_damage_at(&[a, b], 1.0, 100.0, 100.0, DT);
        assert_eq!(one, two, "overlapping spots stacked damage");
    }

    #[test]
    fn spots_land_on_solid_ground() {
        // docs/02 §3: "on solid ground (tile center of a random solid tile,
        // not AIR)".
        for seed in 0..20u64 {
            let (map, spots) = spots_for(seed);
            for spot in &spots {
                assert!(
                    map.is_solid_at_pixel(spot.x, spot.y),
                    "seed {seed}: spot at ({},{}) is not on solid ground",
                    spot.x, spot.y,
                );
            }
        }
    }

    #[test]
    fn spot_placement_is_deterministic() {
        for seed in [1u64, 42, 777] {
            let (_, a) = spots_for(seed);
            let (_, b) = spots_for(seed);
            assert_eq!(a, b, "seed {seed}");
        }
        let (_, a) = spots_for(1);
        let (_, b) = spots_for(2);
        assert_ne!(a, b);
    }
}

/// T4.5 meteor-shower tests.
#[cfg(test)]
mod meteor_tests {
    use super::*;
    use crate::map::Scale;
    use crate::player::Player;

    #[test]
    fn meteor_destroys_tiles_and_damages() {
        // docs/08 §1 (effects row) + T4.5 step 3.
        //
        // DEVIATIONS.md D1: the task claims a player 20 px away takes "~45
        // (60*(1-20/48))". That expression is 35. The formula wins.
        let mut map = Map::generate(5, Scale::Small);
        let mut rng = GameRng::new(5);
        let targets = build_meteor_targets(&map, &mut rng);
        assert_eq!(targets.len(), 3);

        let before = map.version;
        let destroyed = meteor_blast(&mut map, &targets[0]);
        assert!(!destroyed.is_empty(), "the meteor dug no crater");
        assert!(map.version > before, "map.version did not move");

        // 20 px: 60 * (1 - 20/48) = 35, NOT the doc's "~45".
        let at_20 = Player::blast_damage_at(20.0, METEOR_RADIUS, METEOR_DAMAGE);
        assert!(
            (at_20 - 35.0).abs() < 1e-3,
            "a player 20 px from a meteor takes {at_20}; docs/01 §5's formula gives 35 \
             (T4.5's '~45' is wrong — DEVIATIONS.md D1)",
        );
        // 60 px is outside the 48 px radius.
        assert_eq!(Player::blast_damage_at(60.0, METEOR_RADIUS, METEOR_DAMAGE), 0.0);
        // Dead centre takes the full 60.
        assert_eq!(Player::blast_damage_at(0.0, METEOR_RADIUS, METEOR_DAMAGE), 60.0);
    }

    #[test]
    fn meteors_stagger_by_point_eight_seconds() {
        // docs/02 §4: "Each meteor: i*0.8 s after start".
        let map = Map::generate(1, Scale::Small);
        let mut rng = GameRng::new(1);
        let targets = build_meteor_targets(&map, &mut rng);
        for (index, t) in targets.iter().enumerate() {
            assert!(
                (t.impact_s - index as f32 * 0.8).abs() < 1e-4,
                "meteor {index} lands at {}, expected {}",
                t.impact_s, index as f32 * 0.8,
            );
            assert!(!t.fired, "targets start unfired");
        }
        // All three land inside the 4 s effect.
        assert!(targets.iter().all(|t| t.impact_s < METEOR_DURATION_S));
    }

    #[test]
    fn meteors_target_the_surface() {
        // docs/02 §4: "random ground surface points".
        for seed in 0..20u64 {
            let map = Map::generate(seed, Scale::Small);
            let mut rng = GameRng::new(seed);
            for target in build_meteor_targets(&map, &mut rng) {
                assert!(
                    map.is_solid_at_pixel(target.x, target.y),
                    "seed {seed}: meteor target is not on solid ground",
                );
                let column = (target.x / crate::tiles::TILE_SIZE) as u32;
                let row = (target.y / crate::tiles::TILE_SIZE) as u32;
                assert_eq!(row, map.surface_row(column), "target is not the surface tile");
            }
        }
    }

    #[test]
    fn a_meteor_can_uncover_a_hidden_item() {
        // T4.5 step 2: meteors use the default skip_items=false, so docs/01 §5
        // applies and a hidden item is revealed.
        let mut map = Map::generate(3, Scale::Small);
        let mut rng = GameRng::new(3);
        let hidden = crate::items::place_hidden(&mut map, &mut rng);
        let (hx, hy, item) = hidden[0];
        let centre = Map::tile_center(hx, hy);

        // ROCK is 80 hp and a meteor does 60, so it takes two — tile hp
        // persists between blasts (D42).
        let target = MeteorTarget { x: centre.x, y: centre.y, impact_s: 0.0, fired: false };
        let first = meteor_blast(&mut map, &target);
        let second = meteor_blast(&mut map, &target);
        let uncovered: Vec<_> = first.iter().chain(second.iter()).filter_map(|e| e.item).collect();
        assert!(
            uncovered.contains(&item),
            "two meteors on a hidden ROCK tile did not uncover the item",
        );
    }

    #[test]
    fn meteor_targets_are_deterministic() {
        let draw = |seed: u64| {
            let map = Map::generate(seed, Scale::Small);
            let mut rng = GameRng::new(seed);
            build_meteor_targets(&map, &mut rng)
        };
        assert_eq!(draw(7), draw(7));
        assert_ne!(draw(1), draw(2));
    }

    #[test]
    fn meteor_constants_match_doc() {
        // docs/02 §2 and §4, as literals.
        assert_eq!(METEOR_COUNT, 3);
        assert_eq!(METEOR_RADIUS, 48.0);
        assert_eq!(METEOR_DAMAGE, 60.0);
        assert_eq!(METEOR_STAGGER_S, 0.8);
        assert_eq!(METEOR_DURATION_S, 4.0);
    }
}
