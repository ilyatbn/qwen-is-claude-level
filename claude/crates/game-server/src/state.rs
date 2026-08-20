//! Process-wide shared state. At M0 this is the config, the start time and two
//! counters that `/healthz` reports. Rooms land in M6.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crate::config::Config;

#[derive(Debug)]
pub struct Inner {
    pub config: Config,
    pub started: Instant,
    pub rooms: AtomicUsize,
    pub players: AtomicUsize,
    pub metrics: std::sync::Arc<crate::metrics::Metrics>,
}

/// Cheap to clone; every handler gets one.
#[derive(Debug, Clone)]
pub struct AppState(Arc<Inner>);

impl AppState {
    pub fn new(config: Config) -> Self {
        AppState(Arc::new(Inner {
            config,
            started: Instant::now(),
            rooms: AtomicUsize::new(0),
            players: AtomicUsize::new(0),
            metrics: std::sync::Arc::new(crate::metrics::Metrics::default()),
        }))
    }

    pub fn metrics(&self) -> std::sync::Arc<crate::metrics::Metrics> {
        self.0.metrics.clone()
    }

    pub fn config(&self) -> &Config {
        &self.0.config
    }

    pub fn uptime_s(&self) -> u64 {
        self.0.started.elapsed().as_secs()
    }

    pub fn rooms(&self) -> usize {
        self.0.rooms.load(Ordering::Relaxed)
    }

    pub fn players(&self) -> usize {
        self.0.players.load(Ordering::Relaxed)
    }

    pub fn add_player(&self, delta: isize) {
        if delta >= 0 {
            self.0.players.fetch_add(delta as usize, Ordering::Relaxed);
        } else {
            // saturating: a double-decrement must not wrap to usize::MAX and make
            // /healthz report four billion players.
            let _ = self
                .0
                .players
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |p| {
                    Some(p.saturating_sub(delta.unsigned_abs()))
                });
        }
    }

    pub fn set_rooms(&self, n: usize) {
        self.0.rooms.store(n, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_count_never_wraps_below_zero() {
        let s = AppState::new(Config::default());
        assert_eq!(s.players(), 0);
        s.add_player(1);
        s.add_player(1);
        assert_eq!(s.players(), 2);
        s.add_player(-5);
        assert_eq!(s.players(), 0, "must saturate, not wrap");
    }

    #[test]
    fn rooms_and_uptime_report() {
        let s = AppState::new(Config::default());
        s.set_rooms(1);
        assert_eq!(s.rooms(), 1);
        assert!(s.uptime_s() < 5);
    }
}
