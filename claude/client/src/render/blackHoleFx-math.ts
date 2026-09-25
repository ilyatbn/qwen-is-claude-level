/**
 * T22.12 — the black hole's picture, as pure numbers. `blackHoleFx.ts` paints what
 * these decide; nothing here knows Phaser, so all of it runs under vitest.
 *
 * **What you see is what the rules are** (the vortex's rule, `vortexFx-math.ts`):
 * the black disc is the event horizon (`BLACK_HOLE_HORIZON_R`, cross it and you are
 * dead) and the bright accretion ring hugs it — **the only line the rule has**
 * (R90, T22.12C: outside it every thrust escapes; the faint "capture" ring that
 * promised a second line the physics did not keep is gone). The glow fades out to
 * `BLACK_HOLE_REACH`, where the pull ends. All radii are the core's constants.
 *
 * **The telegraph** (R93): for `BLACK_HOLE_TELEGRAPH` seconds before it opens, a
 * solid ring in `BLACK_HOLE_WARN_COLOR` at the horizon where it will open, and a
 * thin ring closing in from the reach onto it as the moment comes.
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
/**
 * The telegraph's colour (R93), drawn opaque at the horizon so a check can ask for
 * *this* colour there before the hole exists. Violet: not the ring's gold, not the
 * vortex's, not a flare's. Drawing only.
 */
export const BLACK_HOLE_WARN_COLOR = 0xb46cff
/** Width of the telegraph's solid ring, px. Drawing only. */
export const BLACK_HOLE_WARN_W = 6
/** The closing ring's width and alpha. Drawing only. */
export const BLACK_HOLE_WARN_CLOSING_W = 2
export const BLACK_HOLE_WARN_CLOSING_ALPHA = 0.6
/** The disc's colour: black, so a check can ask the centre for it. Drawing only. */
export const BLACK_HOLE_DISC_COLOR = 0x000000
/** How fast the accretion streaks turn, rad/s. Drawing only. */
export const BLACK_HOLE_SPIN = 1.6
/** Accretion streaks drawn round the ring on the flat path. Drawing only. */
export const BLACK_HOLE_STREAKS = 7
/**
 * How long the hole's **decoration** (accretion light, halo, streaks) takes to swell
 * into view on arrival, ms. Drawing only. The disc and the ring are full size from the
 * arrival frame (T22.14A L): the server kills at the full horizon on that tick, so a
 * disc drawn growing showed a player outside it who was already inside the rule.
 */
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
  /** Where the pull and the glow end. */
  reach: number
}

/** The radii the drawing is sized from, all the core's. */
export function blackHoleRadii(k: { BLACK_HOLE_HORIZON_R: number; BLACK_HOLE_REACH: number }): BlackHoleRadii {
  return {
    horizon: k.BLACK_HOLE_HORIZON_R,
    ring: k.BLACK_HOLE_HORIZON_R + BLACK_HOLE_RING_GAP + BLACK_HOLE_RING_W / 2,
    reach: k.BLACK_HOLE_REACH,
  }
}

/**
 * R93: how far through the telegraph `nowMs` is, 0 at the warning → 1 at the
 * opening, clamped. A warning whose clock has run out (the hole is late, or the
 * page stalled) holds at 1 rather than disappearing before the hole appears.
 */
export function warnProgress(since: number, opensAt: number, nowMs: number): number {
  const span = opensAt - since
  if (!(span > 0)) return 1
  return Math.max(0, Math.min(1, (nowMs - since) / span))
}

/** The closing ring's radius at telegraph progress `u`: the reach at 0, the horizon at 1. */
export function warnClosingRadius(r: BlackHoleRadii, u: number): number {
  return r.reach - (r.reach - r.horizon) * u
}

/**
 * 0 → 1 over `BLACK_HOLE_GROW_MS` from the arrival — the decoration's scale on arrival
 * only (never the disc's or the ring's, T22.14A L).
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
