import { describe, expect, it } from 'vitest'
import { BLACK_HOLE_LIGHT, DISC_INCLINATION, DISC_INNER, DISC_TILT, NEAR_CLEAR, SHADE_INNER, blackHoleLight, holeShade } from './blackHole'

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
