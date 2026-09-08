/**
 * The jetpack fuel readout — the pure half (§A8: no Phaser, no DOM here).
 *
 * `docs/72-amendments-v4.md` §C26. The reported symptom was "the jetpack refills
 * weirdly", which is an observation rather than a diagnosis, so the curve was
 * measured before anything was changed: burn to empty, then sample fuel every
 * tick for twelve seconds.
 *
 * ```
 * burn      5.0 -> 0.0 in exactly 300 ticks = 5.0000 s   (JETPACK_DRAIN 1.0/s)
 * refill    first rise at tick 31 = 0.5167 s             (JETPACK_REFILL_DELAY 0.5 s)
 *           slope 0.5000 /s                              (JETPACK_REFILL 0.5/s)
 *           full at tick 630 = 10.5000 s = 0.5 + 10.0
 * grounded  identical to airborne — no landing gate
 * ```
 *
 * The simulation **agrees with the constants**. What is weird is the shape, not
 * the code: recovery runs at half the drain rate, so a one-second burn costs two
 * seconds, and the first half-second of that is a flat line while the delay
 * elapses. A bar cannot show the difference between "waiting" and "climbing
 * slowly"; a number can. So this is the fix, and the feel is a tuning question
 * about those three constants rather than a bug.
 */

/**
 * Fuel to one decimal.
 *
 * One decimal is the whole point (§C26: "so the refill curve is legible").
 * Whole seconds would show `0` for the first two ticks of a refill and then
 * jump, which looks exactly like the stall the readout exists to explain.
 *
 * Clamped at both ends: the wire carries fuel as a byte, and a dequantised 255
 * can land a hair over `JETPACK_MAX_FUEL`.
 */
export function fuelText(fuel: number, maxFuel: number): string {
  const clamped = Math.min(Math.max(Number.isFinite(fuel) ? fuel : 0, 0), maxFuel)
  return clamped.toFixed(1)
}

/**
 * Is the tank refilling, draining, or waiting out `JETPACK_REFILL_DELAY`?
 *
 * Derived from two samples rather than tracked as a fourth flag (CLAUDE.md:
 * "derive, do not add a fourth flag" — three flags can disagree). The dead band
 * is one tick of the *slower* of the two rates, so a stationary reading is not
 * reported as motion by float noise.
 */
export function fuelTrend(
  previous: number,
  current: number,
  refillPerSecond: number,
  simDt: number,
): 'draining' | 'refilling' | 'held' {
  const band = refillPerSecond * simDt * 0.5
  if (current > previous + band) return 'refilling'
  if (current < previous - band) return 'draining'
  return 'held'
}
