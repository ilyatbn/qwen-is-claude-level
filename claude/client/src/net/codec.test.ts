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
  OBJECT_WIRE_BYTES,
  FLAG,
  MOVE_MOD,
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
  padCount: number
  /** Write a pad count the buffer cannot hold, without growing the buffer. */
  padCountLie: number
  decoCount: number
  objectCount: number
  rle: Uint8Array
  rleLenLie: number
  carveSeq: number
}> = {}): ArrayBuffer {
  const width = opts.width ?? 2048
  const height = opts.height ?? 1024
  const spawns = opts.spawnCount ?? 2
  const pads = opts.padCount ?? 3
  const decos = opts.decoCount ?? 1
  const objects = opts.objectCount ?? 2
  const rle = opts.rle ?? new Uint8Array([1, 2, 3, 4])
  // magic, w, h, seed, scale, theme, wind, carve_seq, then the counted sections.
  // `carve_seq` (u32) arrived with T6.16 and this fixture did not follow it —
  // 4 bytes short, so the decoder read `spawn_count` out of the middle of it.
  const size =
    // §D6's object section sits between the decorations and the RLE length.
    4 + 4 + 4 + 8 + 1 + 1 + 4 + 4 + 2 + spawns * 4 + 2 + pads * 4 + 2 + decos * 7 +
    2 + objects * OBJECT_WIRE_BYTES + 4 + rle.length
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
  v.setUint16(at, opts.padCountLie ?? pads, true); at += 2
  for (let i = 0; i < pads; i++) {
    v.setInt16(at, 500 + i, true); at += 2
    v.setInt16(at, 600 + i, true); at += 2
  }
  v.setUint16(at, decos, true); at += 2
  for (let i = 0; i < decos; i++) {
    v.setUint16(at, 7, true); at += 2
    v.setInt16(at, 300, true); at += 2
    v.setInt16(at, 400, true); at += 2
    v.setUint8(at++, 0b101)
  }
  v.setUint16(at, objects, true); at += 2
  for (let i = 0; i < objects; i++) {
    v.setUint16(at, 40 + i, true); at += 2   // id
    v.setInt16(at, 700 + i, true); at += 2   // x
    v.setInt16(at, 800 + i, true); at += 2   // y
    v.setUint16(at, 24, true); at += 2       // w
    v.setUint16(at, 32, true); at += 2       // h
    v.setUint8(at++, i % 2)                  // flip: varies, so a decoder that
  }                                          // hardcodes either value fails
  v.setUint32(at, opts.rleLenLie ?? rle.length, true); at += 4
  new Uint8Array(b).set(rle, at)
  return b
}

function snapshotFixture(n: number, trailing = 0): ArrayBuffer {
  // Pinned to the constant, never a literal (§A19). This was `15`, and T11.08's
  // sixteenth byte turned six passing tests red for the right reason — but a
  // fixture that hardcodes the wire layout can also stay *green* against a
  // decoder that has drifted, which is the failure worth preventing.
  const per = C().SNAPSHOT_PLAYER_BYTES
  const b = new ArrayBuffer(C().SNAPSHOT_HEADER_BYTES + n * per + C().SNAPSHOT_FOOTER_BYTES + trailing)
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
    v.setUint8(at++, 204) // vision: 0.8 of clear
    v.setUint8(at++, 153) // battery: 0.6 of BATTERY_MAX (T14.02)
    v.setUint8(at++, 0b01101) // §C9: heals 1, batteries 3
    v.setUint8(at++, 191) // §C5: teleport charge, 0.749 of the way
    v.setUint8(at++, MOVE_MOD.boots) // T21.02: passive-movement bits
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
    // §C5. Between the spawns and the decorations, and the index is the id —
    // asserted here because everything after it in the buffer decodes from the
    // right offset only if this section is read.
    expect(m.pads).toEqual([
      { x: 500, y: 600 },
      { x: 501, y: 601 },
      { x: 502, y: 602 },
    ])
    expect(m.decorations).toEqual([{ kind: 7, x: 300, y: 400, flags: 0b101 }])
    // §D6. After the decorations and before the RLE — and, like the pads above,
    // everything past it decodes from the right offset only if it is read.
    expect(m.objects).toEqual([
      { id: 40, x: 700, y: 800, w: 24, h: 32, flip: false },
      { id: 41, x: 701, y: 801, w: 24, h: 32, flip: true },
    ])
    expect(Array.from(m.rle)).toEqual([1, 2, 3, 4])
  })

  it('rejects a pad count the payload cannot hold', () => {
    expect(() => decodeMapInit(mapInitFixture({ padCountLie: 30000 }))).toThrow(/pad_count/)
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
    expect(p.vision).toBeCloseTo(204 / 255, 5)
    // Dequantised against the constant, like `jetpackFuel` (§A24) — a raw byte
    // here would be divided by 255 a second time somewhere downstream.
    expect(p.battery).toBeCloseTo((153 / 255) * C().BATTERY_MAX, 4)
    // §C9's packed byte, unpacked into two counters rather than left as bits for
    // the caller to shift — a field that means two things is a bug waiting.
    expect(p.heals).toBe(1)
    expect(p.batteries).toBe(3)
  })

  it('decodes the teleport charge as a fraction', () => {
    const s = decodeSnapshot(snapshotFixture(1))
    expect(s.players[0]!.teleportCharge).toBeCloseTo(191 / 255, 4)
    // A fraction, not a raw byte: `pads.ts` multiplies it by 2π directly, and a
    // 191 through that arithmetic draws 191 turns of arc.
    expect(s.players[0]!.teleportCharge).toBeLessThanOrEqual(1)
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
