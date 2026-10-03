/**
 * The options panel (T21.16).
 *
 * DOM and screen-space like every other overlay here (§A35), and **an overlay,
 * not a pause**: the round keeps running behind it, exactly as §B4 established
 * for the death screen and `docs/30` §3 for the inventory. Nothing in this file
 * touches the simulation.
 *
 * One setting so far — **High Quality**, which selects the shader versions of
 * the game's effects where they exist. It ships before any of them do, on
 * purpose: a switch whose plumbing is proven before anything reads it is a
 * switch the first effect can simply use.
 */

import { highQualityChoice, isFpsCounter, setFpsCounter, setHighQuality } from './settings'
import { HUD_ACCENT_CSS, HUD_BUTTON, HUD_HAIRLINE, HUD_INK, HUD_INK_DIM, HUD_PANEL_BG, HUD_SERIF, HUD_SHADOW } from './hudStyle'

/**
 * T23.21B: F's panel and type (`hudStyle.ts`) — night ink, one hairline, square; the serif in the HUD's ink. The font
 * face is installed by the HUD and the escape menu this opens from (this constructor is also driven under node with a
 * fake document, which has no `<head>`).
 */
const PANEL =
  'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:46;' +
  `min-width:320px;padding:18px 20px;border:${HUD_HAIRLINE};background:${HUD_PANEL_BG};` +
  `font:400 14px/1.5 ${HUD_SERIF};letter-spacing:.04em;color:${HUD_INK};text-shadow:${HUD_SHADOW};` +
  'pointer-events:auto;'

const ROW = 'display:flex;align-items:center;justify-content:space-between;gap:16px;margin:14px 0;'

const BTN = `${HUD_BUTTON}padding:7px 14px;font-size:13px;`

/**
 * One button's appearance, from one boolean.
 *
 * Shared rather than copied: the second toggle arrived and the first thing a
 * copy would have dropped is the `aria-pressed` the first one earned.
 */
function paint(btn: HTMLButtonElement, on: boolean, label: string = on ? 'On' : 'Off'): void {
  btn.textContent = label
  btn.setAttribute('aria-pressed', String(on))
  // T23.21B: "on" is the player's colour (R10), "off" the hairline — the quick bar's selected/idle rule.
  btn.style.borderColor = on ? HUD_ACCENT_CSS : HUD_INK_DIM
}

/** The hint under High Quality when the machine can run it. */
export const QUALITY_HINT = 'Nicer fog, smoke, fire and beams. Needs a newer graphics card.'
/** The hint when it cannot (T21.33). */
export const QUALITY_HINT_NO_WEBGL = 'Needs WebGL, which this browser is not using.'

/**
 * What the High Quality row shows (T21.33; R20 for the never-chosen state).
 *
 * **With no WebGL the toggle is disabled and reads Off**, whatever is stored: every effect
 * it selects is a shader, a shader cannot run on the Canvas renderer, and each shader site
 * already falls back through `hasWebGL`. A button reading On there would be a setting the
 * player flips, sees nothing, and cannot explain. The stored value is left alone, so the
 * same player on a WebGL browser keeps their choice.
 *
 * **Never chosen (`choice === null`) reads "Auto (Full)" / "Auto (Low)"**, from the tier the
 * world renderer detected on this machine (`settings.ts::detectTier`) — so the row says what
 * the player is actually getting, where "Off" on a detected-full GPU said the opposite. `on` is
 * the tier in force, and it is what a click flips: **one click stores the other choice
 * explicitly** (Auto (Full) → Off, Auto (Low) → On), so the click always changes the picture.
 */
export function qualityRow(
  shadersAvailable: boolean,
  choice: boolean | null,
  detected: 'full' | 'low',
): { on: boolean; label: string; disabled: boolean; hint: string } {
  if (!shadersAvailable) return { on: false, label: 'Off', disabled: true, hint: QUALITY_HINT_NO_WEBGL }
  if (choice === null) {
    const on = detected === 'full'
    return { on, label: on ? 'Auto (Full)' : 'Auto (Low)', disabled: false, hint: QUALITY_HINT }
  }
  return { on: choice, label: choice ? 'On' : 'Off', disabled: false, hint: QUALITY_HINT }
}

export interface OptionsPanelDeps {
  /** T21.33: can this renderer run shaders at all? `hasWebGL(scene)` — asked, not assumed. */
  shadersAvailable: boolean
  /** Close, so the scene can keep its own idea of what is open in step. */
  onClose(): void
  /** Where the setting is persisted. Injected so a test can supply its own. */
  storage: Pick<Storage, 'setItem'>
  /**
   * R20: the tier detected on this machine's GPU, for the never-chosen label — asked at each
   * paint, because the world renderer (which owns the context it is read from) loads later.
   */
  detectedTier(): 'full' | 'low'
}

export class OptionsPanel {
  readonly root: HTMLDivElement
  readonly quality: HTMLButtonElement
  readonly fps: HTMLButtonElement
  private readonly qualityHint: HTMLDivElement
  private open = false

  constructor(
    private readonly deps: OptionsPanelDeps,
    doc: Document = document,
  ) {
    this.root = doc.createElement('div')
    this.root.id = 'options-panel'
    this.root.style.cssText = PANEL
    this.root.hidden = true

    const title = doc.createElement('div')
    title.textContent = 'Options'
    title.style.cssText = 'font-size:15px;letter-spacing:.2em;margin-bottom:4px;opacity:.85;'

    const row = doc.createElement('div')
    row.style.cssText = ROW
    const label = doc.createElement('span')
    label.textContent = 'High quality effects'
    // Said plainly, because the honest answer to "why is this off?" is that it
    // costs performance and not every machine can run it.
    const hint = doc.createElement('div')
    hint.id = 'options-quality-hint'
    hint.style.cssText = 'opacity:.62;font-size:12px;margin-top:-8px;'
    this.qualityHint = hint

    this.quality = doc.createElement('button')
    this.quality.id = 'options-quality'
    this.quality.className = 'hud-btn'
    this.quality.style.cssText = BTN
    this.quality.addEventListener('click', () => {
      // A disabled button fires no click, but the rule belongs to the row, not to the DOM.
      const q = this.row()
      if (q.disabled) return
      // **Read the value back rather than tracking one here.** A panel with its
      // own copy of the setting is a second answer to the same question. R20: from
      // "Auto" the click stores the opposite of the tier in force, explicitly.
      setHighQuality(this.deps.storage, !q.on)
      this.refresh()
    })

    row.append(label, this.quality)

    // --- T21.24: the FPS counter -------------------------------------------
    //
    // **Below High Quality and independent of it.** The counter exists so a
    // player can decide for themselves whether the setting above costs anything
    // on their machine, which needs it readable in both modes; gating it behind
    // High Quality would leave exactly one of the two numbers unmeasurable.
    const fpsRow = doc.createElement('div')
    fpsRow.style.cssText = ROW
    const fpsLabel = doc.createElement('span')
    fpsLabel.textContent = 'Show frame rate'

    const fpsHint = doc.createElement('div')
    fpsHint.id = 'options-fps-hint'
    fpsHint.textContent = 'A small counter in the top-left corner, for judging what an effect costs.'
    fpsHint.style.cssText = 'opacity:.62;font-size:12px;margin-top:-8px;'

    this.fps = doc.createElement('button')
    this.fps.id = 'options-fps'
    this.fps.className = 'hud-btn'
    this.fps.style.cssText = BTN
    this.fps.addEventListener('click', () => {
      // Read back, never tracked here — the same rule the button above follows.
      setFpsCounter(this.deps.storage, !isFpsCounter())
      this.refresh()
    })

    fpsRow.append(fpsLabel, this.fps)

    const close = doc.createElement('button')
    close.id = 'options-close'
    close.textContent = 'Back'
    close.className = 'hud-btn'
    close.style.cssText = BTN + 'display:block;margin:18px auto 0;'
    close.addEventListener('click', () => this.deps.onClose())

    this.root.append(title, row, hint, fpsRow, fpsHint, close)
    doc.body.appendChild(this.root)
    this.refresh()
  }

  /** Paint the buttons from the settings, never from a local flag. */
  private row(): ReturnType<typeof qualityRow> {
    return qualityRow(this.deps.shadersAvailable, highQualityChoice(), this.deps.detectedTier())
  }

  private refresh(): void {
    const q = this.row()
    paint(this.quality, q.on, q.label)
    this.quality.disabled = q.disabled
    this.quality.style.opacity = q.disabled ? '.45' : '1'
    this.quality.style.cursor = q.disabled ? 'not-allowed' : 'pointer'
    this.qualityHint.textContent = q.hint
    paint(this.fps, isFpsCounter())
  }

  isOpen(): boolean {
    return this.open
  }

  toggle(on = !this.open): void {
    this.open = on
    this.root.hidden = !on
    if (on) this.refresh()
  }

  destroy(): void {
    this.root.remove()
  }
}
