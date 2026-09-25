/**
 * T22.10B — the breach vortex's picture, as pure numbers. `vortexFx.ts` paints what
 * these decide; nothing here knows Phaser, so all of it runs under vitest.
 *
 * **The one line is the one rule** (`R98`, T22.10I; the black hole's `R90` principle):
 * the bright ring sits at `VORTEX_CAPTURE_R` — cross it and you are taken. Since `R97`
 * (T22.03I) nothing else about the vortex is a line: outside the capture radius thrust
 * always wins, so `VORTEX_REACH / 2` marks nothing. The swirl is **decoration** inside
 * the reach and fades to nothing at its outer radius (`swirlFade`), so no edge there
 * reads as a boundary. **The outer radius is sized off the capture ring** — the one rule
 * — as [`VORTEX_SWIRL_OUTER`] capture radii (T22.14A L); T22.10I sized it
 * `VORTEX_REACH / 2`, the half-reach R97 retired, which is the same number today and
 * the wrong reason. (Before `R98` it was drawn as "where thrust stops winning", with a
 * hard-edged halo at `VORTEX_REACH / 2`.) The capture radius is the core's constant;
 * the numbers below are only how it looks.
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

/**
 * How far the decorative swirl reaches, in capture radii (T22.14A L). Drawing only —
 * **not** `VORTEX_REACH / 2`, though equal to it while the reach is four capture radii:
 * that radius marks nothing since R97, and a swirl sized from it would move with a
 * rule nobody can see. Measured, not guessed, why not the whole reach (R98's "inside
 * the reach"): at 1280×720 a swirl out to `VORTEX_REACH` (508 px) left 0 of 48 of
 * `breach-vortex`'s edge probes on screen and showed through the minimap (9.8 % / 33.8 %
 * of its pixels, flat / shader) — a picture the size of the view is not a vortex.
 */
export const VORTEX_SWIRL_OUTER = 2

/**
 * The two radii the drawing is sized from: what takes you (the ring), and where the
 * decorative swirl has faded out — both off the capture ring, the one rule (`R98`:
 * decoration inside the reach, not a boundary, never drawn as an edge; T22.14A L).
 */
export function vortexRadii(k: { VORTEX_CAPTURE_R: number }): { capture: number; outer: number } {
  return { capture: k.VORTEX_CAPTURE_R, outer: k.VORTEX_CAPTURE_R * VORTEX_SWIRL_OUTER }
}

/**
 * Where the swirl fades to nothing (`R98`): the share of `[capture, outer]` it has
 * begun fading by, and where it is gone. Drawing only.
 */
export const VORTEX_SWIRL_FADE_FROM = 0.35
/**
 * The swirl's strength at `r` — 1 inside `VORTEX_SWIRL_FADE_FROM` of the way out from
 * the ring, falling smoothly to 0 **at** `outer`, so nothing drawn there has an edge.
 * Both paths use this shape (the shader's `smoothstep` is the same curve).
 */
export function swirlFade(r: number, capture: number, outer: number): number {
  const from = capture + (outer - capture) * VORTEX_SWIRL_FADE_FROM
  if (r <= from) return 1
  if (r >= outer) return 0
  const u = (r - from) / (outer - from)
  return 1 - u * u * (3 - 2 * u)
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
