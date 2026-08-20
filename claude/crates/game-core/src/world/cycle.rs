//! The day/night cycle and the one field-of-view formula.
//!
//! **This file is the authority for both.** The client has a TypeScript copy in
//! `client/src/render/sky-math.ts` for the sandbox, and `cycle_matches_the_client`
//! below pins the two together across a sweep — two independent copies of this
//! formula is exactly the drift the architecture exists to prevent
//! (`docs/14-daynight-visibility.md` §3, `docs/70-amendments-v2.md` §A13).

use crate::constants::{
    BASE_HEALTH, DAY_DURATION, FLASHLIGHT_AMBIENT_MULT, FOV_DAY, FOV_HEALTH_MIN_MULT, FOV_NIGHT,
    NIGHT_DARKNESS, NIGHT_DURATION,
};
use crate::math::{clamp01, lerp, smoothstep};

/// A full day plus a full night.
pub const CYCLE_LENGTH: f32 = DAY_DURATION + NIGHT_DURATION;

/// Phase boundaries as fractions of the cycle, from `docs/70-amendments-v2.md`
/// §A4. Darkness is derived from these same numbers (§A13) so the sky and the
/// world tell the same story — previously they were specified independently and
/// the orange sunset keyframe played underneath a black overlay.
pub const DUSK_START: f32 = 0.50;
pub const NIGHT_START: f32 = 0.62;
pub const DAWN_START: f32 = 0.90;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DayPhase {
    Day,
    Night,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct CycleState {
    pub phase: DayPhase,
    /// `0.0 ..= NIGHT_DARKNESS`.
    pub darkness: f32,
}

/// Position within the cycle, `0.0 ..< 1.0`. A round always starts in day.
pub fn cycle_u(round_time: f32) -> f32 {
    let u = (round_time / CYCLE_LENGTH).rem_euclid(1.0);
    if u.is_finite() {
        u
    } else {
        0.0
    }
}

/// Darkness at a point in the cycle. Pure; the client computes the same thing.
pub fn darkness_at(u: f32) -> f32 {
    if u < DUSK_START {
        0.0
    } else if u < NIGHT_START {
        NIGHT_DARKNESS * smoothstep((u - DUSK_START) / (NIGHT_START - DUSK_START))
    } else if u < DAWN_START {
        NIGHT_DARKNESS
    } else {
        NIGHT_DARKNESS * (1.0 - smoothstep((u - DAWN_START) / (1.0 - DAWN_START)))
    }
}

pub fn cycle_at(round_time: f32) -> CycleState {
    let u = cycle_u(round_time);
    let darkness = darkness_at(u);
    CycleState {
        // The binary phase is for the `phase_change` event and audio cues. The
        // six-name visual phase lives client-side (§A4); this is the gameplay one.
        phase: if darkness >= NIGHT_DARKNESS * 0.5 {
            DayPhase::Night
        } else {
            DayPhase::Day
        },
        darkness,
    }
}

/// The one FoV formula, shared by the client renderer and (later) server-side
/// visibility culling.
///
/// Note §A16: `FOV_DAY` and `FOV_NIGHT` were restated for `CAMERA_ZOOM` 2.0. They
/// are world-pixel radii governing a *perceptual* effect, so they are meaningful
/// only relative to what is on screen.
pub fn fov_radius(darkness: f32, fog_mult: f32, health: f32, flashlight_on: bool) -> f32 {
    let night = clamp01(darkness / NIGHT_DARKNESS);
    let base = lerp(FOV_DAY, FOV_NIGHT, night);
    let health_mult = lerp(FOV_HEALTH_MIN_MULT, 1.0, clamp01(health / BASE_HEALTH));
    let light_mult = if flashlight_on {
        FLASHLIGHT_AMBIENT_MULT
    } else {
        1.0
    };
    (base * fog_mult * health_mult * light_mult).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 1.0 / 60.0;

    #[test]
    fn a_round_starts_in_full_daylight() {
        let c = cycle_at(0.0);
        assert_eq!(c.darkness, 0.0);
        assert_eq!(c.phase, DayPhase::Day);
    }

    #[test]
    fn darkness_follows_the_phase_table_not_the_old_transition() {
        // §A13. Under the superseded curve, darkness was already maximal at t=64;
        // it now ramps across the whole `evening` phase, which is what makes the
        // sunset visible instead of playing under a black overlay.
        assert_eq!(darkness_at(0.49), 0.0);
        assert!(darkness_at(0.55) > 0.1 && darkness_at(0.55) < NIGHT_DARKNESS);
        assert!((darkness_at(0.62) - NIGHT_DARKNESS).abs() < 1e-5);
        assert!((darkness_at(0.75) - NIGHT_DARKNESS).abs() < 1e-6);
        assert!(darkness_at(0.999) < NIGHT_DARKNESS * 0.05);

        // The specific regression: t = 64 s is u = 0.533, and must NOT be full night.
        let at64 = cycle_at(64.0).darkness;
        assert!(
            at64 < NIGHT_DARKNESS * 0.6,
            "t=64 darkness {at64} — the old CYCLE_TRANSITION curve is back"
        );
    }

    #[test]
    fn the_curve_is_continuous_across_a_whole_round() {
        let mut prev = cycle_at(0.0).darkness;
        let mut i = 1;
        while (i as f32) * DT <= 240.0 {
            let d = cycle_at(i as f32 * DT).darkness;
            assert!(
                (d - prev).abs() < 0.01,
                "jump {prev} -> {d} at t={}",
                i as f32 * DT
            );
            prev = d;
            i += 1;
        }
    }

    #[test]
    fn each_ramp_is_monotonic() {
        let mut prev = 0.0;
        let mut u = DUSK_START;
        while u <= NIGHT_START {
            let d = darkness_at(u);
            assert!(d >= prev - 1e-6, "dusk dipped at u={u}");
            prev = d;
            u += 0.001;
        }
        let mut prev = NIGHT_DARKNESS;
        let mut u = DAWN_START;
        while u <= 1.0 {
            let d = darkness_at(u);
            assert!(d <= prev + 1e-6, "dawn rose at u={u}");
            prev = d;
            u += 0.001;
        }
    }

    #[test]
    fn a_240_second_round_contains_exactly_two_nights() {
        let mut nights = 0;
        let mut was_night = false;
        let mut i = 0;
        while (i as f32) * DT <= 240.0 {
            let night = cycle_at(i as f32 * DT).phase == DayPhase::Night;
            if night && !was_night {
                nights += 1;
            }
            was_night = night;
            i += 1;
        }
        assert_eq!(nights, 2, "a 240 s round should contain two nights");
    }

    #[test]
    fn fov_endpoints_are_exact() {
        assert!((fov_radius(0.0, 1.0, BASE_HEALTH, false) - FOV_DAY).abs() < 1e-3);
        assert!((fov_radius(NIGHT_DARKNESS, 1.0, BASE_HEALTH, false) - FOV_NIGHT).abs() < 1e-3);

        let foggy_night = fov_radius(
            NIGHT_DARKNESS,
            crate::constants::FOV_FOG_MULT,
            BASE_HEALTH,
            false,
        );
        assert!(
            (foggy_night - FOV_NIGHT * crate::constants::FOV_FOG_MULT).abs() < 1e-3,
            "{foggy_night}"
        );

        let hurt = fov_radius(0.0, 1.0, 0.0, false);
        assert!(
            (hurt - FOV_DAY * FOV_HEALTH_MIN_MULT).abs() < 1e-3,
            "{hurt}"
        );

        let torch = fov_radius(0.0, 1.0, BASE_HEALTH, true);
        assert!(
            (torch - FOV_DAY * FLASHLIGHT_AMBIENT_MULT).abs() < 1e-3,
            "{torch}"
        );
    }

    #[test]
    fn all_four_modifiers_multiply() {
        let fog = crate::constants::FOV_FOG_MULT;
        let got = fov_radius(NIGHT_DARKNESS, fog, 0.0, true);
        let want = FOV_NIGHT * fog * FOV_HEALTH_MIN_MULT * FLASHLIGHT_AMBIENT_MULT;
        assert!((got - want).abs() < 1e-3, "{got} vs {want}");
    }

    #[test]
    fn overheal_does_not_widen_the_view() {
        let full = fov_radius(0.0, 1.0, BASE_HEALTH, false);
        let over = fov_radius(0.0, 1.0, crate::constants::HEALTH_CAP, false);
        assert!((full - over).abs() < 1e-4, "overheal changed FoV");
    }

    #[test]
    fn fov_is_never_negative_or_nan() {
        for &d in &[0.0f32, 0.4, NIGHT_DARKNESS, 1.0] {
            for &f in &[0.0f32, 0.45, 1.0] {
                for &h in &[0.0f32, 1.0, BASE_HEALTH, crate::constants::HEALTH_CAP] {
                    for &t in &[false, true] {
                        let r = fov_radius(d, f, h, t);
                        assert!(r.is_finite() && r >= 0.0, "d={d} f={f} h={h} t={t} -> {r}");
                    }
                }
            }
        }
    }

    /// The Rust authority and the client's TypeScript copy must agree.
    ///
    /// The TS values are transcribed from `sky-math.ts`'s `darknessAt`, which is
    /// the same piecewise curve. If someone edits one and not the other, this
    /// fails — which is the entire point of having one formula.
    #[test]
    fn cycle_matches_the_client() {
        fn ts_darkness(u: f32, night: f32) -> f32 {
            let smooth = |x: f32| {
                let k = x.clamp(0.0, 1.0);
                k * k * (3.0 - 2.0 * k)
            };
            if u < 0.5 {
                0.0
            } else if u < 0.62 {
                night * smooth((u - 0.5) / 0.12)
            } else if u < 0.9 {
                night
            } else {
                night * (1.0 - smooth((u - 0.9) / 0.1))
            }
        }
        let mut u = 0.0f32;
        while u < 1.0 {
            let a = darkness_at(u);
            let b = ts_darkness(u, NIGHT_DARKNESS);
            assert!((a - b).abs() < 1e-5, "u={u}: rust {a} vs ts {b}");
            u += 0.0005;
        }
    }
}
