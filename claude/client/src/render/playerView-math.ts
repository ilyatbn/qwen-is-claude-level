/**
 * The pure half of the player view (§A8 — no Phaser here, so it is testable).
 *
 * Animation state is **derived**, never sent over the wire: the snapshot carries
 * flags and velocity, and every client works out the rest identically
 * (`docs/50-sprites-skins.md` §3).
 */

export type AnimState = 'idle' | 'walk' | 'jump' | 'fall' | 'jetpack' | 'hurt' | 'dead'

export interface AnimInputs {
  alive: boolean
  grounded: boolean
  jetpack: boolean
  vx: number
  vy: number
}

/** Below this horizontal speed a grounded player is idle, not walking. */
export const WALK_ANIM_THRESHOLD = 10

/**
 * The doc's table, **in its priority order**. Order is the whole content of this
 * function: a dead player who is also falling has to render as dead, and a
 * jetpacking player is never "jump" even though they are airborne with vy < 0.
 */
export function deriveAnimState(p: AnimInputs): AnimState {
  if (!p.alive) return 'dead'
  if (p.jetpack) return 'jetpack'
  if (!p.grounded) return p.vy < 0 ? 'jump' : 'fall'
  if (Math.abs(p.vx) > WALK_ANIM_THRESHOLD) return 'walk'
  return 'idle'
}

/**
 * Facing comes from **aim**, not velocity (`docs/22-aiming-crosshair.md` §4).
 * Walking right while shooting left has to look right, and it is the case people
 * forget until it is wrong on screen.
 */
export function facingLeft(aim: number): boolean {
  return Math.cos(aim) < 0
}

/**
 * Walk cycle period, so a slowed player visibly trudges instead of moon-walking.
 * Clamped at both ends: without the ceiling, a nearly-stopped player's cycle
 * period goes to infinity and the legs freeze mid-stride.
 */
export function walkFrameMs(vx: number, walkSpeed: number, baseMs = 110): number {
  const speed = Math.max(Math.abs(vx), 1)
  return Math.min(400, Math.max(40, baseMs * (walkSpeed / speed)))
}
