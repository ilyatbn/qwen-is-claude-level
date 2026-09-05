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
  /**
   * **Carrying one**, not "switched on" (T20.07).
   *
   * `docs/72` §C13 specified a trade — the light shrank ambient sight and bought
   * a cone — and the coordinator reversed it: a flashlight in the bag widens the
   * night radius by `FLASHLIGHT_FOV_MULT` and is not toggled, not the active slot
   * and free of energy. `Player::flashlight_on` is gone from the simulation; this
   * comes from the snapshot's bit 4, which the server derives from the inventory.
   */
  hasFlashlight: boolean
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
 * **This is the live copy.** `game_core::world::cycle::fov_radius` has no
 * production caller — only the wasm bridge, which exists so
 * `lightmap-math.test.ts` can pin the two together. Change one and the other must
 * move, and the wasm must be **rebuilt** before that test means anything: it
 * compares against the built binary, so an unrebuilt artifact makes it fail
 * against code that no longer exists.
 *
 * The flashlight **widens** the night radius (T20.07), reversing §C13's trade on
 * the coordinator's instruction, and does nothing by day — `night` is 0 there, so
 * the base has not moved off `FOV_DAY` and a torch at noon is not a telescope.
 */
export function fovRadius(o: FovOpts): number {
  const c = C()
  const night = clamp01(c.NIGHT_DARKNESS > 0 ? o.darkness / c.NIGHT_DARKNESS : 0)
  return (
    lerp(c.FOV_DAY, c.FOV_NIGHT, night) *
    o.fogMult *
    lerp(c.FOV_HEALTH_MIN_MULT, 1, clamp01(o.health / c.BASE_HEALTH)) *
    (o.hasFlashlight && night > 0 ? c.FLASHLIGHT_FOV_MULT : 1)
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
  /**
   * Carrying one (T20.07), for the reason `FovOpts.hasFlashlight` gives.
   *
   * **The cone below is kept, deliberately.** The brief adds a passive radius and
   * says nothing about removing the cone, and deleting it in passing would be a
   * design change beyond it. The consequence is worth stating: a carried
   * flashlight now emits a cone it cannot be switched off — which is invisible
   * today, because `collectLightSources` still has **no production caller**
   * (`GameScene` builds `lights` by hand). T19.20 owns the wiring; when it lands,
   * confirm that a permanently-on cone is wanted before it reaches a screen.
   */
  hasFlashlight: boolean
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
      hasFlashlight: w.localPlayer.hasFlashlight,
    }),
    kind: 'radial',
    intensity: 1,
  })

  if (w.localPlayer.hasFlashlight) {
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
    if (!r.hasFlashlight) continue
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
