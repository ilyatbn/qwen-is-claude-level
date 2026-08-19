import Phaser from 'phaser';
import { Terrain } from '../entities/Terrain';
import { buildDevMap, parseDevOptions } from '../devmap';
import { TerrainGrid } from '../logic/terrainGrid';
import type { MapData } from '../protocol';

/** Arrow-key pan speed for the `?dev=1` debug camera, px/s (T1.10 step 4). */
const DEBUG_PAN_SPEED = 600;

/**
 * GameScene — world, camera, terrain.
 *
 * T1.9/T1.10 scope: renders terrain from `MapData` and clamps the camera to the
 * map. Input, players, HUD and the live socket feed arrive in Phase 2+.
 */
export class GameScene extends Phaser.Scene {
  private terrain?: Terrain;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private debugCamera = false;

  constructor() {
    super({ key: 'GameScene' });
  }

  create(): void {
    const options = parseDevOptions(window.location.search);
    this.debugCamera = options.dev;

    // Until a server round supplies one (docs/06 §2 `round_started`), build a
    // dev map locally so any seed can be rendered offline.
    const map: MapData = buildDevMap(options.seed, options.scale);
    this.buildTerrain(map);

    if (this.debugCamera) {
      this.cursors = this.input.keyboard?.createCursorKeys();
      this.addDebugOverlay(map);
    }
  }

  /** (Re)build terrain from a `MapData` payload and clamp the camera to it. */
  buildTerrain(map: MapData): void {
    this.terrain?.destroy();
    const grid = TerrainGrid.fromMapData(map);
    this.terrain = new Terrain(this, grid);

    // docs/01 §1: camera bounds are the map's pixel size. World coordinates
    // are map pixels, so no scroll-factor games.
    this.cameras.main.setBounds(0, 0, grid.pixelWidth, grid.pixelHeight);
    this.cameras.main.centerOn(grid.pixelWidth / 2, grid.pixelHeight / 2);
  }

  update(_time: number, delta: number): void {
    if (!this.debugCamera || !this.cursors) {
      return;
    }
    // Arrow keys pan the camera; setBounds keeps it clamped at the edges.
    const step = (DEBUG_PAN_SPEED * delta) / 1000;
    const camera = this.cameras.main;
    if (this.cursors.left.isDown) {
      camera.scrollX -= step;
    }
    if (this.cursors.right.isDown) {
      camera.scrollX += step;
    }
    if (this.cursors.up.isDown) {
      camera.scrollY -= step;
    }
    if (this.cursors.down.isDown) {
      camera.scrollY += step;
    }
  }

  private addDebugOverlay(map: MapData): void {
    const text = [
      `seed=${map.seed} scale=${map.scale}`,
      `${map.width}x${map.height} tiles`,
      `tiles drawn: ${this.terrain?.spriteCount ?? 0}`,
      'arrows: pan camera',
    ].join('\n');
    this.add
      .text(8, 8, text, {
        font: '12px monospace',
        color: '#e0e0e0',
        backgroundColor: '#000000a0',
        padding: { x: 6, y: 4 },
      })
      .setScrollFactor(0)
      .setDepth(1000);
  }
}
