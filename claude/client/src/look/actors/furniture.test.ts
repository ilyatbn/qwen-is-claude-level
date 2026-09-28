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
  SPIDER_ART_W,
  VIEW_MARGIN,
  animalActor,
  crystalActors,
  crystalLights,
  graveActor,
  isCrystal,
  labelActor,
  nearView,
  pickupActor,
} from './furniture'
import { CRYSTAL_LIGHT } from '../effectLights'
import { ICON_CENTRE_UNITS, ICON_RES, ICON_UNIT_PX, spriteOf } from './icons'
import { estimateBox } from './cell'

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
    const b = animalActor(BEETLE_KIND, 50, 60, false, w, h)
    expect(b.kind).toBe('beetle')
    expect((b.opts.s ?? 0) * BEETLE_ART_W).toBeCloseTo(w)
    expect(b.y).toBe(60 + h / 2)
    expect(b.opts.face).toBe(-1)
    const s = animalActor(0, 50, 60, true, 12, 8)
    expect(s.kind).toBe('spider')
    expect((s.opts.s ?? 0) * SPIDER_ART_W).toBeCloseTo(12)
    expect(s.lit?.halo).toBe(NIGHT_HALO)
    expect(s.lit?.size).toBeCloseTo(ANIMAL_LIT_PER_S * (s.opts.s ?? 0))
  })

  it('a grave is TOMBSTONE_H tall on its feet line, with the night halo and a box that holds it', () => {
    const g = graveActor(10, 100, 18)
    expect((g.opts.s ?? 0) * GRAVE_ART_H).toBeCloseTo(18)
    expect(g.lit?.halo).toBe(NIGHT_HALO)
    const box = estimateBox(g)
    expect(box[1]).toBeLessThanOrEqual(100 - 18)
    expect(box[3]).toBeGreaterThanOrEqual(100)
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

  it('a label is unlit text; its box holds its plate', () => {
    const l = labelActor('BAZOOKA x1', 100, 50)
    expect(l.lit).toBeNull()
    const b = estimateBox(l)
    expect(b[2] - b[0]).toBeGreaterThan(40)
    expect(b[3]).toBeGreaterThanOrEqual(50)
  })

  it('only what is near the view is drawn', () => {
    const v = { x: 0, y: 0, width: 100, height: 100 }
    expect(nearView(v, 50, 50, VIEW_MARGIN)).toBe(true)
    expect(nearView(v, 100 + VIEW_MARGIN - 1, 50, VIEW_MARGIN)).toBe(true)
    expect(nearView(v, 100 + VIEW_MARGIN + 1, 50, VIEW_MARGIN)).toBe(false)
  })
})
