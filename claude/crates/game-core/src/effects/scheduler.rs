//! The effect scheduler: what fires, when, and in which phase.
//!
//! See `docs/13-weather-effects.md` §1–§2.

use crate::constants::{
    EFFECT_INTERVAL_MAX, EFFECT_INTERVAL_MIN, EFFECT_TELEGRAPH, FOG_DURATION, LAVA_ENABLED,
    METEOR_DURATION, SOLAR_FLARE_DURATION, SOLAR_FLARE_WEIGHT, TOXIC_DURATION, TOXIC_RAIN_ENABLED,
};
use crate::map::Map;
use crate::rng::{pick_weighted, range_f32, substream, ChaCha8Rng};
use crate::weapons::explode::EffectKind;
use rand::Rng;

/// Lava's total active window: the jet, then the burning ground it leaves.
/// Spelled out here rather than inlined because getting this by a phase is the
/// most likely error in the whole milestone (`docs/13-weather-effects.md` §5).
const LAVA_ACTIVE: f32 = crate::constants::LAVA_JET_DURATION + crate::constants::LAVA_BURN_DURATION;

/// The flare's `Active` window: the ribbon's life, then the burn it can leave on
/// whoever it touched last (T22.08C F1). The same shape as `LAVA_ACTIVE` for the
/// same reason — `tick` refuses any effect whose `Active` window outlives the
/// round, so the window must include the burn or a flare rolled near the end
/// burns people on the results screen. The ribbon itself is gone for the tail:
/// `flare::SolarFlare::lit`.
const FLARE_ACTIVE: f32 = SOLAR_FLARE_DURATION + crate::constants::SOLAR_FLARE_BURN_SECONDS;

/// Weights from `docs/13-weather-effects.md` §1, in `KINDS` order, and the solar
/// flare's (T22.08A) appended.
const WEIGHTS: [u16; 5] = [3, 3, 2, 2, SOLAR_FLARE_WEIGHT];
const KINDS: [EffectKind; 5] = [
    EffectKind::ToxicRain,
    EffectKind::MeteorShower,
    EffectKind::LavaBurst,
    EffectKind::HeavyFog,
    EffectKind::SolarFlare,
];

/// Which sky a map has, and so which weather it can roll (`M22-RULINGS` R43; R78).
///
/// **Derived at roll time from the map**, never stored and never read off
/// `World::gravity` — R58's rule, the one `World::wildlife_allowed` follows: the
/// map is written once, the gravity field is reassigned after construction by
/// eighteen sites. It is a second axis beside `enabled`, not a change to it:
/// `enabled` stays the build's switches, and this says what the *place* allows.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum WeatherTable {
    /// Every kind but the flare.
    Ground,
    /// Solar flares and meteor showers only (R43): no ground to open, no air to fog.
    Space,
}

impl WeatherTable {
    /// The table for `map`: `Space` exactly when it is a space map.
    pub fn of(map: &Map) -> Self {
        if map.space_geometry().is_some() {
            Self::Space
        } else {
            Self::Ground
        }
    }

    /// May this table roll `kind` at all? Switches aside — that is `enabled`.
    pub fn allows(self, kind: EffectKind) -> bool {
        match self {
            Self::Space => matches!(kind, EffectKind::MeteorShower | EffectKind::SolarFlare),
            Self::Ground => kind != EffectKind::SolarFlare,
        }
    }
}

/// Which kinds this build may roll, in `KINDS` order.
///
/// **The one place the switches are read**, so a kind that is off is off in the
/// scheduler, in the hash and in every test that builds a real scheduler — and a
/// third switch is a line here rather than a new field.
fn enabled_from_constants() -> [bool; KINDS.len()] {
    let mut on = [true; KINDS.len()];
    for (i, k) in KINDS.iter().enumerate() {
        on[i] = match k {
            EffectKind::ToxicRain => TOXIC_RAIN_ENABLED,
            EffectKind::LavaBurst => LAVA_ENABLED,
            _ => true,
        };
    }
    on
}

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
        EffectKind::SolarFlare => FLARE_ACTIVE,
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
    /// Which of `KINDS` may `roll_kind` pick? Read from the constants in every
    /// build; a field only so the switch-on control tests can run beside the
    /// switch-off ones (T21.39, and lava on 2026-09-16).
    ///
    /// **An array indexed by `KINDS`, not a bool per kind.** Two switched-off
    /// kinds meant a second bool, and a third would have meant a third — and the
    /// thing `roll_kind` actually wants is "the weight of a disabled kind is
    /// zero", which is one rule over a table rather than one clause per kind.
    enabled: [bool; KINDS.len()],
}

impl EffectScheduler {
    /// Fold this scheduler's whole state into a world hash.
    ///
    /// Lives here rather than in `World::state_hash` so the fields stay private
    /// and so the obligation is next to them: a new field added above without a
    /// line here silently shrinks the determinism test that guards the entire
    /// project.
    ///
    /// The RNG is hashed by cloning and drawing, which captures the **stream
    /// position**. Two schedulers that have drawn a different number of times
    /// are not equivalent even when every visible field matches, and that
    /// divergence would otherwise stay invisible until the next effect rolled.
    /// Advance the weather stream without doing anything else. Test hook for
    /// proving the world hash notices a stream-position divergence.
    #[cfg(test)]
    pub fn drain_one_for_test(&mut self) {
        let _ = rand::RngCore::next_u64(&mut self.rng);
    }

    pub fn hash_into(&self, h: &mut blake3::Hasher) {
        h.update(&self.next_at.to_le_bytes());
        h.update(&(self.active.len() as u32).to_le_bytes());
        for a in &self.active {
            h.update(&a.id.to_le_bytes());
            h.update(&[a.kind as u8, a.phase as u8]);
            h.update(&a.started_at.to_le_bytes());
            h.update(&a.phase_started_at.to_le_bytes());
            h.update(&a.seed.to_le_bytes());
        }
        h.update(&[self.last_kind.map_or(255, |k| k as u8)]);
        h.update(&self.next_id.to_le_bytes());
        h.update(&self.last_now.unwrap_or(f32::NAN).to_le_bytes());
        for on in self.enabled {
            h.update(&[u8::from(on)]);
        }
        let mut probe = self.rng.clone();
        h.update(&rand::RngCore::next_u64(&mut probe).to_le_bytes());
    }

    pub fn new(seed: u64, round_start: f32) -> Self {
        Self::with_enabled(seed, round_start, enabled_from_constants())
    }

    fn with_enabled(seed: u64, round_start: f32, enabled: [bool; KINDS.len()]) -> Self {
        let mut rng = substream(seed, "weather");
        let next_at = round_start + range_f32(&mut rng, EFFECT_INTERVAL_MIN, EFFECT_INTERVAL_MAX);
        Self {
            rng,
            next_at,
            active: Vec::new(),
            last_kind: None,
            next_id: 0,
            last_now: None,
            enabled,
        }
    }

    /// Advance phases, then maybe start one. Call once per tick during `Playing`;
    /// the caller is responsible for not calling it during `Warmup`. `table` is
    /// the map's (`WeatherTable::of`), read at the roll (R78).
    pub fn tick(&mut self, now: f32, round_ends_at: f32, table: WeatherTable) -> Vec<EffectEvent> {
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
            let kind = self.roll_kind(table);
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
    ///
    /// **A switched-off kind's weight is zeroed**, the same way the last kind's is —
    /// so the variant, its weight and its duration stay, and a draw is still the
    /// conditional distribution over what is left.
    ///
    /// **Two kinds are off as of 2026-09-16** (toxic rain, T21.39; lava, the owner
    /// from play), which leaves meteor 3 and fog 2. Combined with never-repeat that
    /// is not a distribution at all: with exactly two kinds live, the one that did
    /// not just run is the only one with a non-zero weight, so **the weather strictly
    /// alternates meteor, fog, meteor, fog** and the 3:2 weighting stops meaning
    /// anything. That is a consequence of switching two of four off, not a bug here,
    /// and it is what `two_live_kinds_alternate` pins so it is noticed rather than
    /// discovered. Switching either kind back on restores a real draw.
    ///
    /// Never an empty table — three of four weights can now be zero at once, which
    /// is what `a_draw_is_always_possible` guards.
    ///
    /// **And a kind the map's table does not allow is zeroed the same way** (R78):
    /// on the ground the flare's weight is zero, and a zero at the end of the
    /// table leaves `pick_weighted`'s draw exactly where it was, so the ground's
    /// schedule is the schedule it always was. In space only meteor and flare
    /// remain, which is `R43`'s two-live-kinds answer to `R28`.
    fn roll_kind(&mut self, table: WeatherTable) -> EffectKind {
        let mut weights = WEIGHTS;
        for (i, on) in self.enabled.iter().enumerate() {
            if !on || !table.allows(KINDS[i]) {
                weights[i] = 0;
            }
        }
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

    /// Push the next *scheduled* effect out to `until`, if it is sooner.
    ///
    /// `WeatherMode::Always` calls this every tick so the scheduler never rolls
    /// one of its own on top of the effect being forced. It moves `next_at`,
    /// which is already part of the hashed state, rather than adding a `paused`
    /// flag: a second field saying "do not schedule" beside a timestamp saying
    /// when to schedule is two answers to one question, and the timestamp is the
    /// one that was already there.
    ///
    /// It never brings the next effect *forward*, so a caller cannot use it to
    /// make the weather come early.
    pub fn postpone_until(&mut self, until: f32) {
        if self.next_at < until {
            self.next_at = until;
        }
    }

    /// Move every time this scheduler holds forward by `by` seconds, so a round
    /// whose clock starts at `by` sees the same schedule a round starting at 0
    /// does, shifted.
    ///
    /// For `World::start_clock_at` only. Without it a clock that starts past
    /// `EFFECT_INTERVAL_MAX` rolls one effect per tick until `next_at` catches
    /// up, which is a burst no real round ever has.
    pub fn rebase(&mut self, by: f32) {
        self.next_at += by;
        for e in self.active.iter_mut() {
            e.started_at += by;
            e.phase_started_at += by;
        }
        self.last_now = self.last_now.map(|n| n + by);
    }

    /// Record that `id` was **installed** with `seed`, not the one `force` drew.
    ///
    /// T22.08D F4: `World::force_effect` installs a forced effect with
    /// `World::effect_seed` (T19.24), so until this existed `ActiveEffect::seed` held a
    /// number nothing was built from for every forced effect — a field meaning two
    /// things, found by the first reader that wanted it (the join catch-up, which
    /// re-announces a running effect from this list). `force` still draws its seed,
    /// so the stream every later roll takes from does not move.
    pub fn record_seed(&mut self, id: u32, seed: u64) {
        if let Some(e) = self.active.iter_mut().find(|e| e.id == id) {
            e.seed = seed;
        }
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
            for ev in s.tick(now, round_ends_at, WeatherTable::Ground) {
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
            for ev in s.tick(now, 1.0e9, WeatherTable::Ground) {
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
            for ev in s.tick(now, 1.0e9, WeatherTable::Ground) {
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

    /// Every kind started over `sim_seconds` on the ground, counted in `KINDS` order.
    fn kind_counts(s: EffectScheduler, sim_seconds: f32) -> [usize; KINDS.len()] {
        kind_counts_on(s, sim_seconds, WeatherTable::Ground)
    }

    /// The same, under `table`.
    fn kind_counts_on(
        mut s: EffectScheduler,
        sim_seconds: f32,
        table: WeatherTable,
    ) -> [usize; KINDS.len()] {
        let mut counts = [0usize; KINDS.len()];
        let ticks = (sim_seconds / DT) as u32;
        for i in 0..ticks {
            let now = i as f32 * DT;
            for ev in s.tick(now, 1.0e9, table) {
                if let EffectEvent::Started { kind, .. } = ev {
                    let idx = KINDS.iter().position(|k| *k == kind).unwrap();
                    counts[idx] += 1;
                }
            }
        }
        counts
    }

    /// T21.39, the owner's ruling: across many seeds and a long clock, the live
    /// scheduler never starts toxic rain. The control is the next test.
    #[test]
    fn toxic_rain_is_never_rolled_while_switched_off() {
        let toxic = KINDS
            .iter()
            .position(|k| *k == EffectKind::ToxicRain)
            .unwrap();
        let mut total = 0;
        for seed in 0..40u64 {
            let counts = kind_counts(EffectScheduler::new(seed, 0.0), 6_000.0);
            total += counts.iter().sum::<usize>();
            assert_eq!(
                counts[toxic], 0,
                "seed {seed}: toxic rain started {} times with TOXIC_RAIN_ENABLED = \
                 {TOXIC_RAIN_ENABLED} — counts {counts:?}",
                counts[toxic]
            );
        }
        // Not vacuous: the weather kept happening, only without toxic rain.
        assert!(total > 40 * 100, "only {total} effects over 40 seeds");
    }

    /// The control for the test above: the same seeds and clock with the switch on
    /// do roll toxic rain, so "never" is about the switch and not a quiet stream.
    #[test]
    fn the_switch_on_does_roll_toxic_rain() {
        let toxic = KINDS
            .iter()
            .position(|k| *k == EffectKind::ToxicRain)
            .unwrap();
        for seed in 0..40u64 {
            let counts = kind_counts(
                EffectScheduler::with_enabled(seed, 0.0, [true; KINDS.len()]),
                6_000.0,
            );
            assert!(counts[toxic] > 0, "seed {seed}: {counts:?}");
        }
    }

    /// The live odds with the switches where they actually are.
    ///
    /// **Rewritten 2026-09-16 when lava was switched off.** It used to pin
    /// 0.375/0.3125/0.3125 — the shares for weights 3:2:2 over meteor, lava and
    /// fog with toxic rain alone disabled. Lava going off leaves **two** live
    /// kinds, and never-repeat over two kinds is not a distribution: whichever
    /// did not just run is the only one with a non-zero weight, so the run
    /// alternates and both shares are exactly 0.5. The 3:2 weighting no longer
    /// reaches the outcome at all.
    ///
    /// **So this test is derived from the switches rather than from a written
    /// table**, because a hand-solved table is what went stale here. It computes
    /// what the live set implies and checks the run against that — one live kind
    /// would be 1.0, two alternate at 0.5 each, three or more get the Markov
    /// solve back. `two_live_kinds_alternate` pins the alternation itself, which
    /// is the part a share of 0.5 cannot distinguish from a fair coin.
    ///
    /// **Per table** (T22.08A, `R28`'s space arm): the live set is the switches
    /// *and* the map's table, so space is measured as its own run.
    #[test]
    fn the_live_distribution_matches_the_live_switches() {
        for table in [WeatherTable::Ground, WeatherTable::Space] {
            live_distribution_on(table);
        }
    }

    fn live_distribution_on(table: WeatherTable) {
        let live = live_on(table);
        let counts = kind_counts_on(EffectScheduler::new(31337, 0.0), 400_000.0, table);
        let total: usize = counts.iter().sum();
        assert!(total > 10_000, "{table:?}: only {total} effects");

        // Nothing switched off — or not allowed here — ever runs. This is the half
        // that would catch a disabled kind leaking back in, and it does not depend
        // on the shares.
        for i in 0..KINDS.len() {
            if !live.contains(&i) {
                assert_eq!(counts[i], 0, "{table:?}: {:?} ran while not live", KINDS[i]);
            }
        }

        if live.len() == 2 {
            for &i in &live {
                let share = counts[i] as f32 / total as f32;
                assert!(
                    (share - 0.5).abs() < 0.012,
                    "{table:?} {:?}: {share:.4} vs 0.5000 — with two live kinds and \
                     never-repeat the run must alternate",
                    KINDS[i]
                );
            }
        } else {
            // Three or more live: the no-repeat Markov chain is back and the
            // shares are no longer forced. Assert only that every live kind runs,
            // and leave the solved table to the switch-on test below.
            for &i in &live {
                assert!(
                    counts[i] > 0,
                    "{table:?}: {:?} never ran: {counts:?}",
                    KINDS[i]
                );
            }
        }
    }

    /// Indices of the kinds `table` can roll with the switches as built.
    fn live_on(table: WeatherTable) -> Vec<usize> {
        enabled_from_constants()
            .iter()
            .enumerate()
            .filter(|(i, on)| **on && table.allows(KINDS[*i]))
            .map(|(i, _)| i)
            .collect()
    }

    /// **The flare is space's and only space's, and space has none of the
    /// ground's weather** (R43, R78) — each absence beside its presence, on the
    /// same seeds and clock: space does roll flares and meteors, the ground does
    /// roll fog, so neither "never" is a scheduler that rolls nothing.
    #[test]
    fn space_rolls_flares_and_meteors_and_the_ground_never_rolls_a_flare() {
        let at = |k: EffectKind| KINDS.iter().position(|x| *x == k).unwrap();
        for seed in [1u64, 7, 4242, 31337] {
            let space = kind_counts_on(
                EffectScheduler::new(seed, 0.0),
                6_000.0,
                WeatherTable::Space,
            );
            let ground = kind_counts_on(
                EffectScheduler::new(seed, 0.0),
                6_000.0,
                WeatherTable::Ground,
            );
            for k in [
                EffectKind::HeavyFog,
                EffectKind::ToxicRain,
                EffectKind::LavaBurst,
            ] {
                assert_eq!(
                    space[at(k)],
                    0,
                    "seed {seed}: space rolled {k:?}: {space:?}"
                );
            }
            assert_eq!(
                ground[at(EffectKind::SolarFlare)],
                0,
                "seed {seed}: the ground rolled a solar flare: {ground:?}"
            );
            assert!(
                space[at(EffectKind::SolarFlare)] > 0,
                "seed {seed}: no flare in space: {space:?}"
            );
            assert!(
                space[at(EffectKind::MeteorShower)] > 0,
                "seed {seed}: no meteors in space: {space:?}"
            );
            assert!(
                ground[at(EffectKind::HeavyFog)] > 0,
                "control, seed {seed}: no fog on the ground: {ground:?}"
            );
        }
    }

    /// **A zero weight at the end of the table draws identically to no entry**
    /// (R78): the same scheduler with the flare's switch off against the shipped
    /// one, kind by kind and time by time.
    ///
    /// **This is not the guard that the ground's schedule did not move** — both
    /// sides run the same `roll_kind`, so an extra RNG draw planted there moves
    /// both together and this stays green (measured, T22.08C F2). That guard is
    /// `tests/golden.rs::the_standard_weather_schedule_matches_the_golden_table`,
    /// recorded before the flare existed.
    #[test]
    fn the_flare_does_not_move_the_grounds_schedule() {
        let run = |mut s: EffectScheduler| {
            let mut out = Vec::new();
            for i in 0..(3_000.0 / DT) as u32 {
                let now = i as f32 * DT;
                for ev in s.tick(now, 1.0e9, WeatherTable::Ground) {
                    if let EffectEvent::Started { kind, seed, .. } = ev {
                        out.push((now, kind, seed));
                    }
                }
            }
            out
        };
        let mut without = enabled_from_constants();
        without[KINDS.len() - 1] = false;
        let shipped = run(EffectScheduler::new(4242, 0.0));
        assert!(shipped.len() > 50, "only {} effects", shipped.len());
        assert_eq!(
            shipped,
            run(EffectScheduler::with_enabled(4242, 0.0, without))
        );
    }

    /// The 3:3:2:2 table, pinned with the switch **on** — what the rewrite (T21.41)
    /// turns back on, and the control that the zeroing above is the only change.
    #[test]
    fn the_weighted_distribution_matches_the_table() {
        let counts = kind_counts(
            EffectScheduler::with_enabled(31337, 0.0, [true; KINDS.len()]),
            400_000.0,
        );
        let total: usize = counts.iter().sum();
        assert!(total > 10_000, "only {total} effects");
        // Standard error at this sample size is ~0.004, so 0.012 is a 3-sigma
        // band: tight enough to be meaningful, loose enough not to flake.
        // Not the raw weights: forbidding repeats is a Markov chain, and its
        // stationary distribution is 0.284/0.284/0.216/0.216 for weights 3:3:2:2.
        // Asserting the raw 0.30/0.20 would be asserting the rule does not exist.
        // Still within the task file's 3 % of the nominal weights either way.
        // The flare's share is 0 on the ground table (R78), which is the only
        // table a switch-on ground run can use.
        let expected = [0.2838, 0.2838, 0.2162, 0.2162, 0.0];
        for i in 0..KINDS.len() {
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
                for ev in s.tick(now, 1.0e9, WeatherTable::Ground) {
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
            for ev in s.tick(i as f32 * DT, 1.0e9, WeatherTable::Ground) {
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
                for ev in s.tick(now, 240.0, WeatherTable::Ground) {
                    if let EffectEvent::Started { kind, .. } = ev {
                        let ends = now + EFFECT_TELEGRAPH + active_duration(kind);
                        assert!(ends <= 240.0, "seed {seed}: {kind:?} ends at {ends}");
                    }
                }
            }
        }
    }

    /// **A flare's last burn fits in its own window** (T22.08C F1). The ribbon's
    /// last lit instant plus a full `SOLAR_FLARE_BURN_SECONDS` must end inside the
    /// effect's `Active` window, or `no_effect_starts_that_would_outlive_the_round`
    /// passes while a flare rolled near the bell burns people on the results
    /// screen. The control: the ribbon is lit for a real stretch of that window.
    #[test]
    fn a_flares_last_burn_ends_inside_its_window() {
        use crate::constants::SOLAR_FLARE_BURN_SECONDS;
        use crate::effects::flare::SolarFlare;
        let window_end = EFFECT_TELEGRAPH + active_duration(EffectKind::SolarFlare);
        let last_lit = (0..=(window_end / DT) as u32)
            .map(|i| i as f32 * DT)
            .filter(|t| SolarFlare::lit(*t))
            .fold(f32::NAN, f32::max);
        assert!(
            last_lit - EFFECT_TELEGRAPH > SOLAR_FLARE_DURATION * 0.9,
            "control: the ribbon was lit only until {last_lit}"
        );
        assert!(
            last_lit + SOLAR_FLARE_BURN_SECONDS <= window_end,
            "a touch at {last_lit} burns until {} — past the window's end at {window_end}",
            last_lit + SOLAR_FLARE_BURN_SECONDS
        );
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
            for ev in s.tick(i as f32 * DT, ends_at, WeatherTable::Ground) {
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
            for ev in s.tick(i as f32 * DT, 1.0e9, WeatherTable::Ground) {
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
        s.tick(DT, 1.0e9, WeatherTable::Ground);
        assert!(!s.is_active(EffectKind::ToxicRain));
        assert_eq!(s.active()[0].phase, EffectPhase::Telegraph);

        let ticks = ((EFFECT_TELEGRAPH + 0.5) / DT) as u32;
        for i in 2..ticks {
            s.tick(i as f32 * DT, 1.0e9, WeatherTable::Ground);
        }
        assert!(s.is_active(EffectKind::ToxicRain));
    }

    #[test]
    fn effects_can_overlap() {
        let mut s = EffectScheduler::new(5, 0.0);
        s.force(EffectKind::ToxicRain, 0.0);
        s.force(EffectKind::HeavyFog, 0.0);
        s.tick(DT, 1.0e9, WeatherTable::Ground);
        assert_eq!(s.active().len(), 2);
        let ticks = ((EFFECT_TELEGRAPH + 0.5) / DT) as u32;
        for i in 2..ticks {
            s.tick(i as f32 * DT, 1.0e9, WeatherTable::Ground);
        }
        assert!(s.is_active(EffectKind::ToxicRain));
        assert!(s.is_active(EffectKind::HeavyFog));
    }

    #[test]
    fn ticking_twice_with_the_same_now_does_not_double_advance() {
        let mut s = EffectScheduler::new(5, 0.0);
        s.force(EffectKind::HeavyFog, 0.0);
        let t = EFFECT_TELEGRAPH + DT;
        let first = s.tick(t, 1.0e9, WeatherTable::Ground);
        let second = s.tick(t, 1.0e9, WeatherTable::Ground);
        assert_eq!(first.len(), 1);
        assert!(second.is_empty());
    }

    #[test]
    fn an_ended_effect_leaves_the_active_list() {
        let mut s = EffectScheduler::new(5, 0.0);
        s.force(EffectKind::HeavyFog, 0.0);
        let ticks = ((EFFECT_TELEGRAPH + FOG_DURATION + 1.0) / DT) as u32;
        for i in 1..ticks {
            s.tick(i as f32 * DT, 1.0e9, WeatherTable::Ground);
        }
        assert!(s.active().is_empty());
        assert!(!s.is_active(EffectKind::HeavyFog));
    }

    /// **Three of four weights can be zero at once** now that two kinds are
    /// switched off and `roll_kind` also zeroes whatever just ran. This is the
    /// guard that there is still something to draw.
    ///
    /// Falsified by hand: zeroing the fourth (setting `enabled` all-false) makes
    /// `pick_weighted` face an empty table, which is the panic this rules out.
    #[test]
    ///
    /// **Per table** (`R28`'s space arm). And the doc's "panic" is not what an
    /// empty table does: `pick_weighted` returns index 0 on all-zero weights —
    /// `ToxicRain`, a switched-off kind — which is why the second half checks
    /// that everything rolled is live rather than trusting a panic to say so.
    fn a_draw_is_always_possible() {
        for table in [WeatherTable::Ground, WeatherTable::Space] {
            let live = live_on(table);
            assert!(
                live.len() >= 2,
                "{table:?}: only {} weather kind(s) are live — with never-repeat \
                 zeroing one more, a draw has nothing left to pick from",
                live.len()
            );
            // Not a proof by reasoning: roll a real scheduler a long way.
            for seed in [1u64, 7, 4242, 31337] {
                let counts = kind_counts_on(EffectScheduler::new(seed, 0.0), 6_000.0, table);
                assert!(
                    counts.iter().sum::<usize>() > 0,
                    "{table:?} seed {seed} started no effects at all in 6000 s: {counts:?}"
                );
                for (i, n) in counts.iter().enumerate() {
                    assert!(
                        *n == 0 || live.contains(&i),
                        "{table:?} seed {seed}: {:?} ran {n} times and is not live",
                        KINDS[i]
                    );
                }
            }
        }
    }

    /// **With exactly two kinds live the weather alternates**, because
    /// never-repeat leaves precisely one non-zero weight. Pinned so the
    /// consequence of switching two of four off is visible here rather than
    /// discovered in a match.
    ///
    /// Falsified by re-enabling a third kind in `enabled`: the run stops
    /// alternating and the assertion reds.
    #[test]
    ///
    /// **Per table, and no longer silently blind** (`R28`). The ground arm still
    /// skips itself if a third kind comes back on — the property is not claimed
    /// then — but space's table is two kinds by ruling (R43), so its arm must run,
    /// and the last assertion says so if it did not.
    fn two_live_kinds_alternate() {
        let mut checked = Vec::new();
        for table in [WeatherTable::Ground, WeatherTable::Space] {
            let live: Vec<EffectKind> = live_on(table).into_iter().map(|i| KINDS[i]).collect();
            if live.len() != 2 {
                continue; // a third kind came back on here; not claimed then
            }
            let mut s = EffectScheduler::new(2026, 0.0);
            let mut seen: Vec<EffectKind> = Vec::new();
            let ticks = (6_000.0 / DT) as u32;
            for i in 0..ticks {
                for ev in s.tick(i as f32 * DT, 1.0e9, table) {
                    if let EffectEvent::Started { kind, .. } = ev {
                        seen.push(kind);
                    }
                }
            }
            assert!(
                seen.len() >= 6,
                "{table:?}: only {} effects started",
                seen.len()
            );
            for w in seen.windows(2) {
                assert_ne!(
                    w[0], w[1],
                    "{table:?}: the same kind ran twice running: {seen:?}"
                );
            }
            for k in &seen {
                assert!(
                    live.contains(k),
                    "{table:?}: {k:?} ran while not live: {seen:?}"
                );
            }
            checked.push(table);
        }
        assert!(
            checked.contains(&WeatherTable::Space),
            "space's table is not two kinds any more ({:?}), so R43's alternation \
             went unchecked — R28's blind spot",
            live_on(WeatherTable::Space)
        );
    }
}
