import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Core, C } from '../core'
import { CameraRig } from './cameraRig'

const here = dirname(fileURLToPath(import.meta.url))
const wasmBytes = readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm'))

/** The parts of a Phaser camera the rig touches: its zoom, and where it was centred. */
function fakeCamera() {
  const cam = {
    zoom: 1,
    at: { x: 0, y: 0 },
    setZoom(z: number) {
      cam.zoom = z
      return cam
    },
    setBounds() {
      return cam
    },
    centerOn(x: number, y: number) {
      cam.at = { x, y }
      return cam
    },
  }
  return cam
}

describe('CameraRig at a live zoom (T99.04)', () => {
  beforeAll(async () => {
    await Core.init(wasmBytes)
  })

  it('a close-up reaches as near the floor as its own half-view, and the tuning zoom (the control) does not', () => {
    const c = C()
    const mapW = c.VIEWPORT_W * 4
    const mapH = c.VIEWPORT_H * 2
    const cam = fakeCamera()
    const rig = new CameraRig(cam as unknown as Phaser.Cameras.Scene2D.Camera, mapW, mapH)
    const floor = { x: mapW / 2, y: mapH }
    // The control: at the tuning's zoom the clamp keeps the tuning's half-view off the floor.
    rig.snapTo(floor)
    expect(cam.at.y).toBeCloseTo(mapH - c.VIEWPORT_H / c.CAMERA_ZOOM / 2, 5)
    const z = c.CAMERA_ZOOM * 3
    cam.setZoom(z)
    rig.snapTo(floor)
    expect(cam.at.y).toBeCloseTo(mapH - c.VIEWPORT_H / z / 2, 5)
    // And the per-frame step clamps the same way: following the floor does not drag it back up.
    rig.follow(floor)
    rig.update(1 / 60)
    expect(rig.center.y).toBeCloseTo(mapH - c.VIEWPORT_H / z / 2, 5)
  })

  /** A rig on a big map, settled at `from`, then told to follow `to` (far outside the deadzone). */
  function rigFollowing(from: { x: number; y: number }, to: { x: number; y: number }) {
    const c = C()
    const cam = fakeCamera()
    const rig = new CameraRig(cam as unknown as Phaser.Cameras.Scene2D.Camera, c.VIEWPORT_W * 8, c.VIEWPORT_H * 8)
    cam.setZoom(c.CAMERA_ZOOM)
    rig.snapTo(from)
    rig.follow(to)
    return rig
  }

  it('T23.35: follows as far in 0.4 s at 15 fps (and 5 fps) as at 60 fps, and a 60 fps frame still closes CAMERA_LERP', () => {
    const c = C()
    const from = { x: c.VIEWPORT_W * 2, y: c.VIEWPORT_H * 2 }
    const to = { x: from.x + c.VIEWPORT_W, y: from.y + c.VIEWPORT_H }
    // 60 fps feel unchanged: one 1/60 s frame closes exactly CAMERA_LERP of the gap to the deadzone edge.
    const one = rigFollowing(from, to)
    one.update(1 / 60)
    const want0 = to.x - c.CAMERA_DEADZONE_W / 2
    expect(one.center.x - from.x).toBeCloseTo((want0 - from.x) * c.CAMERA_LERP, 6)
    // The same 0.4 s at 60, 15 and 5 fps ends in the same place.
    const fast = rigFollowing(from, to)
    for (let i = 0; i < 24; i++) fast.update(1 / 60)
    const slow = rigFollowing(from, to)
    for (let i = 0; i < 6; i++) slow.update(1 / 15)
    const quarter = rigFollowing(from, to)
    for (let i = 0; i < 2; i++) quarter.update(1 / 5)
    expect(Math.abs(fast.center.x - from.x)).toBeGreaterThan((want0 - from.x) / 2) // ~95 % of the gap // it really moved
    for (const r of [slow, quarter]) {
      expect(r.center.x).toBeCloseTo(fast.center.x, 4)
      expect(r.center.y).toBeCloseTo(fast.center.y, 4)
    }
  })
})
