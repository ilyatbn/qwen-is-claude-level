/** Types for `gate-sprite.mjs` (T21.12). The implementation is the `.mjs`. */

export interface PortalRegion {
  cx: number
  cy: number
  rx: number
  ry: number
}

export interface FillBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface AlphaStats {
  clear: number
  opaque: number
  partial: number
}

export function isBackdrop(r: number, g: number, b: number, threshold: number): boolean

export function clearConnected(
  rgba: Uint8Array,
  w: number,
  h: number,
  seeds: ReadonlyArray<readonly [number, number]>,
  threshold: number,
): { cleared: number; box: FillBox | null }

export function borderSeeds(w: number, h: number): Array<[number, number]>

export function cutBackdrop(
  rgba: Uint8Array,
  w: number,
  h: number,
  opts?: { threshold?: number; interiorSeed?: readonly [number, number] },
): { outside: number; interior: number; portal: PortalRegion | null }

export function downscaleRgba(
  rgba: Uint8Array,
  w: number,
  h: number,
  dstW: number,
  dstH: number,
): Uint8Array

export function portalLooksLikeARing(
  portal: PortalRegion | null,
  opts?: { minRadius?: number; maxOffCentre?: number },
): { ok: boolean; why: string }

export function alphaStats(rgba: ArrayLike<number>): AlphaStats
