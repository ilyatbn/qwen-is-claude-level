//! `GET /metrics` — plain text, enough to answer "is the server healthy" without
//! wiring up an observability stack (`docs/61-logging-debug.md` §7).
//!
//! Deliberately not Prometheus format in v1. The consumer is a person reading a
//! curl, or an agent reading a paste; the exposition format is future work and
//! the numbers are the point.

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
        }
    }
}

impl Metrics {
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
             inputs_dropped {}\n",
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
}
