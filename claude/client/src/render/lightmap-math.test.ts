import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core, coreDarknessAt, coreFovRadius } from '../core'
import { darknessAt } from './sky-math'
import { FLASH_DECAY, collectLightSources, fovRadius, lightmapNeeded } from './lightmap-math'
import type { PlayerLight, WorldLights } from './lightmap-math'

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

// ---------------------------------------------------------------------------
// collectLightSources (T5.07)
// ---------------------------------------------------------------------------

describe('collectLightSources', () => {
  const player = (over: Partial<PlayerLight> = {}): PlayerLight => ({
    x: 100,
    y: 200,
    health: 100,
    hasFlashlight: false,
    aim: 0,
    ...over,
  })
  const world = (over: Partial<WorldLights> = {}): WorldLights => ({
    localPlayer: player(),
    remotePlayers: [],
    explosions: [],
    hazards: [],
    darkness: 0.82,
    fogMult: 1,
    ...over,
  })

  it('does no work in full daylight', () => {
    expect(collectLightSources(world({ darkness: 0 }))).toEqual([])
  })

  it('gives the local player one radial source at night', () => {
    const ls = collectLightSources(world())
    expect(ls).toHaveLength(1)
    expect(ls[0]!.kind).toBe('radial')
    expect(ls[0]!.x).toBe(100)
    expect(ls[0]!.radius).toBeCloseTo(
      fovRadius({ darkness: 0.82, fogMult: 1, health: 100, hasFlashlight: false }),
      3,
    )
  })

  it('adds a cone at the aim angle when one is carried', () => {
    const ls = collectLightSources(
      world({ localPlayer: player({ hasFlashlight: true, aim: 1.25 }) }),
    )
    const cone = ls.find((l) => l.kind === 'cone')
    expect(cone).toBeDefined()
    expect(cone!.angle).toBe(1.25)
    expect(cone!.coneDeg).toBe(C().FLASHLIGHT_CONE_DEG)
    expect(cone!.radius).toBeCloseTo(C().FLASHLIGHT_RANGE, 3)
  })

  it('widens the ambient radius when one is carried — no longer a trade', () => {
    // The `world()` fixture is at darkness 0.82, i.e. night, which is where the
    // multiplier applies (T20.07).
    const off = collectLightSources(world())[0]!.radius
    const on = collectLightSources(
      world({ localPlayer: player({ hasFlashlight: true }) }),
    ).find((l) => l.kind === 'radial')!.radius
    expect(on).toBeCloseTo(off * C().FLASHLIGHT_FOV_MULT, 3)
    expect(on).toBeGreaterThan(off)
  })

  it('draws a remote player’s cone', () => {
    // Omitting this silently removes the reason a flashlight is a decision: it
    // is meant to be a beacon that gets you seen first.
    const ls = collectLightSources(
      world({ remotePlayers: [{ x: 700, y: 300, hasFlashlight: true, aim: -0.5 }] }),
    )
    const cones = ls.filter((l) => l.kind === 'cone')
    expect(cones).toHaveLength(1)
    expect(cones[0]!.x).toBe(700)
    expect(cones[0]!.angle).toBe(-0.5)
  })

  it('ignores a remote player without one', () => {
    const ls = collectLightSources(
      world({ remotePlayers: [{ x: 700, y: 300, hasFlashlight: false, aim: 0 }] }),
    )
    expect(ls.filter((l) => l.kind === 'cone')).toHaveLength(0)
  })

  it('decays an explosion flash to nothing over FLASH_DECAY', () => {
    const at = (age: number) =>
      collectLightSources(world({ explosions: [{ x: 0, y: 0, age }] })).filter(
        (l) => l.x === 0 && l.y === 0,
      )
    expect(at(0)[0]!.intensity).toBeCloseTo(1, 3)
    expect(at(FLASH_DECAY / 2)[0]!.intensity).toBeCloseTo(0.5, 3)
    expect(at(FLASH_DECAY)).toHaveLength(0)
    expect(at(FLASH_DECAY + 1)).toHaveLength(0)
  })

  it('lights lava, burning ground and meteors while they are active', () => {
    const ls = collectLightSources(
      world({
        hazards: [
          { x: 1, y: 1, kind: 'lava' },
          { x: 2, y: 2, kind: 'burn' },
          { x: 3, y: 3, kind: 'meteor' },
        ],
      }),
    )
    expect(ls).toHaveLength(4) // the player plus three hazards
    expect(ls.filter((l) => l.intensity === 0.85)).toHaveLength(3)
  })

  it('shrinks every radius in fog', () => {
    const clear = collectLightSources(
      world({ localPlayer: player({ hasFlashlight: true }), hazards: [{ x: 1, y: 1, kind: 'lava' }] }),
    )
    const foggy = collectLightSources(
      world({
        localPlayer: player({ hasFlashlight: true }),
        hazards: [{ x: 1, y: 1, kind: 'lava' }],
        fogMult: C().FOV_FOG_MULT,
      }),
    )
    expect(foggy).toHaveLength(clear.length)
    for (let i = 0; i < clear.length; i++) {
      expect(foggy[i]!.radius).toBeLessThan(clear[i]!.radius)
    }
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
