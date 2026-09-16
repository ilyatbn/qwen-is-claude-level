/**
 * The pure half of local input (§A8): key state → button bits, and mouse → aim.
 *
 * Kept free of Phaser so the aim rules — the deadzone, and the world-vs-screen
 * coordinate trap — are actually testable. Both are the kind of bug that works
 * perfectly at the map origin and is wrong everywhere else.
 */

import { C } from '../core'

export interface KeyState {
  left: boolean
  right: boolean
  up: boolean
  down: boolean
  jump: boolean
  fire: boolean
  flashlight: boolean
}

export interface Vec {
  x: number
  y: number
}

/**
 * Pack held state into the wire byte. Bit values come from `game-core`, never from
 * a TypeScript copy — see `constants_json` in `crates/game-wasm/src/lib.rs`.
 *
 * Holding both left and right sets **both** bits. Cancelling them is `move_dir`'s
 * job in `game-core`; doing it here too would mean two places to change.
 */
export function packButtons(k: KeyState): number {
  const c = C()
  let b = 0
  if (k.left) b |= c.BTN_LEFT
  if (k.right) b |= c.BTN_RIGHT
  if (k.up) b |= c.BTN_UP
  if (k.down) b |= c.BTN_DOWN
  if (k.jump) b |= c.BTN_JUMP
  if (k.fire) b |= c.BTN_FIRE
  if (k.flashlight) b |= c.BTN_FLASHLIGHT
  return b
}

/**
 * Aim angle from a **world-space** pointer position.
 *
 * `previous` is returned unchanged inside `AIM_DEADZONE`. Without that the
 * crosshair spins wildly every time the cursor crosses the player's body, which
 * happens constantly (`docs/22-aiming-crosshair.md` §1).
 */
export function aimAngle(playerCentre: Vec, pointerWorld: Vec, previous: number): number {
  const dx = pointerWorld.x - playerCentre.x
  const dy = pointerWorld.y - playerCentre.y
  const c = C()
  if (dx * dx + dy * dy < c.AIM_DEADZONE * c.AIM_DEADZONE) return previous
  return Math.atan2(dy, dx)
}

/** Where the crosshair sits: on a ring of `AIM_RADIUS`, never at the cursor. */
export function crosshairPos(playerCentre: Vec, aim: number): Vec {
  const r = C().AIM_RADIUS
  return { x: playerCentre.x + Math.cos(aim) * r, y: playerCentre.y + Math.sin(aim) * r }
}
