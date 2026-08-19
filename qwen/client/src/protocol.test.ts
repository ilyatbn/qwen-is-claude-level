/**
 * docs/08-testing.md §3 (`protocol.ts` row):
 * "PROTOCOL_VERSION === 1; a round-trip JSON parse of a fixture snapshot
 *  matches expected field names (guards against TS/Rust drift)."
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
  type MapData,
  type PlayerSnap,
  type Snapshot,
} from './protocol';

/** A snapshot fixture written from docs/06 §4 by hand, not from the code. */
const SNAPSHOT_FIXTURE = {
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
    {
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
    },
  ],
  items: [{ item: 'medkit', x: 50.0, y: 60.0, crate: false }],
  projectiles: [{ id: 7, kind: 'rocket', x: 10.0, y: 20.0 }],
};

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
    const parsed: unknown = JSON.parse(JSON.stringify(SNAPSHOT_FIXTURE));
    expect(parsed).toEqual(SNAPSHOT_FIXTURE);
  });

  it('has exactly the field names docs/06 §4 lists', () => {
    const snap = JSON.parse(JSON.stringify(SNAPSHOT_FIXTURE)) as Snapshot;
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
    const snap = JSON.parse(JSON.stringify(SNAPSHOT_FIXTURE)) as Snapshot;
    const player = snap.players[0];
    expect(player).toBeDefined();
    expect(Object.keys(player as PlayerSnap).sort()).toEqual(
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

  it('gives every player 6 inventory slots and 6 ammo counts (docs/04 §5)', () => {
    const snap = JSON.parse(JSON.stringify(SNAPSHOT_FIXTURE)) as Snapshot;
    for (const player of snap.players) {
      expect(player.slots).toHaveLength(6);
      expect(player.ammo).toHaveLength(6);
    }
  });

  it('models a ground item with a `crate` flag (docs/06 §4)', () => {
    const snap = JSON.parse(JSON.stringify(SNAPSHOT_FIXTURE)) as Snapshot;
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
    const parsed: unknown = JSON.parse(JSON.stringify(map));
    expect(Object.keys(parsed as object).sort()).toEqual(
      ['seed', 'scale', 'width', 'height', 'tiles', 'decor', 'spawns'].sort(),
    );
  });

  it('encodes tile kinds as docs/06 §6 specifies', () => {
    expect([TILE_AIR, TILE_GRASS, TILE_DIRT, TILE_STONE, TILE_ROCK]).toEqual([
      0, 1, 2, 3, 4,
    ]);
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
