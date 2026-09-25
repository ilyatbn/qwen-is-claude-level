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
  crateBeaconLit,
  radiusToCells,
  visibleRemotes,
  worldToCell,
  worldToMinimap,
  type MinimapGeometry,
} from './minimap-math'
import { BLACK_HOLE_RING_COLOR } from '../render/blackHoleFx-math'

/**
 * T22.12C R93: the black hole's minimap marker — a black dot in a ring of the hole's
 * own accretion colour, this many px across. Drawing only.
 */
const HOLE_MARK_PX = 7
/** T22.18B F4: the reach circle's alpha on the minimap. Drawing only. */
const HOLE_REACH_ALPHA = 0.6

/** The hole's reach in minimap px (the map's x scale; the minimap keeps the aspect). */
function holeReachPx(reach: number, geo: { w: number; mapW: number }): number {
  return (reach * geo.w) / geo.mapW
}

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
  /** T21.19: the crates handed in on the last update, and how many dots were drawn. */
  private crateCount = 0
  private cratesDrawn = 0
  private crateLit = false
  /** T22.12C R93: whether the last draw put the black hole's marker on, and where (canvas px). */
  private holeDrawn = false
  private holeAt: { x: number; y: number } | null = null
  private holeReach = 0

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

  update(
    dt: number,
    me: { x: number; y: number },
    others: readonly RemoteDot[],
    fov: number,
    // T21.19: dropped crates (`beaconCrates`) and the round clock the blink runs on.
    // Required, not defaulted: an empty default is a scene that forgot to pass its
    // crates and still typechecks — the minimap drew no items for this whole game.
    crates: readonly { x: number; y: number }[],
    roundTime: number,
    // T22.12C R93: the black hole once it is here — a hazard the whole map shares,
    // so it is drawn whether explored or not. Required for the crates' reason.
    hole: { x: number; y: number } | null,
  ): void {
    this.reveal(me.x, me.y, C().MINIMAP_REVEAL_R)
    const c = C()
    this.crateCount = crates.length
    this.crateLit = crateBeaconLit(roundTime, c.MINIMAP_CRATE_PERIOD, c.MINIMAP_CRATE_ON)
    this.cratesDrawn = 0
    this.holeDrawn = false
    this.holeAt = null
    this.holeReach = 0
    if (!this.visible) return

    this.terrainAge += dt
    if (this.terrainAge >= TERRAIN_REBAKE_S) {
      this.resampleTerrain()
      this.terrainAge = 0
    }
    this.draw(me, others, fov, crates, hole)
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

  private draw(
    me: { x: number; y: number },
    others: readonly RemoteDot[],
    fov: number,
    crates: readonly { x: number; y: number }[],
    hole: { x: number; y: number } | null,
  ): void {
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

    // T21.19: dropped crates, while the beacon is lit. Under the local player's dot,
    // which must never be hidden by a crate it is standing on.
    if (this.crateLit && crates.length > 0) {
      const c = C()
      const size = c.MINIMAP_CRATE_DOT
      const half = Math.floor(size / 2)
      this.ctx.fillStyle = `#${(c.MINIMAP_CRATE_COLOUR >>> 0).toString(16).padStart(6, '0')}`
      for (const k of crates) {
        const q = worldToMinimap(k.x, k.y, this.geo)
        this.ctx.fillRect(Math.round(q.x) - half, Math.round(q.y) - half, size, size)
        this.cratesDrawn++
      }
    }

    // T22.12C R93: the black hole — under the local dot, over the terrain.
    if (hole) {
      const q = worldToMinimap(hole.x, hole.y, this.geo)
      const half = Math.floor(HOLE_MARK_PX / 2)
      const [x0, y0] = [Math.round(q.x) - half, Math.round(q.y) - half]
      this.ctx.fillStyle = `#${BLACK_HOLE_RING_COLOR.toString(16).padStart(6, '0')}`
      this.ctx.fillRect(x0, y0, HOLE_MARK_PX, HOLE_MARK_PX)
      this.ctx.fillStyle = '#000000'
      this.ctx.fillRect(x0 + 2, y0 + 2, HOLE_MARK_PX - 4, HOLE_MARK_PX - 4)
      // T22.18B F4: the pull's edge — inside it the rocks' wells are muted (R91), so a
      // player can see on the map why a rock stopped holding them.
      const reach = holeReachPx(C().BLACK_HOLE_REACH, this.geo)
      this.ctx.strokeStyle = `#${BLACK_HOLE_RING_COLOR.toString(16).padStart(6, '0')}`
      this.ctx.globalAlpha = HOLE_REACH_ALPHA
      this.ctx.lineWidth = 1
      this.ctx.beginPath()
      this.ctx.arc(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5, reach, 0, Math.PI * 2)
      this.ctx.stroke()
      this.ctx.globalAlpha = 1
      this.holeReach = reach
      this.holeDrawn = true
      this.holeAt = { x: Math.round(q.x), y: Math.round(q.y) }
    }

    const p = worldToMinimap(me.x, me.y, this.geo)
    this.ctx.fillStyle = '#ffe066'
    this.ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3)
  }

  /** For the debug handle and the e2e check. */
  stats(): {
    visible: boolean
    explored: number
    cells: number
    /** T21.19: crates handed in, whether the beacon is lit, and dots actually drawn. */
    crates: number
    crateLit: boolean
    crateDrawn: number
    /** T22.12C R93: the black hole's marker was drawn, centred here (canvas px). */
    holeDrawn: boolean
    holeAt: { x: number; y: number } | null
    /** The marker's size, so a check can find its ring (the outer pixel) and core. */
    holeMarkPx: number
    /** T22.18B F4: the reach circle's radius, canvas px, and its alpha (0 = not drawn). */
    holeReachPx: number
    holeReachAlpha: number
  } {
    return {
      visible: this.visible,
      explored: this.explored.exploredCount,
      cells: this.geo.w * this.geo.h,
      crates: this.crateCount,
      crateLit: this.crateLit,
      crateDrawn: this.cratesDrawn,
      holeDrawn: this.holeDrawn,
      holeAt: this.holeAt ? { ...this.holeAt } : null,
      holeMarkPx: HOLE_MARK_PX,
      holeReachPx: this.holeReach,
      holeReachAlpha: HOLE_REACH_ALPHA,
    }
  }

  destroy(): void {
    this.root.remove()
  }
}
