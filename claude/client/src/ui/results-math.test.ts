import { describe, expect, it } from 'vitest'
import {
  escapeHtml,
  phaseDeadline,
  resultsView,
  secondsUntil,
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

describe('the countdown is a deadline, not a stopwatch (§C25)', () => {
  const SIM_DT = 1 / 60
  const ENDED_SECONDS = 20

  it('falls as the server clock advances, sampled at several points', () => {
    // The bug: `round_state` is emitted once at the Playing -> Ended transition
    // and never again (`round.rs` has no periodic branch for `Ended`), so a
    // client holding `time_left` renders the same number for twenty seconds.
    // The deadline is fixed once and the remaining time is derived from the
    // server's round time, which every snapshot resyncs.
    const deadline = phaseDeadline(100, 6000, 6000, ENDED_SECONDS, SIM_DT)
    expect(deadline).toBeCloseTo(120, 6)

    // Sampled at several points, not just at the start — a stopwatch that runs
    // once would pass a single-sample assertion.
    const seen = [100, 105, 112.5, 119, 120].map((t) =>
      voteSecondsLeft(secondsUntil(deadline, t)),
    )
    expect(seen).toEqual([20, 15, 8, 1, 0])
  })

  it('reaches zero exactly at the deadline and never goes negative', () => {
    const deadline = phaseDeadline(0, 60, 60, ENDED_SECONDS, SIM_DT)
    expect(secondsUntil(deadline, 20)).toBeCloseTo(0, 6)
    expect(voteSecondsLeft(secondsUntil(deadline, 20))).toBe(0)
    // Past it: the server has already moved on, and a negative countdown on
    // screen is worse than none.
    expect(voteSecondsLeft(secondsUntil(deadline, 25))).toBe(0)
  })

  it('places the deadline in the server frame, not the client one', () => {
    // The `round_state` announcing the phase is emitted on tick 6003 while the
    // last snapshot the client holds is tick 6000 at round time 100. The three
    // ticks between them are the server's, so the deadline is 20 s after 100.05
    // — not after 100. Without the correction the countdown is early by exactly
    // the age of the snapshot, which is the drift §B4 exists to remove.
    const d = phaseDeadline(100, 6000, 6003, ENDED_SECONDS, SIM_DT)
    expect(d).toBeCloseTo(120 + 3 * SIM_DT, 6)
  })

  it('skips the correction before the first snapshot has landed', () => {
    // A client is sent a `round_state` as part of its own join, before any
    // snapshot: `lastServerTick` is still 0. Applying `(stateTick - 0) * SIM_DT`
    // there would push the deadline a hundred seconds into the future on a
    // six-thousand-tick-old room, and the countdown would never move.
    expect(phaseDeadline(100, 0, 6000, ENDED_SECONDS, SIM_DT)).toBeCloseTo(120, 6)
  })

  it('is not the raw `time_left` field', () => {
    // The control for the whole fix: the old behaviour is `time_left` held
    // constant, and this asserts the new value diverges from it as time passes.
    const timeLeft = ENDED_SECONDS
    const deadline = phaseDeadline(0, 60, 60, timeLeft, SIM_DT)
    const afterFiveSeconds = secondsUntil(deadline, 5)
    expect(afterFiveSeconds).toBeCloseTo(15, 6)
    expect(afterFiveSeconds).not.toBeCloseTo(timeLeft, 6)
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

describe('phaseDeadline across a restart', () => {
  // Declared here too: the block above has its own copies, and these tests were
  // written against those without being inside them — so `tsc` failed on four
  // undefined names while `vitest --run results` passed, because the runner
  // transpiles rather than type-checks. `npm run typecheck` is in the gate.
  const SIM_DT = 1 / 60
  const ENDED_SECONDS = 20

  /**
   * The second round, and every round after it.
   *
   * `Room::restart` assigns a fresh `World`, so the server's `tick` and
   * `round_time` both return to 0 — the only time either goes backwards. A
   * client still holding the previous round's anchor computed a correction of
   * `(1 - 15000) * SIM_DT ≈ -250 s` and a deadline of 0.02, which rendered
   * "Warmup — 0:00" for the whole ten-second warmup of round two and left that
   * round's results countdown dead on arrival.
   */
  it('discards the previous round\'s anchor when the server clock resets', () => {
    // Round one ran its full length after a long lobby: a big tick, a big
    // round time. Then `round_state { tick: 1, warmup, 10 }` arrives.
    const stale = phaseDeadline(240, 15000, 1, 10, SIM_DT)
    expect(stale).toBeCloseTo(10, 5)
    // And the control: within one round the correction still applies, or this
    // would be satisfied by a build that ignored the anchor entirely.
    const sameRound = phaseDeadline(100, 6000, 6060, 20, SIM_DT)
    expect(sameRound).toBeCloseTo(100 + 1 + 20, 5)
  })

  it('reads a full window at the start of the restarted round', () => {
    const deadline = phaseDeadline(240, 15000, 1, ENDED_SECONDS, SIM_DT)
    // The first snapshot of the new world puts round time back at ~0.
    expect(secondsUntil(deadline, 0)).toBeCloseTo(ENDED_SECONDS, 5)
    expect(voteSecondsLeft(secondsUntil(deadline, 0))).toBe(ENDED_SECONDS)
  })
})
