import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../core'
import { fovRadius, lightmapNeeded } from './lightmap-math'

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
})

describe('fovRadius', () => {
  it('is FOV_DAY in daylight, full health, no fog, no flashlight', () => {
    const c = C()
    expect(
      fovRadius({ darkness: 0, fogActive: false, health: c.BASE_HEALTH, flashlightOn: false }),
    ).toBeCloseTo(c.FOV_DAY, 4)
  })

  it('is FOV_NIGHT at full darkness', () => {
    const c = C()
    expect(
      fovRadius({
        darkness: c.NIGHT_DARKNESS,
        fogActive: false,
        health: c.BASE_HEALTH,
        flashlightOn: false,
      }),
    ).toBeCloseTo(c.FOV_NIGHT, 4)
  })

  it('stacks fog multiplicatively with night', () => {
    const c = C()
    const v = fovRadius({
      darkness: c.NIGHT_DARKNESS,
      fogActive: true,
      health: c.BASE_HEALTH,
      flashlightOn: false,
    })
    expect(v).toBeCloseTo(c.FOV_NIGHT * c.FOV_FOG_MULT, 4)
    // The doc's own worst case: a foggy night is about three player-heights.
    expect(v).toBeGreaterThan(90)
    expect(v).toBeLessThan(110)
  })

  it('applies the health multiplier at 0 health and not above BASE_HEALTH', () => {
    const c = C()
    expect(
      fovRadius({ darkness: 0, fogActive: false, health: 0, flashlightOn: false }),
    ).toBeCloseTo(c.FOV_DAY * c.FOV_HEALTH_MIN_MULT, 4)
    // Overheal does not buy extra sight — the ratio is clamped at 1.
    expect(
      fovRadius({ darkness: 0, fogActive: false, health: 150, flashlightOn: false }),
    ).toBeCloseTo(c.FOV_DAY, 4)
  })

  it('shrinks ambient sight when the flashlight is on', () => {
    const c = C()
    const off = fovRadius({ darkness: 0, fogActive: false, health: 100, flashlightOn: false })
    const on = fovRadius({ darkness: 0, fogActive: false, health: 100, flashlightOn: true })
    // It is a trade for the cone, not an upgrade.
    expect(on).toBeCloseTo(off * c.FLASHLIGHT_AMBIENT_MULT, 4)
    expect(on).toBeLessThan(off)
  })

  it('is monotonic in darkness', () => {
    const c = C()
    let prev = Infinity
    for (let i = 0; i <= 20; i++) {
      const v = fovRadius({
        darkness: (i / 20) * c.NIGHT_DARKNESS,
        fogActive: false,
        health: 100,
        flashlightOn: false,
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
