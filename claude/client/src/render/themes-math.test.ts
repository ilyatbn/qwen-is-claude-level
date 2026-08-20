import { describe, it, expect } from 'vitest'
import {
  THEMES,
  resolveTheme,
  paletteDistance,
  luminance,
  daySkyBottom,
  worstSkyContrast,
  MIN_SKY_CONTRAST,
  SKY_KEYFRAME_COLOURS,
  type ThemeDef,
} from './themes-math'
import { KEYFRAMES as SKY_KEYFRAMES } from './sky-math'

describe('themes', () => {
  it('ships the three the docs name', () => {
    expect(THEMES.map((t) => t.name)).toEqual(['grassland', 'desert', 'frost'])
  })

  it('resolves every id the generator can produce, by wrapping', () => {
    // MapMeta.theme comes from the seed and knows nothing about how many themes
    // the client has, so an out-of-range id must resolve to *a* theme rather
    // than throwing or collapsing everything onto grassland.
    for (const id of [0, 1, 2, 3, 255, 1000]) {
      expect(resolveTheme(id), `id ${id}`).toBeTruthy()
    }
    expect(resolveTheme(3).name).toBe('grassland')
    expect(resolveTheme(4).name).toBe('desert')
    expect(resolveTheme(-1).name).toBe('frost')
  })

  it('is visibly different between themes, not merely differently named', () => {
    // The requirement is "three rounds in a row look visibly different"
    // (docs/12 §4 checkpoint). A theme table whose palettes are near-identical
    // satisfies every structural test and fails the actual requirement, so the
    // assertion is on perceptual distance.
    const MIN = 20
    for (let i = 0; i < THEMES.length; i++) {
      for (let j = i + 1; j < THEMES.length; j++) {
        const a = THEMES[i]!
        const b = THEMES[j]!
        const fill = paletteDistance(a.fill, b.fill)
        const edge = paletteDistance(a.edge, b.edge)
        expect(
          Math.max(fill, edge),
          `${a.name} vs ${b.name}: fill ${fill.toFixed(1)}, edge ${edge.toFixed(1)}`,
        ).toBeGreaterThan(MIN)
      }
    }
  })

  it('keeps the edge lighter than the fill, or the rim stops reading as ground', () => {
    // The edge band is what makes terrain read as ground rather than as a
    // silhouette (docs/12 §3). An edge darker than its fill inverts that.
    for (const t of THEMES) {
      const lum = (c: { r: number; g: number; b: number }) => 0.3 * c.r + 0.59 * c.g + 0.11 * c.b
      expect(lum(t.edge), t.name).toBeGreaterThan(lum(t.fill))
      expect(lum(t.back), t.name).toBeLessThan(lum(t.fill))
    }
  })

  it('keeps its land visible against the sky at every point in the cycle', () => {
    // Measured in colour distance, not luminance. Sky luminance sweeps the whole
    // range twice a day, so it *must* cross fixed terrain luminance at dusk and
    // dawn — grassland 7.1, desert 9.8, frost 5.3 at their worst. Judging on
    // brightness alone calls frost the worst theme when by colour it is the best
    // (18.4 against 7.1 and 7.9), which is how a real palette gets "fixed" for a
    // defect it does not have.
    for (const t of THEMES) {
      expect(worstSkyContrast(t), t.name).toBeGreaterThanOrEqual(MIN_SKY_CONTRAST)
    }
  })

  it('would reject a theme that reads as sky', () => {
    // The control. Without it, the bound above passes for any palette at all if
    // the metric is wrong — and this metric was wrong once already.
    const skyLike: ThemeDef = {
      ...THEMES[0]!,
      name: 'sky-coloured',
      fill: { r: 168, g: 216, b: 240 },
      edge: { r: 168, g: 216, b: 240 },
      skyTint: 0xffffff,
    }
    expect(worstSkyContrast(skyLike)).toBeLessThan(MIN_SKY_CONTRAST)
  })

  it('checks the sky colours the sky layer actually draws', () => {
    // The keyframe table is duplicated here to keep this module free of a
    // dependency on sky-math; duplicated data that nothing compares is data that
    // drifts (§A24).
    const fromSky = new Set(SKY_KEYFRAMES.flatMap(([, top, bottom]) => [top, bottom]))
    for (const c of SKY_KEYFRAME_COLOURS) expect(fromSky.has(c), `0x${c.toString(16)}`).toBe(true)
    expect(SKY_KEYFRAME_COLOURS.length).toBe(fromSky.size)
  })

  it('has ids matching their index, so resolveTheme cannot silently mismatch', () => {
    THEMES.forEach((t, i) => expect(t.id).toBe(i))
  })
})

describe('A32: a backdrop that is lighter than its sky turns a residual into a hole', () => {
  it('keeps every theme’s backdrop darker than its daytime sky', () => {
    // §A19 accepted a few percent of open sky drawn as cave backdrop. That
    // residual is only tolerable while it reads as *shadow*; a backdrop lighter
    // than the sky would render the same error as flat polygons hanging in the
    // air. This is a constraint on the palette, so it holds for every theme
    // added later without anyone having to remember it.
    const MARGIN = 30
    for (const t of THEMES) {
      const back = luminance(t.back)
      const sky = luminance(daySkyBottom(t))
      expect(
        sky - back,
        `${t.name}: backdrop lum ${back.toFixed(0)} vs day sky ${sky.toFixed(0)}`,
      ).toBeGreaterThan(MARGIN)
    }
  })
})
