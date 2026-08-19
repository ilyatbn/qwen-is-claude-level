import Phaser from 'phaser';
import { CROSSHAIR_RADIUS, crosshairPosition } from '../logic/aim';
import type { HudView } from '../logic/inventoryModel';

/**
 * HUD — crosshair for T2.8; health/shield/jetpack/ammo bars arrive in T3.9.
 *
 * The crosshair draws in world space so it tracks the player; the bars are
 * screen-fixed. All geometry comes from `logic/aim.ts` and
 * `logic/inventoryModel.ts`, both Vitest-tested; this class only renders.
 */
export class Hud {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly bars: Phaser.GameObjects.Graphics;
  private readonly text: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics().setDepth(500);
    this.bars = scene.add.graphics().setScrollFactor(0).setDepth(890);
    this.text = scene.add
      .text(16, 62, '', { font: '12px monospace', color: '#ffffff' })
      .setScrollFactor(0)
      .setDepth(891);
  }

  /**
   * Health, shield and jetpack bars plus the equipped weapon (T3.9 step 3).
   *
   * Health width is proportional to `health / max_health`, so an overcharged
   * player at 150/150 shows a FULL bar rather than one overflowing by 50%.
   */
  drawBars(view: HudView): void {
    const g = this.bars;
    g.clear();

    const x = 16;
    const width = 180;

    // Health.
    g.fillStyle(0x000000, 0.6);
    g.fillRect(x - 2, 14, width + 4, 14);
    g.fillStyle(0x3ac04a, 1);
    g.fillRect(x, 16, width * view.healthFraction, 10);

    // Jetpack fuel (5 s capacity).
    g.fillStyle(0x000000, 0.6);
    g.fillRect(x - 2, 32, width + 4, 10);
    g.fillStyle(0x4aa3f0, 1);
    g.fillRect(x, 34, width * view.jetpackFraction, 6);

    // Shield: a bar only while active.
    if (view.shieldActive) {
      g.fillStyle(0x000000, 0.6);
      g.fillRect(x - 2, 46, width + 4, 10);
      g.fillStyle(0xc9a227, 1);
      g.fillRect(x, 48, width * Math.min(1, view.shieldRemaining / 20), 6);
    }

    const weapon =
      view.weaponName === null
        ? 'no weapon'
        : `${view.weaponName}  x${view.weaponAmmo ?? 0}`;
    const shield = view.shieldActive ? `  shield ${view.shieldRemaining.toFixed(1)}s` : '';
    this.text.setText(
      `${Math.ceil(view.health)}/${Math.ceil(view.maxHealth)}  ${weapon}${shield}`,
    );
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
    this.bars.destroy();
    this.text.destroy();
  }
}
