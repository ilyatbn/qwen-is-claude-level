import { beforeAll, describe, expect, it } from 'vitest'
import { Core, C } from '../core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { aimAngle, crosshairPos, packButtons, type KeyState } from './localInput-math'

// The bit values and AIM_* come from game-core, so the test loads the real wasm
// rather than asserting against numbers copied into TypeScript — which would make
// the test pass while the client and server disagreed.
beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
})

const none: KeyState = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false,
  fire: false,
  flashlight: false,
}

describe('packButtons', () => {
  it('maps each key to its documented bit', () => {
    const c = C()
    expect(packButtons({ ...none, left: true })).toBe(c.BTN_LEFT)
    expect(packButtons({ ...none, right: true })).toBe(c.BTN_RIGHT)
    expect(packButtons({ ...none, up: true })).toBe(c.BTN_UP)
    expect(packButtons({ ...none, down: true })).toBe(c.BTN_DOWN)
    expect(packButtons({ ...none, jump: true })).toBe(c.BTN_JUMP)
    expect(packButtons({ ...none, fire: true })).toBe(c.BTN_FIRE)
    expect(packButtons({ ...none, flashlight: true })).toBe(c.BTN_FLASHLIGHT)
  })

  it('sets both bits when left and right are held together', () => {
    // Cancelling them is move_dir's job in game-core. Doing it here as well would
    // mean two places to change and one of them would be forgotten.
    const c = C()
    expect(packButtons({ ...none, left: true, right: true })).toBe(c.BTN_LEFT | c.BTN_RIGHT)
  })

  it('never sets the reserved bit', () => {
    const all = packButtons({
      left: true,
      right: true,
      up: true,
      down: true,
      jump: true,
      fire: true,
      flashlight: true,
    })
    expect(all & 0x80).toBe(0)
  })
})

describe('aimAngle', () => {
  const p = { x: 1000, y: 500 }

  it('points right at 0 and down at +π/2', () => {
    expect(aimAngle(p, { x: p.x + 100, y: p.y }, 0)).toBeCloseTo(0, 6)
    // Screen space: +y is down.
    expect(aimAngle(p, { x: p.x, y: p.y + 100 }, 0)).toBeCloseTo(Math.PI / 2, 6)
  })

  it('points left at ±π', () => {
    // Asserted through cos/sin rather than the raw value, which may be +π or −π.
    const a = aimAngle(p, { x: p.x - 100, y: p.y }, 0)
    expect(Math.cos(a)).toBeCloseTo(-1, 6)
    expect(Math.abs(Math.sin(a))).toBeLessThan(1e-6)
  })

  it('holds the previous angle inside the deadzone', () => {
    // Without this the crosshair spins every time the cursor crosses the body.
    const prev = 1.2345
    expect(aimAngle(p, { x: p.x + 4, y: p.y }, prev)).toBe(prev)
    expect(aimAngle(p, { x: p.x, y: p.y - 4 }, prev)).toBe(prev)
  })

  it('updates just outside the deadzone', () => {
    const prev = 1.2345
    expect(aimAngle(p, { x: p.x + 12, y: p.y }, prev)).toBeCloseTo(0, 6)
  })

  it('is computed in world space, so camera scroll changes the answer', () => {
    // The trap from docs/22 §7, stated as a test: the same *screen* position maps
    // to a different world point once the camera has scrolled, and therefore to a
    // different angle. A screen-space implementation returns the same angle here
    // and is wrong everywhere except the map origin.
    const screen = { x: 640, y: 360 }
    const unscrolled = { x: screen.x, y: screen.y }
    const scrolled = { x: screen.x + 500, y: screen.y }
    const a1 = aimAngle(p, unscrolled, 0)
    const a2 = aimAngle(p, scrolled, 0)
    expect(a1).not.toBeCloseTo(a2, 3)
  })
})

describe('crosshairPos', () => {
  it('sits exactly AIM_RADIUS from the player for a sweep of angles', () => {
    const p = { x: 300, y: 200 }
    const r = C().AIM_RADIUS
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2 - Math.PI
      const q = crosshairPos(p, a)
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      expect(d).toBeCloseTo(r, 6)
    }
  })
})
