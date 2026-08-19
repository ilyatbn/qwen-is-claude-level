import Phaser from 'phaser';
import { TerrainGrid, TILE_SIZE } from '../logic/terrainGrid';
import { tileVariantIndex } from '../logic/tileVariant';
import { tileTextureKey, type TileKindName } from '../assets/manifest';
import type { TileKind, TilePos } from '../protocol';

/**
 * Phaser rendering layer over the pure {@link TerrainGrid}.
 *
 * All grid state and logic live in the model (D10); this class only turns it
 * into sprites and reacts to destruction events. It is deliberately untested by
 * Vitest — testing it would require a WebGL context. `terrainGrid.test.ts`
 * covers the logic.
 */
export class Terrain {
  private readonly scene: Phaser.Scene;
  readonly grid: TerrainGrid;
  private readonly group: Phaser.GameObjects.Group;
  /** Sprite per solid tile, keyed `x,y`, so destruction can remove one. */
  private readonly sprites = new Map<string, Phaser.GameObjects.Image>();

  constructor(scene: Phaser.Scene, grid: TerrainGrid) {
    this.scene = scene;
    this.grid = grid;
    this.group = scene.add.group();
    this.renderAll();
  }

  private static key(x: number, y: number): string {
    return `${x},${y}`;
  }

  /**
   * Texture key for one tile (docs/07 §2: variant by `(seed + x + y) % 3`).
   *
   * Falls back to the bare kind key if the variant texture is missing, and
   * that is not dead code: BootScene registers a placeholder per variant, but
   * a manifest could name only the bare key.
   */
  private textureFor(kind: TileKind, x: number, y: number): string {
    const variant = tileVariantIndex(this.grid.seed, x, y);
    const key = tileTextureKey(kind as TileKindName, variant);
    return this.scene.textures.exists(key) ? key : kind;
  }

  private renderAll(): void {
    for (const { x, y, kind } of this.grid.solidTiles()) {
      const sprite = this.scene.add
        .image(x * TILE_SIZE, y * TILE_SIZE, this.textureFor(kind, x, y))
        .setOrigin(0, 0);
      this.group.add(sprite);
      this.sprites.set(Terrain.key(x, y), sprite);
    }
  }

  /**
   * Apply a `tile_destroyed` event (docs/06 §2): update the model, then remove
   * only the sprites whose tiles actually changed.
   *
   * T5.2 step 2 asks that redraws use the same variant formula. Destruction
   * only ever removes tiles — the client is never told a tile changed kind, so
   * there is no redraw path to keep consistent. Every sprite that exists was
   * created by `renderAll` through `textureFor`, which is the formula.
   */
  applyDestroyed(tiles: readonly TilePos[], version?: number): void {
    for (const tile of this.grid.applyDestroyed(tiles, version)) {
      const key = Terrain.key(tile.x, tile.y);
      this.sprites.get(key)?.destroy();
      this.sprites.delete(key);
    }
  }

  /** Live sprite count, for debugging and the dev overlay. */
  get spriteCount(): number {
    return this.sprites.size;
  }

  destroy(): void {
    this.group.destroy(true);
    this.sprites.clear();
  }
}
