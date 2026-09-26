import { describe, expect, it } from 'vitest'
import { darknessAt, CYCLE_LENGTH, cycleU, skyPhase, type SkyPhase } from './sky-math'

describe('cycleU', () => {
  it('wraps every CYCLE_LENGTH seconds', () => {
    expect(cycleU(0)).toBe(0)
    expect(cycleU(CYCLE_LENGTH)).toBe(0)
    expect(cycleU(CYCLE_LENGTH * 1.5)).toBeCloseTo(0.5, 9)
    expect(cycleU(CYCLE_LENGTH * 3)).toBeCloseTo(0, 9)
  })

  it('handles negative times without returning a negative u', () => {
    expect(cycleU(-CYCLE_LENGTH * 0.25)).toBeCloseTo(0.75, 9)
  })
})

describe('skyPhase', () => {
  it('produces all six names across the day', () => {
    const seen = new Set<SkyPhase>()
    for (let i = 0; i < 1000; i++) seen.add(skyPhase(i / 1000))
    expect(seen).toEqual(
      new Set(['morning', 'day', 'afternoon', 'evening', 'night', 'dawn'] as SkyPhase[]),
    )
  })

  it('matches the §A4 boundaries exactly', () => {
    expect(skyPhase(0.0)).toBe('morning')
    expect(skyPhase(0.149)).toBe('morning')
    expect(skyPhase(0.15)).toBe('day')
    expect(skyPhase(0.399)).toBe('day')
    expect(skyPhase(0.4)).toBe('afternoon')
    expect(skyPhase(0.5)).toBe('evening')
    expect(skyPhase(0.62)).toBe('night')
    expect(skyPhase(0.9)).toBe('dawn')
    expect(skyPhase(0.999)).toBe('dawn')
  })
})

describe('darknessAt (A13)', () => {
  const NIGHT = 0.82

  it('is 0 through the whole lit half of the day', () => {
    for (const u of [0, 0.1, 0.25, 0.4, 0.49]) expect(darknessAt(u, NIGHT)).toBe(0)
  })

  it('reaches full darkness exactly when night begins, not 10 s early', () => {
    // The §A13 defect: darkness ramped over CYCLE_TRANSITION centred on t=60, so
    // the world was black at t=64 while the sky still showed the orange sunset
    // keyframe at u=0.55. Dusk now ends where the `night` phase starts.
    expect(darknessAt(0.55, NIGHT)).toBeGreaterThan(0)
    expect(darknessAt(0.55, NIGHT)).toBeLessThan(NIGHT * 0.95)
    expect(darknessAt(0.62, NIGHT)).toBeCloseTo(NIGHT, 6)
    expect(darknessAt(0.8, NIGHT)).toBeCloseTo(NIGHT, 6)
  })

  it('matches the phase table it is derived from', () => {
    // One description of the day: dusk spans the `evening` phase and dawn spans
    // `dawn`, so the sky and the darkness can never disagree again.
    expect(skyPhase(0.5)).toBe('evening')
    expect(skyPhase(0.62)).toBe('night')
    expect(skyPhase(0.9)).toBe('dawn')
    expect(darknessAt(0.5, NIGHT)).toBe(0)
    expect(darknessAt(0.9, NIGHT)).toBeCloseTo(NIGHT, 6)
    expect(darknessAt(0.999, NIGHT)).toBeLessThan(NIGHT * 0.05)
  })

  it('is continuous everywhere, including across the wrap', () => {
    let worst = 0
    let prev = darknessAt(0, NIGHT)
    for (let i = 1; i <= 2000; i++) {
      const cur = darknessAt(i / 2000, NIGHT)
      worst = Math.max(worst, Math.abs(cur - prev))
      prev = cur
    }
    // One tick at 60 Hz is 1/7200 of the cycle; this bound is far above that and
    // still far below any visible step.
    expect(worst).toBeLessThan(0.01)
  })

  it('is monotonic within each ramp', () => {
    let prev = -1
    for (let i = 0; i <= 200; i++) {
      const v = darknessAt(0.5 + (i / 200) * 0.12, NIGHT)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = v
    }
    prev = Infinity
    for (let i = 0; i <= 200; i++) {
      const v = darknessAt(0.9 + (i / 200) * 0.1, NIGHT)
      expect(v).toBeLessThanOrEqual(prev + 1e-9)
      prev = v
    }
  })

  it('gives a 240 s round exactly two nights', () => {
    let nights = 0
    let wasNight = false
    for (let t = 0; t <= 240; t += 0.1) {
      const isNight = darknessAt(cycleU(t), NIGHT) >= NIGHT * 0.999
      if (isNight && !wasNight) nights++
      wasNight = isNight
    }
    expect(nights).toBe(2)
  })
})

