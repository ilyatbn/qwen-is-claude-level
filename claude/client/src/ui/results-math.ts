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
 * (T22.12E F4: the time left is `ends_tick − stateTick` whole ticks, so the
 * deadline is the snapshot's round time plus `ends_tick − serverTick` ticks.)
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
  endsTick: number | null,
  simDt: number,
): number {
  // T22.12E F4: **from `ends_tick`, one rule** (R94) — the integer last tick of
  // the phase, which the bell reads too — not the float `time_left` beside it.
  // The deadline is the anchor's round time plus the whole ticks from the anchor
  // to `ends_tick`. `null` (the lobby) has no deadline: "now".
  const ends = endsTick ?? stateTick
  // A restarted round: the anchor belongs to a world that no longer exists.
  if (stateTick < serverTick) return (ends - stateTick) * simDt
  if (serverTick <= 0) return serverRoundTime + (ends - stateTick) * simDt
  return serverRoundTime + (ends - serverTick) * simDt
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

/**
 * Where this client's restart vote stands (T21.32 item 1).
 *
 * `counted` is the **server's** word, never the click's. The button used to read
 * "Voted" the moment it was pressed, and a press after the window had closed —
 * the only kind a stuck results screen could produce — read "Voted" for a vote
 * `round.rs::vote` had thrown away.
 */
export type VoteState = 'none' | 'pending' | 'counted' | 'refused'

export interface VoteButton {
  label: string
  disabled: boolean
}

/**
 * The "Play again" button for a vote state and the time left in the window.
 *
 * Only `none` inside the window is pressable. A window this client's clock
 * says has closed is not offered: the server closes it on its own clock, and a
 * press there would be answered `refused` a moment later anyway.
 */
export function voteButton(state: VoteState, timeLeft: number): VoteButton {
  switch (state) {
    case 'counted':
      return { label: 'Voted', disabled: true }
    case 'pending':
      return { label: 'Voting…', disabled: true }
    case 'refused':
      return { label: 'Vote closed', disabled: true }
    case 'none':
      return voteSecondsLeft(timeLeft) > 0
        ? { label: 'Play again', disabled: false }
        : { label: 'Vote closed', disabled: true }
  }
}

/**
 * The restart vote as the server tallies it (T21.38): `yes` votes of `humans`
 * seated. Bots are in neither number.
 */
export interface VoteTally {
  yes: number
  humans: number
}

/**
 * Read `round_state.votes`, or `null` when it is absent or malformed.
 *
 * The server sends it only while the round is `Ended`. `null` is the honest
 * reading of anything else — never a `{yes: 0, humans: 0}` built from
 * `Number(undefined ?? 0)`, which would render a confident "0 of 0" off a field
 * that does not exist (§B15).
 */
export function parseVoteTally(raw: unknown): VoteTally | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const yes = r['yes']
  const humans = r['humans']
  if (typeof yes !== 'number' || typeof humans !== 'number') return null
  if (!Number.isInteger(yes) || !Number.isInteger(humans) || yes < 0 || humans < 0) return null
  return { yes, humans }
}

/** Every seated human has said yes — the server restarts on this (T21.38 R3). */
export function everyoneSaidYes(tally: VoteTally | null): boolean {
  return tally !== null && tally.humans > 0 && tally.yes >= tally.humans
}

/**
 * The countdown line (T21.32 item 1, reworded by T21.38).
 *
 * "Vote closes in N s" for everyone, voted or not: since T21.38 one counted yes
 * no longer carries the round, so T21.32's "New round in N s" after a counted
 * vote would promise a round that a silent player can still take away. Only a
 * tally showing every human's yes promises one — and the server restarts on that
 * at once, so it says the round is starting rather than counting to it.
 */
export function countdownText(timeLeft: number, tally: VoteTally | null): string {
  if (everyoneSaidYes(tally)) return 'New round starting…'
  const s = voteSecondsLeft(timeLeft)
  if (s <= 0) return 'Vote closed'
  return `Vote closes in ${s} s`
}

/**
 * "2 of 3 players want a rematch" — or nothing, when no tally has arrived.
 */
export function tallyText(tally: VoteTally | null): string {
  if (tally === null) return ''
  const who = tally.humans === 1 ? 'player wants' : 'players want'
  return `${tally.yes} of ${tally.humans} ${who} a rematch`
}

export function resultsView(
  entries: readonly ScoreEntry[],
  timeLeft: number,
  voted: boolean,
): ResultsView {
  return { rows: rankScores(entries), secondsLeft: voteSecondsLeft(timeLeft), voted }
}

/**
 * The rule line under the scoreboard.
 *
 * The rule is the server's `round.rs::RoundController::restart_wins`, from the
 * owner's ruling of 2026-09-15 (T21.38): *"as long as all human players vote
 * yes, restart. If not, title screen."* Silence counts as no; a player who
 * leaves is no longer asked. Bots are not mentioned because they are not asked
 * either. The tally is its own line, `tallyText`, from `round_state.votes`.
 */
export function voteSummary(): string {
  return 'A new round starts only if every player votes Play again — otherwise everyone goes back to the title.'
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
