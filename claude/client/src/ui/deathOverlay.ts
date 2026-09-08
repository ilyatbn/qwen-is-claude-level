/**
 * The death overlay (`docs/71-amendments-v3.md` §B4).
 *
 * DOM, like every screen-space element here: a `scrollFactor(0)` Phaser object
 * is still scaled by camera zoom (§A35).
 *
 * **It is an overlay, not a pause.** The round keeps running behind it and the
 * camera stays where you died, so you watch the fight continue — the same choice
 * `docs/30` §3 makes for the inventory panel, and the reason dying in the open
 * is a real cost rather than a loading screen.
 */
// One escaper, the exported and tested one. This file had a byte-identical
// private copy; a security function with three implementations is a divergence
// waiting to become a vulnerability rather than a wrong number.
import { escapeHtml } from './results-math'
import {
  causeText,
  countdownText,
  secondsLeft,
  shouldShow,
  type DeathInfo,
} from './deathOverlay-math'

export class DeathOverlay {
  private root: HTMLElement | null = null
  private info: DeathInfo | null = null
  private up = false

  died(info: DeathInfo): void {
    this.info = info
  }

  cleared(): void {
    this.info = null
  }

  /** Called every frame with the server's own round time. */
  update(
    dead: boolean,
    roundTime: number,
    nameOf: (id: number) => string | undefined,
    scores: Array<{ name: string; score: number }>,
  ): void {
    if (!shouldShow(dead, this.info)) {
      this.up = false
      this.hide()
      return
    }
    this.up = true
    const left = secondsLeft(this.info, roundTime)
    const el = this.ensure()
    el.querySelector('.death-cause')!.textContent = causeText(this.info, nameOf)
    el.querySelector('.death-count')!.textContent = countdownText(left)
    el.querySelector('.death-scores')!.innerHTML = scores
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((s) => `<li>${escapeHtml(s.name)}<span>${s.score}</span></li>`)
      .join('')
  }

  private ensure(): HTMLElement {
    if (this.root) return this.root
    const el = document.createElement('div')
    el.className = 'death-overlay'
    el.innerHTML = `
      <h2>You died</h2>
      <p class="death-cause"></p>
      <p class="death-count"></p>
      <ul class="death-scores"></ul>
      <p class="hint">The round is still running.</p>`
    document.body.appendChild(el)
    this.root = el
    return el
  }

  private hide(): void {
    this.root?.remove()
    this.root = null
  }

  get isUp(): boolean {
    return this.up
  }

  /**
   * Whether a `died()` has been recorded and not cleared.
   *
   * `isUp` is the conjunction of this and the alive flag, so on its own it
   * cannot say which half is missing when the overlay stays down — and that is
   * exactly what a check needs to report.
   */
  get hasInfo(): boolean {
    return this.info !== null
  }

  destroy(): void {
    this.hide()
    this.info = null
  }
}
