/**
 * T23.18: `kit.js`'s effect vocabulary as data — the additive `ribbon`, the soft and smoke `sprite`s, the
 * `explosion` (smoke plume, fireball, glow, shock ring, sparks) — built in mask px (y down) and drawn by
 * `fx/layer.ts` into the HDR scene. Every number below is the mockup's (`tasks/M23/reference/mockup-src/kit.js`),
 * mirrored from its y-up world into mask px; what the still picture cannot say (how an effect changes with age) is
 * decided in `fx/game.ts`, not here.
 *
 * Pure: no three.js, no DOM (the textures are `fx/textures.ts`).
 */
import type { Fx, Rgb } from '../scene'

/** `kit.js::rnd` — Park–Miller, `_seed = 7` at page load. */
export class Lcg {
  constructor(public q = 7) {}
  next(): number {
    this.q = (this.q * 16807) % 2147483647
    return this.q / 2147483647
  }
}

/** An explosion at `z` 50 puts its smoke at `z − 5` and up: effects below it are drawn under the plume. */
export const SMOKE_Z = 45

/** `kit.js::smokeTex` draws 14 blobs of three `rnd()` each before an explosion places anything. */
export const SMOKE_TEX_DRAWS = 14 * 3

/** A soft or smoke sprite: `kit.js::sprite(tex, x, y, z, size, color, opacity, additive, rot)`. Mask px, `color` linear. */
export interface FxSprite {
  x: number
  y: number
  size: number
  color: Rgb
  alpha: number
  /** 0: `softTex` (radial), 1: `smokeTex` (blobs). The batch decides the texture: smoke (normal blending) is smokeTex, glows softTex. */
  tex: 0 | 1
  /** Radians, anticlockwise on screen (the mockup's `rotation.z` in its y-up world). */
  rot: number
  /** Additive only: drawn before the smoke (the mockup's z 40–43, under an explosion's plume at 45–47). */
  under?: boolean
  /** Blended by the brighter, not the sum (`fx/layer.ts`): a crowd of flames is one fire, not a white bar. */
  max?: boolean
}

/** `kit.js::ribbon`: points `[x, y, widthScale?]` in mask px, tail first. */
export interface FxRibbon {
  pts: [number, number, number?][]
  width: number
  core: Rgb
  glow: Rgb
  fadePow: number
  headBoost: number
  /** Drawn before the smoke (as `FxSprite.under`): tracers and beams; an explosion's sparks are over it. */
  under?: boolean
}

/**
 * A shaded disc: 0 the explosion's fireball (`explosion`'s ShaderMaterial), 1 a flame (the same fire, drawn as a
 * tongue), 2 the shock ring (`RingGeometry(118s, 126s)`, an additive annulus). `size` is the quad's side, mask px.
 */
export interface FxDisc {
  kind: 0 | 1 | 2
  x: number
  y: number
  size: number
  /** Fire: `a` noise offset (0 = the mockup's), `b` flow (noise units/s, 0 = still); ring: inner/outer radius as fractions of size/2. */
  a: number
  b: number
  /** Fire's temperature multiplier (1 = the mockup's); a cooling fire reddens, then goes. */
  heat: number
  /** Overall multiplier on what it adds (1 = the mockup's). */
  alpha: number
  /** Ring colour (linear); fire ignores it. */
  color: Rgb
  /** Blended by the brighter, not the sum (as `FxSprite.max`). */
  max?: boolean
}

/** One frame's effects, in the order each list is drawn (smoke under the additive layers — `fx/layer.ts`). */
export interface FxFrame {
  smoke: FxSprite[]
  /** Normal-blended soft discs over the smoke: ink (a mine's body). */
  ink: FxSprite[]
  soft: FxSprite[]
  ribbons: FxRibbon[]
  discs: FxDisc[]
}

export function emptyFrame(): FxFrame {
  return { smoke: [], ink: [], soft: [], ribbons: [], discs: [] }
}

export function clearFrame(f: FxFrame): void {
  f.smoke.length = 0
  f.ink.length = 0
  f.soft.length = 0
  f.ribbons.length = 0
  f.discs.length = 0
}

/** `THREE.Color(hex)`: sRGB bytes to linear (three's colour management), each channel. */
export function hexToLinear(hex: number): Rgb {
  const c = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)]
}

/** `'r,g,b'` sRGB to linear. */
export function rgbToLinear(rgb: string): Rgb {
  const [r, g, b] = rgb.split(',').map(Number) as [number, number, number]
  return hexToLinear((r << 16) | (g << 8) | b)
}

const SPARK_CORE: Rgb = [2.2, 1.2, 0.4]
const SPARK_GLOW: Rgb = [0.5, 0.15, 0.02]
const EXPLOSION_GLOW: Rgb = [1.0, 0.35, 0.08]
const RING: Rgb = [0.6, 0.55, 0.5]

/**
 * How an explosion changes with age (`fx/game.ts`); the mockup's still is `STILL`. Each is a multiplier on the
 * mockup's value, except `rise` (mask px the plume has climbed beyond the still) and `ring` (the ring's radius scale).
 */
export interface ExplosionAge {
  fire: number
  heat: number
  fireSize: number
  sparks: number
  sparkReach: number
  smoke: number
  smokeSize: number
  rise: number
  ring: number
  ringAlpha: number
  /** Noise offset for the fireball (0 = the mockup's), and how fast its fire boils (noise units/s; 0 = still). */
  seed: number
  flow: number
}
export const STILL: ExplosionAge = { fire: 1, heat: 1, fireSize: 1, sparks: 1, sparkReach: 1, smoke: 1, smokeSize: 1, rise: 0, ring: 1, ringAlpha: 1, seed: 0, flow: 0 }

const scaled = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]

/**
 * `kit.js::explosion(x, y, s, { smoke, z })` into `out`, at (x, y) mask px. `rnd` continues the mockup's stream
 * (for a reference scene: `Lcg(7)` advanced by `SMOKE_TEX_DRAWS`, the texture's draws). `age` is `STILL` for the
 * mockup's frame.
 */
export function explosion(out: FxFrame, x: number, y: number, s: number, smoke: number, rnd: Lcg, age: ExplosionAge = STILL): void {
  const plume = hexToLinear(smoke)
  // smoke behind: 22 sprites, `z - 5 + i * 0.1` — drawn in this order.
  for (let i = 0; i < 22; i++) {
    const a = rnd.next() * 6.283
    const r = (30 + rnd.next() * 60) * s
    const up = rnd.next()
    const size = (60 + rnd.next() * 70) * s * (0.7 + up * 0.6)
    const rot = rnd.next() * 6
    if (age.smoke > 0) {
      out.smoke.push({
        x: x + Math.cos(a) * r * 0.8,
        y: y - 20 * s - up * 110 * s - Math.sin(a) * 20 * s - age.rise * (0.5 + up),
        size: size * age.smokeSize,
        color: scaled(plume, 0.8 + up * 1.2),
        alpha: Math.min(1, (0.55 + up * 0.3) * age.smoke),
        tex: 1,
        rot,
      })
    }
  }
  if (age.fire > 0) out.discs.push({ kind: 0, x, y, size: 190 * s * age.fireSize, a: age.seed, b: age.flow, heat: age.heat, alpha: age.fire, color: [0, 0, 0] })
  if (age.fire > 0) out.soft.push({ x, y, size: 280 * s, color: EXPLOSION_GLOW, alpha: 0.14 * age.fire, tex: 0, rot: 0 })
  // shock ring: RingGeometry(118s, 126s), opacity 0.04, additive.
  if (age.ringAlpha > 0) {
    const R = 126 * s * age.ring
    // The quad a little wider than the ring, so its outer edge's anti-aliasing is not cut off.
    const m = 1.02
    out.discs.push({ kind: 2, x, y, size: 2 * R * m, a: 118 / 126 / m, b: 1 / m, heat: 1, alpha: 0.04 * age.ringAlpha, color: RING })
  }
  // sparks: 22 streaks.
  for (let i = 0; i < 22; i++) {
    const ang = -Math.PI * (0.05 + rnd.next() * 0.9) + (rnd.next() < 0.2 ? Math.PI : 0)
    const r0 = 40 * s
    const r1 = (90 + rnd.next() * 130) * s
    if (!(age.sparks > 0)) continue
    const pts: [number, number, number][] = []
    for (let k = 0; k <= 6; k++) {
      const t = k / 6
      const rr = (r0 + (r1 - r0) * t) * age.sparkReach
      pts.push([x + Math.cos(ang) * rr, y + Math.sin(ang) * rr + t * t * 30 * s * age.sparkReach, 1 - t * 0.5])
    }
    out.ribbons.push({ pts, width: 2.5 * s, core: scaled(SPARK_CORE, age.sparks), glow: scaled(SPARK_GLOW, age.sparks), fadePow: 0.7, headBoost: 1 })
  }
}

/**
 * A reference scene's `fx` list (`scene.ts::Fx`, the mockup's `fx3d` calls in order) as one frame. The explosion's
 * random stream starts where the mockup's does: seed 7, after its smoke texture's draws.
 */
export function sceneFx(list: readonly Fx[], out: FxFrame = emptyFrame()): FxFrame {
  const rnd = new Lcg(7)
  for (let i = 0; i < SMOKE_TEX_DRAWS; i++) rnd.next()
  let explosions = 0
  for (const f of list) {
    // z 40–43: under an explosion's smoke (z 45–47), as three's depth sort drew them.
    if (f.kind === 'ribbon') out.ribbons.push({ pts: f.pts.map(([x, y]) => [x, y] as [number, number]), width: f.width, core: f.core, glow: f.glow, fadePow: f.fadePow, headBoost: f.headBoost, under: f.z < SMOKE_Z })
    else if (f.kind === 'sprite') out.soft.push({ x: f.x, y: f.y, size: f.size, color: f.color, alpha: f.alpha, tex: 0, rot: 0, under: f.z < SMOKE_Z })
    else {
      // A second explosion would make (and draw) its own smoke texture from the stream first; no scene has two.
      if (explosions++ > 0) for (let i = 0; i < SMOKE_TEX_DRAWS; i++) rnd.next()
      explosion(out, f.x, f.y, f.scale, f.smoke, rnd)
    }
  }
  return out
}

/** The mask-px box `[x0, y0, x1, y1]` an effect can paint (its glow's full extent), for look-compare. */
export function fxBox(f: Fx): [number, number, number, number] {
  if (f.kind === 'ribbon') {
    const xs = f.pts.map((p) => p[0])
    const ys = f.pts.map((p) => p[1])
    const h = f.width / 2 + 1
    return [Math.floor(Math.min(...xs) - h), Math.floor(Math.min(...ys) - h), Math.ceil(Math.max(...xs) + h), Math.ceil(Math.max(...ys) + h)]
  }
  if (f.kind === 'sprite') return [Math.floor(f.x - f.size / 2), Math.floor(f.y - f.size / 2), Math.ceil(f.x + f.size / 2), Math.ceil(f.y + f.size / 2)]
  // The glow (280 s) sideways and below; above it, the plume: up to 20 + 110 + 20 s high, sprites up to 130·1.3/2·√2 s.
  const s = f.scale
  return [Math.floor(f.x - 140 * s), Math.floor(f.y - 270 * s), Math.ceil(f.x + 140 * s), Math.ceil(f.y + 140 * s)]
}
