/**
 * T23.24: the fireflies' arithmetic — seeded placement (same every run, near rock, few in open sky, none in rock),
 * the paths (they move, they stay near home), the glint (pulses over a floor) and the fade with the hour.
 */
import { describe, expect, it } from 'vitest'
import {
  FIREFLY_DENSITY,
  FIREFLY_FADE,
  FIREFLY_GLINT_FLOOR,
  FIREFLY_NEAR_MAX,
  FIREFLY_NEAR_MIN,
  FIREFLY_OPEN_KEEP,
  FIREFLY_PERIOD,
  FIREFLY_REACH,
  fieldSampler,
  fireflyAt,
  fireflyFade,
  glintAt,
  keepHome,
  placeFireflies,
  type FieldSample,
} from './fireflies'

const W = 2000
const H = 1000
const SEEDS = [1, 7, 42, 4242, 90210, 0xdeadbeef]
const want = Math.round((W * H * FIREFLY_DENSITY) / 1e6)

/** Rock below `ground`; air above it gets its distance to the ground (capped at 64), a cave wall in one box. */
const terrain = (ground: number) => (x: number, y: number): FieldSample | null => {
  if (x < 0 || y < 0 || x >= W || y >= H) return null
  if (y >= ground) return { dOut: 0, back: false }
  const inCave = x > 1500 && x < 1700 && y > ground - 200
  return { dOut: Math.min(64, ground - y), back: inCave }
}

describe('placeFireflies', () => {
  it('is the same swarm for the same seed, and a different one for another', () => {
    const a = placeFireflies(4242, W, H, terrain(600))
    const b = placeFireflies(4242, W, H, terrain(600))
    const c = placeFireflies(4243, W, H, terrain(600))
    expect(a.length).toBeGreaterThan(0)
    expect(b).toEqual(a)
    expect(c).not.toEqual(a)
  })

  it('wants FIREFLY_DENSITY per million px² — all of them where every candidate is kept', () => {
    const allNear = (): FieldSample => ({ dOut: (FIREFLY_NEAR_MIN + FIREFLY_NEAR_MAX) / 2, back: false })
    for (const s of SEEDS) expect(placeFireflies(s, W, H, allNear).length).toBe(want)
  })

  it('puts none in rock, and an all-rock map yields none (and ends)', () => {
    const rock = (): FieldSample => ({ dOut: 0, back: false })
    for (const s of SEEDS) expect(placeFireflies(s, W, H, rock)).toEqual([])
    for (const s of SEEDS) {
      for (const f of placeFireflies(s, W, H, terrain(600))) expect(f.hy).toBeLessThan(600 - FIREFLY_NEAR_MIN)
    }
  })

  it('keeps most near rock and few in open sky (across seeds)', () => {
    // Ground at 600: the near band (10–56 px over it) is 46 rows of 600 air rows; open sky ≥ 64 px is ~536.
    let near = 0
    let open = 0
    for (const s of SEEDS) {
      for (const f of placeFireflies(s, W, H, terrain(600))) {
        const d = 600 - f.hy
        if (d <= FIREFLY_NEAR_MAX || (f.hx > 1500 && f.hx < 1700 && f.hy > 400)) near++
        else if (d >= 64) open++
      }
    }
    // By area alone open sky would hold ~10× the near band; the keep rule turns that round.
    expect(near).toBeGreaterThan(open)
    expect(open).toBeGreaterThan(0)
  })

  it('keepHome: rock and the rock edge never, near and cave wall always, open sky at FIREFLY_OPEN_KEEP', () => {
    expect(keepHome(null, 0)).toBe(false)
    expect(keepHome({ dOut: 0, back: true }, 0)).toBe(false)
    expect(keepHome({ dOut: FIREFLY_NEAR_MIN - 1, back: false }, 0)).toBe(false)
    expect(keepHome({ dOut: FIREFLY_NEAR_MIN, back: false }, 0.99)).toBe(true)
    expect(keepHome({ dOut: 64, back: true }, 0.99)).toBe(true)
    expect(keepHome({ dOut: 64, back: false }, FIREFLY_OPEN_KEEP - 0.01)).toBe(true)
    expect(keepHome({ dOut: 64, back: false }, FIREFLY_OPEN_KEEP + 0.01)).toBe(false)
  })

  it('fieldSampler reads dOut from G (4 per px) and back from B', () => {
    const v = new Uint8Array(2 * 1 * 4)
    v.set([0, 40, 200, 0], 4)
    const s = fieldSampler(v, 2, 1)
    expect(s(1, 0)).toEqual({ dOut: 10, back: true })
    expect(s(0, 0)).toEqual({ dOut: 0, back: false })
    expect(s(2, 0)).toBeNull()
  })
})

describe('fireflyAt', () => {
  const swarm = SEEDS.flatMap((s) => placeFireflies(s, W, H, terrain(600)))

  it('moves (two instants differ) and stays within FIREFLY_REACH of home', () => {
    let moved = 0
    for (const f of swarm) {
      for (let t = 0; t < 60; t += 0.37) {
        const p = fireflyAt(f, t)
        expect(Math.hypot(p.x - f.hx, p.y - f.hy)).toBeLessThanOrEqual(FIREFLY_REACH)
      }
      const a = fireflyAt(f, 10)
      const b = fireflyAt(f, 10.5)
      if (Math.hypot(a.x - b.x, a.y - b.y) > 1) moved++
    }
    expect(moved).toBeGreaterThan(swarm.length * 0.9)
  })

  it('is a function of the clock: the same instant is the same pose', () => {
    for (const f of swarm.slice(0, 20)) expect(fireflyAt(f, 12.25)).toEqual(fireflyAt(f, 12.25))
  })
})

describe('glintAt', () => {
  it('pulses: at the floor most of a period, near full once in it', () => {
    for (const period of FIREFLY_PERIOD) {
      const f = { period, phase: 0.3 }
      const samples = Array.from({ length: 400 }, (_, k) => glintAt(f, (k / 400) * period))
      for (const g of samples) {
        expect(g).toBeGreaterThanOrEqual(FIREFLY_GLINT_FLOOR - 1e-9)
        expect(g).toBeLessThanOrEqual(1 + 1e-9)
      }
      expect(Math.max(...samples)).toBeGreaterThan(0.95)
      expect(samples.filter((g) => g === FIREFLY_GLINT_FLOOR).length).toBeGreaterThan(samples.length / 2)
    }
  })
})

describe('fireflyFade', () => {
  it('is none by moonlit day, all at night, rising through dusk', () => {
    expect(fireflyFade(0)).toBe(0)
    expect(fireflyFade(FIREFLY_FADE[0])).toBe(0)
    expect(fireflyFade(FIREFLY_FADE[1])).toBe(1)
    expect(fireflyFade(1)).toBe(1)
    const mid = fireflyFade((FIREFLY_FADE[0] + FIREFLY_FADE[1]) / 2)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    let last = -1
    for (let t = 0; t <= 1; t += 0.01) {
      const v = fireflyFade(t)
      expect(v).toBeGreaterThanOrEqual(last)
      last = v
    }
  })
})
