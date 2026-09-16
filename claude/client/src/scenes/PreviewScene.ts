/**
 * A minimal harness for looking at the terrain renderer.
 *
 * Not the sandbox — that is T3.07, with seed controls, carve tools and overlays.
 * This exists so T3.03–T3.06 can be verified by eye and by timing before the
 * sandbox is built, because a rendering task with no screenshot is not verified.
 *
 * `?preview=1&seed=4242&scale=2&fit=1`
 */

import Phaser from 'phaser'
import { C, Core, MapScale } from '../core'
import { TerrainRenderer } from '../render/terrain'
import { CameraRig } from '../render/cameraRig'
import { Backdrop, DEFAULT_THEME, DEPTH } from '../render/backdrop'
import { makeBackTexture, makeEdgeTexture, makeFillTexture } from '../render/procTextures'
import { devSurface } from '../dev'

export class PreviewScene extends Phaser.Scene {
  private core!: Core
  private terrain!: TerrainRenderer
  private rig!: CameraRig
  private backdrop!: Backdrop
  private marker!: Phaser.GameObjects.Rectangle
  private timings = { buildAllMs: 0, chunkCount: 0, lastRebakeMs: 0, generateMs: 0 }

  constructor() {
    super('Preview')
  }

  create(): void {
    const params = new URLSearchParams(location.search)
    const seed = BigInt(params.get('seed') ?? '4242')
    const scale = Number(params.get('scale') ?? MapScale.Medium) as MapScale
    const fit = params.get('fit') === '1'
    const carve = params.get('carve')

    this.core = this.registry.get('core') as Core
    const t0 = performance.now()
    this.core.generate(seed, scale)
    this.timings.generateMs = performance.now() - t0

    const { width: mapW, height: mapH } = this.core

    this.backdrop = new Backdrop(this, DEFAULT_THEME, mapW, mapH)

    const container = this.add.container(0, 0).setDepth(DEPTH.terrain)
    this.terrain = new TerrainRenderer(
      this.textures,
      {
        add: (x, y, key) => {
          const img = this.add.image(x, y, key)
          container.add(img)
          return img
        },
      },
      this.core,
      makeFillTexture(),
      makeEdgeTexture(),
      undefined,
      makeBackTexture(),
    )

    const t1 = performance.now()
    this.terrain.buildAll()
    this.timings.buildAllMs = performance.now() - t1
    this.timings.chunkCount = this.terrain.stats.chunkCount

    // A known-size crater, so the on-screen scale can be measured from a
    // screenshot rather than trusted.
    if (carve) {
      const [cx, cy, r] = carve.split(',').map(Number)
      this.core.carve(cx!, cy!, r!)
      const t2 = performance.now()
      this.terrain.markDirty(this.core.takeDirtyChunks())
      for (let i = 0; i < 8; i++) this.terrain.update({ x: cx!, y: cy! })
      this.timings.lastRebakeMs = performance.now() - t2
    }

    // A PLAYER_W x PLAYER_H box at the first spawn, for scale.
    const spawn = this.core.meta.spawn_points[0] ?? { x: mapW / 2, y: mapH / 2 }
    this.marker = this.add
      .rectangle(spawn.x, spawn.y, C().PLAYER_W, C().PLAYER_H, 0xff30c0)
      .setDepth(DEPTH.actors)

    this.rig = new CameraRig(this.cameras.main, mapW, mapH)
    if (fit) {
      // Whole-map overview: zoom out far enough to see everything.
      const z = Math.min(C().VIEWPORT_W / mapW, C().VIEWPORT_H / mapH)
      this.cameras.main.setZoom(z)
      this.cameras.main.centerOn(mapW / 2, mapH / 2)
    } else {
      this.rig.follow({ x: spawn.x, y: spawn.y })
      this.rig.snapTo({ x: spawn.x, y: spawn.y })
    }

    const self = this
    if (!devSurface()) return
    ;(window as unknown as { __game: unknown }).__game = {
      debug() {
        return {
          ...self.timings,
          mapW,
          mapH,
          chunksX: self.core.chunksX,
          chunksY: self.core.chunksY,
          visible: self.rig.visible,
          zoom: self.cameras.main.zoom,
          spawn,
          surfacePoints: self.core.meta.surface_points.length,
          traversable: self.core.meta.traversable_fraction,
        }
      },
      core: self.core,
    }
  }

  override update(_time: number, delta: number): void {
    const fit = new URLSearchParams(location.search).get('fit') === '1'
    if (!fit) this.rig.update(delta / 1000)
    this.terrain.update(this.rig.center)
    void this.marker
    void this.backdrop
  }
}
