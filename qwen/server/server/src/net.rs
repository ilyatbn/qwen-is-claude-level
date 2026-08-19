//! `net` — socket.io handlers. Translates wire messages to/from game-core
//! types (docs/05 §1: this crate is a thin IO layer with no game logic).

use game_core::protocol::{c2s, s2c, Empty, SetLogLevel, NAMESPACE};
use socketioxide::extract::{Data, SocketRef};
use socketioxide::socket::DisconnectReason;
use socketioxide::SocketIo;
use tracing::{debug, info, warn};

use crate::LogLevelHandle;

/// Register the `/game` namespace and its handlers (docs/06 intro).
pub fn register(io: &SocketIo, log_level: LogLevelHandle) {
    io.ns(NAMESPACE, async move |socket: SocketRef| {
        info!("[net] client connected id={}", socket.id);

        // docs/06 §1: `ping` -> server replies `pong` (T0.3).
        socket.on(c2s::PING, async |socket: SocketRef| {
            debug!("[net] ping from id={}", socket.id);
            if let Err(err) = socket.emit(s2c::PONG, &Empty {}) {
                warn!("[net] failed to emit pong to id={}: {err}", socket.id);
            }
        });

        // docs/05 §5: runtime log level toggle. v1 = any connected client may
        // send it; logged as a warning.
        let level_handle = log_level.clone();
        socket.on(
            c2s::SET_LOG_LEVEL,
            async move |socket: SocketRef, Data::<SetLogLevel>(payload)| {
                warn!(
                    "[net] set_log_level level={} from id={}",
                    payload.level, socket.id
                );
                match level_handle.set(&payload.level) {
                    Ok(()) => info!("[net] log level now {}", payload.level),
                    Err(err) => warn!("[net] rejected log level: {err}"),
                }
            },
        );

        socket.on_disconnect(async |socket: SocketRef, reason: DisconnectReason| {
            info!("[net] client disconnected id={} reason={reason}", socket.id);
        });
    });
}
