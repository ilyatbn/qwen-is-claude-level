/**
 * T23.27 (`docs/78` §A1): whom a spectator watches.
 *
 * Pure, so the rules have a test without a socket: **Tab / Shift+Tab** step through the living players (id order,
 * wrapping); the first living player is watched until one is chosen; **the watched player is kept through death and
 * respawn** — only Tab changes whom you watch; one who leaves (absent from the snapshot) is replaced at once.
 *
 * Owner, 2026-10-02: "the view changes every second to a different bot. it wasn't like this before." It moved on one
 * second after every death of the watched bot (T23.27's rule), and once the bots fought all the time that was most of
 * the time. Retired.
 */

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
  /** One snapshot's players at `nowMs`: keep the watched one, or move on (the rules in the header). */
  update(players: readonly WatchCandidate[], nowMs: number): number | null {
    void nowMs
    const w = this.watching === null ? undefined : players.find((p) => p.id === this.watching)
    if (!w) this.watching = stepWatch(players, null, 1)
    return this.watching
  }

  /** Tab (1) / Shift+Tab (−1). */
  step(players: readonly WatchCandidate[], dir: 1 | -1): number | null {
    this.watching = stepWatch(players, this.watching, dir)
    return this.watching
  }

  reset(): void {
    this.watching = null
  }
}

/** T23.27: the scoreboard's key in spectate (held), since Tab steps the camera there. Phaser's key name. */
export const SPECTATE_SCORES_KEY = 'S'
