/**
 * Keyboard and mouse → the wire `Input`.
 *
 * Sampled **every frame**, never on key events. The wire format carries held state
 * (`docs/20-player-movement.md` §7); event-driven sampling loses "still held" and
 * produces a player who stops moving whenever nothing changes.
 */

import Phaser from 'phaser'
import { C, quantizeAngle } from '../core'
import { aimAngle, packButtons, type KeyState, type Vec } from './localInput-math'

export interface Input {
  seq: number
  buttons: number
  aim: number
}

export class LocalInput {
  private readonly scene: Phaser.Scene
  private readonly keys: Record<keyof KeyState, Phaser.Input.Keyboard.Key | undefined>
  private aim = 0
  private aimLocked = false

  constructor(scene: Phaser.Scene) {
    this.scene = scene
    const kb = scene.input.keyboard
    const K = Phaser.Input.Keyboard.KeyCodes
    const key = (code: number) => kb?.addKey(code, false)
    this.keys = {
      left: key(K.A),
      right: key(K.D),
      up: key(K.W),
      down: key(K.S),
      jump: key(K.SPACE),
      fire: undefined, // mouse
      flashlight: key(K.F),
    }
  }

  /** Held state this frame. */
  private keyState(): KeyState {
    const down = (k: Phaser.Input.Keyboard.Key | undefined) => k?.isDown ?? false
    return {
      left: down(this.keys.left),
      right: down(this.keys.right),
      up: down(this.keys.up),
      down: down(this.keys.down),
      jump: down(this.keys.jump),
      fire: this.scene.input.activePointer.leftButtonDown(),
      flashlight: down(this.keys.flashlight),
    }
  }

  /**
   * Sample the frame into the wire format.
   *
   * The pointer is converted to **world** coordinates first. Screen coordinates
   * work perfectly until the camera scrolls and then aim is silently wrong
   * everywhere except the origin (`docs/22-aiming-crosshair.md` §7).
   */
  sample(seq: number, playerCentre: Vec, camera: Phaser.Cameras.Scene2D.Camera): Input {
    const p = this.scene.input.activePointer
    const world = camera.getWorldPoint(p.x, p.y)
    if (!this.aimLocked) {
      this.aim = aimAngle(playerCentre, { x: world.x, y: world.y }, this.aim)
    }
    return {
      seq,
      buttons: packButtons(this.keyState()),
      // Quantised by game-core, because the server dequantises with the same code.
      aim: quantizeAngle(this.aim),
    }
  }

  /**
   * Point somewhere specific and **hold it**, for a headless check.
   *
   * A plain assignment does not survive: `sample()` recomputes the aim from the
   * pointer every frame, so the forced value is gone before the next input
   * packet leaves — which looked exactly like "firing does no damage".
   */
  forceAim(a: number): void {
    this.aim = a
    this.aimLocked = true
  }

  releaseAim(): void {
    this.aimLocked = false
  }

  get aimAngle(): number {
    return this.aim
  }

  destroy(): void {
    const kb = this.scene.input.keyboard
    for (const k of Object.values(this.keys)) if (k) kb?.removeKey(k)
  }
}

/** The aim ring and the crosshair riding it. */
export class Crosshair {
  private readonly ring: Phaser.GameObjects.Arc
  private readonly mark: Phaser.GameObjects.Container

  constructor(scene: Phaser.Scene, depth = 60) {
    const c = C()
    // The faint full ring is the visual cue that aim is angular, not positional.
    // **Off by default** (§C12). The ring is a development affordance; the
    // crosshair riding it is the aiming one. Starting it visible and having debug
    // mode hide it would mean a production build — which has no debug mode at
    // all (§C17) — shipped a ring nobody could turn off.
    this.ring = scene.add
      .circle(0, 0, c.AIM_RADIUS)
      .setStrokeStyle(1, 0xffffff, 0.18)
      .setDepth(depth)
      .setVisible(false)

    const h = scene.add.rectangle(0, 0, 9, 1, 0xffffff, 0.9)
    const v = scene.add.rectangle(0, 0, 1, 9, 0xffffff, 0.9)
    this.mark = scene.add.container(0, 0, [h, v]).setDepth(depth)
  }

  update(playerX: number, playerY: number, aim: number): void {
    const r = C().AIM_RADIUS
    this.ring.setPosition(playerX, playerY)
    this.mark.setPosition(playerX + Math.cos(aim) * r, playerY + Math.sin(aim) * r)
  }

  setVisible(v: boolean): void {
    this.ring.setVisible(v)
    this.mark.setVisible(v)
  }

  /**
   * §C12: the **ring** is a development affordance and is off in a normal game;
   * the crosshair riding it is the aiming affordance and stays.
   *
   * Separate from `setVisible` on purpose — that one is "hide the whole thing",
   * used when the player is dead, and folding the two together would make a
   * corpse's crosshair reappear the moment debug mode was turned on.
   */
  setRingVisible(v: boolean): void {
    this.ring.setVisible(v)
  }

  destroy(): void {
    this.ring.destroy()
    this.mark.destroy(true)
  }
}
