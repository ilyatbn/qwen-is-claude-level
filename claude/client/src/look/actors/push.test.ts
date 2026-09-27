import { describe, expect, it } from 'vitest'
import { PUSH_HOLD_FRACTION, PushEstimate } from './push'

const FULL = 1100
const DT = 1 / 60
/** A body's velocity as the interpolator hands it over: snapshots at 20 Hz, linear between them. */
const interpolated = (v: (t: number) => number, t: number): number => {
  const a = Math.floor(t * 20) / 20
  const b = a + 1 / 20
  return v(a) + ((v(b) - v(a)) * (t - a)) / (b - a)
}

describe('T23.14D F4: a remote\'s push, estimated from its motion', () => {
  it('a body drifting right while braking pushes left — velocity alone said right', () => {
    const brake = -FULL * 1.1
    const vx = (t: number): number => 200 + brake * t
    const est = new PushEstimate()
    let push = null
    for (let i = 0; i < 9; i++) push = est.step(true, interpolated(vx, i * DT), 0, [0, 0], DT, FULL)
    expect(vx(8 * DT)).toBeGreaterThan(0) // still moving right: velocity would point the push right
    expect(push!.x).toBeLessThan(-0.5 * FULL)
    expect(Math.abs(push!.y)).toBeLessThan(1e-6)
  })

  it('the pull is taken off: a jetting body hovering against gravity pushes up', () => {
    const est = new PushEstimate()
    const g = 1400 * 0.5
    let push = null
    for (let i = 0; i < 5; i++) push = est.step(true, 0, 0, [0, g], DT, FULL)
    expect(push!.y).toBeCloseTo(-g, 3)
    // Control: the same motion with no pull is no push, and nothing clear to hold.
    const none = new PushEstimate()
    let p2 = null
    for (let i = 0; i < 5; i++) p2 = none.step(true, 0, 0, [0, 0], DT, FULL)
    expect(p2).toBeNull()
  })

  it('holds the last clear push through a flat stretch; forgets it when the burn ends', () => {
    const est = new PushEstimate()
    for (let i = 0; i < 10; i++) est.step(true, 50 + i * 15, 0, [0, 0], DT, FULL) // 900 px/s² right
    // At the speed cap: velocity stops changing, the estimate decays under the hold fraction — the push is held.
    let p = null
    for (let i = 0; i < 60; i++) p = est.step(true, 200, 0, [0, 0], DT, FULL)
    expect(p!.x).toBeGreaterThan(PUSH_HOLD_FRACTION * FULL)
    expect(est.step(false, 200, 0, [0, 0], DT, FULL)).toBeNull()
    expect(est.step(true, 200, 0, [0, 0], DT, FULL)).toBeNull()
  })
})
