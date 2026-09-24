/**
 * T22.10B — the breach vortex's picture, as pure numbers. `vortexFx.ts` paints what
 * these decide; nothing here knows Phaser, so all of it runs under vitest.
 *
 * **What you see is what pulls** (`T22.10B-the-vortex-on-screen.md`, point 2): the
 * bright ring sits at `VORTEX_CAPTURE_R` — cross it and you are taken — and the
 * swirl reaches out to `VORTEX_REACH / 2`, where thrust stops beating the pull
 * (`VORTEX_ACCEL_MAX`'s basis). Both radii come from the core's constants; the
 * numbers below are only how it looks.
 */

/** Spiral arms per vortex. Drawing only. */
export const VORTEX_ARMS = 5
/** How far round each arm winds from the core to the outer edge, turns. Drawing only. */
export const VORTEX_ARM_TURNS = 1.25
/** How fast the swirl turns, rad/s — inward, so it reads as sucking. Drawing only. */
export const VORTEX_SPIN = 2.4
/** Samples along one arm. Drawing only. */
export const VORTEX_ARM_SAMPLES = 24
/**
 * The capture ring's colour, drawn opaque on both paths — so a check can ask for
 * *this* colour at the ring, not merely a change, which the halo and the arms also
 * make (measured: without the ring, the flat path still moved every ring probe).
 */
export const VORTEX_RING_COLOR = 0xe6b3ff

/** `0xRRGGBB` as `[r, g, b]`, 0–255. */
export function rgbOf(c: number): [number, number, number] {
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]
}

/** Width of the capture ring, px — the probe band `breach-vortex` photographs. Drawing only. */
export const VORTEX_RING_W = 6
/**
 * How long a vortex that stopped pulling takes to fade, ms (`M22-RULINGS` R88). It
 * still catches after this — on the server — but a secret is drawn only while it sucks.
 */
export const VORTEX_FADE_MS = 1500

/** The two radii the drawing is sized from: what takes you, and where the swirl ends. */
export function vortexRadii(k: { VORTEX_CAPTURE_R: number; VORTEX_REACH: number }): { capture: number; outer: number } {
  return { capture: k.VORTEX_CAPTURE_R, outer: k.VORTEX_REACH / 2 }
}

/** 1 while it pulls; falling to 0 over `VORTEX_FADE_MS` once it stopped (`closedAt`). */
export function vortexFade(closedAt: number | null, nowMs: number): number {
  if (closedAt === null) return 1
  return Math.max(0, Math.min(1, 1 - (nowMs - closedAt) / VORTEX_FADE_MS))
}

/**
 * One logarithmic spiral arm as a flat `[x, y, …]` polyline, from `inner` to
 * `outer` round `(cx, cy)`. Logarithmic because a vortex's arms tighten toward the
 * centre; `phase` turns the whole arm (the spin), and the winding is fixed so the
 * arm ends exactly on the outer radius whatever the phase.
 */
export function spiralArm(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  phase: number,
  out: number[],
): number[] {
  out.length = 0
  const span = Math.log(outer / inner)
  for (let i = 0; i < VORTEX_ARM_SAMPLES; i++) {
    const u = i / (VORTEX_ARM_SAMPLES - 1)
    const r = inner * Math.exp(span * u)
    const a = phase + VORTEX_ARM_TURNS * 2 * Math.PI * u
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
  }
  return out
}

/** The phase of arm `k` at `t` seconds: evenly spaced, turning inward. */
export function armPhase(k: number, t: number): number {
  return (k / VORTEX_ARMS) * 2 * Math.PI - VORTEX_SPIN * t
}
