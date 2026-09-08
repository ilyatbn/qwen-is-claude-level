import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Core, C } from '../core'
import { padUnderfoot, type PadView } from './pads'

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
