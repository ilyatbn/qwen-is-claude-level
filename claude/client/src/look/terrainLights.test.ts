/**
 * T23.07: the terrain's point lights — culled to the view (a circle that misses it lights nothing
 * drawn), the strongest `TERRAIN_LIGHTS` by intensity × on-screen coverage kept, in input order.
 */
import { describe, expect, it } from 'vitest'
import type { Light } from './scene'
import { F1 } from './scenes/F1'
import { TERRAIN_LIGHTS, coverage, pickLights, toLin } from './terrainLights'

const L = (x: number, y: number, r: number, i: number): Light => ({ x, y, z: 20, r, rgb: '255,140,50', i })
const view = { x: 0, y: 0, w: 1280, h: 720 }

describe('pickLights (T23.07)', () => {
  it("keeps F1's ten lights, all of them, in the scene's order (the mockup's sum)", () => {
    expect(pickLights(F1.look.lights, view)).toEqual(F1.look.lights)
  })

  it('drops a light whose circle misses the view, keeps one that reaches in from outside', () => {
    const off = L(-200, 300, 150, 5) // nearest view px 200 away > r
    const reach = L(-100, 300, 150, 5) // 100 away < r
    expect(pickLights([off, reach], view)).toEqual([reach])
    expect(coverage(off, view)).toBe(0)
    expect(coverage(reach, view)).toBe(50 * 300)
  })

  it(`keeps the ${TERRAIN_LIGHTS} strongest by intensity × coverage, in input order`, () => {
    const lights = Array.from({ length: 40 }, (_, k) => L(100 + k * 25, 360, 100, k % 7 === 0 ? 10 : 1))
    const got = pickLights(lights, view)
    expect(got.length).toBe(TERRAIN_LIGHTS)
    // Every intensity-10 light (6 of them) survives; the order is the input's.
    expect(got.filter((l) => l.i === 10).length).toBe(lights.filter((l) => l.i === 10).length)
    const idx = got.map((l) => lights.indexOf(l))
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
    // A half-visible light of the same intensity ranks below a whole one.
    const edge = L(1280, 360, 100, 3)
    const whole = L(640, 360, 100, 3)
    expect(pickLights([edge, whole], view, 1)).toEqual([whole])
  })

  it('T23.18B: over the slot count, combat lights keep their slots before the map’s standing lights', () => {
    const gates = Array.from({ length: TERRAIN_LIGHTS }, (_, k): Light => ({ ...L(80 + k * 70, 360, 150, 1.6), fixed: true }))
    // A blast only partly in view: a smaller coverage × intensity than any whole gate's circle.
    const blast = L(1280 + 40, 360, 60, 1)
    expect(blast.i * coverage(blast, view)).toBeLessThan(gates[0]!.i * coverage(gates[0]!, view))
    const got = pickLights([...gates, blast], view)
    expect(got.length).toBe(TERRAIN_LIGHTS)
    expect(got).toContain(blast)
    // Control: the same blast among lights that are not standing ones is ranked by score, and loses.
    const plain = gates.map((g) => L(g.x, g.y, g.r, g.i))
    expect(pickLights([...plain, blast], view)).not.toContain(blast)
  })

  it("colour is f_kit.js::toLin (a 2.2 power, not the sRGB curve)", () => {
    const [r, g, b] = toLin('255,140,50')
    expect(r).toBe(1)
    expect(g).toBeCloseTo(Math.pow(140 / 255, 2.2), 12)
    expect(b).toBeCloseTo(Math.pow(50 / 255, 2.2), 12)
  })
})
