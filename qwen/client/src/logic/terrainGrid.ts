/**
 * Pure terrain grid model — no Phaser, no DOM.
 *
 * docs/08 §3 restricts client tests to pure logic, but T1.9's Acceptance wants
 * a unit test of `Terrain.applyDestroyed(tiles)`. Splitting the grid state out
 * of the renderer lets Vitest cover the logic without dragging Phaser (and a
 * WebGL context) into the test runner. See DEVIATIONS.md D10.
 *
 * `entities/Terrain.ts` owns this and renders from it.
 */
import {
  TILE_AIR,
  TILE_KINDS,
  type MapData,
  type TileKind,
  type TilePos,
} from '../protocol';

/** Tile size in pixels (docs/01 §1). */
export const TILE_SIZE = 16;

/** Decode `MapData.tiles` (base64 of a width*height u8 array, docs/06 §6). */
export function decodeTiles(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * The client's view of the tile grid.
 *
 * Holds kinds only — hp stays server-side (docs/05 §2) — plus the map version,
 * so a client can tell whether it has missed a destruction event.
 */
export class TerrainGrid {
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  private readonly tiles: Uint8Array;
  private mapVersion = 0;

  constructor(width: number, height: number, tiles: Uint8Array, seed = 0) {
    if (tiles.length !== width * height) {
      throw new Error(
        `TerrainGrid: expected ${width * height} tiles, got ${tiles.length}`,
      );
    }
    this.width = width;
    this.height = height;
    this.tiles = tiles;
    this.seed = seed;
  }

  /** Build from a server `MapData` payload (docs/06 §6). */
  static fromMapData(map: MapData): TerrainGrid {
    return new TerrainGrid(map.width, map.height, decodeTiles(map.tiles), map.seed);
  }

  get version(): number {
    return this.mapVersion;
  }

  /** Map bounds in pixels, for the camera clamp (docs/01 §1). */
  get pixelWidth(): number {
    return this.width * TILE_SIZE;
  }

  get pixelHeight(): number {
    return this.height * TILE_SIZE;
  }

  private index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Tile kind byte at `(x, y)`. Out of bounds reads as AIR, never throws. */
  kindAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) {
      return TILE_AIR;
    }
    return this.tiles[this.index(x, y)] ?? TILE_AIR;
  }

  /** Tile kind name at `(x, y)`, for texture lookup. */
  kindNameAt(x: number, y: number): TileKind {
    return TILE_KINDS[this.kindAt(x, y)] ?? 'AIR';
  }

  isSolid(x: number, y: number): boolean {
    return this.kindAt(x, y) !== TILE_AIR;
  }

  /**
   * Apply a `tile_destroyed` event (docs/06 §2): set those tiles to AIR.
   *
   * Returns the tiles that actually changed, so the renderer only removes
   * sprites that exist. Out-of-bounds and already-AIR entries are ignored.
   */
  applyDestroyed(tiles: readonly TilePos[], version?: number): TilePos[] {
    const changed: TilePos[] = [];
    for (const tile of tiles) {
      if (!this.inBounds(tile.x, tile.y)) {
        continue;
      }
      if (this.tiles[this.index(tile.x, tile.y)] === TILE_AIR) {
        continue;
      }
      this.tiles[this.index(tile.x, tile.y)] = TILE_AIR;
      changed.push(tile);
    }
    if (version !== undefined) {
      this.mapVersion = version;
    }
    return changed;
  }

  /**
   * Texture variant for a tile (docs/07 §2, T5.2):
   * `(seed + tile_x + tile_y) % 3`.
   */
  variantAt(x: number, y: number): number {
    return (((this.seed + x + y) % 3) + 3) % 3;
  }

  /** Every solid tile, for the initial render pass. */
  *solidTiles(): Generator<{ x: number; y: number; kind: TileKind }> {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (this.isSolid(x, y)) {
          yield { x, y, kind: this.kindNameAt(x, y) };
        }
      }
    }
  }
}
