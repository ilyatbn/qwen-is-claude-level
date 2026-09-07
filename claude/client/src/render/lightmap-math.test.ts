import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core, coreDarknessAt, coreFovRadius } from '../core'
import { darknessAt } from './sky-math'
import { fovRadius, lightmapNeeded } from './lightmap-math'

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
})

describe('fovRadius', () => {
  it('is FOV_DAY in daylight, full health, no fog, no flashlight', () => {
    const c = C()
    expect(
      fovRadius({ darkness: 0, fogMult: 1, health: c.BASE_HEALTH, hasFlashlight: false }),
    ).toBeCloseTo(c.FOV_DAY, 4)
  })

  it('is FOV_NIGHT at full darkness', () => {
    const c = C()
    expect(
      fovRadius({
        darkness: c.NIGHT_DARKNESS,
        fogMult: 1,
        health: c.BASE_HEALTH,
        hasFlashlight: false,
      }),
    ).toBeCloseTo(c.FOV_NIGHT, 4)
  })

  it('stacks fog multiplicatively with night', () => {
    const c = C()
    const v = fovRadius({
      darkness: c.NIGHT_DARKNESS,
      fogMult: C().FOV_FOG_MULT,
      health: c.BASE_HEALTH,
      hasFlashlight: false,
    })
    expect(v).toBeCloseTo(c.FOV_NIGHT * c.FOV_FOG_MULT, 4)
    // The worst case the game reaches, restated for §A16's radii: roughly
    // 1.8 player-heights of world, which at CAMERA_ZOOM 2 is about 99 screen px.
    // The doc's original "three player-heights" was written for a 1x camera.
    expect(v).toBeGreaterThan(45)
    expect(v).toBeLessThan(55)
    expect(v * c.CAMERA_ZOOM).toBeGreaterThan(90)
    expect(v * c.CAMERA_ZOOM).toBeLessThan(110)
  })

  it('applies the health multiplier at 0 health and not above BASE_HEALTH', () => {
    const c = C()
    expect(
      fovRadius({ darkness: 0, fogMult: 1, health: 0, hasFlashlight: false }),
    ).toBeCloseTo(c.FOV_DAY * c.FOV_HEALTH_MIN_MULT, 4)
    // Overheal does not buy extra sight — the ratio is clamped at 1.
    expect(
      fovRadius({ darkness: 0, fogMult: 1, health: 150, hasFlashlight: false }),
    ).toBeCloseTo(c.FOV_DAY, 4)
  })

  /**
   * **Replaces "shrinks ambient sight when the flashlight is on"** (T20.07).
   *
   * That test asserted `docs/72` §C13's trade — `on ≈ off × 0.65` — and the
   * coordinator reversed the design: carrying one *widens* the night radius and
   * is passive. The old test is not deleted so much as inverted, and its control
   * is the half that had none.
   */
  it('widens sight at night when a flashlight is carried, and not by day', () => {
    const c = C()
    const at = (darkness: number, hasFlashlight: boolean) =>
      fovRadius({ darkness, fogMult: 1, health: 100, hasFlashlight })

    const nightOff = at(c.NIGHT_DARKNESS, false)
    const nightOn = at(c.NIGHT_DARKNESS, true)
    expect(nightOn).toBeCloseTo(nightOff * c.FLASHLIGHT_FOV_MULT, 4)
    // The direction, separately from the ratio: 0.65 satisfies "on ≈ off × k" as
    // exactly as 1.5 does, and the direction is the whole change.
    expect(nightOn).toBeGreaterThan(nightOff)

    // **The control.** Without it "a flashlight widens the view" is satisfied by
    // one that widens it always, and the gate on `night > 0` would be untested.
    expect(at(0, true)).toBeCloseTo(at(0, false), 4)
  })

  it('is monotonic in darkness', () => {
    const c = C()
    let prev = Infinity
    for (let i = 0; i <= 20; i++) {
      const v = fovRadius({
        darkness: (i / 20) * c.NIGHT_DARKNESS,
        fogMult: 1,
        health: 100,
        hasFlashlight: false,
      })
      expect(v).toBeLessThanOrEqual(prev + 1e-4)
      prev = v
    }
  })
})

describe('lightmapNeeded', () => {
  it('is false in plain daylight, so the whole pass can be skipped', () => {
    expect(lightmapNeeded(0, false)).toBe(false)
  })

  it('is true for any darkness, or for fog in daylight', () => {
    expect(lightmapNeeded(0.01, false)).toBe(true)
    expect(lightmapNeeded(0, true)).toBe(true)
  })
})

/**
 * The TypeScript FoV must agree with the Rust one across the whole input space.
 *
 * Two independent copies of this formula is precisely the drift the shared-core
 * architecture exists to prevent (`docs/01-architecture.md`). The TS copy exists
 * only because calling across the WASM boundary per light per frame would be
 * wasteful — not because the two are allowed to differ.
 */
describe('the TypeScript FoV matches the Rust authority', () => {
  it('agrees across a grid of darkness, fog, health and flashlight', () => {
    const c = C()
    let checked = 0
    for (const darkness of [0, 0.1, 0.4, c.NIGHT_DARKNESS * 0.5, c.NIGHT_DARKNESS]) {
      for (const fogMult of [1, 0.7, c.FOV_FOG_MULT]) {
        for (const health of [0, 1, 37, c.BASE_HEALTH, c.HEALTH_CAP]) {
          for (const hasFlashlight of [false, true]) {
            const ts = fovRadius({ darkness, fogMult, health, hasFlashlight })
            const rs = coreFovRadius(darkness, fogMult, health, hasFlashlight)
            expect(
              Math.abs(ts - rs),
              `darkness=${darkness} fog=${fogMult} health=${health} torch=${hasFlashlight}: ts=${ts} rs=${rs}`,
            ).toBeLessThan(0.01)
            checked++
          }
        }
      }
    }
    expect(checked).toBe(150)
  })

  it('agrees on the darkness curve across the whole cycle', () => {
    for (let u = 0; u < 1; u += 0.005) {
      const ts = darknessAt(u, C().NIGHT_DARKNESS)
      const rs = coreDarknessAt(u)
      expect(Math.abs(ts - rs), `u=${u}: ts=${ts} rs=${rs}`).toBeLessThan(1e-4)
    }
  })
})
