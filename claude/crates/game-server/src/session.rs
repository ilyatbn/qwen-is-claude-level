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
use crate::room::{Command, RoomHandle};

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
    /// Broadcasts are gated on this. A seated-but-not-ready socket that receives
    /// `carve` events while its `map_init` is still in flight drops them, and
    /// carves carry a monotonic `seq` the client must apply in order — so the
    /// gap it leaves triggers a full `resync_map` two seconds later
    /// (`docs/42` §6). Joining mid-firefight would cost an immediate resync.
    ready: RwLock<Vec<Sid>>,
}

impl SessionMap {
    pub fn insert(&self, player: PlayerId, sid: Sid) {
        if let Ok(mut v) = self.inner.write() {
            v.retain(|(p, s)| *p != player && *s != sid);
            v.push((player, sid));
            v.sort_by_key(|(p, _)| *p);
        }
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

    pub fn remove_sid(&self, sid: Sid) -> Option<PlayerId> {
        if let Ok(mut r) = self.ready.write() {
            r.retain(|s| *s != sid);
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
pub fn register(io: &SocketIo, room: RoomHandle, sessions: Arc<SessionMap>, config: Arc<Config>) {
    let io2 = io.clone();
    io.ns("/", move |socket: SocketRef| {
        let room = room.clone();
        let sessions = sessions.clone();
        let config = config.clone();
        let io = io2.clone();
        async move {
            tracing::info!(target: "game::net", socket = %socket.id, "socket connected");

            // ------------------------------------------------------------ join
            {
                let (room, sessions, io, config) =
                    (room.clone(), sessions.clone(), io.clone(), config.clone());
                socket.on(
                    "join",
                    move |socket: SocketRef, Data::<serde_json::Value>(payload)| {
                        let (room, sessions, io, config) =
                            (room.clone(), sessions.clone(), io.clone(), config.clone());
                        async move {
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
                                emit(&socket, "join_error", &serde_json::json!({ "reason": "bad_name" }));
                                return;
                            };
                            // Never validated against a list — the server does not
                            // know what skins exist (`docs/50` §1) — but bounded.
                            let skin_id = payload
                                .get("skin_id")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0)
                                .min(u16::MAX as u64) as u16;

                            let Some(id) = room.join(name.clone(), skin_id).await else {
                                emit(&socket, "join_error", &serde_json::json!({ "reason": "full" }));
                                return;
                            };
                            sessions.insert(id, socket.id);

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

                            let joined = serde_json::json!({
                                "tick": tick, "id": id, "name": name, "skin_id": skin_id,
                            });
                            broadcast_except(&io, socket.id, "player_join", &joined);
                            tracing::info!(target: "game::net", player = id, %name, "joined");
                        }
                    },
                );
            }

            // ----------------------------------------------------------- ready
            {
                let (room, sessions) = (room.clone(), sessions.clone());
                socket.on("ready", move |socket: SocketRef| {
                    let (room, sessions) = (room.clone(), sessions.clone());
                    async move {
                        if let Some(id) = sessions.player_of(socket.id) {
                            sessions.mark_ready(socket.id);
                            room.send(Command::Ready(id));
                        }
                    }
                });
            }

            // ----------------------------------------------------------- input
            {
                let (room, sessions) = (room.clone(), sessions.clone());
                socket.on("input", move |socket: SocketRef, Data::<String>(b64)| {
                    let (room, sessions) = (room.clone(), sessions.clone());
                    async move {
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
                let (room, sessions) = (room.clone(), sessions.clone());
                socket.on(
                    "use_item",
                    move |socket: SocketRef, Data::<serde_json::Value>(p)| {
                        let (room, sessions) = (room.clone(), sessions.clone());
                        async move {
                            if let Some(id) = sessions.player_of(socket.id) {
                                let slot = p.get("slot").and_then(|v| v.as_u64()).unwrap_or(255);
                                room.send(Command::UseItem(id, slot.min(255) as u8));
                            }
                        }
                    },
                );
            }
            {
                let (room, sessions) = (room.clone(), sessions.clone());
                socket.on(
                    "select_slot",
                    move |socket: SocketRef, Data::<serde_json::Value>(p)| {
                        let (room, sessions) = (room.clone(), sessions.clone());
                        async move {
                            if let Some(id) = sessions.player_of(socket.id) {
                                let slot = p.get("slot").and_then(|v| v.as_u64()).unwrap_or(255);
                                room.send(Command::SelectSlot(id, slot.min(255) as u8));
                            }
                        }
                    },
                );
            }
            {
                let (room, sessions) = (room.clone(), sessions.clone());
                // RTT. `docs/42` §7 says it comes from "socket.io's own ping/pong",
                // but the client library does not surface that measurement, so the
                // client's rtt was hardcoded to 0 and the debug HUD reported 0 ms
                // on every connection — a number that reports nothing (§A15).
                // An echo with the client's own timestamp costs one tiny message
                // and makes it real. Stateless, unauthenticated and harmless: the
                // server never reads the value, it only sends it back.
                socket.on("ping_rtt", |socket: SocketRef, Data::<String>(t)| async move {
                    let _ = socket.emit("pong_rtt", &t);
                });
                socket.on("toggle_flashlight", move |socket: SocketRef| {
                    let (room, sessions) = (room.clone(), sessions.clone());
                    async move {
                        if let Some(id) = sessions.player_of(socket.id) {
                            room.send(Command::ToggleFlashlight(id));
                        }
                    }
                });
            }
            {
                let (room, sessions) = (room.clone(), sessions.clone());
                socket.on("fire", move |socket: SocketRef| {
                    let (room, sessions) = (room.clone(), sessions.clone());
                    async move {
                        if let Some(id) = sessions.player_of(socket.id) {
                            room.send(Command::Fire(id));
                        }
                    }
                });
            }
            {
                let (room, sessions) = (room.clone(), sessions.clone());
                socket.on(
                    "vote_restart",
                    move |socket: SocketRef, Data::<serde_json::Value>(p)| {
                        let (room, sessions) = (room.clone(), sessions.clone());
                        async move {
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
                let (room, sessions) = (room.clone(), sessions.clone());
                socket.on("resync_map", move |socket: SocketRef| {
                    let (room, sessions) = (room.clone(), sessions.clone());
                    async move {
                        let Some(_id) = sessions.player_of(socket.id) else {
                            return;
                        };
                        let Some(bytes) = room.inspect(|w| encode_map_init_at(&w.map, w.carve_seq())).await else {
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
                let (room, sessions, io) = (room.clone(), sessions.clone(), io.clone());
                socket.on_disconnect(move |socket: SocketRef| {
                    let (room, sessions, io) = (room.clone(), sessions.clone(), io.clone());
                    async move {
                        // Fires on an abrupt drop as well as a clean close, which
                        // is what keeps a crashed client from holding a seat.
                        if let Some(id) = sessions.remove_sid(socket.id) {
                            room.send(Command::Leave(id));
                            let payload = serde_json::json!({ "id": id, "reason": "disconnect" });
                            broadcast_except(&io, socket.id, "player_leave", &payload);
                            tracing::info!(target: "game::net", player = id, "left");
                        }
                    }
                });
            }
        }
    });
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

/// Broadcast to everyone but one socket, without awaiting in a handler.
fn broadcast_except(io: &SocketIo, except: Sid, ev: &'static str, payload: &serde_json::Value) {
    let (io, payload) = (io.clone(), payload.clone());
    tokio::spawn(async move {
        for s in io.sockets() {
            if s.id == except {
                continue;
            }
            let _ = s.emit(ev, &payload);
        }
    });
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
