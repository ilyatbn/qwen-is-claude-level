import { describe, expect, it } from 'vitest'
import { noiseTilePixels } from './noise-math'
import { layerSeeds, tileSeed } from './procTextures'
import { THEMES } from './themes-math'

/**
 * T21.15 — the terrain texture must vary with the map seed.
 *
 * Reported from play: *"the map texture seems like it's always the same"*. It
 * was: `makeNoiseTile` took the literals 7, 23 and 41, so the rock, the rim and
 * the cave-back were byte-identical on every seed ever generated, and the only
 * variation a player saw was which of three palettes the theme roll picked.
 *
 * These tests exist at all because the arithmetic was only reachable through a
 * canvas, and `vitest` runs in node — so the texture had no test, and a constant
 * where a seed belonged survived every gate this project has.
 */
const SIZE = 64
const theme = THEMES[0]!

const tile = (seed: number) => noiseTilePixels(SIZE, theme.fill, theme.spread.fill, seed)
const differing = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let n = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
  return n
}

describe('seeded terrain tiles (T21.15)', () => {
  it('gives different rock for different map seeds', () => {
    const a = tile(layerSeeds(4242).fill)
    const b = tile(layerSeeds(31337).fill)
    // Per pixel, not by a histogram: two tiles can share a colour distribution
    // and be visibly different, and vice versa.
    expect(differing(a, b), 'two seeds produced the same tile').toBeGreaterThan(0)
    // And substantially different, not one stray byte.
    expect(differing(a, b) / a.length).toBeGreaterThan(0.5)
  })

  it('gives the same rock for the same seed — the control', () => {
    // Without this, "different" is satisfied by a generator that is merely
    // nondeterministic, which would be a worse bug than the one being fixed.
    const a = tile(layerSeeds(4242).fill)
    const b = tile(layerSeeds(4242).fill)
    expect(differing(a, b)).toBe(0)
  })

  it('keeps the three layers distinct from each other at one seed', () => {
    // The offsets exist so the rim does not trace the body's mottling exactly,
    // which would read as a printing error.
    // **Through `layerSeeds`, not hand-written offsets.** Writing `tileSeed(4242,
    // 7)` and `tileSeed(4242, 23)` here left this green when `LAYER_EDGE` was
    // pointed at `LAYER_FILL` — the test restated the constants instead of
    // reading them, so it could not see them move.
    const { fill: sf, edge: se, back: sb } = layerSeeds(4242)
    const fill = tile(sf)
    const edge = tile(se)
    const back = tile(sb)
    expect(differing(fill, edge)).toBeGreaterThan(0)
    expect(differing(fill, back)).toBeGreaterThan(0)
    expect(differing(edge, back)).toBeGreaterThan(0)
  })

  it('changes the shape, not the palette', () => {
    // Seeding must not become re-tinting: the mean stays inside the theme's own
    // spread, so a seed change cannot silently shift the colour of the map.
    const mean = (px: Uint8ClampedArray) => {
      let r = 0
      for (let i = 0; i < px.length; i += 4) r += px[i]!
      return r / (px.length / 4)
    }
    const a = mean(tile(layerSeeds(4242).fill))
    const b = mean(tile(layerSeeds(31337).fill))
    expect(Math.abs(a - b)).toBeLessThan(theme.spread.fill / 2)
    // And both sit near the theme's own base colour.
    expect(Math.abs(a - theme.fill.r)).toBeLessThan(theme.spread.fill)
  })

  it('is still seamless at a seeded value', () => {
    // The wrap is the whole point of the torus sampling: a tile whose left edge
    // does not meet its right draws a grid across the map. Invisible here unless
    // asserted, glaring at every 256 px boundary in the game.
    //
    // **Calibrated against the tile's own interior, not against the spread.**
    // The first version allowed a difference of `theme.spread.fill` (46), which
    // is larger than any seam this noise can produce — so deleting the lattice
    // wrap outright left it green. The bound now comes from the mean adjacent
    // difference inside the tile: the wrap edge must look like any other edge.
    for (const seed of [0, 4242, 31337, 99]) {
      const px = tile(layerSeeds(seed).fill)
      const at = (x: number, y: number) => px[(y * SIZE + x) * 4]!

      // The **largest** ordinary step inside the tile, not the mean. A seamless
      // wrap edge is drawn from the same distribution as every interior edge, so
      // it can exceed three times the mean quite legitimately — measured: a real
      // edge of 9 against a mean of 2.54. What it cannot do is exceed the worst
      // step the tile already contains.
      let worst = 0
      for (let y = 0; y < SIZE; y++) {
        for (let x = 1; x < SIZE; x++) {
          worst = Math.max(worst, Math.abs(at(x, y) - at(x - 1, y)))
        }
      }
      const bound = worst

      for (let y = 0; y < SIZE; y++) {
        expect(
          Math.abs(at(0, y) - at(SIZE - 1, y)),
          `seed ${seed} row ${y}: horizontal seam (bound ${bound.toFixed(2)})`,
        ).toBeLessThanOrEqual(bound)
      }
      for (let x = 0; x < SIZE; x++) {
        expect(
          Math.abs(at(x, 0) - at(x, SIZE - 1)),
          `seed ${seed} col ${x}: vertical seam (bound ${bound.toFixed(2)})`,
        ).toBeLessThanOrEqual(bound)
      }
    }
  })

  it('folds a u64-sized seed into something hash01 can use', () => {
    // A map seed is a u64; a JS number cannot hold one exactly above 2^53, and
    // `hash01` truncates to int32 regardless. The fold makes that narrowing
    // explicit and deterministic.
    const huge = Number.MAX_SAFE_INTEGER
    expect(Number.isFinite(tileSeed(huge, 7))).toBe(true)
    expect(Number.isInteger(tileSeed(huge, 7))).toBe(true)
    expect(tileSeed(huge, 7)).toBe(tileSeed(huge, 7))
    // Distinct layers stay distinct after folding.
    expect(tileSeed(huge, 7)).not.toBe(tileSeed(huge, 23))
  })
})
