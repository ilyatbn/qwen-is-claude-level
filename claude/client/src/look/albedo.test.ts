/**
 * T23.06: the albedo's hash is the mockup's, word for word. `world.js` does not export `hash`, but
 * `vnoise` at integer coordinates is exactly `hash` (its fade weights are 0 there), so the mockup's
 * own function is what `hashU32` is compared with — 10k inputs, negatives and large values in them
 * (`probeInput`, the same inputs the GLSL probe in `look-albedo` reads back).
 */
import { describe, expect, it } from 'vitest'
import { hashU32, probeInput } from './albedo'

const WORLD_JS = new URL('../../../tasks/M23/reference/mockup-src/world.js', import.meta.url).href

describe('albedo hash', () => {
  it('equals world.js::hash over 10k inputs, as a 32-bit word', async () => {
    const world = (await import(/* @vite-ignore */ WORLD_JS)) as { vnoise: (x: number, y: number, s: number) => number }
    let mismatches = 0
    let negatives = 0
    for (let i = 0; i < 10_000; i++) {
      const [x, y, s] = probeInput(i)
      if (x < 0 || y < 0) negatives++
      // The mockup returns word / 2³² in float64, exactly; × 2³² gives the word back.
      if (world.vnoise(x, y, s) * 4294967296 !== hashU32(x, y, s)) mismatches++
    }
    expect(negatives).toBeGreaterThan(1000)
    expect(mismatches).toBe(0)
  })

  it('control: a one-constant change is caught', async () => {
    const world = (await import(/* @vite-ignore */ WORLD_JS)) as { vnoise: (x: number, y: number, s: number) => number }
    const wrong = (x: number, y: number, s: number): number => {
      let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 144667)) | 0
      h = Math.imul(h ^ (h >>> 13), 1274126177)
      return (h ^ (h >>> 16)) >>> 0
    }
    let differ = 0
    for (let i = 0; i < 10_000; i++) {
      const [x, y, s] = probeInput(i)
      if (world.vnoise(x, y, s) * 4294967296 !== wrong(x, y, s)) differ++
    }
    expect(differ).toBeGreaterThan(9_000)
  })
})
