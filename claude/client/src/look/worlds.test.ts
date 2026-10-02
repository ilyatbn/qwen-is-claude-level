/**
 * T23.31: the world looks' registry (`worlds.ts`) — classic is today's two palettes verbatim, volcanic's night is F2's
 * verbatim, each look's two ends have the same shapes (so T23.11's blend walks every field and reaches each end
 * exactly), the override is the dev surface's, and the albedo theme follows the palette.
 */
import { describe, expect, it } from 'vitest'
import { WORLD_LOOK_IDS, WORLD_LOOKS, worldLook } from './worlds'
import { worldLookInUrl, worldLookOverride } from './worldLookId'
import { blendLook, blendPalette } from './daylight'
import { albedoTheme, albedoFs, ALBEDO_FS, TERRAIN_PALETTE, VOLCANIC_PALETTE } from './albedo'
import { F1 } from './scenes/F1'
import { F2 } from './scenes/F2'
import { F5 } from './scenes/F5'

/** Every key path of a value (arrays by index), for "the same shapes". */
function paths(v: unknown, at = ''): string[] {
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [`${at}/${k}`, ...paths(x, `${at}/${k}`)])
  return []
}

describe('world looks', () => {
  it('lists every look once, classic first', () => {
    expect(WORLD_LOOK_IDS[0]).toBe('classic')
    expect(new Set(WORLD_LOOK_IDS).size).toBe(WORLD_LOOK_IDS.length)
    for (const id of WORLD_LOOK_IDS) expect(WORLD_LOOKS[id].id).toBe(id)
  })

  it('classic is F1 by night and F5 by day, the very objects', () => {
    const c = WORLD_LOOKS.classic
    expect(c.night.look).toBe(F1.look)
    expect(c.night.palette).toBe(F1.palette)
    expect(c.day.look).toBe(F5.look)
    expect(c.day.palette).toBe(F5.palette)
    expect(c.backdrop).toBeNull()
    expect(c.fauna).toBe('classic')
  })

  it("volcanic's night is F2's, and its day differs from it", () => {
    const v = WORLD_LOOKS.volcanic
    expect(v.night.look).toBe(F2.look)
    expect(v.night.palette).toBe(F2.palette)
    expect(v.day.look.bg?.skyBottom).not.toBe(F2.look.bg?.skyBottom)
    expect(v.day.look.terrain.sunCol).not.toEqual(F2.look.terrain.sunCol)
    // The low tier bakes the night's shadows at every hour: the ends must agree on the sun's direction.
    expect(v.day.look.terrain.sunDir).toEqual(v.night.look.terrain.sunDir)
    expect(v.backdrop).toBe('volcano')
    expect(v.fauna).toBe('volcanic')
  })

  it("each look's two ends have the same shapes, and the blend reaches both exactly", () => {
    for (const id of WORLD_LOOK_IDS) {
      const { day, night } = WORLD_LOOKS[id]
      if (id === 'volcanic') {
        expect(paths(day.look).sort()).toEqual(paths(night.look).sort())
        expect(paths(day.palette).sort()).toEqual(paths(night.palette).sort())
      }
      expect(blendLook(day.look, night.look, 0)).toEqual(day.look)
      expect(blendLook(day.look, night.look, 1)).toEqual(night.look)
      expect(blendPalette(day.palette, night.palette, 1)).toEqual(night.palette)
    }
    // Control: half way is neither end.
    const v = WORLD_LOOKS.volcanic
    expect(blendLook(v.day.look, v.night.look, 0.5).bg?.skyBottom).not.toBe(v.night.look.bg?.skyBottom)
  })

  it('an unknown id is classic', () => {
    expect(worldLook('lunar').id).toBe('classic')
    expect(worldLook(undefined).id).toBe('classic')
    expect(worldLook('volcanic').id).toBe('volcanic')
  })

  it('the override reads ?look= and ?worldlook=, and nothing else', () => {
    expect(worldLookInUrl('?sandbox=1&look=volcanic')).toBe('volcanic')
    expect(worldLookInUrl('?game=1&worldlook=volcanic')).toBe('volcanic')
    expect(worldLookInUrl('?look=F2')).toBeNull()
    expect(worldLookInUrl('?sandbox=1')).toBeNull()
    // Off the dev surface (a shipped build, and this test) the override is never read.
    expect(worldLookOverride('?sandbox=1&look=volcanic')).toBeNull()
  })

  it("the albedo theme is the palette's: volcanic paints F2's rock without a grass fringe", () => {
    expect(albedoTheme(WORLD_LOOKS.volcanic.night.palette.theme)).toBe('volcanic')
    expect(albedoTheme(WORLD_LOOKS.volcanic.day.palette.theme)).toBe('volcanic')
    expect(albedoTheme(WORLD_LOOKS.classic.night.palette.theme)).toBe('dusk')
    expect(albedoTheme('asteroid')).toBe('dusk')
    expect(albedoFs(TERRAIN_PALETTE)).toBe(ALBEDO_FS)
    const v = albedoFs(VOLCANIC_PALETTE)
    expect(v).not.toBe(ALBEDO_FS)
    expect(v).toContain('if (false && f.g')
    expect(ALBEDO_FS).not.toContain('false &&')
  })
})
