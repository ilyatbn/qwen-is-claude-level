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
  /**
   * 1.0 clear .. FOV_FOG_MULT at full fog.
   *
   * A multiplier rather than a boolean: fog ramps in and out over FOG_RAMP
   * (T5.05), and a boolean would snap the player's whole field of view between
   * two values at the ramp's edges.
   */
  fogMult: number
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
    o.fogMult *
    lerp(c.FOV_HEALTH_MIN_MULT, 1, clamp01(o.health / c.BASE_HEALTH)) *
    (o.flashlightOn ? c.FLASHLIGHT_AMBIENT_MULT : 1)
  )
}

/** Whether the lightmap has anything to do at all this frame. */
export function lightmapNeeded(darkness: number, fogActive: boolean): boolean {
  return darkness > 0.001 || fogActive
}

// ---------------------------------------------------------------------------
// Light sources (T5.07)
// ---------------------------------------------------------------------------

export interface LightSourceSpec {
  x: number
  y: number
  radius: number
  kind: 'radial' | 'cone'
  angle?: number
  coneDeg?: number
  intensity: number
}

export interface PlayerLight {
  x: number
  y: number
  health: number
  flashlightOn: boolean
  /** Radians. */
  aim: number
}

export interface WorldLights {
  localPlayer: PlayerLight
  remotePlayers: readonly Omit<PlayerLight, 'health'>[]
  /** `age` in seconds since the blast. */
  explosions: readonly { x: number; y: number; age: number }[]
  hazards: readonly { x: number; y: number; kind: 'lava' | 'burn' | 'meteor' }[]
  darkness: number
  fogMult: number
}

/** Explosion flash decay, seconds. */
export const FLASH_DECAY = 0.2

/**
 * How far each hazard lights the ground at night.
 *
 * **No `flame` entry, deliberately, and the reason is worth reading once.**
 * §F10.3 says a flame "lights the world through the existing lightmap hazard
 * path". That path is `collectLightSources`, below — and **it has no production
 * caller.** Grepped: the only callers in the tree are its own unit tests.
 * `GameScene` builds its light list from `OrdnanceState.lights()` and
 * `OrdnanceFxState.lights()` directly (`GameScene.ts:1498`), and the sandbox
 * does not light at all. A `flame` row here would have lit nothing.
 *
 * So a flame lights the world the way every other projectile does, through
 * `GLOW` in `ordnance-state.ts` and `OrdnanceState.lights()` — the path that is
 * actually wired to the lightmap. The hazards this table is for are the
 * server-announced zones, and §F10.2 stopped a flame being one of them.
 */
const HAZARD_RADIUS: Record<string, number> = { lava: 150, burn: 90, meteor: 120 }

/**
 * Every light that should erase darkness this frame.
 *
 * The one that is easy to omit and matters most is **remote players' flashlight
 * cones**. Leaving them out silently removes the entire trade the item exists
 * for: a flashlight at night is meant to be a beacon, buying long sightlines at
 * the cost of being seen first (`docs/14-daynight-visibility.md` §4).
 */
export function collectLightSources(w: WorldLights): LightSourceSpec[] {
  const c = C()
  // Daylight with no fog: the lightmap is skipped entirely, so there is nothing
  // to erase into.
  if (!lightmapNeeded(w.darkness, w.fogMult < 1)) return []

  const out: LightSourceSpec[] = []

  out.push({
    x: w.localPlayer.x,
    y: w.localPlayer.y,
    radius: fovRadius({
      darkness: w.darkness,
      fogMult: w.fogMult,
      health: w.localPlayer.health,
      flashlightOn: w.localPlayer.flashlightOn,
    }),
    kind: 'radial',
    intensity: 1,
  })

  if (w.localPlayer.flashlightOn) {
    out.push({
      x: w.localPlayer.x,
      y: w.localPlayer.y,
      radius: c.FLASHLIGHT_RANGE * w.fogMult,
      kind: 'cone',
      angle: w.localPlayer.aim,
      coneDeg: c.FLASHLIGHT_CONE_DEG,
      intensity: 1,
    })
  }

  for (const r of w.remotePlayers) {
    if (!r.flashlightOn) continue
    out.push({
      x: r.x,
      y: r.y,
      radius: c.FLASHLIGHT_RANGE * w.fogMult,
      kind: 'cone',
      angle: r.aim,
      coneDeg: c.FLASHLIGHT_CONE_DEG,
      intensity: 1,
    })
  }

  for (const e of w.explosions) {
    if (e.age >= FLASH_DECAY) continue
    const t = 1 - e.age / FLASH_DECAY
    out.push({ x: e.x, y: e.y, radius: 220 * t * w.fogMult, kind: 'radial', intensity: t })
  }

  for (const h of w.hazards) {
    out.push({
      x: h.x,
      y: h.y,
      radius: (HAZARD_RADIUS[h.kind] ?? 100) * w.fogMult,
      kind: 'radial',
      intensity: 0.85,
    })
  }

  return out
}
