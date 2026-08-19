/**
 * docs/08 §3 (`fov.ts` row): "same formula as server (copy of the math) —
 * assert night/fog/health/flashlight cases match docs/03 §7 values."
 *
 * The vectors are NOT hand-written here. They are generated from the Rust
 * implementation by `game-core/examples/fov_vectors.rs`, so this test fails if
 * the two implementations of docs/03 §7 ever diverge (D31). A hand-written
 * table on each side could drift in step with a wrong change and never notice.
 */
import { describe, expect, it } from 'vitest';
import { computeFov, FOV_BASE, FOV_LOW_HEALTH } from './fov';
import vectors from './fov-vectors.json';

interface FovVector {
  day_phase: number;
  fog_active: boolean;
  health: number;
  flashlight: boolean;
  fov: number;
}

const CASES = vectors.vectors as FovVector[];

describe('computeFov matches the server implementation', () => {
  it('has vectors to check', () => {
    // Guards against the fixture silently becoming empty, which would make
    // every assertion below vacuous.
    expect(CASES.length).toBeGreaterThanOrEqual(12);
  });

  for (const v of CASES) {
    const label =
      `day_phase=${v.day_phase} fog=${v.fog_active} ` +
      `health=${v.health} flashlight=${v.flashlight}`;
    it(`matches the server for ${label}`, () => {
      expect(computeFov(v.day_phase, v.fog_active, v.health, v.flashlight)).toBeCloseTo(
        v.fov,
        4,
      );
    });
  }
});

describe('documented FOV cases (docs/03 §7)', () => {
  it('is 420 in full day, healthy, no fog', () => {
    expect(computeFov(0, false, 100, false)).toBeCloseTo(FOV_BASE, 6);
  });

  it('is 189 at full night (420 * 0.45)', () => {
    expect(computeFov(1, false, 100, false)).toBeCloseTo(189, 6);
  });

  it('is 189 in fog by day — T4.7 asserts exactly this', () => {
    expect(computeFov(0, true, 100, false)).toBeCloseTo(189, 6);
  });

  it('treats exactly 50 hp as healthy (docs says "health >= 50")', () => {
    expect(computeFov(0, false, FOV_LOW_HEALTH, false)).toBeCloseTo(FOV_BASE, 6);
    expect(computeFov(0, false, FOV_LOW_HEALTH - 0.001, false)).toBeLessThan(FOV_BASE);
  });

  it('lets a flashlight cancel night but not fog or low health', () => {
    expect(computeFov(1, false, 100, true)).toBeCloseTo(FOV_BASE, 6);
    expect(computeFov(1, true, 100, true)).toBeCloseTo(189, 6);
    expect(computeFov(1, false, 10, true)).toBeCloseTo(294, 6);
  });

  it('hides a player at 400 px at night, reveals them with a flashlight', () => {
    // T2.10 Acceptance.
    expect(computeFov(1, false, 100, false)).toBeLessThan(400);
    expect(computeFov(1, false, 100, true)).toBeGreaterThan(400);
  });
});
