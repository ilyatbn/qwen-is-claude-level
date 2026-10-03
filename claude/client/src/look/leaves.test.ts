import { describe, expect, it } from 'vitest'
import { FG_SPOTS } from './atmosphere'
import { LEAF_N, LEAF_R, LEAF_REACH, LEAF_SINK, LEAF_STRIP, leafClusters, occluderBox, visibleSpots } from './leaves'

/** A test map: rock below a sloped surface `y = top + x / 8`, nothing above it; `voidFrom` makes a gap with no rock. */
function ground(w: number, h: number, top: number, voidFrom = Infinity, voidTo = -Infinity) {
  const surfaceAt = (x: number): number => top + Math.floor(x / 8)
  const solidAt = (x: number, y: number): boolean => !(x >= voidFrom && x < voidTo) && y >= surfaceAt(x) && y < h
  return { w, h, solidAt, surfaceAt }
}

describe('leafClusters (T23.08B)', () => {
  const m = ground(LEAF_STRIP * 4, 1600, 600)

  it('is a function of the seed and the map: same in, same out; another seed moves them', () => {
    const a = leafClusters(7, m.w, m.h, m.solidAt)
    expect(leafClusters(7, m.w, m.h, m.solidAt)).toEqual(a)
    const b = leafClusters(8, m.w, m.h, m.solidAt)
    expect(b.map((s) => s.x)).not.toEqual(a.map((s) => s.x))
  })

  it('puts one cluster in every frame-wide strip, sized from F1’s range, just under the surface', () => {
    const spots = leafClusters(11, m.w, m.h, m.solidAt)
    expect(spots).toHaveLength(4)
    spots.forEach((s, i) => {
      expect(s.x).toBeGreaterThanOrEqual(i * LEAF_STRIP)
      expect(s.x).toBeLessThan((i + 1) * LEAF_STRIP)
      expect(s.r).toBeGreaterThanOrEqual(LEAF_R[0])
      expect(s.r).toBeLessThanOrEqual(LEAF_R[1])
      expect(LEAF_N).toContain(s.n)
      // The surface is found on a 4-px scan: within a step of the true one, then sunk by LEAF_SINK radii.
      const sunk = s.y - Math.round(s.r * LEAF_SINK)
      expect(Math.abs(sunk - m.surfaceAt(s.x))).toBeLessThanOrEqual(4)
      expect(m.solidAt(s.x, sunk)).toBe(true)
      expect(m.solidAt(s.x, sunk - 5)).toBe(false)
    })
  })

  it('places no cluster in a strip whose column has no rock', () => {
    const gap = ground(LEAF_STRIP * 2, 1600, 600, LEAF_STRIP, LEAF_STRIP * 2)
    const spots = leafClusters(3, gap.w, gap.h, gap.solidAt)
    expect(spots).toHaveLength(1)
    expect(spots[0]!.x).toBeLessThan(LEAF_STRIP)
  })
})

describe('visibleSpots (T23.08B)', () => {
  const view = { x: 1000, y: 500, w: 1280, h: 720 }
  const at = (x: number, y: number) => ({ x, y, r: 100, n: 9 })

  it('keeps the clusters that reach into the view, nearest its centre first, at most the shader’s slots', () => {
    const centre = at(1640, 860)
    const edge = at(1000 - 100 * LEAF_REACH + 1, 860) // reaches in by a pixel
    const out = at(1000 - 100 * LEAF_REACH - 1, 860) // stops a pixel short
    expect(visibleSpots([edge, out, centre], view, FG_SPOTS)).toEqual([centre, edge])
    const many = Array.from({ length: 10 }, (_, i) => at(1100 + i * 100, 860))
    const picked = visibleSpots(many, view, FG_SPOTS)
    expect(picked).toHaveLength(FG_SPOTS)
    const d = (s: { x: number; y: number }) => Math.hypot(s.x - 1640, s.y - 860)
    for (let i = 1; i < picked.length; i++) expect(d(picked[i]!)).toBeGreaterThanOrEqual(d(picked[i - 1]!))
  })
})

describe('occluderBox (T23.08B)', () => {
  it('is the drawn figure around the body centre, wider and taller than the hitbox', () => {
    const [x0, y0, x1, y1] = occluderBox(100, 200, 16, 28)
    expect(x0 < 100 - 8 && x1 > 100 + 8 && y0 < 200 - 14 && y1 > 200 + 14).toBe(true)
    expect((x0 + x1) / 2).toBe(100)
    expect((y0 + y1) / 2).toBe(200)
  })
})
