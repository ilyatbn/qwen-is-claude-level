import { describe, expect, it } from 'vitest'
import { OrdnanceFxState, fade, hazardKind, mineEnd } from './ordnanceFx-math'

describe('hazardKind', () => {
  // The server sends Rust Debug spellings. A client switching on an exact
  // string is a client that breaks when the server renames a variant — which
  // is what `effect_phase` sending "Active" against "telegraph" already cost.
  it('reads the kinds the server actually sends', () => {
    expect(hazardKind('Smoke')).toBe('smoke')
    expect(hazardKind('ToxicZone')).toBe('toxic')
    expect(hazardKind('ToxicZone')).toBe('toxic')
    expect(hazardKind('Fire')).toBe('fire')
    expect(hazardKind('LavaBurn')).toBe('fire')
  })

  it('falls back rather than throwing on a kind it has never seen', () => {
    expect(hazardKind('SomethingNewInM13')).toBe('other')
    expect(hazardKind('')).toBe('other')
  })
})

describe('mineEnd', () => {
  it('distinguishes the three ways a mine leaves', () => {
    expect(mineEnd('Detonated')).toBe('detonated')
    expect(mineEnd('Destroyed')).toBe('destroyed')
    expect(mineEnd('Expired')).toBe('expired')
  })

  it('treats an unknown reason as a quiet expiry', () => {
    expect(mineEnd('Whatever')).toBe('expired')
  })
})

describe('fade', () => {
  it('runs 1 to 0 over the life and never goes negative', () => {
    expect(fade(1, 1)).toBe(1)
    expect(fade(0.5, 1)).toBe(0.5)
    expect(fade(0, 1)).toBe(0)
    expect(fade(-5, 1)).toBe(0)
  })

  it('is 0 rather than NaN for a zero life', () => {
    expect(fade(1, 0)).toBe(0)
  })
})

describe('OrdnanceFxState', () => {
  const st = () => new OrdnanceFxState(0.15, 0.08, 4, 4)

  it('expires a swing exactly at its life, not before', () => {
    const s = st()
    s.addSwing(0, 0, 0, 30, 1, 1)
    s.update(0.14)
    expect(s.swings).toHaveLength(1)
    s.update(0.02)
    expect(s.swings).toHaveLength(0)
  })

  it('bounds the swing pool under sustained swinging', () => {
    const s = st()
    for (let i = 0; i < 50; i++) s.addSwing(i, 0, 0, 30, 1, 0)
    expect(s.swings.length).toBeLessThanOrEqual(4)
    // The newest survives — it is the one the player is looking at.
    expect(s.swings.at(-1)?.x).toBe(49)
  })

  it('bounds the jet pool the same way', () => {
    const s = st()
    for (let i = 0; i < 50; i++) s.addJet(i, 0, 0, 150, 0.5)
    expect(s.jets.length).toBeLessThanOrEqual(4)
  })

  it('tracks mines by id and ages them', () => {
    const s = st()
    s.addMine(7, 1, 100, 200)
    expect(s.mines.size).toBe(1)
    s.update(0.5)
    expect(s.mines.get(7)?.age).toBeCloseTo(0.5)
  })

  it('ignores an end for a mine it never saw placed', () => {
    // A mid-round joiner has exactly this history. Throwing here kills the scene.
    const s = st()
    expect(() => s.removeMine(999)).not.toThrow()
    expect(s.removeMine(999)).toBeNull()
    s.addMine(1, 0, 0, 0)
    expect(s.removeMine(1)).toBe('expired')
    expect(s.mines.size).toBe(0)
  })

  it('expires a hazard on its own clock and on demand', () => {
    const s = st()
    s.addHazard(1, 'smoke', 0, 0, 110, 8)
    s.addHazard(2, 'fire', 0, 0, 28, 5)
    s.update(6)
    expect(s.hazards.has(1)).toBe(true)
    expect(s.hazards.has(2)).toBe(false)
    s.removeHazard(1)
    expect(s.hazards.size).toBe(0)
  })

  it('lights fire and toxic, and never smoke or mines', () => {
    // A mine that lit itself up at night would defeat the point of hiding it,
    // and smoke is the opposite of a light.
    const s = st()
    s.addHazard(1, 'smoke', 0, 0, 110, 8)
    s.addMine(5, 0, 10, 10)
    expect(s.lights()).toHaveLength(0)

    s.addHazard(2, 'fire', 50, 60, 28, 5)
    s.addHazard(3, 'toxic', 70, 80, 90, 8)
    const lights = s.lights()
    expect(lights).toHaveLength(2)
    // Fire is the brighter of the two — a burning patch reads at night.
    const fireLight = lights.find((l) => l.x === 50)
    const toxLight = lights.find((l) => l.x === 70)
    expect(fireLight!.a).toBeGreaterThan(toxLight!.a)
  })

  it('puts a flame jet light along the aim, not at the muzzle', () => {
    const s = st()
    s.addJet(0, 0, 0, 150, 0.55)
    const [l] = s.lights()
    expect(l!.x).toBeGreaterThan(0)
    expect(l!.a).toBeGreaterThan(0)
    // ...and it dims as the jet dies.
    s.update(0.06)
    expect(s.lights()[0]!.a).toBeLessThan(l!.a)
  })

  it('makes a mine unmissable close up and invisible far off (§B6)', () => {
    expect(OrdnanceFxState.mineAlpha(0, 40, 300)).toBe(1)
    expect(OrdnanceFxState.mineAlpha(40, 40, 300)).toBe(1)
    expect(OrdnanceFxState.mineAlpha(300, 40, 300)).toBe(0)
    expect(OrdnanceFxState.mineAlpha(500, 40, 300)).toBe(0)
    const mid = OrdnanceFxState.mineAlpha(170, 40, 300)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })

  it('arms a mine at the arm time and not before', () => {
    expect(OrdnanceFxState.isArmed(0.99, 1)).toBe(false)
    expect(OrdnanceFxState.isArmed(1, 1)).toBe(true)
  })
})
