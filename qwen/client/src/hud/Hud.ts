import Phaser from 'phaser';
import { CROSSHAIR_RADIUS, crosshairPosition } from '../logic/aim';
import { uiTextureKey } from '../assets/manifest';
import {
  KILL_FEED_MAX,
  KillFeed,
  dayIcon,
  formatClock,
  roundRemainingS,
  scoreDelta,
} from '../logic/hudModel';
import type { HudView } from '../logic/inventoryModel';
import type { Kill } from '../protocol';

/** T5.4 step 2: the feed sits top-right. */
const FEED_LINE_HEIGHT = 16;

/**
 * HUD — crosshair, bars, round clock, day/night icon and kill feed (T5.4).
 *
 * The crosshair draws in world space so it tracks the player; everything else
 * is screen-fixed. All state and formatting come from `logic/aim.ts` and
 * `logic/hudModel.ts`, both Vitest-tested; this class only renders.
 *
 * docs/07 §5 wants the HUD non-blocking: nothing here takes input, so mouse
 * aim works over every part of it (T5.4 Acceptance).
 */
export class Hud {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly bars: Phaser.GameObjects.Graphics;
  private readonly text: Phaser.GameObjects.Text;
  private readonly clockText: Phaser.GameObjects.Text;
  private readonly feedTexts: Phaser.GameObjects.Text[] = [];
  private readonly panel?: Phaser.GameObjects.Image;
  private readonly feed = new KillFeed();
  private readonly scene: Phaser.Scene;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.graphics = scene.add.graphics().setDepth(500);
    // T5.4 step 3: the bar backing is a manifest UI texture when one exists,
    // and the drawn rect otherwise. With no assets present the placeholder is
    // itself a rect, so this is the same picture either way.
    const panelKey = uiTextureKey('panel');
    this.panel = scene.textures.exists(panelKey)
      ? scene.add
          .image(14, 12, panelKey)
          .setOrigin(0, 0)
          .setDisplaySize(190, 50)
          .setAlpha(0.75)
          .setScrollFactor(0)
          .setDepth(889)
      : undefined;
    this.bars = scene.add.graphics().setScrollFactor(0).setDepth(890);
    this.text = scene.add
      .text(16, 62, '', { font: '12px monospace', color: '#ffffff' })
      .setScrollFactor(0)
      .setDepth(891);
    // T5.4 step 1: top-centre clock + day/night icon.
    this.clockText = scene.add
      .text(0, 12, '', { font: '18px monospace', color: '#ffffff' })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(891);
    for (let i = 0; i < KILL_FEED_MAX; i += 1) {
      this.feedTexts.push(
        scene.add
          .text(0, 12 + i * FEED_LINE_HEIGHT, '', {
            font: '13px monospace',
            color: '#e8e8ee',
          })
          .setOrigin(1, 0)
          .setScrollFactor(0)
          .setDepth(891),
      );
    }
  }

  /** T5.4 step 1: `4:00  ☀`, centred at the top. */
  drawClock(roundTimeS: number, dayPhase: number): void {
    this.clockText.setPosition(this.scene.cameras.main.width / 2, 12);
    this.clockText.setText(`${formatClock(roundRemainingS(roundTimeS))}  ${dayIcon(dayPhase)}`);
  }

  /**
   * Record a kill for the feed, and float the score change if it is the local
   * player's (T5.4 steps 2 and 4).
   */
  pushKill(kill: Kill, nowS: number, localPlayerId: number, at?: { x: number; y: number }): void {
    this.feed.add(kill, nowS);
    const delta = scoreDelta(kill, localPlayerId);
    if (delta !== 0 && at !== undefined) {
      this.floatScore(delta, at.x, at.y);
    }
  }

  /** T5.4 step 4: `+1` / `−1` drifting up and fading. */
  private floatScore(delta: number, x: number, y: number): void {
    const label = this.scene.add
      .text(x, y - 20, delta > 0 ? '+1' : '−1', {
        font: '16px monospace',
        color: delta > 0 ? '#7ee081' : '#ff8080',
      })
      .setOrigin(0.5, 1)
      .setDepth(900);
    this.scene.tweens.add({
      targets: label,
      y: y - 60,
      alpha: 0,
      duration: 1200,
      onComplete: () => label.destroy(),
    });
  }

  /** Redraw the feed, fading each line over its last second (T5.4 step 2). */
  drawKillFeed(nowS: number): void {
    this.feed.prune(nowS);
    const visible = this.feed.visible(nowS);
    const right = this.scene.cameras.main.width - 16;
    for (const [i, label] of this.feedTexts.entries()) {
      const entry = visible[i];
      if (entry === undefined) {
        label.setText('');
        continue;
      }
      label.setPosition(right, 12 + i * FEED_LINE_HEIGHT);
      label.setText(entry.text);
      label.setAlpha(this.feed.alpha(entry, nowS));
    }
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
    this.clockText.destroy();
    this.panel?.destroy();
    for (const label of this.feedTexts) {
      label.destroy();
    }
  }
}
