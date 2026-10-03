import { describe, expect, it } from 'vitest'
import {
  BLACK_HOLE_LIGHT,
  DISC_INCLINATION,
  DISC_INNER,
  DISC_TILT,
  NEAR_CLEAR,
  SHADE_INNER,
  SWALLOW_MS,
  SWALLOW_RGB,
  SWALLOW_SLOTS,
  SWALLOW_TURN,
  blackHoleLight,
  holeShade,
  swallowCentre,
  swallowStreaks,
} from './blackHole'

/** `black-hole`'s disc probes: the centre and 0.4 horizons along each axis must stay black (R90: the kill line). */
const PROBE = 0.4

/** The near side's disc radius (horizons, in the disc's plane) at a screen point p (horizons, y up) — the shader's. */
function rhoAt(px: number, py: number): number {
  const ct = Math.cos(DISC_TILT)
  const st = Math.sin(DISC_TILT)
  const qx = px * ct + py * st
  const qy = -px * st + py * ct
  return Math.hypot(qx, qy / DISC_INCLINATION)
}

describe('the black hole in the world renderer (T23.20 part C)', () => {
  it('keeps the disc in front of the shadow clear of every black-disc probe', () => {
    expect(NEAR_CLEAR).toBeGreaterThan(PROBE)
    for (const [x, y] of [[0, 0], [PROBE, 0], [-PROBE, 0], [0, PROBE], [0, -PROBE]] as const) {
      expect(rhoAt(x, y)).toBeLessThan(DISC_INNER)
    }
    // Control: the near band does cross the shadow's lower edge (the picture's look), so the bound above is not vacuous.
    expect(rhoAt(0, -0.9)).toBeGreaterThan(DISC_INNER)
  })

  it('maps the shadow to buffer px bottom up, as the night circles', () => {
    const c = holeShade({ x: 300, y: 200, horizon: 64 }, { x: 100, y: 100, w: 1280, h: 720 }, { w: 640, h: 360 })
    expect(c.x).toBeCloseTo(100)
    expect(c.y).toBeCloseTo(360 - 50)
    expect(c.outer).toBeCloseTo(32)
    expect(c.inner).toBeCloseTo(32 * SHADE_INNER)
  })

  it('is a light only while shown, as strong as it has swollen in', () => {
    expect(blackHoleLight(null)).toBeNull()
    expect(blackHoleLight({ x: 1, y: 2, growth: 1, hidden: true })).toBeNull()
    expect(blackHoleLight({ x: 1, y: 2, growth: 0, hidden: false })).toBeNull()
    expect(blackHoleLight({ x: 1, y: 2, growth: 0.5, hidden: false })?.i).toBeCloseTo(BLACK_HOLE_LIGHT.i / 2)
    expect(blackHoleLight({ x: 1, y: 2, growth: 1, hidden: false })).toMatchObject({ x: 1, y: 2, r: BLACK_HOLE_LIGHT.r })
  })
})

describe('the swallow (T23.38)', () => {
  const hole = { x: 400, y: 300 }
  it('ages each swallow over SWALLOW_MS, keeps the newest SWALLOW_SLOTS, and flips y up', () => {
    const list = Array.from({ length: SWALLOW_SLOTS + 2 }, (_, i) => ({ x: 464, y: 300 - i, what: 'mine', at: 1000 + i }))
    const now = 1000 + SWALLOW_MS / 2
    const s = swallowStreaks(list, hole, now)
    expect(s.length).toBe(SWALLOW_SLOTS)
    expect(s.at(-1)!.dy).toBe(SWALLOW_SLOTS + 1)
    expect(s[0]!.k).toBeCloseTo((now - (1000 + 2)) / SWALLOW_MS)
    expect(s[0]!.rgb).toEqual(SWALLOW_RGB['mine'])
    // Done after SWALLOW_MS; an unknown kind draws as loot.
    expect(swallowStreaks([{ x: 0, y: 0, what: '?', at: 0 }], hole, SWALLOW_MS)).toEqual([])
    expect(swallowStreaks([{ x: 0, y: 0, what: '?', at: 0 }], hole, 0)[0]!.rgb).toEqual(SWALLOW_RGB['item'])
  })

  it('puts the streak where the shader does: the horizon at k 0, turned and inward after, the centre at k 1', () => {
    const R = 64
    const crossed = { x: hole.x, y: hole.y - R }
    const start = swallowCentre(hole, crossed, 0, R)
    expect(start.x).toBeCloseTo(crossed.x)
    expect(start.y).toBeCloseTo(crossed.y)
    const mid = swallowCentre(hole, crossed, 0.5, R)
    expect(Math.hypot(mid.x - hole.x, mid.y - hole.y)).toBeCloseTo(R / 2)
    // Turned SWALLOW_TURN / 2 the disc's way: anticlockwise with y up, from the top.
    expect(Math.atan2(-(mid.y - hole.y), mid.x - hole.x)).toBeCloseTo(Math.PI / 2 + SWALLOW_TURN / 2)
    const end = swallowCentre(hole, crossed, 1, R)
    expect(end.x).toBeCloseTo(hole.x)
    expect(end.y).toBeCloseTo(hole.y)
  })
})
