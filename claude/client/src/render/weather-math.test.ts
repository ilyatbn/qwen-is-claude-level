import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { C, Core, fogStrength } from '../core'
import { EmberField, FogClock, RainField, fogVeilAlpha } from './weather-math'

beforeAll(async () => {
  const url = new URL('../core/pkg/game_wasm_bg.wasm', import.meta.url)
  await Core.init(readFileSync(fileURLToPath(url)))
})

describe('RainField', () => {
  it('keeps a fixed pool however long it rains — an emitter, not entities', () => {
    const r = new RainField(120, 800, 600)
    r.update(0.016, 1)
    const n = r.drops.length
    for (let i = 0; i < 600; i++) r.update(0.016, 1) // ~10 s of downpour
    expect(r.drops.length).toBe(n)
  })

  it('ramps in and out rather than appearing whole', () => {
    const r = new RainField(20, 800, 600)
    expect(r.intensity).toBe(0)
    r.update(0.5, 1)
    // Mid-ramp: neither off nor fully on. A layer that snaps to 1 reads as a
    // toggle, not as weather.
    expect(r.intensity).toBeGreaterThan(0)
    expect(r.intensity).toBeLessThan(1)
    for (let i = 0; i < 20; i++) r.update(0.1, 1)
    expect(r.intensity).toBe(1)
    for (let i = 0; i < 40; i++) r.update(0.1, 0)
    expect(r.intensity).toBe(0)
  })

  it('wraps every drop back inside the view', () => {
    const r = new RainField(200, 400, 300)
    for (let i = 0; i < 300; i++) r.update(0.016, 1)
    for (const d of r.drops) {
      expect(d.y).toBeGreaterThanOrEqual(0)
      expect(d.y).toBeLessThanOrEqual(300)
      expect(d.x).toBeGreaterThanOrEqual(0)
      expect(d.x).toBeLessThanOrEqual(400)
    }
  })

  it('does not move a drop while the intensity is zero', () => {
    // The control for the test above: if drops moved regardless, "it rains when
    // active" would pass for a field that always rains.
    const r = new RainField(10, 400, 300)
    const y0 = r.drops.map((d) => d.y)
    for (let i = 0; i < 50; i++) r.update(0.016, 0)
    expect(r.drops.map((d) => d.y)).toEqual(y0)
  })

  it('is deterministic from its seed, so a screenshot of rain reproduces', () => {
    const a = new RainField(30, 800, 600, 99)
    const b = new RainField(30, 800, 600, 99)
    expect(a.drops).toEqual(b.drops)
    expect(new RainField(30, 800, 600, 100).drops).not.toEqual(a.drops)
  })
})

describe('EmberField', () => {
  it('spews upward from the vent', () => {
    const e = new EmberField(200, 500)
    e.emit(0.1, 100, 100, 0, 260)
    expect(e.embers.length).toBeGreaterThan(0)
    // Every ember leaves with an upward velocity: a "spew" that starts by falling
    // is a leak, not an eruption (§C6 asks for fire going *up*).
    for (const p of e.embers) expect(p.vy).toBeLessThan(0)
  })

  it('falls back under gravity, which is what makes it an arc', () => {
    const e = new EmberField(200, 500)
    e.emit(0.1, 100, 100, 0, 260)
    const first = e.embers[0]!
    const vy0 = first.vy
    for (let i = 0; i < 30; i++) e.update(0.016, 900)
    // Either it died, or it is now moving downward faster than it started.
    const alive = e.embers.find((p) => p === first)
    if (alive) expect(alive.vy).toBeGreaterThan(vy0)
  })

  it('never exceeds its cap, however long a vent jets', () => {
    const e = new EmberField(500, 40)
    for (let i = 0; i < 200; i++) {
      e.emit(0.05, 0, 0, 0, 200)
      e.update(0.0001, 0) // barely ages them, so the cap is what bounds it
    }
    expect(e.embers.length).toBeLessThanOrEqual(40)
  })

  it('expires them, so a finished jet leaves nothing behind', () => {
    const e = new EmberField(200, 500)
    e.emit(0.1, 0, 0, 0, 200)
    expect(e.embers.length).toBeGreaterThan(0)
    for (let i = 0; i < 200; i++) e.update(0.05, 900)
    expect(e.embers.length).toBe(0)
  })
})

describe('the heavy-fog veil (§F9)', () => {
  it('is FOG_SCREEN_ALPHA times the strength, across the whole ramp', () => {
    const c = C()
    // Sampled off `fog.rs`'s own ramp rather than off a list of made-up
    // strengths: this is the sequence the veil will actually be handed, ramp in
    // and ramp out included, and it is the same function `fov_multiplier` reads.
    let sawPartial = 0
    let sawFull = 0
    for (let t = 0; t <= c.FOG_DURATION; t += 0.1) {
      const s = fogStrength(t)
      expect(fogVeilAlpha(s)).toBeCloseTo(c.FOG_SCREEN_ALPHA * s, 6)
      if (s > 0.01 && s < 0.99) sawPartial++
      if (s >= 0.999) sawFull++
    }
    // The control the assertion above needs: if the ramp were a step, every
    // sample would be 0 or 1 and "alpha = ALPHA x strength" would be proved for
    // exactly two points. FOG_RAMP is 2 s at each end, so a 0.1 s walk must find
    // partial samples in between.
    expect(sawPartial).toBeGreaterThan(20)
    expect(sawFull).toBeGreaterThan(0)
  })

  it('is FOG_SCREEN_ALPHA at full strength and nothing at all outside the effect', () => {
    const c = C()
    expect(fogVeilAlpha(1)).toBeCloseTo(c.FOG_SCREEN_ALPHA, 6)
    // Before it starts and after it ends. Both come off the real ramp, so this
    // fails if `strength()` ever stops closing at its ends.
    expect(fogVeilAlpha(fogStrength(-1))).toBe(0)
    expect(fogVeilAlpha(fogStrength(0))).toBe(0)
    expect(fogVeilAlpha(fogStrength(c.FOG_DURATION))).toBe(0)
    expect(fogVeilAlpha(fogStrength(c.FOG_DURATION + 1))).toBe(0)
  })

  it('clamps, because a networked client walks the clock itself', () => {
    // `GameScene` computes `roundTime - fogStartedAt`, and a resync can hand it
    // a value outside the window. Phaser treats a negative alpha as opaque, so
    // an unclamped veil would black the screen out on a clock correction.
    expect(fogVeilAlpha(-0.5)).toBe(0)
    expect(fogVeilAlpha(2)).toBeCloseTo(C().FOG_SCREEN_ALPHA, 6)
  })
})

describe('FogClock — the networked client\'s half of §F9', () => {
  it('is clear until a HeavyFog starts, and then follows fog.rs\'s ramp', () => {
    const c = C()
    const f = new FogClock()
    // A control that matters: nothing is foggy before anything happens, so the
    // assertions below are about the fog rather than about a default.
    expect(f.running).toBe(false)
    expect(f.strength(0)).toBe(0)
    expect(f.strength(1000)).toBe(0)

    f.start(7, 'HeavyFog', 100)
    expect(f.running).toBe(true)
    // Round time, not elapsed time: the whole job of the class is to hold the
    // origin so the caller can hand it the clock it already has.
    expect(f.strength(100)).toBe(0)
    expect(f.strength(100 + c.FOG_RAMP / 2)).toBeCloseTo(fogStrength(c.FOG_RAMP / 2), 6)
    expect(f.strength(100 + c.FOG_DURATION / 2)).toBeCloseTo(1, 6)
    expect(f.strength(100 + c.FOG_DURATION)).toBe(0)
  })

  it('ignores every effect that is not heavy fog', () => {
    const f = new FogClock()
    f.start(1, 'ToxicRain', 0)
    f.start(2, 'MeteorShower', 0)
    f.start(3, 'LavaBurst', 0)
    expect(f.running).toBe(false)
    expect(f.strength(C().FOG_DURATION / 2)).toBe(0)
  })

  it('is not switched off by another effect ending inside it', () => {
    // The branch this class exists for. Weather overlaps: a toxic rain can start
    // *and finish* during a 15 s fog, and its `effect_end` carries a different
    // id. Dropping the id check here would clear the veil mid-fog while the
    // server still says it is foggy — invisible to every test that asserts on
    // simulation state, which is the failure §F9 is a fix for.
    const c = C()
    const f = new FogClock()
    f.start(7, 'HeavyFog', 0)
    const mid = c.FOG_DURATION / 2
    const during = f.strength(mid)
    expect(during).toBeCloseTo(1, 6)

    f.end(8) // somebody else's effect
    expect(f.strength(mid)).toBe(during)
    expect(f.running).toBe(true)

    f.end(7) // and now its own
    expect(f.strength(mid)).toBe(0)
    expect(f.running).toBe(false)
  })

  it('a second fog re-bases the clock rather than stacking', () => {
    const c = C()
    const f = new FogClock()
    f.start(1, 'HeavyFog', 0)
    f.start(2, 'HeavyFog', 500)
    expect(f.strength(500 + c.FOG_DURATION / 2)).toBeCloseTo(1, 6)
    // And the first one's end no longer owns it, or the round's second fog would
    // be cancelled by the first one's cleanup event.
    f.end(1)
    expect(f.running).toBe(true)
  })
})
