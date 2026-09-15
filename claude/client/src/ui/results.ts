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
  countdownText,
  escapeHtml,
  resultsView,
  shouldShowResults,
  voteButton,
  voteSummary,
  type ResultsView,
  type VoteState,
} from './results-math'
import type { ScoreEntry } from './scoreboard'

export interface ResultsHandlers {
  onPlayAgain(): void
  onExit(): void
}

export class ResultsScreen {
  private root: HTMLElement | null = null
  private up = false
  /** The server's word on this client's vote, not the click's (T21.32 item 1). */
  private vote: VoteState = 'none'
  /** The window's time left as of the last frame, so a click can be judged by it. */
  private timeLeft = 0
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
      // A new round starts with a clean slate: leaving the vote set would grey the
      // button out for the whole of the next vote.
      if (this.up) this.vote = 'none'
      this.up = false
      this.hide()
      return
    }
    this.up = true
    this.timeLeft = timeLeft
    this.render(resultsView(entries, timeLeft, this.vote === 'counted'))
  }

  /** The server's `vote_counted` answer to this client's press. */
  voteCounted(counted: boolean): void {
    if (this.vote === 'pending') this.vote = counted ? 'counted' : 'refused'
  }

  private render(view: ResultsView): void {
    const el = this.ensure()
    // T21.32 item 1: a visible countdown with words, not a bare `12s` that went
    // blank the moment the window closed and left the screen up with nothing on it.
    el.querySelector('.results-count')!.textContent = countdownText(this.vote, this.timeLeft)
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
    const button = voteButton(this.vote, this.timeLeft)
    again.disabled = button.disabled
    again.textContent = button.label
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
        // The same rule the button is drawn from, so a click cannot do what the
        // label says it will not.
        if (voteButton(this.vote, this.timeLeft).disabled) return
        this.vote = 'pending'
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
