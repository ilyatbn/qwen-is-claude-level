/**
 * The sandbox: `game-core` in the browser with no server.
 *
 * This is the development tool everything after M3 is debugged with, and it stays
 * in the build behind `?sandbox=1` (`docs/60-testing.md` §5,
 * `docs/61-logging-debug.md` §5). It is not throwaway code.
 *
 *   ?sandbox=1&seed=12345&scale=large
 */

import Phaser from 'phaser'
import { Core, MapScale } from '../core'
import { TerrainRenderer } from '../render/terrain'
import { CameraRig } from '../render/cameraRig'
import { Backdrop, DEFAULT_THEME, DEPTH } from '../render/backdrop'
import { makeBackTexture, makeEdgeTexture, makeFillTexture } from '../render/procTextures'

const SCALES: Record<string, MapScale> = {
  small: MapScale.Small,
  medium: MapScale.Medium,
  large: MapScale.Large,
}
const SCALE_NAMES = ['small', 'medium', 'large'] as const

/** Camera pan speed with the arrow keys, in world px/s at zoom 1. */
const PAN_SPEED = 900

export class SandboxScene extends Phaser.Scene {
  private core!: Core
  private terrain!: TerrainRenderer
  private rig!: CameraRig
  private backdrop!: Backdrop
  private container!: Phaser.GameObjects.Container

  private seed = 0n
  private mapScale: MapScale = MapScale.Medium
  private carveRadius = 42

  private readout!: HTMLPreElement
  private ui!: HTMLDivElement
  private seedInput!: HTMLInputElement

  private timings = { generateMs: 0, buildAllMs: 0, lastRebakeMs: 0 }
  private frameBakes = 0

  constructor() {
    super('Sandbox')
  }

  create(): void {
    const params = new URLSearchParams(location.search)
    this.core = this.registry.get('core') as Core

    const seedParam = params.get('seed')
    this.seed = seedParam ? BigInt(seedParam) : randomSeed()
    this.mapScale = SCALES[params.get('scale') ?? 'medium'] ?? MapScale.Medium

    this.buildUi()
    this.regenerate()

    // Click to carve. Pointer coordinates must go through the camera: using screen
    // coordinates works perfectly until the camera scrolls, and then silently
    // carves the wrong place (`docs/22-aiming-crosshair.md` §7).
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const w = this.cameras.main.getWorldPoint(p.x, p.y)
      this.carveAt(Math.round(w.x), Math.round(w.y))
    })

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.ui.remove()
      this.terrain.destroy()
    })

    this.exposeDebugHandle()
  }

  // ---------------------------------------------------------------- generation

  private regenerate(): void {
    // Tear the old map down *first*. Phaser's texture manager is global, so a
    // reused key keeps the old pixels and the new map comes out looking subtly
    // like the previous one — a genuinely confusing symptom to chase (T3.05).
    this.terrain?.destroy()
    this.backdrop?.destroy()
    this.container?.destroy()

    const t0 = performance.now()
    this.core.generate(this.seed, this.mapScale)
    this.timings.generateMs = performance.now() - t0

    const { width: mapW, height: mapH } = this.core
    this.backdrop = new Backdrop(this, DEFAULT_THEME, mapW, mapH)
    this.container = this.add.container(0, 0).setDepth(DEPTH.terrain)

    this.terrain = new TerrainRenderer(
      this.textures,
      {
        add: (x, y, key) => {
          const img = this.add.image(x, y, key)
          this.container.add(img)
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

    const spawn = this.core.meta.spawn_points[0] ?? { x: mapW / 2, y: mapH / 2 }
    this.rig = new CameraRig(this.cameras.main, mapW, mapH)
    this.rig.follow(spawn)
    this.rig.snapTo(spawn)

    // A shareable link is worth the two lines it costs: a map worth talking about
    // can be sent to someone else exactly.
    const url = new URL(location.href)
    url.searchParams.set('sandbox', '1')
    url.searchParams.set('seed', this.seed.toString())
    url.searchParams.set('scale', SCALE_NAMES[this.mapScale] ?? 'medium')
    history.replaceState(null, '', url)

    this.seedInput.value = this.seed.toString()
    this.refreshReadout()
  }

  private carveAt(x: number, y: number): void {
    this.core.carve(x, y, this.carveRadius)
    const dirty = this.core.takeDirtyChunks()
    const t0 = performance.now()
    this.terrain.markDirty(dirty)
    // Force the whole pending set through, so the measured cost is the real cost
    // of this carve rather than one frame's slice of it.
    while (this.terrain.stats.pending > 0) this.terrain.update({ x, y })
    this.timings.lastRebakeMs = performance.now() - t0
    this.refreshReadout()
  }

  // ---------------------------------------------------------------------- ui

  private buildUi(): void {
    const ui = document.createElement('div')
    ui.style.cssText = `position:fixed;left:8px;top:8px;z-index:10;font:12px/1.4 ui-monospace,monospace;
      color:#dfe6ee;background:rgba(12,16,22,.82);padding:8px 10px;border-radius:6px;
      display:flex;flex-direction:column;gap:6px;max-width:340px`

    const row = () => {
      const d = document.createElement('div')
      d.style.cssText = 'display:flex;gap:6px;align-items:center'
      return d
    }

    const r1 = row()
    this.seedInput = document.createElement('input')
    this.seedInput.style.cssText = 'width:150px;font:inherit'
    this.seedInput.value = this.seed.toString()
    const regen = button('Regenerate', () => {
      const v = this.seedInput.value.trim()
      this.seed = v === '' ? randomSeed() : BigInt(v)
      this.regenerate()
    })
    const rand = button('Random', () => {
      this.seed = randomSeed()
      this.regenerate()
    })
    r1.append(label('seed'), this.seedInput, regen, rand)

    const r2 = row()
    const scaleSel = document.createElement('select')
    scaleSel.style.font = 'inherit'
    for (const name of SCALE_NAMES) {
      const o = document.createElement('option')
      o.value = name
      o.textContent = name
      scaleSel.append(o)
    }
    scaleSel.value = SCALE_NAMES[this.mapScale] ?? 'medium'
    scaleSel.onchange = () => {
      this.mapScale = SCALES[scaleSel.value] ?? MapScale.Medium
      this.regenerate()
    }

    const radius = document.createElement('input')
    radius.type = 'range'
    radius.min = '1'
    radius.max = '200'
    radius.value = String(this.carveRadius)
    radius.style.width = '110px'
    const radiusOut = document.createElement('span')
    radiusOut.textContent = String(this.carveRadius)
    radius.oninput = () => {
      this.carveRadius = Number(radius.value)
      radiusOut.textContent = radius.value
    }
    r2.append(label('scale'), scaleSel, label('carve r'), radius, radiusOut)

    this.readout = document.createElement('pre')
    this.readout.style.cssText = 'margin:0;white-space:pre-wrap'

    ui.append(r1, r2, this.readout)
    document.body.append(ui)
    this.ui = ui

    // Typing a seed must not also drive the game.
    ui.addEventListener('keydown', (e) => e.stopPropagation())
  }

  private refreshReadout(): void {
    const m = this.core.meta
    const t = this.timings
    // `attempts` and `used_safe_preset` are the numbers that say whether the
    // generator is healthy, and they are invisible unless shown
    // (`docs/10-map-generation.md` §Pass 7d).
    this.readout.textContent =
      `seed ${m.seed}  scale ${m.scale}  theme ${m.theme}\n` +
      `attempts ${m.attempts}  safe_preset ${m.used_safe_preset}\n` +
      `traversable ${m.traversable_fraction.toFixed(3)}  surface ${m.surface_points.length}\n` +
      `${this.core.width}x${this.core.height}  chunks ${this.terrain.stats.chunkCount}\n` +
      `generate ${t.generateMs.toFixed(0)} ms  bakeAll ${t.buildAllMs.toFixed(0)} ms\n` +
      `last carve rebake ${t.lastRebakeMs.toFixed(1)} ms  bakes/frame ${this.frameBakes}`
  }

  private exposeDebugHandle(): void {
    const self = this
    ;(window as unknown as { __game: unknown }).__game = {
      debug() {
        return {
          ...self.timings,
          seed: self.core.meta.seed,
          scale: self.core.meta.scale,
          attempts: self.core.meta.attempts,
          usedSafePreset: self.core.meta.used_safe_preset,
          traversable: self.core.meta.traversable_fraction,
          mapW: self.core.width,
          mapH: self.core.height,
          chunkCount: self.terrain.stats.chunkCount,
          pending: self.terrain.stats.pending,
          // Phaser's texture manager is global. A missing destroy() shows up here
          // as an unbounded key count long before the browser reports memory
          // pressure, which makes the leak testable rather than eyeballed.
          liveTerrainTextures: Object.keys(self.textures.list).filter((k) =>
            k.startsWith('terrain_'),
          ).length,
          visible: self.rig.visible,
          zoom: self.cameras.main.zoom,
          camera: self.rig.center,
        }
      },
      regenerate(seed?: string, scale?: string) {
        if (seed !== undefined) self.seed = BigInt(seed)
        if (scale !== undefined) self.mapScale = SCALES[scale] ?? self.mapScale
        self.regenerate()
      },
      carve(x: number, y: number, r: number) {
        self.carveRadius = r
        self.carveAt(x, y)
      },
      core: self.core,
    }
  }

  // ------------------------------------------------------------------- update

  override update(_time: number, delta: number): void {
    const dt = delta / 1000
    const k = this.input.keyboard
    if (k) {
      const c = k.createCursorKeys()
      const z = this.cameras.main.zoom
      let dx = 0
      let dy = 0
      if (c.left.isDown) dx -= PAN_SPEED * dt / z
      if (c.right.isDown) dx += PAN_SPEED * dt / z
      if (c.up.isDown) dy -= PAN_SPEED * dt / z
      if (c.down.isDown) dy += PAN_SPEED * dt / z
      if (dx !== 0 || dy !== 0) {
        const p = this.rig.center
        this.rig.follow({ x: p.x + dx, y: p.y + dy })
      }
    }

    this.rig.update(dt)
    this.terrain.update(this.rig.center)
    this.frameBakes = this.terrain.stats.bakesThisFrame
  }
}

function label(text: string): HTMLSpanElement {
  const s = document.createElement('span')
  s.textContent = text
  s.style.opacity = '0.7'
  return s
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = text
  b.style.font = 'inherit'
  b.onclick = onClick
  return b
}

function randomSeed(): bigint {
  const a = new Uint32Array(2)
  crypto.getRandomValues(a)
  return (BigInt(a[0]!) << 32n) | BigInt(a[1]!)
}
