/**
 * Waits paced by the **sandbox's** clock instead of the wall's.
 *
 * ## Why this exists
 *
 * The sandbox scene has no server. Its simulation is stepped once per animation
 * frame by `SandboxScene.update`, with Phaser's frame delta — and Phaser clamps
 * that delta to `fps.min` (5, so 200 ms) and then averages it over the last ten
 * frames. So the sandbox's clock cannot run faster than the wall, and under load
 * it runs a great deal slower.
 *
 * Measured for T21.23 on this box, twenty busy loops against sixteen cores: a
 * `waitForTimeout(1200)` in `m4-checkpoint` advanced the wall **3308 ms** and
 * the sandbox clock **200 ms** — a ratio of **0.06**. Anything the simulation
 * counts — a weapon cooldown, a projectile's flight, a fall, a jetpack's hold
 * delay — is spent in that clock, so a `waitForTimeout` against it is a bet on
 * the box being idle. The bet is lost only when the box is busy, which is to say
 * only in the full gate, which is why this failure gets filed as flakiness.
 * `wasd` was measured failing this way too: "player never landed", after 1500 ms
 * of wall bought a fraction of the fall.
 *
 * This is the sandbox twin of `harness.mjs::serverElapsed`, which does the same
 * job against `serverRoundTime` for the networked checks.
 *
 * ## What it does not cover
 *
 * A wait for a **render**, an animation, a DOM transition or an input round trip
 * is correctly wall-clock — those are the browser's work, not the simulation's.
 * Leave those alone; moving them here is churn.
 */

/**
 * @param {import('playwright-core').Page} page
 */
export function simClock(page) {
  /**
   * The sandbox's clock, in seconds.
   *
   * `debug().roundTime` is the accumulator `SandboxScene.update` adds the frame
   * delta to. The scene's time slider freezes it (`timeScrub`); no caller of
   * this touches the slider, and one that did would see the attempt guard below
   * fire rather than hang.
   */
  const now = async () => {
    const t = await page.evaluate('window.__game.debug().roundTime')
    if (typeof t !== 'number') {
      throw new Error('debug() exposes no roundTime — cannot wait on the sandbox clock')
    }
    return t
  }

  /**
   * Poll `pred` until it returns something truthy, or until `seconds` of
   * **simulated** time have passed. Returns `pred`'s value, or `null` on the
   * budget — so the caller decides what a miss means and can say so in its own
   * words.
   *
   * **A wait that can never be satisfied fails loudly rather than hanging**, and
   * the guard measures the thing that would make it unsatisfiable: a budget
   * denominated in a clock that has *stopped* never expires. So the clock is
   * watched for standing still, not merely for being slow — those are different
   * conditions and only one of them is a bug. A bare attempt count cannot tell
   * them apart, and set tight enough to catch the stall it would fire on a box
   * that was only busy, which is the failure this whole module exists to stop
   * happening. `roundTime` moves every frame, so at Phaser's floor of 5 fps it
   * still moves every 200 ms; not moving across `stallPolls` (~3 s of wall) is a
   * stopped scene and nothing else. `maxPolls` is the backstop under that.
   *
   * (The loop that hung this box for eighteen hours counted its *successes*, so
   * it could never trip its own guard. Both counters here only ever go up on the
   * path that is failing.)
   */
  const until = async (
    pred,
    seconds,
    what,
    { pollMs = 20, stallPolls = 150, maxPolls = 5000 } = {},
  ) => {
    const start = await now()
    let last = start
    let stalled = 0
    for (let i = 0; i < maxPolls; i++) {
      const hit = await pred()
      if (hit) return hit
      const t = await now()
      if (t - start >= seconds) return null
      if (t === last) stalled += 1
      else {
        stalled = 0
        last = t
      }
      if (stalled >= stallPolls) {
        throw new Error(
          `${what}: the sandbox clock has not moved for ${stalled} polls — stuck at ` +
            `${t.toFixed(2)}s, ${(t - start).toFixed(2)}s into a ${seconds}s budget. ` +
            'The scene has stopped stepping.',
        )
      }
      await page.waitForTimeout(pollMs)
    }
    throw new Error(
      `${what}: ${maxPolls} polls and the sandbox clock moved only ` +
        `${(last - start).toFixed(2)}s of ${seconds}s`,
    )
  }

  /** Let `seconds` of **simulated** time pass, whatever the wall says. */
  const elapse = (seconds, what, opts) => until(() => false, seconds, what, opts)

  return { now, until, elapse }
}
