import { describe, expect, it } from 'vitest'
import { FpsMeter, debugFromQuery, initialEnabled } from './debugMode'

/**
 * The DOM half — F1 toggling, the ring going, the state surviving a scene change
 * — is asserted on the rendered frame in `scripts/checks/debug-mode.mjs` (§C2).
 * What is here is the two pieces that can lie on their own.
 */
describe('debugFromQuery', () => {
  it('is off unless asked for', () => {
    expect(debugFromQuery('')).toBe(false)
    expect(debugFromQuery('?sandbox=1')).toBe(false)
    expect(debugFromQuery('?debug=0')).toBe(false)
    expect(debugFromQuery('?debug=no')).toBe(false)
  })

  it('accepts the forms a person would actually type', () => {
    expect(debugFromQuery('?debug=1')).toBe(true)
    expect(debugFromQuery('?debug')).toBe(true)
    expect(debugFromQuery('?debug=')).toBe(true)
    expect(debugFromQuery('?debug=true')).toBe(true)
    expect(debugFromQuery('?seed=7&debug=1')).toBe(true)
  })
})

describe('FpsMeter', () => {
  /**
   * Fed **known deltas**, because the thing this replaces — Phaser's
   * `game.loop.actualFps` — is a smoothed average that under-reports for seconds
   * after a stall, and §A38 spent a session on a "performance regression" that
   * was the counter and not the frame rate.
   */
  it('reports the rate the deltas describe', () => {
    const m = new FpsMeter()
    let t = 0
    for (let i = 0; i < 40; i++) m.sample((t += 1000 / 60))
    expect(m.fps()).toBeCloseTo(60, 0)

    const slow = new FpsMeter()
    t = 0
    for (let i = 0; i < 40; i++) slow.sample((t += 1000 / 30))
    expect(slow.fps()).toBeCloseTo(30, 0)
  })

  it('is empty before it has two frames', () => {
    const m = new FpsMeter()
    expect(m.fps()).toBe(0)
    m.sample(100)
    expect(m.fps()).toBe(0)
  })

  /**
   * One hitch is a hitch, not a frame rate. A mean would report 48 fps for a
   * window that was 60 fps apart from a single 200 ms stall — which is exactly
   * the lie §A38 caught.
   */
  it('a single stall does not drag the reading down', () => {
    const m = new FpsMeter()
    let t = 0
    for (let i = 0; i < 29; i++) m.sample((t += 1000 / 60))
    m.sample((t += 200))
    expect(m.fps()).toBeCloseTo(60, 0)
  })

  it('follows a change rather than averaging over all history', () => {
    const m = new FpsMeter(10)
    let t = 0
    for (let i = 0; i < 20; i++) m.sample((t += 1000 / 60))
    for (let i = 0; i < 12; i++) m.sample((t += 1000 / 20))
    expect(m.fps()).toBeCloseTo(20, 0)
  })
})

describe('initialEnabled', () => {
  /**
   * §C12: "the state survives a scene change". A scene change rebuilds every
   * DOM-owning object, so what has to survive is the *decision made at
   * construction* — and that is this. The browser check asserts the flag is
   * written; this asserts it is read.
   */
  it('comes up on when the last scene left it on', () => {
    expect(initialEnabled('', '1')).toBe(true)
  })

  it('comes up off by default, and off when the last scene turned it off', () => {
    expect(initialEnabled('', null)).toBe(false)
    expect(initialEnabled('', '0')).toBe(false)
  })

  it('lets the query parameter turn it on even when the store says off', () => {
    // Typing `?debug=1` is an explicit instruction and beats a stale flag.
    expect(initialEnabled('?debug=1', '0')).toBe(true)
  })
})
