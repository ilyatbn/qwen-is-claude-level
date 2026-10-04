/** T23.43 / T24.00: the foreground leaves as tiny drifting flecks (`leafFlecks.ts`) — a pure field of (seed, view, time), at depths. */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Core } from '../core'
import { FG_ALPHA_OVER_PLAYER } from './atmosphere'
import { FLECK_ALPHA, FLECK_BLUR, FLECK_CELL, FLECK_DRIFT, FLECK_LEN, FLECK_NEAR_SPEED, FLECK_PER_CELL, fleckAlpha, fleckAt, leafFlecks } from './leafFlecks'
import type { Box } from './scene'

const VIEW = { x: 0, y: 0, w: 1280, h: 720 }

// `gameDescription`'s space branch reads the core's constants.
beforeAll(async () => {
  await Core.init(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../core/pkg/game_wasm_bg.wasm')))
})

describe('leafFlecks (T23.43)', () => {
  it('is world-anchored: two overlapping views see the same flecks where they overlap', () => {
    const t = 12.5
    const a = leafFlecks(7, VIEW, t)
    const b = leafFlecks(7, { x: 400, y: 100, w: 1280, h: 720 }, t)
    const inBoth = (s: { x: number; y: number }): boolean => s.x > 420 && s.x < 1260 && s.y > 120 && s.y < 700
    const key = (s: { x: number; y: number }): string => `${s.x.toFixed(4)},${s.y.toFixed(4)}`
    const ka = a.filter(inBoth).map(key).sort()
    expect(ka.length).toBeGreaterThan(10)
    expect(b.filter(inBoth).map(key).sort()).toEqual(ka)
  })

  it('is seeded and moves with time: same (seed, t) the same, another seed or time moves them', () => {
    expect(leafFlecks(7, VIEW, 3)).toEqual(leafFlecks(7, VIEW, 3))
    expect(leafFlecks(7, VIEW, 3)).not.toEqual(leafFlecks(7, VIEW, 3.5))
    expect(leafFlecks(8, VIEW, 3).map((f) => f.x)).not.toEqual(leafFlecks(7, VIEW, 3).map((f) => f.x))
  })

  it('about a hundred on a screen (T24.00: three times T23.43), over many seeds and times — not a few, not a swarm', () => {
    const counts: number[] = []
    for (let seed = 1; seed <= 12; seed++) for (const t of [0, 7.3, 41]) counts.push(leafFlecks(seed, { ...VIEW, x: seed * 997, y: seed * 331 }, t).length)
    const mean = counts.reduce((s, n) => s + n, 0) / counts.length
    // The basis: (1280·720 / CELL²) · PER_CELL flecks — the mean within 15 % of it, every draw within a factor of two.
    const basis = ((VIEW.w * VIEW.h) / FLECK_CELL ** 2) * FLECK_PER_CELL
    expect(mean).toBeGreaterThan(basis * 0.85)
    expect(mean).toBeLessThan(basis * 1.15)
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(basis / 2)
    expect(Math.max(...counts)).toBeLessThanOrEqual(basis * 2)
    // T23.43's density, the control: four per cell was 36 a screen — a third of this.
    expect(basis).toBeGreaterThanOrEqual(((VIEW.w * VIEW.h) / FLECK_CELL ** 2) * 4 * 2.5)
  })

  it('every fleck is tiny — within FLECK_LEN, its blur within FLECK_BLUR — and fades in and out', () => {
    let n = 0
    for (let seed = 1; seed <= 6; seed++) {
      for (const f of leafFlecks(seed, VIEW, seed * 3.1)) {
        expect(f.len).toBeGreaterThanOrEqual(FLECK_LEN[0])
        expect(f.len).toBeLessThanOrEqual(FLECK_LEN[1])
        expect(f.blur).toBeGreaterThanOrEqual(FLECK_BLUR[0])
        expect(f.blur).toBeLessThanOrEqual(FLECK_BLUR[1])
        expect(f.a).toBeGreaterThanOrEqual(0)
        expect(f.a).toBeLessThanOrEqual(FLECK_ALPHA[1])
        n++
      }
    }
    expect(n).toBeGreaterThan(300)
  })

  it('has depth: most flecks small and far, a few large, close, fast and blurred — and size goes with depth', () => {
    const all = []
    for (let seed = 1; seed <= 8; seed++) all.push(...leafFlecks(seed, { ...VIEW, x: seed * 1500 }, seed * 2.3))
    const mid = (FLECK_LEN[0] + FLECK_LEN[1]) / 2
    const small = all.filter((f) => f.len < mid).length / all.length
    const close = all.filter((f) => f.depth > 0.5)
    // Most small (over two thirds) — and a few close ones, not none (one in ten or more).
    expect(small).toBeGreaterThan(2 / 3)
    expect(close.length / all.length).toBeGreaterThan(0.1)
    expect(close.length / all.length).toBeLessThan(1 / 3)
    // The close ones are the big, blurred ones; the far ones the small, crisp ones (means of each half).
    const far = all.filter((f) => f.depth < 0.1)
    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
    expect(mean(close.map((f) => f.len))).toBeGreaterThan(mean(far.map((f) => f.len)) * 1.8)
    expect(mean(close.map((f) => f.blur))).toBeGreaterThan(mean(far.map((f) => f.blur)) * 2)
  })

  it('drifts slowly across: a far fleck between DRIFT and twice DRIFT px/s, a close one up to NEAR_SPEED times that', () => {
    let n = 0
    let fastestFar = 0
    let fastestClose = 0
    for (let cx = 0; cx < 40; cx++) {
      for (let k = 0; k < FLECK_PER_CELL; k++) {
        const a = fleckAt(5, cx, 3, k, 20)
        const b = fleckAt(5, cx, 3, k, 20.05)
        const vx = (b.x - a.x) / 0.05
        if (Math.abs(vx) > FLECK_DRIFT * 20) continue // it wrapped to a new trip between the two reads
        const top = 2 * FLECK_DRIFT * (1 + (FLECK_NEAR_SPEED - 1) * a.depth)
        expect(vx).toBeGreaterThanOrEqual(FLECK_DRIFT * 0.99)
        expect(vx).toBeLessThanOrEqual(top * 1.01)
        if (a.depth < 0.1) fastestFar = Math.max(fastestFar, vx)
        if (a.depth > 0.6) fastestClose = Math.max(fastestClose, vx)
        n++
      }
    }
    expect(n).toBeGreaterThan(300)
    expect(fastestFar).toBeLessThanOrEqual(2 * FLECK_DRIFT * (1 + (FLECK_NEAR_SPEED - 1) * 0.1) * 1.01)
    // Control: close ones do outrun every far one.
    expect(fastestClose).toBeGreaterThan(fastestFar)
  })

  it('fades over a player box and not beside it (control)', () => {
    const f = { x: 100, y: 100, len: 4, angle: 0, a: FLECK_ALPHA[1], depth: 1, blur: FLECK_BLUR[1] }
    const box: Box = [90, 90, 110, 110]
    expect(fleckAlpha(f, [box])).toBeCloseTo(FLECK_ALPHA[1] * FG_ALPHA_OVER_PLAYER, 6)
    expect(fleckAlpha(f, [[400, 90, 420, 110]])).toBeCloseTo(FLECK_ALPHA[1], 6)
    expect(fleckAlpha(f, [])).toBeCloseTo(FLECK_ALPHA[1], 6)
  })

  it('a classic map gets flecks and no big clusters; volcanic keeps its embers instead; space has neither', async () => {
    const { gameDescription } = await import('./worldRenderer')
    const map = (look: 'classic' | 'volcanic', space = false) => ({ w: 4000, h: 2000, seed: 7, space, look, leaves: [{ x: 500, y: 600, r: 100, n: 9 }] })
    const classic = gameDescription(map('classic'))
    expect(classic.leafFlecks).toEqual({ seed: 7 })
    expect(classic.look.fg).toBeNull()
    expect(classic.leaves ?? null).toBeNull()
    const volcanic = gameDescription(map('volcanic'))
    expect(volcanic.leafFlecks ?? null).toBeNull()
    expect(volcanic.palette?.extra2d).toBe('embers')
    expect(gameDescription(map('classic', true)).leafFlecks ?? null).toBeNull()
  })
})
