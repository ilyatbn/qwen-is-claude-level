/**
 * T23.06B (F1): `TerrainFields`' lifecycle against a fake core and a fake worker — the paths the
 * browser checks never take: a result arriving after the scene let go (must not install), carves made
 * while the job runs (held, replayed after the install), two carves in one frame, a carve across a
 * chunk border, a worker that fails (F3: main-thread fallback, visibly), version skew (F9), and the
 * page worker terminated when its job is cancelled (F2).
 *
 * The fake core keeps a bit mask and a field buffer whose R byte says "solid when the fields were
 * last computed", which is all `TerrainFields` reads of the fields; `renderFieldsDirty` rewrites the
 * rect grown by the write margin from the mask, as the Rust does. Carve boxes are noted per 256² chunk
 * and clipped to it, as `carve.rs::mark_dirty_box` does.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Core, renderFieldsReadMargin } from '../core'
import { TerrainFields, pageWorkerHost, type FieldsCore, type FieldsHost } from './terrainFields'
import type { FieldsJob, FieldsResult } from './fieldsWorker'

const W = 768
const H = 512
const CHUNK = 256
/** `render_fields.rs::WRITE_MARGIN`. */
const WRITE = 64

beforeAll(async () => {
  // `mergeRects` reads the read margin from the wasm (F11), so the wasm must be up.
  const bytes = readFileSync(fileURLToPath(new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)))
  await Core.init(bytes)
})

class FakeCore implements FieldsCore {
  readonly width = W
  readonly height = H
  mask = new Uint8Array(Math.ceil((W * H) / 8))
  fields: Uint8Array = new Uint8Array(W * H * 4)
  din = new Uint16Array(W * H)
  /** Per chunk id, the union of carve boxes in it (`carve.rs::CarveBoxes`). */
  boxes = new Map<number, number[]>()
  installs = 0
  fulls = 0
  dirtyCalls: number[][] = []
  /** The mask as the job's copy saw it. */
  snapshot: Uint8Array | null = null

  constructor() {
    // Ground from row 300 down.
    for (let y = 300; y < H; y++) for (let x = 0; x < W; x++) this.set(x, y, true)
  }
  solid(x: number, y: number): boolean {
    const i = y * W + x
    return ((this.mask[i >> 3]! >> (i & 7)) & 1) !== 0
  }
  set(x: number, y: number, on: boolean): void {
    const i = y * W + x
    if (on) this.mask[i >> 3]! |= 1 << (i & 7)
    else this.mask[i >> 3]! &= ~(1 << (i & 7))
  }
  /** A crater: clears the disc and notes its box per chunk, clipped (`mark_dirty_box`). */
  carve(cx: number, cy: number, r: number): number[] {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x >= 0 && y >= 0 && x < W && y < H && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.set(x, y, false)
      }
    }
    const ids: number[] = []
    for (let by = Math.floor(Math.max(0, cy - r) / CHUNK); by <= Math.floor(Math.min(H - 1, cy + r) / CHUNK); by++) {
      for (let bx = Math.floor(Math.max(0, cx - r) / CHUNK); bx <= Math.floor(Math.min(W - 1, cx + r) / CHUNK); bx++) {
        const [x0, y0] = [bx * CHUNK, by * CHUNK]
        const b = [Math.max(cx - r, x0), Math.max(cy - r, y0), Math.min(cx + r, x0 + CHUNK - 1), Math.min(cy + r, y0 + CHUNK - 1)]
        const id = by * Math.ceil(W / CHUNK) + bx
        const e = this.boxes.get(id)
        this.boxes.set(id, e ? [Math.min(e[0]!, b[0]!), Math.min(e[1]!, b[1]!), Math.max(e[2]!, b[2]!), Math.max(e[3]!, b[3]!)] : b)
        ids.push(id)
      }
    }
    return ids
  }
  /** Fields computed from `mask` (R = solid). */
  fieldsOf(mask: Uint8Array): Uint8Array {
    const f = new Uint8Array(W * H * 4)
    for (let i = 0; i < W * H; i++) f[i * 4] = (mask[i >> 3]! >> (i & 7)) & 1 ? 1 : 0
    return f
  }
  /** Px whose fields disagree with the mask now. */
  stale(): number {
    let n = 0
    for (let i = 0; i < W * H; i++) if (((this.mask[i >> 3]! >> (i & 7)) & 1) !== (this.fields[i * 4]! > 0 ? 1 : 0)) n++
    return n
  }
  maskRle(): Uint8Array {
    this.snapshot = this.mask.slice()
    return new Uint8Array(8)
  }
  maskView(): Uint8Array {
    return this.mask
  }
  renderFieldsView(): Uint8Array {
    return this.fields
  }
  renderFieldsDin2View(): Uint16Array {
    return this.din
  }
  renderFieldsDirty(x: number, y: number, w: number, h: number): number[] {
    this.dirtyCalls.push([x, y, w, h])
    const x0 = Math.max(0, x - WRITE)
    const y0 = Math.max(0, y - WRITE)
    const x1 = Math.min(W, x + w + WRITE)
    const y1 = Math.min(H, y + h + WRITE)
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.fields[(yy * W + xx) * 4] = this.solid(xx, yy) ? 1 : 0
    return [x0, y0, x1 - x0, y1 - y0]
  }
  renderFieldsInstall(_wall: Uint32Array, rgba: Uint8Array, _din2: Uint16Array): number[] {
    this.installs++
    this.fields = new Uint8Array(rgba)
    return [0, 0, W, H]
  }
  renderFieldsFull(): number[] {
    this.fulls++
    this.fields = this.fieldsOf(this.mask)
    return [0, 0, W, H]
  }
  takeCarveBoxes(): Int32Array {
    const b = Int32Array.from([...this.boxes.values()].flat())
    this.boxes.clear()
    return b
  }
}

/** A worker that runs nothing until the test delivers its result. */
class FakeHost implements FieldsHost {
  job: FieldsJob | null = null
  onResult: ((r: FieldsResult) => void) | null = null
  cancelled = 0
  run(job: FieldsJob, _t: Transferable[], onResult: (r: FieldsResult) => void): () => void {
    this.job = job
    this.onResult = onResult
    return () => {
      this.cancelled++
    }
  }
  /** The worker's answer, computed from the mask as the job's copy saw it. */
  deliver(core: FakeCore, extra: Partial<{ strays: number }> = {}): void {
    const rgba = core.fieldsOf(core.snapshot!)
    this.onResult!({ id: this.job!.id, ok: true, wall: new Uint32Array(2 * Math.ceil((W * H) / 32)), rgba, din2: new Uint16Array(W * H), strays: extra.strays ?? 0, ms: 1 })
  }
}

const KEY = [1, 0, 0, 1, 0]

describe('TerrainFields (F1)', () => {
  it('a result that arrives after dispose is not installed, and the job is cancelled', () => {
    const core = new FakeCore()
    const host = new FakeHost()
    const f = new TerrainFields(core, KEY, host)
    f.dispose()
    expect(host.cancelled).toBe(1)
    host.deliver(core)
    expect(core.installs).toBe(0)
    expect(f.ready).toBe(false)
    expect(f.view()).toBeNull()
  })

  it('carves made while the job runs are held, then replayed after the install', () => {
    const core = new FakeCore()
    const host = new FakeHost()
    const f = new TerrainFields(core, KEY, host)
    f.noteDirtyChunks(core.carve(400, 300, 40))
    expect(core.dirtyCalls).toHaveLength(0) // nothing to update before the fields are in
    host.deliver(core)
    expect(core.installs).toBe(1)
    expect(f.stats.replayed).toBe(1)
    expect(core.dirtyCalls).toHaveLength(1)
    expect(core.stale()).toBe(0)
    // The install is a full upload, so the replayed rect is not queued twice.
    expect(f.take()).toMatchObject({ full: true, rects: [] })
  })

  it('two carves in one frame: far apart, two tight updates; close, one', () => {
    const core = new FakeCore()
    const host = new FakeHost()
    const f = new TerrainFields(core, KEY, host)
    host.deliver(core)
    f.take()
    const ids = [...core.carve(100, 320, 12), ...core.carve(650, 320, 12)]
    f.noteDirtyChunks(ids)
    expect(core.dirtyCalls).toHaveLength(2)
    for (const [, , w, h] of core.dirtyCalls) expect(w! * h!).toBeLessThanOrEqual(25 * 25)
    expect(core.stale()).toBe(0)
    expect(f.take().rects).toHaveLength(2)
    core.dirtyCalls = []
    f.noteDirtyChunks([...core.carve(300, 330, 10), ...core.carve(340, 330, 10)])
    expect(core.dirtyCalls).toHaveLength(1)
    expect(core.stale()).toBe(0)
    // F7: the one chunk's union box (x 290..350, y 320..340), not the 256² chunk.
    expect(f.stats.lastDiffPx).toBe(61 * 21)
  })

  it('a carve across a chunk border is one update covering both sides', () => {
    const core = new FakeCore()
    const host = new FakeHost()
    const f = new TerrainFields(core, KEY, host)
    host.deliver(core)
    f.take()
    const ids = core.carve(CHUNK, 310, 20)
    expect(ids).toHaveLength(2)
    f.noteDirtyChunks(ids)
    expect(core.dirtyCalls).toHaveLength(1)
    const [x, , w] = core.dirtyCalls[0]!
    expect(x).toBeLessThan(CHUNK)
    expect(x! + w!).toBeGreaterThan(CHUNK)
    expect(core.stale()).toBe(0)
  })

  it('F3: a failed worker falls back to the main thread — ready, and it says so', () => {
    const core = new FakeCore()
    const host = new FakeHost()
    const f = new TerrainFields(core, KEY, host)
    f.noteDirtyChunks(core.carve(400, 300, 30))
    host.onResult!({ id: host.job!.id, ok: false, error: 'boom' })
    expect(core.fulls).toBe(1)
    expect(f.ready).toBe(true)
    expect(core.stale()).toBe(0)
    expect(f.stats.warning).toMatch(/main thread.*boom/)
    // Control: a good result carries no warning.
    const c2 = new FakeCore()
    const h2 = new FakeHost()
    const g = new TerrainFields(c2, KEY, h2)
    h2.deliver(c2)
    expect(g.stats.warning).toBe('')
  })

  it('T23.08C F8: a single-length worker result (one half, no hard part) falls back and says got/want', () => {
    const core = new FakeCore()
    const host = new FakeHost()
    const f = new TerrainFields(core, KEY, host)
    const half = Math.ceil((W * H) / 32)
    host.onResult!({ id: host.job!.id, ok: true, wall: new Uint32Array(half), rgba: core.fieldsOf(core.snapshot!), din2: new Uint16Array(W * H), strays: 0, ms: 1 })
    expect(core.installs).toBe(0)
    expect(core.fulls).toBe(1)
    expect(f.ready).toBe(true)
    expect(f.stats.warning).toContain(`${half} long, want ${2 * half}`)
    // Control: the doubled length installs, with no warning.
    const c2 = new FakeCore()
    const h2 = new FakeHost()
    const g = new TerrainFields(c2, KEY, h2)
    h2.deliver(c2)
    expect(c2.installs).toBe(1)
    expect(g.stats.warning).toBe('')
  })

  it('F9: version skew is reported', () => {
    const core = new FakeCore()
    const host = new FakeHost()
    const f = new TerrainFields(core, KEY, host)
    host.deliver(core, { strays: 400 })
    expect(f.ready).toBe(true)
    expect(f.stats.strays).toBe(400)
    expect(f.stats.warning).toMatch(/version skew: 400/)
  })

  it('merges with the wasm read margin (F11: imported, not copied)', () => {
    expect(renderFieldsReadMargin()).toBe(128)
  })
})

/** A `Worker` stand-in: records posts and terminations; `reply` answers the last job. */
class FakeWorker {
  static made: FakeWorker[] = []
  onmessage: ((e: MessageEvent<FieldsResult>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  jobs: FieldsJob[] = []
  terminated = false
  constructor() {
    FakeWorker.made.push(this)
  }
  postMessage(job: FieldsJob): void {
    this.jobs.push(job)
  }
  terminate(): void {
    this.terminated = true
  }
  reply(r: FieldsResult): void {
    this.onmessage?.({ data: r } as MessageEvent<FieldsResult>)
  }
}

describe('pageWorkerHost (F2)', () => {
  const job = (id: number): FieldsJob => ({ id, w: 1, h: 1, rle: new Uint8Array(1), key: KEY })

  it('a cancelled job terminates its worker, and the next job runs on the spare made before it', () => {
    FakeWorker.made = []
    const host = pageWorkerHost(() => new FakeWorker() as unknown as Worker)
    const got: FieldsResult[] = []
    const cancelA = host.run(job(1), [], (r) => got.push(r))
    expect(FakeWorker.made).toHaveLength(2) // the worker, and a warm spare
    cancelA()
    expect(FakeWorker.made[0]!.terminated).toBe(true)
    expect(host.restarts).toBe(1)
    host.run(job(2), [], (r) => got.push(r))
    // Job 2 went to the spare that existed before the cancel — no worker made on demand for it.
    expect(FakeWorker.made[1]!.jobs.map((j) => j.id)).toEqual([2])
    expect(FakeWorker.made).toHaveLength(3)
    // Control: cancelling a job whose answer already came terminates nothing.
    const cancelC = host.run(job(3), [], (r) => got.push(r))
    FakeWorker.made[1]!.reply({ id: 3, ok: false, error: 'x' })
    cancelC()
    expect(FakeWorker.made[1]!.terminated).toBe(false)
    expect(got.map((r) => r.id)).toEqual([3])
  })

  it('a worker that fails to start fails its jobs (the feeds fall back — F3), and a failed spare is not promoted', () => {
    FakeWorker.made = []
    const host = pageWorkerHost(() => new FakeWorker() as unknown as Worker)
    const got: FieldsResult[] = []
    host.run(job(9), [], (r) => got.push(r))
    const fail = (w: FakeWorker): void => w.onerror!({ message: 'no module workers', preventDefault: () => {} } as unknown as ErrorEvent)
    fail(FakeWorker.made[1]!) // the spare dies first
    fail(FakeWorker.made[0]!)
    expect(got).toEqual([{ id: 9, ok: false, error: 'fields worker: no module workers' }])
    host.run(job(10), [], (r) => got.push(r))
    expect(FakeWorker.made[1]!.jobs).toHaveLength(0)
    expect(FakeWorker.made[2]!.jobs.map((j) => j.id)).toEqual([10])
  })
})
