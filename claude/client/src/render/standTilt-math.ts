/**
 * T22.19 (`M22-OWNER-ROUND-2` R107) — **standing on asteroids**, as pure numbers.
 * `playerView.ts` draws what these decide; nothing here knows Phaser.
 *
 * The owner: *"rotate the character to the center of gravity when being pulled towards
 * it so they apear to be standing even if they are on the bottom. when not pulled by
 * gravity they go back to being vertical."*
 *
 * **Visual only.** The body, its box, the controls and the aim are untouched (R107:
 * controls stay screen-relative). The pull is **asked of Rust** — `Core.standPullAt`,
 * the same `attractors::env_at` the prediction steps with — never summed here.
 *
 * The angle is the figure's rotation: 0 upright (feet down, +y), π feet up. A pull
 * `(fx, fy)` puts the feet along it: rotating the figure's down `(0, 1)` by θ gives
 * `(−sin θ, cos θ)`, so θ = `atan2(−fx, fy)`.
 */

/**
 * How fast the figure turns to face a pull, 1/s — an exponential approach, so about
 * 95 % of the way in `3 / STAND_TURN_RATE` s (a quarter second). Quick enough that a
 * body landing on a rock's underside is standing by the time it settles; smoothed so a
 * body crossing from one rock's band to another's does not snap. Drawing only.
 */
export const STAND_TURN_RATE = 12

/**
 * How fast it eases back to upright once nothing pulls, 1/s — slower than the turn
 * (≈ 95 % in 0.6 s): a hop off the rock leaves the band within a few frames, and a
 * figure that flipped upright the instant it left would spin twice per hop. Drawing only.
 */
export const STAND_UPRIGHT_RATE = 5

/** Wrap an angle into (−π, π]. */
export function wrapAngle(a: number): number {
  const t = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI))
  return t <= -Math.PI ? t + 2 * Math.PI : t
}

/**
 * The rotation that puts the feet along the pull `(fx, fy)`, or `null` where nothing
 * pulls (exactly zero — R101's field is a step, so open space is exactly `[0, 0]`).
 */
export function standTarget(fx: number, fy: number): number | null {
  if (fx === 0 && fy === 0) return null
  return Math.atan2(-fx, fy)
}

/**
 * One frame of the smoothing: from `theta` toward `target` (upright when `null`) the
 * short way round, at `STAND_TURN_RATE` or `STAND_UPRIGHT_RATE`. Returns the new angle,
 * wrapped. `dt` in seconds; a non-positive `dt` changes nothing.
 */
export function stepTilt(theta: number, target: number | null, dt: number): number {
  if (!(dt > 0)) return wrapAngle(theta)
  const goal = target ?? 0
  const rate = target === null ? STAND_UPRIGHT_RATE : STAND_TURN_RATE
  const k = 1 - Math.exp(-rate * dt)
  return wrapAngle(theta + wrapAngle(goal - theta) * k)
}

/**
 * Where the container's origin (the figure's feet) goes, relative to the body's centre,
 * for a figure of height `h` rotated by `theta` — the pivot is the body's centre, so a
 * figure turned feet-up under a rock still covers the body's box.
 */
export function feetOffset(theta: number, h: number): { x: number; y: number } {
  return { x: -Math.sin(theta) * (h / 2), y: Math.cos(theta) * (h / 2) }
}

/**
 * A point given in **screen** offsets from the body's centre, in the container's
 * rotated frame (whose origin is the feet): what keeps the name tag upright and above
 * the body whatever way the figure faces. `rot(−θ) · (screen) − (0, h/2)`.
 */
export function uprightLocal(theta: number, h: number, sx: number, sy: number): { x: number; y: number } {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return { x: c * sx + s * sy, y: -s * sx + c * sy - h / 2 }
}

/**
 * A screen-space direction `(x, y)` in the rotated frame — the thrust and the velocity
 * the plume is drawn against, which are the controls' directions and stay the screen's.
 */
export function toLocal(theta: number, x: number, y: number): { x: number; y: number } {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return { x: c * x + s * y, y: -s * x + c * y }
}
