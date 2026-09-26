/**
 * T23.03: the world renderer's arithmetic — the y flip into the mockup's space, the buffer, the
 * tiers, and the CPU copy of the output transform `world-canvas` compares the screen against.
 */
import { describe, expect, it } from 'vitest'
import { SCENES } from './scenes'
import { TIER_SAMPLES, TIER_SCALE, acesSrgb, bufferFor, hexLinear, mustDraw, orthoFromView, sameView, toWorld } from './worldRenderer-math'

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

describe('the output transform (OutputPass: ACES then sRGB)', () => {
  it('reads 0xRRGGBB as linear, as e_style.js::hex does', () => {
    expect(hexLinear(0xff0080)).toEqual([1, 0, 128 / 255])
  })
  it('maps black to black and saturates bright input', () => {
    expect(acesSrgb([0, 0, 0], 1.1)).toEqual([0, 0, 0])
    const w = acesSrgb([100, 100, 100], 1.1)
    for (const c of w) expect(c).toBeGreaterThanOrEqual(254)
  })
  it('is monotone in exposure, so a dropped exposure is visible', () => {
    const sky = hexLinear(SCENES.F1!.look.bg.skyBottom)
    const at1 = acesSrgb(sky, 1)
    const at11 = acesSrgb(sky, SCENES.F1!.look.exposure)
    expect(SCENES.F1!.look.exposure).not.toBe(1)
    for (let i = 0; i < 3; i++) expect(at11[i]!).toBeGreaterThan(at1[i]!)
  })
  it('differs from the raw colour: without the OutputPass the screen would show the hex', () => {
    const h = SCENES.F1!.look.bg.skyBottom
    const raw = [(h >> 16) & 255, (h >> 8) & 255, h & 255]
    expect(acesSrgb(hexLinear(h), SCENES.F1!.look.exposure)).not.toEqual(raw)
  })
})
