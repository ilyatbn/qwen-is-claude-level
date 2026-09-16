//! Ambient rain (T21.26): harmless weather on its own schedule.
//!
//! **Not an effect.** `effects/scheduler.rs` exists to space out dangerous things
//! with a warning, and a rain that hurts nobody has no business in it — no
//! telegraph, no `effect_start`, no slot in the hazard rotation. This is the
//! day/night cycle's shape instead (`world/cycle.rs`): a **pure function of the
//! map seed and the round clock**, which every client can evaluate for itself.
//!
//! ## Why a pure function and not a stream
//!
//! The coordinator's ruling, and the reason is determinism without bookkeeping.
//! A stream that advanced as the round ran would be state: it would have to be
//! hashed, carried in a replay, and re-synchronised for a client that joins late.
//! A function of `(seed, round_time)` is none of those — two clients on one seed
//! agree on whether it is raining by construction, a late joiner needs nothing,
//! and the simulation's state and replay output do not change at all, so
//! `REPLAY_VERSION` does not move.
//!
//! It is still `ChaCha8Rng` (CLAUDE.md): the round is cut into
//! `AMBIENT_RAIN_WINDOW`-second windows, and each window's roll is drawn from a
//! fresh sub-stream keyed by the seed and the window's index. Nothing is kept
//! between calls, and nothing draws from any other stream.
//!
//! ## The shape of a window
//!
//! A window rains with probability `AMBIENT_RAIN_CHANCE`, for a duration drawn
//! from `AMBIENT_RAIN_MIN..AMBIENT_RAIN_MAX`, placed wholly inside the window so a
//! shower never has to ask its neighbour. The intensity ramps in and out over
//! `AMBIENT_RAIN_RAMP` so it never pops.

use crate::constants::{
    AMBIENT_RAIN_CHANCE, AMBIENT_RAIN_MAX, AMBIENT_RAIN_MIN, AMBIENT_RAIN_RAMP, AMBIENT_RAIN_WINDOW,
};
use crate::rng::{chance, range_f32, substream};

/// Where the shower sits inside window `index`, as `(start, end)` in seconds from
/// the window's own start — or `None` for a dry window.
fn shower_in(seed: u64, index: u64) -> Option<(f32, f32)> {
    // The index is folded into the seed before the tag is applied, so window 3 of
    // one map and window 3 of another are unrelated, and so are windows 3 and 4.
    let key = seed ^ index.wrapping_add(1).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut rng = substream(key, "ambient_rain");
    if !chance(&mut rng, AMBIENT_RAIN_CHANCE) {
        return None;
    }
    let len = range_f32(&mut rng, AMBIENT_RAIN_MIN, AMBIENT_RAIN_MAX);
    let start = range_f32(&mut rng, 0.0, (AMBIENT_RAIN_WINDOW - len).max(0.0));
    Some((start, start + len))
}

/// How hard the ambient rain is falling at `round_time`, `0.0..=1.0`.
///
/// Pure: same seed and time, same answer, on the server, in the sandbox and on
/// every networked client.
pub fn ambient_rain_at(seed: u64, round_time: f32) -> f32 {
    if !round_time.is_finite() || round_time < 0.0 {
        return 0.0;
    }
    let index = (round_time / AMBIENT_RAIN_WINDOW).floor();
    let local = round_time - index * AMBIENT_RAIN_WINDOW;
    let Some((start, end)) = shower_in(seed, index as u64) else {
        return 0.0;
    };
    if local < start || local >= end {
        return 0.0;
    }
    let ramp = AMBIENT_RAIN_RAMP.max(f32::EPSILON);
    ((local - start) / ramp)
        .min((end - local) / ramp)
        .clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::SIM_DT;

    const ROUND: f32 = 600.0;
    const STEP: f32 = 0.5;

    fn share_raining(seed: u64) -> f32 {
        let n = (ROUND / STEP) as usize;
        let wet = (0..n)
            .filter(|i| ambient_rain_at(seed, *i as f32 * STEP) > 0.0)
            .count();
        wet as f32 / n as f32
    }

    #[test]
    fn the_same_seed_and_time_give_the_same_rain() {
        for seed in [1u64, 7, 4242] {
            for i in 0..400 {
                let t = i as f32 * 1.37;
                assert_eq!(ambient_rain_at(seed, t), ambient_rain_at(seed, t));
            }
        }
    }

    #[test]
    fn different_seeds_rain_at_different_times_the_control() {
        // "Same seed, same rain" is satisfied by a function that ignores the seed.
        let n = (ROUND / STEP) as usize;
        let differs = (0..n)
            .filter(|i| {
                let t = *i as f32 * STEP;
                (ambient_rain_at(1, t) > 0.0) != (ambient_rain_at(2, t) > 0.0)
            })
            .count();
        assert!(
            differs > 0,
            "seeds 1 and 2 rain at exactly the same moments"
        );
    }

    /// A population claim over many seeds (§A27): it happens, and it does not
    /// take over the round.
    ///
    /// Two kinds of bound, because pinning to the constants alone cannot notice
    /// the constants changing (CLAUDE.md): the measured share must sit near what
    /// the constants predict — so the implementation matches its own rule — and
    /// inside an absolute band that says what "ambient" means, so a schedule
    /// tuned into a permanent drizzle or a once-a-round event goes red too.
    #[test]
    fn it_rains_on_most_maps_for_a_modest_share_of_the_round() {
        let seeds: Vec<u64> = (0..200).collect();
        let shares: Vec<f32> = seeds.iter().map(|s| share_raining(*s)).collect();
        let mean = shares.iter().sum::<f32>() / shares.len() as f32;
        let rained = shares.iter().filter(|s| **s > 0.0).count();

        let predicted =
            AMBIENT_RAIN_CHANCE * (AMBIENT_RAIN_MIN + AMBIENT_RAIN_MAX) / 2.0 / AMBIENT_RAIN_WINDOW;
        println!(
            "AMBIENT {rained}/{} seeds rained in {ROUND} s; mean share {mean:.3}, predicted {predicted:.3}",
            seeds.len()
        );
        assert!(
            (mean - predicted).abs() < predicted * 0.25,
            "measured share {mean:.3} is not what the constants predict ({predicted:.3})"
        );
        assert!(
            rained * 10 >= seeds.len() * 9,
            "only {rained} of {} maps saw any ambient rain in a {ROUND} s round",
            seeds.len()
        );
        assert!(
            (0.05..=0.40).contains(&mean),
            "ambient rain covers {mean:.3} of the round — outside what 'ambient' can mean"
        );
    }

    #[test]
    fn it_ramps_rather_than_popping() {
        // Across every seed's first raining moment, consecutive ticks never jump
        // by more than one tick's worth of ramp.
        let max_step = SIM_DT / AMBIENT_RAIN_RAMP + 1e-4;
        for seed in 0u64..50 {
            let mut last = ambient_rain_at(seed, 0.0);
            let mut t = 0.0;
            while t < ROUND {
                t += SIM_DT;
                let now = ambient_rain_at(seed, t);
                assert!(
                    (now - last).abs() <= max_step,
                    "seed {seed} jumped {last} -> {now} at t={t}"
                );
                last = now;
            }
        }
    }

    #[test]
    fn nonsense_times_are_dry() {
        assert_eq!(ambient_rain_at(1, -5.0), 0.0);
        assert_eq!(ambient_rain_at(1, f32::NAN), 0.0);
        assert_eq!(ambient_rain_at(1, f32::INFINITY), 0.0);
    }

    /// **No place in the hazard cycle.** Evaluating the ambient schedule must not
    /// draw from the weather scheduler's stream — if it did, asking "is it
    /// raining" would move which hazard comes next.
    #[test]
    fn asking_about_ambient_rain_does_not_touch_the_hazard_stream() {
        use crate::effects::scheduler::EffectScheduler;
        let hash = |s: &EffectScheduler| {
            let mut h = blake3::Hasher::new();
            s.hash_into(&mut h);
            h.finalize()
        };
        let a = EffectScheduler::new(4242, 0.0);
        let before = hash(&a);
        for i in 0..10_000 {
            let _ = ambient_rain_at(4242, i as f32 * 0.1);
        }
        assert_eq!(before, hash(&a));
        // The control: the hash does see a draw from that stream.
        let mut b = EffectScheduler::new(4242, 0.0);
        b.drain_one_for_test();
        assert_ne!(
            before,
            hash(&b),
            "the scheduler hash cannot see a drawn value"
        );
    }
}
