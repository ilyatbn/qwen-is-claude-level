/**
 * HUD state that is logic rather than drawing: the round clock, the day/night
 * indicator, and the kill feed (T5.4, docs/07 §5).
 *
 * Kept pure and Phaser-free so it is Vitest-tested; `hud/Hud.ts` renders it.
 */
import type { Kill } from '../protocol';

/** docs/00 §2: a round is 240 s. */
export const ROUND_DURATION_S = 240;

/** T5.4 step 2: "last 5, fade after 4 s". */
export const KILL_FEED_MAX = 5;
export const KILL_FEED_TTL_S = 4;

/** Seconds left in the round, from the snapshot's elapsed `round_time_s`. */
export function roundRemainingS(roundTimeS: number): number {
  return Math.max(0, ROUND_DURATION_S - roundTimeS);
}

/** `mm:ss`, rounded up so the clock only shows 0:00 when time is actually out. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Sun or moon for the day/night indicator (T5.4 step 1).
 *
 * `day_phase` is 0 at full day and 1 at full night (docs/02 §1), ramping over
 * the 5 s transitions, so the halfway point is the only sensible switch.
 */
export function dayIcon(dayPhase: number): '☀' | '☾' {
  return dayPhase < 0.5 ? '☀' : '☾';
}

export interface KillFeedEntry {
  readonly text: string;
  readonly at: number;
}

/**
 * One kill feed line (T5.4 step 2: "P1 ☠ P2 (rocket)", "P2 ☠ weather (lava)").
 *
 * Victim first. The two examples only agree under that reading: "P2 ☠ weather"
 * has to mean P2 was killed BY the weather, since the weather cannot be
 * killed. `killer: null` is a weather or void death (docs/06 §2).
 */
export function killFeedLine(kill: Kill): string {
  const killer = kill.killer === null ? 'weather' : `P${kill.killer}`;
  return `P${kill.victim} ☠ ${killer} (${kill.weapon})`;
}

/**
 * The last few kills, newest first, dropping entries older than the TTL.
 *
 * Time is passed in rather than read, so the fade is testable.
 */
export class KillFeed {
  private entries: KillFeedEntry[] = [];

  add(kill: Kill, nowS: number): void {
    this.entries.unshift({ text: killFeedLine(kill), at: nowS });
    this.entries = this.entries.slice(0, KILL_FEED_MAX);
  }

  /** Visible lines at `nowS`, newest first. */
  visible(nowS: number): readonly KillFeedEntry[] {
    return this.entries.filter((entry) => nowS - entry.at < KILL_FEED_TTL_S);
  }

  /** 1 while fresh, falling to 0 across the last second before expiry. */
  alpha(entry: KillFeedEntry, nowS: number): number {
    const age = nowS - entry.at;
    if (age <= KILL_FEED_TTL_S - 1) {
      return 1;
    }
    return Math.max(0, KILL_FEED_TTL_S - age);
  }

  /** Drop expired entries so the list cannot grow without bound. */
  prune(nowS: number): void {
    this.entries = this.entries.filter((entry) => nowS - entry.at < KILL_FEED_TTL_S);
  }

  get size(): number {
    return this.entries.length;
  }
}

/**
 * The score change this kill causes for `playerId`, or 0 (T5.4 step 4).
 *
 * Mirrors `Round::kill` (docs/03 §6): the victim always loses a point, and the
 * killer gains one only when the killer is a different player — "weather kills
 * give no score to anyone", and neither do self-kills.
 */
export function scoreDelta(kill: Kill, playerId: number): number {
  if (kill.victim === playerId) {
    return -1;
  }
  if (kill.killer === playerId && kill.killer !== kill.victim) {
    return 1;
  }
  return 0;
}
