/**
 * T23.01: the look-lab's hand-over — the description built from a ported scene, and what a
 * renderer receives of it, counted at both ends.
 */
import { describe, expect, it } from 'vitest'
import { actorBoxes, decodeMask, describeScene } from './scene'
import { SCENES } from './scenes'
import { StubRenderer, sceneCounts } from './renderer'

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
        expect(x0 <= a.x && a.x <= x1 && y0 <= a.y && a.y <= y1, `${id} ${a.kind} at ${a.x},${a.y} box ${a.box}`).toBe(true)
        expect(x1 > x0 && y1 > y0).toBe(true)
      }
    })
  }
})
