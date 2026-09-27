/**
 * T23.12/T23.13: `f_kit.js::dominant` and `lit()`'s per-pass numbers, ported verbatim — the CPU half of the rim
 * light, run per actor per frame against the scene's light list (T23.09's effect lights in the game).
 */
import type { Light, Moon } from '../scene'

export interface Key {
  /** Unit direction from the actor to the key light, mask px (y down). */
  dx: number
  dy: number
  rgb: string
  w: number
}

/** `f_kit.js::dominant(lights, x, y, moon)`: the strongest light within reach of (x, y), else the moon. */
export function dominant(lights: readonly Light[], x: number, y: number, moon: Moon): Key {
  let best: Key = { dx: moon.dx, dy: moon.dy, rgb: moon.rgb, w: moon.w }
  for (const l of lights) {
    const d = Math.hypot(l.x - x, l.y - y)
    if (d > l.r) continue
    const w = l.i * (1 - d / l.r) ** 2 * 1.6
    if (w > best.w) best = { dx: (l.x - x) / (d || 1), dy: (l.y - y) / (d || 1), rgb: l.rgb, w }
  }
  return best
}

/** What `lit()` derives from the key for one actor of `size`: its passes' offsets (px) and alphas. */
export interface Passes {
  /** The rim passes' colour, 0–1 sRGB, and alpha `a` (`min(1, 0.45 + w·0.5)`). */
  rim: [number, number, number]
  a: number
  /** Rim pass offset (`L·o`, o = 1.15·size); the far rim sits at 1.7× it. */
  off: [number, number]
  /** The cool fill's offset (`−L·0.7·size`) and colour (`moon.fill`, alpha 0.35). */
  fillOff: [number, number]
  fill: [number, number, number]
}

const rgb01 = (s: string): [number, number, number] => {
  const [r = 0, g = 0, b = 0] = s.split(',').map((v) => Number(v) / 255)
  return [r, g, b]
}

export function passes(lights: readonly Light[], moon: Moon, x: number, y: number, size: number): Passes {
  const L = dominant(lights, x, y - 14 * size, moon)
  const o = 1.15 * size
  return {
    rim: rgb01(L.rgb),
    a: Math.min(1, 0.45 + L.w * 0.5),
    off: [L.dx * o, L.dy * o],
    fillOff: [-L.dx * 0.7 * size, -L.dy * 0.7 * size],
    fill: rgb01(moon.fill),
  }
}
