/**
 * T23.19E: the weather's hazards in F's vocabulary (`fx/kit.ts`) — a lava vent's burning mouth and its jet, the embers
 * it spews, and toxic rain's drops — built each frame from the records `render/weather.ts` keeps and handed to the
 * world renderer through the scene's feed (`fx/feed.ts`, `weather`), as `fx/game.ts` builds the ordnance's.
 * **Cosmetic (R3):** nothing here reads or writes the simulation. The simulation halves are stated at each builder:
 * the jet's glows cover the cone that burns (`lava.rs::in_jet`), a drop's streak ends where the drop is — where it
 * hits, as the server moves it.
 *
 * Lava and toxic rain are switched off in play (`LAVA_ENABLED`, `TOXIC_RAIN_ENABLED`, owner 2026-09-16) — the effects'
 * code stays, waiting on the placement fix; `lava-lights` and `weather-visible` stage them in the sandbox.
 */
import type { Rgb } from '../scene'
import { LAVA_GLOW_LIGHT } from '../effectLights'
import { CONE_GLOWS, flameFx } from './game'
import { rgbToLinear, type FxFrame } from './kit'

/** One vent, as `render/weather.ts::VentView` (world px; `lean` the jet's tilt from straight up, radians). */
export interface VentRec {
  x: number
  y: number
  jetting: boolean
  burning: boolean
  lean: number
}

/** One ember in flight (`weather-math.ts::EmberField`): `life` left of `ttl`. */
export interface EmberRec {
  x: number
  y: number
  life: number
  ttl: number
}

/** What the weather layer hands the world renderer (`fx/feed.ts::FxFeed.weather`). */
export interface WeatherSource {
  /** A check's control frame hides the layer: its hazards go with it. */
  readonly visible: boolean
  readonly vents: readonly VentRec[]
  readonly embers: readonly EmberRec[]
  /** Toxic rain's live drops (the server's, world px) — where each is, which is where it hits. */
  readonly drops: readonly { x: number; y: number }[]
  /** `TOXIC_STREAK_LEN` / `_WIDTH` / `_ALPHA`. */
  readonly streak: { len: number; width: number; alpha: number }
}

/**
 * The jet's cone (`lava.rs`: `JET_HEIGHT` 180, `JET_HALF_ANGLE` 0.35 — private consts there, pinned to that source by
 * `hazards.test.ts`). The drawn column reaches the whole of what burns.
 */
export const VENT_JET_H = 180
export const VENT_JET_HALF = 0.35
/**
 * The burning mouth: F1's lava glow (`f_scene.js`'s `L(…, 8, 40, '255,60,30', 0.5)`: the light) as a soft sprite the
 * light's radius across, its colour at the light's HDR strength ×4 (a glow reads as brightly as it lights), and a small
 * fire tongue in it — `VENT_MOUTH_R` the old flat disc's radius (`weather.ts`), too small to stand in for the afterburn's
 * real flames, which the ordnance layer draws.
 */
const LAVA: Rgb = rgbToLinear(LAVA_GLOW_LIGHT.rgb)
export const VENT_GLOW: Rgb = [LAVA[0] * 4, LAVA[1] * 4, LAVA[2] * 4]
export const VENT_MOUTH_R = 8
/** The mouth's flicker (share of its glow), and its rate (rad/s): alive, not strobing. */
const FLICKER = 0.15
const FLICKER_RATE = 20

export function ventFx(out: FxFrame, v: VentRec, seconds: number): void {
  if (!v.jetting && !v.burning) return
  const f = 1 - FLICKER + FLICKER * Math.sin(seconds * FLICKER_RATE + v.x)
  out.soft.push({ x: v.x, y: v.y - LAVA_GLOW_LIGHT.z, size: LAVA_GLOW_LIGHT.r * 2, color: VENT_GLOW, alpha: 0.8 * f, tex: 0, rot: 0, under: true })
  flameFx(out, { id: Math.round(v.x), x: v.x, y: v.y }, VENT_MOUTH_R)
  if (v.jetting) jetFx(out, v)
}

/** F's flamer-cone glows (`game.ts::coneFx`'s colours), stood up from the mouth along the jet, as wide as its cone. */
const JET_NEAR = rgbToLinear('255,215,110')
const JET_FAR = rgbToLinear('255,110,30')
function jetFx(out: FxFrame, v: VentRec): void {
  const ux = Math.sin(v.lean)
  const uy = -Math.cos(v.lean)
  for (let i = 0; i < CONE_GLOWS; i++) {
    const d = (VENT_JET_H * (i + 0.5)) / CONE_GLOWS
    const half = Math.max(4, d * Math.tan(VENT_JET_HALF))
    const c = i < 3 ? JET_NEAR : JET_FAR
    out.soft.push({ x: v.x + ux * d, y: v.y + uy * d, size: half * 3.4, color: [c[0] * 1.4, c[1] * 1.4, c[2] * 1.4], alpha: (0.9 - i * 0.08) * 0.55, tex: 0, rot: 0, under: true })
  }
}

/** The mockup's embers (`f_scene.js`'s `extra2d === 'embers'`: `S.glow(r·4, '255,120,40', 0.5)` and a pale core). */
const EMBER_GLOW = rgbToLinear('255,120,40')
const EMBER_CORE = rgbToLinear('255,200,120')
export const EMBER_R = 1.5
export function emberParticleFx(out: FxFrame, e: EmberRec): void {
  const a = Math.max(0, Math.min(1, e.life / e.ttl))
  if (!(a > 0)) return
  const r = EMBER_R * (0.5 + a)
  out.soft.push({ x: e.x, y: e.y, size: r * 8, color: [EMBER_GLOW[0] * 2, EMBER_GLOW[1] * 2, EMBER_GLOW[2] * 2], alpha: 0.5 * a, tex: 0, rot: 0, under: true })
  out.soft.push({ x: e.x, y: e.y, size: r * 2, color: [EMBER_CORE[0] * 3, EMBER_CORE[1] * 3, EMBER_CORE[2] * 3], alpha: 0.9 * a, tex: 0, rot: 0, under: true })
}

/**
 * A toxic drop: a streak `len` above it ending **at the drop** (where it is is where it hits — the server's position),
 * brightest at the drop. The drop's green (`LOOK.drop`), which R10 allows: it is danger.
 */
export const DROP_GREEN: Rgb = rgbToLinear('155,240,90')
export function dropFx(out: FxFrame, d: { x: number; y: number }, s: WeatherSource['streak']): void {
  const core: Rgb = [DROP_GREEN[0] * 2.5 * s.alpha, DROP_GREEN[1] * 2.5 * s.alpha, DROP_GREEN[2] * 2.5 * s.alpha]
  const glow: Rgb = [DROP_GREEN[0] * s.alpha, DROP_GREEN[1] * s.alpha, DROP_GREEN[2] * s.alpha]
  // Tail first: a ribbon brightens toward its last point (`layer.ts`: `pow(u, fadePow)` and the head boost at u = 1).
  out.ribbons.push({ pts: [[d.x, d.y - s.len], [d.x, d.y]], width: s.width * 2, core, glow, fadePow: 1.2, headBoost: 1, under: true })
}

/** This frame's hazards from `w` into `out` (appended). */
export function weatherFrame(w: WeatherSource, out: FxFrame, seconds: number): void {
  if (!w.visible) return
  for (const v of w.vents) ventFx(out, v, seconds)
  for (const e of w.embers) emberParticleFx(out, e)
  for (const d of w.drops) dropFx(out, d, w.streak)
}
