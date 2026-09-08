import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../core'
import {
  consumablePips,
  energyBar,
  healthBar,
  inRefillDelay,
  jetpackBar,
  mix,
} from './bars-math'

// Pinned to the shipped constants (§A19), never to literals.
let BASE = 0
let CAP = 0
let BATT = 0
let FUEL = 0

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
  const c = C()
  BASE = c.BASE_HEALTH
  CAP = c.HEALTH_CAP
  BATT = c.BATTERY_MAX
  FUEL = c.JETPACK_MAX_FUEL
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

  it('draws a poisoned player in a green the healthy bar never uses', () => {
    const healthy = healthBar(BASE, BASE, CAP)
    const sick = healthBar(BASE, BASE, CAP, true)
    // The pair: the poison has to change the colour, or §E13's indicator is a
    // no-op, and it has to change it to something the full-health bar does not
    // already show, or it is invisible on the player it is about.
    expect(sick.colour).not.toBe(healthy.colour)
    expect(sick.colour).toBe('#7cd44a')
    // And it changes nothing else: the fill is still the health.
    expect(sick.fill).toBeCloseTo(healthy.fill, 5)
    expect(sick.label).toBe(healthy.label)
  })

  it('lets low health outrank the poison tint, so green never masks red', () => {
    // The failure this exists for: poisoned at 10 health drawn green inverts the
    // one signal the bar carries. Red wins below half.
    const dying = healthBar(BASE * 0.1, BASE, CAP, true)
    expect(dying.colour).toBe(healthBar(BASE * 0.1, BASE, CAP).colour)
    // The control, one step the other side of the boundary: above half the
    // poison does show, so the rule above is a precedence and not a mute button.
    const hurt = healthBar(BASE * 0.9, BASE, CAP, true)
    expect(hurt.colour).toBe('#7cd44a')
    expect(hurt.colour).not.toBe(healthBar(BASE * 0.9, BASE, CAP).colour)
  })

  it('shows overheal gold even while poisoned', () => {
    // A band, not a ramp position: the poison tint is a colour on the ramp and
    // has nothing to say about a bar that is above `base`.
    expect(healthBar(CAP, BASE, CAP, true).colour).toBe('#ffc93f')
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

// **The `shieldRing` block is gone** (T20.08), and its five assertions with it:
// every one described a 20 s window (`counts down with time`, `is governed by the
// battery once that is the shorter of the two`) and there is no window. A shield
// generator is carried and pays `SHIELD_HIT_COST` per hit, so the remaining
// protection is `floor(battery / cost)` — a count, not a fraction — and the HUD
// shows the battery it is drawn from rather than a second copy of it. The
// behaviour these tests guarded is asserted where it now lives, in
// `player/state.rs`: `a_shield_is_carrying_one_with_charge_and_nothing_else`,
// `a_held_generator_takes_a_quarter_off_each_hit_for_one_energy` and
// `the_reduction_stops_at_zero_charge_and_resumes_after_a_pack`.

describe('mix', () => {
  it('returns the endpoints exactly and clamps outside them', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', -1)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 2)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})

// T20.06 — the consumable pip rows.
describe('consumablePips', () => {
  it('lights one pip per item held and leaves the rest as sockets', () => {
    expect(consumablePips(0, C().MAX_BATTERIES)).toEqual([false, false, false, false])
    expect(consumablePips(1, C().MAX_BATTERIES)).toEqual([true, false, false, false])
    expect(consumablePips(C().MAX_BATTERIES, C().MAX_BATTERIES)).toEqual([true, true, true, true])
  })

  it('is as long as the cap, which is the thing the digit never showed', () => {
    // Pinned to the shipped constants (§A19). `bump` refuses a fifth pack, and
    // the row is the only place a player is told that.
    expect(consumablePips(0, C().MAX_BATTERIES)).toHaveLength(C().MAX_BATTERIES)
    expect(consumablePips(0, C().MAX_HEALS)).toHaveLength(C().MAX_HEALS)
    // The control: the two caps are different, so "as long as the cap" is not
    // satisfied by a row of a fixed length that happens to match one of them.
    expect(C().MAX_HEALS).not.toBe(C().MAX_BATTERIES)
  })

  it('clamps rather than trusting a count off the wire', () => {
    // `heals` and `batteries` are `u8` in the snapshot, and a HUD that grew a
    // row because the server said 9 would push the cluster across the screen.
    expect(consumablePips(99, C().MAX_BATTERIES)).toEqual([true, true, true, true])
    expect(consumablePips(-1, C().MAX_BATTERIES)).toEqual([false, false, false, false])
    expect(consumablePips(1.7, C().MAX_BATTERIES)).toEqual([true, false, false, false])
  })
})
