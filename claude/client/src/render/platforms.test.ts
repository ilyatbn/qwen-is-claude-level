import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Core, C, MapScale } from '../core'
import { PlatformLayer, ensurePlatformTexture, type PlatformView } from './platforms'

const here = dirname(fileURLToPath(import.meta.url))
const wasmBytes = readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm'))

/**
 * A Phaser stand-in.
 *
 * `vitest` runs with `environment: 'node'`, so there is no canvas and no Phaser.
 * What is worth testing here is the **bookkeeping** — one sprite per platform,
 * idempotent rebuilds, removal of a platform that left the list — and none of it
 * needs a real texture. `ensurePlatformTexture` returning early on a null
 * context is the same path a headless build takes, which is why the layer is
 * written to tolerate it.
 *
 * The picture itself is asserted where a picture has to be asserted — on sampled
 * pixels, in `scripts/checks/platforms.mjs` (`docs/72` §C2).
 */
function fakeScene() {
  const added: unknown[] = []
  const destroyed: unknown[] = []
  const container = {
    add: (o: unknown) => added.push(o),
    setDepth: () => container,
    destroy: () => destroyed.push(container),
  }
  const rect = () => {
    const o = {
      setOrigin: () => o,
      setVisible: (v: boolean) => {
        o.visible = v
        return o
      },
      setPosition: () => o,
      destroy: () => destroyed.push(o),
      visible: false,
    }
    return o
  }
  const image = () => {
    const o = {
      setOrigin: () => o,
      setPosition: (x: number, y: number) => {
        o.x = x
        o.y = y
        return o
      },
      destroy: () => destroyed.push(o),
      x: 0,
      y: 0,
    }
    return o
  }
  return {
    destroyed,
    added,
    scene: {
      add: {
        container: () => container,
        image: (x: number, y: number) => {
          const o = image()
          o.x = x
          o.y = y
          return o
        },
        rectangle: () => rect(),
      },
      // No canvas in node: `createCanvas` answers null and the builder returns
      // its size without painting, which is the documented degraded path.
      textures: { exists: () => false, createCanvas: () => null },
    } as unknown as Phaser.Scene,
  }
}

describe('PlatformLayer (T21.11A)', () => {
  let core: Core

  beforeAll(async () => {
    core = await Core.init(wasmBytes)
  })

  const views = (n: number): PlatformView[] =>
    Array.from({ length: n }, (_, i) => ({ id: i, x: 100 + i * 200, y: 400 }))

  it('draws one sprite per platform', () => {
    const { scene } = fakeScene()
    const layer = new PlatformLayer(scene)
    layer.build(views(C().GUN_PLATFORMS))
    expect(layer.count).toBe(C().GUN_PLATFORMS)
    expect(layer.ids).toEqual([...Array(C().GUN_PLATFORMS).keys()])
  })

  it('is idempotent — a resync does not stack two turrets on one platform', () => {
    const { scene } = fakeScene()
    const layer = new PlatformLayer(scene)
    const v = views(3)
    layer.build(v)
    layer.build(v)
    expect(layer.count).toBe(3)
  })

  it('drops a platform that left the list, and keeps the ones that stayed', () => {
    const { scene } = fakeScene()
    const layer = new PlatformLayer(scene)
    layer.build(views(3))
    layer.build(views(3).slice(0, 2))
    expect(layer.ids).toEqual([0, 1])
    // The control: it really did hold three first, so "two" is a removal and
    // not a build that never worked.
    const again = new PlatformLayer(fakeScene().scene)
    again.build(views(3))
    expect(again.count).toBe(3)
  })

  it('lights only the platforms it is told are occupied', () => {
    const { scene } = fakeScene()
    const layer = new PlatformLayer(scene)
    layer.build(views(3))
    // Nothing lit to start with — a lamp on by default would make the
    // "occupied" assertion below true of an empty platform too.
    layer.setOccupied([])
    expect(layer.lampsLit()).toEqual([])
    layer.setOccupied([1])
    expect(layer.lampsLit()).toEqual([1])
    // And it is the whole set each frame, not a delta: telling it about a
    // different rider turns the first lamp off.
    layer.setOccupied([2])
    expect(layer.lampsLit()).toEqual([2])
    layer.setOccupied([])
    expect(layer.lampsLit()).toEqual([])
  })

  it('sizes the art from the footprint, so the picture cannot drift from the rock', () => {
    const art = ensurePlatformTexture({
      exists: () => false,
      createCanvas: () => null,
    } as unknown as Phaser.Textures.TextureManager)
    expect(art.w).toBe(Math.round(C().GUN_PLATFORM_W))
    // And it is taller than it is deep: the turret stands above the ground it
    // is bolted to, and `GUN_PLATFORM_H` is the rock, not the machine.
    expect(art.h).toBeGreaterThan(C().GUN_PLATFORM_H)
  })

  it('a generated map puts every platform somewhere the layer can draw', () => {
    core.generate(4242n, MapScale.Medium)
    const plats = core.meta.gun_platforms
    expect(plats.length).toBe(C().GUN_PLATFORMS)
    const { scene } = fakeScene()
    const layer = new PlatformLayer(scene)
    layer.build(plats.map((g) => ({ id: g.id, x: g.pos.x, y: g.pos.y })))
    // Counted at both ends: what the core holds against what got drawn.
    expect(layer.count).toBe(plats.length)
  })
})
