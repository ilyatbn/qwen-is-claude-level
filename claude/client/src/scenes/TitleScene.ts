/**
 * The title screen (`docs/71-amendments-v3.md` §B3, `docs/74-amendments-v6.md` §E9).
 *
 * Behind the name and the Start button there is a **sky**: the game's own (T23.04 — the world
 * renderer's F1 haze, stepped layers, moon and stars, `look/skyMaterial.ts`), seeded once. No
 * `World`, no core, no bots, no server. The world renderer's chunk (three.js, T23.03B F10) loads
 * here after the title has painted, so the button never waits on it; the game then finds it cached.
 *
 * §B3 originally asked for a live round here, on the reasoning that it is a
 * continuous smoke test of `game-core` anyone can see. **§E9 overrides that, and
 * the reason is measured.** The attract sim stepped `ATTRACT_HZ` 20 times a
 * second while advancing `SIM_DT` (1/60), so it ran at a third of real time —
 * which put the end of `WARMUP_SECONDS` at about thirty seconds of wall clock,
 * where damage un-gated, the weather scheduler started, item spawns started and
 * teleports started all at once. At forty-five seconds it tore the world down
 * and rebuilt it **from inside `update()`**, and a throw there removed the DOM
 * *and* stopped Phaser's frame loop. That is why the reported symptom was the
 * picture vanishing *and* the button going dead: they are one failure.
 *
 * The fix is not a corrected timestep. A background that runs the game can
 * always break the menu, and the menu is the only thing this screen owes
 * anybody. So the background is decorative, and everything decorative here runs
 * inside `runGuarded` (`title-math.ts`), which catches, says so once, and stops
 * — it cannot reach the button.
 *
 * `Core.attract()`, `Attract` and the Rust `AttractCore` lose their only caller
 * with this change. They are left in place, not deleted: §B3's argument for a
 * visible smoke test is still a good one, and the sandbox is where it belongs if
 * anyone wants it back.
 */
import Phaser from 'phaser'
import { installFont, DISPLAY_STACK } from '../ui/hud'
import { loadWorldRenderer } from '../look/loadWorldRenderer'
import type { GameMap, GameWorld } from '../look/worldRenderer'
import { loadAssetManifest, runLoader } from '../render/assets'
import { devSurface } from '../dev'
import { newGuard, runGuarded, runGuardedAsync, type Guard } from './title-math'

export class TitleScene extends Phaser.Scene {
  private sky: GameWorld | null = null
  private ui: HTMLElement | null = null
  /** Seconds of wall clock since the scene started. */
  private elapsed = 0
  /** The sky's seed, drawn once and never again — nothing here re-rolls it. */
  private seed = 0
  /**
   * Frames `update()` has run.
   *
   * **Scene-level and monotonic**, for the same reason the old tick counter was:
   * a counter that resets when the thing it counts goes away cannot witness the
   * thing going away (§A15). This is the direct evidence for §E9's acceptance
   * criterion — if a throw ever stops Phaser's loop again, this stops growing,
   * and the check that reads it goes red.
   */
  private frames = 0

  private readonly assetGuard: Guard = newGuard()
  private readonly backdropGuard: Guard = newGuard()
  private readonly frameGuard: Guard = newGuard()

  constructor() {
    super('Title')
  }

  async create(): Promise<void> {
    // **The UI first, and unconditionally.** Everything after this line is
    // decoration and is allowed to fail; none of it can reach the button,
    // because the button already exists. The old order awaited two loaders
    // before building any DOM, so a rejection there left a blank page.
    this.buildUi()

    // Keyboard reachable: §B3 requires every screen to be, and a title screen
    // you can only start with a mouse is the first place that gets forgotten.
    this.input.keyboard?.on('keydown-ENTER', () => this.start())
    this.input.keyboard?.on('keydown-SPACE', () => this.start())

    // Phaser fires this on scene stop *and* on shutdown.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown())
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown())

    // §C17: the handle is a **development** surface. `devSurface()` folds to a
    // literal at build time, so in a production bundle this call and the body it
    // reaches are deleted rather than shipped-and-unreachable — and `?e2e=1`
    // keeps it off a developer's own page unless a check asked for it.
    //
    // This shipped in the first version of T18.01: `__title` was in the
    // production bundle, exposing `freeze`, `setBackdropVisible` and `debug`.
    if (devSurface() && new URLSearchParams(location.search).get('e2e') === '1') {
      this.exposeDebugHandle()
    }

    // Every atlas the manifest names. Guarded: with no art the scene draws
    // without it (`docs/50` §8), which is the
    // "starts with no art" guarantee doing its job rather than a reason to stop.
    await runGuardedAsync(
      this.assetGuard,
      async () => {
        await loadAssetManifest(this)
        await runLoader(this)
      },
      (m) => console.warn(`[title] assets did not load, drawing without them: ${m}`),
    )

    runGuarded(
      this.backdropGuard,
      () => {
        // Seeded once. `Math.random` here and nowhere else: §E9 asks for a
        // seeded background, which means the *draw* must not re-roll — a sky
        // that flickers between frames would be the same class of bug as the
        // one this replaces.
        this.seed = Math.floor(Math.random() * 0xffffffff)
        // The world renderer, on demand; `loadWorldRenderer` drops it if the player has already
        // pressed Start (this scene shut down meanwhile) and says why on a failed load.
        void loadWorldRenderer(this).then((m) => {
          runGuarded(
            this.backdropGuard,
            () => {
              if (m) this.sky = m.createGameWorld(this, this.skyMap(true))
            },
            (e) => console.warn(`[title] no backdrop: ${e}`),
          )
        })
      },
      (m) => console.warn(`[title] no backdrop: ${m}`),
    )
  }

  /** The title's "map": the screen itself, so the sky is laid out as seeded, at rest. `shown` false draws none (a check's control). */
  private skyMap(shown: boolean): GameMap {
    return { w: this.scale.width, h: this.scale.height, seed: this.seed, space: !shown }
  }

  private teardown(): void {
    // The world renderer tears itself down on this scene's shutdown (`createWorldRenderer`).
    this.sky = null
    this.ui?.remove()
    this.ui = null
  }

  private buildUi(): void {
    // DOM, like every other screen-space element in this project: a
    // `scrollFactor(0)` Phaser object is still scaled by camera zoom (§A35).
    const el = document.createElement('div')
    el.className = 'title-screen'
    // §E7. The tagline is gone and the title is SHRED, set in the display face.
    //
    // `installFont` and `DISPLAY_STACK` come from the HUD rather than being
    // declared again here: one `@font-face`, one fallback stack. If the face
    // never loads the stack renders in the body-adjacent monospace and the menu
    // still works (`docs/50` §8) — the face is not awaited and nothing gates on
    // it.
    installFont(document)
    el.innerHTML = `
      <h1 id="game-title" style="font-family:${DISPLAY_STACK};letter-spacing:.18em">SHRED</h1>
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
    // Teardown happens on SHUTDOWN, so nothing can outlive the scene even if a
    // caller forgets.
    this.scene.start('Menu')
  }

  override update(_t: number, deltaMs: number): void {
    // Counted before the guard, so it witnesses frames the backdrop refused to
    // draw. If it only advanced on a successful draw it would freeze for the
    // same reasons the loop used to, and could not tell the two apart.
    this.frames++
    this.elapsed += deltaMs / 1000

    // T23.04: nothing to advance — the sky is static (`skyMaterial.ts`: the mockup's has no
    // clock) and draws on the scene's render event. The guard stays for anything decorative
    // that animates here again (R7's moving moons, T23.11).
    runGuarded(this.frameGuard, () => {}, (m) => console.warn(`[title] the backdrop stopped drawing: ${m}`))
  }

  private exposeDebugHandle(): void {
    // **Guarded again here, and not redundantly.** A class method is reachable
    // from the prototype, so the bundler keeps it however the call site is
    // guarded; what it does delete is a block behind a `false` literal, and
    // that is what takes the word `__title` out of the artifact — which is
    // what `no-dev-surface` greps for.
    // T18.01 shipped `__title` in the production bundle: the call site was guarded
    // and the method was not, so the object literal survived and `no-dev-surface`
    // — whose list did not yet name it — passed anyway.
    if (!devSurface()) return
    const self = this
    ;(window as unknown as { __title: unknown }).__title = {
      debug() {
        return {
          // The loop is alive. This is the assertion §E9 turns on: the old bug
          // stopped Phaser's frame callback, and a frozen count is what that
          // looks like from outside.
          frames: self.frames,
          elapsed: self.elapsed,
          seed: self.seed,
          backdrop: self.sky !== null,
          // Guards, so a check can say *why* a backdrop is missing rather than
          // reporting a blank sky as a pass.
          assetsOk: self.assetGuard.live,
          backdropOk: self.backdropGuard.live,
          drawOk: self.frameGuard.live,
          reason:
            self.assetGuard.reason ?? self.backdropGuard.reason ?? self.frameGuard.reason ?? null,
          // The button is the thing this screen owes anybody.
          uiPresent: document.querySelector('#start-game') !== null,
        }
      },
      /**
       * Stop `update` so a check can diff one frozen frame against itself.
       *
       * The old sky twinkled, drifted and interpolated, so two samples a moment apart
       * differed whether or not the backdrop existed — measured, the check's own
       * control fired on exactly that (T23.04's sky is static, and this stays the
       * control's precondition for whatever animates here next). `pause` stops the scene updating while it
       * keeps rendering, which is what makes a layer toggle inside one frame
       * possible at all.
       */
      freeze(on: boolean) {
        if (on) self.scene.pause()
        else self.scene.resume()
      },
      /** Hide the sky so a check can diff one frozen frame against itself. */
      setBackdropVisible(on: boolean) {
        self.sky?.mapChanged(self.skyMap(on))
      },
      start() {
        self.start()
      },
    }
  }
}
