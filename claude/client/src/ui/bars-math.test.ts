import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../core'
import { energyBar, healthBar, inRefillDelay, jetpackBar, mix, shieldRing } from './bars-math'

// Pinned to the shipped constants (§A19), never to literals.
let BASE = 0
let CAP = 0
let BATT = 0
let FUEL = 0
let DUR = 0
let DRAIN = 0

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
  const c = C()
  BASE = c.BASE_HEALTH
  CAP = c.HEALTH_CAP
  BATT = c.BATTERY_MAX
  FUEL = c.JETPACK_MAX_FUEL
  DUR = c.SHIELD_DURATION
  DRAIN = c.SHIELD_DRAIN
})

describe('healthBar', () => {
  it('tracks the snapshot across the range, including both endpoints', () => {
    expect(healthBar(0, BASE, CAP).fill).toBe(0)
    expect(healthBar(BASE / 2, BASE, CAP).fill).toBeCloseTo(BASE / 2 / CAP, 5)
    expect(healthBar(BASE, BASE, CAP).fill).toBeCloseTo(BASE / CAP, 5)
    expect(healthBar(CAP, BASE, CAP).fill).toBeCloseTo(BASE / CAP, 5)
  })

  it('shows overheal as its own band rather than a fill above 1', () => {
    const full = healthBar(BASE, BASE, CAP)
    const over = healthBar(CAP, BASE, CAP)
    expect(full.over).toBe(0)
    expect(over.over).toBeCloseTo((CAP - BASE) / CAP, 5)
    // The one thing the player has to be able to tell apart.
    expect(over.colour).not.toBe(full.colour)
    expect(over.label).toBe(String(CAP))
    // ...and the two together never exceed the track.
    expect(over.fill + over.over).toBeCloseTo(1, 5)
  })

  it('runs red at nothing and green at full', () => {
    expect(healthBar(0, BASE, CAP).colour).toBe('#e0342b')
    expect(healthBar(BASE, BASE, CAP).colour).toBe('#3ec75a')
    // ...and something in between at half, which is what "red→green" means.
    const half = healthBar(BASE / 2, BASE, CAP).colour
    expect(half).not.toBe('#e0342b')
    expect(half).not.toBe('#3ec75a')
  })

  it('clamps rather than drawing past either end', () => {
    expect(healthBar(-40, BASE, CAP).fill).toBe(0)
    expect(healthBar(CAP * 4, BASE, CAP).over).toBeCloseTo((CAP - BASE) / CAP, 5)
  })
})

describe('energyBar', () => {
  it('tracks the battery across the range, including both endpoints', () => {
    expect(energyBar(0, BATT).fill).toBe(0)
    expect(energyBar(BATT / 2, BATT).fill).toBeCloseTo(0.5, 5)
    expect(energyBar(BATT, BATT).fill).toBe(1)
    expect(energyBar(BATT * 2, BATT).fill).toBe(1)
  })
})

describe('jetpackBar', () => {
  it('tracks fuel across the range, including both endpoints', () => {
    expect(jetpackBar(0, FUEL, false).fill).toBe(0)
    expect(jetpackBar(FUEL, FUEL, false).fill).toBe(1)
    expect(jetpackBar(FUEL / 2, FUEL, false).label).toBe((FUEL / 2).toFixed(1))
  })

  it('looks different while the refill delay is running', () => {
    const waiting = jetpackBar(1, FUEL, true)
    const rising = jetpackBar(1, FUEL, false)
    expect(waiting.colour).not.toBe(rising.colour)
    // ...and the *fill* is the same, so what changed is the state and not the
    // number: a bar that also moved would be indistinguishable from refilling.
    expect(waiting.fill).toBe(rising.fill)
  })
})

describe('inRefillDelay', () => {
  it('is on when a part-full tank is not rising, and off once it does', () => {
    expect(inRefillDelay(2.0, 2.0, FUEL, false)).toBe(true)
    expect(inRefillDelay(2.0, 2.1, FUEL, false)).toBe(false)
  })

  /** The controls: neither a full tank nor an active jetpack is waiting. */
  it('is off while jetting and off at full', () => {
    expect(inRefillDelay(2.0, 1.9, FUEL, true)).toBe(false)
    expect(inRefillDelay(FUEL, FUEL, FUEL, false)).toBe(false)
  })
})

describe('shieldRing', () => {
  it('is absent with no shield', () => {
    expect(shieldRing(false, 0, 5, DUR, BATT, DRAIN)).toBeNull()
  })

  it('counts down with time while the battery is deep', () => {
    expect(shieldRing(true, 0, 0, DUR, BATT, DRAIN)).toBeCloseTo(1, 5)
    expect(shieldRing(true, 0, DUR / 2, DUR, BATT, DRAIN)).toBeCloseTo(0.5, 5)
    expect(shieldRing(true, 0, DUR, DUR, BATT, DRAIN)).toBe(0)
  })

  /**
   * §B5's payoff: a flat battery ends the shield before its timer does. Without
   * this the ring would promise time the player does not have.
   */
  it('is governed by the battery once that is the shorter of the two', () => {
    // Enough battery for a quarter of the duration.
    const thin = (DUR / 4) * DRAIN
    expect(shieldRing(true, 0, 0, DUR, thin, DRAIN)).toBeCloseTo(0.25, 5)
    // ...and an empty battery is no shield at all, whatever the timer says.
    expect(shieldRing(true, 0, 0, DUR, 0, DRAIN)).toBe(0)
  })
})

describe('mix', () => {
  it('returns the endpoints exactly and clamps outside them', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', -1)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 2)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})
