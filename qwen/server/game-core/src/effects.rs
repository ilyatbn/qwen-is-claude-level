//! `effects` — weather, toxic rain, meteors, lava, fog, day/night (docs/02).
//!
//! T4.1 needs [`EffectSchedule`] because docs/04 §6 puts "build effect
//! schedule" at step 3 of the round-start determinism order, before item
//! placement. The scheduler itself is T4.8; day/night is T4.2; the four
//! effects are T4.4–T4.7.

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
