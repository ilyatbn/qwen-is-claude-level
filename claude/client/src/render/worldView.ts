/**
 * The terrain render stack: backdrop, chunk container, chunk renderer, camera.
 *
 * Extracted so the sandbox and the game build it the *same* way. Two divergent
 * render paths is how the sandbox stops predicting what the game does — and the
 * sandbox is the tool everything after M3 is debugged with, so the moment it
 * renders differently it starts lying.
 *
 * **That is the intent, and it is not yet true.** `GameScene` uses this class;
 * `SandboxScene` still builds the same stack inline, as it did before this class
 * existed. So every addition here has to be made twice, which is precisely the
 * drift the extraction was meant to end — T9.02's decoration layer is the second
 * feature to pay that cost. Migrating the sandbox is worth its own task; until
 * then this comment says what is, not what was intended.
 */

import Phaser from 'phaser'
import type { Core } from '../core'
import { TerrainRenderer } from './terrain'
import { CameraRig } from './cameraRig'
import { Backdrop, DEFAULT_THEME, DEPTH } from './backdrop'
import { resolveTheme } from '../render/themes-math'
import { makeBackTexture, makeEdgeTexture, makeFillTexture } from './procTextures'
import { DecorationLayer } from './decorations'
import { fromMeta } from './decorations-math'

export interface WorldViewTimings {
  buildAllMs: number
  lastRebakeMs: number
}

export class WorldView {
  readonly terrain: TerrainRenderer
  readonly rig: CameraRig
  readonly decorations: DecorationLayer
  readonly timings: WorldViewTimings = { buildAllMs: 0, lastRebakeMs: 0 }

  private readonly backdrop: Backdrop
  private readonly container: Phaser.GameObjects.Container

  /**
   * Building tears nothing down: the caller owns the lifetime. Phaser's texture
   * manager is global, so a rebuilt view over a reused key keeps the previous
   * map's pixels — call `destroy()` before constructing another (T3.05).
   */
  constructor(scene: Phaser.Scene, core: Core) {
    const { width: mapW, height: mapH } = core

    this.backdrop = new Backdrop(scene, DEFAULT_THEME, mapW, mapH)
    this.container = scene.add.container(0, 0).setDepth(DEPTH.terrain)

    // Seeded from the map, so a seed always looks the same (`docs/12` §4).
    const theme = resolveTheme(core.meta.theme)
    this.terrain = new TerrainRenderer(
      scene.textures,
      {
        add: (x, y, key) => {
          const img = scene.add.image(x, y, key)
          this.container.add(img)
          return img
        },
      },
      core,
      makeFillTexture(256, theme),
      makeEdgeTexture(256, theme),
      undefined,
      makeBackTexture(256, theme),
    )

    const t0 = performance.now()
    this.terrain.buildAll()
    this.timings.buildAllMs = performance.now() - t0

    this.rig = new CameraRig(scene.cameras.main, mapW, mapH)

    // Props last, so they are placed against the mask the chunks were baked
    // from. Built here rather than in each scene for the same reason the rest of
    // this class exists: two render paths that differ are two render paths that
    // drift.
    this.decorations = new DecorationLayer(scene)
    this.decorations.build(fromMeta(core.meta.decorations), (x, y) => core.solidAt(x, y))
  }

  /**
   * A carve landed. Re-bakes are the terrain's business; this removes the props
   * that were standing on what just left.
   */
  onCarve(x: number, y: number, r: number): number {
    return this.decorations.onCarve(x, y, r)
  }

  /** Re-bake the chunks a carve dirtied, within the per-frame budget. */
  update(near: { x: number; y: number }): void {
    const pendingBefore = this.terrain.stats.pending
    const t0 = performance.now()
    this.terrain.update(near)
    if (pendingBefore > 0) this.timings.lastRebakeMs = performance.now() - t0
  }

  /** Bake everything now — used after a full mask load, where a budgeted
   *  drip would show the map filling in chunk by chunk. */
  flush(near: { x: number; y: number }): void {
    let guard = 0
    while (this.terrain.stats.pending > 0 && guard++ < 4096) this.terrain.update(near)
  }

  destroy(): void {
    this.decorations.destroy()
    this.terrain.destroy()
    this.backdrop.destroy()
    this.container.destroy()
  }
}
