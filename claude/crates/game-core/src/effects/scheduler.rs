//! The effect scheduler: what fires, when, and in which phase.
//!
//! See `docs/13-weather-effects.md` §1–§2.

use crate::constants::{
    EFFECT_INTERVAL_MAX, EFFECT_INTERVAL_MIN, EFFECT_TELEGRAPH, FOG_DURATION, METEOR_DURATION,
    TOXIC_DURATION,
};
use crate::rng::{pick_weighted, range_f32, substream, ChaCha8Rng};
use crate::weapons::explode::EffectKind;
use rand::Rng;

/// Lava's total active window: the jet, then the burning ground it leaves.
/// Spelled out here rather than inlined because getting this by a phase is the
/// most likely error in the whole milestone (`docs/13-weather-effects.md` §5).
const LAVA_ACTIVE: f32 = crate::constants::LAVA_JET_DURATION + crate::constants::LAVA_BURN_DURATION;

/// Weights from `docs/13-weather-effects.md` §1, in `KINDS` order.
const WEIGHTS: [u16; 4] = [3, 3, 2, 2];
const KINDS: [EffectKind; 4] = [
    EffectKind::ToxicRain,
    EffectKind::MeteorShower,
    EffectKind::LavaBurst,
    EffectKind::HeavyFog,
];

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum EffectPhase {
    Telegraph,
    Active,
    Done,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ActiveEffect {
    pub id: u32,
    pub kind: EffectKind,
    pub phase: EffectPhase,
    pub started_at: f32,
    pub phase_started_at: f32,
    /// Cosmetic client-side variation only — particle jitter, sprite variants.
    /// Never a hazard position (`docs/13-weather-effects.md` §7).
    pub seed: u64,
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum EffectEvent {
    Started {
        id: u32,
        kind: EffectKind,
        seed: u64,
        duration: f32,
    },
    PhaseChanged {
        id: u32,
        phase: EffectPhase,
    },
    Ended {
        id: u32,
    },
}

/// How long a kind stays in `Active`.
pub fn active_duration(kind: EffectKind) -> f32 {
    match kind {
        EffectKind::ToxicRain => TOXIC_DURATION,
        EffectKind::MeteorShower => METEOR_DURATION,
        EffectKind::LavaBurst => LAVA_ACTIVE,
        EffectKind::HeavyFog => FOG_DURATION,
    }
}

pub struct EffectScheduler {
    rng: ChaCha8Rng,
    next_at: f32,
    active: Vec<ActiveEffect>,
    last_kind: Option<EffectKind>,
    next_id: u32,
    /// Guards against a caller ticking twice with the same `now`, which would
    /// otherwise advance a phase boundary twice.
    last_now: Option<f32>,
}

impl EffectScheduler {
    pub fn new(seed: u64, round_start: f32) -> Self {
        let mut rng = substream(seed, "weather");
        let next_at = round_start + range_f32(&mut rng, EFFECT_INTERVAL_MIN, EFFECT_INTERVAL_MAX);
        Self {
            rng,
            next_at,
            active: Vec::new(),
            last_kind: None,
            next_id: 0,
            last_now: None,
        }
    }

    /// Advance phases, then maybe start one. Call once per tick during `Playing`;
    /// the caller is responsible for not calling it during `Warmup`.
    pub fn tick(&mut self, now: f32, round_ends_at: f32) -> Vec<EffectEvent> {
        let mut events = Vec::new();
        if self.last_now == Some(now) {
            return events;
        }
        self.last_now = Some(now);

        // Phases first, so an effect that ends this tick is out of `active()`
        // before a new one is considered.
        for e in self.active.iter_mut() {
            match e.phase {
                EffectPhase::Telegraph => {
                    if now - e.phase_started_at >= EFFECT_TELEGRAPH {
                        e.phase = EffectPhase::Active;
                        e.phase_started_at = now;
                        events.push(EffectEvent::PhaseChanged {
                            id: e.id,
                            phase: EffectPhase::Active,
                        });
                    }
                }
                EffectPhase::Active => {
                    if now - e.phase_started_at >= active_duration(e.kind) {
                        e.phase = EffectPhase::Done;
                        e.phase_started_at = now;
                        events.push(EffectEvent::Ended { id: e.id });
                    }
                }
                EffectPhase::Done => {}
            }
        }
        self.active.retain(|e| e.phase != EffectPhase::Done);

        if now >= self.next_at {
            let kind = self.roll_kind();
            // An effect that outlives the round would kill someone after the
            // scoreboard is up.
            if now + EFFECT_TELEGRAPH + active_duration(kind) <= round_ends_at {
                let id = self.next_id;
                self.next_id += 1;
                let seed = self.rng.gen::<u64>();
                self.active.push(ActiveEffect {
                    id,
                    kind,
                    phase: EffectPhase::Telegraph,
                    started_at: now,
                    phase_started_at: now,
                    seed,
                });
                self.last_kind = Some(kind);
                events.push(EffectEvent::Started {
                    id,
                    kind,
                    seed,
                    duration: active_duration(kind),
                });
            }
            // Advance from the scheduled time, not from `now`, so the cadence does
            // not drift by a tick each interval.
            self.next_at += range_f32(&mut self.rng, EFFECT_INTERVAL_MIN, EFFECT_INTERVAL_MAX);
        }

        events
    }

    /// Weighted, and **never** the same kind twice running.
    ///
    /// `docs/13-weather-effects.md` §1 asks for two things that the implementation
    /// it suggests cannot both deliver: "never repeat the same effect twice in a
    /// row" and "re-roll once if it comes up again". Re-rolling once still repeats
    /// with probability `w_i / total` on the second draw — measured at **9 %** per
    /// step for the weight-3 kinds, which over 1000 effects is a certainty.
    ///
    /// Zeroing the last kind's weight and drawing once satisfies both: a repeat is
    /// impossible by construction, and a single draw from the remaining weights is
    /// exactly the conditional distribution given "not the same kind", so it is
    /// unbiased. (The task file's warning is about a re-roll *loop*, which would
    /// bias toward the rarer kinds. This is not a loop.)
    ///
    /// The resulting stationary distribution is 0.284/0.284/0.216/0.216 against
    /// raw weights of 0.30/0.30/0.20/0.20 — the no-repeat rule necessarily shifts
    /// mass toward the lighter kinds, and that shift is the same for any correct
    /// implementation of "never repeat".
    fn roll_kind(&mut self) -> EffectKind {
        let mut weights = WEIGHTS;
        if let Some(last) = self.last_kind {
            if let Some(i) = KINDS.iter().position(|k| *k == last) {
                weights[i] = 0;
            }
        }
        KINDS[pick_weighted(&mut self.rng, &weights)]
    }

    pub fn active(&self) -> &[ActiveEffect] {
        &self.active
    }

    /// True only during `Active` — a telegraphing effect is a warning, not a hazard.
    pub fn is_active(&self, kind: EffectKind) -> bool {
        self.active
            .iter()
            .any(|e| e.kind == kind && e.phase == EffectPhase::Active)
    }

    /// Test-only: force an effect to start now, for the sandbox controls and for
    /// the overlap test.
    pub fn force(&mut self, kind: EffectKind, now: f32) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        let seed = self.rng.gen::<u64>();
        self.active.push(ActiveEffect {
            id,
            kind,
            phase: EffectPhase::Telegraph,
            started_at: now,
            phase_started_at: now,
            seed,
        });
        self.last_kind = Some(kind);
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f32 = 1.0 / 60.0;

    /// Simulate for `sim_seconds` and record every (time, kind) started.
    ///
    /// `sim_seconds` and `round_ends_at` are separate arguments on purpose: the
    /// suppression tests want a short simulation against a far-off round end (or
    /// the reverse), and deriving the tick count from the round end once had this
    /// helper simulating 6e10 ticks for a round that ends at 1e9.
    fn run_until(seed: u64, sim_seconds: f32, round_ends_at: f32) -> Vec<(f32, EffectKind)> {
        let mut s = EffectScheduler::new(seed, 0.0);
        let mut out = Vec::new();
        let ticks = (sim_seconds / DT) as u32;
        for i in 0..ticks {
            let now = i as f32 * DT;
            for ev in s.tick(now, round_ends_at) {
                if let EffectEvent::Started { kind, .. } = ev {
                    out.push((now, kind));
                }
            }
        }
        out
    }

    /// Start times only, at an arbitrary tick rate.
    fn start_times(seed: u64, sim_seconds: f32, dt: f32) -> Vec<f32> {
        let mut s = EffectScheduler::new(seed, 0.0);
        let mut out = Vec::new();
        let ticks = (sim_seconds / dt) as u32;
        for i in 0..ticks {
            let now = i as f32 * dt;
            for ev in s.tick(now, 1.0e9) {
                if let EffectEvent::Started { .. } = ev {
                    out.push(now);
                }
            }
        }
        out
    }

    /// A full 240 s round, the common case.
    fn run(seed: u64, round_seconds: f32) -> Vec<(f32, EffectKind)> {
        run_until(seed, round_seconds, round_seconds)
    }

    #[test]
    fn the_same_seed_produces_the_same_schedule() {
        let first = run(4242, 240.0);
        assert!(!first.is_empty());
        for _ in 0..20 {
            assert_eq!(run(4242, 240.0), first);
        }
    }

    #[test]
    fn different_seeds_produce_different_schedules() {
        assert_ne!(run(1, 240.0), run(2, 240.0));
    }

    #[test]
    fn the_first_effect_fires_inside_the_interval_band() {
        for seed in 0..50u64 {
            let s = run(seed, 240.0);
            assert!(!s.is_empty(), "seed {seed} produced no effects");
            let t = s[0].0;
            assert!(
                (EFFECT_INTERVAL_MIN..=EFFECT_INTERVAL_MAX + DT).contains(&t),
                "seed {seed}: first effect at {t}"
            );
        }
    }

    #[test]
    fn intervals_stay_within_the_band() {
        let starts = start_times(7, 10_000.0, DT);
        assert!(starts.len() > 200, "only {} effects", starts.len());
        for w in starts.windows(2) {
            let gap = w[1] - w[0];
            assert!(
                (EFFECT_INTERVAL_MIN - DT..=EFFECT_INTERVAL_MAX + DT).contains(&gap),
                "gap {gap}"
            );
        }
    }

    #[test]
    fn the_cadence_does_not_drift_with_the_tick_rate() {
        // `next_at += interval` and `next_at = now + interval` differ by at most
        // half a tick per interval, so at 60 Hz the drift is invisible — a test
        // that only samples the fine tick rate passes against the bug, which is
        // exactly what an earlier version of this test did.
        //
        // Ticking coarsely magnifies it: at 0.5 s per tick the drift is ~0.25 s
        // per interval, and over 260 intervals that is a full minute of skew. The
        // same seed must produce the same schedule at any tick rate.
        let fine = start_times(7, 10_000.0, DT);
        let coarse = start_times(7, 10_000.0, 0.5);
        let n = fine.len().min(coarse.len());
        assert!(n > 200, "only {n} comparable effects");
        for i in 0..n {
            assert!(
                (fine[i] - coarse[i]).abs() <= 0.5,
                "effect {i}: fine {} vs coarse {} — the schedule follows the tick \
                 rate instead of the clock",
                fine[i],
                coarse[i]
            );
        }
    }

    #[test]
    fn the_same_kind_never_fires_twice_in_a_row() {
        let mut s = EffectScheduler::new(99, 0.0);
        let mut kinds = Vec::new();
        let ticks = (60_000.0 / DT) as u32; // ~1600 effects
        for i in 0..ticks {
            let now = i as f32 * DT;
            for ev in s.tick(now, 1.0e9) {
                if let EffectEvent::Started { kind, .. } = ev {
                    kinds.push(kind);
                }
            }
        }
        assert!(kinds.len() > 1000, "only {} effects", kinds.len());
        for w in kinds.windows(2) {
            assert_ne!(w[0], w[1], "repeated kind in {kinds:?}");
        }
    }

    #[test]
    fn the_weighted_distribution_matches_the_table() {
        let mut s = EffectScheduler::new(31337, 0.0);
        let mut counts = [0usize; 4];
        let ticks = (400_000.0 / DT) as u32; // ~10 600 effects
        for i in 0..ticks {
            let now = i as f32 * DT;
            for ev in s.tick(now, 1.0e9) {
                if let EffectEvent::Started { kind, .. } = ev {
                    let idx = KINDS.iter().position(|k| *k == kind).unwrap();
                    counts[idx] += 1;
                }
            }
        }
        let total: usize = counts.iter().sum();
        assert!(total > 10_000, "only {total} effects");
        // Standard error at this sample size is ~0.004, so 0.012 is a 3-sigma
        // band: tight enough to be meaningful, loose enough not to flake.
        // Not the raw weights: forbidding repeats is a Markov chain, and its
        // stationary distribution is 0.284/0.284/0.216/0.216 for weights 3:3:2:2.
        // Asserting the raw 0.30/0.20 would be asserting the rule does not exist.
        // Still within the task file's 3 % of the nominal weights either way.
        let expected = [0.2838, 0.2838, 0.2162, 0.2162];
        for i in 0..4 {
            let share = counts[i] as f32 / total as f32;
            assert!(
                (share - expected[i]).abs() < 0.012,
                "{:?}: {share:.4} vs {:.4}",
                KINDS[i],
                expected[i]
            );
        }

        // And the shift is observable, not lost in the tolerance: the measured
        // shares must be distinguishable from the raw weights. Without this, the
        // band above would also accept an implementation with no no-repeat rule
        // at all.
        let raw = [0.30, 0.30, 0.20, 0.20];
        let heavy = counts[0] as f32 / total as f32;
        assert!(
            (heavy - raw[0]).abs() > 0.008,
            "weight-3 share {heavy:.4} is indistinguishable from the raw {:.2} — \
             the no-repeat rule is not visible in the output",
            raw[0]
        );
    }

    #[test]
    fn phases_last_exactly_their_durations() {
        for kind in KINDS {
            let mut s = EffectScheduler::new(5, 0.0);
            let id = s.force(kind, 0.0);
            let mut became_active = None;
            let mut ended = None;
            let total = EFFECT_TELEGRAPH + active_duration(kind) + 1.0;
            let ticks = (total / DT) as u32;
            for i in 1..ticks {
                let now = i as f32 * DT;
                for ev in s.tick(now, 1.0e9) {
                    match ev {
                        EffectEvent::PhaseChanged {
                            id: eid,
                            phase: EffectPhase::Active,
                        } if eid == id => became_active = Some(now),
                        EffectEvent::Ended { id: eid } if eid == id => ended = Some(now),
                        _ => {}
                    }
                }
            }
            let a = became_active.expect("never became active");
            let e = ended.expect("never ended");
            assert!(
                (a - EFFECT_TELEGRAPH).abs() <= DT,
                "{kind:?} telegraph {a} vs {EFFECT_TELEGRAPH}"
            );
            assert!(
                (e - a - active_duration(kind)).abs() <= DT,
                "{kind:?} active {} vs {}",
                e - a,
                active_duration(kind)
            );
        }
    }

    #[test]
    fn each_transition_fires_exactly_one_event() {
        let mut s = EffectScheduler::new(5, 0.0);
        let id = s.force(EffectKind::HeavyFog, 0.0);
        let mut actives = 0;
        let mut ends = 0;
        let ticks = ((EFFECT_TELEGRAPH + FOG_DURATION + 5.0) / DT) as u32;
        for i in 1..ticks {
            for ev in s.tick(i as f32 * DT, 1.0e9) {
                match ev {
                    EffectEvent::PhaseChanged { id: e, .. } if e == id => actives += 1,
                    EffectEvent::Ended { id: e } if e == id => ends += 1,
                    _ => {}
                }
            }
        }
        assert_eq!(actives, 1);
        assert_eq!(ends, 1);
    }

    #[test]
    fn no_effect_starts_that_would_outlive_the_round() {
        // 240 s round: nothing may start after 240 - 3 - its duration.
        for seed in 0..60u64 {
            let mut s = EffectScheduler::new(seed, 0.0);
            let ticks = (240.0 / DT) as u32;
            for i in 0..ticks {
                let now = i as f32 * DT;
                for ev in s.tick(now, 240.0) {
                    if let EffectEvent::Started { kind, .. } = ev {
                        let ends = now + EFFECT_TELEGRAPH + active_duration(kind);
                        assert!(ends <= 240.0, "seed {seed}: {kind:?} ends at {ends}");
                    }
                }
            }
        }
    }

    #[test]
    fn suppression_actually_fires() {
        // Guards the previous test against passing vacuously. Take a seed's first
        // effect from an unsuppressed run, then re-run with the round ending just
        // before that effect could finish: it must not start.
        let baseline = run_until(4242, EFFECT_INTERVAL_MAX + 1.0, 1.0e9);
        let (t0, kind0) = baseline[0];
        let ends_at = t0 + EFFECT_TELEGRAPH + active_duration(kind0) - 0.5;

        let mut s = EffectScheduler::new(4242, 0.0);
        let ticks = ((t0 + 1.0) / DT) as u32;
        let mut started = 0;
        for i in 0..ticks {
            for ev in s.tick(i as f32 * DT, ends_at) {
                if let EffectEvent::Started { .. } = ev {
                    started += 1;
                }
            }
        }
        assert_eq!(
            started, 0,
            "{kind0:?} at {t0} should have been suppressed before {ends_at}"
        );

        // And the same scheduler with a round long enough DOES start it, so the
        // assertion above is about suppression and not about the seed being quiet.
        let mut s = EffectScheduler::new(4242, 0.0);
        let mut started = 0;
        for i in 0..ticks {
            for ev in s.tick(i as f32 * DT, 1.0e9) {
                if let EffectEvent::Started { .. } = ev {
                    started += 1;
                }
            }
        }
        assert_eq!(started, 1);
    }

    #[test]
    fn is_active_is_false_during_telegraph() {
        let mut s = EffectScheduler::new(5, 0.0);
        s.force(EffectKind::ToxicRain, 0.0);
        s.tick(DT, 1.0e9);
        assert!(!s.is_active(EffectKind::ToxicRain));
        assert_eq!(s.active()[0].phase, EffectPhase::Telegraph);

        let ticks = ((EFFECT_TELEGRAPH + 0.5) / DT) as u32;
        for i in 2..ticks {
            s.tick(i as f32 * DT, 1.0e9);
        }
        assert!(s.is_active(EffectKind::ToxicRain));
    }

    #[test]
    fn effects_can_overlap() {
        let mut s = EffectScheduler::new(5, 0.0);
        s.force(EffectKind::ToxicRain, 0.0);
        s.force(EffectKind::HeavyFog, 0.0);
        s.tick(DT, 1.0e9);
        assert_eq!(s.active().len(), 2);
        let ticks = ((EFFECT_TELEGRAPH + 0.5) / DT) as u32;
        for i in 2..ticks {
            s.tick(i as f32 * DT, 1.0e9);
        }
        assert!(s.is_active(EffectKind::ToxicRain));
        assert!(s.is_active(EffectKind::HeavyFog));
    }

    #[test]
    fn ticking_twice_with_the_same_now_does_not_double_advance() {
        let mut s = EffectScheduler::new(5, 0.0);
        s.force(EffectKind::HeavyFog, 0.0);
        let t = EFFECT_TELEGRAPH + DT;
        let first = s.tick(t, 1.0e9);
        let second = s.tick(t, 1.0e9);
        assert_eq!(first.len(), 1);
        assert!(second.is_empty());
    }

    #[test]
    fn an_ended_effect_leaves_the_active_list() {
        let mut s = EffectScheduler::new(5, 0.0);
        s.force(EffectKind::HeavyFog, 0.0);
        let ticks = ((EFFECT_TELEGRAPH + FOG_DURATION + 1.0) / DT) as u32;
        for i in 1..ticks {
            s.tick(i as f32 * DT, 1.0e9);
        }
        assert!(s.active().is_empty());
        assert!(!s.is_active(EffectKind::HeavyFog));
    }
}
