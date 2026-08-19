/**
 * TypeScript mirror of `server/game-core/src/protocol.rs` (docs/06-protocol.md).
 *
 * Per docs/06 intro: **when a task changes a message, it updates BOTH files.**
 *
 * Conventions (docs/06 intro):
 * - ticks are u64, px/seconds are f32, player ids are u8 (0..=5)
 * - positions in px, map top-left = (0,0), y down
 * - angles in radians, 0 = right, CCW positive
 *
 * Rust `Option<T>` serialises to `T | null`, so optional fields are modelled
 * as `| null` rather than `?:`.
 */

/** docs/06 §7. Server sends it in `joined`; client warns on mismatch. */
export const PROTOCOL_VERSION = 1;

/** socket.io namespace (docs/06 intro). */
export const NAMESPACE = '/game';

/**
 * A fixed-length 6-tuple, mirroring the `[T; 6]` arrays in protocol.rs.
 *
 * docs/06 §4 writes `players: [PlayerSnap; 6]`, `slots: (string|null)[6]`,
 * `ammo: number[6]`, and §2 writes `ready: [bool; 6]`. A tuple type enforces
 * that cardinality; a plain array would not.
 */
export type Six<T> = [T, T, T, T, T, T];

// ---------------------------------------------------------------------------
// §3 — InputFrame (client -> server, 20 Hz)
// ---------------------------------------------------------------------------

/** docs/06 §3 / docs/03 §3. */
export interface InputFrame {
  tick: number;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  /** Radians from player center to mouse, CCW positive. */
  aim: number;
  fire: boolean;
  /** null except on the tick it is pressed. */
  use_slot: number | null;
}

// ---------------------------------------------------------------------------
// §6 — MapData (sent on join + round_started)
// ---------------------------------------------------------------------------

/** Tile kind byte encoding used by `MapData.tiles` (docs/06 §6). */
export const TILE_AIR = 0;
export const TILE_GRASS = 1;
export const TILE_DIRT = 2;
export const TILE_STONE = 3;
export const TILE_ROCK = 4;

/** Tile kind names, indexed by the byte encoding above. */
export const TILE_KINDS = ['AIR', 'GRASS', 'DIRT', 'STONE', 'ROCK'] as const;
export type TileKind = (typeof TILE_KINDS)[number];

/** docs/06 §6. */
export interface MapData {
  seed: number;
  scale: string;
  /** Tiles, not pixels. */
  width: number;
  height: number;
  /** base64 of a width*height u8 array, row-major, y=0 top. */
  tiles: string;
  decor: DecorData[];
  /** Tile coords (docs/01 §4), NOT pixels — see DEVIATIONS.md D9. */
  spawns: TilePos[];
}

/** docs/06 §6 (`decor`). */
export interface DecorData {
  x: number;
  y: number;
  kind: string;
}

/** A tile coordinate pair (docs/06 §6 `spawns`). */
export interface TilePos {
  x: number;
  y: number;
}

/** A pixel coordinate pair (`round_started.spawn`, ...). */
export interface Point {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// §4 — Snapshot (server -> client, 10 Hz)
// ---------------------------------------------------------------------------

/** docs/06 §4. */
export interface Snapshot {
  tick: number;
  /** Elapsed round time, seconds. */
  round_time_s: number;
  /** 0..1 (docs/02 §1). 0 = full day, 1 = full night. */
  day_phase: number;
  fog: FogState;
  effect: ActiveEffectSnap | null;
  map_version: number;
  /** docs/06 §4: always 6 — missing players carry alive=false, x=y=0. */
  players: Six<PlayerSnap>;
  items: GroundItemSnap[];
  projectiles: ProjectileSnap[];
}

/** docs/06 §4 (`fog`). */
export interface FogState {
  active: boolean;
  remaining_s: number;
}

/** docs/06 §4 (`effect`). */
export interface ActiveEffectSnap {
  kind: string;
  remaining_s: number;
  data: EffectData;
}

/** docs/06 §4 (`PlayerSnap`). */
export interface PlayerSnap {
  id: number;
  name: string;
  skin: number;
  x: number;
  y: number;
  facing: number;
  health: number;
  max_health: number;
  shield_remaining: number;
  jetpack_fuel: number;
  fov: number;
  alive: boolean;
  respawn_in_s: number;
  score: number;
  /** docs/06 §4: `slots: (string|null)[6]` — 6 slots (docs/04 §5). */
  slots: Six<string | null>;
  selected: number;
  /** docs/06 §4: `ammo: number[6]` — parallel to `slots`. */
  ammo: Six<number>;
}

/** docs/06 §4 (`items`). */
export interface GroundItemSnap {
  item: string;
  x: number;
  y: number;
  crate: boolean;
}

/** docs/06 §4 (`projectiles`). */
export interface ProjectileSnap {
  id: number;
  kind: string;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// §5 — EffectData (per kind)
// ---------------------------------------------------------------------------

/** docs/06 §5 (`ToxicRain.spots`). */
export interface ToxicSpot {
  x: number;
  y: number;
  remaining_s: number;
}

/** docs/06 §5 (`MeteorShower.targets`). */
export interface MeteorTarget {
  x: number;
  y: number;
  fired: boolean;
}

/** docs/06 §5 (`ToxicRain`). */
export interface ToxicRainData {
  spots: ToxicSpot[];
}

/** docs/06 §5 (`MeteorShower`). */
export interface MeteorShowerData {
  targets: MeteorTarget[];
}

/** docs/06 §5 (`LavaBurst`). */
export interface LavaBurstData {
  site: Point;
  /**
   * "spew" | "fire". Widened to `string` so the client cannot reject a value
   * the Rust side (`LavaBurstData.phase: String`) can legally send. Narrowing
   * both sides to a shared union is deferred to T4.6, which makes the two
   * phases real. See HANDOFF-phase0.md "tracked".
   */
  phase: string;
}

/** docs/06 §5 (`HeavyFog`) — carries no data. */
export type HeavyFogData = Record<string, never>;

/** docs/06 §5 — discriminated by the owning message's `kind` field. */
export type EffectData =
  | ToxicRainData
  | MeteorShowerData
  | LavaBurstData
  | HeavyFogData;

/** Effect kind names as they appear on the wire (docs/02 §7). */
export const EFFECT_KINDS = [
  'toxic_rain',
  'meteor_shower',
  'lava_burst',
  'heavy_fog',
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

// ---------------------------------------------------------------------------
// §1 — Client -> Server payloads
// ---------------------------------------------------------------------------

/** `join_room` (docs/06 §1). Name 1–12 chars, trimmed; server sanitizes. */
export interface JoinRoom {
  name: string;
}

/** `select_skin` (docs/06 §1). Lobby only. */
export interface SelectSkin {
  skin: number;
  /**
   * docs/06 §1 defines no way to send a weapon skin, though docs/07 §4
   * requires one to be stored and broadcast. Optional, so the documented
   * payload stays valid. See DEVIATIONS.md D52.
   */
  weapon_skin?: number;
}

/** `use_slot` (docs/06 §1). The UI path; also present inside InputFrame. */
export interface UseSlot {
  slot: number;
}

/** `set_log_level` (docs/06 §1). "info" or "debug". */
export interface SetLogLevel {
  level: string;
}

/** `ready`, `restart`, `quit`, `ping` (docs/06 §1) carry `{}`. */
export type Empty = Record<string, never>;

// ---------------------------------------------------------------------------
// §2 — Server -> Client payloads
// ---------------------------------------------------------------------------

/** docs/06 §2 (`LobbyPlayer`). */
export interface LobbyPlayer {
  id: number;
  name: string;
  skin: number;
  ready: boolean;
  /**
   * docs/07 §4 + T5.3 step 2. Per player, not per room — see DEVIATIONS.md
   * D52 for why "weapon_skin u8 added to lobby_state" cannot be a single
   * field on the lobby_state object.
   */
  weapon_skin: number;
}

/** `joined` (docs/06 §2). */
export interface Joined {
  id: number;
  room: number;
  seed: number;
  scale: string;
  map: MapData;
  players: LobbyPlayer[];
  /** docs/06 §7. */
  protocol_version: number;
}

/** `player_joined` (docs/06 §2). */
export interface PlayerJoined {
  id: number;
  name: string;
  skin: number;
}

/** `player_left` (docs/06 §2). */
export interface PlayerLeft {
  id: number;
}

/** `lobby_state` (docs/06 §2). */
export interface LobbyState {
  players: LobbyPlayer[];
  /** docs/06 §2: `ready: [bool; 6]`. */
  ready: Six<boolean>;
  countdown_in_s: number | null;
}

/** `round_started` (docs/06 §2). Map re-sent each round. */
export interface RoundStarted {
  seed: number;
  scale: string;
  map: MapData;
  /** This client's spawn, in pixels. */
  spawn: Point;
}

/** `tile_destroyed` (docs/06 §2). Immediate, not via snapshot. */
export interface TileDestroyedMsg {
  tiles: TilePos[];
  version: number;
  item_uncovered: ItemUncovered | null;
}

/** docs/06 §2 (`tile_destroyed.item_uncovered`). */
export interface ItemUncovered {
  item: string;
  x: number;
  y: number;
}

/** `item_spawned` (docs/06 §2). Sources A–D. */
export interface ItemSpawned {
  item: string;
  x: number;
  y: number;
  crate: boolean;
}

/** `item_picked` (docs/06 §2). */
export interface ItemPicked {
  player: number;
  item: string;
}

/** `crate_dropped` (docs/06 §2). */
export interface CrateDropped {
  x: number;
}

/** `projectile_fired` (docs/06 §2). */
export interface ProjectileFired {
  id: number;
  owner: number;
  kind: string;
  x: number;
  y: number;
  angle: number;
}

/** `explosion` (docs/06 §2). Visual only. */
export interface Explosion {
  x: number;
  y: number;
  radius: number;
}

/** `kill` (docs/06 §2). `killer` null = weather/self. */
export interface Kill {
  victim: number;
  killer: number | null;
  weapon: string;
}

/** `respawned` (docs/06 §2). */
export interface Respawned {
  player: number;
  x: number;
  y: number;
}

/** `effect_started` (docs/06 §2). */
export interface EffectStarted {
  kind: string;
  data: EffectData;
}

/** `effect_ended` (docs/06 §2). */
export interface EffectEnded {
  kind: string;
}

/** An entry of `round_ended.scores` (docs/06 §2). */
export interface ScoreEntry {
  id: number;
  name: string;
  score: number;
  kills: number;
  deaths: number;
}

/** `round_ended` (docs/06 §2). */
export interface RoundEnded {
  scores: ScoreEntry[];
}

/** `error` (docs/06 §2). Codes: room_full, bad_name, not_in_room, ... */
export interface ErrorMsg {
  code: string;
  msg: string;
}

// ---------------------------------------------------------------------------
// Event names (docs/06 §1, §2) — mirrors protocol.rs `c2s` / `s2c`.
// ---------------------------------------------------------------------------

/** Client -> server event names (docs/06 §1). */
export const C2S = {
  JOIN_ROOM: 'join_room',
  READY: 'ready',
  SELECT_SKIN: 'select_skin',
  INPUT: 'input',
  USE_SLOT: 'use_slot',
  RESTART: 'restart',
  QUIT: 'quit',
  SET_LOG_LEVEL: 'set_log_level',
  PING: 'ping',
} as const;

/** Server -> client event names (docs/06 §2). */
export const S2C = {
  JOINED: 'joined',
  PLAYER_JOINED: 'player_joined',
  PLAYER_LEFT: 'player_left',
  LOBBY_STATE: 'lobby_state',
  ROUND_STARTED: 'round_started',
  SNAPSHOT: 'snapshot',
  TILE_DESTROYED: 'tile_destroyed',
  ITEM_SPAWNED: 'item_spawned',
  ITEM_PICKED: 'item_picked',
  CRATE_DROPPED: 'crate_dropped',
  PROJECTILE_FIRED: 'projectile_fired',
  EXPLOSION: 'explosion',
  KILL: 'kill',
  RESPAWNED: 'respawned',
  EFFECT_STARTED: 'effect_started',
  EFFECT_ENDED: 'effect_ended',
  ROUND_ENDED: 'round_ended',
  PONG: 'pong',
  ERROR: 'error',
} as const;
