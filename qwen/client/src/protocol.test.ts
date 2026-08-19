/**
 * docs/08-testing.md §3 (`protocol.ts` row):
 * "PROTOCOL_VERSION === 1; a round-trip JSON parse of a fixture snapshot
 *  matches expected field names (guards against TS/Rust drift)."
 *
 * The guard only works because SNAPSHOT_FIXTURE is annotated `: Snapshot`.
 * Without the annotation the fixture is a structurally-inferred object literal
 * and every assertion below checks the fixture against itself, leaving
 * protocol.ts unchecked — renaming a field in the interface would still
 * compile and still pass. The annotation is what makes a TS/Rust drift a
 * `tsc --noEmit` failure. Do not replace it with a cast.
 */
import { describe, expect, it } from 'vitest';
import {
  C2S,
  NAMESPACE,
  PROTOCOL_VERSION,
  S2C,
  TILE_AIR,
  TILE_DIRT,
  TILE_GRASS,
  TILE_ROCK,
  TILE_STONE,
  type InputFrame,
  type LobbyState,
  type MapData,
  type PlayerSnap,
  type Six,
  type Snapshot,
  type TileDestroyedMsg,
} from './protocol';

/** docs/06 §4: "missing players: alive=false, x=y=0". */
function missingPlayer(id: number): PlayerSnap {
  return {
    id,
    name: '',
    skin: 0,
    x: 0,
    y: 0,
    facing: 0,
    health: 0,
    max_health: 100,
    shield_remaining: 0,
    jetpack_fuel: 0,
    fov: 0,
    alive: false,
    respawn_in_s: 0,
    score: 0,
    slots: [null, null, null, null, null, null],
    selected: 0,
    ammo: [0, 0, 0, 0, 0, 0],
  };
}

const PLAYER_ZERO: PlayerSnap = {
  id: 0,
  name: 'p0',
  skin: 1,
  x: 100.0,
  y: 200.0,
  facing: 0.0,
  health: 100.0,
  max_health: 100.0,
  shield_remaining: 0.0,
  jetpack_fuel: 5.0,
  fov: 420.0,
  alive: true,
  respawn_in_s: 0.0,
  score: 0,
  slots: ['pistol', null, null, null, null, null],
  selected: 0,
  ammo: [30, 0, 0, 0, 0, 0],
};

/**
 * A snapshot fixture written from docs/06 §4 by hand, not from the code.
 * The `: Snapshot` annotation is load-bearing — see the file header.
 */
const SNAPSHOT_FIXTURE: Snapshot = {
  tick: 240,
  round_time_s: 12.0,
  day_phase: 0.0,
  fog: { active: false, remaining_s: 0.0 },
  effect: {
    kind: 'toxic_rain',
    remaining_s: 3.5,
    data: { spots: [{ x: 100.0, y: 200.0, remaining_s: 2.0 }] },
  },
  map_version: 3,
  players: [
    PLAYER_ZERO,
    missingPlayer(1),
    missingPlayer(2),
    missingPlayer(3),
    missingPlayer(4),
    missingPlayer(5),
  ],
  items: [{ item: 'medkit', x: 50.0, y: 60.0, crate: false }],
  projectiles: [{ id: 7, kind: 'rocket', x: 10.0, y: 20.0 }],
};

/** Serialise and re-parse, preserving the static type of the input. */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('PROTOCOL_VERSION', () => {
  it('is 1 (docs/06 §7)', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('uses the /game namespace (docs/06 intro)', () => {
    expect(NAMESPACE).toBe('/game');
  });
});

describe('snapshot fixture round-trip', () => {
  it('survives a JSON round trip unchanged', () => {
    expect(roundTrip(SNAPSHOT_FIXTURE)).toEqual(SNAPSHOT_FIXTURE);
  });

  it('has exactly the field names docs/06 §4 lists', () => {
    const snap = roundTrip(SNAPSHOT_FIXTURE);
    expect(Object.keys(snap).sort()).toEqual(
      [
        'tick',
        'round_time_s',
        'day_phase',
        'fog',
        'effect',
        'map_version',
        'players',
        'items',
        'projectiles',
      ].sort(),
    );
  });

  it('has exactly the PlayerSnap field names docs/06 §4 lists', () => {
    const snap = roundTrip(SNAPSHOT_FIXTURE);
    expect(Object.keys(snap.players[0]).sort()).toEqual(
      [
        'id',
        'name',
        'skin',
        'x',
        'y',
        'facing',
        'health',
        'max_health',
        'shield_remaining',
        'jetpack_fuel',
        'fov',
        'alive',
        'respawn_in_s',
        'score',
        'slots',
        'selected',
        'ammo',
      ].sort(),
    );
  });

  it('always carries 6 players, present or not (docs/06 §4)', () => {
    const snap = roundTrip(SNAPSHOT_FIXTURE);
    expect(snap.players).toHaveLength(6);
    // Missing players are present with alive=false, x=y=0.
    for (const player of snap.players.slice(1)) {
      expect(player.alive).toBe(false);
      expect(player.x).toBe(0);
      expect(player.y).toBe(0);
    }
  });

  it('gives every player 6 inventory slots and 6 ammo counts (docs/04 §5)', () => {
    const snap = roundTrip(SNAPSHOT_FIXTURE);
    for (const player of snap.players) {
      expect(player.slots).toHaveLength(6);
      expect(player.ammo).toHaveLength(6);
    }
  });

  it('models a ground item with a `crate` flag (docs/06 §4)', () => {
    const snap = roundTrip(SNAPSHOT_FIXTURE);
    expect(Object.keys(snap.items[0] ?? {}).sort()).toEqual(
      ['item', 'x', 'y', 'crate'].sort(),
    );
  });
});

describe('MapData', () => {
  it('has exactly the field names docs/06 §6 lists', () => {
    const map: MapData = {
      seed: 42,
      scale: 'small',
      width: 96,
      height: 64,
      tiles: 'AAEC',
      decor: [{ x: 1, y: 2, kind: 'bush' }],
      spawns: [{ x: 5, y: 6 }],
    };
    expect(Object.keys(roundTrip(map)).sort()).toEqual(
      ['seed', 'scale', 'width', 'height', 'tiles', 'decor', 'spawns'].sort(),
    );
  });

  it('encodes tile kinds as docs/06 §6 specifies', () => {
    expect([TILE_AIR, TILE_GRASS, TILE_DIRT, TILE_STONE, TILE_ROCK]).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});

describe('TileDestroyedMsg', () => {
  // docs/06 §2. T1.7 emits this and T1.9 consumes it. Annotated, not cast —
  // the annotation is what makes a drift a compile error.
  const FIXTURE: TileDestroyedMsg = {
    tiles: [{ x: 3, y: 4 }],
    version: 9,
    item_uncovered: { item: 'medkit', x: 56.0, y: 72.0 },
  };

  it('has exactly the field names docs/06 §2 lists', () => {
    const msg = roundTrip(FIXTURE);
    expect(Object.keys(msg).sort()).toEqual(
      ['tiles', 'version', 'item_uncovered'].sort(),
    );
    expect(Object.keys(msg.tiles[0] ?? {}).sort()).toEqual(['x', 'y'].sort());
    expect(Object.keys(msg.item_uncovered ?? {}).sort()).toEqual(
      ['item', 'x', 'y'].sort(),
    );
  });

  it('allows a null item_uncovered (the common case)', () => {
    const bare: TileDestroyedMsg = { tiles: [], version: 1, item_uncovered: null };
    expect(roundTrip(bare).item_uncovered).toBeNull();
  });

  it('carries tile coordinates, not pixels', () => {
    const msg = roundTrip(FIXTURE);
    for (const tile of msg.tiles) {
      expect(Number.isInteger(tile.x)).toBe(true);
      expect(Number.isInteger(tile.y)).toBe(true);
    }
  });
});

describe('InputFrame', () => {
  // docs/06 §3 — the 20 Hz C->S message T2.2/T2.9 are built on.
  const FIXTURE: InputFrame = {
    tick: 7,
    left: true,
    right: false,
    up: false,
    down: false,
    jump: true,
    aim: 1.5,
    fire: true,
    use_slot: 2,
  };

  it('has exactly the field names docs/06 §3 lists', () => {
    expect(Object.keys(roundTrip(FIXTURE)).sort()).toEqual(
      [
        'tick',
        'left',
        'right',
        'up',
        'down',
        'jump',
        'aim',
        'fire',
        'use_slot',
      ].sort(),
    );
  });

  it('carries a null use_slot except on the tick it is pressed (docs/06 §3)', () => {
    const released: InputFrame = { ...FIXTURE, use_slot: null };
    expect(roundTrip(released).use_slot).toBeNull();
    expect(roundTrip(FIXTURE).use_slot).toBe(2);
  });
});

describe('fixed cardinalities', () => {
  it('types a 6-wide lobby ready flag (docs/06 §2)', () => {
    const ready: Six<boolean> = [false, false, false, false, false, false];
    expect(ready).toHaveLength(6);
  });
});

describe('event names', () => {
  it('lists every client->server event in docs/06 §1', () => {
    expect(Object.values(C2S).sort()).toEqual(
      [
        'join_room',
        'ready',
        'select_skin',
        'input',
        'use_slot',
        'restart',
        'quit',
        'set_log_level',
        'ping',
      ].sort(),
    );
  });

  it('lists every server->client event in docs/06 §2', () => {
    expect(Object.values(S2C).sort()).toEqual(
      [
        'joined',
        'player_joined',
        'player_left',
        'lobby_state',
        'round_started',
        'snapshot',
        'tile_destroyed',
        'item_spawned',
        'item_picked',
        'crate_dropped',
        'projectile_fired',
        'explosion',
        'kill',
        'respawned',
        'effect_started',
        'effect_ended',
        'round_ended',
        'pong',
        'error',
      ].sort(),
    );
  });
});

/**
 * T5.3 changed `LobbyPlayer`, so it gets the same annotated-fixture guard the
 * snapshot has. `LOBBY_STATE_FIXTURE: LobbyState` is what makes a rename in
 * protocol.ts a tsc failure — a cast would check the fixture against itself.
 */
const LOBBY_STATE_FIXTURE: LobbyState = {
  players: [{ id: 0, name: 'p0', skin: 3, ready: true, weapon_skin: 1 }],
  ready: [true, false, false, false, false, false],
  countdown_in_s: 2.5,
};

describe('lobby_state (docs/06 §2)', () => {
  it('round-trips with the field names docs/06 §2 lists', () => {
    const parsed: unknown = JSON.parse(JSON.stringify(LOBBY_STATE_FIXTURE));
    expect(Object.keys(parsed as object).sort()).toEqual([
      'countdown_in_s',
      'players',
      'ready',
    ]);
    const player = LOBBY_STATE_FIXTURE.players[0];
    expect(player).toBeDefined();
    expect(Object.keys(player ?? {}).sort()).toEqual([
      'id',
      'name',
      'ready',
      'skin',
      'weapon_skin',
    ]);
  });

  it('has one ready flag per seat (docs/06 §2: `ready: [bool; 6]`)', () => {
    expect(LOBBY_STATE_FIXTURE.ready).toHaveLength(6);
  });

  it('carries a null countdown outside the countdown state', () => {
    const idle: LobbyState = { ...LOBBY_STATE_FIXTURE, countdown_in_s: null };
    expect(idle.countdown_in_s).toBeNull();
  });
});
