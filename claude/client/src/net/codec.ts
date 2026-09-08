/**
 * Binary wire formats, client side: decoding `map_init` and `snapshot`, encoding
 * the `input` batch. Layouts in `docs/40-net-protocol.md` §2-§3.
 *
 * Everything here parses **server-controlled bytes off a socket**. A decoder that
 * throws on a malformed frame is correct; one that returns a half-built object is
 * a bug that surfaces hours later as unexplained terrain.
 */

import { C } from '../core'

/** "MAP1", so a version skew fails loudly instead of decoding garbage. */
export const MAP_MAGIC = 0x4d415031

export class CodecError extends Error {}

export interface MapObject {
  id: number
  x: number
  y: number
  w: number
  h: number
  flip: boolean
}

export interface MapInit {
  width: number
  height: number
  seed: bigint
  scale: number
  theme: number
  wind: number
  /** The last carve `seq` this mask already contains. */
  carveSeq: number
  spawnPoints: { x: number; y: number }[]
  /** §C5's indestructible pads, in id order — the index **is** the id. */
  pads: { x: number; y: number }[]
  decorations: { kind: number; x: number; y: number; flags: number }[]
  /**
   * Scenery stamped into the terrain at pass 6b (§D5).
   *
   * Their collision is already in the mask — they *are* terrain (§D1). This is
   * only which sprite is where, so the renderer can draw the art. `w`/`h` come
   * over the wire rather than out of `objects/manifest.json` so the chunk index
   * can be built with no atlas loaded (`docs/50` §8).
   */
  objects: MapObject[]
  /** Fed straight to `Core.loadMask`, which decodes it in Rust. */
  rle: Uint8Array
}

export interface SnapshotPlayer {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  health: number
  flags: number
  /** Fuel units, 0..`JETPACK_MAX_FUEL` — already dequantised from the wire byte. */
  jetpackFuel: number
  /** This player's own FoV multiplier: fog times the smoke they stand in. */
  vision: number
  /**
   * Energy pool, in battery units 0..`BATTERY_MAX` — already dequantised from
   * the wire byte, for the same reason `jetpackFuel` is (§A24): a value that is
   * sometimes raw and sometimes scaled gets divided by 255 twice.
   */
  battery: number
  /** Heals carried, 0..`MAX_HEALS` (§C9). */
  heals: number
  /** Battery packs carried, 0..`MAX_BATTERIES` (§C9). */
  batteries: number
  /**
   * §C5's pad charge, `0..1`.
   *
   * Authoritative, like `vision` and for the same kind of reason: the fill
   * depends on the arming latch, the cooldown and the step-off reset, all of
   * which live in `world::teleport`. A client running its own two-second clock
   * would be a second copy of three guards.
   */
  teleportCharge: number
  /**
   * T21.02's passive-movement bits — see `MOVE_MOD` and
   * `PlayerState::move_mod_bits` on the Rust side.
   *
   * **Not a flag, and it is a whole byte, because `applyInput` reads it.** The
   * flags byte carries things the client only draws; this carries the things
   * the mirror has to *simulate* with, and the rule those obey is T20.19's:
   * everything `applyInput` reads must be identical on both sides.
   */
  moveMods: number
  /** `null` when the player is holding nothing. */
  selectedItem: number | null
}

export interface Snapshot {
  tick: number
  roundTime: number
  darkness: number
  players: SnapshotPlayer[]
  lastInputSeq: number
}

export interface InputFrame {
  seq: number
  aim: number
  buttons: number
}

/** Bounds-checked cursor. Every read that would run past the end throws. */
class Reader {
  private at = 0
  constructor(private readonly v: DataView) {}
  private need(n: number): number {
    const at = this.at
    if (at + n > this.v.byteLength) {
      throw new CodecError(`truncated: need ${at + n} bytes, had ${this.v.byteLength}`)
    }
    this.at = at + n
    return at
  }
  u8(): number {
    return this.v.getUint8(this.need(1))
  }
  u16(): number {
    return this.v.getUint16(this.need(2), true)
  }
  i16(): number {
    return this.v.getInt16(this.need(2), true)
  }
  u32(): number {
    return this.v.getUint32(this.need(4), true)
  }
  u64(): bigint {
    return this.v.getBigUint64(this.need(8), true)
  }
  f32(): number {
    return this.v.getFloat32(this.need(4), true)
  }
  bytes(n: number): Uint8Array {
    const at = this.need(n)
    return new Uint8Array(this.v.buffer, this.v.byteOffset + at, n)
  }
  get remaining(): number {
    return this.v.byteLength - this.at
  }
}

/**
 * `u16 id, i16 x, i16 y, u16 w, u16 h, u8 flip` — `codec.rs`'s own
 * `OBJECT_WIRE_BYTES`.
 *
 * Exported so the suite's byte fixture reads it instead of spelling `11` a
 * second time. The decoration section above spells `7` in three places and they
 * have stayed in step by luck.
 */
export const OBJECT_WIRE_BYTES = 11

export function decodeMapInit(buf: ArrayBuffer): MapInit {
  const r = new Reader(new DataView(buf))
  const magic = r.u32()
  if (magic !== MAP_MAGIC) {
    throw new CodecError(
      `bad map_init magic 0x${magic.toString(16)} (expected 0x${MAP_MAGIC.toString(16)}) — version skew?`,
    )
  }
  const width = r.u32()
  const height = r.u32()
  // Validate before allocating anything sized by the payload.
  const chunk = C().CHUNK_SIZE
  if (width <= 0 || height <= 0 || width % chunk !== 0 || height % chunk !== 0) {
    throw new CodecError(`map dimensions ${width}x${height} are not multiples of ${chunk}`)
  }
  if (width > 8192 || height > 8192) {
    throw new CodecError(`map dimensions ${width}x${height} are implausible`)
  }

  const seed = r.u64()
  const scale = r.u8()
  const theme = r.u8()
  const wind = r.f32()
  const carveSeq = r.u32()

  const spawnCount = r.u16()
  // 4 bytes each: a count the buffer cannot possibly hold is rejected before the
  // loop rather than by failing partway through it.
  if (spawnCount * 4 > r.remaining) {
    throw new CodecError(`spawn_count ${spawnCount} exceeds the payload`)
  }
  const spawnPoints: { x: number; y: number }[] = []
  for (let i = 0; i < spawnCount; i++) spawnPoints.push({ x: r.i16(), y: r.i16() })

  const padCount = r.u16()
  if (padCount * 4 > r.remaining) {
    throw new CodecError(`pad_count ${padCount} exceeds the payload`)
  }
  const pads: { x: number; y: number }[] = []
  for (let i = 0; i < padCount; i++) pads.push({ x: r.i16(), y: r.i16() })

  const decoCount = r.u16()
  if (decoCount * 7 > r.remaining) {
    throw new CodecError(`decoration_count ${decoCount} exceeds the payload`)
  }
  const decorations: { kind: number; x: number; y: number; flags: number }[] = []
  for (let i = 0; i < decoCount; i++) {
    decorations.push({ kind: r.u16(), x: r.i16(), y: r.i16(), flags: r.u8() })
  }

  const objCount = r.u16()
  if (objCount * OBJECT_WIRE_BYTES > r.remaining) {
    throw new CodecError(`object_count ${objCount} exceeds the payload`)
  }
  const objects: MapObject[] = []
  for (let i = 0; i < objCount; i++) {
    objects.push({
      id: r.u16(),
      x: r.i16(),
      y: r.i16(),
      w: r.u16(),
      h: r.u16(),
      flip: r.u8() !== 0,
    })
  }

  const rleLen = r.u32()
  if (rleLen !== r.remaining) {
    throw new CodecError(`rle_byte_len ${rleLen} disagrees with ${r.remaining} remaining`)
  }
  const rle = r.bytes(rleLen)

  return {
    width,
    height,
    seed,
    scale,
    theme,
    wind,
    carveSeq,
    spawnPoints,
    pads,
    decorations,
    objects,
    rle,
  }
}

export function decodeSnapshot(buf: ArrayBuffer): Snapshot {
  const r = new Reader(new DataView(buf))
  const tick = r.u32()
  const roundTime = r.u16() / 10
  const darkness = r.u8() / 255
  const n = r.u8()

  const players: SnapshotPlayer[] = []
  for (let i = 0; i < n; i++) {
    const id = r.u8()
    const x = r.i16()
    const y = r.i16()
    const vx = r.i16()
    const vy = r.i16()
    const aim = r.u16()
    const health = r.u8()
    const flags = r.u8()
    // Dequantised HERE and nowhere else. `SnapshotPlayer.jetpackFuel` is in fuel
    // units (0..JETPACK_MAX_FUEL), not the raw byte — two call sites in
    // `GameScene` divided by 255 a second time and one of them fed the result to
    // the predictor's core (§A24).
    const jetpackFuel = (r.u8() / 255) * C().JETPACK_MAX_FUEL
    const item = r.u8()
    const vision = r.u8() / 255
    const battery = (r.u8() / 255) * C().BATTERY_MAX
    // §C9: heals in the low 2 bits, batteries in the next 3.
    const consumables = r.u8()
    const heals = consumables & 0b11
    const batteries = (consumables >> 2) & 0b111
    const teleportCharge = r.u8() / 255
    const moveMods = r.u8()
    players.push({
      id,
      x,
      y,
      vx,
      vy,
      aim,
      health,
      flags,
      jetpackFuel,
      vision,
      battery,
      heals,
      batteries,
      teleportCharge,
      moveMods,
      selectedItem: item === 255 ? null : item,
    })
  }
  const lastInputSeq = r.u32()
  if (r.remaining !== 0) {
    throw new CodecError(`${r.remaining} trailing bytes after the snapshot`)
  }
  return { tick, roundTime, darkness, players, lastInputSeq }
}

/** Snapshot flag bits (`docs/40-net-protocol.md` §3). */
export const FLAG = {
  alive: 1 << 0,
  grounded: 1 << 1,
  jetpack: 1 << 2,
  shield: 1 << 3,
  flashlight: 1 << 4,
  iframes: 1 << 5,
  /** §E13. Bit 6; `docs/40` §3 still lists 6-7 as reserved. */
  poisoned: 1 << 6,
} as const

/**
 * Passive-movement bits (T21.02), a byte of their own beside `FLAG`.
 *
 * **Separate from `FLAG` on purpose, and the line is not arbitrary.** `FLAG`
 * carries what the client *draws*; this carries what the mirror *simulates
 * with*, which is the set T20.19's rule governs. The flashlight is passive too
 * and stays in `FLAG` at bit 4, because nothing predicts light.
 *
 * The numbering mirrors `player/state.rs`'s `MOVE_MOD_BITS` table, which is the
 * authority — a wire format is a table, and both ends walk the same one.
 */
export const MOVE_MOD = {
  boots: 1 << 0,
  /** T21.03. Carried, never toggled — dropping them is the only off switch. */
  wings: 1 << 1,
} as const

export function flag(flags: number, bit: number): boolean {
  return (flags & bit) !== 0
}

/**
 * The last `INPUT_REDUNDANCY` inputs, newest last.
 *
 * Redundancy is why a dropped packet costs nothing: the next one re-delivers the
 * missing sequences. That works only because the format is held state rather than
 * edges — a lost edge would be gone forever.
 */
export function encodeInputBatch(inputs: readonly InputFrame[]): ArrayBuffer {
  const redundancy = C().INPUT_REDUNDANCY
  const take = Math.min(inputs.length, redundancy)
  if (take === 0) throw new CodecError('an input batch must carry at least one input')
  const out = new ArrayBuffer(1 + take * 7)
  const v = new DataView(out)
  v.setUint8(0, take)
  let at = 1
  for (const i of inputs.slice(inputs.length - take)) {
    v.setUint32(at, i.seq, true)
    v.setUint16(at + 4, i.aim, true)
    // Bit 7 is reserved; never set it.
    v.setUint8(at + 6, i.buttons & 0x7f)
    at += 7
  }
  return out
}
