import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { C, Core } from '../core'
import { darknessAt } from '../render/sky-math'
import { arcOffset, blendLook, blendPalette, DAY_MOON_U, HEX_KEYS, mixValue, MOON_REACH, MOON_TRAVEL, moonArcs, NIGHT_MOON_U, nightShare } from './daylight'
import type { Background } from './scene'
import { F1 } from './scenes/F1'
import { F5 } from './scenes/F5'
import { gameSky } from './skyLayout'

/** Every leaf of `v` — numbers, strings, booleans, nulls — by path. */
function leaves(v: unknown, path = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) leaves(x, path ? `${path}.${k}` : k, out)
    if (Array.isArray(v) && v.length === 0) out.set(path, '[]')
  } else out.set(path, v)
  return out
}

/** The numeric value of a leaf for the continuity test: numbers as they are, colour strings per channel. */
function channels(v: unknown, key: string): number[] {
  if (typeof v === 'number') return HEX_KEYS.has(key) ? [(v >> 16) & 255, (v >> 8) & 255, v & 255] : [v]
  if (typeof v === 'string') {
    const m = v.match(/[\d.]+/g)
    if (v.startsWith('#')) {
      const h = parseInt(v.slice(1), 16)
      return [(h >> 16) & 255, (h >> 8) & 255, h & 255]
    }
    return m && /\d/.test(v[0] ?? '') || v.startsWith('rgba') ? (m ?? []).map(Number) : []
  }
  return []
}

const here = dirname(fileURLToPath(import.meta.url))
let ND = NaN
beforeAll(async () => {
  await Core.init(readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm')))
  ND = C().NIGHT_DARKNESS
})

const DAY = { look: F5.look, palette: F5.palette }
const NIGHT = { look: F1.look, palette: F1.palette }

describe('T23.11: night and moonlit day, one blend', () => {
  it('blend(0) is P_day and blend(1) is P_night, field by field — counted at both ends', () => {
    for (const [what, day, night, blend] of [
      ['look', DAY.look, NIGHT.look, (t: number) => blendLook(DAY.look, NIGHT.look, t)],
      ['palette', DAY.palette, NIGHT.palette, (t: number) => blendPalette(DAY.palette, NIGHT.palette, t)],
    ] as const) {
      const d = leaves(day)
      const n = leaves(night)
      const b0 = leaves(blend(0))
      const b1 = leaves(blend(1))
      // Count both ends: a field the blend drops (or invents) changes the count before it changes a value.
      expect(b0.size, `${what}: blend(0) has ${b0.size} fields, P_day ${d.size}`).toBe(d.size)
      expect(b1.size, `${what}: blend(1) has ${b1.size} fields, P_night ${n.size}`).toBe(n.size)
      for (const [k, v] of d) expect(b0.get(k), `${what}.${k} at t 0`).toEqual(v)
      for (const [k, v] of n) expect(b1.get(k), `${what}.${k} at t 1`).toEqual(v)
      // Not vacuous: the two palettes differ in many fields, so equality at each end is a claim about the blend.
      const differ = [...n].filter(([k, v]) => d.has(k) && JSON.stringify(d.get(k)) !== JSON.stringify(v)).length
      expect(differ, `${what}: fields that differ between F1 and F5`).toBeGreaterThan(what === 'look' ? 40 : 40)
    }
  })

  it('is continuous: no field jumps more than a tenth of its range between adjacent steps', () => {
    const STEPS = 100
    const series = Array.from({ length: STEPS + 1 }, (_, i) => leaves(blendLook(DAY.look, NIGHT.look, i / STEPS)))
    const pal = Array.from({ length: STEPS + 1 }, (_, i) => leaves(blendPalette(DAY.palette, NIGHT.palette, i / STEPS)))
    let moving = 0
    for (const s of [series, pal]) {
      const keys = new Set(s.flatMap((m) => [...m.keys()]))
      for (const k of keys) {
        const key = k.split('.').pop() ?? ''
        // A thing one end alone has is absent at the far end (its `vis`, tested below, has faded to 0 by then):
        // compared only where it exists.
        const vals = s.map((m) => (m.has(k) ? channels(m.get(k), key) : null))
        const width = Math.max(0, ...vals.map((v) => v?.length ?? 0))
        for (let c = 0; c < width; c++) {
          const col = vals.map((v) => (v ? v[c] ?? 0 : NaN))
          const present = col.filter((v) => !Number.isNaN(v))
          const range = Math.max(...present) - Math.min(...present)
          if (range === 0) continue
          moving++
          for (let i = 1; i <= STEPS; i++) {
            if (Number.isNaN(col[i]!) || Number.isNaN(col[i - 1]!)) continue
            expect(Math.abs(col[i]! - col[i - 1]!), `${k}[${c}] between t ${(i - 1) / STEPS} and ${i / STEPS}`).toBeLessThanOrEqual(range / 10)
          }
        }
      }
    }
    // The fields that move: every differing colour channel and number (a zero here would pass vacuously).
    expect(moving).toBeGreaterThan(100)
  })

  it('blends colours in linear space, not in 0–255', () => {
    // Half way between black and white in linear light is 0.5 linear — 186 in sRGB (2.2), not 128.
    expect(mixValue(0x000000, 0xffffff, 0.5, 'skyTop')).toBe(0xbababa)
    expect(mixValue('0,0,0', '255,255,255', 0.5)).toBe('186.08,186.08,186.08')
    expect(mixValue(0.2, 0.6, 0.25)).toBeCloseTo(0.3)
  })

  it('never blends a shape: the nearer end’s', () => {
    expect(mixValue('pyramid', 'mesa', 0.4)).toBe('pyramid')
    expect(mixValue('pyramid', 'mesa', 0.6)).toBe('mesa')
  })

  it('fades what only one end has — F1’s moon disc and rays, F5’s moons — and leaves it out at the far end', () => {
    const mid = blendLook(DAY.look, NIGHT.look, 0.25).bg!
    expect(mid.sun?.vis).toBeCloseTo(0.25)
    expect(mid.rays?.[2]).toBeCloseTo(F1.look.bg!.rays![2] * 0.25)
    expect(mid.moons?.map((m) => m.vis)).toEqual([0.75, 0.75, 0.75])
    // …and it fades out continuously: nearly gone one step before it is dropped.
    expect(blendLook(DAY.look, NIGHT.look, 0.99).bg!.moons?.[0]?.vis).toBeCloseTo(0.01)
    expect(blendLook(DAY.look, NIGHT.look, 0.01).bg!.sun?.vis).toBeCloseTo(0.01)
    expect(blendLook(DAY.look, NIGHT.look, 0).bg!.sun).toBeUndefined()
    expect(blendLook(DAY.look, NIGHT.look, 1).bg!.moons).toBeUndefined()
  })

  it('t is darkness over NIGHT_DARKNESS, clamped', () => {
    // T23.19G F8: the constant, not its value typed in.
    expect(ND).toBeGreaterThan(0)
    expect(nightShare(0, ND)).toBe(0)
    expect(nightShare(ND / 2, ND)).toBeCloseTo(0.5)
    expect(nightShare(ND * 1.1, ND)).toBe(1)
  })

  /**
   * T23.19G F9: the continuity test above compares a field only where it exists on both sides of a step, so a field
   * that snaps — null against an object, arrays of unequal length, a shape string — is compared nowhere, and a pop at
   * mid-dusk would pass it. Here every path whose presence or type changes between adjacent steps, or whose non-colour
   * string changes, is collected, and the list must be exactly the fades the blend means: what one end alone has
   * (`daylight.ts::FADED`, the rays with the disc), appearing or leaving at the ends (the first and last step) only.
   */
  it('snaps nothing but the one-ended fades, and those only at the ends', () => {
    const STEPS = 100
    const ALLOWED = ['bg.moons', 'bg.rayColor', 'bg.rays', 'bg.sun']
    const COLOUR = /^(\s*[\d.]+\s*,|#|rgba\()/i
    const kind = (v: unknown): string => (v === null ? 'null' : typeof v)
    for (const [what, at] of [
      ['look', (t: number) => blendLook(DAY.look, NIGHT.look, t)],
      ['palette', (t: number) => blendPalette(DAY.palette, NIGHT.palette, t)],
    ] as const) {
      const s = Array.from({ length: STEPS + 1 }, (_, i) => leaves(at(i / STEPS)))
      const snapped = new Set<string>()
      const mid: string[] = []
      for (let i = 1; i <= STEPS; i++) {
        const a = s[i - 1]!
        const b = s[i]!
        for (const k of new Set([...a.keys(), ...b.keys()])) {
          const va = a.get(k)
          const vb = b.get(k)
          const snap =
            a.has(k) !== b.has(k) ||
            kind(va) !== kind(vb) ||
            (typeof va === 'string' && va !== vb && !COLOUR.test(va))
          if (!snap) continue
          const top = k.split('.').slice(0, 2).join('.')
          snapped.add(top)
          if (i !== 1 && i !== STEPS) mid.push(`${k} between t ${(i - 1) / STEPS} and ${i / STEPS}`)
        }
      }
      expect(mid, `${what}: fields that snap mid-blend`).toEqual([])
      expect([...snapped].sort(), `${what}: the fields that appear or leave`).toEqual(ALLOWED)
    }
  })
})

describe('T23.11: the moons move with the cycle', () => {
  const day = gameSky(4242, F5.look.bg as Background)
  const night = gameSky(4242, F1.look.bg as Background)

  it('each moon is at its picture’s place at its picture’s moment, and moves away from it', () => {
    const atNoon = moonArcs(day, DAY_MOON_U)
    expect(atNoon.moons!.map((m) => [m.x, m.y])).toEqual(day.moons!.map((m) => [m.x, m.y]))
    const atMidnight = moonArcs(night, NIGHT_MOON_U)
    expect([atMidnight.sun!.x, atMidnight.sun!.y]).toEqual([night.sun!.x, night.sun!.y])
    expect([atMidnight.rays![0], atMidnight.rays![1]]).toEqual([night.rays![0], night.rays![1]])
    const later = moonArcs(day, DAY_MOON_U + 0.1)
    for (let i = 0; i < 3; i++) expect(later.moons![i]!.x).toBeGreaterThan(day.moons![i]!.x)
    // The look-lab (`u` null): the pictures' places.
    expect(moonArcs(day, null)).toBe(day)
  })

  /**
   * T23.19G F7: the sky bakes each moon set `MOON_REACH` past the frame (`SkyQuad.reach`). Wherever the darkness curve
   * leaves a set any weight, that set must be within the reach of its place, or a moon is clipped at the bake's edge.
   * The sweep reads the curve (`darknessAt`) and the blend's own visibility, not a hand-picked range of `u`.
   */
  it('stays within the baked reach wherever the darkness curve shows it', () => {
    let seen = { day: 0, night: 0 }
    const far = { day: 0, night: 0 }
    for (let i = 0; i < 1000; i++) {
      const u = i / 1000
      const bg = blendLook(DAY.look, NIGHT.look, nightShare(darknessAt(u, ND), ND)).bg!
      const sets = [
        ['day', bg.moons?.length ? bg.moons[0]!.vis ?? 1 : 0, DAY_MOON_U],
        ['night', bg.sun ? bg.sun.vis ?? 1 : 0, NIGHT_MOON_U],
      ] as const
      for (const [name, vis, ref] of sets) {
        if (!(vis > 0)) continue
        seen = { ...seen, [name]: seen[name] + 1 }
        const [dx, dy] = arcOffset(u, ref)
        far[name] = Math.max(far[name], Math.abs(dx))
        expect(Math.abs(dx), `${name} set at u ${u}: ${dx.toFixed(0)} px from its place`).toBeLessThanOrEqual(MOON_REACH[0] + 1e-6)
        expect(dy, `${name} set at u ${u}: ${dy.toFixed(0)} px below its place`).toBeLessThanOrEqual(MOON_REACH[1] + 1e-6)
      }
    }
    // Not vacuous: both sets show for most of the cycle, and one of them reaches the edge of the reach.
    expect(seen.day).toBeGreaterThan(500)
    expect(seen.night).toBeGreaterThan(400)
    expect(Math.max(far.day, far.night)).toBeGreaterThan(MOON_REACH[0] * 0.99)
  })

  it('jumps back only where its end is invisible (half a cycle from its moment)', () => {
    const dx = (u: number, ref: number): number => arcOffset(u, ref)[0]
    // Continuous through the whole day for the day moons (u 0 → 0.5)…
    for (let u = 0; u < 0.5; u += 0.001) expect(Math.abs(dx(u + 0.001, DAY_MOON_U) - dx(u, DAY_MOON_U))).toBeLessThan(MOON_TRAVEL * 0.002)
    // …and through dusk, night and dawn for the night moon (u 0.5 → 1).
    for (let u = 0.5; u < 0.999; u += 0.001) expect(Math.abs(dx(u + 0.001, NIGHT_MOON_U) - dx(u, NIGHT_MOON_U))).toBeLessThan(MOON_TRAVEL * 0.002)
    // The wrap exists (a control that the tests above could fail): at u 0.75 for the day moons.
    expect(Math.abs(dx(0.7505, DAY_MOON_U) - dx(0.7495, DAY_MOON_U))).toBeGreaterThan(MOON_TRAVEL * 0.9)
  })

  it('the two ends lay out the same bands (a shape never blends, so they must agree)', () => {
    expect(day.layers.map(({ color: _c, fade: _f, ...shape }) => shape)).toEqual(night.layers.map(({ color: _c, fade: _f, ...shape }) => shape))
  })
})

describe('T23.19G F5: space keeps F1 at every hour', () => {
  const map = (space: boolean) => ({ w: 4000, h: 2000, seed: 7, space })
  it('a space map has nothing to blend, so its look stays F1\'s grade and bloom; a ground map at t = 0 is F5\'s (the control)', async () => {
    const { gameDescription } = await import('./worldRenderer')
    const space = gameDescription(map(true))
    expect(space.daylight).toBeUndefined()
    expect(space.look.grade).toEqual(F1.look.grade)
    expect(space.look.bloom).toEqual(F1.look.bloom)
    expect(space.palette).toEqual(F1.palette)
    const ground = gameDescription(map(false))
    const d = ground.daylight
    expect(d).toBeDefined()
    if (!d) return
    const day = blendLook(d.day, d.night, 0)
    expect(day.grade).toEqual(F5.look.grade)
    expect(day.bloom).toEqual(F5.look.bloom)
    expect(blendPalette(d.dayPalette, d.nightPalette, 0)).toEqual(F5.palette)
    expect(F5.look.grade).not.toEqual(F1.look.grade)
  })
})
