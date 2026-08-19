import Phaser from 'phaser';
import { PLAYER_COLOURS } from '../assets/placeholders';
import { playerTextureKey } from '../assets/manifest';
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
 * is Vitest-tested.
 *
 * T5.3 step 3: the body is the `player_<skin>` texture, falling back to the
 * id-coloured rect if that key has no texture at all. docs/07 §5's
 * "color per player id" rule is explicitly labelled *pre-T5.1*, so the skin
 * texture supersedes it once one exists.
 */
export class PlayerSprite {
  private readonly scene: Phaser.Scene;
  private body: Phaser.GameObjects.Rectangle | Phaser.GameObjects.Image;
  private readonly weapon: Phaser.GameObjects.Rectangle;
  private readonly label: Phaser.GameObjects.Text;
  private readonly id: number;
  private skin: number;

  constructor(scene: Phaser.Scene, id: number, name: string, skin = 0) {
    this.scene = scene;
    this.id = id;
    this.skin = skin;
    this.body = PlayerSprite.makeBody(scene, id, skin);
    this.weapon = scene.add
      .rectangle(0, 0, WEAPON_LENGTH, WEAPON_THICKNESS, 0x222222)
      .setOrigin(0, 0.5)
      .setDepth(101);
    this.label = scene.add
      .text(0, 0, name, { font: '10px monospace', color: '#ffffff' })
      .setOrigin(0.5, 1)
      .setDepth(102);
  }

  /** The body for a skin: its texture, or the id-coloured rect (T5.3 step 3). */
  private static makeBody(
    scene: Phaser.Scene,
    id: number,
    skin: number,
  ): Phaser.GameObjects.Rectangle | Phaser.GameObjects.Image {
    const key = playerTextureKey(skin);
    if (scene.textures.exists(key)) {
      return scene.add.image(0, 0, key).setDisplaySize(BODY_WIDTH, BODY_HEIGHT).setDepth(100);
    }
    const colour = PLAYER_COLOURS[id % PLAYER_COLOURS.length] ?? 0xffffff;
    return scene.add.rectangle(0, 0, BODY_WIDTH, BODY_HEIGHT, colour).setDepth(100);
  }

  /**
   * Swap the body when a player changes skin mid-session (docs/07 §4: the
   * choice is made in the lobby, but `PlayerSnap.skin` carries it every
   * snapshot, so a change must be picked up rather than fixed at spawn).
   */
  setSkin(skin: number): void {
    if (skin === this.skin) {
      return;
    }
    this.skin = skin;
    const visible = this.body.visible;
    const { x, y } = this.body;
    this.body.destroy();
    this.body = PlayerSprite.makeBody(this.scene, this.id, skin);
    this.body.setPosition(x, y).setVisible(visible);
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
