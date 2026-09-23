import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core } from '../core'
import { BurnTracker, confirmWindow, GHOST, flareBounds, flareStrength, ribbonLength, ribbonOutline, strand, toLocal } from './flareFx-math'

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
})

/** An arch like the core's: `n` points, `span` wide, `height` tall, rising to -y. */
function arch(n: number, span: number, height: number, cx = 500, cy = 400): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1)
    out.push(cx + (u - 0.5) * span, cy - height * Math.sin(Math.PI * u))
  }
  return out
}

/** Even-odd point-in-polygon over a flat `[x0, y0, …]` ring. */
function inside(poly: number[], x: number, y: number): boolean {
  let hit = false
  const n = poly.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i]!
    const yi = poly[2 * i + 1]!
    const xj = poly[2 * j]!
    const yj = poly[2 * j + 1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

// Fixture geometry, not tunables: the shape the core's loop has, at a round size.
const PTS = arch(48, 300, 170)
const HW = 14

describe('ribbonOutline — one polygon round the ribbon, for the flat path (T22.08B)', () => {
  it('contains every sample point and the band around it', () => {
    const poly: number[] = []
    ribbonOutline(PTS, HW, poly)
    for (let i = 0; i < PTS.length; i += 2) {
      expect(inside(poly, PTS[i]!, PTS[i + 1]!), `sample ${i / 2}`).toBe(true)
    }
    // Across the band at the apex: in at 0.9 of the half-width, out at 1.1.
    const apex = PTS.length / 2
    const [x, y] = [PTS[apex]!, PTS[apex + 1]!]
    expect(inside(poly, x, y - HW * 0.9)).toBe(true)
    expect(inside(poly, x, y + HW * 0.9)).toBe(true)
    // The control: the same polygon excludes points just past the band.
    expect(inside(poly, x, y - HW * 1.1)).toBe(false)
    expect(inside(poly, x, y + HW * 1.1)).toBe(false)
  })

  it('rounds both ends outward, not back over the line', () => {
    const poly: number[] = []
    ribbonOutline(PTS, HW, poly)
    // Beyond each footpoint along the line's own direction there is ribbon…
    const tail = (i: number, j: number) => {
      const dx = PTS[2 * i]! - PTS[2 * j]!
      const dy = PTS[2 * i + 1]! - PTS[2 * j + 1]!
      const l = Math.hypot(dx, dy)
      return [PTS[2 * i]! + (dx / l) * HW * 0.8, PTS[2 * i + 1]! + (dy / l) * HW * 0.8] as const
    }
    const end = tail(47, 46)
    const start = tail(0, 1)
    expect(inside(poly, end[0], end[1])).toBe(true)
    expect(inside(poly, start[0], start[1])).toBe(true)
  })

  it('draws nothing for fewer than two points', () => {
    const poly = [1, 2, 3]
    ribbonOutline([10, 10], HW, poly)
    expect(poly).toEqual([])
  })
})

describe('flareBounds / toLocal — the shader quad (T22.08B)', () => {
  it('pads every point by the reach, and the local points land inside the quad', () => {
    const pad = 48
    const box = flareBounds(PTS, pad)!
    const local = new Float32Array(PTS.length)
    toLocal(PTS, box, local)
    for (let i = 0; i < local.length; i += 2) {
      expect(local[i]!).toBeGreaterThanOrEqual(pad - 1e-3)
      expect(local[i]!).toBeLessThanOrEqual(box.w - pad + 1e-3)
      expect(local[i + 1]!).toBeGreaterThanOrEqual(pad - 1e-3)
      expect(local[i + 1]!).toBeLessThanOrEqual(box.h - pad + 1e-3)
    }
    expect(flareBounds([], pad)).toBeNull()
  })

  it('measures the centre line', () => {
    expect(ribbonLength([0, 0, 3, 4, 3, 10])).toBeCloseTo(11, 6)
    // An arch is longer than its span and shorter than span + 2·height.
    const len = ribbonLength(PTS)
    expect(len).toBeGreaterThan(300)
    expect(len).toBeLessThan(300 + 2 * 170)
  })
})

describe('flareStrength — a ghost while it forms, full while it burns (T22.08B)', () => {
  const TELEGRAPH = 3
  it('is a ghost below GHOST in the telegraph, 1 while lit, 0 in the burn tail', () => {
    expect(flareStrength(0.5 * TELEGRAPH, TELEGRAPH, false)).toBeGreaterThan(0)
    expect(flareStrength(0.5 * TELEGRAPH, TELEGRAPH, false)).toBeLessThanOrEqual(GHOST)
    expect(flareStrength(TELEGRAPH + 1, TELEGRAPH, true)).toBe(1)
    // Past the telegraph and not lit: the ribbon has gone (T22.08C F1).
    expect(flareStrength(TELEGRAPH + 13, TELEGRAPH, false)).toBe(0)
  })
})

describe('strand — the flat path twisting threads (T22.08B)', () => {
  it('is pinned at the footpoints and leaves the line in between', () => {
    const out: number[] = []
    strand(PTS, 10, 0.3, 1.7, out)
    expect(out.length).toBe(PTS.length)
    expect(out[0]).toBeCloseTo(PTS[0]!, 6)
    expect(out[out.length - 1]).toBeCloseTo(PTS[PTS.length - 1]!, 6)
    let most = 0
    for (let i = 0; i < out.length; i++) most = Math.max(most, Math.abs(out[i]! - PTS[i]!))
    expect(most).toBeGreaterThan(3)
    expect(most).toBeLessThanOrEqual(10 + 1e-6)
  })
})

describe('BurnTracker — who is on fire, as the client can know it (T22.08B, T22.08D F3)', () => {
  // Fixture numbers in the shape of the shipped ones: a 4 s burn, a ~1 s window.
  const BURN = 4
  const WIN = 1.1

  it('writes the deadline on a touch and never stacks it (R79)', () => {
    const b = new BurnTracker()
    // The control: nobody burns before a touch.
    expect(b.burning(1, 0)).toBe(false)
    b.touch(1, 10, BURN, WIN)
    b.confirm(1, 10.5, WIN, false)
    expect(b.burning(1, 13.9)).toBe(true)
    b.touch(1, 11, BURN, WIN)
    b.touch(1, 11, BURN, WIN)
    // Rewritten: 11 + 4, not 10 + 4 + 4 + 4.
    expect(b.left(1, 11)).toBeCloseTo(BURN, 6)
    expect(b.burning(1, 15.01)).toBe(false)
    expect(b.burning(2, 12)).toBe(false)
  })

  /** The local rule, the half that puts flames out: a touch the server never confirms. */
  it('a touch with no word from the server goes out at the window, and stays out', () => {
    const b = new BurnTracker()
    b.touch(1, 0, BURN, WIN)
    // Provisional: shown at once, so a real burn is not a second late on screen.
    expect(b.burning(1, WIN - 0.01)).toBe(true)
    expect(b.burning(1, WIN + 0.01)).toBe(false)
    // Still "touching" on the client: no relight on contact alone for the burn it proposed.
    b.touch(1, WIN + 0.02, BURN, WIN)
    expect(b.burning(1, WIN + 0.03)).toBe(false)
    // The control beside it: the same touch, confirmed inside the window, burns on.
    const c = new BurnTracker()
    c.touch(1, 0, BURN, WIN)
    c.confirm(1, WIN - 0.05, WIN, false)
    expect(c.burning(1, WIN + 0.01)).toBe(true)
    expect(c.burning(1, BURN - 0.01)).toBe(true)
  })

  /** The local rule, the half that lights them: the server burns you with no local contact. */
  it("the server's word lights a burn with no touch only when it can mean nothing else", () => {
    const b = new BurnTracker()
    b.confirm(1, 5, WIN, true)
    expect(b.burning(1, 5.01)).toBe(true)
    // Each word keeps it lit a window further; silence puts it out.
    b.confirm(1, 6, WIN, true)
    expect(b.burning(1, 6 + WIN - 0.01)).toBe(true)
    expect(b.burning(1, 6 + WIN + 0.01)).toBe(false)
    // A remote's health drop (`start` false) is not enough on its own — a bullet does that.
    const r = new BurnTracker()
    r.confirm(2, 5, WIN, false)
    expect(r.burning(2, 5.01)).toBe(false)
  })

  it('a death or a new round clears it', () => {
    const b = new BurnTracker()
    b.touch(1, 0, BURN, WIN)
    b.touch(2, 0, BURN, WIN)
    b.clear(1)
    expect(b.burning(1, 1)).toBe(false)
    expect(b.burning(2, 1)).toBe(true)
    b.clearAll()
    expect(b.burning(2, 1)).toBe(false)
  })
})

/**
 * T22.08E F2: **the window against a real round trip.** A model of one burn, in the
 * flare's server clock, frame by frame at 60 Hz:
 *
 * - the server's body is in the ribbon for `contact` s from 0 and burns
 *   `SOLAR_FLARE_BURN_SECONDS` past its last touch, logging a `Damage` every
 *   `RADIATION_LOG_INTERVAL` from the first touch (the measured first wait, 0.983 s,
 *   is under that — `world::solar_flare_tests`);
 * - **you** are predicted, so your client touches `rtt/2` early and your `damage`
 *   arrives `rtt/2` late;
 * - **a remote** is drawn `INTERP_DELAY_MS` behind, and its health drop lands in the
 *   next snapshot and arrives `rtt/2` after that.
 *
 * `real = false` is the same client contact with the server never agreeing.
 */
function simulate(who: 'you' | 'remote', rttMs: number, real: boolean, contact = 0.3) {
  const k = C()
  const rtt = rttMs / 1000
  const win = confirmWindow(rttMs)
  const burnEnd = contact + k.SOLAR_FLARE_BURN_SECONDS
  const snap = 1 / k.SNAPSHOT_HZ
  const words: number[] = []
  if (real) {
    for (let d = k.RADIATION_LOG_INTERVAL; d <= burnEnd; d += k.RADIATION_LOG_INTERVAL) {
      words.push(who === 'you' ? d + rtt / 2 : Math.ceil(d / snap) * snap + rtt / 2)
    }
  }
  const lead = who === 'you' ? -rtt / 2 : k.INTERP_DELAY_MS / 1000
  const b = new BurnTracker()
  let first: number | null = null
  let last: number | null = null
  let lit = 0
  for (let f = -60; f < 60 * 12; f++) {
    const now = f / 60
    while (words.length && words[0]! <= now) b.confirm(1, words.shift()!, win, who === 'you')
    if (now >= lead && now < lead + contact) b.touch(1, now, k.SOLAR_FLARE_BURN_SECONDS, win)
    else b.apart(1)
    const on = b.burning(1, now)
    if (on) {
      first ??= now
      last = now
      lit++
    }
  }
  return { shown: first === null || last === null ? 0 : last - first, lit: lit / 60, win, burn: burnEnd }
}

describe('BurnTracker against a real round trip (T22.08E F2)', () => {
  for (const rtt of [50, 200, 300, 500]) {
    for (const who of ['you', 'remote'] as const) {
      it(`${who} at ${rtt} ms: a real burn shows its whole length, a false one at most one window`, () => {
        const snap = 1 / C().SNAPSHOT_HZ
        const real = simulate(who, rtt, true)
        expect(real.shown).toBeGreaterThanOrEqual(real.burn - snap)
        // Lit throughout, not flickering on and off inside that span.
        expect(real.lit).toBeGreaterThanOrEqual(real.burn - snap)
        const fake = simulate(who, rtt, false)
        expect(fake.lit).toBeGreaterThan(0)
        expect(fake.lit).toBeLessThanOrEqual(fake.win + 1 / 60)
        // And a false contact held for the whole burn still shows only the one window.
        const held = simulate(who, rtt, false, C().SOLAR_FLARE_BURN_SECONDS)
        expect(held.lit).toBeLessThanOrEqual(held.win + 1 / 60)
      })
    }
  }

  it('the window grows with the round trip it has to wait out', () => {
    const k = C()
    expect(confirmWindow(0)).toBeCloseTo(k.SOLAR_FLARE_CONFIRM_SECONDS, 6)
    expect(confirmWindow(300) - confirmWindow(0)).toBeCloseTo(0.3, 6)
  })

  it('a word that arrives after the window restores the burn it refuted', () => {
    const k = C()
    const b = new BurnTracker()
    b.touch(1, 0, k.SOLAR_FLARE_BURN_SECONDS, 1)
    expect(b.burning(1, 1.01)).toBe(false)
    b.confirm(1, 1.2, 1, false)
    expect(b.burning(1, 1.21)).toBe(true)
    expect(b.burning(1, k.SOLAR_FLARE_BURN_SECONDS - 0.01)).toBe(true)
  })

  it('refuted, it stays out while contact lasts and may propose again once contact ends', () => {
    const k = C()
    const b = new BurnTracker()
    b.touch(1, 0, k.SOLAR_FLARE_BURN_SECONDS, 1)
    expect(b.burning(1, 1.01)).toBe(false)
    b.touch(1, 1.5, k.SOLAR_FLARE_BURN_SECONDS, 1)
    expect(b.burning(1, 1.51)).toBe(false)
    b.apart(1)
    // A fresh contact is a fresh proposal — well inside the old proposal's 4 s.
    b.touch(1, 2, k.SOLAR_FLARE_BURN_SECONDS, 1)
    expect(b.burning(1, 2.01)).toBe(true)
  })
})
