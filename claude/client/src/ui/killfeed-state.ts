/**
 * The kill feed's bookkeeping (§A8 — no Phaser in this file).
 *
 * `docs/21` §6 defines what a death is worth; this only decides what is on
 * screen and for how long.
 */

export const KILLFEED_MAX = 5
export const KILLFEED_LIFETIME = 6

export type DeathCause = 'player' | 'self' | 'weather' | 'void'

export interface KillEntry {
  /**
   * Absent for an environmental death — nobody gets credit (`docs/21` §4).
   *
   * `| undefined` explicitly, because `exactOptionalPropertyTypes` is on: an
   * optional property and a property that may hold `undefined` are different
   * types here, and the caller genuinely passes `undefined`.
   */
  killer?: string | undefined
  victim: string
  cause: DeathCause
  /** What did it: a weapon key, or an effect kind. */
  by: string
  /** True when the local player is either party — those are drawn highlighted. */
  involvesYou: boolean
  age: number
}

export class KillFeed {
  private entries: KillEntry[] = []

  add(e: Omit<KillEntry, 'age'>): void {
    this.entries.push({ ...e, age: 0 })
    // Newest at the end; evict from the front so the oldest goes first.
    while (this.entries.length > KILLFEED_MAX) this.entries.shift()
  }

  update(dt: number): void {
    for (const e of this.entries) e.age += dt
    this.entries = this.entries.filter((e) => e.age < KILLFEED_LIFETIME)
  }

  /** Oldest first, which is the order they are drawn top to bottom. */
  live(): Array<KillEntry & { alpha: number }> {
    return this.entries.map((e) => {
      const t = e.age / KILLFEED_LIFETIME
      // Only the last fifth fades: an entry that dims from the moment it appears
      // is unreadable exactly when you want to read it.
      return { ...e, alpha: t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1 }
    })
  }

  get count(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries = []
  }
}

/**
 * The one line of text a feed entry becomes.
 *
 * Self-kills and weather deaths read differently on purpose: "ana blew herself
 * up" is information, "ana killed ana" is a bug report.
 */
export function killLine(e: KillEntry): string {
  if (e.cause === 'self') return `${e.victim} blew themselves up (${e.by})`
  // §C15. Its own line, not folded into `weather`: nobody is "killed by the
  // void", they fall into it, and without this case a solo fall reached the
  // last line with no killer and read `? → ana` — an unknown murderer for
  // something the player did to themselves.
  if (e.cause === 'void') return `${e.victim} fell out of the world`
  if (e.cause === 'weather') return `${e.victim} was killed by ${e.by}`
  return `${e.killer ?? '?'} → ${e.victim} (${e.by})`
}
