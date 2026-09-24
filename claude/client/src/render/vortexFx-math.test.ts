import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../core'
import { VORTEX_ARM_SAMPLES, VORTEX_FADE_MS, VORTEX_SWIRL_FADE_FROM, armPhase, spiralArm, swirlFade, vortexFade, vortexRadii } from './vortexFx-math'

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
}, 60_000)

describe('the vortex drawing', () => {
  it('rings what takes you; the swirl is sized inside the reach', () => {
    const k = C()
    const r = vortexRadii(k)
    // Not NaN: the constants reached the client (an absent key reads undefined).
    expect(r.capture).toBeGreaterThan(0)
    expect(r.capture).toBe(k.VORTEX_CAPTURE_R)
    expect(r.outer).toBe(k.VORTEX_REACH / 2)
    expect(r.outer).toBeGreaterThan(r.capture)
  })

  it('the swirl fades to nothing at its outer radius, with no step on the way (R98)', () => {
    const { capture, outer } = vortexRadii(C())
    const from = capture + (outer - capture) * VORTEX_SWIRL_FADE_FROM
    expect(swirlFade(capture, capture, outer)).toBe(1)
    expect(swirlFade(from, capture, outer)).toBe(1)
    expect(swirlFade(outer, capture, outer)).toBe(0)
    // Continuous and falling: no sample-to-sample step bigger than a smooth curve makes.
    const n = 200
    let prev = 1
    for (let i = 0; i <= n; i++) {
      const f = swirlFade(capture + ((outer - capture) * i) / n, capture, outer)
      expect(f).toBeLessThanOrEqual(prev)
      expect(prev - f).toBeLessThan(3 / n / (1 - VORTEX_SWIRL_FADE_FROM))
      prev = f
    }
    // Nearly gone just inside the edge — what `breach-vortex` photographs there.
    expect(swirlFade(outer - (outer - capture) * 0.05, capture, outer)).toBeLessThan(0.02)
  })

  it('an arm runs from the inner radius to the outer one, whatever the phase', () => {
    const out: number[] = []
    const { capture, outer } = vortexRadii(C())
    const inner = capture / 4
    for (const phase of [0, 1.3, -4]) {
      spiralArm(100, 200, inner, outer, phase, out)
      expect(out.length).toBe(VORTEX_ARM_SAMPLES * 2)
      expect(Math.hypot(out[0]! - 100, out[1]! - 200)).toBeCloseTo(inner, 3)
      const n = out.length
      expect(Math.hypot(out[n - 2]! - 100, out[n - 1]! - 200)).toBeCloseTo(outer, 3)
    }
  })

  it('spins: every arm turns the same way over time, evenly spaced', () => {
    expect(armPhase(0, 1)).toBeLessThan(armPhase(0, 0))
    expect(armPhase(1, 0)).toBeGreaterThan(armPhase(0, 0))
  })

  it('a pulling vortex is drawn whole; a stopped one fades out and is then gone', () => {
    expect(vortexFade(null, 1e9)).toBe(1)
    expect(vortexFade(1000, 1000)).toBe(1)
    expect(vortexFade(1000, 1000 + VORTEX_FADE_MS / 2)).toBeCloseTo(0.5, 6)
    expect(vortexFade(1000, 1000 + VORTEX_FADE_MS * 2)).toBe(0)
  })
})
