import { describe, expect, it } from 'vitest'
import {
  STAND_TURN_RATE,
  STAND_UPRIGHT_RATE,
  feetOffset,
  standTarget,
  stepTilt,
  toLocal,
  uprightLocal,
  wrapAngle,
} from './standTilt-math'

/** `R(θ) · v` — the container's rotation, applied as Phaser applies it. */
const rot = (t: number, x: number, y: number) => ({
  x: Math.cos(t) * x - Math.sin(t) * y,
  y: Math.sin(t) * x + Math.cos(t) * y,
})

describe('standTilt-math (T22.19, R107)', () => {
  it('puts the feet along the pull: down upright, up feet-up, sideways a quarter turn', () => {
    expect(standTarget(0, 500)).toBeCloseTo(0, 9)
    expect(Math.abs(standTarget(0, -500)!)).toBeCloseTo(Math.PI, 9)
    expect(standTarget(500, 0)).toBeCloseTo(-Math.PI / 2, 9)
    // Every bearing: the figure's down, rotated, is the pull's direction.
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI
      const t = standTarget(Math.cos(a), Math.sin(a))!
      const down = rot(t, 0, 1)
      expect(down.x).toBeCloseTo(Math.cos(a), 6)
      expect(down.y).toBeCloseTo(Math.sin(a), 6)
    }
    // No pull, no target — the control that a field-free frame asks for upright.
    expect(standTarget(0, 0)).toBeNull()
  })

  it('turns toward a pull at the turn rate and eases back at the upright rate, the short way round', () => {
    const dt = 1 / 60
    // A quarter second of turning toward feet-up gets most of the way (95 % at 3/rate).
    let t = 0
    for (let i = 0; i < Math.ceil((3 / STAND_TURN_RATE) / dt); i++) t = stepTilt(t, Math.PI, dt)
    expect(Math.abs(t)).toBeGreaterThan(0.94 * Math.PI)
    // Back to upright once nothing pulls: slower, but it gets there.
    const half = Math.round((1 / STAND_UPRIGHT_RATE) / dt)
    let u = t
    for (let i = 0; i < half; i++) u = stepTilt(u, null, dt)
    expect(Math.abs(u)).toBeGreaterThan(0.2 * Math.PI) // not snapped
    for (let i = 0; i < 4 * half; i++) u = stepTilt(u, null, dt)
    expect(Math.abs(u)).toBeLessThan(0.05)
    // The short way: from +170° toward −170° is 20°, through ±180°, never through 0.
    const from = (170 / 180) * Math.PI
    const to = (-170 / 180) * Math.PI
    let w = from
    for (let i = 0; i < 5; i++) {
      w = stepTilt(w, to, dt)
      expect(Math.abs(w)).toBeGreaterThan((160 / 180) * Math.PI)
    }
    expect(stepTilt(1, 2, 0)).toBe(1)
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9)
  })

  it('pivots on the body centre, keeps the tag upright above it, and leaves screen directions alone', () => {
    const h = 28
    for (const t of [0, 0.7, Math.PI / 2, Math.PI, -2.1]) {
      const feet = feetOffset(t, h)
      // The feet are half a body along the figure's down from the centre.
      expect(Math.hypot(feet.x, feet.y)).toBeCloseTo(h / 2, 9)
      // A local point placed by `uprightLocal`, carried through the container's
      // transform (origin at the feet, rotated θ), lands at the screen offset asked.
      const want = { x: 0, y: -h / 2 - 6 }
      const local = uprightLocal(t, h, want.x, want.y)
      const r = rot(t, local.x, local.y)
      expect(feet.x + r.x).toBeCloseTo(want.x, 9)
      expect(feet.y + r.y).toBeCloseTo(want.y, 9)
      // The aim stays in screen space: a weapon drawn at `aim − θ` inside the rotated
      // container points at `aim` on screen (R107: controls stay screen-relative).
      const aim = 0.4
      const tip = rot(t, Math.cos(aim - t), Math.sin(aim - t))
      expect(tip.x).toBeCloseTo(Math.cos(aim), 9)
      expect(tip.y).toBeCloseTo(Math.sin(aim), 9)
      // And a thrust carried into the frame by `toLocal` comes back out as itself.
      const th = toLocal(t, 0, -1)
      const back = rot(t, th.x, th.y)
      expect(back.x).toBeCloseTo(0, 9)
      expect(back.y).toBeCloseTo(-1, 9)
    }
  })
})
