import { describe, it, expect } from 'vitest'
import {
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
