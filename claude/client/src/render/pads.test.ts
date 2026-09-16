import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Core, C } from '../core'
import { GATE_KEY, PadLayer, padUnderfoot, type PadView } from './pads'

const here = dirname(fileURLToPath(import.meta.url))
const wasmBytes = readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm'))

/**
 * `padUnderfoot` is a second implementation of `TeleportPad::underfoot`.
 *
 * The duplication is deliberate and argued in `pads.ts` — it is cosmetic, it
 * decides which ring gets the charge arc and never whether a teleport happens.
 * But "share the guard, or share the function" has been paid for on this project
 * more than once, so the copy is pinned at its **edges**: an off-by-one in either
 * direction moves the boundary and one of these fails.
 *
 * Every bound comes from `C()`, never a literal, so a drifted constant cannot
 * leave this green (CLAUDE.md).
 */
describe('padUnderfoot', () => {
  let c: ReturnType<typeof C>

  beforeAll(async () => {
    await Core.init(wasmBytes)
    c = C()
  })

  /** One pad at a round position, so the arithmetic below is readable. */
  const pads = (): PadView[] => [{ id: 3, x: 500, y: 400 }]
  /** The body centre whose feet land exactly on the pad's surface line. */
  const centreFor = (footY: number) => footY - c.PLAYER_H / 2

  it('finds the pad when the feet are on the line and the body is centred', () => {
    expect(padUnderfoot(pads(), 500, centreFor(400))).toBe(3)
  })

  it('is inclusive at exactly half a pad width, and rejects a pixel past it', () => {
    const y = centreFor(400)
    expect(padUnderfoot(pads(), 500 + c.PAD_W / 2, y)).toBe(3)
    expect(padUnderfoot(pads(), 500 - c.PAD_W / 2, y)).toBe(3)
    expect(padUnderfoot(pads(), 500 + c.PAD_W / 2 + 1, y)).toBeNull()
    expect(padUnderfoot(pads(), 500 - c.PAD_W / 2 - 1, y)).toBeNull()
  })

  it('is inclusive at exactly the touch slack, and rejects a pixel past it', () => {
    expect(padUnderfoot(pads(), 500, centreFor(400 + c.PAD_TOUCH_SLACK))).toBe(3)
    expect(padUnderfoot(pads(), 500, centreFor(400 - c.PAD_TOUCH_SLACK))).toBe(3)
    expect(padUnderfoot(pads(), 500, centreFor(400 + c.PAD_TOUCH_SLACK + 1))).toBeNull()
    expect(padUnderfoot(pads(), 500, centreFor(400 - c.PAD_TOUCH_SLACK - 1))).toBeNull()
  })

  // The control: without it every assertion above is satisfied by a function
  // that always returns null for anything it is not handed exactly.
  it('returns null when there are no pads, and finds the right one of several', () => {
    expect(padUnderfoot([], 500, centreFor(400))).toBeNull()
    const many: PadView[] = [
      { id: 0, x: 100, y: 400 },
      { id: 1, x: 500, y: 400 },
      { id: 2, x: 900, y: 400 },
    ]
    expect(padUnderfoot(many, 500, centreFor(400))).toBe(1)
    expect(padUnderfoot(many, 900, centreFor(400))).toBe(2)
    expect(padUnderfoot(many, 700, centreFor(400))).toBeNull()
  })

  it('uses the feet, not the centre — the whole point of the rule', () => {
    // The body *centre* on the surface line means the feet are half a body below
    // it, which is not standing on the pad.
    expect(padUnderfoot(pads(), 500, 400)).toBeNull()
  })
})

/**
 * T21.12's gate, and the fallback underneath it.
 *
 * `docs/50` §8 is a hard rule on this project: **the game must boot with no art
 * at all.** A pad with no gate image still has to show the player where it is —
 * a pad you cannot see is a pad nobody stands on (§A39) — so the ring is not
 * dead code, it is the documented degraded path, and both halves are asserted.
 *
 * `vitest` runs in node, so the scene is a stand-in. What is worth testing here
 * is the bookkeeping; the picture is asserted where a picture has to be, on
 * sampled pixels in `scripts/checks/teleport.mjs`.
 */
describe('PadLayer and the gate (T21.12)', () => {
  function fakeScene(hasGate: boolean) {
    const obj = () => {
      const o: Record<string, unknown> = {
        visible: true,
        alpha: 1,
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        setOrigin: () => o,
        // T21.28: `pads.ts` sizes the gate to `PAD_ART_W`.
        setDisplaySize: (w: number, h: number) => {
          o.displayWidth = w
          o.displayHeight = h
          return o
        },
        setStrokeStyle: () => o,
        setPosition: (x: number, y: number) => {
          o.x = x
          o.y = y
          return o
        },
        setVisible: (v: boolean) => {
          o.visible = v
          return o
        },
        setAlpha: (a: number) => {
          o.alpha = a
          return o
        },
        setScale: () => o,
        setDepth: () => o,
        clear: () => o,
        destroy: () => undefined,
      }
      return o
    }
    const container = obj()
    // **What actually reached the scene.** `layer.count` is the entry map, and
    // a test that asserts only that passes against a layer that draws nothing
    // — measured: deleting the fallback ring from `container.add` left all nine
    // of these green until this was added.
    const drawn: Array<Record<string, unknown>> = []
    container.add = (o: unknown) => {
      for (const child of Array.isArray(o) ? o : [o]) {
        drawn.push(child as Record<string, unknown>)
      }
      return container
    }
    container.setVisible = (v: boolean) => {
      container.visible = v
      return container
    }
    return {
      drawn,
      scene: {
        add: {
          container: () => container,
          ellipse: (x: number, y: number) => {
            const o = obj()
            o.x = x
            o.y = y
            return o
          },
          graphics: () => obj(),
          image: (x: number, y: number) => {
            const o = obj()
            o.x = x
            o.y = y
            return o
          },
        },
        textures: {
          exists: (k: string) => hasGate && k === GATE_KEY,
          get: () => ({ getSourceImage: () => ({ width: 64, height: 71 }) }),
        },
      } as unknown as Phaser.Scene,
    }
  }

  const views = (n: number): PadView[] =>
    Array.from({ length: n }, (_, i) => ({ id: i, x: 200 + i * 300, y: 400 }))
  const portal = { cx: 0.5, cy: 0.375, rx: 0.28, ry: 0.26 }

  it('wears a gate when the art is loaded, and the ring stands down', () => {
    const { scene, drawn } = fakeScene(true)
    const layer = new PadLayer(scene)
    layer.build(views(3), portal)
    expect(layer.count).toBe(3)
    expect(layer.gatesDrawn).toBe(3)
    expect(layer.portalGeometry()).not.toBeNull()
    // The ring is the fallback and must stand down, or it draws a second pad
    // through the gate's base. Asserted on the objects, not on a flag.
    const hidden = drawn.filter((o) => o.visible === false).length
    expect(hidden, 'the fallback ring is still drawn under the gate').toBeGreaterThanOrEqual(6)
  })

  it('still draws a pad with no art at all — the documented fallback', () => {
    const { scene, drawn } = fakeScene(false)
    const layer = new PadLayer(scene)
    layer.build(views(2), null)
    expect(layer.count, 'a pad vanished when its art was missing').toBe(2)
    expect(layer.gatesDrawn).toBe(0)
    // No gate means no portal, so the charge arc is the indicator instead.
    expect(layer.portalGeometry()).toBeNull()
    // **Something visible actually reached the scene.** Without this the test
    // passes against a layer that books two entries and draws nothing, which is
    // precisely the §A39 bug the fallback exists to prevent.
    // **Three visible objects per pad, named rather than counted loosely.**
    // `>= 2` was exactly the count that survives deleting the ring and the glow
    // (two pads x one `arc` each), so the assertion could not detect the
    // mutation it was written for. An `arc` also draws nothing until `update`
    // runs on the pad you are standing on, so the ring and the glow are the
    // whole of what a bystander pad shows.
    expect(
      drawn.filter((o) => o.visible).length,
      'no art AND nothing drawn — the pad is invisible',
    ).toBe(6)
  })

  it('is idempotent — a resync does not stack two gates on one pad', () => {
    const { scene, drawn } = fakeScene(true)
    const layer = new PadLayer(scene)
    const v = views(2)
    layer.build(v, portal)
    const afterFirst = drawn.length
    layer.build(v, portal)
    expect(layer.count).toBe(2)
    expect(layer.gatesDrawn).toBe(2)
    // **Counted on the scene, not on the entry map.** `count` and `gatesDrawn`
    // both read `this.entries`, a Map keyed by pad id — its size can never
    // exceed the pad count however many objects were created. Deleting the
    // `if (existing) … continue` branch leaks a second gate, fill, ring and glow
    // per pad and both of those assertions stay green.
    expect(drawn.length, 'a second build stacked more objects on the pads').toBe(afterFirst)
  })

  it('puts the portal where the region says, not at the pad', () => {
    const { scene } = fakeScene(true)
    const layer = new PadLayer(scene)
    layer.build(views(1), portal)
    const g = layer.portalGeometry()!
    // Above the feet line by the sprite's own geometry: drawn `PAD_ART_W` wide, so
    // the fake 64x71 source is drawn 71 * PAD_ART_W / 64 tall (T21.40 moved the
    // width; this used the old drawn height, 71, as a literal).
    const drawnH = (71 * C().PAD_ART_W) / 64
    expect(g.dy).toBeCloseTo(-drawnH * (1 - portal.cy), 3)
    expect(g.dy).toBeLessThan(0)
  })
})
