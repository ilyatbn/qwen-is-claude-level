/**
 * T8.08 — the game-feel layer, drawn in the **DOM**.
 *
 * ## Why the DOM and not Phaser
 *
 * §A35. A Phaser object with `setScrollFactor(0)` is still scaled by the camera's
 * zoom, so at `CAMERA_ZOOM = 2` every screen-space element lands off-viewport —
 * the model computed correct values and the screen showed nothing. The HUD strip
 * and the scoreboard in this codebase were already DOM for the same reason; this
 * is that answer applied consistently rather than a third attempt at the Phaser
 * transform.
 *
 * Screen shake is the exception and stays in Phaser: it moves the *camera*, which
 * is world space, and `CameraRig` already owns trauma.
 *
 * Everything positional maps through `feelLayer-math`, which goes via
 * `camera.worldView` rather than re-deriving the engine's transform.
 */
import {
  BannerQueue,
  DamageNumbers,
  HitMarkers,
  Vignette,
} from '../render/feel-math'
import { KillFeed, killLine, type DeathCause } from './killfeed-state'
import { isOnScreen, worldToCss, type Rect } from './feelLayer-math'

/** What the layer needs from the scene each frame. It does not reach for a camera. */
export interface FeelFrame {
  /** `camera.worldView` — the visible world rectangle at the current zoom. */
  view: Rect
  /** The canvas's CSS bounding box, because `Scale.FIT` letterboxes it. */
  canvasRect: Rect
  /** The game's design resolution, i.e. the canvas backing size. */
  canvasW: number
  canvasH: number
}

const Z = 9 // below the sandbox's own panel (10), above the canvas

export class FeelLayer {
  private readonly root: HTMLDivElement
  private readonly vignetteEl: HTMLDivElement
  private readonly numbersEl: HTMLDivElement
  private readonly markersEl: HTMLDivElement
  private readonly bannerEl: HTMLDivElement
  private readonly feedEl: HTMLDivElement

  readonly numbers = new DamageNumbers()
  readonly vignette = new Vignette()
  readonly markers = new HitMarkers()
  readonly banner = new BannerQueue()
  readonly feed = new KillFeed()

  constructor() {
    this.root = document.createElement('div')
    this.root.dataset.feel = 'root'
    this.root.style.cssText = `position:fixed;inset:0;z-index:${Z};pointer-events:none;
      font:700 16px/1.1 ui-monospace,monospace;overflow:hidden`

    this.vignetteEl = document.createElement('div')
    this.vignetteEl.dataset.feel = 'vignette'
    this.vignetteEl.style.cssText = `position:absolute;inset:0;opacity:0;
      background:radial-gradient(ellipse at center,rgba(0,0,0,0) 42%,rgba(190,20,20,0.95) 100%)`

    this.numbersEl = document.createElement('div')
    this.numbersEl.dataset.feel = 'numbers'
    this.numbersEl.style.cssText = 'position:absolute;inset:0'

    this.markersEl = document.createElement('div')
    this.markersEl.dataset.feel = 'markers'
    this.markersEl.style.cssText = 'position:absolute;inset:0'

    this.bannerEl = document.createElement('div')
    this.bannerEl.dataset.feel = 'banner'
    this.bannerEl.style.cssText = `position:absolute;left:50%;top:14%;transform:translateX(-50%);
      font-size:30px;letter-spacing:2px;text-shadow:0 2px 0 #000,0 0 12px #000;opacity:0;
      white-space:nowrap`

    this.feedEl = document.createElement('div')
    this.feedEl.dataset.feel = 'killfeed'
    this.feedEl.style.cssText = `position:absolute;right:10px;top:10px;text-align:right;
      font-size:13px;color:#e8e8ea;text-shadow:0 1px 2px #000;display:flex;
      flex-direction:column;gap:3px`

    this.root.append(this.vignetteEl, this.numbersEl, this.markersEl, this.bannerEl, this.feedEl)
    document.body.append(this.root)
  }

  // ------------------------------------------------------------------ inputs

  /** The local player took a hit: a number at the world point, plus the vignette. */
  damageTaken(x: number, y: number, amount: number): void {
    this.numbers.add(x, y, amount, true)
    this.vignette.hit(amount)
  }

  /** Someone else took a hit from you: a number, plus a marker at the crosshair. */
  damageDealt(x: number, y: number, amount: number, lethal: boolean): void {
    this.numbers.add(x, y, amount, false)
    this.markers.add(lethal)
  }

  showBanner(text: string, tint: number): void {
    this.banner.show(text, tint)
  }

  kill(e: {
    victim: string
    cause: DeathCause
    by: string
    killer?: string | undefined
    involvesYou: boolean
  }): void {
    this.feed.add(e)
  }

  // ------------------------------------------------------------------ update

  update(dt: number, f: FeelFrame): void {
    this.numbers.update(dt)
    this.vignette.update(dt)
    this.markers.update(dt)
    this.banner.update(dt)
    this.feed.update(dt)
    this.render(f)
  }

  private render(f: FeelFrame): void {
    this.vignetteEl.style.opacity = String(this.vignette.alpha)

    // Damage numbers. Rebuilt each frame rather than diffed: there are at most a
    // handful alive, and a diff would be more code than it saves.
    const liveNums = this.numbers.live().filter((d) => isOnScreen({ x: d.x, y: d.drawY }, f.view))
    this.numbersEl.replaceChildren(
      ...liveNums.map((d) => {
        const p = worldToCss({ x: d.x, y: d.drawY }, f.view, f.canvasRect, f.canvasW, f.canvasH)
        const el = document.createElement('div')
        el.textContent = d.incoming ? `-${Math.round(d.amount)}` : String(Math.round(d.amount))
        el.style.cssText = `position:absolute;left:${p.x}px;top:${p.y}px;
          transform:translate(-50%,-50%);opacity:${d.alpha};
          color:${d.incoming ? '#ff5a5a' : '#ffffff'};
          font-size:${d.incoming ? 22 : 17}px;text-shadow:0 2px 0 #000,0 0 8px #000`
        return el
      }),
    )

    // Hit markers sit at the centre of the *canvas*, which is where the crosshair
    // is — they are feedback about your shot, not about a world position.
    const centre = {
      x: f.canvasRect.x + f.canvasRect.width / 2,
      y: f.canvasRect.y + f.canvasRect.height / 2,
    }
    this.markersEl.replaceChildren(
      ...this.markers.live().map((m) => {
        const el = document.createElement('div')
        el.textContent = '✕'
        el.style.cssText = `position:absolute;left:${centre.x}px;top:${centre.y}px;
          transform:translate(-50%,-50%) scale(${m.scale});opacity:${m.alpha};
          color:${m.lethal ? '#ff3b3b' : '#ffffff'};font-size:20px;
          text-shadow:0 0 6px #000`
        return el
      }),
    )

    const b = this.banner.live()
    if (b) {
      this.bannerEl.textContent = b.text
      this.bannerEl.style.opacity = String(b.alpha)
      this.bannerEl.style.color = `#${b.tint.toString(16).padStart(6, '0')}`
    } else {
      this.bannerEl.style.opacity = '0'
    }

    this.feedEl.replaceChildren(
      ...this.feed.live().map((e) => {
        const el = document.createElement('div')
        el.textContent = killLine(e)
        el.style.opacity = String(e.alpha)
        return el
      }),
    )
  }

  /** For the e2e check and the debug handle: what is actually on screen. */
  stats(): {
    numbers: number
    markers: number
    vignette: number
    banner: string | null
    feed: number
    mountedNumbers: number
  } {
    return {
      numbers: this.numbers.count,
      markers: this.markers.count,
      vignette: this.vignette.alpha,
      banner: this.banner.live()?.text ?? null,
      feed: this.feed.live().length,
      // Counted from the DOM, not from the model: §A15 — the model saying a
      // number exists is not evidence that anything was drawn, and that is
      // precisely how this feature failed the first time.
      mountedNumbers: this.numbersEl.childElementCount,
    }
  }

  destroy(): void {
    this.root.remove()
  }
}
