import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Core, C } from '../core'
import { BEETLE, SPIDER, bodyColor, bodySize, legPhase } from './animals-math'

const here = dirname(fileURLToPath(import.meta.url))
const wasmBytes = readFileSync(join(here, '../core/pkg/game_wasm_bg.wasm'))

describe('animals-math', () => {
  beforeAll(async () => {
    await Core.init(wasmBytes)
  })

  it('the drawn size IS the hit box, for both kinds', () => {
    // The reason `birds-math` has the same test: a drawn size spelled in TS
    // drifts from the box a bullet tests against, and the symptom is an animal
    // you can see and cannot hit. Pinned to `C()`, never to a literal here.
    const c = C()
    const s = bodySize(SPIDER)
    expect(s.w).toBeCloseTo(c.SPIDER_W, 5)
    expect(s.h).toBeCloseTo(c.SPIDER_H, 5)
    const b = bodySize(BEETLE)
    expect(b.w).toBeCloseTo(c.BEETLE_W, 5)
    expect(b.h).toBeCloseTo(c.BEETLE_H, 5)
  })

  it('a beetle is drawn bigger than a spider, as the sim has it', () => {
    // The control for the test above: if both branches returned the same
    // numbers, the equalities would still hold for one kind's constants used
    // twice.
    expect(bodySize(BEETLE).w).toBeGreaterThan(bodySize(SPIDER).w)
    expect(bodySize(BEETLE).h).toBeGreaterThan(bodySize(SPIDER).h)
  })

  it('the two kinds are visually distinct', () => {
    const spider = bodyColor(SPIDER)
    const beetle = bodyColor(BEETLE)
    expect(spider).not.toBe(beetle)
    const lum = (c: number) =>
      0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)
    expect(Math.abs(lum(spider) - lum(beetle))).toBeGreaterThan(20)
  })

  it('the legs swing over their full range within one period', () => {
    let lo = Infinity
    let hi = -Infinity
    for (let ms = 0; ms < 1000; ms += 5) {
      const v = legPhase(ms, 0, SPIDER)
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    expect(hi).toBeGreaterThan(0.95)
    expect(lo).toBeLessThan(-0.95)
  })

  it('two animals do not walk in lockstep', () => {
    // Without the per-id offset a row of spiders is one animation drawn five
    // times, which reads as a rendering bug rather than as life.
    expect(Math.abs(legPhase(0, 0, SPIDER) - legPhase(0, 1, SPIDER))).toBeGreaterThan(0.1)
  })

  it('the two kinds do not walk at the same rate', () => {
    // A beetle plods and a spider skitters. Same clock, different period, or
    // the kind argument is decoration.
    expect(legPhase(200, 0, BEETLE)).not.toBeCloseTo(legPhase(200, 0, SPIDER), 3)
  })
})
