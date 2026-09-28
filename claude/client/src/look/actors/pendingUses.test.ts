import { describe, expect, it } from 'vitest'
import { PENDING_USE_BASE_MS, PENDING_USE_RTT_FACTOR, PendingUses, swings } from './pendingUses'

describe('PendingUses (T23.14F F2)', () => {
  const rtt = 80
  const bound = PENDING_USE_BASE_MS + PENDING_USE_RTT_FACTOR * rtt

  it('an echo matching a prediction plays nothing more', () => {
    const p = new PendingUses(() => rtt)
    p.predicted('shovel', 0)
    expect(p.echo('shovel', bound / 2)).toBe(false)
    expect(p.stats).toEqual({ predicted: 1, confirmed: 1, late: 0, dropped: 0 })
    expect(p.waiting).toBe(0)
  })

  it('an echo with no prediction plays late — and a second echo of one prediction plays too', () => {
    const p = new PendingUses(() => rtt)
    expect(p.echo('shovel', 10)).toBe(true)
    p.predicted('shovel', 20)
    expect(p.echo('shovel', 30)).toBe(false)
    expect(p.echo('shovel', 40)).toBe(true)
    expect(p.stats.late).toBe(2)
  })

  it('a prediction with no echo within the bound is dropped: its late echo swings (it would have been a second)', () => {
    const p = new PendingUses(() => rtt)
    p.predicted('molotov', 0)
    p.expire(bound - 1)
    expect(p.waiting).toBe(1)
    // Control above; past the bound it is gone, so an echo then finds nothing.
    expect(p.echo('molotov', bound + 1)).toBe(true)
    expect(p.stats.dropped).toBe(1)
  })

  it('matches by key: an echo of another item neither confirms nor consumes the prediction', () => {
    const p = new PendingUses(() => rtt)
    p.predicted('grenade', 0)
    expect(p.echo('molotov', 5)).toBe(true)
    expect(p.waiting).toBe(1)
    expect(p.echo('grenade', 6)).toBe(false)
  })

  it('the bound grows with the measured round trip', () => {
    const slow = new PendingUses(() => 500)
    slow.predicted('knife', 0)
    slow.expire(bound + 1)
    expect(slow.waiting).toBe(1)
  })

  it('a gun moves no figure: never kept, never echoed', () => {
    expect(swings('smg')).toBe(false)
    expect(swings('shovel')).toBe(true)
    expect(swings('mine')).toBe(true)
    const p = new PendingUses(() => rtt)
    p.predicted('smg', 0)
    expect(p.waiting).toBe(0)
    expect(p.echo('smg', 1)).toBe(false)
  })
})
