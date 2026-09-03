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
import { EmberField, RainField, fogVeilAlpha } from './weather-math'
import { C } from '../core'

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
  /**
   * §F9's heavy-fog veil: one screen-space rectangle over the whole view.
   *
   * Separate from `vignette` even though both are full-screen casts, because
   * they sit at different depths and answer to different things — the toxic cast
   * is a particle-layer tint that belongs *under* the rain, and this one is above
   * everything in the world including the lightmap. Merging them would put fog
   * behind the drops and force one alpha to mean two effects.
   */
  private readonly fogVeil: Phaser.GameObjects.Graphics
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
    // Above the lightmap, below the HUD — see `DEPTH.fog` for why both halves of
    // that matter. Created with no fill: an effect that has not started must
    // draw nothing at all, not a transparent rectangle whose alpha is a rounding
    // error away from visible.
    this.fogVeil = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH.fog)
    this.rain = new RainField(260, this.cam.width, this.cam.height, 4242)
  }

  /** The veil's current opacity, so a check can count at both ends (§A39). */
  get fogAlpha(): number {
    return this.lastFogAlpha
  }
  private lastFogAlpha = 0

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
  update(dt: number, vents: VentView[], fallScale: number, fog = 0): void {
    this.rain.resize(this.cam.width, this.cam.height)
    this.rain.update(dt, this.toxicTarget)

    for (const v of vents) {
      if (v.jetting) this.embers.emit(dt, v.x, v.y, v.lean, 260)
    }
    this.embers.update(dt, fallScale * 0.9)

    this.drawRain()
    this.drawFire(vents)
    this.drawFog(fog)
  }

  /**
   * The whole of §F9: a grey rectangle over the view, at `FOG_SCREEN_ALPHA ×
   * strength`.
   *
   * `setScrollFactor(0)` and a rect sized from the camera rather than the world:
   * fog is on the lens, so it must not scroll, and a world-sized fill would cost
   * more on a large map for no visible difference.
   *
   * The simulation has been right about fog since M5 — `strength()` ramps, the
   * FoV shrinks — and none of it was legible in daylight, which is when fog is
   * meant to matter. This function is the entire fix; everything else about the
   * effect was already correct.
   */
  private drawFog(strength: number): void {
    const g = this.fogVeil
    g.clear()
    const a = fogVeilAlpha(strength)
    this.lastFogAlpha = a
    // Not `a <= 0`: Phaser will happily fill at 0.0001, and a veil that is
    // technically drawn between effects is one nobody can assert the absence of.
    if (a < 0.005) {
      this.lastFogAlpha = 0
      return
    }
    g.fillStyle(C().FOG_SCREEN_COLOUR, a)
    g.fillRect(0, 0, this.cam.width, this.cam.height)
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
    this.fogVeil.destroy()
  }
}
