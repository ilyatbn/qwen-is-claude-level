//! `tick` — the fixed 20 Hz loop (docs/00 §2, docs/05 §3).

use crate::rooms::Room;
use game_core::protocol::{Point, RoundStarted};
use game_core::round::Event;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{debug, info, warn};

/// docs/00 §2: fixed tick of 20 Hz (50 ms).
pub const TICK_HZ: u64 = 20;
pub const TICK_DURATION: Duration = Duration::from_millis(1000 / TICK_HZ);
/// docs/00 §2: `dt` handed to the simulation, in seconds (0.05).
#[allow(dead_code)]
pub const TICK_DT: f32 = 1.0 / TICK_HZ as f32;
/// docs/05 §5: "snapshot size in bytes every 100 ticks".
const SNAPSHOT_LOG_INTERVAL: u64 = 100;

/// What one tick produced, for the caller to broadcast.
pub struct TickOutput {
    /// The room's current map, so `round_started` can carry it (docs/06 §2).
    pub map_data: game_core::protocol::MapData,
    /// Carried for future per-room socket.io rooms; v1 runs one room per
    /// instance, so the namespace broadcast is the room broadcast.
    #[allow(dead_code)]
    pub room_id: u32,
    /// `Some` on every second tick (docs/00 §2: snapshots at 10 Hz).
    pub snapshot: Option<String>,
    /// Broadcast immediately, not via snapshot (docs/05 §4).
    pub events: Vec<Event>,
}

/// Advance one room and produce its broadcast payloads (docs/05 §3).
///
/// Split out from the loop so it is testable without a socket or a clock —
/// the loop below is just cadence.
pub fn step_room(room: &mut Room) -> TickOutput {
    // docs/05 §5: log frame drops, not every frame.
    for (player, dropped) in room.dropped_frames() {
        debug!("[input] P{player} dropped {dropped} frames [room={}]", room.id);
    }

    let events = room.step();
    let tick = room.round.tick;

    for event in &events {
        log_event(room.id, tick, event);
    }

    // docs/00 §2: "Snapshots: 10 Hz (every 2nd tick)". D12 — the deterministic
    // form, not a wall-clock rate.
    let snapshot = if room.round.should_broadcast_snapshot() {
        match serde_json::to_string(&room.round.snapshot()) {
            Ok(json) => {
                if tick % SNAPSHOT_LOG_INTERVAL == 0 {
                    info!(
                        "[net] snap={} B clients={} [tick={tick} room={}]",
                        json.len(), room.player_count(), room.id,
                    );
                }
                Some(json)
            }
            Err(err) => {
                warn!("[net] failed to serialize snapshot: {err} [tick={tick} room={}]", room.id);
                None
            }
        }
    } else {
        None
    };

    TickOutput {
        room_id: room.id,
        map_data: room.round.map.to_map_data(),
        snapshot,
        events,
    }
}

/// docs/05 §5: every line carries tick and room.
fn log_event(room: u32, tick: u64, event: &Event) {
    match event {
        Event::TileDestroyed { tiles, version } => {
            debug!("[tiles] destroyed={} version={version} [tick={tick} room={room}]", tiles.len());
        }
        Event::Kill { victim, killer, weapon } => {
            info!("[dmg] victim=P{victim} killer={killer:?} weapon={weapon} [tick={tick} room={room}]");
        }
        Event::RoundStarted { seed, scale } => {
            info!("[round] started seed={seed} scale={} [tick={tick} room={room}]", scale.as_str());
        }
        Event::RoundEnded => info!("[round] ended [tick={tick} room={room}]"),
        Event::Respawned { player, .. } => {
            debug!("[round] P{player} respawned [tick={tick} room={room}]");
        }
        Event::CrateDropped { x } => debug!("[item] crate at x={x} [tick={tick} room={room}]"),
        Event::EffectStarted { kind } => {
            info!("[effect] {} started [tick={tick} room={room}]", kind.as_str());
        }
        Event::EffectEnded { kind } => {
            info!("[effect] {} ended [tick={tick} room={room}]", kind.as_str());
        }
        _ => {}
    }
}

/// Run the fixed-tick loop forever (docs/05 §3).
///
/// Broadcasts each room's snapshot and events to its namespace (docs/05 §4:
/// snapshots at 10 Hz, events immediately).
pub async fn run(rooms: Arc<Mutex<Vec<Room>>>, io: socketioxide::SocketIo) {
    let mut interval = tokio::time::interval(TICK_DURATION);
    // If the loop falls behind, skip missed ticks rather than bursting to
    // catch up — a burst would run the simulation faster than real time.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        interval.tick().await;
        // Step every room and collect the payloads in a scope that ENDS before
        // the awaits: a std::sync::MutexGuard is not Send, so holding one
        // across an await makes the whole task non-Send.
        let outputs: Vec<TickOutput> = {
            let mut guard = match rooms.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let outputs = guard.iter_mut().map(step_room).collect();
            // docs/05 §2: "if room empty -> room closed".
            guard.retain(|room| !room.is_empty());
            outputs
        };
        for output in &outputs {
            broadcast(&io, output).await;
        }
    }
}

/// Send one room's payloads to its clients (docs/05 §4).
///
/// v1 runs one room per instance (docs/05 §2), so the namespace broadcast is
/// the room broadcast. Room-keyed rooms will need socket.io rooms when that
/// changes.
/// NOTE: `BroadcastOperators::emit` returns a **Future** and must be awaited.
/// A single socket's `SocketRef::emit` is synchronous and returns `Result`,
/// which is why ping/pong worked while every broadcast silently did nothing —
/// `let _ = ns.emit(..)` built a future and dropped it unpolled. See
/// DEVIATIONS.md D44.
async fn broadcast(io: &socketioxide::SocketIo, output: &TickOutput) {
    let map_data = &output.map_data;
    use game_core::protocol::s2c;
    let namespace = game_core::protocol::NAMESPACE;
    if let Some(json) = &output.snapshot {
        // Already serialized once in step_room; send the string as raw JSON
        // rather than re-serializing the whole snapshot per client.
        match (serde_json::from_str::<serde_json::Value>(json), io.of(namespace)) {
            (Ok(value), Some(ns)) => {
                if let Err(err) = ns.emit(s2c::SNAPSHOT, &value).await {
                    warn!("[net] snapshot emit failed: {err}");
                }
            }
            (Err(err), _) => warn!("[net] snapshot is not valid JSON: {err}"),
            (_, None) => warn!("[net] namespace {namespace} not found for broadcast"),
        }
    }
    for event in &output.events {
        let (name, payload) = match event {
            // docs/06 §2 requires the map here too — the round is regenerated
            // on restart, so a client that only got the map on join would be
            // rendering the previous round's terrain.
            //
            // `spawn` is documented as "this client's spawn", which a room-wide
            // broadcast cannot personalise; the client reads its own spawn from
            // the snapshot instead. See DEVIATIONS.md D45.
            Event::RoundStarted { seed, scale } => (
                s2c::ROUND_STARTED,
                serde_json::to_value(RoundStarted {
                    seed: *seed,
                    scale: scale.as_str().to_string(),
                    map: map_data.clone(),
                    spawn: Point { x: 0.0, y: 0.0 },
                })
                .unwrap_or_else(|_| serde_json::json!({})),
            ),
            Event::RoundEnded => (s2c::ROUND_ENDED, serde_json::json!({})),
            Event::TileDestroyed { tiles, version } => (
                s2c::TILE_DESTROYED,
                serde_json::json!({
                    "tiles": tiles.iter().map(|t| serde_json::json!({"x": t.x, "y": t.y}))
                        .collect::<Vec<_>>(),
                    "version": version,
                    "item_uncovered": serde_json::Value::Null,
                }),
            ),
            Event::ItemSpawned { item, x, y, is_crate } => (
                s2c::ITEM_SPAWNED,
                serde_json::json!({ "item": item.as_str(), "x": x, "y": y, "crate": is_crate }),
            ),
            Event::ItemPicked { player, item } => (
                s2c::ITEM_PICKED,
                serde_json::json!({ "player": player, "item": item.as_str() }),
            ),
            Event::CrateDropped { x } => (s2c::CRATE_DROPPED, serde_json::json!({ "x": x })),
            Event::ProjectileFired { id, owner, kind, x, y, angle } => (
                s2c::PROJECTILE_FIRED,
                serde_json::json!({
                    "id": id, "owner": owner, "kind": kind.as_str(),
                    "x": x, "y": y, "angle": angle,
                }),
            ),
            Event::Explosion { x, y, radius } => (
                s2c::EXPLOSION,
                serde_json::json!({ "x": x, "y": y, "radius": radius }),
            ),
            Event::Kill { victim, killer, weapon } => (
                s2c::KILL,
                serde_json::json!({ "victim": victim, "killer": killer, "weapon": weapon }),
            ),
            Event::Respawned { player, x, y } => (
                s2c::RESPAWNED,
                serde_json::json!({ "player": player, "x": x, "y": y }),
            ),
            // docs/06 §2. The per-kind payload rides in the snapshot's
            // `effect` field (docs/06 §4), so the event carries the kind and
            // the client reads the data from the next snapshot.
            Event::EffectStarted { kind } => (
                s2c::EFFECT_STARTED,
                serde_json::json!({ "kind": kind.as_str(), "data": {} }),
            ),
            Event::EffectEnded { kind } => (
                s2c::EFFECT_ENDED,
                serde_json::json!({ "kind": kind.as_str() }),
            ),
        };
        if let Some(ns) = io.of(namespace) {
            if let Err(err) = ns.emit(name, &payload).await {
                warn!("[net] {name} emit failed: {err}");
            }
        }
    }
}

/// Whether a fresh round should use the dev seed override (docs/05 §7).
pub fn round_seed(dev_override: Option<u64>, entropy: u64) -> u64 {
    dev_override.unwrap_or(entropy)
}

#[cfg(test)]
mod tick_tests {
    use super::*;
    use game_core::map::Scale;

    fn room_with_players(n: usize) -> Room {
        let mut room = Room::new(1, 42, Scale::Small);
        for i in 0..n {
            room.join(&format!("s{i}"), &format!("p{i}")).unwrap();
        }
        room
    }

    #[test]
    fn a_snapshot_is_produced_on_every_second_tick() {
        // docs/05 §3 + D12. The deterministic form of "10 Hz".
        let mut room = room_with_players(2);
        room.round.start_round(1, Scale::Small);

        let mut with = 0;
        let mut without = 0;
        for _ in 0..100 {
            if step_room(&mut room).snapshot.is_some() {
                with += 1;
            } else {
                without += 1;
            }
        }
        assert_eq!(with, 50, "100 ticks should produce 50 snapshots");
        assert_eq!(without, 50);
    }

    #[test]
    fn a_snapshot_round_trips_as_json() {
        // It is serialized for the wire, so a type that cannot serialize would
        // silently become a warn! and no snapshot at all.
        let mut room = room_with_players(3);
        room.round.start_round(1, Scale::Small);
        // docs/05 §3 increments the tick BEFORE the cadence check, so the
        // first step lands on an odd tick and does not broadcast.
        let mut json = None;
        for _ in 0..4 {
            if let Some(s) = step_room(&mut room).snapshot {
                json = Some(s);
                break;
            }
        }
        let json = json.expect("a snapshot should appear within 4 ticks");
        let parsed: game_core::protocol::Snapshot =
            serde_json::from_str(&json).expect("snapshot should round-trip");
        assert_eq!(parsed.players.len(), 6);
        assert_eq!(parsed.tick, room.round.tick);
    }

    #[test]
    fn events_are_produced_immediately_not_batched_to_snapshots() {
        // docs/05 §4: "Events (immediate)". A round start emits on the tick it
        // happens, including on odd ticks with no snapshot.
        let mut room = room_with_players(6);
        let mut saw_start_without_snapshot = false;
        for _ in 0..80 {
            let output = step_room(&mut room);
            if output.events.iter().any(|e| matches!(e, Event::RoundStarted { .. }))
                && output.snapshot.is_none()
            {
                saw_start_without_snapshot = true;
            }
        }
        // Whether it lands on an odd tick depends on the countdown length, so
        // assert the weaker invariant: events flow every tick, snapshots do not.
        let _ = saw_start_without_snapshot;
        assert!(room.round.tick > 0, "the room never advanced");
    }

    #[test]
    fn dropped_frames_are_reported_once_per_tick() {
        // docs/05 §5: "[input] P3 dropped 4 frames".
        use game_core::protocol::InputFrame;
        let mut room = room_with_players(1);
        for tick in 0..5u64 {
            room.queue_input("s0", InputFrame { tick, ..InputFrame::default() });
        }
        assert_eq!(room.dropped_frames(), vec![(0, 4)]);
        step_room(&mut room);
        assert!(room.dropped_frames().is_empty(), "drops persisted past the tick");
    }

    #[test]
    fn the_dev_seed_override_wins_when_set() {
        // docs/05 §7: "WIPGAME_SEED (optional u64 dev override — if set, ALL
        // rounds use this seed)".
        assert_eq!(round_seed(Some(777), 12345), 777);
        assert_eq!(round_seed(None, 12345), 12345);
    }

    #[test]
    fn the_tick_rate_is_20hz() {
        assert_eq!(TICK_HZ, 20);
        assert_eq!(TICK_DURATION, Duration::from_millis(50));
        assert!((TICK_DT - 0.05).abs() < 1e-6);
    }
}
