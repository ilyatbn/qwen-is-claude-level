import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  ANIMAL_LIT_PER_S,
  BEETLE_ART_W,
  BEETLE_KIND,
  CRYSTAL_ART_H,
  CRYSTAL_OBJECT_IDS,
  CRYSTAL_S_MAX,
  GRAVE_ART_H,
  ITEM_S,
  NIGHT_HALO,
  NIGHT_HALO_STEPS,
  nightHalo,
  SPIDER_ART_W,
  VIEW_MARGIN,
  BIRD_ART_W,
  BIRD_FLAP_STEPS,
  animalActor,
  CRAWLER_ART_W,
  GAIT_STEPS,
  TRIPOD_ART_W,
  birdActor,
  crystalActors,
  crystalLights,
  graveActor,
  graveGlow,
  GRAVE_GLOW_DAY_A,
  GRAVE_GLOW_NIGHT_A,
  rgbOfHex,
  isCrystal,
  nearView,
  pickupActor,
} from './furniture'
import { CRYSTAL_LIGHT } from '../effectLights'
import { ICON_CENTRE_UNITS, ICON_RES, ICON_UNIT_PX, spriteOf } from './icons'
import { HALO_A, estimateBox } from './cell'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('furniture (T23.19)', () => {
  it("the crystal ids are the objects manifest's crystal entries, every one", () => {
    const m = JSON.parse(readFileSync(join(root, 'assets/objects/manifest.json'), 'utf8')) as { objects: { id: number; category: string }[] }
    const want = m.objects.filter((o) => o.category === 'crystal').map((o) => o.id)
    const got = m.objects.filter((o) => isCrystal(o.id)).map((o) => o.id)
    expect(want.length).toBeGreaterThan(0)
    expect(got).toEqual(want)
    expect(CRYSTAL_OBJECT_IDS.to - CRYSTAL_OBJECT_IDS.from).toBe(want.length)
  })

  it("a stamped crystal stands one cluster on its base, F1's size at most, in its middle; one light each", () => {
    const o = { id: CRYSTAL_OBJECT_IDS.from, x: 100, y: 200, w: 72, h: 58 }
    const cs = crystalActors(o)
    expect(cs).toHaveLength(1)
    for (const a of cs) {
      expect(a.kind).toBe('crystals')
      expect(a.y).toBe(o.y + o.h)
      expect(a.x).toBeGreaterThan(o.x)
      expect(a.x).toBeLessThan(o.x + o.w)
      expect(a.opts.s).toBeCloseTo(Math.min(CRYSTAL_S_MAX, o.h / CRYSTAL_ART_H))
    }
    const rock = { id: CRYSTAL_OBJECT_IDS.from - 1, x: 0, y: 0, w: 50, h: 40 }
    const lights = crystalLights([o, rock])
    expect(lights).toHaveLength(1)
    expect(lights[0]!.r).toBe(CRYSTAL_LIGHT.r)
    expect(lights[0]!.x).toBe(o.x + o.w / 2)
  })

  it('an animal is drawn at its hit box: its body as wide as the box, standing on its bottom edge, facing its way', () => {
    const w = 16
    const h = 10
    const b = animalActor(BEETLE_KIND, 50, 60, false, w, h, 1)
    expect(b.kind).toBe('beetle')
    expect((b.opts.s ?? 0) * BEETLE_ART_W).toBeCloseTo(w)
    expect(b.y).toBe(60 + h / 2)
    expect(b.opts.face).toBe(-1)
    const s = animalActor(0, 50, 60, true, 12, 8, 1)
    expect(s.kind).toBe('spider')
    expect((s.opts.s ?? 0) * SPIDER_ART_W).toBeCloseTo(12)
    expect(s.lit?.halo).toBe(NIGHT_HALO)
    expect(s.lit?.size).toBeCloseTo(ANIMAL_LIT_PER_S * (s.opts.s ?? 0))
  })

  it("T23.31: the volcanic world's animals on the same kinds — the tripod where the beetle is, the crawler where the spider is, walking", () => {
    const t = animalActor(BEETLE_KIND, 50, 60, false, 16, 10, 1, 'volcanic', 0.5)
    expect(t.kind).toBe('tripod')
    expect((t.opts.s ?? 0) * TRIPOD_ART_W).toBeCloseTo(16)
    expect(t.y).toBe(65)
    expect(t.opts.face).toBe(-1)
    expect(t.opts.gait).toBeCloseTo(Math.round(0.5 * GAIT_STEPS) / GAIT_STEPS)
    const c = animalActor(0, 50, 60, true, 12, 8, 1, 'volcanic', 0.99)
    expect(c.kind).toBe('crawler')
    expect((c.opts.s ?? 0) * CRAWLER_ART_W).toBeCloseTo(12)
    // A gait just short of a whole stride is the first step again: GAIT_STEPS cells, no more.
    expect(c.opts.gait).toBe(0)
    const steps = new Set(Array.from({ length: 100 }, (_, i) => animalActor(0, 0, 0, true, 12, 8, 1, 'volcanic', i / 100).opts.gait))
    expect(steps.size).toBe(GAIT_STEPS)
    // Control: classic keeps F4's two, unchanged by a gait.
    expect(animalActor(BEETLE_KIND, 50, 60, false, 16, 10, 1, 'classic', 0.5)).toEqual(animalActor(BEETLE_KIND, 50, 60, false, 16, 10, 1))
  })

  it('a grave is TOMBSTONE_H tall on its feet line, with the night halo and a box that holds it', () => {
    const g = graveActor(10, 100, 18, 1)
    expect((g.opts.s ?? 0) * GRAVE_ART_H).toBeCloseTo(18)
    expect(g.lit?.halo).toBe(NIGHT_HALO)
    expect(g.lit?.haloAlpha).toBe(HALO_A)
    const box = estimateBox(g)
    expect(box[1]).toBeLessThanOrEqual(100 - 18)
    expect(box[3]).toBeGreaterThanOrEqual(100)
  })

  it('T23.19D F2: the night halo fades with the night — none at noon, F\'s at full night, whole steps between', () => {
    // The control: the same grave and animal at full night wear it (above), so "none at noon" is not "never".
    expect(graveActor(10, 100, 18, 0).lit?.halo).toBeNull()
    expect(animalActor(0, 50, 60, true, 12, 8, 0).lit?.halo).toBeNull()
    expect(nightHalo(-0.5).halo).toBeNull()
    expect(nightHalo(2)).toEqual({ halo: NIGHT_HALO, haloAlpha: HALO_A })
    const half = nightHalo(0.5)
    expect(half.halo).toBe(NIGHT_HALO)
    expect(half.haloAlpha).toBeCloseTo(HALO_A / 2)
    // Stepped: every night within half a step of 0.5 is the same cell (one atlas drawing through dusk, not one a frame).
    const eps = 0.4 / NIGHT_HALO_STEPS
    expect(nightHalo(0.5 + eps)).toEqual(half)
    expect(nightHalo(0.5 - eps)).toEqual(half)
    const seen = new Set<number | undefined>()
    for (let i = 0; i <= 100; i++) seen.add(nightHalo(i / 100).haloAlpha)
    expect(seen.size).toBe(NIGHT_HALO_STEPS + 1)
  })

  it("T23.36: a grave glows in its owner's colour — faint by day, stronger by night, in the night halo's steps", () => {
    const red = rgbOfHex('#e8482c')
    expect(red).toBe('232,72,44')
    const noon = graveActor(10, 100, 18, 0, red)
    const night = graveActor(10, 100, 18, 1, red)
    // By day too (the night halo has none at noon: the control just above).
    expect(noon.lit?.halo).toBe(red)
    expect(noon.lit?.haloAlpha).toBe(GRAVE_GLOW_DAY_A)
    expect(night.lit?.halo).toBe(red)
    expect(night.lit?.haloAlpha).toBe(GRAVE_GLOW_NIGHT_A)
    expect(GRAVE_GLOW_DAY_A).toBeGreaterThan(0)
    expect(GRAVE_GLOW_NIGHT_A).toBeGreaterThan(GRAVE_GLOW_DAY_A)
    // Two owners, two colours: the cell key (`lit` is in it) tells them apart.
    const teal = graveActor(10, 100, 18, 1, rgbOfHex('#18c2b8'))
    expect(teal.lit?.halo).not.toBe(night.lit?.halo)
    // Stepped as the night halo is: one atlas drawing a step through dusk.
    const seen = new Set<number | undefined>()
    for (let i = 0; i <= 100; i++) seen.add(graveGlow(i / 100, red).haloAlpha)
    expect(seen.size).toBe(NIGHT_HALO_STEPS + 1)
    // Control: no glow given — the night halo exactly as before.
    expect(graveActor(10, 100, 18, 1)).toEqual({ ...night, lit: { size: 1, ...nightHalo(1), shadow: true } })
  })

  it("a weapon pickup is its model at the icon's fitted scale, centred; anything else is an item drawing", () => {
    const sprite = spriteOf('bazooka')
    ICON_UNIT_PX.set(sprite, 3)
    ICON_CENTRE_UNITS.set(sprite, [4, -1])
    const a = pickupActor(sprite, 30, 40)
    expect(a.kind).toBe('weapon')
    expect(a.opts.key).toBe('bazooka')
    expect(a.opts.s).toBeCloseTo(3 / ICON_RES)
    expect(a.opts.origin).toEqual([-4 * (3 / ICON_RES), 1 * (3 / ICON_RES)])
    const m = pickupActor('item_medkit', 30, 40)
    expect(m.kind).toBe('item')
    expect(m.opts.key).toBe('item_medkit')
    expect(m.opts.s).toBe(ITEM_S)
  })

  it('only what is near the view is drawn', () => {
    const v = { x: 0, y: 0, width: 100, height: 100 }
    expect(nearView(v, 50, 50, VIEW_MARGIN)).toBe(true)
    expect(nearView(v, 100 + VIEW_MARGIN - 1, 50, VIEW_MARGIN)).toBe(true)
    expect(nearView(v, 100 + VIEW_MARGIN + 1, 50, VIEW_MARGIN)).toBe(false)
  })

  it('T23.19B: a bird is F4\'s drawing scaled to its hit box, its wing drawn at one of BIRD_FLAP_STEPS positions', () => {
    const w = 18
    const a = birdActor(false, 100, 50, true, w, 0.3)
    expect(a.kind).toBe('bird')
    expect(a.opts.s).toBeCloseTo(w / BIRD_ART_W, 12)
    expect(a.opts.face).toBe(1)
    expect(a.opts.metal).toBeUndefined()
    expect(birdActor(true, 100, 50, false, w, 0.3).opts).toMatchObject({ metal: true, face: -1 })
    // The phase is continuous; the drawing takes BIRD_FLAP_STEPS values (one atlas cell each), both ends included.
    const flaps = new Set<number>()
    for (let k = 0; k <= 400; k++) flaps.add(birdActor(false, 0, 0, true, w, -1 + (2 * k) / 400).opts.flap ?? -1)
    expect(flaps.size).toBe(BIRD_FLAP_STEPS)
    expect(Math.min(...flaps)).toBe(0)
    expect(Math.max(...flaps)).toBe(1)
    // The box the cell is cut from holds the drawing (span ±10 units, flap ±6).
    const b = estimateBox(a)
    const s = a.opts.s ?? 1
    expect(b[0]).toBeLessThanOrEqual(a.x - 10 * s)
    expect(b[2]).toBeGreaterThanOrEqual(a.x + 10 * s)
    expect(b[1]).toBeLessThanOrEqual(a.y - 7 * s)
    expect(b[3]).toBeGreaterThanOrEqual(a.y + 7 * s)
  })
})
