import { describe, expect, it } from 'vitest'
import {
  STAND_SNAP_PX,
  STAND_TURN_RATE,
  STAND_UPRIGHT_RATE,
  feetOffset,
  standTarget,
  stepTilt,
  toLocal,
  trackTilt,
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

  it('pivots where the box meets the rock, keeps the tag upright above it, and leaves screen directions alone', () => {
    // The fixture's box is `C()`-free on purpose (pure math); the scene passes PLAYER_W/H.
    const w = 16
    const h = 28
    // T22.19B F3: the feet stand on the box's own edge. Upright and feet-up are the
    // T22.19 spots exactly (half a height below / above the centre)…
    expect(feetOffset(0, w, h).x).toBeCloseTo(0, 9)
    expect(feetOffset(0, w, h).y).toBeCloseTo(h / 2, 9)
    expect(feetOffset(Math.PI, w, h).y).toBeCloseTo(-h / 2, 9)
    // …and a quarter turn puts them half a *width* out, on the flank — not half a height,
    // which sank them (h − w)/2 into the rock (the T22.19 pivot, the plant this rules out).
    const side = feetOffset(Math.PI / 2, w, h)
    expect(side.x).toBeCloseTo(-w / 2, 9)
    expect(side.y).toBeCloseTo(0, 9)
    expect(feetOffset(-Math.PI / 2, w, h).x).toBeCloseTo(w / 2, 9)
    for (let k = 0; k < 64; k++) {
      const t = -Math.PI + (k / 64) * 2 * Math.PI
      const feet = feetOffset(t, w, h)
      // On the box's outline, along the figure's down.
      const onEdge = Math.max(Math.abs(feet.x) / (w / 2), Math.abs(feet.y) / (h / 2))
      expect(onEdge).toBeCloseTo(1, 9)
      const down = rot(t, 0, 1)
      expect(feet.x * down.y - feet.y * down.x).toBeCloseTo(0, 9)
      expect(feet.x * down.x + feet.y * down.y).toBeGreaterThan(0)
      // Continuous: a small turn moves the feet a little.
      const next = feetOffset(t + 1e-3, w, h)
      expect(Math.hypot(next.x - feet.x, next.y - feet.y)).toBeLessThan(0.1)
    }
    for (const t of [0, 0.7, Math.PI / 2, Math.PI, -2.1]) {
      const feet = feetOffset(t, w, h)
      // A local point placed by `uprightLocal`, carried through the container's
      // transform (origin at the feet, rotated θ), lands at the screen offset asked.
      const want = { x: 0, y: -h / 2 - 6 }
      const local = uprightLocal(t, feet, want.x, want.y)
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

  it('snaps on first sight and on a relocation, and turns otherwise (T22.19B F5)', () => {
    const dt = 1 / 60
    // First sight (a new remote, one back in the sampled set, a new round): already standing.
    const first = trackTilt(null, 100, 100, 0, 0, Math.PI, dt)
    expect(Math.abs(first.theta)).toBeCloseTo(Math.PI, 9)
    expect(trackTilt(null, 100, 100, 0, 0, null, dt).theta).toBe(0)
    // Travel, however fast, turns: a body carried by its velocity is not relocated.
    const fast = trackTilt({ theta: 0, x: 0, y: 0 }, 900 * dt + 3, 0, 900, 0, Math.PI, dt)
    expect(fast.theta).toBeCloseTo(stepTilt(0, Math.PI, dt), 9)
    // Control for the snap: the same target a step away turns (not snapped)…
    const near = trackTilt({ theta: 0, x: 0, y: 0 }, STAND_SNAP_PX - 1, 0, 0, 0, Math.PI, dt)
    expect(near.theta).toBeCloseTo(stepTilt(0, Math.PI, dt), 9)
    expect(Math.abs(near.theta)).toBeLessThan(Math.PI / 2)
    // …and a pad, a vortex trip, a respawn — past `STAND_SNAP_PX` with no velocity to
    // carry it — lands already standing on the new rock, or upright in open space.
    const trip = trackTilt({ theta: 0, x: 0, y: 0 }, STAND_SNAP_PX + 1, 0, 0, 0, Math.PI, dt)
    expect(Math.abs(trip.theta)).toBeCloseTo(Math.PI, 9)
    const out = trackTilt({ theta: Math.PI, x: 0, y: 0 }, 0, 400, 0, 0, null, dt)
    expect(out.theta).toBe(0)
    // Hidden frames still step (the scene calls it for every body): a remote culled for
    // a second has turned all the way by the time it shows.
    let t: ReturnType<typeof trackTilt> = { theta: 0, x: 0, y: 0 }
    for (let i = 0; i < 60; i++) t = trackTilt(t, 0, 0, 0, 0, Math.PI, dt)
    expect(Math.abs(t.theta)).toBeGreaterThan(0.99 * Math.PI)
    expect(t.x).toBe(0)
  })
})
