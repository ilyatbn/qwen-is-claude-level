/**
 * T22.06 — the space backdrop, drawn: stars, the sun, the earth and the moon, all
 * moving on the round's clock. `spaceSky-math.ts` has the where and the what; this
 * file only places sprites.
 *
 * Owned by `SkyLayer`, which shows this *instead of* its gradient's day, its sun and
 * moon arcs, its night stars and the parallax band. Everything here sits at
 * `DEPTH.sky`, under the terrain, the thruster plume and the radiation edge glow.
 *
 * **Both render paths draw the same thing**: every colour is baked into a texture, so
 * nothing depends on `setTint` (which Canvas ignores), and the glows are `ADD`, which
 * Canvas has as `lighter`.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { DEPTH } from './backdrop'
import {
  earthPixels,
  moonPixels,
  shadowPixels,
  spaceBodies,
  spaceSkySeed,
  spaceStars,
  starAt,
  type SpaceSkySeed,
  type SpaceStar,
} from './spaceSky-math'

/** One body's last placement, camera space and screen space, for `debug()`. */
export interface SpaceBodyDebug {
  /** Where Phaser was told to put it (camera space, before its scroll factor). */
  x: number
  y: number
  /** Where it lands on the canvas this frame, px. */
  screenX: number
  screenY: number
  /** On-screen radius, px. */
  screenR: number
  visible: boolean
}

export interface SpaceSkyDebug {
  seed: number
  stars: number
  starsDrawn: number
  /** A checksum of the star field, so two seeds can be told apart without pixels. */
  starHash: number
  sun: SpaceBodyDebug
  earth: SpaceBodyDebug
  moon: SpaceBodyDebug & { front: boolean }
  /** The clock the last frame was placed at. */
  clock: number
  hidden: SpaceBodyName[]
}

let generation = 0
/** Camera px a planet's night-side shade reaches past its disc (see the constructor). */
const SHADE_OVERHANG = 2

export type SpaceBodyName = 'sun' | 'earth' | 'moon'
const BODY_NAMES: readonly SpaceBodyName[] = ['sun', 'earth', 'moon']

export class SpaceSky {
  private readonly scene: Phaser.Scene
  private moonFront = false
  private readonly starGfx: Phaser.GameObjects.Graphics
  private readonly sunGlow: Phaser.GameObjects.Image
  private readonly sun: Phaser.GameObjects.Image
  private readonly earthGlow: Phaser.GameObjects.Image
  private readonly earth: Phaser.GameObjects.Image
  private readonly earthShade: Phaser.GameObjects.Image
  private readonly moon: Phaser.GameObjects.Image
  private readonly moonShade: Phaser.GameObjects.Image
  private readonly keys: string[] = []
  private readonly gen = ++generation
  private seed = 0
  private phases: SpaceSkySeed = spaceSkySeed(0)
  private stars: SpaceStar[] = []
  private starsDrawn = 0
  private shown = false
  /** A check's control frame: these bodies off, everything else left on. */
  private readonly hiddenBodies = new Set<SpaceBodyName>()
  private clock = 0

  constructor(scene: Phaser.Scene) {
    this.scene = scene
    const c = C()
    const par = c.SPACE_BODY_PARALLAX
    const body = (key: string, depth: number) =>
      scene.add.image(0, 0, key).setScrollFactor(par).setDepth(depth).setVisible(false)
    // Stars in front of the gradient (`sky`), bodies in front of the stars; the
    // moon's depth flips per frame around the earth's (`sky + 3`).
    this.starGfx = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH.sky + 1).setVisible(false)
    this.sunGlow = body(this.glow('sun_glow', [255, 226, 160]), DEPTH.sky + 2)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(c.SPACE_SUN_RADIUS * c.SPACE_SUN_GLOW * 2, c.SPACE_SUN_RADIUS * c.SPACE_SUN_GLOW * 2)
    this.sun = body(this.sunDisc(c.SPACE_SUN_RADIUS), DEPTH.sky + 2)
    this.earthGlow = body(this.glow('earth_glow', [90, 160, 255]), DEPTH.sky + 3)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(c.SPACE_EARTH_RADIUS * 2.5, c.SPACE_EARTH_RADIUS * 2.5)
    this.earth = body(this.key('earth'), DEPTH.sky + 3)
    // The shades are a little larger than their planets: rotated under NEAREST
    // filtering, a same-size disc left a dotted ring of lit rim around the night side.
    const shade = (r: number) => r + SHADE_OVERHANG
    this.earthShade = body(this.pixels('earth_shade', shadowPixels(shade(c.SPACE_EARTH_RADIUS), 0.92), shade(c.SPACE_EARTH_RADIUS)), DEPTH.sky + 3)
    this.moon = body(this.key('moon'), DEPTH.sky + 3)
    this.moonShade = body(this.pixels('moon_shade', shadowPixels(shade(c.SPACE_MOON_RADIUS), 0.9), shade(c.SPACE_MOON_RADIUS)), DEPTH.sky + 3)
    // A real texture before the first map arrives, not Phaser's missing-texture square.
    this.setSeed(0)
  }

  /** Point the sky at a map: its seed decides the arrangement, the stars and the planets. */
  setSeed(seed: number): void {
    const c = C()
    this.seed = seed
    this.phases = spaceSkySeed(seed)
    this.stars = spaceStars(seed, c.SPACE_STAR_COUNT)
    this.earth.setTexture(this.pixels('earth', earthPixels(seed, c.SPACE_EARTH_RADIUS), c.SPACE_EARTH_RADIUS))
    this.moon.setTexture(this.pixels('moon', moonPixels(seed, c.SPACE_MOON_RADIUS), c.SPACE_MOON_RADIUS))
  }

  /**
   * Place everything for round time `t`. `scrollX`/`scrollY` are the camera's
   * **live** scroll, read after the rig moved it this frame.
   */
  update(t: number, view: { left: number; top: number; w: number; h: number }, scrollX: number, scrollY: number): void {
    if (!this.shown) return
    const c = C()
    this.clock = t
    const b = spaceBodies(t, this.phases, c, view.w, view.h)
    // A body at view fraction (fx, fy) lands there when the camera is centred on the
    // map; flying away from the centre shifts it by the scroll times its parallax. The
    // map's size is the camera's bounds (`CameraRig` sets them to it) — derived, so no
    // caller can hand the sky a map size that disagrees with the one being flown.
    const cam = this.scene.cameras.main
    const map = cam.useBounds ? cam.getBounds() : { width: cam.width, height: cam.height }
    const ox = (map.width / 2 - cam.width / 2) * c.SPACE_BODY_PARALLAX
    const oy = (map.height / 2 - cam.height / 2) * c.SPACE_BODY_PARALLAX
    const at = (fx: number, fy: number) => ({ x: view.left + fx * view.w + ox, y: view.top + fy * view.h + oy })

    const sun = at(b.sun.fx, b.sun.fy)
    const earth = at(b.earth.fx, b.earth.fy)
    this.sun.setPosition(sun.x, sun.y)
    this.sunGlow.setPosition(sun.x, sun.y)
    this.earth.setPosition(earth.x, earth.y)
    this.earthGlow.setPosition(earth.x, earth.y)
    this.earthShade.setPosition(earth.x, earth.y).setRotation(b.sunward)
    const mx = earth.x + b.moon.dx
    const my = earth.y + b.moon.dy
    // The sun is far enough that the moon's lit side faces the same way as the earth's.
    this.moon.setPosition(mx, my)
    this.moonShade.setPosition(mx, my).setRotation(b.sunward)
    const moonDepth = b.moon.front ? DEPTH.sky + 4 : DEPTH.sky + 2
    this.moon.setDepth(moonDepth)
    this.moonShade.setDepth(moonDepth)
    this.moonFront = b.moon.front

    this.drawStars(t, view, scrollX, scrollY)
  }

  private drawStars(t: number, view: { left: number; top: number; w: number; h: number }, sx: number, sy: number): void {
    const c = C()
    const g = this.starGfx
    g.clear()
    this.starsDrawn = 0
    for (const s of this.stars) {
      const p = starAt(s, t, c.SPACE_STAR_DRIFT, sx, sy, c.SPACE_STAR_PARALLAX, view.w, view.h)
      g.fillStyle(s.color, p.a)
      g.fillRect(view.left + p.x, view.top + p.y, s.size, s.size)
      this.starsDrawn++
    }
  }

  /** Show or hide the whole space sky — `SkyLayer` does this when the mode changes. */
  setShown(on: boolean): void {
    this.shown = on
    this.starGfx.setVisible(on)
    this.applyVisibility()
    if (!on) this.starGfx.clear()
  }

  /**
   * A check's control frame: hide one body (or all three), so the pixels that change
   * are proved to be that body and no other — the moon passes close to the earth, and
   * a patch around it would otherwise carry the earth's glow.
   */
  setBodiesVisible(on: boolean, which: SpaceBodyName | 'all' = 'all'): void {
    for (const n of which === 'all' ? BODY_NAMES : [which]) {
      if (on) this.hiddenBodies.delete(n)
      else this.hiddenBodies.add(n)
    }
    this.applyVisibility()
  }

  private applyVisibility(): void {
    for (const n of BODY_NAMES) {
      for (const o of this.body(n)) o.setVisible(this.shown && !this.hiddenBodies.has(n))
    }
  }

  private body(n: SpaceBodyName): Phaser.GameObjects.Image[] {
    if (n === 'sun') return [this.sunGlow, this.sun]
    if (n === 'earth') return [this.earthGlow, this.earth, this.earthShade]
    return [this.moon, this.moonShade]
  }

  debug(): SpaceSkyDebug {
    const cam = this.scene.cameras.main
    const z = cam.zoom || 1
    const par = C().SPACE_BODY_PARALLAX
    // Phaser's own transform for a scroll-factor object: scroll it, then zoom about
    // the camera's centre. A check photographs `screenX/Y`; if this formula were
    // wrong the patch would be empty sky and the check would say so.
    const place = (o: Phaser.GameObjects.Image, r: number): SpaceBodyDebug => ({
      x: o.x,
      y: o.y,
      screenX: cam.x + (o.x - cam.scrollX * par - cam.width / 2) * z + cam.width / 2,
      screenY: cam.y + (o.y - cam.scrollY * par - cam.height / 2) * z + cam.height / 2,
      screenR: r * z,
      visible: o.visible,
    })
    let hash = 0
    for (const s of this.stars) hash = (Math.imul(hash, 31) + Math.round(s.u * 1e6) + Math.round(s.v * 1e6)) | 0
    const c = C()
    return {
      seed: this.seed,
      stars: this.stars.length,
      starsDrawn: this.shown ? this.starsDrawn : 0,
      starHash: hash,
      sun: place(this.sun, c.SPACE_SUN_RADIUS),
      earth: place(this.earth, c.SPACE_EARTH_RADIUS),
      moon: { ...place(this.moon, c.SPACE_MOON_RADIUS), front: this.moonFront },
      clock: this.clock,
      hidden: [...this.hiddenBodies],
    }
  }

  destroy(): void {
    this.starGfx.destroy()
    for (const o of this.bodies()) o.destroy()
    for (const k of this.keys) if (this.scene.textures.exists(k)) this.scene.textures.remove(k)
  }

  private bodies(): Phaser.GameObjects.Image[] {
    return BODY_NAMES.flatMap((n) => this.body(n))
  }

  private key(name: string): string {
    return `__space_${name}_${this.gen}`
  }

  /** Upload RGBA pixels as this instance's texture `name`, replacing any earlier one. */
  private pixels(name: string, data: Uint8ClampedArray, r: number): string {
    const key = this.key(name)
    const size = Math.ceil(r * 2)
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key)
    const tex = this.scene.textures.createCanvas(key, size, size)
    const ctx = tex?.getContext()
    if (!tex || !ctx) return key
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0)
    tex.refresh()
    if (!this.keys.includes(key)) this.keys.push(key)
    return key
  }

  /** The sun: a white-hot core fading to gold at its rim, drawn smooth rather than stepped. */
  private sunDisc(r: number): string {
    const key = this.key('sun')
    const size = Math.ceil(r * 2)
    const tex = this.scene.textures.createCanvas(key, size, size)
    const ctx = tex?.getContext()
    if (!tex || !ctx) return key
    const g = ctx.createRadialGradient(r, r, 0, r, r, r)
    g.addColorStop(0, '#ffffff')
    g.addColorStop(0.55, '#fff6d8')
    g.addColorStop(0.9, '#ffd98a')
    g.addColorStop(1, 'rgba(255,200,110,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    tex.refresh()
    tex.setFilter(Phaser.Textures.FilterMode.LINEAR)
    this.keys.push(key)
    return key
  }

  /**
   * A soft coloured glow, the colour **baked in** — Canvas cannot tint, and the ground
   * sky's `glowTexture` is white for a tint that never reaches the Canvas path.
   */
  private glow(name: string, [r, g, b]: [number, number, number]): string {
    const key = this.key(name)
    const size = 128
    const tex = this.scene.textures.createCanvas(key, size, size)
    const ctx = tex?.getContext()
    if (!tex || !ctx) return key
    const h = size / 2
    const grad = ctx.createRadialGradient(h, h, 0, h, h, h)
    grad.addColorStop(0, `rgba(${r},${g},${b},0.6)`)
    grad.addColorStop(0.2, `rgba(${r},${g},${b},0.3)`)
    grad.addColorStop(0.5, `rgba(${r},${g},${b},0.08)`)
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    tex.refresh()
    tex.setFilter(Phaser.Textures.FilterMode.LINEAR)
    this.keys.push(key)
    return key
  }
}
