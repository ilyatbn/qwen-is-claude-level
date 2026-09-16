import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { C, Core } from '../core'
import { beaconCrates, crateBeaconLit } from './minimap-math'

const here = dirname(fileURLToPath(import.meta.url))
let c: ReturnType<typeof C>
beforeAll(async () => {
  await Core.init(readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm')))
  c = C()
})

const lit = (t: number) => crateBeaconLit(t, c.MINIMAP_CRATE_PERIOD, c.MINIMAP_CRATE_ON)

describe('crateBeaconLit (T21.19)', () => {
  it('is lit for MINIMAP_CRATE_ON of every MINIMAP_CRATE_PERIOD, sampled across a whole period', () => {
    // A test that only sampled the on-window could not tell a blink from a marker.
    const steps = 3000
    let on = 0
    for (let i = 0; i < steps; i++) if (lit((i / steps) * c.MINIMAP_CRATE_PERIOD)) on++
    expect(on / steps).toBeCloseTo(c.MINIMAP_CRATE_ON / c.MINIMAP_CRATE_PERIOD, 2)
  })

  it('is off for the rest of the period — the control', () => {
    expect(lit(0)).toBe(true)
    expect(lit(c.MINIMAP_CRATE_ON + (c.MINIMAP_CRATE_PERIOD - c.MINIMAP_CRATE_ON) / 2)).toBe(false)
  })

  it('repeats every period, on the round clock', () => {
    for (let i = 0; i < 50; i++) {
      const t = (i / 50) * c.MINIMAP_CRATE_PERIOD
      expect(lit(t + c.MINIMAP_CRATE_PERIOD * 7)).toBe(lit(t))
    }
  })

  it('is dark rather than lit for a nonsense clock or period', () => {
    expect(lit(Number.NaN)).toBe(false)
    expect(crateBeaconLit(1, 0, c.MINIMAP_CRATE_ON)).toBe(false)
  })
})

describe('beaconCrates (T21.19)', () => {
  const item = (source: string, grounded: boolean) => ({ id: 1, x: 10, y: 20, source, grounded })

  it('beacons a landed crate', () => {
    expect(beaconCrates([item('Crate', true)])).toHaveLength(1)
  })

  it('does not beacon a crate still falling, or an item that is not a crate', () => {
    expect(beaconCrates([item('Crate', false), item('Spawn', true)])).toHaveLength(0)
  })

  it('draws nothing with no items — the control', () => {
    expect(beaconCrates([])).toHaveLength(0)
  })

  it('stops beaconing a crate once it leaves the mirror (picked up)', () => {
    const mirror = new Map([[7, item('Crate', true)]])
    expect(beaconCrates(mirror.values())).toHaveLength(1)
    mirror.delete(7)
    expect(beaconCrates(mirror.values())).toHaveLength(0)
  })
})
