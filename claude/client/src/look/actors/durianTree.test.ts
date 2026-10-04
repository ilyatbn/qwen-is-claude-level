/** T24.01: the durian tree's drawing data, its fruit's pulse and lights — and the purple gas's wire kind. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DURIAN_GLOW,
  DURIAN_LIGHT,
  DURIAN_LIGHTS_MAX,
  DURIAN_PULSE_MIN,
  DURIAN_PULSE_S,
  DURIAN_PULSE_STEPS,
  FRUIT_AT,
  FRUIT_SCALE,
  durianPulse,
  durianTreeActor,
  fruitActor,
  fruitLights,
} from './durianTree'
import { hazardKind } from '../../render/ordnanceFx-math'
import { pickupActor } from './furniture'

const here = dirname(fileURLToPath(import.meta.url))
const rust = readFileSync(join(here, '../../../../crates/game-core/src/map/durian.rs'), 'utf8')

describe('durian tree (T24.01)', () => {
  it("hangs its fruit where the server does — FRUIT_AT is game-core's table", () => {
    const m = /pub const FRUIT_AT: \[\(f32, f32\); DURIAN_FRUIT\] = \[([^\]]+)\];/.exec(rust)
    expect(m, 'durian.rs has no FRUIT_AT').not.toBeNull()
    const pairs = [...(m?.[1] ?? '').matchAll(/\((-?[0-9.]+), (-?[0-9.]+)\)/g)].map((p) => [Number(p[1]), Number(p[2])])
    expect(pairs.length).toBeGreaterThan(0)
    expect(FRUIT_AT).toEqual(pairs)
  })

  it('draws the tree mirrored with its flip bit, its branches to FRUIT_AT', () => {
    const a = durianTreeActor({ x: 100, y: 400, flip: false })
    const b = durianTreeActor({ x: 100, y: 400, flip: true })
    expect(a.kind).toBe('durianTree')
    expect([a.opts.face, b.opts.face]).toEqual([1, -1])
    expect(a.opts.fruit).toEqual(FRUIT_AT)
    expect(a.lit?.halo ?? null).toBeNull()
  })

  it('pulses: between DURIAN_PULSE_MIN and 1, in DURIAN_PULSE_STEPS steps a period, and it moves', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 400; i++) {
      const k = durianPulse((i / 400) * DURIAN_PULSE_S * 2)
      expect(k).toBeGreaterThanOrEqual(DURIAN_PULSE_MIN - 1e-9)
      expect(k).toBeLessThanOrEqual(1 + 1e-9)
      seen.add(Math.round(k * 1e6))
    }
    // The steps' cosine is symmetric, so a period shows at most STEPS values and more than one (it animates).
    expect(seen.size).toBeGreaterThan(1)
    expect(seen.size).toBeLessThanOrEqual(DURIAN_PULSE_STEPS)
    // A phase moves it: two fruit of one tree are not in step.
    expect(durianPulse(0.1, 0)).not.toBe(durianPulse(0.1, 0.5))
  })

  it("gives a hanging fruit the grenade's pickup drawing in the green halo, scaled by the pulse", () => {
    const hi = fruitActor('weapon_durian_grenade', 10, 20, 1)
    const lo = fruitActor('weapon_durian_grenade', 10, 20, DURIAN_PULSE_MIN)
    expect(hi.lit?.halo).toBe(DURIAN_GLOW)
    // Drawn larger than the same item on the ground (FRUIT_SCALE).
    const ground = pickupActor('weapon_durian_grenade', 10, 20)
    expect(hi.opts.s).toBeCloseTo((ground.opts.s ?? 1) * FRUIT_SCALE, 6)
    expect((hi.lit?.haloAlpha ?? 0) > (lo.lit?.haloAlpha ?? 0)).toBe(true)
  })

  it('lights each fruit at its pulse, the brightest DURIAN_LIGHTS_MAX only', () => {
    const many = Array.from({ length: DURIAN_LIGHTS_MAX + 4 }, (_, i) => ({ id: i, x: i * 10, y: 0 }))
    const l = fruitLights(many, 0.3)
    expect(l.length).toBe(DURIAN_LIGHTS_MAX)
    for (const x of l) {
      expect(x.rgb).toBe(DURIAN_LIGHT.rgb)
      expect(x.i).toBeLessThanOrEqual(DURIAN_LIGHT.i)
      expect(x.i).toBeGreaterThanOrEqual(DURIAN_LIGHT.i * DURIAN_PULSE_MIN - 1e-9)
    }
    // Control: fewer fruit than the cap are all lit.
    expect(fruitLights(many.slice(0, 2), 0.3).length).toBe(2)
  })

  it("reads the server's `DurianGas` as the purple cloud, apart from the toxic one", () => {
    expect(hazardKind('DurianGas')).toBe('durian')
    expect(hazardKind('Toxic')).toBe('toxic')
  })
})
