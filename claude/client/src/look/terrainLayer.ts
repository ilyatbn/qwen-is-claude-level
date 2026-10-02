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
import type { AlbedoPaletteName } from './albedo'
import type { Rect } from './terrainGpu'
import { C } from '../core'

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
  /** T23.20: the albedo palette every GPU side is made with (the scene description's `albedo`). */
  palette: AlbedoPaletteName = 'dusk'

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

  /** T23.20: the discs last handed to the GPU side (`syncDiscs`), as their flat key. */
  private discKey = ''
  private discFlat = new Float32Array(0)

  /**
   * T23.20: hand the albedo the map's cores and irons when they change (a core struck, a core gone, a new map), and
   * repaint each disc that changed — a hit dims a whole heart, which the carve's own rect need not cover. Whether
   * anything was repainted.
   */
  private syncDiscs(feed: TerrainFeed, g: TerrainGpu): boolean {
    const d = feed.discs?.()
    const cores = d?.cores ?? []
    const irons = d?.irons ?? []
    const n = Math.floor(cores.length / 4) + Math.floor(irons.length / 3)
    const flat = new Float32Array(n * 4)
    let k = 0
    for (let i = 0; i + 3 < cores.length; i += 4) flat.set([cores[i]!, cores[i + 1]!, cores[i + 2]!, cores[i + 3]!], 4 * k++)
    for (let i = 0; i + 2 < irons.length; i += 3) flat.set([irons[i]!, irons[i + 1]!, irons[i + 2]!, -1], 4 * k++)
    const key = flat.join(',')
    if (g === this.discGpu && key === this.discKey) return false
    const prev = g === this.discGpu ? this.discFlat : null
    this.discGpu = g
    this.discKey = key
    this.discFlat = flat
    g.setDiscs(flat, n, C().CORE_HITS)
    if (!prev || !g.painted) return false
    // Repaint every disc that is new, gone or changed, old and new places both.
    const same = (a: Float32Array, i: number, b: Float32Array, j: number): boolean => a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2] && a[i + 3] === b[j + 3]
    const rect = (a: Float32Array, i: number): Rect => {
      const r = Math.ceil(a[i + 2]!) + 1
      return { x: Math.floor(a[i]!) - r, y: Math.floor(a[i + 1]!) - r, w: 2 * r + 1, h: 2 * r + 1 }
    }
    let painted = false
    for (const [a, b] of [[flat, prev], [prev, flat]] as const) {
      for (let i = 0; i < a.length; i += 4) {
        let found = false
        for (let j = 0; j < b.length && !found; j += 4) found = same(a, i, b, j)
        if (!found) {
          g.paintNow(rect(a, i))
          painted = true
        }
      }
    }
    return painted
  }
  private discGpu: TerrainGpu | null = null

  /**
   * T23.20: paint the albedo with `palette` (a space map: the asteroid's). The scenes describe the map before they
   * feed its fields, so this normally lands before `setFeed`; a change under a whole feed remakes the GPU side and
   * queues its full pass.
   */
  setPalette(palette: AlbedoPaletteName): void {
    if (palette === this.palette) return
    this.palette = palette
    const feed = this.feed
    if (!feed || !this.gpu) return
    this.gpu.dispose()
    this.gpu = new TerrainGpu(this.renderer, feed.w, feed.h, feed.albedoOffset, palette)
    if (this.bakeLook) this.gpu.setBake(this.bakeLook)
    if (feed.ready) this.gpu.queueAll()
  }

  /** Hand over the scene's fields (`null`: none). `units`: work per frame while a full pass is queued. */
  setFeed(feed: TerrainFeed | null, units: number): void {
    const same =
      !!feed && !!this.gpu && this.feed?.mapKey === feed.mapKey && this.gpu.w === feed.w && this.gpu.h === feed.h && this.gpu.palette === this.palette
    this.feed = feed
    this.units = units
    this.stats.maxPumpMs = 0
    if (same) {
      this.stats.kept++
      return
    }
    this.gpu?.dispose()
    const t0 = performance.now()
    this.gpu = feed ? new TerrainGpu(this.renderer, feed.w, feed.h, feed.albedoOffset, this.palette) : null
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
    const discsChanged = this.syncDiscs(feed, g)
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
    let changed = discsChanged || t.full || t.rects.length > 0 || t.scorches.length > 0
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
