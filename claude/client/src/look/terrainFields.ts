/**
 * T23.06: the terrain fields a scene feeds the world renderer — T23.05's buffer, kept current.
 *
 * **Round start, off the frame.** The landform derive (T23.05B) and the full field pass cost ~1.1 s
 * on a Large map (wasm, release); both run in `fieldsWorker.ts` on a copy of the map, and the
 * result is installed here (`renderFieldsInstall`, one memcpy). **Carves made meanwhile** are the
 * dirty chunks noted while the job ran; after the install they are diffed like any other (below),
 * which is exact because incremental == full (`render_fields.rs`).
 *
 * **Carves, by the chunks the core reports.** `TerrainRenderer.markDirty` is the one place every
 * carve reaches the renderer, whoever made it (`worldView.ts`'s drain), so the hook is there. A
 * chunk is 256 px, and a dirty rect that size costs far more than the crater in it; so each dirty
 * chunk is diffed — the mask now against the fields' own solid bit (`dIn > 0`) — and only the
 * bounding box of what changed goes to `renderFieldsDirty`. Rects closer than the fields' read
 * margin are merged first.
 */
import { C, type Core } from '../core'
import type { FieldsJob, FieldsResult } from './fieldsWorker'
import type { Rect } from './terrainGpu'

/** What the world renderer reads (plain data, R11): the buffer and what changed in it. */
export interface TerrainFeed {
  readonly w: number
  readonly h: number
  readonly ready: boolean
  /** Dev: what the feed measured (the worker job, the install, carve updates). */
  readonly stats?: Readonly<Record<string, number | string>>
  /** A fresh view of the field buffer (F9 — never kept), or null before the install. */
  view(): Uint8Array | null
  /** A fresh view of the exact `dIn²` buffer (the albedo's), or null before the install. */
  din2(): Uint16Array | null
  /** Since the last take: `full` (a pass was installed) or the rects rewritten; and the blasts. */
  take(): { full: boolean; rects: Rect[]; scorches: [number, number, number][] }
}

/**
 * A blast's scorch radius per unit of its carve radius: `mockup-src/maps.js::ARENA_E`, whose fresh
 * crater (r 50) carries F1's scorch (r 80). Render-only.
 */
export const SCORCH_PER_BLAST_R = 80 / 50

/** `render_fields.rs::READ_MARGIN`: dirty rects nearer than this share reads, so they merge. */
const MERGE_MARGIN = 128

let worker: Worker | null = null
let nextJob = 1
const waiting = new Map<number, (r: FieldsResult) => void>()

function pageWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./fieldsWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<FieldsResult>): void => {
    const cb = waiting.get(e.data.id)
    waiting.delete(e.data.id)
    cb?.(e.data)
  }
  return worker
}

/** Merge rects whose `MERGE_MARGIN` neighbourhoods touch. */
export function mergeRects(rs: Rect[]): Rect[] {
  const out = rs.map((r) => ({ ...r }))
  for (let merged = true; merged; ) {
    merged = false
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        const a = out[i]!
        const b = out[j]!
        const m = MERGE_MARGIN
        if (a.x - m < b.x + b.w && b.x - m < a.x + a.w && a.y - m < b.y + b.h && b.y - m < a.y + a.h) {
          const x = Math.min(a.x, b.x)
          const y = Math.min(a.y, b.y)
          out[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
          out.splice(j, 1)
          merged = true
        }
      }
    }
  }
  return out
}

export class TerrainFields implements TerrainFeed {
  readonly w: number
  readonly h: number
  ready = false
  readonly stats = { jobMs: NaN, workerMs: NaN, installMs: NaN, replayed: 0, carves: 0, lastCarveMs: NaN, maxCarveMs: 0, error: '' }
  private full = false
  private rects: Rect[] = []
  private scorches: [number, number, number][] = []
  private heldChunks = new Set<number>()
  private disposed = false

  /**
   * @param key `[seed_lo, seed_hi, scale, generator, theme]` — `map_init`'s, or `renderFieldsOwnKey()` for a local map.
   */
  constructor(
    private readonly core: Core,
    key: number[],
  ) {
    this.w = core.width
    this.h = core.height
    const job: FieldsJob = { id: nextJob++, w: this.w, h: this.h, rle: core.maskRle(), key }
    const t0 = performance.now()
    waiting.set(job.id, (r) => this.installed(r, t0))
    try {
      pageWorker().postMessage(job, [job.rle.buffer])
    } catch (e) {
      waiting.delete(job.id)
      this.stats.error = String(e)
    }
  }

  view(): Uint8Array | null {
    return this.ready ? this.core.renderFieldsView() : null
  }

  din2(): Uint16Array | null {
    return this.ready ? this.core.renderFieldsDin2View() : null
  }

  take(): { full: boolean; rects: Rect[]; scorches: [number, number, number][] } {
    const t = { full: this.full, rects: this.rects, scorches: this.scorches }
    this.full = false
    this.rects = []
    this.scorches = []
    return t
  }

  /** A blast of carve radius `r`: scorched on the GPU (the renderer drains these whether or not the fields are in). */
  blast(x: number, y: number, r: number): void {
    if (!this.disposed && r > 0) this.scorches.push([x, y, r * SCORCH_PER_BLAST_R])
  }

  /** `TerrainRenderer.markDirty`'s ids: the chunks a carve touched. */
  noteDirtyChunks(ids: ArrayLike<number>, chunkSize: number): void {
    if (this.disposed || ids.length === 0) return
    if (!this.ready) {
      for (let i = 0; i < ids.length; i++) this.heldChunks.add(ids[i]!)
      return
    }
    const t0 = performance.now()
    const changed: Rect[] = []
    for (let i = 0; i < ids.length; i++) {
      const r = this.diffChunk(ids[i]!, chunkSize)
      if (r) changed.push(r)
    }
    for (const r of mergeRects(changed)) {
      const [x, y, w, h] = this.core.renderFieldsDirty(r.x, r.y, r.w, r.h) as [number, number, number, number]
      this.rects.push({ x, y, w, h })
    }
    if (changed.length) {
      const ms = performance.now() - t0
      this.stats.carves++
      this.stats.lastCarveMs = ms
      this.stats.maxCarveMs = Math.max(this.stats.maxCarveMs, ms)
    }
  }

  dispose(): void {
    this.disposed = true
  }

  /** The bounding box of the px in chunk `id` whose solidity differs from the fields' — `null` if none. */
  private diffChunk(id: number, size: number): Rect | null {
    const cols = Math.ceil(this.w / size)
    const cx0 = (id % cols) * size
    const cy0 = Math.floor(id / cols) * size
    const mask = this.core.maskView()
    const f = this.core.renderFieldsView()
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -1
    let y1 = -1
    for (let y = cy0; y < Math.min(this.h, cy0 + size); y++) {
      for (let x = cx0; x < Math.min(this.w, cx0 + size); x++) {
        const bit = y * this.w + x
        const solid = ((mask[bit >> 3]! >> (bit & 7)) & 1) !== 0
        if (solid !== f[bit * 4]! > 0) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  }

  private installed(r: FieldsResult, t0: number): void {
    if (this.disposed) return
    if (!r.ok) {
      this.stats.error = r.error
      console.warn('terrain fields:', r.error)
      return
    }
    if (r.wall.length !== this.core.width * this.core.height) return // the map changed under the job
    const t1 = performance.now()
    this.core.renderFieldsInstall(r.wall, r.rgba, r.din2)
    this.ready = true
    this.full = true
    this.stats.installMs = performance.now() - t1
    this.stats.workerMs = r.ms
    this.stats.jobMs = performance.now() - t0
    const held = [...this.heldChunks]
    this.heldChunks.clear()
    this.stats.replayed = held.length
    this.noteDirtyChunks(held, C().CHUNK_SIZE)
    this.rects = [] // the full upload the renderer does next covers them
  }
}
