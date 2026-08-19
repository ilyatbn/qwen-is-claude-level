import { describe, expect, it } from 'vitest';
import { aimAngle, crosshairPosition, CROSSHAIR_RADIUS } from './aim';

const PX = 100;
const PY = 100;
const TAU = Math.PI * 2;

/** Normalise to (-π, π] so ±π compare equal. */
function norm(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
}

describe('aimAngle (docs/06 intro: 0 = right, CCW positive)', () => {
  it('reports 0 for a point to the right', () => {
    // T2.8 step 3: "mouse right of player -> 0".
    expect(aimAngle(PX, PY, PX + 50, PY)).toBeCloseTo(0, 6);
  });

  it('reports +π/2 for a point ABOVE the player', () => {
    // T2.8 step 3: "above -> +π/2 (CCW positive)". Screen y grows downward,
    // so "above" is a SMALLER y. This is the assertion that catches a missing
    // y-negation — without it this would be -π/2.
    expect(aimAngle(PX, PY, PX, PY - 50)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('reports -π/2 for a point below the player', () => {
    expect(aimAngle(PX, PY, PX, PY + 50)).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('reports ±π for a point to the left', () => {
    expect(Math.abs(aimAngle(PX, PY, PX - 50, PY))).toBeCloseTo(Math.PI, 6);
  });

  it('reports +π/4 for up-and-right', () => {
    expect(aimAngle(PX, PY, PX + 50, PY - 50)).toBeCloseTo(Math.PI / 4, 6);
  });

  it('is independent of distance', () => {
    const near = aimAngle(PX, PY, PX + 10, PY - 10);
    const far = aimAngle(PX, PY, PX + 1000, PY - 1000);
    expect(near).toBeCloseTo(far, 6);
  });

  it('increases counter-clockwise through the first quadrant', () => {
    // The defining property of "CCW positive": sweeping the mouse from right
    // to up must produce increasing angles.
    const right = aimAngle(PX, PY, PX + 50, PY);
    const upRight = aimAngle(PX, PY, PX + 50, PY - 20);
    const up = aimAngle(PX, PY, PX, PY - 50);
    expect(upRight).toBeGreaterThan(right);
    expect(up).toBeGreaterThan(upRight);
  });
});

describe('crosshairPosition (docs/03 §8)', () => {
  it('sits on the ring at radius 60', () => {
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      const p = crosshairPosition(PX, PY, angle);
      const dist = Math.hypot(p.x - PX, p.y - PY);
      expect(dist).toBeCloseTo(CROSSHAIR_RADIUS, 6);
    }
  });

  it('uses the documented 60 px radius by default', () => {
    expect(CROSSHAIR_RADIUS).toBe(60);
  });

  it('places the crosshair above the player for +π/2', () => {
    const p = crosshairPosition(PX, PY, Math.PI / 2);
    expect(p.x).toBeCloseTo(PX, 6);
    expect(p.y).toBeCloseTo(PY - CROSSHAIR_RADIUS, 6);
  });

  it('round-trips with aimAngle', () => {
    // The two functions must use the same convention, or the crosshair drifts
    // from where the player is actually aiming.
    for (const angle of [0, 0.3, 1.2, Math.PI / 2, 2.5, -1.0, -2.9]) {
      const p = crosshairPosition(PX, PY, angle);
      expect(norm(aimAngle(PX, PY, p.x, p.y))).toBeCloseTo(norm(angle), 5);
    }
  });
});
