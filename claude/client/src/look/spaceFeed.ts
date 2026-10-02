/**
 * T23.20 — the space feed: what the scene's `SpaceSky` (`render/spaceSky.ts`) hands the world renderer each frame
 * (`space.ts` draws it). **Three-free on purpose**: the scenes import `SpaceSky` eagerly and three.js is the world
 * renderer's lazily loaded chunk (`loadWorldRenderer.ts`), so this module carries data only.
 */

/** F3's sky as drawn (`variant_F3.js`): its first two arcs are the planet and the moon. */
export const EARTH_BAND = 0
export const MOON_BAND = 1
/** F3's radii, frame px: the star's disc, the planet's arc, the moon's (`variant_F3.js`; `space.test.ts` pins them to `F3`). */
export const F3_RADII = { sun: 8, earth: 620, moon: 260 } as const

/** A body or the star field a check may hide for its control frame (T22.06's parts, `shade` retired with the shade). */
export type SpacePart = 'sun' | 'earth' | 'moon' | 'stars'

/**
 * What the scene's `SpaceSky` hands the world renderer each frame (plain data, R11): whether space is shown, the
 * bodies' places (frame px: the star's centre, each arc's apex — `spaceSky-math.ts::spaceScreen`), the star field
 * (`stars`: x, y, alpha, size per star, frame px; `starRgb`: its sRGB colour, 0–1) and the parts a check hid.
 */
export interface SpaceFeed {
  shown: boolean
  sun: [number, number]
  earth: [number, number]
  moon: [number, number]
  stars: Float32Array
  starRgb: Float32Array
  starCount: number
  hidden: Set<SpacePart>
  /** Bumped on every write — the renderer redraws when it moves (the bodies and the stars move on the round's clock). */
  version: number
}

const feeds = new WeakMap<object, SpaceFeed>()

/** The space feed of a Phaser scene, made on first ask. */
export function spaceFeed(scene: object): SpaceFeed {
  let f = feeds.get(scene)
  if (!f) {
    f = { shown: false, sun: [0, 0], earth: [0, 0], moon: [0, 0], stars: new Float32Array(0), starRgb: new Float32Array(0), starCount: 0, hidden: new Set(), version: 0 }
    feeds.set(scene, f)
  }
  return f
}

