/**
 * T23.31 (docs/78 §A7): the volcanic world's **drifting embers** — F2's `extra2d: 'embers'` (`f_scene.js`: 90 sparks,
 * `S.glow(g, x, y, r·4, '255,120,40', 0.5)` and a pale `r × r` core, `r` 0.6–2.0, over `y` 200–720 of the frame).
 *
 * Two placements, one look:
 * - **The look-lab's still scene** (`mockupEmbers`): the mockup's own sparks — its Park–Miller generator from seed 3,
 *   in its draw order — in the scene's camera frame, so F2 in the lab is F2's picture.
 * - **The game** (`ambientEmbers`): a world-anchored field, a pure function of (view, time): cells of `CELL` world px
 *   each hold `PER_CELL` sparks at hashed places, rising at their own speeds and swaying, fading in and out over a
 *   rise of `RISE` px — so a pan shows the same sparks, every client of a round sees the same sky of them, and nothing
 *   is kept between frames. Density matches F2's (90 over the lower 1280 × 520 of the frame ≈ 0.6 per `CELL`²/1000).
 *
 * Drawn as the effects layer's soft sprites (`fx/kit.ts`), additive in the HDR scene, as `fx/hazards.ts` draws a
 * vent's embers — a glow `r·8` across at half strength and a small hot core. **Cosmetic**: nothing reads it.
 */
import type { FxFrame } from './fx/kit'
import { rgbToLinear } from './fx/kit'
import type { ViewRect } from './scene'

const GLOW = rgbToLinear('255,120,40')
const CORE = rgbToLinear('255,200,120')

/** `f_scene.js`'s ember count and band (frame px). */
export const MOCKUP_EMBERS = 90
const BAND_TOP = 200
const BAND_H = 520

/** One spark: centre, the mockup's `r`, and its alpha share (1 in the mockup; the game's fade in and out). */
export interface Spark {
  x: number
  y: number
  r: number
  a: number
}

/** The mockup's 90 sparks, frame px (its generator, `q = q · 16807 mod 2³¹ − 1`, from 3; x, y, r in its order). */
export function mockupEmbers(): Spark[] {
  let q = 3
  const rnd = (): number => (q = (q * 16807) % 2147483647) / 2147483647
  const out: Spark[] = []
  for (let i = 0; i < MOCKUP_EMBERS; i++) {
    const x = rnd() * 1280
    const y = BAND_TOP + rnd() * BAND_H
    const r = 0.6 + rnd() * 1.4
    out.push({ x, y, r, a: 1 })
  }
  return out
}

/** World px a field cell spans (square). */
export const CELL = 256
/** Sparks per cell: F2's density (90 in 1280 × 520 px) — 90 / (1280 · 520) · 256² ≈ 8.9. */
export const PER_CELL = 9
/** How far a spark rises over its life, world px, and how fast (px/s, the slowest; each adds up to the same again). */
export const RISE = 220
export const SPEED = 14
/** Sideways sway, px, and its rate (rad/s). */
const SWAY = 10
const SWAY_RATE = 0.9

/** A small integer hash to [0, 1) — the field's places (render-only; the simulation's RNG rule is game-core's). */
function h01(x: number, y: number, s: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 144665)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * The game's sparks in `view` (world px, y down) at `seconds`, plus a cell's margin so a spark never pops at the
 * frame's edge. Each rises `RISE` px from a hashed start and starts again; its alpha rises and falls with its life.
 */
export function ambientEmbers(view: ViewRect, seconds: number): Spark[] {
  const out: Spark[] = []
  const cx0 = Math.floor(view.x / CELL) - 1
  const cx1 = Math.floor((view.x + view.w) / CELL) + 1
  const cy0 = Math.floor(view.y / CELL) - 1
  const cy1 = Math.floor((view.y + view.h + RISE) / CELL) + 1
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let k = 0; k < PER_CELL; k++) {
        const speed = SPEED * (1 + h01(cx, cy, k * 4 + 3))
        const life = RISE / speed
        const u = (seconds / life + h01(cx, cy, k * 4 + 2)) % 1
        const x = (cx + h01(cx, cy, k * 4)) * CELL + SWAY * Math.sin(seconds * SWAY_RATE + k * 1.7 + cx)
        const y = (cy + h01(cx, cy, k * 4 + 1)) * CELL - u * RISE
        if (x < view.x - 8 || x > view.x + view.w + 8 || y < view.y - 8 || y > view.y + view.h + 8) continue
        const a = Math.sin(Math.PI * u)
        out.push({ x, y, r: 0.6 + 1.4 * h01(cx, cy, k * 4 + 5), a })
      }
    }
  }
  return out
}

/** The sparks into `out`'s soft sprites (mask px): a glow and a core, as `fx/hazards.ts::emberParticleFx`. */
export function emberSprites(out: FxFrame, sparks: readonly Spark[]): void {
  for (const s of sparks) {
    if (!(s.a > 0)) continue
    out.soft.push({ x: s.x, y: s.y, size: s.r * 8, color: [GLOW[0] * 2, GLOW[1] * 2, GLOW[2] * 2], alpha: 0.5 * s.a, tex: 0, rot: 0, under: false })
    out.soft.push({ x: s.x, y: s.y, size: s.r * 2.2, color: [CORE[0] * 3, CORE[1] * 3, CORE[2] * 3], alpha: 0.9 * s.a, tex: 0, rot: 0, under: false })
  }
}
