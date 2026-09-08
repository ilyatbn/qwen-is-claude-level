/**
 * Game feel, the parts that are arithmetic (§A8 — no Phaser in this file).
 *
 * **Trauma is not here.** It is camera state and it lives in `cameraRig-math.ts`
 * beside the class that owns it — this file briefly had a second `Trauma` of its
 * own, which is exactly the duplication §A24 warns about. The scene calls
 * `rig.shake(traumaFromExplosion(distance, radius))`.
 */

// ---------------------------------------------------------------------------
// Floating damage numbers
// ---------------------------------------------------------------------------

export const DAMAGE_NUMBER_LIFETIME = 0.9
/** Screen px a damage number drifts upward over its life. */
export const DAMAGE_NUMBER_RISE = 34

export interface DamageNumber {
  x: number
  y: number
  amount: number
  /** True when it was the local player taking the hit — drawn red rather than white. */
  incoming: boolean
  age: number
}

export class DamageNumbers {
  private items: DamageNumber[] = []

  add(x: number, y: number, amount: number, incoming: boolean): void {
    // Sub-1 damage happens at the very edge of a blast and is visual noise.
    if (amount < 1) return
    this.items.push({ x, y, amount, incoming, age: 0 })
  }

  update(dt: number): void {
    for (const d of this.items) d.age += dt
    this.items = this.items.filter((d) => d.age < DAMAGE_NUMBER_LIFETIME)
  }

  /** Position and alpha for rendering; `t` is 0..1 through the life. */
  live(): Array<DamageNumber & { t: number; drawY: number; alpha: number }> {
    return this.items.map((d) => {
      const t = d.age / DAMAGE_NUMBER_LIFETIME
      return {
        ...d,
        t,
        drawY: d.y - DAMAGE_NUMBER_RISE * t,
        // Hold full opacity for the first half, then fade: a number that starts
        // fading immediately is hard to read at exactly the moment you want it.
        alpha: t < 0.5 ? 1 : 1 - (t - 0.5) * 2,
      }
    })
  }

  get count(): number {
    return this.items.length
  }
}

// ---------------------------------------------------------------------------
// Damage vignette
// ---------------------------------------------------------------------------

export const VIGNETTE_DECAY_S = 0.55
export const VIGNETTE_MAX_ALPHA = 0.45

/** A red edge flash when the local player is hit, proportional to the damage. */
export class Vignette {
  private value = 0

  hit(amount: number): void {
    // Full-strength at 50 damage, which is a bazooka to the face.
    this.value = Math.min(1, this.value + Math.max(0, amount) / 50)
  }

  update(dt: number): void {
    this.value = Math.max(0, this.value - dt / VIGNETTE_DECAY_S)
  }

  get alpha(): number {
    return this.value * VIGNETTE_MAX_ALPHA
  }
}

// ---------------------------------------------------------------------------
// Hit markers
// ---------------------------------------------------------------------------

export const HIT_MARKER_LIFETIME = 0.25

/** A tick at the crosshair when *your* shot lands, the one piece of pure feedback. */
export class HitMarkers {
  private items: Array<{ age: number; lethal: boolean }> = []

  add(lethal: boolean): void {
    this.items.push({ age: 0, lethal })
  }

  update(dt: number): void {
    for (const m of this.items) m.age += dt
    this.items = this.items.filter((m) => m.age < HIT_MARKER_LIFETIME)
  }

  /** Scale and alpha: markers pop outward and fade. */
  live(): Array<{ scale: number; alpha: number; lethal: boolean }> {
    return this.items.map((m) => {
      const t = m.age / HIT_MARKER_LIFETIME
      return { scale: 1 + t * 0.8, alpha: 1 - t, lethal: m.lethal }
    })
  }

  get count(): number {
    return this.items.length
  }
}

// ---------------------------------------------------------------------------
// Phase banner
// ---------------------------------------------------------------------------

export const BANNER_LIFETIME = 2.6

export interface Banner {
  text: string
  tint: number
  age: number
}

/**
 * One banner at a time. A weather telegraph arriving during a day/night flip
 * replaces it rather than stacking — two banners fighting for the same strip of
 * screen is worse than missing one, and the weather one is always the more urgent.
 */
export class BannerQueue {
  private current: Banner | null = null

  show(text: string, tint: number): void {
    this.current = { text, tint, age: 0 }
  }

  update(dt: number): void {
    if (!this.current) return
    this.current.age += dt
    if (this.current.age >= BANNER_LIFETIME) this.current = null
  }

  live(): (Banner & { alpha: number }) | null {
    if (!this.current) return null
    const t = this.current.age / BANNER_LIFETIME
    // Fade in over the first 10%, hold, fade out over the last 25%.
    const alpha = t < 0.1 ? t / 0.1 : t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1
    return { ...this.current, alpha }
  }
}

// ---------------------------------------------------------------------------
// Landing (T20.11)
// ---------------------------------------------------------------------------

/** Quietest a landing can be, so a step off a kerb is still audible. */
export const LANDING_VOLUME_FLOOR = 0.25

/**
 * How loud a landing is, from the speed the body was falling at.
 *
 * **One function because there were two copies of the expression**, in
 * `GameScene` and `SandboxScene`, and both were wrong in the same way: they read
 * `Math.abs(vy)` on the frame the body grounded, and `move_y` zeroes `vel.y`
 * *before* it marks the body grounded — so both evaluated to the floor, always,
 * from M6 until T20.11. Two copies of a rule is how they came to be wrong
 * together and would have been fixed apart.
 *
 * `impact` is `PlayerState.landingImpact`, measured inside `integrate` where the
 * number still exists; `maxFall` is `MAX_FALL_SPEED`, from `C()`, never a
 * literal here.
 */
export function landingVolume(impact: number, maxFall: number): number {
  if (!(maxFall > 0)) return LANDING_VOLUME_FLOOR
  const hard = Math.max(0, impact) / maxFall
  return Math.min(1, hard + LANDING_VOLUME_FLOOR)
}
