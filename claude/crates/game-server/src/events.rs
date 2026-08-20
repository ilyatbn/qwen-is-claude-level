//! Turning the world's `GameEvent`s into socket.io emissions, **with scope**.
//!
//! Scope is the whole point of this module (`docs/40-net-protocol.md` §3):
//!
//! | Scope | Events |
//! |---|---|
//! | Everyone | carve, explosion, projectile_*, hitscan, item_*, crate_spawn, death, respawn, score, effect_*, hazard_spawn, phase_change, round_state, round_end, player_join, player_leave, mask_checksum |
//! | Owner only | `inventory` |
//! | Victim and attacker only | `damage` |
//!
//! `inventory` reaching anyone but its owner is an information-disclosure bug, not
//! a cosmetic one: what someone is holding is meant to be readable from their
//! sprite and nowhere else, which is deliberately imperfect information
//! (`docs/30-items-inventory.md` §6).

use std::sync::Arc;

use game_core::items::registry::def;
use game_core::player::state::{DeathCause, PlayerId};
use game_core::world::{GameEvent, World};
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
        | GameEvent::CarveCapsule { .. }
        | GameEvent::Explosion { .. }
        | GameEvent::ProjectileSpawn { .. }
        | GameEvent::ProjectileDespawn { .. }
        | GameEvent::Hitscan { .. }
        | GameEvent::ItemSpawn { .. }
        | GameEvent::ItemPickup { .. }
        | GameEvent::ItemDespawn { .. }
        | GameEvent::CrateSpawn { .. }
        | GameEvent::Death { .. }
        | GameEvent::Respawn { .. }
        | GameEvent::Score { .. }
        | GameEvent::EffectStart { .. }
        | GameEvent::EffectPhaseChanged { .. }
        | GameEvent::EffectEnd { .. }
        | GameEvent::HazardSpawn { .. }
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
        GameEvent::ProjectileDespawn { .. } => "projectile_despawn",
        GameEvent::Hitscan { .. } => "hitscan",
        GameEvent::ItemSpawn { .. } => "item_spawn",
        GameEvent::ItemPickup { .. } => "item_pickup",
        GameEvent::ItemDespawn { .. } => "item_despawn",
        GameEvent::CrateSpawn { .. } => "crate_spawn",
        GameEvent::Inventory { .. } => "inventory",
        GameEvent::Damage { .. } => "damage",
        GameEvent::Death { .. } => "death",
        GameEvent::Respawn { .. } => "respawn",
        GameEvent::Score { .. } => "score",
        GameEvent::EffectStart { .. } => "effect_start",
        GameEvent::EffectPhaseChanged { .. } => "effect_phase",
        GameEvent::EffectEnd { .. } => "effect_end",
        GameEvent::HazardSpawn { .. } => "hazard_spawn",
        GameEvent::PhaseChange { .. } => "phase_change",
        GameEvent::RoundState { .. } => "round_state",
        GameEvent::RoundEnd { .. } => "round_end",
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
            "tick": tick, "victim": victim, "attacker": attacker, "cause": cause_name(*cause)
        }),
        GameEvent::Respawn { id, x, y, .. } => json!({"tick": tick, "id": id, "x": x, "y": y}),
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
        GameEvent::EffectPhaseChanged { id, phase, .. } => {
            json!({"tick": tick, "id": id, "phase": format!("{phase:?}")})
        }
        GameEvent::EffectEnd { id, .. } => json!({"tick": tick, "id": id}),
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
        } => json!({
            "tick": tick, "phase": phase.as_str(), "time_left": time_left,
            "seed": world.seed.to_string()
        }),
        GameEvent::RoundEnd { .. } => json!({"tick": tick, "reason": "round_over"}),
    }
}

fn cause_name(c: DeathCause) -> &'static str {
    match c {
        DeathCause::Player(_) => "player",
        DeathCause::SelfInflicted => "self",
        DeathCause::Weather => "weather",
    }
}

/// Emit a tick's events, each to its own scope.
///
/// Events are emitted in the order the world produced them, **and that order now
/// holds across ticks as well as within a batch** — it did not while each batch
/// went to its own `tokio::spawn`. Carves are never reordered or coalesced:
/// clients apply them in `seq` order, and merging two overlapping carves into
/// one changes the resulting mask (`docs/11-map-destruction.md` §6).
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
                // Ready sockets only: see `SessionMap::ready`.
                for s in io.sockets() {
                    if sessions.is_ready(s.id) {
                        let _ = s.emit(name, &payload);
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

pub fn emit_round_end(io: &SocketIo, tick: u32, reason: &str) {
    let payload = serde_json::json!({ "tick": tick, "reason": reason });
    for s in io.sockets() {
        let _ = s.emit("round_end", &payload);
    }
}

pub fn emit_mask_checksum(io: &SocketIo, tick: u32, hash: &str) {
    let payload = serde_json::json!({ "tick": tick, "hash": hash });
    // Inline, and to every socket: a client still loading its map has nothing to
    // compare yet and ignores it, which is cheaper than tracking readiness here.
    for s in io.sockets() {
        let _ = s.emit("mask_checksum", &payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use game_core::constants::MapScale;
    use game_core::world::{CarveKind, DespawnReason, RoundPhase};

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
        assert_eq!(slots[0]["key"], "bazooka");
        assert_eq!(slots[0]["count"], 4);
        assert!(slots[1].is_null(), "empty slots are null, not omitted");
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
}
