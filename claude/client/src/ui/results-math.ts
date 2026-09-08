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
 * Display only — nothing is decided by it here, and the server closes the window
 * on its own clock.
 */
export function voteSecondsLeft(timeLeft: number): number {
  return Math.max(0, Math.ceil(timeLeft))
}

/**
 * The round time at which the current phase ends.
 *
 * §C25: the countdown was **static**. `round_state` is broadcast on every phase
 * transition and then once a second *while `Playing`* — `round.rs`'s `Ended` and
 * `Warmup` branches emit none at all. So a client received exactly one
 * `round_state` saying `ended, ENDED_SECONDS`, wrote it into a field, and
 * rendered that same number for the whole twenty-second window. The HUD's
 * "Round over — 0:20" and "Warmup — 0:10" banners read the same field and were
 * frozen for the same reason, which is why this is a deadline for **any** phase
 * rather than one for the vote.
 *
 * The fix is T10.06's, which §B4 states as a rule: hold the **deadline** and
 * recompute against the server's clock on every snapshot, rather than holding a
 * remaining time. A local stopwatch drifts, and this one has a vote deadline
 * attached to it.
 *
 * The deadline is computed in the server's own frame rather than the client's,
 * so it carries no latency term. `round_state` and every snapshot both carry a
 * `tick`, and during a round `tick` and `round_time` advance together at
 * `SIM_DT`, so the round time at `stateTick` is the last snapshot's round time
 * walked back by the tick difference. The result equals the server's
 * `phase_started_at + ENDED_SECONDS` exactly.
 *
 * `serverTick <= 0` means no snapshot has landed yet — the `round_state` a
 * client is sent as part of its own join arrives before the first one. There is
 * nothing to correct against then, and the `welcome` that precedes it was built
 * from the same instant, so the correction is skipped rather than applied
 * against a zero.
 *
 * `stateTick < serverTick` means the server's clock went **backwards**, and
 * there is exactly one way that happens: `Room::restart` assigns a whole new
 * `World`, so `tick` and `round_time` both reset to 0 for the second and every
 * later round. Correcting against the previous round's anchor gave
 * `(1 - 15000) * SIM_DT = -250 s`, a deadline of 0.02, and therefore
 * "Warmup — 0:00" for the entire warmup of every round after the first, plus a
 * dead results countdown at the end of it. The anchor is stale, not merely
 * imprecise, so it is discarded: a fresh world's round time is 0, which makes
 * `timeLeft` the deadline outright.
 */
export function phaseDeadline(
  serverRoundTime: number,
  serverTick: number,
  stateTick: number,
  timeLeft: number,
  simDt: number,
): number {
  // A restarted round: the anchor belongs to a world that no longer exists.
  if (stateTick < serverTick) return timeLeft
  const correction = serverTick > 0 ? (stateTick - serverTick) * simDt : 0
  return serverRoundTime + correction + timeLeft
}

/**
 * Seconds until `deadline`, on the server's clock. May be negative.
 *
 * Kept separate from `voteSecondsLeft` so the raw number can be asserted against
 * the server's `time_left` without a rounding rule in the way.
 */
export function secondsUntil(deadline: number, roundTime: number): number {
  return deadline - roundTime
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
