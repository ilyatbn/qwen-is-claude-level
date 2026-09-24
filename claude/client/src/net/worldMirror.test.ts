import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core, MapGenerator, MapScale } from '../core'
import { WorldMirror, hex } from './worldMirror'

/** `MapGenerator::to_u8`, keyed by serde's spelling in `Core.meta` (T22.14A B3). */
const GENERATOR_BYTE = { V1: 0, V2: 1, Space: 2 } as const

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
/**
 * A `map_init` for the map `c` is already holding.
 *
 * **The pads come from the map, not an empty array.** `applyMapInit` installs
 * whatever the wire says (§C5 — the client has to carve the way the server does,
 * and pads are indestructible), so a fixture sending `pads: []` for a map that
 * has six is a `map_init` no server would ever send, and it wipes them. That is
 * not hypothetical: it turned `two cores fed the same carves in order hash
 * identically` red, because the mirror's core lost its pads and the control core
 * kept them — a true report of a fixture that was lying.
 */
function initMirror(
  c: Core,
  carveSeq = 0,
  pads = c.meta.teleport_pads.map((p) => ({ x: p.pos.x, y: p.pos.y })),
  // **And the platforms, for the identical reason as the pads above.** T21.11's
  // footprints are indestructible too, so a fixture sending `platforms: []` for
  // a map that has three is a `map_init` no server would send, and it wipes
  // them — the same way an empty `pads` once turned the hash-agreement test red.
  platforms = c.meta.gun_platforms.map((g) => ({ x: g.pos.x, y: g.pos.y })),
  // **And the rocks, third for the same reason** (T22.11C). `applyMapInit`
  // installs whatever the wire says, so a fixture sending `asteroids: []` for a
  // space map is a `map_init` no server would send and it wipes the field the
  // mirror predicts against. Empty on every map these fixtures generate, which
  // is why it is a default rather than an argument every caller passes.
  asteroids = c.meta.asteroids.map((a) => ({ x: a.x, y: a.y, r: a.r, level: a.level })),
): WorldMirror {
  const m = new WorldMirror(c)
  m.applyMapInit({
    width: c.width,
    height: c.height,
    seed: 4242n,
    scale: 0,
    theme: 0,
    generator: GENERATOR_BYTE[c.meta.generator],
    wind: 0,
    carveSeq,
    spawnPoints: [],
    pads,
    platforms,
    decorations: [],
    objects: [],
    asteroids,
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
    generator: GENERATOR_BYTE[core.meta.generator],
    wind: 0,
    carveSeq: 0,
    spawnPoints: [],
    pads: [],
    platforms: [],
    decorations: [],
    objects: [],
    asteroids: [],
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

  /**
   * §C5: `map_init` installs the pads into the **core**, not just the renderer.
   *
   * Pads are indestructible, so `carve_circle` refuses pixels inside them — and
   * this core runs the same `carve_circle` the server does. A client that never
   * hears about them digs holes the server refused, one pad-shaped patch per
   * carve, and the divergence shows up minutes later as "I got shot through a
   * wall".
   *
   * **Both cores start with no pads**, which is what a real client is: it loads a
   * mask through `loadMask` and never runs the generator, so its `MapMeta` has
   * nothing in it. Only one of them is then sent a `map_init` carrying the pads.
   * An earlier version let the core keep the pads `generate()` gave it, and
   * deleting the `setTeleportPads` call from `applyMapInit` did not fail it —
   * the test was passing on state the production path never has.
   */
  it('the pads from map_init make a carve over one a no-op', () => {
    // The "server": it generated the map, so it knows where the pads are.
    const server = other
    server.generate(4242n, MapScale.Small)
    const pad = server.meta.teleport_pads[0]
    expect(pad).toBeDefined()
    const k = C()
    const wire = server.meta.teleport_pads.map((p) => ({ x: p.pos.x, y: p.pos.y }))

    const padSolid = (c: Core) => {
      let n = 0
      const half = k.PAD_W / 2
      for (let y = pad!.pos.y + 1; y <= pad!.pos.y + k.PAD_H; y++) {
        for (let x = pad!.pos.x - half; x < pad!.pos.x + half; x++) {
          if (c.solidAt(x, y)) n++
        }
      }
      return n
    }

    // A client: same map, but its core knows nothing until `map_init` tells it.
    core.generate(4242n, MapScale.Small)
    core.setTeleportPads([])
    expect(core.teleportPads().length).toBe(0)
    initMirror(core, 0, wire)
    expect(core.teleportPads().length).toBe(wire.length * 2)

    const before = padSolid(core)
    expect(before).toBeGreaterThan(0)
    core.carve(pad!.pos.x, pad!.pos.y + k.PAD_W, k.PAD_W * 2)
    expect(padSolid(core)).toBe(before)

    // The control: the same map and the same carve, on a core still ignorant of
    // the pads. Without it, "the pad survived" is also true of a carve that
    // missed it entirely.
    server.setTeleportPads([])
    expect(padSolid(server)).toBe(before)
    server.carve(pad!.pos.x, pad!.pos.y + k.PAD_W, k.PAD_W * 2)
    expect(padSolid(server)).toBe(0)
  })

  /**
   * **T22.11C / R49: `map_init` installs the asteroids into the core**, which is
   * the production caller of `Core.setAsteroids` and the only thing that puts a
   * gravity field under a networked player.
   *
   * Since T22.11B a space body's acceleration is the summed pull of every rock,
   * read out of `map.meta.asteroids`. A networked core has no rocks of its own —
   * `GameCore::new()` generates on the standard generator and `loadMask` carries
   * a rock's *shape* but not its level — so without the call in `applyMapInit`
   * the mirror predicts a straight float while the server curves the body toward
   * a rock. That is a rubber-band on every frame a player spends inside a well.
   *
   * **The core is emptied first**, which is what a real client is: it never runs
   * the generator. The pads test above records why that matters — an earlier
   * version let the core keep what `generate()` gave it, and deleting the
   * `setTeleportPads` call did not fail it.
   *
   * The assertion is on the **effect**: the field at a point, read back through
   * `attractors::env_at` in Rust. A count of installed rocks would be satisfied
   * by rocks installed at the wrong places.
   */
  it('the rocks from map_init put a field under the client (T22.11C)', () => {
    // The "server": it generated the map, so it knows where the rocks are.
    const server = other
    expect(server.generateForGravity(4242n, MapScale.Small, MapGenerator.V2, 'space')).toBe(true)
    const wire = server.meta.asteroids.map((a) => ({ x: a.x, y: a.y, r: a.r, level: a.level }))
    expect(wire.length).toBeGreaterThan(0)
    const deepest = wire.reduce((best, a) => (a.level > best.level ? a : best), wire[0]!)
    const probe = { x: deepest.x + deepest.r + C().PLAYER_H * 2, y: deepest.y }
    const pull = (c: Core) => {
      const f = c.fieldAccelAt(probe.x, probe.y)
      return Math.hypot(f[0]!, f[1]!)
    }
    expect(pull(server)).toBeGreaterThan(0)

    // A client: the same map and the same mode, but its core knows nothing about
    // the rocks until `map_init` tells it.
    expect(core.generateForGravity(4242n, MapScale.Small, MapGenerator.V2, 'space')).toBe(true)
    core.setAsteroids([])
    expect(pull(core)).toBe(0)

    initMirror(core, 0, undefined, undefined, wire)
    expect(core.meta.asteroids).toEqual(wire)
    expect(pull(core)).toBeCloseTo(pull(server), 3)

    // **The control that the line reads the wire rather than remembering.** The
    // same `map_init` with an empty section must take the field away again — a
    // mirror that installed the core's own table would pass the assertion above
    // and fail this one.
    initMirror(core, 0, undefined, undefined, [])
    expect(core.meta.asteroids).toEqual([])
    expect(pull(core)).toBe(0)
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
      jetpackFuel: 255, vision: 1, battery: 0, heals: 0, batteries: 0,
      teleportCharge: 0,
      moveMods: 0,
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

  /**
   * T19.17. `crate_spawn`'s payload is `{tick, world_item_id, x, y}` — no
   * `item_id`, no `count` — and the arm that handles it is shared with
   * `item_spawn`. It used to coerce the missing fields with `n(p['item_id'])`,
   * which is **0**, and 0 is `MEDKIT`.
   *
   * The two halves are asserted together on purpose: the `item_spawn` case is
   * the control that says the field is still read when it is there, so "the
   * crate reports null" cannot be satisfied by a mirror that stopped decoding
   * item ids altogether.
   */
  it('a crate reports unknown contents, and a real item_spawn still reports its id', () => {
    const { mirror } = freshMirror()
    mirror.applyEvent('crate_spawn', { world_item_id: 11, x: 306, y: 69 }, 0)
    const crate = mirror.items.get(11)
    expect(crate?.source).toBe('Crate')
    // Not 0 — 0 is a real registry id (MEDKIT), so a crate reporting 0 is
    // indistinguishable from a crate holding a medkit.
    expect(crate?.item).toBeNull()
    expect(crate?.count).toBeNull()

    // The control: the same arm, with the fields present.
    //
    // **`source` was `'Crate'` here and is now `'Periodic'`** (T19.21). It was
    // incidental to this control, which is about `item_id` and `count` being
    // read when they are there — but it made this the one place in the tree
    // where an `item_spawn` carried `source: 'Crate'`, and that combination was
    // read as evidence that `SpawnSource::Crate` meant two things. It does not:
    // it marks a world item that *is* an unopened crate, and the five live
    // `ItemSpawn` emitters carry `Buried`, `Periodic`, `Periodic`, `Death` and
    // `Dropped`. The server has never sent this shape and no longer builds it in
    // the join catch-up either.
    mirror.applyEvent(
      'item_spawn',
      { world_item_id: 12, item_id: 22, count: 2, x: 1, y: 2, source: 'Periodic' },
      0,
    )
    expect(mirror.items.get(12)?.item).toBe(22)
    expect(mirror.items.get(12)?.count).toBe(2)

    // And an id that really is 0 survives, which is the case `null` exists to
    // be told apart from.
    mirror.applyEvent(
      'item_spawn',
      { world_item_id: 13, item_id: 0, count: 1, x: 1, y: 2, source: 'Periodic' },
      0,
    )
    expect(mirror.items.get(13)?.item).toBe(0)
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
        generator: GENERATOR_BYTE[core.meta.generator],
        wind: 0,
        carveSeq: 0,
        spawnPoints: [],
        pads: [],
        platforms: [],
        decorations: [],
        objects: [],
    asteroids: [],
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
      generator: GENERATOR_BYTE[core.meta.generator],
      wind: 0,
      // The mask already contains carves 1..41; the next one will be 42.
      carveSeq: 41,
      spawnPoints: [],
      pads: [],
      platforms: [],
      decorations: [],
      objects: [],
    asteroids: [],
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
      generator: GENERATOR_BYTE[core.meta.generator],
      wind: 0,
      carveSeq: 41,
      spawnPoints: [],
      pads: [],
      platforms: [],
      decorations: [],
      objects: [],
    asteroids: [],
      rle: core.maskRle(),
    })
    mirror.applyCarve(50, () => {}, 0) // 42..49 missing
    mirror.tick(10_000)
    expect(resyncs).toBe(1)
  })
})

/**
 * T22.10B: the vortex list reaches the core **as the pull `apply_input` reads**.
 * Asserted through `fieldAccelAt` — the same `env_at` sum prediction runs — on a
 * space-gravity core, not through the mirror's own array: a list the mirror kept
 * and never handed over would pass an array assertion and rubber-band in play.
 */
describe('breach vortices', () => {
  const field = (c: Core, x: number, y: number): [number, number] => {
    const f = c.fieldAccelAt(x, y)
    return [f[0]!, f[1]!]
  }

  it('an opened vortex pulls, a closed one stops, and a new round clears the core', () => {
    core.generate(4242n, MapScale.Small)
    expect(core.setGravity('space')).toBe(true)
    const mirror = new WorldMirror(core)
    const at = { x: 600, y: 300 }
    const probe = { x: at.x + C().VORTEX_CAPTURE_R * 1.5, y: at.y }
    const before = field(core, probe.x, probe.y)

    mirror.applyEvent('vortex_open', { id: 7, x: at.x, y: at.y }, 0)
    const pulled = field(core, probe.x, probe.y)
    // Toward the vortex: it sits at smaller x than the probe.
    expect(pulled[0] - before[0]).toBeLessThan(-100)

    // The join catch-up re-announcing the same id is not a second vortex.
    mirror.applyEvent('vortex_open', { id: 7, x: at.x, y: at.y }, 0)
    expect(mirror.vortices.length).toBe(1)
    expect(field(core, probe.x, probe.y)).toEqual(pulled)

    // R88: closed stops the pull and keeps the entry, to be drawn fading.
    mirror.applyEvent('vortex_close', { id: 7 }, 1234)
    expect(field(core, probe.x, probe.y)).toEqual(before)
    expect(mirror.vortices[0]!.closedAt).toBe(1234)

    mirror.applyEvent('vortex_open', { id: 8, x: at.x, y: at.y }, 0)
    expect(field(core, probe.x, probe.y)).toEqual(pulled)
    mirror.clearVortices()
    expect(mirror.vortices.length).toBe(0)
    expect(field(core, probe.x, probe.y)).toEqual(before)
    core.setGravity('standard')
  })

  it('keeps opening order, unsorted — the order the server sums in', () => {
    core.generate(4242n, MapScale.Small)
    const mirror = new WorldMirror(core)
    for (const [id, x] of [
      [5, 900],
      [2, 300],
      [9, 600],
    ] as const) {
      mirror.applyEvent('vortex_open', { id, x, y: 200 }, 0)
    }
    expect(mirror.pullingVortices.map((v) => v.id)).toEqual([5, 2, 9])
    mirror.applyEvent('vortex_close', { id: 2 }, 5)
    expect(mirror.pullingVortices.map((v) => v.id)).toEqual([5, 9])
  })

  it('a new mirror tells the shared core the list is empty — the last match does not pull', () => {
    core.generate(4242n, MapScale.Small)
    expect(core.setGravity('space')).toBe(true)
    const probe = { x: 600 + C().VORTEX_CAPTURE_R * 1.5, y: 300 }
    // Measured after a mirror has cleared the core: the test above left two
    // vortices pulling in it, which is this test's subject, one test early.
    const old = new WorldMirror(core)
    const empty = field(core, probe.x, probe.y)
    old.applyEvent('vortex_open', { id: 1, x: 600, y: 300 }, 0)
    expect(field(core, probe.x, probe.y)).not.toEqual(empty)
    new WorldMirror(core)
    expect(field(core, probe.x, probe.y)).toEqual(empty)
    core.setGravity('standard')
  })
})

/**
 * T22.12: the black hole reaches the core **as the pull `apply_input` reads**, and
 * the rock it ate leaves the core's list — its well with it, as on the server.
 * Asserted through `fieldAccelAt` (the same `env_at` sum prediction runs) and the
 * core's own asteroid table, not the mirror's fields.
 */
describe('the black hole (T22.12)', () => {
  it('pulls once announced, drops the eaten rock, survives a resync, and a new round clears it', () => {
    expect(core.generateForGravity(4242n, MapScale.Small, MapGenerator.V2, 'space')).toBe(true)
    const wire = core.meta.asteroids.map((a) => ({ x: a.x, y: a.y, r: a.r, level: a.level }))
    expect(wire.length).toBeGreaterThan(1)
    const mirror = initMirror(core, 0, undefined, undefined, wire)
    const eaten = wire[1]!
    const probe = { x: eaten.x + C().BLACK_HOLE_REACH * 0.5, y: eaten.y }
    const fx = () => core.fieldAccelAt(probe.x, probe.y)[0]!
    const fy = () => core.fieldAccelAt(probe.x, probe.y)[1]!
    const before = fx()
    const beforeY = fy()

    // T22.12C R93: the telegraph is drawn, not pulled — the core is not told.
    mirror.applyEvent('black_hole_warn', { x: eaten.x, y: eaten.y, arrives_in: C().BLACK_HOLE_TELEGRAPH }, 10)
    expect(mirror.blackHoleWarn).toEqual({ x: eaten.x, y: eaten.y, since: 10, opensAt: 10 + C().BLACK_HOLE_TELEGRAPH * 1000 })
    expect(fx()).toBe(before)
    expect(mirror.blackHole).toBe(null)

    mirror.applyEvent('black_hole', { x: eaten.x, y: eaten.y }, 42)
    expect(mirror.blackHoleWarn).toBe(null)
    expect(core.meta.asteroids.length).toBe(wire.length - 1)
    expect(core.meta.asteroids.some((a) => a.x === eaten.x && a.y === eaten.y)).toBe(false)
    // Toward the hole: it sits at smaller x than the probe. And R91 on the mirror's
    // side: inside the reach **only** the hole pulls, so level with it the field has
    // no vertical part at all — which the wells gave it before (the control).
    const pulled = fx()
    expect(pulled).toBeLessThan(0)
    expect(pulled).not.toBe(before)
    expect(beforeY).not.toBe(0)
    expect(fy()).toBe(0)
    // Sticky: a catch-up re-announcing it keeps the first arrival.
    mirror.applyEvent('black_hole', { x: eaten.x, y: eaten.y }, 99)
    expect(mirror.blackHole?.arrivedAt).toBe(42)

    // A resync whose `map_init` predates the arrival still carries the rock: dropped again.
    mirror.applyMapInit({
      width: core.width,
      height: core.height,
      seed: 4242n,
      scale: 0,
      theme: 0,
      generator: GENERATOR_BYTE[core.meta.generator],
      wind: 0,
      carveSeq: 0,
      spawnPoints: [],
      pads: [],
      platforms: [],
      decorations: [],
      objects: [],
      asteroids: wire,
      rle: core.maskRle(),
    })
    expect(core.meta.asteroids.length).toBe(wire.length - 1)
    expect(fx()).toBe(pulled)

    mirror.clearBlackHole()
    expect(mirror.blackHole).toBe(null)
    expect(fx()).not.toBe(pulled)
    core.setGravity('standard')
  })
})

