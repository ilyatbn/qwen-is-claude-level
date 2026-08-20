/**
 * T8.06 — the explored-terrain minimap (§A6).
 *
 * ## Why a DOM canvas rather than a Phaser object
 *
 * §A35: a `scrollFactor(0)` Phaser object is still scaled by the camera's zoom,
 * so screen-space elements land off-viewport at `CAMERA_ZOOM = 2`. The HUD, the
 * scoreboard and the feel layer are all DOM for that reason, and this is the
 * same answer applied again rather than a fourth attempt at the engine
 * transform. A 2D canvas is also simply the right tool: the minimap *is* a
 * per-pixel image.
 *
 * ## What it must not do
 *
 * It never shows a remote player outside your FoV. The minimap presents
 * information you already have; leaking a position the screen is hiding would
 * make it better to play looking at the corner.
 */
import { C, type Core } from '../core'
import {
  ExploredMask,
  radiusToCells,
  visibleRemotes,
  worldToCell,
  worldToMinimap,
  type MinimapGeometry,
} from './minimap-math'

/** Terrain is re-sampled at most this often — twice a second, per the task. */
const TERRAIN_REBAKE_S = 0.5

export interface RemoteDot {
  id: number
  x: number
  y: number
}

export class Minimap {
  private readonly geo: MinimapGeometry
  private readonly explored: ExploredMask
  private readonly root: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  /** One byte per cell: solid or not, resampled from the mask. */
  private terrain: Uint8Array
  private terrainAge = TERRAIN_REBAKE_S
  private visible = true

  constructor(
    private readonly core: Core,
    mapW: number,
    mapH: number,
  ) {
    const c = C()
    this.geo = { mapW, mapH, w: c.MINIMAP_W, h: c.MINIMAP_H }
    this.explored = new ExploredMask(this.geo.w, this.geo.h)
    this.terrain = new Uint8Array(this.geo.w * this.geo.h)

    this.root = document.createElement('div')
    this.root.dataset.minimap = 'root'
    this.root.style.cssText = `position:fixed;right:10px;bottom:10px;z-index:9;
      pointer-events:none;opacity:${c.MINIMAP_ALPHA};
      border:1px solid rgba(255,255,255,0.25);background:#05070d;
      image-rendering:pixelated;line-height:0`

    this.canvas = document.createElement('canvas')
    this.canvas.width = this.geo.w
    this.canvas.height = this.geo.h
    // Displayed at 1:1 CSS px per cell; `image-rendering:pixelated` keeps the
    // dots crisp rather than smearing them.
    this.canvas.style.cssText = `width:${this.geo.w}px;height:${this.geo.h}px;display:block`
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('minimap: no 2d context')
    this.ctx = ctx

    this.root.append(this.canvas)
    document.body.append(this.root)
  }

  /** Mark the terrain sample stale — call after a carve. */
  setTerrainDirty(): void {
    this.terrainAge = TERRAIN_REBAKE_S
  }

  /** Reveal around a world point. Idempotent; the explored set only grows. */
  reveal(x: number, y: number, worldR: number): void {
    const cell = worldToCell(x, y, this.geo)
    this.explored.revealCells(cell.x, cell.y, radiusToCells(worldR, this.geo))
  }

  toggle(): boolean {
    this.visible = !this.visible
    this.root.style.display = this.visible ? 'block' : 'none'
    return this.visible
  }

  update(dt: number, me: { x: number; y: number }, others: readonly RemoteDot[], fov: number): void {
    this.reveal(me.x, me.y, C().MINIMAP_REVEAL_R)
    if (!this.visible) return

    this.terrainAge += dt
    if (this.terrainAge >= TERRAIN_REBAKE_S) {
      this.resampleTerrain()
      this.terrainAge = 0
    }
    this.draw(me, others, fov)
  }

  /**
   * One sample per cell from the mask, straight out of WASM memory.
   *
   * 20 000 samples twice a second. Averaging the whole cell would be truer but
   * costs `(mapW/w)²` reads each — 420× more on a large map — for a picture
   * 200 px wide, which nobody would see.
   */
  private resampleTerrain(): void {
    const { w, h, mapW, mapH } = this.geo
    const sx = mapW / w
    const sy = mapH / h
    for (let cy = 0; cy < h; cy++) {
      const wy = Math.min(mapH - 1, Math.floor((cy + 0.5) * sy))
      for (let cx = 0; cx < w; cx++) {
        const wx = Math.min(mapW - 1, Math.floor((cx + 0.5) * sx))
        this.terrain[cy * w + cx] = this.core.solidAt(wx, wy) ? 1 : 0
      }
    }
  }

  private draw(me: { x: number; y: number }, others: readonly RemoteDot[], fov: number): void {
    const { w, h } = this.geo
    const img = this.ctx.createImageData(w, h)
    const d = img.data
    for (let i = 0; i < w * h; i++) {
      const seen = this.explored.cells[i] === 255
      const solid = this.terrain[i] === 1
      const o = i * 4
      if (!seen) {
        // Unexplored is flat dark — the point of the whole feature.
        d[o] = 8
        d[o + 1] = 10
        d[o + 2] = 18
      } else if (solid) {
        d[o] = 122
        d[o + 1] = 104
        d[o + 2] = 78
      } else {
        d[o] = 32
        d[o + 1] = 46
        d[o + 2] = 68
      }
      d[o + 3] = 255
    }
    this.ctx.putImageData(img, 0, 0)

    // Remote players, filtered by FoV *before* they are drawn (§A6).
    this.ctx.fillStyle = '#ff5a5a'
    for (const o of visibleRemotes(me, others, fov)) {
      const p = worldToMinimap(o.x, o.y, this.geo)
      this.ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3)
    }

    const p = worldToMinimap(me.x, me.y, this.geo)
    this.ctx.fillStyle = '#ffe066'
    this.ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3)
  }

  /** For the debug handle and the e2e check. */
  stats(): { visible: boolean; explored: number; cells: number } {
    return {
      visible: this.visible,
      explored: this.explored.exploredCount,
      cells: this.geo.w * this.geo.h,
    }
  }

  destroy(): void {
    this.root.remove()
  }
}
