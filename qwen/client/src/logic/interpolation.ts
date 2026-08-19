/**
 * Snapshot interpolation (T2.9, docs/00 §2, docs/08 §3).
 *
 * docs/00 §2: "Renders remote players by linearly interpolating between the
 * last two snapshots (render at 60 fps, 100 ms interpolation delay)."
 *
 * Pure — no Phaser (D10).
 */
import type { PlayerSnap, Snapshot } from '../protocol';

/** Interpolation delay, ms (docs/00 §2). */
export const INTERPOLATION_DELAY_MS = 100;

/** A snapshot tagged with the client clock time it arrived. */
export interface TimedSnapshot {
  snapshot: Snapshot;
  /** Client receive time, ms. */
  receivedAt: number;
}

/** An interpolated render position. */
export interface RenderState {
  x: number;
  y: number;
  facing: number;
}

/** Clamp to [0, 1]. */
function clamp01(t: number): number {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Shortest-path angular interpolation, in radians.
 *
 * Facing wraps at ±π, so plain `lerp` would spin the player the long way
 * round when aim crosses the boundary — e.g. from +3.0 to −3.0 is a 0.28 rad
 * step, not a 6.0 rad one.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  const TAU = Math.PI * 2;
  let delta = (b - a) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return a + delta * t;
}

/**
 * Interpolation factor between two snapshots at a given render time.
 *
 * `renderTime` is the client clock minus {@link INTERPOLATION_DELAY_MS}.
 * Returns 0 at or before `prev`, 1 at or after `next`.
 */
export function interpolationFactor(
  prev: TimedSnapshot,
  next: TimedSnapshot,
  renderTime: number,
): number {
  const span = next.receivedAt - prev.receivedAt;
  if (span <= 0) {
    // Same instant (or out of order): nothing to interpolate across.
    return 1;
  }
  return clamp01((renderTime - prev.receivedAt) / span);
}

/**
 * Keeps the last two snapshots and produces interpolated render states.
 *
 * docs/08 §3 requires: same snapshot -> same point; t=0 -> prev; t=1 -> next;
 * monotonic in between.
 */
export class SnapshotInterpolator {
  private prev?: TimedSnapshot;
  private next?: TimedSnapshot;

  /** Record an arriving snapshot. Out-of-order arrivals are dropped. */
  push(snapshot: Snapshot, receivedAt: number): void {
    if (this.next && snapshot.tick <= this.next.snapshot.tick) {
      // A late or duplicate snapshot would rewind the render position.
      return;
    }
    this.prev = this.next;
    this.next = { snapshot, receivedAt };
  }

  /** How many snapshots are buffered (0, 1 or 2). */
  get bufferedCount(): number {
    return (this.prev ? 1 : 0) + (this.next ? 1 : 0);
  }

  /**
   * Render state for one player at `now` (client clock, ms).
   *
   * Before two snapshots exist, the single known position is returned
   * unmoved rather than guessing.
   */
  renderState(playerId: number, now: number): RenderState | undefined {
    const next = this.next;
    if (!next) {
      return undefined;
    }
    const nextSnap = findPlayer(next.snapshot, playerId);
    if (!nextSnap) {
      return undefined;
    }

    const prev = this.prev;
    if (!prev) {
      return { x: nextSnap.x, y: nextSnap.y, facing: nextSnap.facing };
    }
    const prevSnap = findPlayer(prev.snapshot, playerId);
    if (!prevSnap) {
      return { x: nextSnap.x, y: nextSnap.y, facing: nextSnap.facing };
    }

    const t = interpolationFactor(prev, next, now - INTERPOLATION_DELAY_MS);
    return {
      x: lerp(prevSnap.x, nextSnap.x, t),
      y: lerp(prevSnap.y, nextSnap.y, t),
      facing: lerpAngle(prevSnap.facing, nextSnap.facing, t),
    };
  }
}

/** Find a player entry in a snapshot. */
export function findPlayer(
  snapshot: Snapshot,
  playerId: number,
): PlayerSnap | undefined {
  return snapshot.players.find((p) => p.id === playerId);
}
