/**
 * T22.12 — the black hole's picture, as pure numbers. `blackHoleFx.ts` paints what
 * these decide; nothing here knows Phaser, so all of it runs under vitest.
 *
 * **What you see is what the rules are** (the vortex's rule, `vortexFx-math.ts`):
 * the black disc is the event horizon (`BLACK_HOLE_HORIZON_R`, cross it and you are
 * dead) and the bright accretion ring hugs it — **the only line the rule has**
 * (R90, T22.12C: outside it every thrust escapes; the faint "capture" ring that
 * promised a second line the physics did not keep is gone). The glow fades out to
 * [`BLACK_HOLE_GLOW_HORIZONS`] horizons — decoration, not the reach (T22.18, below).
 * The rule's radii are the core's constants.
 *
 * **The reach ring** (T22.18B F4): a faint thin ring in the accretion ring's colour at
 * `BLACK_HOLE_REACH`, drawn for the hole's whole life. **Not a line of the death rule**
 * — that is still the horizon alone (R90) — but the edge of the pull, and inside it the
 * asteroid wells are muted (R91): without it a player standing on a rock inside the
 * reach felt the rock stop holding them with nothing on screen to say why.
 *
 * **The telegraph** (R93): for `BLACK_HOLE_TELEGRAPH` seconds before it opens, a
 * solid ring in `BLACK_HOLE_WARN_COLOR` at the horizon where it will open, and a
 * thin ring closing in from the glow's edge onto it as the moment comes.
 */

/**
 * How far the lensing glow reaches, in horizons. Drawing only. **Four — the reach it
 * was drawn to until R106** (T22.18): the pull now ends at eight horizons (512 px), and
 * a glow sized off it filled a 1280×720 view at the match zoom with an orange tint whose
 * flat-path steps read as rings across the whole screen (`black-hole`'s control point
 * had nowhere in view to stand). The glow was never a line of the rule — the ring at
 * the horizon is (R90) — so it keeps the size it had. *Reverse it by:* this constant.
 */
export const BLACK_HOLE_GLOW_HORIZONS = 4

/**
 * The accretion ring's colour, drawn opaque on both paths — so a check can ask for
 * *this* colour at the ring, not merely a change (the glow moves those pixels too).
 */
export const BLACK_HOLE_RING_COLOR = 0xffc870
/**
 * T22.18B F4: the reach ring's alpha and width (world px), in `BLACK_HOLE_RING_COLOR`.
 * Faint on purpose: it marks where the pull (and R91's muting of the wells) ends, not
 * where you die. `black-hole` asks for exactly this mix of the colour over the frame
 * hidden. Drawing only.
 */
export const BLACK_HOLE_REACH_RING_ALPHA = 0.35
export const BLACK_HOLE_REACH_RING_W = 3
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
  /**
   * Where the pull ends (the core's `BLACK_HOLE_REACH`) — and inside it the wells are
   * muted (R91). Drawn as the faint reach ring since T22.18B (F4).
   */
  reach: number
  /** Where the decorative glow ends: [`BLACK_HOLE_GLOW_HORIZONS`] horizons. */
  glow: number
}

/** The radii the drawing is sized from, all the core's. */
export function blackHoleRadii(k: { BLACK_HOLE_HORIZON_R: number; BLACK_HOLE_REACH: number }): BlackHoleRadii {
  return {
    horizon: k.BLACK_HOLE_HORIZON_R,
    ring: k.BLACK_HOLE_HORIZON_R + BLACK_HOLE_RING_GAP + BLACK_HOLE_RING_W / 2,
    reach: k.BLACK_HOLE_REACH,
    glow: k.BLACK_HOLE_HORIZON_R * BLACK_HOLE_GLOW_HORIZONS,
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

/**
 * The closing ring's radius at telegraph progress `u`: the glow's edge at 0
 * (`BLACK_HOLE_GLOW_HORIZONS` horizons — not the reach since T22.18), the horizon at 1.
 */
export function warnClosingRadius(r: BlackHoleRadii, u: number): number {
  return r.glow - (r.glow - r.horizon) * u
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
