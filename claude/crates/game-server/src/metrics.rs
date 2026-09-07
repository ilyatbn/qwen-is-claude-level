//! `GET /metrics` — plain text, enough to answer "is the server healthy" without
//! wiring up an observability stack (`docs/61-logging-debug.md` §7).
//!
//! Deliberately not Prometheus format in v1. The consumer is a person reading a
//! curl, or an agent reading a paste; the exposition format is future work and
//! the numbers are the point.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// Recent tick durations, for percentiles.
///
/// A ring rather than a histogram: 1024 samples is ~17 s of ticks, percentiles
/// over it describe *now* rather than the whole process lifetime, and "now" is
/// what someone asks about when a round feels bad. A lifetime histogram would
/// average away the ten seconds that mattered.
const RING: usize = 1024;

/// How many ticks a room's worst reading keeps counting for.
///
/// **The same window as `RING`, deliberately** (T20.25): `tick_p99_ms` and
/// `tick_p99_ms_max_over_rooms` are published side by side and the first thing
/// anyone does is compare them, which is only meaningful if they describe the
/// same span. ~17 s of ticks either way.
const ROOM_WINDOW: u32 = RING as u32;

/// Half the tick budget, in micros.
///
/// Half, not the whole budget, for the reason `docs/71` §B2 sets the capacity
/// threshold there: a room at 100 % of budget has no room to catch up in, and
/// `MissedTickBehavior::Burst` makes it catch up in a spike rather than degrade
/// gently. Named once so the test pins the same number `room_health` reads.
const HALF_BUDGET_US: u32 = (1_000_000.0 / crate::SIM_HZ_F / 2.0) as u32;

/// A room's worst tick over a trailing window, kept as two windows so the
/// reading neither stands forever nor drops to zero the instant one rolls.
///
/// **This used to be a bare `u32` and a lifetime `max`** (T20.25). One 20 ms
/// hiccup at startup — a first tick, a descheduled thread, a neighbouring
/// `cargo` build — marked that room "over budget" on `/metrics` for as long as
/// it existed, and `rooms_over_budget` is the number `docs/71` §B2's capacity
/// threshold is expressed against. A signal that can only climb cannot say a
/// server recovered, which is the one thing a capacity decision needs from it.
#[derive(Debug, Default, Clone, Copy)]
struct RoomTicks {
    /// Worst tick in the window being filled.
    current_us: u32,
    /// Worst tick in the window before it. Reported alongside the current one,
    /// so what is published always covers between one and two full windows —
    /// a tumbling window on its own reads healthy for the first tick after
    /// every roll, whatever just happened.
    previous_us: u32,
    /// Samples taken into the current window.
    n: u32,
}

impl RoomTicks {
    fn record(&mut self, micros: u32) {
        self.current_us = self.current_us.max(micros);
        self.n += 1;
        if self.n >= ROOM_WINDOW {
            self.previous_us = self.current_us;
            self.current_us = 0;
            self.n = 0;
        }
    }

    fn worst_us(&self) -> u32 {
        self.current_us.max(self.previous_us)
    }
}

#[derive(Debug)]
pub struct Metrics {
    started: Instant,
    ticks: AtomicU64,
    overruns: AtomicU64,
    commands: AtomicU64,
    inputs_dropped: AtomicU64,
    snapshot_bytes: AtomicU64,
    players: AtomicU64,
    /// Micros, so the ring is integers and the lock is never held for maths.
    tick_us: Mutex<Vec<u32>>,
    /// Per-room worst recent tick, in micros (§B2). **Recent**, not lifetime —
    /// see `RoomTicks`.
    ///
    /// The process-wide `tick_p99_ms` averages every room together, so one room
    /// in trouble is invisible behind seven healthy ones — and one room in
    /// trouble is exactly the thing an operator needs to see, because
    /// `MissedTickBehavior::Burst` makes it catch up in a spike rather than
    /// degrade gently. Keyed by room id; only counted and maxed over, never
    /// iterated for output (§A11).
    room_worst_us: Mutex<HashMap<u32, RoomTicks>>,
}

impl Default for Metrics {
    fn default() -> Self {
        Metrics {
            started: Instant::now(),
            ticks: AtomicU64::new(0),
            overruns: AtomicU64::new(0),
            commands: AtomicU64::new(0),
            inputs_dropped: AtomicU64::new(0),
            snapshot_bytes: AtomicU64::new(0),
            players: AtomicU64::new(0),
            tick_us: Mutex::new(Vec::with_capacity(RING)),
            room_worst_us: Mutex::new(HashMap::new()),
        }
    }
}

impl Metrics {
    /// A room's worst tick over the last `ROOM_WINDOW` ticks or so. Ages out, so
    /// a spike five minutes ago does not make a healthy server look permanently
    /// sick.
    ///
    /// **The comment above said that before the code did** (T20.25). The body
    /// was `*e = (*e).max(micros)` with nothing anywhere resetting or decaying
    /// it: `room_health` reads without clearing, and the only removal is
    /// `forget_room`, called when a room is *dropped*. So it was a running
    /// maximum over the room's whole life, and a running maximum grows with the
    /// number of samples taken — which is why T20.14 could not compare "worst
    /// room tick" across runs of different lengths and cannot use it to answer
    /// whether per-tick cost grows with the number of rooms.
    ///
    /// **Aged out here rather than reset on read.** Reset-on-read matches the
    /// old comment's "since it last reported" more literally, but it makes
    /// `/metrics` a sampling interface where two scrapes race for the data and
    /// the second sees zeros — and `render` calls `room_health` twice, so the
    /// two published numbers would have disagreed by construction. A trailing
    /// window is what a dashboard wants and does not care who reads it.
    ///
    /// **Counted in ticks rather than wall-clock** for the reason `RING` is: a
    /// room ticks at `SIM_HZ` whatever else the box is doing, so a sample count
    /// *is* a duration here, it costs no clock read on a path that runs every
    /// tick for every room, and it makes the behaviour testable without a sleep.
    pub fn record_room_tick(&self, room: u32, micros: u32) {
        if let Ok(mut m) = self.room_worst_us.lock() {
            m.entry(room).or_default().record(micros);
        }
    }

    pub fn forget_room(&self, room: u32) {
        if let Ok(mut m) = self.room_worst_us.lock() {
            m.remove(&room);
        }
    }

    /// (worst room tick in ms, how many rooms are over half the tick budget),
    /// both over the trailing window rather than over all time (T20.25).
    ///
    /// Does not clear what it reads: see `record_room_tick` for why the ageing
    /// lives on the write side.
    pub fn room_health(&self) -> (f64, usize) {
        match self.room_worst_us.lock() {
            Ok(m) => {
                let worst = m.values().map(RoomTicks::worst_us).max().unwrap_or(0);
                let over = m.values().filter(|v| v.worst_us() > HALF_BUDGET_US).count();
                (worst as f64 / 1000.0, over)
            }
            Err(_) => (0.0, 0),
        }
    }

    pub fn record_tick(&self, micros: u32, commands: u32) {
        self.ticks.fetch_add(1, Ordering::Relaxed);
        self.commands.fetch_add(commands as u64, Ordering::Relaxed);
        // A poisoned lock here must not take the room down: metrics are an
        // observation of the game, never a participant in it.
        if let Ok(mut ring) = self.tick_us.lock() {
            if ring.len() < RING {
                ring.push(micros);
            } else {
                let i = (self.ticks.load(Ordering::Relaxed) as usize) % RING;
                ring[i] = micros;
            }
        }
    }

    pub fn record_overrun(&self) {
        self.overruns.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_inputs_dropped(&self, n: u64) {
        self.inputs_dropped.fetch_add(n, Ordering::Relaxed);
    }

    pub fn record_snapshot(&self, bytes: usize) {
        self.snapshot_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub fn players(&self) -> u64 {
        self.players.load(Ordering::Relaxed)
    }

    pub fn set_players(&self, n: usize) {
        self.players.store(n as u64, Ordering::Relaxed);
    }

    fn percentile(&self, p: f64) -> f64 {
        let Ok(ring) = self.tick_us.lock() else {
            return 0.0;
        };
        if ring.is_empty() {
            return 0.0;
        }
        let mut v = ring.clone();
        v.sort_unstable();
        // Nearest-rank, clamped: with 1024 samples the interpolation a "proper"
        // percentile would add is smaller than the measurement noise.
        let idx = ((v.len() as f64 - 1.0) * p).round() as usize;
        v[idx.min(v.len() - 1)] as f64 / 1000.0
    }

    pub fn render(&self, rooms: usize) -> String {
        let uptime = self.started.elapsed().as_secs_f64().max(0.001);
        let ticks = self.ticks.load(Ordering::Relaxed);
        let commands = self.commands.load(Ordering::Relaxed);
        format!(
            "uptime_s {:.0}\n\
             rooms {rooms}\n\
             players {}\n\
             ticks {ticks}\n\
             tick_p50_ms {:.2}\n\
             tick_p99_ms {:.2}\n\
             tick_overruns {}\n\
             snapshot_bytes_per_s {:.0}\n\
             commands_per_tick_avg {:.2}\n\
             inputs_dropped {}\n\
             rooms_active {rooms}\n\
             tick_p99_ms_max_over_rooms {:.2}\n\
             rooms_over_budget {}\n",
            uptime,
            self.players.load(Ordering::Relaxed),
            self.percentile(0.50),
            self.percentile(0.99),
            self.overruns.load(Ordering::Relaxed),
            self.snapshot_bytes.load(Ordering::Relaxed) as f64 / uptime,
            if ticks == 0 {
                0.0
            } else {
                commands as f64 / ticks as f64
            },
            self.inputs_dropped.load(Ordering::Relaxed),
            self.room_health().0,
            self.room_health().1,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_server_renders_zeros_rather_than_nan() {
        let m = Metrics::default();
        let out = m.render(1);
        assert!(out.contains("ticks 0"), "{out}");
        assert!(out.contains("commands_per_tick_avg 0.00"), "{out}");
        assert!(out.contains("tick_p50_ms 0.00"), "{out}");
        assert!(!out.contains("NaN"), "{out}");
    }

    #[test]
    fn percentiles_track_the_samples() {
        let m = Metrics::default();
        for i in 1..=100u32 {
            m.record_tick(i * 1000, 0); // 1 ms .. 100 ms
        }
        let out = m.render(1);
        let p50 = m.percentile(0.50);
        let p99 = m.percentile(0.99);
        assert!((49.0..=52.0).contains(&p50), "p50 was {p50}: {out}");
        assert!((98.0..=100.0).contains(&p99), "p99 was {p99}: {out}");
        assert!(p99 > p50, "p99 must exceed p50");
    }

    /// The ring must describe *recent* ticks. A lifetime histogram would let a
    /// healthy first minute hide a bad one now, which is the opposite of what
    /// someone asking "why does it feel bad" needs.
    #[test]
    fn the_ring_forgets_old_samples() {
        let m = Metrics::default();
        for _ in 0..RING {
            m.record_tick(1_000, 0); // 1 ms
        }
        assert!(m.percentile(0.99) < 2.0);
        for _ in 0..RING {
            m.record_tick(50_000, 0); // 50 ms
        }
        let p50 = m.percentile(0.50);
        assert!(
            p50 > 40.0,
            "the ring is still reporting the old fast ticks: p50 {p50}"
        );
    }

    #[test]
    fn averages_are_per_tick_not_per_command() {
        let m = Metrics::default();
        m.record_tick(1000, 4);
        m.record_tick(1000, 6);
        assert!(m.render(1).contains("commands_per_tick_avg 5.00"));
    }

    /// **A spike must age out** (T20.25), and the pair of assertions is what
    /// makes each half mean something.
    ///
    /// `rooms_over_budget` is what `docs/71` §B2's capacity threshold reads. It
    /// used to be a lifetime maximum, so one 20 ms hiccup at startup marked the
    /// room over budget for as long as it existed and the number could only
    /// climb. Written against the *other* choice this task considered — a
    /// lifetime high-water mark — the final assertion here fails.
    #[test]
    fn a_rooms_worst_tick_ages_out_instead_of_standing_forever() {
        let m = Metrics::default();
        let spike = HALF_BUDGET_US * 2;
        let healthy = HALF_BUDGET_US / 8;

        // The presence control. Without it "the room is not over budget" at the
        // end is satisfied by a metric that never noticed the spike at all.
        m.record_room_tick(1, spike);
        assert_eq!(
            m.room_health().1,
            1,
            "the spike was not counted as over budget in the first place"
        );
        assert!(
            m.room_health().0 >= f64::from(spike) / 1000.0,
            "the spike was not reported: {:?}",
            m.room_health()
        );

        // It must survive a while, or this is reset-on-read wearing a window.
        for _ in 0..ROOM_WINDOW {
            m.record_room_tick(1, healthy);
        }
        assert_eq!(
            m.room_health().1,
            1,
            "the spike vanished within one window — the reading drops to healthy \
             the instant a window rolls, whatever just happened"
        );

        // And it must then go.
        for _ in 0..ROOM_WINDOW {
            m.record_room_tick(1, healthy);
        }
        assert_eq!(
            m.room_health().1,
            0,
            "the room still reads over budget after two clear windows: {:?}",
            m.room_health()
        );
        assert!(
            m.room_health().0 < f64::from(HALF_BUDGET_US) / 1000.0,
            "the worst reading did not come down: {:?}",
            m.room_health()
        );
    }

    /// The control for the test above, in the other direction: a room that is
    /// *genuinely* slow keeps reading slow. Ageing that took the signal away
    /// from a room still missing its budget would be worse than never ageing.
    #[test]
    fn a_room_that_stays_slow_keeps_reading_over_budget() {
        let m = Metrics::default();
        for _ in 0..ROOM_WINDOW * 3 {
            m.record_room_tick(1, HALF_BUDGET_US * 2);
        }
        assert_eq!(m.room_health().1, 1, "a slow room stopped being reported");
    }

    /// Both published numbers come from the same reading, and `render` asks for
    /// it twice. A reset-on-read design would have zeroed the second answer;
    /// this pins that they agree.
    #[test]
    fn render_reports_the_same_room_health_twice() {
        let m = Metrics::default();
        m.record_room_tick(1, HALF_BUDGET_US * 2);
        let out = m.render(1);
        assert!(
            out.contains("rooms_over_budget 1"),
            "the second read of room_health disagreed with the first: {out}"
        );
        assert!(
            !out.contains("tick_p99_ms_max_over_rooms 0.00"),
            "the first read reported nothing: {out}"
        );
    }
}
