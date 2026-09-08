//! Heavy fog: the only effect that deals no damage, and the only one that
//! changes **daytime** combat.
//!
//! A pure timer — no RNG, no map. That is what lets the client compute the same
//! value locally from the effect's start time without per-tick updates, and what
//! makes it trivially testable (`docs/13-weather-effects.md` §6).

use crate::constants::{FOG_DURATION, FOG_RAMP, FOV_FOG_MULT};
use crate::math::{lerp, smoothstep};

pub struct HeavyFog {
    started_at: f32,
}

impl HeavyFog {
    pub fn new(now: f32) -> Self {
        Self { started_at: now }
    }

    /// 0.0 (clear) .. 1.0 (full fog), ramping in and out over `FOG_RAMP`.
    ///
    /// Smoothstep rather than a linear fade: a linear fog has visible corners at
    /// the moments it starts and stops.
    pub fn strength(&self, now: f32) -> f32 {
        let t = now - self.started_at;
        if t <= 0.0 || t >= FOG_DURATION {
            return 0.0;
        }
        if t < FOG_RAMP {
            return smoothstep(t / FOG_RAMP);
        }
        if t > FOG_DURATION - FOG_RAMP {
            return smoothstep((FOG_DURATION - t) / FOG_RAMP);
        }
        1.0
    }

    /// The FoV multiplier this fog contributes.
    ///
    /// Stacks **multiplicatively** with night in `cycle::fov_radius`, so a foggy
    /// night is `FOV_NIGHT * 0.45` — about three player heights. That is the
    /// design, not an accident of the formula.
    pub fn fov_multiplier(&self, now: f32) -> f32 {
        lerp(1.0, FOV_FOG_MULT, self.strength(now))
    }

    pub fn started_at(&self) -> f32 {
        self.started_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 1.0 / 60.0;

    #[test]
    fn it_ramps_up_holds_and_ramps_down() {
        let f = HeavyFog::new(0.0);
        assert_eq!(f.strength(0.0), 0.0);
        assert!(
            (f.strength(FOG_RAMP) - 1.0).abs() < 1e-5,
            "{}",
            f.strength(FOG_RAMP)
        );
        assert_eq!(f.strength(FOG_DURATION / 2.0), 1.0);
        assert!((f.strength(FOG_DURATION - FOG_RAMP) - 1.0).abs() < 1e-5);
        assert_eq!(f.strength(FOG_DURATION), 0.0);
    }

    #[test]
    fn it_stays_zero_after_it_ends_and_before_it_starts() {
        let f = HeavyFog::new(10.0);
        for t in [-5.0f32, 0.0, 9.9, 10.0] {
            assert_eq!(f.strength(t), 0.0, "at {t}");
        }
        for i in 0..600 {
            let t = 10.0 + FOG_DURATION + i as f32 * DT;
            assert_eq!(f.strength(t), 0.0, "at {t}");
        }
    }

    #[test]
    fn the_curve_is_continuous() {
        // No jump larger than one tick's worth of change, anywhere — including
        // across both ramp boundaries and the end.
        let f = HeavyFog::new(0.0);
        let mut prev = f.strength(-DT);
        let mut i = 0;
        while (i as f32) * DT <= FOG_DURATION + 1.0 {
            let s = f.strength(i as f32 * DT);
            assert!(
                (s - prev).abs() < 0.05,
                "jump {} -> {s} at t={}",
                prev,
                i as f32 * DT
            );
            prev = s;
            i += 1;
        }
    }

    #[test]
    fn each_ramp_is_monotonic() {
        let f = HeavyFog::new(0.0);
        let mut prev = 0.0;
        let mut t = 0.0;
        while t <= FOG_RAMP {
            let s = f.strength(t);
            assert!(s >= prev - 1e-6, "up-ramp dipped at {t}");
            prev = s;
            t += DT;
        }
        let mut prev = 1.0;
        let mut t = FOG_DURATION - FOG_RAMP;
        while t <= FOG_DURATION {
            let s = f.strength(t);
            assert!(s <= prev + 1e-6, "down-ramp rose at {t}");
            prev = s;
            t += DT;
        }
    }

    #[test]
    fn the_multiplier_spans_one_to_the_fog_constant() {
        let f = HeavyFog::new(0.0);
        assert_eq!(f.fov_multiplier(0.0), 1.0);
        assert!((f.fov_multiplier(FOG_DURATION / 2.0) - FOV_FOG_MULT).abs() < 1e-6);
        assert_eq!(f.fov_multiplier(FOG_DURATION + 1.0), 1.0);
    }

    #[test]
    fn fog_is_global_and_takes_no_player() {
        // Asserted structurally: `strength` and `fov_multiplier` take only a time.
        // If either ever grows a player argument, fog has stopped being weather.
        let f = HeavyFog::new(0.0);
        let a = f.fov_multiplier(3.0);
        let b = f.fov_multiplier(3.0);
        assert_eq!(a, b);
    }
}
