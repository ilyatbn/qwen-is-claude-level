/**
 * T21.31 — the clouds, the pure half (§A8: Phaser cannot load under vitest).
 *
 * Reported from play: *"the clouds you created are bad and buggy. they do not move
 * and are honestly too large. should have smaller clouds in different shapes and
 * sizes and colors."* What he was looking at was not a cloud at all — the far ridge,
 * hazed toward the sky — because the only clouds left (`CLOUD_FRAGMENT`, T21.18)
 * needed WebGL and High Quality, and he has neither.
 *
 * So these are **world objects**, drawn as filled circles that every renderer has:
 *
 * - **Many, small, varied.** One per `CLOUD_SPACING` of map width, each with its own
 *   width, aspect, lobe count (the silhouette), tint, opacity and speed — all drawn
 *   from the map seed, so two players in one round see one sky.
 * - **Drifting with the wind**, each at its own speed, on the round clock.
 * - **Above the rock, never in it.** A cloud floats `altitude` above the *sky floor*:
 *   the highest rock within `CLOUD_FLOOR_WINDOW`, smoothed. `skyFloor` says what that
 *   guarantees and why the window must exceed the widest cloud. The terrain only ever
 *   loses rock, so a floor measured once per map stays true for the round.
 *
 * World-anchored rather than parallaxed, because T21.31's rain falls from under a
 * cloud: a cloud that slid with the camera would drag its rain across the ground.
 */

import type { C } from '../core'

type K = ReturnType<typeof C>

/** The constants this module reads, so a test can hand it `C()` or a variant of it. */
export type CloudTuning = Pick<
  K,
  | 'CLOUD_SPACING'
  | 'CLOUD_W_MIN'
  | 'CLOUD_W_MAX'
  | 'CLOUD_ASPECT_MIN'
  | 'CLOUD_ASPECT_MAX'
  | 'CLOUD_LOBES_MIN'
  | 'CLOUD_LOBES_MAX'
  | 'CLOUD_SPEED_MIN'
  | 'CLOUD_SPEED_MAX'
  | 'CLOUD_BRIGHT_MIN'
  | 'CLOUD_BRIGHT_MAX'
  | 'CLOUD_TINT_COOL'
  | 'CLOUD_TINT_WARM'
  | 'CLOUD_OPACITY_MIN'
  | 'CLOUD_OPACITY_MAX'
  | 'CLOUD_ALTITUDE_MIN'
  | 'CLOUD_ALTITUDE_MAX'
  | 'CLOUD_DRIFT'
  | 'CLOUD_WIND_GAIN'
  | 'CLOUD_FLOOR_WINDOW'
  | 'CLOUD_FLOOR_SMOOTH'
  | 'CLOUD_TOP_MIN'
>

/** One circle of a cloud's silhouette, relative to the cloud's top-left corner. */
export interface Lobe {
  cx: number
  cy: number
  r: number
}

export interface Cloud {
  /** Centre x at clock 0, world px. */
  x0: number
  w: number
  h: number
  /** Every lobe lies inside the `w` x `h` box — `lobes` builds them that way. */
  lobes: Lobe[]
  /** The cloud's own colour, 0xRRGGBB, multiplied into the phase's tint. */
  tint: number
  /** Multiple of the phase's opacity. */
  opacity: number
  /** Multiple of the drift speed. */
  speed: number
  /** Base above the sky floor, world px. */
  altitude: number
}

/** Where a cloud is at one moment, world px. `visible` is false when it cannot fit. */
export interface CloudBox {
  index: number
  left: number
  top: number
  w: number
  h: number
  visible: boolean
}

/** mulberry32: small, seedable, and the same in every browser. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function mix(a: number, b: number, t: number): number {
  const ch = (sh: number) => Math.round(lerp((a >> sh) & 255, (b >> sh) & 255, t)) & 255
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** Channel-wise multiply of two 0xRRGGBB colours — a tint applied to a tint. */
export function mulColor(a: number, b: number): number {
  const ch = (sh: number) => Math.round((((a >> sh) & 255) * ((b >> sh) & 255)) / 255)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/**
 * A silhouette: `n` circles along the width, biggest in the middle, resting on a
 * flat base. Each radius is capped at half the height, so every lobe is inside the
 * box — which is what lets the floor guarantee speak about the box alone.
 */
function lobes(r: () => number, w: number, h: number, n: number): Lobe[] {
  const out: Lobe[] = []
  for (let j = 0; j < n; j++) {
    const fx = Math.min(1, Math.max(0, (j + 0.5) / n + (r() - 0.5) * (0.5 / n)))
    const hump = Math.sin(Math.PI * fx)
    const rad = Math.min(w / 2, (h / 2) * (0.5 + 0.5 * hump) * lerp(0.8, 1, r()))
    const cx = Math.min(w - rad, Math.max(rad, fx * w))
    // The edge lobes lift a little off the base, so the underside is not a ruler.
    const lift = (1 - hump) * h * 0.15 * r()
    const cy = Math.max(rad, h - rad - lift)
    out.push({ cx, cy, r: rad })
  }
  return out
}

/** The round's clouds, from the map seed. The same seed is the same sky. */
export function cloudField(seed: number, mapW: number, k: CloudTuning): Cloud[] {
  const r = rng((seed >>> 0) ^ 0x5eed_c10d)
  const count = Math.max(1, Math.floor(mapW / k.CLOUD_SPACING))
  const cell = mapW / count
  const out: Cloud[] = []
  for (let i = 0; i < count; i++) {
    const x0 = (i + 0.5 + (r() - 0.5) * 0.8) * cell
    // Skewed toward small: a sky of mostly puffs and the odd bank.
    const sizeT = Math.pow(r(), 1.6)
    const w = lerp(k.CLOUD_W_MIN, k.CLOUD_W_MAX, sizeT)
    const h = w * lerp(k.CLOUD_ASPECT_MIN, k.CLOUD_ASPECT_MAX, r())
    // Longer clouds get more lobes, with a seeded spread so equal widths still differ.
    const nT = Math.min(1, sizeT * 0.7 + r() * 0.3)
    const n = Math.round(lerp(k.CLOUD_LOBES_MIN, k.CLOUD_LOBES_MAX, nT))
    const shape = lobes(r, w, h, n)
    const tint = mulColor(
      mix(k.CLOUD_TINT_COOL, k.CLOUD_TINT_WARM, r()),
      mix(0x000000, 0xffffff, lerp(k.CLOUD_BRIGHT_MIN, k.CLOUD_BRIGHT_MAX, r())),
    )
    out.push({
      x0,
      w,
      h,
      lobes: shape,
      tint,
      opacity: lerp(k.CLOUD_OPACITY_MIN, k.CLOUD_OPACITY_MAX, r()),
      speed: lerp(k.CLOUD_SPEED_MIN, k.CLOUD_SPEED_MAX, r()),
      altitude: lerp(k.CLOUD_ALTITUDE_MIN, k.CLOUD_ALTITUDE_MAX, r()),
    })
  }
  return out
}

/**
 * A cloud's horizontal speed, world px/s: its own multiple of the drift, in the
 * wind's direction, faster the harder the wind. A calm round still drifts (rightward),
 * because a cloud that does not move was half the owner's report.
 */
export function cloudVelocity(cloud: Cloud, wind: number, k: CloudTuning): number {
  const dir = wind < 0 ? -1 : 1
  return dir * (k.CLOUD_DRIFT + Math.abs(wind) * k.CLOUD_WIND_GAIN) * cloud.speed
}

/**
 * Centre x at clock `t`. Wraps over the map plus a widest cloud either side, so a
 * cloud leaves past one wall wholly before it re-enters past the other.
 */
export function cloudCentreX(cloud: Cloud, t: number, wind: number, mapW: number, k: CloudTuning): number {
  const span = mapW + 2 * k.CLOUD_W_MAX
  const raw = cloud.x0 + cloudVelocity(cloud, wind, k) * t + k.CLOUD_W_MAX
  return (((raw % span) + span) % span) - k.CLOUD_W_MAX
}

/** The sky floor: per sampled column, the lowest y a cloud's base may reach. */
export interface SkyFloor {
  step: number
  y: Float32Array
}

/**
 * The first rock from the top, per column `step` px apart; `height` where there is none.
 *
 * **Every row is read**, only columns are stepped: a spire narrower than `step` could
 * slip between two columns, and generated rock is never that thin (carving only removes).
 */
export function columnTops(
  width: number,
  height: number,
  step: number,
  solidAt: (x: number, y: number) => boolean,
): Float32Array {
  const n = Math.floor((width - 1) / step) + 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = i * step
    let y = 0
    while (y < height && !solidAt(x, y)) y++
    out[i] = y
  }
  return out
}

/**
 * The floor under which no cloud may sink, from `columnTops`.
 *
 * The highest rock within `CLOUD_FLOOR_WINDOW / 2` of each column, then averaged over
 * `CLOUD_FLOOR_SMOOTH`. **What that guarantees**: every value in the average is at
 * least as high as the rock within `(WINDOW - SMOOTH) / 2` of the column, so the
 * average is too — and interpolating between two columns costs one `step` of that
 * reach. `constants.rs` asserts the reach covers half the widest cloud.
 */
export function skyFloor(tops: Float32Array, step: number, k: CloudTuning): SkyFloor {
  const n = tops.length
  const half = Math.round(k.CLOUD_FLOOR_WINDOW / 2 / step)
  const peak = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let m = Infinity
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) m = Math.min(m, tops[j]!)
    peak[i] = m
  }
  const sh = Math.round(k.CLOUD_FLOOR_SMOOTH / 2 / step)
  const y = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    let cnt = 0
    for (let j = Math.max(0, i - sh); j <= Math.min(n - 1, i + sh); j++) {
      sum += peak[j]!
      cnt++
    }
    y[i] = sum / cnt
  }
  return { step, y }
}

/** A floor with no ground under it — the title screen's, which has no map. */
export function flatFloor(y: number): SkyFloor {
  return { step: 1, y: Float32Array.of(y) }
}

/** The floor at world `x`, interpolated and clamped to the sampled range. */
export function floorAt(floor: SkyFloor, x: number): number {
  const n = floor.y.length
  const f = Math.min(n - 1, Math.max(0, x / floor.step))
  const i = Math.floor(f)
  const j = Math.min(n - 1, i + 1)
  return lerp(floor.y[i]!, floor.y[j]!, f - i)
}

/**
 * Where cloud `index` is at clock `t`.
 *
 * Its base sits `altitude` above the floor under its centre, raised if that would
 * push its top past `CLOUD_TOP_MIN`. **If raising it cannot keep `CLOUD_ALTITUDE_MIN`
 * of air under it, it is not drawn** — a sky with one cloud fewer is better than a
 * cloud in a mountain.
 */
export function placeCloud(
  cloud: Cloud,
  index: number,
  t: number,
  wind: number,
  mapW: number,
  floor: SkyFloor,
  k: CloudTuning,
): CloudBox {
  const cx = cloudCentreX(cloud, t, wind, mapW, k)
  const fy = floorAt(floor, cx)
  let top = fy - cloud.altitude - cloud.h
  if (top < k.CLOUD_TOP_MIN) top = k.CLOUD_TOP_MIN
  const visible = top + cloud.h <= fy - k.CLOUD_ALTITUDE_MIN
  return { index, left: cx - cloud.w / 2, top, w: cloud.w, h: cloud.h, visible }
}
