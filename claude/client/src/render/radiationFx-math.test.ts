import { describe, expect, it } from 'vitest'
import {
  ExposureClock,
  RADIATION_EDGE_MAX,
  RADIATION_EDGE_MIN,
  edgeAlpha,
  suitLine,
  suitState,
} from './radiationFx-math'

describe('suitState', () => {
  it('is irradiated whenever the Rust predicate says so, and sealed only in space alive', () => {
    expect(suitState(true, true, true)).toBe('irradiated')
    expect(suitState(true, true, false)).toBe('sealed')
    // The absences, each with the one input that turns it off.
    expect(suitState(false, true, false)).toBe('none')
    expect(suitState(true, false, false)).toBe('none')
  })
})

describe('suitLine', () => {
  it('names radiation and the fix when flat, and says the suit softens every hit when sealed (F4)', () => {
    expect(suitLine('irradiated')).toMatch(/RADIATION/)
    expect(suitLine('irradiated')).toMatch(/battery pack/)
    expect(suitLine('sealed')).toMatch(/softens every hit/)
    expect(suitLine('sealed')).not.toMatch(/RADIATION ·/)
    expect(suitLine('none')).toBeNull()
  })
})

describe('edgeAlpha', () => {
  const period = 1

  it('starts at the crest, troughs half a period in, and repeats', () => {
    expect(edgeAlpha(0, period)).toBeCloseTo(RADIATION_EDGE_MAX, 9)
    expect(edgeAlpha(period / 2, period)).toBeCloseTo(RADIATION_EDGE_MIN, 9)
    expect(edgeAlpha(period, period)).toBeCloseTo(RADIATION_EDGE_MAX, 9)
    expect(edgeAlpha(0.3 * period, period)).toBeCloseTo(edgeAlpha(1.3 * period, period), 9)
  })

  it('never leaves its band — no frame of an exposure is dark', () => {
    for (let i = 0; i <= 200; i++) {
      const a = edgeAlpha(i * 0.0137, period)
      expect(a).toBeGreaterThanOrEqual(RADIATION_EDGE_MIN - 1e-12)
      expect(a).toBeLessThanOrEqual(RADIATION_EDGE_MAX + 1e-12)
    }
    // The floor is what the `radiation` browser check leans on: a trough frame
    // must still read against the sealed control frame.
    expect(RADIATION_EDGE_MIN).toBeGreaterThan(0)
  })

  it('holds the crest on a degenerate period or clock rather than producing NaN', () => {
    expect(edgeAlpha(0.4, 0)).toBe(RADIATION_EDGE_MAX)
    expect(edgeAlpha(Number.NaN, period)).toBe(RADIATION_EDGE_MAX)
  })
})

describe('ExposureClock', () => {
  it('runs only while irradiated and restarts at each onset', () => {
    const c = new ExposureClock()
    c.update(0.25, 'irradiated')
    c.update(0.25, 'irradiated')
    expect(c.seconds).toBeCloseTo(0.5, 9)
    c.update(0.25, 'sealed')
    expect(c.seconds).toBe(0)
    c.update(0.1, 'irradiated')
    expect(c.seconds).toBeCloseTo(0.1, 9)
  })
})
