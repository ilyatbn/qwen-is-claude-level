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
    pub registry: std::sync::Arc<std::sync::Mutex<crate::registry::RoomRegistry>>,
    config: std::sync::Arc<crate::config::Config>,
    /// Kept for API compatibility; rooms are stopped through the registry.
    pub shutdown: tokio::sync::oneshot::Sender<()>,
}

impl Stack {
    /// The room a test wants when it only ever wants one, **created on first
    /// call**.
    ///
    /// §C18 removed the room that used to be created at startup. Tests that
    /// predate the registry still want "the room", so they get one here — and
    /// because it is lazy, a test that never asks still sees a server with zero
    /// rooms, which is the property the amendment is about.
    pub fn default_room(&self) -> crate::registry::RoomId {
        let mut r = match self.registry.lock() {
            Ok(r) => r,
            Err(p) => p.into_inner(),
        };
        if let Some(id) = r.ids().first().copied() {
            return id;
        }
        let (id, _) = r
            .create(self.config.map_scale, false)
            .expect("an empty registry is always under MAX_ROOMS");
        id
    }

    pub fn room(&self) -> crate::room::RoomHandle {
        let id = self.default_room();
        let r = match self.registry.lock() {
            Ok(r) => r,
            Err(p) => p.into_inner(),
        };
        r.get(id).expect("just created").handle.clone()
    }

    /// Create the default room **and start its round**, the way a player does.
    ///
    /// §C18 means a room now waits in `Lobby`, so a harness that waits for the
    /// first tick waits forever. This presses "Start with bots" for it. It is
    /// the same command the socket handler sends — not a back door that skips
    /// the path players take, which would let the lobby break without a test
    /// noticing.
    pub fn start_default_room(&self) -> crate::room::RoomHandle {
        let h = self.room();
        h.send(crate::room::Command::StartWithBots(0));
        h
    }

    pub fn sessions(&self) -> std::sync::Arc<crate::session::SessionMap> {
        let id = self.default_room();
        let r = match self.registry.lock() {
            Ok(r) => r,
            Err(p) => p.into_inner(),
        };
        r.get(id).expect("just created").sessions.clone()
    }
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

    // The registry owns every room. §C18: it starts **empty**. A room used to
    // be created here, at server startup, with bots seated and ticking — so
    // every player who connected landed in a battle already in progress.
    // `/healthz` reporting `rooms 0, players 0` on a fresh server is correct.
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

    // --- the room reaper ----------------------------------------------------
    //
    // `RoomRegistry::reap()` has existed since T10.01 with **every one of its
    // callers in its own `#[cfg(test)]` module** (§A39, sixteenth instance). A
    // live server with zero players held `rooms: 2` steady for forty seconds:
    // both rooms logged "last human left; room is on the clock" and then nothing
    // ever removed them. Rooms accumulate for the life of the process, each
    // holding a generated map, and at `MAX_ROOMS` the registry refuses to make
    // another — the symptom a player sees is "create game does nothing".
    //
    // It lives here because a room cannot reap itself: the thing being dropped
    // is the task that would have to do the dropping. `reap()` calls
    // `drop_room`, which sends each room's own shutdown, so the tick stops
    // rather than outliving its registry entry.
    //
    // The task holds a **Weak** reference: when the last owner of the registry
    // goes (a test's `Stack` being dropped), this loop ends with it instead of
    // sweeping a registry nobody can reach for the life of the runtime.
    {
        let registry = std::sync::Arc::downgrade(&registry);
        let period = std::time::Duration::from_secs_f32(game_core::constants::ROOM_REAP_INTERVAL);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(period);
            // The first tick fires immediately; skipping it is not important,
            // but missed ticks must not burst — a stalled runtime would
            // otherwise sweep several times in a row on the way back.
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let Some(reg) = registry.upgrade() else { break };
                let reaped = {
                    let mut r = match reg.lock() {
                        Ok(r) => r,
                        Err(p) => p.into_inner(),
                    };
                    r.reap(std::time::Instant::now())
                };
                if !reaped.is_empty() {
                    tracing::info!(
                        target: "game::round",
                        rooms = ?reaped,
                        "reaped {} empty room(s)",
                        reaped.len()
                    );
                }
            }
        });
    }

    crate::session::register(&io, registry.clone(), config.clone());
    Stack {
        router,
        io,
        registry,
        config,
        shutdown,
    }
}
