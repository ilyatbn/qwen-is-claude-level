/**
 * The three terrain themes (`docs/12-map-render.md` §4, `docs/50` §5).
 *
 * Phaser-free (§A8). The theme is chosen from `MapMeta.theme`, which is seeded,
 * so a seed always looks the same — which matters for a bug report with a
 * screenshot attached.
 *
 * These are the **procedural fallback** palettes (`docs/51` §5), and on this
 * project the fallback is the shipping path: Kenney has no seamless 256 px rock
 * textures, and generated tiles wrap by construction where a photograph would
 * need hand-editing to. A theme with real PNGs on disk overrides these.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface ThemeDef {
  id: number
  name: string
  /** Terrain body. */
  fill: Rgb
  /** The upward-facing rim — the thing that makes terrain read as ground. */
  edge: Rgb
  /** Rock seen through craters and cave mouths, behind the terrain body. */
  back: Rgb
  /** Mottling strength per layer; higher reads as coarser rock. */
  spread: { fill: number; edge: number; back: number }
  /** Multiplied into the sky gradient (§A4) so the whole frame agrees. */
  skyTint: number
  fogTint: number
  lightTint: number
}

export const THEMES: ThemeDef[] = [
  {
    id: 0,
    name: 'grassland',
    fill: { r: 92, g: 78, b: 62 },
    edge: { r: 104, g: 152, b: 68 },
    back: { r: 38, g: 32, b: 27 },
    spread: { fill: 46, edge: 40, back: 20 },
    skyTint: 0xffffff,
    fogTint: 0xc9d6e0,
    lightTint: 0xfff3d0,
  },
  {
    id: 1,
    name: 'desert',
    fill: { r: 156, g: 118, b: 74 },
    edge: { r: 214, g: 176, b: 104 },
    back: { r: 62, g: 44, b: 30 },
    spread: { fill: 38, edge: 34, back: 18 },
    skyTint: 0xffe9c8,
    fogTint: 0xe4cfa8,
    lightTint: 0xffe2a8,
  },
  {
    id: 2,
    name: 'frost',
    fill: { r: 108, g: 122, b: 140 },
    edge: { r: 214, g: 232, b: 244 },
    back: { r: 34, g: 44, b: 58 },
    spread: { fill: 40, edge: 28, back: 20 },
    skyTint: 0xd8e8ff,
    fogTint: 0xdce9f4,
    lightTint: 0xdcecff,
  },
]

/**
 * Resolve a theme id from `MapMeta.theme`.
 *
 * Wraps rather than falling back to 0: the generator picks the id from the seed
 * and has no idea how many themes the client ships, so an id past the end is a
 * normal event, not an error. Falling back to 0 would make every unknown id look
 * like grassland, which hides the problem instead of showing a different map.
 */
export function resolveTheme(themeId: number): ThemeDef {
  const n = THEMES.length
  const i = ((Math.trunc(themeId) % n) + n) % n
  return THEMES[i] as ThemeDef
}

/** Perceptual distance between two themes' fills — used to prove they differ. */
export function paletteDistance(a: Rgb, b: Rgb): number {
  // Rec. 601 weights: a green/brown pair that differs mostly in hue should still
  // register, and a plain Euclidean RGB distance under-weights green.
  const dr = (a.r - b.r) * 0.3
  const dg = (a.g - b.g) * 0.59
  const db = (a.b - b.b) * 0.11
  return Math.sqrt(dr * dr + dg * dg + db * db)
}
