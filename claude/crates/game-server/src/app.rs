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
    /// The default room, for tests that predate the registry and only ever want
    /// one. New code should go through `registry`.
    pub room: crate::room::RoomHandle,
    pub sessions: std::sync::Arc<crate::session::SessionMap>,
    pub registry: std::sync::Arc<std::sync::Mutex<crate::registry::RoomRegistry>>,
    pub default_room: crate::registry::RoomId,
    /// Kept for API compatibility; rooms are stopped through the registry.
    pub shutdown: tokio::sync::oneshot::Sender<()>,
}

impl Stack {
    /// Stop every room and wait for the tasks, so a replay footer is written
    /// (`docs/41` §7).
    pub async fn shutdown_all(&self, grace: std::time::Duration) {
        let handles = {
            let mut r = match self.registry.lock() {
                Ok(r) => r,
                Err(p) => p.into_inner(),
            };
            let hs = r.handles();
            for (id, _) in &hs {
                r.drop_room(*id);
            }
            hs
        };
        for (_, h) in handles {
            h.wait_for_shutdown(grace).await;
        }
    }
}

pub fn build_stack(state: AppState) -> Stack {
    let config = std::sync::Arc::new(state.config().clone());
    let state_metrics = state.metrics();
    let rooms_gauge = state.rooms_gauge();
    let (router, io) = build(state);

    // The registry owns every room, including this default one. A process with
    // one room is the same code path as a process with eight — there is no
    // "single room mode" to diverge (`docs/71` §B1).
    let registry = std::sync::Arc::new(std::sync::Mutex::new(
        crate::registry::RoomRegistry::new(
            io.clone(),
            config.clone(),
            std::sync::Arc::new(crate::registry::RealSpawner {
                metrics: Some(state_metrics),
            }),
        )
        .with_gauge(rooms_gauge),
    ));

    let (room, sessions, default_room) = {
        let mut r = registry.lock().expect("fresh registry is never poisoned");
        let (id, _) = r
            .create(config.map_scale, false)
            .expect("the first room is always under MAX_ROOMS");
        let e = r.get(id).expect("just created");
        (e.handle.clone(), e.sessions.clone(), id)
    };

    // One signal that stops every room.
    //
    // Rooms are owned by the registry now, so this cannot be a room's own
    // shutdown channel any more. It is a relay: signalling it drops every room,
    // which sends each room's own shutdown. `main` then waits on the handles, so
    // the replay footer is still written before the process exits (`docs/41`
    // §7) — that path is asserted by two tests and is the `docker compose down`
    // case.
    let (shutdown, rx) = tokio::sync::oneshot::channel::<()>();
    {
        let registry = registry.clone();
        tokio::spawn(async move {
            let _ = rx.await;
            let ids = {
                let r = match registry.lock() {
                    Ok(r) => r,
                    Err(p) => p.into_inner(),
                };
                r.ids().to_vec()
            };
            let mut r = match registry.lock() {
                Ok(r) => r,
                Err(p) => p.into_inner(),
            };
            for id in ids {
                r.drop_room(id);
            }
        });
    }

    crate::session::register(&io, registry.clone(), default_room, config);
    Stack {
        router,
        io,
        room,
        sessions,
        registry,
        default_room,
        shutdown,
    }
}
