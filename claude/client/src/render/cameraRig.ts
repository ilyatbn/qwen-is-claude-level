/**
 * The Phaser side of the camera. All the rules live in `cameraRig-math.ts`.
 *
 * §A1: the camera zooms to `CAMERA_ZOOM` (2.0), so the visible world is 640 × 360
 * and the map is something you explore rather than something you see at once.
 */

import { C } from '../core'
import {
  Trauma,
  clampCenter,
  desiredCenter,
  stepCenter,
  stepLookahead,
  visibleSize,
  type CameraTuning,
  type Vec,
} from './cameraRig-math'

export function tuningFromConstants(): CameraTuning {
  const c = C()
  return {
    viewportW: c.VIEWPORT_W,
    viewportH: c.VIEWPORT_H,
    zoom: c.CAMERA_ZOOM,
    lerp: c.CAMERA_LERP,
    deadzoneW: c.CAMERA_DEADZONE_W,
    deadzoneH: c.CAMERA_DEADZONE_H,
    lookahead: c.CAMERA_LOOKAHEAD,
    lookaheadLerp: c.CAMERA_LOOKAHEAD_LERP,
  }
}

export class CameraRig {
  private readonly camera: Phaser.Cameras.Scene2D.Camera
  private readonly tuning: CameraTuning
  private readonly mapW: number
  private readonly mapH: number
  private readonly trauma = new Trauma()

  private target: Vec | null = null
  private aim: number | null = null
  private lookahead: Vec = { x: 0, y: 0 }
  private phase = 0

  center: Vec

  constructor(camera: Phaser.Cameras.Scene2D.Camera, mapW: number, mapH: number) {
    this.camera = camera
    this.tuning = tuningFromConstants()
    this.mapW = mapW
    this.mapH = mapH

    this.camera.setZoom(this.tuning.zoom)
    this.camera.setBounds(0, 0, mapW, mapH)
    this.center = clampCenter({ x: mapW / 2, y: mapH / 2 }, mapW, mapH, this.tuning)
    this.camera.centerOn(this.center.x, this.center.y)
  }

  /** The world area actually visible, at the current zoom. */
  get visible(): { w: number; h: number } {
    return visibleSize(this.tuning)
  }

  follow(target: Vec): void {
    this.target = target
  }

  /** Aim angle in radians, or null for no lookahead. */
  setAim(angle: number | null): void {
    this.aim = angle
  }

  shake(intensity: number): void {
    this.trauma.add(intensity)
  }

  /** Jump straight to a position, for a respawn or a map change. */
  snapTo(p: Vec): void {
    this.center = clampCenter(p, this.mapW, this.mapH, this.tuning)
    this.camera.centerOn(this.center.x, this.center.y)
  }

  update(dt: number): void {
    this.phase += 1
    if (this.target) {
      this.lookahead = stepLookahead(this.lookahead, this.aim, this.tuning)
      const want = desiredCenter(this.center, this.target, this.lookahead, this.tuning)
      this.center = clampCenter(
        stepCenter(this.center, want, this.tuning.lerp),
        this.mapW,
        this.mapH,
        this.tuning,
      )
    }
    this.trauma.decay(dt)

    const shake = this.trauma.offset(12, this.phase)
    this.camera.centerOn(this.center.x + shake.x, this.center.y + shake.y)
  }

  get traumaLevel(): number {
    return this.trauma.level
  }
}
