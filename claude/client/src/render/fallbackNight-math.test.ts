import { describe, it, expect } from 'vitest'
import { FALLBACK_NIGHT_SHARE, fallbackNightAlpha } from './fallbackNight-math'
import { NIGHT_VIEW_KEEP } from '../look/worldRenderer-math'

describe('the Phaser fallback night (T23.10C F6)', () => {
  // A night darkness: the function scales by darkness / nightDarkness, so any positive value serves.
  const N = 0.5

  it('dims by night, to its share of the night view at full night', () => {
    expect(fallbackNightAlpha(N, N)).toBeCloseTo(FALLBACK_NIGHT_SHARE * (1 - NIGHT_VIEW_KEEP), 9)
    expect(fallbackNightAlpha(N / 2, N)).toBeCloseTo((FALLBACK_NIGHT_SHARE * (1 - NIGHT_VIEW_KEEP)) / 2, 9)
  })

  it('does not dim the day — the control', () => {
    expect(fallbackNightAlpha(0, N)).toBe(0)
    expect(fallbackNightAlpha(N, 0)).toBe(0)
  })

  it('never dims past full night, nor as far as the night view does outside the sight', () => {
    expect(fallbackNightAlpha(N * 3, N)).toBeCloseTo(fallbackNightAlpha(N, N), 9)
    expect(fallbackNightAlpha(N, N)).toBeLessThan(1 - NIGHT_VIEW_KEEP)
  })
})
