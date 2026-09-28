/**
 * T23.14F F2: **your own swing, reconciled with the server.**
 *
 * Your figure swings (or throws) the frame you use a weapon, on the predicted sim's word (`Core.predictUse`,
 * T23.14E). The mirror can be wrong both ways — its cooldown runs on this page's clock, not the server's; a stale
 * `inventory` event can give back a grenade it threw; a pickup can fill the selected slot before the event saying
 * so; an in-flight `inventory` can overwrite a selection — so each predicted swing waits here for the server's echo
 * of it (your own `melee`, `projectile_spawn` of a thrown weapon, or `mine_placed`), matched by the item's key:
 * - an echo with a matching prediction is the prediction confirmed: nothing more to play;
 * - an echo with **none** is a use the mirror refused and the server took: the swing plays now, late;
 * - a prediction with no echo within the bound is dropped — it swung once and never swings again.
 *
 * A false positive (the mirror took a use the server refused) has already swung and cannot be taken back; the list
 * only keeps it from swallowing a later echo for longer than the bound.
 */
import { WEAPONS } from './weapons'

/**
 * How long a prediction waits for its echo, before the measured round trip is added (ms). Basis: the slowest echo
 * the suite has recorded is 392 ms after the use (`melee-swing` in a 4-wide batch, `gate-t2318-B1.txt`), with
 * the round trip then ~ a frame; ×2.5 for a loaded box. Too short and a real prediction's late echo swings a
 * second time; too long and a stale false positive swallows a later false negative's echo — the rarer of the two.
 */
export const PENDING_USE_BASE_MS = 1000
/** The measured round trip counts this many times over (there, and the echo back behind a frame). */
export const PENDING_USE_RTT_FACTOR = 2

/** Does using `key` move the figure (a melee swing, a throw)? A gun does not (`PlayerView.firedWith`). */
export function swings(key: string | null | undefined): boolean {
  const W = key ? WEAPONS[key] : undefined
  return !!(W?.melee || W?.thrown)
}

export interface PendingStats {
  predicted: number
  /** Echoes a prediction matched: no second swing. */
  confirmed: number
  /** Echoes no prediction matched: the swing played late. */
  late: number
  /** Predictions no echo matched within the bound: dropped, never re-swung. */
  dropped: number
}

export class PendingUses {
  private readonly list: { key: string; at: number }[] = []
  readonly stats: PendingStats = { predicted: 0, confirmed: 0, late: 0, dropped: 0 }

  /** `rttMs`: the connection's measured round trip, read when the bound is. */
  constructor(private readonly rttMs: () => number) {}

  /** How long a prediction waits for its echo, ms. */
  bound(): number {
    return PENDING_USE_BASE_MS + PENDING_USE_RTT_FACTOR * Math.max(0, this.rttMs())
  }

  /** The figure swung for a predicted use of `key` at `now` (ms). A key that moves no figure is not kept. */
  predicted(key: string, now: number): void {
    this.expire(now)
    if (!swings(key)) return
    this.list.push({ key, at: now })
    this.stats.predicted += 1
  }

  /**
   * The server's echo of your own use of `key` at `now` (ms). **True: play the swing now** — no prediction was
   * waiting for it. False: a prediction was (it is confirmed and removed), or `key` moves no figure.
   */
  echo(key: string, now: number): boolean {
    if (!swings(key)) return false
    this.expire(now)
    const i = this.list.findIndex((p) => p.key === key)
    if (i >= 0) {
      this.list.splice(i, 1)
      this.stats.confirmed += 1
      return false
    }
    this.stats.late += 1
    return true
  }

  /** Drop what has waited past the bound. */
  expire(now: number): void {
    const limit = now - this.bound()
    while (this.list.length > 0 && this.list[0]!.at < limit) {
      this.list.shift()
      this.stats.dropped += 1
    }
  }

  /** Predictions still waiting. */
  get waiting(): number {
    return this.list.length
  }

  /** A new round or body: nothing is waiting. */
  clear(): void {
    this.list.length = 0
  }
}
