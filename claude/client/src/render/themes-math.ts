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

/** Rec. 601 luminance, 0..255. */
export function luminance(c: Rgb): number {
  return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b
}

/** Unpack a packed 0xRRGGBB into components. */
export function unpackRgb(hex: number): Rgb {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff }
}

/**
 * The daytime sky this theme shows, after its `skyTint` is applied.
 *
 * §A4's keyframe at u = 0.30 is full day — the brightest sky, and the condition
 * under which a misclassified backdrop patch is most visible.
 */
export const DAY_SKY_BOTTOM = 0xa8d8f0

/**
 * The §A4 sky keyframes, as the theme layer needs them: a terrain palette has to
 * hold up against the sky at **every** point in the cycle, not at one keyframe.
 *
 * Duplicated from `sky-math.ts` rather than imported to keep this module free of
 * that dependency; the test asserts the two agree, so they cannot drift.
 */
export const SKY_KEYFRAME_COLOURS: number[] = [
  0x1b2a5e, 0xf2a15c, 0x3f7fd0, 0xbfe3f5, 0x2f7fd8, 0xa8d8f0, 0x3a6fb8, 0xf0c07a,
  0x4a2c6b, 0xe2723b, 0x221041, 0x6b2f5c, 0x030616, 0x0d1a3a, 0x050a1c, 0x10204a,
  0x101a44, 0x6a4a6e,
]

/**
 * How visible this theme's land is against the sky, at its worst moment.
 *
 * **Measured in colour distance, not luminance.** Sky luminance sweeps the whole
 * range twice a day, so it necessarily crosses fixed terrain luminance at dusk
 * and at dawn — every theme has a moment where the two match in brightness
 * (measured: grassland 7.1, desert 9.8, frost 5.3). That is a property of having
 * a day cycle, not a palette defect, and judging on luminance alone names frost
 * the worst theme when by colour distance it is comfortably the best.
 *
 * Terrain also gets its bright edge band along every sky-facing surface
 * (`docs/12` §3), which is the thing that actually separates land from sky; this
 * takes the better of fill and edge for that reason.
 */
export function worstSkyContrast(theme: ThemeDef): number {
  const tint = unpackRgb(theme.skyTint)
  let worst = Number.POSITIVE_INFINITY
  for (const hex of SKY_KEYFRAME_COLOURS) {
    const s = unpackRgb(hex)
    const sky: Rgb = {
      r: (s.r * tint.r) / 255,
      g: (s.g * tint.g) / 255,
      b: (s.b * tint.b) / 255,
    }
    worst = Math.min(worst, paletteDistance(theme.fill, sky), paletteDistance(theme.edge, sky))
  }
  return worst
}

/**
 * Floor for `worstSkyContrast`, chosen from the measured values rather than
 * picked: grassland 7.1, desert 7.9, frost 18.4. A new theme that reads as sky
 * at some point in the cycle fails here rather than in a screenshot nobody takes
 * at that time of day.
 */
export const MIN_SKY_CONTRAST = 6

export function daySkyBottom(theme: ThemeDef): Rgb {
  const sky = unpackRgb(DAY_SKY_BOTTOM)
  const tint = unpackRgb(theme.skyTint)
  return {
    r: (sky.r * tint.r) / 255,
    g: (sky.g * tint.g) / 255,
    b: (sky.b * tint.b) / 255,
  }
}
