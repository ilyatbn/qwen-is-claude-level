/**
 * Bookkeeping for the ordnance the server narrates but nobody drew (§A39 #10):
 * melee swings, flame cones, placed mines and the three hazard zones T11.08
 * added. Phaser-free (§A8).
 *
 * This file is the part that can be wrong in a way a screenshot will not show.
 * A mine drawn twice, or one the server destroyed and the client kept, looks
 * exactly like a normal minefield — which is why the count is asserted against
 * the server's rather than eyeballed (§A39).
 */

/** A melee arc, alive for a fraction of a second. */
export interface Swing {
  x: number
  y: number
  /** Aim angle in radians — the arc is centred on it. */
  aim: number
  reach: number
  /** Full arc width in radians. */
  arc: number
  /** How many players it caught. A swing that connected is drawn brighter. */
  hits: number
  /** Seconds remaining. */
  ttl: number
  /** Seconds it started with, so alpha can be a fraction rather than a clock. */
  life: number
}

/** A flamethrower jet. Short-lived and re-emitted every tick you hold fire. */
export interface Jet {
  x: number
  y: number
  aim: number
  range: number
  arc: number
  ttl: number
  life: number
}

/** A placed mine, as the client knows it. */
export interface Mine {
  id: number
  owner: number
  x: number
  y: number
  /** Seconds since it was placed, for the arming tell. */
  age: number
}

/**
 * **No `fire` since §F10.2.** Burning ground was a `HazardSpawn` the client drew
 * as a disc; a molotov bursts into `MOLOTOV_FLAMES` projectiles now and each one
 * draws itself in the ordnance layer. `BurnZone` has a single variant left, so
 * the only hazards a server still narrates are the toxic grenade's cloud and
 * smoke — and a kind spelled `Fire` arriving here would be a *bug*, not a disc
 * to draw, which is why it falls through to `other` rather than keeping a
 * private renderer alive for nobody.
 */
export type HazardKind = 'toxic' | 'smoke' | 'other'

/** A ground hazard: a toxic zone, or a smoke cloud. */
export interface Hazard {
  id: number
  kind: HazardKind
  x: number
  y: number
  r: number
  /** Seconds remaining; hazards also end early via `hazard_ended`. */
  ttl: number
  life: number
}

/** Why a mine left the world. Each looks different (§B6). */
export type MineEnd = 'detonated' | 'destroyed' | 'expired'

export interface FxLight {
  x: number
  y: number
  r: number
  a: number
}

/**
 * The server sends `kind` as a Rust `Debug` string (`ToxicZone`, `Smoke`…).
 * Match on substrings rather than exact values: the
 * client must not break when a variant is renamed, and an unknown kind draws as
 * a neutral zone rather than throwing.
 *
 * This is the same lesson as `effect_phase` sending `"Active"` while
 * `effect_start` sent `"telegraph"` — a client switching on an exact spelling
 * is a client that breaks when the server spells it differently.
 */
export function hazardKind(raw: string): HazardKind {
  const s = raw.toLowerCase()
  if (s.includes('smoke')) return 'smoke'
  if (s.includes('toxic')) return 'toxic'
  return 'other'
}

/** `MineEnded.reason`, likewise by substring. Unknown reasons expire quietly. */
export function mineEnd(raw: string): MineEnd {
  const s = raw.toLowerCase()
  if (s.includes('detonat')) return 'detonated'
  if (s.includes('destroy')) return 'destroyed'
  return 'expired'
}

/** Fraction of life remaining, 1 at spawn and 0 at expiry. Never negative. */
export function fade(ttl: number, life: number): number {
  if (life <= 0) return 0
  return Math.max(0, Math.min(1, ttl / life))
}

/**
 * Every live effect, and nothing else.
 *
 * Mines are keyed by id because the server names them; swings, jets and
 * hazards-without-ids are pooled by index and expire on their own. Hazards
 * carry ids because smoke ends early when its cloud is cleared.
 */
export class OrdnanceFxState {
  readonly swings: Swing[] = []
  readonly jets: Jet[] = []
  readonly mines = new Map<number, Mine>()
  readonly hazards = new Map<number, Hazard>()

  constructor(
    private readonly swingLife: number,
    private readonly jetLife: number,
    private readonly maxSwings = 64,
    private readonly maxJets = 64,
  ) {}

  addSwing(x: number, y: number, aim: number, reach: number, arc: number, hits: number): void {
    // Bounded: a knife at a 0.35 s cooldown, or six bots swinging at once, must
    // not grow this without limit. Oldest goes, because the newest swing is the
    // one the player is looking at.
    if (this.swings.length >= this.maxSwings) this.swings.shift()
    this.swings.push({ x, y, aim, reach, arc, hits, ttl: this.swingLife, life: this.swingLife })
  }

  addJet(x: number, y: number, aim: number, range: number, arc: number, life = this.jetLife): void {
    if (this.jets.length >= this.maxJets) this.jets.shift()
    this.jets.push({ x, y, aim, range, arc, ttl: life, life })
  }

  addMine(id: number, owner: number, x: number, y: number): void {
    this.mines.set(id, { id, owner, x, y, age: 0 })
  }

  /** Removing an id we never saw placed is a no-op — a mid-round joiner has
   * exactly that history, and throwing there would kill the scene. */
  removeMine(id: number): MineEnd | null {
    return this.mines.delete(id) ? 'expired' : null
  }

  addHazard(id: number, kind: HazardKind, x: number, y: number, r: number, duration: number): void {
    this.hazards.set(id, { id, kind, x, y, r, ttl: duration, life: Math.max(duration, 0.0001) })
  }

  removeHazard(id: number): void {
    this.hazards.delete(id)
  }

  update(dt: number): void {
    for (let i = this.swings.length - 1; i >= 0; i--) {
      const s = this.swings[i]
      if (s === undefined) continue
      s.ttl -= dt
      if (s.ttl <= 0) this.swings.splice(i, 1)
    }
    for (let i = this.jets.length - 1; i >= 0; i--) {
      const j = this.jets[i]
      if (j === undefined) continue
      j.ttl -= dt
      if (j.ttl <= 0) this.jets.splice(i, 1)
    }
    for (const m of this.mines.values()) m.age += dt
    for (const [id, h] of [...this.hazards]) {
      h.ttl -= dt
      if (h.ttl <= 0) this.hazards.delete(id)
    }
  }

  /**
   * Light sources, fed to the lightmap like every other emitter (§A3).
   *
   * Fire and flame jets emit; toxic glows faintly; smoke and mines emit
   * nothing — a mine that lit itself up at night would defeat the point of
   * hiding it, and smoke is the opposite of a light.
   */
  lights(): FxLight[] {
    const out: FxLight[] = []
    for (const j of this.jets) {
      out.push({
        x: j.x + Math.cos(j.aim) * j.range * 0.4,
        y: j.y + Math.sin(j.aim) * j.range * 0.4,
        r: j.range * 0.7,
        a: 0.8 * fade(j.ttl, j.life),
      })
    }
    for (const h of this.hazards.values()) {
      // §F10.2 took the fire zone's light with the fire zone. What lit the
      // ground around a molotov now is the flames themselves, through
      // `OrdnanceState.lights()` — one light per burning object rather than one
      // per announced rectangle of rule.
      if (h.kind === 'toxic') out.push({ x: h.x, y: h.y, r: h.r * 1.4, a: 0.28 })
    }
    return out
  }

  /** How visible a mine should be: unmissable close up, nearly nothing far off.
   *
   * §B6: "a mine must be visible at close range and subtle at distance — a
   * blinking light that reads at 40 px and not at 300. Invisible instant death
   * is not fun; a trap you could have spotted is." */
  static mineAlpha(dist: number, near: number, far: number): number {
    if (dist <= near) return 1
    if (dist >= far) return 0
    return 1 - (dist - near) / (far - near)
  }

  /** An armed mine pulses; a disarmed one sits still. */
  static isArmed(age: number, armTime: number): boolean {
    return age >= armTime
  }
}
