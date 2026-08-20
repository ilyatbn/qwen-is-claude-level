import { describe, expect, it } from 'vitest'
import {
  causeText,
  countdownText,
  secondsLeft,
  shouldShow,
  type DeathInfo,
} from './deathOverlay-math'

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
    expect(secondsLeft(d, 25)).toBeCloseTo(5)
    expect(secondsLeft(d, 28.5)).toBeCloseTo(1.5)
    expect(secondsLeft(d, 30)).toBe(0)
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
    expect(secondsLeft(d, 26.0)).toBeCloseTo(secondsLeft(d, 26.0))
    expect(secondsLeft(d, 26.3) + 0.3).toBeCloseTo(secondsLeft(d, 26.0))
  })

  it('never goes negative, however late a snapshot is', () => {
    expect(secondsLeft(info({ respawnAt: 10 }), 999)).toBe(0)
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

  it('all three attribution paths produce different text', () => {
    const a = causeText(info({ attacker: 2 }), names)
    const b = causeText(info({ victim: 1, attacker: 1 }), names)
    const c = causeText(info({ attacker: null, cause: 'ToxicRain' }), names)
    expect(new Set([a, b, c]).size).toBe(3)
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
