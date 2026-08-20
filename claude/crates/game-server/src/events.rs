//! Turning the world's `GameEvent`s into socket.io emissions.
//!
//! Delivery **scope** is the part that matters and it lands in T6.07; this is the
//! broadcast skeleton the room task needs to compile and run.

use game_core::world::GameEvent;
use socketioxide::SocketIo;

/// Broadcast a tick's events. T6.07 replaces this with per-scope delivery.
pub fn flush(io: &SocketIo, events: &[GameEvent]) {
    let _ = (io, events);
}

pub fn emit_round_end(io: &SocketIo, tick: u32, reason: &str) {
    let payload = serde_json::json!({ "tick": tick, "reason": reason });
    tokio::spawn({
        let io = io.clone();
        async move {
            if let Err(e) = io.emit("round_end", &payload).await {
                tracing::warn!(target: "game::net", "round_end emit failed: {e}");
            }
        }
    });
}
