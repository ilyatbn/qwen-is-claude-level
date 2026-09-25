import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../core'
import {
  BLACK_HOLE_GLOW_HORIZONS,
  BLACK_HOLE_GROW_MS,
  BLACK_HOLE_RING_COLOR,
  BLACK_HOLE_RING_GAP,
  BLACK_HOLE_RING_W,
  BLACK_HOLE_STREAKS,
  BLACK_HOLE_WARN_COLOR,
  blackHoleGrowth,
  blackHoleRadii,
  rgbOf,
  streakPhase,
  warnClosingRadius,
  warnProgress,
} from './blackHoleFx-math'

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
}, 60_000)

describe('the black hole drawing (T22.12B)', () => {
  it('sizes every ring off the core: the disc is the horizon, the ring hugs it, the glow ends at its own radius inside the reach', () => {
    const k = C()
    const r = blackHoleRadii(k)
    // Not NaN: the constants reached the client (an absent key reads undefined).
    expect(r.horizon).toBeGreaterThan(0)
    expect(r.horizon).toBe(k.BLACK_HOLE_HORIZON_R)
    expect(r.reach).toBe(k.BLACK_HOLE_REACH)
    // The ring's inner edge is outside the disc, so the disc stays black to its edge.
    expect(r.ring - BLACK_HOLE_RING_W / 2).toBe(r.horizon + BLACK_HOLE_RING_GAP)
    expect(r.horizon < r.ring && r.ring < r.glow && r.glow <= r.reach).toBe(true)
    // T22.18: the glow is decoration, sized off the horizon — not the reach R106 doubled.
    expect(r.glow).toBe(k.BLACK_HOLE_HORIZON_R * BLACK_HOLE_GLOW_HORIZONS)
    // R90: one line, not two — the capture ring is gone, and so is its radius.
    expect(Object.keys(r).sort()).toEqual(['glow', 'horizon', 'reach', 'ring'])
    expect('BLACK_HOLE_CAPTURE_R' in k).toBe(false)
  })

  it('telegraphs from the glow edge onto the horizon over the warning, and holds at the end (R93)', () => {
    const r = blackHoleRadii(C())
    const span = C().BLACK_HOLE_TELEGRAPH * 1000
    expect(span).toBeGreaterThan(0)
    expect(warnProgress(500, 500 + span, 500)).toBe(0)
    expect(warnProgress(500, 500 + span, 500 + span / 2)).toBeCloseTo(0.5, 6)
    expect(warnProgress(500, 500 + span, 500 + span)).toBe(1)
    // Past the promised moment with no hole yet (a late event, a stalled page): held.
    expect(warnProgress(500, 500 + span, 500 + 10 * span)).toBe(1)
    // A zero-length warning (a catch-up at the last instant) is complete, not NaN.
    expect(warnProgress(500, 500, 500)).toBe(1)
    expect(warnClosingRadius(r, 0)).toBe(r.glow)
    expect(warnClosingRadius(r, 1)).toBe(r.horizon)
  })

  it('swells in on arrival and then stays at full size', () => {
    expect(blackHoleGrowth(1000, 1000)).toBe(0)
    expect(blackHoleGrowth(1000, 1000 + BLACK_HOLE_GROW_MS / 2)).toBeGreaterThan(0.5)
    expect(blackHoleGrowth(1000, 1000 + BLACK_HOLE_GROW_MS)).toBe(1)
    // Stays: an hour later, and a results screen later, it is still whole.
    expect(blackHoleGrowth(1000, 1000 + 3_600_000)).toBe(1)
    // A clock read before the arrival (a catch-up) draws nothing yet, not a negative size.
    expect(blackHoleGrowth(1000, 0)).toBe(0)
  })

  it('spaces the streaks evenly and turns them', () => {
    const a = streakPhase(0, 0)
    const b = streakPhase(1, 0)
    expect(b - a).toBeCloseTo((2 * Math.PI) / BLACK_HOLE_STREAKS, 6)
    expect(streakPhase(0, 1)).not.toBe(a)
  })

  it('names the ring colour the check will ask for', () => {
    expect(rgbOf(BLACK_HOLE_RING_COLOR)).toEqual([0xff, 0xc8, 0x70])
    // The telegraph's own colour, not the hole's: a check asking for one must not
    // be satisfied by the other.
    expect(rgbOf(BLACK_HOLE_WARN_COLOR)).not.toEqual(rgbOf(BLACK_HOLE_RING_COLOR))
  })
})
