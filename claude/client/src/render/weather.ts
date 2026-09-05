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
import { EmberField, RainField, fogVeilAlpha, toxicDensity } from './weather-math'
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
/**
 * The glowing mouth of a burning vent, px.
 *
 * It was 26 and it was the **burning-ground disc** — the decal §F10 replaced.
 * A vent's afterburn is `LAVA_FLAMES_PER_SECOND` real flames now, each drawn as
 * its own object by the ordnance layer and each on fire for `FLAME_LIFE`; a disc
 * this wide sat *over* them and flattened a crowd back into one blob. Small
 * enough to say "this vent is still going" and too small to stand in for the
 * fire, which is the whole distinction.
 */
const VENT_MOUTH_R = 8

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

  /**
   * Toxic rain, at the density the **real** drops justify (T20.05).
   *
   * Takes a live drop count rather than a boolean, and that is the whole of this
   * task. §C6's emitter and §C21's projectiles were two rains that did not know
   * about each other: a fixed 260-droplet sheet on seed 4242, and an unrelated
   * set of real drops that did the carving and the poisoning. The player saw a
   * downpour and was hit by a drizzle.
   *
   * **Whether it is raining is derived from the same number**, rather than from a
   * separate `active` flag. The cadence is `TOXIC_DROP_EVERY` (0.15 s) against a
   * descent of about a second, so a shower never has an empty frame in the middle
   * — asserted in game-core by
   * `toxic_drops_in_flight_matches_what_a_shower_actually_puts_in_the_air`, because
   * a client deriving "is it raining" from a count that can hit zero would strobe.
   * Deriving it here also means the sheet stops when the last drop **lands**
   * rather than when the server's phase flips, which is the honest moment.
   *
   * The ramp lives in the field, not the caller.
   */
  setToxic(liveDrops: number): void {
    this.toxicTarget = liveDrops > 0 ? 1 : 0
    this.toxicDensityTarget = toxicDensity(liveDrops, C().TOXIC_DROPS_IN_FLIGHT)
  }
  private toxicTarget = 0
  private toxicDensityTarget = 0

  /**
   * The density this layer was **asked** for, before the ramp.
   *
   * Exposed so a check can assert the derivation exactly — the drawn count below
   * is the ramped effect of it and lags by design, which makes it the wrong thing
   * to compare a formula against. Both are asserted: this one says the join is
   * wired, `rainDrops` says something reached the screen.
   */
  get toxicDensityAsked(): number {
    return this.toxicDensityTarget
  }

  /** How many drops are actually being drawn — for counting at both ends. */
  get rainDrops(): number {
    return this.rain.intensity > 0.02 ? this.rain.visibleDrops : 0
  }

  /** The pool's size, so a check can tell "thinned" from "off". */
  get rainPool(): number {
    return this.rain.drops.length
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
  update(
    dt: number,
    vents: VentView[],
    fallScale: number,
    // **Both required, neither defaulted.** `fog = 0` and `hasFlashlight = false`
    // are each the pre-fix behaviour — no veil, and a veil that never lightens —
    // so a default is a caller that silently reproduces the bug and still
    // typechecks. That is `RainField`'s density rule (T20.05) applied here too;
    // both live call sites already pass all five, so it costs nothing.
    fog: number,
    // **Carrying a flashlight lightens §F9's veil** (T20.07). Threaded through
    // `update` rather than held as a setter beside `setToxic`, because unlike the
    // rain it has no ramp of its own: the veil is recomputed from `strength` every
    // frame and the flashlight is a multiplier on that, so a stored copy would be
    // a second place the answer could go stale.
    hasFlashlight: boolean,
  ): void {
    this.rain.resize(this.cam.width, this.cam.height)
    this.rain.update(dt, this.toxicTarget, this.toxicDensityTarget)

    for (const v of vents) {
      if (v.jetting) this.embers.emit(dt, v.x, v.y, v.lean, 260)
    }
    this.embers.update(dt, fallScale * 0.9)

    this.drawRain()
    this.drawFire(vents)
    this.drawFog(fog, hasFlashlight)
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
  private drawFog(strength: number, hasFlashlight: boolean): void {
    const g = this.fogVeil
    g.clear()
    const a = fogVeilAlpha(strength, hasFlashlight)
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
    // **A slice, not the pool** (T20.05): how many droplets are drawn is the real
    // rain's density. The green cast below stays on `intensity` — "it is raining
    // acid" is a fact about the effect, not about how hard it is falling, and
    // tying the wash to the count would make a thinning shower look like a
    // brightening one.
    const n = this.rain.visibleDrops
    for (const d of this.rain.drops.slice(0, n)) {
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
    // §F10.2/§F10.3: what is left here is the vent's mouth, not its fire — see
    // `VENT_MOUTH_R`.
    for (const v of vents) {
      if (!v.burning) continue
      const f = 0.35 + 0.15 * Math.sin(performance.now() * 0.02 + v.x)
      g.fillStyle(0xff4400, f)
      g.fillCircle(v.x, v.y, VENT_MOUTH_R)
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
