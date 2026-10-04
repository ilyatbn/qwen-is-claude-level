/**
 * T23.09: **the effects are the lights.** One per-frame list of `f_scene.js`-shaped point lights
 * (`{x, y, z, r, rgb, i}`, mask px) built from what the client already draws — the ordnance layer's
 * projectiles, tracers and impacts, the bodies it draws jetting, the lava vents it derives, and the
 * gates it builds — for the lit terrain's point-light slots (`terrainLights.ts::pickLights` culls it
 * to the view + radius, ranks by intensity × on-screen coverage and keeps `TERRAIN_LIGHTS`).
 *
 * **Cosmetic (R3).** Nothing here reads or writes the simulation; every input is a render-side
 * record the scenes already keep. Two clients may light the same blast a frame apart.
 *
 * Every value below is the mockup's: `tasks/M23/reference/mockup-src/f_scene.js::combatF`'s `L(...)`
 * list (the F1/F2/F5 combat scene), colours from its palette `P` (`F1.palette`). What the still
 * picture cannot say — how a light changes over time — is decided here and stated at each constant.
 */
import type { Tracer, Impact, TrackedProjectile, ProjectileKind } from '../render/ordnance-state'
import type { CombatPalette, Light, RgbString, ViewRect } from './scene'
import { F1 } from './scenes/F1'
import { BLACK_HOLE_LIGHT } from './fx/blackHole'
import { flareLights, type FlareView } from './fx/flare'

/** One light's shape before it is placed: `L(x, y, z, r, rgb, i)` less the position. */
export interface LightSpec {
  z: number
  r: number
  rgb: RgbString
  i: number
}

/** `P` for F1 (`variant_F1.js`): the colours below. F1's data always has one; the type allows scenes that do not. */
function palette(): CombatPalette {
  if (!F1.palette) throw new Error('F1 has no palette')
  return F1.palette
}
const P = palette()

/**
 * `f_scene.js::combatF` — `L(1115, 515, 70, 460, P.fire, 3.2) // explosion`. **Decays** linearly to
 * 0 over the impact's life (`OrdnanceState.addImpact`'s `ttl`, the flat flash's 0.35 s). Every blast
 * gets the same radius whatever its damage radius: the picture has one explosion and no rule for
 * scaling it (decision, T23.09).
 */
export const EXPLOSION_LIGHT: LightSpec = { z: 70, r: 460, rgb: P.fire, i: 3.2 }
/** `f_scene.js::combatF` — `L(l1[0], l1[1], 30, 170, P.laser, 2.4) // laser impact`; at a beam's far end, fading with the beam. */
export const LASER_IMPACT_LIGHT: LightSpec = { z: 30, r: 170, rgb: P.laser, i: 2.4 }
/** `f_scene.js::combatF` — `L(m0[0], m0[1], 30, 120, P.muzzle, 1.8) // turret muzzle`; for `MUZZLE_FRAMES` frames. */
export const MUZZLE_LIGHT: LightSpec = { z: 30, r: 120, rgb: P.muzzle, i: 1.8 }
/** `f_scene.js::combatF` — `L(ex - 4, ey - 4, 20, 100, P.fire, 1.3) // enemy jet plume`, at the jetting figure's feet. */
export const JET_PLUME_LIGHT: LightSpec = { z: 20, r: 100, rgb: P.fire, i: 1.3 }
/** `f_scene.js::combatF` — `L(rx - 8, ry, 20, 120, P.fire, 1.5) // rocket motor`, `ROCKET_MOTOR_BACK` px behind the round. */
export const ROCKET_LIGHT: LightSpec = { z: 20, r: 120, rgb: P.fire, i: 1.5 }
/** `f_scene.js::combatF` — `L(qx2 - 34, qy2 - 26, 20, 150, P.fire, 2.0) // teammate's flamethrower`: one per `FLAME_CELL` of fire. */
export const FLAMETHROWER_LIGHT: LightSpec = { z: 20, r: 150, rgb: P.fire, i: 2.0 }
/** `f_scene.js::combatF` — `L(gx, gyy - 24, 30, 150, P.gate, 1.6) // gate`, `GATE_LIGHT_RISE` above the pad's feet line. */
export const GATE_LIGHT: LightSpec = { z: 30, r: 150, rgb: P.gate, i: 1.6 }
/**
 * `f_scene.js::combatF` — `L(250, gy(250, 250) - 14, 20, 110, P.crystal, 1.2)` (the big cluster; the small
 * one is r 100 i 1.0). **No caller yet**: crystals are stamped rock (R5) and T23.19 places them from the
 * objects manifest; they go in `StaticLights` beside the gates.
 */
export const CRYSTAL_LIGHT: LightSpec = { z: 20, r: 110, rgb: P.crystal, i: 1.2 }
/** `f_scene.js::combatF` — `L(735, gy(735, 520) - 8, 8, 40, '255,60,30', 0.5)`, F1's lava glow: a vent's burning mouth. */
export const LAVA_GLOW_LIGHT: LightSpec = { z: 8, r: 40, rgb: '255,60,30', i: 0.5 }

/** "muzzle … for 1–2 frames" (research § 3): the flash's frames, `i` then `i/2`. Counted in built lists, not seconds, so a 20 fps tier still draws it. */
export const MUZZLE_FRAMES = 2
/** `rx - 8`: the rocket light sits this far behind the round, along its travel. */
export const ROCKET_MOTOR_BACK = 8
/** `gyy - 24`: the gate light's height above the pad's feet line, world px. */
export const GATE_LIGHT_RISE = 24
/** A lava vent's jet is lit this far above the mouth — the column, not the hole (`weather-math.ts`'s old `JET_LIGHT_RISE`). */
export const VENT_JET_RISE = 60
/** Flames closer than this share one flamethrower light (its radius): a molotov's 24 flames are one fire, not 24 lamps. */
export const FLAME_CELL = FLAMETHROWER_LIGHT.r

/** Projectiles that leave a gun — a flash at the spot they were first drawn. Thrown things and rain do not. */
const MUZZLE_KINDS: ReadonlySet<ProjectileKind> = new Set(['bullet', 'bazooka', 'airburst'])
/** Projectiles that carry their own fire (the rocket motor). */
const MOTOR_KINDS: ReadonlySet<ProjectileKind> = new Set(['bazooka', 'meteor'])

/** `spec` at `(x, y)`, its intensity × `k` (clamped to 0..1); `null` once `k` is spent. */
export function place(spec: LightSpec, x: number, y: number, k = 1): Light | null {
  const f = Math.min(1, Math.max(0, k))
  if (!(f > 0)) return null
  return { x, y, z: spec.z, r: spec.r, rgb: spec.rgb, i: spec.i * f }
}

/** The explosion's light at its impact's remaining life (`life / ttl`): full at the blast, 0 at its end. */
export function explosionLight(im: Pick<Impact, 'x' | 'y' | 'life' | 'ttl'>): Light | null {
  return place(EXPLOSION_LIGHT, im.x, im.y, im.ttl > 0 ? im.life / im.ttl : 0)
}

/**
 * The static lights (gates today; crystals with T23.19) in a uniform grid, so a frame asks only the
 * cells its view + the largest radius touches rather than walking every light on the map.
 */
export class StaticLights {
  private readonly cells = new Map<string, Light[]>()
  private maxR = 0
  constructor(private readonly cell = 512) {}

  set(lights: readonly Light[]): void {
    this.cells.clear()
    this.maxR = 0
    for (const l of lights) {
      const key = `${Math.floor(l.x / this.cell)},${Math.floor(l.y / this.cell)}`
      const list = this.cells.get(key)
      if (list) list.push(l)
      else this.cells.set(key, [l])
      this.maxR = Math.max(this.maxR, l.r)
    }
  }

  /**
   * Every light whose cell lies within `view` grown by the largest radius (a superset; `pickLights` culls exactly),
   * appended to `out` (T23.09C F8: the per-frame caller passes its own scratch list).
   */
  query(view: ViewRect, out: Light[] = []): Light[] {
    if (!this.cells.size) return out
    const x0 = Math.floor((view.x - this.maxR) / this.cell)
    const x1 = Math.floor((view.x + view.w + this.maxR) / this.cell)
    const y0 = Math.floor((view.y - this.maxR) / this.cell)
    const y1 = Math.floor((view.y + view.h + this.maxR) / this.cell)
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.cells.get(`${cx},${cy}`)
        if (list) for (const l of list) out.push(l)
      }
    }
    return out
  }

  get size(): number {
    let n = 0
    for (const l of this.cells.values()) n += l.length
    return n
  }
}

/** The gates' lights from the pads the scene built (`PadView`: feet line). */
export function gateLights(pads: readonly { x: number; y: number }[]): Light[] {
  return pads.flatMap((p) => place(GATE_LIGHT, p.x, p.y - GATE_LIGHT_RISE) ?? [])
}

/** Phaser's `worldView` (`width`/`height`) as the renderer's `ViewRect`. */
export function viewRect(r: { x: number; y: number; width: number; height: number }): ViewRect {
  return { x: r.x, y: r.y, w: r.width, h: r.height }
}

/**
 * A player view's jet light source — **its flame** as drawn (`PlayerView.flame`: the flame's glow, F1's `ex − 3,
 * ey − 6`, beside the mockup's light at `ex − 4, ey − 4`), T23.14B; it was the feet, which a body turned in space
 * leaves behind — or none: not drawn (culled by the dark), or no flame (not burning, dead, hidden).
 */
export function jetFlames(v: { container: { visible: boolean }; flame: { x: number; y: number } | null } | null): { x: number; y: number }[] {
  const f = v?.flame
  if (!v || !f || !v.container.visible) return []
  return [{ x: f.x, y: f.y }]
}

/** What a frame's effect lights are built from — records the scenes already keep and draw. */
export interface EffectSources {
  /** `OrdnanceState`: rounds in flight, beams, blasts. */
  projectiles: Iterable<TrackedProjectile>
  tracers: readonly Tracer[]
  impacts: readonly Impact[]
  /** The flame of every **drawn** body whose jetpack/thruster is firing (a hidden remote casts no light). */
  jets: readonly { x: number; y: number }[]
  /** The lava vents drawn this frame. */
  vents: readonly { x: number; y: number; jetting: boolean; burning: boolean }[]
  /**
   * T23.09C F2: rounds that flash no muzzle — alive before this client first saw the list, or never seen leaving a
   * gun (`WorldView.staleRounds`, marked in `syncProjectiles`). Absent: every round is fresh when first listed.
   */
  stale?: { has(round: object): boolean }
  /** T23.20 part C: the black hole the world renderer draws (`fx/feed.ts::blackHole`) — a light while it is shown. */
  hole?: { x: number; y: number; growth: number; hidden: boolean } | null
  /** T23.20 part C: the solar flare the world renderer draws (`fx/feed.ts`) — lights along its loop while shown. */
  flare?: Pick<FlareView, 'points' | 'strength' | 'hidden'> | null
  /** T24.01: the hanging durian fruit's pulsing lights (`actors/durianTree.ts::fruitLights`, already capped). */
  fruit?: readonly Light[]
}

/** Which source each light in the last list came from — for the dev handle (count both ends). */
export type EffectKind = 'static' | 'explosion' | 'laser' | 'muzzle' | 'rocket' | 'flame' | 'jet' | 'vent' | 'hole' | 'flare' | 'fruit'

/**
 * The per-frame builder. Stateful only for the muzzle flash, which is a light for the first
 * `MUZZLE_FRAMES` lists a new round or beam appears in; everything else is derived from the
 * sources' own remaining life each frame.
 *
 * T23.09C F8: built in scratch (the lights, their kinds, the fire cells and the statics query are reused), and **a list
 * equal to the last one is the last one** — the same array back — so a still frame allocates nothing and the renderer
 * (`WorldRenderer.setLights`) sees nothing new. A list that differs is a new array of new lights: what `frame` returned
 * before is never changed under its holder.
 */
export class EffectLights {
  readonly statics = new StaticLights()
  /** Lists each round/beam has flashed in. Weak: a finished tracer or projectile record drops out on its own. */
  private readonly flashed = new WeakMap<object, number>()
  /** The last list and its kinds, index for index (dev handle: count both ends). */
  lastKinds: EffectKind[] = []
  last: Light[] = []
  private readonly scratch: Light[] = []
  private readonly scratchKinds: EffectKind[] = []
  private readonly statics_: Light[] = []
  private readonly flames = new Map<number, { x: number; y: number; n: number }>()
  private n = 0

  /** This frame's lights, in a stable order (statics, then dynamic) — `pickLights` keeps input order. */
  frame(src: EffectSources, view: ViewRect): Light[] {
    this.n = 0
    // Into the scratch pool, in place: `place`'s rule (intensity × k, clamped; nothing once k is spent) without a new
    // object per light per frame.
    const put = (spec: LightSpec, x: number, y: number, k: number, kind: EffectKind): void => {
      const f = Math.min(1, Math.max(0, k))
      if (!(f > 0)) return
      const l = this.scratch[this.n] ?? (this.scratch[this.n] = { x: 0, y: 0, z: 0, r: 0, rgb: spec.rgb, i: 0 })
      l.x = x
      l.y = y
      l.z = spec.z
      l.r = spec.r
      l.rgb = spec.rgb
      l.i = spec.i * f
      if (kind === 'muzzle') l.muzzle = true
      else delete l.muzzle
      if (kind === 'static') l.fixed = true
      else delete l.fixed
      if (kind === 'jet') l.body = true
      else delete l.body
      this.scratchKinds[this.n] = kind
      this.n++
    }
    this.statics_.length = 0
    for (const l of this.statics.query(view, this.statics_)) put(l, l.x, l.y, 1, 'static')
    for (const im of src.impacts) put(EXPLOSION_LIGHT, im.x, im.y, im.ttl > 0 ? im.life / im.ttl : 0, 'explosion')
    for (const t of src.tracers) {
      put(LASER_IMPACT_LIGHT, t.x1, t.y1, t.ttl > 0 ? t.life / t.ttl : 0, 'laser')
      put(MUZZLE_LIGHT, t.x0, t.y0, this.muzzle(t, true), 'muzzle')
    }
    const flames = this.flames
    flames.clear()
    for (const p of src.projectiles) {
      // T23.09C F2: freshness is the view's word (`stale`), not the trail's length — every round is first drawn with a
      // trail of two, so a round already in flight at a late join, a resync or a round first seen far from its gun
      // flashed in mid-air.
      if (MUZZLE_KINDS.has(p.kind)) put(MUZZLE_LIGHT, p.trail[0]?.x ?? p.x, p.trail[0]?.y ?? p.y, this.muzzle(p, !src.stale?.has(p)), 'muzzle')
      if (MOTOR_KINDS.has(p.kind)) {
        const prev = p.trail.length >= 2 ? p.trail[p.trail.length - 2]! : null
        const dx = prev ? p.x - prev.x : 0
        const dy = prev ? p.y - prev.y : 0
        const len = Math.hypot(dx, dy)
        const back = len > 1e-6 ? ROCKET_MOTOR_BACK / len : 0
        put(ROCKET_LIGHT, p.x - dx * back, p.y - dy * back, 1, 'rocket')
      }
      if (p.kind === 'flame') {
        // A cell key as one number: columns and rows of a map fit well inside 2^20.
        const key = Math.floor(p.x / FLAME_CELL) * 1048576 + Math.floor(p.y / FLAME_CELL)
        const c = flames.get(key)
        if (c) {
          c.x += p.x
          c.y += p.y
          c.n++
        } else flames.set(key, { x: p.x, y: p.y, n: 1 })
      }
    }
    for (const c of flames.values()) put(FLAMETHROWER_LIGHT, c.x / c.n, c.y / c.n, 1, 'flame')
    for (const j of src.jets) put(JET_PLUME_LIGHT, j.x, j.y, 1, 'jet')
    for (const v of src.vents) {
      if (v.jetting) put(FLAMETHROWER_LIGHT, v.x, v.y - VENT_JET_RISE, 1, 'vent')
      else if (v.burning) put(LAVA_GLOW_LIGHT, v.x, v.y, 1, 'vent')
    }
    // T23.20 part C: the black hole's disc lights the rock and the figures near it, as it swells in.
    if (src.hole && !src.hole.hidden) put(BLACK_HOLE_LIGHT, src.hole.x, src.hole.y, src.hole.growth, 'hole')
    // T23.20 part C: F3's effects are key lights — the flare's loop (the vortex is not one: `fx/vortex.ts` says why).
    for (const l of flareLights(src.flare ?? null)) put(l, l.x, l.y, 1, 'flare')
    // T24.01: the durian fruit glow, each at its pulse (its `i` already scaled).
    for (const l of src.fruit ?? []) put(l, l.x, l.y, 1, 'fruit')
    if (this.unchanged()) return this.last
    this.last = this.scratch.slice(0, this.n).map((l) => ({ ...l }))
    this.lastKinds = this.scratchKinds.slice(0, this.n)
    return this.last
  }

  /** Is this frame's scratch list the last list, light for light and kind for kind? */
  private unchanged(): boolean {
    if (this.n !== this.last.length) return false
    for (let k = 0; k < this.n; k++) {
      const a = this.scratch[k]!
      const b = this.last[k]!
      if (this.scratchKinds[k] !== this.lastKinds[k] || a.x !== b.x || a.y !== b.y || a.z !== b.z || a.r !== b.r || a.i !== b.i || a.rgb !== b.rgb) return false
    }
    return true
  }

  /**
   * `key`'s flash this list, as a share of `MUZZLE_LIGHT` — 1, then 1/2, for its first `MUZZLE_FRAMES` lists; 0 after.
   * `fresh`: the source may flash — a round the view marked stale (in flight before this client saw it, or never seen
   * leaving a gun) does not.
   */
  private muzzle(key: object, fresh: boolean): number {
    const n = this.flashed.get(key) ?? (fresh ? 0 : MUZZLE_FRAMES)
    if (n >= MUZZLE_FRAMES) {
      this.flashed.set(key, n)
      return 0
    }
    this.flashed.set(key, n + 1)
    return (MUZZLE_FRAMES - n) / MUZZLE_FRAMES
  }
}
