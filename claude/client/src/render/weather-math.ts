/**
 * Weather particle fields — the pure half (§A8: Phaser cannot be imported under
 * vitest, so the logic lives here and the drawing imports it).
 *
 * These are **emitters, not entities**. `TOXIC_DURATION` is 8 s of rain over a
 * whole map; an object per drop is thousands of allocations a second for something
 * nobody counts. A fixed pool of points that wrap is the same picture for a
 * constant cost.
 *
 * The bug this exists for: the weather simulation is correct and heavily tested,
 * and none of it reached the screen — §B21, where heavy fog ran correctly for five
 * milestones while `fogMult` was hardcoded to 1. Toxic rain fell on nobody's
 * screen for the same reason: the puddles were drawn and the rain never was.
 */

import { C, fogStrength } from '../core'

export interface Drop {
  x: number
  y: number
  /** Fall speed, px/s. Varied per drop so the sheet has depth. */
  vy: number
  /** Lateral drift, px/s. */
  vx: number
  len: number
}

export interface Ember {
  x: number
  y: number
  vx: number
  vy: number
  /** Seconds remaining. */
  life: number
  ttl: number
}

/** Deterministic from a seed, so a screenshot of the rain is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * A sheet of falling droplets covering a rectangle, wrapping at the bottom.
 *
 * `intensity` ramps 0..1 so the rain fades in and out rather than appearing whole,
 * which is what makes it read as weather rather than as a layer being toggled.
 */
/**
 * Live real drops → the fraction of the emitter's pool to draw (T20.05).
 *
 * §C6 gave the rain a particle emitter; §C21 made a drop a projectile *"so that
 * the rain is visible"*. Both clauses are live, and for five milestones the game
 * satisfied them **separately**: a 260-droplet sheet on seed 4242 that knew
 * nothing about the weather, and an unrelated set of real drops that did the
 * carving and the poisoning. A player saw a downpour and was hit by a drizzle.
 *
 * This is the join. It is a **scalar**, deliberately: the emitter is
 * `setScrollFactor(0)` screen-space and the drops are world-space projectiles, so
 * drawing a particle *at* a drop is a different renderer, not this one.
 *
 * `full` is `TOXIC_DROPS_IN_FLIGHT` — measured, not the 54 drops a whole shower
 * releases, which is a cumulative figure against a live one.
 */
export function toxicDensity(liveDrops: number, full: number): number {
  if (!(full > 0)) return 0
  return Math.max(0, Math.min(1, liveDrops / full))
}

export class RainField {
  readonly drops: Drop[] = []
  intensity = 0
  /**
   * `0..1`, ramped like `intensity` — the share of the pool that is drawn.
   *
   * **Separate from `intensity` on purpose.** `intensity` is "is this effect
   * happening", and it drives the fade and the green cast; this is "how hard",
   * and it drives the count. One scalar meaning both would make a shower that is
   * merely starting indistinguishable from one that is nearly dry — a field that
   * means two things, which is the shape this repo keeps paying for.
   */
  density = 0

  constructor(
    count: number,
    private w: number,
    private h: number,
    seed = 1,
  ) {
    const r = rng(seed)
    for (let i = 0; i < count; i++) {
      this.drops.push({
        x: r() * w,
        y: r() * h,
        vy: 420 + r() * 380,
        vx: -30 + r() * 20,
        len: 6 + r() * 10,
      })
    }
  }

  resize(w: number, h: number): void {
    this.w = w
    this.h = h
  }

  /**
   * `target` is 1 while the effect is active, 0 otherwise; the ramp is 1/`ramp` s.
   *
   * `density` is `toxicDensity(liveDrops, TOXIC_DROPS_IN_FLIGHT)` and is
   * **required**, not defaulted (T20.05). A default of 1 would mean "draw the
   * whole sheet", which is exactly the behaviour this task removed — a caller
   * that forgot to wire the real drops would compile, run, and reproduce the bug.
   * It rides the same ramp so a drop landing does not pop 37 droplets off the
   * screen.
   */
  update(dt: number, target: number, density: number, ramp = 1.5): void {
    const step = dt / ramp
    this.intensity =
      target > this.intensity
        ? Math.min(target, this.intensity + step)
        : Math.max(target, this.intensity - step)
    this.density =
      density > this.density
        ? Math.min(density, this.density + step)
        : Math.max(density, this.density - step)

    if (this.intensity <= 0) return
    for (const d of this.drops) {
      d.y += d.vy * dt
      d.x += d.vx * dt
      // Wrap rather than respawn: the pool never changes size, so the cost of a
      // downpour is the cost of a drizzle.
      if (d.y > this.h) {
        d.y -= this.h
        d.x = ((d.x % this.w) + this.w) % this.w
      }
      if (d.x < 0) d.x += this.w
      else if (d.x > this.w) d.x -= this.w
    }
  }

  /**
   * How many of the pool to draw right now.
   *
   * A prefix of the pool rather than a random subset: the drops' x are already
   * uniform over the width, so the first N are spread as evenly as any N, and a
   * stable prefix means a thinning shower fades out droplets instead of
   * reshuffling the whole sheet every frame.
   */
  get visibleDrops(): number {
    return Math.round(this.density * this.drops.length)
  }
}

/**
 * Fire spewing **upward** from a vent, spreading and falling back.
 *
 * `docs/72` §C6 asks for a spew, not a cone: the sandbox drew a static triangle,
 * which shows where the jet is and not that it is erupting. Embers are spawned at
 * the vent with an upward velocity and a lean, then fall under gravity — the arc
 * is what makes it read as pressure.
 */
export class EmberField {
  readonly embers: Ember[] = []
  private acc = 0
  private r = rng(7)

  constructor(
    private readonly perSecond: number,
    private readonly max: number,
  ) {}

  /** Emit from a vent for this frame. `lean` is the jet's tilt in radians. */
  emit(dt: number, x: number, y: number, lean: number, speed: number): void {
    this.acc += this.perSecond * dt
    while (this.acc >= 1) {
      this.acc -= 1
      if (this.embers.length >= this.max) break
      const a = -Math.PI / 2 + lean + (this.r() - 0.5) * 0.7
      const v = speed * (0.6 + this.r() * 0.7)
      this.embers.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: 0.7 + this.r() * 0.6,
        ttl: 1.3,
      })
    }
  }

  update(dt: number, gravity: number): void {
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i]!
      e.life -= dt
      if (e.life <= 0) {
        // Swap-remove: order does not matter and splice in a loop is quadratic.
        this.embers[i] = this.embers[this.embers.length - 1]!
        this.embers.pop()
        continue
      }
      e.vy += gravity * dt
      e.x += e.vx * dt
      e.y += e.vy * dt
    }
  }

  clear(): void {
    this.embers.length = 0
  }
}

// ---------------------------------------------------------------------------
// Heavy fog's screen-space veil (§F9)
// ---------------------------------------------------------------------------

/**
 * How opaque the fog veil is right now: `FOG_SCREEN_ALPHA × strength`.
 *
 * A function of one number rather than a field on the layer, because the layer
 * must not hold a fade of its own. `strength` is `fog.rs`'s ramp — the same one
 * `fov_multiplier` reads — so the veil and the shrinking field of view cannot
 * disagree about how foggy it is, and `FOG_RAMP` is honoured without a second
 * smoothstep anywhere in the client.
 *
 * Clamped, because the two callers get `strength` from different places: the
 * sandbox reads its local world's `weather.fog`, and a networked client walks the
 * ramp itself from the effect's start time, where a clock that has run past the
 * end must read 0 rather than a negative alpha Phaser would silently treat as
 * opaque.
 *
 * **And it is required, not defaulted.** T20.05 argued — correctly — that
 * `RainField`'s density argument must be required because *"a default of 1 is
 * the old bug and would let an unwired caller reproduce it silently"*. `false`
 * here is the old bug in exactly that sense: it is the pre-T20.07 behaviour, a
 * veil that never lightens. Two commits in one family applied opposite rules to
 * the same hazard; this is the one rule, applied to both.
 *
 * **`hasFlashlight` is a second argument, not a pre-scale of `strength`** (T20.07,
 * and the task file is explicit). `strength` is stored as `debug().fogStrength`
 * and asserted by `weather-visible.mjs` and `fog-visible.mjs`; discounting it here
 * would make that number mean "the effect's strength, less whatever the player is
 * carrying" — one field, two meanings — and those checks would silently start
 * measuring something else while still passing.
 *
 * The multiplier is `FLASHLIGHT_FOG_VEIL_MULT`, and the three readings of
 * *"20 % more visible"* are weighed in its doc comment. It defaults to off so the
 * sandbox's fog path, which has no player inventory in scope, keeps its meaning.
 */
export function fogVeilAlpha(strength: number, hasFlashlight: boolean): number {
  const lit = hasFlashlight ? C().FLASHLIGHT_FOG_VEIL_MULT : 1
  return C().FOG_SCREEN_ALPHA * Math.min(1, Math.max(0, strength)) * lit
}

/**
 * Which heavy fog is running, and when it started — the networked client's half
 * of §F9.
 *
 * A class rather than two fields on `GameScene` for one reason: **the id matters
 * and it is easy to drop.** Weather effects overlap, so an `effect_end` for a
 * toxic rain that began after the fog must not switch the veil off in the middle
 * of it. That rule has exactly one branch, it lives in a scene vitest cannot
 * load without a canvas, and it fails silently — the fog would simply stop
 * looking foggy while the server still says it is foggy. Here it is testable.
 *
 * The sandbox does **not** use this: it owns a real `HeavyFog` and reads
 * `weather.fog` off its own world. This exists because a match's weather runs on
 * the server and the snapshot carries only `vision`, which is fog *times smoke*.
 */
export class FogClock {
  private id = -1
  private startedAt: number | null = null

  /** An `effect_start` arrived. Anything that is not heavy fog is ignored. */
  start(id: number, kind: string, roundTime: number): void {
    if (kind !== 'HeavyFog') return
    this.id = id
    this.startedAt = roundTime
  }

  /** An `effect_end` arrived. Only the fog's own end clears it. */
  end(id: number): void {
    if (id !== this.id) return
    this.id = -1
    this.startedAt = null
  }

  /**
   * Forget the fog entirely, whatever its id.
   *
   * Distinct from `end`, which is the **event** and refuses an id that is not
   * this fog's — the rule this class exists to hold. A scene tearing down at the
   * end of a round has no `effect_end` to hand it and no id to quote, and it is
   * not ending an effect: it is discarding a round. `GameScene.resetForNewRound`
   * is the caller (T20.13); a fog left running here veiled the **next** match.
   */
  clear(): void {
    this.id = -1
    this.startedAt = null
  }

  /** `0..1` — `fog.rs`'s ramp, walked from the start time. */
  strength(roundTime: number): number {
    if (this.startedAt === null) return 0
    return fogStrength(roundTime - this.startedAt)
  }

  /** For a debug handle: is a fog running at all, independent of its ramp? */
  get running(): boolean {
    return this.startedAt !== null
  }
}

/**
 * Which lava burst is running, when it started, and the seed the server chose
 * its vents with — the networked client's half of §A3's ground fire (T19.24).
 *
 * `FogClock`'s shape, for the same reasons: effects overlap, so an `effect_end`
 * belonging to another effect must not switch this one off, and that branch is
 * untestable inside a scene vitest cannot load. What it adds is the **seed**,
 * because unlike fog — whose ramp is a pure timer — lava's presentation is a set
 * of *places*, and those are derived from the seed the server broadcast.
 *
 * The sandbox does not use this: it owns a real `LavaBurst` and reads
 * `weatherStep().vents` off its own world. A match's weather runs on the server,
 * and until this existed the networked client drew none of it — no vent, no
 * mouth, no ember, and no light during the jet, which is the only phase that
 * damages you.
 */
export class LavaClock {
  private id = -1
  private startedAt: number | null = null
  private lo = 0
  private hi = 0

  /**
   * An `effect_start` arrived. Anything that is not a lava burst is ignored.
   *
   * **Records the seed and starts no clock.** `effect_start` fires at the
   * *telegraph*, and `lava.rs` does not open its vents then: `tick` returns
   * early while `active` is false, and re-bases every `jet_until` to the moment
   * `opened` flips. So a clock started here runs `EFFECT_TELEGRAPH` (3 s) ahead
   * of the server's — which, against 3 s phases, means the client reports
   * *jetting* through the whole telegraph and *burning* through the whole jet.
   * A phase out, in the direction that draws fire before there is any. The
   * origin comes from `activate` instead.
   *
   * `seed` is the decimal string `effect_start` carries — a `u64`, which JSON
   * has no type for and `wasm_bindgen` has no parameter for, hence the split
   * into two 32-bit halves here rather than at each call site.
   */
  start(id: number, kind: string, seed: string): void {
    if (kind !== 'LavaBurst') return
    let s: bigint
    try {
      s = BigInt(seed)
    } catch {
      // A malformed seed is a server that changed the wire format, not a reason
      // to throw inside an event handler and take the scene down with it.
      return
    }
    this.id = id
    this.startedAt = null
    this.lo = Number(s & 0xffffffffn)
    this.hi = Number((s >> 32n) & 0xffffffffn)
  }

  /**
   * An `effect_phase` arrived. Only `active` starts the clock, and only for this
   * burst — the moment `lava.rs` opens its vents and re-bases their timers.
   */
  activate(id: number, phase: string, roundTime: number): void {
    if (id !== this.id || phase !== 'active') return
    this.startedAt = roundTime
  }

  /** An `effect_end` arrived. Only this burst's own end clears it. */
  end(id: number): void {
    if (id !== this.id) return
    this.clear()
  }

  /** Discard the round, whatever is running — `FogClock.clear`'s reason. */
  clear(): void {
    this.id = -1
    this.startedAt = null
    this.lo = 0
    this.hi = 0
  }

  /**
   * What to ask the core for, or `null` when no burst is running.
   *
   * Returned as one object rather than three getters so a caller cannot read a
   * seed that belongs to a burst that has since ended.
   */
  query(roundTime: number): { lo: number; hi: number; elapsed: number } | null {
    if (this.startedAt === null) return null
    return { lo: this.lo, hi: this.hi, elapsed: roundTime - this.startedAt }
  }

  /** For a debug handle: are this burst's vents open? */
  get running(): boolean {
    return this.startedAt !== null
  }

  /** For a debug handle: is a burst known but still telegraphing? */
  get telegraphing(): boolean {
    return this.id !== -1 && this.startedAt === null
  }
}

/**
 * The lights a lava vent casts, by phase.
 *
 * **One function because there are now two callers** (T19.24). `SandboxScene`
 * has had these five numbers inline since the effect was built; `GameScene`
 * needs the same ones now that a networked client finally has vents to light,
 * and a second copy is a second place for the jet's offset or the burn's radius
 * to drift. `docs/14` §A3 — fire is a light source at night — is the claim both
 * of them are keeping, so it should be kept once.
 *
 * The jet is lit **above** the mouth because that is where the column of lava
 * is; the afterburn is lit at the mouth itself and dimmer, because what is left
 * is glowing ground rather than a jet.
 *
 * Returned structurally rather than as `lightmap.ts`'s `LightSource` so this
 * file stays free of the render layer and testable without a canvas.
 */
export function ventLights(
  vents: readonly { x: number; y: number; jetting: boolean; burning: boolean }[],
): { x: number; y: number; radius: number; intensity: number }[] {
  const out: { x: number; y: number; radius: number; intensity: number }[] = []
  for (const v of vents) {
    if (v.jetting) out.push({ x: v.x, y: v.y - JET_LIGHT_RISE, radius: JET_LIGHT_R, intensity: JET_LIGHT_A })
    else if (v.burning) out.push({ x: v.x, y: v.y, radius: BURN_LIGHT_R, intensity: BURN_LIGHT_A })
  }
  return out
}

/** How far above the mouth the jet's light sits — the column, not the hole. */
const JET_LIGHT_RISE = 60
const JET_LIGHT_R = 150
const JET_LIGHT_A = 0.9
const BURN_LIGHT_R = 90
const BURN_LIGHT_A = 0.6
