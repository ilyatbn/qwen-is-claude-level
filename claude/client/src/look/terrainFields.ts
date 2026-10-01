/**
 * T23.06: the terrain fields a scene feeds the world renderer — T23.05's buffer, kept current.
 *
 * **Round start, off the frame.** The landform derive (T23.05B) and the full field pass cost ~1.6 s
 * on a Large map (wasm, release, SwiftShader box); both run in `fieldsWorker.ts` on a copy of the
 * map, and the result is installed here (`renderFieldsInstall`, one copy across the boundary).
 * **Carves made meanwhile** are held as their boxes; after the install they are diffed like any
 * other (below), which is exact because incremental == full (`render_fields.rs`).
 *
 * **Carves, by the boxes the core reports** (T23.06B F7). `TerrainRenderer.markDirty` is the one
 * place every carve reaches the renderer, whoever made it (`worldView.ts`'s drain), so the hook is
 * there; it then takes the core's carve boxes (`takeCarveBoxes`: per dirty chunk, the box of what
 * carves touched in it) and diffs only those — the mask now against the fields' own solid bit
 * (`dIn > 0`) — so a bullet's 7² px box is read, not the 256² chunk around it. Only the bounding
 * box of what changed goes to `renderFieldsDirty`; rects closer than the fields' read margin merge.
 *
 * **Never absent (F3), never stale (F1/F2).** A disposed feed ignores a late result and cancels its
 * job — the page's worker is terminated and made again, so the next map's job does not queue behind
 * a stale one. A worker that fails is replaced by the full pass on the main thread with "was rock" =
 * the mask: a hitch and no generated cave walls, but a terrain, and `stats.warning` says so (the
 * scenes' `debug()` carries it). A version-skewed landform (F9) is reported the same way.
 */
import { renderFieldsReadMargin, wasmModule } from '../core'
import type { FieldsJob, FieldsResult, FieldsWarm } from './fieldsWorker'
import type { Rect } from './terrainGpu'
import { albedoOffset } from './albedo'

/** What the world renderer reads (plain data, R11): the buffer and what changed in it. */
export interface TerrainFeed {
  readonly w: number
  readonly h: number
  /** Names the map (`map_init`'s key and the size): a same-map resync keeps the GPU side (F3). */
  readonly mapKey: string
  /** R24 (T23.07B F2): the albedo's per-map offset (`albedo.ts::albedoOffset` of the map seed); (0, 0) in the look-lab. */
  readonly albedoOffset: readonly [number, number]
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

/** What the fields read of the game core — `Core`'s own methods; a fake in the tests. */
export interface FieldsCore {
  readonly width: number
  readonly height: number
  maskRle(): Uint8Array
  maskView(): Uint8Array
  renderFieldsView(): Uint8Array
  renderFieldsDin2View(): Uint16Array
  renderFieldsDirty(x: number, y: number, w: number, h: number): number[]
  renderFieldsInstall(wall: Uint32Array, rgba: Uint8Array, din2: Uint16Array): number[]
  renderFieldsFull(): number[]
  takeCarveBoxes(): Int32Array
}

/** Runs a fields job somewhere; returns the job's cancel. `onResult` is called at most once. */
export interface FieldsHost {
  run(job: FieldsJob, transfer: Transferable[], onResult: (r: FieldsResult) => void): () => void
}

/**
 * A blast's scorch radius per unit of its carve radius: `mockup-src/maps.js::ARENA_E`, whose fresh
 * crater (r 50) carries F1's scorch (r 80). Render-only.
 */
export const SCORCH_PER_BLAST_R = 80 / 50


/** A new fields worker, warmed: it instantiates the main thread's compiled wasm before any job (F2). */
function spawnFieldsWorker(): Worker {
  const w = new Worker(new URL('./fieldsWorker.ts', import.meta.url), { type: 'module' })
  const module = wasmModule()
  const warm: FieldsWarm = module ? { warm: true, module } : { warm: true }
  w.postMessage(warm)
  return w
}

/**
 * The page's fields worker (T23.06B F2): one job at a time; a job cancelled while it runs
 * **terminates** the worker, so a rematch or resync never waits for a dead map's ~1.6 s. **A warm
 * spare** takes its place: measured, a worker made on demand after a terminate cost ~400 ms (spawn,
 * module graph, wasm instantiate) before its job began — more than a stale job usually had left, so
 * terminating was slower than queueing — hence the next worker is made ahead, whenever one is
 * promoted. Any other job still waiting on a terminated or failed worker is failed, and its feed
 * falls back (F3). A spare that failed to start is never promoted.
 */
export function pageWorkerHost(make: () => Worker = spawnFieldsWorker): FieldsHost & { restarts: number } {
  interface Slot {
    w: Worker
    failed: string | null
  }
  let active: Slot | null = null
  let spare: Slot | null = null
  const waiting = new Map<number, (r: FieldsResult) => void>()
  const failAll = (error: string): void => {
    const all = [...waiting]
    waiting.clear()
    for (const [id, cb] of all) cb({ id, ok: false, error })
  }
  const slot = (): Slot => {
    const s: Slot = { w: make(), failed: null }
    s.w.onmessage = (e: MessageEvent<FieldsResult>): void => {
      if (active !== s) return
      const cb = waiting.get(e.data.id)
      waiting.delete(e.data.id)
      cb?.(e.data)
    }
    s.w.onerror = (e: ErrorEvent): void => {
      e.preventDefault()
      // A worker that errored (a module that would not load) is not reused.
      s.failed = `fields worker: ${e.message || 'failed to start'}`
      s.w.terminate()
      if (active === s) {
        active = null
        failAll(s.failed)
      }
      if (spare === s) spare = null
    }
    return s
  }
  const host = {
    restarts: 0,
    run(job: FieldsJob, transfer: Transferable[], onResult: (r: FieldsResult) => void): () => void {
      if (!active) {
        active = spare && !spare.failed ? spare : slot()
        spare = null
      }
      spare ??= slot()
      const mine = active
      waiting.set(job.id, onResult)
      mine.w.postMessage(job, transfer)
      return () => {
        if (!waiting.delete(job.id) || active !== mine) return
        mine.w.terminate()
        active = null
        host.restarts++
        failAll('fields worker restarted')
      }
    },
  }
  return host
}

let pageHost: FieldsHost | null = null
let nextJob = 1

/**
 * Merge rects whose read neighbourhoods touch: `render_fields.rs::READ_MARGIN` (imported from the
 * wasm, T23.06B F11) — rects nearer than that share reads, so one `renderFieldsDirty` serves both.
 */
export function mergeRects(rs: Rect[], m: number = renderFieldsReadMargin()): Rect[] {
  const out = rs.map((r) => ({ ...r }))
  for (let merged = true; merged; ) {
    merged = false
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        const a = out[i]!
        const b = out[j]!
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
  readonly mapKey: string
  readonly albedoOffset: readonly [number, number]
  ready = false
  readonly stats = {
    jobMs: NaN,
    workerMs: NaN,
    installMs: NaN,
    /** Carve boxes held while the job ran and replayed after the install. */
    replayed: 0,
    carves: 0,
    lastCarveMs: NaN,
    maxCarveMs: 0,
    /** Px diffed by the last carve update (F7: its boxes, not whole chunks). */
    lastDiffPx: 0,
    /** Wasm memory around the install, MB (F6). */
    memBeforeMB: NaN,
    memAfterMB: NaN,
    /** F9: mask px outside the re-derived landform (0 on a matching build). */
    strays: 0,
    error: '',
    /** Why the picture is not the full one (worker failed → main-thread fallback; version skew). Empty when it is. */
    warning: '',
  }
  private full = false
  private rects: Rect[] = []
  private scorches: [number, number, number][] = []
  private held: Rect[] = []
  private disposed = false
  private cancel: (() => void) | null = null

  /**
   * @param key `[seed_lo, seed_hi, scale, generator, theme, shape]` — `map_init`'s, or `renderFieldsOwnKey()` for a local map.
   * @param host where the job runs — the page's worker; a fake in the tests.
   */
  constructor(
    private readonly core: FieldsCore,
    key: number[],
    host: FieldsHost = (pageHost ??= pageWorkerHost()),
  ) {
    this.w = core.width
    this.h = core.height
    this.mapKey = `${key.join(',')}@${this.w}x${this.h}`
    this.albedoOffset = albedoOffset(key[0] ?? 0, key[1] ?? 0)
    // Boxes from before this map's fields exist (the map build, a previous map) are not carves on it.
    core.takeCarveBoxes()
    const job: FieldsJob = { id: nextJob++, w: this.w, h: this.h, rle: core.maskRle(), key }
    const t0 = performance.now()
    try {
      this.cancel = host.run(job, [job.rle.buffer], (r) => this.installed(r, t0))
    } catch (e) {
      this.fallBack(`worker: ${String(e)}`)
    }
  }

  view(): Uint8Array | null {
    return this.ready && !this.disposed ? this.core.renderFieldsView() : null
  }

  din2(): Uint16Array | null {
    return this.ready && !this.disposed ? this.core.renderFieldsDin2View() : null
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

  /**
   * `TerrainRenderer.markDirty`'s hook: chunks were dirtied, so the core has carve boxes to take.
   * Only the boxes are read (F7); the ids say that there are some.
   */
  noteDirtyChunks(ids: ArrayLike<number>): void {
    if (this.disposed || ids.length === 0) return
    const boxes = this.takeBoxes()
    if (!this.ready) {
      this.held = this.held.concat(boxes)
      return
    }
    this.update(boxes)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // F2: a job still running for a dead map is cancelled — the worker is terminated.
    this.cancel?.()
    this.cancel = null
  }

  private takeBoxes(): Rect[] {
    const b = this.core.takeCarveBoxes()
    const out: Rect[] = []
    for (let i = 0; i + 3 < b.length; i += 4) {
      const x0 = Math.max(0, b[i]!)
      const y0 = Math.max(0, b[i + 1]!)
      const x1 = Math.min(this.w - 1, b[i + 2]!)
      const y1 = Math.min(this.h - 1, b[i + 3]!)
      if (x1 >= x0 && y1 >= y0) out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 })
    }
    return out
  }

  /** Diff `boxes` against the fields, rewrite what changed, queue the rects for the GPU. */
  private update(boxes: Rect[]): void {
    const t0 = performance.now()
    const changed: Rect[] = []
    let px = 0
    for (const b of boxes) {
      const r = this.diff(b)
      px += b.w * b.h
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
      this.stats.lastDiffPx = px
      this.stats.maxCarveMs = Math.max(this.stats.maxCarveMs, ms)
    }
  }

  /** The bounding box of the px in `b` whose solidity differs from the fields' — `null` if none. */
  private diff(b: Rect): Rect | null {
    const mask = this.core.maskView()
    const f = this.core.renderFieldsView()
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -1
    let y1 = -1
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
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

  /** F3: the worker could not give us the fields — the full pass here, "was rock" = the mask. */
  private fallBack(why: string): void {
    this.cancel = null
    this.stats.error = why
    this.stats.warning = `terrain fields computed on the main thread (${why}); generated caves show no wall`
    console.warn('terrain fields:', this.stats.warning)
    const t1 = performance.now()
    this.core.renderFieldsFull()
    this.stats.installMs = performance.now() - t1
    this.held = [] // the pass read the mask as it is now: every held carve is in it
    this.ready = true
    this.full = true
  }

  private installed(r: FieldsResult, t0: number): void {
    this.cancel = null
    if (this.disposed) return
    if (!r.ok) {
      this.fallBack(r.error)
      return
    }
    // T23.07C: the wall words are two equal halves, all "was rock" then its hard part (`render_fields.rs::wall_words`).
    const want = 2 * Math.ceil((this.core.width * this.core.height) / 32)
    if (r.wall.length !== want) {
      // The core's map changed size under the job (a scene that forgot to dispose us), or a worker built
      // before T23.07C handed back one half: never absent, and the warning says which numbers disagreed.
      this.fallBack(`the worker's wall words are ${r.wall.length} long, want ${want} (2 halves of ${want / 2})`)
      return
    }
    const t1 = performance.now()
    const mem = (): number => (this.core as Partial<{ memoryBytes(): number }>).memoryBytes?.() ?? NaN
    this.stats.memBeforeMB = mem() / 2 ** 20
    this.core.renderFieldsInstall(r.wall, r.rgba, r.din2)
    this.stats.memAfterMB = mem() / 2 ** 20
    this.ready = true
    this.full = true
    this.stats.installMs = performance.now() - t1
    this.stats.workerMs = r.ms
    this.stats.jobMs = performance.now() - t0
    this.stats.strays = r.strays
    if (r.strays > 0) {
      this.stats.warning = `version skew: ${r.strays} mask px outside the re-derived landform — cave wall = the mask`
      console.warn('terrain fields:', this.stats.warning)
    }
    const held = this.held
    this.held = []
    this.stats.replayed = held.length
    this.update(held)
    this.rects = [] // the full upload the renderer does next covers them
  }
}
