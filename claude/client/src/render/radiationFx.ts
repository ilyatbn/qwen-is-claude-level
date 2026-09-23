/**
 * T22.09B — space's radiation on screen: a pulsing edge glow while the suit is flat,
 * and a HUD line saying what the suit is doing (`M22-RULINGS` R6, R26).
 *
 * **DOM, not Phaser**, for `feelLayer.ts`'s reason (§A35): a scroll-factor-0 Phaser
 * object is still scaled by the camera zoom and lands off screen. The glow is the
 * hit vignette's sibling and sits at the same depth; it is yellow-green where the hit
 * vignette is red, so a radiation tick's own red flash reads on top of it rather than
 * being lost in it.
 *
 * The picture is chosen in `radiationFx-math.ts`; this file only paints it. Both
 * scenes drive it with one call a frame, from the one Rust predicate each has
 * (`FLAG.irradiated` in a match, `Core.irradiated` in the sandbox).
 */
import {
  ExposureClock,
  edgeAlpha,
  suitLine,
  suitState,
  type SuitState,
} from './radiationFx-math'

/** `feelLayer`'s depth: under the HUD (12) and the sandbox panel (10), over the canvas. */
const Z = 9

/** Radiation's colour, one place: the glow and the loud line share it. */
const GLOW = '190,255,60'

export class RadiationFx {
  private readonly root: HTMLDivElement
  private readonly edgeEl: HTMLDivElement
  private readonly lineEl: HTMLDivElement
  private readonly clock = new ExposureClock()
  private state: SuitState = 'none'
  private alpha = 0

  constructor(doc: Document = document) {
    this.root = doc.createElement('div')
    this.root.dataset.fx = 'radiation'
    this.root.style.cssText = `position:fixed;inset:0;z-index:${Z};pointer-events:none;overflow:hidden`

    // An inset band on all four sides: solid at the very edge, gone a fifth of the
    // way in. The centre of the screen — where the player is — is never tinted.
    this.edgeEl = doc.createElement('div')
    this.edgeEl.dataset.fx = 'radiation-edge'
    this.edgeEl.style.cssText = `position:absolute;inset:0;opacity:0;
      box-shadow:inset 0 0 140px 36px rgba(${GLOW},0.9)`

    // Above §C8's bar cluster (`bars.ts`: `left:10px;bottom:56px`, three 20 px rows),
    // so the line sits on the energy bar it is about. **Wraps** inside the viewport
    // less its 10 px margins (T22.09C F8): `nowrap` at a fixed size clipped the
    // RADIATION line below ~550 px of width. It grows upward, off `bottom`.
    this.lineEl = doc.createElement('div')
    this.lineEl.dataset.fx = 'radiation-line'
    this.lineEl.style.cssText = `position:absolute;left:10px;bottom:124px;display:none;
      padding:3px 8px;border-radius:3px;background:rgba(0,0,0,0.6);
      font:700 13px/1.3 ui-monospace,monospace;letter-spacing:1px;
      box-sizing:border-box;max-width:calc(100vw - 20px);white-space:normal`

    this.root.append(this.edgeEl, this.lineEl)
    doc.body.append(this.root)
  }

  /**
   * One frame. `live` is "the round is in `Playing`" (F8). `period` is
   * `RADIATION_LOG_INTERVAL`, so the glow crests with each damage number. Everything is re-derived from the inputs every call; the only
   * memory is the exposure clock, which exists to put the crest on the onset.
   */
  update(dt: number, space: boolean, alive: boolean, irradiated: boolean, live: boolean, period: number): void {
    const state = suitState(space, alive, irradiated, live)
    this.clock.update(dt, state)
    this.alpha = state === 'irradiated' ? edgeAlpha(this.clock.seconds, period) : 0
    this.edgeEl.style.opacity = String(this.alpha)
    if (state !== this.state) {
      this.state = state
      const text = suitLine(state)
      this.lineEl.textContent = text ?? ''
      this.lineEl.style.display = text === null ? 'none' : 'block'
      // Loud when it hurts, quiet when it is working.
      this.lineEl.style.color = state === 'irradiated' ? `rgb(${GLOW})` : '#9fc4d8'
      this.lineEl.style.fontSize = state === 'irradiated' ? '15px' : '12px'
    }
  }

  /**
   * For `debug()` and the `radiation` check: what is **mounted**, read back off the
   * DOM rather than off the model (§A15) — plus the line's box, so a check can aim a
   * pixel patch at it instead of at a remembered position.
   */
  stats(): {
    state: SuitState
    edgeOpacity: number
    line: string | null
    lineRect: { x: number; y: number; w: number; h: number } | null
  } {
    const shown = this.lineEl.style.display !== 'none'
    // A plain object: a `DOMRect` does not survive `page.evaluate`'s serialisation.
    const r = shown ? this.lineEl.getBoundingClientRect() : null
    return {
      state: this.state,
      edgeOpacity: Number(this.edgeEl.style.opacity),
      line: shown ? this.lineEl.textContent : null,
      lineRect: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
    }
  }

  destroy(): void {
    this.root.remove()
  }
}
