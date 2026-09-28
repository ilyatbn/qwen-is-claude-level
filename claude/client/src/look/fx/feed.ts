/**
 * T23.18: how the game's effects reach the world renderer. The ordnance layers (`render/ordnance.ts`,
 * `render/ordnanceFx.ts`) keep the records; each registers itself on its Phaser scene's feed, and the scene's world
 * renderer (`createGameWorld`) builds F's effects from that feed every frame it draws (`gameFrame`) — the records are
 * read where they are kept, not copied into a second list.
 *
 * **Who draws them** is one derived fact, `worldDraws`: the world renderer sets it when it draws this scene's effects
 * (a map with a sky — not space, whose opaque M22 backdrop hides the world canvas until T23.20), and the ordnance
 * layers draw their old flat Phaser picture only while it is false (space; `?world=off`; no WebGL2). One flag, set by
 * the drawer, so the two can never both draw or both not.
 */
import { LOOK, type OrdnanceState } from '../../render/ordnance-state'
import { OrdnanceFxState } from '../../render/ordnanceFx-math'
import type { Light } from '../scene'
import { MUZZLE_LIGHT } from '../effectLights'
import { beamFx, blastFx, bulletFx, cloudFx, coneFx, emberFx, flameFx, mineFx, muzzleFx, rocketFx, smokeLook, swingFx } from './game'
import { clearFrame, type FxFrame } from './kit'
import { weatherFrame, type WeatherSource } from './hazards'

export interface OrdnanceSource {
  readonly state: OrdnanceState
  /** A check's control frame hides the layer (`setVisible`): its effects go with it. */
  readonly visible: boolean
  /** `FLAME_RADIUS`: the circle a flame burns. */
  readonly flameRadius: number
  /** `BULLET_LENGTH`: a round's streak. */
  readonly bulletLength: number
}

export interface ZonesSource {
  readonly state: OrdnanceFxState
  readonly visible: boolean
  /** The local player (a mine's visibility is its distance to them, §B6), the layer's clock (ms), `MINE_ARM_TIME`. */
  readonly eye: { x: number; y: number }
  readonly nowMs: number
  readonly armTime: number
}

export interface FxFeed {
  ordnance: OrdnanceSource | null
  zones: ZonesSource | null
  /** T23.19E: the weather layer's vents, embers and toxic drops (`render/weather.ts`), drawn by `fx/hazards.ts`. */
  weather: WeatherSource | null
  /** The world renderer draws this scene's effects (see the file comment). Written only by `setWorldDraws`. */
  worldDraws: boolean
  /** T23.19D F1: the layers that draw themselves in the world or with Phaser by `worldDraws` (`followWorldDraws`). */
  readonly followers: Set<(on: boolean) => void>
  /**
   * T23.19D F2: the scene's night, R7's `t` = darkness / `NIGHT_DARKNESS` (0 noon … 1 night; 0 in space), set by the
   * scene each frame from `sceneDarkness`. What the furniture's night halo fades with (`furniture.ts::nightHalo`).
   */
  night: number
  /** e2e (T23.10): something reads the world canvas every frame (`render/ordnanceWatch.ts`) — draw every frame. */
  keepDrawing: boolean
  /**
   * e2e (`render/ordnanceWatch.ts`): the world canvas's pixels in a rect of **Phaser canvas px**, read from the frame
   * just drawn (call it after the scene's render, in the same task), at the world's own buffer resolution; null when
   * this scene's world renderer is not drawing. Set by that renderer.
   */
  readWorld: ((x: number, y: number, w: number, h: number) => Uint8Array | null) | null
}

const feeds = new WeakMap<object, FxFeed>()

/** The feed of a Phaser scene (any object the layers and the renderer agree on), made on first ask. */
export function fxFeed(scene: object): FxFeed {
  let f = feeds.get(scene)
  if (!f) {
    f = { ordnance: null, zones: null, weather: null, worldDraws: false, readWorld: null, followers: new Set(), night: 0, keepDrawing: false }
    feeds.set(scene, f)
  }
  return f
}

/** The drawer (the world renderer) says whether it draws this scene; every follower hears a change. */
export function setWorldDraws(feed: FxFeed, on: boolean): void {
  if (feed.worldDraws === on) return
  feed.worldDraws = on
  for (const f of feed.followers) f(on)
}

/**
 * T23.19D F1: **the furniture follows the same flag the effects do.** `use(on)` is called now with the current answer
 * and again on every change — so pickups, labels, graves, animals, gates and turrets are the world renderer's exactly
 * while it draws this scene, and Phaser's otherwise (space, `?world=off`, no WebGL2). Before, each scene told them
 * `!spaceMap`, so with no world renderer they were hidden in Phaser *and* drawn by nobody. Returns the unfollow.
 */
export function followWorldDraws(scene: object, use: (on: boolean) => void): () => void {
  const f = fxFeed(scene)
  f.followers.add(use)
  use(f.worldDraws)
  return () => void f.followers.delete(use)
}

/** §B6: a mine reads at 40 px and is gone by 300 (`ordnanceFx.ts`'s numbers). */
export const MINE_NEAR = 40
export const MINE_FAR = 300

/**
 * This frame's game effects from `feed` into `out` (cleared first). `seconds`: the clock the fire and smoke move on;
 * `lights`: this frame's effect lights, whose muzzle lights are where the muzzle glows go.
 */
export function gameFrame(feed: FxFeed, out: FxFrame, seconds: number, lights: readonly Light[] = []): void {
  clearFrame(out)
  // T23.11 (R7): the smoke in the palette of the scene's hour.
  const smoke = smokeLook(feed.night)
  const z = feed.zones
  if (z?.visible) {
    const st = z.state
    for (const h of st.hazards.values()) if (h.kind !== 'other') cloudFx(out, h, seconds, smoke)
    for (const j of st.jets) coneFx(out, j)
    for (const s of st.swings) swingFx(out, s)
    for (const m of st.mines.values()) {
      const alpha = OrdnanceFxState.mineAlpha(Math.hypot(m.x - z.eye.x, m.y - z.eye.y), MINE_NEAR, MINE_FAR)
      mineFx(out, m, alpha, OrdnanceFxState.isArmed(m.age, z.armTime), z.nowMs)
    }
  }
  const o = feed.ordnance
  if (o?.visible) {
    for (const t of o.state.tracers) beamFx(out, t)
    for (const b of o.state.blasts) blastFx(out, b, smoke)
    for (const p of o.state.projectiles.values()) {
      if (p.kind === 'flame') flameFx(out, p, o.flameRadius)
      else if (p.kind === 'bullet') bulletFx(out, p, o.bulletLength)
      else if (p.kind === 'bazooka') rocketFx(out, p, smoke)
      else if (p.kind === 'meteor') {
        rocketFx(out, p, smoke)
        emberFx(out, p, LOOK.meteor.colour, LOOK.meteor.r)
      } else if (p.kind === 'pellet' || p.kind === 'fragment' || p.kind === 'drop') emberFx(out, p, LOOK[p.kind].colour, LOOK[p.kind].r)
      // The thrown weapons (grenade, airburst, smoke, molotov, toxic) fly as themselves, drawn by Phaser (T23.17).
    }
    for (const l of lights) if (l.muzzle) muzzleFx(out, l.x, l.y, l.i / MUZZLE_LIGHT.i)
  }
  if (feed.weather) weatherFrame(feed.weather, out, seconds)
}
