/**
 * T22.04 — the suit thruster's plume, the Phaser half. The rules are in
 * `thrusterPlume-math.ts`; this file only draws what they decide.
 *
 * # The first arbitrary-direction thing inside `PlayerView`
 *
 * Boots and wings are `setFlipX`, which can say left or right and nothing else.
 * A plume points anywhere, so both of its objects are drawn **once, along +x**,
 * and rotated per frame — the pattern the weapon already uses
 * (`this.weapon.setRotation(aim)`), not a redraw. Up stays up for the body
 * (`M22-RULINGS` R7); only the plume turns.
 *
 * # Two render paths, one assertion
 *
 * `webgl && isHighQuality()` — the predicate every shader in the client uses — is
 * the shader quad; everything else (WebGL with High Quality off, and Canvas with
 * either) is the flat shape. Both are drawn in the same box in the same place —
 * **the box, not the pixels**: the shader paints its sheath across about half the
 * quad's width, so on screen it is visibly narrower than the flat shape
 * (T22.04B F6, screenshotted side by side; widening it is `shaders.ts`'s
 * `THRUST_FRAGMENT`, not this file). And
 * `scripts/checks/thrusters.mjs` photographs each path against its own control
 * frame, because T21.36 found the flat path is the half nobody checks.
 *
 * # Toggled per frame, never rebuilt
 *
 * Built with the view and shown from `setState`, like boots and wings: a plume
 * made at construction would vanish on T20.12's appearance rebuild, and one keyed
 * to the appearance would not exist at all. The shader quad is built on first
 * use, so a Canvas machine or a High-Quality-off player never makes one.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { THRUST_FRAGMENT } from './shaders'
import { isHighQuality } from '../ui/settings'
import { hullRadius, plumeDir, type Dir } from './thrusterPlume-math'

const SHEATH = 0x3d9eff
const CORE = 0xe0faff

let shaderSeed = 0

export class ThrusterPlume {
  private readonly flat: Phaser.GameObjects.Graphics
  private shader: Phaser.GameObjects.Shader | null = null
  private hidden = false
  private drawn = false
  private viaShader = false
  private dir: Dir = { x: 0, y: 1 }
  /** What the last `update` was given, so a hide or show repaints the same instant. */
  private last: Parameters<ThrusterPlume['update']> | null = null

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly container: Phaser.GameObjects.Container,
    private readonly webgl: boolean,
  ) {
    const c = C()
    const L = c.THRUSTER_PLUME_LENGTH
    const W = c.THRUSTER_PLUME_WIDTH
    // Along +x from the nozzle at 0 to the tip at L. A sheath and a hot core, each
    // an ellipse at the nozzle drawn out to a point — the flat twin of the shader.
    const g = scene.add.graphics()
    g.fillStyle(SHEATH, 0.6)
    g.fillEllipse(L * 0.3, 0, L * 0.6, W)
    g.fillTriangle(L * 0.3, -W * 0.42, L * 0.3, W * 0.42, L, 0)
    g.fillStyle(CORE, 0.95)
    g.fillEllipse(L * 0.18, 0, L * 0.36, W * 0.45)
    g.fillTriangle(L * 0.18, -W * 0.2, L * 0.18, W * 0.2, L * 0.6, 0)
    g.setVisible(false)
    this.flat = g
    // Behind everything the view holds: the exhaust comes out of the back of the
    // suit, and must never cover the face or the weapon.
    container.addAt(g, 0)
  }

  /**
   * Show or hide the plume for this frame.
   *
   * `cx`/`cy` are the drawn body's centre in container coordinates and
   * `halfW`/`halfH` its hull, so the nozzle sits on the edge of the body the
   * scene actually drew — not on the physics box, which a scene may offset.
   */
  update(on: boolean, vx: number, vy: number, cx: number, cy: number, halfW: number, halfH: number): void {
    this.last = [on, vx, vy, cx, cy, halfW, halfH]
    const show = on && !this.hidden
    const shader = show && this.webgl && isHighQuality()
    this.drawn = show
    this.viaShader = shader
    if (!show) {
      this.flat.setVisible(false)
      this.shader?.setVisible(false)
      return
    }
    const c = C()
    const d = plumeDir(vx, vy, c.THRUSTER_PLUME_MIN_SPEED)
    this.dir = d
    const r = hullRadius(d, halfW, halfH)
    const x = cx + d.x * r
    const y = cy + d.y * r
    const angle = Math.atan2(d.y, d.x)
    if (shader) {
      const q = this.quad()
      q.setPosition(x, y).setRotation(angle).setVisible(true)
      this.flat.setVisible(false)
    } else {
      this.shader?.setVisible(false)
      // A small flicker in length, off the clock: a steady flat shape reads as a
      // sticker. Never below 0.84 of the length, so the pixels a check samples
      // near the nozzle are painted on every frame.
      const flicker = 0.92 + 0.08 * Math.sin(Date.now() * 0.045)
      this.flat.setPosition(x, y).setRotation(angle).setScale(flicker, 1).setVisible(true)
    }
  }

  /**
   * e2e only (§C2): hide the plume for a same-instant control frame.
   *
   * Repaints from the last `update` rather than waiting for the next one: a check
   * freezes the scene first, and a frozen scene calls no `setState`, so a show
   * that waited would leave the "after" photograph as bare as the control.
   */
  setHidden(on: boolean): void {
    this.hidden = on
    if (this.last) this.update(...this.last)
  }

  /** What the last `update` drew — read back, not the setting (§A39). */
  get state(): { drawn: boolean; shader: boolean; dir: Dir } {
    return { drawn: this.drawn, shader: this.viaShader, dir: { ...this.dir } }
  }

  private quad(): Phaser.GameObjects.Shader {
    if (this.shader) return this.shader
    const c = C()
    const base = new Phaser.Display.BaseShader('thrusterPlume', THRUST_FRAGMENT, undefined, {
      seed: { type: '1f', value: (shaderSeed++ % 97) * 0.6180339887 },
    })
    const q = this.scene.add
      .shader(base, 0, 0, c.THRUSTER_PLUME_LENGTH, c.THRUSTER_PLUME_WIDTH)
      .setOrigin(0, 0.5)
      .setVisible(false)
    this.container.addAt(q, this.container.getIndex(this.flat))
    this.shader = q
    return q
  }
}
