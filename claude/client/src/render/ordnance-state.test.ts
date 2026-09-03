import { describe, expect, it } from 'vitest'
import {
  bulletStreak,
  flameAtRest,
  flameFlicker,
  KIND_BY_WEAPON_KEY,
  LOOK,
  OrdnanceState,
  WEAPON_KEYS,
} from './ordnance-state'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIFE = 0.09
const TRAIL = 12

describe('OrdnanceState', () => {
  it('expires a tracer exactly at its lifetime', () => {
    const o = new OrdnanceState(LIFE, TRAIL)
    o.addTracer(0, 0, 100, 0)
    o.update(LIFE - 0.001)
    expect(o.counts.tracers).toBe(1)
    o.update(0.002)
    expect(o.counts.tracers).toBe(0)
  })

  it('never lets a trail exceed its bound', () => {
    // A 10 shots/s weapon must not grow this without limit.
    const o = new OrdnanceState(LIFE, TRAIL)
    o.addProjectile(1, 'bazooka', 0, 0)
    for (let i = 0; i < 500; i++) o.moveProjectile(1, i, i)
    expect(o.projectiles.get(1)!.trail.length).toBe(TRAIL)
    // And it keeps the NEWEST points, not the oldest.
    expect(o.projectiles.get(1)!.trail.at(-1)).toEqual({ x: 499, y: 499 })
  })

  it('ignores moves and removes for unknown ids', () => {
    const o = new OrdnanceState(LIFE, TRAIL)
    expect(() => o.moveProjectile(42, 1, 1)).not.toThrow()
    expect(() => o.removeProjectile(42)).not.toThrow()
    expect(o.counts.projectiles).toBe(0)
  })

  it('lights every live projectile and drops expired impacts', () => {
    const o = new OrdnanceState(LIFE, TRAIL)
    o.addProjectile(1, 'bazooka', 10, 20)
    o.addProjectile(2, 'grenade', 30, 40)
    o.addImpact(50, 60, 42, 'blast', 0.2)

    let lights = o.lights()
    expect(lights.some((l) => l.x === 10 && l.y === 20)).toBe(true)
    expect(lights.some((l) => l.x === 30 && l.y === 40)).toBe(true)
    expect(lights.some((l) => l.x === 50 && l.y === 60)).toBe(true)

    o.update(0.25)
    lights = o.lights()
    expect(lights.some((l) => l.x === 50 && l.y === 60)).toBe(false)
    expect(lights.length).toBe(2)

    o.removeProjectile(1)
    expect(o.lights().length).toBe(1)
  })

  it('makes a rocket a brighter light than a grenade', () => {
    // Night combat is readable because ordnance lights the map; a rocket is the
    // brightest thing most rounds will see.
    const o = new OrdnanceState(LIFE, TRAIL)
    o.addProjectile(1, 'bazooka', 0, 0)
    o.addProjectile(2, 'grenade', 0, 0)
    const [rocket, grenade] = o.lights()
    expect(rocket!.r).toBeGreaterThan(grenade!.r)
    expect(rocket!.a).toBeGreaterThan(grenade!.a)
  })

  it('fades a tracer light as the tracer fades', () => {
    const o = new OrdnanceState(LIFE, TRAIL)
    o.addTracer(0, 0, 100, 0)
    const first = o.lights()[0]!.a
    o.update(LIFE / 2)
    expect(o.lights()[0]!.a).toBeLessThan(first)
  })
})

it('a tracer lights its muzzle as well as its impact', () => {
  // Firing at night must give away the shooter's position, not only the target's
  // (`docs/14-daynight-visibility.md` §2). Lighting only the far end inverts the
  // trade the whole night design rests on.
  const s = new OrdnanceState(0.09, 12)
  s.addTracer(100, 100, 500, 300)
  const lights = s.lights()
  const muzzle = lights.find((l) => l.x === 100 && l.y === 100)
  const impact = lights.find((l) => l.x === 500 && l.y === 300)
  expect(muzzle, 'no light at the muzzle').toBeDefined()
  expect(impact, 'no light at the impact').toBeDefined()
  expect(muzzle!.a).toBeGreaterThan(0)

  // And both fade with the tracer rather than lingering.
  s.update(0.09)
  expect(s.lights().filter((l) => l.x === 100 || l.x === 500)).toHaveLength(0)
})

// ------------------------------------------------------------------ §C4 tables

describe('the projectile look-up tables', () => {
  it('keeps the weapon key order the Rust registry declares', () => {
    // The registry is positional and nothing asserted it. §B16 is the bug where
    // inserting two weapons at the front shifted every later lookup and a laser
    // resolved as a bazooka; the only symptom was an unrelated-looking failure.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../crates/game-core/src/weapons/defs.rs'),
      'utf8',
    )
    const rust = [...src.matchAll(/^\s+key:\s*"([^"]+)"/gm)].map((m) => m[1])
    expect(rust.length).toBeGreaterThan(0) // or the regex silently proves nothing
    expect(WEAPON_KEYS).toEqual(rust)
  })

  it('gives every projectile-bearing weapon a visible look', () => {
    for (const [key, kind] of Object.entries(KIND_BY_WEAPON_KEY)) {
      expect(WEAPON_KEYS, `${key} is not a real weapon`).toContain(key)
      expect(LOOK[kind], `${kind} has no look`).toBeDefined()
      expect(LOOK[kind].r, `${kind} would be invisible`).toBeGreaterThan(0)
    }
  })

  it('draws something for every kind, so nothing is silently invisible', () => {
    for (const kind of Object.keys(LOOK) as Array<keyof typeof LOOK>) {
      // A bullet is exempt from the radius rule and only from that rule: it is
      // drawn as a `BULLET_LENGTH` streak (§F2), so its `r` is the head dot and
      // its visibility comes from the segment. Asserting `r >= 3` on it would be
      // asserting the wrong dimension — and the `bulletStreak` tests above are
      // what cover the one that matters.
      if (kind === 'bullet') continue
      expect(LOOK[kind].r).toBeGreaterThanOrEqual(3)
    }
  })

  it('maps all five guns to a bullet and neither laser to one', () => {
    // §F1 moved exactly five weapons off hitscan. The lasers stayed, and that is
    // the whole reason the two look different — a check that only asserted the
    // guns would pass with the lasers drawn as bullets too.
    for (const key of ['smg', 'pistol', 'revolver', 'deagle', 'machinegun']) {
      expect(KIND_BY_WEAPON_KEY[key], `${key} does not draw as a bullet`).toBe('bullet')
    }
    for (const key of ['laser_pistol', 'laser_smg']) {
      expect(KIND_BY_WEAPON_KEY[key], `${key} draws as a bullet`).not.toBe('bullet')
    }
  })

  it('pins BEAM_LIFETIME to the Rust constant', () => {
    // §F2 raised it from 0.09 to 0.35 because five frames is shorter than a
    // screenshot round-trip — the reason the old check had to freeze the frame.
    // Read from the source rather than copied, or the day it moves this agrees
    // with a value nothing uses.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../crates/game-core/src/constants.rs'),
      'utf8',
    )
    const beam = src.match(/pub const BEAM_LIFETIME: f32 = ([0-9.]+);/)
    expect(beam, 'BEAM_LIFETIME is not in constants.rs').not.toBeNull()
    expect(Number(beam![1])).toBe(0.35)
    // And the name it replaced is gone, so nothing can read a stale 0.09.
    expect(src).not.toMatch(/pub const TRACER_LIFETIME/)
  })
})

// ------------------------------------------------------------------ §F2 streak

describe('bulletStreak', () => {
  const trailed = (pts: Array<[number, number]>) => ({
    x: pts[pts.length - 1]![0],
    y: pts[pts.length - 1]![1],
    trail: pts.map(([x, y]) => ({ x, y })),
  })

  it('lays the streak back along the direction of travel', () => {
    // Moving right: the head is where the round is, the tail is behind it.
    const s = bulletStreak(trailed([[100, 50], [120, 50]]), 10)
    expect(s.x0).toBe(120)
    expect(s.y0).toBe(50)
    expect(s.x1).toBe(110)
    expect(s.y1).toBe(50)
  })

  it('follows a diagonal, at the length asked for', () => {
    const s = bulletStreak(trailed([[0, 0], [30, 40]]), 10)
    // Direction (0.6, 0.8), so the tail is 10 px back along it.
    expect(s.x1).toBeCloseTo(30 - 6, 6)
    expect(s.y1).toBeCloseTo(40 - 8, 6)
    // The length drawn is the length asked for, whatever the heading.
    expect(Math.hypot(s.x0 - s.x1, s.y0 - s.y1)).toBeCloseTo(10, 6)
  })

  it('scales with the length, so the constant reaches the drawing', () => {
    const short = bulletStreak(trailed([[0, 0], [20, 0]]), 4)
    const long = bulletStreak(trailed([[0, 0], [20, 0]]), 40)
    expect(short.x1).toBe(16)
    expect(long.x1).toBe(-20)
  })

  it('draws a dot for a round that has not moved yet, not a NaN', () => {
    // One trail point: spawned this frame, no direction to derive. A normalise
    // here would be 0/0 — which paints nothing while looking exactly like a
    // draw, so the failure would show up as "bullets are invisible" three
    // milestones later.
    const fresh = bulletStreak({ x: 7, y: 9, trail: [{ x: 7, y: 9 }] }, 10)
    expect(fresh).toEqual({ x0: 7, y0: 9, x1: 7, y1: 9 })
    for (const v of Object.values(fresh)) expect(Number.isFinite(v)).toBe(true)

    // Two identical points: a round that reported the same position twice.
    const still = bulletStreak(trailed([[3, 4], [3, 4]]), 10)
    expect(still).toEqual({ x0: 3, y0: 4, x1: 3, y1: 4 })
    for (const v of Object.values(still)) expect(Number.isFinite(v)).toBe(true)
  })

  it('uses the last two points, not the whole trail', () => {
    // A round that turned would otherwise be drawn along its oldest heading.
    // Nothing in this game turns yet, and that is exactly why it has to be
    // pinned: `Delivery::Bullet` flies straight today (§F1) and the drawing must
    // not quietly depend on it.
    const s = bulletStreak(trailed([[0, 0], [100, 0], [100, 50]]), 10)
    expect(s.x1).toBeCloseTo(100, 6)
    expect(s.y1).toBeCloseTo(40, 6)
  })
})

describe('a flame on screen (§F10.3)', () => {
  it('resolves the flame weapon key to the flame look', () => {
    // The whole chain, in one assertion: the registry order gives the key, the
    // key gives the kind, the kind gives the look. §B16 is the bug where the
    // middle step was assumed and a laser drew as a bazooka.
    expect(KIND_BY_WEAPON_KEY['flame']).toBe('flame')
    expect(LOOK.flame).toBeDefined()
    expect(LOOK.flame.r).toBeGreaterThan(0)
    // And it is not somebody else's look. A `KIND_BY_WEAPON_KEY` entry that
    // pointed at `molotov` would satisfy every assertion above.
    expect(LOOK.flame).not.toEqual(LOOK.molotov)
  })

  it('flickers the same way twice for the same flame at the same moment', () => {
    // The requirement that makes `fire-visible` possible at all: it counts
    // clusters of lit pixels across two frames, so a per-frame re-roll would
    // make the count a coin flip, and a gate that fails on a coin flip gates
    // nothing.
    for (const [id, t] of [
      [1, 0],
      [7, 1234.5],
      [160, 98765.25],
    ] as const) {
      expect(flameFlicker(id, t)).toBe(flameFlicker(id, t))
    }
  })

  it('keeps every flame bright, and out of step with its neighbours', () => {
    const t = 4321.0
    const vals = Array.from({ length: 40 }, (_, i) => flameFlicker(i, t))
    for (const v of vals) {
      // Never dark: §F10.3 says a resting flame must not fade, and a flicker
      // that reached zero would put "the fire is out" on the screen while it is
      // still burning.
      expect(v).toBeGreaterThan(0.6)
      expect(v).toBeLessThanOrEqual(1.0)
    }
    // A crowd breathing in unison reads as one object with a heartbeat, which is
    // the decal §F10 replaced. The control that this is really the *id* doing it
    // is the identical-time sample: every value here shares `t`.
    expect(new Set(vals.map((v) => v.toFixed(4))).size).toBeGreaterThan(20)
  })

  it('moves over time, so the flicker is a flicker', () => {
    // Without this, "deterministic" is satisfied by a constant.
    const a = flameFlicker(3, 0)
    const b = flameFlicker(3, 130)
    expect(Math.abs(a - b)).toBeGreaterThan(0.01)
  })

  it('calls a flame at rest only when it has stopped', () => {
    const trail = (pts: [number, number][]) => ({
      x: pts[pts.length - 1]![0],
      y: pts[pts.length - 1]![1],
      trail: pts.map(([x, y]) => ({ x, y })),
    })
    // Spawned this frame: no direction yet, so no trail to draw.
    expect(flameAtRest({ x: 5, y: 5, trail: [{ x: 5, y: 5 }] })).toBe(true)
    expect(flameAtRest(trail([[5, 5], [5, 5]]))).toBe(true)
    // Moving — the control, without which "at rest" passes for everything.
    expect(flameAtRest(trail([[5, 5], [12, 5]]))).toBe(false)
    // Sub-pixel drift on a slope is still at rest: a resting flame reported one
    // tick apart does not land on exactly the same float.
    expect(flameAtRest(trail([[5, 5], [5.2, 5]]))).toBe(true)
  })
})
