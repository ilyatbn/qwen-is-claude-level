/**
 * Chunk placement and the rebake budget.
 *
 * Two things here are the difference between a renderer that survives a round and
 * one that does not:
 *
 * - **Texture keys carry a map generation.** Phaser's texture manager is global, so
 *   reusing a key across a regenerate leaves the old pixels in place and the new
 *   map shows fragments of the old one.
 * - **`destroy()` removes every texture.** Without it, regenerating twenty times in
 *   the sandbox leaks a hundred megabytes of canvas and the tab dies.
 *
 * See `docs/12-map-render.md` §1, §5, §6.
 */

import type { Core } from '../core'
import { C } from '../core'
import { BackdropMask, BakeScratch, bakeChunk } from './chunkBake'

/** The slice of Phaser this needs, so tests can stub it without importing Phaser. */
export interface TextureHost {
  exists(key: string): boolean
  addCanvas(key: string, canvas: HTMLCanvasElement): Phaser.Textures.CanvasTexture | null
  remove(key: string): void
}

export interface ImageHost {
  add(x: number, y: number, key: string): { setOrigin(x: number, y: number): unknown; destroy(): void }
}

/**
 * The two DOM/canvas touch points, injectable so the scheduling and lifecycle can
 * be tested in node without a canvas (`docs/70-amendments-v2.md` §A8).
 */
export interface TerrainDeps {
  createCanvas(size: number): HTMLCanvasElement
  bake(
    texture: Phaser.Textures.CanvasTexture,
    chunkX: number,
    chunkY: number,
  ): void
}

export interface TerrainStats {
  bakesThisFrame: number
  lastBakeMs: number
  totalBakeMs: number
  /** `buildAll` split: the mask-only backdrop pass... */
  backdropMs: number
  /** ...and the loop that allocates canvases and bakes into them. */
  chunkBakeMs: number
  pending: number
  chunkCount: number
}

let generationCounter = 0

export class TerrainRenderer {
  private readonly textures: TextureHost
  private readonly images: ImageHost
  private readonly core: Core
  private readonly fill: CanvasImageSource | null
  private readonly edge: CanvasImageSource | null
  private readonly back: CanvasImageSource | null
  private scratch: BakeScratch | undefined
  /** The dilated silhouette: where the cave backdrop shows. */
  private snapshot: BackdropMask | undefined

  private readonly generation: number
  private readonly keys: string[] = []
  private readonly sprites: Array<{ destroy(): void }> = []
  private readonly textureByChunk = new Map<number, Phaser.Textures.CanvasTexture>()
  /** A Set, so repeated markDirty for the same chunk before it bakes collapses. */
  private readonly pending = new Set<number>()

  readonly stats: TerrainStats = {
    bakesThisFrame: 0,
    lastBakeMs: 0,
    totalBakeMs: 0,
    backdropMs: 0,
    chunkBakeMs: 0,
    pending: 0,
    chunkCount: 0,
  }

  private readonly deps: TerrainDeps

  constructor(
    textures: TextureHost,
    images: ImageHost,
    core: Core,
    fill: CanvasImageSource | null,
    edge: CanvasImageSource | null,
    deps?: Partial<TerrainDeps>,
    back: CanvasImageSource | null = null,
  ) {
    this.textures = textures
    this.images = images
    this.core = core
    this.fill = fill
    this.edge = edge
    this.back = back
    this.generation = ++generationCounter

    // The real implementations touch the DOM; a test supplies stubs.
    this.deps = {
      createCanvas:
        deps?.createCanvas ??
        ((size: number) => {
          const canvas = document.createElement('canvas')
          canvas.width = size
          canvas.height = size
          return canvas
        }),
      bake:
        deps?.bake ??
        ((texture, cx, cy) => {
          this.scratch ??= new BakeScratch()
          if (!this.fill) return
          bakeChunk(
            texture,
            {
              fill: this.fill,
              edge: this.edge,
              back: this.back,
              backSource: this.snapshot ?? null,
            },
            cx,
            cy,
            this.core,
            this.scratch,
          )
        }),
    }
  }

  get chunksX(): number {
    return this.core.chunksX
  }

  get chunksY(): number {
    return this.core.chunksY
  }

  private key(cx: number, cy: number): string {
    return `terrain_${this.generation}_${cx}_${cy}`
  }

  /** Create one CanvasTexture + Image per chunk and bake them all. Round start. */
  buildAll(): void {
    const size = C().CHUNK_SIZE
    const t0 = now()

    // The backdrop silhouette, computed once from the pristine mask.
    this.snapshot = new BackdropMask(
      this.core,
      undefined,
      C().SKY_MARGIN,
      C().BACKDROP_RAYS,
      C().BACKDROP_RAY_LEN,
      C().BACKDROP_MIN_HITS,
      C().BACKDROP_MIN_UP,
      C().BACKDROP_MAX_DIST_TO_SOLID,
      C().BACKDROP_MIN_ROOF,
    )
    // Split, because the two halves are different kinds of work and only one of
    // them is stable. `backdropMs` is pure CPU over the mask; the chunk loop
    // allocates canvases and hands them to the renderer. When the total moves
    // and this does not, the cost is not in our arithmetic (T9.07).
    this.stats.backdropMs = now() - t0
    const tChunks = now()

    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cx = 0; cx < this.chunksX; cx++) {
        const key = this.key(cx, cy)
        const texture = this.textures.addCanvas(key, this.deps.createCanvas(size))
        if (!texture) continue

        this.keys.push(key)
        this.textureByChunk.set(cy * this.chunksX + cx, texture)

        const sprite = this.images.add(cx * size, cy * size, key)
        sprite.setOrigin(0, 0)
        this.sprites.push(sprite)

        this.deps.bake(texture, cx, cy)
      }
    }

    this.stats.chunkCount = this.keys.length
    this.stats.chunkBakeMs = now() - tChunks
    this.stats.totalBakeMs = now() - t0
  }

  /** Queue chunks the core reported dirty. Out-of-range ids are ignored. */
  markDirty(chunkIds: ArrayLike<number>): void {
    const max = this.chunksX * this.chunksY
    for (let i = 0; i < chunkIds.length; i++) {
      const id = chunkIds[i]!
      if (id >= 0 && id < max) this.pending.add(id)
    }
    this.stats.pending = this.pending.size
  }

  /**
   * Bake at most `CHUNK_REBAKE_BUDGET` chunks, nearest the camera first.
   *
   * A meteor shower dirties a dozen chunks in a tick; spreading them over three
   * frames is invisible, doing them all at once is a 40 ms spike. Off-screen chunks
   * are still rebaked — they are cheap and it avoids a pop when the camera pans —
   * but the distance ordering puts them last.
   */
  update(cameraCenter: { x: number; y: number }): void {
    this.stats.bakesThisFrame = 0
    if (this.pending.size === 0) {
      this.stats.pending = 0
      return
    }

    const size = C().CHUNK_SIZE
    const budget = C().CHUNK_REBAKE_BUDGET

    const ordered = [...this.pending].sort((a, b) => this.dist(a, cameraCenter, size) - this.dist(b, cameraCenter, size))

    const t0 = now()
    for (const id of ordered.slice(0, budget)) {
      const texture = this.textureByChunk.get(id)
      this.pending.delete(id)
      if (!texture) continue
      const cx = id % this.chunksX
      const cy = Math.floor(id / this.chunksX)
      this.deps.bake(texture, cx, cy)
      this.stats.bakesThisFrame++
    }
    this.stats.lastBakeMs = now() - t0
    this.stats.pending = this.pending.size
  }

  private dist(id: number, camera: { x: number; y: number }, size: number): number {
    const cx = (id % this.chunksX) * size + size / 2
    const cy = Math.floor(id / this.chunksX) * size + size / 2
    const dx = cx - camera.x
    const dy = cy - camera.y
    return dx * dx + dy * dy
  }

  /** Free every texture and Image. The single most important method here. */
  destroy(): void {
    for (const sprite of this.sprites) sprite.destroy()
    this.sprites.length = 0
    for (const key of this.keys) this.textures.remove(key)
    this.keys.length = 0
    this.textureByChunk.clear()
    this.pending.clear()
    this.stats.pending = 0
    this.stats.chunkCount = 0
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
