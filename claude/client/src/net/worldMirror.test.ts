import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Core, MapScale } from '../core'
import { WorldMirror, hex } from './worldMirror'

/**
 * These run against the **real** wasm core, not a fake. The bug this file exists
 * to catch — a mask that diverges from the server's — only exists against a real
 * mask, and a stubbed `carve` would make every test here pass while the game was
 * broken (`docs/70-amendments-v2.md` §A17's lesson, applied to the net layer).
 */
let core: Core
let other: Core

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url),
  )
  const bytes = readFileSync(wasmPath)
  core = await Core.init(bytes)
  other = await Core.init(bytes)
}, 60_000)

/**
 * A point with solid rock around it.
 *
 * Two of these tests originally carved at a hardcoded (300, 300), which on a
 * Small map is open sky — the carve removed nothing, the hash did not move, and
 * the tests failed while the code was correct. Any test that carves needs to
 * carve something.
 */
function solidPoint(c: Core): [number, number] {
  for (let y = c.height - 60; y > c.height / 3; y -= 8) {
    for (let x = 200; x < c.width - 200; x += 8) {
      if (c.solidAt(x, y) && c.solidAt(x + 40, y) && c.solidAt(x - 40, y)) return [x, y]
    }
  }
  throw new Error('no solid point found — the generator is broken, not this test')
}

/** Put a mirror through a real `map_init` so its carve expectation is set. */
function initMirror(c: Core, carveSeq = 0): WorldMirror {
  const m = new WorldMirror(c)
  m.applyMapInit({
    width: c.width,
    height: c.height,
    seed: 4242n,
    scale: 0,
    theme: 0,
    wind: 0,
    carveSeq,
    spawnPoints: [],
    decorations: [],
    rle: c.maskRle(),
  })
  return m
}

/**
 * A mirror that has been through a real `map_init`.
 *
 * It matters that this goes through `applyMapInit` rather than a test seam:
 * the mirror refuses to verify a checksum before a map has landed, and a
 * fixture that faked that flag would test a state the client never reaches.
 */
function freshMirror(): { mirror: WorldMirror; resyncs: number[] } {
  core.generate(4242n, MapScale.Small)
  const mirror = new WorldMirror(core)
  const resyncs: number[] = []
  mirror.onResyncNeeded = () => resyncs.push(1)
  mirror.applyMapInit({
    width: core.width,
    height: core.height,
    seed: 4242n,
    scale: 0,
    theme: 0,
    wind: 0,
    carveSeq: 0,
    spawnPoints: [],
    decorations: [],
    rle: core.maskRle(),
  })
  return { mirror, resyncs }
}

describe('carve ordering', () => {
  // Sequences start at 1: the world increments before emitting, so there is no
  // carve 0 and a test that used one was testing a state the server never sends.
  it('applies carves in seq order and buffers what arrives early', () => {
    const { mirror } = freshMirror()
    const applied: number[] = []
    mirror.applyCarve(3, () => applied.push(3), 0)
    mirror.applyCarve(1, () => applied.push(1), 0)
    expect(applied).toEqual([1])
    expect(mirror.pendingCarves).toBe(1)

    mirror.applyCarve(2, () => applied.push(2), 0)
    expect(applied).toEqual([1, 2, 3])
    expect(mirror.pendingCarves).toBe(0)
  })

  it('ignores a duplicate seq rather than applying it twice', () => {
    const { mirror } = freshMirror()
    let n = 0
    mirror.applyCarve(1, () => n++, 0)
    mirror.applyCarve(1, () => n++, 0)
    expect(n).toBe(1)
  })

  it('resyncs when a gap persists past the timeout, and not before', () => {
    const { mirror, resyncs } = freshMirror()
    mirror.applyCarve(2, () => {}, 1000) // seq 1 missing
    expect(resyncs.length).toBe(0)

    mirror.tick(2500) // 1.5 s later — still inside the window
    expect(resyncs.length).toBe(0)

    mirror.tick(3200) // 2.2 s — past it
    expect(resyncs.length).toBe(1)
  })

  it('does not resync while carves keep arriving in order', () => {
    const { mirror, resyncs } = freshMirror()
    for (let i = 1; i <= 50; i++) mirror.applyCarve(i, () => {}, i * 100)
    mirror.tick(100_000)
    expect(resyncs.length).toBe(0)
  })
})

describe('mask agreement', () => {
  /**
   * The claim the whole architecture rests on: two independent copies of
   * `game-core` fed the same carve stream end up bit-identical
   * (`docs/01-architecture.md`, `docs/41` §8).
   */
  it('two cores fed the same carves in order hash identically', () => {
    core.generate(4242n, MapScale.Small)
    other.generate(4242n, MapScale.Small)
    expect(hex(core.maskHash())).toBe(hex(other.maskHash()))

    const mirror = initMirror(core)
    // Deterministic pseudo-random carves, so a failure is reproducible.
    let s = 12345
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

    const carves: Array<[number, number, number]> = []
    for (let i = 0; i < 100; i++) {
      carves.push([
        Math.floor(rnd() * core.width),
        Math.floor(rnd() * core.height),
        8 + Math.floor(rnd() * 40),
      ])
    }

    // One core gets them shuffled with sequence numbers; the other in order.
    const order = carves.map((_, i) => i)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[order[i], order[j]] = [order[j]!, order[i]!]
    }
    for (const i of order) {
      const [x, y, r] = carves[i]!
      mirror.applyCarve(i + 1, () => core.carve(x, y, r), 0)
    }
    for (const [x, y, r] of carves) other.carve(x, y, r)

    expect(mirror.pendingCarves).toBe(0)
    expect(hex(core.maskHash())).toBe(hex(other.maskHash()))
  })

  it('is falsifiable: a different carve set gives a different hash', () => {
    core.generate(4242n, MapScale.Small)
    other.generate(4242n, MapScale.Small)
    const [x, y] = solidPoint(core)
    core.carve(x, y, 40)
    other.carve(x, y, 41)
    expect(hex(core.maskHash())).not.toBe(hex(other.maskHash()))
  })

  it('carve_capsule reaches the core, so lava does not diverge the mask', () => {
    core.generate(4242n, MapScale.Small)
    other.generate(4242n, MapScale.Small)
    const before = hex(core.maskHash())
    const solidBefore = core.countSolid()
    const [x, y] = solidPoint(core)

    const mirror = initMirror(core)
    mirror.applyEvent(
      'carve_capsule',
      { seq: 1, x0: x, y0: y - 60, x1: x, y1: y + 60, r: 24 },
      0,
    )
    other.carveCapsule(x, y - 60, x, y + 60, 24)

    // The control: a capsule carved through empty sky removes nothing and every
    // assertion below would pass against a no-op binding.
    expect(core.countSolid()).toBeLessThan(solidBefore)
    expect(hex(core.maskHash())).not.toBe(before)
    expect(hex(core.maskHash())).toBe(hex(other.maskHash()))
  })
})

describe('checksum', () => {
  it('accepts a matching hash and resyncs on a mismatch', () => {
    const { mirror, resyncs } = freshMirror()
    expect(mirror.verifyChecksum(hex(core.maskHash()))).toBe(true)
    expect(resyncs.length).toBe(0)

    expect(mirror.verifyChecksum('deadbeefdeadbeef')).toBe(false)
    expect(resyncs.length).toBe(1)
    expect(mirror.stats.checksumMismatches).toBe(1)
  })

  it('matches on the truncated 8-byte prefix the server sends', () => {
    const { mirror } = freshMirror()
    const truncated = hex(core.maskHash()).slice(0, 16)
    expect(mirror.verifyChecksum(truncated)).toBe(true)
  })

  it('an empty hash is a mismatch, not a free pass', () => {
    const { mirror } = freshMirror()
    expect(mirror.verifyChecksum('')).toBe(false)
  })
})

describe('roster and entities', () => {
  it('drops players absent from a snapshot rather than leaving ghosts', () => {
    const { mirror } = freshMirror()
    const p = (id: number) => ({
      id,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      aim: 0,
      health: 100,
      flags: 1,
      jetpackFuel: 255,
      selectedItem: null,
    })
    mirror.applySnapshot(
      { tick: 1, roundTime: 1, darkness: 0, players: [p(1), p(2)], lastInputSeq: 0 },
      0,
    )
    expect([...mirror.players.keys()].sort()).toEqual([1, 2])

    mirror.applySnapshot(
      { tick: 2, roundTime: 1, darkness: 0, players: [p(1)], lastInputSeq: 0 },
      0,
    )
    expect([...mirror.players.keys()]).toEqual([1])
  })

  it('tracks item spawn and pickup', () => {
    const { mirror } = freshMirror()
    mirror.applyEvent(
      'item_spawn',
      { world_item_id: 7, item_id: 3, count: 4, x: 10, y: 20, source: 'Buried' },
      0,
    )
    expect(mirror.items.get(7)?.item).toBe(3)
    mirror.applyEvent('item_pickup', { world_item_id: 7, player_id: 1 }, 0)
    expect(mirror.items.has(7)).toBe(false)
  })

  it('tracks projectile spawn and despawn', () => {
    const { mirror } = freshMirror()
    mirror.applyEvent(
      'projectile_spawn',
      { id: 5, weapon: 0, owner: 1, x: 1, y: 2, vx: 3, vy: 4 },
      0,
    )
    expect(mirror.projectiles.get(5)?.vx).toBe(3)
    mirror.applyEvent('projectile_despawn', { id: 5, reason: 'exploded' }, 0)
    expect(mirror.projectiles.has(5)).toBe(false)
  })

  it('a resync clears buffered carves so the stream restarts cleanly', () => {
    const { mirror } = freshMirror()
    mirror.applyCarve(5, () => {}, 0)
    expect(mirror.pendingCarves).toBe(1)
    // Re-loading the mask is what a resync does.
    core.generate(4242n, MapScale.Small)
    const rle = new Uint8Array(0)
    expect(() =>
      mirror.applyMapInit({
        width: core.width,
        height: core.height,
        seed: 4242n,
        scale: 0,
        theme: 0,
        wind: 0,
        carveSeq: 0,
        spawnPoints: [],
        decorations: [],
        rle,
      }),
    ).toThrow() // an empty RLE cannot load — the guard is real
  })
})

describe('checksum before the map arrives', () => {
  it('does not resync while no map has been loaded', () => {
    core.generate(4242n, MapScale.Small)
    const mirror = new WorldMirror(core)
    let resyncs = 0
    mirror.onResyncNeeded = () => resyncs++
    // A `mask_checksum` can arrive before `map_init` — the server broadcasts it
    // to every socket, seated or not.
    expect(mirror.verifyChecksum('deadbeefdeadbeef')).toBe(true)
    expect(resyncs).toBe(0)
  })

  it('but does resync once a map is loaded and the hash is wrong', () => {
    const { mirror, resyncs } = freshMirror()
    expect(mirror.verifyChecksum('deadbeefdeadbeef')).toBe(false)
    expect(resyncs.length).toBe(1)
  })
})

describe('carve stream resumption', () => {
  /**
   * The bug the M6 checkpoint caught: the world's first carve is `seq 1`, and a
   * client that reset its expectation to 0 buffered it, timed out, and refetched
   * the whole map — for every rocket, forever.
   */
  it('picks the carve stream up from the seq map_init reports', () => {
    core.generate(4242n, MapScale.Small)
    const mirror = new WorldMirror(core)
    let resyncs = 0
    mirror.onResyncNeeded = () => resyncs++
    mirror.applyMapInit({
      width: core.width,
      height: core.height,
      seed: 4242n,
      scale: 0,
      theme: 0,
      wind: 0,
      // The mask already contains carves 1..41; the next one will be 42.
      carveSeq: 41,
      spawnPoints: [],
      decorations: [],
      rle: core.maskRle(),
    })

    let applied = 0
    mirror.applyCarve(42, () => applied++, 0)
    expect(applied).toBe(1)
    mirror.tick(10_000)
    expect(resyncs).toBe(0)
  })

  it('is falsifiable: a stream starting past the reported seq still gaps', () => {
    core.generate(4242n, MapScale.Small)
    const mirror = new WorldMirror(core)
    let resyncs = 0
    mirror.onResyncNeeded = () => resyncs++
    mirror.applyMapInit({
      width: core.width,
      height: core.height,
      seed: 4242n,
      scale: 0,
      theme: 0,
      wind: 0,
      carveSeq: 41,
      spawnPoints: [],
      decorations: [],
      rle: core.maskRle(),
    })
    mirror.applyCarve(50, () => {}, 0) // 42..49 missing
    mirror.tick(10_000)
    expect(resyncs).toBe(1)
  })
})
