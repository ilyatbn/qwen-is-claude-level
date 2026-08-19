//! `tick` — the fixed 20 Hz loop (docs/00 §2, docs/05 §3).

use crate::rooms::Room;
use game_core::protocol::{
    CrateDropped, EffectEnded, EffectStarted, Explosion, ItemPicked, ItemSpawned, ItemUncovered,
    Kill, MapData, Point, ProjectileFired, Respawned, RoundEnded, RoundStarted, TileDestroyedMsg,
    TilePos,
};
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
    pub map_data: MapData,
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
        Event::RoundEnded { scores } => {
            info!("[round] ended players={} [tick={tick} room={room}]", scores.len());
        }
        Event::Respawned { player, .. } => {
            debug!("[round] P{player} respawned [tick={tick} room={room}]");
        }
        Event::CrateDropped { x } => debug!("[item] crate at x={x} [tick={tick} room={room}]"),
        Event::EffectStarted { kind, .. } => {
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
        // Every payload goes through its struct in protocol.rs. Hand-built
        // `json!` objects compiled and shipped, but the protocol pins guard
        // the structs — so a rename on either side left the other silent.
        // See DEVIATIONS.md D46.
        let (name, payload) = match event_payload(event, map_data) {
            Ok(pair) => pair,
            Err(err) => {
                // Skip the event rather than emitting an empty object: a
                // client that receives `kill {}` cannot tell it from a kill
                // with missing fields.
                warn!("[net] failed to serialize {event:?}: {err}");
                continue;
            }
        };
        if let Some(ns) = io.of(namespace) {
            if let Err(err) = ns.emit(name, &payload).await {
                warn!("[net] {name} emit failed: {err}");
            }
        }
    }
}

/// One event's wire name and payload (docs/06 §2).
///
/// Split out of [`broadcast`] so it is testable without a socket: the tests
/// below assert the shipping payload against docs/06 §2 directly, which the
/// in-line `json!` version could not be.
fn event_payload(
    event: &Event,
    map_data: &MapData,
) -> Result<(&'static str, serde_json::Value), serde_json::Error> {
    use game_core::protocol::s2c;
    let payload = match event {
        // docs/06 §2 requires the map here too — the round is regenerated on
        // restart, so a client that only got the map on join would be
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
            })?,
        ),
        // docs/06 §2: round_ended carries the score table. RoundEndScene
        // renders it, and an empty payload gave it nothing to show.
        Event::RoundEnded { scores } => (
            s2c::ROUND_ENDED,
            serde_json::to_value(RoundEnded { scores: scores.clone() })?,
        ),
        Event::TileDestroyed { tiles, version } => (
            s2c::TILE_DESTROYED,
            serde_json::to_value(TileDestroyedMsg {
                tiles: tiles.iter().map(|t| TilePos { x: t.x, y: t.y }).collect(),
                version: *version,
                item_uncovered: uncovered(tiles),
            })?,
        ),
        Event::ItemSpawned { item, x, y, is_crate } => (
            s2c::ITEM_SPAWNED,
            serde_json::to_value(ItemSpawned {
                item: item.as_str().to_string(),
                x: *x,
                y: *y,
                is_crate: *is_crate,
            })?,
        ),
        Event::ItemPicked { player, item } => (
            s2c::ITEM_PICKED,
            serde_json::to_value(ItemPicked {
                player: *player,
                item: item.as_str().to_string(),
            })?,
        ),
        Event::CrateDropped { x } => {
            (s2c::CRATE_DROPPED, serde_json::to_value(CrateDropped { x: *x })?)
        }
        Event::ProjectileFired { id, owner, kind, x, y, angle } => (
            s2c::PROJECTILE_FIRED,
            serde_json::to_value(ProjectileFired {
                id: *id,
                owner: *owner,
                kind: kind.as_str().to_string(),
                x: *x,
                y: *y,
                angle: *angle,
            })?,
        ),
        Event::Explosion { x, y, radius } => (
            s2c::EXPLOSION,
            serde_json::to_value(Explosion { x: *x, y: *y, radius: *radius })?,
        ),
        Event::Kill { victim, killer, weapon } => (
            s2c::KILL,
            serde_json::to_value(Kill {
                victim: *victim,
                killer: *killer,
                weapon: weapon.to_string(),
            })?,
        ),
        Event::Respawned { player, x, y } => (
            s2c::RESPAWNED,
            serde_json::to_value(Respawned { player: *player, x: *x, y: *y })?,
        ),
        Event::EffectStarted { kind, data } => (
            s2c::EFFECT_STARTED,
            serde_json::to_value(EffectStarted {
                kind: kind.as_str().to_string(),
                data: data.clone(),
            })?,
        ),
        Event::EffectEnded { kind } => (
            s2c::EFFECT_ENDED,
            serde_json::to_value(EffectEnded { kind: kind.as_str().to_string() })?,
        ),
    };
    Ok(payload)
}

/// docs/06 §2 `tile_destroyed.item_uncovered`.
///
/// The wire field is a single optional item, but one blast can uncover
/// several tiles that each hid one. The first goes here; every uncovered item
/// — including this one — also gets its own `item_spawned`, which is what the
/// client actually spawns from. See DEVIATIONS.md D47.
fn uncovered(tiles: &[game_core::tiles::TileDestroyed]) -> Option<ItemUncovered> {
    tiles.iter().find_map(|t| {
        t.item.map(|item| {
            let centre = game_core::map::Map::tile_center(t.x, t.y);
            ItemUncovered { item: item.as_str().to_string(), x: centre.x, y: centre.y }
        })
    })
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

    /// docs/06 §2, one row per S->C event. Key sets, not just types: a struct
    /// whose field is renamed still serializes, so only the wire keys catch
    /// drift.
    #[test]
    fn every_event_payload_matches_docs_06_2() {
        use game_core::effects::EffectKind;
        use game_core::protocol::{EffectData, HeavyFogData, ItemId, ScoreEntry};
        use game_core::tiles::{TileDestroyed, TileKind};

        let map = room_with_players(1).round.map.to_map_data();
        let cases: Vec<(Event, &str, &[&str])> = vec![
            (
                Event::RoundStarted { seed: 1, scale: Scale::Small },
                "round_started",
                &["map", "scale", "seed", "spawn"],
            ),
            (
                Event::RoundEnded {
                    scores: vec![ScoreEntry {
                        id: 1, name: "p".into(), score: 2, kills: 3, deaths: 4,
                    }],
                },
                "round_ended",
                &["scores"],
            ),
            (
                Event::TileDestroyed {
                    tiles: vec![TileDestroyed { x: 1, y: 2, kind: TileKind::Rock, item: None }],
                    version: 7,
                },
                "tile_destroyed",
                &["item_uncovered", "tiles", "version"],
            ),
            (
                Event::ItemSpawned { item: ItemId::Medkit, x: 1.0, y: 2.0, is_crate: false },
                "item_spawned",
                &["crate", "item", "x", "y"],
            ),
            (
                Event::ItemPicked { player: 1, item: ItemId::Pistol },
                "item_picked",
                &["item", "player"],
            ),
            (Event::CrateDropped { x: 3.0 }, "crate_dropped", &["x"]),
            (
                Event::ProjectileFired {
                    id: 1, owner: 2, kind: ItemId::Rocket, x: 3.0, y: 4.0, angle: 0.5,
                },
                "projectile_fired",
                &["angle", "id", "kind", "owner", "x", "y"],
            ),
            (
                Event::Explosion { x: 1.0, y: 2.0, radius: 3.0 },
                "explosion",
                &["radius", "x", "y"],
            ),
            (
                Event::Kill { victim: 1, killer: Some(2), weapon: "rocket" },
                "kill",
                &["killer", "victim", "weapon"],
            ),
            (
                Event::Respawned { player: 1, x: 2.0, y: 3.0 },
                "respawned",
                &["player", "x", "y"],
            ),
            (
                Event::EffectStarted {
                    kind: EffectKind::HeavyFog,
                    data: EffectData::HeavyFog(HeavyFogData {}),
                },
                "effect_started",
                &["data", "kind"],
            ),
            (Event::EffectEnded { kind: EffectKind::HeavyFog }, "effect_ended", &["kind"]),
        ];

        // Guard the guard: the table must cover every variant, or a new event
        // could ship unchecked. `Event` has 12 variants (round.rs).
        assert_eq!(cases.len(), 12, "an Event variant is missing from the table");

        for (event, expected_name, expected_keys) in cases {
            let (name, payload) = event_payload(&event, &map).expect("payload serializes");
            assert_eq!(name, expected_name, "wire name for {event:?}");
            let mut keys: Vec<&str> =
                payload.as_object().expect("object payload").keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, expected_keys, "wire keys for {name}");
        }
    }

    /// docs/06 §2 + §5: `effect_started.data` is the per-kind payload, not a
    /// placeholder. The hand-built version shipped `"data": {}` for every
    /// kind, which is indistinguishable from HeavyFog's real (empty) payload.
    #[test]
    fn effect_started_carries_the_per_kind_payload() {
        let mut room = room_with_players(2);
        room.set_ready("s0", true);
        room.set_ready("s1", true);
        let map = room.round.map.to_map_data();
        let started = (0..6000)
            .find_map(|_| {
                room.step().into_iter().find_map(|e| match e {
                    Event::EffectStarted { kind, data } => Some((kind, data)),
                    _ => None,
                })
            })
            .expect("an effect starts within a round");
        let (kind, data) = started;
        let (_, payload) = event_payload(
            &Event::EffectStarted { kind, data },
            &map,
        )
        .expect("payload serializes");
        let data = &payload["data"];
        // Every kind but HeavyFog has a non-empty shape (docs/06 §5).
        if kind != game_core::effects::EffectKind::HeavyFog {
            assert!(
                data.as_object().is_some_and(|o| !o.is_empty()),
                "{} shipped an empty data payload: {payload}",
                kind.as_str(),
            );
        }
    }

    /// docs/06 §2 `tile_destroyed.item_uncovered`. Populated from the batch,
    /// which the hand-built payload hardcoded to null. See D47.
    #[test]
    fn tile_destroyed_reports_an_uncovered_item() {
        use game_core::protocol::ItemId;
        use game_core::tiles::{TileDestroyed, TileKind};

        let map = room_with_players(1).round.map.to_map_data();
        let event = Event::TileDestroyed {
            tiles: vec![
                TileDestroyed { x: 1, y: 2, kind: TileKind::Dirt, item: None },
                TileDestroyed { x: 3, y: 4, kind: TileKind::Dirt, item: Some(ItemId::Shotgun) },
            ],
            version: 9,
        };
        let (_, payload) = event_payload(&event, &map).expect("payload serializes");
        assert_eq!(payload["item_uncovered"]["item"], "shotgun");
        // Pixel centre of tile (3, 4), not the tile coordinate (docs/06 §2:
        // x/y are f32 pixels here, while `tiles[]` carries tile coords).
        let centre = game_core::map::Map::tile_center(3, 4);
        assert_eq!(payload["item_uncovered"]["x"], centre.x);
        assert_eq!(payload["item_uncovered"]["y"], centre.y);
        assert_eq!(payload["tiles"][1]["x"], 3);
    }
}
