//! The socket layer: per-connection state, the join flow, and the handlers that
//! turn socket.io messages into [`Command`]s.
//!
//! Handlers are deliberately thin. They parse, validate, and push into the room's
//! channel — nothing here touches the `World`, because the room task owns it
//! outright (`docs/41-server-loop-rooms.md` §1).

use std::sync::{Arc, RwLock};

use game_core::player::state::PlayerId;
use socketioxide::extract::{Data, SocketRef};
use socketioxide::socket::Sid;
use socketioxide::SocketIo;

use crate::codec::{b64_encode, decode_input_batch, encode_map_init_at};
use crate::config::Config;
use crate::registry::{RoomId, RoomRegistry};
use crate::room::{Command, RoomHandle};

/// What a handler needs to find its room.
///
/// Handlers used to close over one `RoomHandle` and one `SessionMap`, which is
/// exactly as many as a process could have. With a registry they resolve per
/// call instead: a socket is in whichever room it was attached to, and in the
/// default room until it chooses one.
#[derive(Clone)]
pub struct Ctx {
    pub registry: Arc<std::sync::Mutex<RoomRegistry>>,
    pub default_room: RoomId,
}

impl Ctx {
    fn lock(&self) -> std::sync::MutexGuard<'_, RoomRegistry> {
        match self.registry.lock() {
            Ok(g) => g,
            // A poisoned registry means a handler panicked while holding it.
            // Refusing to serve anyone afterwards turns one bad request into an
            // outage, so carry on with the state as it was left.
            Err(p) => p.into_inner(),
        }
    }

    /// The room this socket belongs to, with its handle and session map.
    pub fn resolve(&self, sid: Sid) -> Option<(RoomId, RoomHandle, Arc<SessionMap>)> {
        let r = self.lock();
        let id = r.room_of(sid).unwrap_or(self.default_room);
        let e = r.get(id)?;
        Some((id, e.handle.clone(), e.sessions.clone()))
    }

    /// The parts of a specific room, by id.
    pub fn room_parts(&self, room: RoomId) -> Option<(RoomHandle, Arc<SessionMap>)> {
        let r = self.lock();
        let e = r.get(room)?;
        Some((e.handle.clone(), e.sessions.clone()))
    }

    /// The room this socket has chosen, or the default one.
    pub fn room_or_default(&self, sid: Sid) -> RoomId {
        self.lock().room_of(sid).unwrap_or(self.default_room)
    }

    pub fn attach(&self, sid: Sid, room: RoomId) {
        self.lock().attach(sid, room);
    }

    pub fn create(
        &self,
        scale: game_core::constants::MapScale,
        private: bool,
    ) -> Result<(RoomId, Option<String>), crate::registry::JoinRejection> {
        self.lock().create(scale, private)
    }

    pub fn by_code(&self, code: &str) -> Option<RoomId> {
        self.lock().by_code(code)
    }

    pub fn quick_match(
        &self,
        scale: game_core::constants::MapScale,
        max_players: usize,
    ) -> crate::registry::QuickMatch {
        self.lock().quick_match(scale, max_players)
    }

    pub fn detach(&self, sid: Sid) -> Option<RoomId> {
        self.lock().detach(sid)
    }
}

/// Player id ↔ socket, so an event can be delivered to one player rather than
/// broadcast.
///
/// This is **socket-layer** state, not game state, so a lock here does not violate
/// the "no locks on the World" rule. It is written on join and leave and read on
/// every scoped emit, which is exactly what an `RwLock` is for.
#[derive(Default, Debug)]
pub struct SessionMap {
    inner: RwLock<Vec<(PlayerId, Sid)>>,
    /// Sockets that have sent `ready` and decoded their map.
    ///
    /// **Snapshots** are gated on this, and that gate is load-bearing: a player is
    /// seated before `welcome` is sent, so without it the 20 Hz stream starts
    /// during the join handshake and races `map_init` on the same socket.
    ready: RwLock<Vec<Sid>>,
    /// Per-socket delivery state for **broadcast events**.
    ///
    /// Readiness for events and readiness for snapshots are different things
    /// (`docs/70-amendments-v2.md` §A40). A socket can take carves as soon as it
    /// has a mask to apply them to — the moment `map_init` is *sent* — but the
    /// carves landing between the map being encoded and that emit must not be
    /// dropped: they carry a monotonic `seq`, and a hole in it costs a full map
    /// resync two seconds later. They are queued here and flushed in order.
    delivery: RwLock<Vec<(Sid, Delivery)>>,
}

/// Where a socket's broadcast events go right now.
#[derive(Debug)]
pub enum Delivery {
    /// Seated, map not yet on the wire: hold events in order.
    Queueing(Vec<(&'static str, serde_json::Value)>),
    /// The queue exceeded `JOIN_EVENT_QUEUE_MAX` and was dropped. The socket is
    /// owed a fresh `map_init` rather than a stream with a hole in it.
    Overflowed,
    /// `map_init` is on the wire; emit directly.
    Live,
}

impl SessionMap {
    pub fn insert(&self, player: PlayerId, sid: Sid) {
        if let Ok(mut v) = self.inner.write() {
            v.retain(|(p, s)| *p != player && *s != sid);
            v.push((player, sid));
            v.sort_by_key(|(p, _)| *p);
        }
        // Seated but mapless: hold broadcasts rather than dropping them.
        if let Ok(mut d) = self.delivery.write() {
            d.retain(|(s, _)| *s != sid);
            d.push((sid, Delivery::Queueing(Vec::new())));
        }
    }

    /// Take one broadcast event for a socket: emit it now, or hold it.
    ///
    /// Returns `true` when the caller should emit. Holding and going live are
    /// decided under the same lock, so an event cannot slip between the two and
    /// be lost — either it lands in the queue that `go_live` is about to drain,
    /// or it is emitted directly after the drain.
    pub fn queue_or_emit(&self, sid: Sid, name: &'static str, payload: &serde_json::Value) -> bool {
        let Ok(mut d) = self.delivery.write() else {
            return false;
        };
        let Some((_, state)) = d.iter_mut().find(|(s, _)| *s == sid) else {
            return false; // not seated: nothing is owed to it
        };
        match state {
            Delivery::Live => true,
            Delivery::Overflowed => false,
            Delivery::Queueing(q) => {
                if q.len() >= game_core::constants::JOIN_EVENT_QUEUE_MAX {
                    tracing::warn!(
                        target: "game::net", socket = %sid,
                        held = q.len(),
                        "join event queue overflowed; owed a fresh map_init"
                    );
                    *state = Delivery::Overflowed;
                } else {
                    q.push((name, payload.clone()));
                }
                false
            }
        }
    }

    /// `map_init` is on the wire. Returns what was held, in arrival order.
    ///
    /// `Err(())` means the queue overflowed and the socket needs a fresh
    /// `map_init` instead of a replay with a hole in it.
    #[allow(clippy::result_unit_err)]
    pub fn go_live(&self, sid: Sid) -> Result<Vec<(&'static str, serde_json::Value)>, ()> {
        let Ok(mut d) = self.delivery.write() else {
            return Ok(Vec::new());
        };
        let Some((_, state)) = d.iter_mut().find(|(s, _)| *s == sid) else {
            return Ok(Vec::new());
        };
        let prev = std::mem::replace(state, Delivery::Live);
        match prev {
            Delivery::Queueing(q) => Ok(q),
            Delivery::Overflowed => Err(()),
            Delivery::Live => Ok(Vec::new()),
        }
    }

    /// Test seam: how many events are being held for a socket.
    pub fn queued_len(&self, sid: Sid) -> usize {
        self.delivery
            .read()
            .ok()
            .and_then(|d| {
                d.iter().find(|(s, _)| *s == sid).map(|(_, st)| match st {
                    Delivery::Queueing(q) => q.len(),
                    _ => 0,
                })
            })
            .unwrap_or(0)
    }

    pub fn is_live(&self, sid: Sid) -> bool {
        self.delivery
            .read()
            .ok()
            .map(|d| {
                d.iter()
                    .any(|(s, st)| *s == sid && matches!(st, Delivery::Live))
            })
            .unwrap_or(false)
    }

    pub fn mark_ready(&self, sid: Sid) {
        if let Ok(mut v) = self.ready.write() {
            if !v.contains(&sid) {
                v.push(sid);
            }
        }
    }

    pub fn is_ready(&self, sid: Sid) -> bool {
        self.ready.read().map(|v| v.contains(&sid)).unwrap_or(false)
    }

    pub fn ready_sids(&self) -> Vec<Sid> {
        self.ready.read().map(|v| v.clone()).unwrap_or_default()
    }

    /// Every socket seated in this room, in `PlayerId` order.
    ///
    /// **This is what scopes a broadcast to one room** (`docs/71` §B1). Iterating
    /// `io.sockets()` reaches every socket on the process, which with more than
    /// one room means a carve in one game lands in another — the multi-room form
    /// of the inventory leak in `docs/30` §6. Using the same list that already
    /// backs per-owner delivery keeps one answer to "who is in this room" rather
    /// than two that can disagree (§A24).
    pub fn sids(&self) -> Vec<Sid> {
        self.inner
            .read()
            .map(|v| v.iter().map(|(_, s)| *s).collect())
            .unwrap_or_default()
    }

    pub fn remove_sid(&self, sid: Sid) -> Option<PlayerId> {
        if let Ok(mut r) = self.ready.write() {
            r.retain(|s| *s != sid);
        }
        if let Ok(mut d) = self.delivery.write() {
            d.retain(|(s, _)| *s != sid);
        }
        let mut v = self.inner.write().ok()?;
        let i = v.iter().position(|(_, s)| *s == sid)?;
        Some(v.remove(i).0)
    }

    pub fn sid_of(&self, player: PlayerId) -> Option<Sid> {
        let v = self.inner.read().ok()?;
        v.iter().find(|(p, _)| *p == player).map(|(_, s)| *s)
    }

    pub fn player_of(&self, sid: Sid) -> Option<PlayerId> {
        let v = self.inner.read().ok()?;
        v.iter().find(|(_, s)| *s == sid).map(|(p, _)| *p)
    }

    pub fn len(&self) -> usize {
        self.inner.read().map(|v| v.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// 1–16 characters after trimming, with control characters stripped.
///
/// Truncates rather than rejecting an over-long name: a 17-character name is a
/// client that counted differently, not an attack, and refusing the join over it
/// is a worse experience than shortening it. An empty name **is** rejected,
/// because there is nothing to show on the scoreboard.
pub fn sanitise_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(16)
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Register every handler on the default namespace.
pub fn register(
    io: &SocketIo,
    registry: Arc<std::sync::Mutex<RoomRegistry>>,
    default_room: RoomId,
    config: Arc<Config>,
) {
    let io2 = io.clone();
    let ctx0 = Ctx {
        registry,
        default_room,
    };
    io.ns("/", move |socket: SocketRef| {
        let ctx = ctx0.clone();
        let config = config.clone();
        let io = io2.clone();
        async move {
            tracing::info!(target: "game::net", socket = %socket.id, "socket connected");

            // ------------------------------------------------------------ join
            {
                let (ctx, io, config) = (ctx.clone(), io.clone(), config.clone());
                socket.on(
                    "join",
                    move |socket: SocketRef, Data::<serde_json::Value>(payload)| {
                        let (ctx, io, config) = (ctx.clone(), io.clone(), config.clone());
                        async move {
                            // Whichever room this socket has chosen, or the
                            // default one if it has not chosen (the single-room
                            // path every test before T10.02 uses).
                            let room_id = ctx.room_or_default(socket.id);
                            seat(socket, ctx, io, config, room_id, payload).await;
                        }
                    },
                );
            }

            // ----------------------------------------------------------- lobby
            //
            // Three ways into a room, all ending in `seat` (§B9). They select a
            // room and then take the same path `join` does, so name validation,
            // the map encode, the join-window flush and the world-state
            // catch-up exist once rather than four times.
            {
                let (ctx, io, config) = (ctx.clone(), io.clone(), config.clone());
                socket.on(
                    "create_room",
                    move |socket: SocketRef, Data::<serde_json::Value>(payload)| {
                        let (ctx, io, config) = (ctx.clone(), io.clone(), config.clone());
                        async move {
                            let scale = scale_from(&payload, config.map_scale);
                            let private = payload
                                .get("private")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true);
                            match ctx.create(scale, private) {
                                Ok((room_id, code)) => {
                                    ctx.attach(socket.id, room_id);
                                    emit(
                                        &socket,
                                        "room_created",
                                        &serde_json::json!({
                                            "room_id": room_id,
                                            "code": code,
                                            "scale": scale_name(scale),
                                        }),
                                    );
                                    seat(socket, ctx, io, config, room_id, payload).await;
                                }
                                Err(reason) => emit(
                                    &socket,
                                    "join_error",
                                    &serde_json::json!({ "reason": reason.as_str() }),
                                ),
                            }
                        }
                    },
                );
            }
            {
                let (ctx, io, config) = (ctx.clone(), io.clone(), config.clone());
                socket.on(
                    "join_room",
                    move |socket: SocketRef, Data::<serde_json::Value>(payload)| {
                        let (ctx, io, config) = (ctx.clone(), io.clone(), config.clone());
                        async move {
                            // Attacker-controlled text. `normalise_code` bounds
                            // its own output and `code_looks_valid` rejects
                            // anything that is not exactly a code, so a 5000-byte
                            // "code" never reaches a map lookup or a log line.
                            let raw = payload.get("code").and_then(|v| v.as_str()).unwrap_or("");
                            let code = crate::registry::normalise_code(raw);
                            if !crate::registry::code_looks_valid(&code) {
                                emit(
                                    &socket,
                                    "join_error",
                                    &serde_json::json!({ "reason": "unknown_code" }),
                                );
                                return;
                            }
                            let Some(room_id) = ctx.by_code(&code) else {
                                emit(
                                    &socket,
                                    "join_error",
                                    &serde_json::json!({ "reason": "unknown_code" }),
                                );
                                return;
                            };
                            ctx.attach(socket.id, room_id);
                            seat(socket, ctx, io, config, room_id, payload).await;
                        }
                    },
                );
            }
            {
                let (ctx, io, config) = (ctx.clone(), io.clone(), config.clone());
                socket.on(
                    "quick_match",
                    move |socket: SocketRef, Data::<serde_json::Value>(payload)| {
                        let (ctx, io, config) = (ctx.clone(), io.clone(), config.clone());
                        async move {
                            let scale = scale_from(&payload, config.map_scale);
                            let max = config.max_players;
                            match ctx.quick_match(scale, max) {
                                crate::registry::QuickMatch::Existing(room_id)
                                | crate::registry::QuickMatch::Created(room_id) => {
                                    ctx.attach(socket.id, room_id);
                                    // Status before the map: a client that has to
                                    // wait for a 20 KB `map_init` should already
                                    // know it got a seat.
                                    //
                                    // §B10: `waiting`/`eta_s` are gone — they
                                    // were structurally always zero, because
                                    // there is no queue to wait in. What is true
                                    // and useful is who is already in there:
                                    // "3/6, two of them bots".
                                    let (players, bots) = match ctx.room_parts(room_id) {
                                        Some((h, _)) => h.status().await.unwrap_or((0, 0)),
                                        None => (0, 0),
                                    };
                                    emit(
                                        &socket,
                                        "room_list",
                                        &serde_json::json!({
                                            "room_id": room_id,
                                            "players": players,
                                            "capacity": max,
                                            "bots": bots,
                                        }),
                                    );
                                    seat(socket, ctx, io, config, room_id, payload).await;
                                }
                                crate::registry::QuickMatch::Full => emit(
                                    &socket,
                                    "join_error",
                                    &serde_json::json!({ "reason": "server_full" }),
                                ),
                            }
                        }
                    },
                );
            }
            {
                let (ctx, io) = (ctx.clone(), io.clone());
                socket.on("leave_room", move |socket: SocketRef| {
                    let (ctx, io) = (ctx.clone(), io.clone());
                    async move {
                        // Leaving must free the seat in the *old* room before the
                        // socket can be seated anywhere else, or a client that
                        // hops rooms holds two seats and the first room never
                        // empties.
                        let Some((_, room, sessions)) = ctx.resolve(socket.id) else {
                            return;
                        };
                        if let Some(id) = sessions.remove_sid(socket.id) {
                            room.send(Command::Leave(id));
                            let payload = serde_json::json!({ "id": id, "reason": "left" });
                            broadcast_except(&io, &sessions, socket.id, "player_leave", &payload);
                        }
                        ctx.detach(socket.id);
                        emit(&socket, "room_left", &serde_json::json!({}));
                    }
                });
            }

            // ----------------------------------------------------------- ready
            {
                let ctx = ctx.clone();
                socket.on("ready", move |socket: SocketRef| {
                    let ctx = ctx.clone();
                    async move {
                        let Some((_, room, sessions)) = ctx.resolve(socket.id) else {
                            return;
                        };
                        if let Some(id) = sessions.player_of(socket.id) {
                            sessions.mark_ready(socket.id);
                            room.send(Command::Ready(id));
                        }
                    }
                });
            }

            // ----------------------------------------------------------- input
            {
                let ctx = ctx.clone();
                socket.on("input", move |socket: SocketRef, Data::<String>(b64)| {
                    let ctx = ctx.clone();
                    async move {
                        let Some((_, room, sessions)) = ctx.resolve(socket.id) else {
                            return;
                        };
                        let Some(id) = sessions.player_of(socket.id) else {
                            return;
                        };
                        let Some(buf) = crate::codec::b64_decode(&b64) else {
                            tracing::warn!(
                                target: "game::net", socket = %socket.id,
                                "input was not valid base64"
                            );
                            return;
                        };
                        match decode_input_batch(&buf) {
                            Ok(inputs) => room.send(Command::Input(id, inputs)),
                            // Malformed is far more likely to be version skew than
                            // an attack: log and drop, never disconnect
                            // (`docs/40` §6).
                            Err(e) => tracing::warn!(
                                target: "game::net", socket = %socket.id, bytes = buf.len(),
                                "malformed input: {e}"
                            ),
                        }
                    }
                });
            }

            // ------------------------------------------------------ item verbs
            {
                let ctx = ctx.clone();
                socket.on(
                    "use_item",
                    move |socket: SocketRef, Data::<serde_json::Value>(p)| {
                        let ctx = ctx.clone();
                        async move {
                            let Some((_, room, sessions)) = ctx.resolve(socket.id) else {
                                return;
                            };
                            if let Some(id) = sessions.player_of(socket.id) {
                                let slot = p.get("slot").and_then(|v| v.as_u64()).unwrap_or(255);
                                room.send(Command::UseItem(id, slot.min(255) as u8));
                            }
                        }
                    },
                );
            }
            {
                let ctx = ctx.clone();
                socket.on(
                    "select_slot",
                    move |socket: SocketRef, Data::<serde_json::Value>(p)| {
                        let ctx = ctx.clone();
                        async move {
                            let Some((_, room, sessions)) = ctx.resolve(socket.id) else {
                                return;
                            };
                            if let Some(id) = sessions.player_of(socket.id) {
                                let slot = p.get("slot").and_then(|v| v.as_u64()).unwrap_or(255);
                                room.send(Command::SelectSlot(id, slot.min(255) as u8));
                            }
                        }
                    },
                );
            }
            {
                let ctx = ctx.clone();
                // RTT. `docs/42` §7 says it comes from "socket.io's own ping/pong",
                // but the client library does not surface that measurement, so the
                // client's rtt was hardcoded to 0 and the debug HUD reported 0 ms
                // on every connection — a number that reports nothing (§A15).
                // An echo with the client's own timestamp costs one tiny message
                // and makes it real. Stateless, unauthenticated and harmless: the
                // server never reads the value, it only sends it back.
                socket.on(
                    "ping_rtt",
                    |socket: SocketRef, Data::<String>(t)| async move {
                        let _ = socket.emit("pong_rtt", &t);
                    },
                );
                socket.on("toggle_flashlight", move |socket: SocketRef| {
                    let ctx = ctx.clone();
                    async move {
                        let Some((_, room, sessions)) = ctx.resolve(socket.id) else {
                            return;
                        };
                        if let Some(id) = sessions.player_of(socket.id) {
                            room.send(Command::ToggleFlashlight(id));
                        }
                    }
                });
            }
            {
                let ctx = ctx.clone();
                socket.on("fire", move |socket: SocketRef| {
                    let ctx = ctx.clone();
                    async move {
                        let Some((_, room, sessions)) = ctx.resolve(socket.id) else {
                            return;
                        };
                        if let Some(id) = sessions.player_of(socket.id) {
                            room.send(Command::Fire(id));
                        }
                    }
                });
            }
            {
                let ctx = ctx.clone();
                socket.on(
                    "vote_restart",
                    move |socket: SocketRef, Data::<serde_json::Value>(p)| {
                        let ctx = ctx.clone();
                        async move {
                            let Some((_, room, sessions)) = ctx.resolve(socket.id) else {
                                return;
                            };
                            if let Some(id) = sessions.player_of(socket.id) {
                                let yes =
                                    p.get("restart").and_then(|v| v.as_bool()).unwrap_or(false);
                                room.send(Command::VoteRestart(id, yes));
                            }
                        }
                    },
                );
            }
            {
                let ctx = ctx.clone();
                socket.on("resync_map", move |socket: SocketRef| {
                    let ctx = ctx.clone();
                    async move {
                        let Some((_, room, sessions)) = ctx.resolve(socket.id) else {
                            return;
                        };
                        let Some(_id) = sessions.player_of(socket.id) else {
                            return;
                        };
                        let Some(bytes) = room
                            .inspect(|w| encode_map_init_at(&w.map, w.carve_seq()))
                            .await
                        else {
                            return;
                        };
                        if let Err(e) = socket.emit("map_init", &b64_encode(&bytes)) {
                            tracing::warn!(target: "game::net", "resync map_init failed: {e}");
                        }
                    }
                });
            }

            // ------------------------------------------------------ disconnect
            {
                let (ctx, io) = (ctx.clone(), io.clone());
                socket.on_disconnect(move |socket: SocketRef| {
                    let (ctx, io) = (ctx.clone(), io.clone());
                    async move {
                        let Some((_, room, sessions)) = ctx.resolve(socket.id) else {
                            return;
                        };
                        // Fires on an abrupt drop as well as a clean close, which
                        // is what keeps a crashed client from holding a seat.
                        if let Some(id) = sessions.remove_sid(socket.id) {
                            room.send(Command::Leave(id));
                            let payload = serde_json::json!({ "id": id, "reason": "disconnect" });
                            broadcast_except(&io, &sessions, socket.id, "player_leave", &payload);
                            // Also drop it from the registry, or the room's human
                            // count never reaches zero and it is never reaped.
                            ctx.detach(socket.id);
                            tracing::info!(target: "game::net", player = id, "left");
                        }
                    }
                });
            }
        }
    });
}

/// Seat a socket in `room_id` and send it everything it needs to start playing.
///
/// One path, four entry points: `join` uses the socket's current room, and
/// `create_room` / `join_room` / `quick_match` each choose a room first and then
/// come here. Duplicating this for each of them would mean four copies of the
/// name validation, the map encode, the join-window flush and the world-state
/// catch-up — and the catch-up alone is three separate things that were each
/// missing once (`docs/70-amendments-v2.md` §A39).
async fn seat(
    socket: SocketRef,
    ctx: Ctx,
    io: SocketIo,
    config: Arc<Config>,
    room_id: RoomId,
    payload: serde_json::Value,
) {
    let Some((room, sessions)) = ctx.room_parts(room_id) else {
        emit(
            &socket,
            "join_error",
            &serde_json::json!({ "reason": "no_room" }),
        );
        return;
    };
    // A second join on one socket is ignored, not a second
    // player: a client that retries must not consume two
    // seats.
    if sessions.player_of(socket.id).is_some() {
        tracing::debug!(target: "game::net", socket = %socket.id, "duplicate join ignored");
        return;
    }

    let name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let Some(name) = sanitise_name(name) else {
        emit(
            &socket,
            "join_error",
            &serde_json::json!({ "reason": "bad_name" }),
        );
        return;
    };
    // Never validated against a list — the server does not
    // know what skins exist (`docs/50` §1) — but bounded.
    let skin_id = payload
        .get("skin_id")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .min(u16::MAX as u64) as u16;
    // §B9. Like `skin_id`, never validated against a list: the server does not
    // know what any skin looks like (`docs/50` §1). Echoed so other clients can
    // draw this player's grave with their chosen stone.
    let tombstone_skin_id = payload
        .get("tombstone_skin_id")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .min(u16::MAX as u64) as u16;

    let Some(id) = room.join(name.clone(), skin_id).await else {
        emit(
            &socket,
            "join_error",
            &serde_json::json!({ "reason": "full" }),
        );
        return;
    };
    sessions.insert(id, socket.id);
    ctx.attach(socket.id, room_id);

    let Some(w) = room
        .inspect(move |w| {
            (
                w.tick,
                w.round_time,
                w.phase.as_str().to_string(),
                w.seed,
                w.map.meta.scale,
                w.players
                    .iter()
                    .map(|p| {
                        serde_json::json!({
                            "id": p.id,
                            "skin_id": p.skin_id,
                            "score": p.score,
                        })
                    })
                    .collect::<Vec<_>>(),
                encode_map_init_at(&w.map, w.carve_seq()),
            )
        })
        .await
    else {
        return;
    };
    let (tick, round_time, phase, seed, scale, players, map_bytes) = w;

    emit(
        &socket,
        "welcome",
        &serde_json::json!({
            "player_id": id,
            "tick": tick,
            "round_time": round_time,
            "phase": phase,
            "sim_hz": game_core::constants::SIM_HZ,
            "snapshot_hz": game_core::constants::SNAPSHOT_HZ,
            "players": players,
            // On the HUD, so a bug report carries a
            // reproducible seed (`docs/61` §8).
            "seed": seed.to_string(),
            "scale": scale_name(scale),
            "max_players": config.max_players,
        }),
    );

    // Binary: `Bytes` becomes a socket.io attachment.
    // Base64 text, not a binary attachment — see
    // `codec::b64_encode` for why.
    if let Err(e) = socket.emit("map_init", &b64_encode(&map_bytes)) {
        tracing::warn!(target: "game::net", socket = %socket.id, "map_init failed: {e}");
    }

    // The map is on the wire, so this socket can take
    // carves now — and the ones that landed while it was
    // being encoded are owed to it, in order.
    //
    // Dropping them was the bug (§A40): `map_init` is
    // stamped `carve_seq = N`, so the client picks the
    // stream up at N+1, and any carve skipped in this
    // window leaves a hole it can only resolve by
    // refetching the whole map two seconds later. Carves
    // already baked into this mask carry `seq <= N` and
    // the client discards them as duplicates, so
    // replaying the whole queue is safe.
    match sessions.go_live(socket.id) {
        Ok(held) => {
            if !held.is_empty() {
                tracing::debug!(
                    target: "game::net", player = id, count = held.len(),
                    "flushed events held during the join window",
                );
            }
            for (name, payload) in held {
                if let Err(e) = socket.emit(name, &payload) {
                    tracing::warn!(
                        target: "game::net", socket = %socket.id,
                        "held {name} failed: {e}"
                    );
                    break;
                }
            }
        }
        // Overflowed: a replay with a hole in it is worse
        // than the resync it would cause, so take the
        // resync now and deliberately.
        Err(()) => {
            if let Some(bytes) = room
                .inspect(|w| encode_map_init_at(&w.map, w.carve_seq()))
                .await
            {
                let _ = socket.emit("map_init", &b64_encode(&bytes));
                tracing::warn!(
                    target: "game::net", player = id,
                    "join queue overflowed; resent map_init",
                );
            }
        }
    }

    // The world already on the ground.
    //
    // `place_initial` runs inside `World::new`, before
    // any event buffer exists, so the 8–20 items every
    // round starts with were never announced to anyone —
    // the server had them and no client could see them,
    // which for items is not cosmetic: they are the
    // reason to move (`docs/30`). A player joining
    // mid-round needs the same list for the same reason
    // (`docs/41` §4), so this is sent per socket rather
    // than broadcast at round start.
    if let Some(items) = room
        .inspect(|w| {
            w.items
                .iter()
                .map(|it| {
                    serde_json::json!({
                        "tick": w.tick,
                        "world_item_id": it.id,
                        "item_id": it.item,
                        "count": it.count,
                        "x": it.pos.x.round() as i32,
                        "y": it.pos.y.round() as i32,
                        "source": format!("{:?}", it.source),
                    })
                })
                .collect::<Vec<_>>()
        })
        .await
    {
        for it in &items {
            emit(&socket, "item_spawn", it);
        }
        tracing::debug!(
            target: "game::items",
            player = id,
            count = items.len(),
            "sent the existing world items",
        );
    }

    // Their own inventory.
    //
    // `inventory` is pushed on pickup, use and death and
    // never on join, so a player who starts with anything
    // — a DEV_LOADOUT, or a mid-round joiner who will pick
    // something up before the first event — saw "(empty)"
    // while holding it. Third instance of one pattern
    // (initial items, scores, this): events describe
    // *changes*, and a joiner needs the *current value*.
    //
    // Owner-scoped, like every other `inventory`
    // (`docs/30` §6): emitted to this socket only, never
    // broadcast.
    if let Some(inv) = room
        .inspect(move |w| {
            let p = w.player(id)?;
            let slots = (0..game_core::constants::INVENTORY_SLOTS)
                .map(|i| match p.inventory.slot(i as u8) {
                    Some(st) => serde_json::json!({
                        "item": st.item,
                        "count": st.count,
                        "key": game_core::items::registry::def(st.item)
                            .map(|d| d.key)
                            .unwrap_or("?"),
                    }),
                    None => serde_json::Value::Null,
                })
                .collect::<Vec<_>>();
            Some(serde_json::json!({
                "tick": w.tick,
                "slots": slots,
                "selected": p.inventory.selected(),
            }))
        })
        .await
        .flatten()
    {
        emit(&socket, "inventory", &inv);
    }

    let joined = serde_json::json!({
        "tick": tick, "id": id, "name": name,
        "skin_id": skin_id, "tombstone_skin_id": tombstone_skin_id,
    });
    broadcast_except(&io, &sessions, socket.id, "player_join", &joined);
    tracing::info!(target: "game::net", player = id, %name, "joined");
}

/// Map size from a lobby payload, falling back to the server's default.
///
/// An unknown string is the default rather than an error: a client sending
/// "huge" is a version skew, and refusing the whole request over it is worse
/// than giving them a medium map (`docs/40` §6 takes the same line on malformed
/// payloads).
fn scale_from(
    p: &serde_json::Value,
    fallback: game_core::constants::MapScale,
) -> game_core::constants::MapScale {
    use game_core::constants::MapScale::*;
    match p.get("scale").and_then(|v| v.as_str()).unwrap_or("") {
        "small" => Small,
        "medium" => Medium,
        "large" => Large,
        _ => fallback,
    }
}

fn scale_name(s: game_core::constants::MapScale) -> &'static str {
    use game_core::constants::MapScale::*;
    match s {
        Small => "small",
        Medium => "medium",
        Large => "large",
    }
}

fn emit(socket: &SocketRef, ev: &'static str, payload: &serde_json::Value) {
    if let Err(e) = socket.emit(ev, payload) {
        tracing::warn!(target: "game::net", socket = %socket.id, "{ev} emit failed: {e}");
    }
}

/// Broadcast to everyone in **this room** but one socket.
///
/// Scoped through the room's `SessionMap` rather than `io.sockets()`, for the
/// reason in [`SessionMap::sids`]: with more than one room, a process-wide
/// iteration announces every join to every game.
fn broadcast_except(
    io: &SocketIo,
    sessions: &SessionMap,
    except: Sid,
    ev: &'static str,
    payload: &serde_json::Value,
) {
    for sid in sessions.sids() {
        if sid == except {
            continue;
        }
        if let Some(s) = io.get_socket(sid) {
            let _ = s.emit(ev, payload);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_trimmed_stripped_and_bounded() {
        assert_eq!(sanitise_name("  ana  ").as_deref(), Some("ana"));
        assert_eq!(sanitise_name("a\u{0}b\u{7}c").as_deref(), Some("abc"));
        assert_eq!(sanitise_name("ana\nbeth").as_deref(), Some("anabeth"));
        // Truncated, not refused.
        assert_eq!(
            sanitise_name("abcdefghijklmnopqrstuvwxyz").as_deref(),
            Some("abcdefghijklmnop")
        );
        assert_eq!(sanitise_name("").as_deref(), None);
        assert_eq!(sanitise_name("   ").as_deref(), None);
        // A name that is *only* control characters has nothing to show.
        assert_eq!(sanitise_name("\u{0}\u{1}").as_deref(), None);
    }

    #[test]
    fn a_sanitised_name_is_never_longer_than_sixteen_characters() {
        for n in 0..40 {
            let raw = "x".repeat(n);
            if let Some(s) = sanitise_name(&raw) {
                assert!(s.chars().count() <= 16, "{n} -> {}", s.chars().count());
            }
        }
    }

    #[test]
    fn the_session_map_round_trips_and_removes() {
        let m = SessionMap::default();
        let (a, b) = (Sid::new(), Sid::new());
        m.insert(1, a);
        m.insert(2, b);
        assert_eq!(m.player_of(a), Some(1));
        assert_eq!(m.sid_of(2), Some(b));
        assert_eq!(m.len(), 2);
        assert_eq!(m.remove_sid(a), Some(1));
        assert_eq!(m.player_of(a), None);
        assert_eq!(m.remove_sid(a), None);
        assert_eq!(m.len(), 1);
    }

    fn ev(n: u32) -> serde_json::Value {
        serde_json::json!({ "seq": n })
    }

    /// The bug §A40 describes: an event arriving before `map_init` is on the wire
    /// must be **held**, not dropped, because carves carry a `seq` the client
    /// applies in order.
    #[test]
    fn events_are_held_until_the_map_is_on_the_wire_then_replayed_in_order() {
        let m = SessionMap::default();
        let sid = Sid::new();
        m.insert(1, sid);

        // Seated, mapless: held, not emitted.
        for i in 1..=3 {
            assert!(
                !m.queue_or_emit(sid, "carve", &ev(i)),
                "carve {i} was emitted before map_init"
            );
        }
        assert_eq!(m.queued_len(sid), 3);

        let held = m.go_live(sid).expect("not overflowed");
        let seqs: Vec<u64> = held
            .iter()
            .map(|(_, p)| p["seq"].as_u64().unwrap_or(0))
            .collect();
        assert_eq!(seqs, vec![1, 2, 3], "replayed out of order");
        assert!(m.is_live(sid));

        // And afterwards it goes straight out.
        assert!(m.queue_or_emit(sid, "carve", &ev(4)));
        assert_eq!(m.queued_len(sid), 0);
    }

    /// The control: without it, "events are held" also passes for a socket that
    /// is never seated and is simply skipped forever.
    #[test]
    fn an_unseated_socket_is_skipped_and_is_owed_nothing() {
        let m = SessionMap::default();
        let sid = Sid::new();
        assert!(!m.queue_or_emit(sid, "carve", &ev(1)));
        assert_eq!(m.queued_len(sid), 0);
        assert!(m.go_live(sid).expect("no queue").is_empty());
    }

    /// A client that never sends `ready` holds its seat for READY_TIMEOUT_SECS,
    /// and a busy round is hundreds of carves. Overflow is deliberate: drop the
    /// queue and take the resync, rather than replaying a stream with a hole.
    #[test]
    fn an_overflowing_queue_asks_for_a_fresh_map_instead_of_a_holed_replay() {
        let m = SessionMap::default();
        let sid = Sid::new();
        m.insert(2, sid);
        let cap = game_core::constants::JOIN_EVENT_QUEUE_MAX;
        for i in 0..cap {
            assert!(!m.queue_or_emit(sid, "carve", &ev(i as u32)));
        }
        assert_eq!(m.queued_len(sid), cap);
        // One past the cap tips it.
        assert!(!m.queue_or_emit(sid, "carve", &ev(cap as u32)));
        assert!(m.go_live(sid).is_err(), "overflow must demand a resync");
    }

    /// Snapshot readiness and event delivery are different things (§A40): going
    /// live must not imply `ready`, or the 20 Hz binary stream restarts racing
    /// `map_init` — the bug the ready gate was added for in the first place.
    #[test]
    fn going_live_for_events_does_not_make_a_socket_ready_for_snapshots() {
        let m = SessionMap::default();
        let sid = Sid::new();
        m.insert(1, sid);
        let _ = m.go_live(sid);
        assert!(m.is_live(sid));
        assert!(
            !m.is_ready(sid),
            "map on the wire is not the same as decoded"
        );
        m.mark_ready(sid);
        assert!(m.is_ready(sid));
    }

    /// A disconnect must not leave a queue behind for a dead socket.
    #[test]
    fn removing_a_socket_forgets_what_it_was_owed() {
        let m = SessionMap::default();
        let sid = Sid::new();
        m.insert(1, sid);
        m.queue_or_emit(sid, "carve", &ev(1));
        assert_eq!(m.queued_len(sid), 1);
        assert_eq!(m.remove_sid(sid), Some(1));
        assert_eq!(m.queued_len(sid), 0);
        assert!(!m.queue_or_emit(sid, "carve", &ev(2)));
    }

    /// A reconnecting socket that reuses a player id must not leave a stale entry
    /// pointing at a dead socket, or scoped events go to nobody.
    #[test]
    fn reinserting_a_player_replaces_the_old_socket() {
        let m = SessionMap::default();
        let (a, b) = (Sid::new(), Sid::new());
        m.insert(1, a);
        m.insert(1, b);
        assert_eq!(m.len(), 1);
        assert_eq!(m.sid_of(1), Some(b));
        assert_eq!(m.player_of(a), None);
    }
}
