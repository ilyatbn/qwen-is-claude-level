/**
 * F4 overlays: collision boxes, the coarse grid, chunk bounds, surface points,
 * spawns, FoV and (sandbox only) buried slots.
 *
 * One `Graphics` at depth 55 — **above** the lightmap, so overlays stay readable at
 * night — cleared and redrawn each frame. Never an object per cell.
 */

import Phaser from 'phaser'
import { C, type Core } from '../core'

export interface OverlayFlags {
  collisionBoxes: boolean
  coarseGrid: boolean
  chunkBounds: boolean
  surfacePoints: boolean
  spawnPoints: boolean
  fovRadius: boolean
  /** Sandbox only. Never in the networked game — see the constructor. */
  buriedSlots: boolean
}

export interface PlayerDebugInfo {
  x: number
  y: number
  fov?: number
}

const DEFAULTS: OverlayFlags = {
  collisionBoxes: true,
  coarseGrid: false,
  chunkBounds: true,
  surfacePoints: false,
  spawnPoints: true,
  fovRadius: true,
  buriedSlots: false,
}

export class DebugOverlay {
  private readonly gfx: Phaser.GameObjects.Graphics
  private readonly core: Core
  private readonly allowBuried: boolean
  private flags: OverlayFlags = { ...DEFAULTS }
  private on = false

  /**
   * `allowBuried` is gated on the *scene*, not merely on a flag. Buried slot
   * positions are deliberately never sent to clients
   * (`docs/32-item-spawning.md` §5) — drawing them in the networked game would turn
   * "digging is speculative" into "digging is a map", and a flag someone can flip
   * is not a guarantee.
   */
  constructor(scene: Phaser.Scene, core: Core, allowBuried = false) {
    this.core = core
    this.allowBuried = allowBuried
    this.gfx = scene.add.graphics().setDepth(55).setVisible(false)

    scene.input.keyboard?.on('keydown-F4', () => this.toggle())
  }

  toggle(): void {
    this.on = !this.on
    this.gfx.setVisible(this.on)
  }

  get enabled(): boolean {
    return this.on
  }

  setFlags(f: Partial<OverlayFlags>): void {
    this.flags = { ...this.flags, ...f }
  }

  update(camera: Phaser.Cameras.Scene2D.Camera, players: readonly PlayerDebugInfo[]): void {
    if (!this.on) return
    const g = this.gfx
    const c = C()
    g.clear()

    const view = camera.worldView
    const x0 = view.x
    const y0 = view.y
    const x1 = view.right
    const y1 = view.bottom

    // Everything below is clipped to the camera. The coarse grid at medium scale is
    // 384 x 192 = 73,728 cells and drawing all of them freezes the tab; the surface
    // point set runs to thousands.
    if (this.flags.coarseGrid) {
      const cell = c.COARSE_CELL
      g.lineStyle(1, 0x44ffcc, 0.15)
      for (let x = Math.floor(x0 / cell) * cell; x <= x1; x += cell) {
        g.lineBetween(x, y0, x, y1)
      }
      for (let y = Math.floor(y0 / cell) * cell; y <= y1; y += cell) {
        g.lineBetween(x0, y, x1, y)
      }
    }

    if (this.flags.chunkBounds) {
      const cs = c.CHUNK_SIZE
      g.lineStyle(1, 0xffaa00, 0.5)
      for (let x = Math.floor(x0 / cs) * cs; x <= x1; x += cs) g.lineBetween(x, y0, x, y1)
      for (let y = Math.floor(y0 / cs) * cs; y <= y1; y += cs) g.lineBetween(x0, y, x1, y)
    }

    if (this.flags.surfacePoints) {
      g.fillStyle(0x66ff66, 0.8)
      for (const p of this.core.meta.surface_points) {
        if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue
        g.fillRect(p.x - 1, p.y - 1, 2, 2)
      }
    }

    if (this.flags.spawnPoints) {
      g.lineStyle(2, 0xff30c0, 0.9)
      for (const p of this.core.meta.spawn_points) {
        if (p.x < x0 - 20 || p.x > x1 + 20 || p.y < y0 - 20 || p.y > y1 + 20) continue
        g.strokeCircle(p.x, p.y, 8)
        g.lineBetween(p.x - 12, p.y, p.x + 12, p.y)
      }
    }

    if (this.flags.buriedSlots && this.allowBuried) {
      g.lineStyle(1, 0xffd24a, 0.9)
      for (const s of this.core.meta.buried_slots) {
        if (s.pos.x < x0 || s.pos.x > x1 || s.pos.y < y0 || s.pos.y > y1) continue
        g.strokeRect(s.pos.x - 4, s.pos.y - 4, 8, 8)
      }
    }

    for (const p of players) {
      if (this.flags.collisionBoxes) {
        g.lineStyle(1, 0x00ffff, 0.9)
        g.strokeRect(p.x - c.PLAYER_W / 2, p.y - c.PLAYER_H / 2, c.PLAYER_W, c.PLAYER_H)
      }
      if (this.flags.fovRadius && p.fov !== undefined) {
        g.lineStyle(1, 0xffffff, 0.25)
        g.strokeCircle(p.x, p.y, p.fov)
      }
    }
  }

  destroy(): void {
    this.gfx.destroy()
  }
}
