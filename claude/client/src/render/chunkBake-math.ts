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
