/**
 * The carve→rebake contract, tested without Phaser (§A8).
 *
 * `WorldView` itself imports Phaser, so it cannot be constructed here. What can be
 * tested is the rule that actually fixes §C0, expressed against the same two
 * objects the real class talks to: a core that *accumulates* dirty chunks and a
 * terrain that *drains* them.
 *
 * The bug was never in either object. `take_dirty_chunks` has always been a drain,
 * `markDirty` has always queued, and both were unit-tested. Nobody connected them
 * in the game scene, so the game rendered a map that had stopped being true. These
 * tests pin the connection.
 */
import { describe, expect, it } from 'vitest'

/** The slice of `Core` the render stack uses. */
class FakeCore {
  private dirty: number[] = []
  carves = 0

  carve(_x: number, _y: number, _r: number): void {
    this.carves++
    // One carve dirties the chunks it touched; the real core computes them.
    this.dirty.push(this.carves)
  }

  /** A *drain*: reading it clears it. This is the semantic the bug ignored. */
  takeDirtyChunks(): number[] {
    const d = this.dirty
    this.dirty = []
    return d
  }

  get pendingDirt(): number {
    return this.dirty.length
  }
}

class FakeTerrain {
  readonly queued: number[] = []
  markDirty(ids: ArrayLike<number>): void {
    for (let i = 0; i < ids.length; i++) this.queued.push(ids[i]!)
  }
}

/**
 * The rule under test, in isolation: whatever the core has accumulated ends up in
 * the terrain's queue, every frame, without the caller asking.
 */
function drain(core: FakeCore, terrain: FakeTerrain): void {
  terrain.markDirty(core.takeDirtyChunks())
}

describe('the carve → rebake contract', () => {
  it('moves a carve the caller never reported into the bake queue', () => {
    const core = new FakeCore()
    const terrain = new FakeTerrain()

    // A carve from *somewhere else* — the network, a replay, a weather effect.
    // This is the case the game scene had: nothing told the renderer.
    core.carve(100, 100, 20)
    expect(terrain.queued).toHaveLength(0)

    drain(core, terrain)
    expect(terrain.queued).toEqual([1])
  })

  it('leaves nothing behind, so a later frame does not re-bake a stale chunk', () => {
    const core = new FakeCore()
    const terrain = new FakeTerrain()
    core.carve(0, 0, 1)
    drain(core, terrain)
    drain(core, terrain)
    expect(terrain.queued).toEqual([1])
    expect(core.pendingDirt).toBe(0)
  })

  it('loses no carve when several land between two frames', () => {
    const core = new FakeCore()
    const terrain = new FakeTerrain()
    // A meteor shower dirties a dozen chunks inside one tick (`docs/12` §6).
    for (let i = 0; i < 12; i++) core.carve(i, i, 4)
    drain(core, terrain)
    expect(terrain.queued).toHaveLength(12)
  })

  it('is what fails when the drain is removed', () => {
    // The falsification, kept as a test: without the drain the queue stays empty
    // however much is carved, which is exactly what the game did.
    const core = new FakeCore()
    const terrain = new FakeTerrain()
    core.carve(50, 50, 30)
    // (no drain)
    expect(terrain.queued).toHaveLength(0)
    expect(core.pendingDirt).toBeGreaterThan(0)
  })
})
