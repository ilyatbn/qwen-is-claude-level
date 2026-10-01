import { describe, expect, it } from 'vitest'
import { SPECTATE_DEATH_LINGER_MS, stepWatch, WatchState } from './spectate'

const P = (id: number, alive = true) => ({ id, alive })

describe('T23.27: whom a spectator watches', () => {
  it('Tab steps to the next living player in id order and wraps; Shift+Tab goes back', () => {
    const ps = [P(4), P(1), P(7, false), P(9)]
    expect(stepWatch(ps, null, 1)).toBe(1)
    expect(stepWatch(ps, 1, 1)).toBe(4)
    expect(stepWatch(ps, 4, 1)).toBe(9) // 7 is dead: skipped
    expect(stepWatch(ps, 9, 1)).toBe(1) // wraps
    expect(stepWatch(ps, 1, -1)).toBe(9)
    expect(stepWatch(ps, 9, -1)).toBe(4)
    // Nobody alive: stay put rather than invent one.
    expect(stepWatch([P(2, false)], 2, 1)).toBe(2)
  })

  it('watches the first living player, stays on a death for the linger, then moves on', () => {
    const w = new WatchState()
    expect(w.update([P(3), P(5)], 0)).toBe(3)
    // Dies: held through the linger (the control — it does not jump at once)…
    expect(w.update([P(3, false), P(5)], 100)).toBe(3)
    expect(w.update([P(3, false), P(5)], 100 + SPECTATE_DEATH_LINGER_MS - 1)).toBe(3)
    // …and moved on after it.
    expect(w.update([P(3, false), P(5)], 100 + SPECTATE_DEATH_LINGER_MS)).toBe(5)
    // A watched player who leaves is replaced at once.
    expect(w.update([P(3)], 5000)).toBe(3)
  })

  it('a respawn inside the linger keeps the camera on them', () => {
    const w = new WatchState()
    w.update([P(3), P(5)], 0)
    w.update([P(3, false), P(5)], 10)
    expect(w.update([P(3), P(5)], 500)).toBe(3)
    expect(w.update([P(3), P(5)], 10 + SPECTATE_DEATH_LINGER_MS * 2)).toBe(3)
  })
})
