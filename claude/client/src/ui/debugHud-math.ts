/**
 * T8.03 — the arithmetic behind the F3 HUD (§A8 — no Phaser in this file).
 *
 * §A8 requires the testable half of a client module to live outside the Phaser
 * file, so the task's single `debugHud.ts` is split. The part worth testing is
 * the rates: "corrections per second" is the number that tells you whether
 * prediction is healthy, and a rate computed wrong is worse than no rate.
 *
 * Rates are measured over a **short trailing window**, not over the session, for
 * the same reason the server's tick ring is 1024 samples: a percentile or a rate
 * that averages the whole session lets a healthy first minute hide a bad one,
 * which is the opposite of what "why does it feel bad *right now*" needs.
 */

/** Default window for every rate on the HUD. */
export const RATE_WINDOW_MS = 3000

/**
 * Counts events per second over a trailing window.
 *
 * Stores timestamps rather than a decayed average so the answer is exact and a
 * burst is visible as a burst — an EWMA smears a 200 ms stall into a gentle dip.
 */
export class RateMeter {
  private stamps: number[] = []

  constructor(private readonly windowMs: number = RATE_WINDOW_MS) {}

  mark(nowMs: number, count = 1): void {
    for (let i = 0; i < count; i++) this.stamps.push(nowMs)
    this.trim(nowMs)
  }

  /** Events per second over the window. Zero before any event. */
  perSecond(nowMs: number): number {
    this.trim(nowMs)
    if (this.stamps.length === 0) return 0
    // Divide by the *window*, not by the observed span: dividing by the span
    // reports a single event as an infinite rate.
    return (this.stamps.length / this.windowMs) * 1000
  }

  get count(): number {
    return this.stamps.length
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - this.windowMs
    while (this.stamps.length > 0 && (this.stamps[0] as number) < cutoff) this.stamps.shift()
  }
}

/**
 * Running mean and max of correction distances, over the same trailing window.
 *
 * `docs/42` §2: corrections above the epsilon happening *constantly* means
 * something is genuinely wrong, so the rate and the magnitude have to be read
 * together — a high rate of 2 px corrections is float noise, while one 300 px
 * correction is a real desync.
 */
export class CorrectionStats {
  private samples: Array<{ t: number; px: number }> = []

  constructor(private readonly windowMs: number = RATE_WINDOW_MS) {}

  add(nowMs: number, px: number): void {
    this.samples.push({ t: nowMs, px })
    this.trim(nowMs)
  }

  summary(nowMs: number): { count: number; mean: number; max: number } {
    this.trim(nowMs)
    if (this.samples.length === 0) return { count: 0, mean: 0, max: 0 }
    let sum = 0
    let max = 0
    for (const s of this.samples) {
      sum += s.px
      if (s.px > max) max = s.px
    }
    return { count: this.samples.length, mean: sum / this.samples.length, max }
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - this.windowMs
    while (this.samples.length > 0 && (this.samples[0] as { t: number }).t < cutoff) {
      this.samples.shift()
    }
  }
}

/**
 * Packet loss, estimated from gaps in the snapshot tick sequence.
 *
 * Snapshots go out every 3rd tick (`SNAPSHOT_HZ` 20 against `SIM_HZ` 60), so a
 * gap larger than one interval means snapshots went missing. This is an estimate
 * and is labelled as one on the HUD: a server that skipped a snapshot because it
 * was overloaded looks identical from here to one whose packet was dropped.
 */
export function estimateLoss(ticks: readonly number[], ticksPerSnapshot = 3): number {
  if (ticks.length < 2) return 0
  const first = ticks[0] as number
  const last = ticks[ticks.length - 1] as number
  const span = last - first
  if (span <= 0) return 0
  const expected = Math.round(span / ticksPerSnapshot) + 1
  if (expected <= 0) return 0
  const missing = Math.max(0, expected - ticks.length)
  return (missing / expected) * 100
}

/** Jitter: mean absolute deviation of snapshot inter-arrival times, in ms. */
export function jitterMs(arrivals: readonly number[]): number {
  if (arrivals.length < 3) return 0
  const gaps: number[] = []
  for (let i = 1; i < arrivals.length; i++) {
    gaps.push((arrivals[i] as number) - (arrivals[i - 1] as number))
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  return gaps.reduce((a, g) => a + Math.abs(g - mean), 0) / gaps.length
}
