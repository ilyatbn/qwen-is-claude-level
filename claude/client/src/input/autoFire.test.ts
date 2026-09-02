/**
 * §F3 — hold to empty the clip.
 *
 * Every cadence here is pinned to the Rust constant through the parsed registry,
 * never to a literal: a fixture carrying its own copy of `SMG_COOLDOWN` stays
 * green against a drifted implementation (`CLAUDE.md`).
 */

import { describe, expect, it } from 'vitest'
import { MAX_FRAME_DT, RepeatFire, type AutoFireWeapon } from './autoFire'
import { fireProfileByRegistryKey, parseRegistry } from '../render/itemSprites-math'
import { itemRegistryJson } from '../render/__liveRegistry'

/** The live registry, as the client actually receives it. */
const profiles = fireProfileByRegistryKey(parseRegistry(itemRegistryJson()))

const FRAME = 1 / 60

/**
 * Hold for `seconds` at 60 fps; return the repeats **and the time the clock
 * actually saw**.
 *
 * The elapsed time is returned rather than assumed because 60 frames of 1/60
 * sum to 0.9999999999999999, not 1.0 — so a fixture demanding exactly ten shots
 * from "one second" at a 0.1 s cadence is asserting the FPU, not the weapon. The
 * expectation is computed from the same sum the clock accumulated.
 */
function hold(
  weapon: AutoFireWeapon | null,
  seconds: number,
  { hasAmmo = true, held = true } = {},
): { shots: number; elapsed: number } {
  const r = new RepeatFire()
  // The rising edge: the press itself fires through `pointerdown`, not here.
  r.update({ dt: FRAME, held, weapon, hasAmmo })
  let shots = 0
  let elapsed = 0
  for (let t = 0; t < seconds; t += FRAME) {
    shots += r.update({ dt: FRAME, held, weapon, hasAmmo })
    elapsed += FRAME
  }
  return { shots, elapsed }
}

describe('the registry carries the cadence (§F3)', () => {
  it('exposes auto and cooldown for weapons, and for nothing else', () => {
    const smg = profiles.get('smg')
    expect(smg).toBeDefined()
    expect(smg?.auto).toBe(true)
    expect(smg?.cooldown).toBeGreaterThan(0)
    // A medkit is not "not automatic" — it was never asked. Absent, not false.
    expect(profiles.has('medkit')).toBe(false)
    // **What this cannot prove**, stated rather than implied: both sides here
    // read the declared Rust source, so it cannot catch `item_registry_json`
    // failing to *emit* what it declares. The e2e half covers that — it holds a
    // real button in a real client reading the real wire.
  })

  it('the automatic set is exactly smg, machinegun and laser_smg', () => {
    const auto = [...profiles.entries()]
      .filter(([, p]) => p.auto)
      .map(([k]) => k)
      .sort()
    // Asserted against the parsed registry rather than a literal list in this
    // file: if a weapon gains or loses `auto` in `defs.rs`, this is what fails.
    expect(auto).toEqual(['laser_smg', 'machinegun', 'smg'])
  })
})

describe('RepeatFire', () => {
  it('fires a held automatic at its own cooldown, and nothing on the press', () => {
    const smg = profiles.get('smg')!
    // **Held for nine and a half cooldowns, not for "one second".**
    //
    // A whole number of cooldowns is a float boundary, and the clock lands on
    // the wrong side of it: it subtracts `cooldown` repeatedly while the
    // expectation divides once, and the two round differently — 60 frames of
    // 1/60 sum to 0.9999999999999999, so "ten shots in a second at 0.1 s" is a
    // demand that the FPU round the way the fixture guessed. Half a cooldown of
    // margin on either side makes the count the cadence's, not the FPU's, and
    // the number is still pinned to the constant.
    const n = 9
    const { shots } = hold(smg, smg.cooldown * (n + 0.5))
    expect(shots).toBe(n)
    // The press shot is `pointerdown`'s and is deliberately not counted here —
    // if this ever counts it too, the scene is double-firing.
  })

  it('fires nothing extra for a NON-automatic weapon, however long it is held', () => {
    const pistol = profiles.get('pistol')!
    expect(pistol.auto).toBe(false)
    // The control for the test above. A pistol held for a second is one shot —
    // the press — and this counts the repeats, so zero.
    expect(hold(pistol, 1.0).shots).toBe(0)
  })

  it('a faster weapon fires more than a slower one over the same hold', () => {
    const smg = profiles.get('smg')!
    const machinegun = profiles.get('machinegun')!
    // Ordering, not magnitudes: it would survive both constants moving, and it
    // fails if the clock ignores `cooldown` and uses one rate for everything —
    // which "10 shots in a second" alone would not catch.
    expect(machinegun.cooldown).toBeLessThan(smg.cooldown)
    expect(hold(machinegun, 1.0).shots).toBeGreaterThan(hold(smg, 1.0).shots)
  })

  it('stops the moment the button is released', () => {
    const smg = profiles.get('smg')!
    const r = new RepeatFire()
    r.update({ dt: FRAME, held: true, weapon: smg, hasAmmo: true })
    for (let t = 0; t < 0.5; t += FRAME) r.update({ dt: FRAME, held: true, weapon: smg, hasAmmo: true })
    // Released, then held down again by nothing — a full second of not holding.
    let after = 0
    for (let t = 0; t < 1.0; t += FRAME) {
      after += r.update({ dt: FRAME, held: false, weapon: smg, hasAmmo: true })
    }
    expect(after).toBe(0)
  })

  it('tapping cannot out-shoot the weapon: a press resets the cadence', () => {
    const smg = profiles.get('smg')!
    const r = new RepeatFire()
    // Ten taps, each holding most of a cooldown and then releasing. Banked, that
    // is nine cooldowns of credit and a burst on the next press; reset, it is
    // nothing. The first version of this test released and pressed **once** and
    // was vacuous — the rising edge zeroes the clock either way, so it passed
    // with the rule deleted. Repeating the tap is what makes the banked credit
    // large enough to be visible if it survives.
    let shots = 0
    for (let tap = 0; tap < 10; tap++) {
      r.update({ dt: FRAME, held: true, weapon: smg, hasAmmo: true })
      for (let t = 0; t < smg.cooldown * 0.9; t += FRAME) {
        shots += r.update({ dt: FRAME, held: true, weapon: smg, hasAmmo: true })
      }
      r.update({ dt: FRAME, held: false, weapon: smg, hasAmmo: true })
    }
    expect(shots).toBe(0)
  })

  it('stops on an empty stack', () => {
    const smg = profiles.get('smg')!
    expect(hold(smg, 1.0, { hasAmmo: false }).shots).toBe(0)
    // Control: the same hold with ammo does fire, so this is not a test that
    // passes because nothing ever fires.
    expect(hold(smg, 1.0, { hasAmmo: true }).shots).toBeGreaterThan(0)
  })

  it('fires nothing while the button is not held — the right-button case', () => {
    const smg = profiles.get('smg')!
    // §F4.1: right-click opens the backpack. The scene passes `leftButtonDown()`,
    // so a held right button arrives here as `held: false` and must produce
    // nothing at any cadence. This is the unit form of "holding the right button
    // fires nothing".
    expect(hold(smg, 2.0, { held: false }).shots).toBe(0)
  })

  it('owes the shots a long frame skipped rather than dropping them', () => {
    const smg = profiles.get('smg')!
    const r = new RepeatFire()
    r.update({ dt: FRAME, held: true, weapon: smg, hasAmmo: true })
    // One long frame — a tab that stalled. A laggy client must not fire slower
    // than a smooth one at the same weapon. Sized at five and a half cooldowns
    // for the same boundary reason as above.
    const shots = r.update({ dt: smg.cooldown * 5.5, held: true, weapon: smg, hasAmmo: true })
    expect(shots).toBe(5)
  })

  describe('a blocked hold banks nothing (the refused-request flood)', () => {
    // Hold for `seconds` while blocked, then unblock **without releasing**, and
    // return the shots produced in that single frame.
    const burstAfterBlockedHold = (
      blockedAs: { weapon: AutoFireWeapon | null; hasAmmo: boolean },
      seconds = 3.0,
    ): number => {
      const smg = profiles.get('smg')!
      const r = new RepeatFire()
      r.update({ dt: FRAME, held: true, ...blockedAs })
      for (let t = 0; t < seconds; t += FRAME) {
        r.update({ dt: FRAME, held: true, ...blockedAs })
      }
      // The block lifts mid-hold: ammo picked up, or an automatic selected.
      return r.update({ dt: FRAME, held: true, weapon: smg, hasAmmo: true })
    }

    // Three ways to be blocked, all reachable in ordinary play. The measured
    // burst before the clamp was 29 shots in one frame on every one of them.
    it('an empty stack banks nothing — hold on a spent smg, walk over ammo', () => {
      expect(burstAfterBlockedHold({ weapon: profiles.get('smg')!, hasAmmo: false })).toBeLessThanOrEqual(1)
    })
    it('a non-automatic weapon banks nothing — hold on a pistol, switch to the smg', () => {
      expect(burstAfterBlockedHold({ weapon: profiles.get('laser_pistol')!, hasAmmo: true })).toBeLessThanOrEqual(1)
    })
    it('no weapon selected banks nothing', () => {
      expect(burstAfterBlockedHold({ weapon: null, hasAmmo: true })).toBeLessThanOrEqual(1)
    })

    it('and the clock still runs: an unblocked switch does not wait a full cooldown', () => {
      // The control for the three above. Zeroing `since` while blocked would
      // pass them all and silently cost the responsiveness the running clock is
      // for — so this asserts the clamp kept it. Blocked for most of a cooldown
      // on a weapon whose cadence we know, then unblocked: the shot is due.
      const smg = profiles.get('smg')!
      const pistol = profiles.get('laser_pistol')!
      const r = new RepeatFire()
      r.update({ dt: FRAME, held: true, weapon: pistol, hasAmmo: true })
      for (let t = 0; t < smg.cooldown * 1.5; t += FRAME) {
        r.update({ dt: FRAME, held: true, weapon: pistol, hasAmmo: true })
      }
      expect(r.update({ dt: FRAME, held: true, weapon: smg, hasAmmo: true })).toBe(1)
    })
  })

  it('a single enormous frame cannot discharge a backgrounded tab', () => {
    const smg = profiles.get('smg')!
    const r = new RepeatFire()
    r.update({ dt: FRAME, held: true, weapon: smg, hasAmmo: true })
    // Ten seconds in one frame: a tab that was backgrounded and refocused.
    //
    // The clock itself is honest here — those shots *were* earned by elapsed
    // time — so this is not a bug in `RepeatFire`, and the fix is not in it. The
    // scene clamps `dt` to the same ceiling its fixed-timestep accumulator uses
    // before calling in, because ten seconds of wall clock is not ten seconds of
    // game the player was holding the button through. This asserts what arrives
    // *after* that clamp, which is the contract the scene has to keep.
    //
    // **What this cannot catch, said plainly:** the clamp itself lives in
    // `GameScene`, which vitest cannot load — there is no canvas — so deleting
    // `Math.min(dt, MAX_FRAME_DT)` at the call site leaves every test here
    // green. This is the description of the contract, not proof it is honoured.
    //
    // What it *does* pin is the number. `MAX_FRAME_DT` is imported from the
    // module the scene imports it from, so the ceiling fed in here and the bound
    // asserted against are the scene's own; an earlier version declared a local
    // `0.25` and was therefore self-consistent whatever the scene did, which is
    // a test agreeing with itself.
    const shots = r.update({ dt: Math.min(10.0, MAX_FRAME_DT), held: true, weapon: smg, hasAmmo: true })
    expect(shots).toBeLessThanOrEqual(Math.ceil(MAX_FRAME_DT / smg.cooldown) + 1)
    // And the unclamped number, recorded so the size of what the clamp prevents
    // is visible: ~100 calls in one frame.
    const unclamped = new RepeatFire()
    unclamped.update({ dt: FRAME, held: true, weapon: smg, hasAmmo: true })
    expect(unclamped.update({ dt: 10.0, held: true, weapon: smg, hasAmmo: true })).toBeGreaterThan(50)
  })

  it('never spins on a zero cooldown', () => {
    // No such weapon exists in the registry; this is the guard that keeps a
    // future one from being an infinite loop wearing a weapon's clothes.
    expect(hold({ auto: true, cooldown: 0 }, 1.0).shots).toBe(0)
  })

  it('fires nothing when no weapon is selected', () => {
    expect(hold(null, 1.0).shots).toBe(0)
  })
})
