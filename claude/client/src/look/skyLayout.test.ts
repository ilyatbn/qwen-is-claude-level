import { describe, expect, it } from 'vitest'
import type { Background, ViewRect } from './scene'
import { SCENES } from './scenes'
import { HORIZON_PARALLAX, LAYER_PARALLAX, PERIOD_MIN, PERIOD_SPAN, gameSky, shapeWidth, skyOffsets } from './skyLayout'

const F1 = SCENES.F1!.look.bg as Background
const F5 = SCENES.F5!.look.bg as Background
const FRAME_W = 1280
/** A Large map (4096 × 2048) and a zoom-2 view (640 × 360), as the game has them today. */
const WORLD = { w: 4096, h: 2048 }
const view = (cx: number, cy: number, w = 640, h = 360): ViewRect => ({ x: cx - w / 2, y: cy - h / 2, w, h })

describe('gameSky — the layout is a pure function of the map seed (T23.04)', () => {
  it('gives the same layout for the same seed, every call (every client of a round agrees)', () => {
    expect(gameSky(4242, F1)).toEqual(gameSky(4242, F1))
  })

  it('gives another layout for another seed', () => {
    const a = gameSky(4242, F1).layers
    const b = gameSky(4243, F1).layers
    const moved = a.filter((l, i) => l.x !== b[i]!.x || l.period !== b[i]!.period || l.seed !== b[i]!.seed)
    expect(moved.length).toBe(a.length)
  })

  it("keeps the template's palette, shapes, steps and fades, and its sun and moons (parallax 0)", () => {
    for (const seed of [1, 4242, 0x7fffffff]) {
      const g = gameSky(seed, F1)
      expect(g.layers.length).toBe(F1.layers.length)
      g.layers.forEach((l, i) => {
        const t = F1.layers[i]!
        expect([l.shape, l.y, l.color, l.step, l.soft, l.fade, l.jitter, l.slope]).toEqual([t.shape, t.y, t.color, t.step, t.soft, t.fade, t.jitter, t.slope])
        expect(l.parallax).toBe(LAYER_PARALLAX[i])
        // The repeat is a shape and a gap of a third to a whole shape: copies never overlap above
        // the haze line, and there is always one close by.
        const w = shapeWidth(t, F1.horizon)
        expect(l.period!).toBeGreaterThanOrEqual(Math.round(w * PERIOD_MIN))
        expect(l.period!).toBeLessThanOrEqual(Math.round(w * (PERIOD_MIN + PERIOD_SPAN)))
        expect(PERIOD_MIN).toBeGreaterThan(1)
        expect(l.x).toBeGreaterThanOrEqual(0)
        expect(l.x).toBeLessThanOrEqual(l.period!)
      })
      expect(g.sun).toEqual(F1.sun)
      expect(g.rays).toEqual(F1.rays)
      expect(g.parallax).toBe(HORIZON_PARALLAX)
    }
    expect(gameSky(9, F5).moons).toEqual(F5.moons)
  })

  it("measures a shape's width where it meets the haze: F1's far pyramid is ~880 px, its left one ~460", () => {
    // From the mockup's numbers: apex y 30, haze line 480, slope 1.02 → 2 × 450 / 1.02.
    expect(shapeWidth(F1.layers[0]!, F1.horizon)).toBeCloseTo((2 * (480 - 30)) / 1.02, 9)
    expect(shapeWidth(F1.layers[3]!, F1.horizon)).toBeCloseTo((2 * (490 - 250)) / 1.05, 9)
  })

  it('orders the depths: each band further back moves less, and none reads as foreground', () => {
    for (let i = 1; i < LAYER_PARALLAX.length; i++) expect(LAYER_PARALLAX[i]!).toBeGreaterThan(LAYER_PARALLAX[i - 1]!)
    expect(LAYER_PARALLAX[LAYER_PARALLAX.length - 1]!).toBeLessThanOrEqual(0.35)
    expect(HORIZON_PARALLAX).toBeLessThanOrEqual(LAYER_PARALLAX[0]!)
  })
})

describe('skyOffsets — where the bands are for a camera', () => {
  const sky = gameSky(4242, F1)

  it('is a pure function of (layout, camera): the same view gives the same offsets', () => {
    const v = view(900, 700)
    expect(skyOffsets(sky, v, WORLD, FRAME_W)).toEqual(skyOffsets(sky, { ...v }, WORLD, FRAME_W))
  })

  it('is zero with the camera on the map centre — the frame the layout is authored in', () => {
    const o = skyOffsets(sky, view(WORLD.w / 2, WORLD.h / 2), WORLD, FRAME_W)
    for (const [x, y] of [...o.layers, o.horizon]) expect([x, y]).toEqual([0, 0])
  })

  it('moves the far band less than the near one, both against the pan, by pan × zoom × factor', () => {
    const a = skyOffsets(sky, view(1000, 900), WORLD, FRAME_W)
    const b = skyOffsets(sky, view(1300, 800), WORLD, FRAME_W)
    const zoom = FRAME_W / 640
    sky.layers.forEach((l, i) => {
      expect(b.layers[i]![0] - a.layers[i]![0]).toBeCloseTo(-300 * zoom * l.parallax!, 9)
      expect(b.layers[i]![1] - a.layers[i]![1]).toBeCloseTo(100 * zoom * l.parallax!, 9)
    })
    const shift = (i: number) => Math.abs(b.layers[i]![0] - a.layers[i]![0])
    for (let i = 1; i < sky.layers.length; i++) expect(shift(i)).toBeGreaterThan(shift(i - 1))
    expect(Math.abs(b.horizon[0] - a.horizon[0])).toBeCloseTo(300 * zoom * HORIZON_PARALLAX, 9)
  })

  it('scales with zoom: the same pan at twice the zoom moves a band twice as far on screen', () => {
    const d = (w: number, h: number) => {
      const a = skyOffsets(sky, view(1000, 900, w, h), WORLD, FRAME_W)
      const b = skyOffsets(sky, view(1200, 900, w, h), WORLD, FRAME_W)
      return b.layers[2]![0] - a.layers[2]![0]
    }
    expect(d(640, 360)).toBeCloseTo(2 * d(1280, 720), 9)
  })

  it("leaves the look-lab's scenes where the mockup drew them, whatever the camera", () => {
    for (const bg of [F1, F5]) {
      const o = skyOffsets(bg, view(3000, 1500), WORLD, FRAME_W)
      for (const [x, y] of [...o.layers, o.horizon]) expect(Math.abs(x) + Math.abs(y)).toBe(0)
    }
  })
})
