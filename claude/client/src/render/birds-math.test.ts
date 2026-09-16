import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Core, C } from '../core'
import { BIRD_METAL, BIRD_NORMAL, bodyColor, bodyScale, bodySize, wingPhase } from './birds-math'

const here = dirname(fileURLToPath(import.meta.url))
const wasmBytes = readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm'))

describe('birds-math', () => {
  beforeAll(async () => {
    await Core.init(wasmBytes)
  })

  it('flaps: the phase spans its full range over a second', () => {
    let lo = Infinity
    let hi = -Infinity
    for (let ms = 0; ms < 1000; ms += 5) {
      const v = wingPhase(ms, 0)
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    expect(hi).toBeGreaterThan(0.95)
    expect(lo).toBeLessThan(-0.95)
  })

  it('two birds do not flap in lockstep', () => {
    // Without the per-id offset every bird is the same animation, which reads
    // as one object drawn several times.
    const a = wingPhase(0, 0)
    const b = wingPhase(0, 1)
    expect(Math.abs(a - b)).toBeGreaterThan(0.1)
  })

  it('the two kinds are visually distinct', () => {
    const normal = bodyColor(BIRD_NORMAL)
    const metal = bodyColor(BIRD_METAL)
    expect(normal).not.toBe(metal)
    // Far enough apart in luminance to tell apart against either sky. §C16 asks
    // for distinct, and the reward depends on reading it before you shoot.
    const lum = (c: number) =>
      0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)
    expect(Math.abs(lum(normal) - lum(metal))).toBeGreaterThan(80)
  })

  it('a metal bird is drawn larger', () => {
    expect(bodyScale(BIRD_METAL)).toBeGreaterThan(bodyScale(BIRD_NORMAL))
  })

  it('the drawn size comes from the shared hit box, not a local copy', () => {
    // A sprite that no longer matches what a bullet hits should be a failing
    // test rather than a mystery about why birds are hard to shoot.
    const c = C()
    const n = bodySize(BIRD_NORMAL)
    expect(n.w).toBeCloseTo(c.BIRD_W, 5)
    expect(n.h).toBeCloseTo(c.BIRD_H, 5)
    const m = bodySize(BIRD_METAL)
    expect(m.w).toBeCloseTo(c.BIRD_W * bodyScale(BIRD_METAL), 5)
  })
})
