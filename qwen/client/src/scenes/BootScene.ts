import Phaser from 'phaser';
import { TILE_SIZE } from '../logic/terrainGrid';

/**
 * Placeholder tile colours (docs/07 §5).
 *
 * "Placeholder visuals (colored rects/circles) are correct until T5.1"
 * (docs/00 §8). T5.1 swaps real textures in under these same keys, so no
 * rendering code changes.
 */
export const PLACEHOLDER_TILE_COLOURS: Readonly<Record<string, number>> = {
  GRASS: 0x4a8f3c,
  DIRT: 0x7a5230,
  STONE: 0x6b6b6b,
  ROCK: 0x8a7f6a,
};

/** Player placeholder colours, one per id (docs/07 §5: "6 fixed colors"). */
export const PLAYER_COLOURS: readonly number[] = [
  0xe6194b, 0x3cb44b, 0x4363d8, 0xf58231, 0x911eb4, 0x42d4f4,
];

/**
 * BootScene — registers placeholder textures, then starts GameScene.
 *
 * T5.1 extends this to load `manifest.json` and fall back to these
 * placeholders for any missing asset (docs/07 §2).
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#101014');
    this.registerPlaceholderTiles();
    console.log('client ready');
    this.scene.start('GameScene');
  }

  /** Generate a flat 16x16 texture per tile kind, keyed by kind name. */
  private registerPlaceholderTiles(): void {
    for (const [kind, colour] of Object.entries(PLACEHOLDER_TILE_COLOURS)) {
      if (this.textures.exists(kind)) {
        continue;
      }
      const canvas = this.textures.createCanvas(kind, TILE_SIZE, TILE_SIZE);
      if (!canvas) {
        continue;
      }
      const ctx = canvas.getContext();
      ctx.fillStyle = `#${colour.toString(16).padStart(6, '0')}`;
      ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
      // A subtle darker edge so individual tiles are visible against
      // neighbours of the same kind.
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
      canvas.refresh();
    }
  }
}
