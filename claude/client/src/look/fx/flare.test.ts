import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../../core'
import { FLARE_LIGHT, FLARE_LIGHT_AT, FLARE_MAX_POINTS, flareLights } from './flare'

beforeAll(async () => {
  const url = new URL('../../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
}, 60_000)

/** An arch of `n` samples, as the core's loop: x/y pairs. */
function arch(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(100 + i * 10, 400 - 100 * Math.sin((Math.PI * i) / (n - 1)))
  return out
}

describe('the solar flare in the world renderer (T23.20 part C)', () => {
  it('holds every sample the server burns with', () => {
    // A shader array shorter than the samples would draw a loop cut short — burn points with nothing painted.
    expect(C().SOLAR_FLARE_SAMPLES).toBeGreaterThan(1)
    expect(FLARE_MAX_POINTS).toBeGreaterThanOrEqual(C().SOLAR_FLARE_SAMPLES)
  })

  it('lights the loop at its samples, as strong as the flare, and nothing while hidden or gone', () => {
    const pts = arch(48)
    const ls = flareLights({ points: pts, strength: 1, hidden: false })
    expect(ls).toHaveLength(FLARE_LIGHT_AT.length)
    // On the loop, not beside it: each light sits on one of the samples.
    for (const l of ls) {
      let on = false
      for (let i = 0; i < pts.length; i += 2) if (pts[i] === l.x && pts[i + 1] === l.y) on = true
      expect(on).toBe(true)
      expect(l.i).toBe(FLARE_LIGHT.i)
    }
    expect(flareLights({ points: pts, strength: 0.3, hidden: false })[0]!.i).toBeCloseTo(FLARE_LIGHT.i * 0.3)
    expect(flareLights({ points: pts, strength: 1, hidden: true })).toEqual([])
    expect(flareLights({ points: pts, strength: 0, hidden: false })).toEqual([])
    expect(flareLights(null)).toEqual([])
  })
})
