/**
 * T23.18: the game's effects in F's vocabulary (`fx/kit.ts`), built each frame from the records the ordnance layers
 * already keep — `OrdnanceState` (blasts, flames) and `OrdnanceFxState` (smoke and toxic clouds) — and handed to the
 * world renderer through the scene's feed (`fx/feed.ts`). **Cosmetic (R3):** nothing here reads or writes the
 * simulation, and the simulation halves are stated at each builder: the fire drawn covers every damage circle, a blast
 * covers its blast radius, a cloud covers the cloud the server blinds you in.
 *
 * The mockup's pictures are stills; how each effect changes with age is decided here, at each constant.
 */
import type { Blast, TrackedProjectile } from '../../render/ordnance-state'
import type { Hazard } from '../../render/ordnanceFx-math'
import type { Rgb } from '../scene'
import { F1 } from '../scenes/F1'
import { explosion, hexToLinear, Lcg, rgbToLinear, type ExplosionAge, type FxFrame } from './kit'

/**
 * How far from a fireball's centre, per unit of `kit.js::explosion`'s scale `s`, its fire reads (mask px): the
 * shape `smoothstep(0.78, 0.2, r + noise)` is solid near `r` ≈ 0.5 of its half-side (95 s) with the noise near its
 * middle. A blast of radius `r` is drawn at `s = r / BLAST_REACH`, so its fire reaches the edge of what the blast hurts
 * — the simulation half, measured on the drawn frame by `blast-fx` (every point just inside the radius painted, lit).
 * F1's own explosion is `s` 0.5; a bazooka's (42 px) is drawn at 0.88.
 */
export const BLAST_REACH = 0.5 * 95
/** Below this blast radius (world px: bullets' 2–6, not a grenade's 36) an explosion is an impact: fire and sparks, no plume. */
export const IMPACT_MAX_R = 12
/** An impact's life (s): its sparks are gone by then. A blast lives `BLAST_SHADER_LIFE` (the old painted blast's, 1.1 s). */
export const IMPACT_LIFE = 0.3
/** How fast a fire boils (noise units/s) — the still picture's fire, alive. */
export const FIRE_FLOW = 0.35
/** The plume's climb over a blast's life, per unit of `s` (mask px). */
export const PLUME_RISE = 40

/** F1's palette: the plume's colour (`P.plume`), the smoke's (`P.smoke`). */
const P = F1.palette!
/** `P.plume`, F1's explosion smoke. */
export const PLUME = P.plume

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const ramp = (k: number, from: number, to: number): number => clamp01((k - from) / (to - from))

/**
 * An explosion's shape at `k` = age / life (0 the blast, 1 gone). The fire is whole for the first 30 % — the blast
 * radius is covered then (`blast-fx` poses it at 25 %) — then cools and goes by 60 %; sparks fly out in the first 12 %
 * and are gone by 35 %; the ring runs out to its size in 20 %; the plume thickens, climbs and fades out from 55 %.
 */
export function explosionAge(k: number, s: number, seed: number): ExplosionAge {
  return {
    fire: 1 - ramp(k, 0.3, 0.6),
    heat: 1 - 0.5 * ramp(k, 0.05, 0.45),
    fireSize: 0.75 + 0.25 * ramp(k, 0, 0.06),
    sparks: 1 - ramp(k, 0.1, 0.35),
    sparkReach: 0.35 + 0.65 * ramp(k, 0, 0.12),
    smoke: (0.7 + 0.3 * ramp(k, 0, 0.1)) * (1 - ramp(k, 0.55, 1)),
    smokeSize: 1 + 0.35 * k,
    rise: PLUME_RISE * s * k,
    ring: 0.4 + 0.6 * ramp(k, 0, 0.2),
    ringAlpha: 1 - ramp(k, 0, 0.25),
    seed,
    flow: FIRE_FLOW,
  }
}

/** A stable stream per blast (its place), so a blast looks the same every frame it is drawn. */
function blastRnd(x: number, y: number): Lcg {
  const q = Math.abs(Math.floor(x) * 7919 + Math.floor(y) * 104729) % 2147483646
  return new Lcg(q + 1)
}

/** `s` for a blast of radius `r` (`BLAST_REACH`). */
export const blastScale = (r: number): number => r / BLAST_REACH

/** One blast into `out`: a plume-less impact under `IMPACT_MAX_R`, F's explosion above it. `null` once it is over. */
export function blastFx(out: FxFrame, b: Pick<Blast, 'x' | 'y' | 'r' | 'age' | 'ttl'>): void {
  const small = b.r < IMPACT_MAX_R
  const life = small ? Math.min(b.ttl, IMPACT_LIFE) : b.ttl
  const k = life > 0 ? b.age / life : 1
  if (k >= 1) return
  const s = blastScale(b.r)
  const rnd = blastRnd(b.x, b.y)
  const age = explosionAge(k, s, (rnd.q % 997) * 0.37)
  if (small) age.smoke = 0
  explosion(out, b.x, b.y, s, PLUME, rnd, age)
}

/**
 * A flame's fire covers its burn circle: the tongue (`fx/layer.ts` kind 1) reads within `FLAME_REACH` of its half-side
 * around `(x, (y + 0.35)·0.62)` — least far sideways — so the half-side is `FLAME_RADIUS / FLAME_REACH` and every point
 * of the damage circle is painted (measured on the drawn frame by `fire-fx`).
 */
export const FLAME_REACH = 0.35
/** A flame burns cooler than a blast's heart: orange with a yellow core, not the fireball's white (heat 1). */
export const FLAME_HEAT = 0.55
/** How far above the flame's centre (a share of the half-side) the tongue's body sits: `(y + 0.35)` in the shader. */
export const FLAME_LIFT = 0.35
/** Each flame's soft glow: `P.fire`'s colour at the flamethrower sprite's HDR strength (F1: `Color(1.6, 0.6, 0.15)`). */
export const FLAME_GLOW: Rgb = [1.6, 0.6, 0.15]
/** The glow's side, in burn radii, and its opacity (F1's flamethrower sprite: 60 px at 0.7). Blended by the brightest. */
export const FLAME_GLOW_SIZE = 4
export const FLAME_GLOW_ALPHA = 0.4

export function flameFx(out: FxFrame, p: Pick<TrackedProjectile, 'id' | 'x' | 'y'>, burnRadius: number): void {
  const h = burnRadius / FLAME_REACH
  // The quad's centre sits `FLAME_LIFT · h` above the flame (mask y down): the shader's body is at p.y = −0.35.
  out.discs.push({ kind: 1, x: p.x, y: p.y - FLAME_LIFT * h, size: 2 * h, a: (p.id % 97) * 0.618, b: 1.2, heat: FLAME_HEAT, alpha: 1, color: [0, 0, 0], max: true })
  out.soft.push({ x: p.x, y: p.y, size: burnRadius * FLAME_GLOW_SIZE, color: FLAME_GLOW, alpha: FLAME_GLOW_ALPHA, tex: 0, rot: 0, max: true })
}

/** Smoke sprites per cloud; each is `CLOUD_SIZE` radii across, placed within `CLOUD_SPREAD` of the centre. */
export const CLOUD_SPRITES = 36
export const CLOUD_SIZE = 1.0
export const CLOUD_SPREAD = 0.8
/** A cloud's opacity per sprite, and the seconds it takes to thicken in and thin out. */
export const CLOUD_ALPHA = 0.55
export const CLOUD_FADE = 0.6
/** The smoke grenade's cloud: `P.smoke` (F1's smoke trail colour). */
export const SMOKE_RGB: Rgb = rgbToLinear(P.smoke.rgb)
/** The toxic cloud: danger, so saturated (R10) — the old zone's green, deepened; and its glow. */
export const TOXIC_RGB: Rgb = hexToLinear(0x2f6a1a)
export const TOXIC_GLOW: Rgb = [0.25, 0.9, 0.12]
/** How fast a cloud's sprites turn (rad/s): smoke is never still. */
export const CLOUD_SPIN = 0.08

export function cloudFx(out: FxFrame, h: Pick<Hazard, 'id' | 'kind' | 'x' | 'y' | 'r' | 'ttl' | 'life'>, seconds: number): void {
  const elapsed = h.life - h.ttl
  const fade = Math.min(ramp(elapsed, 0, CLOUD_FADE), ramp(h.ttl, 0, CLOUD_FADE))
  if (!(fade > 0)) return
  const toxic = h.kind === 'toxic'
  const colour = toxic ? TOXIC_RGB : SMOKE_RGB
  const rnd = new Lcg((Math.abs(h.id) % 2147483646) + 1)
  for (let i = 0; i < CLOUD_SPRITES; i++) {
    const a = rnd.next() * Math.PI * 2
    const d = Math.sqrt(rnd.next()) * CLOUD_SPREAD * h.r
    const size = h.r * CLOUD_SIZE * (0.8 + 0.4 * rnd.next())
    const tint = 0.8 + 0.4 * rnd.next()
    const spin = (rnd.next() - 0.5) * 2 * CLOUD_SPIN
    const rot = rnd.next() * 6 + spin * seconds
    const wob = 0.06 * h.r
    out.smoke.push({
      x: h.x + Math.cos(a) * d + Math.cos(seconds * 0.3 + i) * wob,
      y: h.y + Math.sin(a) * d + Math.sin(seconds * 0.23 + i * 1.7) * wob,
      size,
      color: [colour[0] * tint, colour[1] * tint, colour[2] * tint],
      alpha: CLOUD_ALPHA * fade,
      tex: 1,
      rot,
    })
  }
  if (toxic) out.soft.push({ x: h.x, y: h.y, size: h.r * 2.4, color: TOXIC_GLOW, alpha: 0.2 * fade, tex: 0, rot: 0 })
}
