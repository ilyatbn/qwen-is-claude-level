import { describe, expect, it } from 'vitest'
import { KILLFEED_LIFETIME, KILLFEED_MAX, KillFeed, killLine } from './killfeed-state'

const entry = (victim: string, over: Partial<Parameters<KillFeed['add']>[0]> = {}) => ({
  killer: 'ana',
  victim,
  cause: 'player' as const,
  by: 'bazooka',
  involvesYou: false,
  ...over,
})

describe('kill feed', () => {
  it('evicts the oldest past the maximum', () => {
    const f = new KillFeed()
    for (let i = 0; i < KILLFEED_MAX + 3; i++) f.add(entry(`v${i}`))
    expect(f.count).toBe(KILLFEED_MAX)
    // The survivors are the newest, oldest-first.
    expect(f.live().map((e) => e.victim)).toEqual(['v3', 'v4', 'v5', 'v6', 'v7'])
  })

  it('expires entries at their lifetime', () => {
    const f = new KillFeed()
    f.add(entry('bo'))
    f.update(KILLFEED_LIFETIME - 0.01)
    expect(f.count).toBe(1)
    f.update(0.02)
    expect(f.count).toBe(0)
  })

  it('holds full opacity until the last fifth', () => {
    const f = new KillFeed()
    f.add(entry('bo'))
    f.update(KILLFEED_LIFETIME * 0.5)
    expect(f.live()[0]?.alpha).toBe(1)
    f.update(KILLFEED_LIFETIME * 0.35)
    expect(f.live()[0]?.alpha).toBeLessThan(1)
  })

  it('ages entries independently, so a burst of kills does not expire together', () => {
    const f = new KillFeed()
    f.add(entry('first'))
    f.update(KILLFEED_LIFETIME * 0.9)
    f.add(entry('second'))
    f.update(KILLFEED_LIFETIME * 0.2)
    expect(f.live().map((e) => e.victim)).toEqual(['second'])
  })
})

describe('killLine', () => {
  it('reads a self-kill as a self-kill, not as ana killing ana', () => {
    const line = killLine({ ...entry('ana'), cause: 'self', age: 0 })
    expect(line).toContain('themselves')
    expect(line).not.toContain('→')
  })

  it('credits nobody for a weather death', () => {
    const line = killLine({
      ...entry('bo'),
      killer: undefined,
      cause: 'weather' as const,
      by: 'meteor',
      age: 0,
    })
    expect(line).toBe('bo was killed by meteor')
  })

  it('names both parties and the weapon for a normal kill', () => {
    expect(killLine({ ...entry('bo'), age: 0 })).toBe('ana → bo (bazooka)')
  })
})
