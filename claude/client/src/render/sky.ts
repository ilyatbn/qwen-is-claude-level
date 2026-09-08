/**
 * The sky: a five-phase gradient, a sun and a moon on their arcs, and stars.
 *
 * `docs/70-amendments-v2.md` §A4. All the maths lives in `sky-math.ts`, which is
 * Phaser-free and therefore tested (§A8); this file only draws.
 */

import Phaser from 'phaser'
import { C } from '../core'
import {
  bodyPositions,
  cycleU,
  skyColors,
  skyPhase,
  starAlpha,
  starField,
  type SkyPhase,
  type Star,
} from './sky-math'
import { DEPTH } from './backdrop'
import { ParallaxLayer } from './parallax'

const GRAD_KEY = '__sky_gradient'
const GRAD_H = 256

export class SkyLayer {
  private readonly scene: Phaser.Scene
  private readonly gradient: Phaser.GameObjects.Image
  private readonly starGfx: Phaser.GameObjects.Graphics
  private readonly sun: Phaser.GameObjects.Arc
  private readonly sunGlow: Phaser.GameObjects.Image
  private readonly moon: Phaser.GameObjects.Arc
  private readonly moonGlow: Phaser.GameObjects.Image
  private readonly stars: Star[]
  private readonly texture: Phaser.Textures.CanvasTexture | null
  /**
   * §C14's mountains and clouds.
   *
   * Owned by `SkyLayer` rather than added scene by scene: three scenes build a
   * sky, and a background that each of them had to remember to construct is a
   * background one of them would not have.
   */
  readonly parallax: ParallaxLayer

  /** Last colours baked, so the gradient is not redrawn every frame. */
  private lastTop = -1
  private lastBottom = -1
  private phase: SkyPhase = 'morning'
  /**
   * Set by `setVisible(false)`; `update` must not undo it on the next frame.
   *
   * The same latch `ParallaxLayer` carries, and for the same reason: the bodies
   * and the stars are shown or hidden per frame by their own rules, so without
   * this a hidden sky would come back on the very next tick and a check that
   * toggles the layer would diff a frame against itself.
   */
  private hidden = false

  constructor(scene: Phaser.Scene, seed = 0, themeId = 0) {
    this.scene = scene
    const c = C()
    const w = c.VIEWPORT_W
    const h = c.VIEWPORT_H

    if (scene.textures.exists(GRAD_KEY)) scene.textures.remove(GRAD_KEY)
    this.texture = scene.textures.createCanvas(GRAD_KEY, 2, GRAD_H) ?? null

    // Drawn generously oversized and pinned to the camera: with scrollFactor 0 the
    // image is in camera space, so at zoom < 1 a viewport-sized one covers only
    // part of the screen and the rest shows the clear colour.
    this.gradient = scene.add
      .image(-w, -h, GRAD_KEY)
      .setOrigin(0, 0)
      .setDisplaySize(w * 4, h * 4)
      .setScrollFactor(0)
      .setDepth(DEPTH.sky)

    this.parallax = new ParallaxLayer(scene, seed, themeId)

    this.stars = starField(c.STAR_COUNT ?? 220, w, h * 0.75)
    this.starGfx = scene.add
      .graphics()
      .setScrollFactor(c.SKY_BODY_PARALLAX ?? 0.08)
      .setDepth(DEPTH.sky + 1)

    const sunR = c.SUN_RADIUS ?? 34
    const moonR = c.MOON_RADIUS ?? 26
    const par = c.SKY_BODY_PARALLAX ?? 0.08

    // A glow is a **gradient**, not a translucent disc.
    //
    // These were flat `circle`s at uniform alpha, which draws a hard-edged pale
    // ring around the sun — at zoom 2 it read as a rendering bug rather than as
    // light. One texture each, generated once at boot, exactly as the lightmap
    // does for the same reason.
    this.sunGlow = scene.add
      .image(0, 0, glowTexture(scene, 'sky_glow_sun', 0xffd27a))
      .setScrollFactor(par)
      .setDepth(DEPTH.sky + 1)
      .setDisplaySize(sunR * 6, sunR * 6)
      .setBlendMode(Phaser.BlendModes.ADD)
    this.sun = scene.add
      .circle(0, 0, sunR, 0xfff2c4)
      .setScrollFactor(par)
      .setDepth(DEPTH.sky + 2)
    this.moonGlow = scene.add
      .image(0, 0, glowTexture(scene, 'sky_glow_moon', 0xbfd4ff))
      .setScrollFactor(par)
      .setDepth(DEPTH.sky + 1)
      .setDisplaySize(moonR * 5, moonR * 5)
      .setBlendMode(Phaser.BlendModes.ADD)
    this.moon = scene.add
      .circle(0, 0, moonR, 0xe8eeff)
      .setScrollFactor(par)
      .setDepth(DEPTH.sky + 2)
  }

  /** `darkness` is the server's scalar; the sky only uses it to fade the stars. */
  update(roundTime: number, darkness: number, nightDarkness = 0.82): void {
    const c = C()
    const u = cycleU(roundTime)
    this.phase = skyPhase(u)

    const { top, bottom } = skyColors(u)
    // Re-bake only when the interpolated colours actually change. At 120 s per day
    // that is a handful of times a second, not 60.
    if (top !== this.lastTop || bottom !== this.lastBottom) {
      this.lastTop = top
      this.lastBottom = bottom
      this.bakeGradient(top, bottom)
    }

    const w = c.VIEWPORT_W
    const horizon = c.VIEWPORT_H * 0.82
    const { sun, moon } = bodyPositions(u, w, horizon, c.SKY_BODY_ARC_H ?? 300)

    const place = (
      disc: Phaser.GameObjects.Arc,
      glow: Phaser.GameObjects.Image,
      b: { x: number; y: number; a: number } | null,
    ) => {
      const on = b !== null && b.a > 0.001 && !this.hidden
      disc.setVisible(on)
      glow.setVisible(on)
      if (!b) return
      disc.setPosition(b.x, b.y).setAlpha(b.a)
      glow.setPosition(b.x, b.y).setAlpha(b.a * 0.5)
    }
    place(this.sun, this.sunGlow, sun)
    place(this.moon, this.moonGlow, moon)

    // The sun warms toward the horizon, which is most of what sells sunrise and
    // sunset as different from midday.
    if (sun) {
      const height = 1 - Math.min(1, (horizon - sun.y) / (c.SKY_BODY_ARC_H ?? 300))
      this.sun.setFillStyle(mix(0xfff2c4, 0xff9d4a, height))
      this.sunGlow.setTint(mix(0xffd27a, 0xff7a3a, height))
    }

    this.drawStars(starAlpha(u, darkness, nightDarkness))

    // The parallax band gets the gradient's **own** bottom colour, so the haze
    // on a distant ridge cannot drift from the sky it is fading into.
    this.parallax.update(this.scene.time.now / 1000, bottom, this.scene.cameras.main.scrollX, u)
  }

  /** Point the background at a map. Call after every generate. */
  setSeed(seed: number, themeId: number): void {
    this.parallax.setSeed(seed, themeId)
  }

  get currentPhase(): SkyPhase {
    return this.phase
  }

  private bakeGradient(top: number, bottom: number): void {
    const ctx = this.texture?.getContext()
    if (!ctx) return
    const g = ctx.createLinearGradient(0, 0, 0, GRAD_H)
    g.addColorStop(0, `#${top.toString(16).padStart(6, '0')}`)
    g.addColorStop(1, `#${bottom.toString(16).padStart(6, '0')}`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 2, GRAD_H)
    this.texture?.refresh()
  }

  private drawStars(alpha: number): void {
    this.starGfx.clear()
    if (alpha <= 0.002 || this.hidden) {
      this.starGfx.setVisible(false)
      return
    }
    this.starGfx.setVisible(true)
    const t = this.scene.time.now / 1000
    for (const s of this.stars) {
      // Twinkle: a slow per-star sine, so the field shimmers instead of blinking
      // in unison.
      const tw = 0.75 + 0.25 * Math.sin(t * 1.7 + s.phase)
      this.starGfx.fillStyle(0xffffff, alpha * s.b * tw)
      this.starGfx.fillRect(s.x, s.y, 1, 1)
    }
  }

  /**
   * Show or hide the whole sky, for a check's control frame (§C2).
   *
   * The gradient, the bodies and the stars are this layer's; the ridges and
   * clouds belong to `parallax`, which carries the same latch. Toggling one
   * frozen frame against itself isolates what the sky contributes and nothing
   * else — a before/after across two moments would also catch the day cycle
   * advancing, which is not the thing being asserted.
   */
  setVisible(on: boolean): void {
    this.hidden = !on
    this.gradient.setVisible(on)
    this.starGfx.setVisible(on)
    this.sun.setVisible(on)
    this.sunGlow.setVisible(on)
    this.moon.setVisible(on)
    this.moonGlow.setVisible(on)
    this.parallax.setVisible(on)
  }

  destroy(): void {
    this.parallax.destroy()
    this.gradient.destroy()
    this.starGfx.destroy()
    this.sun.destroy()
    this.sunGlow.destroy()
    this.moon.destroy()
    this.moonGlow.destroy()
    if (this.scene.textures.exists(GRAD_KEY)) this.scene.textures.remove(GRAD_KEY)
  }
}

function mix(a: number, b: number, t: number): number {
  const ch = (sh: number) => {
    const av = (a >> sh) & 255
    const bv = (b >> sh) & 255
    return Math.round(av + (bv - av) * t) & 255
  }
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/**
 * A soft radial glow, generated once and reused.
 *
 * White with an alpha falloff so a caller can tint it. `pixelArt: true` forces
 * NEAREST filtering globally, which would stair-step a gradient this large, so
 * the texture opts into LINEAR — the same fix the half-resolution lightmap needed.
 */
function glowTexture(scene: Phaser.Scene, key: string, _tint: number): string {
  if (scene.textures.exists(key)) return key
  const size = 256
  const tex = scene.textures.createCanvas(key, size, size)
  const ctx = tex?.getContext()
  if (!ctx || !tex) return key
  const r = size / 2
  const g = ctx.createRadialGradient(r, r, 0, r, r, r)
  // Bright core, long tail: a linear ramp reads as a disc with a soft edge
  // rather than as light spilling into the sky.
  g.addColorStop(0, 'rgba(255,255,255,0.55)')
  g.addColorStop(0.18, 'rgba(255,255,255,0.34)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.12)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  tex.refresh()
  tex.setFilter(Phaser.Textures.FilterMode.LINEAR)
  return key
}
