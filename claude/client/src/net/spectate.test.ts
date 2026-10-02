import { describe, expect, it } from 'vitest'
import { stepWatch, WatchState } from './spectate'

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

  it('watches the first living player and keeps them through death and respawn; only a leaver is replaced', () => {
    const w = new WatchState()
    expect(w.update([P(3), P(5)], 0)).toBe(3)
    // Dies and stays dead for a long time: still watched (owner, 2026-10-02 — no hopping on every death).
    expect(w.update([P(3, false), P(5)], 100)).toBe(3)
    expect(w.update([P(3, false), P(5)], 60_000)).toBe(3)
    // Respawns: still watched.
    expect(w.update([P(3), P(5)], 61_000)).toBe(3)
    // Control: a watched player who leaves is replaced at once.
    expect(w.update([P(5)], 62_000)).toBe(5)
  })

  it('Tab still steps to the next living player while the watched one is dead', () => {
    const w = new WatchState()
    w.update([P(3), P(5)], 0)
    w.update([P(3, false), P(5)], 10)
    expect(w.step([P(3, false), P(5)], 1)).toBe(5)
  })

})
