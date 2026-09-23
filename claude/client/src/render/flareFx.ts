/**
 * T22.08B — a solar flare on screen: the prominence loop, and who it has set alight.
 * The rules are in `flareFx-math.ts`; this file only paints what they decide.
 *
 * # What is drawn is what burns
 *
 * The ribbon is `GameCore::flare_points` at the flare's own clock — **the samples the
 * server's contact test runs on** (`R80`) — and whether it is there at all is
 * `GameCore::flare_lit`, the window the server touches in (T22.08C F1). Both scenes
 * hand this layer the same `FlareQuery`: a match builds it from `FlareClock`, the
 * sandbox's `weatherStep` hands one out. Nothing here re-derives a position.
 *
 * # Two render paths, one assertion
 *
 * `webgl && isHighQuality()` is the shader quad (`flareFragment`); everything else is
 * six filled outlines round the same polyline (`ribbonOutline`) and two twisting threads. Both paint the body solid to the contact
 * radius around every sample, and `solar-flare` / `solar-flare-canvas` assert that on
 * the rendered frame at every sample point, in both paths — T21.36 found the flat path
 * covering 85 of 192 burn points while nobody looked.
 *
 * # Who is burning
 *
 * Not on the wire (`R80`: the flags byte is full). The client asks the core's own
 * contact test, `flare_touches`, about every drawn body each lit frame and keeps the
 * deadlines in a `BurnTracker` — the server's rule evaluated on the client's copy of
 * the positions, so a remote player on fire is seen on fire. A burning body gets
 * flickering flame tongues for as long as its burn lasts, ribbon or no ribbon.
 */

import Phaser from 'phaser'
import { C, type Core, type FlareQuery } from '../core'
import { DEPTH } from './backdrop'
import { flareFragment } from './shaders'
import { isHighQuality } from '../ui/settings'
import { BurnTracker, flareBounds, flareStrength, ribbonLength, ribbonOutline, strand, strokePasses, toLocal } from './flareFx-math'

/** One body the flare may touch: physics centre and box for contact, drawn centre for the flames. */
export interface FlareBody {
  id: number
  alive: boolean
  x: number
  y: number
  w: number
  h: number
  /** Where the scene drew this body's centre — the sandbox draws half a body high. */
  drawX: number
  drawY: number
}

/** What the last `update` drew — read back by the checks, never the setting (§A39). */
export interface FlareState {
  drawn: boolean
  shader: boolean
  strength: number
  lit: boolean
  elapsed: number
  /** The ribbon drawn this frame, world px — so a check samples the points that were painted. */
  points: number[]
  /** Frames in which a ribbon was drawn, for a check's page-not-drawing arm. */
  frames: number
  burning: number[]
}

let flareSeed = 0

export class FlareFx {
  private readonly gfx: Phaser.GameObjects.Graphics
  /** The flat corona, **added** over the sky rather than painted on it: translucent orange
   *  painted over near-black comes out a maroon sleeve (screenshotted); added, it glows. */
  private readonly coronaGfx: Phaser.GameObjects.Graphics
  private readonly burnGfx: Phaser.GameObjects.Graphics
  private shader: Phaser.GameObjects.Shader | null = null
  private local: Float32Array | null = null
  private readonly tracker = new BurnTracker()
  private readonly strandBuf: number[] = []
  private readonly outline: number[] = []
  private readonly passes = strokePasses(C().SOLAR_FLARE_RIBBON_R, C().SOLAR_FLARE_GLOW)
  private hidden = false
  private last: FlareState = {
    drawn: false,
    shader: false,
    strength: 0,
    lit: false,
    elapsed: 0,
    points: [],
    frames: 0,
    burning: [],
  }
  private frames = 0

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly webgl: boolean,
  ) {
    // At the particles' depth, over the terrain and the players, under the HUD: a flare
    // is light, and it crosses rock as easily as space. **The same depth, not 41**:
    // `sceneDepths()` lists every depth up to the lightmap and `terrain-render` pins
    // that list, so a new number is a changed layer set, not a new layer.
    // Drawn after the particles because it is built after them.
    this.coronaGfx = scene.add.graphics().setDepth(DEPTH.particles).setBlendMode(Phaser.BlendModes.ADD)
    this.gfx = scene.add.graphics().setDepth(DEPTH.particles)
    this.burnGfx = scene.add.graphics().setDepth(DEPTH.particles)
  }

  /**
   * One frame. `q` is the running flare or `null`; `now` is the round clock the burn
   * deadlines are kept in; `t` stirs the animation.
   */
  update(q: FlareQuery | null, core: Core, bodies: readonly FlareBody[], now: number, t: number): void {
    const c = C()
    this.gfx.clear()
    this.coronaGfx.clear()
    this.burnGfx.clear()
    let drawn = false
    let viaShader = false
    let strength = 0
    let lit = false
    let points: number[] = []
    if (q) {
      lit = core.flareLit(q.elapsed)
      strength = flareStrength(q.elapsed, c.EFFECT_TELEGRAPH, lit)
      const pts = core.flarePoints(q)
      points = Array.from(pts)
      if (lit) {
        for (const b of bodies) {
          if (b.alive && core.flareTouches(q, b.x, b.y, b.w, b.h)) {
            this.tracker.touch(b.id, now, c.SOLAR_FLARE_BURN_SECONDS)
          }
        }
      }
      if (strength > 0 && !this.hidden) {
        drawn = true
        viaShader = this.webgl && isHighQuality()
        if (viaShader) this.paintShader(pts, strength)
        else this.paintFlat(pts, strength, t)
      }
    }
    if (!viaShader) this.shader?.setVisible(false)
    if (drawn) this.frames++

    const burning: number[] = []
    for (const b of bodies) {
      if (!b.alive) {
        this.tracker.clear(b.id)
        continue
      }
      if (!this.tracker.burning(b.id, now)) continue
      burning.push(b.id)
      if (!this.hidden) this.paintBurning(b, t, this.tracker.left(b.id, now))
    }
    this.last = { drawn, shader: viaShader, strength, lit, elapsed: q?.elapsed ?? 0, points, frames: this.frames, burning }
  }

  /** e2e only (§C2): hide the flare for a same-instant control frame. */
  setHidden(on: boolean): void {
    this.hidden = on
    if (on) {
      this.gfx.clear()
      this.coronaGfx.clear()
      this.burnGfx.clear()
      this.shader?.setVisible(false)
    }
  }

  /** Discard the round: nobody is burning in the next one. */
  clear(): void {
    this.tracker.clearAll()
  }

  get state(): FlareState {
    return { ...this.last, points: [...this.last.points], burning: [...this.last.burning] }
  }

  destroy(): void {
    this.gfx.destroy()
    this.coronaGfx.destroy()
    this.burnGfx.destroy()
    this.shader?.destroy()
    this.shader = null
  }

  private paintShader(pts: Float32Array, strength: number): void {
    const c = C()
    const box = flareBounds(pts, c.SOLAR_FLARE_RIBBON_R + c.SOLAR_FLARE_GLOW)
    if (!box) return
    const q = this.quad(pts.length)
    toLocal(pts, box, this.local!)
    q.setUniform('strength.value', strength)
    q.setUniform('len.value', ribbonLength(pts))
    q.setPosition(box.x, box.y).setSize(box.w, box.h).setVisible(true)
  }

  private paintFlat(pts: Float32Array, strength: number, t: number): void {
    const g = this.gfx
    // A slow breathing on the corona only: the body pass never flickers, so every
    // point that burns is painted on every frame.
    const breathe = 0.85 + 0.15 * Math.sin(t * 5.3)
    this.passes.forEach((p, i) => {
      ribbonOutline(pts, p.width / 2, this.outline)
      const ring: { x: number; y: number }[] = []
      for (let j = 0; j + 1 < this.outline.length; j += 2) ring.push({ x: this.outline[j]!, y: this.outline[j + 1]! })
      const corona = i < 3
      const into = corona ? this.coronaGfx : g
      into.fillStyle(p.color, p.alpha * strength * (corona ? breathe : 1))
      into.fillPoints(ring, true)
    })
    // Two magnetic threads twisting round the loop — the shader's strands, flat.
    const r = C().SOLAR_FLARE_RIBBON_R
    for (const [k, color] of [
      [0, 0xfff0c0],
      [1, 0xffd060],
    ] as const) {
      strand(pts, r * 0.7, k * 2.1, t, this.strandBuf)
      g.lineStyle(Math.max(1.5, r * 0.16), color, 0.8 * strength)
      g.beginPath()
      g.moveTo(this.strandBuf[0]!, this.strandBuf[1]!)
      for (let i = 2; i + 1 < this.strandBuf.length; i += 2) g.lineTo(this.strandBuf[i]!, this.strandBuf[i + 1]!)
      g.strokePath()
    }
  }

  /**
   * A body on fire: flame tongues licking up its sides, flickering, fading over the
   * last second of the burn. Drawn with `Graphics` on both paths — small, and the
   * same picture everywhere.
   */
  private paintBurning(b: FlareBody, t: number, left: number): void {
    const g = this.burnGfx
    // Fades over the last second of the burn, so the flames go out when it does.
    const fade = Math.min(1, left)
    // A hot glow round the body first, then tongues licking up from its lower half
    // and its sides — taller than the body, so a burning player reads at a glance.
    g.fillStyle(0xff5a14, 0.22 * fade * (0.8 + 0.2 * Math.sin(t * 11 + b.id)))
    g.fillEllipse(b.drawX, b.drawY, b.w * 2.2, b.h * 1.6)
    const tongues = 9
    for (let i = 0; i < tongues; i++) {
      const u = i / (tongues - 1)
      const x = b.drawX + (u - 0.5) * b.w * 1.3
      const flick = 0.5 + 0.5 * Math.sin(t * 14 + i * 2.7 + b.id * 1.3)
      const edge = Math.abs(u - 0.5) * 2
      const h = b.h * (0.55 + 0.45 * flick) * (1 - 0.35 * edge)
      const base = b.drawY + b.h * (0.45 - 0.3 * edge)
      const lean = Math.sin(t * 9 + i * 1.7) * b.w * 0.18
      const half = b.w * 0.16
      g.fillStyle(0xff4a10, 0.8 * fade)
      g.fillTriangle(x - half, base, x + half, base, x + lean, base - h)
      g.fillStyle(0xffc040, 0.9 * fade)
      g.fillTriangle(x - half * 0.5, base, x + half * 0.5, base, x + lean * 0.7, base - h * 0.6)
    }
  }

  private quad(len: number): Phaser.GameObjects.Shader {
    if (this.shader && this.local && this.local.length === len) return this.shader
    this.shader?.destroy()
    const c = C()
    this.local = new Float32Array(len)
    const base = new Phaser.Display.BaseShader('solarFlare', flareFragment(len / 2), undefined, {
      pts: { type: '2fv', value: this.local },
      ribbon: { type: '1f', value: c.SOLAR_FLARE_RIBBON_R },
      len: { type: '1f', value: 1 },
      glow: { type: '1f', value: c.SOLAR_FLARE_GLOW },
      strength: { type: '1f', value: 0 },
      seed: { type: '1f', value: (flareSeed++ % 97) * 0.6180339887 },
    })
    this.shader = this.scene.add
      .shader(base, 0, 0, 64, 64)
      .setOrigin(0, 0)
      .setDepth(DEPTH.particles)
      .setVisible(false)
    return this.shader
  }
}
