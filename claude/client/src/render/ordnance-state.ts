/**
 * The pure half of visible ordnance (§A8): tracer, trail and impact bookkeeping,
 * and the light sources they contribute.
 *
 * §A3 is a headline requirement — **every shot is visible and every shot digs**.
 * The SMG stays hitscan; what makes it visible is a tracer drawn along the
 * `hitscan` event's segment. At night these are the light sources that make combat
 * readable at all, which is why `lights()` lives here and is tested.
 */

/** Light samples along a tracer's path. Enough to read as a beam, few enough
 * that 10 shots/s does not flood the lightmap. */
const TRACER_LIGHT_SAMPLES = 6

export interface Tracer {
  x0: number
  y0: number
  x1: number
  y1: number
  /** Seconds remaining. */
  life: number
  ttl: number
}

export type ProjectileKind = 'bazooka' | 'grenade' | 'meteor' | 'fragment'

export interface TrailPoint {
  x: number
  y: number
}

export interface TrackedProjectile {
  id: number
  kind: ProjectileKind
  x: number
  y: number
  trail: TrailPoint[]
}

export interface Impact {
  x: number
  y: number
  r: number
  kind: string
  life: number
  ttl: number
}

export interface Light {
  x: number
  y: number
  r: number
  a: number
}

/** How brightly each kind glows, and how far. */
const GLOW: Record<ProjectileKind, { r: number; a: number }> = {
  bazooka: { r: 90, a: 0.85 },
  grenade: { r: 45, a: 0.5 },
  meteor: { r: 150, a: 1 },
  fragment: { r: 60, a: 0.7 },
}

export class OrdnanceState {
  readonly tracers: Tracer[] = []
  /**
   * Freeze tracer decay. Debug-only, for headless screenshots.
   *
   * A tracer lives 0.09 s, which is shorter than a Playwright screenshot
   * round-trip, so a shot of "the tracer" reliably captured an empty hillside
   * instead. Holding decay makes the evidence deterministic rather than a race.
   */
  holdTracers = false
  readonly projectiles = new Map<number, TrackedProjectile>()
  readonly impacts: Impact[] = []

  constructor(
    private readonly tracerLifetime: number,
    private readonly trailLen: number,
  ) {}

  addTracer(x0: number, y0: number, x1: number, y1: number): void {
    this.tracers.push({ x0, y0, x1, y1, life: this.tracerLifetime, ttl: this.tracerLifetime })
  }

  addProjectile(id: number, kind: ProjectileKind, x: number, y: number): void {
    this.projectiles.set(id, { id, kind, x, y, trail: [{ x, y }] })
  }

  moveProjectile(id: number, x: number, y: number): void {
    const p = this.projectiles.get(id)
    if (!p) return
    p.x = x
    p.y = y
    p.trail.push({ x, y })
    // A bounded ring: a 10 shots/s weapon must not grow this without limit.
    if (p.trail.length > this.trailLen) p.trail.splice(0, p.trail.length - this.trailLen)
  }

  removeProjectile(id: number): void {
    this.projectiles.delete(id)
  }

  addImpact(x: number, y: number, r: number, kind: string, ttl = 0.35): void {
    this.impacts.push({ x, y, r, kind, life: ttl, ttl })
  }

  update(dt: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      if (this.holdTracers) break
      const t = this.tracers[i]!
      t.life -= dt
      if (t.life <= 0) this.tracers.splice(i, 1)
    }
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i]!
      im.life -= dt
      if (im.life <= 0) this.impacts.splice(i, 1)
    }
  }

  /**
   * Everything currently emitting light, for the lightmap to erase around.
   *
   * Shooting in the dark tells everyone where you are — that is intentional
   * (`docs/14-daynight-visibility.md` §2), and it only works if ordnance actually
   * feeds the lightmap.
   */
  lights(): Light[] {
    const out: Light[] = []
    for (const p of this.projectiles.values()) {
      const g = GLOW[p.kind]
      out.push({ x: p.x, y: p.y, r: g.r, a: g.a })
    }
    for (const t of this.tracers) {
      const k = t.life / t.ttl
      // A tracer LIGHTS ITS OWN PATH, not just its ends.
      //
      // Drawing it was never the problem: it renders at DEPTH.particles (40),
      // above terrain — but the lightmap multiplies at depth 50, so at full
      // darkness a white line became roughly RGB 46 against RGB 20 terrain and
      // was, as reported, nearly invisible. §A3 requires every shot to be
      // visible, so the beam has to carve its own hole in the dark rather than
      // be dimmed by it.
      //
      // Sampling the segment rather than adding one huge radial keeps the lit
      // region the shape of the beam.
      for (let i = 0; i <= TRACER_LIGHT_SAMPLES; i++) {
        const f = i / TRACER_LIGHT_SAMPLES
        out.push({
          x: t.x0 + (t.x1 - t.x0) * f,
          y: t.y0 + (t.y1 - t.y0) * f,
          r: 46,
          a: 0.75 * k,
        })
      }
      // The muzzle is brighter and wider: firing at night must give away the
      // shooter, not only the target ("shooting in the dark tells everyone where
      // you are", `docs/14-daynight-visibility.md` §2).
      out.push({ x: t.x0, y: t.y0, r: 80, a: 0.9 * k })
    }
    for (const im of this.impacts) {
      // A bright, fast decay: the flash of the blast, not a lingering lamp.
      const k = im.life / im.ttl
      out.push({ x: im.x, y: im.y, r: im.r * 2.5, a: Math.min(1, k * 1.4) })
    }
    return out
  }

  get counts(): { tracers: number; projectiles: number; impacts: number } {
    return {
      tracers: this.tracers.length,
      projectiles: this.projectiles.size,
      impacts: this.impacts.length,
    }
  }
}
