/**
 * T23.18: the game's effects in F's vocabulary (`fx/kit.ts`), built each frame from the records the ordnance layers
 * already keep — `OrdnanceState` (blasts, flames) and `OrdnanceFxState` (smoke and toxic clouds) — and handed to the
 * world renderer through the scene's feed (`fx/feed.ts`). **Cosmetic (R3):** nothing here reads or writes the
 * simulation, and the simulation halves are stated at each builder: the fire drawn covers every damage circle, a blast
 * covers its blast radius, a cloud covers the cloud the server blinds you in.
 *
 * The mockup's pictures are stills; how each effect changes with age is decided here, at each constant.
 */
import { bulletStreak, type Blast, type Tracer, type TrackedProjectile } from '../../render/ordnance-state'
import type { Hazard } from '../../render/ordnanceFx-math'
import type { Rgb } from '../scene'
import { F1 } from '../scenes/F1'
import { F5 } from '../scenes/F5'
import { blendPalette } from '../daylight'
import { explosion, hexToLinear, Lcg, rgbToLinear, SMOKE_TEX_DRAWS, type ExplosionAge, type FxFrame } from './kit'

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

/** T23.11: the smoke's colours — the explosion's plume (`P.plume`, `0xRRGGBB`) and the smoke's (`P.smoke`, linear). */
export interface SmokeLook {
  plume: number
  smoke: Rgb
}
/** At night: F1's. */
export const NIGHT_SMOKE: SmokeLook = { plume: PLUME, smoke: rgbToLinear(P.smoke.rgb) }
let smokeAt: { t: number; look: SmokeLook } = { t: 1, look: NIGHT_SMOKE }
/**
 * T23.11 (R7): the smoke's colours at `t` (0 moonlit day, 1 night) — the palettes' own blend (`daylight.ts`), F5's
 * smoke by day (`150,140,160`, plume `0x2a2430`), F1's at night. Remembered for the last `t` (one per frame).
 */
export function smokeLook(t: number): SmokeLook {
  if (t === smokeAt.t) return smokeAt.look
  const p = blendPalette(F5.palette, F1.palette, t)
  const look = p ? { plume: p.plume, smoke: rgbToLinear(p.smoke.rgb) } : NIGHT_SMOKE
  smokeAt = { t, look }
  return look
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const ramp = (k: number, from: number, to: number): number => clamp01((k - from) / (to - from))
const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]

/**
 * **R27 (coordinator, T23.19D): the reference still is one frame of the animation.** Every curve below passes through
 * `STILL` at `BLAST_PEAK` of the blast's life, and the fire's boil is measured from that moment, so a blast drawn at
 * its peak with the mockup's stream (`MOCKUP_STREAM`) is F1's explosion at Level A (`look-fx`'s game-path leg). The
 * peak is 12 %: the latest age the growth curves could be pinned to without slowing the fireball — the sparks reach
 * their full spread there (they flew out over 12 % already), the fireball has been full-size since 6 %, the plume
 * thick since 10 %. Moved to meet it: white heat holds to 12 % (from 5 %), sparks fade from 12 % (from 10 %), the ring
 * is full at 12 % (from 20 %) and fades 12–37 % (from 0–25 %), the plume's climb and swell count from the peak.
 */
export const BLAST_PEAK = 0.12

/**
 * The mockup's own explosion stream: `kit.js::rnd` from seed 7, after its smoke texture's draws — what a blast whose
 * `stream` is this draws (sparks, smoke) and what its fireball's noise offset is measured from (0 here).
 */
export const MOCKUP_STREAM: number = (() => {
  const r = new Lcg(7)
  for (let i = 0; i < SMOKE_TEX_DRAWS; i++) r.next()
  return r.q
})()

/**
 * An explosion's shape at `k` = age / life (0 the blast, 1 gone). The fire is whole for the first 30 % — the blast
 * radius is covered then (`blast-fx` poses it at 25 %) — then cools and goes by 60 %; sparks fly out in the first 12 %
 * and are gone by 35 %; the ring runs out to its size in 20 %; the plume thickens, climbs and fades out from 55 %.
 */
export function explosionAge(k: number, s: number, seed: number, life: number): ExplosionAge {
  const P = BLAST_PEAK
  return {
    fire: 1 - ramp(k, 0.3, 0.6),
    heat: 1 - 0.5 * ramp(k, P, 0.45),
    fireSize: 0.75 + 0.25 * ramp(k, 0, 0.06),
    sparks: 1 - ramp(k, P, 0.35),
    sparkReach: 0.35 + 0.65 * ramp(k, 0, P),
    smoke: (0.7 + 0.3 * ramp(k, 0, 0.1)) * (1 - ramp(k, 0.55, 1)),
    smokeSize: 1 + 0.35 * (k - P),
    rise: PLUME_RISE * s * (k - P),
    ring: 0.4 + 0.6 * ramp(k, 0, P),
    ringAlpha: 1 - ramp(k, P, P + 0.25),
    seed,
    // Seconds from the peak × the boil rate: the fire moves through the still, not from it.
    boil: -FIRE_FLOW * (k - P) * life,
  }
}

/** A stable stream start per blast (its place, unless it names one), so a blast looks the same every frame it is drawn. */
export function blastStream(b: Pick<Blast, 'x' | 'y' | 'stream'>): number {
  if (b.stream !== undefined) return b.stream
  return (Math.abs(Math.floor(b.x) * 7919 + Math.floor(b.y) * 104729) % 2147483646) + 1
}

/** `s` for a blast of radius `r` (`BLAST_REACH`). */
export const blastScale = (r: number): number => r / BLAST_REACH

/** One blast into `out`: a plume-less impact under `IMPACT_MAX_R`, F's explosion above it. `null` once it is over. */
export function blastFx(out: FxFrame, b: Pick<Blast, 'x' | 'y' | 'r' | 'age' | 'ttl' | 'stream'>, look: SmokeLook = NIGHT_SMOKE): void {
  const small = b.r < IMPACT_MAX_R
  const life = small ? Math.min(b.ttl, IMPACT_LIFE) : b.ttl
  const k = life > 0 ? b.age / life : 1
  if (k >= 1) return
  const s = blastScale(b.r)
  const q0 = blastStream(b)
  const rnd = new Lcg(q0)
  // The fireball's noise offset, measured from the mockup's stream: its own blast is offset 0 (R27).
  const age = explosionAge(k, s, (((q0 - MOCKUP_STREAM) % 997) + 997) % 997 * 0.37, life)
  if (small) age.smoke = 0
  explosion(out, b.x, b.y, s, look.plume, rnd, age)
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
/** The smoke grenade's cloud: `P.smoke` (F1's smoke trail colour; T23.11: the blend's — `SmokeLook`). */
export const SMOKE_RGB: Rgb = NIGHT_SMOKE.smoke
/** The toxic cloud: danger, so saturated (R10) — the old zone's green, deepened; and its glow. */
export const TOXIC_RGB: Rgb = hexToLinear(0x2f6a1a)
export const TOXIC_GLOW: Rgb = [0.25, 0.9, 0.12]
/** How fast a cloud's sprites turn (rad/s): smoke is never still. */
export const CLOUD_SPIN = 0.08

export function cloudFx(out: FxFrame, h: Pick<Hazard, 'id' | 'kind' | 'x' | 'y' | 'r' | 'ttl' | 'life'>, seconds: number, look: SmokeLook = NIGHT_SMOKE): void {
  const elapsed = h.life - h.ttl
  const fade = Math.min(ramp(elapsed, 0, CLOUD_FADE), ramp(h.ttl, 0, CLOUD_FADE))
  if (!(fade > 0)) return
  const toxic = h.kind === 'toxic'
  const colour = toxic ? TOXIC_RGB : look.smoke
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

// ---------------------------------------------------------------------------------------------------------------
// T23.18 part B: beams, rounds, rockets, muzzles, flame cones, swings, mines — F1's values where F1 has the thing.
// ---------------------------------------------------------------------------------------------------------------

/** F1's laser: `ribbon([l0, l1], 6, [1.2, 3.4, 3.6], [0.05, 0.5, 0.7], { fadePow: 0.2, headBoost: 0 })`, shooter to impact. */
export const LASER_WIDTH = 6
export const LASER_CORE: Rgb = [1.2, 3.4, 3.6]
export const LASER_GLOW: Rgb = [0.05, 0.5, 0.7]
/** F1's laser impact: `sprite(softTex(), l1, 43, 46, Color(0.4, 1.6, 2.0), 1, true)`. */
export const LASER_IMPACT_SIZE = 46
export const LASER_IMPACT: Rgb = [0.4, 1.6, 2.0]

/** A beam at `k` = its life left (1 → 0): F1's laser and its impact glow, fading with the beam. */
export function beamFx(out: FxFrame, t: Pick<Tracer, 'x0' | 'y0' | 'x1' | 'y1' | 'life' | 'ttl'>): void {
  const k = t.ttl > 0 ? clamp01(t.life / t.ttl) : 0
  if (!(k > 0)) return
  out.ribbons.push({ pts: [[t.x0, t.y0], [t.x1, t.y1]], width: LASER_WIDTH, core: scale(LASER_CORE, k), glow: scale(LASER_GLOW, k), fadePow: 0.2, headBoost: 0, under: true })
  out.soft.push({ x: t.x1, y: t.y1, size: LASER_IMPACT_SIZE, color: LASER_IMPACT, alpha: k, tex: 0, rot: 0, under: true })
}

/** F1's turret tracer: `ribbon([P0(t1), P0(t0)], 3, [4, 3, 1.4], [1.0, 0.45, 0.08], { fadePow: 1.2 })` — front first. */
export const TRACER_WIDTH_PX = 3
export const TRACER_CORE: Rgb = [4, 3, 1.4]
export const TRACER_GLOW: Rgb = [1.0, 0.45, 0.08]

/** A round in flight: F1's tracer streak along its travel, `length` behind the round (`BULLET_LENGTH`). */
export function bulletFx(out: FxFrame, p: Pick<TrackedProjectile, 'x' | 'y' | 'trail'>, length: number): void {
  const s = bulletStreak(p, length)
  // Not yet moving: a streak one px long along nothing would be a dot of NaN; draw it as a point-length streak.
  const x1 = s.x1 === s.x0 && s.y1 === s.y0 ? s.x0 - 1 : s.x1
  out.ribbons.push({ pts: [[s.x0, s.y0], [x1, s.y1]], width: TRACER_WIDTH_PX, core: TRACER_CORE, glow: TRACER_GLOW, fadePow: 1.2, headBoost: 1, under: true })
}

/** F1's rocket motor: `sprite(softTex(), rx − 8, ry, 43, 16, Color(2.4, 1.2, 0.3), 0.9, true)` — `ROCKET_MOTOR_BACK` behind. */
export const MOTOR_SIZE = 16
export const MOTOR: Rgb = [2.4, 1.2, 0.3]
export const MOTOR_BACK = 8
/** The rocket's smoke trail: `kit.js::smokeTrail` sprites along the trail, in F1's smoke colour (`P.smoke`). */
export const TRAIL_SIZE = 8
export const TRAIL_GROW = 3

/** A rocket (or meteor): its motor's glow and its smoke trail. The body is an actor (`fx/rockets.ts`). */
export function rocketFx(out: FxFrame, p: Pick<TrackedProjectile, 'id' | 'x' | 'y' | 'trail'>, look: SmokeLook = NIGHT_SMOKE): void {
  const prev = p.trail.length >= 2 ? p.trail[p.trail.length - 2]! : null
  const dx = prev ? p.x - prev.x : 0
  const dy = prev ? p.y - prev.y : 0
  const len = Math.hypot(dx, dy)
  const back = len > 1e-6 ? MOTOR_BACK / len : 0
  out.soft.push({ x: p.x - dx * back, y: p.y - dy * back, size: MOTOR_SIZE, color: MOTOR, alpha: 0.9, tex: 0, rot: 0, under: true })
  const pts = p.trail
  if (pts.length < 2) return
  const rnd = new Lcg((p.id % 2147483646) + 1)
  for (let i = 0; i < pts.length - 1; i++) {
    const t = i / (pts.length - 1)
    const tint = 0.8 + 0.3 * rnd.next()
    const jx = (rnd.next() - 0.5) * 6 * (1 - t)
    const jy = (rnd.next() - 0.5) * 6 * (1 - t)
    out.smoke.push({
      x: pts[i]!.x + jx,
      y: pts[i]!.y + jy - (1 - t) * 10,
      size: TRAIL_SIZE * (1 + (1 - t) * TRAIL_GROW),
      color: [look.smoke[0] * tint, look.smoke[1] * tint, look.smoke[2] * tint],
      alpha: 0.12 + 0.5 * t,
      tex: 1,
      rot: rnd.next() * 6,
    })
  }
}

/** A small hot round (a pellet, a fragment, a drop): a glow in its colour and a short streak behind it. */
export function emberFx(out: FxFrame, p: Pick<TrackedProjectile, 'x' | 'y' | 'trail'>, colour: number, r: number): void {
  const c = hexToLinear(colour)
  const hot: Rgb = [c[0] * 2.2, c[1] * 2.2, c[2] * 2.2]
  out.soft.push({ x: p.x, y: p.y, size: r * 6, color: hot, alpha: 0.9, tex: 0, rot: 0, under: true })
  const tail = p.trail.length >= 2 ? p.trail[Math.max(0, p.trail.length - 4)]! : null
  if (tail && Math.hypot(p.x - tail.x, p.y - tail.y) > 1) {
    out.ribbons.push({ pts: [[tail.x, tail.y], [p.x, p.y]], width: r * 1.5, core: hot, glow: scale(c, 0.6), fadePow: 1.2, headBoost: 1, under: true })
  }
}

/** F1's muzzle: `sprite(softTex(), m0, 42, 34, Color(2.5, 1.6, 0.6), 0.9, true)` — where the muzzle light is, as strong. */
export const MUZZLE_SIZE = 34
export const MUZZLE: Rgb = [2.5, 1.6, 0.6]
/** `share`: the muzzle light's intensity over `MUZZLE_LIGHT.i` (1, then ½, for `MUZZLE_FRAMES` lists). */
export function muzzleFx(out: FxFrame, x: number, y: number, share: number): void {
  if (!(share > 0)) return
  out.soft.push({ x, y, size: MUZZLE_SIZE, color: MUZZLE, alpha: 0.9 * Math.min(1, share), tex: 0, rot: 0, under: true })
}

/**
 * A flamethrower's cone (`cone` event: aim, range, arc): F1's flamer flame — seven glows along the aim, pale yellow
 * near the nozzle, orange beyond (`f_scene.js`: `S.glow(15 + i·4.5, …, 3 + i·1.8, i < 3 ? '255,215,110' : '255,110,30',
 * 0.9 − i·0.08)`) — stretched to the cone's range and as wide as its arc, overlapping into one tongue as the canvas's
 * glows do; F1's 60 px flamer sprite over it.
 */
export const CONE_GLOWS = 7
const CONE_NEAR = rgbToLinear('255,215,110')
const CONE_FAR = rgbToLinear('255,110,30')
export function coneFx(out: FxFrame, j: { x: number; y: number; aim: number; range: number; arc: number; ttl: number; life: number }): void {
  const k = j.life > 0 ? clamp01(j.ttl / j.life) : 0
  if (!(k > 0)) return
  const cx = Math.cos(j.aim)
  const cy = Math.sin(j.aim)
  for (let i = 0; i < CONE_GLOWS; i++) {
    const d = (j.range * (i + 0.5)) / CONE_GLOWS
    const half = Math.max(3, d * Math.tan(Math.min(1.2, j.arc / 2)))
    const c = i < 3 ? CONE_NEAR : CONE_FAR
    const a = (0.9 - i * 0.08) * k
    out.soft.push({ x: j.x + cx * d, y: j.y + cy * d, size: half * 3.4, color: [c[0] * 1.4, c[1] * 1.4, c[2] * 1.4], alpha: a * 0.55, tex: 0, rot: 0, under: true })
  }
  out.soft.push({ x: j.x + cx * j.range * 0.35, y: j.y + cy * j.range * 0.35, size: j.range * 1.1, color: FLAME_GLOW, alpha: 0.5 * k, tex: 0, rot: 0, under: true })
}

/**
 * A melee swing: a pale arc ribbon at its reach, across its arc, bright at the leading edge (R10: no new saturated
 * colour — steel, not fire). A swing that connected is brighter and wider.
 */
export const SWING_POINTS = 12
/**
 * The arc's width, world px (miss / hit). T23.10 (R6): tuned at zoom 2 as 4 / 6 — on screen 8 / 12 px; at zoom 1 that
 * was a 2-buffer-px hairline on the low tier whose fading tail no longer read (`swing-mine-fx`: 2 of 5 arc points), so
 * restated to keep its on-screen width. Not F's (no picture has a swing): the game's own, like the arc's colours.
 */
export const SWING_WIDTH = 8
export const SWING_HIT_WIDTH = 12
/**
 * How the arc fades in from its tail (`layer.ts`: `pow(u, fadePow)` along it). T23.25B F1: 1.5 → 1.0 — additive, the
 * tail is laid over the pale noon sky with little left to brighten, and `swing-mine-fx`'s day leg read its first point
 * 23–27 against `VISIBLE` 24 (night 36). Linear keeps it a sweep that brightens to the leading edge.
 */
export const SWING_FADE_POW = 1.0
export function swingFx(out: FxFrame, s: { x: number; y: number; aim: number; reach: number; arc: number; hits: number; ttl: number; life: number }): void {
  const k = s.life > 0 ? clamp01(s.ttl / s.life) : 0
  if (!(k > 0)) return
  const pts: [number, number, number][] = []
  for (let i = 0; i <= SWING_POINTS; i++) {
    const t = i / SWING_POINTS
    const a = s.aim - s.arc / 2 + s.arc * t
    pts.push([s.x + Math.cos(a) * s.reach, s.y + Math.sin(a) * s.reach, 0.4 + 0.6 * t])
  }
  const hit = s.hits > 0
  const core: Rgb = hit ? [1.6, 1.55, 1.45] : [1.0, 1.05, 1.15]
  const glow: Rgb = hit ? [0.35, 0.3, 0.25] : [0.12, 0.13, 0.16]
  out.ribbons.push({ pts, width: hit ? SWING_HIT_WIDTH : SWING_WIDTH, core: scale(core, k), glow: scale(glow, k), fadePow: SWING_FADE_POW, headBoost: 0.5 })
}

/** A mine: an ink disc and its tell — amber until armed, then a red blink (danger, R10). `alpha`: its visibility by distance. */
export const MINE_SIZE = 22
export const MINE_INK: Rgb = hexToLinear(0x07060a)
export const MINE_ARMED: Rgb = [2.2, 0.25, 0.12]
export const MINE_SAFE: Rgb = [1.6, 0.9, 0.2]
export function mineFx(out: FxFrame, m: { x: number; y: number }, alpha: number, armed: boolean, nowMs: number): void {
  if (!(alpha > 0)) return
  out.ink.push({ x: m.x, y: m.y, size: MINE_SIZE, color: MINE_INK, alpha, tex: 0, rot: 0 })
  const blink = armed ? 0.55 + 0.45 * Math.sin(nowMs * 0.012) : 0.35
  out.soft.push({ x: m.x, y: m.y - 2, size: MINE_SIZE * 0.55, color: armed ? MINE_ARMED : MINE_SAFE, alpha: alpha * blink, tex: 0, rot: 0 })
}
