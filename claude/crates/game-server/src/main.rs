//! The game server process: axum + socketioxide + tracing.
//!
//! At M0 this is a process that starts, logs properly, answers `/healthz` and
//! proves the socket.io transport works end to end. Room logic and the tick loop
//! arrive in M6 (`docs/41-server-loop-rooms.md`).

use std::net::SocketAddr;
use std::process::ExitCode;

use game_server::{app, config::Config, logging, state::AppState};

#[tokio::main]
async fn main() -> ExitCode {
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            // Logging is not up yet, and this must be readable regardless.
            eprintln!("configuration error: {e}");
            return ExitCode::FAILURE;
        }
    };

    if let Err(e) = logging::init(&config.game_log) {
        eprintln!("configuration error: {e}");
        return ExitCode::FAILURE;
    }

    tracing::info!(target: "game::net", "starting {}", config.summary());

    let bind = config.bind_addr;
    let state = AppState::new(config);
    // The room task starts here and lives as long as the process.
    let stack = app::build_stack(state);
    let router = stack.router;
    // Held so the room is not shut down by the sender being dropped.
    let shutdown = stack.shutdown;
    let room = stack.room.clone();

    let listener = match tokio::net::TcpListener::bind(bind).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(target: "game::net", "cannot bind {bind}: {e}");
            return ExitCode::FAILURE;
        }
    };

    let local: SocketAddr = match listener.local_addr() {
        Ok(a) => a,
        Err(e) => {
            tracing::error!(target: "game::net", "cannot read local address: {e}");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!(target: "game::net", "listening on {local}");

    let served = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await;

    // Tell the room, then **wait for it**. Returning here without waiting is a
    // race the room loses: the process exits before the task is scheduled again,
    // and a recorded round loses the footer that makes it verifiable — the round
    // interrupted by `docker compose down` being exactly the one worth keeping
    // (`docs/41` §7).
    let _ = shutdown.send(());
    if !room.wait_for_shutdown(SHUTDOWN_GRACE).await {
        tracing::warn!(
            target: "game::net",
            "room did not stop within {}s; a replay may be missing its footer",
            SHUTDOWN_GRACE.as_secs()
        );
    }

    match served {
        Ok(()) => {
            tracing::info!(target: "game::net", "shutdown complete");
            ExitCode::SUCCESS
        }
        Err(e) => {
            tracing::error!(target: "game::net", "server error: {e}");
            ExitCode::FAILURE
        }
    }
}

/// How long the room gets to finish after the listener stops. `docs/41` §7 gives
/// sockets 2 s to drain; compose allows 10 s before SIGKILL (`docs/62` §4), so
/// this sits comfortably inside both.
const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// SIGTERM (what `docker compose down` sends) and Ctrl-C both mean the same thing:
/// stop accepting, let the sockets drain (`docs/41-server-loop-rooms.md` §7).
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(target: "game::net", "cannot listen for ctrl-c: {e}");
            // Never return: returning would trigger an immediate shutdown.
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(e) => {
                tracing::error!(target: "game::net", "cannot listen for SIGTERM: {e}");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!(target: "game::net", "received ctrl-c"),
        _ = terminate => tracing::info!(target: "game::net", "received SIGTERM"),
    }
}
