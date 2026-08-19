/**
 * The pure half of the chunk bake: everything that decides *which* pixels are
 * terrain and which are edge band.
 *
 * DOM-free and Phaser-free by design (`docs/70-amendments-v2.md` §A8), so all of it
 * is testable under vitest in node. `chunkBake.ts` holds the canvas work and
 * imports this — never the other way round.
 */

/** The subset of `Core` these functions need. Lets tests supply a synthetic mask. */
export interface MaskSource {
  readonly width: number
  readonly height: number
  maskView(): Uint8Array
}

/** Opaque white / fully transparent, as a single 32-bit store per pixel. */
export const OPAQUE = 0xffffffff
export const CLEAR = 0x00000000

/** World position of a chunk's top-left corner. */
export function chunkOrigin(
  chunkX: number,
  chunkY: number,
  chunkSize: number,
): { x: number; y: number } {
  return { x: chunkX * chunkSize, y: chunkY * chunkSize }
}

/**
 * Offset at which to start drawing the tiling fill, so the pattern is continuous
 * across chunk seams.
 *
 * Drawing from (0,0) in every chunk produces a visible grid of repeated tiles — the
 * most obvious possible rendering artefact, and painful to retrofit.
 */
export function tileOffset(
  chunkX: number,
  chunkY: number,
  chunkSize: number,
  texW: number,
  texH: number,
): { x: number; y: number } {
  const { x, y } = chunkOrigin(chunkX, chunkY, chunkSize)
  return { x: ((x % texW) + texW) % texW, y: ((y % texH) + texH) % texH }
}

/**
 * Read one pixel of a packed mask.
 *
 * Bit order matches `Mask` exactly: `bit = y * w + x`, byte `bit >> 3`,
 * `(byte >> (bit & 7)) & 1`. Rust packs `u64` words while this reads bytes; on
 * little-endian — every platform that runs a browser — the two agree.
 */
export function solidIn(view: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false
  const bit = y * w + x
  return ((view[bit >> 3]! >> (bit & 7)) & 1) !== 0
}

/**
 * Solid pixels of the chunk's slice → `OPAQUE` in `out`, everything else `CLEAR`.
 *
 * `out` is `chunkSize²` 32-bit words, supplied by the caller and reused across
 * bakes.
 */
export function stencilBits(
  src: MaskSource,
  chunkX: number,
  chunkY: number,
  chunkSize: number,
  out: Uint32Array,
): void {
  const { x: ox, y: oy } = chunkOrigin(chunkX, chunkY, chunkSize)
  const w = src.width
  const h = src.height
  const view = src.maskView()

  for (let row = 0; row < chunkSize; row++) {
    const wy = oy + row
    const base = row * chunkSize
    if (wy < 0 || wy >= h) {
      out.fill(CLEAR, base, base + chunkSize)
      continue
    }
    const bitRow = wy * w
    for (let col = 0; col < chunkSize; col++) {
      const wx = ox + col
      let solid = false
      if (wx >= 0 && wx < w) {
        const bit = bitRow + wx
        solid = ((view[bit >> 3]! >> (bit & 7)) & 1) !== 0
      }
      out[base + col] = solid ? OPAQUE : CLEAR
    }
  }
}

/**
 * Mark the top `band` solid pixels below each air→solid transition.
 *
 * **Only upward-facing surfaces.** The run counter resets on air, so the band
 * appears below an air→solid transition and nowhere else; the undersides of
 * overhangs stay dark, which is what sells the depth. A symmetric outline would
 * make the terrain look like a sticker.
 *
 * The scan starts `band` rows **above** the chunk. Without that margin, a column
 * already solid at the chunk's top edge starts its run at zero and paints a false
 * band straight across the seam — a visible horizontal line at every chunk
 * boundary, which is the failure `docs/12-map-render.md` §2 warns about.
 */
export function edgeBits(
  src: MaskSource,
  chunkX: number,
  chunkY: number,
  chunkSize: number,
  band: number,
  out: Uint32Array,
): void {
  const { x: ox, y: oy } = chunkOrigin(chunkX, chunkY, chunkSize)
  const w = src.width
  const h = src.height
  const view = src.maskView()
  out.fill(CLEAR)

  for (let col = 0; col < chunkSize; col++) {
    const wx = ox + col
    if (wx < 0 || wx >= w) continue

    let run = 0
    for (let wy = oy - band; wy < oy + chunkSize; wy++) {
      if (solidIn(view, w, h, wx, wy)) {
        if (run < band && wy >= oy) {
          out[(wy - oy) * chunkSize + col] = OPAQUE
        }
        run++
      } else {
        run = 0
      }
    }
  }
}

/**
 * A coarse, dilated silhouette of the terrain, used to stencil the cave backdrop.
 *
 * The backdrop has to appear **inside the landmass** — behind generator caves,
 * behind craters, behind tunnels — and nowhere else. Two simpler rules both fail:
 * a full-map rectangle hides the sky entirely, and stencilling against the pristine
 * mask leaves the generator's own caves showing sky, because they were already air
 * when the snapshot was taken.
 *
 * Dilating the silhouette by `DILATE_PX` closes both: any air within that distance
 * of rock is treated as interior. It is computed once per round at
 * `COARSE_CELL` resolution and sampled per pixel during the bake, so the cost is
 * negligible.
 */
export class BackdropMask implements MaskSource {
  readonly width: number
  readonly height: number
  readonly cell: number
  readonly cw: number
  readonly ch: number
  private readonly cells: Uint8Array<ArrayBuffer>

  /** Caves up to twice this wide are treated as interior. */
  static readonly CLOSE_PX = 56

  constructor(src: MaskSource, cell = 4, closePx = BackdropMask.CLOSE_PX) {
    this.width = src.width
    this.height = src.height
    this.cell = cell
    this.cw = Math.ceil(src.width / cell)
    this.ch = Math.ceil(src.height / cell)

    const view = src.maskView()
    let grid: Uint8Array<ArrayBuffer> = new Uint8Array(this.cw * this.ch)
    for (let y = 0; y < src.height; y++) {
      const row = Math.floor(y / cell) * this.cw
      for (let x = 0; x < src.width; x++) {
        if (solidIn(view, src.width, src.height, x, y)) {
          grid[row + Math.floor(x / cell)] = 1
        }
      }
    }

    // A morphological CLOSING — dilate then erode — not a plain dilation.
    // Dilation alone fills the caves but also grows the outer silhouette, painting
    // a 56 px blocky halo of "rock" into the open sky. Eroding by the same radius
    // afterwards pulls that boundary back while leaving the filled interior.
    const r = Math.max(1, Math.round(closePx / cell))
    grid = this.dilate(grid, r)
    grid = this.erode(grid, r)

    // Closing fills narrow caves but not a large enclosed cavern, which then shows
    // sky through the middle of a hillside. The complete rule is "interior is
    // whatever the outside cannot reach": flood the air inward from the map border
    // and treat everything it fails to reach as inside the landmass.
    grid = this.fillEnclosed(grid)

    // One last erosion pulls the backdrop just inside the rock silhouette. The
    // grid is coarse, so without this the backdrop overhangs the terrain by up to
    // a cell and draws a stepped dark fringe against the sky — clearly visible at
    // gameplay zoom, where one cell is 8 screen px. The rock is drawn per pixel on
    // top, so a backdrop that sits slightly inside it is completely hidden.
    this.cells = this.erode(grid, 1)
  }

  /** Air not reachable from the map border becomes interior. */
  private fillEnclosed(grid: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    const outside = new Uint8Array(this.cw * this.ch)
    const stack: number[] = []
    const push = (cx: number, cy: number) => {
      if (cx < 0 || cy < 0 || cx >= this.cw || cy >= this.ch) return
      const i = cy * this.cw + cx
      if (outside[i] || grid[i]) return
      outside[i] = 1
      stack.push(i)
    }
    for (let cx = 0; cx < this.cw; cx++) {
      push(cx, 0)
      push(cx, this.ch - 1)
    }
    for (let cy = 0; cy < this.ch; cy++) {
      push(0, cy)
      push(this.cw - 1, cy)
    }
    while (stack.length) {
      const i = stack.pop()!
      const cx = i % this.cw
      const cy = (i - cx) / this.cw
      push(cx + 1, cy)
      push(cx - 1, cy)
      push(cx, cy + 1)
      push(cx, cy - 1)
    }

    const out = new Uint8Array(this.cw * this.ch)
    for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1
    return out
  }

  private dilate(src: Uint8Array<ArrayBuffer>, r: number): Uint8Array<ArrayBuffer> {
    return this.morph(src, r, true)
  }

  private erode(src: Uint8Array<ArrayBuffer>, r: number): Uint8Array<ArrayBuffer> {
    return this.morph(src, r, false)
  }

  /** Separable max (dilate) or min (erode) filter over the coarse grid. */
  private morph(src: Uint8Array<ArrayBuffer>, r: number, max: boolean): Uint8Array<ArrayBuffer> {
    const want = max ? 1 : 0
    const tmp = new Uint8Array(this.cw * this.ch)
    for (let cy = 0; cy < this.ch; cy++) {
      const base = cy * this.cw
      for (let cx = 0; cx < this.cw; cx++) {
        let hit = max ? 0 : 1
        for (let d = -r; d <= r; d++) {
          const nx = cx + d
          // Outside the grid counts as solid for erosion, so the map border does
          // not erode inward and expose a rim of sky along the walls.
          const v = nx < 0 || nx >= this.cw ? (max ? 0 : 1) : src[base + nx]!
          if (v === want) {
            hit = want
            break
          }
        }
        tmp[base + cx] = hit
      }
    }
    const out = new Uint8Array(this.cw * this.ch)
    for (let cx = 0; cx < this.cw; cx++) {
      for (let cy = 0; cy < this.ch; cy++) {
        let hit = max ? 0 : 1
        for (let d = -r; d <= r; d++) {
          const ny = cy + d
          const v = ny < 0 || ny >= this.ch ? (max ? 0 : 1) : tmp[ny * this.cw + cx]!
          if (v === want) {
            hit = want
            break
          }
        }
        out[cy * this.cw + cx] = hit
      }
    }
    return out
  }

  insideAt(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false
    return this.cells[Math.floor(y / this.cell) * this.cw + Math.floor(x / this.cell)] === 1
  }

  /** Packed like a mask, so it can be used anywhere a `MaskSource` is expected. */
  maskView(): Uint8Array {
    const bytes = new Uint8Array(Math.ceil((this.width * this.height) / 8))
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.insideAt(x, y)) {
          const bit = y * this.width + x
          bytes[bit >> 3]! |= 1 << (bit & 7)
        }
      }
    }
    return bytes
  }
}

/**
 * Write a chunk's slice of a `BackdropMask` into `out`. Avoids materialising a
 * full packed mask, which `maskView()` would do on every call.
 */
export function backdropBits(
  mask: BackdropMask,
  chunkX: number,
  chunkY: number,
  chunkSize: number,
  out: Uint32Array,
): void {
  const { x: ox, y: oy } = chunkOrigin(chunkX, chunkY, chunkSize)
  for (let row = 0; row < chunkSize; row++) {
    const base = row * chunkSize
    for (let col = 0; col < chunkSize; col++) {
      out[base + col] = mask.insideAt(ox + col, oy + row) ? OPAQUE : CLEAR
    }
  }
}

/**
 * A frozen copy of the mask as it was at round start.
 *
 * The cave backdrop belongs **behind terrain that existed**, not across the whole
 * map: a crater blown through a hillside must show dark rock, while the open sky
 * above the terrain must stay sky. Stencilling the backdrop against this snapshot
 * gives exactly that, for the cost of one copy per round.
 *
 * It is deliberately not updated by carving — that is the point.
 */
export class MaskSnapshot implements MaskSource {
  readonly width: number
  readonly height: number
  private readonly bytes: Uint8Array

  constructor(src: MaskSource) {
    this.width = src.width
    this.height = src.height
    this.bytes = new Uint8Array(src.maskView())
  }

  maskView(): Uint8Array {
    return this.bytes
  }
}
