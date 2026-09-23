import { describe, expect, it } from 'vitest'
import { hullRadius, plumeDir, plumeOn } from './thrusterPlume-math'

describe('plumeDir', () => {
  it('fires from above when you travel down — the owner’s sentence', () => {
    const d = plumeDir(0, 200, 1)
    expect(d.y).toBeLessThan(0)
    expect(Math.abs(d.x)).toBeLessThan(1e-9)
  })

  it('is the negated, normalised velocity on every axis', () => {
    // Up, left, right and a diagonal: a sign slip on one axis shows here and
    // nowhere else, because each case only exercises its own component.
    for (const [vx, vy] of [
      [0, -150],
      [-90, 0],
      [260, 0],
      [120, -160],
    ] as const) {
      const d = plumeDir(vx, vy, 1)
      const s = Math.hypot(vx, vy)
      expect(d.x).toBeCloseTo(-vx / s, 9)
      expect(d.y).toBeCloseTo(-vy / s, 9)
      expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 9)
    }
  })

  it('points down from rest — the exhaust of the lift-off R42 allows', () => {
    expect(plumeDir(0, 0, 1)).toEqual({ x: 0, y: 1 })
    // At the threshold, not only at zero: a body creeping at 0.5 px/s has no
    // direction worth drawing, and NaN from a 0/0 must never reach a rotation.
    expect(plumeDir(0.5, 0, 1)).toEqual({ x: 0, y: 1 })
    expect(plumeDir(Number.NaN, 0, 1)).toEqual({ x: 0, y: 1 })
  })
})

describe('hullRadius', () => {
  it('is the semi-axis along each axis and in between on a diagonal', () => {
    expect(hullRadius({ x: 0, y: -1 }, 8, 14)).toBeCloseTo(14, 9)
    expect(hullRadius({ x: 1, y: 0 }, 8, 14)).toBeCloseTo(8, 9)
    const diag = hullRadius({ x: Math.SQRT1_2, y: Math.SQRT1_2 }, 8, 14)
    expect(diag).toBeGreaterThan(8)
    expect(diag).toBeLessThan(14)
  })
})

describe('plumeOn', () => {
  it('needs all three: alive, the pack firing, and space', () => {
    expect(plumeOn(true, true, true)).toBe(true)
    // Each one alone off turns it off — a corpse, an idle drifter, and the
    // shipped jetpack under gravity, whose push does not follow velocity.
    expect(plumeOn(false, true, true)).toBe(false)
    expect(plumeOn(true, false, true)).toBe(false)
    expect(plumeOn(true, true, false)).toBe(false)
  })
})
