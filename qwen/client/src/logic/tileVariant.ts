/**
 * Tile texture variant selection (docs/07 §2, docs/01 §7).
 *
 * "tile texture index = `(seed + tile_x + tile_y) % 3` → looks different per
 * round, deterministic, no extra protocol data."
 *
 * Client-only: the server never computes this, so nothing has to agree with it
 * across the wire — only with itself, across page loads of the same seed.
 */
import { TILE_VARIANTS } from '../assets/manifest';

/**
 * The variant index for a tile, in `[0, TILE_VARIANTS)`.
 *
 * Written as `((seed % 3) + x + y) % 3` rather than docs/07 §2's
 * `(seed + x + y) % 3`. The two are identical for exact integers, but `seed`
 * is a u64 arriving as a JSON number: above 2^53 it is a double whose spacing
 * exceeds 1, so `seed + x + y` **rounds straight back to `seed`** and every
 * tile on the map lands on the same variant — the whole feature silently off
 * for most random seeds. Reducing first keeps the arithmetic in the range
 * where it is exact. See DEVIATIONS.md D51.
 */
export function tileVariantIndex(seed: number, x: number, y: number): number {
  const reduced = Math.abs(seed) % TILE_VARIANTS;
  return (reduced + x + y) % TILE_VARIANTS;
}
