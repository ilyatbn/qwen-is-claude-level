/**
 * T23.06B (F6): the queued full pass — field strips interleaved with albedo tiles — paints no tile
 * before every field row it reads is up (its own rows, the row above, `ALBEDO_REACH` below: the grass
 * fringe), uploads every strip once, and paints every tile once.
 */
import { describe, expect, it } from 'vitest'
import { ALBEDO_REACH, STRIP_ROWS, fullPassWork, tilesOf } from './terrainGpu'

describe('fullPassWork (F6)', () => {
  for (const [w, h] of [
    [2048, 1024],
    [4096, 2048],
    [1280, 768],
    [300, 200],
  ] as const) {
    it(`${w}×${h}: every tile after the strips it reads; each strip and tile once`, () => {
      const work = fullPassWork(w, h)
      const up = new Set<number>()
      let tiles = 0
      for (const u of work) {
        if ('strip' in u) {
          expect(up.has(u.strip.y)).toBe(false)
          up.add(u.strip.y)
          continue
        }
        tiles++
        const t = u.tile
        for (let row = Math.max(0, t.y - 1); row <= Math.min(h - 1, t.y + t.h - 1 + ALBEDO_REACH); row++) {
          expect(up.has(Math.floor(row / STRIP_ROWS) * STRIP_ROWS), `tile ${JSON.stringify(t)} row ${row}`).toBe(true)
        }
      }
      expect(tiles).toBe(tilesOf(w, h).length)
      expect(up.size).toBe(Math.ceil(h / STRIP_ROWS))
    })
  }
})
