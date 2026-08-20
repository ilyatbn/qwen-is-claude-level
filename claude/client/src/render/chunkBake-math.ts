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
 * ## Enclosure, not connectivity (§A17)
 *
 * Two earlier rules were wrong in instructive ways. Stencilling against the mask
 * left the generator's own caves showing sky. Flooding "outside" through a
 * `reach`-wide disc fixed sealed air — 27,420 sealed px, zero drawn as sky — but
 * sealed air was never the problem: **49.3 % of all roofed air still rendered as
 * open daylight**, because on a map of 140–310 px voids the sky region reaches
 * deep inside through every wide mouth. Connectivity is not a proxy for outdoors.
 *
 * Roofedness alone cannot fix it either: air under a **floating island** is roofed
 * and is unambiguously sky. That case is what kills the simple version.
 *
 * What separates a cavern from the space under an island is **enclosure**. A cavern
 * has rock in most directions; under an island there is rock above and open air
 * below and to the sides. So: cast `BACKDROP_RAYS` rays and count how many strike
 * solid within `BACKDROP_RAY_LEN`; interior at `BACKDROP_MIN_HITS` or more, OR'd
 * with the sealed-air rule which is kept because it is cheap and exactly right for
 * the case it covers.
 *
 * ## Resolution
 *
 * Eight rays per pixel over 8.4 M pixels is far too slow, and deciding per coarse
 * cell is what produced the axis-aligned rectangles in the first place. The hit
 * count is evaluated **per coarse cell** and then **bilinearly interpolated** to
 * pixel resolution before thresholding, so the field is smooth and the boundary
 * follows the rock rather than the grid.
 */
export class BackdropMask implements MaskSource {
  readonly width: number
  readonly height: number
  private readonly inside: Uint8Array<ArrayBuffer>

  /** A cave mouth narrower than twice this is sealed for flood purposes. */
  static readonly REACH_PX = 28
  /** Coarse cell for the enclosure field. */
  static readonly CELL = 8

  private static readonly ORTH = 3
  private static readonly DIAG = 4
  private static readonly FAR = 255

  /**
   * `minHits` has **no default**, deliberately (§A19). A default that disagreed
   * with the shipped constant is exactly what let the synthetic tests run at 6
   * while production ran at 5 — and at the shipped value two of those tests
   * failed, one of them violating §A17's own EDGE_BAND_PX proximity bound.
   * Callers pass `C().BACKDROP_MIN_HITS`; tests pin to the same constant.
   */
  constructor(
    src: MaskSource,
    reach = BackdropMask.REACH_PX,
    skyMargin = 96,
    rays = 8,
    rayLen = 320,
    minHits: number,
    /**
     * Upward ray hits required, in addition to `minHits` total (§A21).
     *
     * Interior air has rock above it. Without this, an exposed crest collects
     * enough side and downward hits to cross any workable total, and wears a
     * halo of backdrop along its skyline — measured mean 3.4-6.3 px. Roofedness
     * alone is not enough either (§A17: the air under a floating island is
     * roofed and is plainly sky), which is why this is a conjunct: something
     * over your head, AND rock most of the way around you.
     *
     * No default, for the same reason `minHits` has none (§A19): a constructor
     * default that can silently drift from the shipped constant is what let the
     * synthetic tests run at 6 while production ran at 5.
     */
    minUp: number,
  ) {
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
    const isSolid = (x: number, y: number) =>
      x < 0 || y < 0 || x >= w || y >= h ? false : solid[y * w + x] === 1

    // --- sealed air (§A14), kept as one half of the OR --------------------
    const rC = reach * BackdropMask.ORTH
    const distSolid = BackdropMask.chamfer(solid, w, h)
    const open = new Uint8Array(n)
    const stack: number[] = []
    const seed = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return
      const i = y * w + x
      if (open[i] || distSolid[i]! <= rC) return
      open[i] = 1
      stack.push(i)
    }
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
    const distOpen = BackdropMask.chamfer(open, w, h)

    // --- enclosure field, per coarse cell ---------------------------------
    const cell = BackdropMask.CELL
    const cw = Math.ceil(w / cell) + 1
    const ch = Math.ceil(h / cell) + 1
    const hits = new Float32Array(cw * ch)
    const upHits = new Float32Array(cw * ch)
    const dirs: Array<[number, number]> = []
    for (let k = 0; k < rays; k++) {
      const a = (k / rays) * Math.PI * 2
      dirs.push([Math.cos(a), Math.sin(a)])
    }
    // Step along each ray in 4-px increments: the features that matter are tens of
    // pixels across, and per-pixel marching here costs 8x for no extra fidelity.
    const STEP = 4
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        const px = cx * cell
        const py = cy * cell
        let count = 0
        let up = 0
        for (const [dx, dy] of dirs) {
          for (let t = STEP; t <= rayLen; t += STEP) {
            if (isSolid(Math.round(px + dx * t), Math.round(py + dy * t))) {
              count++
              // Screen coordinates: negative y is up.
              if (dy < -0.3) up++
              break
            }
          }
        }
        hits[cy * cw + cx] = count
        upHits[cy * cw + cx] = up
      }
    }

    // Blur the field before interpolating.
    //
    // Ray counts are integers and the threshold is an integer, so where two
    // adjacent cells read 5 and 6 the bilinear crossing lands *exactly* on the cell
    // edge — measured on a real map, 88 % of interior/exterior boundary
    // transitions sat on the 8 px lattice, against a 52 % control taken on the
    // terrain silhouette itself. A 3x3 average makes the field genuinely
    // continuous, so the crossing moves with the geometry instead of snapping.
    // Both fields are blurred, for the same reason: integer counts against an
    // integer threshold put the bilinear crossing exactly on a cell edge.
    const smoothUp = new Float32Array(cw * ch)
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        let sum = 0
        let wsum = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue
            const wt = dx === 0 && dy === 0 ? 8 : 1
            sum += upHits[ny * cw + nx]! * wt
            wsum += wt
          }
        }
        smoothUp[cy * cw + cx] = sum / wsum
      }
    }

    const smooth = new Float32Array(cw * ch)
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        // Centre-weighted: enough to make the field continuous, mild enough not to
        // erode a cavern's own high count at its mouth. A flat 3x3 average cost
        // 1.3 points of enclosure accuracy for no extra smoothness.
        let sum = 0
        let wsum = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue
            const wt = dx === 0 && dy === 0 ? 8 : 1
            sum += hits[ny * cw + nx]! * wt
            wsum += wt
          }
        }
        smooth[cy * cw + cx] = sum / wsum
      }
    }
    hits.set(smooth)
    upHits.set(smoothUp)

    // --- threshold at pixel resolution ------------------------------------
    const inside = new Uint8Array(n)
    for (let y = 0; y < h; y++) {
      const gy = y / cell
      const y0 = Math.min(ch - 1, Math.floor(gy))
      const y1 = Math.min(ch - 1, y0 + 1)
      const fy = gy - y0
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (solid[i]) {
          inside[i] = 1
          continue
        }
        // Sealed air is interior regardless of the ray count.
        if (distOpen[i]! > rC) {
          inside[i] = 1
          continue
        }
        const gx = x / cell
        const x0 = Math.min(cw - 1, Math.floor(gx))
        const x1 = Math.min(cw - 1, x0 + 1)
        const fx = gx - x0
        // Bilinear: the smooth field is what keeps the boundary off the grid.
        const a = hits[y0 * cw + x0]!
        const b = hits[y0 * cw + x1]!
        const c2 = hits[y1 * cw + x0]!
        const d = hits[y1 * cw + x1]!
        const top = a + (b - a) * fx
        const bot = c2 + (d - c2) * fx
        if (top + (bot - top) * fy < minHits) continue
        // §A21: and something over your head.
        const ua = upHits[y0 * cw + x0]!
        const ub = upHits[y0 * cw + x1]!
        const uc = upHits[y1 * cw + x0]!
        const ud = upHits[y1 * cw + x1]!
        const utop = ua + (ub - ua) * fx
        const ubot = uc + (ud - uc) * fx
        if (utop + (ubot - utop) * fy < minUp) continue
        inside[i] = 1
      }
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
