/**
 * The darkness overlay, and the lights that cut holes in it.
 *
 * `docs/14-daynight-visibility.md` §5: fill with the night colour at the current
 * darkness, **erase** each light source, then composite over the scene with
 * MULTIPLY. Night is not a filter — it is a mask you carry a hole in.
 *
 * ## Why a 2D canvas rather than `RenderTexture.erase`
 *
 * The first implementation filled a `RenderTexture` and erased a scaled `Image`
 * into it. Measured against the radius it was *asked* for, the rendered hole did
 * not match and did not track: r=100 rendered ≈103 px, r=300 rendered ≈156, r=450
 * rendered ≈232 — it stopped growing near the eraser texture's native size and sat
 * off-centre. Setting the transform on the object instead of passing `(obj, x, y)`
 * did not fix it.
 *
 * A canvas gives exact, boring 2D semantics — `fillRect` then `destination-out` —
 * which is the same technique the chunk baker already uses in this codebase, and
 * `rendered radius == requested radius` is now asserted by a test.
 *
 * It is drawn at half resolution and scaled up. The whole layer is soft gradients,
 * so the resolution loss is invisible, and it cuts the per-frame upload by 4×.
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

const TEX_KEY = '__lightmap'
/** Half resolution: the layer is all soft gradients, so nothing is lost. */
const SCALE = 0.5

export class Lightmap {
  private readonly scene: Phaser.Scene
  private readonly texture: Phaser.Textures.CanvasTexture | null
  private readonly image: Phaser.GameObjects.Image
  private readonly nightColor: string
  private readonly lw: number
  private readonly lh: number
  /**
   * `filled` is the one that means anything (§A15).
   *
   * `drawsLastFrame` counts **erased lights**, so it reads 0 both when the pass was
   * skipped and when it ran at full darkness with nothing lit on screen — it
   * reports that work was attempted, not that it happened. The daylight-skip
   * assertion is on `filled`; night darkness is asserted on sampled pixels by
   * `night_darkens_the_world`.
   */
  readonly stats = { drawsLastFrame: 0, filled: false }

  constructor(scene: Phaser.Scene, nightColor = 0x000818) {
    this.scene = scene
    const c = C()
    this.lw = Math.round(c.VIEWPORT_W * SCALE)
    this.lh = Math.round(c.VIEWPORT_H * SCALE)
    this.nightColor = `#${nightColor.toString(16).padStart(6, '0')}`

    if (scene.textures.exists(TEX_KEY)) scene.textures.remove(TEX_KEY)
    this.texture = scene.textures.createCanvas(TEX_KEY, this.lw, this.lh) ?? null
    // `pixelArt: true` sets NEAREST globally, which quantises this half-resolution
    // falloff into 2-px stairs when it is scaled up. The lightmap is the one layer
    // that is all gradient, so it opts out on its own texture rather than the game
    // opting out everywhere.
    this.texture?.setFilter(Phaser.Textures.FilterMode.LINEAR)

    this.image = scene.add
      .image(0, 0, TEX_KEY)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH.lightmap)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setVisible(false)
  }

  /**
   * Fill, erase, composite. Costs **nothing** in daylight: the whole pass is
   * skipped and `stats.drawsLastFrame` stays 0, which `docs/14` §7 requires.
   */
  render(
    camera: Phaser.Cameras.Scene2D.Camera,
    darkness: number,
    sources: readonly LightSource[],
    fogActive = false,
  ): void {
    this.stats.drawsLastFrame = 0
    this.stats.filled = false

    if (!lightmapNeeded(darkness, fogActive)) {
      this.image.setVisible(false)
      return
    }

    const ctx = this.texture?.getContext()
    if (!ctx) return

    const c = C()
    const zoom = camera.zoom
    // A scroll-factor-0 object is still scaled by zoom about the camera midpoint,
    // so the image is counter-scaled to cover exactly the viewport at any zoom.
    // Getting this wrong is invisible at zoom 1 and wrong everywhere else.
    const midX = c.VIEWPORT_W / 2
    const midY = c.VIEWPORT_H / 2
    this.image.setPosition(midX * (1 - 1 / zoom), midY * (1 - 1 / zoom))
    this.image.setDisplaySize(c.VIEWPORT_W / zoom, c.VIEWPORT_H / zoom)
    this.image.setVisible(true)

    // World px → canvas px.
    const k = (this.lw / c.VIEWPORT_W) * zoom

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, this.lw, this.lh)
    ctx.globalAlpha = darkness
    ctx.fillStyle = this.nightColor
    ctx.fillRect(0, 0, this.lw, this.lh)
    ctx.globalAlpha = 1
    this.stats.filled = true

    ctx.globalCompositeOperation = 'destination-out'
    for (const s of sources) {
      const cx = (s.x - camera.worldView.x) * k
      const cy = (s.y - camera.worldView.y) * k
      const r = s.radius * k
      if (r <= 0) continue
      if (cx < -r || cy < -r || cx > this.lw + r || cy > this.lh + r) continue

      const a = Math.max(0, Math.min(1, s.intensity))
      if (s.kind === 'cone') {
        this.eraseCone(ctx, cx, cy, r, s.angle ?? 0, s.coneDeg ?? c.FLASHLIGHT_CONE_DEG, a)
      } else {
        this.eraseRadial(ctx, cx, cy, r, a)
      }
      this.stats.drawsLastFrame++
    }

    ctx.globalCompositeOperation = 'source-over'
    this.texture?.refresh()
  }

  /**
   * `FOV_EDGE_SOFTNESS` (0.35) is the fraction of the radius used for the falloff,
   * so vision fades out instead of ending at a line.
   */
  private eraseRadial(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    alpha: number,
  ): void {
    const solid = 1 - C().FOV_EDGE_SOFTNESS
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    g.addColorStop(0, `rgba(0,0,0,${alpha})`)
    g.addColorStop(solid, `rgba(0,0,0,${alpha})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
  }

  private eraseCone(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    angle: number,
    coneDeg: number,
    alpha: number,
  ): void {
    const half = ((coneDeg * Math.PI) / 180) / 2
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    g.addColorStop(0, `rgba(0,0,0,${alpha})`)
    g.addColorStop(0.6, `rgba(0,0,0,${alpha * 0.9})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, r, angle - half, angle + half)
    ctx.closePath()
    ctx.fill()
  }

  destroy(): void {
    this.image.destroy()
    if (this.scene.textures.exists(TEX_KEY)) this.scene.textures.remove(TEX_KEY)
  }
}
