import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyFrame } from './kit'
import { dropFx, emberParticleFx, VENT_JET_H, VENT_JET_HALF, VENT_MOUTH_R, ventFx, weatherFrame, type WeatherSource } from './hazards'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const STREAK = { len: 18, width: 2, alpha: 0.9 }

describe('the weather hazards in F (T23.19E)', () => {
  it("the jet's cone is lava.rs's own (both ends: the TS copy against the Rust source)", () => {
    const src = readFileSync(join(root, 'crates/game-core/src/effects/lava.rs'), 'utf8')
    expect(Number(/const JET_HEIGHT: f32 = ([\d.]+);/.exec(src)?.[1])).toBe(VENT_JET_H)
    expect(Number(/const JET_HALF_ANGLE: f32 = ([\d.]+);/.exec(src)?.[1])).toBe(VENT_JET_HALF)
  })

  it("a jetting vent's glows cover every point of the cone that burns; the mouth glows and burns", () => {
    for (const lean of [0, 0.3, -0.25]) {
      const v = { x: 500, y: 400, jetting: true, burning: false, lean }
      const out = emptyFrame()
      ventFx(out, v, 0)
      expect(out.discs.length).toBe(1)
      // Sample the cone: along the axis and to either edge (lava.rs::in_jet's test, walked).
      for (let d = 10; d <= VENT_JET_H; d += 10) {
        for (const off of [-VENT_JET_HALF * 0.95, 0, VENT_JET_HALF * 0.95]) {
          const a = lean + off
          const px = v.x + Math.sin(a) * d
          const py = v.y - Math.cos(a) * d
          const covered = out.soft.some((s) => Math.hypot(s.x - px, s.y - py) <= s.size / 2 * 0.8)
          expect(covered, `lean ${lean}: (${px.toFixed(0)},${py.toFixed(0)}) at ${d} px, ${off} rad off the axis`).toBe(true)
        }
      }
    }
  })

  it('a burning vent glows at its mouth and has no jet; a spent vent draws nothing (the control)', () => {
    const burning = emptyFrame()
    ventFx(burning, { x: 0, y: 0, jetting: false, burning: true, lean: 0 }, 0)
    expect(burning.soft.length).toBeGreaterThan(0)
    expect(burning.soft.every((s) => Math.hypot(s.x, s.y) <= VENT_MOUTH_R * 2)).toBe(true)
    const spent = emptyFrame()
    ventFx(spent, { x: 0, y: 0, jetting: false, burning: false, lean: 0 }, 0)
    expect(spent.soft.length + spent.discs.length).toBe(0)
  })

  it("a toxic drop's streak ends at the drop — where it hits — and runs up from it", () => {
    const out = emptyFrame()
    dropFx(out, { x: 120, y: 300 }, STREAK)
    const r = out.ribbons[0]!
    // The ribbon's head (brightest) is its last point.
    expect(r.pts[r.pts.length - 1]).toEqual([120, 300])
    expect(r.pts[0]).toEqual([120, 300 - STREAK.len])
  })

  it('an ember fades with its life; a spent one is not drawn', () => {
    const live = emptyFrame()
    emberParticleFx(live, { x: 1, y: 2, life: 1, ttl: 1.3 })
    expect(live.soft.length).toBe(2)
    const spent = emptyFrame()
    emberParticleFx(spent, { x: 1, y: 2, life: 0, ttl: 1.3 })
    expect(spent.soft.length).toBe(0)
  })

  it('a hidden weather layer lays out nothing; shown, everything (counted at both ends)', () => {
    const w: WeatherSource = {
      visible: true,
      vents: [{ x: 0, y: 0, jetting: true, burning: false, lean: 0 }],
      embers: [{ x: 5, y: 5, life: 1, ttl: 1 }],
      drops: [{ x: 9, y: 9 }, { x: 19, y: 9 }],
      streak: STREAK,
    }
    const out = emptyFrame()
    weatherFrame(w, out, 0)
    expect(out.ribbons.length).toBe(w.drops.length)
    expect(out.discs.length).toBe(w.vents.length)
    const hidden = emptyFrame()
    weatherFrame({ ...w, visible: false }, hidden, 0)
    expect(hidden.ribbons.length + hidden.soft.length + hidden.discs.length).toBe(0)
  })
})
