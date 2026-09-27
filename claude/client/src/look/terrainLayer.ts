/**
 * T23.06/T23.06B: the world renderer's terrain — the scene's fields feed (`terrainFields.ts`) and its
 * GPU side (`terrainGpu.ts`), pumped once per drawn frame. Split out of `WorldRenderer` (T23.06B F11).
 *
 * **The readiness signal T23.07 reads (F3): `ready`** — a whole picture has been painted into this
 * map's GPU side (every field strip up, every albedo tile painted). Until then T23.07 keeps drawing
 * Phaser's rock: the terrain is never absent, only not yet swapped. `pending` is the queued work left.
 *
 * **Made at map change, kept across a same-map resync (F3/F6).** A feed for a new map (its `mapKey`)
 * gets a new GPU side at once — allocated, nothing uploaded — so the install's frame only starts the
 * strip queue. A feed for the **same** map (a resync's second `map_init`) keeps the GPU side: the
 * picture stays up (and `ready` stays true) while the new fields install and repaint it in place,
 * and the scorch mask is kept — **R23: scorch history is cosmetic**, so a client keeps its own, and a
 * late joiner or a client on another map starts with none (it is not on the wire).
 */
import type { WebGLRenderer } from 'three'
import type { TerrainLook } from './scene'
import type { TerrainFeed } from './terrainFields'
import { TerrainGpu } from './terrainGpu'

export class TerrainLayer {
  feed: TerrainFeed | null = null
  gpu: TerrainGpu | null = null
  /** Work units (strip uploads, albedo tiles) done per drawn frame while a full pass is queued. */
  private units = 0
  readonly stats = {
    /** The last dirty update's cost (upload + repaint; with `measure`, until the GPU is done), ms. */
    lastUpdateMs: NaN,
    maxUpdateMs: 0,
    /** The worst `pump` since the feed was set, ms (F6: the install frame, the strips, the tiles). */
    maxPumpMs: 0,
    /** Same-map resyncs that kept the GPU side. */
    kept: 0,
    /** F6: making the GPU side at the map change (allocate, pay the lazy clear, warm both passes), ms of CPU. */
    makeMs: NaN,
  }
  /** Dev: finish each dirty update on the GPU (a 1-px readback) so `lastUpdateMs` includes its work. */
  measure = false
  /** T23.07: the look the low tier's bake is shaded for, or `null` (the full tier: no bake). */
  private bakeLook: TerrainLook | null = null

  constructor(private readonly renderer: WebGLRenderer) {}

  /** Whether this map's picture is whole (see the module comment) — T23.07's switch from Phaser's rock. */
  get ready(): boolean {
    return !!this.gpu?.painted
  }

  get pending(): number {
    return this.gpu?.pending ?? 0
  }

  /** T23.07: the low tier's bake is whole for the current look — its shader may draw. */
  get baked(): boolean {
    return !!this.gpu?.baked
  }

  /**
   * T23.07 (R14): keep a lit bake for `look` (the low tier) or none (`null`). Applied to this GPU side
   * now and to every one made for a later map before its full pass is queued.
   */
  setBake(look: TerrainLook | null): void {
    this.bakeLook = look
    this.gpu?.setBake(look)
  }

  /** Hand over the scene's fields (`null`: none). `units`: work per frame while a full pass is queued. */
  setFeed(feed: TerrainFeed | null, units: number): void {
    const same = !!feed && !!this.gpu && this.feed?.mapKey === feed.mapKey && this.gpu.w === feed.w && this.gpu.h === feed.h
    this.feed = feed
    this.units = units
    this.stats.maxPumpMs = 0
    if (same) {
      this.stats.kept++
      return
    }
    this.gpu?.dispose()
    const t0 = performance.now()
    this.gpu = feed ? new TerrainGpu(this.renderer, feed.w, feed.h) : null
    if (this.gpu && this.bakeLook) this.gpu.setBake(this.bakeLook)
    if (feed) this.stats.makeMs = performance.now() - t0
  }

  /** Apply what changed in the fields since the last frame and do a few queued units; whether anything was drawn. */
  pump(): boolean {
    const t0 = performance.now()
    const changed = this.pumpInner()
    this.stats.maxPumpMs = Math.max(this.stats.maxPumpMs, performance.now() - t0)
    return changed
  }

  private pumpInner(): boolean {
    const feed = this.feed
    const g = this.gpu
    if (!feed || !g) return false
    const t = feed.take()
    if (t.full) g.queueAll()
    const t0 = performance.now()
    for (const r of t.rects) {
      // Fresh views per upload: nothing here allocates in wasm, but a kept view is F9's bug.
      const v = feed.view()
      const d = feed.din2()
      if (!v || !d) continue
      g.uploadFields(v, d, r)
      g.paintNow(r)
    }
    for (const [x, y, r] of t.scorches) g.addScorch(x, y, r)
    if (t.rects.length || t.scorches.length) {
      // Dev: finish the GPU's work before the clock stops, so the number includes it.
      if (this.measure) this.renderer.readRenderTargetPixels(g.albedo, 0, 0, 1, 1, new Uint8Array(4))
      this.stats.lastUpdateMs = performance.now() - t0
      this.stats.maxUpdateMs = Math.max(this.stats.maxUpdateMs, this.stats.lastUpdateMs)
    }
    let changed = t.full || t.rects.length > 0 || t.scorches.length > 0
    if (g.pending > 0) {
      g.step(this.units, () => {
        const view = feed.view()
        const din2 = feed.din2()
        return view && din2 ? { view, din2 } : null
      })
      changed = true
    }
    return changed
  }

  dispose(): void {
    this.gpu?.dispose()
    this.gpu = null
    this.feed = null
  }
}
