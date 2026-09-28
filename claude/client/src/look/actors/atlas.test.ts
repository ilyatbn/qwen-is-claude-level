import { describe, expect, it } from 'vitest'
import type { Actor } from '../scene'
import { F4 } from '../scenes/F4'
import { ATLAS_SIZE, ActorAtlas, BASE_CELL, EVICT_FRAMES, type Painter } from './atlas'
import { CELL_ALIGN, actorRect, cellKey, hasExtras, type Lighting } from './cell'
import type { G } from './draw'
import { dominant, passes } from './lit'

/** A 2D context that records nothing and answers everything (vitest runs in node: no canvas). */
function fakeContext(): G {
  const grad = { addColorStop: (): void => undefined }
  return new Proxy({} as G, {
    get: (_t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient' ? () => grad : () => undefined),
    set: () => true,
  })
}

/** A painter that counts what it is asked to draw and upload. */
function countingPainter(): Painter & { begun: number; uploads: [number, number][] } {
  const g = fakeContext()
  const p = {
    begun: 0,
    uploads: [] as [number, number][],
    begin: (): G => {
      p.begun++
      return g
    },
    upload: (x: number, y: number): void => void p.uploads.push([x, y]),
  }
  return p
}

const standing: Actor = { kind: 'stick', x: 100.25, y: 200, opts: { s: 1.15, aim: 0.3, weapon: 'bazooka', accent: '#e8482c' }, lit: { size: 1, halo: null, shadow: true }, box: null }
const offs = (dx: number, a = 0.8): Lighting => ({ offs: [[-dx, 0], [dx, 0], [dx * 1.7, 0]], rgb: '185,195,245', a, fill: '90,80,110', rim: true })

describe('the actor atlas (T23.12)', () => {
  it('redraws a standing figure once over 100 frames under one light', () => {
    const p = countingPainter()
    const atlas = new ActorAtlas(p)
    for (let f = 0; f < 100; f++) {
      atlas.beginFrame()
      expect(atlas.cellFor(standing, offs(1, 0.5 + f / 200))).not.toBeNull()
    }
    // The light brightened every frame: still one drawing — its colour and alpha are the shader's.
    expect(atlas.stats.redraws).toBe(1)
    expect(p.begun).toBe(1)
    expect(p.uploads).toHaveLength(1)
  })

  it('redraws when the drawing changes — aim, the key light turning — and not where it stands, nor below the 1/8 px key', () => {
    const atlas = new ActorAtlas(countingPainter())
    atlas.beginFrame()
    atlas.cellFor(standing, offs(1))
    atlas.cellFor({ ...standing, opts: { ...standing.opts, aim: 0.31 } }, offs(1))
    expect(atlas.stats.redraws).toBe(2)
    // T23.14D F13: the same drawing anywhere — a cell grain, a quarter px, one px, far off — is the same cell (the quad
    // moves; `cell.ts::atAnchor`). It was a new cell per 1/8 px: a moving figure redrew every frame.
    atlas.cellFor({ ...standing, x: standing.x + CELL_ALIGN }, offs(1))
    atlas.cellFor({ ...standing, x: standing.x + 0.25 }, offs(1))
    atlas.cellFor({ ...standing, x: standing.x + 1 }, offs(1))
    atlas.cellFor({ ...standing, x: standing.x + 313.6, y: standing.y - 41.3 }, offs(1))
    expect(atlas.stats.redraws).toBe(2)
    // The look-lab's pixel phase (the control that the anchor is what did it): one whole px along is another cell, and
    // (T23.16) so is a sub-pixel step past the 1/8 px key — the lab draws the fraction, as the mockup's canvas does
    // (F6 stands its weapons at fractional x); a step under the key is not.
    atlas.cellFor(standing, offs(1), true)
    atlas.cellFor({ ...standing, x: standing.x + 0.05 }, offs(1), true)
    expect(atlas.stats.redraws).toBe(3)
    atlas.cellFor({ ...standing, x: standing.x + 0.25 }, offs(1), true)
    expect(atlas.stats.redraws).toBe(4)
    atlas.cellFor({ ...standing, x: standing.x + 1 }, offs(1), true)
    expect(atlas.stats.redraws).toBe(5)
    // The key light turned: the passes are drawn at new offsets.
    atlas.cellFor(standing, offs(2))
    expect(atlas.stats.redraws).toBe(6)
    atlas.cellFor(standing, offs(2.01))
    expect(atlas.stats.redraws).toBe(6)
  })

  it('an actor with extras is baked: it keys on the light\'s colour and alpha too, one without does not', () => {
    const jet: Actor = { ...standing, opts: { ...standing.opts, jet: true, pose: 'jet' } }
    expect(hasExtras(jet)).toBe(true)
    expect(hasExtras(standing)).toBe(false)
    expect(cellKey(jet, offs(1, 0.5))).not.toBe(cellKey(jet, offs(1, 0.9)))
    expect(cellKey(standing, offs(1, 0.5))).toBe(cellKey(standing, offs(1, 0.9)))
    expect(cellKey(jet, { ...offs(1), rim: false })).not.toBe(cellKey(jet, offs(1)))
    expect(cellKey(standing, { ...offs(1), rim: false })).toBe(cellKey(standing, offs(1)))
  })

  it('places cells on the 64-px grid, apart', () => {
    const p = countingPainter()
    const atlas = new ActorAtlas(p)
    atlas.beginFrame()
    const a = atlas.cellFor(standing)!
    const b = atlas.cellFor({ ...standing, opts: { ...standing.opts, aim: -1 } })!
    for (const c of [a, b]) {
      expect(c.x % BASE_CELL).toBe(0)
      expect(c.y % BASE_CELL).toBe(0)
      expect(c.x + c.gw * BASE_CELL).toBeLessThanOrEqual(ATLAS_SIZE)
    }
    const overlap = a.x < b.x + b.gw * BASE_CELL && b.x < a.x + a.gw * BASE_CELL && a.y < b.y + b.gh * BASE_CELL && b.y < a.y + a.gh * BASE_CELL
    expect(overlap).toBe(false)
  })

  it('frees cells unused for EVICT_FRAMES when room is needed; resets only when every cell is in use', () => {
    const aim = (n: number): Actor => ({ ...standing, opts: { ...standing.opts, aim: n / 1000 } })
    // How many of this figure fill the atlas: the first cell that needs a reset.
    const probe = new ActorAtlas(countingPainter())
    probe.beginFrame()
    let full = 0
    while (probe.stats.resets === 0) probe.cellFor(aim(full++), offs(1))
    full--
    expect(full).toBeGreaterThan(10)
    const run = (age: number): ActorAtlas => {
      const atlas = new ActorAtlas(countingPainter())
      atlas.beginFrame()
      for (let n = 0; n < full; n++) atlas.cellFor(aim(n), offs(1))
      expect(atlas.stats.resets).toBe(0)
      for (let f = 0; f < age; f++) atlas.beginFrame()
      atlas.cellFor(aim(-1), offs(1))
      return atlas
    }
    // Aged out: the new cell takes an old one's room, no reset.
    const aged = run(EVICT_FRAMES)
    expect(aged.stats.resets).toBe(0)
    expect(aged.stats.cells).toBe(1)
    // Control: one frame short of aged, nothing may be evicted — the atlas resets.
    expect(run(EVICT_FRAMES - 1).stats.resets).toBe(1)
  })

  it('a cell rect covers the measured box, on the dither grid', () => {
    for (const a of F4.actors) {
      const r = actorRect(a)
      const b = a.box!
      expect(r[0]).toBeLessThanOrEqual(b[0])
      expect(r[1]).toBeLessThanOrEqual(b[1])
      expect(r[2]).toBeGreaterThanOrEqual(b[2])
      expect(r[3]).toBeGreaterThanOrEqual(b[3])
      for (const v of r) expect(v % CELL_ALIGN).toBe(0)
    }
  })
})

describe("lit()'s numbers (f_kit.js)", () => {
  const moon = F4.look.moon
  it('dominant: the moon with no light in reach, the strongest light within it', () => {
    expect(dominant([], 0, 0, moon)).toEqual({ dx: moon.dx, dy: moon.dy, rgb: moon.rgb, w: moon.w })
    const near = { x: 10, y: 0, z: 0, r: 100, rgb: '1,2,3', i: 2 }
    const k = dominant([near], 0, 0, moon)
    expect(k.rgb).toBe('1,2,3')
    expect(k.dx).toBe(1)
    expect(k.w).toBeCloseTo(2 * 0.9 ** 2 * 1.6)
    // Out of reach: the moon again.
    expect(dominant([{ ...near, x: 101 }], 0, 0, moon).rgb).toBe(moon.rgb)
  })
  it('passes: offsets at 1.15·size toward the key, the fill at 0.7·size away from it', () => {
    const ps = passes([], moon, 0, 0, 3)
    expect(ps.off[0]).toBeCloseTo(moon.dx * 1.15 * 3)
    expect(ps.fillOff[1]).toBeCloseTo(-moon.dy * 0.7 * 3)
    expect(ps.a).toBeCloseTo(Math.min(1, 0.45 + moon.w * 0.5))
  })
})
