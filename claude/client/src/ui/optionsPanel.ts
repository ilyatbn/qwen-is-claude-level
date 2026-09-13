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

import { isFpsCounter, isHighQuality, setFpsCounter, setHighQuality } from './settings'

const PANEL =
  'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:46;' +
  'min-width:320px;padding:18px 20px;border-radius:10px;' +
  'border:1px solid rgba(255,255,255,.22);background:rgba(18,24,38,.96);' +
  'font:400 14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e9edf5;' +
  'pointer-events:auto;'

const ROW = 'display:flex;align-items:center;justify-content:space-between;gap:16px;margin:14px 0;'

const BTN =
  'padding:7px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.25);' +
  'background:rgba(40,50,72,.95);font:700 13px/1 ui-monospace,monospace;' +
  'color:#e9edf5;cursor:pointer;pointer-events:auto;'

/**
 * One button's appearance, from one boolean.
 *
 * Shared rather than copied: the second toggle arrived and the first thing a
 * copy would have dropped is the `aria-pressed` the first one earned.
 */
function paint(btn: HTMLButtonElement, on: boolean): void {
  btn.textContent = on ? 'On' : 'Off'
  btn.setAttribute('aria-pressed', String(on))
  btn.style.borderColor = on ? 'rgba(120,220,255,.75)' : 'rgba(255,255,255,.25)'
}

export interface OptionsPanelDeps {
  /** Close, so the scene can keep its own idea of what is open in step. */
  onClose(): void
  /** Where the setting is persisted. Injected so a test can supply its own. */
  storage: Pick<Storage, 'setItem'>
}

export class OptionsPanel {
  readonly root: HTMLDivElement
  readonly quality: HTMLButtonElement
  readonly fps: HTMLButtonElement
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
    title.style.cssText = 'font-weight:700;font-size:16px;margin-bottom:4px;'

    const row = doc.createElement('div')
    row.style.cssText = ROW
    const label = doc.createElement('span')
    label.textContent = 'High quality effects'
    // Said plainly, because the honest answer to "why is this off?" is that it
    // costs performance and not every machine can run it.
    const hint = doc.createElement('div')
    hint.id = 'options-quality-hint'
    hint.textContent = 'Nicer fog, smoke, fire and beams. Needs a newer graphics card.'
    hint.style.cssText = 'opacity:.62;font-size:12px;margin-top:-8px;'

    this.quality = doc.createElement('button')
    this.quality.id = 'options-quality'
    this.quality.style.cssText = BTN
    this.quality.addEventListener('click', () => {
      // **Read the value back rather than tracking one here.** A panel with its
      // own copy of the setting is a second answer to the same question.
      setHighQuality(this.deps.storage, !isHighQuality())
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
    close.style.cssText = BTN + 'display:block;margin:18px auto 0;'
    close.addEventListener('click', () => this.deps.onClose())

    this.root.append(title, row, hint, fpsRow, fpsHint, close)
    doc.body.appendChild(this.root)
    this.refresh()
  }

  /** Paint the buttons from the settings, never from a local flag. */
  private refresh(): void {
    paint(this.quality, isHighQuality())
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
