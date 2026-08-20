/**
 * The pure half of the lightmap (§A8): the field-of-view formula.
 *
 * `docs/14-daynight-visibility.md` §3. This is the one genuinely testable piece of
 * the lightmap, and the server needs the identical formula for visibility culling
 * later — so it lives on its own rather than inside a Phaser class.
 */

import { C } from '../core'

export interface FovOpts {
  /** 0 .. NIGHT_DARKNESS */
  darkness: number
  fogActive: boolean
  /** 0 .. HEALTH_CAP */
  health: number
  flashlightOn: boolean
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

/**
 * All four modifiers are multiplicative on one radius, exactly as the doc states.
 *
 * The flashlight *reduces* ambient sight — it is a trade for the cone, not an
 * upgrade.
 */
export function fovRadius(o: FovOpts): number {
  const c = C()
  const night = clamp01(c.NIGHT_DARKNESS > 0 ? o.darkness / c.NIGHT_DARKNESS : 0)
  return (
    lerp(c.FOV_DAY, c.FOV_NIGHT, night) *
    (o.fogActive ? c.FOV_FOG_MULT : 1) *
    lerp(c.FOV_HEALTH_MIN_MULT, 1, clamp01(o.health / c.BASE_HEALTH)) *
    (o.flashlightOn ? c.FLASHLIGHT_AMBIENT_MULT : 1)
  )
}

/** Whether the lightmap has anything to do at all this frame. */
export function lightmapNeeded(darkness: number, fogActive: boolean): boolean {
  return darkness > 0.001 || fogActive
}
