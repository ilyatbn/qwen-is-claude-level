/**
 * T23.07: which point lights the terrain shader gets this frame, and in what form.
 *
 * The mockup's `kit.js::terrainMaterial` has 10 uniform slots (`MAX_PL`) and every F scene fills at
 * most 10. The game will have more (T23.09: every muzzle, plume and blast is a light), so the slots go
 * up to `TERRAIN_LIGHTS` and the list is **culled to the view and sorted** (research § 1): a light
 * whose circle misses the view lights no drawn pixel and is dropped; the rest rank by intensity ×
 * on-screen coverage (the area of its circle's bounding box inside the view — what it can light), and
 * the top `TERRAIN_LIGHTS` are kept, **in their input order** (the sum is order-sensitive in the last
 * float bit; keeping the scene's order keeps a ≤ 16-light scene exactly the mockup's sum).
 *
 * Colour is the mockup's: `f_kit.js::toLin` (`(v / 255) ^ 2.2`, not the sRGB curve) × `i`.
 */
import type { Light, ViewRect } from './scene'

/** Uniform slots in the terrain shader (research § 1: 16–24; the mockup's 10 plus headroom). */
export const TERRAIN_LIGHTS = 16
/**
 * T23.18B: the low tier's slots — the mockup's own `MAX_PL` (10), so every F scene still gets all its lights there.
 * SwiftShader runs the light loops to their bound whatever the count, so the bound is the cost: measured (frozen
 * sandbox, 16 lights in view, `drawCost`) 12.6–13.5 ms a frame at 16, 11.6 at 8. Past 10 in view the low tier keeps
 * the strongest 10 (combat lights first — `pickLights`).
 */
export const TERRAIN_LIGHTS_LOW = 10

/** `f_kit.js::toLin`. */
export function toLin(rgb: string): [number, number, number] {
  const p = rgb.split(',').map((v) => Math.pow(Number(v) / 255, 2.2))
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]
}

/** The area of the light's circle's bounding box inside `view`, px² (0: it cannot light the view). */
export function coverage(l: Light, view: ViewRect): number {
  // Nearest point of the view to the light: a circle that misses the rect lights nothing drawn.
  const nx = Math.min(Math.max(l.x, view.x), view.x + view.w)
  const ny = Math.min(Math.max(l.y, view.y), view.y + view.h)
  if (Math.hypot(l.x - nx, l.y - ny) >= l.r) return 0
  const w = Math.min(l.x + l.r, view.x + view.w) - Math.max(l.x - l.r, view.x)
  const h = Math.min(l.y + l.r, view.y + view.h) - Math.max(l.y - l.r, view.y)
  return Math.max(0, w) * Math.max(0, h)
}

/**
 * The lights to upload: culled to `view`, the `max` strongest by intensity × coverage, in input order. T23.18B: when
 * they do not all fit, **combat lights rank before the map's standing ones** (`Light.fixed`: gates, crystals) — a
 * blast, rocket or muzzle only partly in view scored below a whole gate's circle and lost its slot to it, so the
 * fight went dark while the furniture stayed lit.
 */
export function pickLights(lights: readonly Light[], view: ViewRect, max = TERRAIN_LIGHTS): Light[] {
  const scored = lights
    .map((l, k) => ({ l, k, s: l.i * coverage(l, view) }))
    .filter((e) => e.s > 0)
  if (scored.length > max) {
    scored.sort((a, b) => Number(!!a.l.fixed) - Number(!!b.l.fixed) || b.s - a.s || a.k - b.k)
    scored.length = max
  }
  return scored.sort((a, b) => a.k - b.k).map((e) => e.l)
}
