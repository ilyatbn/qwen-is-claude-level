/**
 * The attract mode's core: a whole round running client-side (§B3).
 *
 * Structurally a twin of `Core`, deliberately: the render stack takes anything
 * with this shape, so `WorldView`, `TerrainRenderer` and `CameraRig` are the ones
 * the game uses rather than a second copy that can drift. What it wraps is a real
 * `World` with real `Bot`s, ticked exactly as the server room ticks them.
 */
import type { MapMeta } from './index'

/** The subset of `Core` the render stack actually consumes. */
export interface TerrainSource {
  readonly width: number
  readonly height: number
  readonly chunksX: number
  readonly chunksY: number
  readonly meta: MapMeta
  maskView(): Uint8Array
  solidAt(x: number, y: number): boolean
  takeDirtyChunks(): Uint32Array
}

export interface AttractBot {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  aim: number
  alive: boolean
  /** 0 grounded, 1 airborne, 2 jetpack — the same encoding the game uses. */
  moveState: number
}

/** Fields per bot in the flat array `AttractCore.players()` returns. */
const STRIDE = 8

export class Attract implements TerrainSource {
  private view: Uint8Array | null = null
  private metaCache: MapMeta | null = null
  private stopped = false
  private ticks = 0

  constructor(
    private readonly inner: {
      step(dt: number): void
      tick(): number
      round_time(): number
      mask_ptr(): number
      mask_byte_len(): number
      width(): number
      height(): number
      chunks_x(): number
      chunks_y(): number
      solid_at(x: number, y: number): boolean
      take_dirty_chunks(): Uint32Array
      meta_json(): string
      count_solid(): number
      players(): Float32Array
      focus(): Float32Array
      free?(): void
    },
    private readonly memory: WebAssembly.Memory,
  ) {}

  /**
   * Advance the simulation.
   *
   * A no-op once stopped, and `stopped` is observable through `tickCount` — §A15:
   * the test for "leaving the scene stops it" has to assert that no ticks
   * happened, not that `stop()` was called.
   */
  step(dt: number): void {
    if (this.stopped) return
    this.inner.step(dt)
    this.ticks++
  }

  stop(): void {
    this.stopped = true
  }

  get isStopped(): boolean {
    return this.stopped
  }

  /** Ticks this object has actually run. The evidence, not the intent. */
  get tickCount(): number {
    return this.ticks
  }

  get simTick(): number {
    return this.inner.tick()
  }

  get roundTime(): number {
    return this.inner.round_time()
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

  /** Re-acquired whenever the WASM heap has grown — see `Core.maskView`. */
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

  solidAt(x: number, y: number): boolean {
    const w = this.width
    if (x < 0 || y < 0 || x >= w || y >= this.height) return false
    const bit = y * w + x
    const view = this.maskView()
    return ((view[bit >> 3]! >> (bit & 7)) & 1) !== 0
  }

  takeDirtyChunks(): Uint32Array {
    return this.inner.take_dirty_chunks()
  }

  countSolid(): number {
    return this.inner.count_solid()
  }

  bots(): AttractBot[] {
    return decodeBots(this.inner.players())
  }

  /** Where the camera should look: the bot in the most trouble. */
  focus(): { x: number; y: number } {
    const f = this.inner.focus()
    return { x: f[0] ?? 0, y: f[1] ?? 0 }
  }

  destroy(): void {
    this.stop()
    this.view = null
    this.inner.free?.()
  }
}

/**
 * Flat array → bots. Exported so it is testable without WASM: the packing is
 * shared with Rust by convention, which is exactly the kind of agreement that
 * silently drifts.
 */
export function decodeBots(flat: ArrayLike<number>): AttractBot[] {
  const out: AttractBot[] = []
  for (let i = 0; i + STRIDE <= flat.length; i += STRIDE) {
    out.push({
      id: flat[i]!,
      x: flat[i + 1]!,
      y: flat[i + 2]!,
      vx: flat[i + 3]!,
      vy: flat[i + 4]!,
      aim: flat[i + 5]!,
      alive: flat[i + 6]! !== 0,
      moveState: flat[i + 7]!,
    })
  }
  return out
}
