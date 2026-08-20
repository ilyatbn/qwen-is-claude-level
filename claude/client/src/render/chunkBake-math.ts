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
 * Which air pixels are **inside** the landmass, and so get the cave backdrop.
 *
 * The backdrop has to appear behind generator caves, behind craters and behind
 * tunnels — and nowhere else. Two simpler rules both fail: a full-map rectangle
 * hides the sky entirely, and stencilling against the pristine mask leaves the
 * generator's own caves showing sky, because they were already air when the
 * snapshot was taken.
 *
 * The rule that works is geodesic: **sky is wherever a disc of radius `reach` can
 * roll in from the border.** Everything else is interior.
 *
 * ```
 *   1. distance transform from solid          -> where does a disc of radius R fit?
 *   2. flood **from the sky** through those    -> where can the sky actually reach?
 *   3. distance transform from that flood      -> interior is air further than R away
 * ```
 *
 * Step 2 seeds from **genuine sky only** — the top border and anything above
 * `SKY_MARGIN` — never from all four borders (§A14). Seeding from every border made
 * any chamber joined to open air by a passage wider than `2 * reach` flood and
 * render as sky: a 312 x 360 cavern measured 0 % sky before, 84 % after. Tunnels
 * (bore 30-52) stayed under the threshold, which is exactly why the network still
 * looked right and the failure hid in the biggest holes on the map. The disc is the
 * width gate; it is not the definition of "outside".
 *
 * A cave mouth narrower than `2 * reach` admits no disc, so the cave is interior all
 * the way to its lip. A wide bay admits one, so it reads as open sky. A sealed
 * cavern is never reached at all, so it is interior for free — no special case.
 *
 * **This replaced a morphological closing on a coarse grid, which was wrong twice
 * over.** Its structuring element was a *square*, so it filled concave corners with
 * ~100 px axis-aligned rectangles that stuck visibly out into the sky; and it
 * decided a per-pixel boundary at 4 px granularity, which drew a stepped fringe
 * along the silhouette at gameplay zoom. Both are gone because the boundary here is
 * a disc offset computed at mask resolution.
 *
 * Cost is three linear passes over the mask, once per snapshot. A chamfer transform
 * (3 orthogonal, 4 diagonal) approximates Euclidean distance within about 6 %,
 * which is far below anything visible.
 */
export class BackdropMask implements MaskSource {
  readonly width: number
  readonly height: number
  private readonly inside: Uint8Array<ArrayBuffer>

  /** A cave mouth narrower than twice this is interior, not sky. */
  static readonly REACH_PX = 28

  /** Chamfer weights. Orthogonal step 3, diagonal step 4. */
  private static readonly ORTH = 3
  private static readonly DIAG = 4
  private static readonly FAR = 255

  constructor(src: MaskSource, reach = BackdropMask.REACH_PX, skyMargin = 96) {
    const w = (this.width = src.width)
    const h = (this.height = src.height)
    const n = w * h
    const view = src.maskView()

    const solid = new Uint8Array(n)
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w; x++) {
        if (solidIn(view, w, h, x, y)) solid[row + x] = 1
      }
    }

    const rC = reach * BackdropMask.ORTH

    // 1. How far is each air pixel from rock? A disc of radius `reach` centred here
    //    fits iff that distance exceeds `reach`.
    const distSolid = BackdropMask.chamfer(solid, w, h)

    // 2. Flood the border through the positions a disc fits in. Out-of-bounds counts
    //    as open, so the flood starts anywhere on the edge that is not walled off.
    const open = new Uint8Array(n)
    const stack: number[] = []
    const seed = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return
      const i = y * w + x
      if (open[i] || distSolid[i]! <= rC) return
      open[i] = 1
      stack.push(i)
    }
    // Genuine sky only: the top row, plus every row above SKY_MARGIN, which the
    // generator guarantees is empty. The side and bottom borders are rock or
    // bedrock and seeding from them is what let caverns flood.
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < Math.min(skyMargin, h); y++) seed(x, y)
    }
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i - x) / w
      seed(x + 1, y)
      seed(x - 1, y)
      seed(x, y + 1)
      seed(x, y - 1)
    }

    // 3. Interior is air the sky-disc never got within `reach` of. Measuring from the
    //    flood rather than clipping to a fixed offset is what keeps the boundary
    //    hugging the rock instead of standing off it by a constant.
    const distOpen = BackdropMask.chamfer(open, w, h)

    // Width is the whole distinction, and the disc already measures it. A "nothing
    // above the highest rock in this column is interior" clip was tried here to
    // remove the shading in concave corners; it painted **bright sky down every
    // crevice**, because a crack open at the top has no rock above it either. A
    // 12 px crack reading as open air is far worse than a little extra shade in the
    // corner of a wide notch, where it passes for ambient occlusion.
    const inside = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (solid[i] || distOpen[i]! > rC) inside[i] = 1
    }
    this.inside = inside
  }

  /** Two-pass chamfer distance transform from the set bits of `src`, clamped. */
  private static chamfer(
    src: Uint8Array<ArrayBuffer>,
    w: number,
    h: number,
  ): Uint8Array<ArrayBuffer> {
    const { ORTH, DIAG, FAR } = BackdropMask
    const d = new Uint8Array(w * h)
    for (let i = 0; i < d.length; i++) d[i] = src[i] === 1 ? 0 : FAR

    const relax = (i: number, from: number, cost: number) => {
      const v = d[from]! + cost
      if (v < d[i]!) d[i] = v
    }

    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w; x++) {
        const i = row + x
        if (d[i] === 0) continue
        if (x > 0) relax(i, i - 1, ORTH)
        if (y > 0) {
          relax(i, i - w, ORTH)
          if (x > 0) relax(i, i - w - 1, DIAG)
          if (x + 1 < w) relax(i, i - w + 1, DIAG)
        }
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      const row = y * w
      for (let x = w - 1; x >= 0; x--) {
        const i = row + x
        if (d[i] === 0) continue
        if (x + 1 < w) relax(i, i + 1, ORTH)
        if (y + 1 < h) {
          relax(i, i + w, ORTH)
          if (x + 1 < w) relax(i, i + w + 1, DIAG)
          if (x > 0) relax(i, i + w - 1, DIAG)
        }
      }
    }
    return d
  }

  insideAt(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false
    return this.inside[y * this.width + x] === 1
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
