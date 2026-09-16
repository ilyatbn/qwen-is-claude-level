/** Types for `build-gate-sprite.mjs` (T21.12). The implementation is the `.mjs`. */
import type { RustConstants } from './lib/rust-constants.d.mts'

export declare const IMAGE_KEY: string
export declare const IMAGE_PATH: string

/**
 * The sprite's target size, derived from `PAD_W`.
 *
 * Exported so a test can pin the committed artifact against the builder's own
 * arithmetic instead of carrying a second copy of `PAD_ART_W`'s use.
 */
export declare function targetSize(
  srcW: number,
  srcH: number,
  table?: RustConstants,
): { w: number; h: number }
