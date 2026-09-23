import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core, MapScale } from '../core'
import {
  cloudCentreX,
  cloudField,
  cloudVelocity,
  columnTops,
  flatFloor,
  floorAt,
  placeCloud,
  skyFloor,
  type Cloud,
} from './clouds-math'

let core: Core
/** Map widths read off generated maps, never typed: `MAP_*_W` are not exported. */
let mediumW = 0
let largeW = 0
beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  core = await Core.init(readFileSync(fileURLToPath(url)))
  core.generate(1n, MapScale.Large)
  largeW = core.width
  core.generate(1n, MapScale.Medium)
  mediumW = core.width
})
/** A strong wind, as an input: the property is "more wind, more drift", for any wind. */
const GUST = 60

// Seeds are draws, not tunables: a population claim needs more than one.
const SEEDS = [1, 2, 7, 4242, 99, 123456]
const lum = (c: number) => 0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)

describe('cloudField (T21.31) — many, small, varied', () => {
  it('is one cloud per CLOUD_SPACING of map width, and the same seed is the same sky', () => {
    const k = C()
    const w = mediumW
    expect(w).toBeGreaterThan(0)
    const a = cloudField(4242, w, k)
    expect(a.length).toBe(Math.floor(w / k.CLOUD_SPACING))
    expect(cloudField(4242, w, k)).toEqual(a)
    expect(cloudField(4243, w, k)).not.toEqual(a)
  })

  it('"too large" is answered by the constant: the widest cloud is under a quarter of the zoomed view', () => {
    const k = C()
    // The owner's report, as a basis the value is checked against rather than pinned to.
    expect(k.CLOUD_W_MAX).toBeLessThan(k.VIEWPORT_W / k.CAMERA_ZOOM / 4)
  })

  it('sizes, silhouettes, tints and speeds span their ranges on every seed — a sky of identical clouds fails', () => {
    const k = C()
    for (const seed of SEEDS) {
      const f = cloudField(seed, mediumW, k)
      const ws = f.map((c) => c.w)
      const ls = f.map((c) => lum(c.tint))
      const lobeCounts = new Set(f.map((c) => c.lobes.length))
      const aspects = f.map((c) => c.h / c.w)
      const speeds = f.map((c) => c.speed)
      expect(Math.max(...ws) - Math.min(...ws), `seed ${seed} widths`).toBeGreaterThan(
        0.5 * (k.CLOUD_W_MAX - k.CLOUD_W_MIN),
      )
      expect(Math.max(...aspects) - Math.min(...aspects), `seed ${seed} aspects`).toBeGreaterThan(
        0.5 * (k.CLOUD_ASPECT_MAX - k.CLOUD_ASPECT_MIN),
      )
      expect(lobeCounts.size, `seed ${seed} silhouettes`).toBeGreaterThanOrEqual(3)
      // The tint range the constants allow, measured as luminance, at its two corners.
      const darkest = lum(0) + Math.min(lum(k.CLOUD_TINT_COOL), lum(k.CLOUD_TINT_WARM)) * k.CLOUD_BRIGHT_MIN
      const brightest = Math.max(lum(k.CLOUD_TINT_COOL), lum(k.CLOUD_TINT_WARM)) * k.CLOUD_BRIGHT_MAX
      expect(Math.max(...ls) - Math.min(...ls), `seed ${seed} tints`).toBeGreaterThan(0.4 * (brightest - darkest))
      expect(new Set(f.map((c) => c.tint)).size, `seed ${seed} distinct tints`).toBeGreaterThan(f.length / 2)
      expect(Math.max(...speeds) - Math.min(...speeds), `seed ${seed} speeds`).toBeGreaterThan(
        0.5 * (k.CLOUD_SPEED_MAX - k.CLOUD_SPEED_MIN),
      )
    }
  })

  it('keeps every lobe inside its cloud box, so the floor guarantee can speak about the box', () => {
    const k = C()
    for (const seed of SEEDS) {
      for (const c of cloudField(seed, largeW, k)) {
        for (const l of c.lobes) {
          expect(l.cx - l.r).toBeGreaterThanOrEqual(-1e-9)
          expect(l.cx + l.r).toBeLessThanOrEqual(c.w + 1e-9)
          expect(l.cy - l.r).toBeGreaterThanOrEqual(-1e-9)
          expect(l.cy + l.r).toBeLessThanOrEqual(c.h + 1e-9)
        }
      }
    }
  })
})

describe('drift (T21.31) — "they do not move"', () => {
  const k = () => C()
  const one = (): Cloud => cloudField(4242, mediumW, C())[0]!

  it('moves every cloud in the wind direction, faster with more wind, at its own speed', () => {
    const c = one()
    const calm = cloudVelocity(c, 0, k())
    expect(calm).toBeCloseTo(k().CLOUD_DRIFT * c.speed, 9)
    expect(cloudVelocity(c, GUST, k())).toBeGreaterThan(calm)
    expect(cloudVelocity(c, -GUST, k())).toBeLessThan(0)
    const f = cloudField(4242, mediumW, C())
    expect(new Set(f.map((x) => cloudVelocity(x, 30, k()))).size).toBe(f.length)
  })

  it('crosses v*t between two clocks and wraps past both walls', () => {
    const c = one()
    const w = mediumW
    const v = cloudVelocity(c, 20, k())
    const a = cloudCentreX(c, 0, 20, w, k())
    expect(cloudCentreX(c, 3, 20, w, k()) - a).toBeCloseTo(v * 3, 6)
    const span = w + 2 * k().CLOUD_W_MAX
    expect(cloudCentreX(c, span / v, 20, w, k())).toBeCloseTo(a, 4)
    for (let t = 0; t < 2000; t += 37) {
      const x = cloudCentreX(c, t, 20, w, k())
      expect(x).toBeGreaterThanOrEqual(-k().CLOUD_W_MAX)
      expect(x).toBeLessThan(w + k().CLOUD_W_MAX)
    }
  })
})

describe('skyFloor (T21.31) — clouds are never inside rock', () => {
  it('a thin spire lifts every cloud whose box would reach it', () => {
    const k = C()
    const width = 1600
    const height = 800
    const spireX = 800
    // Ground at 700, and a spire up to 300 exactly `step` wide.
    const solid = (x: number, y: number) => y >= 700 || (x >= spireX && x < spireX + 2 && y >= 300)
    const floor = skyFloor(columnTops(width, height, 2, solid), 2, k)
    const f = cloudField(1, width, k)
    let near = 0
    for (let t = 0; t < 400; t += 1) {
      for (let i = 0; i < f.length; i++) {
        const b = placeCloud(f[i]!, i, t, 40, width, floor, k)
        if (!b.visible) continue
        if (b.left <= spireX + 2 && b.left + b.w >= spireX) {
          near++
          expect(b.top + b.h).toBeLessThanOrEqual(300)
        }
      }
    }
    // The control: clouds really did pass over the spire, or the loop asserted nothing.
    expect(near).toBeGreaterThan(0)
  })

  it('holds against real generated terrain across seeds and scales, at every sampled moment', () => {
    const k = C()
    for (const scale of [MapScale.Small, MapScale.Medium, MapScale.Large]) {
      for (const seed of [4242n, 7n, 99n]) {
        core.generate(seed, scale)
        const { width, height } = core
        const solid = (x: number, y: number) => core.solidAt(x, y)
        const floor = skyFloor(columnTops(width, height, k.CLOUD_FLOOR_STEP, solid), k.CLOUD_FLOOR_STEP, k)
        const f = cloudField(Number(seed), width, k)
        const wind = core.meta.wind
        let drawn = 0
        for (let t = 0; t < 900; t += 45) {
          for (let i = 0; i < f.length; i++) {
            const b = placeCloud(f[i]!, i, t, wind, width, floor, k)
            if (!b.visible) continue
            drawn++
            for (let x = Math.ceil(b.left); x <= Math.floor(b.left + b.w); x++) {
              for (let y = Math.floor(b.top); y <= Math.ceil(b.top + b.h); y++) {
                if (solid(x, y)) throw new Error(`seed ${seed} scale ${scale} cloud ${i} t=${t}: rock at ${x},${y}`)
              }
            }
          }
        }
        // Presence: a floor that hid every cloud would pass the loop above.
        expect(drawn, `seed ${seed} scale ${scale}`).toBeGreaterThan(0.8 * f.length * 20)
      }
    }
  })

  it('the title screen has a flat floor with no map under it', () => {
    const k = C()
    const y = k.VIEWPORT_H * k.CLOUD_TITLE_FLOOR_FRAC
    // Close, not equal: the floor is a `Float32Array`, and 331.2 does not survive f32.
    expect(floorAt(flatFloor(y), -50)).toBeCloseTo(y, 3)
    expect(floorAt(flatFloor(y), 5000)).toBeCloseTo(y, 3)
  })
})
