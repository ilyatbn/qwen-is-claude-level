import Phaser from 'phaser';
import { PLAYER_COLOURS } from '../scenes/BootScene';
import type { RenderState } from '../logic/interpolation';

/** Player body size, px (docs/07 §5; DEVIATIONS D6). */
export const BODY_WIDTH = 24;
export const BODY_HEIGHT = 28;
/** Weapon stub, px (docs/07 §5: "10×4 rect at aim angle"). */
const WEAPON_LENGTH = 10;
const WEAPON_THICKNESS = 4;

/**
 * A rendered player: placeholder rect, weapon stub at the aim angle, and a
 * name label (T2.9 step 2, docs/07 §5).
 *
 * Purely presentational — position comes from `logic/interpolation.ts`, which
 * is Vitest-tested. T5.3 swaps the rect for a skin texture.
 */
export class PlayerSprite {
  private readonly body: Phaser.GameObjects.Rectangle;
  private readonly weapon: Phaser.GameObjects.Rectangle;
  private readonly label: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, id: number, name: string) {
    const colour = PLAYER_COLOURS[id % PLAYER_COLOURS.length] ?? 0xffffff;

    this.body = scene.add
      .rectangle(0, 0, BODY_WIDTH, BODY_HEIGHT, colour)
      .setDepth(100);
    this.weapon = scene.add
      .rectangle(0, 0, WEAPON_LENGTH, WEAPON_THICKNESS, 0x222222)
      .setOrigin(0, 0.5)
      .setDepth(101);
    this.label = scene.add
      .text(0, 0, name, { font: '10px monospace', color: '#ffffff' })
      .setOrigin(0.5, 1)
      .setDepth(102);
  }

  /** Move to an interpolated render state. */
  update(state: RenderState): void {
    this.body.setPosition(state.x, state.y);
    this.weapon.setPosition(state.x, state.y);
    // Screen y grows downward, protocol angles are CCW positive (docs/06).
    this.weapon.setRotation(-state.facing);
    this.label.setPosition(state.x, state.y - BODY_HEIGHT / 2 - 2);
  }

  setVisible(visible: boolean): void {
    this.body.setVisible(visible);
    this.weapon.setVisible(visible);
    this.label.setVisible(visible);
  }

  destroy(): void {
    this.body.destroy();
    this.weapon.destroy();
    this.label.destroy();
  }
}
