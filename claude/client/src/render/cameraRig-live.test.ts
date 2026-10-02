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
})
