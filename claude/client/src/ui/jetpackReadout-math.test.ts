import { describe, expect, it } from 'vitest'
import { fuelText, fuelTrend } from './jetpackReadout-math'

// Pinned to the constants the simulation uses, not to literals: a fixture
// carrying its own 5.0 stays green against an implementation that has drifted
// (§A19). These mirror `constants.rs`.
const MAX_FUEL = 5.0
const REFILL = 0.5
const SIM_DT = 1 / 60

describe('fuelText', () => {
  it('shows one decimal, because that is what makes the curve legible', () => {
    expect(fuelText(4.25, MAX_FUEL)).toBe('4.3')
    expect(fuelText(0.05, MAX_FUEL)).toBe('0.1')
    // The case the readout exists for: 0.5 s into a refill the tank holds a
    // hundredth of a unit. Rounded to whole units this reads `0` and looks
    // identical to the stall during REFILL_DELAY.
    expect(fuelText(0.008, MAX_FUEL)).toBe('0.0')
    expect(fuelText(0.06, MAX_FUEL)).toBe('0.1')
  })

  it('clamps both ends', () => {
    // The wire carries fuel as a byte, so a dequantised 255 can land a hair over.
    expect(fuelText(MAX_FUEL + 0.02, MAX_FUEL)).toBe('5.0')
    expect(fuelText(-0.3, MAX_FUEL)).toBe('0.0')
    expect(fuelText(NaN, MAX_FUEL)).toBe('0.0')
  })
})

describe('fuelTrend', () => {
  it('names the three states of the measured curve', () => {
    // Draining at JETPACK_DRAIN (1.0/s) is one tick of -0.0167.
    expect(fuelTrend(3.0, 3.0 - 1.0 * SIM_DT, REFILL, SIM_DT)).toBe('draining')
    // Refilling at JETPACK_REFILL (0.5/s) is one tick of +0.0083.
    expect(fuelTrend(3.0, 3.0 + REFILL * SIM_DT, REFILL, SIM_DT)).toBe('refilling')
    // The measured flat half-second while REFILL_DELAY elapses — the part of
    // the curve that reads as "broken" on a bar and is the reason for the
    // readout.
    expect(fuelTrend(3.0, 3.0, REFILL, SIM_DT)).toBe('held')
  })

  it('does not report float noise as motion', () => {
    // The control for `held`. Without a dead band, two identical snapshots that
    // differ in the last bit would flicker between refilling and draining, and
    // the readout would claim the tank moves while it is waiting out the delay.
    expect(fuelTrend(3.0, 3.0 + 1e-7, REFILL, SIM_DT)).toBe('held')
    expect(fuelTrend(3.0, 3.0 - 1e-7, REFILL, SIM_DT)).toBe('held')
  })

  it('is derived from two samples rather than a flag', () => {
    // Same current value, different previous: the answer must change. A trend
    // read off a stored flag would give the same answer for both.
    expect(fuelTrend(2.0, 2.5, REFILL, SIM_DT)).toBe('refilling')
    expect(fuelTrend(3.0, 2.5, REFILL, SIM_DT)).toBe('draining')
  })
})
