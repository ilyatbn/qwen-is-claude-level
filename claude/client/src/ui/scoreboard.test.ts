import { describe, expect, it } from 'vitest'
import { formatClock, formatScore, phaseBanner, rankScores, type ScoreEntry } from './scoreboard'

const e = (id: number, score: number, deaths = 0, joinOrder = id): ScoreEntry => ({
  id,
  name: `p${id}`,
  score,
  deaths,
  joinOrder,
})

describe('rankScores', () => {
  it('sorts by score descending', () => {
    const r = rankScores([e(1, 2), e(2, 9), e(3, 5)])
    expect(r.map((x) => x.id)).toEqual([2, 3, 1])
  })

  it('breaks a score tie on fewest deaths', () => {
    const r = rankScores([e(1, 5, 4), e(2, 5, 1)])
    expect(r.map((x) => x.id)).toEqual([2, 1])
  })

  it('breaks a score and death tie on join order', () => {
    const r = rankScores([e(1, 5, 2, 9), e(2, 5, 2, 3)])
    expect(r.map((x) => x.id)).toEqual([2, 1])
  })

  it('shows a tie at the top as a tie rather than as 1st and 2nd', () => {
    const r = rankScores([e(1, 5, 2, 1), e(2, 5, 2, 2), e(3, 1)])
    expect(r[0]!.rank).toBe(1)
    expect(r[1]!.rank).toBe(1)
    expect(r[0]!.tied).toBe(true)
    expect(r[1]!.tied).toBe(true)
    expect(r[2]!.rank).toBe(3) // not 2 — two players occupy 1st
    expect(r[2]!.tied).toBe(false)
  })

  it('keeps negative scores below zero and sorts them correctly', () => {
    const r = rankScores([e(1, -3), e(2, 0), e(3, -1)])
    expect(r.map((x) => x.score)).toEqual([0, -1, -3])
  })

  it('does not mutate its input', () => {
    const input = [e(1, 1), e(2, 2)]
    const copy = JSON.parse(JSON.stringify(input))
    rankScores(input)
    expect(input).toEqual(copy)
  })

  it('handles an empty board', () => {
    expect(rankScores([])).toEqual([])
  })
})

describe('formatScore', () => {
  it('signs a positive score and never a zero', () => {
    expect(formatScore(3)).toBe('+3')
    expect(formatScore(0)).toBe('0')
    expect(formatScore(-2)).toBe('-2')
  })
})

describe('formatClock', () => {
  it('formats mm:ss and floors', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(9.9)).toBe('0:09')
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(240)).toBe('4:00')
  })

  it('clamps a negative clock to zero rather than showing -0:01', () => {
    expect(formatClock(-5)).toBe('0:00')
  })
})

describe('phaseBanner', () => {
  it('is silent during play and speaks otherwise', () => {
    expect(phaseBanner('playing', 10)).toBeNull()
    expect(phaseBanner('warmup', 7)).toContain('Warmup')
    expect(phaseBanner('ended', 20)).toContain('Round over')
    expect(phaseBanner('lobby', 0)).toContain('Waiting')
  })
})
