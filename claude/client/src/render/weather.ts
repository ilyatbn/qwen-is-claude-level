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
 *
 * ## Rain is in the world since T21.31
 *
 * Both rains were `scrollFactor(0)` sheets, and the report from play was *"it
 * literally rains from the whole screen when the clouds are below me"*. Now:
 *
 * - **Ambient rain** (T21.26/T21.31, `CloudRain` from the clouds) is **retired** with the
 *   clouds it fell from (T23.04: F's sky has haze, not clouds, and F has no rain).
 * - **Toxic rain** is a streak at each of the server's **real** drops, so the picture
 *   and the damage are one population by construction (T20.05's rule, which a density
 *   scalar over an invented sheet only approximated). The green cast stays
 *   screen-wide: "it is raining acid" is a fact about the round.
 */
import Phaser from 'phaser'
import { DEPTH } from './backdrop'
import { EmberField, fogVeilAlpha } from './weather-math'
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
  /** T21.31: the real toxic drops this frame, world px — what the streaks are drawn at. */
  private toxicDrops: ReadonlyArray<{ x: number; y: number }> = []
  private toxicDrawn: Array<{ x: number; y: number }> = []
  /** The green cast's fade, `0..1` — "a shower is on", not how hard. */
  private toxicCast = 0
  private readonly embers = new EmberField(70, 260)
  private readonly cam: Phaser.Cameras.Scene2D.Camera

  constructor(scene: Phaser.Scene) {
    this.cam = scene.cameras.main
    // T21.31: both rains are **world-space** now (scroll factor 1); only the green
    // cast and the fog stay on the lens.
    // Order matters and is not obvious: created second at the same depth, the
    // vignette drew *over* the drops and washed them out. The measured colour
    // delta was real and was entirely the cast — the rain was invisible and the
    // number said otherwise, which is the §A15 trap wearing a new hat.
    this.vignette = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH.particles - 1)
    this.rainGfx = scene.add.graphics().setDepth(DEPTH.particles)
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
  }

  /** The veil's current opacity, so a check can count at both ends (§A39). */
  get fogAlpha(): number {
    return this.lastFogAlpha
  }

  /**
   * The strength `fogAlpha` was computed from — written in the same draw (T22.00G).
   * The scene's live `fog.strength(roundTime)` is from the moment it is read, and on
   * the ramp a frame or two of skew is worth more than `fog-visible`'s 0.01 tolerance.
   */
  get fogDrawnStrength(): number {
    return this.lastFogStrength
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
  private lastFogStrength = 0
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
   * Toxic rain: **the server's real drops**, world px (T20.05, T21.31).
   *
   * §C6's emitter and §C21's projectiles were two rains that did not know about each
   * other — a player saw a downpour and was hit by a drizzle. T20.05 welded the sheet's
   * density to the live count; T21.31 draws a streak at each live drop instead, so the
   * rain on the screen *is* the rain that poisons, drop for drop, and it stops where
   * the server's drop lands.
   *
   * **Whether it is raining is derived from the same list**, rather than from a
   * separate `active` flag, so the cast fades when the last drop lands rather than
   * when the server's phase flips.
   */
  setToxic(drops: ReadonlyArray<{ x: number; y: number }>): void {
    this.toxicDrops = drops
  }

  /** Real drops drawn on the last frame — counted at both ends against `toxicDrops`. */
  get rainDrops(): number {
    return this.toxicDrawn.length
  }

  /** Where the last frame drew them, world px, so a check can stand a player under one. */
  get toxicDropsDrawn(): ReadonlyArray<{ x: number; y: number }> {
    return this.toxicDrawn
  }

  get emberCount(): number {
    return this.embers.embers.length
  }

  /** The green cast's fade, `0..1`. */
  get toxicIntensity(): number {
    return this.toxicCast
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
    // typechecks. That is T20.05's rule for the rain's old density argument, applied here too;
    // both live call sites already pass all five, so it costs nothing.
    fog: number,
    // **Carrying a flashlight lightens §F9's veil** (T20.07). Threaded through
    // `update` rather than held as a setter beside `setToxic`, because unlike the
    // rain it has no ramp of its own: the veil is recomputed from `strength` every
    // frame and the flashlight is a multiplier on that, so a stored copy would be
    // a second place the answer could go stale.
    hasFlashlight: boolean,
  ): void {
    const c = C()
    const step = dt / c.TOXIC_CAST_RAMP
    const wantCast = this.toxicDrops.length > 0 ? 1 : 0
    this.toxicCast =
      wantCast > this.toxicCast ? Math.min(1, this.toxicCast + step) : Math.max(0, this.toxicCast - step)

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
    this.lastFogStrength = strength
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

  /**
   * A streak above each real toxic drop, in the world, and the cast over the view.
   *
   * **Every live drop, not a slice**: the drawn list is the server's list, so
   * `rainDrops` equals the live count by construction and a check can compare them.
   */
  private drawRain(): void {
    const c = C()
    const g = this.rainGfx
    g.clear()
    this.toxicDrawn = []
    if (this.toxicDrops.length > 0) {
      g.lineStyle(c.TOXIC_STREAK_WIDTH, RAIN_COLOUR, c.TOXIC_STREAK_ALPHA)
      for (const d of this.toxicDrops) {
        g.lineBetween(d.x, d.y - c.TOXIC_STREAK_LEN, d.x, d.y)
        this.toxicDrawn.push({ x: d.x, y: d.y })
      }
    }
    const v = this.vignette
    v.clear()
    if (this.toxicCast <= 0.02) return
    // A sickly green cast over the whole view, so "it is raining acid" is legible
    // even where no drop happens to be.
    v.fillStyle(RAIN_COLOUR, c.TOXIC_CAST_ALPHA * this.toxicCast)
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

  destroy(): void {
    this.embers.clear()
    this.rainGfx.destroy()
    this.fireGfx.destroy()
    this.vignette.destroy()
    this.fogVeil.destroy()
    this.fogShader?.destroy()
    // Or every round leaks a listener, and a setting flip wakes the dead ones.
    this.unsubscribeQuality()
  }
}
