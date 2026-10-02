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
 * (`render_fields.fixture.json`).
 *
 * **T23.20: a strip whose bottom row is not solid (F3, space) is padded with its own rows mirrored**
 * (row 720 + k = row 719 − k). The mockup's distance transform sees nothing past the strip; a mirrored
 * px is always farther from any row ≤ 719 than the px it mirrors (`(1439 − y′) − y > |y − y′|` for
 * y, y′ ≤ 719), so the nearest rock / air of every px in the strip is still one inside it — `dIn` and
 * `dOut` of the top 720 rows are the mockup's. (The cave wall's closing, R24, reads a second distance
 * over the padded band, so its last ~48 rows may differ; F3's bottom rows are open sky and planet limb.)
 */
import { C, MapGenerator, type Core } from '../core'
import type { Masks, Scorch } from './scene'
import type { TerrainFeed } from './terrainFields'
import type { Rect } from './terrainGpu'
import { worldLookByte } from './worldLookId'

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

let labMaps = 0

export class LabFields implements TerrainFeed {
  readonly w: number
  readonly h: number
  readonly ready = true
  /** A look-lab scene is its own map: never a same-map resync (F3). */
  readonly mapKey = `lab:${++labMaps}`
  /** R24: none — the lab's scenes are the mockup's albedo, unshifted. */
  readonly albedoOffset = [0, 0] as const
  private first = true

  constructor(
    private readonly core: Core,
    masks: Masks,
    private readonly scorch: Scorch[],
    /** T23.20: F3's rock — the core's generator says space, so the Rust relief raises the asteroid's boulders. */
    asteroid = false,
    /** T23.31: F2's rock — the core's world look says volcanic, so the Rust relief raises `THEMES.volcanic`'s boulders. */
    volcanic = false,
  ) {
    const size = C().CHUNK_SIZE
    this.w = masks.w
    this.h = Math.ceil(masks.h / size) * size
    if (this.w % size !== 0) throw new Error(`look-lab fields: a ${masks.w}×${masks.h} strip needs whole-chunk width`)
    const bottom = masks.solid.subarray((masks.h - 1) * masks.w, masks.h * masks.w)
    const mirror = bottom.some((b) => b === 0)
    const solid = new Uint8Array(this.w * this.h).fill(1)
    solid.set(masks.solid)
    const wall = new Uint8Array(this.w * this.h)
    wall.set(masks.back)
    if (mirror) {
      if (this.h - masks.h > masks.h) throw new Error(`look-lab fields: a ${masks.w}×${masks.h} strip is too short to mirror`)
      for (let k = 0; k < this.h - masks.h; k++) {
        const from = (masks.h - 1 - k) * this.w
        solid.copyWithin((masks.h + k) * this.w, from, from + this.w)
        wall.copyWithin((masks.h + k) * this.w, from, from + this.w)
      }
    }
    core.setMapGenerator(asteroid ? MapGenerator.Space : MapGenerator.V2)
    core.setWorldLook(worldLookByte(volcanic ? 'volcanic' : 'classic'))
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
