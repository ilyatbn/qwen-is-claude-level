/**
 * Procedural terrain textures.
 *
 * `docs/51-assets.md` §5 requires the game to start with zero downloaded art, and
 * M3 builds the renderer long before any exists. These are the fallback: seeded
 * value noise into a canvas, tiling correctly, flat but entirely adequate.
 * T7.05 replaces them with real theme textures.
 */

import { resolveTheme } from './themes-math'
// One value-noise implementation, shared with the sky's mountain ridge (§A24).
import { noiseTilePixels } from './noise-math'

export interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * A seamless mottled tile.
 *
 * Wraps by sampling on a torus, so the tile has no visible seam when repeated —
 * which matters because the chunk bake tiles it across the whole map.
 */
export function makeNoiseTile(size: number, base: Rgb, spread: number, seed: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable for a procedural tile')

  // **The arithmetic lives in `noise-math.ts`** (T21.15). `vitest` runs in node,
  // so anything reached only through a canvas cannot be tested — which is how
  // "every map wears the same rock" shipped unnoticed. This function is now the
  // canvas half and nothing else.
  const img = ctx.createImageData(size, size)
  img.data.set(noiseTilePixels(size, base, spread, seed))
  ctx.putImageData(img, 0, 0)
  return canvas
}

/**
 * Per-layer noise offsets. **Offsets, not seeds** (T21.15).
 *
 * They were the whole seed — `makeNoiseTile(..., 7)` and friends — so the rock,
 * the rim and the cave-back were byte-identical on every map ever generated, and
 * the only thing that varied between seeds was which of three palettes was
 * drawn. Reported from play as *"the map texture seems like it's always the
 * same"*, which it was.
 *
 * They stay distinct from each other because the three layers must not share one
 * noise field — the rim tracing the body's mottling exactly would read as a
 * printing error.
 */
const LAYER_FILL = 7
const LAYER_EDGE = 23
const LAYER_BACK = 41

/**
 * The three noise seeds one map uses, **exported so a test reads them rather
 * than re-encoding them**.
 *
 * The first version of `procTextures-math.test.ts` wrote `tileSeed(4242, 7)` and
 * `tileSeed(4242, 23)` by hand, so pointing `LAYER_EDGE` at `LAYER_FILL` — which
 * makes the rim trace the body's mottling exactly — left it green. A test that
 * restates the constants cannot detect them moving.
 */
export function layerSeeds(mapSeed: number): { fill: number; edge: number; back: number } {
  return {
    fill: tileSeed(mapSeed, LAYER_FILL),
    edge: tileSeed(mapSeed, LAYER_EDGE),
    back: tileSeed(mapSeed, LAYER_BACK),
  }
}

/**
 * Fold a map seed into the range `hash01` can actually use.
 *
 * `hash01` does `seed * 1274126177 | 0`, so it truncates to int32 regardless; and
 * a map seed is a `u64` that a JS number cannot hold exactly above 2^53. Folding
 * here makes the narrowing explicit and deterministic instead of leaving it to
 * float precision at the multiply.
 */
export function tileSeed(mapSeed: number, layer: number): number {
  const folded = Math.abs(Math.trunc(mapSeed)) % 2_147_483_647
  return (folded + layer) | 0
}

/**
 * Theme-aware tiles.
 *
 * The palette comes from `themes-math`; the noise comes from the **map seed**
 * plus a per-layer offset (T21.15).
 *
 * **The property the old fixed seeds were written for is kept**, and it is worth
 * stating because it is the reason they looked deliberate: at a *fixed* seed,
 * changing the theme still recolours the map without reshaping it, so two themes
 * remain comparable in a screenshot. `theme` and `mapSeed` are independent
 * inputs, so that holds by construction. What changes is that two *different*
 * seeds no longer produce the same rock.
 *
 * `mapSeed` defaults to 0 so a caller with no map — `PreviewScene` — is still
 * deterministic rather than accidentally varying.
 */
export function makeFillTexture(
  size = 256,
  theme = resolveTheme(0),
  mapSeed = 0,
): HTMLCanvasElement {
  return makeNoiseTile(size, theme.fill, theme.spread.fill, layerSeeds(mapSeed).fill)
}

export function makeEdgeTexture(
  size = 256,
  theme = resolveTheme(0),
  mapSeed = 0,
): HTMLCanvasElement {
  return makeNoiseTile(size, theme.edge, theme.spread.edge, layerSeeds(mapSeed).edge)
}

/** Dark rock seen through craters, behind the terrain body. */
export function makeBackTexture(
  size = 256,
  theme = resolveTheme(0),
  mapSeed = 0,
): HTMLCanvasElement {
  return makeNoiseTile(size, theme.back, theme.spread.back, layerSeeds(mapSeed).back)
}
