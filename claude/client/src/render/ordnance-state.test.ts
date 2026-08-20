import { describe, expect, it } from 'vitest'
import { OrdnanceState } from './ordnance-state'

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
