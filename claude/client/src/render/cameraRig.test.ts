import { describe, it, expect } from 'vitest'
import {
  Trauma,
  TRAUMA_DECAY,
  clampCenter,
  desiredCenter,
  stepCenter,
  stepLookahead,
  visibleSize,
  type CameraTuning,
} from './cameraRig-math'

/** The real values, per docs/02-constants.md and A1. */
const T: CameraTuning = {
  viewportW: 1280,
  viewportH: 720,
  zoom: 2,
  lerp: 0.12,
  deadzoneW: 120,
  deadzoneH: 90,
  lookahead: 70,
  lookaheadLerp: 0.06,
}

describe('zoom', () => {
  it('shows 640x360 of world at CAMERA_ZOOM 2', () => {
    expect(visibleSize(T)).toEqual({ w: 640, h: 360 })
  })
})

describe('clampCenter', () => {
  it('keeps the view inside the map', () => {
    const mapW = 4096
    const mapH = 2048
    expect(clampCenter({ x: 0, y: 0 }, mapW, mapH, T)).toEqual({ x: 320, y: 180 })
    expect(clampCenter({ x: 9999, y: 9999 }, mapW, mapH, T)).toEqual({
      x: mapW - 320,
      y: mapH - 180,
    })
  })

  it('leaves a centre well inside the map alone', () => {
    expect(clampCenter({ x: 2000, y: 1000 }, 4096, 2048, T)).toEqual({ x: 2000, y: 1000 })
  })

  it('uses the ZOOMED viewport, not the design resolution', () => {
    // With the design resolution the clamp would be 640/360; at zoom 2 it is
    // 320/180. Clamping with the unzoomed size shows a screen of nothing past the
    // map edge.
    expect(clampCenter({ x: 0, y: 0 }, 4096, 2048, T).x).toBe(320)
    expect(clampCenter({ x: 0, y: 0 }, 4096, 2048, { ...T, zoom: 1 }).x).toBe(640)
  })

  it('centres on a map smaller than the view instead of wedging it into a corner', () => {
    const small = clampCenter({ x: 0, y: 0 }, 400, 200, T)
    expect(small).toEqual({ x: 200, y: 100 })
  })
})

describe('follow', () => {
  it('moves exactly CAMERA_LERP of the way in one step', () => {
    const next = stepCenter({ x: 0, y: 0 }, { x: 100, y: 200 }, T.lerp)
    expect(next.x).toBeCloseTo(12, 6)
    expect(next.y).toBeCloseTo(24, 6)
  })

  it('converges on the target', () => {
    let center = { x: 0, y: 0 }
    const target = { x: 1000, y: 500 }
    for (let i = 0; i < 400; i++) {
      const want = desiredCenter(center, target, { x: 0, y: 0 }, T)
      center = stepCenter(center, want, T.lerp)
    }
    // The deadzone means it converges to within half a deadzone, not exactly.
    expect(Math.abs(center.x - target.x)).toBeLessThanOrEqual(T.deadzoneW / 2 + 1)
    expect(Math.abs(center.y - target.y)).toBeLessThanOrEqual(T.deadzoneH / 2 + 1)
  })

  it('holds still while the target stays inside the deadzone', () => {
    const center = { x: 1000, y: 500 }
    const want = desiredCenter(center, { x: 1040, y: 520 }, { x: 0, y: 0 }, T)
    expect(want).toEqual(center)
  })

  it('tracks the deadzone edge once the target leaves it', () => {
    const center = { x: 1000, y: 500 }
    const want = desiredCenter(center, { x: 1200, y: 500 }, { x: 0, y: 0 }, T)
    // Target 200 px right; the camera wants to sit half a deadzone behind it.
    expect(want.x).toBe(1200 - T.deadzoneW / 2)
    expect(want.y).toBe(500)
  })

  it('never leaves the map when following a target in a corner', () => {
    let center = { x: 2000, y: 1000 }
    const target = { x: 0, y: 0 }
    for (let i = 0; i < 500; i++) {
      const want = desiredCenter(center, target, { x: 0, y: 0 }, T)
      center = clampCenter(stepCenter(center, want, T.lerp), 4096, 2048, T)
      expect(center.x).toBeGreaterThanOrEqual(320)
      expect(center.y).toBeGreaterThanOrEqual(180)
    }
  })
})

describe('lookahead', () => {
  it('eases toward the aim direction and never snaps', () => {
    let look = { x: 0, y: 0 }
    const first = stepLookahead(look, 0, T)
    expect(first.x).toBeCloseTo(70 * T.lookaheadLerp, 6)

    look = { x: 0, y: 0 }
    for (let i = 0; i < 500; i++) look = stepLookahead(look, 0, T)
    expect(look.x).toBeCloseTo(70, 3)
    expect(look.y).toBeCloseTo(0, 3)
  })

  it('returns to zero when there is no aim', () => {
    let look = { x: 70, y: 0 }
    for (let i = 0; i < 500; i++) look = stepLookahead(look, null, T)
    expect(look.x).toBeCloseTo(0, 3)
  })

  it('points the lead the way the player aims', () => {
    let look = { x: 0, y: 0 }
    for (let i = 0; i < 500; i++) look = stepLookahead(look, Math.PI, T)
    expect(look.x).toBeCloseTo(-70, 3)
  })
})

describe('Trauma', () => {
  it('is zero-offset at rest', () => {
    const t = new Trauma()
    expect(t.level).toBe(0)
    expect(t.offset(10, 1)).toEqual({ x: 0, y: 0 })
  })

  it('accumulates additively and caps at 1', () => {
    const t = new Trauma()
    t.add(0.3)
    expect(t.level).toBeCloseTo(0.3, 6)
    for (let i = 0; i < 20; i++) t.add(0.3)
    expect(t.level).toBe(1)
  })

  it('decays to zero within about 0.4 s', () => {
    const t = new Trauma()
    t.add(1)
    // Exactly 0.4 s of ticks sums to 0.99999... rather than 1.0, leaving a float
    // sliver, so give it one more tick.
    const dt = 1 / 60
    for (let i = 0; i < Math.ceil(0.4 / dt) + 1; i++) t.decay(dt)
    expect(t.level).toBe(0)
    // And it should not have decayed much faster than the documented rate.
    const u = new Trauma()
    u.add(1)
    u.decay(0.1)
    expect(u.level).toBeCloseTo(1 - TRAUMA_DECAY * 0.1, 6)
  })

  it('squares the trauma so small shakes stay subtle', () => {
    const small = new Trauma()
    small.add(0.2)
    const big = new Trauma()
    big.add(0.4)
    const s = Math.abs(small.offset(10, 3).x)
    const b = Math.abs(big.offset(10, 3).x)
    // Twice the trauma is four times the offset.
    expect(b / s).toBeCloseTo(4, 4)
  })

  it('is deterministic for a given phase', () => {
    const a = new Trauma()
    a.add(0.5)
    const b = new Trauma()
    b.add(0.5)
    expect(a.offset(10, 42)).toEqual(b.offset(10, 42))
  })
})
