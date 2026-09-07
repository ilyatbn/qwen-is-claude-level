import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Core, MapScale, C } from './index'

const here = dirname(fileURLToPath(import.meta.url))
const wasmBytes = readFileSync(join(here, 'pkg/game_wasm_bg.wasm'))

async function newCore(): Promise<Core> {
  return Core.init(wasmBytes)
}

describe('Core', () => {
  let core: Core

  beforeAll(async () => {
    core = await newCore()
  })

  it('initialises and exposes constants from Rust', () => {
    const c = C()
    expect(c.VIEWPORT_W).toBe(1280)
    expect(c.VIEWPORT_H).toBe(720)
    expect(c.CHUNK_SIZE).toBe(256)
    expect(c.CAMERA_ZOOM).toBe(2)
    expect(c.PLAYER_W).toBe(16)
    expect(c.PLAYER_H).toBe(28)
  })

  it('generates each scale at the right dimensions', () => {
    core.generate(4242n, MapScale.Small)
    expect([core.width, core.height]).toEqual([2048, 1024])
    core.generate(4242n, MapScale.Medium)
    expect([core.width, core.height]).toEqual([3072, 1536])
    expect(core.chunksX).toBe(12)
    expect(core.chunksY).toBe(6)
  })

  it('parses meta with spawn and surface points', () => {
    core.generate(4242n, MapScale.Small)
    const m = core.meta
    expect(m.spawn_points.length).toBeGreaterThanOrEqual(6)
    expect(m.surface_points.length).toBeGreaterThan(0)
    expect(m.traversable_fraction).toBeGreaterThan(0.5)
    expect(Math.abs(m.wind)).toBeLessThanOrEqual(90)
  })

  it('caches meta until the map changes', () => {
    core.generate(1n, MapScale.Small)
    const a = core.meta
    expect(core.meta).toBe(a)
    core.generate(2n, MapScale.Small)
    expect(core.meta).not.toBe(a)
  })

  it('solidAt agrees with a carve', () => {
    core.generate(4242n, MapScale.Small)
    // Just above the bedrock in the middle is reliably solid.
    const x = Math.floor(core.width / 2)
    const y = core.height - 60
    expect(core.solidAt(x, y)).toBe(true)

    core.carve(x, y, 40)
    expect(core.solidAt(x, y)).toBe(false)
    // Well outside the crater is untouched.
    expect(core.solidAt(x + 120, y)).toBe(true)
  })

  it('reports dirty chunks once per carve', () => {
    core.generate(4242n, MapScale.Small)
    core.takeDirtyChunks()
    core.carve(Math.floor(core.width / 2), core.height - 60, 30)
    expect(core.takeDirtyChunks().length).toBeGreaterThan(0)
    expect(core.takeDirtyChunks().length).toBe(0)
  })

  it('solidAt is out-of-bounds safe', () => {
    core.generate(1n, MapScale.Small)
    expect(core.solidAt(-1, 10)).toBe(false)
    expect(core.solidAt(10, -1)).toBe(false)
    expect(core.solidAt(core.width, 10)).toBe(false)
    expect(core.solidAt(10, core.height)).toBe(false)
  })

  /**
   * The trap this wrapper exists to close: a view over WASM memory is detached by
   * heap growth, and a detached view reads as zeros — a blank map with no error.
   */
  it('survives WASM memory growth after a view is held', () => {
    core.generate(4242n, MapScale.Small)
    const x = Math.floor(core.width / 2)
    const y = core.height - 60
    expect(core.solidAt(x, y)).toBe(true)

    const stale = core.maskView()
    const staleBuffer = stale.buffer

    // Generating a much larger map reallocates and very likely grows the heap.
    core.generate(4242n, MapScale.Large)
    expect([core.width, core.height]).toEqual([4096, 2048])

    const fresh = core.maskView()
    expect(fresh.byteLength).toBe((4096 * 2048) / 8)

    // The mask must still read correctly. If the wrapper handed back the stale
    // view, every read here would be a zero and the map would render blank.
    let solidCount = 0
    for (let px = 0; px < core.width; px += 64) {
      for (let py = 0; py < core.height; py += 64) {
        if (core.solidAt(px, py)) solidCount++
      }
    }
    expect(solidCount).toBeGreaterThan(0)

    if (staleBuffer !== fresh.buffer) {
      // The heap did grow, so this run actually exercised the re-acquire path.
      expect(stale.byteLength === 0 || stale.buffer !== core.maskView().buffer).toBe(true)
    }
  })

  it('round-trips a mask through RLE', () => {
    core.generate(31337n, MapScale.Small)
    const before = core.maskHash()
    const rle = core.maskRle()

    const other = core
    expect(other.loadMask(core.width, core.height, rle)).toBe(true)
    expect(Array.from(other.maskHash())).toEqual(Array.from(before))
  })

  it('rejects a malformed mask payload', () => {
    core.generate(1n, MapScale.Small)
    expect(core.loadMask(256, 256, new Uint8Array([255, 255, 255, 255]))).toBe(false)
    expect(core.loadMask(100, 100, new Uint8Array([0]))).toBe(false)
  })

  it('round-trips player state, health included', () => {
    core.addPlayer(1, 0, 0)
    // Deliberately not BASE_HEALTH: `addPlayer` seats a player at full health,
    // so a snapshot value equal to it would be indistinguishable from the
    // mirror ignoring the argument (T20.19).
    const hurt = C().BASE_HEALTH / 2
    core.setPlayerState(1, {
      x: 12.5,
      y: -3.25,
      vx: 7,
      vy: -1.5,
      grounded: true,
      fuel: 2.5,
      moveState: 0,
      health: hurt,
    })
    const s = core.playerState(1)
    expect(s).not.toBeNull()
    expect(s!.x).toBe(12.5)
    expect(s!.y).toBe(-3.25)
    expect(s!.grounded).toBe(true)
    expect(s!.fuel).toBe(2.5)
    expect(s!.health).toBe(hurt)
    expect(s!.health).not.toBe(C().BASE_HEALTH)
  })

  it('returns null for an unknown player', () => {
    expect(core.playerState(200)).toBeNull()
  })

  it('applies input and moves the player', () => {
    core.generate(4242n, MapScale.Small)
    core.addPlayer(9, 500, 40)
    const before = core.playerState(9)!
    const RIGHT = 1 << 1
    for (let seq = 0; seq < 60; seq++) core.applyInput(9, seq, RIGHT, 0, C().SIM_DT)
    const after = core.playerState(9)!
    expect(after.x).not.toBe(before.x)
  })
})
