import { describe, expect, it } from 'vitest'
import { KIND_BY_WEAPON_KEY, LOOK, OrdnanceState, WEAPON_KEYS } from './ordnance-state'
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
      expect(LOOK[kind].r).toBeGreaterThanOrEqual(3)
    }
  })
})
