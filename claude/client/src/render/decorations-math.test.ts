import { describe, expect, it } from 'vitest'
import {
  decodeFlags,
  destroyedBy,
  frameFor,
  fromMeta,
  place,
  supported,
  baseColumns,
  baseOriginY,
  opaqueBase,
  DECOR_GROUND_SLACK_PX,
  FLIP_BIT,
  SCALE_TIERS,
  type ArtBase,
  type WireDecoration,
} from './decorations-math'

/** Ground everywhere below y=500. */
const groundBelow500 = (_x: number, y: number) => y >= 500
/** A frame whose opaque base is its whole bottom row. */
const full18: ArtBase = { frameW: 18, frameH: 18, row: 17, left: 0, right: 18 }
const baseAll = () => full18

function deco(over: Partial<WireDecoration> = {}): WireDecoration {
  return { kind: 0, x: 100, y: 499, flags: 0, ...over }
}

describe('decodeFlags', () => {
  it('reads the flip bit', () => {
    expect(decodeFlags(0).flip).toBe(false)
    expect(decodeFlags(FLIP_BIT).flip).toBe(true)
  })

  it('reads each scale tier', () => {
    expect(decodeFlags(0 << 1).scale).toBe(SCALE_TIERS[0])
    expect(decodeFlags(1 << 1).scale).toBe(SCALE_TIERS[1])
    expect(decodeFlags(2 << 1).scale).toBe(SCALE_TIERS[2])
  })

  it('reads flip and tier from the same byte independently', () => {
    // The server packs `flip | (scale_tier << 1)`. Getting the shift wrong makes
    // every flipped prop also change size, which is subtle enough to ship.
    const both = decodeFlags(FLIP_BIT | (2 << 1))
    expect(both.flip).toBe(true)
    expect(both.scale).toBe(SCALE_TIERS[2])
  })

  it('clamps an out-of-range tier rather than returning undefined', () => {
    expect(decodeFlags(3 << 1).scale).toBe(SCALE_TIERS[2])
    expect(decodeFlags(255).scale).toBeGreaterThan(0)
  })
})

describe('fromMeta', () => {
  it('packs to the same byte the server sends, so both scenes decode alike', () => {
    const wire = fromMeta([{ kind: 7, pos: { x: 10, y: 20 }, flip: true, scale_tier: 2 }])
    expect(wire[0]).toEqual({ kind: 7, x: 10, y: 20, flags: FLIP_BIT | (2 << 1) })
    // Round-trip: the whole point of normalising is that the two paths agree.
    expect(decodeFlags(wire[0]!.flags)).toEqual({ flip: true, scale: SCALE_TIERS[2] })
  })
})

describe('place', () => {
  it('places a decoration standing on solid ground, anchored by its base row', () => {
    const out = place([deco()], baseAll, groundBelow500)
    expect(out).toHaveLength(1)
    expect(out[0]?.frame).toBe('decor_0')
    expect(out[0]?.x).toBe(100)
    expect(out[0]?.originY).toBe(1)
  })

  it('skips a kind this theme has no art for, silently', () => {
    const only3 = (f: string) => (f === 'decor_3' ? full18 : null)
    const out = place([deco({ kind: 0 }), deco({ kind: 3 })], only3, groundBelow500)
    expect(out.map((d) => d.kind)).toEqual([3])
  })

  it('does not place one whose anchor is already air', () => {
    // A mid-round joiner receives a map that has been under fire for minutes;
    // some generated anchors no longer have ground under them.
    expect(place([deco({ y: 100 })], baseAll, groundBelow500)).toHaveLength(0)
  })

  it('drops a prop whose drawn base is half over air — the T21.28 ruling', () => {
    // This used to be *accepted*: 3 solid pixels in a 16 px span was support, so
    // a prop on the lip of a drop was drawn with half its base in the air —
    // exactly the floating the owner reported.
    const ledge = (x: number, y: number) => y >= 500 && x >= 101
    expect(place([deco({ x: 100, y: 499 })], baseAll, ledge)).toHaveLength(0)
  })

  it('drops a prop over a gap and draws the same prop on flat ground (the control)', () => {
    // `deco()` is scale tier 0 (0.8x), so an 18 px base covers columns 92..107.
    // One 2 px notch under its right end, deeper than the slack.
    const notched = (x: number, y: number) => y >= 500 && !(x >= 104 && x <= 105 && y < 510)
    expect(place([deco({ x: 100, y: 499 })], baseAll, notched)).toHaveLength(0)
    expect(place([deco({ x: 100, y: 499 })], baseAll, groundBelow500)).toHaveLength(1)
  })

  it('still rejects a prop with nothing under its footprint at all', () => {
    const farAway = (x: number, _y: number) => x > 1000
    expect(place([deco({ x: 100, y: 499 })], baseAll, farAway)).toHaveLength(0)
  })

  it('tests below the anchor, not the anchor itself', () => {
    // Surface points are air-above-solid: testing the anchor pixel finds air and
    // would place nothing at all, which looks exactly like "the feature is off".
    const surfaceOnly = (_x: number, y: number) => y === 500
    expect(place([deco({ y: 499 })], baseAll, surfaceOnly)).toHaveLength(1)
  })

  it('carries flip and scale through to the placement', () => {
    const out = place([deco({ flags: FLIP_BIT | (2 << 1) })], baseAll, groundBelow500)
    expect(out[0]?.flip).toBe(true)
    expect(out[0]?.scale).toBe(SCALE_TIERS[2])
  })

  it('handles an empty list', () => {
    expect(place([], baseAll, groundBelow500)).toEqual([])
  })
})

describe('the drawn base (T21.28)', () => {
  it('allows rock up to DECOR_GROUND_SLACK_PX below the feet, and not one pixel more', () => {
    const cols = baseColumns(100, full18, 1, false)
    const lowered = (drop: number) => (x: number, y: number) => y >= 500 + (x >= 105 ? drop : 0)
    expect(supported(100, 499, cols, lowered(DECOR_GROUND_SLACK_PX))).toBe(true)
    expect(supported(100, 499, cols, lowered(DECOR_GROUND_SLACK_PX + 1))).toBe(false)
  })

  it('measures the drawn width, so a bigger scale tier needs more ground', () => {
    // Ground under columns 90..109: enough for 18 px at 1x, not at the 1.25x tier.
    const strip = (x: number, y: number) => y >= 500 && x >= 90 && x < 110
    expect(supported(100, 499, baseColumns(100, full18, 1, false), strip)).toBe(true)
    expect(supported(100, 499, baseColumns(100, full18, SCALE_TIERS[2], false), strip)).toBe(false)
  })

  it('uses the art, not the frame: an off-centre base mirrors with the flip', () => {
    // A base on frame columns 11..14 sits right of centre, and left of it flipped.
    const offCentre: ArtBase = { frameW: 18, frameH: 18, row: 13, left: 11, right: 15 }
    const rightOnly = (x: number, y: number) => y >= 500 && x >= 102 && x < 106
    expect(supported(100, 499, baseColumns(100, offCentre, 1, false), rightOnly)).toBe(true)
    expect(supported(100, 499, baseColumns(100, offCentre, 1, true), rightOnly)).toBe(false)
  })

  it('finds the lowest opaque row and its span, and stands that row on the feet line', () => {
    // Opaque on row 13, columns 11..14 — decor_3's shape.
    const alpha = (x: number, y: number) => (y === 13 && x >= 11 && x <= 14 ? 255 : y < 13 ? 255 : 0)
    const b = opaqueBase(alpha, 18, 18)
    expect(b).toEqual({ frameW: 18, frameH: 18, row: 13, left: 11, right: 15 })
    expect(baseOriginY(b!)).toBe(14 / 18)
    expect(opaqueBase(() => 0, 18, 18)).toBeNull()
  })
})

describe('destroyedBy', () => {
  const placed = place(
    [deco({ x: 100 }), deco({ x: 200 }), deco({ x: 300 })],
    baseAll,
    groundBelow500,
  )

  it('returns exactly the decorations inside the circle', () => {
    expect(destroyedBy(placed, 100, 499, 30)).toEqual([0])
    expect(destroyedBy(placed, 250, 499, 60)).toEqual([1, 2])
  })

  it('is inclusive at the radius and excludes one pixel beyond', () => {
    // The boundary is where a "close enough" implementation and a correct one
    // disagree, and it is the only place the test can tell them apart.
    expect(destroyedBy(placed, 130, 499, 30)).toEqual([0])
    expect(destroyedBy(placed, 131, 499, 30)).toEqual([])
  })

  it('measures true distance, not horizontal offset', () => {
    // Directly above by more than the radius: a dx-only check would destroy it.
    expect(destroyedBy(placed, 100, 399, 30)).toEqual([])
    expect(destroyedBy(placed, 100, 480, 30)).toEqual([0])
  })

  it('returns nothing for a carve that misses everything', () => {
    expect(destroyedBy(placed, 5000, 5000, 100)).toEqual([])
  })

  it('is empty for an empty layer', () => {
    expect(destroyedBy([], 100, 100, 50)).toEqual([])
  })
})

describe('frameFor', () => {
  it('names frames by kind, which is theme*6 + variant', () => {
    // grassland 0-5, desert 6-11, frost 12-17 (map/meta.rs).
    expect(frameFor(0)).toBe('decor_0')
    expect(frameFor(6)).toBe('decor_6')
    expect(frameFor(17)).toBe('decor_17')
  })
})
