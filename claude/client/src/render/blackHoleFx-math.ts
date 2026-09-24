/**
 * T22.12 — the black hole's picture, as pure numbers. `blackHoleFx.ts` paints what
 * these decide; nothing here knows Phaser, so all of it runs under vitest.
 *
 * **What you see is what the rules are** (the vortex's rule, `vortexFx-math.ts`):
 * the black disc is the event horizon (`BLACK_HOLE_HORIZON_R`, cross it and you are
 * dead), the bright accretion ring hugs it, and a faint lensing ring marks
 * `BLACK_HOLE_CAPTURE_R` — inside it no thrust escapes. The glow fades out to
 * `BLACK_HOLE_REACH`, where the pull ends. All radii are the core's constants.
 */

/**
 * The accretion ring's colour, drawn opaque on both paths — so a check can ask for
 * *this* colour at the ring, not merely a change (the glow moves those pixels too).
 */
export const BLACK_HOLE_RING_COLOR = 0xffc870
/** Width of the accretion ring, px — the probe band `black-hole` photographs. Drawing only. */
export const BLACK_HOLE_RING_W = 8
/** The ring sits this many px outside the horizon, so the disc stays black to its edge. */
export const BLACK_HOLE_RING_GAP = 3
/** The capture ring: thin and faint — a warning, not the event. Drawing only. */
export const BLACK_HOLE_CAPTURE_COLOR = 0xff8a3c
export const BLACK_HOLE_CAPTURE_ALPHA = 0.45
export const BLACK_HOLE_CAPTURE_W = 2
/** The disc's colour: black, so a check can ask the centre for it. Drawing only. */
export const BLACK_HOLE_DISC_COLOR = 0x000000
/** How fast the accretion streaks turn, rad/s. Drawing only. */
export const BLACK_HOLE_SPIN = 1.6
/** Accretion streaks drawn round the ring on the flat path. Drawing only. */
export const BLACK_HOLE_STREAKS = 7
/** How long the hole takes to swell into view on arrival, ms. Drawing only. */
export const BLACK_HOLE_GROW_MS = 900

/** `0xRRGGBB` as `[r, g, b]`, 0–255. */
export function rgbOf(c: number): [number, number, number] {
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]
}

export interface BlackHoleRadii {
  /** The event horizon: the black disc. */
  horizon: number
  /** The centre line of the accretion ring. */
  ring: number
  /** No-escape radius: the faint lensing ring. */
  capture: number
  /** Where the pull and the glow end. */
  reach: number
}

/** The radii the drawing is sized from, all the core's. */
export function blackHoleRadii(k: {
  BLACK_HOLE_HORIZON_R: number
  BLACK_HOLE_CAPTURE_R: number
  BLACK_HOLE_REACH: number
}): BlackHoleRadii {
  return {
    horizon: k.BLACK_HOLE_HORIZON_R,
    ring: k.BLACK_HOLE_HORIZON_R + BLACK_HOLE_RING_GAP + BLACK_HOLE_RING_W / 2,
    capture: k.BLACK_HOLE_CAPTURE_R,
    reach: k.BLACK_HOLE_REACH,
  }
}

/**
 * 0 → 1 over `BLACK_HOLE_GROW_MS` from the arrival — a scale for the arrival only.
 * Once grown it stays grown, results screen included (R8.4: it stays drawn).
 */
export function blackHoleGrowth(arrivedAt: number, nowMs: number): number {
  const u = Math.max(0, Math.min(1, (nowMs - arrivedAt) / BLACK_HOLE_GROW_MS))
  // Ease out: it tears open fast and settles.
  return 1 - (1 - u) * (1 - u)
}

/** The start angle of accretion streak `k` at `t` seconds, turning with the spin. */
export function streakPhase(k: number, t: number): number {
  return (k / BLACK_HOLE_STREAKS) * 2 * Math.PI + BLACK_HOLE_SPIN * t
}
