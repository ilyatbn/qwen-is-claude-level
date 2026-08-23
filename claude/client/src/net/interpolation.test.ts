import { describe, expect, it } from 'vitest'
import type { SnapshotPlayer } from './codec'
import {
  ClockSync,
  RemoteInterpolator,
  dequantAim,
  shortestArcLerp,
  wrapToPi,
} from './interpolation'

const TAU = Math.PI * 2
const BUF = 100

function p(id: number, x: number, y: number, aimDeg = 0, vx = 0, vy = 0): SnapshotPlayer {
  return {
    id,
    x,
    y,
    vx,
    vy,
    aim: Math.round(((((aimDeg * Math.PI) / 180) % TAU) / TAU) * 65536) & 0xffff,
    health: 100,
    flags: 1,
    jetpackFuel: 255, vision: 1, battery: 0,
    selectedItem: null,
  }
}

describe('angle helpers', () => {
  it('wrapToPi maps to (-pi, pi]', () => {
    expect(wrapToPi(0)).toBeCloseTo(0, 9)
    expect(wrapToPi(TAU)).toBeCloseTo(0, 9)
    expect(wrapToPi(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2, 9)
    expect(wrapToPi(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2, 9)
  })

  it('interpolates 350° to 10° through 0, not through 180', () => {
    const a = (350 / 180) * Math.PI
    const b = (10 / 180) * Math.PI
    const mid = shortestArcLerp(a, b, 0.5)
    // 0° (or equivalently 360°), never 180°.
    const deg = ((mid * 180) / Math.PI + 720) % 360
    expect(Math.min(deg, 360 - deg)).toBeLessThan(1)
  })

  it('is falsifiable: a naive lerp of the same pair goes the long way', () => {
    const a = (350 / 180) * Math.PI
    const b = (10 / 180) * Math.PI
    const naive = a + (b - a) * 0.5
    const deg = ((naive * 180) / Math.PI + 720) % 360
    expect(Math.abs(deg - 180)).toBeLessThan(1)
  })
})

describe('bracketing', () => {
  it('interpolates linearly between the bracketing pair', () => {
    const it0 = new RemoteInterpolator(BUF)
    it0.push(1, 1000, [p(1, 0, 0)])
    it0.push(2, 1050, [p(1, 100, 200)])
    // renderTime = now - 100 = 1025, halfway between 1000 and 1050
    const s = it0.sample(1125)
    expect(s.get(1)!.x).toBeCloseTo(50, 6)
    expect(s.get(1)!.y).toBeCloseTo(100, 6)
    expect(s.get(1)!.extrapolated).toBe(false)
  })

  it('picks the correct pair out of many', () => {
    const it0 = new RemoteInterpolator(BUF)
    for (let i = 0; i < 10; i++) it0.push(i, 1000 + i * 50, [p(1, i * 10, 0)])
    // renderTime 1275 sits between frames at 1250 (x=50) and 1300 (x=60)
    const s = it0.sample(1375)
    expect(s.get(1)!.x).toBeCloseTo(55, 6)
  })

  it('handles snapshots arriving out of order', () => {
    const it0 = new RemoteInterpolator(BUF)
    it0.push(3, 1100, [p(1, 200, 0)])
    it0.push(1, 1000, [p(1, 0, 0)])
    it0.push(2, 1050, [p(1, 100, 0)])
    const s = it0.sample(1125) // renderTime 1025 → between 1000 and 1050
    expect(s.get(1)!.x).toBeCloseTo(50, 6)
  })

  it('a re-sent tick replaces rather than duplicating', () => {
    const it0 = new RemoteInterpolator(BUF)
    it0.push(1, 1000, [p(1, 0, 0)])
    it0.push(1, 1000, [p(1, 0, 0)])
    it0.push(2, 1050, [p(1, 100, 0)])
    expect(it0.stats.bufferDepth).toBe(2)
  })

  it('a dropped snapshot still leaves a bracketing pair', () => {
    const it0 = new RemoteInterpolator(BUF)
    it0.push(1, 1000, [p(1, 0, 0)])
    // the 1050 snapshot never arrives
    it0.push(3, 1100, [p(1, 200, 0)])
    const s = it0.sample(1150) // renderTime 1050 → halfway across the gap
    expect(s.get(1)!.x).toBeCloseTo(100, 6)
    expect(s.get(1)!.extrapolated).toBe(false)
  })

  it('interpolates aim the short way across the wrap point', () => {
    const it0 = new RemoteInterpolator(BUF)
    it0.push(1, 1000, [p(1, 0, 0, 350)])
    it0.push(2, 1050, [p(1, 0, 0, 10)])
    const s = it0.sample(1125)
    const deg = ((s.get(1)!.aim * 180) / Math.PI + 720) % 360
    expect(Math.min(deg, 360 - deg)).toBeLessThan(2)
  })
})

describe('extrapolation', () => {
  it('extrapolates from velocity when there is no future snapshot', () => {
    const it0 = new RemoteInterpolator(BUF)
    it0.push(1, 1000, [p(1, 0, 0, 0, 100, 0)]) // 100 px/s right
    const s = it0.sample(1200) // renderTime 1100 → 100 ms past the last frame
    expect(s.get(1)!.x).toBeCloseTo(10, 3)
    expect(s.get(1)!.extrapolated).toBe(true)
    expect(it0.stats.frozen).toBe(false)
  })

  it('stops extrapolating at 250 ms and holds position', () => {
    const it0 = new RemoteInterpolator(BUF)
    it0.push(1, 1000, [p(1, 0, 0, 0, 100, 0)])

    const at250 = it0.sample(1350).get(1)!.x // renderTime 1250 → exactly 250 ms
    expect(at250).toBeCloseTo(25, 3)

    const at2s = it0.sample(3100).get(1)!.x // renderTime 3000 → 2 s past
    expect(at2s).toBeCloseTo(25, 3) // frozen at the cap, not 200 px away
    expect(it0.stats.frozen).toBe(true)
  })

  it('is not extrapolating while a future snapshot exists', () => {
    const it0 = new RemoteInterpolator(BUF)
    it0.push(1, 1000, [p(1, 0, 0, 0, 100, 0)])
    it0.push(2, 1200, [p(1, 20, 0, 0, 100, 0)])
    it0.sample(1150)
    expect(it0.stats.extrapolatingMs).toBe(0)
    expect(it0.stats.frozen).toBe(false)
  })
})

describe('roster edges', () => {
  it('holds a player who is in the older frame but not the newer', () => {
    const it0 = new RemoteInterpolator(BUF)
    it0.push(1, 1000, [p(1, 10, 20), p(2, 30, 40)])
    it0.push(2, 1050, [p(1, 10, 20)])
    const s = it0.sample(1125)
    expect(s.get(2)).toBeDefined()
    expect(s.get(2)!.x).toBe(30)
  })

  it('draws a player who appears only in the newer frame', () => {
    const it0 = new RemoteInterpolator(BUF)
    it0.push(1, 1000, [p(1, 10, 20)])
    it0.push(2, 1050, [p(1, 10, 20), p(3, 70, 80)])
    const s = it0.sample(1125)
    expect(s.get(3)!.x).toBe(70)
  })

  it('an empty buffer samples to nothing rather than throwing', () => {
    expect(new RemoteInterpolator(BUF).sample(1000).size).toBe(0)
  })
})

describe('ClockSync', () => {
  it('converges on a steady offset', () => {
    const c = new ClockSync()
    for (let i = 0; i < 60; i++) c.addSample(1000 + i * 50 + 25, 1000 + i * 50, 50)
    // offset = serverTime + rtt/2 - localTime = 25 + 25 = 50
    expect(c.offset).toBeCloseTo(50, 0)
  })

  it('rejects a 3-sigma outlier instead of chasing it', () => {
    const c = new ClockSync()
    for (let i = 0; i < 40; i++) {
      const jitter = (i % 2 === 0 ? 1 : -1) * 0.5
      c.addSample(1000 + i * 50 + 25 + jitter, 1000 + i * 50, 50)
    }
    const before = c.offset
    c.addSample(1000 + 40 * 50 + 25 + 5000, 1000 + 40 * 50, 50) // wild sample
    expect(Math.abs(c.offset - before)).toBeLessThan(1)
  })

  it('tracks rtt', () => {
    const c = new ClockSync()
    for (let i = 0; i < 30; i++) c.addSample(1000 + i, 1000 + i, 80)
    expect(c.rtt).toBeCloseTo(80, 0)
  })
})

describe('quantised aim', () => {
  it('round-trips within a fraction of a degree', () => {
    for (let deg = 0; deg < 360; deg += 7) {
      const q = Math.round((((deg * Math.PI) / 180 / TAU) * 65536)) & 0xffff
      const back = (dequantAim(q) * 180) / Math.PI
      expect(Math.abs(back - deg)).toBeLessThan(0.01)
    }
  })
})
