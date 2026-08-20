import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Core, C, MapScale } from '../core'
import {
  decodeMapInit,
  decodeSnapshot,
  encodeInputBatch,
  CodecError,
  MAP_MAGIC,
  FLAG,
  flag,
} from './codec'

/**
 * Fixtures are built here in TypeScript to the documented layout. The Rust
 * encoder's own tests pin its output against the same layout, and
 * `the mask a real map_init carries round-trips through Core` closes the loop
 * with real bytes from a real generated map.
 */
function mapInitFixture(opts: Partial<{
  magic: number
  width: number
  height: number
  spawnCount: number
  decoCount: number
  rle: Uint8Array
  rleLenLie: number
  carveSeq: number
}> = {}): ArrayBuffer {
  const width = opts.width ?? 2048
  const height = opts.height ?? 1024
  const spawns = opts.spawnCount ?? 2
  const decos = opts.decoCount ?? 1
  const rle = opts.rle ?? new Uint8Array([1, 2, 3, 4])
  // magic, w, h, seed, scale, theme, wind, carve_seq, then the counted sections.
  // `carve_seq` (u32) arrived with T6.16 and this fixture did not follow it —
  // 4 bytes short, so the decoder read `spawn_count` out of the middle of it.
  const size =
    4 + 4 + 4 + 8 + 1 + 1 + 4 + 4 + 2 + spawns * 4 + 2 + decos * 7 + 4 + rle.length
  const b = new ArrayBuffer(size)
  const v = new DataView(b)
  let at = 0
  v.setUint32(at, opts.magic ?? MAP_MAGIC, true); at += 4
  v.setUint32(at, width, true); at += 4
  v.setUint32(at, height, true); at += 4
  v.setBigUint64(at, 8123491234n, true); at += 8
  v.setUint8(at++, 1)
  v.setUint8(at++, 2)
  v.setFloat32(at, -42.5, true); at += 4
  v.setUint32(at, opts.carveSeq ?? 0, true); at += 4
  v.setUint16(at, spawns, true); at += 2
  for (let i = 0; i < spawns; i++) {
    v.setInt16(at, 100 + i, true); at += 2
    v.setInt16(at, 200 + i, true); at += 2
  }
  v.setUint16(at, decos, true); at += 2
  for (let i = 0; i < decos; i++) {
    v.setUint16(at, 7, true); at += 2
    v.setInt16(at, 300, true); at += 2
    v.setInt16(at, 400, true); at += 2
    v.setUint8(at++, 0b101)
  }
  v.setUint32(at, opts.rleLenLie ?? rle.length, true); at += 4
  new Uint8Array(b).set(rle, at)
  return b
}

function snapshotFixture(n: number, trailing = 0): ArrayBuffer {
  const per = 15
  const b = new ArrayBuffer(8 + n * per + 4 + trailing)
  const v = new DataView(b)
  let at = 0
  v.setUint32(at, 1234, true); at += 4
  v.setUint16(at, 306, true); at += 2   // 30.6 s
  v.setUint8(at++, 209)                 // full night: 0.82 * 255
  v.setUint8(at++, n)
  for (let i = 0; i < n; i++) {
    v.setUint8(at++, i)
    v.setInt16(at, 1000 + i, true); at += 2
    v.setInt16(at, -500 - i, true); at += 2
    v.setInt16(at, 33, true); at += 2
    v.setInt16(at, -44, true); at += 2
    v.setUint16(at, 40000, true); at += 2
    v.setUint8(at++, 137)
    v.setUint8(at++, FLAG.alive | FLAG.flashlight)
    v.setUint8(at++, 128)
    v.setUint8(at++, i === 0 ? 255 : 3)
  }
  v.setUint32(at, 9999, true)
  return b
}

let core: Core

beforeAll(async () => {
  // wasm-bindgen's web target fetches by URL, which node has no base for; the
  // bytes are read directly instead, as the other Core-using suites do.
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  core = await Core.init(readFileSync(fileURLToPath(url)))
}, 120_000)

describe('map_init', () => {
  it('decodes every field', () => {
    const m = decodeMapInit(mapInitFixture())
    expect(m.width).toBe(2048)
    expect(m.height).toBe(1024)
    expect(m.seed).toBe(8123491234n)
    expect(m.scale).toBe(1)
    expect(m.theme).toBe(2)
    expect(m.wind).toBeCloseTo(-42.5, 4)
    expect(m.spawnPoints).toEqual([
      { x: 100, y: 200 },
      { x: 101, y: 201 },
    ])
    expect(m.decorations).toEqual([{ kind: 7, x: 300, y: 400, flags: 0b101 }])
    expect(Array.from(m.rle)).toEqual([1, 2, 3, 4])
  })

  it('rejects a wrong magic number with a clear message', () => {
    expect(() => decodeMapInit(mapInitFixture({ magic: 0xdeadbeef }))).toThrow(/magic/)
  })

  it('rejects dimensions that are not chunk multiples', () => {
    expect(() => decodeMapInit(mapInitFixture({ width: 2000 }))).toThrow(/multiples/)
  })

  it('rejects an rle_byte_len that disagrees with the payload', () => {
    expect(() => decodeMapInit(mapInitFixture({ rleLenLie: 99 }))).toThrow(/disagrees/)
  })

  it('rejects a truncated buffer rather than returning a partial object', () => {
    const full = mapInitFixture()
    for (let cut = 0; cut < full.byteLength; cut++) {
      expect(() => decodeMapInit(full.slice(0, cut))).toThrow()
    }
  })

  it('rejects an absurd spawn count without allocating for it', () => {
    const b = mapInitFixture()
    // Overwrite spawn_count with 65535; the payload cannot hold it.
    // Derived, not a magic 26: this offset silently rotted when `carve_seq`
    // was inserted ahead of it, and the test then poked the wrong field.
    const SPAWN_COUNT_AT = 4 + 4 + 4 + 8 + 1 + 1 + 4 + 4
    new DataView(b).setUint16(SPAWN_COUNT_AT, 0xffff, true)
    expect(() => decodeMapInit(b)).toThrow(/exceeds the payload/)
  })

  /** The loop the whole format exists to close: real server bytes, real mask. */
  it('carries a mask that round-trips through Core to the same hash', () => {
    core.generate(4242n, MapScale.Small)
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    const before = hex(core.maskHash())
    const rle = core.maskRle()

    // Build a map_init around the real payload, exactly as the server does.
    const b = mapInitFixture({ width: core.width, height: core.height, rle })
    const m = decodeMapInit(b)

    // A different map first, to prove loadMask really replaces rather than merges.
    core.generate(1n, MapScale.Small)
    expect(hex(core.maskHash())).not.toBe(before)
    expect(core.loadMask(m.width, m.height, m.rle)).toBe(true)
    expect(hex(core.maskHash())).toBe(before)
  })
})

describe('snapshot', () => {
  it('decodes every field', () => {
    const s = decodeSnapshot(snapshotFixture(3))
    expect(s.tick).toBe(1234)
    expect(s.roundTime).toBeCloseTo(30.6, 5)
    expect(s.darkness).toBeCloseTo(209 / 255, 5)
    expect(s.lastInputSeq).toBe(9999)
    expect(s.players).toHaveLength(3)
    const p = s.players[1]!
    expect(p.id).toBe(1)
    expect(p.x).toBe(1001)
    expect(p.y).toBe(-501)
    expect(p.vx).toBe(33)
    expect(p.vy).toBe(-44)
    expect(p.aim).toBe(40000)
    expect(p.health).toBe(137)
  })

  it('decodes flags to the right booleans', () => {
    const s = decodeSnapshot(snapshotFixture(1))
    const f = s.players[0]!.flags
    expect(flag(f, FLAG.alive)).toBe(true)
    expect(flag(f, FLAG.flashlight)).toBe(true)
    expect(flag(f, FLAG.grounded)).toBe(false)
    expect(flag(f, FLAG.shield)).toBe(false)
    expect(flag(f, FLAG.iframes)).toBe(false)
  })

  it('dequantises jetpack fuel and darkness within one part in 255', () => {
    const s = decodeSnapshot(snapshotFixture(1))
    expect(s.players[0]!.jetpackFuel).toBeCloseTo((128 / 255) * C().JETPACK_MAX_FUEL, 4)
    expect(Math.abs(s.darkness - 0.82)).toBeLessThan(1 / 255)
  })

  it('decodes selected_item 255 as none', () => {
    const s = decodeSnapshot(snapshotFixture(2))
    expect(s.players[0]!.selectedItem).toBeNull()
    expect(s.players[1]!.selectedItem).toBe(3)
  })

  it('six players decode to six entries with unique ids', () => {
    const s = decodeSnapshot(snapshotFixture(6))
    expect(s.players).toHaveLength(6)
    expect(new Set(s.players.map((p) => p.id)).size).toBe(6)
  })

  it('rejects a truncated buffer', () => {
    const full = snapshotFixture(3)
    for (let cut = 0; cut < full.byteLength; cut++) {
      expect(() => decodeSnapshot(full.slice(0, cut))).toThrow()
    }
  })

  it('rejects a length that disagrees with player_count', () => {
    expect(() => decodeSnapshot(snapshotFixture(3, 5))).toThrow(/trailing/)
    const b = snapshotFixture(3)
    new DataView(b).setUint8(7, 200)
    expect(() => decodeSnapshot(b)).toThrow()
  })

  it('is exactly header + n * player + footer', () => {
    const c = C()
    expect(snapshotFixture(6).byteLength).toBe(
      c.SNAPSHOT_HEADER_BYTES + 6 * c.SNAPSHOT_PLAYER_BYTES + c.SNAPSHOT_FOOTER_BYTES,
    )
  })
})

describe('input batch', () => {
  const f = (seq: number) => ({ seq, aim: seq * 7, buttons: seq & 0x7f })

  it('is 8, 15 and 22 bytes for one, two and three inputs', () => {
    expect(encodeInputBatch([f(1)]).byteLength).toBe(8)
    expect(encodeInputBatch([f(1), f(2)]).byteLength).toBe(15)
    expect(encodeInputBatch([f(1), f(2), f(3)]).byteLength).toBe(22)
  })

  it('sends only the last INPUT_REDUNDANCY inputs', () => {
    const many = Array.from({ length: 10 }, (_, i) => f(i + 1))
    const b = encodeInputBatch(many)
    const v = new DataView(b)
    expect(v.getUint8(0)).toBe(C().INPUT_REDUNDANCY)
    expect(v.getUint32(1, true)).toBe(8)
  })

  it('refuses an empty batch rather than sending a zero count', () => {
    // The server rejects count == 0, so sending one is a guaranteed wasted packet.
    expect(() => encodeInputBatch([])).toThrow(CodecError)
  })

  it('never sets the reserved bit', () => {
    const b = encodeInputBatch([{ seq: 1, aim: 0, buttons: 0xff }])
    expect(new DataView(b).getUint8(7)).toBe(0x7f)
  })
})

describe('fuzz', () => {
  it('rejects a thousand random buffers without an unhandled throw', () => {
    let state = 0x2545f491
    const next = () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return state >>> 0
    }
    let rejected = 0
    for (let i = 0; i < 1000; i++) {
      const len = next() % 96
      const b = new ArrayBuffer(len)
      const u = new Uint8Array(b)
      for (let j = 0; j < len; j++) u[j] = next() & 0xff
      for (const fn of [decodeMapInit, decodeSnapshot]) {
        try {
          fn(b)
        } catch (e) {
          // A CodecError is the contract. Anything else — a TypeError from an
          // unchecked index, a RangeError from a huge allocation — is the bug
          // this test exists to catch.
          expect(e).toBeInstanceOf(CodecError)
          rejected++
        }
      }
    }
    expect(rejected).toBeGreaterThan(1500)
  })
})
