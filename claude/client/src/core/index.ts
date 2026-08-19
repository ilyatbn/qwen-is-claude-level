/**
 * Typed wrapper over the `game-wasm` bindings.
 *
 * Two things here are load-bearing:
 *
 * 1. **The mask view is re-acquired on demand.** A `Uint8Array` over WASM memory is
 *    detached whenever the heap grows, and a detached view reads as zeros — a map
 *    that renders blank with no error anywhere. `maskView()` checks the buffer
 *    identity every call so no caller has to remember.
 * 2. **Constants come from Rust.** Nothing in the client re-declares a tunable; they
 *    are read across the boundary once, so there is exactly one source of truth.
 */

import init, { GameCore, constants_json } from './pkg/game_wasm.js'
import wasmUrl from './pkg/game_wasm_bg.wasm?url'

export const enum MapScale {
  Small = 0,
  Medium = 1,
  Large = 2,
}

export interface Point {
  x: number
  y: number
}

export interface BuriedSlot {
  id: number
  pos: Point
  revealed: boolean
}

export interface Decoration {
  kind: number
  pos: Point
  flip: boolean
  scale_tier: number
}

export interface MapMeta {
  seed: number
  requested_seed: number
  attempts: number
  used_safe_preset: boolean
  scale: string
  theme: number
  spawn_points: Point[]
  surface_points: Point[]
  buried_slots: BuriedSlot[]
  decorations: Decoration[]
  wind: number
  traversable_fraction: number
}

export interface PlayerState {
  x: number
  y: number
  vx: number
  vy: number
  grounded: boolean
  fuel: number
  /** 0 grounded, 1 airborne, 2 jetpack */
  moveState: number
}

/**
 * Every tunable the client needs, read from `game-core`'s `constants.rs`.
 *
 * The client must never re-declare one of these. A literal in TypeScript that
 * shadows a Rust constant is exactly the drift this architecture exists to
 * prevent — see `docs/01-architecture.md`.
 */
export interface Constants {
  VIEWPORT_W: number
  VIEWPORT_H: number
  CHUNK_SIZE: number
  COARSE_CELL: number
  BEDROCK_H: number
  WALL_W: number
  SKY_MARGIN: number
  PLAYER_W: number
  PLAYER_H: number
  EDGE_BAND_PX: number
  CHUNK_REBAKE_BUDGET: number
  PARALLAX_FACTOR: number
  CAMERA_LERP: number
  CAMERA_ZOOM: number
  CAMERA_DEADZONE_W: number
  CAMERA_DEADZONE_H: number
  CAMERA_LOOKAHEAD: number
  CAMERA_LOOKAHEAD_LERP: number
  SIM_DT: number
  SIM_HZ: number
  AIM_RADIUS: number
  JETPACK_MAX_FUEL: number
  MINIMAP_W: number
  MINIMAP_H: number
}

/** Populated by `Core.init()`. Throws if read before then, rather than silently
 *  handing out zeros. */
let constantsCache: Constants | null = null

export function C(): Constants {
  if (!constantsCache) {
    throw new Error('constants read before Core.init() — call it first')
  }
  return constantsCache
}

export class Core {
  private readonly inner: GameCore
  private readonly memory: WebAssembly.Memory
  private view: Uint8Array | null = null
  private metaCache: MapMeta | null = null

  private constructor(inner: GameCore, memory: WebAssembly.Memory) {
    this.inner = inner
    this.memory = memory
  }

  /**
   * `source` overrides where the wasm binary comes from. The browser uses the
   * bundled URL; node tests pass the bytes directly, because `fetch` of a
   * file:// URL is not available there.
   */
  static async init(source?: BufferSource | WebAssembly.Module): Promise<Core> {
    const wasm = await init({ module_or_path: source ?? wasmUrl })
    constantsCache = JSON.parse(constants_json()) as Constants
    return new Core(new GameCore(), wasm.memory)
  }

  generate(seed: bigint, scale: MapScale): void {
    const lo = Number(seed & 0xffffffffn) >>> 0
    const hi = Number((seed >> 32n) & 0xffffffffn) >>> 0
    this.inner.generate(lo, hi, scale)
    this.invalidate()
  }

  loadMask(w: number, h: number, rle: Uint8Array): boolean {
    const ok = this.inner.load_mask(w, h, rle)
    this.invalidate()
    return ok
  }

  private invalidate(): void {
    this.view = null
    this.metaCache = null
  }

  get width(): number {
    return this.inner.width()
  }

  get height(): number {
    return this.inner.height()
  }

  get chunksX(): number {
    return this.inner.chunks_x()
  }

  get chunksY(): number {
    return this.inner.chunks_y()
  }

  get meta(): MapMeta {
    if (!this.metaCache) {
      this.metaCache = JSON.parse(this.inner.meta_json()) as MapMeta
    }
    return this.metaCache
  }

  /**
   * A live view over the mask in WASM memory.
   *
   * Re-acquired whenever the heap has grown. `byteLength === 0` catches an already
   * detached view; comparing `buffer` against `memory.buffer` catches the case
   * where the buffer was swapped but this view has not been touched since.
   */
  maskView(): Uint8Array {
    const v = this.view
    if (v === null || v.byteLength === 0 || v.buffer !== this.memory.buffer) {
      this.view = new Uint8Array(
        this.memory.buffer,
        this.inner.mask_ptr(),
        this.inner.mask_byte_len(),
      )
    }
    return this.view as Uint8Array
  }

  /**
   * Reads the view directly rather than crossing the boundary per pixel: a WASM
   * call per pixel over a 65k-pixel chunk would be unusably slow.
   *
   * Bit order matches `Mask` exactly: `bit = y * w + x`, byte `bit >> 3`,
   * `(byte >> (bit & 7)) & 1`. Rust packs the mask as `u64` words while this reads
   * bytes; on little-endian — every platform that runs a browser — the two agree.
   */
  solidAt(x: number, y: number): boolean {
    const w = this.width
    if (x < 0 || y < 0 || x >= w || y >= this.height) return false
    const bit = y * w + x
    const view = this.maskView()
    return ((view[bit >> 3]! >> (bit & 7)) & 1) !== 0
  }

  carve(cx: number, cy: number, r: number): void {
    this.inner.carve(cx, cy, r)
  }

  takeDirtyChunks(): Uint32Array {
    return this.inner.take_dirty_chunks()
  }

  addPlayer(id: number, x: number, y: number): void {
    this.inner.add_player(id, x, y)
  }

  removePlayer(id: number): void {
    this.inner.remove_player(id)
  }

  applyInput(id: number, seq: number, buttons: number, aim: number, dt: number): void {
    this.inner.apply_input(id, seq, buttons, aim, dt)
  }

  setPlayerState(id: number, s: PlayerState): void {
    this.inner.set_player_state(id, s.x, s.y, s.vx, s.vy, s.grounded, s.fuel)
  }

  playerState(id: number): PlayerState | null {
    const a = this.inner.player_state(id)
    if (a.length < 7) return null
    return {
      x: a[0]!,
      y: a[1]!,
      vx: a[2]!,
      vy: a[3]!,
      grounded: a[4]! !== 0,
      fuel: a[5]!,
      moveState: a[6]!,
    }
  }

  maskHash(): Uint8Array {
    return this.inner.mask_hash()
  }

  maskRle(): Uint8Array {
    return this.inner.mask_rle()
  }
}
