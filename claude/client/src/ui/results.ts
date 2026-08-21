/**
 * The end-of-round results screen (`docs/72-amendments-v4.md` §C3).
 *
 * DOM, like every screen-space element here: a `scrollFactor(0)` Phaser object is
 * still scaled by camera zoom, so it lands off-viewport at `CAMERA_ZOOM` 2 (§A35).
 *
 * Unlike the death overlay, this one **does** take the controls away — the round
 * is over, the server has frozen the simulation, and a client that keeps sending
 * input queues a burst that arrives on the next round.
 */
import {
  escapeHtml,
  resultsView,
  shouldShowResults,
  voteSummary,
  type ResultsView,
} from './results-math'
import type { ScoreEntry } from './scoreboard'

export interface ResultsHandlers {
  onPlayAgain(): void
  onExit(): void
}

export class ResultsScreen {
  private root: HTMLElement | null = null
  private up = false
  private voted = false
  private readonly handlers: ResultsHandlers

  constructor(handlers: ResultsHandlers) {
    this.handlers = handlers
  }

  /** Called every frame with the server's phase and its own round clock. */
  update(
    phase: string,
    timeLeft: number,
    entries: readonly ScoreEntry[],
  ): void {
    if (!shouldShowResults(phase)) {
      // A new round starts with a clean slate: leaving `voted` set would grey the
      // button out for the whole of the next vote.
      if (this.up) this.voted = false
      this.up = false
      this.hide()
      return
    }
    this.up = true
    this.render(resultsView(entries, timeLeft, this.voted))
  }

  private render(view: ResultsView): void {
    const el = this.ensure()
    el.querySelector('.results-count')!.textContent =
      view.secondsLeft > 0 ? `${view.secondsLeft}s` : ''
    el.querySelector('.results-vote')!.textContent = voteSummary()
    el.querySelector('.results-rows')!.innerHTML = view.rows
      .map(
        (r) =>
          `<li class="${r.isLocal ? 'me' : ''}">` +
          `<span class="rank">${r.tied ? '=' : ''}${r.rank}</span>` +
          `<span class="name">${escapeHtml(r.name)}</span>` +
          `<span class="deaths">${r.deaths}</span>` +
          `<span class="score">${r.score}</span>` +
          `</li>`,
      )
      .join('')
    const again = el.querySelector<HTMLButtonElement>('.results-again')!
    again.disabled = this.voted
    again.textContent = this.voted ? 'Voted' : 'Play again'
  }

  private ensure(): HTMLElement {
    if (this.root) return this.root
    const el = document.createElement('div')
    el.className = 'results-screen'
    el.innerHTML = `
      <h2>Round over</h2>
      <ol class="results-head"><li>
        <span class="rank"></span><span class="name">player</span>
        <span class="deaths">deaths</span><span class="score">score</span>
      </li></ol>
      <ol class="results-rows"></ol>
      <p class="results-vote"></p>
      <p class="results-count"></p>
      <div class="results-buttons">
        <button class="results-again">Play again</button>
        <button class="results-exit">Exit to title</button>
      </div>`
    el.querySelector<HTMLButtonElement>('.results-again')!.addEventListener(
      'click',
      () => {
        if (this.voted) return
        this.voted = true
        this.handlers.onPlayAgain()
      },
    )
    el.querySelector<HTMLButtonElement>('.results-exit')!.addEventListener(
      'click',
      () => this.handlers.onExit(),
    )
    document.body.appendChild(el)
    this.root = el
    return el
  }

  private hide(): void {
    this.root?.remove()
    this.root = null
  }

  /** True while the screen is up — the scene reads this to stop sending input. */
  get isUp(): boolean {
    return this.up
  }

  destroy(): void {
    this.hide()
    this.up = false
  }
}
