/**
 * T23.01: the look-lab's hand-over — the description built from a ported scene, and what a
 * renderer receives of it, counted at both ends.
 */
import { WEAPONS } from './actors/weapons'
import { describe, expect, it } from 'vitest'
import { actorBoxes, decodeMask, describeScene } from './scene'
import { SCENES } from './scenes'
import { StubRenderer, sceneCounts, viewOf } from './renderer'

describe('describeScene', () => {
  for (const [id, data] of Object.entries(SCENES)) {
    it(`${id}: decodes the mask and passes everything else through`, () => {
      const d = describeScene(data)
      expect(d.id).toBe(id)
      expect(d.masks).not.toBeNull()
      const m = decodeMask(data.mask)
      // Buffer equality: `toEqual` walks 921 600 bytes element by element (1.6 s a scene).
      expect(Buffer.from(d.masks!.solid).equals(Buffer.from(m.solid))).toBe(true)
      expect(Buffer.from(d.masks!.back).equals(Buffer.from(m.back))).toBe(true)
      expect(d.actors).toBe(data.actors)
      expect(d.look).toBe(data.look)
      expect(d.camera).toEqual(data.camera)
      expect(d.world).toEqual({ w: data.mask.w, h: data.mask.h })
    })
  }
})

describe('StubRenderer', () => {
  it('records what it was handed and each frame it was asked for', () => {
    const r = new StubRenderer()
    expect(r.stats.scene).toBeNull()
    const d = describeScene(SCENES.F1!)
    r.setScene(d)
    expect(r.stats.scene).toEqual(sceneCounts(d))
    expect(r.stats.scene!.actors).toBe(SCENES.F1!.actors.length)
    expect(r.stats.scene!.lights).toBe(SCENES.F1!.look.lights.length)
    expect(r.stats.scene!.solidPx).toBe(d.masks!.solid.reduce((a, b) => a + b, 0))
    expect(r.stats.frames).toBe(0)
    r.render({ x: 1, y: 2, w: 3, h: 4 })
    r.render({ x: 5, y: 6, w: 7, h: 8 })
    expect(r.stats.frames).toBe(2)
    expect(r.stats.view).toEqual({ x: 5, y: 6, w: 7, h: 8 })
  })

  it('reports a null rock count for a scene with no mask (the game, before T23.07)', () => {
    const d = { ...describeScene(SCENES.F1!), masks: null }
    expect(sceneCounts(d).solidPx).toBeNull()
  })
})

describe('actor boxes (T23.02)', () => {
  for (const [id, data] of Object.entries(SCENES)) {
    it(`${id}: one measured box per actor, each holding its actor's anchor`, () => {
      expect(actorBoxes(describeScene(data)).length).toBe(data.actors.length)
      for (const a of data.actors) {
        const [x0, y0, x1, y1] = a.box!
        // The anchor is where the mockup drew from: feet, body centre, the smoke's first puff.
        // T23.14: F7's figures stand on their feet line, and an airborne pose (jump, fall) tucks its feet above it —
        // the anchor is then under the box, by less than a leg (TH + SH = 13.8 figure units at F7's 3.45).
        const below = a.kind === 'figure' ? 13.8 * 3.45 : 0
        // T23.16: a weapon alone is drawn from its shoulder frame's origin, which a one-handed or thrown weapon's
        // drawing does not reach (the grenade sits 8–13 units out): the point checked is the visual centre `cx`
        // along from the origin, at its muzzle's height (a thrown weapon is held above the hand line).
        const W = a.kind === 'weapon' ? WEAPONS[a.opts.key ?? ''] : undefined
        const [ox, oy] = [a.x + (a.opts.origin?.[0] ?? 0), a.y + (a.opts.origin?.[1] ?? 0)]
        const ax = W ? ox + W.cx * (a.opts.s ?? 1) : a.x
        const ay = W ? oy + W.muzzle[1] * (a.opts.s ?? 1) : a.y
        expect(x0 <= ax && ax <= x1 && y0 <= ay && ay <= y1 + below, `${id} ${a.kind} at ${ax},${ay} box ${a.box}`).toBe(true)
        expect(x1 > x0 && y1 > y0).toBe(true)
      }
    })
  }
})

/**
 * Phaser 3.90 `Camera.preRender`'s scroll, midPoint and worldView, copied (`cameras/2d/Camera.js`;
 * the camera cannot be constructed in node — its module graph reads `window` at load). Follow,
 * deadzone and bounds are left out: they only move `scrollX/Y` before this runs.
 */
function preRender(c: { width: number; height: number; zoom: number; scrollX: number; scrollY: number; roundPixels: boolean }) {
  let sx = c.scrollX
  let sy = c.scrollY
  if (c.roundPixels) {
    sx = Math.floor(sx)
    sy = Math.floor(sy)
  }
  const midPoint = { x: sx + c.width * 0.5, y: sy + c.height * 0.5 }
  const dw = Math.floor(c.width / c.zoom + 0.5)
  const dh = Math.floor(c.height / c.zoom + 0.5)
  const worldView = { x: Math.floor(midPoint.x - dw / 2 + 0.5), y: Math.floor(midPoint.y - dh / 2 + 0.5), w: dw, h: dh }
  return { cam: { width: c.width, height: c.height, zoomX: c.zoom, zoomY: c.zoom, midPoint }, worldView }
}

describe('viewOf (T23.03B F6): the view from scroll, zoom and midPoint, unrounded', () => {
  it("equals Phaser's worldView today — roundPixels on, integer zoom — so today's pixels do not move", () => {
    for (const zoom of [1, 2]) {
      for (const [x, y] of [[0, 0], [100.6, 50.2], [2431.99, 1175.5], [-3.3, 7.7]] as const) {
        const { cam, worldView } = preRender({ width: 1280, height: 720, zoom, scrollX: x, scrollY: y, roundPixels: true })
        expect(viewOf(cam), `zoom ${zoom} at ${x},${y}`).toEqual(worldView)
      }
    }
  })
  it("follows the sub-pixel scroll and a fractional zoom where worldView rounds (the jitter R15 would expose)", () => {
    const { cam, worldView } = preRender({ width: 1280, height: 720, zoom: 2, scrollX: 100.6, scrollY: 50.2, roundPixels: false })
    const v = viewOf(cam)
    expect(v).toEqual({ x: 420.6, y: 230.2, w: 640, h: 360 })
    expect(worldView.x).toBe(421)
    const z = preRender({ width: 1280, height: 720, zoom: 1.7, scrollX: 0, scrollY: 0, roundPixels: false })
    expect(viewOf(z.cam).w).toBeCloseTo(1280 / 1.7, 9)
    expect(z.worldView.w).toBe(753)
  })
})
