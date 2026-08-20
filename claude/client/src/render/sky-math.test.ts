import { describe, expect, it } from 'vitest'
import {
  bodyPositions,
  darknessAt,
  CYCLE_LENGTH,
  cycleU,
  skyColors,
  skyPhase,
  starAlpha,
  starField,
  type SkyPhase,
} from './sky-math'

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

describe('skyColors', () => {
  const channels = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]

  it('returns each keyframe exactly at its own u', () => {
    // If interpolation drifts, the authored palette is not what anyone sees.
    expect(skyColors(0.0)).toEqual({ top: 0x1b2a5e, bottom: 0xf2a15c })
    expect(skyColors(0.3)).toEqual({ top: 0x2f7fd8, bottom: 0xa8d8f0 })
    expect(skyColors(0.78)).toEqual({ top: 0x030616, bottom: 0x0d1a3a })
  })

  it('is continuous across the whole day, including the 1.0 -> 0.0 wrap', () => {
    // A discontinuity here is a visible snap in the sky, and the wrap is where a
    // keyframe table is most likely to have one.
    let worst = 0
    let prev = skyColors(0)
    for (let i = 1; i <= 1000; i++) {
      const cur = skyColors(i / 1000)
      for (const key of ['top', 'bottom'] as const) {
        const a = channels(prev[key])
        const b = channels(cur[key])
        for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(a[ch]! - b[ch]!))
      }
      prev = cur
    }
    expect(worst).toBeLessThanOrEqual(12)
  })

  it('is actually dark at night and bright in the day', () => {
    // Guards against a table that interpolates smoothly between wrong colours.
    const lum = (c: number) => {
      const [r, g, b] = channels(c)
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    expect(lum(skyColors(0.3).top)).toBeGreaterThan(lum(skyColors(0.78).top) + 60)
  })
})

describe('bodyPositions', () => {
  const W = 1280
  const HORIZON = 500
  const ARC = 300

  it('shows the sun only over its own arc', () => {
    expect(bodyPositions(0.0, W, HORIZON, ARC).sun).not.toBeNull()
    expect(bodyPositions(0.3, W, HORIZON, ARC).sun).not.toBeNull()
    expect(bodyPositions(0.55, W, HORIZON, ARC).sun).not.toBeNull()
    expect(bodyPositions(0.6, W, HORIZON, ARC).sun).toBeNull()
    expect(bodyPositions(0.9, W, HORIZON, ARC).sun).toBeNull()
  })

  it('shows the moon only over its own arc', () => {
    expect(bodyPositions(0.4, W, HORIZON, ARC).moon).toBeNull()
    expect(bodyPositions(0.5, W, HORIZON, ARC).moon).not.toBeNull()
    expect(bodyPositions(0.99, W, HORIZON, ARC).moon).not.toBeNull()
  })

  it('puts both at their peak mid-arc and at the horizon at the ends', () => {
    const noon = bodyPositions(0.275, W, HORIZON, ARC).sun!
    expect(noon.y).toBeLessThan(HORIZON - ARC * 0.9)
    const rise = bodyPositions(0.0, W, HORIZON, ARC).sun!
    const set = bodyPositions(0.55, W, HORIZON, ARC).sun!
    expect(rise.y).toBeCloseTo(HORIZON, 5)
    expect(set.y).toBeCloseTo(HORIZON, 5)
    // And they travel across, not just up.
    expect(set.x).toBeGreaterThan(rise.x)
  })

  it('fades both in and out rather than popping at the horizon', () => {
    expect(bodyPositions(0.0, W, HORIZON, ARC).sun!.a).toBeCloseTo(0, 5)
    expect(bodyPositions(0.275, W, HORIZON, ARC).sun!.a).toBe(1)
    expect(bodyPositions(0.55, W, HORIZON, ARC).sun!.a).toBeCloseTo(0, 5)
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

describe('starField', () => {
  it('is deterministic, so the sky does not reshuffle on reload', () => {
    const a = starField(50, 800, 400)
    const b = starField(50, 800, 400)
    expect(a).toEqual(b)
    expect(starField(50, 800, 400, 99)).not.toEqual(a)
  })

  it('stays inside the requested area', () => {
    for (const s of starField(400, 800, 400)) {
      expect(s.x).toBeGreaterThanOrEqual(0)
      expect(s.x).toBeLessThanOrEqual(800)
      expect(s.y).toBeGreaterThanOrEqual(0)
      expect(s.y).toBeLessThanOrEqual(400)
    }
  })
})

describe('starAlpha', () => {
  const NIGHT = 0.82

  it('is zero in broad daylight even if darkness is somehow set', () => {
    expect(starAlpha(0.3, NIGHT, NIGHT)).toBe(0)
  })

  it('is full at night with full darkness', () => {
    expect(starAlpha(0.78, NIGHT, NIGHT)).toBeCloseTo(1, 5)
  })

  it('scales with darkness, so stars arrive with the dark and not with the clock', () => {
    expect(starAlpha(0.78, NIGHT / 2, NIGHT)).toBeCloseTo(0.5, 5)
    expect(starAlpha(0.78, 0, NIGHT)).toBe(0)
  })
})
