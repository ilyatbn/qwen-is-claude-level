import { describe, expect, it } from 'vitest'
import { exhaustDir, hullRadius, plumeDir, plumeOn } from './thrusterPlume-math'

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

describe('exhaustDir (T22.04C)', () => {
  it('braking: drifting right, pushed left, the exhaust is on the right', () => {
    const d = exhaustDir({ x: -1100, y: 0 }, 200, 0, 1)
    expect(d.x).toBeCloseTo(1)
    expect(d.y).toBeCloseTo(0)
    // Control: the velocity rule alone points it the other way.
    expect(plumeDir(200, 0, 1).x).toBeCloseTo(-1)
  })

  it('climbing out of a well while still falling: the exhaust is below', () => {
    expect(exhaustDir({ x: 0, y: -2200 }, 0, 150, 1).y).toBeCloseTo(1)
  })

  it('the unequal axes survive: UP + RIGHT is not a 45° plume', () => {
    const d = exhaustDir({ x: 1100, y: -2200 }, 0, 0, 1)
    expect(d.x).toBeCloseTo(-1100 / Math.hypot(1100, 2200))
    expect(d.y).toBeCloseTo(2200 / Math.hypot(1100, 2200))
  })

  it('no thrust known (a remote) or none held: the velocity rule, unchanged', () => {
    expect(exhaustDir(null, 120, -160, 1)).toEqual(plumeDir(120, -160, 1))
    expect(exhaustDir({ x: 0, y: 0 }, 120, -160, 1)).toEqual(plumeDir(120, -160, 1))
  })
})
