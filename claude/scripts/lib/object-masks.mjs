/**
 * Turning a PNG into a 1-bit terrain mask. The pure half of T16.01.
 *
 * No filesystem, no PNG decoding, no argv — those live in
 * `scripts/build-object-masks.mjs`. Everything here is a function over typed
 * arrays, so the vitest suite can drive the same code the build runs
 * (`client/src/render/objectMasks.test.ts`) rather than a second copy of it.
 *
 * `docs/73-amendments-v5.md` §D1/§D2.
 */

/** `masks.bin` header magic, so a truncated or foreign file fails loudly. */
export const MASKS_MAGIC = 0x4d4a424f // the bytes `O B J M`, read little-endian
export const MASKS_VERSION = 2
/** magic + version + count. */
export const MASKS_HEADER_BYTES = 12
/** id, w, h, anchorX, anchorY, category, pad, offset, len. */
export const MASKS_RECORD_BYTES = 24

/**
 * Category as a number, because `game-core` reads `masks.bin` and not the JSON.
 *
 * Position is the encoding, so this array is as load-bearing as the id/position
 * rule in §B16 and is asserted against the Rust enum's order by the suite. A
 * category the build has never heard of stops the build rather than defaulting
 * to zero and silently stamping bushes.
 */
export const CATEGORY_ORDER = ['bush', 'rock', 'crystal', 'ruin']

export function categoryCode(name) {
  const i = CATEGORY_ORDER.indexOf(name)
  if (i < 0) throw new Error(`unknown object category \`${name}\``)
  return i
}

/**
 * α **strictly above** the threshold is solid.
 *
 * Strictly, because `scripts/catalogue-sprites.mjs:15` measured every bounding
 * box in `CATALOGUE.md` with `a > 128`. `>=` here would make the catalogue's
 * numbers and this pipeline's output describe different pixels, and §D0's whole
 * table is the input to the scale decision.
 */
export function thresholdAlpha(rgba, w, h, threshold) {
  const bits = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bits[i] = rgba[(i << 2) + 3] > threshold ? 1 : 0
  return bits
}

/** The opaque bounding box. `w`/`h` are zero when nothing is opaque. */
export function opaqueBounds(bits, w, h) {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bits[w * y + x]) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** Crop a bit plane to a box. */
export function crop(bits, w, _h, box) {
  const out = new Uint8Array(box.w * box.h)
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      out[box.w * y + x] = bits[w * (box.y + y) + (box.x + x)]
    }
  }
  return out
}

/** Crop RGBA to the same box, so the art and the mask describe one rectangle. */
export function cropRgba(rgba, w, _h, box) {
  const out = new Uint8Array(box.w * box.h * 4)
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const s = ((w * (box.y + y) + (box.x + x)) << 2)
      const d = ((box.w * y + x) << 2)
      out[d] = rgba[s]
      out[d + 1] = rgba[s + 1]
      out[d + 2] = rgba[s + 2]
      out[d + 3] = rgba[s + 3]
    }
  }
  return out
}

/**
 * Nearest-neighbour, `src = floor(dst * srcW / dstW)`.
 *
 * At an integer factor this is exact and reversible: upscaling by k puts source
 * pixel `x` at `x*k .. x*k+k-1`, and downscaling by k reads `x*k` back. §D2 wants
 * that property so a mask re-derived anywhere agrees bit for bit (§A24).
 */
export function scaleNearest(bits, w, h, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH)
  for (let y = 0; y < dstH; y++) {
    const sy = Math.floor((y * h) / dstH)
    for (let x = 0; x < dstW; x++) {
      out[dstW * y + x] = bits[w * sy + Math.floor((x * w) / dstW)]
    }
  }
  return out
}

/** The same sampling on RGBA, so art and mask are scaled by one rule. */
export function scaleRgbaNearest(rgba, w, h, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4)
  for (let y = 0; y < dstH; y++) {
    const sy = Math.floor((y * h) / dstH)
    for (let x = 0; x < dstW; x++) {
      const s = (w * sy + Math.floor((x * w) / dstW)) << 2
      const d = (dstW * y + x) << 2
      out[d] = rgba[s]
      out[d + 1] = rgba[s + 1]
      out[d + 2] = rgba[s + 2]
      out[d + 3] = rgba[s + 3]
    }
  }
  return out
}

/**
 * Greatest common divisor, for keeping a factor in lowest terms.
 */
export function gcd(a, b) {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

/**
 * A JS number as an exact `num/den`, read off its own decimal spelling.
 *
 * `PLAYER_H * OBJECT_TARGET_PLAYER_H_BUSH` is `28`, and `* 1.1` would be
 * `30.800000000000004` — a float whose product with a sprite height is not the
 * same on every machine. Every double JS prints round-trips, so the printed
 * decimals are an exact rational, and from there the pipeline is integers only.
 */
export function rationalFromNumber(x) {
  const text = String(x)
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`cannot take ${text} as an exact rational`)
  }
  const dot = text.indexOf('.')
  if (dot < 0) return exactly({ num: Number(text), den: 1 }, text)
  const den = 10 ** (text.length - dot - 1)
  return exactly({ num: Math.round(x * den), den }, text)
}

/**
 * Refuse a rational that cannot survive being multiplied by a sprite dimension.
 *
 * `PLAYER_H * 1.1` is `30.800000000000004`, whose exact denominator is 10^15 —
 * so `num` lands past `Number.MAX_SAFE_INTEGER` and `bounds.w * num` stops being
 * integer arithmetic. Silently, and only for some sprites. Better to stop with
 * the number in the message than to ship masks that are bit-exact on paper.
 */
function exactly(factor, text) {
  // A sprite dimension is small, but leave the headroom explicit rather than
  // assuming it: the product is what has to stay exact, not the factor.
  const headroom = 1 << 16
  if (
    !Number.isSafeInteger(factor.num) ||
    !Number.isSafeInteger(factor.den) ||
    factor.num > Number.MAX_SAFE_INTEGER / headroom ||
    factor.den > Number.MAX_SAFE_INTEGER / headroom
  ) {
    throw new Error(
      `${text} needs ${factor.num}/${factor.den}, which is too large to stay exact — ` +
        'pick a target height with fewer decimals',
    )
  }
  return factor
}

/** `num/den` in lowest terms. */
export function reduceRational(factor) {
  const g = gcd(factor.num, factor.den) || 1
  return { num: factor.num / g, den: factor.den / g }
}

/**
 * **The scale factor: one per category, measured from the sprites selected.**
 *
 * `factor = target_px / mean_opaque_height`, which is §D4's table — and taking
 * the mean from the *selection* rather than from §D0's printed number is what
 * makes ruins come out right: §D0's 68 averages all 164 files including the four
 * 488x431 contact sheets that are not objects, while the 40 in `Assets/` mean
 * 57.5, so the factor is 84/57.5 and not 84/68.
 *
 * One factor for the whole category, **on purpose**: it is what keeps a small
 * crystal small and a big rock big. Dividing each sprite by its own height
 * instead would land all 40 crystals on exactly `target_px` and flatten the
 * variety the packs are here to provide (§D4's own note).
 *
 * Exact: `target_px * n / sum(h)`, integers, reduced. No float survives into the
 * sampling loop, so a re-derived mask agrees bit for bit (§A24).
 */
export function packFactor(targetPx, heights) {
  if (heights.length === 0) throw new Error('a category with no sprites has no mean height')
  const sum = heights.reduce((n, h) => n + h, 0)
  if (sum === 0) throw new Error('a category whose sprites are all empty has no mean height')
  const target = rationalFromNumber(targetPx)
  return reduceRational({ num: target.num * heights.length, den: target.den * sum })
}

/** `round(a / b)` for non-negative integers, without touching a float. */
export function divRound(a, b) {
  return Math.floor((2 * a + b) / (2 * b))
}

/**
 * **The scale policy, and its only call site.**
 *
 * Applies the category's factor to *this* sprite's own measured bounds, so the
 * spread inside a pack survives to the map.
 */
export function scaleFor(factor, bounds) {
  return {
    w: Math.max(1, divRound(bounds.w * factor.num, factor.den)),
    h: Math.max(1, divRound(bounds.h * factor.num, factor.den)),
  }
}

/** Row-major, MSB first, no per-row padding — bit `y*w + x`. */
export function packBits(bits, w, h) {
  const out = new Uint8Array(packedLength(w, h))
  for (let i = 0; i < w * h; i++) {
    if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7)
  }
  return out
}

export function unpackBits(packed, w, h) {
  const out = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    out[i] = (packed[i >> 3] >> (7 - (i & 7))) & 1
  }
  return out
}

export function packedLength(w, h) {
  return Math.ceil((w * h) / 8)
}

/** Set bits in a packed blob. A mask with none of these stamps nothing. */
export function popcount(packed) {
  let n = 0
  for (const byte of packed) {
    let b = byte
    while (b) {
      n += b & 1
      b >>= 1
    }
  }
  return n
}

/**
 * §B16: a laser resolved as a bazooka because two registries each assumed array
 * position was the id and nobody made them say so. This is that assertion, and
 * every writer of the table runs it.
 */
export function assertIdsMatchPosition(entries) {
  const wrong = entries
    .map((e, i) => ({ i, e }))
    .filter(({ i, e }) => e.id !== i)
    .map(({ i, e }) => `${e.key ?? '<no key>'} is at position ${i} with id ${e.id}`)
  if (wrong.length) {
    throw new Error(`object ids must equal array position:\n  ${wrong.join('\n  ')}`)
  }
  return entries
}

/**
 * `masks.bin`: a header, a fixed-width index, then every mask's bits end to end.
 *
 * §D2 asks for "one blob"; the index in front of it is so `game-core` can slice
 * that blob without parsing JSON — it embeds this file with `include_bytes!` and
 * has no serde_json, and adding one to the pure crate to read its own art table
 * is a worse trade than twenty bytes an object. `manifest.json` carries the same
 * extents for the client, and the suite asserts the two agree rather than
 * trusting that they do.
 */
export function encodeMasksBin(entries) {
  assertIdsMatchPosition(entries)
  const index = MASKS_HEADER_BYTES + entries.length * MASKS_RECORD_BYTES
  const total = entries.reduce((n, e) => n + e.packed.length, index)
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)
  view.setUint32(0, MASKS_MAGIC, true)
  view.setUint32(4, MASKS_VERSION, true)
  view.setUint32(8, entries.length, true)

  let offset = index
  entries.forEach((e, i) => {
    const at = MASKS_HEADER_BYTES + i * MASKS_RECORD_BYTES
    view.setUint32(at, e.id, true)
    view.setUint16(at + 4, e.w, true)
    view.setUint16(at + 6, e.h, true)
    view.setUint16(at + 8, e.anchorX, true)
    view.setUint16(at + 10, e.anchorY, true)
    view.setUint8(at + 12, categoryCode(e.category))
    view.setUint32(at + 16, offset, true)
    view.setUint32(at + 20, e.packed.length, true)
    buf.set(e.packed, offset)
    offset += e.packed.length
  })
  return buf
}

export function decodeMasksBin(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.byteLength < MASKS_HEADER_BYTES) throw new Error('masks.bin is shorter than its header')
  if (view.getUint32(0, true) !== MASKS_MAGIC) throw new Error('masks.bin has the wrong magic')
  const version = view.getUint32(4, true)
  if (version !== MASKS_VERSION) throw new Error(`masks.bin is version ${version}`)
  const count = view.getUint32(8, true)
  const out = []
  for (let i = 0; i < count; i++) {
    const at = MASKS_HEADER_BYTES + i * MASKS_RECORD_BYTES
    const offset = view.getUint32(at + 16, true)
    const len = view.getUint32(at + 20, true)
    if (offset + len > buf.byteLength) throw new Error(`masks.bin record ${i} runs past the file`)
    out.push({
      id: view.getUint32(at, true),
      w: view.getUint16(at + 4, true),
      h: view.getUint16(at + 6, true),
      anchorX: view.getUint16(at + 8, true),
      anchorY: view.getUint16(at + 10, true),
      category: CATEGORY_ORDER[view.getUint8(at + 12)],
      offset,
      len,
      packed: buf.subarray(offset, offset + len),
    })
  }
  return out
}
