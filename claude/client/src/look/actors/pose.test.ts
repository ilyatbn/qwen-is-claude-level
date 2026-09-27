import { describe, expect, it } from 'vitest'
import { SH, TH, flameAxis, leg } from './figure'
import { AIM_QUANTUM, FIGURE_SCALE, FLICKER, JET_LEN, JET_MIN_FRACTION, JET_QUANTUM, LAND_S, LEG_QUANTUM, SETTLE_STEP_S, SPACE_JET_LEN, STRIDE_UNITS, newFigureState, reach, stepFigure, trigger, type FigureInputs } from './pose'
import { deriveAnimState } from '../../render/playerView-math'
import { cellKey } from './cell'
import type { Actor } from '../scene'

const WALK = 120
/** The full flame's push these tests burn against (`Core.fullThrust` in the game), and a full push up. */
const FULL = 1000
const UP = { x: 0, y: -FULL }
const inp = (o: Partial<FigureInputs> = {}): FigureInputs => ({
  dt: 1 / 60, vx: 0, vy: 0, aim: 0, alive: true, grounded: true, jetpack: false, space: false, thrust: null,
  weapon: 'smg', boots: false, wings: false, walkSpeed: WALK, thrustMax: FULL, ...o,
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
    const planted = (t: { fy: number }): boolean => Math.abs(t.fy) < (TH + SH) * LEG_QUANTUM
    let pairs = 0
    let worst = 0
    for (let i = 1; i < track.length; i++) {
      if (!planted(track[i]!) || !planted(track[i - 1]!)) continue
      pairs++
      worst = Math.max(worst, Math.abs(track[i]!.x - track[i - 1]!.x))
    }
    expect(pairs).toBeGreaterThan(40)
    // T23.14D F13: the drawn angles are rounded (`LEG_QUANTUM`), which moves a foot by at most half a quantum's arc
    // along thigh + shin; the walker's own slide stays under 0.05 px on top of that.
    expect(worst).toBeLessThan(0.05 + (TH + SH) * LEG_QUANTUM * s)
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
    expect(Math.abs(fFlat[1])).toBeLessThan((TH + SH) * LEG_QUANTUM)
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
    const jf = stepFigure(newFigureState(), inp({ jetpack: true, grounded: false, thrust: UP })).J.jet!
    expect(Math.abs(jf - JET_LEN)).toBeLessThanOrEqual(JET_LEN * FLICKER + JET_QUANTUM)
    const spSt = newFigureState()
    let sp = stepFigure(spSt, inp({ space: true, jetpack: true, grounded: false, thrust: { x: 100, y: 0 } }))
    for (let i = 0; i < 30; i++) sp = stepFigure(spSt, inp({ space: true, jetpack: true, grounded: false, thrust: { x: 100, y: 0 } }))
    expect(sp.helmet).toBe(true)
    expect(sp.rot).toBeCloseTo(Math.PI / 2, 1)
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

  describe('T23.14B: the jet flame', () => {
    /** The flame's direction on screen (nozzle → tip), unit, after `n` frames of pushing `thrust` in space. */
    const flameDir = (thrust: { x: number; y: number }, face = 1, n = 40): [number, number] => {
      const st = newFigureState()
      let d = stepFigure(st, inp({ space: true, jetpack: true, grounded: false, thrust }))
      for (let i = 0; i < n; i++) d = stepFigure(st, inp({ space: true, jetpack: true, grounded: false, thrust, aim: face > 0 ? 0 : Math.PI }))
      const ax = flameAxis(d.J, { s: FIGURE_SCALE, face: d.face, rot: d.rot })!
      const v: [number, number] = [ax.tip[0] - ax.base[0], ax.tip[1] - ax.base[1]]
      const l = Math.hypot(...v)
      return [v[0] / l, v[1] / l]
    }
    it('points against the push, every way round and facing either way (DOWN held: the flame is above)', () => {
      for (const face of [1, -1]) {
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4
          const push = { x: Math.cos(a) * 1000, y: Math.sin(a) * 1000 }
          const [dx, dy] = flameDir(push, face)
          // Against the push to within the turn's rounding and the nozzle's few-degree offset.
          expect(dx * Math.cos(a) + dy * Math.sin(a)).toBeLessThan(-0.97)
        }
      }
      // DOWN by name (the owner's words: "if i move down … a burst … from above"); T23.14's ±1.3 rad clamp fails it.
      const down = flameDir({ x: 0, y: 1000 })
      expect(down[1]).toBeLessThan(-0.97)
    })
    it('eases round, and floats upright again when the push stops', () => {
      const st = newFigureState()
      const push = { space: true, jetpack: true, grounded: false, thrust: { x: 0, y: 1000 } }
      const first = stepFigure(st, inp(push)).rot
      expect(Math.abs(first)).toBeGreaterThan(0)
      expect(Math.abs(first)).toBeLessThan(Math.PI / 2)
      for (let i = 0; i < 60; i++) stepFigure(st, inp(push))
      let d = stepFigure(st, inp(push))
      expect(Math.abs(d.rot)).toBeCloseTo(Math.PI, 1)
      for (let i = 0; i < 60; i++) d = stepFigure(st, inp({ space: true, grounded: false }))
      expect(d.rot).toBeCloseTo(0, 1)
      expect(d.J.jet).toBe(0)
    })
    it('flickers within its band, in steps, and a weaker push burns a shorter flame', () => {
      const st = newFigureState()
      const lens = new Set<number>()
      for (let i = 0; i < 120; i++) {
        const j = stepFigure(st, inp({ jetpack: true, grounded: false, thrust: UP })).J.jet!
        expect(Math.abs(j - JET_LEN)).toBeLessThanOrEqual(JET_LEN * FLICKER + JET_QUANTUM)
        expect(Math.abs(j / JET_QUANTUM - Math.round(j / JET_QUANTUM))).toBeLessThan(1e-9)
        lens.add(j)
      }
      expect(lens.size).toBeGreaterThanOrEqual(4)
      const mean = (thrust: { x: number; y: number }): number => {
        const s2 = newFigureState()
        let sum = 0
        for (let i = 0; i < 120; i++) sum += stepFigure(s2, inp({ space: true, jetpack: true, grounded: false, thrust })).J.jet!
        return sum / 120
      }
      expect(Math.abs(mean({ x: 0, y: -1000 }) - SPACE_JET_LEN)).toBeLessThan(SPACE_JET_LEN * FLICKER * 0.5)
      expect(Math.abs(mean({ x: 0, y: -450 }) - SPACE_JET_LEN * JET_MIN_FRACTION)).toBeLessThan(SPACE_JET_LEN * FLICKER * 0.5)
    })
    it('T23.14D F5: the same push burns the same flame on every client; no known push burns the weakest', () => {
      // Two views that have seen different pushes before (the old running max) draw the same flame for the same push.
      const run = (before: { x: number; y: number }[]): number => {
        const st = newFigureState()
        for (const t of before) stepFigure(st, inp({ jetpack: true, grounded: false, thrust: t }))
        st.jetT = 0
        return stepFigure(st, inp({ jetpack: true, grounded: false, thrust: { x: 0, y: -FULL / 2 }, dt: 0 })).J.jet!
      }
      expect(run([])).toBe(run([{ x: 0, y: -4 * FULL }, { x: 3 * FULL, y: 0 }]))
      // Null (unknown) is the weakest flame — as a push under JET_MIN_FRACTION is — not the full one it drew before.
      const mean = (thrust: { x: number; y: number } | null): number => {
        const st = newFigureState()
        let sum = 0
        for (let i = 0; i < 120; i++) sum += stepFigure(st, inp({ jetpack: true, grounded: false, thrust })).J.jet!
        return sum / 120
      }
      expect(Math.abs(mean(null) - JET_LEN * JET_MIN_FRACTION)).toBeLessThan(JET_LEN * FLICKER * 0.5)
      expect(Math.abs(mean(UP) - JET_LEN)).toBeLessThan(JET_LEN * FLICKER * 0.5)
    })
    it('T23.14D F4: space turns against the push it is given, never the travel (a braking body)', () => {
      // Drifting right (vx > 0) while braking with LEFT: the push is left, so the flame points right, behind the push.
      const st = newFigureState()
      let d = stepFigure(st, inp({ space: true, jetpack: true, grounded: false, vx: 150, thrust: { x: -FULL, y: 0 } }))
      for (let i = 0; i < 40; i++) d = stepFigure(st, inp({ space: true, jetpack: true, grounded: false, vx: 150 - i, thrust: { x: -FULL, y: 0 } }))
      const ax = flameAxis(d.J, { s: FIGURE_SCALE, face: d.face, rot: d.rot })!
      expect(ax.tip[0] - ax.base[0]).toBeGreaterThan(0)
      // No push known: no flame, whatever the velocity (velocity no longer stands in).
      const n = stepFigure(newFigureState(), inp({ space: true, jetpack: true, grounded: false, vx: 150, thrust: null }))
      expect(n.J.jet).toBe(0)
    })
  })

  describe('T23.14D F6: the walker does not pop', () => {
    /** Both feet's world x and height (figure units, + down) as drawn. */
    const feetOf = (d: ReturnType<typeof stepFigure>, x: number): [number, number][] =>
      [0, 1].map((i) => {
        const f = foot(d.J, i)
        return [x + f[0] * FIGURE_SCALE * d.face, f[1]] as [number, number]
      })
    /** The largest move of any foot between consecutive frames, px. */
    const worstJump = (frames: [number, number][][]): number => {
      let w = 0
      for (let i = 1; i < frames.length; i++) for (let k = 0; k < 2; k++) w = Math.max(w, Math.hypot(frames[i]![k]![0] - frames[i - 1]![k]![0], (frames[i]![k]![1] - frames[i - 1]![k]![1]) * FIGURE_SCALE))
      return w
    }
    /** The fastest a foot moves in a frame while walking from a standstill (a stride swings it at twice the body's speed). */
    const STEP_PX = ((): number => {
      const st = newFigureState()
      let x = 0
      const frames: [number, number][][] = []
      for (let i = 0; i < 120; i++) {
        x += WALK / 60
        frames.push(feetOf(stepFigure(st, inp({ vx: WALK, x, groundDy: () => 0 })), x))
      }
      return worstJump(frames)
    })()

    it('stopping mid-stride settles by stepping, not by teleporting, and ends at the stance', () => {
      let lifts = 0
      for (const stopAt of [7, 11, 16, 23]) {
        const st = newFigureState()
        let x = 0
        const frames: [number, number][][] = []
        for (let i = 0; i < stopAt; i++) {
          x += WALK / 60
          frames.push(feetOf(stepFigure(st, inp({ vx: WALK, x, groundDy: () => 0 })), x))
        }
        for (let i = 0; i < 60; i++) {
          const d = stepFigure(st, inp({ vx: 0, x, groundDy: () => 0 }))
          const f = feetOf(d, x)
          if (f.some(([, y]) => y < -0.3)) lifts++
          frames.push(f)
        }
        // No frame moves a foot faster than walking does (a teleport to the stance was a whole stride in one frame).
        expect(worstJump(frames)).toBeLessThanOrEqual(STEP_PX + 0.05)
        // It ends standing: the same picture as a figure that never moved, placed here.
        const still = feetOf(stepFigure(newFigureState(), inp({ x, groundDy: () => 0 })), x)
        const end = frames[frames.length - 1]!
        for (let k = 0; k < 2; k++) expect(Math.abs(end[k]![0] - still[k]![0])).toBeLessThan(1.2 * FIGURE_SCALE + 0.2)
      }
      // A foot that had to move back did so lifted, over frames (a step), in at least one of the stops.
      expect(lifts).toBeGreaterThan(2)
      // Control: SETTLE_STEP_S is what clocks it — a settle takes that long, not one frame.
      expect(SETTLE_STEP_S * 60).toBeGreaterThan(3)
    })

    it('a landing re-plants the feet under the body and rises out of the crouch without a jump', () => {
      const st = newFigureState()
      let x = 0
      for (let i = 0; i < 20; i++) stepFigure(st, inp({ x, groundDy: () => 0 }))
      // A hop: 40 frames in the air drifting 60 px right, then down.
      const frames: [number, number][][] = []
      for (let i = 0; i < 40; i++) {
        x += 1.5
        stepFigure(st, inp({ grounded: false, vy: i < 20 ? -200 : 200, vx: 90, x, groundDy: () => 0 }))
      }
      const land: ReturnType<typeof stepFigure>[] = []
      for (let i = 0; i < 40; i++) {
        const d = stepFigure(st, inp({ x, groundDy: () => 0 }))
        land.push(d)
        frames.push(feetOf(d, x))
      }
      // Planted where it landed: both feet on the ground under the body, at their stance spots.
      const still = feetOf(stepFigure(newFigureState(), inp({ x, groundDy: () => 0 })), x)
      for (let k = 0; k < 2; k++) {
        expect(Math.abs(frames[0]![k]![0] - still[k]![0])).toBeLessThan(0.5)
        expect(Math.abs(frames[0]![k]![1])).toBeLessThan(0.05)
      }
      // The crouch: the hip starts low and rises; no foot moves more than a hair through it.
      expect(land[0]!.J.hipY!).toBeGreaterThan(-9)
      expect(land[land.length - 1]!.J.hipY!).toBeLessThan(-12.5)
      expect(worstJump(frames)).toBeLessThan(0.5)
      expect(Math.round((LAND_S * 60) / 2)).toBeGreaterThan(2)
    })

    it('a foot over no ground hangs on the pose (FK), and one over ground stays planted (the control)', () => {
      // Ground only left of the feet origin +1 px: the front foot (right, facing right) is off the edge.
      const edge = (dx: number): number | null => (dx <= 1 ? 0 : null)
      const d = stepFigure(newFigureState(), inp({ x: 0, groundDy: edge }))
      const fk = stepFigure(newFigureState(), inp({}))
      const front = [0, 1].reduce((a, b) => (foot(d.J, a)[0] > foot(d.J, b)[0] ? a : b))
      const back = 1 - front
      expect(d.J.legs[front]).toEqual(fk.J.legs[front])
      // The planted one is on the ground (y 0); the hanging one is where FK puts it, not dragged to the feet line.
      expect(Math.abs(foot(d.J, back)[1])).toBeLessThan(0.05)
      // Nothing under it for many frames: it keeps hanging, it does not tread air.
      const st = newFigureState()
      const legs = new Set<string>()
      for (let i = 0; i < 30; i++) legs.add(JSON.stringify(stepFigure(st, inp({ x: 0, groundDy: edge })).J.legs[front]))
      expect(legs.size).toBe(1)
    })
  })

  it('T23.14D F8: the pose is chosen by deriveAnimState, and reports it', () => {
    const cases: Partial<FigureInputs>[] = [
      {}, { vx: WALK }, { grounded: false, vy: -100 }, { grounded: false, vy: 100 }, { jetpack: true, grounded: false, thrust: UP },
      { alive: false }, { alive: false, jetpack: true }, { jetpack: true, grounded: true, thrust: UP },
    ]
    for (const c of cases) {
      const i = inp(c)
      expect(stepFigure(newFigureState(), i).state).toBe(deriveAnimState(i))
    }
    // Dead is dead whatever else holds (the table's first row), and draws the dead turn.
    expect(stepFigure(newFigureState(), inp({ alive: false, jetpack: true })).rot).toBe(-1.5)
  })

  it('T23.14D F13: a figure climbing on its jet is as many cells as it has drawings, wherever it goes', () => {
    for (const [vy, jetpack] of [[-200, true], [400, false]] as const) {
      const st = newFigureState()
      const keys = new Set<string>()
      const phased = new Set<string>()
      const drawings = new Set<string>()
      let y = 500
      for (let i = 0; i < 120; i++) {
        y += vy / 60
        const d = stepFigure(st, inp({ vy, jetpack, grounded: false, thrust: UP, aim: 0.2 }))
        const a: Actor = { kind: 'figure', x: 300.4 + i * 0.7, y, opts: { J: d.J, s: FIGURE_SCALE, face: d.face, rot: d.rot }, lit: { size: 1, halo: null, shadow: false }, box: null }
        keys.add(cellKey(a, null))
        phased.add(cellKey(a, null, true))
        drawings.add(JSON.stringify(d.J))
      }
      expect(keys.size).toBe(drawings.size)
      expect(drawings.size).toBeLessThan(60)
      // Control: keyed on its pixel phase (the look-lab's rule) nearly every frame is a new cell.
      expect(phased.size).toBeGreaterThan(2 * drawings.size)
    }
  })
})
