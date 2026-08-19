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

// ---------------------------------------------------------------------------
// Lava burst (T4.6, docs/02 §5)
// ---------------------------------------------------------------------------

/// Spew phase length, seconds (docs/02 §5: "Phase 1 (0-5 s)").
pub const LAVA_SPEW_S: f32 = 5.0;
/// Total effect length, seconds (docs/02 §5: "Phase 2 (5-8 s)").
pub const LAVA_DURATION_S: f32 = 8.0;
/// Damage per second in either phase (docs/02 §2, §5).
pub const LAVA_DPS: f32 = 15.0;
/// Fire particles emitted per tick during the spew (docs/02 §5).
pub const LAVA_PARTICLES_PER_TICK: usize = 2;
/// Particle speed, px/s, and life, seconds (docs/02 §5).
pub const LAVA_PARTICLE_SPEED: f32 = 150.0;
pub const LAVA_PARTICLE_LIFE_S: f32 = 1.0;

/// Which half of a lava burst is running (docs/02 §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LavaPhase {
    Spew,
    Fire,
}

impl LavaPhase {
    /// Wire name (docs/06 §5: `phase: "spew"|"fire"`).
    pub const fn as_str(self) -> &'static str {
        match self {
            LavaPhase::Spew => "spew",
            LavaPhase::Fire => "fire",
        }
    }
}

/// The phase at `elapsed_s`, or `None` once the effect is over.
pub fn lava_phase_at(elapsed_s: f32) -> Option<LavaPhase> {
    if elapsed_s < LAVA_SPEW_S {
        Some(LavaPhase::Spew)
    } else if elapsed_s < LAVA_DURATION_S {
        Some(LavaPhase::Fire)
    } else {
        None
    }
}

/// A single fire particle (docs/02 §5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FireParticle {
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
    pub life_s: f32,
}

/// Dig the 3x3 hole a lava burst opens (docs/02 §5, T4.6 step 1).
///
/// "a 3x3 tile area around the site becomes AIR (emits tile_destroyed events,
/// **no hidden-item spawn for these** — weather destruction skips item
/// uncovery)".
///
/// This is the first caller of `skip_items`, added speculatively in T3.3.
/// Uses the deferred destroy path with one conversion pass at the end (D22).
pub fn lava_clear_area(map: &mut Map, site_x: u32, site_y: u32) -> Vec<crate::tiles::TileDestroyed> {
    let mut destroyed = Vec::new();
    for dy in -1i32..=1 {
        for dx in -1i32..=1 {
            let x = site_x as i32 + dx;
            let y = site_y as i32 + dy;
            if x < 0 || y < 0 || x >= map.width as i32 || y >= map.height as i32 {
                continue;
            }
            if let Some(mut event) = map.destroy_tile_deferred(x as u32, y as u32) {
                // Weather skips uncovery: the item stays buried rather than
                // being destroyed with the tile (docs/02 §5, D-note in T3.3).
                if event.item.is_some() {
                    let mut tile = map.tile(x as u32, y as u32);
                    tile.item = event.item;
                    map.set_tile(x as u32, y as u32, tile);
                    event.item = None;
                }
                destroyed.push(event);
            }
        }
    }
    if !destroyed.is_empty() {
        map.apply_surface_conversion();
    }
    destroyed
}

/// Emit this tick's fire particles (docs/02 §5, T4.6 step 2).
///
/// "per tick, 2 fire particles fly from the site in random directions (RNG,
/// 30 degree spread upward +- 120 degrees), speed 150 px/s, live 1 s".
pub fn spew_particles(site_x: f32, site_y: f32, rng: &mut GameRng) -> Vec<FireParticle> {
    (0..LAVA_PARTICLES_PER_TICK)
        .map(|_| {
            // Upward is -y; the spread is measured about straight up.
            let spread = rng.gen_range_f32(-120.0, 120.0).to_radians();
            let angle = std::f32::consts::FRAC_PI_2 + spread;
            FireParticle {
                x: site_x,
                y: site_y,
                vx: angle.cos() * LAVA_PARTICLE_SPEED,
                vy: -angle.sin() * LAVA_PARTICLE_SPEED,
                life_s: LAVA_PARTICLE_LIFE_S,
            }
        })
        .collect()
}

/// Advance a fire particle. Returns false once it has expired.
pub fn step_particle(particle: &mut FireParticle, dt: f32) -> bool {
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vy += crate::player::player_config::GRAVITY * dt;
    particle.life_s -= dt;
    particle.life_s > 0.0
}

/// Damage a player takes this tick from lava (docs/02 §5).
///
/// Spew phase: overlapping a fire particle. Fire phase: standing on the burnt
/// 3x3. Both are 15 hp/s.
pub fn lava_damage_at(
    phase: LavaPhase,
    particles: &[FireParticle],
    burning: &[(u32, u32)],
    px: f32,
    py: f32,
    dt: f32,
) -> f32 {
    let hit = match phase {
        LavaPhase::Spew => particles
            .iter()
            .any(|p| (p.x - px).hypot(p.y - py) <= crate::items::PLAYER_HIT_RADIUS),
        LavaPhase::Fire => {
            let tx = (px / crate::tiles::TILE_SIZE) as u32;
            let ty = (py / crate::tiles::TILE_SIZE) as u32;
            burning.iter().any(|&(bx, by)| bx == tx && by == ty)
        }
    };
    if hit {
        LAVA_DPS * dt
    } else {
        0.0
    }
}

// ---------------------------------------------------------------------------
// Heavy fog (T4.7, docs/02 §6)
// ---------------------------------------------------------------------------

/// Fog duration, seconds (docs/02 §2 table, §6).
pub const FOG_DURATION_S: f32 = 15.0;

/// Fog state carried in the snapshot (docs/06 §4 `fog`).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct FogState {
    pub active: bool,
    pub remaining_s: f32,
}

impl FogState {
    /// Fog for an effect that started `elapsed_s` ago (docs/02 §6).
    pub fn at(elapsed_s: f32) -> Self {
        if elapsed_s < FOG_DURATION_S {
            FogState { active: true, remaining_s: FOG_DURATION_S - elapsed_s }
        } else {
            FogState::default()
        }
    }
}

// ---------------------------------------------------------------------------
// Scheduler (T4.8, docs/02 §8)
// ---------------------------------------------------------------------------

/// First effect window, seconds (docs/02 §8: "first effect at t in [10, 20] s").
pub const FIRST_EFFECT_MIN_S: f32 = 10.0;
pub const FIRST_EFFECT_MAX_S: f32 = 20.0;
/// Gap between effects, seconds (docs/02 §8: "subsequent gaps: t in [18, 32] s").
pub const EFFECT_GAP_MIN_S: f32 = 18.0;
pub const EFFECT_GAP_MAX_S: f32 = 32.0;
/// No effect may start within this many seconds of the end (docs/02 §8).
pub const EFFECT_TAIL_S: f32 = 15.0;
/// Weights: toxic 30, meteor 25, lava 25, fog 20 (docs/02 §8).
pub const EFFECT_WEIGHTS: [u32; 4] = [30, 25, 25, 20];

/// Every effect kind, in the weight-table order.
pub const EFFECT_KINDS: [EffectKind; 4] = [
    EffectKind::ToxicRain,
    EffectKind::MeteorShower,
    EffectKind::LavaBurst,
    EffectKind::HeavyFog,
];

/// How long an effect of each kind runs (docs/02 §2 table).
pub fn effect_duration_s(kind: EffectKind) -> f32 {
    match kind {
        EffectKind::ToxicRain => TOXIC_DURATION_S,
        EffectKind::MeteorShower => METEOR_DURATION_S,
        EffectKind::LavaBurst => LAVA_DURATION_S,
        EffectKind::HeavyFog => FOG_DURATION_S,
    }
}

/// The precomputed effect timeline for a round (docs/02 §8).
///
/// Built at round start from the round RNG, so a seed replays the same
/// timeline and tests can assert an exact effect list.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EffectSchedule {
    /// `(start time in seconds, kind)`, ascending.
    pub entries: Vec<(f32, EffectKind)>,
}

impl EffectSchedule {
    /// docs/02 §8, T4.8 step 1.
    ///
    /// "first effect at t in [10, 20] s (RNG); subsequent gaps: t in [18, 32] s
    /// (RNG); kind: weighted pick; stop scheduling when t > round_duration - 15 s".
    ///
    /// Draw order per entry is **time, then kind** — the order fixes the whole
    /// downstream sequence (docs/04 §6, D19).
    pub fn build(rng: &mut GameRng, round_duration_s: f32) -> Self {
        let mut entries = Vec::new();
        let latest = round_duration_s - EFFECT_TAIL_S;

        let mut t = rng.gen_range_f32(FIRST_EFFECT_MIN_S, FIRST_EFFECT_MAX_S);
        while t <= latest {
            let index = rng
                .weighted_index(&EFFECT_WEIGHTS)
                .expect("effect weights are non-empty");
            entries.push((t, EFFECT_KINDS[index]));
            t += rng.gen_range_f32(EFFECT_GAP_MIN_S, EFFECT_GAP_MAX_S);
        }
        EffectSchedule { entries }
    }

    /// The next entry due at or before `now` that has not started yet.
    pub fn due(&self, now: f32, started: usize) -> Option<(f32, EffectKind)> {
        self.entries.get(started).copied().filter(|(t, _)| now >= *t)
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

/// T4.6 lava-burst tests.
#[cfg(test)]
mod lava_tests {
    use super::*;
    use crate::map::Scale;
    use crate::player::DT;
    use crate::tiles::{TileKind, TILE_SIZE};

    #[test]
    fn lava_spew_then_ground_fire() {
        // docs/08 §1 (effects row) + T4.6 step 5: "phase switch at 5 s; damage
        // in both phases; no damage after 8 s".
        assert_eq!(lava_phase_at(0.0), Some(LavaPhase::Spew));
        assert_eq!(lava_phase_at(4.9), Some(LavaPhase::Spew));
        assert_eq!(lava_phase_at(5.0), Some(LavaPhase::Fire), "phase switches at 5 s");
        assert_eq!(lava_phase_at(7.9), Some(LavaPhase::Fire));
        assert_eq!(lava_phase_at(8.0), None, "the effect is over at 8 s");
        assert_eq!(lava_phase_at(100.0), None);

        // Damage in BOTH phases, at the documented 15 hp/s.
        let particle = FireParticle { x: 100.0, y: 100.0, vx: 0.0, vy: 0.0, life_s: 1.0 };
        let spew = lava_damage_at(LavaPhase::Spew, &[particle], &[], 100.0, 100.0, DT);
        assert!((spew - 15.0 * DT).abs() < 1e-4, "spew damage {spew} per tick");

        let burning = [(6u32, 6u32)];
        let fire = lava_damage_at(LavaPhase::Fire, &[], &burning, 6.5 * TILE_SIZE, 6.5 * TILE_SIZE, DT);
        assert!((fire - 15.0 * DT).abs() < 1e-4, "fire damage {fire} per tick");

        // Away from both: nothing.
        assert_eq!(lava_damage_at(LavaPhase::Spew, &[particle], &[], 500.0, 500.0, DT), 0.0);
        assert_eq!(lava_damage_at(LavaPhase::Fire, &[], &burning, 500.0, 500.0, DT), 0.0);
    }

    #[test]
    fn the_dug_area_is_exactly_nine_tiles_and_persists() {
        // T4.6 step 5: "dug area is exactly 9 tiles (+- tiles already AIR)";
        // Acceptance: "after the burst the hole persists (tiles stay AIR)".
        let (w, h) = Scale::Small.dimensions();
        let mut map = Map {
            seed: 0, scale: Scale::Small, width: w, height: h,
            tiles: vec![crate::tiles::Tile::new(TileKind::Stone); (w * h) as usize],
            decor: Vec::new(), spawns: Vec::new(), version: 0,
        };
        let destroyed = lava_clear_area(&mut map, 20, 20);
        assert_eq!(destroyed.len(), 9, "a 3x3 dig should remove 9 solid tiles");
        for dy in -1i32..=1 {
            for dx in -1i32..=1 {
                let (x, y) = ((20 + dx) as u32, (20 + dy) as u32);
                assert_eq!(map.tile(x, y).kind, TileKind::Air, "({x},{y}) is not AIR");
            }
        }
        // The hole persists: nothing refills it.
        assert_eq!(map.tile(20, 20).kind, TileKind::Air);
        // Tiles already AIR are not counted twice.
        let again = lava_clear_area(&mut map, 20, 20);
        assert!(again.is_empty(), "re-digging AIR reported destruction");
    }

    #[test]
    fn lava_leaves_hidden_items_buried() {
        // docs/02 §5: "no hidden-item spawn for these — weather destruction
        // skips item uncovery". T4.6 is the first caller of skip_items.
        let mut map = Map::generate(3, Scale::Small);
        let mut rng = GameRng::new(3);
        let hidden = crate::items::place_hidden(&mut map, &mut rng);
        let (hx, hy, item) = hidden[0];

        let destroyed = lava_clear_area(&mut map, hx, hy);
        assert!(!destroyed.is_empty());
        assert!(
            destroyed.iter().all(|e| e.item.is_none()),
            "lava uncovered a hidden item",
        );
        assert_eq!(
            map.tile(hx, hy).item, Some(item),
            "the item was destroyed rather than left buried",
        );
    }

    #[test]
    fn particles_spew_upward_at_the_documented_speed() {
        // docs/02 §5: 2 per tick, 150 px/s, 1 s life, upward +- 120 degrees.
        let mut rng = GameRng::new(1);
        for _ in 0..200 {
            let particles = spew_particles(100.0, 100.0, &mut rng);
            assert_eq!(particles.len(), 2, "2 particles per tick");
            for p in particles {
                let speed = p.vx.hypot(p.vy);
                assert!((speed - 150.0).abs() < 1e-2, "speed {speed}, expected 150");
                assert_eq!(p.life_s, 1.0);
                // The spread is +-120 degrees about straight up, so the
                // steepest downward component is cos(120 deg) of the speed.
                assert!(
                    p.vy <= 150.0 * 0.5 + 1e-2,
                    "particle vy {} is steeper than the 120 degree spread allows", p.vy,
                );
            }
        }
    }

    #[test]
    fn particles_expire_after_one_second() {
        let mut p = FireParticle { x: 0.0, y: 0.0, vx: 100.0, vy: -100.0, life_s: 1.0 };
        let mut ticks = 0;
        while step_particle(&mut p, DT) {
            ticks += 1;
            assert!(ticks < 100, "the particle never expired");
        }
        // 1 s = 20 ticks.
        assert!((19..=21).contains(&ticks), "particle lived {ticks} ticks, expected ~20");
    }

    #[test]
    fn no_damage_after_the_effect_ends() {
        // T4.6 step 5: "no damage after 8 s".
        assert_eq!(lava_phase_at(8.0), None);
        assert_eq!(lava_phase_at(8.1), None);
    }

    #[test]
    fn lava_constants_match_doc() {
        assert_eq!(LAVA_SPEW_S, 5.0);
        assert_eq!(LAVA_DURATION_S, 8.0);
        assert_eq!(LAVA_DPS, 15.0);
        assert_eq!(LAVA_PARTICLES_PER_TICK, 2);
        assert_eq!(LAVA_PARTICLE_SPEED, 150.0);
        assert_eq!(LAVA_PARTICLE_LIFE_S, 1.0);
        assert_eq!(LavaPhase::Spew.as_str(), "spew");
        assert_eq!(LavaPhase::Fire.as_str(), "fire");
    }
}

/// T4.7 heavy-fog tests.
#[cfg(test)]
mod fog_tests {
    use super::*;
    use crate::player::Player;

    #[test]
    fn fog_reduces_fov() {
        // docs/08 §1 (effects row) + T4.7 step 4: "fov with fog ~= 0.45 x
        // without (same inputs)". T4.7 Acceptance: "assert local fov drops
        // from 420 to 189 at full day".
        let clear = Player::compute_fov(0.0, false, 100.0, false);
        let foggy = Player::compute_fov(0.0, true, 100.0, false);
        assert_eq!(clear, 420.0, "full day, healthy, no fog");
        assert_eq!(foggy, 189.0, "fog should give 420 * 0.45 = 189");
        assert!((foggy / clear - 0.45).abs() < 1e-4, "the ratio should be 0.45");
    }

    #[test]
    fn fog_stacks_multiplicatively_with_night() {
        // docs/02 §6: "stacks multiplicatively with night per docs/03 §7".
        let night = Player::compute_fov(1.0, false, 100.0, false);
        let night_fog = Player::compute_fov(1.0, true, 100.0, false);
        assert!((night_fog - night * 0.45).abs() < 1e-3, "fog did not stack with night");
        assert!((night_fog - 85.05).abs() < 1e-2, "420 * 0.45 * 0.45 = 85.05");
    }

    #[test]
    fn fog_lasts_fifteen_seconds() {
        // docs/02 §6: "Duration 15 s".
        assert_eq!(FOG_DURATION_S, 15.0);
        let start = FogState::at(0.0);
        assert!(start.active);
        assert_eq!(start.remaining_s, 15.0);

        let mid = FogState::at(7.5);
        assert!(mid.active);
        assert_eq!(mid.remaining_s, 7.5);

        assert!(FogState::at(14.9).active);
        assert!(!FogState::at(15.0).active, "fog outlived its 15 s");
        assert_eq!(FogState::at(15.0).remaining_s, 0.0);
        assert!(!FogState::at(100.0).active);
    }

    #[test]
    fn fog_does_no_damage() {
        // docs/02 §2 table: fog damage is "none".
        //
        // Structural rather than behavioural: there is no fog damage function
        // to call, which is the point. If one is ever added, this test's
        // comment is where to explain why.
        let before = Player::compute_fov(0.0, false, 100.0, false);
        let after = Player::compute_fov(0.0, true, 100.0, false);
        assert!(after < before, "fog should only shrink vision");
    }

    #[test]
    fn a_flashlight_does_not_cancel_fog() {
        // docs/03 §7: the flashlight sets night_factor to 1.0, nothing else.
        let foggy_night = Player::compute_fov(1.0, true, 100.0, true);
        assert_eq!(foggy_night, 189.0, "a flashlight should not clear fog");
    }
}

/// T4.8 scheduler tests.
#[cfg(test)]
mod schedule_tests {
    use super::*;

    fn build(seed: u64) -> EffectSchedule {
        EffectSchedule::build(&mut GameRng::new(seed), 240.0)
    }

    #[test]
    fn schedule_deterministic_per_seed() {
        // docs/08 §1 (effects row) + T4.8 step 4: "3 seeds -> identical
        // timelines".
        for seed in [1u64, 42, 12345] {
            assert_eq!(build(seed), build(seed), "seed {seed} scheduled differently");
        }
        assert_ne!(build(1), build(2), "different seeds gave the same timeline");
    }

    #[test]
    fn no_effect_in_first_10s() {
        // docs/08 §1 + docs/02 §7: "Effects never start in the first 10 s of a
        // round (grace period)."
        for seed in 0..200u64 {
            for (t, kind) in &build(seed).entries {
                assert!(
                    *t >= FIRST_EFFECT_MIN_S,
                    "seed {seed}: {kind:?} scheduled at {t} s, inside the 10 s grace",
                );
            }
        }
    }

    #[test]
    fn no_effect_in_last_15s() {
        // docs/08 §1 + docs/02 §8: "stop scheduling when t > round_duration - 15 s".
        for seed in 0..200u64 {
            for (t, kind) in &build(seed).entries {
                assert!(
                    *t <= 240.0 - EFFECT_TAIL_S,
                    "seed {seed}: {kind:?} scheduled at {t} s, inside the final 15 s",
                );
            }
        }
    }

    #[test]
    fn one_effect_at_a_time() {
        // docs/08 §1 + docs/02 §7: "Only ONE effect active at a time. A new
        // effect cannot start while one is active."
        //
        // The gap floor is 18 s and the longest effect is heavy fog at 15 s,
        // so the schedule can never overlap — asserted over the whole timeline
        // rather than assumed from the constants.
        for seed in 0..200u64 {
            let schedule = build(seed);
            for pair in schedule.entries.windows(2) {
                let (start, kind) = pair[0];
                let (next_start, _) = pair[1];
                let ends = start + effect_duration_s(kind);
                assert!(
                    next_start >= ends,
                    "seed {seed}: {kind:?} runs {start}..{ends} but the next starts at {next_start}",
                );
            }
        }
    }

    #[test]
    fn gaps_are_within_the_documented_range() {
        // docs/02 §8: "subsequent gaps: t in [18, 32] s".
        for seed in 0..200u64 {
            let schedule = build(seed);
            for pair in schedule.entries.windows(2) {
                let gap = pair[1].0 - pair[0].0;
                assert!(
                    (EFFECT_GAP_MIN_S..=EFFECT_GAP_MAX_S).contains(&gap),
                    "seed {seed}: gap of {gap} s is outside 18..32",
                );
            }
        }
    }

    #[test]
    fn the_first_effect_lands_in_its_documented_window() {
        // docs/02 §8: "first effect at t in [10, 20] s".
        for seed in 0..200u64 {
            if let Some((t, _)) = build(seed).entries.first() {
                assert!(
                    (FIRST_EFFECT_MIN_S..=FIRST_EFFECT_MAX_S).contains(t),
                    "seed {seed}: first effect at {t} s, outside 10..20",
                );
            }
        }
    }

    #[test]
    fn kinds_follow_the_documented_weights() {
        // docs/02 §8: "toxic rain 30%, meteor 25%, lava 25%, fog 20%".
        let mut counts = [0u32; 4];
        let mut total = 0u32;
        for seed in 0..4000u64 {
            for (_, kind) in build(seed).entries {
                let index = EFFECT_KINDS.iter().position(|k| *k == kind).unwrap();
                counts[index] += 1;
                total += 1;
            }
        }
        assert!(total > 1000, "not enough samples: {total}");
        let weight_total: u32 = EFFECT_WEIGHTS.iter().sum();
        assert_eq!(weight_total, 100, "docs/02 §8's weights should be percentages");
        for (index, &weight) in EFFECT_WEIGHTS.iter().enumerate() {
            let expected = total as f32 * weight as f32 / weight_total as f32;
            let actual = counts[index] as f32;
            assert!(
                (actual - expected).abs() < expected * 0.12,
                "{:?}: {actual} of {total}, expected ~{expected}",
                EFFECT_KINDS[index],
            );
        }
    }

    #[test]
    fn a_seed_produces_a_stable_printable_timeline() {
        // T4.8 Acceptance: "seed 12345 always produces the same effect list
        // (print it in the test output for the first seed)".
        let schedule = build(12345);
        println!("seed 12345 effect timeline:");
        for (t, kind) in &schedule.entries {
            println!("  t={t:>7.3} s  {}", kind.as_str());
        }
        assert!(!schedule.entries.is_empty(), "seed 12345 scheduled nothing");
        assert_eq!(schedule, build(12345));
    }

    #[test]
    fn due_returns_each_entry_once_in_order() {
        let schedule = build(7);
        assert!(schedule.entries.len() >= 2);
        let (first_t, first_kind) = schedule.entries[0];

        assert_eq!(schedule.due(first_t - 0.1, 0), None, "fired before its time");
        assert_eq!(schedule.due(first_t, 0), Some((first_t, first_kind)));
        // Once started, `due` moves on to the next entry.
        let (second_t, _) = schedule.entries[1];
        assert_eq!(schedule.due(first_t, 1), None, "the second entry fired early");
        assert!(schedule.due(second_t, 1).is_some());
        // Past the end.
        assert_eq!(schedule.due(1000.0, schedule.entries.len()), None);
    }

    #[test]
    fn a_short_round_schedules_nothing() {
        // round_duration - 15 < 10 leaves no window at all.
        let schedule = EffectSchedule::build(&mut GameRng::new(1), 20.0);
        assert!(schedule.entries.is_empty(), "a 20 s round scheduled effects");
    }
}
