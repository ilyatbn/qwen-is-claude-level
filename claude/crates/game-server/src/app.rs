//! Router construction: HTTP routes plus the socket.io layer.

use axum::{extract::State, routing::get, Json, Router};
use serde_json::json;
use socketioxide::SocketIo;

use crate::state::AppState;

/// Build the router and hand back the `SocketIo` handle.
///
/// Handlers are registered separately by [`crate::session::register`], because they
/// need the room handle — which needs this `SocketIo` to emit into. The cycle is
/// broken by building the layer first and registering the namespace after the room
/// exists.
pub fn build(state: AppState) -> (Router, SocketIo) {
    let (layer, io) = SocketIo::new_layer();

    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics))
        .with_state(state)
        .layer(layer);

    (router, io)
}

/// Reads the same registry `/metrics` does.
///
/// It used to read a separate pair of counters in `AppState` that nothing ever
/// incremented, so a healthy server with two players reported `players: 0` — two
/// sources of truth for one number, and the unused one was the one on the health
/// check.
async fn healthz(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "uptime_s": state.uptime_s(),
        "rooms": state.rooms(),
        "players": state.metrics().players(),
    }))
}

/// Plain text, not Prometheus (`docs/61` §7). The reader is a person with a curl
/// or an agent with a paste.
async fn metrics(State(state): State<AppState>) -> String {
    state.metrics().render(state.rooms())
}

/// The whole stack: router, room task, and socket handlers wired together.
///
/// Returned pieces are what a test needs to drive the server directly; `main`
/// only needs the router.
pub struct Stack {
    pub router: Router,
    pub io: SocketIo,
    pub room: crate::room::RoomHandle,
    pub sessions: std::sync::Arc<crate::session::SessionMap>,
    /// Dropping or sending on this stops the room task.
    pub shutdown: tokio::sync::oneshot::Sender<()>,
}

pub fn build_stack(state: AppState) -> Stack {
    let config = std::sync::Arc::new(state.config().clone());
    let state_metrics = state.metrics();
    // One room per process in v1 (`docs/41` §9 leaves the registry as future
    // work). Set here rather than left at 0, so `/healthz` and `/metrics` report
    // what is actually running.
    state.set_rooms(1);
    let (router, io) = build(state);
    let sessions = std::sync::Arc::new(crate::session::SessionMap::default());
    let (shutdown, rx) = tokio::sync::oneshot::channel();
    let room = crate::room::spawn_room_with(
        io.clone(),
        config.clone(),
        sessions.clone(),
        rx,
        Some(state_metrics),
    );
    crate::session::register(&io, room.clone(), sessions.clone(), config);
    Stack {
        router,
        io,
        room,
        sessions,
        shutdown,
    }
}
