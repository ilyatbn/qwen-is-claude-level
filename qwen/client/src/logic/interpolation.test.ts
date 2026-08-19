/**
 * docs/08 §3 (`interpolation.ts` row): "lerp_snapshots — same snapshot -> same
 * point; t=0 -> prev, t=1 -> next; ... assert monotonic."
 */
import { describe, expect, it } from 'vitest';
import {
  INTERPOLATION_DELAY_MS,
  SnapshotInterpolator,
  interpolationFactor,
  lerp,
  lerpAngle,
  type TimedSnapshot,
} from './interpolation';
import type { PlayerSnap, Six, Snapshot } from '../protocol';

function player(id: number, x: number, y: number, facing = 0): PlayerSnap {
  return {
    id,
    name: `p${id}`,
    skin: 0,
    x,
    y,
    facing,
    health: 100,
    max_health: 100,
    shield_remaining: 0,
    jetpack_fuel: 5,
    fov: 420,
    alive: true,
    respawn_in_s: 0,
    score: 0,
    slots: [null, null, null, null, null, null],
    selected: 0,
    ammo: [0, 0, 0, 0, 0, 0],
  };
}

function snapshot(tick: number, x: number, y: number, facing = 0): Snapshot {
  const players = [
    player(0, x, y, facing),
    player(1, 0, 0),
    player(2, 0, 0),
    player(3, 0, 0),
    player(4, 0, 0),
    player(5, 0, 0),
  ] as Six<PlayerSnap>;
  return {
    tick,
    round_time_s: tick * 0.05,
    day_phase: 0,
    fog: { active: false, remaining_s: 0 },
    effect: null,
    map_version: 0,
    players,
    items: [],
    projectiles: [],
  };
}

const timed = (s: Snapshot, at: number): TimedSnapshot => ({
  snapshot: s,
  receivedAt: at,
});

describe('lerp', () => {
  it('returns the endpoints at t=0 and t=1', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it('is linear in between', () => {
    expect(lerp(10, 20, 0.5)).toBe(15);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });
});

describe('lerpAngle', () => {
  it('matches lerp away from the wrap boundary', () => {
    expect(lerpAngle(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('takes the short way across the ±π boundary', () => {
    // +3.0 -> -3.0 is 0.283 rad the short way, 6.0 the long way. Plain lerp
    // would spin the player almost a full turn.
    const mid = lerpAngle(3.0, -3.0, 0.5);
    const dist = Math.abs(Math.atan2(Math.sin(mid - 3.0), Math.cos(mid - 3.0)));
    expect(dist).toBeLessThan(0.2);
  });

  it('returns the endpoints at t=0 and t=1', () => {
    expect(lerpAngle(1.0, 2.0, 0)).toBeCloseTo(1.0, 6);
    expect(lerpAngle(1.0, 2.0, 1)).toBeCloseTo(2.0, 6);
  });
});

describe('interpolationFactor', () => {
  const prev = timed(snapshot(0, 0, 0), 1000);
  const next = timed(snapshot(2, 100, 0), 1100);

  it('is 0 at prev and 1 at next', () => {
    expect(interpolationFactor(prev, next, 1000)).toBe(0);
    expect(interpolationFactor(prev, next, 1100)).toBe(1);
  });

  it('is 0.5 halfway', () => {
    expect(interpolationFactor(prev, next, 1050)).toBeCloseTo(0.5, 6);
  });

  it('clamps outside the interval rather than extrapolating', () => {
    // Extrapolation would fling a player past its last known position when a
    // snapshot is late.
    expect(interpolationFactor(prev, next, 500)).toBe(0);
    expect(interpolationFactor(prev, next, 9999)).toBe(1);
  });

  it('handles two snapshots at the same instant', () => {
    const same = timed(snapshot(2, 100, 0), 1000);
    expect(interpolationFactor(prev, same, 1000)).toBe(1);
  });
});

describe('SnapshotInterpolator', () => {
  it('returns the single known position before two snapshots exist', () => {
    const interp = new SnapshotInterpolator();
    expect(interp.renderState(0, 1000)).toBeUndefined();
    interp.push(snapshot(0, 50, 60), 1000);
    expect(interp.renderState(0, 1000)).toEqual({ x: 50, y: 60, facing: 0 });
  });

  it('interpolates between the last two snapshots with the 100 ms delay', () => {
    const interp = new SnapshotInterpolator();
    interp.push(snapshot(0, 0, 0), 1000);
    interp.push(snapshot(2, 100, 0), 1100);

    // At now = 1100, render time is 1000 (delay 100 ms) -> t = 0 -> prev.
    expect(interp.renderState(0, 1100)?.x).toBeCloseTo(0, 6);
    // At now = 1200, render time is 1100 -> t = 1 -> next.
    expect(interp.renderState(0, 1200)?.x).toBeCloseTo(100, 6);
    // Halfway.
    expect(interp.renderState(0, 1150)?.x).toBeCloseTo(50, 6);
  });

  it('uses the documented 100 ms delay', () => {
    expect(INTERPOLATION_DELAY_MS).toBe(100);
  });

  it('gives the same point for two identical snapshots', () => {
    // docs/08 §3: "same snapshot -> same point".
    const interp = new SnapshotInterpolator();
    interp.push(snapshot(0, 42, 24), 1000);
    interp.push(snapshot(2, 42, 24), 1100);
    for (const now of [1100, 1120, 1150, 1180, 1200]) {
      const state = interp.renderState(0, now);
      expect(state?.x).toBeCloseTo(42, 6);
      expect(state?.y).toBeCloseTo(24, 6);
    }
  });

  it('is monotonic across the interval', () => {
    // docs/08 §3: "assert monotonic".
    const interp = new SnapshotInterpolator();
    interp.push(snapshot(0, 0, 0), 1000);
    interp.push(snapshot(2, 100, 0), 1100);
    let last = -Infinity;
    for (let now = 1080; now <= 1220; now += 5) {
      const x = interp.renderState(0, now)?.x ?? 0;
      expect(x).toBeGreaterThanOrEqual(last - 1e-9);
      last = x;
    }
  });

  it('drops out-of-order and duplicate snapshots', () => {
    // A late snapshot would rewind the render position visibly.
    const interp = new SnapshotInterpolator();
    interp.push(snapshot(0, 0, 0), 1000);
    interp.push(snapshot(2, 100, 0), 1100);
    interp.push(snapshot(1, -500, 0), 1150); // stale
    interp.push(snapshot(2, -500, 0), 1160); // duplicate tick
    expect(interp.renderState(0, 1200)?.x).toBeCloseTo(100, 6);
  });

  it('returns undefined for a player absent from the snapshot', () => {
    const interp = new SnapshotInterpolator();
    interp.push(snapshot(0, 0, 0), 1000);
    expect(interp.renderState(99, 1000)).toBeUndefined();
  });
});
