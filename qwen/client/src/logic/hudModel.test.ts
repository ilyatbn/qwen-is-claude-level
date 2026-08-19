import { describe, expect, it } from 'vitest';
import {
  KILL_FEED_MAX,
  KILL_FEED_TTL_S,
  KillFeed,
  ROUND_DURATION_S,
  dayIcon,
  formatClock,
  killFeedLine,
  roundRemainingS,
  scoreDelta,
} from './hudModel';
import type { Kill } from '../protocol';

const kill = (victim: number, killer: number | null, weapon: string): Kill => ({
  victim,
  killer,
  weapon,
});

describe('round clock', () => {
  it('counts down from the 240 s round (docs/00 §2)', () => {
    expect(roundRemainingS(0)).toBe(ROUND_DURATION_S);
    expect(roundRemainingS(60)).toBe(180);
  });

  it('never goes negative once the round is over', () => {
    expect(roundRemainingS(ROUND_DURATION_S + 5)).toBe(0);
  });

  it('formats mm:ss', () => {
    expect(formatClock(240)).toBe('4:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(0)).toBe('0:00');
  });

  it('rounds up, so 0:00 means time is actually out', () => {
    expect(formatClock(0.4)).toBe('0:01');
    expect(formatClock(59.9)).toBe('1:00');
  });
});

describe('day/night indicator', () => {
  it('is the sun by day and the moon by night (docs/02 §1)', () => {
    expect(dayIcon(0)).toBe('☀');
    expect(dayIcon(0.49)).toBe('☀');
    expect(dayIcon(0.5)).toBe('☾');
    expect(dayIcon(1)).toBe('☾');
  });
});

describe('kill feed lines', () => {
  it('reads victim first (T5.4 step 2)', () => {
    // The two examples in the task only agree under this reading: the weather
    // cannot be killed, so "P2 ☠ weather" must mean P2 died to it.
    expect(killFeedLine(kill(1, 2, 'rocket'))).toBe('P1 ☠ P2 (rocket)');
    expect(killFeedLine(kill(2, null, 'lava'))).toBe('P2 ☠ weather (lava)');
  });

  it('names the weather for a null killer (docs/06 §2)', () => {
    expect(killFeedLine(kill(0, null, 'void'))).toContain('weather');
  });
});

describe('KillFeed', () => {
  it('keeps only the last 5, newest first (T5.4 step 2)', () => {
    const feed = new KillFeed();
    for (let i = 0; i < 8; i += 1) {
      feed.add(kill(i, 9, 'pistol'), 0);
    }
    // The doc's literal 5, not KILL_FEED_MAX: asserting a constant against
    // itself passes whatever the constant becomes.
    expect(feed.size).toBe(5);
    expect(KILL_FEED_MAX).toBe(5);
    const visible = feed.visible(0);
    expect(visible[0]?.text).toContain('P7');
    expect(visible[4]?.text).toContain('P3');
    // The three oldest were evicted, not merely hidden.
    expect(visible.some((e) => e.text.includes('P0'))).toBe(false);
  });

  it('drops entries older than the 4 s TTL (T5.4 step 2)', () => {
    const feed = new KillFeed();
    feed.add(kill(1, 2, 'rocket'), 10);
    expect(KILL_FEED_TTL_S).toBe(4);
    expect(feed.visible(13.99)).toHaveLength(1);
    expect(feed.visible(14)).toHaveLength(0);
  });

  it('fades over the last second rather than vanishing', () => {
    const feed = new KillFeed();
    feed.add(kill(1, 2, 'rocket'), 0);
    const entry = feed.visible(0)[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(feed.alpha(entry, 0)).toBe(1);
    expect(feed.alpha(entry, 3)).toBe(1);
    expect(feed.alpha(entry, 3.5)).toBeCloseTo(0.5, 5);
    expect(feed.alpha(entry, 4)).toBe(0);
  });

  it('prunes, so a long round cannot grow the list without bound', () => {
    const feed = new KillFeed();
    feed.add(kill(1, 2, 'rocket'), 0);
    feed.prune(100);
    expect(feed.size).toBe(0);
  });
});

describe('scoreDelta (docs/03 §6)', () => {
  it('gives the killer +1 and the victim -1', () => {
    expect(scoreDelta(kill(1, 2, 'rocket'), 2)).toBe(1);
    expect(scoreDelta(kill(1, 2, 'rocket'), 1)).toBe(-1);
  });

  it('gives a weather kill to nobody but still costs the victim a point', () => {
    expect(scoreDelta(kill(1, null, 'lava'), 1)).toBe(-1);
    expect(scoreDelta(kill(1, null, 'lava'), 2)).toBe(0);
  });

  it('does not reward a self-kill', () => {
    expect(scoreDelta(kill(1, 1, 'grenade'), 1)).toBe(-1);
  });

  it('is 0 for an uninvolved player', () => {
    expect(scoreDelta(kill(1, 2, 'rocket'), 3)).toBe(0);
  });
});
