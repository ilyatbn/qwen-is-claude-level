import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { C, Core } from '../core'
import { CYCLE_LENGTH, bodyPositions, darknessAt, sceneDarkness, starAlpha } from './sky-math'
import {
  earthPixels,
  moonPixels,
  shadowPixels,
  spaceBodies,
  spaceSkySeed,
  spaceStars,
  starAt,
} from './spaceSky-math'

const here = dirname(fileURLToPath(import.meta.url))
let c: ReturnType<typeof C>
/** The visible view in camera px at `CAMERA_ZOOM` — what the sky is laid out in. */
let viewW = 0
let viewH = 0
beforeAll(async () => {
  await Core.init(readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm')))
  c = C()
  viewW = c.VIEWPORT_W / c.CAMERA_ZOOM
  viewH = c.VIEWPORT_H / c.CAMERA_ZOOM
})

const at = (t: number, seed = 4242) => spaceBodies(t, spaceSkySeed(seed), c, viewW, viewH)

describe('spaceBodies — the motion driver, decoupled from the day', () => {
  it('moves every body as the round clock advances', () => {
    const a = at(30)
    const b = at(40)
    expect(Math.hypot(b.sun.fx - a.sun.fx, b.sun.fy - a.sun.fy)).toBeGreaterThan(0)
    expect(Math.hypot(b.earth.fx - a.earth.fx, b.earth.fy - a.earth.fy)).toBeGreaterThan(0)
    expect(Math.hypot(b.moon.dx - a.moon.dx, b.moon.dy - a.moon.dy)).toBeGreaterThan(0)
  })

  it('is not the day cycle: one CYCLE_LENGTH later the sky has moved on', () => {
    // The ground sky repeats every `CYCLE_LENGTH`; a driver built on `cycleU` would too.
    const a = at(10)
    const b = at(10 + CYCLE_LENGTH)
    expect(Math.abs(b.earth.fx - a.earth.fx) + Math.abs(b.earth.fy - a.earth.fy)).toBeGreaterThan(0.01)
  })

  it('shows the sun and the moon together at every moment — the ground sky never does', () => {
    // Control: the ground's `bodyPositions` has one of them null for most of the cycle.
    let groundBoth = 0
    for (let t = 0; t < CYCLE_LENGTH; t += 1) {
      const g = bodyPositions(t / CYCLE_LENGTH, 1000, 500, 300)
      if (g.sun && g.moon) groundBoth++
      const s = at(t)
      for (const f of [s.sun.fx, s.sun.fy, s.earth.fx, s.earth.fy]) {
        expect(f).toBeGreaterThan(0)
        expect(f).toBeLessThan(1)
      }
    }
    expect(groundBoth).toBeLessThan(CYCLE_LENGTH / 5)
  })

  it('is seeded: a seed repeats itself and another seed starts elsewhere', () => {
    expect(at(0, 4242)).toEqual(at(0, 4242))
    expect(at(0, 4243)).not.toEqual(at(0, 4242))
  })

  it('faces the earth\'s lit side at the sun', () => {
    for (const t of [0, 77, 190]) {
      const b = at(t)
      const want = Math.atan2((b.sun.fy - b.earth.fy) * viewH, (b.sun.fx - b.earth.fx) * viewW)
      expect(b.sunward).toBeCloseTo(want, 9)
    }
  })
})

describe('the constants against what the owner asked for — "should move"', () => {
  /** Mean on-screen speed over one lap, px/s, sampled off the function itself. */
  const lapSpeed = (pick: (t: number) => { x: number; y: number }, period: number) => {
    let len = 0
    let prev = pick(0)
    const steps = 720
    for (let i = 1; i <= steps; i++) {
      const p = pick((period * i) / steps)
      len += Math.hypot(p.x - prev.x, p.y - prev.y)
      prev = p
    }
    return (len * c.CAMERA_ZOOM) / period
  }

  it('the earth crosses the screen at a pace a player sees and does not mistake for play', () => {
    const v = lapSpeed((t) => ({ x: at(t).earth.fx * viewW, y: at(t).earth.fy * viewH }), c.SPACE_EARTH_PERIOD)
    // ~6 px/s is the doc comment's claim; a pace under 2 is a still picture over a
    // fight, over 20 is a thing flying past rather than a planet.
    expect(v).toBeGreaterThan(2)
    expect(v).toBeLessThan(20)
  })

  it('the moon laps the earth at least once in the shortest round', () => {
    expect(c.ROUND_SECONDS_MIN / c.SPACE_MOON_PERIOD).toBeGreaterThanOrEqual(1)
  })

  it('the stars drift at all', () => {
    expect(c.SPACE_STAR_DRIFT).toBeGreaterThan(0)
  })
})

describe('spaceStars / starAt', () => {
  it('is seeded, and the count is the constant', () => {
    const a = spaceStars(4242, c.SPACE_STAR_COUNT)
    expect(a).toHaveLength(c.SPACE_STAR_COUNT)
    expect(spaceStars(4242, c.SPACE_STAR_COUNT)).toEqual(a)
    expect(spaceStars(4243, c.SPACE_STAR_COUNT)).not.toEqual(a)
  })

  it('drifts on the round clock and wraps inside the view', () => {
    const s = spaceStars(4242, 1)[0]!
    const a = starAt(s, 0, c.SPACE_STAR_DRIFT, 0, 0, c.SPACE_STAR_PARALLAX, viewW, viewH)
    const b = starAt(s, 5, c.SPACE_STAR_DRIFT, 0, 0, c.SPACE_STAR_PARALLAX, viewW, viewH)
    const moved = (((a.x - b.x) % viewW) + viewW) % viewW
    expect(moved).toBeCloseTo(5 * c.SPACE_STAR_DRIFT, 6)
    expect(b.y).toBe(a.y)
    for (let t = 0; t < 1000; t += 37) {
      const p = starAt(s, t, c.SPACE_STAR_DRIFT, t * 13, -t * 7, c.SPACE_STAR_PARALLAX, viewW, viewH)
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThan(viewW)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThan(viewH)
    }
  })

  it('shines with no darkness at all — where the ground\'s stars are invisible', () => {
    // Control: the ground sky's stars are zero at darkness 0, which is space's darkness.
    expect(starAlpha(0.75, 0, c.NIGHT_DARKNESS)).toBe(0)
    for (const s of spaceStars(4242, 50)) {
      expect(starAt(s, 12, c.SPACE_STAR_DRIFT, 0, 0, c.SPACE_STAR_PARALLAX, viewW, viewH).a).toBeGreaterThan(0.1)
    }
  })
})

describe('sceneDarkness — the one spelling of the frame\'s darkness', () => {
  const night = 0.75 * CYCLE_LENGTH

  it('is 0 in space at the ground\'s night, whatever the byte says', () => {
    expect(sceneDarkness(true, 0, night, c.NIGHT_DARKNESS)).toBe(0)
    expect(sceneDarkness(true, 0.5, night, c.NIGHT_DARKNESS)).toBe(0)
  })

  it('on the ground reads a 0 byte as "none yet" — the falsy fallback space must not reach', () => {
    const d = sceneDarkness(false, 0, night, c.NIGHT_DARKNESS)
    expect(d).toBe(darknessAt(0.75, c.NIGHT_DARKNESS))
    expect(d).toBeGreaterThan(0)
    expect(sceneDarkness(false, 0.3, night, c.NIGHT_DARKNESS)).toBe(0.3)
  })
})

describe('the planets\' pixels', () => {
  const lit = (px: Uint8ClampedArray) => {
    let n = 0
    for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) n++
    return n
  }

  it('the earth is a disc of ocean and land, seeded', () => {
    const r = 20
    const a = earthPixels(4242, r)
    expect(a).toHaveLength(Math.ceil(2 * r) ** 2 * 4)
    const area = lit(a)
    expect(area).toBeGreaterThan(Math.PI * r * r * 0.9)
    expect(area).toBeLessThan(Math.PI * r * r * 1.1)
    // Corners are outside the disc: transparent.
    expect(a[3]).toBe(0)
    let ocean = 0
    let land = 0
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] === 0) continue
      if (a[i + 2]! > a[i]! + 40) ocean++
      else if (a[i + 1]! > a[i + 2]!) land++
    }
    expect(ocean).toBeGreaterThan(0)
    expect(earthPixels(4242, r)).toEqual(a)
    expect(earthPixels(99, r)).not.toEqual(a)
    // Land at some seed in a handful — a planet of pure ocean on every seed would pass the above.
    let anyLand = land
    for (let s = 1; s < 8 && anyLand === 0; s++) {
      const p = earthPixels(s, r)
      for (let i = 0; i < p.length; i += 4) if (p[i + 3]! > 0 && p[i + 1]! > p[i + 2]!) anyLand++
    }
    expect(anyLand).toBeGreaterThan(0)
  })

  it('the moon is a grey disc', () => {
    const m = moonPixels(4242, 10)
    expect(lit(m)).toBeGreaterThan(Math.PI * 100 * 0.9)
  })

  it('the shade darkens the left half and leaves the right clear', () => {
    const r = 20
    const s = shadowPixels(r, 0.9)
    const size = Math.ceil(2 * r)
    const alphaAt = (x: number) => s[(r * size + x) * 4 + 3]!
    expect(alphaAt(2)).toBeGreaterThan(200)
    expect(alphaAt(size - 3)).toBe(0)
  })
})
