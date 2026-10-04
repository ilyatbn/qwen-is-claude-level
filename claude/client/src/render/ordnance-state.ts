/**
 * The pure half of visible ordnance (§A8): tracer, trail and impact bookkeeping.
 *
 * §A3 is a headline requirement — **every shot is visible and every shot digs**.
 * The SMG stays hitscan; what makes it visible is a tracer drawn along the
 * `hitscan` event's segment. **T23.09: the lights these records cast are built from
 * them in `look/effectLights.ts`** (F's point lights on the lit terrain); the lightmap
 * light list that lived here (`lights()`, `GLOW`) retired with the lightmap's effect role.
 */

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
  | 'flame'
  /** T24.01: the durian grenade in flight, and one of the four pieces it bursts into. */
  | 'durian'
  | 'durianPiece'

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
  // §F10.3. **`r` is unused for a flame**, as it is for a bullet: its discs are
  // sized from `FLAME_RADIUS` by `flameDiscs`, so the fire you see covers the
  // circle that burns you. T21.36: this used to be `r: 7` under a comment saying
  // "a little larger than `FLAME_RADIUS`" — the discs reached ~8 px against 10,
  // and `fire-shader` measured 85–108 of 192 burn-circle points unpainted.
  // The trail is short: a flame flies for a fraction of its life and rests for
  // the rest of it, and a long tail behind a resting flame is a smear.
  flame: { r: 0, colour: 0xff8a2b, trail: 4 },
  // T24.01: the grenade flies as its model (`ordnance.ts::THROWN_KEY`) with a green glow; a piece is a small purple
  // ember with a short tail — it becomes a purple cloud (`fx/game.ts::DURIAN_GAS_RGB`).
  durian: { r: 5, colour: 0x6eff8c, trail: 6 },
  durianPiece: { r: 3, colour: 0xb05cff, trail: 6 },
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
  // T21.11C's gun platform. **Appended, like every id before it** — the registry
  // is positional and `weaponKeysMatchTheRustRegistry` pins this list to it, so
  // a missing entry here is one weapon's worth of shift in every projectile
  // colour after it (§B16, the laser that resolved as a bazooka).
  //
  // Nobody carries it: there is no `ItemDef`, it never enters an inventory, and
  // it is spawned only by `World::fire_platform`. It is here because it has a
  // `WeaponId` and its rounds fly.
  'platform_gun',
  // T24.01: the durian grenade and its piece. Appended (§B16), as the registry appends them.
  'durian_grenade',
  'durian_piece',
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
  // §F10.3. Every fire in the game is one of these now — a flamethrower press,
  // a molotov's crowd and a lava vent's afterburn all arrive as this weapon.
  flame: 'flame',
  // T21.11C. A **bullet**, drawn exactly like the ballistic guns above: the
  // rounds go down the same `Delivery::Bullet` path in Rust, so drawing them
  // any other way would be two pictures of one thing — the §A24 mistake this
  // file's `LOOK` comment already records having paid for once.
  platform_gun: 'bullet',
  // T24.01.
  durian_grenade: 'durian',
  durian_piece: 'durianPiece',
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

/** T21.18: one explosion as the High Quality blast paints it. `age` counts up to `ttl`. */
export interface Blast {
  x: number
  y: number
  r: number
  age: number
  ttl: number
  /**
   * T23.19D (R27): the start of the blast's random stream (`fx/game.ts::blastStream`); absent — the game's case — it
   * is derived from the blast's place. The look-lab names the mockup's (`MOCKUP_STREAM`) to draw F1's explosion.
   */
  stream?: number
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
  /**
   * T21.18: what a High Quality blast is painted from — the same explosion as its
   * `Impact`, but living `blastLife` seconds so the soot can linger after the flash.
   * **Drawing only**: lights still come from `impacts`, and the crater and knockback
   * are the server's. `blastLife` 0 (the default) records none.
   */
  readonly blasts: Blast[] = []
  blastLife = 0
  /** Freeze impact and blast decay — `holdTracers`' twin, for a check posing one blast. */
  holdImpacts = false

  constructor(
    private readonly tracerLifetime: number,
    private readonly trailLen: number,
  ) {}

  addTracer(x0: number, y0: number, x1: number, y1: number): void {
    this.tracers.push({ x0, y0, x1, y1, life: this.tracerLifetime, ttl: this.tracerLifetime })
  }

  addProjectile(id: number, kind: ProjectileKind, x: number, y: number): void {
    this.projectiles.set(id, { id, kind, x, y, trail: [{ x, y }] })
    this.unshown.add(id)
    // T23.14E F8: a round added under an id still leaving (removed before its one draw) is a live round: it must not
    // be taken off by the old one's pending removal at the next `update`.
    this.leaving.delete(id)
  }

  /** T23.09D: rounds added since the last `update` (the layer's draw), and rounds removed before one was drawn. */
  private readonly unshown = new Set<number>()
  private readonly leaving = new Set<number>()

  moveProjectile(id: number, x: number, y: number): void {
    const p = this.projectiles.get(id)
    if (!p) return
    p.x = x
    p.y = y
    p.trail.push({ x, y })
    // A bounded ring: a 10 shots/s weapon must not grow this without limit.
    if (p.trail.length > this.trailLen) p.trail.splice(0, p.trail.length - this.trailLen)
  }

  /**
   * Take a round off. T23.09D: **a round is drawn on at least one frame** — one added since the last `update` stays,
   * where it was last moved to, until the `update` after next, so it is drawn once. A round shorter than a frame (an smg
   * round striking rock ~25 px out lives ~3 sim ticks; a loaded box's frame holds them all) was spawned, flown and
   * removed between two draws and never seen (`m4-checkpoint`, red in the batch gate).
   */
  removeProjectile(id: number): void {
    if (this.unshown.has(id) && this.projectiles.has(id)) {
      this.leaving.add(id)
      return
    }
    this.projectiles.delete(id)
  }

  addImpact(x: number, y: number, r: number, kind: string, ttl = 0.35): void {
    this.impacts.push({ x, y, r, kind, life: ttl, ttl })
    if (this.blastLife > 0) this.blasts.push({ x, y, r, age: 0, ttl: this.blastLife })
  }

  update(dt: number): void {
    // T23.09D: a round removed before it was drawn goes once it has been (this update's draw is its one frame).
    for (const id of this.leaving) {
      if (this.unshown.has(id)) continue
      this.projectiles.delete(id)
      this.leaving.delete(id)
    }
    this.unshown.clear()
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      if (this.holdTracers) break
      const t = this.tracers[i]!
      t.life -= dt
      if (t.life <= 0) this.tracers.splice(i, 1)
    }
    if (!this.holdImpacts) this.ageImpacts(dt)
  }

  /**
   * Age impacts and blasts by `dt`, dropping the finished ones. `update` calls it, and
   * so does a check posing a held blast at a known age — one function, so the pose
   * and the game age them the same way.
   */
  ageImpacts(dt: number): void {
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i]!
      im.life -= dt
      if (im.life <= 0) this.impacts.splice(i, 1)
    }
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i]!
      b.age += dt
      if (b.age >= b.ttl) this.blasts.splice(i, 1)
    }
  }

  get counts(): { tracers: number; projectiles: number; impacts: number } {
    return {
      tracers: this.tracers.length,
      projectiles: this.projectiles.size,
      impacts: this.impacts.length,
    }
  }
}

// ---------------------------------------------------------------------------
// F10.3 — a flame flickers
// ---------------------------------------------------------------------------

/**
 * A flame's brightness right now: `0.75 .. 1.0`, and **deterministic**.
 *
 * Keyed on the flame's id and the time, never on a per-frame draw. `CLAUDE.md`:
 * a gate that fails on a coin flip gates nothing — and `fire-visible` counts
 * *clusters of lit pixels across two frames*, so a flicker re-rolled each frame
 * would make the count a dice throw. Two calls with the same id and the same
 * time give the same number, which is what the unit test asserts.
 *
 * The id is folded in so a crowd does not pulse in unison: twenty-four flames
 * breathing together reads as one object with a heartbeat, which is the decal
 * §F10 exists to stop being.
 */
export function flameFlicker(id: number, timeMs: number): number {
  // Two incommensurable rates so the pattern does not repeat visibly, and an
  // id-derived phase so neighbours are out of step. `sin` rather than a hash:
  // a flame's brightness has to move *smoothly*, or it strobes.
  const phase = (id % 97) * 0.6180339887
  const t = timeMs / 1000
  const a = Math.sin(t * 11.0 + phase)
  const b = Math.sin(t * 17.0 + phase * 2.3)
  // `a * 0.6 + b * 0.4` is in [-1, 1], so the result is in [FLAME_FLICKER_MIN, 1].
  return FLAME_FLICKER_MID + FLAME_FLICKER_SWING * (a * 0.6 + b * 0.4)
}

const FLAME_FLICKER_MID = 0.875
const FLAME_FLICKER_SWING = 0.125
/** The smallest value `flameFlicker` returns. `flameDiscs` sizes the body from it. */
export const FLAME_FLICKER_MIN = FLAME_FLICKER_MID - FLAME_FLICKER_SWING

/**
 * The three flat discs of a flame wherever the world renderer does not draw the effects (`fx/feed.ts::worldDraws`
 * false: space, no WebGL2 — T23.18 retired the shader quads and their pool),
 * sized from the burn radius — T21.36.
 *
 * **The opaque body covers the burn circle at the smallest flicker**: a player takes
 * `FLAME_DPS` anywhere within `FLAME_RADIUS`, so ground that burns must look like it
 * burns. The rim and heart keep the proportions the flame had (1.15 : 0.8 : 0.38), so
 * it is the same flame, scaled — it just no longer comes from a radius of its own.
 */
export function flameDiscs(burnRadius: number, flicker: number): { rim: number; body: number; heart: number } {
  const body = (burnRadius * flicker) / FLAME_FLICKER_MIN
  return { rim: body * (1.15 / 0.8), body, heart: body * (0.38 / 0.8) }
}

/**
 * Is this flame at rest?
 *
 * Derived from the trail, not sent: `projectile_move` carries a position and
 * nothing else, and adding a `resting` bit to the wire would put a rendering
 * decision into the protocol — the same argument `bulletStreak` makes about
 * velocity. Two samples in the same place is what resting looks like.
 *
 * A flame with fewer than two samples has not moved yet either, so it counts as
 * at rest: it was spawned this frame and has no direction to draw a trail along.
 */
export function flameAtRest(p: { x: number; y: number; trail: TrailPoint[] }): boolean {
  const prev = p.trail.length >= 2 ? p.trail[p.trail.length - 2] : undefined
  if (!prev) return true
  return Math.hypot(p.x - prev.x, p.y - prev.y) < 0.5
}
