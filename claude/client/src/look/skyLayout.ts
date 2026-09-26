/**
 * T23.04: where the sky's stepped layers sit — **a pure function of (map seed, camera)**.
 *
 * The mockup lays its layers out on one 1280×720 frame (`e_style.js::bgMaterial`: each layer one
 * shape at a screen position). The game's camera moves over a map several screens wide, so here
 * each layer becomes a **world-anchored parallax band**: the mockup's shape repeated every
 * `period` screen px, each copy's apex nudged by the seed, the band shifted by
 * `−(camera − map centre) × zoom × parallax` — far layers least (R: the task's step 2). The
 * sky's own gradient, horizon glow and haze band ride with the farthest factor
 * (`HORIZON_PARALLAX`); the moons and the stars sit at parallax 0.
 *
 * Seeded from the map seed, so every round differs and every client of one round agrees
 * (they share `welcome`'s seed). No `Math.random`, no clock: two calls with the same inputs
 * give the same layout, which `skyLayout.test.ts` asserts.
 *
 * The look-lab's scenes carry no `parallax`/`period`, so `skyOffsets` answers zero for them and
 * the shader draws the mockup's frame verbatim — that is what `look-sky` compares.
 */
import type { Background, BgLayer, ViewRect } from './scene'

/**
 * Parallax factor per depth, far → near (the mockup's layer order is its depth order). A layer
 * moves `factor` × the terrain's on-screen speed. **Composition, not tuning**: each band about
 * 1.6× the one behind it, so F1's four read as four depths (its nearest, the left pyramid, at
 * about a sixth of the terrain's speed); slots 5–6 continue the series for a scene with more. A
 * factor past ~0.35 starts to read as scenery beside the terrain rather than behind it.
 */
export const LAYER_PARALLAX: readonly number[] = [0.04, 0.07, 0.11, 0.17, 0.24, 0.3]
/** The sky gradient, horizon glow and haze band: the farthest layer's factor, so the haze stays under the far band. */
export const HORIZON_PARALLAX = 0.04
/**
 * A band's repeat, as a multiple of its shape's width at the haze line (`shapeWidth`): 1.3–2.0×,
 * seeded per layer so no two bands line up — so a copy is followed by a gap of a third to a
 * whole shape, and every band has a copy on screen most of the time. Measured: at a flat
 * 1.15–1.65 × the frame, F1's narrow left pyramid (~460 px wide) was off screen at the map's
 * centre on seed 4242, and `look-sky` found no pixels of it.
 */
export const PERIOD_MIN = 1.3
export const PERIOD_SPAN = 0.7
/** How far the seed may move a copy's apex up or down, screen px (the shader's `jitterY`). */
export const APEX_JITTER = 34

/** mulberry32: a small seeded PRNG, the client's render-only one (not simulation — CLAUDE.md's ChaCha rule is game-core's). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A layer's width at its haze line (`fade[1]`, else the horizon), screen px: where the mockup's
 * shape fades into the haze band and stops reading as a shape. Arc: its diameter.
 */
export function shapeWidth(l: BgLayer, horizon: number): number {
  if (l.shape === 'arc') return 2 * (l.r ?? 1)
  const base = l.fade?.[1] ?? horizon
  return 2 * Math.max(0, base - l.y) / (l.slope ?? 1) + 2 * (l.top ?? 0)
}

/**
 * The game's sky for map seed `seed`: `template`'s palette, shapes, steps, softness, fades and
 * moons (F1 until T23.11 blends it with F5), with each layer made a seeded parallax band —
 * `period` and phase (`x`) from the seed, `seed` the per-copy apex jitter's key, `parallax` its
 * depth's factor. The frame the layout is authored in is the camera at the map's centre.
 */
export function gameSky(seed: number, template: Background): Background {
  const r = rng(seed ^ 0x5a17)
  const layers: BgLayer[] = template.layers.slice(0, LAYER_PARALLAX.length).map((l, i) => {
    const period = Math.max(1, Math.round(shapeWidth(l, template.horizon) * (PERIOD_MIN + PERIOD_SPAN * r())))
    return {
      ...l,
      x: Math.round(r() * period),
      period,
      seed: Math.floor(r() * 997) + 1,
      parallax: LAYER_PARALLAX[i]!,
    }
  })
  return { ...template, layers, parallax: HORIZON_PARALLAX }
}

/** Screen px a band is moved by: x right, y down. */
export type Offset = [number, number]

/**
 * Each layer's screen offset, and the horizon's, for camera `view` (world px, y down) over a map
 * `world` px, drawn into a frame `frameW` px wide (Phaser's game width — R18). Zero at the map's
 * centre and for a layer with no `parallax` (the look-lab's).
 */
export function skyOffsets(
  bg: Background,
  view: ViewRect,
  world: { w: number; h: number },
  frameW: number,
): { layers: Offset[]; horizon: Offset } {
  const zoom = frameW / view.w
  const dx = view.x + view.w / 2 - world.w / 2
  const dy = view.y + view.h / 2 - world.h / 2
  // `0 − …`, not `−…`: a centred camera gives +0, not −0.
  const at = (f: number): Offset => [0 - dx * zoom * f, 0 - dy * zoom * f]
  return { layers: bg.layers.map((l) => at(l.parallax ?? 0)), horizon: at(bg.parallax ?? 0) }
}

/**
 * T23.04B (R21): world px the camera's centre may sit past the map's clamp (`cameraRig`'s bounds)
 * and still find baked sky — a margin for shake and a rig overshoot. Past it the bake's edge
 * texel is repeated (clamp to edge), which reads as the band continuing, not as a hole.
 */
export const SKY_PAN_SLACK = 64

/** A baked texture's footprint in its layer's own coordinates, frame px: top-left and size. */
export interface Extent {
  org: [number, number]
  ext: [number, number]
}

/**
 * T23.04B (R21): how much of each band to bake so that **every** camera in the map finds it —
 * the frame plus, each side, the largest offset `skyOffsets` can give that band
 * (`(world − view)/2 + SKY_PAN_SLACK` × zoom × factor) and one texel for the linear filter's
 * neighbour. `texel` is frame px per baked texel (1 full, 2 low): origins and sizes are whole
 * texels, so with no offset a screen pixel's centre lands on a texel's centre and the sample is
 * the value the shader would have computed there. A layer with no parallax (the look-lab's) is
 * baked at exactly the frame.
 */
export function bakeExtents(
  bg: Background,
  view: ViewRect,
  world: { w: number; h: number },
  frame: [number, number],
  texel: number,
): { layers: Extent[]; horizon: Extent } {
  const zoom = frame[0] / view.w
  const dx = Math.max(0, (world.w - view.w) / 2) + SKY_PAN_SLACK
  const dy = Math.max(0, (world.h - view.h) / 2) + SKY_PAN_SLACK
  const up = (v: number): number => Math.ceil(v / texel) * texel
  const at = (f: number, clear = -Infinity): Extent => {
    const mx = f ? up(dx * zoom * f + texel) : 0
    const my = f ? up(dy * zoom * f + texel) : 0
    const top = Math.max(0 - my, Math.floor(clear / texel) * texel)
    return { org: [0 - mx, top + 0], ext: [frame[0] + 2 * mx, frame[1] + my - top] }
  }
  return { layers: bg.layers.map((l) => at(l.parallax ?? 0, clearAbove(l, texel))), horizon: at(bg.parallax ?? 0) }
}

/**
 * The band-space row above which a layer is transparent: no copy's edge rises above its apex
 * (`A.y`, less `APEX_JITTER` when repeated — every shape's edge is `≥` its apex, the staircase only
 * rounds down-screen), and the edge's smoothstep starts `soft` above it; one texel more for the
 * filter. The bake starts there and clamp-to-edge repeats that transparent row above it.
 */
export function clearAbove(l: BgLayer, texel: number): number {
  return l.y - (l.period ? APEX_JITTER : 0) - (l.soft ?? 1) - texel
}

/**
 * T23.04B (R21): the offsets a frame draws — `skyOffsets` rounded to whole baked texels (`texel`
 * frame px: 1 full, 2 low). The bakes are sampled nearest, so a snapped frame is exactly
 * `bgMaterial` evaluated at the snapped offset, texel for texel; a band moves in whole buffer
 * pixels, as Phaser's `roundPixels` moves the terrain. `+ 0`: never `−0`.
 */
export function snapOffsets(o: { layers: Offset[]; horizon: Offset }, texel: number): { layers: Offset[]; horizon: Offset } {
  const s = (v: number): number => Math.round(v / texel) * texel + 0
  return { layers: o.layers.map(([x, y]) => [s(x), s(y)]), horizon: [s(o.horizon[0]), s(o.horizon[1])] }
}
