/**
 * T23.03: the arithmetic of the world renderer, apart from three.js so it can be tested.
 *
 * The world space is the mockup's (`mockup-src/kit.js::orthoCam` / `wy`): mask px, x right,
 * **y up**, world y = `H − maskY` where `H` is the mask's height. Phaser's camera and the
 * scene description are y down; this is the one place the flip happens.
 */
import type { ViewRect } from './scene'

/** R14: the full tier is the pictures; the low tier renders the world canvas and its target at half resolution without MSAA (the mockup's `scale 2`). */
export type QualityTier = 'full' | 'low'

/** The world canvas's drawing buffer (and so its post target) as a fraction of the display, per tier. */
export const TIER_SCALE: Record<QualityTier, number> = { full: 1, low: 0.5 }
/** MSAA samples on the half-float target, per tier (`kit.js::post`: `samples: scale === 1 ? 4 : 0`). */
export const TIER_SAMPLES: Record<QualityTier, number> = { full: 4, low: 0 }

export interface OrthoBounds {
  left: number
  right: number
  top: number
  bottom: number
}

/** The ortho camera that shows `view` (y down) of a mask `maskH` rows tall, in y-up world space. */
export function orthoFromView(view: ViewRect, maskH: number): OrthoBounds {
  return { left: view.x, right: view.x + view.w, top: maskH - view.y, bottom: maskH - (view.y + view.h) }
}

/** A mask-px point (y down) in world space (y up): `kit.js::wy`. */
export function toWorld(x: number, y: number, maskH: number): { x: number; y: number } {
  return { x, y: maskH - y }
}

/** The drawing buffer for a canvas shown at `cssW × cssH` on a `dpr` screen: device pixels, at least 1. */
export function bufferSize(cssW: number, cssH: number, dpr: number): { w: number; h: number } {
  return { w: Math.max(1, Math.round(cssW * dpr)), h: Math.max(1, Math.round(cssH * dpr)) }
}

/** `0xRRGGBB` read as **linear** components, the way `e_style.js::hex` does (`setHex(h, LinearSRGBColorSpace)`). */
export function hexLinear(h: number): [number, number, number] {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
}

/**
 * What `OutputPass` does to a linear colour: three's ACES filmic at `exposure`, then the sRGB
 * transfer, as 0–255. A CPU copy of `tonemapping_pars_fragment.glsl.js::ACESFilmicToneMapping`
 * and `colorspace_pars_fragment.glsl.js::sRGBTransferOETF` (three 0.170), so a check can say
 * what the screen must show for a flat linear colour.
 */
export function acesSrgb(rgb: [number, number, number], exposure: number): [number, number, number] {
  const k = exposure / 0.6
  const [r, g, b] = [rgb[0] * k, rgb[1] * k, rgb[2] * k]
  // mat3 columns as written in the GLSL (transposed from source), applied as M * v.
  const i = [
    0.59719 * r + 0.35458 * g + 0.04823 * b,
    0.076 * r + 0.90834 * g + 0.01566 * b,
    0.0284 * r + 0.13383 * g + 0.83777 * b,
  ]
  const fit = (v: number): number => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081)
  const [x, y, z] = [fit(i[0]!), fit(i[1]!), fit(i[2]!)]
  const o = [
    1.60475 * x - 0.53108 * y - 0.07367 * z,
    -0.10208 * x + 1.10813 * y - 0.00605 * z,
    -0.00327 * x - 0.07276 * y + 1.07602 * z,
  ]
  const srgb = (v: number): number => {
    const c = Math.min(1, Math.max(0, v))
    return c <= 0.0031308 ? c * 12.92 : Math.pow(c, 0.41666) * 1.055 - 0.055
  }
  return [Math.round(srgb(o[0]!) * 255), Math.round(srgb(o[1]!) * 255), Math.round(srgb(o[2]!) * 255)]
}
