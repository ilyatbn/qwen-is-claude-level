/**
 * The end-of-round results screen — the pure half (§A8: no Phaser, no DOM here).
 *
 * `docs/72-amendments-v4.md` §C3. The server's `Ended` phase has existed and
 * worked since T6.12 and the client ignored it, so `ROUND_SECONDS` elapsed and
 * nothing happened — §A39 for the fourteenth time, a mechanism with no consumer.
 *
 * The ordering is **not** reimplemented here: `rankScores` already encodes
 * `docs/21` §6 (score desc, fewest deaths, join order) and shows ties as ties.
 * A second sort would be a second thing to keep correct, and the two would
 * disagree on the first tie (§A24).
 */
import { rankScores, type ScoreEntry, type ScoreRow } from './scoreboard'

export interface ResultsView {
  rows: ScoreRow[]
  /** Whole seconds until the vote window closes; never negative. */
  secondsLeft: number
  /** True once this client has voted, so the button can stop inviting a re-click. */
  voted: boolean
}

/**
 * Should the screen be up?
 *
 * Phase only. Deliberately not "the timer reached zero": the client's clock and
 * the server's disagree by the latency the whole netcode exists to hide, and the
 * authority on which phase the round is in is the server (`docs/41` §3). A
 * client that decided this locally would show the results a beat early and take
 * input away from a player who could still act.
 */
export function shouldShowResults(phase: string): boolean {
  return phase === 'ended'
}

/**
 * Seconds left in the vote window, floored at 0.
 *
 * `time_left` comes from `round_state`, which is broadcast on every transition
 * and once a second while playing. Between those it is stale by up to a second,
 * so this is display only — nothing is decided by it here, and the server closes
 * the window on its own clock.
 */
export function voteSecondsLeft(timeLeft: number): number {
  return Math.max(0, Math.ceil(timeLeft))
}

export function resultsView(
  entries: readonly ScoreEntry[],
  timeLeft: number,
  voted: boolean,
): ResultsView {
  return { rows: rankScores(entries), secondsLeft: voteSecondsLeft(timeLeft), voted }
}

/**
 * The line under the buttons.
 *
 * It states the **rule**, not a tally, and that is a deliberate limit rather than
 * a simplification: `round_state` carries `phase`, `time_left` and `seed` and
 * **no vote information at all**, so a client cannot know how many have voted.
 * An earlier draft of this rendered `${votesFor}/${connected}` from a
 * `votes_for` field that does not exist — `Number(undefined ?? 0)` is 0, so it
 * would have displayed a confident `0/4` for the whole window and never once
 * failed (§B15).
 *
 * The rule itself is the server's: `restart_wins` is `yes * 2 > cast`, a majority
 * of those who **voted**, with abstentions ignored (`docs/41` §3 — "a player who
 * alt-tabs should not veto the round"). Note that §3 *also* says "majority of
 * connected", which cannot both hold; see the journal entry for T13.06.
 */
export function voteSummary(): string {
  return 'A majority of the players who vote starts a new round.'
}

/**
 * Escape text before it goes anywhere near `innerHTML`.
 *
 * Player names arrive from `join` and are **attacker-controlled** (`docs/40` §2
 * validates length, not content), and this screen renders every player in the
 * room. A name of `<img src=x onerror=...>` would run in every other player's
 * page, so this is an injection guard rather than a formatting nicety.
 *
 * `deathOverlay.ts` carries its own private copy of this. Two copies of an
 * escaper is exactly §A24's shape — the second one to be written is the one that
 * gets a case wrong — so that file should import this and lose its own. Not done
 * here: `deathOverlay.ts` is outside this task's **Touch only**.
 */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}
