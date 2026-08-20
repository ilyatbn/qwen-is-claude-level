import { beforeAll, describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../core'
import {
  BackdropMask,
  CLEAR,
  OPAQUE,
  chunkOrigin,
  edgeBits,
  solidIn,
  stencilBits,
  tileOffset,
  type MaskSource,
} from './chunkBake-math'

const EDGE_BAND_PX = 5

/**
 * The **shipped** threshold, not a literal (§A19). These tests previously pinned
 * an explicit 6 while production passed `C().BACKDROP_MIN_HITS`; at the shipped
 * value two of them failed. A test pinned to a value the game does not use is
 * testing a build nobody runs, so this loads the constant across the WASM
 * boundary like every other consumer.
 */
let MIN_HITS = 0
let MIN_UP = 0
let MAX_DIST = 0
beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
  MIN_HITS = C().BACKDROP_MIN_HITS
  MIN_UP = C().BACKDROP_MIN_UP
  MAX_DIST = C().BACKDROP_MAX_DIST_TO_SOLID
}, 120_000)

/** A synthetic mask, packed exactly as Rust packs it. */
class FakeMask implements MaskSource {
  readonly width: number
  readonly height: number
  private readonly bytes: Uint8Array

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.bytes = new Uint8Array(Math.ceil((width * height) / 8))
  }

  set(x: number, y: number): void {
    const bit = y * this.width + x
    this.bytes[bit >> 3]! |= 1 << (bit & 7)
  }

  fillRect(x0: number, y0: number, x1: number, y1: number): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y)
  }

  clear(x: number, y: number): void {
    const bit = y * this.width + x
    this.bytes[bit >> 3]! &= ~(1 << (bit & 7))
  }

  solidAt(x: number, y: number): boolean {
    const bit = y * this.width + x
    return ((this.bytes[bit >> 3]! >> (bit & 7)) & 1) !== 0
  }

  maskView(): Uint8Array {
    return this.bytes
  }
}

const SIZE = 64

function stencil(m: MaskSource, cx = 0, cy = 0): Uint32Array {
  const out = new Uint32Array(SIZE * SIZE)
  stencilBits(m, cx, cy, SIZE, out)
  return out
}

function edges(m: MaskSource, cx = 0, cy = 0): Uint32Array {
  const out = new Uint32Array(SIZE * SIZE)
  edgeBits(m, cx, cy, SIZE, EDGE_BAND_PX, out)
  return out
}

const at = (buf: Uint32Array, x: number, y: number) => buf[y * SIZE + x]

describe('chunk geometry', () => {
  it('maps chunk indices to world positions', () => {
    expect(chunkOrigin(3, 2, 256)).toEqual({ x: 768, y: 512 })
    expect(chunkOrigin(0, 0, 256)).toEqual({ x: 0, y: 0 })
  })

  it('computes the tile offset that keeps fills continuous across seams', () => {
    // A 256-px texture on 256-px chunks lines up exactly.
    expect(tileOffset(3, 2, 256, 256, 256)).toEqual({ x: 0, y: 0 })
    // A 100-px texture does not: 768 % 100 = 68, 512 % 100 = 12.
    expect(tileOffset(3, 2, 256, 100, 100)).toEqual({ x: 68, y: 12 })
  })
})

describe('solidIn', () => {
  it('matches the Rust bit layout and is bounds safe', () => {
    const m = new FakeMask(SIZE, SIZE)
    m.set(5, 3)
    const v = m.maskView()
    expect(solidIn(v, SIZE, SIZE, 5, 3)).toBe(true)
    expect(solidIn(v, SIZE, SIZE, 6, 3)).toBe(false)
    expect(solidIn(v, SIZE, SIZE, -1, 0)).toBe(false)
    expect(solidIn(v, SIZE, SIZE, 0, -1)).toBe(false)
    expect(solidIn(v, SIZE, SIZE, SIZE, 0)).toBe(false)
    expect(solidIn(v, SIZE, SIZE, 0, SIZE)).toBe(false)
  })
})

describe('stencilBits', () => {
  it('marks exactly the solid pixels', () => {
    const m = new FakeMask(SIZE, SIZE)
    m.fillRect(10, 20, 15, 25)
    const s = stencil(m)
    expect(at(s, 10, 20)).toBe(OPAQUE)
    expect(at(s, 15, 25)).toBe(OPAQUE)
    expect(at(s, 9, 20)).toBe(CLEAR)
    expect(at(s, 16, 25)).toBe(CLEAR)
    expect(at(s, 10, 19)).toBe(CLEAR)
  })

  it('is fully opaque for a solid chunk and fully clear for an empty one', () => {
    const solid = new FakeMask(SIZE, SIZE)
    solid.fillRect(0, 0, SIZE - 1, SIZE - 1)
    expect(stencil(solid).every((p) => p === OPAQUE)).toBe(true)

    const empty = new FakeMask(SIZE, SIZE)
    expect(stencil(empty).every((p) => p === CLEAR)).toBe(true)
  })

  it('clears pixels outside the map rather than reading past the mask', () => {
    // A map one chunk wide, sampled at the chunk to its right.
    const m = new FakeMask(SIZE, SIZE)
    m.fillRect(0, 0, SIZE - 1, SIZE - 1)
    expect(stencil(m, 1, 0).every((p) => p === CLEAR)).toBe(true)
    expect(stencil(m, 0, 1).every((p) => p === CLEAR)).toBe(true)
  })
})

describe('edgeBits', () => {
  it('bands the top EDGE_BAND_PX rows of a flat floor and nothing below', () => {
    const m = new FakeMask(SIZE, SIZE)
    m.fillRect(0, 30, SIZE - 1, SIZE - 1)
    const e = edges(m)

    for (let d = 0; d < EDGE_BAND_PX; d++) {
      expect(at(e, 20, 30 + d)).toBe(OPAQUE)
    }
    expect(at(e, 20, 30 + EDGE_BAND_PX)).toBe(CLEAR)
    expect(at(e, 20, 29)).toBe(CLEAR)
  })

  it('leaves the underside of an overhang dark', () => {
    // A solid slab; the pixel with air BELOW it must not be banded.
    const m = new FakeMask(SIZE, SIZE)
    m.fillRect(0, 10, SIZE - 1, 20)
    const e = edges(m)
    expect(at(e, 20, 10)).toBe(OPAQUE) // top face, banded
    expect(at(e, 20, 20)).toBe(CLEAR) // underside, dark
    expect(at(e, 20, 19)).toBe(CLEAR)
  })

  it('bands every pixel of a run shorter than the band', () => {
    const m = new FakeMask(SIZE, SIZE)
    m.fillRect(0, 30, SIZE - 1, 30 + EDGE_BAND_PX - 2)
    const e = edges(m)
    for (let d = 0; d < EDGE_BAND_PX - 1; d++) {
      expect(at(e, 20, 30 + d)).toBe(OPAQUE)
    }
  })

  it('bands exactly EDGE_BAND_PX of a tall run', () => {
    const m = new FakeMask(SIZE, 200)
    m.fillRect(0, 10, SIZE - 1, 120)
    const out = new Uint32Array(SIZE * SIZE)
    edgeBits(m, 0, 0, SIZE, EDGE_BAND_PX, out)
    let marked = 0
    for (let y = 0; y < SIZE; y++) if (out[y * SIZE + 20] === OPAQUE) marked++
    expect(marked).toBe(EDGE_BAND_PX)
  })

  it('bands both floors of a ledge above a floor', () => {
    const m = new FakeMask(SIZE, SIZE)
    m.fillRect(0, 10, SIZE - 1, 14) // ledge
    m.fillRect(0, 40, SIZE - 1, SIZE - 1) // floor below
    const e = edges(m)
    expect(at(e, 20, 10)).toBe(OPAQUE)
    expect(at(e, 20, 40)).toBe(OPAQUE)
  })

  /** The seam case: this is what the EDGE_BAND_PX margin above the chunk exists for. */
  it('paints no band where terrain continues down through the chunk boundary', () => {
    const m = new FakeMask(SIZE, SIZE * 2)
    // Solid from well above the second chunk's top edge, straight through it.
    m.fillRect(0, 10, SIZE - 1, SIZE * 2 - 1)

    const out = new Uint32Array(SIZE * SIZE)
    edgeBits(m, 0, 1, SIZE, EDGE_BAND_PX, out)
    expect(out.every((p) => p === CLEAR)).toBe(true)
  })

  it('marks nothing in an empty chunk', () => {
    const m = new FakeMask(SIZE, SIZE)
    expect(edges(m).every((p) => p === CLEAR)).toBe(true)
  })

  it('marks nothing in a chunk that is solid all the way through', () => {
    const m = new FakeMask(SIZE, SIZE * 2)
    m.fillRect(0, 0, SIZE - 1, SIZE * 2 - 1)
    const out = new Uint32Array(SIZE * SIZE)
    edgeBits(m, 0, 1, SIZE, EDGE_BAND_PX, out)
    expect(out.every((p) => p === CLEAR)).toBe(true)
  })
})

describe('BackdropMask', () => {
  /** A hill with a narrow tunnel and a large enclosed cavern inside it. */
  function hill(): FakeMask {
    const m = new FakeMask(512, 256)
    m.fillRect(0, 100, 511, 255) // the landmass
    return m
  }

  it('treats open sky above the terrain as outside', () => {
    const b = new BackdropMask(hill(), undefined, 96, 8, 320, MIN_HITS, MIN_UP, MAX_DIST)
    expect(b.insideAt(256, 20)).toBe(false)
    expect(b.insideAt(256, 60)).toBe(false)
  })

  it('treats the inside of the landmass as interior', () => {
    const b = new BackdropMask(hill(), undefined, 96, 8, 320, MIN_HITS, MIN_UP, MAX_DIST)
    expect(b.insideAt(256, 200)).toBe(true)
  })

  it('fills a narrow tunnel, so a cave shows rock rather than sky', () => {
    const m = new FakeMask(512, 256)
    m.fillRect(0, 100, 511, 255)
    // A 20 px tunnel: no 28 px disc fits, so the sky never reaches in.
    for (let y = 150; y < 170; y++) for (let x = 100; x < 400; x++) m.clear(x, y)

    const b = new BackdropMask(m, undefined, 96, 8, 320, MIN_HITS, MIN_UP, MAX_DIST)
    expect(b.insideAt(250, 160)).toBe(true)
  })

  it('does not turn a cavern with a wide mouth into sky (A14)', () => {
    // The regression: seeding the flood from all four borders made any chamber
    // joined to open air by a passage wider than 2*reach flood and render as sky.
    // A 312x360 cavern measured 0% sky before that change and 84% after.
    const m = new FakeMask(512, 512)
    m.fillRect(0, 100, 511, 511)
    // A big cavern deep inside the rock, opening only sideways to the map edge —
    // no route to the sky at all. Seeding the flood from every border let it in
    // from the right; seeding from the sky cannot reach it.
    for (let y = 250; y < 450; y++) for (let x = 100; x < 412; x++) m.clear(x, y)
    for (let y = 300; y < 400; y++) for (let x = 412; x < 512; x++) m.clear(x, y)

    const b = new BackdropMask(m, undefined, 96, 8, 320, MIN_HITS, MIN_UP, MAX_DIST)
    let interior = 0
    let total = 0
    for (let y = 240; y < 420; y++) {
      for (let x = 130; x < 380; x++) {
        total++
        if (b.insideAt(x, y)) interior++
      }
    }
    // The cavern is a hole in a mountain; it must read as rock behind, not sky.
    expect(interior / total).toBeGreaterThan(0.9)
  })

  it('fills a large enclosed cavern that closing alone would miss', () => {
    const m = new FakeMask(512, 256)
    m.fillRect(0, 100, 511, 255)
    // 200 px across — far wider than the disc, but sealed, so unreachable.
    for (let y = 140; y < 220; y++) for (let x = 150; x < 350; x++) m.clear(x, y)

    const b = new BackdropMask(m, undefined, 96, 8, 320, MIN_HITS, MIN_UP, MAX_DIST)
    expect(b.insideAt(250, 180)).toBe(true)
  })

  it('does not paint the backdrop out into open sky', () => {
    const m = new FakeMask(512, 256)
    m.fillRect(0, 200, 511, 255)
    const b = new BackdropMask(m, undefined, 96, 8, 320, MIN_HITS, MIN_UP, MAX_DIST)
    // Well above the surface must stay sky.
    expect(b.insideAt(256, 100)).toBe(false)
    expect(b.insideAt(256, 150)).toBe(false)
  })

  /** How far above a column's first solid pixel the backdrop starts, at worst. */
  function worstOverhang(b: BackdropMask, m: FakeMask, w: number, h: number): number {
    let worst = 0
    for (let x = 0; x < w; x++) {
      let firstSolid = h
      let firstInside = h
      for (let y = 0; y < h; y++) {
        if (firstInside === h && b.insideAt(x, y)) firstInside = y
        if (m.solidAt(x, y)) {
          firstSolid = y
          break
        }
      }
      if (firstInside < firstSolid) worst = Math.max(worst, firstSolid - firstInside)
    }
    return worst
  }

  it('hugs the rock exactly along an unobstructed silhouette', () => {
    // On a surface with no concave pockets there is no excuse for any overhang:
    // every pixel of sky has open air above it, so §A21's upward-hit conjunct
    // excludes all of it.
    //
    // This bound was 4, relaxed to 16 as a pinned ceiling while the crest halo
    // was a known defect, and is now back at 4 because §A21 fixed it — measured
    // 13px before the conjunct, 4px after. Restored rather than left pinned: a
    // ceiling around a fixed bug stops guarding anything.
    const m = new FakeMask(512, 256)
    for (let x = 0; x < 512; x++) {
      const top = Math.round(140 + 25 * Math.sin(x / 60))
      m.fillRect(x, top, x, 255)
    }
    const worst = worstOverhang(new BackdropMask(m, undefined, 96, 8, 320, MIN_HITS, MIN_UP, MAX_DIST), m, 512, 256)
    expect(worst).toBeLessThanOrEqual(4)
  })

  it('treats a crevice as interior and the space under an island as sky (A17)', () => {
    // §A17's table, which is the whole rule: enclosure, not roof. A crevice has
    // rock on both sides and below (6-7 rays hit) and is interior; under a
    // floating island there is rock above and open air everywhere else (1-3 rays)
    // and it is sky. Roofedness alone cannot tell these apart, which is why two
    // earlier attempts at this file missed.
    // The island sits in open air, further above the ground than BACKDROP_RAY_LEN
    // — which is what a floating island is. (An island only ~250 px up is a
    // covered gallery, and reading as interior there is correct.)
    const m = new FakeMask(768, 900)
    m.fillRect(0, 700, 767, 899) // ground
    for (let y = 700; y < 860; y++) for (let x = 300; x < 320; x++) m.clear(x, y) // crevice
    m.fillRect(120, 120, 400, 160) // a floating island

    const b = new BackdropMask(m, undefined, 96, 8, 320, MIN_HITS, MIN_UP, MAX_DIST)
    expect(b.insideAt(310, 800)).toBe(true) // deep in the crevice
    expect(b.insideAt(260, 220)).toBe(false) // 60 px under the island: sky
    expect(b.insideAt(600, 400)).toBe(false) // open sky
  })

  it('fills a crevice rather than showing sky down it', () => {
    // A crack open at the top has no rock above it, so any "is there rock above?"
    // clip turns it into a bright blue slit through the hillside. Width is the
    // distinction, and only the disc measures width.
    const m = new FakeMask(512, 256)
    m.fillRect(0, 100, 511, 255)
    for (let y = 100; y < 200; y++) for (let x = 250; x < 268; x++) m.clear(x, y)
    const b = new BackdropMask(m, undefined, 96, 8, 320, MIN_HITS, MIN_UP, MAX_DIST)
    expect(b.insideAt(259, 180)).toBe(true)
    expect(b.insideAt(259, 130)).toBe(true)
  })

  it('leaves no long axis-aligned run along the backdrop/sky boundary', () => {
    // The signature of square-kernel morphology: the boundary snaps to long
    // horizontal and vertical segments instead of following the rock.
    const m = new FakeMask(512, 256)
    for (let x = 0; x < 512; x++) {
      const top = Math.round(140 + 25 * Math.sin(x / 37) + 12 * Math.sin(x / 11))
      m.fillRect(x, top, x, 255)
    }
    const b = new BackdropMask(m, undefined, 96, 8, 320, MIN_HITS, MIN_UP, MAX_DIST)

    const boundary: number[] = []
    for (let x = 0; x < 512; x++) {
      let y = 0
      while (y < 256 && !b.insideAt(x, y)) y++
      boundary.push(y)
    }
    let run = 1
    let longest = 1
    for (let x = 1; x < boundary.length; x++) {
      run = boundary[x] === boundary[x - 1] ? run + 1 : 1
      longest = Math.max(longest, run)
    }
    // Back at the original 40 for the same reason as the overhang test: this was
    // 143 px while the backdrop floated clear of the rock and flattened, and it
    // predicted its own fix — "drops back below 40 the moment the classifier
    // gains the upward-hit conjunct". Measured 17 px with §A21.
    expect(longest).toBeLessThan(40)
  })
})
