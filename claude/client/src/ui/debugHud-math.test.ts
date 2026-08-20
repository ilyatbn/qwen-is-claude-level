import { describe, expect, it } from 'vitest'
import { CorrectionStats, RateMeter, estimateLoss, jitterMs } from './debugHud-math'

describe('RateMeter', () => {
  it('is zero before anything happens', () => {
    expect(new RateMeter(1000).perSecond(0)).toBe(0)
  })

  it('reports events per second over the window', () => {
    const m = new RateMeter(1000)
    for (let i = 0; i < 20; i++) m.mark(i * 50)
    expect(m.perSecond(950)).toBeCloseTo(20, 5)
  })

  /**
   * Dividing by the observed span rather than the window reports a single event
   * as an infinite rate — the classic way this meter gets written wrong.
   */
  it('does not report one event as an infinite rate', () => {
    const m = new RateMeter(1000)
    m.mark(500)
    expect(Number.isFinite(m.perSecond(500))).toBe(true)
    expect(m.perSecond(500)).toBeCloseTo(1, 5)
  })

  it('forgets events older than the window, so it describes now', () => {
    const m = new RateMeter(1000)
    for (let i = 0; i < 60; i++) m.mark(i * 10) // a burst in the first 600 ms
    expect(m.perSecond(600)).toBeCloseTo(60, 5)
    // Two seconds later the burst is gone and the rate is honest about it.
    expect(m.perSecond(2600)).toBe(0)
  })

  it('counts a batch as a batch', () => {
    const m = new RateMeter(1000)
    m.mark(0, 5)
    expect(m.count).toBe(5)
  })
})

describe('CorrectionStats', () => {
  it('is empty before anything happens', () => {
    expect(new CorrectionStats().summary(0)).toEqual({ count: 0, mean: 0, max: 0 })
  })

  it('reports mean and max together — the rate alone does not distinguish noise from a desync', () => {
    const s = new CorrectionStats(1000)
    s.add(0, 2)
    s.add(100, 2)
    s.add(200, 300)
    const r = s.summary(300)
    expect(r.count).toBe(3)
    expect(r.mean).toBeCloseTo(101.33, 1)
    expect(r.max).toBe(300)
  })

  it('drops samples outside the window', () => {
    const s = new CorrectionStats(1000)
    s.add(0, 500)
    s.add(100, 4)
    expect(s.summary(1050).count).toBe(1)
    expect(s.summary(1050).max).toBe(4)
  })
})

describe('estimateLoss', () => {
  it('is zero for an unbroken sequence', () => {
    expect(estimateLoss([0, 3, 6, 9, 12])).toBe(0)
  })

  it('is zero when there is not enough to judge', () => {
    expect(estimateLoss([])).toBe(0)
    expect(estimateLoss([7])).toBe(0)
  })

  it('sees a single dropped snapshot', () => {
    // 0,3,[6 missing],9 — 4 expected, 3 arrived.
    expect(estimateLoss([0, 3, 9])).toBeCloseTo(25, 5)
  })

  it('scales with the size of the gap', () => {
    expect(estimateLoss([0, 30])).toBeGreaterThan(estimateLoss([0, 3, 9]))
  })
})

describe('jitterMs', () => {
  it('is zero for perfectly even arrivals', () => {
    expect(jitterMs([0, 50, 100, 150, 200])).toBeCloseTo(0, 5)
  })

  it('is zero when there is not enough to judge', () => {
    expect(jitterMs([0, 50])).toBe(0)
  })

  it('grows with irregularity', () => {
    const even = jitterMs([0, 50, 100, 150])
    const uneven = jitterMs([0, 10, 100, 110])
    expect(uneven).toBeGreaterThan(even)
  })
})
