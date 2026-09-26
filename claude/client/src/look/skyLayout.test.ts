import { describe, expect, it } from 'vitest'
import type { Background, ViewRect } from './scene'
import { SCENES } from './scenes'
import {
  APEX_JITTER,
  HORIZON_PARALLAX,
  LAYER_PARALLAX,
  PERIOD_MIN,
  PERIOD_SPAN,
  SKY_PAN_SLACK,
  bakeExtents,
  clearAbove,
  gameSky,
  shapeWidth,
  skyOffsets,
  snapOffsets,
  type Extent,
  type Offset,
} from './skyLayout'

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

describe('bakeExtents — every camera in the map finds its sky baked (T23.04B, R21)', () => {
  const FRAME: [number, number] = [FRAME_W, 720]
  const MAPS = [
    { w: 2048, h: 1024 },
    { w: 3072, h: 1536 },
    { w: 4096, h: 2048 },
  ]
  /** Camera centres across the whole map, clamped as `cameraRig`'s bounds clamp them, then pushed out by the slack. */
  const centres = (world: { w: number; h: number }, w: number, h: number): [number, number][] => {
    const out: [number, number][] = []
    const xs = [w / 2 - SKY_PAN_SLACK, w / 2, world.w / 2, world.w - w / 2, world.w - w / 2 + SKY_PAN_SLACK]
    const ys = [h / 2 - SKY_PAN_SLACK, h / 2, world.h / 2, world.h - h / 2, world.h - h / 2 + SKY_PAN_SLACK]
    for (const x of xs) for (const y of ys) out.push([x, y])
    return out
  }
  /** The band-space rows and columns a frame's pixel centres read, at offset `o`, against extent `e`. */
  const reads = (o: Offset, texel: number) => ({
    x0: texel / 2 - o[0],
    x1: FRAME[0] - texel / 2 - o[0],
    y0: texel / 2 - o[1],
    y1: FRAME[1] - texel / 2 - o[1],
  })
  const inside = (r: ReturnType<typeof reads>, e: Extent, clear: number): boolean =>
    r.x0 >= e.org[0] &&
    r.x1 <= e.org[0] + e.ext[0] &&
    r.y1 <= e.org[1] + e.ext[1] &&
    // Above the bake's first row is transparent sky only if the crop started at or above `clear`.
    (r.y0 >= e.org[1] || e.org[1] <= clear)

  for (const texel of [1, 2]) {
    for (const [vw, vh] of [
      [640, 360],
      [1280, 720],
    ] as const) {
      it(`covers every read of every band and the horizon — texel ${texel}, view ${vw}×${vh}, all three map sizes, 25 cameras each`, () => {
        for (const seed of [1, 4242, 99991]) {
          const sky = gameSky(seed, F1)
          for (const world of MAPS) {
            const x = bakeExtents(sky, view(world.w / 2, world.h / 2, vw, vh), world, FRAME, texel)
            let checked = 0
            for (const [cx, cy] of centres(world, vw, vh)) {
              const o = snapOffsets(skyOffsets(sky, view(cx, cy, vw, vh), world, FRAME_W), texel)
              sky.layers.forEach((l, i) => {
                expect(inside(reads(o.layers[i]!, texel), x.layers[i]!, clearAbove(l, texel))).toBe(true)
                checked++
              })
              expect(inside(reads(o.horizon, texel), x.horizon, -Infinity)).toBe(true)
            }
            expect(checked).toBe(25 * sky.layers.length)
          }
        }
      })
    }
  }

  it('is whole texels: every origin and size a multiple of the texel, so a pixel centre is a texel centre', () => {
    for (const texel of [1, 2]) {
      const x = bakeExtents(gameSky(4242, F1), view(1000, 700), WORLD, FRAME, texel)
      for (const e of [...x.layers, x.horizon]) for (const v of [...e.org, ...e.ext]) expect(Math.abs(v % texel)).toBe(0)
    }
  })

  it('bakes the look-lab (no parallax) at exactly the frame, less only the transparent rows above a band', () => {
    const x = bakeExtents(F1, view(640, 360, 1280, 720), { w: 1280, h: 720 }, FRAME, 1)
    expect(x.horizon).toEqual({ org: [0, 0], ext: FRAME })
    F1.layers.forEach((l, i) => {
      const top = Math.max(0, Math.floor(clearAbove(l, 1)))
      expect(x.layers[i]).toEqual({ org: [0, top], ext: [FRAME[0], FRAME[1] - top] })
    })
  })

  it('grows with the parallax factor: the nearest band is baked widest', () => {
    const x = bakeExtents(gameSky(4242, F1), view(1000, 700), WORLD, FRAME, 2)
    for (let i = 1; i < x.layers.length; i++) expect(x.layers[i]!.ext[0]).toBeGreaterThan(x.layers[i - 1]!.ext[0])
  })

  it('starts a band at its highest possible edge: the apex, less the copies\' jitter, its softness and a texel', () => {
    const l = gameSky(4242, F1).layers[3]!
    expect(clearAbove(l, 2)).toBe(l.y - APEX_JITTER - l.soft! - 2)
    // Unrepeated (the look-lab's), no jitter.
    expect(clearAbove(F1.layers[3]!, 1)).toBe(F1.layers[3]!.y - F1.layers[3]!.soft! - 1)
  })
})

describe('snapOffsets — a frame draws its bands at whole baked texels', () => {
  const o = { layers: [[-16.4, 3.2], [-0.4, 0.2], [7.9, -1.1]] as Offset[], horizon: [-0.9, 0.4] as Offset }

  it('rounds each offset to the nearest multiple of the texel, never −0', () => {
    for (const texel of [1, 2]) {
      const s = snapOffsets(o, texel)
      const pairs = [...o.layers, o.horizon].map((v, i) => [v, [...s.layers, s.horizon][i]!] as const)
      for (const [raw, snapped] of pairs) {
        for (const k of [0, 1]) {
          expect(Math.abs(snapped[k]! % texel)).toBe(0)
          expect(Math.abs(snapped[k]! - raw[k]!)).toBeLessThanOrEqual(texel / 2)
          expect(Object.is(snapped[k], -0)).toBe(false)
        }
      }
    }
    expect(snapOffsets(o, 2).layers[0]).toEqual([-16, 4])
  })
})
