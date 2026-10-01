/**
 * T23.27 (`docs/78` §A1): whom a spectator watches.
 *
 * Pure, so the rules have a test without a socket: **Tab / Shift+Tab** step through the living players (id order,
 * wrapping); the first living player is watched until one is chosen; when the watched one dies the camera **stays on
 * the death for `SPECTATE_DEATH_LINGER_MS`**, then moves to the next living player; one who leaves (absent from the
 * snapshot) is replaced at once.
 */

/**
 * How long the camera stays on a watched player's death before moving on. The task's "~1 s" — a client-only UI pace,
 * not a simulation tunable, so it lives here rather than in `constants.rs` (whose mirror reaches the client through
 * the wasm, outside this task's files). Assumption recorded in T23.27's As-built.
 */
export const SPECTATE_DEATH_LINGER_MS = 1000

export interface WatchCandidate {
  id: number
  alive: boolean
}

/** The next (`dir` 1) or previous (−1) living player after `current`, wrapping; `current` itself if it is the only one. */
export function stepWatch(players: readonly WatchCandidate[], current: number | null, dir: 1 | -1): number | null {
  const living = players.filter((p) => p.alive).map((p) => p.id).sort((a, b) => a - b)
  if (living.length === 0) return current
  if (current === null) return dir === 1 ? living[0]! : living[living.length - 1]!
  if (dir === 1) return living.find((id) => id > current) ?? living[0]!
  return [...living].reverse().find((id) => id < current) ?? living[living.length - 1]!
}

/** Whom to watch, kept across snapshots. */
export class WatchState {
  watching: number | null = null
  /** When the watched player was first seen dead (ms), or `null`. */
  private deadSince: number | null = null

  /** One snapshot's players at `nowMs`: keep the watched one, or move on (the rules in the header). */
  update(players: readonly WatchCandidate[], nowMs: number): number | null {
    const w = this.watching === null ? undefined : players.find((p) => p.id === this.watching)
    if (!w) {
      this.deadSince = null
      this.watching = stepWatch(players, null, 1)
      return this.watching
    }
    if (w.alive) {
      this.deadSince = null
      return this.watching
    }
    this.deadSince ??= nowMs
    if (nowMs - this.deadSince >= SPECTATE_DEATH_LINGER_MS) {
      const next = stepWatch(players, this.watching, 1)
      if (next !== null && next !== this.watching) {
        this.watching = next
        this.deadSince = null
      }
    }
    return this.watching
  }

  /** Tab (1) / Shift+Tab (−1). */
  step(players: readonly WatchCandidate[], dir: 1 | -1): number | null {
    const next = stepWatch(players, this.watching, dir)
    if (next !== this.watching) this.deadSince = null
    this.watching = next
    return this.watching
  }

  reset(): void {
    this.watching = null
    this.deadSince = null
  }
}

/** T23.27: the scoreboard's key in spectate (held), since Tab steps the camera there. Phaser's key name. */
export const SPECTATE_SCORES_KEY = 'S'
