//! Router construction: HTTP routes plus the socket.io layer.

use axum::{extract::State, routing::get, Json, Router};
use serde_json::json;
use socketioxide::extract::{Data, SocketRef};
use socketioxide::SocketIo;

use crate::state::AppState;

/// Build the router and hand back the `SocketIo` handle so a caller (the room task,
/// from M6) can emit into it.
pub fn build(state: AppState) -> (Router, SocketIo) {
    let (layer, io) = SocketIo::new_layer();

    io.ns("/", async |socket: SocketRef| {
        tracing::info!(target: "game::net", socket = %socket.id, "socket connected");

        // M0 proof-of-transport: echo whatever arrives straight back. Replaced by
        // the real join/input handlers in M6 (docs/40-net-protocol.md §2).
        socket.on(
            "echo",
            async |socket: SocketRef, Data::<serde_json::Value>(payload)| {
                tracing::debug!(target: "game::net", socket = %socket.id, "echo");
                if let Err(e) = socket.emit("echo_back", &payload) {
                    tracing::warn!(target: "game::net", socket = %socket.id, "echo_back failed: {e}");
                }
            },
        );

        socket.on_disconnect(async |socket: SocketRef| {
            tracing::info!(target: "game::net", socket = %socket.id, "socket disconnected");
        });
    });

    let router = Router::new()
        .route("/healthz", get(healthz))
        .with_state(state)
        .layer(layer);

    (router, io)
}

async fn healthz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "uptime_s": state.uptime_s(),
        "rooms": state.rooms(),
        "players": state.players(),
    }))
}
