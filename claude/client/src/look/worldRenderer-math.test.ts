/**
 * T23.03: the world renderer's arithmetic — the y flip into the mockup's space, the buffer, the
 * tiers, and the CPU copy of the output transform `world-canvas` compares the screen against.
 */
import { describe, expect, it } from 'vitest'
import { SCENES } from './scenes'
import { TIER_SAMPLES, TIER_SCALE, acesSrgb, bufferSize, hexLinear, orthoFromView, toWorld } from './worldRenderer-math'

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
  it('sizes the drawing buffer in device pixels, once', () => {
    expect(bufferSize(1280, 720, 1)).toEqual({ w: 1280, h: 720 })
    expect(bufferSize(1280, 720, 1.5)).toEqual({ w: 1920, h: 1080 })
    expect(bufferSize(0, 0, 2)).toEqual({ w: 1, h: 1 })
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
