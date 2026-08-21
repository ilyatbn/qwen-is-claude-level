/**
 * Weather you can see (§C6).
 *
 * The simulation was correct and heavily tested and none of it reached the screen:
 * puddles were drawn as discs and the *rain* never was, so an 8-second downpour
 * looked like a few green circles appearing. Meteors were dots. Lava was a static
 * triangle rather than something erupting.
 *
 * Owned by `WorldView` so both scenes get it from one implementation — the sandbox
 * and the game each had their own hazard renderer, which is how they diverged
 * (§C1).
 */
import Phaser from 'phaser'
import { DEPTH } from './backdrop'
import { EmberField, RainField } from './weather-math'

export interface VentView {
  x: number
  y: number
  jetting: boolean
  burning: boolean
  lean: number
}

const RAIN_COLOUR = 0x7fe04a
const EMBER_COLOUR = 0xff7a1a

export class WeatherLayer {
  private readonly rainGfx: Phaser.GameObjects.Graphics
  private readonly fireGfx: Phaser.GameObjects.Graphics
  private readonly vignette: Phaser.GameObjects.Graphics
  private readonly rain: RainField
  private readonly embers = new EmberField(70, 260)
  private readonly cam: Phaser.Cameras.Scene2D.Camera

  constructor(scene: Phaser.Scene) {
    this.cam = scene.cameras.main
    // Rain is screen-space: it falls across the view, not across the world, so it
    // costs the same on a large map as a small one.
    // Order matters and is not obvious: created second at the same depth, the
    // vignette drew *over* the drops and washed them out. The measured colour
    // delta was real and was entirely the cast — the rain was invisible and the
    // number said otherwise, which is the §A15 trap wearing a new hat.
    this.vignette = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH.particles - 1)
    this.rainGfx = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH.particles)
    this.rainGfx.setBlendMode(Phaser.BlendModes.ADD)
    // Embers are world-space — they come out of a vent that is somewhere.
    this.fireGfx = scene.add.graphics().setDepth(DEPTH.particles)
    this.fireGfx.setBlendMode(Phaser.BlendModes.ADD)
    this.rain = new RainField(260, this.cam.width, this.cam.height, 4242)
  }

  /** Toxic rain, on or off. The ramp lives in the field, not the caller. */
  setToxic(active: boolean): void {
    this.toxicTarget = active ? 1 : 0
  }
  private toxicTarget = 0

  /** How many drops are actually being drawn — for counting at both ends. */
  get rainDrops(): number {
    return this.rain.intensity > 0.02 ? this.rain.drops.length : 0
  }

  get emberCount(): number {
    return this.embers.embers.length
  }

  get toxicIntensity(): number {
    return this.rain.intensity
  }

  /**
   * `fallScale` is the game's terminal velocity (`MAX_FALL_SPEED`): embers are
   * drawn falling, and scaling their arc off the same number the world uses keeps
   * the spew looking like it belongs to this game rather than a tuned-by-eye
   * constant that drifts from it.
   */
  update(dt: number, vents: VentView[], fallScale: number): void {
    this.rain.resize(this.cam.width, this.cam.height)
    this.rain.update(dt, this.toxicTarget)

    for (const v of vents) {
      if (v.jetting) this.embers.emit(dt, v.x, v.y, v.lean, 260)
    }
    this.embers.update(dt, fallScale * 0.9)

    this.drawRain()
    this.drawFire(vents)
  }

  private drawRain(): void {
    const g = this.rainGfx
    g.clear()
    const t = this.rain.intensity
    if (t <= 0.02) {
      this.vignette.clear()
      return
    }
    g.lineStyle(2, RAIN_COLOUR, 0.9 * t)
    for (const d of this.rain.drops) {
      // Streak length follows fall speed, so the sheet has depth rather than
      // reading as a field of identical ticks.
      const len = d.len + d.vy * 0.03
      g.lineBetween(d.x, d.y, d.x + d.vx * 0.05, d.y + len)
    }
    // A sickly green cast over the whole view, so "it is raining acid" is legible
    // even where no drop happens to be.
    const v = this.vignette
    v.clear()
    v.fillStyle(RAIN_COLOUR, 0.1 * t)
    v.fillRect(0, 0, this.cam.width, this.cam.height)
  }

  private drawFire(vents: VentView[]): void {
    const g = this.fireGfx
    g.clear()
    for (const e of this.embers.embers) {
      const a = Math.max(0, e.life / e.ttl)
      g.fillStyle(EMBER_COLOUR, 0.8 * a)
      g.fillCircle(e.x, e.y, 1.5 + 3 * a)
    }
    // Burning ground flickers rather than sitting still: a constant disc reads as
    // a decal, and this is meant to look dangerous.
    for (const v of vents) {
      if (!v.burning) continue
      const f = 0.35 + 0.15 * Math.sin(performance.now() * 0.02 + v.x)
      g.fillStyle(0xff4400, f)
      g.fillCircle(v.x, v.y, 26)
    }
  }

  /** Feed the lightmap: fire is a light source at night (§A3). */
  lights(): Array<{ x: number; y: number; r: number; a: number }> {
    const out: Array<{ x: number; y: number; r: number; a: number }> = []
    for (const e of this.embers.embers) {
      out.push({ x: e.x, y: e.y, r: 40, a: 0.35 * Math.max(0, e.life / e.ttl) })
    }
    return out
  }

  destroy(): void {
    this.embers.clear()
    this.rainGfx.destroy()
    this.fireGfx.destroy()
    this.vignette.destroy()
  }
}
