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

/**
 * T23.03B / R18: the world canvas's drawing buffer — **Phaser's game resolution** (`gameW × gameH`,
 * the size of Phaser's own drawing buffer) times the tier's scale, at least 1. Never the CSS box
 * times `devicePixelRatio`: the pictures are drawn at `setPixelRatio(1)` on 1280×720, so an effect
 * sized in buffer px (bloom radius, MSAA, blur taps) only matches them at this size. Equivalently
 * R18's pixel ratio `gameW / cssW × TIER_SCALE` on a canvas shown `cssW` wide — computed as the
 * buffer itself, so a fractional CSS width cannot floor 1280 to 1279.
 */
export function bufferFor(gameW: number, gameH: number, tier: QualityTier): { w: number; h: number } {
  const k = TIER_SCALE[tier]
  return { w: Math.max(1, Math.round(gameW * k)), h: Math.max(1, Math.round(gameH * k)) }
}

/**
 * T23.03B (F1): the one definition of "the same view". The redraw skip uses it, and
 * `world-canvas` asserts every frame that Phaser's `worldView` and the view last drawn pass it —
 * a skip that forgot one field (the review planted `y`) then shows as a frame where they differ.
 */
export function sameView(a: ViewRect | null, b: ViewRect | null): boolean {
  return a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/**
 * T23.03B (F3): must this frame be drawn? An unchanged view of an unchanged, **unanimated**
 * scene is an unchanged picture, and the canvas keeps showing the last one (measured: drawing
 * every frame cost SwiftShader 60 → 51 fps in a match). Anything animated — T23.04's stars —
 * draws every frame, or it freezes.
 */
export function mustDraw(s: { dirty: boolean; animated: boolean; last: ViewRect | null; view: ViewRect }): boolean {
  return s.dirty || s.animated || !sameView(s.last, s.view)
}

/** `0xRRGGBB` read as **linear** components, the way `e_style.js::hex` does (`setHex(h, LinearSRGBColorSpace)`). */
export function hexLinear(h: number): [number, number, number] {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
}
