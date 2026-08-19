import { describe, expect, it } from 'vitest';
import manifestJson from './manifest.json';
import {
  ITEM_KEYS,
  MANIFEST_VERSION,
  PLAYER_SKINS,
  TILE_KINDS,
  TILE_VARIANTS,
  allTextureKeys,
  itemTextureKey,
  loadEntries,
  manifestProblem,
  playerTextureKey,
  tileTextureKey,
  type AssetManifest,
} from './manifest';
import { placeholderFor } from './placeholders';

const MANIFEST: AssetManifest = manifestJson;

describe('the shipped manifest', () => {
  it('is version 1 with every section docs/07 §2 lists', () => {
    expect(MANIFEST.version).toBe(MANIFEST_VERSION);
    for (const section of ['tiles', 'players', 'weapons', 'items', 'decor', 'ui'] as const) {
      expect(MANIFEST[section], `manifest.${section}`).toBeDefined();
    }
    expect(manifestProblem(MANIFEST)).toBeNull();
  });

  it('lists exactly 3 variants per tile kind, as the % 3 formula requires', () => {
    const tiles = MANIFEST.tiles;
    expect('placeholder' in tiles).toBe(false);
    if ('placeholder' in tiles) return;
    for (const kind of TILE_KINDS) {
      expect(tiles[kind], kind).toHaveLength(TILE_VARIANTS);
    }
  });

  it('produces one load entry per texture key', () => {
    const entries = loadEntries(MANIFEST);
    // 4 kinds x 3 variants + 6 players + 4 weapons + 4 items + 3 decor + 3 ui.
    expect(entries).toHaveLength(12 + 6 + 4 + 4 + 3 + 3);
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
    expect(entries.map((e) => e.key)).toContain(tileTextureKey('GRASS', 0));
    expect(entries.map((e) => e.key)).toContain(playerTextureKey(PLAYER_SKINS - 1));
  });

  /**
   * The point of the whole module: a file that fails to load must leave a
   * placeholder standing. That is only true if every manifest key is also a
   * placeholder key.
   */
  it('never names a texture key that has no placeholder', () => {
    for (const entry of loadEntries(MANIFEST)) {
      expect(placeholderFor(entry.key), `no placeholder for ${entry.key}`).toBeDefined();
    }
  });

  it("maps the manifest's `shield` section key to the protocol's `shield_gen`", () => {
    // docs/07 §2 and docs/06 §2 disagree on the name — DEVIATIONS.md D49.
    expect(ITEM_KEYS['shield']).toBe('shield_gen');
    expect(loadEntries(MANIFEST).map((e) => e.key)).toContain(itemTextureKey('shield_gen'));
  });
});

describe('loadEntries', () => {
  const placeholderAll: AssetManifest = {
    version: 1,
    tiles: { placeholder: true },
    players: { placeholder: true },
    weapons: { placeholder: true },
    items: { placeholder: true },
    decor: { placeholder: true },
    ui: { placeholder: true },
  };

  it('loads nothing when every section is in placeholder mode (docs/07 §2)', () => {
    expect(loadEntries(placeholderAll)).toEqual([]);
    expect(manifestProblem(placeholderAll)).toBeNull();
  });

  it('accepts a frame rect as well as a plain path (docs/07 §3)', () => {
    const withFrame: AssetManifest = {
      ...placeholderAll,
      players: [{ file: 'processed/players/sheet.png', frame: [16, 32, 24, 28] }],
    };
    expect(loadEntries(withFrame)).toEqual([
      { key: 'player_0', file: 'processed/players/sheet.png', frame: [16, 32, 24, 28] },
    ]);
  });

  it('ignores variants past the third, which the % 3 formula can never select', () => {
    const extra: AssetManifest = {
      ...placeholderAll,
      tiles: {
        GRASS: ['a.png', 'b.png', 'c.png', 'd.png'],
        DIRT: ['a.png', 'b.png', 'c.png'],
        STONE: ['a.png', 'b.png', 'c.png'],
        ROCK: ['a.png', 'b.png', 'c.png'],
      },
    };
    expect(loadEntries(extra).filter((e) => e.key.startsWith('GRASS'))).toHaveLength(3);
  });
});

describe('manifestProblem', () => {
  it('rejects a manifest written for another loader version', () => {
    expect(manifestProblem({ ...MANIFEST, version: 2 })).toMatch(/version 2/);
  });

  it('rejects a tile kind with too few variants', () => {
    const short: AssetManifest = {
      ...MANIFEST,
      tiles: {
        GRASS: ['a.png', 'b.png'],
        DIRT: ['a.png', 'b.png', 'c.png'],
        STONE: ['a.png', 'b.png', 'c.png'],
        ROCK: ['a.png', 'b.png', 'c.png'],
      },
    };
    expect(manifestProblem(short)).toMatch(/tiles\.GRASS/);
  });
});

describe('allTextureKeys', () => {
  it('has a placeholder for every key, so no key can render blank', () => {
    const keys = allTextureKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(placeholderFor(key), `no placeholder for ${key}`).toBeDefined();
    }
  });

  it('keeps the bare tile-kind keys the renderer used before variants', () => {
    expect(allTextureKeys()).toContain('GRASS');
    expect(allTextureKeys()).toContain('GRASS_1');
  });
});
