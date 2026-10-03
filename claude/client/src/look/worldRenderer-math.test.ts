/**
 * T23.03: the world renderer's arithmetic — the y flip into the mockup's space, the buffer, the
 * tiers, and the CPU copy of the output transform `world-canvas` compares the screen against.
 */
import { describe, expect, it } from 'vitest'
import { TIER_SAMPLES, TIER_SCALE, bufferFor, mustDraw, orthoFromView, sameView, toWorld, nightUniforms, NIGHT_VIEW_KEEP, hourFromUrl, sightLights, seeingLights, seenAt, NIGHT_CIRCLES } from './worldRenderer-math'

describe('orthoFromView', () => {
  it('is the mockup camera for the mockup view (kit.js::orthoCam: 0, W, H, 0)', () => {
    expect(orthoFromView({ x: 0, y: 0, w: 1280, h: 720 }, 720)).toEqual({ left: 0, right: 1280, top: 720, bottom: 0 })
  })
  it('flips y: a view lower on the map (larger mask y) is lower in world space', () => {
    const a = orthoFromView({ x: 100, y: 200, w: 640, h: 360 }, 1000)
    expect(a).toEqual({ left: 100, right: 740, top: 800, bottom: 440 })
    const b = orthoFromView({ x: 100, y: 300, w: 640, h: 360 }, 1000)
    expect(b.top).toBe(a.top - 100)
  })
  it('puts a mask point inside the view inside the ortho bounds, at the same fraction', () => {
    const v = { x: 37, y: 91, w: 640, h: 360 }
    const o = orthoFromView(v, 900)
    const p = toWorld(v.x + 160, v.y + 90, 900)
    expect((p.x - o.left) / (o.right - o.left)).toBeCloseTo(0.25)
    expect((o.top - p.y) / (o.top - o.bottom)).toBeCloseTo(0.25) // a quarter down the screen
  })
})

describe('tiers and buffers', () => {
  it('low halves the target and drops MSAA; full is the pictures (kit.js::post)', () => {
    expect(TIER_SCALE.full).toBe(1)
    expect(TIER_SCALE.low).toBe(0.5)
    expect(TIER_SAMPLES.full).toBe(4)
    expect(TIER_SAMPLES.low).toBe(0)
  })
  it("R18: the buffer is Phaser's game resolution times the tier, whatever the window or the screen", () => {
    // No CSS size and no devicePixelRatio in the signature: a 4K screen gets the same buffer
    // as a 720p one, which is what the pictures were drawn at (setPixelRatio(1), 1280×720).
    expect(bufferFor(1280, 720, 'full')).toEqual({ w: 1280, h: 720 })
    expect(bufferFor(1280, 720, 'low')).toEqual({ w: 640, h: 360 })
    expect(bufferFor(0, 0, 'full')).toEqual({ w: 1, h: 1 })
    // The pixel ratio R18 states, for a canvas shown 1100 CSS px wide: 1280/1100 × scale.
    // Floored the way three's setSize floors it, that ratio can lose a pixel; the buffer cannot.
    const ratio = (1280 / 1100) * TIER_SCALE.full
    expect(Math.round(1100 * ratio)).toBe(bufferFor(1280, 720, 'full').w)
  })
})

describe('the redraw skip (T23.03B F1, F3)', () => {
  const v = { x: 10, y: 20, w: 640, h: 360 }
  it('sameView compares every field — each one alone makes a different view', () => {
    expect(sameView(v, { ...v })).toBe(true)
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(sameView(v, { ...v, [k]: v[k] + 1 }), k).toBe(false)
    expect(sameView(null, v)).toBe(false)
    expect(sameView(v, null)).toBe(false)
  })
  it('skips only an unchanged view of a clean, unanimated scene', () => {
    expect(mustDraw({ dirty: false, animated: false, last: v, view: { ...v } })).toBe(false)
    expect(mustDraw({ dirty: true, animated: false, last: v, view: { ...v } })).toBe(true)
    expect(mustDraw({ dirty: false, animated: false, last: v, view: { ...v, y: v.y + 1 } })).toBe(true)
    expect(mustDraw({ dirty: false, animated: false, last: null, view: v })).toBe(true)
  })
  it('an animated layer draws every frame, even with the view and scene unchanged (F3)', () => {
    expect(mustDraw({ dirty: false, animated: true, last: v, view: { ...v } })).toBe(true)
  })
})

describe('caveWallFromUrl (T23.09A)', () => {
  it('is off by default in the game, on with ?cavewall=1, off with ?cavewall=0', async () => {
    const { caveWallFromUrl, CAVE_WALL_DEFAULT } = await import('./worldRenderer-math')
    expect(CAVE_WALL_DEFAULT).toBe(false)
    expect(caveWallFromUrl('?sandbox=1&seed=4')).toBe(false)
    expect(caveWallFromUrl('?sandbox=1&cavewall=1')).toBe(true)
    expect(caveWallFromUrl('?cavewall=0')).toBe(false)
  })
})

describe('nightUniforms (T23.10, R7)', () => {
  const view = { x: 100, y: 50, w: 1280, h: 720 }
  const buf = { w: 640, h: 360 }
  it('none by day or with no night; at full night keeps NIGHT_VIEW_KEEP of the light outside sight', () => {
    expect(nightUniforms(null, view, buf)).toBeNull()
    expect(nightUniforms({ darkness: 0, nightDarkness: 0.82, soft: 0.35, circles: [] }, view, buf)).toBeNull()
    const u = nightUniforms({ darkness: 0.82, nightDarkness: 0.82, soft: 0.35, circles: [] }, view, buf)
    expect(u?.k).toBeCloseTo(1 - NIGHT_VIEW_KEEP)
    const half = nightUniforms({ darkness: 0.41, nightDarkness: 0.82, soft: 0.35, circles: [] }, view, buf)
    expect(half?.k).toBeCloseTo((1 - NIGHT_VIEW_KEEP) / 2)
  })

  it("a circle lands in buffer px, bottom up, its fade from (1 − soft)·r to r", () => {
    const u = nightUniforms({ darkness: 0.82, nightDarkness: 0.82, soft: 0.35, circles: [{ x: 100 + 640, y: 50 + 180, r: 220 }] }, view, buf)!
    const c = u.circles[0]!
    expect(c.x).toBeCloseTo(320)
    expect(c.y).toBeCloseTo(360 - 90)
    expect(c.outer).toBeCloseTo(110)
    expect(c.inner).toBeCloseTo(110 * 0.65)
  })
})

describe('nightUniforms lit by effect lights (T23.10, R7; T23.10B F1)', () => {
  it("after the sight circles, the scene's lit circles, each fading over its whole radius", () => {
    const v = { darkness: 0.82, nightDarkness: 0.82, soft: 0.35, circles: [{ x: 0, y: 0, r: 220 }], lit: [{ x: 10, y: 10, r: 150 }, { x: 10, y: 10, r: 60 }] }
    const u = nightUniforms(v, { x: 0, y: 0, w: 100, h: 100 }, { w: 100, h: 100 }, NIGHT_CIRCLES)!
    expect(u.circles.length).toBe(3)
    expect(u.circles[1]!.outer).toBeCloseTo(150)
    expect(u.circles[1]!.inner).toBe(0)
    expect(u.circles[2]!.outer).toBeCloseTo(60)
    // Control: with no lit circles, the sight alone — this pass no longer picks lights of its own.
    expect(nightUniforms({ ...v, lit: [] }, { x: 0, y: 0, w: 100, h: 100 }, { w: 100, h: 100 }, NIGHT_CIRCLES)!.circles.length).toBe(1)
  })
})

describe('sightLights and seenAt (T23.10B F1/F2: the seeing rule, one list)', () => {
  const view = { x: 0, y: 0, w: 1000, h: 1000 }
  const L = (x: number, i: number, r: number, extra: object = {}) => ({ x, y: 500, z: 0, r, rgb: '255,0,0', i, ...extra })

  it("keeps lit lights in view, leaves out a body's own jet, the dark ones and the ones off view", () => {
    const got = sightLights([L(100, 1, 50), L(300, 1, 50, { body: true }), L(500, 0, 50), L(-500, 1, 50)], view, NIGHT_CIRCLES)
    expect(got).toEqual([{ x: 100, y: 500, r: 50 }])
  })

  it('ranks by pickLights when they do not fit: combat before the map’s standing lights (F2)', () => {
    // A gate (fixed) brighter and wider than the blast: by raw intensity it would win the one slot.
    const gate = L(100, 3, 150, { fixed: true })
    const blast = L(700, 1, 40)
    expect(sightLights([gate, blast], view, 1)).toEqual([{ x: 700, y: 500, r: 40 }])
    // Control: with room for both, both.
    expect(sightLights([gate, blast], view, 2)).toHaveLength(2)
    expect(sightLights([gate, blast], view, 0)).toEqual([])
  })

  it('T23.25B F2: a player in a gate’s light is seen with more combat lights on screen than the night view has slots', () => {
    // NIGHT_CIRCLES combat lights in view (one more than the night view's light slots), none near the gate.
    const blasts = Array.from({ length: NIGHT_CIRCLES }, (_, k) => ({ ...L(600 + k * 40, 1, 30), y: 100 }))
    const gate = L(100, 1, 80, { fixed: true })
    const at = { x: 100, y: 500 } // the remote, standing in the gate's light
    expect(seenAt(seeingLights([gate, ...blasts], view), at.x, at.y)).toBe(true)
    // The night view's capped list is the combat lights alone (the gate lost its slot) — drawn, not judged.
    expect(seenAt(sightLights([gate, ...blasts], view, NIGHT_CIRCLES - 1), at.x, at.y)).toBe(false)
    // Control: the same fight without the gate — nothing lights him.
    expect(seenAt(seeingLights(blasts, view), at.x, at.y)).toBe(false)
    // Every revealing light, not a body's own jet nor one off view.
    expect(seeingLights([gate, L(300, 1, 50, { body: true }), L(-500, 1, 50), ...blasts], view)).toHaveLength(1 + blasts.length)
  })

  it('seenAt is inside any circle, the edge included', () => {
    const circles = [{ x: 0, y: 0, r: 100 }, { x: 500, y: 0, r: 50 }]
    expect(seenAt(circles, 100, 0)).toBe(true)
    expect(seenAt(circles, 540, 0)).toBe(true)
    expect(seenAt(circles, 300, 0)).toBe(false)
    expect(seenAt([], 0, 0)).toBe(false)
  })
})

describe('T23.11: hourFromUrl (dev &hour=)', () => {
  it('pins t (and u when given), refuses anything else', () => {
    expect(hourFromUrl('?sandbox=1&hour=1')).toEqual({ t: 1, u: null })
    expect(hourFromUrl('?hour=0.5,0.76')).toEqual({ t: 0.5, u: 0.76 })
    expect(hourFromUrl('?sandbox=1')).toBeNull()
    expect(hourFromUrl('?hour=2')).toBeNull()
    expect(hourFromUrl('?hour=night')).toBeNull()
  })
})
