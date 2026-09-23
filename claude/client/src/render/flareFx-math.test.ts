import { describe, expect, it } from 'vitest'
import { BurnTracker, GHOST, flareBounds, flareStrength, ribbonLength, ribbonOutline, strand, toLocal } from './flareFx-math'

/** An arch like the core's: `n` points, `span` wide, `height` tall, rising to -y. */
function arch(n: number, span: number, height: number, cx = 500, cy = 400): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1)
    out.push(cx + (u - 0.5) * span, cy - height * Math.sin(Math.PI * u))
  }
  return out
}

/** Even-odd point-in-polygon over a flat `[x0, y0, …]` ring. */
function inside(poly: number[], x: number, y: number): boolean {
  let hit = false
  const n = poly.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i]!
    const yi = poly[2 * i + 1]!
    const xj = poly[2 * j]!
    const yj = poly[2 * j + 1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

// Fixture geometry, not tunables: the shape the core's loop has, at a round size.
const PTS = arch(48, 300, 170)
const HW = 14

describe('ribbonOutline — one polygon round the ribbon, for the flat path (T22.08B)', () => {
  it('contains every sample point and the band around it', () => {
    const poly: number[] = []
    ribbonOutline(PTS, HW, poly)
    for (let i = 0; i < PTS.length; i += 2) {
      expect(inside(poly, PTS[i]!, PTS[i + 1]!), `sample ${i / 2}`).toBe(true)
    }
    // Across the band at the apex: in at 0.9 of the half-width, out at 1.1.
    const apex = PTS.length / 2
    const [x, y] = [PTS[apex]!, PTS[apex + 1]!]
    expect(inside(poly, x, y - HW * 0.9)).toBe(true)
    expect(inside(poly, x, y + HW * 0.9)).toBe(true)
    // The control: the same polygon excludes points just past the band.
    expect(inside(poly, x, y - HW * 1.1)).toBe(false)
    expect(inside(poly, x, y + HW * 1.1)).toBe(false)
  })

  it('rounds both ends outward, not back over the line', () => {
    const poly: number[] = []
    ribbonOutline(PTS, HW, poly)
    // Beyond each footpoint along the line's own direction there is ribbon…
    const tail = (i: number, j: number) => {
      const dx = PTS[2 * i]! - PTS[2 * j]!
      const dy = PTS[2 * i + 1]! - PTS[2 * j + 1]!
      const l = Math.hypot(dx, dy)
      return [PTS[2 * i]! + (dx / l) * HW * 0.8, PTS[2 * i + 1]! + (dy / l) * HW * 0.8] as const
    }
    const end = tail(47, 46)
    const start = tail(0, 1)
    expect(inside(poly, end[0], end[1])).toBe(true)
    expect(inside(poly, start[0], start[1])).toBe(true)
  })

  it('draws nothing for fewer than two points', () => {
    const poly = [1, 2, 3]
    ribbonOutline([10, 10], HW, poly)
    expect(poly).toEqual([])
  })
})

describe('flareBounds / toLocal — the shader quad (T22.08B)', () => {
  it('pads every point by the reach, and the local points land inside the quad', () => {
    const pad = 48
    const box = flareBounds(PTS, pad)!
    const local = new Float32Array(PTS.length)
    toLocal(PTS, box, local)
    for (let i = 0; i < local.length; i += 2) {
      expect(local[i]!).toBeGreaterThanOrEqual(pad - 1e-3)
      expect(local[i]!).toBeLessThanOrEqual(box.w - pad + 1e-3)
      expect(local[i + 1]!).toBeGreaterThanOrEqual(pad - 1e-3)
      expect(local[i + 1]!).toBeLessThanOrEqual(box.h - pad + 1e-3)
    }
    expect(flareBounds([], pad)).toBeNull()
  })

  it('measures the centre line', () => {
    expect(ribbonLength([0, 0, 3, 4, 3, 10])).toBeCloseTo(11, 6)
    // An arch is longer than its span and shorter than span + 2·height.
    const len = ribbonLength(PTS)
    expect(len).toBeGreaterThan(300)
    expect(len).toBeLessThan(300 + 2 * 170)
  })
})

describe('flareStrength — a ghost while it forms, full while it burns (T22.08B)', () => {
  const TELEGRAPH = 3
  it('is a ghost below GHOST in the telegraph, 1 while lit, 0 in the burn tail', () => {
    expect(flareStrength(0.5 * TELEGRAPH, TELEGRAPH, false)).toBeGreaterThan(0)
    expect(flareStrength(0.5 * TELEGRAPH, TELEGRAPH, false)).toBeLessThanOrEqual(GHOST)
    expect(flareStrength(TELEGRAPH + 1, TELEGRAPH, true)).toBe(1)
    // Past the telegraph and not lit: the ribbon has gone (T22.08C F1).
    expect(flareStrength(TELEGRAPH + 13, TELEGRAPH, false)).toBe(0)
  })
})

describe('strand — the flat path twisting threads (T22.08B)', () => {
  it('is pinned at the footpoints and leaves the line in between', () => {
    const out: number[] = []
    strand(PTS, 10, 0.3, 1.7, out)
    expect(out.length).toBe(PTS.length)
    expect(out[0]).toBeCloseTo(PTS[0]!, 6)
    expect(out[out.length - 1]).toBeCloseTo(PTS[PTS.length - 1]!, 6)
    let most = 0
    for (let i = 0; i < out.length; i++) most = Math.max(most, Math.abs(out[i]! - PTS[i]!))
    expect(most).toBeGreaterThan(3)
    expect(most).toBeLessThanOrEqual(10 + 1e-6)
  })
})

describe('BurnTracker — who is on fire, as the client can know it (T22.08B)', () => {
  it('writes the deadline on a touch and never stacks it (R79)', () => {
    const b = new BurnTracker()
    // The control: nobody burns before a touch.
    expect(b.burning(1, 0)).toBe(false)
    b.touch(1, 10, 4)
    expect(b.burning(1, 13.9)).toBe(true)
    b.touch(1, 11, 4)
    b.touch(1, 11, 4)
    // Rewritten: 11 + 4, not 10 + 4 + 4 + 4.
    expect(b.left(1, 11)).toBeCloseTo(4, 6)
    expect(b.burning(1, 15.01)).toBe(false)
    expect(b.burning(2, 12)).toBe(false)
  })

  it('a death or a new round clears it', () => {
    const b = new BurnTracker()
    b.touch(1, 0, 4)
    b.touch(2, 0, 4)
    b.clear(1)
    expect(b.burning(1, 1)).toBe(false)
    expect(b.burning(2, 1)).toBe(true)
    b.clearAll()
    expect(b.burning(2, 1)).toBe(false)
  })
})
