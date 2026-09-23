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
// Deleted: the light-source collector (T19.20)
// ---------------------------------------------------------------------------
//
// `collectLightSources`, `LightSourceSpec`, `PlayerLight`, `WorldLights`,
// `FLASH_DECAY` and `HAZARD_RADIUS` lived here and **had no production caller
// in the entire tree** — only their own nine unit tests, which made a dead path
// read as maintained code. It was the sole producer of `kind: 'cone'`, so
// `lightmap.ts::eraseCone` had no producer either; both are gone.
//
// **Sanctioned by `docs/76` §G2**, which withdraws `docs/14` §4's beacon clause
// — *"Your cone is drawn in everyone's lightmap … Long sightlines at the cost of
// being seen first"* — and its `F`-toggle bullet, the latter stale since T20.07.
// A flashlight is a straight upgrade now: a longer view for whoever finds one,
// with no tell. This is not a builder deleting a specced feature.
//
// §G2 spells out what is left: **a wider view, no cone, no toggle, no tell, no
// fuel cost.** Not even the carrier gets a cone — the only one the client ever
// built was in the function deleted here, so §4's cone was never rendered for
// anybody. `FLASHLIGHT_RANGE` and `FLASHLIGHT_CONE_DEG` are consequently read by
// nothing; §G2 leaves them standing and asks for their retirement to be booked
// rather than folded in here.
//
// T20.07's implementer left a note on `PlayerLight.hasFlashlight` asking that a
// permanently-on cone be confirmed before it reached a screen. It was asked,
// and the answer was no — so the note goes with the code it guarded rather than
// pointing at nothing.
//
// What the nine tests covered, so the loss is named rather than counted: the
// daylight no-op, the local radial, the local cone, the ambient-radius widening,
// a remote player's cone and its no-flashlight control, explosion-flash decay
// over `FLASH_DECAY`, lava/burn/meteor hazard lights, and fog shrinking every
// radius. Only the widening had another home — `fovRadius`, still tested above,
// including against the Rust copy. The rest guarded a path nothing ran.
