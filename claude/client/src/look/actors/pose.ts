/**
 * T23.14: the stick figure's animation — F7's poses (`reference/controls/posesonly.js`, from `variant_F7.js`),
 * chosen and blended from what the client already knows of a player (R3: nothing new on the wire): velocity,
 * aim, the alive/grounded/jetpack flags, the space flag and the thrust, the held item, boots and wings. Pure and
 * stepped per frame by `PlayerView`; the one state it keeps is animation state (the run phase, the scarf's lag,
 * the landing and action timers).
 *
 * **Feet plant, they do not slide.** The run phase advances with the distance the body covers — one radian per
 * `STRIDE_UNITS` figure units — which is the stance foot's own sweep under F7's leg curve at mid-stance, so the
 * planted foot keeps still against the ground while the body passes over it. On a slope each foot near the ground
 * is sent to the ground under it (`groundDy`) and the leg is solved two-bone IK (`reach`).
 */
import { SH, TH, type Pose } from './figure'
import { WEAPONS } from './weapons'
import { deriveAnimState, type AnimState } from '../../render/playerView-math'

type P = [number, number]

/**
 * The figure's size on screen: `e_style.js::stick`'s default scale, 1.15 — ~36 px tall at zoom 1 over the 28-px
 * hitbox (M23-RESEARCH § 4: "draw at ~1.2× the hitbox"). A render constant, not physics.
 */
export const FIGURE_SCALE = 1.15
/** F7's idle stance: thigh angle, knee bend per leg. */
export const STAND: [number, number][] = [[0.43, 0.25], [-0.27, 0.06]]
/** Figure units the body covers per radian of run phase: the stance foot's sweep at mid-stance (`(TH + SH) · 0.62`). */
export const STRIDE_UNITS = (TH + SH) * 0.62
/** The scarf's lag: the time constant it follows the body's motion with, s. */
export const SCARF_LAG_S = 0.15
/** Vertical speed that swings the scarf fully (F7's jump/fall), px/s. */
export const SCARF_VY_REF = 320
/** The landing crouch's length (F7 `land`), s — and melee swing, throw and hit reaction. */
export const LAND_S = 0.16
export const MELEE_S = 0.28
export const THROW_S = 0.3
export const HIT_S = 0.25
/** The aim a cell is drawn at is rounded to this (rad, ½°): finer than any aim a player can tell apart, coarse
 * enough that a still mouse is a still picture (a redraw per quantum, not per frame). T23.14D F13 measured a 1° quantum
 * in a 6-player match: redraws 1156 → 1137 in 5 s — a bot's aim moves more than a degree a frame — so it stays ½°. */
export const AIM_QUANTUM = Math.PI / 360
/**
 * T23.14B, the jet flame: its flicker — the flame's length varies by up to this fraction, from two incommensurate
 * waves at `FLICKER_HZ` — and the step its length is rounded to (a redraw per step, not per frame).
 */
export const FLICKER = 0.12
export const FLICKER_HZ: [number, number] = [7.3, 11.9]
export const JET_QUANTUM = 0.05
/** F7's flame length (`J.jet`) under the pack in standard gravity (`jet`) and in space (`space`) at full push. */
export const JET_LEN = 1.2
export const SPACE_JET_LEN = 1.6
/** The weakest push's flame, as a fraction of a full one (`thrustMax`). */
export const JET_MIN_FRACTION = 0.6
/**
 * Space: the time constant the body turns to put its pack behind the push with, s. Quick, because braking is quick:
 * the `thrusters` braking arm measured a drift of 138–147 px/s down to 46–75 px/s 83–252 ms (wall clock, page round
 * trips included) after LEFT went down, and at 0.08 s the flame was still swinging round for all of it — that arm
 * never once saw it turned (20 s, both renderers).
 */
export const SPACE_TURN_S = 0.035
/** The walker's step: how far ahead of the hip a foot lands (figure units), the stride being twice it. */
export const STEP_REACH = 5.5
/** A step's lift at full speed, figure units. */
const STEP_LIFT = 3
/** Standing, a foot this far (figure units) from its stance spot steps back to it. */
const SETTLE = 1.2
/**
 * T23.14D F6: a step taken at rest (settling back to the stance, or a stride the body stopped in the middle of) is
 * clocked by time, not by distance — the body covers none — and takes this long, s: a walking step's length at walk
 * speed (`2 · STEP_REACH · FIGURE_SCALE` px at 120 px/s ≈ 0.1 s), a little slower.
 */
export const SETTLE_STEP_S = 0.12
/**
 * T23.14D F13: a drawn leg's or arm's angle is rounded to this (rad), and the hip's height to `HIP_QUANTUM` (figure
 * units), so a figure whose pose barely moves is the same picture — and the same atlas cell — frame after frame. A
 * foot moves at most `(TH + SH) · LEG_QUANTUM / 2` units for it (0.07 units, 0.08 px at `FIGURE_SCALE`).
 */
export const LEG_QUANTUM = 0.01
export const HIP_QUANTUM = 0.05

/**
 * One of the walker's feet: planted at x, or stepping from `from` to `to` — as the body covers `span` px from `start`
 * (a stride), or over `SETTLE_STEP_S` (`t`, its progress 0…1: a step at rest) — lifted `lift` units at mid-step, set
 * when the step starts (a stride stopped half-way keeps its height rather than dropping with the speed).
 */
interface Foot {
  x: number
  step: { from: number; to: number; start: number; span: number; t: number | null; lift: number } | null
}

export type Action = 'melee' | 'throw' | 'hit'

export interface FigureInputs {
  dt: number
  vx: number
  vy: number
  /** Screen aim, radians (y down). */
  aim: number
  alive: boolean
  grounded: boolean
  jetpack: boolean
  space: boolean
  /**
   * The pack's push, px/s² — the one applied (the local player, `Core.thrustAt`) or estimated (a remote:
   * `push.ts::PushEstimate`, its acceleration less the pull) — or null: none known. Space turns the body against it;
   * its size sets the flame's length. T23.14D F4: velocity no longer stands in (braking drew an accelerating flame).
   */
  thrust: { x: number; y: number } | null
  weapon: string | null
  boots: boolean
  wings: boolean
  /**
   * The push that burns a full flame (px/s²; `Core.fullThrust`, the same number on every client — T23.14D F5); a
   * weaker `thrust` burns a shorter one, down to `JET_MIN_FRACTION`, which is also what a burn with no known push draws.
   */
  thrustMax: number
  /** Walk speed (the sim's `WALK_SPEED`): what "full stride" and the scarf's full trail are measured against. */
  walkSpeed: number
  /** The ground at world dx px from the feet (+ right), px relative to the feet line (+ down), or null (none near). */
  groundDy?: (dxPx: number) => number | null
  /** The feet's world x, px — where a planted foot is pinned (with `groundDy`). */
  x?: number
  s?: number
}

export interface FigureState {
  phase: number
  scarf: P
  wasGrounded: boolean
  landT: number
  action: { kind: Action; t: number } | null
  flapT: number
  /** Space: the turn the body is easing towards the push with, radians; and the flame's clock, s. */
  rot: number
  jetT: number
  /** The walker's feet (world px), null until it first walks on a ground. */
  feet: Foot[] | null
}

export const newFigureState = (): FigureState => ({ phase: 0, scarf: [0.35, 0.05], wasGrounded: true, landT: Infinity, action: null, flapT: 0, rot: 0, jetT: 0, feet: null })

export interface Drawn {
  J: Pose
  face: number
  /** Extra turn (space thrust), radians — the scene's tilt is added by the caller. */
  rot: number
  helmet: boolean
  /** The contact shadow is for grounded figures only (`lit()`'s shadow; F7 drops it for jump/jet/fall). */
  shadow: boolean
  /** T23.14D F8: the animation state the pose was chosen by (`deriveAnimState`, the one derivation). */
  state: AnimState
}

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const q = (v: number, k: number): number => Math.round(v / k) * k

/** F7's run leg at phase ph: thigh angle, knee bend. */
export const runLeg = (ph: number): [number, number] => [0.62 * Math.sin(ph), 0.12 + 1.15 * Math.max(0, Math.cos(ph))]

/** Two-bone IK: the thigh angle and knee bend that put the foot at `t` (from the hip), knee forward. */
export function reach(t: P): [number, number] {
  const d = clamp(Math.hypot(t[0], t[1]), Math.abs(TH - SH) + 1e-3, TH + SH - 1e-3)
  const theta = Math.atan2(t[0], t[1])
  const alpha = Math.acos(clamp((TH * TH + d * d - SH * SH) / (2 * TH * d), -1, 1))
  const a = theta + alpha
  const k: P = [Math.sin(a) * TH, Math.cos(a) * TH]
  const g = Math.atan2(t[0] - k[0], t[1] - k[1])
  return [a, a - g]
}

/** The run's leg blend at speed fraction k: stand ↔ F7's run leg (and its lean, 0.2·k). */
const blendLeg = (ph: number, k: number, i: number): [number, number] => {
  const r = runLeg(ph)
  return [STAND[i]![0] + (r[0] - STAND[i]![0]) * k, STAND[i]![1] + (r[1] - STAND[i]![1]) * k]
}
/** Foot position from the hip for thigh a, bend b. */
const footOf = (a: number, b: number): P => [Math.sin(a) * TH + Math.sin(a - b) * SH, Math.cos(a) * TH + Math.cos(a - b) * SH]

/** Start an action (a melee swing, a throw, a hit): it plays over the pose for its length. */
export function trigger(st: FigureState, kind: Action): void {
  st.action = { kind, t: 0 }
}

/** One frame: advance `st` by `inp` and return the pose to draw. */
export function stepFigure(st: FigureState, inp: FigureInputs): Drawn {
  const s = inp.s ?? FIGURE_SCALE
  const dirx = Math.cos(inp.aim)
  const face = dirx < 0 ? -1 : 1
  const aim = q(Math.atan2(-Math.sin(inp.aim), Math.abs(dirx)), AIM_QUANTUM)
  const forward = inp.vx * face
  const W = inp.weapon && WEAPONS[inp.weapon] ? inp.weapon : null
  // Timers.
  if (inp.grounded && !st.wasGrounded) st.landT = 0
  else st.landT += inp.dt
  st.wasGrounded = inp.grounded
  if (st.action) {
    st.action.t += inp.dt
    const len = st.action.kind === 'melee' ? MELEE_S : st.action.kind === 'throw' ? THROW_S : HIT_S
    if (st.action.t >= len) st.action = null
  }
  st.flapT += inp.dt
  st.jetT += inp.dt
  // The flame's length at full push, flickering (T23.14B): `jet(len)` for a pose that burns.
  const wob = 0.5 * (Math.sin(st.jetT * 2 * Math.PI * FLICKER_HZ[0]) + Math.sin(st.jetT * 2 * Math.PI * FLICKER_HZ[1] + 1.3))
  const strength = inp.thrust && inp.thrustMax > 0 ? clamp(Math.hypot(inp.thrust.x, inp.thrust.y) / inp.thrustMax, JET_MIN_FRACTION, 1) : JET_MIN_FRACTION
  const jet = (len: number): number => q(len * strength * (1 + FLICKER * wob), JET_QUANTUM)
  // The scarf follows the motion with a lag.
  const k = clamp(Math.abs(inp.vx) / inp.walkSpeed, 0, 1)
  // F7: idle [0.35, 0.05], run [1.3, 0.15], jump/jet y −1.1, fall 1.3.
  const want: P = [0.35 + 0.95 * k, clamp(0.05 + 0.1 * k + inp.vy / SCARF_VY_REF, -1.1, 1.3)]
  const f = 1 - Math.exp(-inp.dt / SCARF_LAG_S)
  st.scarf = [st.scarf[0] + (want[0] - st.scarf[0]) * f, st.scarf[1] + (want[1] - st.scarf[1]) * f]
  const scarf: P = [q(st.scarf[0], 0.02), q(st.scarf[1], 0.02)]
  const wings = inp.wings ? q(0.5 + 0.5 * Math.sin(st.flapT * (inp.grounded ? 2 : 9)), 0.05) : false
  const base = { weapon: W, aim, scarf, boots: inp.boots, wings } as const

  let J: Pose
  let rot = 0
  let helmet = inp.space
  // T23.20 (T23.14 review F7): the space pose is free flight's — a body standing or walking on an asteroid walks.
  const flying = inp.space && !inp.grounded
  if (!flying || !inp.alive) st.rot = 0
  let shadow = inp.grounded
  // T23.14D F8: the state is `deriveAnimState`'s — the table `PlayerView.state` reports — and the pose follows it.
  const state = deriveAnimState({ alive: inp.alive, grounded: inp.grounded, jetpack: inp.jetpack, vx: inp.vx, vy: inp.vy })
  const walking = inp.groundDy && inp.x !== undefined ? { x: inp.x, groundDy: inp.groundDy } : null
  // T23.14D F6: a figure off the ground has no planted feet: they are placed afresh at the stance where it lands.
  if (!walking || (state !== 'walk' && state !== 'idle')) st.feet = null
  if (state === 'dead') {
    J = { legs: [[0.25, -0.35], [0.6, 0.65]], arms: [[1.9, 0.7], [0.35, -0.5]], scarf: [0, -0.6], wave: 0.3, toe: [0.6, 1.4], boots: inp.boots, wings: false, weapon: null }
    rot = -1.5
    shadow = false
  } else if (flying) {
    // F7 `space`: the body leans along the push (its feet away from it); a coasting body floats upright.
    const push = inp.thrust
    const on = inp.jetpack && !!push && Math.hypot(push.x, push.y) > 1e-3
    J = { ...base, legs: [[0.06, 0.12], [-0.06, 0.05]], jet: on ? jet(SPACE_JET_LEN) : 0, scarf: on ? [0.7, 0.8] : scarf, wave: 2.8 }
    // The turn is applied in screen space before the facing flip (`figure`): the head leans into the push on screen
    // whichever way the figure faces (a figure aiming left while pushing right leans right). T23.14B: a whole turn —
    // the pack's flame is the thruster's exhaust and must point against the push whichever way it is (DOWN held puts
    // the flame above the body; T23.14 clamped the lean to ±1.3 rad, which left a DOWN burn's flame beside it). The
    // body eases round (`SPACE_TURN_S`) the short way; coasting, it floats back upright.
    const want = on && push ? Math.atan2(push.x, -push.y) : 0
    let d = want - st.rot
    d = Math.atan2(Math.sin(d), Math.cos(d))
    st.rot += d * (1 - Math.exp(-inp.dt / SPACE_TURN_S))
    st.rot = Math.atan2(Math.sin(st.rot), Math.cos(st.rot))
    rot = q(st.rot, 0.02)
    helmet = true
    shadow = false
  } else if (state === 'jetpack') {
    J = { ...base, legs: [[0.28, 0.5], [-0.12, 0.35]], jet: jet(JET_LEN), wave: 2 }
    shadow = false
  } else if (state === 'jump' || state === 'fall') {
    J = state === 'jump' ? { ...base, legs: [[1.25, 1.9], [0.55, 1.5]], lean: -0.05 } : { ...base, legs: [[0.7, -0.25], [-0.75, 0.45]], lean: -0.1, arms: W ? [] : [[2.7, 0.5]] }
    shadow = false
  } else if (st.landT < LAND_S && !walking) {
    J = { ...base, hipY: -8.4, legs: [[1.05, 1.95], [-0.15, 1.35]], lean: 0.38 }
  } else if (st.landT < LAND_S && walking) {
    // T23.14D F6: the landing crouch on the walker — F7's `land` hip (−8.4) and lean, rising back to the stand's over
    // `LAND_S`, the feet planted at the stance where the body landed and the knees solved to them (F7's fixed land legs
    // then a cut to the stand was a pop at both ends).
    const u = 1 - st.landT / LAND_S
    const stand: Pose = { ...base, legs: [blendLeg(0, 0, 0), blendLeg(Math.PI, 0, 1)], hipY: mix(-13, -8.4, u), lean: 0.38 * u, wave: 0.8 }
    J = walk(st, stand, walking.x, 0, face, s, 0, walking.groundDy, inp.dt)
  } else {
    // Stand ↔ run by speed. Without a ground (the tests' FK, a scene with no probe) F7's leg curve by phase; with one,
    // the stepping walker (`walk`): feet planted on the ground where they land, stepping ahead as the body passes.
    st.phase += (forward * inp.dt) / (s * STRIDE_UNITS)
    const ph = st.phase
    const legs: [number, number][] = [blendLeg(ph, k, 0), blendLeg(ph + Math.PI, k, 1)]
    J = { ...base, legs, lean: 0.2 * k, hipY: -13 + k * (0.55 * Math.abs(Math.cos(ph)) - 0.2), wave: k > 0 ? q(1.6 * Math.sin(ph * 2), 0.1) : 0.8 }
    if (!W) J.arms = [[-0.7 * Math.sin(ph) * k - 0.1, 1.1], [0.7 * Math.sin(ph) * k - 0.1, 1.1]]
    if (walking) J = walk(st, J, walking.x, inp.vx, face, s, k, walking.groundDy, inp.dt)
  }
  if (!W && !J.arms && inp.alive) J.arms = [[0.3, 0.5], [-0.2, 0.4]]
  // Actions play over the pose.
  const act = st.action
  if (act && inp.alive) {
    if (act.kind === 'melee') {
      J = { ...J, lean: 0.25, aim: q(mix(1.2, -0.95, clamp(act.t / MELEE_S, 0, 1)), 0.02), wave: 2 }
    } else if (act.kind === 'throw') {
      J = { ...J, lean: 0.18, weapon: null, arms: [[mix(-0.6, 2.35, clamp(act.t / THROW_S, 0, 1)), 0.25], [-0.9, 0.5]] }
    } else {
      J = { ...J, lean: -0.45, headDX: -0.6, aim: 1.0 }
    }
  }
  return { J: quantize({ ...J, helmet }), face, rot, helmet, shadow, state }
}

/** T23.14D F13: the pose's continuous angles and the hip rounded (`LEG_QUANTUM`, `HIP_QUANTUM`). */
function quantize(J: Pose): Pose {
  const qa = (l: [number, number][]): [number, number][] => l.map(([a, b]) => [q(a, LEG_QUANTUM), q(b, LEG_QUANTUM)])
  const out: Pose = { ...J, legs: qa(J.legs) }
  if (J.arms) out.arms = qa(J.arms)
  if (J.hipY !== undefined) out.hipY = q(J.hipY, HIP_QUANTUM)
  if (J.lean !== undefined) out.lean = q(J.lean, LEG_QUANTUM)
  return out
}


/** The stance spot of leg i, figure units ahead of the feet origin (F7's idle feet). */
const restX = (i: number): number => footOf(STAND[i]![0], STAND[i]![1])[0]

/**
 * The stepping walker. Each foot is planted at a world x — where it landed — and stays there: it cannot slide. When
 * the body has passed a planted foot by `STEP_REACH` and the other foot is down, that foot steps: it lifts and swings
 * to `STEP_REACH` ahead of the body, arriving as the body covers the same distance. Feet sit on the ground under them
 * (`groundDy`); the legs are solved by `reach` with the hip dropped where a foot is too far below to reach (a downhill
 * foot).
 *
 * T23.14D F6 — nothing teleports: standing, a foot away from its stance spot **steps** back to it (lifted, over
 * `SETTLE_STEP_S`), and a stride the body stops in the middle of finishes the same way from where the foot is; a foot
 * with no ground under it (a ledge's edge) **hangs** — the pose's own leg (`J.legs`, forward kinematics) — and is
 * pinned where it hangs, so it comes down where it is when ground is under it again.
 */
function walk(st: FigureState, J: Pose, x: number, vx: number, face: number, s: number, k: number, groundDy: (dxPx: number) => number | null, dt: number): Pose {
  const u = s // px per figure unit
  const lean = J.lean ?? 0
  const rest = (i: number): number => x + restX(i) * u * face
  if (!st.feet || st.feet.some((f) => Math.abs(f.x - x) > 4 * STEP_REACH * u)) {
    st.feet = [0, 1].map((i) => ({ x: rest(i), step: null }))
  }
  const feet = st.feet
  const dir = Math.sign(vx) || 0
  const moving = k > 0.05 && dir !== 0
  const progress = (f: Foot): number => (f.step ? (f.step.t ?? Math.min(1, Math.abs(x - f.step.start) / f.step.span)) : 0)
  // Advance steps in flight: a stride by the distance covered — or, the body stopped under it, by time from here.
  feet.forEach((f, i) => {
    const step = f.step
    if (!step) return
    if (step.t === null && !moving) {
      // The body stopped under a stride: the foot finishes as the second half of a step at rest from where it is (at
      // its height) to its stance spot — re-based to half-way, so it neither jumps nor lands on the stride's far end.
      const h = Math.sin(Math.PI * progress(f)) * step.lift
      const to = rest(i)
      f.step = { from: 2 * f.x - to, to, start: x, span: 1, t: 0.5, lift: h }
    } else if (step.t !== null) step.t = Math.min(1, step.t + dt / SETTLE_STEP_S)
    const p = progress(f)
    f.x = f.step!.from + (f.step!.to - f.step!.from) * p
    if (p >= 1) f.step = null
  })
  if (!feet.some((f) => f.step)) {
    if (moving) {
      // The foot furthest behind (in the travel direction) steps, once the body has passed it by STEP_REACH.
      const behind = feet.reduce((a, b) => ((a.x - x) * dir < (b.x - x) * dir ? a : b))
      if ((behind.x - x) * dir < -STEP_REACH * u) {
        const span = 2 * STEP_REACH * u
        behind.step = { from: behind.x, to: x + dir * (STEP_REACH * u + span), start: x, span, t: null, lift: STEP_LIFT * Math.max(k, 0.3) }
      }
    } else {
      // At rest: a foot off its stance spot steps back to it, one at a time.
      const i = feet.findIndex((f, j) => Math.abs(f.x - rest(j)) > SETTLE * u)
      if (i >= 0) feet[i]!.step = { from: feet[i]!.x, to: rest(i), start: x, span: 1, t: 0, lift: STEP_LIFT * 0.3 }
    }
  }
  let hy = J.hipY ?? -13
  const R = TH + SH - 0.25
  const targets = feet.map((f, i) => {
    const g = groundDy(f.x - x)
    if (g === null) {
      // No ground under it: the pose's own leg, and the foot pinned where that puts it.
      const [a, b] = J.legs[i]!
      f.x = x + footOf(a - lean, b)[0] * u * face
      f.step = null
      return null
    }
    const lift = f.step ? Math.sin(Math.PI * progress(f)) * f.step.lift : 0
    return [((f.x - x) * face) / u, g / u - lift] as P
  })
  for (const t of targets) if (t) hy = Math.max(hy, t[1] - Math.sqrt(Math.max(0, R * R - t[0] * t[0])))
  const legs = targets.map((t, i) => {
    if (!t) return J.legs[i]!
    const r = reach([t[0], t[1] - hy])
    return [r[0] + lean, r[1]] as [number, number]
  })
  return { ...J, legs, hipY: hy }
}
