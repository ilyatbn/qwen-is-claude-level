//! `net` — socket.io handlers. Translates wire messages to/from game-core
//! types (docs/05 §1: this crate is a thin IO layer with no game logic).

use crate::rooms::{Room, RoomId};
use game_core::map::Scale;
use game_core::protocol::{
    c2s, s2c, Empty, ErrorMsg, InputFrame, JoinRoom, Joined, SelectSkin, SetLogLevel,
    UseSlot, NAMESPACE, PROTOCOL_VERSION,
};
use socketioxide::extract::{Data, SocketRef};
use socketioxide::socket::DisconnectReason;
use socketioxide::SocketIo;
use std::sync::{Arc, Mutex};
use tracing::{debug, info, warn};

use crate::LogLevelHandle;

/// Shared room list, driven by the tick loop and mutated by socket handlers.
pub type Rooms = Arc<Mutex<Vec<Room>>>;

/// Lock helper: a poisoned mutex must not take the server down, since the
/// room state is still readable and the next tick will overwrite it anyway.
pub fn lock(rooms: &Rooms) -> std::sync::MutexGuard<'_, Vec<Room>> {
    match rooms.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// The room a socket belongs to, or the first room with space.
fn room_for<'a>(rooms: &'a mut [Room], socket: &str) -> Option<&'a mut Room> {
    rooms.iter_mut().find(|r| r.player_of(socket).is_some())
}

/// Register the `/game` namespace and its handlers (docs/06 intro).
pub fn register(io: &SocketIo, log_level: LogLevelHandle, rooms: Rooms, dev_seed: Option<u64>) {
    io.ns(NAMESPACE, async move |socket: SocketRef| {
        info!("[net] client connected id={}", socket.id);

        // docs/06 §1: `ping` -> `pong` (T0.3).
        socket.on(c2s::PING, async |socket: SocketRef| {
            debug!("[net] ping from id={}", socket.id);
            if let Err(err) = socket.emit(s2c::PONG, &Empty {}) {
                warn!("[net] failed to emit pong to id={}: {err}", socket.id);
            }
        });

        // docs/06 §1: join_room { name } -> joined { id, room, seed, ... }.
        let join_rooms = rooms.clone();
        socket.on(
            c2s::JOIN_ROOM,
            async move |socket: SocketRef, Data::<JoinRoom>(payload)| {
                let mut guard = lock(&join_rooms);
                if guard.is_empty() {
                    let seed = dev_seed.unwrap_or(0xC0FFEE);
                    guard.push(Room::new(0 as RoomId, seed, Scale::Medium));
                }
                // First room with space; v1 runs one room per instance
                // (docs/05 §2) but the code is room-keyed regardless.
                let socket_id = socket.id.to_string();
                let room = guard.iter_mut().find(|r| r.player_count() < 6);
                match room {
                    Some(room) => match room.join(&socket_id, &payload.name) {
                        Ok(id) => {
                            info!("[net] P{id} joined name={} [room={}]", payload.name, room.id);
                            // Emitted through the TYPED struct, not json!.
                            // A hand-built json! bypasses `Joined` entirely, so
                            // every protocol-pinning test guarding it would
                            // constrain nothing about what actually ships.
                            let joined = Joined {
                                id,
                                room: room.id,
                                seed: room.round.seed,
                                scale: room.round.scale.as_str().to_string(),
                                // docs/06 §2: the client renders terrain from
                                // this. Absent until now, so every client drew
                                // a local placeholder unrelated to the map the
                                // server simulates.
                                map: room.round.map.to_map_data(),
                                players: room.lobby_players(),
                                protocol_version: PROTOCOL_VERSION,
                            };
                            let _ = socket.emit(s2c::JOINED, &joined);
                        }
                        Err(err) => {
                            warn!("[net] join refused: {}", err.code());
                            let _ = socket.emit(
                                s2c::ERROR,
                                &ErrorMsg { code: err.code().into(), msg: "join refused".into() },
                            );
                        }
                    },
                    None => {
                        let _ = socket.emit(
                            s2c::ERROR,
                            &ErrorMsg { code: "room_full".into(), msg: "all rooms full".into() },
                        );
                    }
                }
            },
        );

        let ready_rooms = rooms.clone();
        socket.on(c2s::READY, async move |socket: SocketRef| {
            let mut guard = lock(&ready_rooms);
            let socket_id = socket.id.to_string();
            if let Some(room) = room_for(&mut guard, &socket_id) {
                room.set_ready(&socket_id, true);
                debug!("[net] {} is ready [room={}]", socket_id, room.id);
            }
        });

        // docs/06 §1: input frames at 20 Hz, latest-wins.
        let input_rooms = rooms.clone();
        socket.on(
            c2s::INPUT,
            async move |socket: SocketRef, Data::<InputFrame>(frame)| {
                let mut guard = lock(&input_rooms);
                let socket_id = socket.id.to_string();
                if let Some(room) = room_for(&mut guard, &socket_id) {
                    room.queue_input(&socket_id, frame);
                }
            },
        );

        // docs/06 §1: the UI path for using a slot; also inside InputFrame.
        let slot_rooms = rooms.clone();
        socket.on(
            c2s::USE_SLOT,
            async move |socket: SocketRef, Data::<UseSlot>(payload)| {
                let mut guard = lock(&slot_rooms);
                let socket_id = socket.id.to_string();
                if let Some(room) = room_for(&mut guard, &socket_id) {
                    room.queue_input(
                        &socket_id,
                        InputFrame { use_slot: Some(payload.slot), ..InputFrame::default() },
                    );
                }
            },
        );

        let skin_rooms = rooms.clone();
        socket.on(
            c2s::SELECT_SKIN,
            async move |socket: SocketRef, Data::<SelectSkin>(payload)| {
                let mut guard = lock(&skin_rooms);
                let socket_id = socket.id.to_string();
                if let Some(room) = room_for(&mut guard, &socket_id) {
                    if let Some(id) = room.player_of(&socket_id) {
                        if let Some(rp) =
                            room.round.players.iter_mut().find(|p| p.player.id == id)
                        {
                            rp.player.skin = payload.skin;
                        }
                    }
                }
            },
        );

        // docs/05 §2: restart -> new seed unless WIPGAME_SEED pins it.
        let restart_rooms = rooms.clone();
        socket.on(c2s::RESTART, async move |socket: SocketRef| {
            let mut guard = lock(&restart_rooms);
            let socket_id = socket.id.to_string();
            if let Some(room) = room_for(&mut guard, &socket_id) {
                let seed = crate::tick::round_seed(dev_seed, room.round.seed.wrapping_mul(6364136223846793005).wrapping_add(1));
                info!("[round] restart seed={seed} [room={}]", room.id);
                room.restart(seed);
            }
        });

        let quit_rooms = rooms.clone();
        socket.on(c2s::QUIT, async move |socket: SocketRef| {
            let mut guard = lock(&quit_rooms);
            let socket_id = socket.id.to_string();
            if let Some(room) = room_for(&mut guard, &socket_id) {
                room.leave(&socket_id);
            }
        });

        // docs/05 §5: runtime log level toggle.
        let level_handle = log_level.clone();
        socket.on(
            c2s::SET_LOG_LEVEL,
            async move |socket: SocketRef, Data::<SetLogLevel>(payload)| {
                warn!("[net] set_log_level level={} from id={}", payload.level, socket.id);
                match level_handle.set(&payload.level) {
                    Ok(()) => info!("[net] log level now {}", payload.level),
                    Err(err) => warn!("[net] rejected log level: {err}"),
                }
            },
        );

        let disconnect_rooms = rooms.clone();
        socket.on_disconnect(
            async move |socket: SocketRef, reason: DisconnectReason| {
                info!("[net] client disconnected id={} reason={reason}", socket.id);
                let mut guard = lock(&disconnect_rooms);
                let socket_id = socket.id.to_string();
                if let Some(room) = room_for(&mut guard, &socket_id) {
                    if let Some(id) = room.leave(&socket_id) {
                        info!("[net] P{id} left [room={}]", room.id);
                    }
                }
            },
        );
    });
}
