import { describe, expect, it } from 'vitest'
import {
  causeText,
  countdownText,
  secondsLeft,
  shouldShow,
  type DeathInfo,
} from './deathOverlay-math'

/** The fixture's respawn delay: `respawnAt` 30 is a death at 25. */
const DELAY = 5

const info = (over: Partial<DeathInfo> = {}): DeathInfo => ({
  victim: 1,
  attacker: 2,
  cause: 'Player',
  respawnAt: 30,
  ...over,
})

describe('the countdown is the server\'s', () => {
  it('counts down against round time, not against arrival', () => {
    const d = info({ respawnAt: 30 })
    expect(secondsLeft(d, 25, DELAY)).toBeCloseTo(5)
    expect(secondsLeft(d, 28.5, DELAY)).toBeCloseTo(1.5)
    expect(secondsLeft(d, 30, DELAY)).toBe(0)
  })

  /**
   * The reason it is computed rather than decremented: the `death` event takes
   * time to arrive, so a local timer started on arrival is already late by the
   * latency, and it stays late. Recomputing from the authority's clock is
   * self-correcting.
   */
  it('is unaffected by when the event arrived', () => {
    const d = info({ respawnAt: 30 })
    // Two clients, one 300 ms behind the other, agree on what is left.
    expect(secondsLeft(d, 26.0, DELAY)).toBeCloseTo(secondsLeft(d, 26.0, DELAY))
    expect(secondsLeft(d, 26.3, DELAY) + 0.3).toBeCloseTo(secondsLeft(d, 26.0, DELAY))
  })

  /**
   * T22.14C MED-3: the countdown read "5.1s" on a 5 s respawn — the snapshot's round
   * time was deciseconds truncated, so the clock it was read against sat up to 0.1 s
   * behind the server's `respawn_at − RESPAWN_DELAY`, and a death heard before its own
   * tick's snapshot lags that too. What is left can never exceed the delay itself.
   */
  it('never reads more than the respawn delay, however far behind the clock is', () => {
    const delay = DELAY
    const d = info({ respawnAt: 30 })
    // The death's own tick is 25; the clock the page holds is behind it.
    for (const behind of [0.04, 0.09, 0.3]) {
      expect(secondsLeft(d, 25 - behind, delay)).toBeLessThanOrEqual(delay)
      expect(countdownText(secondsLeft(d, 25 - behind, delay))).toBe('5.0s')
    }
    expect(secondsLeft(d, 27, delay)).toBeCloseTo(3)
  })

  it('never goes negative, however late a snapshot is', () => {
    expect(secondsLeft(info({ respawnAt: 10 }), 999, DELAY)).toBe(0)
  })

  it('shows a decimal, because whole seconds read as frozen', () => {
    expect(countdownText(4.25)).toBe('4.3s')
    expect(countdownText(0)).toBe('Respawning…')
  })
})

describe('cause attribution', () => {
  const names = (id: number) => (id === 2 ? 'ana' : undefined)

  it('names the killer', () => {
    expect(causeText(info({ attacker: 2 }), names)).toBe('Killed by ana')
  })

  it('falls back to an id rather than saying nothing', () => {
    expect(causeText(info({ attacker: 7 }), names)).toBe('Killed by player 7')
  })

  /** A self-kill that reads "killed by you" is worse than saying nothing. */
  it('reads a self-kill as a self-kill', () => {
    expect(causeText(info({ victim: 1, attacker: 1 }), names)).toBe('You killed yourself')
  })

  it('names the weather, which credits nobody', () => {
    expect(causeText(info({ attacker: null, cause: 'MeteorShower' }), names)).toBe(
      'Killed by the meteor shower',
    )
    expect(causeText(info({ attacker: null, cause: 'LavaBurst' }), names)).toBe(
      'Killed by a lava vent',
    )
  })

  /**
   * §C15. The bug this guards: `"void"` had no arm anywhere, so it fell to
   * `weatherName`'s `default` and the overlay read **"Killed by void"** — while
   * the kill feed two inches away said "ana fell out of the world".
   */
  it('says you fell rather than "Killed by void"', () => {
    const text = causeText(info({ attacker: null, cause: 'void' }), names)
    expect(text).toBe('You fell out of the world')
    // The specific failure, named: the prefix cannot be grammatical here.
    expect(text).not.toContain('Killed by')
    expect(text).not.toContain('void')
  })

  /**
   * The control. Being blasted off the edge arrives with an attacker — the
   * server's assist window resolved it — so it is an ordinary kill and the void
   * sentence must not swallow it.
   */
  it('leaves a blast into the void as an ordinary kill', () => {
    expect(causeText(info({ attacker: 2, cause: 'void' }), names)).toBe('Killed by ana')
  })

  /** T22.09B (R20): radiation has its own sentence, not "Killed by radiation". */
  it('says the suit ran out, and leaves a credited radiation death to the shooter', () => {
    const text = causeText(info({ attacker: null, cause: 'radiation' }), names)
    expect(text).toBe('Radiation — your suit ran out of energy')
    expect(text).not.toContain('Killed by')
    // The control: a shot inside the assist window arrives credited, and is a kill.
    expect(causeText(info({ attacker: 2, cause: 'radiation' }), names)).toBe('Killed by ana')
  })

  /** T22.12 (R20): the black hole has its own sentence — you fell in. */
  it('says you fell into the black hole, and leaves a credited one to the shooter', () => {
    const text = causeText(info({ attacker: null, cause: 'black_hole' }), names)
    expect(text).toBe('You fell into the black hole')
    expect(causeText(info({ attacker: 2, cause: 'black_hole' }), names)).toBe('Killed by ana')
  })

  it('all four attribution paths produce different text', () => {
    const a = causeText(info({ attacker: 2 }), names)
    const b = causeText(info({ victim: 1, attacker: 1 }), names)
    const c = causeText(info({ attacker: null, cause: 'ToxicRain' }), names)
    const d = causeText(info({ attacker: null, cause: 'void' }), names)
    expect(new Set([a, b, c, d]).size).toBe(4)
  })
})

describe('visibility', () => {
  it('follows the server\'s alive flag, not the countdown', () => {
    const d = info({ respawnAt: 0 })
    // Countdown finished, but the server has not respawned them yet.
    expect(shouldShow(true, d)).toBe(true)
    // Server says alive: down it goes, even mid-countdown.
    expect(shouldShow(false, info({ respawnAt: 999 }))).toBe(false)
  })

  it('never shows without a death to show', () => {
    expect(shouldShow(true, null)).toBe(false)
  })
})
