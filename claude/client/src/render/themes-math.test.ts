import { describe, it, expect } from 'vitest'
import { THEMES, resolveTheme, paletteDistance } from './themes-math'

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

  it('has ids matching their index, so resolveTheme cannot silently mismatch', () => {
    THEMES.forEach((t, i) => expect(t.id).toBe(i))
  })
})
