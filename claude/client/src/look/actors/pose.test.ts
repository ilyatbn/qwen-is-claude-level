import { describe, expect, it } from 'vitest'
import { SH, TH, leg } from './figure'
import { AIM_QUANTUM, FIGURE_SCALE, STRIDE_UNITS, newFigureState, reach, stepFigure, trigger, type FigureInputs } from './pose'
import { cellKey } from './cell'
import type { Actor } from '../scene'

const WALK = 120
const inp = (o: Partial<FigureInputs> = {}): FigureInputs => ({
  dt: 1 / 60, vx: 0, vy: 0, aim: 0, alive: true, grounded: true, jetpack: false, space: false, thrust: null,
  weapon: 'smg', boots: false, wings: false, walkSpeed: WALK, ...o,
})

/** The foot of leg i as drawn, figure units from the feet origin (the hip frame turned by the lean). */
function foot(J: ReturnType<typeof stepFigure>['J'], i: number): [number, number] {
  const hip: [number, number] = [0, J.hipY ?? -13]
  const [a, b] = J.legs[i]!
  const [, f] = leg([0, 0], a - (J.lean ?? 0), b)
  return [hip[0] + f[0], hip[1] + f[1]]
}

describe('the stick figure animation (T23.14)', () => {
  it('the run phase advances with speed and stops at rest', () => {
    const st = newFigureState()
    stepFigure(st, inp({ vx: WALK }))
    const p1 = st.phase
    for (let i = 0; i < 30; i++) stepFigure(st, inp({ vx: WALK }))
    expect(st.phase).toBeGreaterThan(p1)
    // Twice the speed, twice the phase per frame.
    const a = newFigureState()
    const b = newFigureState()
    stepFigure(a, inp({ vx: WALK }))
    stepFigure(b, inp({ vx: 2 * WALK }))
    expect(b.phase).toBeCloseTo(2 * a.phase)
    // At rest: still — the same pose frame after frame (control: moving changes it).
    const rest = newFigureState()
    const j0 = JSON.stringify(stepFigure(rest, inp()).J)
    for (let i = 0; i < 30; i++) expect(JSON.stringify(stepFigure(rest, inp()).J)).toBe(j0)
    const moving = newFigureState()
    const m0 = JSON.stringify(stepFigure(moving, inp({ vx: WALK })).J)
    expect(JSON.stringify(stepFigure(moving, inp({ vx: WALK })).J)).not.toBe(m0)
  })

  it('the planted foot does not slide: at mid-stance it holds still in the world as the body passes', () => {
    const st = newFigureState()
    const s = FIGURE_SCALE
    let x = 0
    const track: { x: number; fy: number; fx: number }[] = []
    for (let i = 0; i < 240; i++) {
      x += WALK / 60
      const d = stepFigure(st, inp({ vx: WALK, x, groundDy: () => 0 }))
      const f = foot(d.J, 0)
      track.push({ x: x + f[0] * s, fy: f[1], fx: f[0] })
    }
    // Frames where leg 0 is on the ground (y 0, planted): its world x does not move from one to the next.
    const planted = (t: { fy: number }): boolean => Math.abs(t.fy) < 1e-6
    let pairs = 0
    let worst = 0
    for (let i = 1; i < track.length; i++) {
      if (!planted(track[i]!) || !planted(track[i - 1]!)) continue
      pairs++
      worst = Math.max(worst, Math.abs(track[i]!.x - track[i - 1]!.x))
    }
    expect(pairs).toBeGreaterThan(40)
    expect(worst).toBeLessThan(0.05)
    // Control: the body moved 2 px a frame all along — a foot glued to the body would slide by that.
    expect(WALK / 60).toBeGreaterThan(1)
    expect(STRIDE_UNITS).toBeCloseTo((TH + SH) * 0.62)
  })

  it('IK puts the foot where it is sent (a slope), and a flat ground changes nothing it did not need to', () => {
    for (const t of [[2, 12], [-3, 11.5], [1, 9], [4, 12.5]] as [number, number][]) {
      const [a, b] = reach(t)
      const [, f] = leg([0, 0], a, b)
      expect(f[0]).toBeCloseTo(t[0], 5)
      expect(f[1]).toBeCloseTo(t[1], 5)
    }
    // A standing figure on a slope: the downhill foot reaches lower than on flat ground.
    const flat = stepFigure(newFigureState(), inp({ x: 0, groundDy: () => 0 }))
    const slope = stepFigure(newFigureState(), inp({ x: 0, groundDy: (dx) => dx * 0.4 }))
    const fFlat = foot(flat.J, 0)
    const fSlope = foot(slope.J, 0)
    expect(fFlat[1]).toBeCloseTo(0, 3)
    expect(fSlope[1]).toBeCloseTo((fSlope[0] * FIGURE_SCALE * 0.4) / FIGURE_SCALE, 1)
    expect(fSlope[1]).toBeGreaterThan(fFlat[1] + 0.5)
  })

  it('aim maps to the arm continuously: aims 1° apart are different cells, within AIM_QUANTUM the same', () => {
    const key = (aim: number): string => {
      const d = stepFigure(newFigureState(), inp({ aim }))
      const a: Actor = { kind: 'figure', x: 100, y: 200, opts: { J: d.J, s: FIGURE_SCALE, face: d.face }, lit: { size: 1, halo: null, shadow: true }, box: null }
      return cellKey(a, null)
    }
    for (let deg = -80; deg <= 80; deg += 1) expect(key((deg * Math.PI) / 180)).not.toBe(key(((deg + 1) * Math.PI) / 180))
    expect(key(-60 * AIM_QUANTUM)).toBe(key(-60 * AIM_QUANTUM + AIM_QUANTUM * 0.2))
    // Facing comes from the aim: left of vertical faces left.
    expect(stepFigure(newFigureState(), inp({ aim: Math.PI - 0.2 })).face).toBe(-1)
    expect(stepFigure(newFigureState(), inp({ aim: 0.2 })).face).toBe(1)
  })

  it('poses follow the flags; the scarf lags the motion; actions play and end', () => {
    expect(stepFigure(newFigureState(), inp({ jetpack: true, grounded: false })).J.jet).toBe(1.2)
    const sp = stepFigure(newFigureState(), inp({ space: true, jetpack: true, grounded: false, thrust: { x: 100, y: 0 } }))
    expect(sp.helmet).toBe(true)
    expect(sp.rot).toBeGreaterThan(1)
    expect(stepFigure(newFigureState(), inp({ alive: false })).rot).toBe(-1.5)
    // Lag: one frame into a run the scarf has moved only part of the way to its run trail.
    const st = newFigureState()
    const one = stepFigure(st, inp({ vx: WALK })).J.scarf![0]
    for (let i = 0; i < 60; i++) stepFigure(st, inp({ vx: WALK }))
    const settled = stepFigure(st, inp({ vx: WALK })).J.scarf![0]
    expect(one).toBeLessThan(settled - 0.3)
    expect(settled).toBeCloseTo(1.3, 1)
    // Landing: grounded after airborne crouches (F7 land), then stands.
    const l = newFigureState()
    stepFigure(l, inp({ grounded: false, vy: 200 }))
    expect(stepFigure(l, inp()).J.hipY).toBe(-8.4)
    for (let i = 0; i < 20; i++) stepFigure(l, inp())
    expect(stepFigure(l, inp()).J.hipY).not.toBe(-8.4)
    const m = newFigureState()
    trigger(m, 'melee')
    const a0 = stepFigure(m, inp({ weapon: 'bat' })).J.aim!
    for (let i = 0; i < 10; i++) stepFigure(m, inp({ weapon: 'bat' }))
    const a1 = stepFigure(m, inp({ weapon: 'bat' })).J.aim!
    expect(a1).toBeLessThan(a0)
    for (let i = 0; i < 30; i++) stepFigure(m, inp({ weapon: 'bat' }))
    expect(m.action).toBeNull()
  })
})
