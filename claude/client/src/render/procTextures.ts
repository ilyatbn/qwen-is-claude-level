/**
 * Procedural terrain textures.
 *
 * `docs/51-assets.md` §5 requires the game to start with zero downloaded art, and
 * M3 builds the renderer long before any exists. These are the fallback: seeded
 * value noise into a canvas, tiling correctly, flat but entirely adequate.
 * T7.05 replaces them with real theme textures.
 */

/** Deterministic hash → 0..1, same shape as the Rust lattice noise. */
function hash01(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  h = h ^ (h >>> 16)
  return ((h >>> 0) % 65536) / 65536
}

/**
 * Value noise on a lattice that **wraps** after `cells` steps.
 *
 * The wrap is the whole point. Sampling an unwrapped lattice gives a tile whose
 * left edge does not match its right, and tiling it across the map draws a visible
 * grid — which is exactly what the first preview screenshot showed.
 */
function wrappedNoise(x: number, y: number, cells: number, size: number, seed: number): number {
  const fx = (x / size) * cells
  const fy = (y / size) * cells
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const s = (t: number) => t * t * (3 - 2 * t)
  const w = (n: number) => ((n % cells) + cells) % cells

  const a = hash01(w(x0), w(y0), seed)
  const b = hash01(w(x0 + 1), w(y0), seed)
  const c = hash01(w(x0), w(y0 + 1), seed)
  const d = hash01(w(x0 + 1), w(y0 + 1), seed)
  const top = a + (b - a) * s(tx)
  const bot = c + (d - c) * s(tx)
  return top + (bot - top) * s(ty)
}

import { resolveTheme } from './themes-math'

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

  const img = ctx.createImageData(size, size)
  const px = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Two octaves, both on wrapping lattices, so the tile is seamless.
      const n =
        0.65 * wrappedNoise(x, y, 8, size, seed) +
        0.35 * wrappedNoise(x, y, 32, size, seed + 17)
      const v = (n - 0.5) * spread
      const i = (y * size + x) * 4
      px[i] = Math.max(0, Math.min(255, base.r + v))
      px[i + 1] = Math.max(0, Math.min(255, base.g + v))
      px[i + 2] = Math.max(0, Math.min(255, base.b + v))
      px[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

/**
 * Theme-aware tiles. The palette comes from `themes-math`, the noise seeds are
 * fixed per layer so a theme change recolours the map without reshaping it —
 * which makes two themes comparable in a screenshot.
 */
export function makeFillTexture(size = 256, theme = resolveTheme(0)): HTMLCanvasElement {
  return makeNoiseTile(size, theme.fill, theme.spread.fill, 7)
}

export function makeEdgeTexture(size = 256, theme = resolveTheme(0)): HTMLCanvasElement {
  return makeNoiseTile(size, theme.edge, theme.spread.edge, 23)
}

/** Dark rock seen through craters, behind the terrain body. */
export function makeBackTexture(size = 256, theme = resolveTheme(0)): HTMLCanvasElement {
  return makeNoiseTile(size, theme.back, theme.spread.back, 41)
}
