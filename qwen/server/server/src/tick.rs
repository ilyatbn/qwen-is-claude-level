//! `tick` — the fixed 20 Hz loop (docs/00 §2, docs/05 §3).
//!
//! T0.3 stub: no rooms yet, just the cadence.

use std::time::Duration;
use tracing::debug;

/// docs/00 §2: fixed tick of 20 Hz (50 ms).
pub const TICK_HZ: u64 = 20;
pub const TICK_DURATION: Duration = Duration::from_millis(1000 / TICK_HZ);
/// docs/00 §2: `dt` handed to the simulation, in seconds (0.05).
/// Used from T2.x onward, when the loop starts driving `Round::step`.
#[allow(dead_code)]
pub const TICK_DT: f32 = 1.0 / TICK_HZ as f32;

/// Run the fixed-tick loop forever.
///
/// T0.3: logs `[tick] n` at debug. Rooms and `Round::step` arrive in T4.x.
pub async fn run() {
    let mut interval = tokio::time::interval(TICK_DURATION);
    // If the loop falls behind, skip missed ticks rather than bursting to
    // catch up — a burst would run the simulation faster than real time.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut tick: u64 = 0;
    loop {
        interval.tick().await;
        debug!("[tick] {tick}");
        tick = tick.wrapping_add(1);
    }
}
