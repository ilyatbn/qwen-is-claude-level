/**
 * The title screen (`docs/71-amendments-v3.md` §B3).
 *
 * Behind the name and the Start button, a real round runs: a generated map with
 * real bots fighting, stepped through `game-core` in WASM with no server
 * involved. §B3 asks for that specifically, and the reason is worth restating —
 * **it is a continuous smoke test of the simulation that anyone can see.** If the
 * bots stop moving, or the terrain stops taking damage, something in `game-core`
 * is broken, and it is visible before anyone opens a test suite.
 */
import Phaser from 'phaser'
import { C, Core, MapScale } from '../core'
import type { Attract } from '../core/attract'
import { WorldView } from '../render/worldView'
import { SkyLayer } from '../render/sky'
import { PlayerView } from '../render/playerView'
import { loadAssetManifest, runLoader } from '../render/assets'

/** How long one attract round runs before a fresh map is generated. */
const ATTRACT_ROUND_SECONDS = 45

/**
 * The attract sim runs at a third of the game's rate.
 *
 * It is a background behind a menu, not the game: at 60 Hz it would compete with
 * the UI for frame budget for no visible benefit, because nobody is reading the
 * bots' movement closely enough to see the difference.
 */
const ATTRACT_HZ = 20

/**
 * Zoomed out from the game's `CAMERA_ZOOM`.
 *
 * At 2x you see terrain; at this you see a fight, which is the only reason the
 * attract mode is on screen. It is a presentation number for this scene, not a
 * gameplay one — the game's own zoom is untouched.
 */
const ATTRACT_ZOOM = 0.75

export class TitleScene extends Phaser.Scene {
  private attract: Attract | null = null
  private view: WorldView | null = null
  private sky: SkyLayer | null = null
  private views: PlayerView[] = []
  private acc = 0
  private elapsed = 0
  private ui: HTMLElement | null = null
  /** Ticks run since the scene started, for the e2e handle. */
  private ticks = 0

  constructor() {
    super('Title')
  }

  async create(): Promise<void> {
    // The same atlases the game loads. Without this `PlayerView` falls back to
    // its placeholder box — which is correct behaviour (`docs/50` §8) and was
    // exactly the §B12 defect: routing the attract bots through the real sprite
    // path is worth nothing if the art is never loaded, and the frame looks
    // identical to the coloured rectangles it replaced.
    await loadAssetManifest(this)
    await runLoader(this)

    this.startAttract()
    this.buildUi()

    // Keyboard reachable: §B3 requires every screen to be, and a title screen
    // you can only start with a mouse is the first place that gets forgotten.
    this.input.keyboard?.on('keydown-ENTER', () => this.start())
    this.input.keyboard?.on('keydown-SPACE', () => this.start())

    // Phaser fires this on scene stop *and* on shutdown; without it the sim
    // keeps ticking behind the next scene, burning a core for nothing.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown())
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown())

    this.exposeDebugHandle()
  }

  private startAttract(): void {
    const seed = BigInt(Math.floor(Math.random() * 0xffffffff))
    // Small, because the camera is zoomed out to show the fight and a large map
    // would be mostly empty sky at this distance — and because generation is the
    // expensive part and it happens while someone is waiting to press Start.
    this.attract = Core.attract(seed, MapScale.Small, 4, 0.85)
    this.view = new WorldView(this, this.attract as never)
    // §C14's mountains come from the map seed, so the attract map gets its own
    // skyline — the same one it would have in a round on that seed.
    this.sky = new SkyLayer(this, this.attract.meta.seed, this.attract.meta.theme)
    this.cameras.main.setZoom(ATTRACT_ZOOM)
    this.elapsed = 0

    // The **same** sprite path the game uses (§B12): facing from aim, animation
    // state from the movement flags, held weapon. A second render path for the
    // title screen is a second thing to keep in sync, and the first time it
    // drifts the title is advertising a game that no longer looks like that.
    //
    // `PlayerView` already falls back to a coloured box when an atlas is
    // missing (`docs/50` §8), so this does not cost the "starts with no art"
    // guarantee — it inherits it instead of reimplementing it.
    this.views = this.attract.bots().map((b) => new PlayerView(this, b.id % 5))
  }

  private teardown(): void {
    this.attract?.destroy()
    this.attract = null
    this.view?.destroy()
    this.view = null
    this.views.forEach((v) => v.destroy())
    this.views = []
    this.ui?.remove()
    this.ui = null
  }

  private buildUi(): void {
    // DOM, like every other screen-space element in this project: a
    // `scrollFactor(0)` Phaser object is still scaled by camera zoom (§A35).
    const el = document.createElement('div')
    el.className = 'title-screen'
    el.innerHTML = `
      <h1>DEEP CUT</h1>
      <p class="tagline">A deathmatch in a map you can dig through.</p>
      <button id="start-game" autofocus>Start Game</button>
      <p class="hint">Enter to start</p>
    `
    document.body.appendChild(el)
    el.querySelector<HTMLButtonElement>('#start-game')?.addEventListener('click', () =>
      this.start(),
    )
    this.ui = el
  }

  private start(): void {
    // Teardown happens on SHUTDOWN, so the sim cannot outlive the scene even if
    // a caller forgets.
    this.scene.start('Menu')
  }

  override update(_t: number, deltaMs: number): void {
    const a = this.attract
    if (!a) return
    const dt = deltaMs / 1000

    this.elapsed += dt
    if (this.elapsed > ATTRACT_ROUND_SECONDS) {
      this.teardown()
      this.startAttract()
      this.buildUi()
      return
    }

    // Fixed timestep, as everywhere else: stepping by the frame delta makes the
    // simulation depend on frame rate, and the whole point of game-core is that
    // it does not.
    const step = 1 / ATTRACT_HZ
    this.acc = Math.min(this.acc + dt, 0.25)
    while (this.acc >= step) {
      a.step(C().SIM_DT)
      this.ticks++
      this.acc -= step
    }

    const bots = a.bots()
    for (let i = 0; i < this.views.length; i++) {
      const b = bots[i]
      const v = this.views[i]
      if (!b || !v) continue
      v.setState(b.x, b.y, b.vx, b.vy, b.aim, {
        alive: b.alive,
        grounded: b.moveState === 0,
        jetpack: b.moveState === 2,
        shield: false,
        iframes: false,
      })
    }

    // Follow the action rather than sitting still, so it reads as a fight.
    const f = a.focus()
    this.view?.rig.follow(f)
    this.view?.update(f)
    this.sky?.update(a.roundTime, 0)
  }

  private exposeDebugHandle(): void {
    const self = this
    ;(window as unknown as { __title: unknown }).__title = {
      debug() {
        const a = self.attract
        return {
          running: a !== null && !a.isStopped,
          // **Scene-level**, so it survives teardown.
          //
          // This read `attract?.tickCount ?? 0` first, and after teardown that
          // is 0 — so "ticks did not change after leaving the scene" compared 0
          // against 0 and passed however the sim behaved. A counter that resets
          // when the thing it counts goes away cannot witness the thing going
          // away (§A15). `self.ticks` only ever grows, so a frozen value is
          // evidence and a growing one is a bug.
          ticks: self.ticks,
          attractTicks: a?.tickCount ?? -1,
          simTick: a?.simTick ?? 0,
          mapW: a?.width ?? 0,
          mapH: a?.height ?? 0,
          solid: a?.countSolid() ?? 0,
          bots: a?.bots() ?? [],
          roundTime: a?.roundTime ?? 0,
        }
      },
      start() {
        self.start()
      },
    }
  }
}
