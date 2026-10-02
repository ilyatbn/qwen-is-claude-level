/**
 * T23.31: the world looks' registry (`worlds.ts`) — classic is today's two palettes verbatim, volcanic's night is F2's
 * verbatim, each look's two ends have the same shapes (so T23.11's blend walks every field and reaches each end
 * exactly), the override is the dev surface's, and the albedo theme follows the palette.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core, MapScale } from '../core'
import { WORLD_LOOK_IDS, WORLD_LOOKS, worldLook } from './worlds'
import { adoptWorldLook, worldLookByte, worldLookInUrl, worldLookOfMeta, worldLookOverride } from './worldLookId'
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

  it("classic keeps today's cloud sea; volcanic names an ash sea darker than its fog", () => {
    expect(WORLD_LOOKS.classic.sea).toBeNull()
    const sea = WORLD_LOOKS.volcanic.sea
    expect(sea).not.toBeNull()
    const fog = WORLD_LOOKS.volcanic.night.look.fogFront?.color ?? [1, 1, 1]
    const sum = (c: readonly number[]): number => c.reduce((a, b) => a + b, 0)
    expect(sum(sea?.color ?? fog)).toBeLessThan(sum(fog))
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

describe('world looks from the map (T23.31 part 1)', () => {
  let core: Core
  beforeAll(async () => {
    core = await Core.init(readFileSync(fileURLToPath(new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url))))
  }, 120_000)

  it("the ids are the server's, in its byte order", () => {
    expect([...WORLD_LOOK_IDS]).toEqual([...C().WORLD_LOOKS])
    WORLD_LOOK_IDS.forEach((id, i) => expect(worldLookByte(id)).toBe(i))
  })

  it("a generated map carries the generator's look, both occur over seeds, and the core takes map_init's", () => {
    const seen = new Set<string>()
    for (let s = 1n; s <= 16n; s++) {
      core.generate(s, MapScale.Small)
      const id = worldLookOfMeta(core.meta.look)
      expect(adoptWorldLook(core, '?sandbox=1')).toBe(id)
      seen.add(id)
    }
    expect([...seen].sort()).toEqual([...WORLD_LOOK_IDS].sort())
    // `map_init`'s byte, installed: the meta (what the scenes read) follows it, both ways.
    for (const id of WORLD_LOOK_IDS) {
      expect(core.setWorldLook(worldLookByte(id))).toBe(true)
      expect(worldLookOfMeta(core.meta.look)).toBe(id)
    }
    expect(core.setWorldLook(WORLD_LOOK_IDS.length)).toBe(false)
    expect(worldLookOfMeta(undefined)).toBe('classic')
  })
})
