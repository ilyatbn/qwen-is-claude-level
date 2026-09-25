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
 * for a body box `w × h` and a figure rotated by `theta`.
 *
 * **T22.19B F3 (ruling): the pivot is where the box meets the rock** — the point where
 * the figure's down `(−sin θ, cos θ)`, cast from the box centre, leaves the box. At
 * T22.19 it was the centre (the feet always half a *height* away), so at a quarter turn
 * the feet sat `h/2` beside a box only `w/2` wide — sunk `(h − w)/2` into the rock's
 * flank. Here the feet stand on the box's own edge on every bearing: upright `(0, h/2)`
 * (the old `(x, y + PLAYER_H/2)` exactly), feet-up `(0, −h/2)` (the figure covers the box
 * as before), a quarter turn `(∓w/2, 0)`. Continuous in θ (the box outline is).
 * **Accepted cost of "visual only":** turned sideways, the drawn figure is `h` long
 * across a box `w` wide, so it overhangs the axis-aligned hitbox by `h − w` on the side
 * away from the rock — the box, which is what collides and is shot at, does not turn.
 */
export function feetOffset(theta: number, w: number, h: number): { x: number; y: number } {
  const dx = -Math.sin(theta)
  const dy = Math.cos(theta)
  const tx = Math.abs(dx) > 1e-9 ? w / 2 / Math.abs(dx) : Infinity
  const ty = Math.abs(dy) > 1e-9 ? h / 2 / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty)
  return { x: dx * t, y: dy * t }
}

/**
 * A point given in **screen** offsets `(sx, sy)` from the body's centre, in the
 * container's rotated frame whose origin is the feet at `feet` (`feetOffset`) from that
 * centre: what keeps the name tag upright and above the body whatever way the figure
 * faces. `rot(−θ) · ((sx, sy) − feet)`.
 */
export function uprightLocal(
  theta: number,
  feet: { x: number; y: number },
  sx: number,
  sy: number,
): { x: number; y: number } {
  return toLocal(theta, sx - feet.x, sy - feet.y)
}

/**
 * **T22.19B F5: how far a body must move in one frame, beyond what its velocity carried
 * it, to count as moved rather than travelled** — a pad, a vortex trip, a respawn or a
 * dev placement. Then the tilt snaps to the new spot's target instead of turning for a
 * quarter second from wherever it stood before. `net/prediction.ts`'s `SNAP_PX` basis
 * (64 px, "above this the render teleports as well as the simulation"), so the figure
 * snaps exactly when the body it is drawn on does. Drawing only.
 */
export const STAND_SNAP_PX = 64

/** One body's tilt and where it was drawn last frame (`trackTilt`'s state). */
export interface TiltTrack {
  theta: number
  x: number
  y: number
}

/**
 * **One frame of one body's tilt** (T22.19B F5): `stepTilt` toward `target`, except that
 * a body seen for the first time (`prev` null — a new remote, a remote back in the
 * sampled set, a new round) or one that jumped (`STAND_SNAP_PX` past what `(vx, vy)`
 * carried it in `dt`) **snaps** to the target: its figure was never drawn turning there.
 * The scene calls it every frame for every body it holds, visible or not, so a remote
 * culled by the dark keeps its angle current and reappears already standing.
 */
export function trackTilt(
  prev: TiltTrack | null,
  x: number,
  y: number,
  vx: number,
  vy: number,
  target: number | null,
  dt: number,
): TiltTrack {
  const jumped =
    prev !== null && Math.hypot(x - prev.x - vx * Math.max(dt, 0), y - prev.y - vy * Math.max(dt, 0)) > STAND_SNAP_PX
  const theta = prev === null || jumped ? wrapAngle(target ?? 0) : stepTilt(prev.theta, target, dt)
  return { theta, x, y }
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
