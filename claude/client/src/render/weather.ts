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
import { FOG_FRAGMENT, hasWebGL, rgbToUniform3f } from './shaders'
import { isHighQuality, onHighQualityChange } from '../ui/settings'
import { C } from '../core'

/**
 * Below this, fog is not drawn at all.
 *
 * Not `<= 0`: Phaser will happily fill at 0.0001, and a veil that is technically
 * drawn between effects is one nobody can assert the absence of. Named because
 * two places need the same answer — the per-frame draw, and the toggle, which
 * has to know whether the shader it just enabled should be showing yet.
 */
const FOG_VISIBLE = 0.005

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
  /**
   * T21.26's **ambient** rain: harmless, grey-blue, on its own schedule — a
   * separate sheet, never a reuse of `rain`. `rain` is the toxic rain's picture and
   * its density is welded to the real drops (T20.05); a second rain sharing it would
   * be a field that means two things, and `toxic-rain-game` reads `rainDrops`.
   */
  private readonly ambient: RainField
  private readonly ambientGfx: Phaser.GameObjects.Graphics
  private ambientTarget = 0
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
    // T21.26's ambient sheet: under the toxic sheet and its cast, and **not additive**
    // — ADD is what makes the acid glow, and a harmless rain that glowed would read as
    // a hazard.
    //
    // **At the vignette's depth, created before it, not at a depth of its own.** It
    // was `particles - 2` (38) and `two-clients` went red: the game's world-layer set
    // is pinned there, and 38 is the sandbox's hazard furniture, deliberately absent
    // from the game (§C0/§C1). Equal depths draw in creation order, so this still
    // sits under the green cast — the same place 38 put it — without a new layer.
    this.ambientGfx = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH.particles - 1)
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

    // --- T21.17: the High Quality fog -------------------------------------
    //
    // **Built beside the flat veil, not instead of it.** One of the two draws on
    // any given frame; which one is `useShader()`. A machine without WebGL never
    // gets here, and a player with the toggle off keeps exactly today's picture —
    // that is the whole contract of T21.16's switch.
    if (hasWebGL(scene)) {
      const base = new Phaser.Display.BaseShader('fogVolume', FOG_FRAGMENT, undefined, {
        alpha: { type: '1f', value: 0 },
        tint: { type: '3f', value: rgbToUniform3f(C().FOG_SCREEN_COLOUR) },
      })
      this.fogShader = scene.add
        .shader(base, 0, 0, this.cam.width, this.cam.height)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(DEPTH.fog)
        .setVisible(false)
    }
    // A live toggle: layers built under the old value have to follow it, or the
    // player flips the switch, sees nothing, and flips it back (T21.16).
    this.unsubscribeQuality = onHighQualityChange(() => this.applyQuality())
    this.rain = new RainField(260, this.cam.width, this.cam.height, 4242)
    this.ambient = new RainField(
      C().AMBIENT_RAIN_DROPS,
      this.cam.width,
      this.cam.height,
      9191,
      C().AMBIENT_RAIN_SPEED,
    )
  }

  /** The veil's current opacity, so a check can count at both ends (§A39). */
  get fogAlpha(): number {
    return this.lastFogAlpha
  }

  /**
   * Is the fog currently painted by the shader?
   *
   * Read off the object rather than off the setting: the setting can be on where
   * WebGL is not, and then this is `false` — which is what a check must assert
   * against, because the flat veil is not a fallback there, it is the only thing
   * that works.
   */
  get fogIsShader(): boolean {
    return this.useShader() && (this.fogShader?.visible ?? false)
  }
  private lastFogAlpha = 0
  /** The High Quality fog, or `null` on a machine with no WebGL. */
  private fogShader: Phaser.GameObjects.Shader | null = null
  private readonly unsubscribeQuality: () => void

  /**
   * Is the shader path in use right now?
   *
   * **Both halves matter.** The toggle can be on where WebGL is not available,
   * and then the flat veil is not a fallback, it is the only thing that works.
   */
  private useShader(): boolean {
    return this.fogShader !== null && isHighQuality()
  }

  /**
   * Hide whichever fog is not in use, so the two can never both draw.
   *
   * **Applied here rather than left to the next frame.** `fogIsShader` reads the
   * object's visibility, so a toggle that waits for `drawFog` tells whoever just
   * flipped it the *old* answer — a wrong read for a check, and a frame of
   * flicker for a player.
   */
  private applyQuality(): void {
    if (!this.fogShader) return
    const on = this.useShader()
    this.fogShader.setVisible(on && this.lastFogAlpha >= FOG_VISIBLE)
    if (on) this.fogVeil.clear()
  }

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

  /**
   * T21.26: the ambient schedule's intensity this frame, `0..1`.
   *
   * The schedule is Rust's (`world::ambient`), evaluated by the scene from the map
   * seed and the round clock. Unlike the toxic sheet there is no real-drop count
   * behind it, so "is it raining" and "how hard" are honestly the same number.
   */
  setAmbient(intensity: number): void {
    this.ambientTarget = Math.max(0, Math.min(1, intensity))
  }

  /** What the ambient sheet was asked for this frame, before the field's ramp. */
  get ambientAsked(): number {
    return this.ambientTarget
  }

  /** Ambient droplets actually drawn — its own count, never `rainDrops`. */
  get ambientDrops(): number {
    return this.ambient.intensity > 0.02 ? this.ambient.visibleDrops : 0
  }

  get ambientPool(): number {
    return this.ambient.drops.length
  }

  get ambientIntensity(): number {
    return this.ambient.intensity
  }

  /**
   * Show or hide one rain, **for a pixel check's control frame** (§C2): the only way
   * to know what a sheet contributes to a frozen frame is to take it away. Read back
   * off the object rather than echoed.
   */
  setRainVisible(which: 'toxic' | 'ambient', on: boolean): { visible: boolean } {
    if (which === 'toxic') {
      this.rainGfx.setVisible(on)
      this.vignette.setVisible(on)
      return { visible: this.rainGfx.visible }
    }
    this.ambientGfx.setVisible(on)
    return { visible: this.ambientGfx.visible }
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
    // Alpha rides "is it raining" and the count rides the schedule's own ramp.
    this.ambient.resize(this.cam.width, this.cam.height)
    this.ambient.update(dt, this.ambientTarget > 0 ? 1 : 0, this.ambientTarget)

    for (const v of vents) {
      if (v.jetting) this.embers.emit(dt, v.x, v.y, v.lean, 260)
    }
    this.embers.update(dt, fallScale * 0.9)

    this.drawRain()
    this.drawAmbient()
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
    if (a < FOG_VISIBLE) {
      this.lastFogAlpha = 0
      // **The shader is an object, not a draw call.** Clearing the Graphics is
      // enough for the flat veil; a shader left visible keeps rendering after
      // the fog has gone.
      this.fogShader?.setVisible(false)
      return
    }
    if (this.useShader() && this.fogShader) {
      // The shader takes the **same** alpha the flat veil would have used, so
      // the strength — and therefore how far a player can see — is identical in
      // both modes. Only the painting differs.
      this.fogShader.setVisible(true)
      this.fogShader.setUniform('alpha.value', a)
      this.fogShader.setDisplaySize(this.cam.width, this.cam.height)
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

  /**
   * The ambient sheet: grey-blue, slower, thinner, and **no full-screen cast** — the
   * toxic sheet's green wash is part of what says "acid", and this rain says nothing.
   */
  private drawAmbient(): void {
    const g = this.ambientGfx
    g.clear()
    const t = this.ambient.intensity
    if (t <= 0.02) return
    const c = C()
    g.lineStyle(1.5, c.AMBIENT_RAIN_COLOUR, c.AMBIENT_RAIN_ALPHA * t)
    for (const d of this.ambient.drops.slice(0, this.ambient.visibleDrops)) {
      const len = d.len + d.vy * 0.03
      g.lineBetween(d.x, d.y, d.x + d.vx * 0.05, d.y + len)
    }
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
    this.ambientGfx.destroy()
    this.fireGfx.destroy()
    this.vignette.destroy()
    this.fogVeil.destroy()
    this.fogShader?.destroy()
    // Or every round leaks a listener, and a setting flip wakes the dead ones.
    this.unsubscribeQuality()
  }
}
