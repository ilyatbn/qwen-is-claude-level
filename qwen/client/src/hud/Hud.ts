import Phaser from 'phaser';
import { CROSSHAIR_RADIUS, crosshairPosition } from '../logic/aim';

/**
 * HUD — crosshair for T2.8; health/shield/jetpack/ammo bars arrive in T3.9.
 *
 * Draws in world space so the crosshair tracks the player. All geometry comes
 * from `logic/aim.ts`, which is Vitest-tested; this class only renders.
 */
export class Hud {
  private readonly graphics: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics().setDepth(500);
  }

  /**
   * Redraw the crosshair: a faint ring of radius 60 around the player, with a
   * cross at the aim point on that ring (docs/03 §8, docs/07 §5).
   */
  drawCrosshair(playerX: number, playerY: number, angle: number): void {
    const g = this.graphics;
    g.clear();

    // The ring is "a visual aid only" (docs/03 §8).
    g.lineStyle(1, 0xffffff, 0.25);
    g.strokeCircle(playerX, playerY, CROSSHAIR_RADIUS);

    const { x, y } = crosshairPosition(playerX, playerY, angle);
    g.lineStyle(2, 0xffffff, 0.9);
    const arm = 5;
    g.beginPath();
    g.moveTo(x - arm, y);
    g.lineTo(x + arm, y);
    g.moveTo(x, y - arm);
    g.lineTo(x, y + arm);
    g.strokePath();
  }

  destroy(): void {
    this.graphics.destroy();
  }
}
