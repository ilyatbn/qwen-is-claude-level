import { describe, expect, it } from 'vitest'
import { PENDING_USE_BASE_MS, PENDING_USE_RTT_FACTOR, PendingUses, RttFilter, RTT_VAR_K, swings } from './pendingUses'

describe('PendingUses (T23.14F F2, paired by seq since T23.19D F4)', () => {
  const rtt = 80
  const bound = PENDING_USE_BASE_MS + PENDING_USE_RTT_FACTOR * rtt

  it('an echo matching a prediction plays nothing more', () => {
    const p = new PendingUses(() => rtt)
    p.predicted('shovel', 7, 0)
    expect(p.echo('shovel', 7, bound / 2)).toBe(false)
    expect(p.stats).toEqual({ predicted: 1, confirmed: 1, late: 0, dropped: 0 })
    expect(p.waiting).toBe(0)
  })

  it('an echo with no prediction plays late — and a second echo of one prediction plays too', () => {
    const p = new PendingUses(() => rtt)
    expect(p.echo('shovel', 3, 10)).toBe(true)
    p.predicted('shovel', 4, 20)
    expect(p.echo('shovel', 4, 30)).toBe(false)
    expect(p.echo('shovel', 4, 40)).toBe(true)
    expect(p.stats.late).toBe(2)
  })

  it('F4: a refused prediction still waiting does not swallow the echo of a later use of the same weapon', () => {
    // The mirror swung for seq 10, the server refused it; the mirror refused seq 20, the server took it. FIFO per key
    // paired 20's echo with 10's prediction and 20 never swung. By seq, 20 is late (it swings) and 10 stays waiting.
    const p = new PendingUses(() => rtt)
    p.predicted('grenade', 10, 0)
    expect(p.echo('grenade', 20, 50)).toBe(true)
    expect(p.waiting).toBe(1)
    // Control: the echo of 10 itself is still paired.
    expect(p.echo('grenade', 10, 60)).toBe(false)
    expect(p.waiting).toBe(0)
  })

  it('F4: echoes out of order pair with their own predictions', () => {
    const p = new PendingUses(() => rtt)
    p.predicted('knife', 1, 0)
    p.predicted('grenade', 1, 0)
    p.predicted('knife', 30, 500)
    expect(p.echo('knife', 30, 510)).toBe(false)
    expect(p.echo('grenade', 1, 520)).toBe(false)
    expect(p.echo('knife', 1, 530)).toBe(false)
    expect(p.stats.late).toBe(0)
  })

  it('an echo naming no seq matches nothing: it plays late', () => {
    const p = new PendingUses(() => rtt)
    p.predicted('knife', 1, 0)
    expect(p.echo('knife', null, 5)).toBe(true)
    expect(p.waiting).toBe(1)
  })

  it('a prediction with no echo within the bound is dropped: its late echo swings (it would have been a second)', () => {
    const p = new PendingUses(() => rtt)
    p.predicted('molotov', 2, 0)
    p.expire(bound - 1)
    expect(p.waiting).toBe(1)
    // Control above; past the bound it is gone, so an echo then finds nothing.
    expect(p.echo('molotov', 2, bound + 1)).toBe(true)
    expect(p.stats.dropped).toBe(1)
  })

  it('matches by key: an echo of another item neither confirms nor consumes the prediction', () => {
    const p = new PendingUses(() => rtt)
    p.predicted('grenade', 5, 0)
    expect(p.echo('molotov', 5, 5)).toBe(true)
    expect(p.waiting).toBe(1)
    expect(p.echo('grenade', 5, 6)).toBe(false)
  })

  it('the bound grows with the round trip', () => {
    const slow = new PendingUses(() => 500)
    slow.predicted('knife', 1, 0)
    slow.expire(bound + 1)
    expect(slow.waiting).toBe(1)
  })

  it('a gun moves no figure: never kept, never echoed', () => {
    expect(swings('smg')).toBe(false)
    expect(swings('shovel')).toBe(true)
    expect(swings('mine')).toBe(true)
    const p = new PendingUses(() => rtt)
    p.predicted('smg', 1, 0)
    expect(p.waiting).toBe(0)
    expect(p.echo('smg', 1, 1)).toBe(false)
  })
})

describe('RttFilter (T23.19D F4)', () => {
  it('is 0 before a sample, the first sample with its spread after one', () => {
    const f = new RttFilter()
    expect(f.value).toBe(0)
    f.sample(80)
    expect(f.value).toBe(80 + RTT_VAR_K * 40)
  })

  it('a steady link converges to its round trip; one fast sample does not shrink the bound to it', () => {
    const f = new RttFilter()
    for (let i = 0; i < 200; i++) f.sample(300)
    expect(f.value).toBeCloseTo(300, 3)
    f.sample(5)
    // Control: the last sample alone (the bound's input before) would read 5, and a real echo 300 ms out would be
    // dropped as unanswered. The filter errs wide: a spread sample widens the bound (a late echo is the worse error).
    expect(f.value).toBeGreaterThan(300)
    for (let i = 0; i < 200; i++) f.sample(300)
    expect(f.value).toBeCloseTo(300, 1)
  })

  it('ignores what is not a round trip', () => {
    const f = new RttFilter()
    f.sample(Number.NaN)
    f.sample(-5)
    expect(f.value).toBe(0)
  })
})
