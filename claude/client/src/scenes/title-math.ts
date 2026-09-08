/**
 * The guard that stops the title screen's background taking the menu with it
 * (`docs/74-amendments-v6.md` §E9).
 *
 * Phaser-free, so it is testable (§A8) — and it is the piece worth testing,
 * because the defect §E9 exists for was never about what the background drew.
 * `TitleScene` tore its world down and rebuilt it from inside `update()`, and a
 * throw there removed the DOM *and* stopped Phaser's frame loop, so the Start
 * button died with the picture. The picture is decoration; the button is the
 * screen's only job.
 *
 * The rule this encodes: **anything decorative runs inside a guard that catches,
 * says so once, and then stops running.** Not "logs and carries on", which would
 * report per frame at 60 Hz, and not "logs and rethrows", which is the failure
 * mode being fixed.
 */

/** A one-shot latch around something decorative. */
export interface Guard {
  /** Whether the guarded body is still being run. False after its first throw. */
  live: boolean
  /**
   * How many times the body threw.
   *
   * Never exceeds 1, because the guard stops running the body. It is a count
   * rather than a bool so a test can distinguish "reported once" from "reported
   * once per frame", which is the difference §E9 cares about.
   */
  failures: number
  /** The message from the first throw, kept for the debug handle. */
  reason: string | null
}

export function newGuard(): Guard {
  return { live: true, failures: 0, reason: null }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Run `body` unless this guard has already failed. A throw disables the guard,
 * is reported **once**, and does not propagate.
 *
 * The non-propagation is the load-bearing half: this is called from `update()`,
 * and an exception escaping Phaser's frame callback is what stopped the loop.
 */
export function runGuarded(g: Guard, body: () => void, report: (msg: string) => void): void {
  if (!g.live) return
  try {
    body()
  } catch (err) {
    g.live = false
    g.failures += 1
    g.reason = describe(err)
    report(g.reason)
  }
}

/**
 * The same latch for a one-shot `await`.
 *
 * Asset loading is awaited in `create()`, and a rejection there used to mean the
 * scene never reached the line that builds the UI. Separate from `runGuarded`
 * rather than folded into it because a sync `update()` path must not be made to
 * return a promise.
 */
export async function runGuardedAsync(
  g: Guard,
  body: () => Promise<void>,
  report: (msg: string) => void,
): Promise<void> {
  if (!g.live) return
  try {
    await body()
  } catch (err) {
    g.live = false
    g.failures += 1
    g.reason = describe(err)
    report(g.reason)
  }
}
