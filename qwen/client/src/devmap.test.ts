/**
 * Dev map + query-param parsing (T1.9 step 4, T1.10 steps 2-3).
 * Pure logic only — no Phaser (D10).
 */
import { describe, expect, it } from 'vitest';
import { buildDevMap, parseDevOptions } from './devmap';
import { TerrainGrid } from './logic/terrainGrid';

describe('parseDevOptions', () => {
  it('reads seed, scale and dev flag', () => {
    const options = parseDevOptions('?seed=777&scale=medium&dev=1');
    expect(options).toEqual({ seed: 777, scale: 'medium', dev: true });
  });

  it('defaults to seed 1, small, no dev', () => {
    expect(parseDevOptions('')).toEqual({ seed: 1, scale: 'small', dev: false });
  });

  it('falls back on an unknown scale rather than producing a broken map', () => {
    expect(parseDevOptions('?scale=enormous').scale).toBe('small');
  });

  it('falls back on a non-numeric seed', () => {
    expect(parseDevOptions('?seed=abc').seed).toBe(1);
  });
});

describe('buildDevMap', () => {
  it('produces the documented dimensions per scale (docs/01 §1)', () => {
    expect([buildDevMap(1, 'small').width, buildDevMap(1, 'small').height]).toEqual([96, 64]);
    expect([buildDevMap(1, 'medium').width, buildDevMap(1, 'medium').height]).toEqual([160, 96]);
    expect([buildDevMap(1, 'large').width, buildDevMap(1, 'large').height]).toEqual([240, 128]);
  });

  it('is deterministic for a given seed', () => {
    expect(buildDevMap(777, 'medium')).toEqual(buildDevMap(777, 'medium'));
  });

  it('produces different terrain for different seeds', () => {
    expect(buildDevMap(1, 'small').tiles).not.toEqual(buildDevMap(2, 'small').tiles);
  });

  it('decodes to a full grid with ground in every column', () => {
    const grid = TerrainGrid.fromMapData(buildDevMap(42, 'small'));
    for (let x = 0; x < grid.width; x += 1) {
      let solid = false;
      for (let y = 0; y < grid.height; y += 1) {
        if (grid.isSolid(x, y)) {
          solid = true;
          break;
        }
      }
      expect(solid, `column ${x} has no ground`).toBe(true);
    }
  });

  it('has open sky at the top and solid ground at the bottom', () => {
    const grid = TerrainGrid.fromMapData(buildDevMap(42, 'small'));
    for (let x = 0; x < grid.width; x += 1) {
      expect(grid.isSolid(x, 0)).toBe(false);
      expect(grid.isSolid(x, grid.height - 1)).toBe(true);
    }
  });

  it('layers grass over dirt over stone, like the server (docs/01 §3)', () => {
    const grid = TerrainGrid.fromMapData(buildDevMap(3, 'small'));
    const x = 20;
    let surface = 0;
    while (surface < grid.height && !grid.isSolid(x, surface)) {
      surface += 1;
    }
    expect(grid.kindNameAt(x, surface)).toBe('GRASS');
    expect(grid.kindNameAt(x, surface + 1)).toBe('DIRT');
    expect(grid.kindNameAt(x, surface + 5)).toBe('STONE');
  });
});
