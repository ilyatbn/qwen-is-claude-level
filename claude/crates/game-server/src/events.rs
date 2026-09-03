//! Turning the world's `GameEvent`s into socket.io emissions, **with scope**.
//!
//! Scope is the whole point of this module (`docs/40-net-protocol.md` §3):
//!
//! | Scope | Events |
//! |---|---|
//! | Everyone | carve, explosion, projectile_*, hitscan, item_* (including item_move), crate_spawn, death, respawn, score, effect_*, hazard_spawn, phase_change, round_state, round_end, player_join, player_leave, mask_checksum |
//! | Owner only | `inventory` |
//! | Victim and attacker only | `damage` |
//!
//! `inventory` reaching anyone but its owner is an information-disclosure bug, not
//! a cosmetic one: what someone is holding is meant to be readable from their
//! sprite and nowhere else, which is deliberately imperfect information
//! (`docs/30-items-inventory.md` §6).

use std::sync::Arc;

use game_core::effects::scheduler::EffectPhase;
use game_core::items::registry::def;
use game_core::player::state::{DeathCause, PlayerId};
use game_core::world::{GameEvent, RoundPhase, World};
use socketioxide::SocketIo;

use crate::session::SessionMap;

/// Where one event goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    Everyone,
    Only(PlayerId),
    /// Victim first, then the attacker when there is one and it is not the victim.
    Pair(PlayerId, Option<PlayerId>),
}

/// The scope of an event, split out so it can be tested without a socket.
///
/// Exhaustive on purpose: a new `GameEvent` variant will not compile until someone
/// decides who receives it, which is the only way this stays correct as the event
/// list grows.
pub fn scope_of(e: &GameEvent) -> Scope {
    match e {
        GameEvent::Inventory { player_id, .. } => Scope::Only(*player_id),
        GameEvent::Damage {
            victim, attacker, ..
        } => Scope::Pair(*victim, attacker.filter(|a| a != victim)),

        GameEvent::Carve { .. }
        | GameEvent::Melee { .. }
        | GameEvent::Cone { .. }
        | GameEvent::MinePlaced { .. }
        | GameEvent::MineEnded { .. }
        | GameEvent::CarveCapsule { .. }
        | GameEvent::Explosion { .. }
        | GameEvent::ProjectileSpawn { .. }
        | GameEvent::ProjectileMove { .. }
        | GameEvent::ProjectileDespawn { .. }
        | GameEvent::Hitscan { .. }
        | GameEvent::BirdSpawn { .. }
        | GameEvent::BirdMove { .. }
        | GameEvent::BirdDespawn { .. }
        | GameEvent::ItemSpawn { .. }
        | GameEvent::ItemMove { .. }
        | GameEvent::ItemPickup { .. }
        | GameEvent::ItemDespawn { .. }
        | GameEvent::CrateSpawn { .. }
        | GameEvent::Death { .. }
        | GameEvent::Respawn { .. }
        | GameEvent::Teleport { .. }
        | GameEvent::TombstoneSpawn { .. }
        | GameEvent::TombstoneDespawn { .. }
        | GameEvent::Score { .. }
        | GameEvent::EffectStart { .. }
        | GameEvent::EffectPhaseChanged { .. }
        | GameEvent::EffectEnd { .. }
        | GameEvent::HazardSpawn { .. }
        | GameEvent::HazardEnded { .. }
        | GameEvent::PhaseChange { .. }
        | GameEvent::RoundState { .. }
        | GameEvent::RoundEnd { .. } => Scope::Everyone,
    }
}

/// The socket.io event name.
pub fn name_of(e: &GameEvent) -> &'static str {
    match e {
        GameEvent::Carve { .. } => "carve",
        GameEvent::CarveCapsule { .. } => "carve_capsule",
        GameEvent::Explosion { .. } => "explosion",
        GameEvent::ProjectileSpawn { .. } => "projectile_spawn",
        GameEvent::ProjectileMove { .. } => "projectile_move",
        GameEvent::ProjectileDespawn { .. } => "projectile_despawn",
        GameEvent::Hitscan { .. } => "hitscan",
        GameEvent::Melee { .. } => "melee",
        GameEvent::Cone { .. } => "cone",
        GameEvent::MinePlaced { .. } => "mine_placed",
        GameEvent::MineEnded { .. } => "mine_ended",
        GameEvent::BirdSpawn { .. } => "bird_spawn",
        GameEvent::BirdMove { .. } => "bird_move",
        GameEvent::BirdDespawn { .. } => "bird_despawn",
        GameEvent::ItemSpawn { .. } => "item_spawn",
        GameEvent::ItemMove { .. } => "item_move",
        GameEvent::ItemPickup { .. } => "item_pickup",
        GameEvent::ItemDespawn { .. } => "item_despawn",
        GameEvent::CrateSpawn { .. } => "crate_spawn",
        GameEvent::Inventory { .. } => "inventory",
        GameEvent::Damage { .. } => "damage",
        GameEvent::Death { .. } => "death",
        GameEvent::Respawn { .. } => "respawn",
        GameEvent::Teleport { .. } => "teleport",
        GameEvent::TombstoneSpawn { .. } => "tombstone_spawn",
        GameEvent::TombstoneDespawn { .. } => "tombstone_despawn",
        GameEvent::Score { .. } => "score",
        GameEvent::EffectStart { .. } => "effect_start",
        GameEvent::EffectPhaseChanged { .. } => "effect_phase",
        GameEvent::EffectEnd { .. } => "effect_end",
        GameEvent::HazardSpawn { .. } => "hazard_spawn",
        GameEvent::HazardEnded { .. } => "hazard_ended",
        GameEvent::PhaseChange { .. } => "phase_change",
        GameEvent::RoundState { .. } => "round_state",
        GameEvent::RoundEnd { .. } => "round_end",
    }
}

/// Wire name for an effect's lifecycle phase.
///
/// Named explicitly rather than derived from the enum, so the wire format cannot
/// change because someone renamed a variant — `docs/40` §3 fixes these strings.
fn effect_phase_name(p: EffectPhase) -> &'static str {
    match p {
        EffectPhase::Telegraph => "telegraph",
        EffectPhase::Active => "active",
        EffectPhase::Done => "cleanup",
    }
}

/// The JSON body. `world` is read for the payloads that need current state —
/// `inventory` and `score` describe the world *now* rather than carrying a
/// snapshot of it through the event queue.
pub fn payload_of(e: &GameEvent, world: &World) -> serde_json::Value {
    use serde_json::json;
    let tick = e.tick();
    match e {
        GameEvent::Carve {
            seq, x, y, r, kind, ..
        } => json!({"tick": tick, "seq": seq, "x": x, "y": y, "r": r, "kind": format!("{kind:?}")}),
        GameEvent::CarveCapsule {
            seq,
            x0,
            y0,
            x1,
            y1,
            r,
            ..
        } => json!({"tick": tick, "seq": seq, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "r": r}),
        GameEvent::Explosion { x, y, r, kind, .. } => {
            json!({"tick": tick, "x": x, "y": y, "r": r, "kind": format!("{kind:?}")})
        }
        // §B6 ordnance. All cosmetic on the client — the damage is already in the
        // damage events — but a swing or a jet you cannot see reads as damage
        // from nowhere, and a mine nobody can spot is not a trap, it is a bug
        // that looks like one.
        GameEvent::Melee {
            owner,
            weapon,
            x,
            y,
            aim,
            reach,
            arc,
            hits,
            ..
        } => json!({"tick": tick, "owner": owner, "weapon": weapon.0, "x": x, "y": y,
                    "aim": aim, "reach": reach, "arc": arc, "hits": hits}),
        GameEvent::Cone {
            owner,
            weapon,
            x,
            y,
            aim,
            range,
            arc,
            ..
        } => json!({"tick": tick, "owner": owner, "weapon": weapon.0, "x": x, "y": y,
                    "aim": aim, "range": range, "arc": arc}),
        GameEvent::MinePlaced {
            id,
            owner,
            weapon,
            x,
            y,
            ..
        } => json!({"tick": tick, "id": id, "owner": owner, "weapon": weapon.0, "x": x, "y": y}),
        GameEvent::MineEnded { id, reason, .. } => {
            json!({"tick": tick, "id": id, "reason": format!("{reason:?}")})
        }
        GameEvent::ProjectileSpawn {
            id,
            weapon,
            owner,
            x,
            y,
            vx,
            vy,
            ..
        } => json!({
            "tick": tick, "id": id, "weapon": weapon.0, "owner": owner,
            "x": x, "y": y, "vx": vx, "vy": vy
        }),
        GameEvent::ProjectileDespawn { id, reason, .. } => {
            json!({"tick": tick, "id": id, "reason": format!("{reason:?}")})
        }
        GameEvent::Hitscan {
            owner,
            x0,
            y0,
            x1,
            y1,
            hit,
            ..
        } => json!({
            "tick": tick, "owner": owner, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "hit": hit
        }),
        GameEvent::BirdSpawn {
            id,
            kind,
            x,
            y,
            right,
            ..
        } => json!({
            "tick": tick, "id": id, "kind": kind, "x": x, "y": y, "right": right
        }),
        GameEvent::BirdMove { id, x, y, .. } => {
            json!({"tick": tick, "id": id, "x": x, "y": y})
        }
        GameEvent::BirdDespawn { id, killed, .. } => {
            json!({"tick": tick, "id": id, "killed": killed})
        }
        GameEvent::ItemSpawn {
            world_item_id,
            item_id,
            count,
            x,
            y,
            source,
            ..
        } => json!({
            "tick": tick, "world_item_id": world_item_id, "item_id": item_id,
            "count": count, "x": x, "y": y, "source": format!("{source:?}")
        }),
        GameEvent::ProjectileMove { id, x, y, .. } => {
            json!({"tick": tick, "id": id, "x": x, "y": y})
        }
        GameEvent::ItemMove {
            world_item_id,
            x,
            y,
            grounded,
            ..
        } => json!({
            "tick": tick, "world_item_id": world_item_id,
            "x": x, "y": y, "grounded": grounded
        }),
        GameEvent::ItemPickup {
            world_item_id,
            player_id,
            ..
        } => json!({"tick": tick, "world_item_id": world_item_id, "player_id": player_id}),
        GameEvent::ItemDespawn { world_item_id, .. } => {
            json!({"tick": tick, "world_item_id": world_item_id})
        }
        GameEvent::CrateSpawn {
            world_item_id,
            x,
            y,
            ..
        } => json!({"tick": tick, "world_item_id": world_item_id, "x": x, "y": y}),
        GameEvent::Inventory { player_id, .. } => {
            let slots = world
                .player(*player_id)
                .map(|p| {
                    (0..game_core::constants::INVENTORY_SLOTS)
                        .map(|i| match p.inventory.slot(i as u8) {
                            Some(s) => json!({
                                "item": s.item,
                                "count": s.count,
                                "key": def(s.item).map(|d| d.key).unwrap_or("?"),
                            }),
                            None => serde_json::Value::Null,
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let selected = world.player(*player_id).map(|p| p.inventory.selected());
            json!({"tick": tick, "slots": slots, "selected": selected})
        }
        GameEvent::Damage {
            victim,
            attacker,
            amount,
            cause,
            ..
        } => json!({
            "tick": tick, "victim": victim, "attacker": attacker,
            "amount": amount, "cause": cause_name(*cause)
        }),
        GameEvent::Death {
            victim,
            attacker,
            cause,
            ..
        } => json!({
            "tick": tick, "victim": victim, "attacker": attacker, "cause": cause_name(*cause),
            // The client counts down to *this*, against the round time in the
            // snapshot header — not from a local timer started on arrival. A
            // local timer drifts by the latency of the death event itself and
            // then disagrees with the moment the player actually respawns.
            "respawn_at": world.player(*victim).map(|p| p.respawn_at),
            "round_time": world.round_time,
        }),
        GameEvent::Respawn { id, x, y, .. } => json!({"tick": tick, "id": id, "x": x, "y": y}),
        // Everyone: a player vanishing from one pad and appearing on another is
        // something the other players have to be able to read, and a snapshot
        // alone shows only the arrival.
        GameEvent::Teleport {
            id,
            from_pad,
            to_pad,
            x,
            y,
            ..
        } => {
            json!({"tick": tick, "id": id, "from_pad": from_pad, "to_pad": to_pad, "x": x, "y": y})
        }
        GameEvent::TombstoneSpawn {
            id,
            owner,
            x,
            y,
            skin_id,
            ..
        } => json!({"tick": tick, "id": id, "owner": owner, "x": x, "y": y, "skin_id": skin_id}),
        GameEvent::TombstoneDespawn { id, .. } => json!({"tick": tick, "id": id}),
        GameEvent::Score { .. } => json!({
            "tick": tick,
            "scores": world.players.iter().map(|p| json!({
                "id": p.id, "score": p.score, "deaths": p.deaths
            })).collect::<Vec<_>>()
        }),
        GameEvent::EffectStart {
            id,
            kind,
            seed,
            duration,
            ..
        } => json!({
            "tick": tick, "id": id, "kind": format!("{kind:?}"), "phase": "telegraph",
            "seed": seed.to_string(), "duration": duration
        }),
        // `docs/40` §3 and `docs/13` §2 both give this field's literal values as
        // lowercase, and `effect_start` above hardcodes `"telegraph"`. Serialising
        // the enum's `Debug` here instead sent `"Active"`, so the *same field*
        // arrived in two different casings depending on which event carried it,
        // and a client switching on it had to know which one it came from.
        // Found by the first check that watched a whole round (T9.06); no unit
        // test compares two events' encodings against each other.
        GameEvent::EffectPhaseChanged { id, phase, .. } => {
            json!({"tick": tick, "id": id, "phase": effect_phase_name(*phase)})
        }
        GameEvent::EffectEnd { id, .. } => json!({"tick": tick, "id": id}),
        GameEvent::HazardEnded { id, .. } => json!({"tick": tick, "id": id}),
        GameEvent::HazardSpawn {
            id,
            kind,
            x,
            y,
            r,
            duration,
            ..
        } => json!({
            "tick": tick, "id": id, "kind": format!("{kind:?}"),
            "x": x, "y": y, "r": r, "duration": duration
        }),
        GameEvent::PhaseChange { day_phase, .. } => {
            json!({"tick": tick, "day_phase": format!("{day_phase:?}").to_lowercase()})
        }
        GameEvent::RoundState {
            phase, time_left, ..
        } => round_state_payload(tick, *phase, *time_left, world.seed),
        GameEvent::RoundEnd { .. } => json!({"tick": tick, "reason": "round_over"}),
    }
}

fn cause_name(c: DeathCause) -> &'static str {
    match c {
        DeathCause::Player(_) => "player",
        DeathCause::SelfInflicted => "self",
        DeathCause::Weather => "weather",
        // §C15. A distinct string, not folded into "weather": the death overlay
        // and the kill feed have a sentence to write, and "killed by the weather"
        // for someone who dug through the floor is the wrong one.
        DeathCause::Void => "void",
    }
}

/// Emit a tick's events, each to its own scope.
///
/// Events are emitted in the order the world produced them, **and that order now
/// holds across ticks as well as within a batch** — it did not while each batch
/// went to its own `tokio::spawn`. Carves are never reordered or coalesced:
/// clients apply them in `seq` order, and merging two overlapping carves into
/// one changes the resulting mask (`docs/11-map-destruction.md` §6).
/// The `round_state` payload, built in **one** place.
///
/// Two paths emit this event — `payload_of` for a match, `flush_lobby_events`
/// for a lobby, which has no world to read the seed off — and they each built
/// the object independently. Identical today; add a field and the lobby path
/// silently omits it, so a client would get one shape for its first seconds and
/// a different one once playing. `CLAUDE.md`: share the guard, or share the
/// function. The decoration `7` spelled six places is the same shape.
fn round_state_payload(
    tick: u32,
    phase: RoundPhase,
    time_left: f32,
    seed: u64,
) -> serde_json::Value {
    serde_json::json!({
        "tick": tick,
        "phase": phase.as_str(),
        "time_left": time_left,
        "seed": seed.to_string(),
    })
}

/// The `lobby_state` payload (§E6), built in one place and sent to every socket.
///
/// `players` comes from `LobbyState`, which derives it from `Seats` — §E1.1's
/// single source. Optional fields are **omitted**, not sent as null: §E6 says
/// "absent", and a client distinguishing `undefined` from `null` is a second
/// spelling of the same absence.
pub fn lobby_state_payload(state: &crate::room::LobbyState) -> serde_json::Value {
    let mut v = serde_json::json!({
        "private": state.private,
        "capacity": state.capacity,
        "scale": state.scale.as_str(),
        "players": state
            .players
            .iter()
            .map(|p| serde_json::json!({
                "seat": p.seat,
                "name": p.name,
                "skin_id": p.skin_id,
                "ready": p.ready,
                "bot": p.bot,
            }))
            .collect::<Vec<_>>(),
    });
    let map = v.as_object_mut().expect("json! built an object");
    if let Some(code) = state.code.as_ref() {
        map.insert("code".into(), serde_json::json!(code));
    }
    if let Some(owner) = state.settings_owner {
        map.insert("settings_owner".into(), serde_json::json!(owner));
    }
    if let Some(left) = state.starts_in {
        map.insert("starts_in".into(), serde_json::json!(left));
    }
    v
}

/// Send `lobby_state` to every socket in the room (§E6).
pub fn broadcast_lobby_state(
    io: &SocketIo,
    sessions: &Arc<SessionMap>,
    state: &crate::room::LobbyState,
) {
    let payload = lobby_state_payload(state);
    // **Emitted directly, never queued**, the way `broadcast_map_init` is.
    //
    // `queue_or_emit` holds events for a socket still inside its join window and
    // the hold is *bounded* (`JOIN_EVENT_QUEUE_MAX`); overflowing it forces a
    // fresh `map_init`, and a client that replays its carve stream against a
    // mask snapshot taken at a different moment disagrees with the server. A
    // lobby broadcasts on every join, leave, ready and whole second, so routing
    // it through that queue spent the capacity carves need: measured, it took
    // `two_clients_agree_on_the_mask_after_a_hundred_carves` from 1 failure in
    // 16 to 8 in 24.
    //
    // Nothing is lost by skipping the queue. `lobby_state` carries no sequence
    // and is ordered against nothing, and a socket still in its join window is
    // sent the current lobby by `seat` the moment it goes live.
    for sid in sessions.sids() {
        if let Some(s) = io.get_socket(sid) {
            let _ = s.emit("lobby_state", &payload);
        }
    }
}

/// One player's own inventory, as `docs/30` §6 scopes it.
///
/// Built in one place because two callers need it: the join handshake, and match
/// start. They were one caller until §E1 moved the world — see
/// [`broadcast_inventories`].
pub fn inventory_payload(world: &World, id: PlayerId) -> Option<serde_json::Value> {
    let p = world.player(id)?;
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
        "tick": world.tick,
        "slots": slots,
        "selected": p.inventory.selected(),
    }))
}

/// Send every seated player their own inventory, at match start.
///
/// **The bug this exists for.** `inventory` is pushed on pickup, use and death —
/// it describes *changes* — so a player holding something before the first event
/// needs to be told the current value. The join handshake did that, and §E1 moved
/// the world out from under it: a player seats into a **lobby**, where
/// `grant_dev_loadout` has nothing to act on, and the loadout is granted later by
/// `populate_world`. Nothing told them. Armed on the server, empty on screen.
///
/// T17.01 added `broadcast_map_init` here and left this consumer behind — one
/// mechanism moved, one of its two readers updated. It surfaced only when a
/// fixture in another task tripped over it, two tasks later.
///
/// Owner-scoped like every other `inventory`, never broadcast.
pub fn broadcast_inventories(io: &SocketIo, sessions: &Arc<SessionMap>, world: &World) {
    for p in world.players.iter() {
        if let Some(payload) = inventory_payload(world, p.id) {
            emit_to(io, sessions, p.id, "inventory", &payload);
        }
    }
}

/// Send `map_init` to every socket in the room, at match start.
///
/// §E1: the map does not exist while the room is a lobby, so this is the moment
/// every seated player receives one — not the moment they sat down. Base64 text
/// rather than a binary attachment, for the reason `codec::b64_encode` gives.
pub fn broadcast_map_init(io: &SocketIo, sessions: &Arc<SessionMap>, bytes: &[u8]) {
    let payload = crate::codec::b64_encode(bytes);
    for sid in sessions.sids() {
        let Some(s) = io.get_socket(sid) else {
            continue;
        };
        if let Err(e) = s.emit("map_init", &payload) {
            tracing::warn!(target: "game::net", socket = %sid, "match-start map_init failed: {e}");
        }
    }
}

/// Flush the events a **lobby** produces, which has no world to describe them.
///
/// A lobby can only emit `RoundState` — there is no simulation to produce
/// anything else — and the one field `payload_of` reads off the world for it is
/// the seed, which the room holds anyway and which is the same number the world
/// will be built from. Anything else arriving here is a bug rather than a case
/// to handle, so it is logged instead of silently dropped.
pub fn flush_lobby_events(
    io: &SocketIo,
    sessions: &Arc<SessionMap>,
    seed: u64,
    events: &[GameEvent],
) {
    for e in events {
        let GameEvent::RoundState {
            tick,
            phase,
            time_left,
        } = e
        else {
            tracing::warn!(
                target: "game::round",
                event = name_of(e),
                "a lobby produced an event that needs a world"
            );
            continue;
        };
        let payload = round_state_payload(*tick, *phase, *time_left, seed);
        for sid in sessions.sids() {
            if sessions.queue_or_emit(sid, "round_state", &payload) {
                if let Some(s) = io.get_socket(sid) {
                    let _ = s.emit("round_state", &payload);
                }
            }
        }
    }
}

pub fn flush_events(
    io: &SocketIo,
    world: &World,
    sessions: &Arc<SessionMap>,
    events: &[GameEvent],
) {
    if events.is_empty() {
        return;
    }
    let mut batch: Vec<(&'static str, serde_json::Value, Scope)> = Vec::with_capacity(events.len());
    for e in events {
        batch.push((name_of(e), payload_of(e, world), scope_of(e)));
    }

    // Emitted **inline**, not from a spawned task.
    //
    // The previous version handed each batch to `tokio::spawn` on the grounds
    // that emitting is async — it is not: `SocketRef::emit` returns
    // `Result<(), SendError>` and is a queue push per socket. Two spawned tasks
    // have no ordering guarantee between them, so consecutive ticks' batches
    // could interleave: measured at 2076 out-of-order adjacent pairs over 60
    // batches x 40 rounds. Carves carry a monotonic `seq` that clients apply in
    // order, so reordering them across ticks manufactures the exact gap that
    // triggers a `resync_map`.
    for (name, payload, scope) in batch {
        match scope {
            Scope::Everyone => {
                // Gated on **map delivery**, not on `ready` (§A40).
                //
                // A socket can apply carves as soon as it has a mask, and holding
                // them until `ready` is what dropped every carve in the join
                // window — 1–2 full map resyncs per client per round once the
                // bots started firing. `queue_or_emit` either emits now or holds
                // the event for the join handler to flush in order.
                // The room's own socket list, not `io.sockets()` — that
                // reaches every socket in the process, and with more than one
                // room a carve in one game would land in another (`docs/71` §B1).
                for sid in sessions.sids() {
                    if sessions.queue_or_emit(sid, name, &payload) {
                        if let Some(s) = io.get_socket(sid) {
                            let _ = s.emit(name, &payload);
                        }
                    }
                }
            }
            Scope::Only(p) => emit_to(io, sessions, p, name, &payload),
            Scope::Pair(victim, attacker) => {
                emit_to(io, sessions, victim, name, &payload);
                if let Some(a) = attacker {
                    emit_to(io, sessions, a, name, &payload);
                }
            }
        }
    }
}

/// Deliver to one player, if they have a socket at all.
///
/// A bot has none (§A5), so this is also the guard that keeps the per-owner emit
/// path from trying to send an `inventory` to something that cannot receive one.
///
/// ## Deliberately ungated, and there are exactly two readiness rules
///
/// Broadcasts gate on **map delivery** (§A40) and snapshots gate on **`ready`**.
/// This path gates on **neither**, and that is a decision rather than an
/// oversight — the original join-window gap survived four milestones precisely
/// because a third, unwritten rule existed without anyone deciding it.
///
/// Scoped events are safe to deliver early for reasons broadcasts are not:
///
/// - They are **JSON**, so they cannot interleave with the binary `map_init` the
///   way the 20 Hz snapshot stream did. That interleave is the whole reason the
///   `ready` gate exists.
/// - They carry **no ordering token**. A carve has a monotonic `seq` and a hole
///   in it costs a full map resync; an `inventory` is a complete current value
///   and a `damage` is self-contained, so an early one is applied or ignored
///   harmlessly.
/// - The current value is **re-sent at join anyway** (T9.08), so a scoped event
///   arriving before the client is ready cannot leave it stale.
///
/// With multiple rooms this path must be right about **which socket** and
/// **which room**. The room half is structural: `sessions` is the room's own map,
/// so a `PlayerId` from room A cannot resolve to a socket in room B.
fn emit_to(
    io: &SocketIo,
    sessions: &SessionMap,
    player: PlayerId,
    name: &'static str,
    payload: &serde_json::Value,
) {
    let Some(sid) = sessions.sid_of(player) else {
        return;
    };
    if let Some(s) = io.get_socket(sid) {
        let _ = s.emit(name, payload);
    }
}

/// Broadcast the snapshot for this tick. Binary, and `last_input_seq` is per
/// recipient, so each socket gets its own frame.
/// Returns the total bytes sent, for `/metrics`.
pub fn broadcast_snapshot(
    io: &SocketIo,
    world: &World,
    sessions: &Arc<SessionMap>,
    last_seq: &[(PlayerId, u32)],
) -> usize {
    let mut frames: Vec<(socketioxide::socket::Sid, Vec<u8>)> = Vec::new();
    for (player, seq) in last_seq {
        if let Some(sid) = sessions.sid_of(*player) {
            frames.push((sid, crate::codec::encode_snapshot(world, *player, *seq)));
        }
    }
    if frames.is_empty() {
        return 0;
    }
    let total: usize = frames.iter().map(|(_, b)| b.len()).sum();
    // Inline for the same reason as `flush_events`: a spawned task per tick lets
    // a stale snapshot land after a newer one.
    for (sid, bytes) in frames {
        if let Some(s) = io.get_socket(sid) {
            let _ = s.emit("snapshot", &crate::codec::b64_encode(&bytes));
        }
    }
    total
}

pub fn emit_round_end(io: &SocketIo, sessions: &SessionMap, tick: u32, reason: &str) {
    let payload = serde_json::json!({ "tick": tick, "reason": reason });
    for sid in sessions.sids() {
        if let Some(s) = io.get_socket(sid) {
            let _ = s.emit("round_end", &payload);
        }
    }
}

pub fn emit_mask_checksum(io: &SocketIo, sessions: &SessionMap, tick: u32, hash: &str) {
    let payload = serde_json::json!({ "tick": tick, "hash": hash });
    // Inline, and to every socket **in this room**: a client still loading its
    // map has nothing to compare yet and ignores it, which is cheaper than
    // tracking readiness here.
    for sid in sessions.sids() {
        if let Some(s) = io.get_socket(sid) {
            let _ = s.emit("mask_checksum", &payload);
        }
    }
}

/// Announce a player who was seated **after** the clients were already here.
///
/// A socket learns the roster from its own `welcome` and then from
/// `player_join` (`docs/40` §3). Bots used to be seated when the room was
/// constructed, so every human's `welcome` already listed them and no
/// announcement was needed. §C18 moved seating to `begin_round` — which happens
/// while humans are connected and watching — and nothing was added to tell
/// them. The result: snapshots carried three players and the scoreboard listed
/// one, so the results screen at the end of a round against bots named nobody
/// but you. §A39 in its quietest form — the *consumer* existed and the producer
/// stopped calling it.
pub fn emit_player_join(
    io: &SocketIo,
    sessions: &SessionMap,
    tick: u32,
    id: game_core::player::state::PlayerId,
    name: &str,
    skin_id: u16,
    tombstone_skin_id: u16,
) {
    let payload = serde_json::json!({
        "tick": tick,
        "id": id,
        "name": name,
        "skin_id": skin_id,
        "tombstone_skin_id": tombstone_skin_id,
    });
    for sid in sessions.sids() {
        if let Some(s) = io.get_socket(sid) {
            let _ = s.emit("player_join", &payload);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use game_core::constants::MapScale;
    use game_core::world::{CarveKind, DespawnReason};

    fn world() -> World {
        let mut w = World::new(4242, MapScale::Small);
        w.add_player(0, 0, "a".into());
        w.add_player(1, 0, "b".into());
        w.set_phase(RoundPhase::Playing);
        let _ = w.drain_events();
        w
    }

    #[test]
    fn inventory_is_scoped_to_its_owner_and_nobody_else() {
        let e = GameEvent::Inventory {
            tick: 5,
            player_id: 3,
        };
        assert_eq!(scope_of(&e), Scope::Only(3));
    }

    #[test]
    fn damage_reaches_the_victim_and_the_attacker_only() {
        let e = GameEvent::Damage {
            tick: 5,
            victim: 1,
            attacker: Some(2),
            amount: 10.0,
            cause: DeathCause::Player(2),
        };
        assert_eq!(scope_of(&e), Scope::Pair(1, Some(2)));
    }

    /// Self-damage must not send the victim two copies of the same event.
    #[test]
    fn self_damage_does_not_double_deliver() {
        let e = GameEvent::Damage {
            tick: 5,
            victim: 1,
            attacker: Some(1),
            amount: 10.0,
            cause: DeathCause::SelfInflicted,
        };
        assert_eq!(scope_of(&e), Scope::Pair(1, None));
    }

    #[test]
    fn environmental_damage_has_no_attacker_to_deliver_to() {
        let e = GameEvent::Damage {
            tick: 5,
            victim: 1,
            attacker: None,
            amount: 10.0,
            cause: DeathCause::Weather,
        };
        assert_eq!(scope_of(&e), Scope::Pair(1, None));
    }

    /// Death is public even though damage is not — everyone sees the kill feed.
    #[test]
    fn death_is_public_while_damage_is_private() {
        let d = GameEvent::Death {
            tick: 1,
            victim: 1,
            attacker: Some(2),
            cause: DeathCause::Player(2),
        };
        assert_eq!(scope_of(&d), Scope::Everyone);
    }

    #[test]
    fn terrain_and_round_events_go_to_everyone() {
        let cases = [
            GameEvent::Carve {
                tick: 1,
                seq: 1,
                x: 0,
                y: 0,
                r: 1,
                kind: CarveKind::Weapon,
            },
            GameEvent::Explosion {
                tick: 1,
                x: 0.0,
                y: 0.0,
                r: 1.0,
                kind: CarveKind::Weapon,
            },
            GameEvent::ProjectileDespawn {
                tick: 1,
                id: 0,
                reason: DespawnReason::Exploded,
            },
            GameEvent::Score { tick: 1 },
            GameEvent::RoundEnd { tick: 1 },
        ];
        for e in cases {
            assert_eq!(scope_of(&e), Scope::Everyone, "{}", name_of(&e));
        }
    }

    #[test]
    fn every_event_payload_carries_its_tick() {
        let w = world();
        let cases = [
            GameEvent::Carve {
                tick: 42,
                seq: 1,
                x: 1,
                y: 2,
                r: 3,
                kind: CarveKind::Meteor,
            },
            GameEvent::Inventory {
                tick: 42,
                player_id: 0,
            },
            GameEvent::Damage {
                tick: 42,
                victim: 0,
                attacker: Some(1),
                amount: 5.0,
                cause: DeathCause::Player(1),
            },
            GameEvent::Score { tick: 42 },
            GameEvent::RoundState {
                tick: 42,
                phase: RoundPhase::Playing,
                time_left: 10.0,
            },
        ];
        for e in cases {
            let p = payload_of(&e, &w);
            assert_eq!(p["tick"], 42, "{} lost its tick", name_of(&e));
        }
    }

    #[test]
    fn the_inventory_payload_has_one_entry_per_slot() {
        let mut w = world();
        game_core::world::give(&mut w, 0, game_core::items::registry::BAZOOKA, 4);
        let p = payload_of(
            &GameEvent::Inventory {
                tick: 1,
                player_id: 0,
            },
            &w,
        );
        let slots = p["slots"].as_array().expect("slots array");
        assert_eq!(slots.len(), game_core::constants::INVENTORY_SLOTS);
        // Slot 0 is the shovel every player is issued (§F5), so `give` puts the
        // bazooka in slot 1. Both are asserted: the payload has to carry the
        // starting kit as well as what was picked up, and a payload that only
        // reported slot 0 would still satisfy a one-slot assertion.
        assert_eq!(slots[0]["key"], "shovel");
        assert_eq!(slots[0]["count"], 1);
        assert_eq!(slots[1]["key"], "bazooka");
        assert_eq!(slots[1]["count"], 4);
        assert!(slots[2].is_null(), "empty slots are null, not omitted");
    }

    #[test]
    fn the_score_payload_lists_every_player() {
        let w = world();
        let p = payload_of(&GameEvent::Score { tick: 1 }, &w);
        let scores = p["scores"].as_array().expect("scores array");
        assert_eq!(scores.len(), 2);
    }

    /// The seed is on `round_state` so a bug report carries a reproducible map
    /// (`docs/61` §8). As a string, because a u64 seed loses precision in JSON.
    #[test]
    fn round_state_carries_the_seed_losslessly() {
        let w = world();
        let p = payload_of(
            &GameEvent::RoundState {
                tick: 1,
                phase: RoundPhase::Playing,
                time_left: 1.0,
            },
            &w,
        );
        assert_eq!(p["seed"], w.seed.to_string());
    }

    /// The same field, on the two events that carry it, must agree.
    ///
    /// `effect_start` hardcoded `"telegraph"` while `effect_phase` serialised the
    /// enum's `Debug`, so the wire carried `"telegraph"` and `"Active"` for one
    /// field and a client switching on it had to know which event it came from.
    /// No unit test compared two events' encodings against each other, so it took
    /// a check that watched a whole round to notice (T9.06).
    #[test]
    fn effect_phase_uses_the_same_casing_on_both_events() {
        let w = world();
        let start = payload_of(
            &GameEvent::EffectStart {
                tick: 1,
                id: 7,
                kind: game_core::weapons::explode::EffectKind::HeavyFog,
                seed: 1,
                duration: 15.0,
            },
            &w,
        );
        let changed = payload_of(
            &GameEvent::EffectPhaseChanged {
                tick: 2,
                id: 7,
                phase: EffectPhase::Active,
            },
            &w,
        );
        let a = start["phase"].as_str().expect("phase is a string");
        let b = changed["phase"].as_str().expect("phase is a string");
        assert_eq!(a, a.to_lowercase(), "effect_start phase must be lowercase");
        assert_eq!(b, b.to_lowercase(), "effect_phase phase must be lowercase");
        // And the literal values docs/40 §3 fixes.
        assert_eq!(a, "telegraph");
        assert_eq!(b, "active");
        assert_eq!(effect_phase_name(EffectPhase::Telegraph), "telegraph");
        assert_eq!(effect_phase_name(EffectPhase::Done), "cleanup");
    }
}
