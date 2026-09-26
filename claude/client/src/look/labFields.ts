/**
 * T23.06: the look-lab's terrain fields — a reference scene's own masks through T23.05's Rust
 * (`render_fields.rs`), on a `Core` of the lab's own, so the lab paints the albedo from the same
 * fields the game does.
 *
 * The mockup's 1280×720 strip is not a whole number of chunks, and the core holds maps of whole
 * chunks, so the mask is **padded with solid rows** to 768. That changes no field in the top 720
 * rows *when the strip's bottom row is solid* (ARENA_E's is): a solid row adds no air to `dIn`'s
 * search and nothing nearer than the row above it to `dOut`'s. Checked, not assumed: `look-albedo`
 * hashes each channel of the top 720 rows against T23.05's mockup dump
 * (`render_fields.fixture.json`), and this constructor refuses a strip whose bottom row is not solid.
 */
import { C, type Core } from '../core'
import type { Masks, Scorch } from './scene'
import type { TerrainFeed } from './terrainFields'
import type { Rect } from './terrainGpu'

/** `rle.rs`'s format: alternating runs, the first clear, LEB128 lengths. */
function encodeRle(bits: Uint8Array): Uint8Array {
  const out: number[] = []
  const put = (n: number): void => {
    do {
      let b = n & 0x7f
      n = Math.floor(n / 128)
      if (n > 0) b |= 0x80
      out.push(b)
    } while (n > 0)
  }
  let run = 0
  let on = 0
  for (let i = 0; i < bits.length; i++) {
    if ((bits[i]! ? 1 : 0) === on) run++
    else {
      put(run)
      on ^= 1
      run = 1
    }
  }
  put(run)
  return new Uint8Array(out)
}

export class LabFields implements TerrainFeed {
  readonly w: number
  readonly h: number
  readonly ready = true
  private first = true

  constructor(
    private readonly core: Core,
    masks: Masks,
    private readonly scorch: Scorch[],
  ) {
    const size = C().CHUNK_SIZE
    this.w = masks.w
    this.h = Math.ceil(masks.h / size) * size
    const bottom = masks.solid.subarray((masks.h - 1) * masks.w, masks.h * masks.w)
    if (this.w % size !== 0 || bottom.some((b) => b === 0)) {
      throw new Error(`look-lab fields: a ${masks.w}×${masks.h} strip needs whole-chunk width and a solid bottom row to pad`)
    }
    const solid = new Uint8Array(this.w * this.h).fill(1)
    solid.set(masks.solid)
    const wall = new Uint8Array(this.w * this.h)
    wall.set(masks.back)
    if (!core.loadMask(this.w, this.h, encodeRle(solid))) throw new Error('look-lab fields: mask failed to load')
    core.renderFieldsFullWithWall(wall)
  }

  view(): Uint8Array {
    return this.core.renderFieldsView()
  }

  din2(): Uint16Array {
    return this.core.renderFieldsDin2View()
  }

  /**
   * FNV-1a-32 of each channel over the first `rows` rows — T23.05's fixture hashes
   * (`render_fields.fixture.json`: din, dout, back, relief_u8), for `look-albedo` to check the padding.
   */
  channelFnv(rows: number): { din: number; dout: number; back: number; relief_u8: number } {
    const v = this.view()
    const h = [0x811c9dc5, 0x811c9dc5, 0x811c9dc5, 0x811c9dc5]
    for (let i = 0; i < this.w * rows; i++) {
      for (let c = 0; c < 4; c++) h[c] = Math.imul(h[c]! ^ v[i * 4 + c]!, 0x01000193) >>> 0
    }
    return { din: h[0]!, dout: h[1]!, back: h[2]!, relief_u8: h[3]! }
  }

  take(): { full: boolean; rects: Rect[]; scorches: [number, number, number][] } {
    const full = this.first
    this.first = false
    return { full, rects: [], scorches: full ? this.scorch.map((s): [number, number, number] => [s.x, s.y, s.r]) : [] }
  }
}
