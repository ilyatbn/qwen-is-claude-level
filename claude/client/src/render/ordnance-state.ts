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

export type ProjectileKind =
  | 'bullet'
  | 'bazooka'
  | 'grenade'
  | 'meteor'
  | 'fragment'
  | 'airburst'
  | 'pellet'
  | 'smoke'
  | 'molotov'
  | 'toxic'
  | 'drop'

/**
 * How each projectile looks (§C4). Deliberately placeholder art — coloured dots
 * sized so you can tell what is in the air — behind **one** lookup, so replacing
 * them with sprites later touches this table and nothing else.
 *
 * The bug this exists for: the game drew no projectiles at all. You could not see
 * what you fired or what was being fired at you, which is the single most
 * important thing a shooter draws.
 */
export interface ProjectileLook {
  /** Radius in world px. */
  r: number
  /** Fill colour, 0xRRGGBB. */
  colour: number
  /** Trail sample count; 0 draws no trail. */
  trail: number
}

export const LOOK: Record<ProjectileKind, ProjectileLook> = {
  // §F2. `r` is unused for a bullet — it is drawn as a streak, not a disc — and
  // the trail is **short** on purpose: at `MACHINEGUN_COOLDOWN` 0.09 s there are
  // several rounds on one line, and a long tail behind each would merge them
  // into a bar. The picture is a stream of separate rounds (the M19 reference
  // image), not a laser.
  bullet: { r: 2, colour: 0xffe9a0, trail: 3 },
  bazooka: { r: 6, colour: 0xff8a3d, trail: 12 },
  grenade: { r: 5, colour: 0x3f7d3f, trail: 6 },
  airburst: { r: 5, colour: 0xa77dff, trail: 10 },
  pellet: { r: 3, colour: 0xa77dff, trail: 4 },
  smoke: { r: 5, colour: 0xb9bec6, trail: 0 },
  molotov: { r: 5, colour: 0xff5a2b, trail: 10 },
  toxic: { r: 5, colour: 0x7cd44a, trail: 10 },
  // A falling drop of rain (§C21): small, bright green, with a streak behind it
  // so it reads as rain rather than as a bullet.
  drop: { r: 3, colour: 0x9bf05a, trail: 8 },
  meteor: { r: 8, colour: 0xff4433, trail: 14 },
  fragment: { r: 3, colour: 0xff7755, trail: 5 },
}

/**
 * Weapon **key** to how its projectile looks.
 *
 * Keyed by name, not by numeric id. The registry is positional (`WEAPONS[i].id ==
 * WeaponId(i)`) and §B16 is the bug where that assumption was made silently and a
 * laser resolved as a bazooka. `weaponKindPinnedToRegistry` in the test asserts
 * this table against the Rust source, so inserting a weapon mid-table fails loudly
 * instead of re-colouring every projectile after it.
 */
/**
 * Weapon keys in registry order, so `WEAPON_KEYS[id]` is that weapon's key.
 *
 * The Rust registry is positional (`WEAPONS[i].id == WeaponId(i)`). Mirroring that
 * order here is a duplication, and `weaponKeysMatchTheRustRegistry` in the test
 * pins it against `defs.rs` — §B16 is the bug where exactly this assumption was
 * made without an assertion and a laser resolved as a bazooka.
 */
export const WEAPON_KEYS: string[] = [
  'bazooka',
  'grenade',
  'smg',
  'meteor',
  'meteor_fragment',
  'laser_pistol',
  'laser_smg',
  'pistol',
  'revolver',
  'deagle',
  'machinegun',
  'knife',
  'bat',
  'whip',
  'axe',
  'hammer',
  'flamethrower',
  'mine',
  'airburst',
  'smoke',
  'molotov',
  'toxic_grenade',
  'airburst_pellet',
  // §C21. A drop of toxic rain is a projectile so that it falls — and being a
  // projectile is also what makes it visible, because this is the layer that
  // draws them.
  'toxic_drop',
  // §F5. Appended last, and the five melee keys above it stay: retiring a weapon
  // does not free its id (`WEAPONS[i].id == WeaponId(i)`), so a hole here would
  // shift everything after it — §B16 again. It has no `KIND_BY_WEAPON_KEY` entry
  // because a swing spawns no projectile.
  'shovel',
  // §F10. A flame is a projectile, so it has a `WeaponId`, so it is here — the
  // registry is positional and `weaponKeysMatchTheRustRegistry` pins this list
  // to it. Its `KIND_BY_WEAPON_KEY` entry and its look arrive with T19.13; until
  // then nothing emits one, so nothing reaches the layer that would draw it.
  'flame',
]

export const KIND_BY_WEAPON_KEY: Record<string, ProjectileKind> = {
  // §F1's five guns. The lasers are deliberately absent: they are still
  // `Delivery::Hitscan` and draw as beams, which is the one thing that makes
  // them look different from a gun.
  smg: 'bullet',
  pistol: 'bullet',
  revolver: 'bullet',
  deagle: 'bullet',
  machinegun: 'bullet',
  toxic_drop: 'drop',
  bazooka: 'bazooka',
  grenade: 'grenade',
  meteor: 'meteor',
  meteor_fragment: 'fragment',
  airburst: 'airburst',
  airburst_pellet: 'pellet',
  smoke: 'smoke',
  molotov: 'molotov',
  toxic_grenade: 'toxic',
}

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

/**
 * The two ends of a bullet's drawn streak (§F2).
 *
 * **Direction comes from the trail, not from the wire.** `projectile_move`
 * carries a position and nothing else, and adding a velocity field to make a
 * drawing decision would put a rendering concern into the protocol — the server
 * would have to send, snapshot and replay a number only the renderer reads. The
 * last two positions already say which way the round is going.
 *
 * A round with one trail point has no direction yet (it was spawned this frame
 * and has not moved), and so does one whose last two samples are identical. Both
 * draw a **dot** — `x0 === x1`, `y0 === y1` — rather than normalising a zero
 * vector, which is `0/0` and paints nothing at all while looking like a draw.
 * That is the NaN the unit test is about.
 *
 * The streak is drawn **behind** the round: the head sits at the current
 * position, where the physics says the bullet is, and the tail trails back along
 * where it came from. A streak centred on the position would put half the round
 * in front of itself.
 */
export function bulletStreak(
  p: { x: number; y: number; trail: TrailPoint[] },
  length: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const head = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }
  const prev = p.trail.length >= 2 ? p.trail[p.trail.length - 2] : undefined
  if (!prev) return head
  const dx = p.x - prev.x
  const dy = p.y - prev.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return head
  return { x0: p.x, y0: p.y, x1: p.x - (dx / len) * length, y1: p.y - (dy / len) * length }
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
  // Bright and small: a round has to be findable at night (§A3) without a
  // sustained burst turning the map into daylight — twenty can be in the air.
  bullet: { r: 40, a: 0.6 },
  bazooka: { r: 90, a: 0.85 },
  grenade: { r: 45, a: 0.5 },
  meteor: { r: 150, a: 1 },
  fragment: { r: 60, a: 0.7 },
  // Energy ordnance reads cooler and brighter than ballistic, because what it
  // does to a shield is different and the player has to be able to tell (§B5).
  airburst: { r: 70, a: 0.7 },
  pellet: { r: 40, a: 0.6 },
  // Smoke denies sight; a bright glow on it would defeat its own purpose.
  smoke: { r: 20, a: 0.15 },
  molotov: { r: 80, a: 0.8 },
  toxic: { r: 70, a: 0.6 },
  // Rain, not ordnance: enough to catch the eye falling through a dark sky and
  // no more. A drop that lit the ground like a rocket would make a toxic storm
  // brighter than daylight — twenty of them are in the air at once.
  drop: { r: 24, a: 0.35 },
}

export class OrdnanceState {
  readonly tracers: Tracer[] = []
  /**
   * Freeze beam decay. Debug-only, for headless screenshots.
   *
   * A beam lives `BEAM_LIFETIME` — 0.35 s since §F2, and 0.09 s before it, which
   * was shorter than a Playwright screenshot round-trip, so a shot of "the
   * tracer" reliably captured an empty hillside instead. Holding decay makes the
   * evidence deterministic rather than a race.
   *
   * **A bullet needs none of this**, and that is the point of §F1: `bullets-visible`
   * photographs a round in flight with the game running, because a thing that
   * takes time to cross the screen can simply be looked at. Needing to stop the
   * world to see your own gunfire was the bug.
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
