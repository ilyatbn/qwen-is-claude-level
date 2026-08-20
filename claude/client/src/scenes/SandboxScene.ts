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
import { C, Core, MapScale } from '../core'
import { TerrainRenderer } from '../render/terrain'
import { CameraRig } from '../render/cameraRig'
import { Backdrop, DEFAULT_THEME, DEPTH } from '../render/backdrop'
import { makeBackTexture, makeEdgeTexture, makeFillTexture } from '../render/procTextures'
import { PlayerView } from '../render/playerView'
import { Crosshair, LocalInput } from '../input/localInput'
import { SkyLayer } from '../render/sky'
import { Lightmap, fovRadius, type LightSource } from '../render/lightmap'
import { DebugOverlay } from '../render/debugOverlay'
import { cycleU, skyPhase } from '../render/sky-math'
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
  /** Round time in seconds, driven by the clock or scrubbed by the slider. */
  private roundTime = 0
  private timeScrub = false

  private player!: PlayerView
  private localInput!: LocalInput
  private crosshair!: Crosshair
  private seq = 0
  /** Fixed-step accumulator: the sim must advance at SIM_HZ, not at frame rate. */
  private acc = 0

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

    this.sky = new SkyLayer(this)
    this.lightmap = new Lightmap(this)
    // `true`: this is the sandbox, the one place buried slots may be drawn.
    this.overlay = new DebugOverlay(this, this.core, true)
    this.player = new PlayerView(this, 0)
    this.player.container.setDepth(DEPTH.actors)
    this.localInput = new LocalInput(this)
    this.crosshair = new Crosshair(this, DEPTH.hud)

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
      this.lightmap.destroy()
      this.overlay.destroy()
      this.sky.destroy()
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
    // Spawn points are feet positions; the body is positioned by its centre.
    this.core.removePlayer(0)
    this.core.addPlayer(0, spawn.x, spawn.y - C().PLAYER_H / 2)
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

    const r3 = row()
    const time = document.createElement('input')
    time.type = 'range'
    time.min = '0'
    time.max = '1000'
    time.value = '0'
    time.style.width = '150px'
    const timeOut = document.createElement('span')
    timeOut.textContent = 'morning'
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

    this.readout = document.createElement('pre')
    this.readout.style.cssText = 'margin:0;white-space:pre-wrap'

    ui.append(r1, r2, r3, this.readout)
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
      `last carve rebake ${t.lastRebakeMs.toFixed(1)} ms  bakes/frame ${this.frameBakes}\n` +
      `fps ${Math.round(this.game.loop.actualFps)}  pending ${this.terrain.stats.pending}  ` +
      `lightmap draws ${this.lightmap?.stats.drawsLastFrame ?? 0}`
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
          darkness: sandboxDarkness(self.roundTime),
          fogActive: self.fogActive,
          lightmapDraws: self.lightmap?.stats.drawsLastFrame ?? 0,
          fov: fovRadius({
            darkness: sandboxDarkness(self.roundTime),
            fogActive: self.fogActive,
            health: C().BASE_HEALTH,
            flashlightOn: false,
          }),
          overlays: self.overlay?.enabled ?? false,
        }
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

    if (!this.timeScrub) this.roundTime += dt
    // Darkness is the server's scalar in M6; here it follows the doc's formula so
    // the sandbox shows what a real round will.
    this.sky.update(this.roundTime, sandboxDarkness(this.roundTime), C().NIGHT_DARKNESS)

    this.rig.update(dt)
    this.terrain.update(this.rig.center)
    this.frameBakes = this.terrain.stats.bakesThisFrame

    const darkness = sandboxDarkness(this.roundTime)
    const lights: LightSource[] = []
    if (body) {
      const fov = fovRadius({
        darkness,
        fogActive: this.fogActive,
        health: C().BASE_HEALTH,
        flashlightOn: false,
      })
      lights.push({ x: body.x, y: body.y, radius: fov, kind: 'radial', intensity: 1 })
    }
    this.lightmap.render(this.cameras.main, darkness, lights, this.fogActive)

    this.overlay.update(
      this.cameras.main,
      body
        ? [
            {
              x: body.x,
              y: body.y,
              fov: fovRadius({
                darkness,
                fogActive: this.fogActive,
                health: C().BASE_HEALTH,
                flashlightOn: false,
              }),
            },
          ]
        : [],
    )
  }
}

/**
 * The `docs/14-daynight-visibility.md` §1 darkness curve, local to the sandbox.
 *
 * In a real round this arrives in the snapshot header — the server owns the clock.
 * Duplicating the formula here is deliberate and temporary: the sandbox has no
 * server, and M6 replaces this call with the transmitted value rather than keeping
 * two implementations.
 */
function sandboxDarkness(roundTime: number): number {
  const c = C()
  const day = c.DAY_DURATION
  const night = c.NIGHT_DURATION
  const ramp = c.CYCLE_TRANSITION
  const t = roundTime % (day + night)
  const smooth = (x: number) => {
    const k = Math.max(0, Math.min(1, x))
    return k * k * (3 - 2 * k)
  }
  // Dusk is centred on the day/night boundary, dawn on the end of the cycle.
  if (t < day - ramp / 2) return 0
  if (t < day + ramp / 2) return c.NIGHT_DARKNESS * smooth((t - (day - ramp / 2)) / ramp)
  const endRamp = day + night - ramp / 2
  if (t < endRamp) return c.NIGHT_DARKNESS
  return c.NIGHT_DARKNESS * (1 - smooth((t - endRamp) / ramp))
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
