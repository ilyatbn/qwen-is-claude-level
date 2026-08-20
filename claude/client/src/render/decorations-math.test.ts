import { describe, expect, it } from 'vitest'
import {
  decodeFlags,
  destroyedBy,
  frameFor,
  fromMeta,
  place,
  FLIP_BIT,
  SCALE_TIERS,
  type WireDecoration,
} from './decorations-math'

/** Every frame exists, so `place` is testing the ground rule and nothing else. */
const allFrames = () => true
/** Ground everywhere below y=500. */
const groundBelow500 = (_x: number, y: number) => y >= 500

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
  it('places a decoration standing on solid ground', () => {
    const out = place([deco()], allFrames, groundBelow500)
    expect(out).toHaveLength(1)
    expect(out[0]?.frame).toBe('decor_0')
    expect(out[0]?.x).toBe(100)
  })

  it('skips a kind this theme has no art for, silently', () => {
    const only3 = (f: string) => f === 'decor_3'
    const out = place([deco({ kind: 0 }), deco({ kind: 3 })], only3, groundBelow500)
    expect(out.map((d) => d.kind)).toEqual([3])
  })

  it('does not place one whose anchor is already air', () => {
    // A mid-round joiner receives a map that has been under fire for minutes;
    // some generated anchors no longer have ground under them.
    const out = place([deco({ y: 100 })], allFrames, groundBelow500)
    expect(out).toHaveLength(0)
  })

  it('accepts a prop on a slope, where the pixel under its centre is air', () => {
    // The regression that cost this feature 25 of 35 props on seed 4242, and the
    // one map/gen/surface.rs already documents: support is tested across the
    // footprint because a body on a slope rests on the highest ground beneath
    // it, and the centre column is often air.
    const slope = (x: number, y: number) => y >= 500 && x >= 101
    const out = place([deco({ x: 100, y: 499 })], allFrames, slope)
    expect(out).toHaveLength(1)
  })

  it('still rejects a prop with nothing under its footprint at all', () => {
    // The control: if support were assumed rather than tested, the case above
    // would pass for the wrong reason and props would float over craters.
    const farAway = (x: number, _y: number) => x > 1000
    expect(place([deco({ x: 100, y: 499 })], allFrames, farAway)).toHaveLength(0)
  })

  it('tests below the anchor, not the anchor itself', () => {
    // Surface points are air-above-solid: testing the anchor pixel finds air and
    // would place nothing at all, which looks exactly like "the feature is off".
    const surfaceOnly = (_x: number, y: number) => y === 500
    const out = place([deco({ y: 499 })], allFrames, surfaceOnly)
    expect(out).toHaveLength(1)
  })

  it('carries flip and scale through to the placement', () => {
    const out = place([deco({ flags: FLIP_BIT | (2 << 1) })], allFrames, groundBelow500)
    expect(out[0]?.flip).toBe(true)
    expect(out[0]?.scale).toBe(SCALE_TIERS[2])
  })

  it('handles an empty list', () => {
    expect(place([], allFrames, groundBelow500)).toEqual([])
  })
})

describe('destroyedBy', () => {
  const placed = place(
    [deco({ x: 100 }), deco({ x: 200 }), deco({ x: 300 })],
    allFrames,
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
