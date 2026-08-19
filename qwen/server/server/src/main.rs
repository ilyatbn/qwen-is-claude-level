//! wipgame server — thin IO layer over `game-core` (docs/05 §1).
//!
//! Env (docs/05 §7): `WIPGAME_PORT` (default 3001), `WIPGAME_SEED` (optional
//! u64 dev override — if set, ALL rounds use this seed), `RUST_LOG`.

mod net;
mod tick;

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use socketioxide::SocketIo;
use tracing::{info, warn};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::reload;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// docs/05 §6, docs/00 §6.
const DEFAULT_PORT: u16 = 3001;

/// Handle used to change the tracing filter at runtime (docs/05 §5,
/// `set_log_level`), so an agent can flip to debug without a restart.
#[derive(Clone)]
pub struct LogLevelHandle {
    inner: Arc<reload::Handle<EnvFilter, tracing_subscriber::Registry>>,
}

impl LogLevelHandle {
    /// Apply a new filter directive. Rejects anything `EnvFilter` cannot parse.
    pub fn set(&self, level: &str) -> Result<(), String> {
        let filter = EnvFilter::try_new(level).map_err(|e| e.to_string())?;
        self.inner.reload(filter).map_err(|e| e.to_string())
    }
}

/// Server config parsed from the environment (docs/05 §7).
struct Config {
    port: u16,
    seed: Option<u64>,
}

impl Config {
    fn from_env() -> Self {
        let port = match std::env::var("WIPGAME_PORT") {
            Ok(raw) => raw.parse::<u16>().unwrap_or_else(|_| {
                eprintln!("WIPGAME_PORT={raw:?} is not a port, using {DEFAULT_PORT}");
                DEFAULT_PORT
            }),
            Err(_) => DEFAULT_PORT,
        };
        let seed = match std::env::var("WIPGAME_SEED") {
            Ok(raw) => match raw.parse::<u64>() {
                Ok(seed) => Some(seed),
                Err(_) => {
                    eprintln!("WIPGAME_SEED={raw:?} is not a u64, ignoring");
                    None
                }
            },
            Err(_) => None,
        };
        Config { port, seed }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("wipgame server starting");

    let config = Config::from_env();

    // docs/05 §5: `tracing` + `tracing-subscriber`, env `RUST_LOG` controls
    // level (default info). Wrapped in a reload layer so `set_log_level` can
    // change it live.
    let base = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::default().add_directive(LevelFilter::INFO.into()));
    let (filter, reload_handle) = reload::Layer::new(base);
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .init();
    let log_level = LogLevelHandle {
        inner: Arc::new(reload_handle),
    };

    if let Some(seed) = config.seed {
        warn!("[cfg] WIPGAME_SEED={seed} — every round will use this seed");
    }

    let (layer, io) = SocketIo::new_layer();
    net::register(&io, log_level);

    let app = axum::Router::new().layer(layer);

    let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, config.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("[net] listening on {addr} (namespace {})", game_core::protocol::NAMESPACE);

    // docs/05 §3: the 20 Hz fixed tick runs alongside the socket listener.
    let ticker = tokio::spawn(tick::run());

    // docs/05 §7: graceful shutdown on SIGINT — log active rooms, exit.
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            match tokio::signal::ctrl_c().await {
                Ok(()) => info!("[net] SIGINT received, shutting down (rooms active: 0)"),
                Err(err) => warn!("[net] failed to listen for SIGINT: {err}"),
            }
        })
        .await?;

    ticker.abort();
    Ok(())
}
