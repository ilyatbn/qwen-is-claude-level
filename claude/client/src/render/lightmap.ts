/**
 * The darkness overlay, and the lights that cut holes in it.
 *
 * `docs/14-daynight-visibility.md` §5: fill a full-screen texture with the night
 * colour at the current darkness, **erase** each light source into it, then draw it
 * over the scene. Night is not a filter — it is a mask you carry a hole in.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { fovRadius, lightmapNeeded, type FovOpts } from './lightmap-math'
import { DEPTH } from './backdrop'

export { fovRadius, lightmapNeeded }
export type { FovOpts }

export interface LightSource {
  x: number
  y: number
  radius: number
  kind: 'radial' | 'cone'
  /** Cone only: direction in radians. */
  angle?: number
  /** Cone only: full cone angle in degrees. */
  coneDeg?: number
  /** 0..1 — how completely this light erases the dark. */
  intensity: number
}

const RADIAL_KEY = '__light_radial'
const CONE_KEY = '__light_cone'
const RADIAL_SIZE = 256
const CONE_SIZE = 256

export class Lightmap {
  private readonly scene: Phaser.Scene
  private readonly rt: Phaser.GameObjects.RenderTexture
  private readonly nightColor: number
  private readonly eraser: Phaser.GameObjects.Image
  readonly stats = { drawsLastFrame: 0 }

  constructor(scene: Phaser.Scene, nightColor = 0x000818) {
    this.scene = scene
    this.nightColor = nightColor
    const c = C()

    Lightmap.ensureTextures(scene)

    this.rt = scene.add
      .renderTexture(0, 0, c.VIEWPORT_W, c.VIEWPORT_H)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH.lightmap)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setVisible(false)

    // One reusable image, re-positioned and re-scaled per source. Building a
    // gradient per light per frame is the obvious way to write this and it halves
    // the frame rate.
    this.eraser = scene.add.image(0, 0, RADIAL_KEY).setVisible(false)
  }

  /**
   * The gradient and cone textures, generated once.
   *
   * `FOV_EDGE_SOFTNESS` is baked into the colour stops: opaque for the inner 65 %
   * of the radius, fading over the outer 35 %, so vision ends in a gradient rather
   * than at a line.
   */
  private static ensureTextures(scene: Phaser.Scene): void {
    const c = C()
    if (!scene.textures.exists(RADIAL_KEY)) {
      const tex = scene.textures.createCanvas(RADIAL_KEY, RADIAL_SIZE, RADIAL_SIZE)
      const ctx = tex?.getContext()
      if (ctx) {
        const r = RADIAL_SIZE / 2
        const g = ctx.createRadialGradient(r, r, 0, r, r, r)
        const solid = 1 - c.FOV_EDGE_SOFTNESS
        g.addColorStop(0, 'rgba(255,255,255,1)')
        g.addColorStop(solid, 'rgba(255,255,255,1)')
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, RADIAL_SIZE, RADIAL_SIZE)
        tex?.refresh()
      }
    }

    if (!scene.textures.exists(CONE_KEY)) {
      const tex = scene.textures.createCanvas(CONE_KEY, CONE_SIZE, CONE_SIZE)
      const ctx = tex?.getContext()
      if (ctx) {
        // Drawn pointing right (+x), so it can simply be rotated to the aim angle.
        const half = ((c.FLASHLIGHT_CONE_DEG * Math.PI) / 180) / 2
        const cx = 0
        const cy = CONE_SIZE / 2
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, CONE_SIZE)
        g.addColorStop(0, 'rgba(255,255,255,1)')
        g.addColorStop(0.65, 'rgba(255,255,255,0.85)')
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.arc(cx, cy, CONE_SIZE, -half, half)
        ctx.closePath()
        ctx.fill()
        tex?.refresh()
      }
    }
  }

  /**
   * Fill, erase, done. Costs **nothing** in daylight: the whole pass is skipped and
   * `stats.drawsLastFrame` stays 0, which `docs/14` §7 requires and T3.11 displays.
   */
  render(
    camera: Phaser.Cameras.Scene2D.Camera,
    darkness: number,
    sources: readonly LightSource[],
    fogActive = false,
  ): void {
    this.stats.drawsLastFrame = 0

    if (!lightmapNeeded(darkness, fogActive)) {
      this.rt.setVisible(false)
      return
    }

    this.rt.setVisible(true)
    this.rt.clear()
    this.rt.fill(this.nightColor, darkness)

    const zoom = camera.zoom
    for (const s of sources) {
      // World → screen, by hand rather than through a container: the render
      // texture is pinned to the camera so everything drawn into it is in screen
      // space, and the sources are in world space.
      const sx = (s.x - camera.worldView.x) * zoom
      const sy = (s.y - camera.worldView.y) * zoom
      const r = s.radius * zoom

      // Off-screen lights are skipped, which matters during a meteor shower.
      if (sx < -r || sy < -r || sx > this.rt.width + r || sy > this.rt.height + r) continue

      if (s.kind === 'cone') {
        this.eraser.setTexture(CONE_KEY)
        this.eraser.setOrigin(0, 0.5)
        this.eraser.setDisplaySize(r, r * 2)
        this.eraser.setRotation(s.angle ?? 0)
      } else {
        this.eraser.setTexture(RADIAL_KEY)
        this.eraser.setOrigin(0.5, 0.5)
        this.eraser.setDisplaySize(r * 2, r * 2)
        this.eraser.setRotation(0)
      }
      this.eraser.setAlpha(Math.max(0, Math.min(1, s.intensity)))
      this.rt.erase(this.eraser, sx, sy)
      this.stats.drawsLastFrame++
    }
  }

  destroy(): void {
    this.rt.destroy()
    this.eraser.destroy()
    for (const k of [RADIAL_KEY, CONE_KEY]) {
      if (this.scene.textures.exists(k)) this.scene.textures.remove(k)
    }
  }
}
