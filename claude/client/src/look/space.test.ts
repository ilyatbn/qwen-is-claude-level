import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { C, Core } from '../core'
import { F3 } from './scenes/F3'
import { F1 } from './scenes/F1'
import type { Background } from './scene'
import { EARTH_BAND, MOON_BAND, P_SPACE, bakedPlaces, bodyReach, spaceBackground, spaceDescription, starKey } from './space'
import { F3_RADII } from './spaceFeed'
import { bakeExtents, clearAbove } from './skyLayout'
import { ASTEROID_PALETTE, TERRAIN_PALETTE, albedoFs } from './albedo'
import { F3_MOON_FROM_EARTH, spaceBodies, spaceScreen, spaceSkySeed } from '../render/spaceSky-math'

const here = dirname(fileURLToPath(import.meta.url))
beforeAll(async () => {
  await Core.init(readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm')))
})
const F3_BG = F3.look.bg as Background
const W = 1280
const H = 720
/** A Medium space map (the sandbox's default scale). */
const MAP = { w: 3072, h: 1536 }

describe('P_space — variant_F3.js, not F1 (T23.20)', () => {
  it("is F3's sky, rock, fog, bloom, grade, exposure and key light", () => {
    expect(P_SPACE.bg).toEqual(F3_BG)
    expect(P_SPACE.terrain).toEqual(F3.look.terrain)
    expect(P_SPACE.fogBack).toEqual(F3.look.fogBack)
    expect(P_SPACE.bloom).toEqual(F3.look.bloom)
    expect(P_SPACE.grade).toEqual(F3.look.grade)
    expect(P_SPACE.exposure).toBe(F3.look.exposure)
    expect(P_SPACE.moon).toEqual(F3.look.moon)
    // The control: F1's differ where F3 says something else.
    expect(F1.palette!.terrain).not.toEqual(F3.look.terrain)
    expect(F1.palette!.bg).not.toEqual(F3_BG)
  })

  it("F3's radii are the feed's (the debug the checks read)", () => {
    expect(F3_RADII.sun).toBe(F3_BG.sun!.r)
    expect(F3_RADII.earth).toBe(F3_BG.layers[EARTH_BAND]!.r)
    expect(F3_RADII.moon).toBe(F3_BG.layers[MOON_BAND]!.r)
    expect(F3_BG.layers[EARTH_BAND]!.shape).toBe('arc')
    expect(F3_BG.layers[MOON_BAND]!.shape).toBe('arc')
  })

  it("the moon circles F3's place for it beside the planet", () => {
    const e = F3_BG.layers[EARTH_BAND]!
    const m = F3_BG.layers[MOON_BAND]!
    expect(F3_MOON_FROM_EARTH).toEqual([m.x - e.x, m.y - e.y])
  })
})

describe("space's description: one look, no daylight, the asteroid's rock", () => {
  it('is P_space alone, lit terrain on, asteroid albedo, its bodies at their baked places', () => {
    const d = spaceDescription(MAP, false)
    expect(d.daylight).toBeUndefined()
    expect(d.litTerrain).toBe(true)
    expect(d.albedo).toBe('asteroid')
    expect(d.look.bloom).toEqual(F3.look.bloom)
    expect(d.look.exposure).toBe(F3.look.exposure)
    expect(d.spaceSky?.places).toEqual(bakedPlaces(C().VIEWPORT_W, C().VIEWPORT_H))
    const bg = d.look.bg!
    expect([bg.sun!.x, bg.sun!.y]).toEqual(d.spaceSky!.places.sun)
    expect([bg.layers[EARTH_BAND]!.x, bg.layers[EARTH_BAND]!.y]).toEqual(d.spaceSky!.places.earth)
    expect([bg.layers[MOON_BAND]!.x, bg.layers[MOON_BAND]!.y]).toEqual(d.spaceSky!.places.moon)
    // T22.06's star field replaces F3's static dust in the game.
    expect(bg.stars).toBe(0)
    expect(F3_BG.stars).toBeGreaterThan(0)
  })
})

describe('the bodies move within what is baked', () => {
  it('over a long round every body stays inside its reach of its baked place', () => {
    const c = C()
    const s = spaceSkySeed(4242)
    const at = bakedPlaces(W, H)
    const reach = bodyReach(MAP, W, H)
    const panMax: [number, number] = [((MAP.w - W) / 2) * c.SPACE_BODY_PARALLAX, ((MAP.h - H) / 2) * c.SPACE_BODY_PARALLAX]
    let maxMove = 0
    for (let t = 0; t <= 2400; t += 5) {
      for (const pan of [[0, 0], panMax, [-panMax[0], -panMax[1]]] as [number, number][]) {
        const b = spaceBodies(t, s, c, W / c.CAMERA_ZOOM, H / c.CAMERA_ZOOM)
        const p = spaceScreen(b, W, H, 1, pan)
        for (const k of ['sun', 'earth', 'moon'] as const) {
          expect(Math.abs(p[k][0] - at[k][0])).toBeLessThanOrEqual(reach[k][0] + 1e-6)
          expect(Math.abs(p[k][1] - at[k][1])).toBeLessThanOrEqual(reach[k][1] + 1e-6)
        }
        maxMove = Math.max(maxMove, Math.hypot(p.earth[0] - at.earth[0], p.earth[1] - at.earth[1]))
      }
    }
    // The control: the planet does move — most of its reach.
    expect(maxMove).toBeGreaterThan(reach.earth[0] * 0.8)
  })

  it("a body arc's bake is its disc's columns, from above its apex to the frame's bottom as far as it rises", () => {
    const bg = spaceBackground(MAP, W, H)
    const view = { x: MAP.w / 2 - W / 2, y: MAP.h / 2 - H / 2, w: W, h: H }
    const x = bakeExtents(bg, view, MAP, [W, H], 1)
    for (const i of [EARTH_BAND, MOON_BAND]) {
      const l = bg.layers[i]!
      const e = x.layers[i]!
      expect(e.org[0]).toBeLessThanOrEqual(l.x - l.r!)
      expect(e.org[0] + e.ext[0]).toBeGreaterThanOrEqual(l.x + l.r!)
      expect(e.ext[0]).toBeLessThan(2 * l.r! + 32)
      expect(e.org[1]).toBeLessThanOrEqual(clearAbove(l, 1))
      expect(e.org[1] + e.ext[1]).toBeGreaterThanOrEqual(H + l.reach![1])
    }
    // The near limb has no reach: a parallax band, baked over the frame and its parallax margin.
    expect(bg.layers[2]!.reach).toBeUndefined()
    expect(x.layers[2]!.ext[0]).toBeGreaterThan(W)
  })
})

describe('starKey — the cast is rim-lit from the star', () => {
  it('points from the screen centre toward the star', () => {
    const m = starKey([0, 0], W, H)
    expect(m.dx).toBeLessThan(0)
    expect(m.dy).toBeLessThan(0)
    expect(Math.hypot(m.dx, m.dy)).toBeCloseTo(1, 6)
    expect(starKey([W, H], W, H).dx).toBeGreaterThan(0)
  })
})

describe("the asteroid albedo — world.js::THEMES.asteroid", () => {
  it('has no soil, grass or fringe and its own rock, and the ground keeps dusk', () => {
    expect(ASTEROID_PALETTE.noTop).toBe(true)
    expect(ASTEROID_PALETTE.noFringe).toBe(true)
    expect(ASTEROID_PALETTE.boulders).toBe(0.62)
    expect(TERRAIN_PALETTE.noTop).toBe(false)
    const a = albedoFs(ASTEROID_PALETTE)
    const d = albedoFs(TERRAIN_PALETTE)
    expect(a).not.toBe(d)
    expect(a).toContain('vec3(118.0, 110.0, 116.0)')
    expect(d).not.toContain('vec3(118.0, 110.0, 116.0)')
    expect(a).toContain('if (false && up > 0.25')
    expect(d).toContain('if (true && up > 0.25')
  })
})
