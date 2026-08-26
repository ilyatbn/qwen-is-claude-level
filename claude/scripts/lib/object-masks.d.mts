export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface MaskEntry {
  id: number
  key?: string
  w: number
  h: number
  anchorX: number
  anchorY: number
  packed: Uint8Array
}

export interface MaskRecord {
  id: number
  w: number
  h: number
  anchorX: number
  anchorY: number
  offset: number
  len: number
  packed: Uint8Array
}

export declare const MASKS_MAGIC: number
export declare const MASKS_VERSION: number
export declare const MASKS_HEADER_BYTES: number
export declare const MASKS_RECORD_BYTES: number

export declare function thresholdAlpha(
  rgba: Uint8Array,
  w: number,
  h: number,
  threshold: number,
): Uint8Array
export declare function opaqueBounds(bits: Uint8Array, w: number, h: number): Box
export declare function crop(bits: Uint8Array, w: number, h: number, box: Box): Uint8Array
export declare function cropRgba(rgba: Uint8Array, w: number, h: number, box: Box): Uint8Array
export declare function scaleNearest(
  bits: Uint8Array,
  w: number,
  h: number,
  dstW: number,
  dstH: number,
): Uint8Array
export declare function scaleRgbaNearest(
  rgba: Uint8Array,
  w: number,
  h: number,
  dstW: number,
  dstH: number,
): Uint8Array
export interface Rational {
  num: number
  den: number
}

export declare function gcd(a: number, b: number): number
export declare function rationalFromNumber(x: number): Rational
export declare function reduceRational(factor: Rational): Rational
export declare function packFactor(targetPx: number, heights: readonly number[]): Rational
export declare function divRound(a: number, b: number): number
export declare function scaleFor(factor: Rational, bounds: Box): { w: number; h: number }
export declare function packBits(bits: Uint8Array, w: number, h: number): Uint8Array
export declare function unpackBits(packed: Uint8Array, w: number, h: number): Uint8Array
export declare function packedLength(w: number, h: number): number
export declare function popcount(packed: Uint8Array): number
export declare function assertIdsMatchPosition<T extends { id: number; key?: string }>(
  entries: readonly T[],
): readonly T[]
export declare function encodeMasksBin(entries: readonly MaskEntry[]): Uint8Array
export declare function decodeMasksBin(buf: Uint8Array): MaskRecord[]
