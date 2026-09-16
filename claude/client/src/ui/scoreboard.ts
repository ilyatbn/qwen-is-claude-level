/**
 * Scoreboard ordering and formatting. **No Phaser** — see
 * `docs/70-amendments-v2.md` §A8; the scene draws what this returns.
 */

export interface ScoreEntry {
  id: number
  name: string
  /** Signed, and it may be negative. */
  score: number
  deaths: number
  /** Ascending, in the order players joined. */
  joinOrder: number
  isLocal?: boolean
}

export interface ScoreRow extends ScoreEntry {
  /** 1-based, and **shared by ties** — two players on 5 points are both 1st. */
  rank: number
  /** True when at least one other row shares this rank. */
  tied: boolean
}

/**
 * Sort: score descending, then fewest deaths, then join order
 * (`docs/21-player-stats.md` §6).
 *
 * Ties at the top are shown as ties; there is no tiebreaker round. So rank is
 * assigned by *value*, not by array position — otherwise two players on equal
 * score and equal deaths would be displayed as 1st and 2nd, which is a different
 * claim than the game makes.
 */
export function rankScores(entries: readonly ScoreEntry[]): ScoreRow[] {
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || a.deaths - b.deaths || a.joinOrder - b.joinOrder,
  )

  const rows: ScoreRow[] = []
  let rank = 0
  let lastKey: string | null = null
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!
    // Join order deliberately excluded from the tie key: it is a display
    // tiebreak, not a claim that one player did better.
    const key = `${e.score}/${e.deaths}`
    if (key !== lastKey) {
      rank = i + 1
      lastKey = key
    }
    rows.push({ ...e, rank, tied: false })
  }
  const counts = new Map<number, number>()
  for (const r of rows) counts.set(r.rank, (counts.get(r.rank) ?? 0) + 1)
  for (const r of rows) r.tied = (counts.get(r.rank) ?? 0) > 1

  return rows
}

/** `+3`, `0`, `-2` — the sign is the point, so a negative score reads as one. */
export function formatScore(score: number): string {
  return score > 0 ? `+${score}` : String(score)
}

/** `mm:ss`, floored, never negative. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export type Phase = 'lobby' | 'warmup' | 'playing' | 'ended'

/** The banner text for a phase, or null when there is nothing to say. */
export function phaseBanner(phase: Phase, timeLeft: number): string | null {
  switch (phase) {
    case 'lobby':
      return 'Waiting for players'
    case 'warmup':
      return `Warmup — ${formatClock(timeLeft)}`
    case 'ended':
      return `Round over — ${formatClock(timeLeft)}`
    case 'playing':
      return null
  }
}
