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
import type { OrdnanceState } from '../../render/ordnance-state'
import type { OrdnanceFxState } from '../../render/ordnanceFx-math'
import { blastFx, cloudFx, flameFx } from './game'
import { clearFrame, type FxFrame } from './kit'

export interface OrdnanceSource {
  readonly state: OrdnanceState
  /** A check's control frame hides the layer (`setVisible`): its effects go with it. */
  readonly visible: boolean
  /** `FLAME_RADIUS`: the circle a flame burns. */
  readonly flameRadius: number
}

export interface ZonesSource {
  readonly state: OrdnanceFxState
  readonly visible: boolean
}

export interface FxFeed {
  ordnance: OrdnanceSource | null
  zones: ZonesSource | null
  /** The world renderer draws this scene's effects (see the file comment). */
  worldDraws: boolean
}

const feeds = new WeakMap<object, FxFeed>()

/** The feed of a Phaser scene (any object the layers and the renderer agree on), made on first ask. */
export function fxFeed(scene: object): FxFeed {
  let f = feeds.get(scene)
  if (!f) {
    f = { ordnance: null, zones: null, worldDraws: false }
    feeds.set(scene, f)
  }
  return f
}

/** This frame's game effects from `feed` into `out` (cleared first). `seconds`: the clock the fire and smoke move on. */
export function gameFrame(feed: FxFeed, out: FxFrame, seconds: number): void {
  clearFrame(out)
  const z = feed.zones
  if (z?.visible) for (const h of z.state.hazards.values()) if (h.kind !== 'other') cloudFx(out, h, seconds)
  const o = feed.ordnance
  if (o?.visible) {
    for (const b of o.state.blasts) blastFx(out, b)
    for (const p of o.state.projectiles.values()) if (p.kind === 'flame') flameFx(out, p, o.flameRadius)
  }
}
