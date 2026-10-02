/**
 * T23.24: fireflies at night — the arithmetic, apart from three.js so it can be tested (`fireflyLayer.ts` draws it).
 *
 * The owner (2026-10-02): *"small black with some shine flying around"* — a tiny ink-black bug with a pulsing glint,
 * flitting in loose drifting paths, a faint touch of light around it at most. So the light is the glint's own soft
 * halo in the picture, **not** a point light: fireflies take none of the terrain's light slots (`pickLights`), so they
 * can never crowd a blast, a muzzle or a gate out of them.
 *
 * **Cosmetic and per-client** (as R23's scorch): homes are seeded from the map seed alone and the paths are a function
 * of (home, clock), so a map shows the same fireflies on every run and every client; nothing simulated reads them and
 * nothing goes on the wire. The clock is the scene's own (`scene.time.now`), so a frozen scene freezes them too.
 *
 * Where: mostly near rock (the edges, the caves' back wall), a few in open sky, none in rock — read from the terrain
 * fields' `dOut` (G: air's distance to rock, 4 per px, 255 at ≥ 64 px) and `back` (B) channels. None in space: a space
 * map's description carries no `fireflies` (`worldRenderer.ts::gameDescription`), and neither does the look-lab's.
 */
import { rng } from './skyLayout'

/** Fireflies per million mask px² of map, before the placement's rejections. Tuned by eye (t2324 shots). */
export const FIREFLY_DENSITY = 22
/** Candidate homes tried per wanted firefly before the map gives up (an all-rock map yields none, not a hang). */
export const FIREFLY_TRIES = 6
/** Air this close to rock (px) is "near": homes there are always kept. Under `NEAR_MIN` the wander would sit in rock. */
export const FIREFLY_NEAR_MIN = 10
export const FIREFLY_NEAR_MAX = 56
/** The chance a candidate in open sky (no rock within 64 px, no cave wall) is kept: "few in open sky". */
export const FIREFLY_OPEN_KEEP = 0.04
/** The wander's reach, px: the slow drift's amplitude range and the fast flit's. */
export const FIREFLY_DRIFT: readonly [number, number] = [14, 30]
export const FIREFLY_FLIT = 2.5
/** The glint's flash period range, s, and the share of it lit. */
export const FIREFLY_PERIOD: readonly [number, number] = [1.6, 4.2]
export const FIREFLY_FLASH = 0.32
/** The glint between flashes (of its flash): always some shine, as the owner's "black with some shine". */
export const FIREFLY_GLINT_FLOOR = 0.35
/** The fade with the hour `t` (0 moonlit day, 1 night): none under `FADE[0]`, all over `FADE[1]` — in at dusk, out by day. */
export const FIREFLY_FADE: readonly [number, number] = [0.45, 0.9]
/** Steps per second the swarm is redrawn at (a moved firefly ends the renderer's redraw skip at most this often). */
export const FIREFLY_HZ = 30

/** What the placement reads of the terrain fields at a mask px. */
export interface FieldSample {
  /** Distance from this air px to rock, px (0 in rock, 64 = 64 or more). */
  dOut: number
  /** The cave's back wall is behind this px. */
  back: boolean
}

export interface Firefly {
  /** Home, mask px (y down). */
  hx: number
  hy: number
  /** Drift: two slow sines per axis (amplitude px, rad/s, phase). */
  ax: [number, number]
  ay: [number, number]
  wx: [number, number]
  wy: [number, number]
  px: [number, number]
  py: [number, number]
  /** Flit: a fast small wobble (rad/s, phase). */
  fw: number
  fp: number
  /** Flash period (s) and phase (0–1). */
  period: number
  phase: number
}

export interface FireflyPose {
  x: number
  y: number
  /** Heading, radians, in mask px (y down): the body's long axis. */
  heading: number
  /** The glint, 0–1 (before the night fade). */
  glint: number
  /** The wings' beat, 0–1. */
  wing: number
}

/** The drift's second x sine and both y sines, as shares of an amplitude draw (wider than tall: they mostly drift sideways). */
const DRIFT_SHARE = { x2: 0.45, y1: 0.7, y2: 0.35 }

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Read the terrain fields' RGBA view (`TerrainFeed.view()`) at mask px — the sampler `placeFireflies` takes. */
export function fieldSampler(view: Uint8Array, w: number, h: number): (x: number, y: number) => FieldSample | null {
  return (x, y) => {
    const px = Math.floor(x)
    const py = Math.floor(y)
    if (px < 0 || py < 0 || px >= w || py >= h) return null
    const o = (py * w + px) * 4
    return { dOut: view[o + 1]! / 4, back: view[o + 2]! > 127 }
  }
}

/** Is a candidate home at this sample kept? `roll` is the candidate's own draw (0–1). */
export function keepHome(s: FieldSample | null, roll: number): boolean {
  if (!s || s.dOut <= 0) return false
  if (s.dOut < FIREFLY_NEAR_MIN) return false
  if (s.back) return true
  if (s.dOut <= FIREFLY_NEAR_MAX) return true
  return roll < FIREFLY_OPEN_KEEP
}

/** The map's fireflies: seeded from `seed` alone, homes where `sample` says (`keepHome`). */
export function placeFireflies(seed: number, w: number, h: number, sample: (x: number, y: number) => FieldSample | null): Firefly[] {
  const r = rng((seed ^ 0x5f1ef1e5) >>> 0)
  const want = Math.round((w * h * FIREFLY_DENSITY) / 1e6)
  const out: Firefly[] = []
  for (let k = 0; k < want * FIREFLY_TRIES && out.length < want; k++) {
    const hx = r() * w
    const hy = r() * h
    const roll = r()
    if (!keepHome(sample(hx, hy), roll)) continue
    const amp = (): number => lerp(FIREFLY_DRIFT[0], FIREFLY_DRIFT[1], r())
    const freq = (lo: number, hi: number): number => lerp(lo, hi, r())
    out.push({
      hx,
      hy,
      ax: [amp(), amp() * DRIFT_SHARE.x2],
      ay: [amp() * DRIFT_SHARE.y1, amp() * DRIFT_SHARE.y2],
      wx: [freq(0.18, 0.42), freq(0.7, 1.3)],
      wy: [freq(0.22, 0.5), freq(0.8, 1.6)],
      px: [r() * Math.PI * 2, r() * Math.PI * 2],
      py: [r() * Math.PI * 2, r() * Math.PI * 2],
      fw: freq(7, 13),
      fp: r() * Math.PI * 2,
      period: lerp(FIREFLY_PERIOD[0], FIREFLY_PERIOD[1], r()),
      phase: r(),
    })
  }
  return out
}

/** The glint at clock `t`: a quick swell and a slower fade once a period, over a floor. */
export function glintAt(f: Pick<Firefly, 'period' | 'phase'>, t: number): number {
  const u = (((t / f.period + f.phase) % 1) + 1) % 1
  if (u >= FIREFLY_FLASH) return FIREFLY_GLINT_FLOOR
  const s = u / FIREFLY_FLASH
  // Rise in the first fifth, fall over the rest.
  const p = s < 0.2 ? s / 0.2 : 1 - (s - 0.2) / 0.8
  return FIREFLY_GLINT_FLOOR + (1 - FIREFLY_GLINT_FLOOR) * p * p * (3 - 2 * p)
}

/** Where a firefly is at clock `t` (s), heading along its motion. */
export function fireflyAt(f: Firefly, t: number): FireflyPose {
  const fx = Math.sin(f.fw * t + f.fp)
  const fy = Math.cos(f.fw * 1.37 * t + f.fp * 0.7)
  const x = f.hx + f.ax[0] * Math.sin(f.wx[0] * t + f.px[0]) + f.ax[1] * Math.sin(f.wx[1] * t + f.px[1]) + FIREFLY_FLIT * fx
  const y = f.hy + f.ay[0] * Math.sin(f.wy[0] * t + f.py[0]) + f.ay[1] * Math.sin(f.wy[1] * t + f.py[1]) + FIREFLY_FLIT * fy
  // The drift's own velocity (the flit is too fast to steer by: the body would spin).
  const vx = f.ax[0] * f.wx[0] * Math.cos(f.wx[0] * t + f.px[0]) + f.ax[1] * f.wx[1] * Math.cos(f.wx[1] * t + f.px[1])
  const vy = f.ay[0] * f.wy[0] * Math.cos(f.wy[0] * t + f.py[0]) + f.ay[1] * f.wy[1] * Math.cos(f.wy[1] * t + f.py[1])
  const wing = 0.5 + 0.5 * Math.sin(t * 60 + f.fp * 3)
  return { x, y, heading: Math.atan2(vy, vx), glint: glintAt(f, t), wing }
}

/** How much of the swarm shows at hour `t` (0 moonlit day, 1 night): 0 by day, 1 at night, smooth through dusk. */
export function fireflyFade(t: number): number {
  const s = Math.min(1, Math.max(0, (t - FIREFLY_FADE[0]) / (FIREFLY_FADE[1] - FIREFLY_FADE[0])))
  return s * s * (3 - 2 * s)
}

/** The largest distance a firefly gets from its home, px — the margin a view is grown by before culling homes. */
export const FIREFLY_REACH = Math.hypot(
  FIREFLY_DRIFT[1] * (1 + DRIFT_SHARE.x2) + FIREFLY_FLIT,
  FIREFLY_DRIFT[1] * (DRIFT_SHARE.y1 + DRIFT_SHARE.y2) + FIREFLY_FLIT,
)
