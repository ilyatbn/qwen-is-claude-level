import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { C, Core } from '../core'
import { ridgeLayout, screenAnchoredRidgeForTest, type RidgeInput } from './parallax-math'

const here = dirname(fileURLToPath(import.meta.url))
let c: ReturnType<typeof C>
beforeAll(async () => {
  await Core.init(readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm')))
  c = C()
})

const near = () => c.MOUNTAIN_HEIGHT_FRAC[c.MOUNTAIN_LAYERS - 1]!

const input = (over: Partial<RidgeInput> = {}): RidgeInput => ({
  // A map twice the viewport tall. The properties hold for any map; this one just
  // leaves the camera room to travel.
  mapH: c.VIEWPORT_H * 2,
  baseFrac: c.MOUNTAIN_BASE_FRAC,
  titleBaseFrac: c.MOUNTAIN_TITLE_BASE_FRAC,
  heightFrac: near(),
  viewportH: c.VIEWPORT_H,
  viewY: 0,
  zoom: c.CAMERA_ZOOM,
  ...over,
})

/** The world row a layout draws the ridge base at, recovered from its screen answer. */
const baseInWorld = (o: RidgeInput, l = ridgeLayout(o)) => (l.top + l.h) / o.zoom + o.viewY

// Camera positions, not tunables: the claim is "wherever the camera is".
const CAMERA_ROWS = [0, 60, 180, 420]

describe('ridgeLayout (T21.20)', () => {
  it('keeps the ridge base on one world row wherever the camera is', () => {
    const rows = CAMERA_ROWS.map((viewY) => baseInWorld(input({ viewY })))
    for (const r of rows) expect(r).toBeCloseTo(rows[0]!, 6)
    expect(rows[0]).toBeCloseTo(c.VIEWPORT_H * 2 * c.MOUNTAIN_BASE_FRAC, 6)
  })

  it('the layout it replaced does not — the control', () => {
    // Without this, the test above passes for any function that ignores the camera.
    // This is the shipped behaviour the report describes: the base rides with it.
    const rows = CAMERA_ROWS.map((viewY) => {
      const o = input({ viewY })
      return baseInWorld(o, screenAnchoredRidgeForTest(o))
    })
    expect(new Set(rows.map((r) => r.toFixed(3))).size).toBe(rows.length)
  })

  it('is the same world height at every zoom', () => {
    const worldH = (zoom: number) => ridgeLayout(input({ zoom })).h / zoom
    expect(worldH(1)).toBeCloseTo(worldH(c.CAMERA_ZOOM), 6)
    expect(worldH(1)).toBeCloseTo(c.VIEWPORT_H * near(), 6)
  })

  it('the old layout shrank with zoom — the control', () => {
    const worldH = (zoom: number) => screenAnchoredRidgeForTest(input({ zoom })).h / zoom
    expect(worldH(c.CAMERA_ZOOM)).toBeLessThan(worldH(1))
  })

  it('moves on screen exactly as far as the terrain does when the camera moves', () => {
    const step = 50
    const a = ridgeLayout(input({ viewY: 100 }))
    const b = ridgeLayout(input({ viewY: 100 + step }))
    expect(a.top - b.top).toBeCloseTo(step * c.CAMERA_ZOOM, 6)
  })

  it('keeps the screen layout on the title, where there is no map', () => {
    const t = ridgeLayout(input({ mapH: 0, zoom: 1, viewY: 0 }))
    const h = c.VIEWPORT_H * near()
    expect(t.worldBase).toBeNull()
    expect(t.worldH).toBeNull()
    expect(t.h).toBeCloseTo(h, 6)
    expect(t.top).toBeCloseTo(c.VIEWPORT_H * c.MOUNTAIN_TITLE_BASE_FRAC - h, 6)
  })
})
