/** T23.31: the volcanic embers (`embers.ts`) — the mockup's sparks, and the game's field as a pure function of view and time. */
import { describe, expect, it } from 'vitest'
import { ambientEmbers, emberSprites, mockupEmbers, MOCKUP_EMBERS, PER_CELL, CELL } from './embers'
import { emptyFrame } from './fx/kit'

describe('embers', () => {
  it("are the mockup's 90 sparks in its band, the same every call", () => {
    const a = mockupEmbers()
    expect(a).toHaveLength(MOCKUP_EMBERS)
    expect(mockupEmbers()).toEqual(a)
    for (const s of a) {
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThan(1280)
      expect(s.y).toBeGreaterThanOrEqual(200)
      expect(s.y).toBeLessThan(720)
    }
    // f_scene.js's first spark: q = 3 · 16807 = 50421, x = 50421 / (2³¹ − 1) · 1280.
    expect(a[0]!.x).toBeCloseTo((50421 / 2147483647) * 1280, 9)
  })

  it('the field is world-anchored: two overlapping views see the same sparks where they overlap', () => {
    const t = 12.5
    const a = ambientEmbers({ x: 0, y: 0, w: 1280, h: 720 }, t)
    const b = ambientEmbers({ x: 400, y: 100, w: 1280, h: 720 }, t)
    const inBoth = (s: { x: number; y: number }): boolean => s.x > 420 && s.x < 1260 && s.y > 120 && s.y < 700
    const key = (s: { x: number; y: number }): string => `${s.x.toFixed(4)},${s.y.toFixed(4)}`
    const ka = a.filter(inBoth).map(key).sort()
    expect(ka.length).toBeGreaterThan(20)
    expect(b.filter(inBoth).map(key).sort()).toEqual(ka)
  })

  it('moves with time and is the same at the same time', () => {
    const v = { x: 0, y: 0, w: 1280, h: 720 }
    expect(ambientEmbers(v, 3)).toEqual(ambientEmbers(v, 3))
    expect(ambientEmbers(v, 3)).not.toEqual(ambientEmbers(v, 3.5))
  })

  it("has F2's density, within a factor of two", () => {
    const n = ambientEmbers({ x: 0, y: 0, w: CELL * 10, h: CELL * 10 }, 7).length
    const per = n / 100
    expect(per).toBeGreaterThan(PER_CELL / 2)
    expect(per).toBeLessThan(PER_CELL * 2)
  })

  it('draws a glow and a core per visible spark', () => {
    const f = emptyFrame()
    emberSprites(f, [{ x: 1, y: 2, r: 1, a: 1 }, { x: 3, y: 4, r: 1, a: 0 }])
    expect(f.soft).toHaveLength(2)
  })
})
