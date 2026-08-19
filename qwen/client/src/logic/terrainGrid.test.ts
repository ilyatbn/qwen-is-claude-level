/**
 * T1.9 Acceptance: "a unit test of Terrain's applyDestroyed(tiles) updates the
 * grid correctly". Tests the pure model only — no Phaser reaches Vitest (D10).
 */
import { describe, expect, it } from 'vitest';
import { TILE_AIR, TILE_DIRT, TILE_GRASS, TILE_STONE, type MapData } from '../protocol';
import { decodeTiles, TerrainGrid, TILE_SIZE } from './terrainGrid';

/** A 4x3 grid: row 0 all AIR, row 1 GRASS, row 2 DIRT. */
function sampleGrid(): TerrainGrid {
  const tiles = new Uint8Array([
    TILE_AIR, TILE_AIR, TILE_AIR, TILE_AIR,
    TILE_GRASS, TILE_GRASS, TILE_GRASS, TILE_GRASS,
    TILE_DIRT, TILE_DIRT, TILE_DIRT, TILE_DIRT,
  ]);
  return new TerrainGrid(4, 3, tiles, 0);
}

describe('TerrainGrid construction', () => {
  it('rejects a tile array that does not match the dimensions', () => {
    expect(() => new TerrainGrid(4, 3, new Uint8Array(5))).toThrow(
      /expected 12 tiles, got 5/,
    );
  });

  it('reads row-major with y=0 on top (docs/01 §1)', () => {
    const grid = sampleGrid();
    expect(grid.kindNameAt(0, 0)).toBe('AIR');
    expect(grid.kindNameAt(0, 1)).toBe('GRASS');
    expect(grid.kindNameAt(0, 2)).toBe('DIRT');
  });

  it('reports pixel bounds for the camera clamp', () => {
    const grid = sampleGrid();
    expect(grid.pixelWidth).toBe(4 * TILE_SIZE);
    expect(grid.pixelHeight).toBe(3 * TILE_SIZE);
  });

  it('treats out-of-bounds as AIR rather than throwing', () => {
    const grid = sampleGrid();
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [4, 0],
      [0, 3],
      [999, 999],
    ]) {
      expect(grid.kindAt(x as number, y as number)).toBe(TILE_AIR);
      expect(grid.isSolid(x as number, y as number)).toBe(false);
    }
  });
});

describe('applyDestroyed', () => {
  it('sets the named tiles to AIR', () => {
    const grid = sampleGrid();
    expect(grid.isSolid(1, 1)).toBe(true);
    grid.applyDestroyed([{ x: 1, y: 1 }]);
    expect(grid.isSolid(1, 1)).toBe(false);
    expect(grid.kindNameAt(1, 1)).toBe('AIR');
  });

  it('leaves every other tile untouched', () => {
    const grid = sampleGrid();
    grid.applyDestroyed([{ x: 1, y: 1 }]);
    expect(grid.kindNameAt(0, 1)).toBe('GRASS');
    expect(grid.kindNameAt(2, 1)).toBe('GRASS');
    expect(grid.kindNameAt(1, 2)).toBe('DIRT');
  });

  it('returns only the tiles that actually changed', () => {
    const grid = sampleGrid();
    const changed = grid.applyDestroyed([
      { x: 0, y: 1 }, // GRASS -> changes
      { x: 0, y: 0 }, // already AIR -> no change
      { x: 99, y: 0 }, // out of bounds -> ignored
      { x: 1, y: 2 }, // DIRT -> changes
    ]);
    expect(changed).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 2 },
    ]);
  });

  it('is idempotent — destroying the same tile twice changes nothing', () => {
    const grid = sampleGrid();
    expect(grid.applyDestroyed([{ x: 2, y: 1 }])).toHaveLength(1);
    expect(grid.applyDestroyed([{ x: 2, y: 1 }])).toHaveLength(0);
  });

  it('does not throw on out-of-bounds coordinates', () => {
    const grid = sampleGrid();
    expect(() =>
      grid.applyDestroyed([
        { x: -1, y: -1 },
        { x: 1000, y: 1000 },
      ]),
    ).not.toThrow();
  });

  it('tracks the map version when one is supplied (docs/01 §4)', () => {
    const grid = sampleGrid();
    expect(grid.version).toBe(0);
    grid.applyDestroyed([{ x: 1, y: 1 }], 7);
    expect(grid.version).toBe(7);
    // Omitting the version leaves it alone.
    grid.applyDestroyed([{ x: 2, y: 1 }]);
    expect(grid.version).toBe(7);
  });
});

describe('decodeTiles', () => {
  it('round-trips a base64 tile array (docs/06 §6)', () => {
    // [0,1,2,3,4] -> AIR, GRASS, DIRT, STONE, ROCK
    const bytes = new Uint8Array([0, 1, 2, 3, 4]);
    const base64 = btoa(String.fromCharCode(...bytes));
    expect(Array.from(decodeTiles(base64))).toEqual([0, 1, 2, 3, 4]);
  });

  it('builds a grid from a MapData payload', () => {
    const tiles = new Uint8Array([TILE_STONE, TILE_AIR, TILE_GRASS, TILE_DIRT]);
    const map: MapData = {
      seed: 5,
      scale: 'small',
      width: 2,
      height: 2,
      tiles: btoa(String.fromCharCode(...tiles)),
      decor: [],
      spawns: [],
    };
    const grid = TerrainGrid.fromMapData(map);
    expect(grid.width).toBe(2);
    expect(grid.seed).toBe(5);
    expect(grid.kindNameAt(0, 0)).toBe('STONE');
    expect(grid.kindNameAt(1, 1)).toBe('DIRT');
  });
});

describe('variantAt (docs/07 §2, T5.2)', () => {
  it('is (seed + x + y) % 3', () => {
    const grid = new TerrainGrid(4, 3, new Uint8Array(12), 7);
    expect(grid.variantAt(0, 0)).toBe(7 % 3);
    expect(grid.variantAt(1, 1)).toBe((7 + 2) % 3);
  });

  it('always returns 0, 1 or 2', () => {
    const grid = new TerrainGrid(4, 3, new Uint8Array(12), 999);
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        expect([0, 1, 2]).toContain(grid.variantAt(x, y));
      }
    }
  });
});

describe('solidTiles', () => {
  it('yields every solid tile and no AIR', () => {
    const grid = sampleGrid();
    const solid = [...grid.solidTiles()];
    expect(solid).toHaveLength(8);
    expect(solid.every((t) => t.kind !== 'AIR')).toBe(true);
    expect(solid.filter((t) => t.kind === 'GRASS')).toHaveLength(4);
    expect(solid.filter((t) => t.kind === 'DIRT')).toHaveLength(4);
  });

  it('reflects destruction', () => {
    const grid = sampleGrid();
    grid.applyDestroyed([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
    expect([...grid.solidTiles()]).toHaveLength(6);
  });
});
