//! `protocol` — serde types shared with the client (docs/06-protocol.md).
//!
//! The TypeScript mirror lives in `client/src/protocol.ts`. Per docs/06 intro:
//! **when a task changes a message, it updates BOTH files.**
//!
//! Conventions (docs/06 intro):
//! - `u64` ticks, `f32` px/seconds, player ids are `u8` (0..=5).
//! - Positions in px, map top-left = (0,0), y down.
//! - Angles in radians, 0 = right, CCW positive.

use serde::{Deserialize, Serialize};

/// docs/06 §7. Server sends it in `joined`; client warns on mismatch.
pub const PROTOCOL_VERSION: u8 = 1;

/// socket.io namespace (docs/06 intro).
pub const NAMESPACE: &str = "/game";

// ---------------------------------------------------------------------------
// §3 — InputFrame (client -> server, 20 Hz)
// ---------------------------------------------------------------------------

/// docs/06 §3 / docs/03 §3.
///
/// `jump` and `use_slot` are edge-triggered server-side; the client sends the
/// held/pressed state. `use_slot` is `None` except on the tick it is pressed.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct InputFrame {
    pub tick: u64,
    pub left: bool,
    pub right: bool,
    pub up: bool,
    pub down: bool,
    pub jump: bool,
    /// Radians from player center to mouse, CCW positive.
    pub aim: f32,
    pub fire: bool,
    pub use_slot: Option<u8>,
}

// ---------------------------------------------------------------------------
// §6 — MapData (sent on join + round_started)
// ---------------------------------------------------------------------------

/// Tile kind byte encoding used by [`MapData::tiles`] (docs/06 §6).
pub const TILE_AIR: u8 = 0;
pub const TILE_GRASS: u8 = 1;
pub const TILE_DIRT: u8 = 2;
pub const TILE_STONE: u8 = 3;
pub const TILE_ROCK: u8 = 4;

/// docs/06 §6.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MapData {
    pub seed: u64,
    pub scale: String,
    /// Tiles, not pixels.
    pub width: u32,
    pub height: u32,
    /// base64 of a `width*height` u8 array, row-major, y=0 top.
    /// 0=AIR 1=GRASS 2=DIRT 3=STONE 4=ROCK.
    ///
    /// Requires the `base64` crate, which T0.1's dependency list omits —
    /// see DEVIATIONS.md D7.
    pub tiles: String,
    pub decor: Vec<DecorData>,
    /// Tile coords (docs/01 §4), NOT pixels — see DEVIATIONS.md D9.
    pub spawns: Vec<TilePos>,
}

/// An entry of [`MapData::decor`] (docs/06 §6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecorData {
    pub x: u32,
    pub y: u32,
    pub kind: String,
}

/// A tile coordinate pair (docs/06 §6 `spawns`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TilePos {
    pub x: u32,
    pub y: u32,
}

/// A pixel coordinate pair (`round_started.spawn`, `respawned`, ...).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

// ---------------------------------------------------------------------------
// §4 — Snapshot (server -> client, 10 Hz)
// ---------------------------------------------------------------------------

/// docs/06 §4.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub tick: u64,
    /// Elapsed round time, seconds.
    pub round_time_s: f32,
    /// 0..1 (docs/02 §1). 0 = full day, 1 = full night.
    pub day_phase: f32,
    pub fog: FogState,
    pub effect: Option<ActiveEffectSnap>,
    pub map_version: u64,
    /// Missing players: `alive=false`, `x=y=0`.
    pub players: Vec<PlayerSnap>,
    pub items: Vec<GroundItemSnap>,
    pub projectiles: Vec<ProjectileSnap>,
}

/// docs/06 §4 (`fog`).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct FogState {
    pub active: bool,
    pub remaining_s: f32,
}

/// docs/06 §4 (`effect`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveEffectSnap {
    pub kind: String,
    pub remaining_s: f32,
    pub data: EffectData,
}

/// docs/06 §4 (`PlayerSnap`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlayerSnap {
    pub id: u8,
    pub name: String,
    pub skin: u8,
    pub x: f32,
    pub y: f32,
    pub facing: f32,
    pub health: f32,
    pub max_health: f32,
    pub shield_remaining: f32,
    pub jetpack_fuel: f32,
    pub fov: f32,
    pub alive: bool,
    pub respawn_in_s: f32,
    pub score: i32,
    /// 6 slots (docs/04 §5).
    pub slots: Vec<Option<String>>,
    pub selected: u8,
    /// 6 entries, parallel to `slots`.
    pub ammo: Vec<u8>,
}

/// docs/06 §4 (`items`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroundItemSnap {
    pub item: String,
    pub x: f32,
    pub y: f32,
    #[serde(rename = "crate")]
    pub is_crate: bool,
}

/// docs/06 §4 (`projectiles`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectileSnap {
    pub id: u32,
    pub kind: String,
    pub x: f32,
    pub y: f32,
}

// ---------------------------------------------------------------------------
// §5 — EffectData (per kind)
// ---------------------------------------------------------------------------

/// docs/06 §5. Tagged by the owning message's `kind` field, so the payload
/// itself is an untagged union of the four shapes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EffectData {
    ToxicRain { spots: Vec<ToxicSpot> },
    MeteorShower { targets: Vec<MeteorTarget> },
    LavaBurst { site: Point, phase: String },
    HeavyFog {},
}

/// docs/06 §5 (`ToxicRain.spots`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ToxicSpot {
    pub x: f32,
    pub y: f32,
    pub remaining_s: f32,
}

/// docs/06 §5 (`MeteorShower.targets`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MeteorTarget {
    pub x: f32,
    pub y: f32,
    pub fired: bool,
}

// ---------------------------------------------------------------------------
// §1 — Client -> Server payloads
// ---------------------------------------------------------------------------

/// `join_room` (docs/06 §1). Name 1–12 chars, trimmed; server sanitizes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JoinRoom {
    pub name: String,
}

/// `select_skin` (docs/06 §1). Lobby only.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SelectSkin {
    pub skin: u8,
}

/// `use_slot` (docs/06 §1). The UI path; also present inside [`InputFrame`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct UseSlot {
    pub slot: u8,
}

/// `set_log_level` (docs/06 §1). "info" or "debug"; logged as a warning.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SetLogLevel {
    pub level: String,
}

/// `ready`, `restart`, `quit`, `ping` (docs/06 §1) carry `{}`.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Empty {}

// ---------------------------------------------------------------------------
// §2 — Server -> Client payloads
// ---------------------------------------------------------------------------

/// docs/06 §2 (`LobbyPlayer`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LobbyPlayer {
    pub id: u8,
    pub name: String,
    pub skin: u8,
    pub ready: bool,
}

/// `joined` (docs/06 §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Joined {
    pub id: u8,
    pub room: u32,
    pub seed: u64,
    pub scale: String,
    pub map: MapData,
    pub players: Vec<LobbyPlayer>,
    /// docs/06 §7 — server sends the version so the client can warn.
    pub protocol_version: u8,
}

/// `player_joined` (docs/06 §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlayerJoined {
    pub id: u8,
    pub name: String,
    pub skin: u8,
}

/// `player_left` (docs/06 §2).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PlayerLeft {
    pub id: u8,
}

/// `lobby_state` (docs/06 §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LobbyState {
    pub players: Vec<LobbyPlayer>,
    /// 6 entries.
    pub ready: Vec<bool>,
    pub countdown_in_s: Option<f32>,
}

/// `round_started` (docs/06 §2). The map is re-sent each round.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundStarted {
    pub seed: u64,
    pub scale: String,
    pub map: MapData,
    /// This client's spawn, in pixels.
    pub spawn: Point,
}

/// `tile_destroyed` (docs/06 §2). Broadcast immediately, not via snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TileDestroyedMsg {
    pub tiles: Vec<TilePos>,
    pub version: u64,
    pub item_uncovered: Option<ItemUncovered>,
}

/// docs/06 §2 (`tile_destroyed.item_uncovered`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ItemUncovered {
    pub item: String,
    pub x: f32,
    pub y: f32,
}

/// `item_spawned` (docs/06 §2). Sources A–D.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ItemSpawned {
    pub item: String,
    pub x: f32,
    pub y: f32,
    #[serde(rename = "crate")]
    pub is_crate: bool,
}

/// `item_picked` (docs/06 §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ItemPicked {
    pub player: u8,
    pub item: String,
}

/// `crate_dropped` (docs/06 §2). Crate starts falling; client animates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CrateDropped {
    pub x: f32,
}

/// `projectile_fired` (docs/06 §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectileFired {
    pub id: u32,
    pub owner: u8,
    pub kind: String,
    pub x: f32,
    pub y: f32,
    pub angle: f32,
}

/// `explosion` (docs/06 §2). Visual only.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Explosion {
    pub x: f32,
    pub y: f32,
    pub radius: f32,
}

/// `kill` (docs/06 §2). `killer` null = weather/self.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Kill {
    pub victim: u8,
    pub killer: Option<u8>,
    pub weapon: String,
}

/// `respawned` (docs/06 §2).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Respawned {
    pub player: u8,
    pub x: f32,
    pub y: f32,
}

/// `effect_started` (docs/06 §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EffectStarted {
    pub kind: String,
    pub data: EffectData,
}

/// `effect_ended` (docs/06 §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EffectEnded {
    pub kind: String,
}

/// An entry of [`RoundEnded::scores`] (docs/06 §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoreEntry {
    pub id: u8,
    pub name: String,
    pub score: i32,
    pub kills: u32,
    pub deaths: u32,
}

/// `round_ended` (docs/06 §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundEnded {
    pub scores: Vec<ScoreEntry>,
}

/// `error` (docs/06 §2). Codes: `room_full`, `bad_name`, `not_in_room`, ...
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorMsg {
    pub code: String,
    pub msg: String,
}

// ---------------------------------------------------------------------------
// Event names (docs/06 §1, §2) — one place, so Rust and TS cannot drift.
// ---------------------------------------------------------------------------

/// Client -> server event names (docs/06 §1).
pub mod c2s {
    pub const JOIN_ROOM: &str = "join_room";
    pub const READY: &str = "ready";
    pub const SELECT_SKIN: &str = "select_skin";
    pub const INPUT: &str = "input";
    pub const USE_SLOT: &str = "use_slot";
    pub const RESTART: &str = "restart";
    pub const QUIT: &str = "quit";
    pub const SET_LOG_LEVEL: &str = "set_log_level";
    pub const PING: &str = "ping";
}

/// Server -> client event names (docs/06 §2).
pub mod s2c {
    pub const JOINED: &str = "joined";
    pub const PLAYER_JOINED: &str = "player_joined";
    pub const PLAYER_LEFT: &str = "player_left";
    pub const LOBBY_STATE: &str = "lobby_state";
    pub const ROUND_STARTED: &str = "round_started";
    pub const SNAPSHOT: &str = "snapshot";
    pub const TILE_DESTROYED: &str = "tile_destroyed";
    pub const ITEM_SPAWNED: &str = "item_spawned";
    pub const ITEM_PICKED: &str = "item_picked";
    pub const CRATE_DROPPED: &str = "crate_dropped";
    pub const PROJECTILE_FIRED: &str = "projectile_fired";
    pub const EXPLOSION: &str = "explosion";
    pub const KILL: &str = "kill";
    pub const RESPAWNED: &str = "respawned";
    pub const EFFECT_STARTED: &str = "effect_started";
    pub const EFFECT_ENDED: &str = "effect_ended";
    pub const ROUND_ENDED: &str = "round_ended";
    pub const PONG: &str = "pong";
    pub const ERROR: &str = "error";
}

// ---------------------------------------------------------------------------
// Tests — field names are checked against docs/06 verbatim (T0.2 Acceptance:
// "field names identical to the doc (spot-check 3 types)").
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Field names of a JSON object, sorted. `serde_json::Value` stores keys
    /// in a `BTreeMap`, so order is alphabetical, not declaration order —
    /// JSON objects are unordered, only the NAMES are part of the contract.
    fn field_names(v: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = v
            .as_object()
            .expect("expected a JSON object")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    /// Sort an expected name list so it can be compared to [`field_names`].
    fn sorted(names: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        v.sort();
        v
    }

    #[test]
    fn protocol_version_is_1() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }

    /// Spot-check 1 of 3 — docs/06 §3.
    fn sample_input_frame() -> InputFrame {
        InputFrame {
            tick: 7,
            left: true,
            right: false,
            up: false,
            down: false,
            jump: true,
            aim: 1.5,
            fire: true,
            use_slot: Some(2),
        }
    }

    #[test]
    fn input_frame_field_names_match_doc() {
        let v = serde_json::to_value(sample_input_frame()).unwrap();
        let got = field_names(&v);
        // docs/06 §3, verbatim.
        assert_eq!(got, sorted(&[
            "tick", "left", "right", "up", "down", "jump", "aim", "fire", "use_slot",
        ]));
        // `use_slot` is null except on the tick it is pressed.
        assert_eq!(v["use_slot"], json!(2));
        let released = InputFrame {
            use_slot: None,
            ..sample_input_frame()
        };
        assert_eq!(serde_json::to_value(released).unwrap()["use_slot"], json!(null));
    }

    /// Spot-check 2 of 3 — docs/06 §4 `PlayerSnap`.
    #[test]
    fn player_snap_field_names_match_doc() {
        let snap = PlayerSnap {
            id: 3,
            name: "p3".into(),
            skin: 1,
            x: 10.0,
            y: 20.0,
            facing: 0.0,
            health: 100.0,
            max_health: 100.0,
            shield_remaining: 0.0,
            jetpack_fuel: 5.0,
            fov: 420.0,
            alive: true,
            respawn_in_s: 0.0,
            score: 0,
            slots: vec![None; 6],
            selected: 0,
            ammo: vec![0; 6],
        };
        let v = serde_json::to_value(snap).unwrap();
        let got = field_names(&v);
        // docs/06 §4, verbatim.
        assert_eq!(got, sorted(&[
            "id",
            "name",
            "skin",
            "x",
            "y",
            "facing",
            "health",
            "max_health",
            "shield_remaining",
            "jetpack_fuel",
            "fov",
            "alive",
            "respawn_in_s",
            "score",
            "slots",
            "selected",
            "ammo",
        ]));
        assert_eq!(v["slots"].as_array().unwrap().len(), 6);
        assert_eq!(v["ammo"].as_array().unwrap().len(), 6);
    }

    /// Spot-check 3 of 3 — docs/06 §6 `MapData`.
    #[test]
    fn map_data_field_names_match_doc() {
        let map = MapData {
            seed: 42,
            scale: "small".into(),
            width: 96,
            height: 64,
            tiles: "AAEC".into(),
            decor: vec![DecorData {
                x: 1,
                y: 2,
                kind: "bush".into(),
            }],
            spawns: vec![TilePos { x: 5, y: 6 }],
        };
        let v = serde_json::to_value(map).unwrap();
        let got = field_names(&v);
        // docs/06 §6, verbatim.
        assert_eq!(got, sorted(&[
            "seed", "scale", "width", "height", "tiles", "decor", "spawns",
        ]));
        assert_eq!(field_names(&v["decor"][0]), sorted(&["x", "y", "kind"]));
        assert_eq!(field_names(&v["spawns"][0]), sorted(&["x", "y"]));
    }

    /// `crate` is a Rust keyword, so the field is named `is_crate` and renamed
    /// on the wire. Guard that the wire name is the one docs/06 §2/§4 specify.
    #[test]
    fn crate_flag_serializes_as_crate() {
        let v = serde_json::to_value(GroundItemSnap {
            item: "medkit".into(),
            x: 1.0,
            y: 2.0,
            is_crate: true,
        })
        .unwrap();
        assert_eq!(field_names(&v), sorted(&["item", "x", "y", "crate"]));
        assert_eq!(v["crate"], json!(true));

        let v = serde_json::to_value(ItemSpawned {
            item: "rocket".into(),
            x: 1.0,
            y: 2.0,
            is_crate: false,
        })
        .unwrap();
        assert_eq!(v["crate"], json!(false));
    }

    #[test]
    fn snapshot_round_trips() {
        let snap = Snapshot {
            tick: 100,
            round_time_s: 5.0,
            day_phase: 0.0,
            fog: FogState {
                active: false,
                remaining_s: 0.0,
            },
            effect: Some(ActiveEffectSnap {
                kind: "toxic_rain".into(),
                remaining_s: 3.5,
                data: EffectData::ToxicRain {
                    spots: vec![ToxicSpot {
                        x: 100.0,
                        y: 200.0,
                        remaining_s: 2.0,
                    }],
                },
            }),
            map_version: 3,
            players: vec![],
            items: vec![],
            projectiles: vec![],
        };
        let text = serde_json::to_string(&snap).unwrap();
        let back: Snapshot = serde_json::from_str(&text).unwrap();
        assert_eq!(snap, back);

        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let got = field_names(&v);
        // docs/06 §4, verbatim.
        assert_eq!(got, sorted(&[
            "tick",
            "round_time_s",
            "day_phase",
            "fog",
            "effect",
            "map_version",
            "players",
            "items",
            "projectiles",
        ]));
    }

    #[test]
    fn effect_data_shapes_match_doc() {
        // docs/06 §5 — four shapes.
        let toxic = serde_json::to_value(EffectData::ToxicRain {
            spots: vec![ToxicSpot {
                x: 1.0,
                y: 2.0,
                remaining_s: 3.0,
            }],
        })
        .unwrap();
        assert_eq!(field_names(&toxic), sorted(&["spots"]));
        assert_eq!(
            field_names(&toxic["spots"][0]),
            sorted(&["x", "y", "remaining_s"])
        );

        let meteor = serde_json::to_value(EffectData::MeteorShower {
            targets: vec![MeteorTarget {
                x: 1.0,
                y: 2.0,
                fired: false,
            }],
        })
        .unwrap();
        assert_eq!(field_names(&meteor), sorted(&["targets"]));
        assert_eq!(
            field_names(&meteor["targets"][0]),
            sorted(&["x", "y", "fired"])
        );

        let lava = serde_json::to_value(EffectData::LavaBurst {
            site: Point { x: 1.0, y: 2.0 },
            phase: "spew".into(),
        })
        .unwrap();
        assert_eq!(field_names(&lava), sorted(&["site", "phase"]));

        let fog = serde_json::to_value(EffectData::HeavyFog {}).unwrap();
        assert!(field_names(&fog).is_empty());
    }

    #[test]
    fn kill_killer_is_nullable() {
        // docs/06 §2: "killer null = weather/self".
        let v = serde_json::to_value(Kill {
            victim: 1,
            killer: None,
            weapon: "lava".into(),
        })
        .unwrap();
        assert_eq!(v["killer"], json!(null));
        assert_eq!(field_names(&v), sorted(&["victim", "killer", "weapon"]));
    }

    #[test]
    fn tile_kind_encoding_matches_doc() {
        // docs/06 §6: 0=AIR 1=GRASS 2=DIRT 3=STONE 4=ROCK
        assert_eq!(
            [TILE_AIR, TILE_GRASS, TILE_DIRT, TILE_STONE, TILE_ROCK],
            [0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn namespace_is_game() {
        assert_eq!(NAMESPACE, "/game");
    }
}
