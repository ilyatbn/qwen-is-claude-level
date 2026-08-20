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
import { C, Core, MapScale, type WeatherState } from '../core'
import { TerrainRenderer } from '../render/terrain'
import { CameraRig } from '../render/cameraRig'
import { Backdrop, DEFAULT_THEME, DEPTH } from '../render/backdrop'
import { resolveTheme } from '../render/themes-math'
import { makeBackTexture, makeEdgeTexture, makeFillTexture } from '../render/procTextures'
import { PlayerView } from '../render/playerView'
import { loadAssetManifest, runLoader } from '../render/assets'
import { Crosshair, LocalInput } from '../input/localInput'
import { FeelLayer, type FeelFrame } from '../ui/feelLayer'
import { Minimap } from '../ui/minimap'
import { traumaFromExplosion } from '../render/cameraRig-math'
import { SkyLayer } from '../render/sky'
import { Lightmap, fovRadius, type LightSource } from '../render/lightmap'
import { DebugOverlay } from '../render/debugOverlay'
import { OrdnanceLayer } from '../render/ordnance'
import type { ProjectileKind } from '../render/ordnance-state'
import { cycleU, darknessAt, skyPhase } from '../render/sky-math'
import { dequantizeAngle } from '../core'

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

  private sky!: SkyLayer
  private lightmap!: Lightmap
  private overlay!: DebugOverlay
  private fogActive = false
  private hazardGfx!: Phaser.GameObjects.Graphics
  private lastWeather: WeatherState | null = null
  /**
   * The weather's own clock, which **always** advances.
   *
   * The day/night slider freezes `roundTime` so a phase can be inspected, and a
   * frozen clock stops the effect scheduler dead — its double-tick guard
   * correctly refuses to advance a phase twice for the same `now`. In a real
   * round these are one clock; here they must not be, or forcing an effect while
   * scrubbed leaves it telegraphing forever.
   */
  private weatherTime = 0
  private fovOverride: number | null = null
  private ordnance!: OrdnanceLayer
  private hud!: HTMLDivElement
  private feel!: FeelLayer
  private feelEnabled = true
  private minimap: Minimap | null = null
  private invOpen = false
  /** Round time in seconds, driven by the clock or scrubbed by the slider. */
  private roundTime = 0
  private timeScrub = false

  private player!: PlayerView
  private localInput!: LocalInput
  private crosshair!: Crosshair
  private seq = 0
  /** Fixed-step accumulator: the sim must advance at SIM_HZ, not at frame rate. */
  private acc = 0
  private simTime = 0

  private readout!: HTMLPreElement
  private ui!: HTMLDivElement
  private seedInput!: HTMLInputElement
  private timeInput: HTMLInputElement | undefined
  private timeLabel: HTMLSpanElement | undefined

  private timings = { generateMs: 0, buildAllMs: 0, lastRebakeMs: 0 }
  private frameBakes = 0
  private readoutAcc = 0

  constructor() {
    super('Sandbox')
  }

  /**
   * False until `create()` has finished.
   *
   * `create()` is async because art is fetched, and Phaser does **not** await
   * it — `update()` starts running immediately and would touch `this.core`
   * before it exists. The symptom is a page error on the very first frame.
   */
  private ready = false

  async create(): Promise<void> {
    // Art first. Every draw path falls back if this finds nothing, so a failure
    // here is a console line, not a broken scene (`docs/50` §8).
    await loadAssetManifest(this)
    await runLoader(this)

    const params = new URLSearchParams(location.search)
    this.core = this.registry.get('core') as Core

    const seedParam = params.get('seed')
    this.seed = seedParam ? BigInt(seedParam) : randomSeed()
    this.mapScale = SCALES[params.get('scale') ?? 'medium'] ?? MapScale.Medium

    this.buildUi()
    this.regenerate()

    this.sky = new SkyLayer(this)
    this.lightmap = new Lightmap(this)
    // `true`: this is the sandbox, the one place buried slots may be drawn.
    this.overlay = new DebugOverlay(this, this.core, true)
    this.ordnance = new OrdnanceLayer(this)
    // Hazards sit just under the ordnance layer: both are world-space FX, and
    // a puddle should never draw over a rocket.
    this.hazardGfx = this.add.graphics().setDepth(38)
    this.player = new PlayerView(this, 0)
    this.player.container.setDepth(DEPTH.actors)
    this.localInput = new LocalInput(this)
    this.crosshair = new Crosshair(this, DEPTH.hud)

    // Click to carve. Pointer coordinates must go through the camera: using screen
    // coordinates works perfectly until the camera scrolls, and then silently
    // carves the wrong place (`docs/22-aiming-crosshair.md` §7).
    // Left click carves (the terrain tool); firing is on the F key and on LMB
    // once a weapon is selected, so the checkpoint can drive either.
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.rightButtonDown()) return
      const w = this.cameras.main.getWorldPoint(p.x, p.y)
      this.carveAt(Math.round(w.x), Math.round(w.y))
    })

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.ui.remove()
      this.hud?.remove()
      this.feel?.destroy()
      this.minimap?.destroy()
      this.ordnance.destroy()
      this.terrain.destroy()
      this.lightmap.destroy()
      this.overlay.destroy()
      this.sky.destroy()
    })

    this.buildHud()
    this.feel = new FeelLayer()
    this.input.keyboard?.on('keydown-M', () => this.minimap?.toggle())

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (p.rightButtonDown()) {
        this.invOpen = !this.invOpen
        this.refreshHud()
      }
    })
    this.input.keyboard?.on('keydown-ONE', () => this.pickSlot(0))
    this.input.keyboard?.on('keydown-TWO', () => this.pickSlot(1))
    this.input.keyboard?.on('keydown-THREE', () => this.pickSlot(2))
    this.input.keyboard?.on('keydown-F', () => {
      const inv = this.core.inventory(0)
      if (inv) this.core.fire(0, this.simTime)
      this.refreshHud()
    })

    this.exposeDebugHandle()
  
    // Everything the update loop touches now exists.
    this.ready = true
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

    const theme = resolveTheme(this.core.meta.theme)
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
      makeFillTexture(256, theme),
      makeEdgeTexture(256, theme),
      undefined,
      makeBackTexture(256, theme),
    )

    const t1 = performance.now()
    this.terrain.buildAll()
    this.timings.buildAllMs = performance.now() - t1

    const spawn = this.core.meta.spawn_points[0] ?? { x: mapW / 2, y: mapH / 2 }
    // Spawn points are feet positions; the body is positioned by its centre.
    this.core.removePlayer(0)
    this.core.addPlayer(0, spawn.x, spawn.y - C().PLAYER_H / 2)
    this.rig = new CameraRig(this.cameras.main, mapW, mapH)
    this.rig.follow(spawn)
    this.rig.snapTo(spawn)

    // A new map is a new world: the explored set does not survive it.
    this.minimap?.destroy()
    this.minimap = new Minimap(this.core, mapW, mapH)

    // A shareable link is worth the two lines it costs: a map worth talking about
    // can be sent to someone else exactly.
    const url = new URL(location.href)
    url.searchParams.set('sandbox', '1')
    url.searchParams.set('seed', this.seed.toString())
    url.searchParams.set('scale', SCALE_NAMES[this.mapScale] ?? 'medium')
    history.replaceState(null, '', url)

    // Regenerating recreates the player, so the loadout is granted here rather
    // than once at create() — otherwise every regenerate silently disarms you.
    this.grantSandboxLoadout()

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

    const r3 = row()
    const time = document.createElement('input')
    time.type = 'range'
    time.min = '0'
    time.max = '1000'
    time.value = '0'
    time.style.width = '150px'
    const timeOut = document.createElement('span')
    timeOut.textContent = 'morning'
    this.timeInput = time
    this.timeLabel = timeOut
    time.oninput = () => {
      // Scrubbing the slider takes the clock over, so a phase can be inspected
      // without waiting two minutes for it to come round.
      this.timeScrub = true
      this.roundTime = (Number(time.value) / 1000) * 120
      timeOut.textContent = skyPhase(cycleU(this.roundTime))
    }
    const live = button('Live', () => {
      this.timeScrub = false
    })
    const fog = button('Fog: off', () => {
      this.fogActive = !this.fogActive
      fog.textContent = `Fog: ${this.fogActive ? 'on' : 'off'}`
    })
    const overlays = button('F4 overlays', () => this.overlay.toggle())
    r3.append(label('time'), time, timeOut, live, fog, overlays)

    // The M5 checkpoint is "force each effect and watch it run start to finish",
    // so each gets a button. Telegraph -> active -> end runs on the real
    // scheduler; these only inject the start.
    const r4 = row()
    for (const [name, kind] of [
      ['Toxic', 0],
      ['Meteors', 1],
      ['Lava', 2],
      ['Fog FX', 3],
    ] as const) {
      r4.append(button(name, () => this.core.forceEffect(kind, this.weatherTime)))
    }
    r4.prepend(label('weather'))

    this.readout = document.createElement('pre')
    this.readout.style.cssText = 'margin:0;white-space:pre-wrap'

    ui.append(r1, r2, r3, r4, this.readout)
    document.body.append(ui)
    this.ui = ui

    // Typing a seed must not also drive the game.
    ui.addEventListener('keydown', (e) => e.stopPropagation())
  }

  /** Keep the time slider and its label showing what `roundTime` actually is. */
  /**
   * Sandbox only — the real game makes you find these. It exists so the M4
   * checkpoint (fire, crater, self-damage, inventory) can be driven headlessly.
   */
  private grantSandboxLoadout(): void {
    this.core.give(0, 3 /* bazooka */, 4)
    this.core.give(0, 4 /* grenade */, 3)
    this.core.give(0, 5 /* smg */, 60)
    this.core.selectSlot(0, 0)
    this.refreshHud()
  }

  private pickSlot(slot: number): void {
    this.core.selectSlot(0, slot)
    this.refreshHud()
  }

  /** The permanently-visible strip, plus the right-click panel. */
  /**
   * What the DOM feel layer needs to place things over the canvas.
   *
   * `worldView` rather than the camera transform, and the canvas's *CSS* rect
   * rather than its backing size, because `Scale.FIT` letterboxes it — §A35.
   */
  private feelFrame(): FeelFrame {
    const cam = this.cameras.main
    const canvas = this.game.canvas
    const r = canvas.getBoundingClientRect()
    return {
      view: {
        x: cam.worldView.x,
        y: cam.worldView.y,
        width: cam.worldView.width,
        height: cam.worldView.height,
      },
      canvasRect: { x: r.left, y: r.top, width: r.width, height: r.height },
      canvasW: this.scale.width,
      canvasH: this.scale.height,
    }
  }

  private buildHud(): void {
    const hud = document.createElement('div')
    hud.style.cssText = `position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:10;
      font:12px/1.5 ui-monospace,monospace;color:#dfe6ee;background:rgba(12,16,22,.82);
      padding:6px 10px;border-radius:6px;text-align:center;white-space:pre`
    document.body.append(hud)
    this.hud = hud
    this.refreshHud()
  }

  private refreshHud(): void {
    if (!this.hud) return
    const inv = this.core.inventory(0)
    if (!inv) return
    const sel = inv.slots[inv.selected]
    // The held sprite follows the selected slot, so switching weapons is
    // visible on the character rather than only in the HUD strip.
    this.player?.setWeapon(sel?.key ?? '')
    const strip = `HP ${inv.health.toFixed(0)}   ${sel ? `${sel.key} x${sel.count}` : 'empty'}   [LMB carve] [F fire] [RMB inventory]`
    if (!this.invOpen) {
      this.hud.textContent = strip
      return
    }
    // A 4x2 grid, as docs/30 §3 describes.
    const rows: string[] = []
    for (let r = 0; r < 2; r++) {
      const cells: string[] = []
      for (let c = 0; c < 4; c++) {
        const i = r * 4 + c
        const s = inv.slots[i]
        const mark = i === inv.selected ? '>' : ' '
        cells.push(`${mark}${i + 1} ${s ? `${s.key.slice(0, 8)} x${s.count}` : '--'}`.padEnd(18))
      }
      rows.push(cells.join(''))
    }
    this.hud.textContent = `${strip}\n${rows.join('\n')}`
  }

  private syncTimeControl(): void {
    if (this.timeInput) this.timeInput.value = String(Math.round((this.roundTime % 120) / 120 * 1000))
    if (this.timeLabel) this.timeLabel.textContent = skyPhase(cycleU(this.roundTime))
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
      `last carve rebake ${t.lastRebakeMs.toFixed(1)} ms  bakes/frame ${this.frameBakes}\n` +
      `fps ${Math.round(this.game.loop.actualFps)}  pending ${this.terrain.stats.pending}  ` +
      `lightmap ${this.lightmap?.stats.filled ? 'on' : 'off'} draws ${this.lightmap?.stats.drawsLastFrame ?? 0}`
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
          player: self.core.playerState(0),
          aim: self.localInput?.aimAngle ?? 0,
          animState: self.player?.state ?? 'idle',
          roundTime: self.roundTime,
          skyPhase: self.sky?.currentPhase ?? 'morning',
          darkness: darknessAt(cycleU(self.roundTime), C().NIGHT_DARKNESS),
          fogMult: self.fogActive ? C().FOV_FOG_MULT : 1,
          lightmapDraws: self.lightmap?.stats.drawsLastFrame ?? 0,
          lightmapFilled: self.lightmap?.stats.filled ?? false,
          fov: fovRadius({
            darkness: darknessAt(cycleU(self.roundTime), C().NIGHT_DARKNESS),
            fogMult: self.fogActive ? C().FOV_FOG_MULT : 1,
            health: C().BASE_HEALTH,
            flashlightOn: false,
          }),
          overlays: self.overlay?.enabled ?? false,
          trauma: self.rig.traumaLevel,
          fps: self.game.loop.actualFps,
          worldView: {
            x: self.cameras.main.worldView.x,
            y: self.cameras.main.worldView.y,
            w: self.cameras.main.worldView.width,
            h: self.cameras.main.worldView.height,
          },
        }
      },
      fire() {
        const ev = self.core.fire(0, self.simTime)
        if (ev.hitscan) {
          for (const s of ev.hitscan) self.ordnance.addTracer(s.x0, s.y0, s.x1, s.y1)
          self.terrain.markDirty(self.core.takeDirtyChunks())
        }
        self.refreshHud()
        return ev
      },
      selectSlot(slot: number) {
        self.pickSlot(slot)
      },
      inventory() {
        return self.core.inventory(0)
      },
      toggleInventory() {
        self.invOpen = !self.invOpen
        self.refreshHud()
        return self.invOpen
      },
      ordnance() {
        return { ...self.ordnance.state.counts, lights: self.ordnance.lights().length }
      },
      setFov(r: number | null) {
        self.fovOverride = r
      },
      /** Diagnostic seam: prove whether a defect is zoom-dependent. */
      setZoom(z: number) {
        self.cameras.main.setZoom(z)
      },
      /** Force a weather effect at the current round time. */
      forceEffect(kind: 0 | 1 | 2 | 3) {
        self.core.forceEffect(kind, self.weatherTime)
      },
      /** Raw tracer segments, for diagnosing why one is not on screen. */
      ordnanceState() {
        return self.ordnance.state.tracers.map((t) => ({
          x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1, life: t.life,
        }))
      },
      /** Freeze tracer decay so a screenshot can catch one (debug only). */
      holdTracers(on: boolean) {
        self.ordnance.state.holdTracers = on
      },
      /** First hazard position, so a screenshot can actually show the effect. */
      hazardAt() {
        const w = self.lastWeather
        const v = w?.vents[0]
        if (v) return { x: v.x, y: v.y }
        const p = w?.puddles[0]
        if (p) return { x: p.x, y: p.y }
        return null
      },
      /** What the weather is doing right now — the M5 checkpoint reads this. */
      weatherProbe() {
        const w = self.lastWeather
        return {
          active: w?.active ?? [],
          puddles: w?.puddles.length ?? 0,
          vents: w?.vents.length ?? 0,
          fog: w?.fog ?? 0,
          solid: self.core.countSolid(),
          fov: fovRadius({
            darkness: darknessAt(cycleU(self.roundTime), C().NIGHT_DARKNESS),
            fogMult: self.fogActive
              ? C().FOV_FOG_MULT
              : 1 - (1 - C().FOV_FOG_MULT) * (w?.fog ?? 0),
            health: C().BASE_HEALTH,
            flashlightOn: false,
          }),
        }
      },
      /** §A15: counts DOM nodes, not model entries — see FeelLayer.stats(). */
      feel() {
        return self.feel.stats()
      },
      /** For the perf check: measuring the layer's cost needs a control. */
      setFeelEnabled(on: boolean) {
        self.feelEnabled = on
      },
      minimap() {
        return self.minimap?.stats() ?? null
      },
      toggleMinimap() {
        return self.minimap?.toggle() ?? false
      },
      banner(text: string) {
        self.feel.showBanner(text, 0xffd166)
      },
      setFog(on: boolean) {
        self.fogActive = on
      },
      toggleOverlays() {
        self.overlay.toggle()
      },
      /** Jump to a point in the day, for inspecting a phase. */
      setTime(t: number) {
        self.timeScrub = true
        self.roundTime = t
        // Move the control with it. Setting roundTime alone left the slider and
        // its label reading "morning" on a night screenshot, which cost a
        // reviewer real time and produced a wrong diagnosis.
        self.syncTimeControl()
      },
      /** Teleport, so a movement check can start from known ground. */
      place(x: number, y: number) {
        self.core.removePlayer(0)
        self.core.addPlayer(0, x, y)
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
    if (!this.ready) return
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

    // Fixed timestep. Stepping by the frame delta would make movement depend on
    // frame rate, and the whole point of game-core is that the browser runs the
    // same simulation the server does.
    const step = C().SIM_DT
    this.acc = Math.min(this.acc + dt, 0.25)
    let body = this.core.playerState(0)
    while (this.acc >= step) {
      const centre = body ? { x: body.x, y: body.y } : this.rig.center
      const inp = this.localInput.sample(++this.seq, centre, this.cameras.main)
      this.core.applyInput(0, inp.seq, inp.buttons, inp.aim, step)
      this.acc -= step
      body = this.core.playerState(0)
    }

    if (body) {
      const aim = dequantizeAngle(
        this.localInput.sample(this.seq, { x: body.x, y: body.y }, this.cameras.main).aim,
      )
      this.player.setState(body.x, body.y - C().PLAYER_H / 2, body.vx, body.vy, aim, {
        alive: true,
        grounded: body.grounded,
        jetpack: body.moveState === 2,
        shield: false,
        iframes: false,
      })
      this.crosshair.update(body.x, body.y, aim)
      this.rig.follow({ x: body.x, y: body.y })
      this.rig.setAim(aim)
    }

    this.simTime += dt

    // Projectiles, explosions and their consequences.
    for (const ev of this.core.combatStep(this.simTime, dt)) {
      if (!ev.explosion) continue
      const e = ev.explosion
      this.ordnance.removeProjectile(e.id)
      this.ordnance.addImpact(e.x, e.y, e.r)
      this.terrain.markDirty(this.core.takeDirtyChunks())
    this.minimap?.setTerrainDirty()
      // Trauma scaled by distance and blast size, from the layer that owns it
      // (§A24 — this file briefly had a second Trauma of its own).
      const me = this.core.playerState(0)
      const dist = me ? Math.hypot(me.x - e.x, me.y - e.y) : 0
      this.rig.shake(traumaFromExplosion(dist, e.r))
      for (const h of e.hits) {
        const lethal = h.health_after <= 0
        if (h.id === 0) this.feel.damageTaken(e.x, e.y, h.damage)
        else this.feel.damageDealt(e.x, e.y, h.damage, lethal)
        if (lethal) {
          this.feel.kill({
            victim: h.id === 0 ? 'you' : `p${h.id}`,
            killer: h.id === 0 ? undefined : 'you',
            cause: h.id === 0 ? 'self' : 'player',
            by: 'bazooka',
            involvesYou: true,
          })
        }
      }
      if (e.hits.length) this.refreshHud()
    }
    for (const p of this.core.liveProjectiles()) {
      if (!this.ordnance.state.projectiles.has(p.id)) {
        this.ordnance.addProjectile(p.id, p.key as ProjectileKind, p.x, p.y)
      } else {
        this.ordnance.moveProjectile(p.id, p.x, p.y)
      }
    }
    this.ordnance.update(dt)

    if (!this.timeScrub) this.roundTime += dt
    // Darkness is the server's scalar in M6; here it follows the doc's formula so
    // the sandbox shows what a real round will.
    this.sky.update(this.roundTime, darknessAt(cycleU(this.roundTime), C().NIGHT_DARKNESS), C().NIGHT_DARKNESS)

    this.rig.update(dt)
    if (this.feelEnabled) this.feel.update(dt, this.feelFrame())
    this.terrain.update(this.rig.center)
    this.frameBakes = this.terrain.stats.bakesThisFrame

    // The readout used to refresh only on regenerate/carve, so it displayed
    // live-looking numbers (fps, pending, lightmap) that never changed.
    this.readoutAcc += dt
    if (this.readoutAcc >= 0.25) {
      this.readoutAcc = 0
      this.syncTimeControl()
      this.refreshReadout()
    }

    // Weather runs on the real scheduler; the buttons only inject a start.
    this.weatherTime += dt
    const weather = this.core.weatherStep(this.weatherTime, dt)
    this.lastWeather = weather
    this.drawHazards(weather)
    // Fog from the effect ramps; the Fog button is a separate manual override so
    // visibility can be inspected without waiting for a burst.
    const fogMult = this.fogActive
      ? C().FOV_FOG_MULT
      : 1 - (1 - C().FOV_FOG_MULT) * weather.fog

    const darkness = darknessAt(cycleU(this.roundTime), C().NIGHT_DARKNESS)
    const lights: LightSource[] = []
    if (body) {
      const fov =
        this.fovOverride ??
        fovRadius({
          darkness,
          fogMult,
          health: C().BASE_HEALTH,
          flashlightOn: false,
        })
      lights.push({ x: body.x, y: body.y, radius: fov, kind: 'radial', intensity: 1 })
      // The same `fov` the lightmap uses, not a second copy of the formula —
      // two of them would let the minimap and the screen disagree (§A6).
      this.minimap?.update(dt, { x: body.x, y: body.y }, [], fov)
    }
    // Ordnance lights the map. Shooting in the dark tells everyone where you are,
    // and it is most of what makes night combat readable at all.
    for (const l of this.ordnance.lights()) {
      lights.push({ x: l.x, y: l.y, radius: l.r, kind: 'radial', intensity: l.a })
    }
    // Lava lights the map, exactly as ordnance does — a vent at night is a
    // beacon and that is the point of digging yourself a hole being punished.
    for (const v of weather.vents) {
      if (v.jetting) lights.push({ x: v.x, y: v.y - 60, radius: 150, kind: 'radial', intensity: 0.9 })
      else if (v.burning) lights.push({ x: v.x, y: v.y, radius: 90, kind: 'radial', intensity: 0.6 })
    }
    this.lightmap.render(this.cameras.main, darkness, lights, this.fogActive || weather.fog > 0)

    this.overlay.update(
      this.cameras.main,
      body
        ? [
            {
              x: body.x,
              y: body.y,
              fov: fovRadius({
                darkness,
                fogMult: this.fogActive ? C().FOV_FOG_MULT : 1,
                health: C().BASE_HEALTH,
                flashlightOn: false,
              }),
            },
          ]
        : [],
    )
  }
  /**
   * Draw the active hazards.
   *
   * Deliberately primitive shapes rather than art: the sandbox exists to prove
   * the simulation runs telegraph -> active -> end, and M7 brings the sprites.
   * The positions are the server's data, not locally rolled — that seam is what
   * stops a client from disagreeing about where the lava is.
   */
  private drawHazards(w: WeatherState): void {
    const g = this.hazardGfx
    g.clear()

    for (const p of w.puddles) {
      g.fillStyle(0x6dff4a, 0.35)
      g.fillCircle(p.x, p.y, p.r)
      g.lineStyle(2, 0x9dff7a, 0.8)
      g.strokeCircle(p.x, p.y, p.r)
    }

    for (const v of w.vents) {
      if (v.jetting) {
        // A cone from the vent, leaning as the sim leans it.
        const h = 180
        const half = 0.35
        const a = -Math.PI / 2 + v.lean
        g.fillStyle(0xff6a1a, 0.55)
        g.beginPath()
        g.moveTo(v.x, v.y)
        g.lineTo(v.x + Math.cos(a - half) * h, v.y + Math.sin(a - half) * h)
        g.lineTo(v.x + Math.cos(a + half) * h, v.y + Math.sin(a + half) * h)
        g.closePath()
        g.fillPath()
      } else if (v.burning) {
        g.fillStyle(0xff4400, 0.45)
        g.fillCircle(v.x, v.y, C().LAVA_BURN_RADIUS)
      } else {
        // Telegraph: cracks at the points that are about to open.
        g.lineStyle(2, 0xff8800, 0.9)
        g.strokeCircle(v.x, v.y, 10)
      }
    }
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