/**
 * §C13's escape menu: Resume, Options (disabled), Quit to title.
 *
 * **An overlay, not a pause.** The round runs behind it, exactly as §B4
 * established for the death screen and `docs/30` §3 for the inventory — nothing
 * here touches the simulation or stops the clock.
 *
 * ## The stacking rule
 *
 * `Esc` closes the **innermost** overlay first: with the backpack open it closes
 * the backpack and leaves the menu alone. That is the whole of `handleEscape`,
 * and it is a function rather than a chain of `if`s in the scene so it can be
 * driven under node — key handling is where this kind of thing usually breaks.
 */

/** What `Esc` did, so the caller can act and a test can assert. */
export type EscapeAction = 'closed-inventory' | 'closed-menu' | 'opened-menu'

export interface EscapeState {
  /** The backpack panel (§C10). */
  inventoryOpen: boolean
  /** This menu. */
  menuOpen: boolean
}

/**
 * Innermost first. Returns what should happen; changes nothing itself.
 *
 * The order is the point: the inventory is *inside* the menu in the sense that
 * matters — it was opened last and it is what the player is looking at — so a
 * single `Esc` must not close both, and must not open the menu on top of it.
 */
export function handleEscape(state: EscapeState): EscapeAction {
  if (state.inventoryOpen) return 'closed-inventory'
  if (state.menuOpen) return 'closed-menu'
  return 'opened-menu'
}

export interface EscapeMenuDeps {
  onResume(): void
  /** Leave the room *and* return to the title. Both, or the seat stays taken. */
  onQuit(): void
}

const BUTTON =
  'display:block;width:220px;margin:0 auto 10px;padding:11px 0;border-radius:6px;' +
  'border:1px solid rgba(255,255,255,.25);background:rgba(30,38,56,.92);' +
  'font:700 15px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e9edf5;' +
  'text-align:center;cursor:pointer;pointer-events:auto;'

export class EscapeMenu {
  readonly root: HTMLDivElement
  readonly options: HTMLButtonElement
  private open = false

  constructor(deps: EscapeMenuDeps, doc: Document = document) {
    this.root = doc.createElement('div')
    this.root.id = 'escape-menu'
    // Centred over the field, and **transparent to the field behind it**: it is
    // an overlay. A full-screen opaque backdrop would say "paused" to the player
    // even though the round is still running, which is the thing §C13 is at
    // pains about.
    this.root.style.cssText =
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:20;' +
      'display:none;padding:22px 26px 12px;border-radius:10px;' +
      'background:rgba(8,10,16,.86);border:1px solid rgba(255,255,255,.2);' +
      'box-shadow:0 8px 40px rgba(0,0,0,.6);pointer-events:auto;'

    const title = doc.createElement('div')
    title.textContent = 'Paused menu'
    title.style.cssText =
      'font:700 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9aa4b8;' +
      'text-align:center;margin-bottom:14px;letter-spacing:1px;'
    this.root.appendChild(title)

    const resume = doc.createElement('button')
    resume.id = 'escape-resume'
    resume.textContent = 'Resume'
    resume.style.cssText = BUTTON
    resume.addEventListener('click', () => deps.onResume())

    // **Present and disabled, not hidden** — the same treatment weapon skins get
    // in the skins menu (§B3), so the player knows it is planned rather than
    // wondering whether they missed it. `disabled` also takes it out of the tab
    // order, which §C13 asks for in as many words.
    this.options = doc.createElement('button')
    this.options.id = 'escape-options'
    this.options.textContent = 'Options — coming soon'
    this.options.disabled = true
    this.options.tabIndex = -1
    this.options.style.cssText = BUTTON + 'opacity:.42;cursor:default;'

    const quit = doc.createElement('button')
    quit.id = 'escape-quit'
    quit.textContent = 'Quit to title'
    quit.style.cssText = BUTTON
    quit.addEventListener('click', () => deps.onQuit())

    this.root.append(resume, this.options, quit)
    doc.body.appendChild(this.root)
  }

  get isOpen(): boolean {
    return this.open
  }

  toggle(open = !this.open): boolean {
    this.open = open
    this.root.style.display = open ? 'block' : 'none'
    return this.open
  }

  destroy(): void {
    this.root.remove()
  }
}
