import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Core, MapScale, C } from '../core'
import {
  TerrainRenderer,
  caveBackdropDefault,
  setCaveBackdropDefault,
  type ImageHost,
  type TextureHost,
} from './terrain'

const here = dirname(fileURLToPath(import.meta.url))
const wasmBytes = readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm'))

/** Records every texture created and removed, so leaks are assertable. */
class FakeTextures implements TextureHost {
  readonly created: string[] = []
  readonly removed: string[] = []
  private readonly live = new Set<string>()

  exists(key: string): boolean {
    return this.live.has(key)
  }

  addCanvas(key: string): Phaser.Textures.CanvasTexture | null {
    this.created.push(key)
    this.live.add(key)
    return { key } as unknown as Phaser.Textures.CanvasTexture
  }

  remove(key: string): void {
    this.removed.push(key)
    this.live.delete(key)
  }

  get liveCount(): number {
    return this.live.size
  }
}

class FakeImages implements ImageHost {
  readonly added: Array<{ x: number; y: number; key: string }> = []
  destroyed = 0

  add(x: number, y: number, key: string) {
    this.added.push({ x, y, key })
    const self = this
    return {
      setOrigin: () => undefined,
      destroy: () => {
        self.destroyed++
      },
    }
  }
}

/** Build a renderer whose canvas and bake are stubs. */
function makeRenderer(core: Core, back: CanvasImageSource | null = null) {
  const textures = new FakeTextures()
  const images = new FakeImages()
  const baked: Array<[number, number]> = []
  const renderer = new TerrainRenderer(
    textures,
    images,
    core,
    null,
    null,
    {
      createCanvas: () => ({}) as HTMLCanvasElement,
      bake: (_t, cx, cy) => {
        baked.push([cx, cy])
      },
    },
    back,
  )
  return { renderer, textures, images, baked }
}

describe('TerrainRenderer', () => {
  let core: Core

  beforeAll(async () => {
    core = await Core.init(wasmBytes)
  })

  it('creates one texture per chunk at every scale', () => {
    for (const [scale, cx, cy] of [
      [MapScale.Small, 8, 4],
      [MapScale.Medium, 12, 6],
      [MapScale.Large, 16, 8],
    ] as const) {
      core.generate(4242n, scale)
      const { renderer, textures, images } = makeRenderer(core)
      renderer.buildAll()
      expect(textures.created.length).toBe(cx * cy)
      expect(images.added.length).toBe(cx * cy)
      expect(renderer.stats.chunkCount).toBe(cx * cy)
      renderer.destroy()
    }
  })

  it('places each chunk image at its world position', () => {
    core.generate(1n, MapScale.Small)
    const { renderer, images } = makeRenderer(core)
    renderer.buildAll()
    const size = C().CHUNK_SIZE
    // Chunk (3, 2) sits at world (768, 512).
    expect(images.added).toContainEqual(
      expect.objectContaining({ x: 3 * size, y: 2 * size }),
    )
    renderer.destroy()
  })

  it('uses unique texture keys across two builds, so a regenerate cannot reuse pixels', () => {
    core.generate(1n, MapScale.Small)
    const a = makeRenderer(core)
    a.renderer.buildAll()
    const b = makeRenderer(core)
    b.renderer.buildAll()

    const overlap = a.textures.created.filter((k) => b.textures.created.includes(k))
    expect(overlap).toEqual([])
    a.renderer.destroy()
    b.renderer.destroy()
  })

  it('destroy removes every texture it created and every image', () => {
    core.generate(1n, MapScale.Small)
    const { renderer, textures, images } = makeRenderer(core)
    renderer.buildAll()
    const created = textures.created.length
    renderer.destroy()

    expect(textures.removed.length).toBe(created)
    expect(textures.liveCount).toBe(0)
    expect(images.destroyed).toBe(created)
    expect(renderer.stats.chunkCount).toBe(0)
  })

  it('collapses duplicate dirty ids', () => {
    core.generate(1n, MapScale.Small)
    const { renderer } = makeRenderer(core)
    renderer.buildAll()
    renderer.markDirty([5, 5, 5, 7])
    expect(renderer.stats.pending).toBe(2)
    renderer.destroy()
  })

  it('ignores out-of-range chunk ids rather than throwing', () => {
    core.generate(1n, MapScale.Small)
    const { renderer } = makeRenderer(core)
    renderer.buildAll()
    const max = renderer.chunksX * renderer.chunksY
    expect(() => renderer.markDirty([-1, max, max + 1000, 999999])).not.toThrow()
    expect(renderer.stats.pending).toBe(0)
    renderer.destroy()
  })

  it('bakes at most CHUNK_REBAKE_BUDGET per update and drains over several frames', () => {
    core.generate(1n, MapScale.Small)
    const { renderer, baked } = makeRenderer(core)
    renderer.buildAll()
    baked.length = 0

    const ids = Array.from({ length: 20 }, (_, i) => i)
    renderer.markDirty(ids)
    expect(renderer.stats.pending).toBe(20)

    const budget = C().CHUNK_REBAKE_BUDGET
    renderer.update({ x: 0, y: 0 })
    expect(renderer.stats.bakesThisFrame).toBe(budget)
    expect(renderer.stats.pending).toBe(20 - budget)

    for (let i = 0; i < 4; i++) renderer.update({ x: 0, y: 0 })
    expect(renderer.stats.pending).toBe(0)
    expect(baked.length).toBe(20)
    renderer.destroy()
  })

  it('bakes nearest the camera first', () => {
    core.generate(1n, MapScale.Small)
    const { renderer, baked } = makeRenderer(core)
    renderer.buildAll()
    baked.length = 0

    const size = C().CHUNK_SIZE
    const chunksX = renderer.chunksX
    // Chunk 0 is top-left; chunk (5,3) is far away. Put the camera on chunk 5,3.
    const near = 3 * chunksX + 5
    renderer.markDirty([0, 1, near])

    renderer.update({ x: 5 * size + size / 2, y: 3 * size + size / 2 })
    expect(baked[0]).toEqual([5, 3])
    renderer.destroy()
  })

  it('update with nothing pending does no work', () => {
    core.generate(1n, MapScale.Small)
    const { renderer, baked } = makeRenderer(core)
    renderer.buildAll()
    baked.length = 0
    renderer.update({ x: 0, y: 0 })
    expect(renderer.stats.bakesThisFrame).toBe(0)
    expect(baked.length).toBe(0)
    renderer.destroy()
  })

  it('marks the chunks a real carve dirties', () => {
    core.generate(4242n, MapScale.Small)
    const { renderer } = makeRenderer(core)
    renderer.buildAll()
    core.takeDirtyChunks()

    core.carve(Math.floor(core.width / 2), core.height - 60, 40)
    const dirty = core.takeDirtyChunks()
    expect(dirty.length).toBeGreaterThan(0)

    renderer.markDirty(dirty)
    expect(renderer.stats.pending).toBe(dirty.length)
    renderer.destroy()
  })

  /**
   * `CAVE_BACKDROP` (`docs/70` §A17's classifier, now behind a switch).
   *
   * Asserted on `bakeLayers()` rather than on the `caveBackdrop` field, because
   * the field is not what draws anything: a renderer that read it and handed the
   * texture over regardless would satisfy a field assertion and still paint every
   * cavern. `bakeLayers()` is what `bakeChunk` is actually given.
   */
  describe('the cave backdrop toggle', () => {
    const backTexture = {} as CanvasImageSource

    afterEach(() => setCaveBackdropDefault(null))

    it('hands bakeChunk no backdrop, and builds no mask, when off', () => {
      core.generate(4242n, MapScale.Small)
      setCaveBackdropDefault(false)
      const { renderer } = makeRenderer(core, backTexture)
      renderer.buildAll()

      expect(renderer.backdropEnabled).toBe(false)
      expect(renderer.bakeLayers().back).toBeNull()
      expect(renderer.bakeLayers().backSource).toBeNull()
      // The classifier is three chamfers over the whole map. Skipped, not fast.
      expect(renderer.stats.backdropMs).toBeLessThan(20)
      renderer.destroy()
    })

    // The control. Without it the assertions above hold for a renderer that never
    // had a backdrop to hand over in the first place.
    it('hands it both when on', () => {
      core.generate(4242n, MapScale.Small)
      setCaveBackdropDefault(true)
      const { renderer } = makeRenderer(core, backTexture)
      renderer.buildAll()

      expect(renderer.backdropEnabled).toBe(true)
      expect(renderer.bakeLayers().back).toBe(backTexture)
      expect(renderer.bakeLayers().backSource).not.toBeNull()
      expect(renderer.stats.backdropMs).toBeGreaterThan(0)
      renderer.destroy()
    })

    it('flipping it live re-queues every chunk', () => {
      core.generate(4242n, MapScale.Small)
      setCaveBackdropDefault(false)
      const { renderer } = makeRenderer(core, backTexture)
      renderer.buildAll()
      core.takeDirtyChunks()
      renderer.update({ x: 0, y: 0 })
      expect(renderer.stats.pending).toBe(0)

      renderer.setCaveBackdrop(true)
      expect(renderer.stats.pending).toBe(renderer.chunksX * renderer.chunksY)
      expect(renderer.bakeLayers().back).toBe(backTexture)
      renderer.destroy()
    })

    it('the default survives a rebuild, which a live flip alone would not', () => {
      core.generate(4242n, MapScale.Small)
      setCaveBackdropDefault(true)
      expect(caveBackdropDefault()).toBe(true)
      const { renderer } = makeRenderer(core, backTexture)
      expect(renderer.backdropEnabled).toBe(true)
      renderer.destroy()

      // What the Regenerate button does: a brand-new renderer.
      const second = makeRenderer(core, backTexture).renderer
      expect(second.backdropEnabled).toBe(true)
      second.destroy()
    })

    it('ships off', () => {
      expect(C().CAVE_BACKDROP).toBe(false)
      expect(caveBackdropDefault()).toBe(false)
    })
  })
})

describe('setObjects and the rebake queue', () => {
  let core: Core

  beforeAll(async () => {
    core = await Core.init(wasmBytes)
    core.generate(4242n, MapScale.Small)
  })

  /**
   * **The bound this had no test for, which is how it reached the browser.**
   *
   * `setObjects` queued *every* chunk on the map. Nothing failed — the scenery
   * appears either way — so a full-map backlog at the start of every round was
   * invisible: at `CHUNK_REBAKE_BUDGET` 4 a frame, 128 chunks is ~32 frames
   * during which a carve's own rebake waits behind chunks that did not change.
   *
   * The assertion is on the **queue draining within a bounded number of
   * frames**, not on the count of dirty chunks, because that is the thing a
   * player would feel. An injected `deps.bake` proves scheduling and never
   * drawing — this says which chunks were asked for and when, and nothing at all
   * about pixels.
   */
  function objectsAt(spots: Array<{ x: number; y: number }>) {
    return spots.map((p, i) => ({ id: i, x: p.x, y: p.y, w: 16, h: 16, flip: false }))
  }

  it('queues only the chunks that hold an object', async () => {
    const { renderer } = makeRenderer(core)
    renderer.buildAll()
    renderer.update({ x: 0, y: 0 })
    while (renderer.stats.pending > 0) renderer.update({ x: 0, y: 0 })

    const size = C().CHUNK_SIZE
    renderer.setObjects(objectsAt([{ x: 8, y: 8 }, { x: size + 8, y: 8 }]), null)

    expect(renderer.stats.pending).toBe(2)
    // The control: the map has many more chunks than that, so "2" is a
    // restriction and not just the size of the map.
    expect(renderer.chunksX * renderer.chunksY).toBeGreaterThan(8)
  })

  it('drains what it queued within the budget, in a bounded number of frames', async () => {
    const { renderer } = makeRenderer(core)
    renderer.buildAll()
    while (renderer.stats.pending > 0) renderer.update({ x: 0, y: 0 })

    const size = C().CHUNK_SIZE
    renderer.setObjects(
      objectsAt([
        { x: 8, y: 8 },
        { x: size + 8, y: 8 },
        { x: 8, y: size + 8 },
      ]),
      null,
    )

    const queued = renderer.stats.pending
    expect(queued).toBe(3)
    // `CHUNK_REBAKE_BUDGET` chunks a frame, so three chunks is one frame. The
    // bound is derived from the constant rather than picked.
    const bound = Math.ceil(queued / C().CHUNK_REBAKE_BUDGET)
    let frames = 0
    while (renderer.stats.pending > 0 && frames < 500) {
      renderer.update({ x: 0, y: 0 })
      frames++
    }
    expect(renderer.stats.pending).toBe(0)
    expect(frames).toBeLessThanOrEqual(bound)
  })

  it('a whole-map queue would blow that bound — the falsification', async () => {
    // What the old `setObjects` did, spelled out here so the bound above is
    // shown to discriminate. Queue every chunk and the drain takes
    // chunks/budget frames, which for this map is far more than the three
    // chunks the objects actually occupy.
    const { renderer } = makeRenderer(core)
    renderer.buildAll()
    while (renderer.stats.pending > 0) renderer.update({ x: 0, y: 0 })

    const all = renderer.chunksX * renderer.chunksY
    renderer.markDirty(Array.from({ length: all }, (_, i) => i))
    expect(renderer.stats.pending).toBe(all)

    const boundForThree = Math.ceil(3 / C().CHUNK_REBAKE_BUDGET)
    let frames = 0
    while (renderer.stats.pending > 0 && frames < 5000) {
      renderer.update({ x: 0, y: 0 })
      frames++
    }
    expect(frames).toBeGreaterThan(boundForThree)
  })
})
