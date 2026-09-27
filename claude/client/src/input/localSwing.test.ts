import { describe, expect, it } from 'vitest'
import { LocalSwing, type SwingUse } from './localSwing'

const COOLDOWN = 0.5
const use = (o: Partial<SwingUse> = {}): SwingUse => ({ now: 10, alive: true, mounted: false, key: 'axe', count: 1, swings: true, cooldown: COOLDOWN, ...o })

describe('T23.09D: the local swing is predicted on the frame the use is sent', () => {
  it('a use the server will take swings at once; one inside the cooldown does not; after it, does again', () => {
    const s = new LocalSwing()
    expect(s.use(use())).toBe(true)
    expect(s.use(use({ now: 10 + COOLDOWN / 2 }))).toBe(false)
    expect(s.use(use({ now: 10 + COOLDOWN }))).toBe(true)
  })

  it('refused uses do not swing: dead, riding, empty, a gun, nothing held', () => {
    for (const o of [{ alive: false }, { mounted: true }, { count: 0 }, { swings: false }, { key: null }] as Partial<SwingUse>[]) {
      expect(new LocalSwing().use(use(o))).toBe(false)
    }
    // Control: the same use with none of those swings.
    expect(new LocalSwing().use(use())).toBe(true)
  })

  it('a refused use does not start the cooldown (the next valid use still swings)', () => {
    const s = new LocalSwing()
    expect(s.use(use({ count: 0 }))).toBe(false)
    expect(s.use(use({ now: 10.01 }))).toBe(true)
    s.reset()
    expect(s.use(use({ now: 10.02 }))).toBe(true)
  })
})
