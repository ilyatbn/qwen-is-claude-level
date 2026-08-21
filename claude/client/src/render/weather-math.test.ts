import { describe, expect, it } from 'vitest'
import { EmberField, RainField } from './weather-math'

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
