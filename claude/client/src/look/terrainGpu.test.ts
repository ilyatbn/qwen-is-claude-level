/**
 * T23.06B (F6): the queued full pass — field strips interleaved with albedo tiles — paints no tile
 * before every field row it reads is up (its own rows, the row above, `ALBEDO_REACH` below: the grass
 * fringe), uploads every strip once, and paints every tile once.
 *
 * T23.07: with the low tier's bake, every bake tile comes after the albedo rows it reads (one px past
 * it: the normal's luminance taps) and the field rows `BAKE_REACH` past it (the shadow marches), and
 * each tile is baked once.
 */
import { describe, expect, it } from 'vitest'
import { ALBEDO_REACH, STRIP_ROWS, fullPassWork, tilesOf, type Rect } from './terrainGpu'
import { BAKE_REACH } from './terrainMaterial'

describe('fullPassWork (F6, T23.07)', () => {
  for (const bake of [false, true]) {
    for (const [w, h] of [
      [2048, 1024],
      [4096, 2048],
      [1280, 768],
      [300, 200],
    ] as const) {
      it(`${w}×${h}${bake ? ' with the bake' : ''}: every unit after what it reads; each strip, tile and bake once`, () => {
        const work = fullPassWork(w, h, bake)
        const up = new Set<number>()
        const painted: Rect[] = []
        let tiles = 0
        let bakes = 0
        const stripsUp = (t: Rect, below: number): void => {
          for (let row = Math.max(0, t.y - 1); row <= Math.min(h - 1, t.y + t.h - 1 + below); row++) {
            expect(up.has(Math.floor(row / STRIP_ROWS) * STRIP_ROWS), `${JSON.stringify(t)} row ${row}`).toBe(true)
          }
        }
        for (const u of work) {
          if ('strip' in u) {
            expect(up.has(u.strip.y)).toBe(false)
            up.add(u.strip.y)
          } else if ('tile' in u) {
            tiles++
            stripsUp(u.tile, ALBEDO_REACH)
            painted.push(u.tile)
          } else {
            bakes++
            const t = u.bake
            stripsUp(t, BAKE_REACH)
            // Every albedo px within one of the tile is painted.
            for (const probe of [
              [t.x - 1, t.y - 1],
              [t.x + t.w, t.y + t.h],
              [t.x, t.y + t.h],
              [t.x + t.w, t.y - 1],
            ] as const) {
              const [x, y] = [Math.min(w - 1, Math.max(0, probe[0])), Math.min(h - 1, Math.max(0, probe[1]))]
              expect(painted.some((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h), `bake ${JSON.stringify(t)} before albedo at ${x},${y}`).toBe(true)
            }
          }
        }
        expect(tiles).toBe(tilesOf(w, h).length)
        expect(bakes).toBe(bake ? tilesOf(w, h).length : 0)
        expect(up.size).toBe(Math.ceil(h / STRIP_ROWS))
      })
    }
  }
})
