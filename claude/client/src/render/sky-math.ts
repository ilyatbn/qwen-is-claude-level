/**
 * The pure half of the sky (§A8): cycle phase, gradient keyframes, sun and moon
 * positions, stars.
 *
 * `docs/70-amendments-v2.md` §A4. The sky is how you tell the time of day without
 * looking at a clock, which is the whole reason it stopped being a flat colour.
 *
 * `darkness` — the gameplay-facing scalar — is **not** computed here. It stays
 * server-authoritative exactly as `docs/14-daynight-visibility.md` §1 specifies;
 * this file is presentation only.
 */

export type SkyPhase = 'morning' | 'day' | 'afternoon' | 'evening' | 'night' | 'dawn'

/** One full day, in seconds. `DAY_DURATION + NIGHT_DURATION`. */
export const CYCLE_LENGTH = 120

/** Phase boundaries, from §A4. Upper bound exclusive. */
const PHASES: Array<[SkyPhase, number, number]> = [
  ['morning', 0.0, 0.15],
  ['day', 0.15, 0.4],
  ['afternoon', 0.4, 0.5],
  ['evening', 0.5, 0.62],
  ['night', 0.62, 0.9],
  ['dawn', 0.9, 1.0],
]

/** Gradient keyframes, from §A4. */
const KEYFRAMES: Array<[number, number, number]> = [
  [0.0, 0x1b2a5e, 0xf2a15c],
  [0.12, 0x3f7fd0, 0xbfe3f5],
  [0.3, 0x2f7fd8, 0xa8d8f0],
  [0.45, 0x3a6fb8, 0xf0c07a],
  [0.55, 0x4a2c6b, 0xe2723b],
  [0.64, 0x221041, 0x6b2f5c],
  [0.78, 0x030616, 0x0d1a3a],
  [0.92, 0x050a1c, 0x10204a],
  // §A4's table jumped straight from here to the sunrise at 0.0, which put the
  // whole of dawn into 9 seconds and produced a visible step in the gradient. This
  // keyframe is an addition to the doc, recorded in §A4.
  [0.96, 0x101a44, 0x6a4a6e],
]

/** Position in the day, wrapped to `[0, 1)`. */
export function cycleU(roundTime: number): number {
  const u = (roundTime / CYCLE_LENGTH) % 1
  return u < 0 ? u + 1 : u
}

export function skyPhase(u: number): SkyPhase {
  const t = cycleU(u * CYCLE_LENGTH)
  for (const [name, lo, hi] of PHASES) {
    if (t >= lo && t < hi) return name
  }
  return 'dawn'
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Interpolate a packed RGB pair in **linear** space.
 *
 * Mixing sRGB bytes directly makes every transition swing through a muddy
 * desaturated middle — most visible on the dusk keyframes, which is exactly where
 * the sky is supposed to look best.
 */
function mixChannel(a: number, b: number, t: number): number {
  const al = Math.pow(a / 255, 2.2)
  const bl = Math.pow(b / 255, 2.2)
  return Math.round(Math.pow(lerp(al, bl, t), 1 / 2.2) * 255)
}

function mixColor(a: number, b: number, t: number): number {
  const r = mixChannel((a >> 16) & 255, (b >> 16) & 255, t)
  const g = mixChannel((a >> 8) & 255, (b >> 8) & 255, t)
  const bl = mixChannel(a & 255, b & 255, t)
  return (r << 16) | (g << 8) | bl
}

/** Top and bottom sky colours at cycle position `u`, wrapping at 1.0. */
export function skyColors(u: number): { top: number; bottom: number } {
  const t = cycleU(u * CYCLE_LENGTH)

  let i = KEYFRAMES.length - 1
  for (let k = 0; k < KEYFRAMES.length; k++) {
    if (t >= KEYFRAMES[k]![0]) i = k
    else break
  }
  const [u0, top0, bot0] = KEYFRAMES[i]!
  const next = (i + 1) % KEYFRAMES.length
  const [u1raw, top1, bot1] = KEYFRAMES[next]!
  // The last segment wraps past 1.0 back to the first keyframe.
  const u1 = next === 0 ? u1raw + 1 : u1raw
  const tt = u1 === u0 ? 0 : (t - u0) / (u1 - u0)

  return { top: mixColor(top0, top1, tt), bottom: mixColor(bot0, bot1, tt) }
}

export interface Body {
  x: number
  y: number
  /** Alpha, faded in and out near the horizon so nothing pops. */
  a: number
}

/** Fade over the first and last 8% of an arc. */
function arcAlpha(p: number): number {
  if (p < 0.08) return Math.max(0, p / 0.08)
  if (p > 0.92) return Math.max(0, (1 - p) / 0.08)
  return 1
}

/**
 * Sun and moon along their semicircular arcs.
 *
 * The sun is up for `u` in `[0, 0.55]`, the moon for `[0.5, 1.0]`; they overlap
 * briefly at dusk, which is true of the real thing and reads well.
 */
export function bodyPositions(
  u: number,
  w: number,
  horizonY: number,
  arcH: number,
): { sun: Body | null; moon: Body | null } {
  const t = cycleU(u * CYCLE_LENGTH)

  const place = (p: number): Body => ({
    x: lerp(-0.1, 1.1, p) * w,
    y: horizonY - Math.sin(p * Math.PI) * arcH,
    a: arcAlpha(p),
  })

  const sun = t <= 0.55 ? place(t / 0.55) : null
  const moon = t >= 0.5 ? place((t - 0.5) / 0.5) : null
  return { sun, moon }
}

export interface Star {
  x: number
  y: number
  /** Base brightness. */
  b: number
  /** Twinkle phase, so they do not all pulse together. */
  phase: number
}

/**
 * A fixed star field. Seeded rather than random so the sky does not reshuffle on
 * every reload — and so a screenshot of a bug is reproducible.
 */
export function starField(count: number, w: number, h: number, seed = 0x5eed): Star[] {
  let s = seed >>> 0
  const rnd = () => {
    // xorshift32: tiny, deterministic, and good enough for scattering dots.
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
  const stars: Star[] = []
  for (let i = 0; i < count; i++) {
    stars.push({
      x: rnd() * w,
      // Squared, so stars cluster toward the top of the sky rather than sitting
      // in a uniform band across the horizon.
      y: rnd() * rnd() * h,
      b: 0.35 + rnd() * 0.65,
      phase: rnd() * Math.PI * 2,
    })
  }
  return stars
}

/** How visible the stars are: they arrive with the dark, not with the clock. */
export function starAlpha(u: number, darkness: number, nightDarkness: number): number {
  const t = cycleU(u * CYCLE_LENGTH)
  const START = 0.58
  const byPhase = t >= START ? Math.min(1, (t - START) / 0.12) : t < 0.08 ? 1 - t / 0.08 : 0
  const byDark = nightDarkness > 0 ? Math.min(1, darkness / nightDarkness) : 0
  return Math.max(0, Math.min(1, byPhase * byDark))
}
