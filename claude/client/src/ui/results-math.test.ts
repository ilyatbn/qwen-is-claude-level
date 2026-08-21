import { describe, expect, it } from 'vitest'
import {
  escapeHtml,
  resultsView,
  shouldShowResults,
  voteSecondsLeft,
  voteSummary,
} from './results-math'
import type { ScoreEntry } from './scoreboard'

const e = (over: Partial<ScoreEntry> = {}): ScoreEntry => ({
  id: 0,
  name: 'ana',
  score: 0,
  deaths: 0,
  joinOrder: 0,
  ...over,
})

describe('shouldShowResults', () => {
  it('is up in ended and down in every other phase', () => {
    expect(shouldShowResults('ended')).toBe(true)
    // The control. "It shows in ended" alone passes for a screen that is always
    // up, which is exactly the bug in reverse — the field would be unplayable.
    for (const p of ['lobby', 'warmup', 'playing']) {
      expect(shouldShowResults(p)).toBe(false)
    }
  })

  it('does not decide from the clock', () => {
    // A client that showed results when its own timer hit zero would take input
    // away from a player the server still considers alive.
    expect(shouldShowResults('playing')).toBe(false)
  })
})

describe('voteSecondsLeft', () => {
  it('floors at zero and rounds up', () => {
    expect(voteSecondsLeft(4.2)).toBe(5)
    expect(voteSecondsLeft(0)).toBe(0)
    expect(voteSecondsLeft(-3)).toBe(0)
  })
})

describe('resultsView', () => {
  it('ranks by score, then fewest deaths, then join order', () => {
    const v = resultsView([
        e({ id: 1, name: 'bo', score: 2, deaths: 4, joinOrder: 1 }),
        e({ id: 2, name: 'cy', score: 5, deaths: 1, joinOrder: 2 }),
        e({ id: 3, name: 'di', score: 5, deaths: 0, joinOrder: 3 }),
      ], 10, false)
    expect(v.rows.map((r) => r.name)).toEqual(['di', 'cy', 'bo'])
  })

  it('shows a tie as a tie rather than inventing an order', () => {
    const v = resultsView([
        e({ id: 1, name: 'bo', score: 5, deaths: 1, joinOrder: 1 }),
        e({ id: 2, name: 'cy', score: 5, deaths: 1, joinOrder: 2 }),
      ], 10, false)
    expect(v.rows.map((r) => r.rank)).toEqual([1, 1])
    expect(v.rows.every((r) => r.tied)).toBe(true)
  })

  it('carries a negative score through — it is signed and may be below zero', () => {
    const v = resultsView([e({ score: -2 })], 1, false)
    expect(v.rows[0]!.score).toBe(-2)
  })
})

describe('voteSummary', () => {
  it('states the rule the server actually implements', () => {
    // `restart_wins` is `yes * 2 > cast`: a majority of those who voted, with
    // abstentions ignored. The text must not promise a different rule.
    expect(voteSummary()).toMatch(/majority of the players who vote/i)
  })

  it('quotes no tally, because the client is never sent one', () => {
    // `round_state` carries phase, time_left and seed — no vote data. A summary
    // with numbers in it would be reading a field that does not exist, which
    // renders as a confident `0/4` and can never fail (§B15).
    expect(voteSummary()).not.toMatch(/\d/)
  })
})

describe('escapeHtml', () => {
  it('neutralises a name that would otherwise execute', () => {
    // Names come from `join` and are attacker-controlled, and this screen shows
    // every player in the room to every player in the room.
    const out = escapeHtml('<img src=x onerror="alert(1)">')
    expect(out).not.toContain('<')
    expect(out).not.toContain('"')
    expect(out).toContain('&lt;img')
  })

  it('leaves ordinary names alone', () => {
    expect(escapeHtml('ana')).toBe('ana')
  })
})
