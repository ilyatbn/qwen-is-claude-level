import { describe, expect, it } from 'vitest';
import { tileVariantIndex } from './tileVariant';
import { TILE_VARIANTS } from '../assets/manifest';

const variantsOver = (seed: number, w = 24, h = 24): number[] => {
  const out: number[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      out.push(tileVariantIndex(seed, x, y));
    }
  }
  return out;
};

describe('tileVariantIndex', () => {
  it('matches docs/07 §2 exactly for seeds small enough to be exact', () => {
    for (const seed of [0, 1, 2, 7, 1000, 12648430]) {
      for (const [x, y] of [[0, 0], [1, 0], [0, 1], [5, 9], [159, 95]] as const) {
        expect(tileVariantIndex(seed, x, y)).toBe((seed + x + y) % TILE_VARIANTS);
      }
    }
  });

  it('stays in range', () => {
    for (const v of variantsOver(4242)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(TILE_VARIANTS);
    }
  });

  /** T5.2 Acceptance: "same seed → identical texture layout across two page loads". */
  it('is deterministic for a given seed', () => {
    expect(variantsOver(1)).toEqual(variantsOver(1));
  });

  /** T5.2 step 3: "?seed=1 vs ?seed=2 show visibly different tile patterns". */
  it('gives different layouts for different seeds', () => {
    expect(variantsOver(1)).not.toEqual(variantsOver(2));
  });

  /**
   * The reason for the rewrite. docs/07 §2's literal formula collapses to one
   * variant for every tile once the seed exceeds 2^53, because adding x + y to
   * a double that large rounds back to the same double. D51.
   */
  it('still varies for a u64 seed too large for exact integer arithmetic', () => {
    const huge = 12_302_652_060_662_048_000;
    expect(huge + 1).toBe(huge); // the hazard, stated rather than assumed
    expect(new Set(variantsOver(huge)).size).toBe(TILE_VARIANTS);
    // The literal formula would have produced exactly one variant.
    expect(new Set(variantsOver(huge).map(() => (huge + 0) % TILE_VARIANTS)).size).toBe(1);
  });
});
