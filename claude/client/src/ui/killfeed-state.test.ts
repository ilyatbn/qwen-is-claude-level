import { describe, expect, it } from 'vitest'
import {
  KILLFEED_LIFETIME,
  KILLFEED_MAX,
  KillFeed,
  feedCause,
  killLine,
  type KillEntry,
} from './killfeed-state'

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

/**
 * §C15's void deaths. Split out because the failure they guard against is a
 * *rendering* one that no server-side test can see: `cause: 'void'` with no
 * attacker used to fall through to the last line of `killLine` and come out as
 * `? → ana`, inventing a killer for someone who fell down a hole they dug.
 */
describe('a void death', () => {
  const entry = (over: Partial<KillEntry> = {}): KillEntry => ({
    victim: 'ana',
    killer: undefined,
    cause: 'void',
    by: 'void',
    involvesYou: false,
    age: 0,
    ...over,
  })

  it('names nobody when you fell in alone', () => {
    const line = killLine(entry())
    expect(line).toBe('ana fell out of the world')
    // The specific bug: no invented killer.
    expect(line).not.toContain('?')
    expect(line).not.toContain('→')
  })

  // The control. Without it, "no arrow, no question mark" is satisfied by a
  // `killLine` that returns the same sentence for everything.
  it('still renders an ordinary kill with an arrow', () => {
    expect(killLine(entry({ cause: 'player', killer: 'bo', by: 'bazooka' }))).toBe(
      'bo → ana (bazooka)',
    )
  })

  // A player blasted into the void arrives as cause 'player' (the server's
  // assist window resolves it), so the void line must not swallow that case.
  it('leaves a blast-into-the-void as a normal kill', () => {
    expect(killLine(entry({ cause: 'player', killer: 'bo', by: 'bazooka' }))).toContain('bo →')
  })
})

/**
 * T22.09B, `M22-RULINGS` R20: a radiation death **at both ends of the client**. The
 * allowlist used to live inline in `GameScene`, where anything unlisted became
 * `'player'` and rendered `"? → ana (radiation)"`.
 */
describe('a radiation death', () => {
  it('passes the allowlist as itself, and the unknown still falls to player', () => {
    expect(feedCause('radiation', undefined, 3)).toBe('radiation')
    expect(feedCause('void', undefined, 3)).toBe('void')
    expect(feedCause('weather', undefined, 3)).toBe('weather')
    // The control: the default is still there, so the arm above is what passed it.
    // (It was `'black_hole'` until T22.12 made that a cause of its own.)
    expect(feedCause('quasar', undefined, 3)).toBe('player')
    expect(feedCause('player', 1, 3)).toBe('player')
    // Ids decide a self-kill, whatever the string.
    expect(feedCause('selfinflicted', 3, 3)).toBe('self')
  })

  it('names the suit and invents no killer', () => {
    const line = killLine({
      victim: 'ana',
      killer: undefined,
      cause: 'radiation',
      by: 'radiation',
      involvesYou: false,
      age: 0,
    })
    expect(line).toBe("ana's suit ran flat (radiation)")
    expect(line).not.toContain('?')
    expect(line).not.toContain('→')
  })
})

/** T22.12 (R20): the black hole at both ends of the client — the allowlist and the line. */
describe('a black hole death', () => {
  it('passes the allowlist as itself and reads as falling in, with no killer', () => {
    expect(feedCause('black_hole', undefined, 3)).toBe('black_hole')
    const line = killLine({
      victim: 'ana',
      killer: undefined,
      cause: 'black_hole',
      by: 'black_hole',
      involvesYou: false,
      age: 0,
    })
    expect(line).toBe('ana fell into the black hole')
    expect(line).not.toContain('?')
  })
})

