/**
 * Bird drawing maths (§C16), with no Phaser in it.
 *
 * The wing phase and the colour choice are the two things worth pinning, and
 * both are pure functions of time and kind — so they can be asserted under node
 * rather than by staring at a frame.
 */
import { C } from '../core'

/** `kind` as it arrives on the wire. */
export const BIRD_NORMAL = 0
export const BIRD_METAL = 1

/**
 * Wing position, -1 (down) to 1 (up).
 *
 * A sine of wall-clock time, not of the bird's position: two birds at the same
 * x should not flap in lockstep, so the phase is offset by id.
 */
export function wingPhase(nowMs: number, id: number, flapsPerSecond = 3.2): number {
  const t = nowMs / 1000
  return Math.sin((t * flapsPerSecond + id * 0.37) * Math.PI * 2)
}

/**
 * Body colour per kind.
 *
 * Metal is a cold grey against the normal bird's dark brown, and the two are far
 * enough apart in luminance to tell apart against both a day and a night sky —
 * §C16 asks for "visually distinct" and the reward depends on it.
 */
export function bodyColor(kind: number): number {
  return kind === BIRD_METAL ? 0xb8c4d0 : 0x3a2c22
}

/** Metal birds are drawn slightly larger, which reads as heavier. */
export function bodyScale(kind: number): number {
  return kind === BIRD_METAL ? 1.15 : 1.0
}

/**
 * The drawn size of a bird, from the hit box the server uses.
 *
 * Read from the shared constants rather than carried here, so a sprite that no
 * longer matches what a bullet hits is a failing test and not a mystery.
 */
export function bodySize(kind: number): { w: number; h: number } {
  const c = C()
  const s = bodyScale(kind)
  return { w: c.BIRD_W * s, h: c.BIRD_H * s }
}
