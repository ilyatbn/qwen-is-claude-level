//! Solar flares (T22.08A): a prominence loop — a fiery ribbon arched between two
//! footpoints — that wanders a space map and burns whoever it touches.
//!
//! **Not `BurnField`** (`M22-RULINGS` R12, R27). That type is "damaging ground
//! zones", its centre-plus-half-width overlap is not safe for anything thin, and —
//! the decisive reason — the hazard wire has no move event, so a moving hazard
//! cannot ride it. The flare is instead **a pure function of (effect seed,
//! elapsed, map size)**: the server damages with [`SolarFlare::points_at`], and a
//! networked client draws the very same points through wasm
//! (`GameCore::flare_points`), the `LavaClock` precedent (`R80`). Nothing about it
//! is stored beyond its seed and its start, so nothing about it needs hashing: the
//! scheduler, which *is* hashed, owns both.
//!
//! **The damage is not here.** A touch writes `PlayerState::burning_until` (R79);
//! the burn is logged once a second by `World::step` like radiation's (R81). This
//! file answers only *where the ribbon is* and *does it touch this box*.

use crate::constants::{
    EFFECT_TELEGRAPH, SOLAR_FLARE_DURATION, SOLAR_FLARE_HEIGHT, SOLAR_FLARE_ORBIT,
    SOLAR_FLARE_RIBBON_R, SOLAR_FLARE_SAMPLES, SOLAR_FLARE_SPAN, SOLAR_FLARE_SPEED,
    SOLAR_FLARE_TURN,
};
use crate::math::Vec2;
use crate::rng::{range_f32, substream};
use crate::weapons::flame::circle_touches_box;
use std::f32::consts::{PI, TAU};

/// The loop's extent from its centre: half the span along its axis, the arch's
/// full height across it. The wander keeps the centre this far inside the map so
/// the ribbon never leaves it.
fn reach() -> f32 {
    (SOLAR_FLARE_SPAN * 0.5).hypot(SOLAR_FLARE_HEIGHT) + SOLAR_FLARE_RIBBON_R
}

/// One flare's shape parameters, drawn once from its seed.
///
/// **The wander is an arc at constant speed**: the loop's centre rides a circle of
/// radius `rho` about a seeded point at exactly `SOLAR_FLARE_SPEED`. A Lissajous
/// wander was written first and dropped before it ran — on a Large map its speed
/// is `amp · freq · cos(…)` with `freq` ~0.03 rad/s, so a seed whose phases sat
/// near the turning points would barely move for a whole 12 s flare (reasoned,
/// not measured). An arc's speed is `rho · omega`, the same
/// at every instant.
#[derive(Clone, Debug, PartialEq)]
pub struct SolarFlare {
    /// The circle the loop's centre rides, and where on it the flare starts.
    orbit: Vec2,
    rho: f32,
    /// Radians per second, signed: which way round it goes.
    omega: f32,
    start: f32,
    /// The axis angle at `elapsed = 0`, and which way it turns (±1).
    axis0: f32,
    turn: f32,
    /// Phases for the arch's breathing and the ribbon's ripple.
    breathe: f32,
    ripple: f32,
}

impl SolarFlare {
    /// A flare on a `map_w × map_h` map. `seed` is the effect's own seed — the one
    /// `EffectStart` carries — so the client can build the same flare.
    pub fn new(seed: u64, map_w: f32, map_h: f32) -> Self {
        let mut rng = substream(seed, "solar_flare");
        // The circle must keep the whole loop on the map: its radius is
        // `SOLAR_FLARE_ORBIT` or whatever fits, and its centre is drawn from the
        // rectangle left over.
        let fit_x = map_w * 0.5 - reach();
        let fit_y = map_h * 0.5 - reach();
        let rho = SOLAR_FLARE_ORBIT.min(fit_x).min(fit_y).max(0.0);
        let span_x = (fit_x - rho).max(0.0);
        let span_y = (fit_y - rho).max(0.0);
        let orbit = Vec2::new(
            map_w * 0.5 + range_f32(&mut rng, -span_x, span_x),
            map_h * 0.5 + range_f32(&mut rng, -span_y, span_y),
        );
        let way = if range_f32(&mut rng, 0.0, 1.0) < 0.5 {
            -1.0
        } else {
            1.0
        };
        Self {
            orbit,
            rho,
            omega: if rho > 1.0 {
                way * SOLAR_FLARE_SPEED / rho
            } else {
                0.0
            },
            start: range_f32(&mut rng, 0.0, TAU),
            axis0: range_f32(&mut rng, 0.0, TAU),
            turn: if range_f32(&mut rng, 0.0, 1.0) < 0.5 {
                -1.0
            } else {
                1.0
            },
            breathe: range_f32(&mut rng, 0.0, TAU),
            ripple: range_f32(&mut rng, 0.0, TAU),
        }
    }

    /// **Does the ribbon exist and burn at `elapsed`?** From the end of the
    /// telegraph for `SOLAR_FLARE_DURATION`. The effect itself stays `Active`
    /// `SOLAR_FLARE_BURN_SECONDS` longer than that (T22.08C F1: the lava way, so no
    /// flare is scheduled whose last burn outlives the round), and for that tail
    /// the ribbon is gone — this is the one statement of when it is there, read by
    /// the server's contact and by the client's drawing (wasm `flare_lit`).
    pub fn lit(elapsed: f32) -> bool {
        (EFFECT_TELEGRAPH..EFFECT_TELEGRAPH + SOLAR_FLARE_DURATION).contains(&elapsed)
    }

    /// Where the loop's centre (the midpoint of its footpoints) is.
    pub fn centre_at(&self, elapsed: f32) -> Vec2 {
        self.orbit + Vec2::from_angle(self.start + self.omega * elapsed) * self.rho
    }

    /// The ribbon's centre line at `elapsed` seconds after the effect started,
    /// footpoint to footpoint, `SOLAR_FLARE_SAMPLES` points.
    pub fn points_at(&self, elapsed: f32) -> Vec<Vec2> {
        let n = SOLAR_FLARE_SAMPLES.max(2);
        let c = self.centre_at(elapsed);
        let theta = self.axis0 + self.turn * SOLAR_FLARE_TURN * elapsed;
        let axis = Vec2::new(theta.cos(), theta.sin());
        // The arch rises to the axis's left: "up" on screen when the axis points right.
        let up = Vec2::new(theta.sin(), -theta.cos());
        let height = SOLAR_FLARE_HEIGHT * (0.85 + 0.15 * (1.3 * elapsed + self.breathe).sin());
        // A ripple along the ribbon, zero at the footpoints, well inside its width
        // so the sample spacing still covers it.
        let ripple = SOLAR_FLARE_RIBBON_R * 0.5;
        (0..n)
            .map(|i| {
                let u = i as f32 / (n - 1) as f32;
                let along = (u - 0.5) * SOLAR_FLARE_SPAN;
                let arch = (PI * u).sin();
                let lift = height * arch
                    + ripple * arch * (TAU * 2.0 * u + 2.2 * elapsed + self.ripple).sin();
                c + axis * along + up * lift
            })
            .collect()
    }

    /// Does the ribbon at `elapsed` touch a `w × h` box centred on `centre`?
    /// Never outside [`Self::lit`] — here rather than at each caller, because the
    /// server and the sandbox both touch through this and a second copy of the
    /// window is a guard one of them would drop (T22.08C F1).
    pub fn touches(&self, elapsed: f32, centre: Vec2, w: f32, h: f32) -> bool {
        Self::lit(elapsed)
            && self
                .points_at(elapsed)
                .into_iter()
                .any(|p| circle_touches_box(p, SOLAR_FLARE_RIBBON_R, centre, w, h))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MapScale, PLAYER_H, PLAYER_W};
    use crate::effects::scheduler::active_duration;
    use crate::weapons::explode::EffectKind;

    const SEEDS: [u64; 6] = [1, 7, 42, 4242, 90210, 31337];
    const SCALES: [MapScale; 3] = [MapScale::Small, MapScale::Medium, MapScale::Large];

    fn flare(seed: u64, scale: MapScale) -> (SolarFlare, f32, f32) {
        let p = scale.params();
        let (w, h) = (p.width as f32, p.height as f32);
        (SolarFlare::new(seed, w, h), w, h)
    }

    /// Times across a whole flare effect: telegraph, ribbon and the burn's tail.
    fn times() -> impl Iterator<Item = f32> {
        let end = EFFECT_TELEGRAPH + active_duration(EffectKind::SolarFlare);
        (0..=(end * 10.0) as u32).map(|i| i as f32 * 0.1)
    }

    #[test]
    fn a_seed_is_a_flare_and_another_seed_is_another() {
        let (a, ..) = flare(4242, MapScale::Medium);
        let (b, ..) = flare(4242, MapScale::Medium);
        let (c, ..) = flare(4243, MapScale::Medium);
        assert_eq!(a.points_at(3.3), b.points_at(3.3));
        assert_ne!(a.points_at(3.3), c.points_at(3.3));
    }

    /// **It moves**, at the speed its constant claims, at every instant — the
    /// owner's "moving at random on the map". Slowest and fastest centre speed,
    /// sampled at 60 Hz over a flare, across seeds and every scale.
    #[test]
    fn the_loop_wanders_at_its_speed() {
        for seed in SEEDS {
            for scale in SCALES {
                let (f, ..) = flare(seed, scale);
                let dt = 1.0 / 60.0;
                let (mut lo, mut hi) = (f32::MAX, 0.0f32);
                let mut prev = f.centre_at(0.0);
                for i in 1..(SOLAR_FLARE_DURATION * 60.0) as u32 {
                    let now = f.centre_at(i as f32 * dt);
                    let v = (now - prev).len() / dt;
                    (lo, hi) = (lo.min(v), hi.max(v));
                    prev = now;
                }
                assert!(
                    lo > SOLAR_FLARE_SPEED * 0.98 && hi < SOLAR_FLARE_SPEED * 1.02,
                    "seed {seed} {scale:?}: centre speed {lo}..{hi} px/s against {SOLAR_FLARE_SPEED}"
                );
            }
        }
    }

    /// The whole ribbon stays on the map at every moment, on every scale.
    #[test]
    fn the_ribbon_never_leaves_the_map() {
        for seed in SEEDS {
            for scale in SCALES {
                let (f, w, h) = flare(seed, scale);
                for t in times() {
                    for p in f.points_at(t) {
                        assert!(
                            p.x >= 0.0 && p.x <= w && p.y >= 0.0 && p.y <= h,
                            "seed {seed} {scale:?} t {t}: {p:?} is off a {w}×{h} map"
                        );
                    }
                }
            }
        }
    }

    /// **No body slips between two samples.** Contact is a circle of
    /// `SOLAR_FLARE_RIBBON_R` at each sample, so two neighbours farther apart
    /// than that leave a gap in the middle of the ribbon a body could stand in.
    /// The control: the same line sampled at a quarter of the points does have
    /// gaps, so this is measuring the spacing and not a degenerate loop.
    #[test]
    fn no_gap_between_samples_is_wider_than_the_ribbon() {
        let mut widest = 0.0f32;
        for seed in SEEDS {
            let (f, ..) = flare(seed, MapScale::Medium);
            for t in times() {
                let pts = f.points_at(t);
                assert_eq!(pts.len(), SOLAR_FLARE_SAMPLES as usize);
                for w in pts.windows(2) {
                    widest = widest.max((w[1] - w[0]).len());
                }
                let coarse: Vec<Vec2> = pts.iter().step_by(4).copied().collect();
                let coarse_gap = coarse
                    .windows(2)
                    .map(|w| (w[1] - w[0]).len())
                    .fold(0.0, f32::max);
                assert!(
                    coarse_gap > SOLAR_FLARE_RIBBON_R,
                    "control: a quarter of the samples left no gap ({coarse_gap})"
                );
            }
        }
        assert!(
            widest <= SOLAR_FLARE_RIBBON_R,
            "two neighbouring samples are {widest} px apart, wider than the \
             {SOLAR_FLARE_RIBBON_R} px ribbon — a body can stand in the gap"
        );
    }

    /// A body standing on the ribbon touches it; the same body moved clear of
    /// every sample by more than the ribbon's radius does not.
    #[test]
    fn a_body_on_the_ribbon_touches_it_and_one_beside_it_does_not() {
        for seed in SEEDS {
            let (f, ..) = flare(seed, MapScale::Medium);
            let t = 5.0;
            let pts = f.points_at(t);
            let on = pts[pts.len() / 2];
            assert!(
                f.touches(t, on, PLAYER_W, PLAYER_H),
                "seed {seed}: standing on the arch"
            );
            // Straight "up" from the arch's top by more than the box and the
            // ribbon: the arch is the loop's farthest point in that direction.
            let theta = f.axis0 + f.turn * SOLAR_FLARE_TURN * t;
            let up = Vec2::new(theta.sin(), -theta.cos());
            let clear = on + up * (PLAYER_H + SOLAR_FLARE_RIBBON_R * 2.0);
            assert!(
                !f.touches(t, clear, PLAYER_W, PLAYER_H),
                "seed {seed}: a body {} px above the arch was burned",
                PLAYER_H + SOLAR_FLARE_RIBBON_R * 2.0
            );
        }
    }
}
