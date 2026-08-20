/**
 * Game feel, the parts that are arithmetic (§A8 — no Phaser in this file).
 *
 * Trauma-based screen shake: you add *trauma*, and shake is `trauma^2`. The
 * square is what makes it feel right — a small hit barely registers while a
 * rocket at your feet throws the camera — and it is also what makes the decay
 * read as a settling rather than a fade.
 */

/** Seconds for trauma to fall from 1 to 0. */
export const TRAUMA_DECAY_S = 0.9
/** World px beyond which an explosion adds no trauma at all. */
export const TRAUMA_MAX_DISTANCE = 620
/** Screen px of displacement at full trauma. */
export const SHAKE_MAX_PX = 22
/** Radians of camera roll at full trauma. Small — roll reads as impact, not as a bug. */
export const SHAKE_MAX_ROLL = 0.035

export class Trauma {
  private value = 0

  /** Trauma is capped at 1: two rockets must not shake twice as hard as physics allows. */
  add(amount: number): void {
    this.value = Math.min(1, Math.max(0, this.value + amount))
  }

  /**
   * Trauma from an explosion, by distance. Linear falloff to zero at
   * `TRAUMA_MAX_DISTANCE`, scaled by the blast's own radius so a grenade and a
   * meteor do not shake alike.
   */
  addExplosion(distance: number, radius: number): void {
    const reach = Math.max(1, TRAUMA_MAX_DISTANCE)
    const near = Math.max(0, 1 - Math.max(0, distance) / reach)
    // A 42 px bazooka is the reference blast; a 50 px meteor hits harder.
    const weight = Math.min(1.5, radius / 42)
    this.add(near * near * weight)
  }

  update(dt: number): void {
    this.value = Math.max(0, this.value - dt / TRAUMA_DECAY_S)
  }

  get level(): number {
    return this.value
  }

  /** The squared curve the shake actually uses. */
  get shake(): number {
    return this.value * this.value
  }

  /**
   * Camera offset for this frame. `seed` advances per frame so successive frames
   * are uncorrelated — a smooth wobble reads as a camera bug, a jittery one reads
   * as impact.
   */
  offset(seed: number): { x: number; y: number; roll: number } {
    const s = this.shake
    if (s <= 0) return { x: 0, y: 0, roll: 0 }
    const n = (k: number) => {
      const v = Math.sin((seed + k) * 12.9898) * 43758.5453
      return (v - Math.floor(v)) * 2 - 1
    }
    return {
      x: n(0) * SHAKE_MAX_PX * s,
      y: n(1.7) * SHAKE_MAX_PX * s,
      roll: n(3.3) * SHAKE_MAX_ROLL * s,
    }
  }
}

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
