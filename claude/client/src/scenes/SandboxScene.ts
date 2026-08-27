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
import { DEPTH } from '../render/backdrop'
import { WorldView } from '../render/worldView'
import { caveBackdropDefault, setCaveBackdropDefault } from '../render/terrain'
import { PlayerView } from '../render/playerView'
import { loadAssetManifest, runLoader } from '../render/assets'
import { Crosshair, LocalInput } from '../input/localInput'
import { FeelLayer, type FeelFrame } from '../ui/feelLayer'
import { Minimap } from '../ui/minimap'
import { traumaFromExplosion } from '../render/cameraRig-math'
import { Mixer } from '../audio/mixer'
import { loadAudio } from '../audio/sfx'
import { SkyLayer } from '../render/sky'
import { Lightmap, fovRadius, type LightSource } from '../render/lightmap'
import { DebugOverlay } from '../render/debugOverlay'
import { cloudTint, cycleU, darknessAt, skyPhase } from '../render/sky-math'
import { cloudSpriteTint } from '../render/clouds-math'
import { dequantizeAngle } from '../core'
import { devSurface } from '../dev'

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
  /**
   * The shared render stack. The sandbox used to build its own copy of this,
   * which is how the game scene ended up without a working carve→rebake path:
   * every feature had to be added twice and one of them was not (§C0/§C1).
   * Sandbox-only controls are a panel *over* this world, not a second world.
   */
  private world!: WorldView

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
  private hud!: HTMLDivElement
  private feel!: FeelLayer
  private feelEnabled = true
  private minimap: Minimap | null = null
  /** Silent until audio.json loads; `docs/50` §8 — no assets is supported. */
  private audio = new Mixer()
  private audioSink: { unlock(): void; sampleCount: number; liveVoices: number; isUnlocked: boolean } | null = null
  private stepAcc = 0
  private wasGrounded = true
  private wasJetting = false
  private cueLog: string[] = []
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

    this.sky = new SkyLayer(this, this.core.meta.seed, this.core.meta.theme)
    this.lightmap = new Lightmap(this)
    // `true`: this is the sandbox, the one place buried slots may be drawn.
    this.overlay = new DebugOverlay(this, this.core, true)
    // The sandbox keeps `F4`. §C12 folded the overlays into debug mode for the
    // *game* — one toggle there — but the sandbox is the development scene and
    // its panel already has a button beside the key.
    this.input.keyboard?.on('keydown-F4', () => this.overlay.toggle())
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
      this.world.destroy()
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
      if (inv) {
        const ev = this.core.fire(0, this.simTime)
        const sel = inv.slots[inv.selected]
        if (ev.hitscan?.length) {
          const first = ev.hitscan[0]
          if (first) this.cue('fire_smg', first.x0, first.y0)
        } else if (sel) {
          this.cue(sel.key === 'grenade' ? 'fire_grenade' : 'fire_bazooka')
        }
      }
      this.refreshHud()
    })

    this.initAudio()
    this.exposeDebugHandle()
  
    // Everything the update loop touches now exists.
    this.ready = true
  }

  /** Load samples; never awaited — silence is a supported configuration. */
  private initAudio(): void {
    const c = C()
    this.audio = new Mixer({
      falloff: c.FOV_DAY,
      panHalfWidth: c.VIEWPORT_W / c.CAMERA_ZOOM / 2,
    })
    void loadAudio().then(({ cues, sustained, sink }) => {
      this.audio.setCues(cues, sustained)
      if (sink) {
        sink.onEnded = (h) => this.audio.onVoiceEnded(h)
        this.audio.setSink(sink)
        this.audioSink = sink
        this.input.once('pointerdown', () => sink.unlock())
        this.input.keyboard?.once('keydown', () => sink.unlock())
      }
    })
  }

  /**
   * Fire a cue and record that it happened.
   *
   * The log exists because the e2e check must assert on an *effect*: a browser
   * with no audio device still runs every line of the mixer, so "did a sound
   * play" has to mean "was a voice started with a real gain", not "was play()
   * called" (§A15).
   */
  private cue(name: Parameters<Mixer['play']>[0], x?: number, y?: number, volume = 1): void {
    const body = this.core.playerState(0)
    const ear = body ? { x: body.x, y: body.y } : this.world.rig.center
    const gain =
      x === undefined || y === undefined
        ? this.audio.play(name, { volume })
        : this.audio.spatial(name, x, y, ear, volume)
    if (gain > 0) {
      this.cueLog.push(name)
      if (this.cueLog.length > 64) this.cueLog.shift()
    }
  }

  /** Footsteps, landing and the jetpack — driven by state, not by an event. */
  private movementCues(dt: number, body: { vx: number; vy: number; grounded: boolean; moveState: number }): void {
    const jetting = body.moveState === 2
    if (jetting !== this.wasJetting) {
      this.audio.hold('jetpack', jetting, 0.35)
      if (jetting) this.cueLog.push('jetpack')
      this.wasJetting = jetting
    }
    if (body.grounded && !this.wasGrounded) {
      this.cue('land', undefined, undefined, Math.min(1, Math.abs(body.vy) / C().MAX_FALL_SPEED + 0.25))
      this.stepAcc = 0
    }
    this.wasGrounded = body.grounded

    const speed = Math.abs(body.vx)
    if (body.grounded && speed > 10) {
      // Stride spacing, so a slowed player audibly trudges (docs/21 §3).
      this.stepAcc += (speed * dt) / 26
      if (this.stepAcc >= 1) {
        this.stepAcc = 0
        this.cue('walk', undefined, undefined, 0.35 * Math.min(1, speed / C().WALK_SPEED))
      }
    } else {
      this.stepAcc = 0
    }
  }

  // ---------------------------------------------------------------- generation

  private regenerate(): void {
    // Tear the old map down *first*. Phaser's texture manager is global, so a
    // reused key keeps the old pixels and the new map comes out looking subtly
    // like the previous one — a genuinely confusing symptom to chase (T3.05).
    this.world?.destroy()

    const t0 = performance.now()
    this.core.generate(this.seed, this.mapScale)
    this.timings.generateMs = performance.now() - t0

    const { width: mapW, height: mapH } = this.core
    // One stack, built the same way the game builds it. Backdrop, chunks,
    // camera and props all live in here now.
    this.world = new WorldView(this, this.core)
    this.timings.buildAllMs = this.world.timings.buildAllMs

    const spawn = this.core.meta.spawn_points[0] ?? { x: mapW / 2, y: mapH / 2 }
    // Spawn points are feet positions; the body is positioned by its centre.
    this.core.removePlayer(0)
    this.core.addPlayer(0, spawn.x, spawn.y - C().PLAYER_H / 2)
    this.world.rig.follow(spawn)
    this.world.rig.snapTo(spawn)

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

    // The background is seeded from the map, so it has to follow a regenerate.
    // Without this the sandbox kept the first map's skyline for the whole
    // session and "a seed always looks the same" was true of the terrain only.
    // `sky` is undefined on the first call: `create()` regenerates before it
    // builds the sky, and the constructor above passes the seed directly.
    this.sky?.setSeed(this.core.meta.seed, this.core.meta.theme)

    this.seedInput.value = this.seed.toString()
    this.refreshReadout()
  }

  /**
   * Flip the cave backdrop on the live map **and** for the next regenerate.
   *
   * Both, because they are two different failures: setting only the live renderer
   * loses the choice at the next Regenerate, and setting only the default leaves
   * the map on screen unchanged and reads as a dead button.
   */
  private setCaveBackdrop(on: boolean): boolean {
    setCaveBackdropDefault(on)
    this.world.terrain.setCaveBackdrop(on)
    this.world.flush(this.cameras.main.midPoint)
    this.refreshReadout()
    return on
  }

  private carveAt(x: number, y: number): void {
    const t0 = performance.now()
    this.world.applyCarve(x, y, this.carveRadius)
    // Force the whole pending set through, so the measured cost is the real cost
    // of this carve rather than one frame's slice of it.
    this.world.flush({ x, y })
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
    // `CAVE_BACKDROP` without a wasm rebuild, so the two can be looked at one
    // after the other on the same map. Flipped before you dig — see
    // `TerrainRenderer.setCaveBackdrop`.
    // `caveBackdropDefault()`, not `this.world` — `buildUi` runs before the world
    // exists, and reading it here threw on boot.
    const caveBack = button(`Cave bg: ${caveBackdropDefault() ? 'on' : 'off'}`, () => {
      caveBack.textContent = `Cave bg: ${this.setCaveBackdrop(!caveBackdropDefault()) ? 'on' : 'off'}`
    })
    r3.append(label('time'), time, timeOut, live, fog, overlays, caveBack)

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
      `${this.core.width}x${this.core.height}  chunks ${this.world.terrain.stats.chunkCount}\n` +
      `generate ${t.generateMs.toFixed(0)} ms  bakeAll ${t.buildAllMs.toFixed(0)} ms\n` +
      `last carve rebake ${t.lastRebakeMs.toFixed(1)} ms  bakes/frame ${this.frameBakes}\n` +
      `fps ${Math.round(this.game.loop.actualFps)}  pending ${this.world.terrain.stats.pending}  ` +
      `lightmap ${this.lightmap?.stats.filled ? 'on' : 'off'} draws ${this.lightmap?.stats.drawsLastFrame ?? 0}\n` +
      `cave bg ${this.world.terrain.backdropEnabled ? 'on' : 'off'}  ` +
      `backdrop ${this.world.terrain.stats.backdropMs.toFixed(0)} ms`
  }

  private exposeDebugHandle(): void {
    const self = this
    if (!devSurface()) return
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
          chunkCount: self.world.terrain.stats.chunkCount,
          // The buildAll split (T9.07): mask-only backdrop vs the canvas loop.
          backdropMs: self.world.terrain.stats.backdropMs,
          // Whether that number is a measurement or a skipped pass. Without it
          // `backdropMs: 0` reads as "the pass got faster" (§C0 on metrics).
          caveBackdrop: self.world.terrain.backdropEnabled,
          chunkBakeMs: self.world.terrain.stats.chunkBakeMs,
          pending: self.world.terrain.stats.pending,
          // Phaser's texture manager is global. A missing destroy() shows up here
          // as an unbounded key count long before the browser reports memory
          // pressure, which makes the leak testable rather than eyeballed.
          liveTerrainTextures: Object.keys(self.textures.list).filter((k) =>
            k.startsWith('terrain_'),
          ).length,
          visible: self.world.rig.visible,
          zoom: self.cameras.main.zoom,
          camera: self.world.rig.center,
          player: self.core.playerState(0),
          aim: self.localInput?.aimAngle ?? 0,
          animState: self.player?.state ?? 'idle',
          roundTime: self.roundTime,
          skyPhase: self.sky?.currentPhase ?? 'morning',
          // §C14. `visibleClouds` separates "the layer exists" from "it is
          // drawing", which is the distinction §A15 keeps being about.
          parallax: self.sky?.parallax.debug() ?? null,
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
          // Both ends of the same number (§A39). The server/core knows how many
          // projectiles are alive; the layer knows how many it draws. They were
          // silently different for four milestones and only one was ever asserted.
          projectilesLive: self.core.liveProjectiles().length,
          projectilesDrawn: self.world.drawnProjectiles,
          // Weather at both ends: the sim's ramp, and how many drops are drawn.
          toxicIntensity: self.world.weather.toxicIntensity,
          rainDrops: self.world.weather.rainDrops,
          embers: self.world.weather.emberCount,
          // Jetting vents, so "the layer drew nothing" can be told apart from
          // "the simulation never jetted" — different bugs, same silence.
          vents: (self.lastWeather?.vents ?? []).filter((v) => v.jetting).length,
          trauma: self.world.rig.traumaLevel,
          fps: self.game.loop.actualFps,
          worldView: {
            x: self.cameras.main.worldView.x,
            y: self.cameras.main.worldView.y,
            w: self.cameras.main.worldView.width,
            h: self.cameras.main.worldView.height,
          },
        }
      },
      /**
       * Audio state for the e2e check. `voices` and `gains` are effects — a
       * voice actually started with a real gain — not a count of play() calls.
       */
      /**
       * The depths the shared world stack actually produced, deduped and sorted.
       *
       * Asserted between the two scenes (§C1). Not "both call WorldView" — a scene
       * that adds a world layer inline still shows up here, which is the drift the
       * whole task exists to end.
       */
      sceneDepths() {
        const seen = new Set<number>()
        for (const o of self.children.list) {
          const d = (o as unknown as { depth?: number }).depth
          // World layers only: the sandbox panel and the HUD are DOM or per-scene
          // furniture, and comparing them would report a difference that is not one.
          if (typeof d === 'number' && d <= DEPTH.lightmap) seen.add(d)
        }
        return [...seen].sort((a, b) => a - b)
      },
      decorations() {
        return { count: self.world.decorations.count, total: self.core.meta.decorations.length }
      },
      audio() {
        return {
          samples: self.audioSink?.sampleCount ?? 0,
          unlocked: self.audioSink?.isUnlocked ?? false,
          live: self.audioSink?.liveVoices ?? 0,
          cues: [...self.cueLog],
          master: self.audio.masterVolume,
        }
      },
      clearCues() {
        self.cueLog = []
      },
      /**
       * Force a weather effect: 0 toxic, 1 meteor, 2 lava, 3 fog.
       *
       * Takes the scene's own weather clock rather than making the caller guess
       * it — a check that passes the wrong `now` schedules an effect into the
       * past and then reports the renderer as broken.
       */
      forceWeather(kind: 0 | 1 | 2 | 3) {
        self.core.forceEffect(kind, self.weatherTime)
      },
      setMasterVolume(v: number) {
        self.audio.setMasterVolume(v)
      },
      fire() {
        const inv = self.core.inventory(0)
        const sel = inv?.slots[inv.selected]
        const ev = self.core.fire(0, self.simTime)
        if (ev.hitscan?.length) {
          for (const s of ev.hitscan) self.world.ordnance.addTracer(s.x0, s.y0, s.x1, s.y1)
          const first = ev.hitscan[0]
          if (first) self.cue('fire_smg', first.x0, first.y0)
          // The carve already happened in the core; drain it into the renderer.
          self.world.update(self.world.rig.center)
        } else if (ev.projectile !== undefined && sel) {
          // A launch cue only when a projectile actually left the tube: firing
          // an empty slot or inside a cooldown is rejected server-side and must
          // not make a noise (docs/30 §4).
          self.cue(sel.key === 'grenade' ? 'fire_grenade' : 'fire_bazooka')
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
        return { ...self.world.ordnance.state.counts, lights: self.world.ordnance.lights().length }
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
        return self.world.ordnance.state.tracers.map((t) => ({
          x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1, life: t.life,
        }))
      },
      /** Freeze tracer decay so a screenshot can catch one (debug only). */
      holdTracers(on: boolean) {
        self.world.ordnance.state.holdTracers = on
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
      /** §C14's constants, so a check pins to them rather than to a literal. */
      constants() {
        return C()
      },
      /**
       * Hide the parallax band, for the control frame `living-sky` needs.
       *
       * A check asserting "there are ridge pixels here" is satisfied by the
       * gradient that was always there; the only way to attribute them is to
       * take the layer away and look again.
       */
      setParallaxVisible(on: boolean) {
        self.sky?.parallax.setVisible(on)
      },
      /**
       * Re-seed the **skyline only**, leaving the map alone.
       *
       * `regenerate` with a new seed changes the terrain too, so a frame diff
       * after one measures a new map rather than a new ridge — the check read
       * 100 % changed and would have read 100 % for a skyline that ignored the
       * seed entirely.
       */
      setSkySeed(seed: number) {
        self.sky?.setSeed(seed, self.core.meta.theme)
      },
      /**
       * Pin the cloud drift clock, `null` to resume.
       *
       * The spacing is only exactly even at t = 0; after that the per-cloud
       * speed spread makes clouds pass each other on purpose. A check asserting
       * on the smallest gap without pinning the clock is asserting on how long
       * it took to get there, which is the coin-flip gate §C0 forbids.
       */
      /** `cloudTint` itself, so a check can compare it with the drawn sprite. */
      cloudTintAt(u: number, baseAlpha: number, skyMix: number, alphaFloor: number) {
        return cloudTint(u, baseAlpha, skyMix, alphaFloor)
      },
      /**
       * The tint a **pack sprite** is drawn with, which is not `cloudTint`.
       *
       * §D0/T16.04: selecting `Clouds_black` by phase already darkens the cloud,
       * so applying `cloudTint`'s mix-and-dim on top would darken it twice. A
       * check must compare against whichever path `parallax.cloudAtlas` says is
       * live, or it is asserting the wrong function's answer.
       */
      cloudSpriteTintAt(baseAlpha: number) {
        return cloudSpriteTint(baseAlpha)
      },
      setParallaxClock(t: number | null) {
        self.sky?.parallax.setClock(t)
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
        // Re-grant, because removing the player takes the inventory with it.
        // This cost two debugging rounds as a caller's responsibility, which is
        // the definition of a trap — §A24: make the correct use the only use.
        self.grantSandboxLoadout()
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
      /**
       * The `CAVE_BACKDROP` toggle, for a check that has to measure both sides.
       * Takes effect on the map on screen and on the next `regenerate()`.
       */
      caveBackdrop(on: boolean) {
        return self.setCaveBackdrop(on)
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
        const p = this.world.rig.center
        this.world.rig.follow({ x: p.x + dx, y: p.y + dy })
      }
    }

    // Fixed timestep. Stepping by the frame delta would make movement depend on
    // frame rate, and the whole point of game-core is that the browser runs the
    // same simulation the server does.
    const step = C().SIM_DT
    this.acc = Math.min(this.acc + dt, 0.25)
    let body = this.core.playerState(0)
    while (this.acc >= step) {
      const centre = body ? { x: body.x, y: body.y } : this.world.rig.center
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
      this.world.rig.follow({ x: body.x, y: body.y })
      this.world.rig.setAim(aim)
      this.movementCues(dt, body)
    }

    this.simTime += dt

    // Projectiles, explosions and their consequences.
    for (const ev of this.core.combatStep(this.simTime, dt)) {
      if (!ev.explosion) continue
      const e = ev.explosion
      this.world.ordnance.removeProjectile(e.id)
      this.world.ordnance.addImpact(e.x, e.y, e.r)
      this.cue('explode', e.x, e.y)
            this.world.onCarve(e.x, e.y, e.r)
    this.minimap?.setTerrainDirty()
      // Trauma scaled by distance and blast size, from the layer that owns it
      // (§A24 — this file briefly had a second Trauma of its own).
      const me = this.core.playerState(0)
      const dist = me ? Math.hypot(me.x - e.x, me.y - e.y) : 0
      this.world.rig.shake(traumaFromExplosion(dist, e.r))
      for (const h of e.hits) {
        const lethal = h.health_after <= 0
        if (h.id === 0) this.feel.damageTaken(e.x, e.y, h.damage)
        else this.feel.damageDealt(e.x, e.y, h.damage, lethal)
        this.cue('hit', e.x, e.y)
        if (lethal) this.cue('death')
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
    // A diff against the live list, not add-then-move: the old loop never
    // removed anything, so a detonated rocket stayed drawn until the scene was
    // rebuilt. `syncProjectiles` is shared with the game so both scenes get the
    // same behaviour from one implementation.
    this.world.syncProjectiles(this.core.liveProjectiles())
    this.world.ordnance.update(dt)

    if (!this.timeScrub) this.roundTime += dt
    // Darkness is the server's scalar in M6; here it follows the doc's formula so
    // the sandbox shows what a real round will.
    this.sky.update(this.roundTime, darknessAt(cycleU(this.roundTime), C().NIGHT_DARKNESS), C().NIGHT_DARKNESS)

    this.world.rig.update(dt)
    if (this.feelEnabled) this.feel.update(dt, this.feelFrame())
    this.world.update(this.world.rig.center)
    this.frameBakes = this.world.terrain.stats.bakesThisFrame

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
    // The rain, the spew and the green cast. The discs above say *where* the
    // hazards are; this is what makes an 8-second downpour look like one.
    this.world.weather.setToxic(
      weather.active.some((a) => a.kind === 'toxic' && a.phase === 'active'),
    )
    this.world.weather.update(dt, weather.vents, C().MAX_FALL_SPEED)
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
    for (const l of this.world.ordnance.lights()) {
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