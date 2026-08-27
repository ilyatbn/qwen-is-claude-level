/**
 * Which cloud sprite each cloud is, and what colour it is right now.
 *
 * `docs/73-amendments-v5.md` §D0, `docs/72-amendments-v4.md` §C14, T16.04.
 *
 * T15.03 drew twelve procedural blobs. The pack has real ones, so this decides
 * *which* — and nothing else. **Drift, wrap and parallax are unchanged and not
 * touched here**: they are `sky-math.ts`'s `cloudField`/`cloudX`/`cloudTwinX`,
 * they were T15.03's, and a cloud's shape has no business knowing where it is.
 */

import { clientTagSeed } from './noise-math'
import type { SkyPhase } from './sky-math'

/** Which colour set a cloud is drawn from. */
export type CloudColour = 'white' | 'gray' | 'black'

/**
 * **Eight shape families per colour, not three.**
 *
 * T16.04 says *"Three shape families exist per colour (`Shape1`, `Shape2`, …)"*.
 * Counted from the pack: `Clouds_black`, `Clouds_gray` and `Clouds_white` each
 * hold `Shape1`–`Shape8` at five sizes, so 3 x 8 x 5 = 120, and with the 5
 * `Lightning` sprites that is exactly the 125 files §D0 reports. Reading it as
 * three throws away five-eighths of the variety the pack exists to provide.
 */
export const CLOUD_SHAPES = 8
/** `cloud_shapeN_1` … `_5` in every family. */
export const CLOUD_SIZES = 5

/** One cloud's identity: fixed for the round, independent of the time of day. */
export interface CloudSprite {
  /** 1-based, matching the pack's `ShapeN` directories. */
  shape: number
  /** 1-based, matching the `_N` suffix. */
  size: number
}

/**
 * The colour set for a sky phase (§C14).
 *
 * White by day, grey at dusk and dawn, black at night — **and black in a storm
 * whatever the hour**, which is the case §C14 names and the one a phase table
 * alone cannot express.
 *
 * A cloud's *shape* does not change with the light; only which colour set it is
 * drawn from. Tinting is a second, continuous thing on top (`cloudTint`), and
 * §A32's lesson is that a palette judged in one lighting condition is not
 * judged at all — so this is asserted at noon and at midnight, not once.
 *
 * **`storm` has no caller yet, and that is deliberate.** There is no storm state
 * on the client — `WeatherLayer` owns a `RainField` and an `EmberField` and no
 * discrete kind — so `ParallaxLayer` calls this with the phase alone rather than
 * holding a field that is permanently false. The arm is here because §C14 names
 * it and it is asserted below; it goes live when the weather scheduler does,
 * which is the same shelf `Lightning` sits on (§D0, T16.04). Do not read a
 * passing test for it as evidence that a storm darkens the sky today.
 */
export function cloudColourForPhase(phase: SkyPhase, storm = false): CloudColour {
  if (storm) return 'black'
  switch (phase) {
    case 'night':
      return 'black'
    case 'dawn':
    case 'evening':
      return 'gray'
    default:
      return 'white'
  }
}

/**
 * Atlas frame for one cloud. `build-cloud-atlas.mjs` names them this way.
 */
export function cloudFrame(colour: CloudColour, sprite: CloudSprite): string {
  return `cloud_${colour}_s${sprite.shape}_${sprite.size}`
}

/**
 * Pick a shape and size for each of `count` clouds, seeded from the map seed.
 *
 * Seeded so a seed always looks the same — §C14's requirement for the mountains,
 * and the reason a screenshot of a bug is reproducible. Its own tag, so adding
 * this cannot move the positions `cloudField` already drew from the `'clouds'`
 * stream: the same sub-stream discipline `docs/10` §2 uses server-side.
 */
export function cloudSprites(seed: number, count: number): CloudSprite[] {
  let s = clientTagSeed(seed, 'cloud-shapes') >>> 0
  const rnd = (): number => {
    // xorshift32, the same scatter `cloudField` and the star field use.
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
  const out: CloudSprite[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      shape: 1 + Math.floor(rnd() * CLOUD_SHAPES),
      size: 1 + Math.floor(rnd() * CLOUD_SIZES),
    })
  }
  return out
}

/**
 * How a phase-picked sprite is tinted — **and it is not `cloudTint`**.
 *
 * `cloudTint` (`sky-math.ts`) was written for T15.03's one white procedural
 * blob. It mixes white toward the sky's bottom colour *and* scales alpha by sky
 * luminance, because a white blob is the only thing it has to work with and both
 * jobs fall to it.
 *
 * Selecting `Clouds_black` by phase already does the first job, in the art. Doing
 * both would darken twice: a black sprite, mixed toward a near-black night sky,
 * at luminance-scaled alpha — a cloud you cannot see against the night, which is
 * worse than the bright-cloud-at-midnight bug §C14 asked us to avoid and would
 * pass a test that only compares night against noon.
 *
 * So exactly one mechanism darkens a cloud, and which one depends on what is
 * being drawn:
 *
 * - **atlas sprite** — the colour set is the phase response. No colour mix, and
 *   a flat `CLOUD_ALPHA`, so a black cloud stays legible against a black sky.
 * - **procedural blob** — unchanged, `cloudTint` exactly as T15.03 left it.
 *
 * The cost is real and worth stating: a sprite cloud no longer picks up the
 * sky's warmth at dawn, because nothing mixes the gradient into it any more. The
 * three colour sets are a coarser instrument than a continuous mix. A blend of
 * the two — a reduced mix over the sprite — would need two new tunables that no
 * doc specifies, so it is not being invented here.
 */
export function cloudSpriteTint(baseAlpha: number): { color: number; alpha: number } {
  return { color: 0xffffff, alpha: baseAlpha }
}
