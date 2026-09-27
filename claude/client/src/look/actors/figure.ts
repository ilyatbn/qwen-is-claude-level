/**
 * T23.14: the posable stick figure — `tasks/M23/reference/mockup-src/poses.js::figure`, ported with its numbers
 * (F4's proportions and line weights: hip (0, −13), neck (0.8, −23.5), head r 3.7, shoulder (1.2, −21.5); thigh 7,
 * shin 6.8, upper arm 5.2, forearm 5; legs 2.3, body 3, arms 1.8). Units are figure units, feet at y = 0, facing +x.
 *
 * Added for the game, drawn in the same ink so the rim lights them (R8 — they are items, a player must see who has
 * them): **boots** (a heavy block round each foot) and **wings** (two swept feathers from the shoulder blades,
 * behind the body). Neither is in the mockup; both are marked where drawn.
 */
import { INK, disc, line, type G } from './draw'
import { WEAPONS } from './weapons'

type P = [number, number]

/** Thigh, shin, upper arm, forearm — `poses.js`. */
export const TH = 7
export const SH = 6.8
export const UA = 5.2
export const FA = 5

/** A pose (`poses.js`'s J): leg/arm angles are from straight down, + forward; bends are the knee's / elbow's. */
export interface Pose {
  lean?: number
  hipY?: number
  legs: [number, number][]
  arms?: [number, number][]
  weapon?: string | null
  aim?: number
  /** Scarf trail: the motion the scarf lags, figure units (−x back, −y up); `wave` its curl. */
  scarf?: [number, number]
  wave?: number
  jet?: number
  helmet?: boolean
  headDX?: number
  headDY?: number
  toe?: [number, number]
  /** T23.14: the game's items on the figure (not in the mockup). */
  boots?: boolean
  wings?: number | false
}

export interface FigureOpts {
  s?: number
  face?: number
  rot?: number
  accent?: string
  rim?: boolean
  visor?: string | null
}

const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]]
const dir = (ang: number, len: number): P => [Math.sin(ang) * len, Math.cos(ang) * len]

/** Knee and foot from the hip, thigh angle a and knee bend b. */
export const leg = (hip: P, a: number, b: number): [P, P] => {
  const k = add(hip, dir(a, TH))
  return [k, add(k, dir(a - b, SH))]
}
/** Elbow and hand from the shoulder, upper-arm angle a and elbow bend b. */
export const arm = (sh: P, a: number, b: number): [P, P] => {
  const e = add(sh, dir(a, UA))
  return [e, add(e, dir(a + b, FA))]
}

/** `poses.js::figure` at (x, y), feet there. */
export function figure(g: G, x: number, y: number, J: Pose, o: FigureOpts = {}): void {
  const { s = 3.45, face = 1, rot = 0, accent = '#e8482c', rim = false, visor = null } = o
  g.save()
  g.translate(x, y)
  g.rotate(rot)
  g.scale(s * face, s)
  const hy = J.hipY ?? -13
  const hip: P = [0, hy]
  g.save()
  g.translate(...hip)
  g.rotate(J.lean ?? 0)
  g.translate(-hip[0], -hip[1])
  const neck: P = [0.8, hy - 10.5]
  const head: P = [1.4 + (J.headDX ?? 0), hy - 14.8 + (J.headDY ?? 0)]
  const sh: P = [1.2, hy - 8.5]
  // T23.14 (not in the mockup): wings, behind everything but the scarf's far end.
  if (J.wings !== undefined && J.wings !== false) wings(g, neck, J.wings)
  const [vx, vy] = J.scarf ?? [0, 0]
  const kick = Math.abs(vx) + Math.abs(vy) > 0.2
  const e1: P = [neck[0] - 4 - vx * 6, neck[1] + 5 - vy * 6 - (kick ? 5 : 0)]
  const e2: P = [neck[0] - 3 - vx * 5, neck[1] + 7 - vy * 5 - (kick ? 3 : 0)]
  const wave = J.wave ?? 1.5
  g.strokeStyle = accent
  g.lineCap = 'round'
  g.lineWidth = 2.1
  g.beginPath()
  g.moveTo(neck[0] - 0.2, neck[1] + 0.5)
  g.quadraticCurveTo((neck[0] + e1[0]) / 2 + wave, (neck[1] + e1[1]) / 2 - 1.5, ...e1)
  g.stroke()
  g.lineWidth = 1.5
  g.beginPath()
  g.moveTo(neck[0] - 0.4, neck[1] + 0.9)
  g.quadraticCurveTo((neck[0] + e2[0]) / 2 - wave, (neck[1] + e2[1]) / 2 + 1, ...e2)
  g.stroke()
  g.fillStyle = INK
  g.beginPath()
  g.roundRect(-4.6, neck[1], 3.6, 8.5, 1.2)
  g.fill()
  if (J.jet && !rim) {
    const L = J.jet * FLAME_PER_JET
    const fy = hy - NOZZLE_UP
    const fl = g.createLinearGradient(0, fy, 0, fy + L)
    fl.addColorStop(0, 'rgba(255,245,200,1)')
    fl.addColorStop(0.35, 'rgba(255,160,40,0.95)')
    fl.addColorStop(1, 'rgba(230,70,20,0)')
    g.fillStyle = fl
    g.beginPath()
    g.moveTo(-4.4, fy)
    g.quadraticCurveTo(-2.8, fy + L * 0.7, -2.8, fy + L)
    g.quadraticCurveTo(-2.8, fy + L * 0.7, -1.2, fy)
    g.fill()
  }
  for (const [a, b] of J.legs) {
    const [k, f] = leg(hip, a, b)
    line(g, [hip, k, f], 2.3)
    line(g, [f, add(f, J.toe ?? [1.8, 0])], 2.3)
    // T23.14 (not in the mockup): an ironman boot — a heavy block round the foot, a cuff at the ankle.
    if (J.boots) boot(g, f, J.toe ?? [1.8, 0])
  }
  line(g, [hip, neck], 3)
  if (J.helmet) {
    disc(g, head[0], head[1], 5.1)
    if (!rim) {
      g.fillStyle = visor ?? accent
      g.globalAlpha = 0.85
      g.beginPath()
      g.ellipse(head[0] + 2.2, head[1] - 0.2, 2.4, 2.9, 0, -Math.PI / 2, Math.PI / 2)
      g.fill()
      g.globalAlpha = 1
      disc(g, head[0] + 3, head[1] - 1.6, 0.6, 'rgba(255,255,255,0.8)')
    }
  } else disc(g, head[0], head[1], 3.7)
  for (const [a, b] of J.arms ?? []) {
    const [e, hnd] = arm(sh, a, b)
    line(g, [sh, e, hnd], 1.8)
  }
  const W = J.weapon ? WEAPONS[J.weapon] : undefined
  if (W) {
    g.save()
    g.translate(...sh)
    g.rotate(-(J.aim ?? 0))
    W.draw(g, rim ? 'rgba(0,0,0,0)' : accent)
    const hand = (h: P, bend: number): void => line(g, [[0, 0], [h[0] * 0.45, h[1] * 0.45 + bend], h], 1.8)
    hand(W.grips[0]!, 2.8)
    if (W.grips[1]) hand(W.grips[1], 2.2)
    g.restore()
  }
  g.restore()
  g.restore()
}

/** `figure`'s jet flame: its length per unit of `J.jet`, and where it leaves the pack (x; y is `hipY − 2`). */
export const FLAME_PER_JET = 12
const NOZZLE_X = -2.8
const NOZZLE_UP = 2

/**
 * T23.14B: the jet flame's axis as `figure` draws it — nozzle and tip, px from the feet, after the pose's lean (about
 * the hip), the scale, the facing flip and the turn — or null without a flame. Where the flame's glow and light go.
 */
export function flameAxis(J: Pose, o: { s: number; face: number; rot: number }): { base: P; tip: P } | null {
  if (!J.jet) return null
  const hy = J.hipY ?? -13
  const lean = J.lean ?? 0
  const at = (u: number): P => {
    // Figure units, then the lean about the hip, then scale/flip, then the turn (`figure`'s transform order, inverted).
    const p: P = [NOZZLE_X, hy - NOZZLE_UP + u * FLAME_PER_JET * (J.jet ?? 0)]
    const dx = p[0]
    const dy = p[1] - hy
    const l: P = [dx * Math.cos(lean) - dy * Math.sin(lean), hy + dx * Math.sin(lean) + dy * Math.cos(lean)]
    const q: P = [l[0] * o.s * o.face, l[1] * o.s]
    return [q[0] * Math.cos(o.rot) - q[1] * Math.sin(o.rot), q[0] * Math.sin(o.rot) + q[1] * Math.cos(o.rot)]
  }
  return { base: at(0), tip: at(1) }
}

/** T23.14: the ironman boot, figure units — heel to toe along the foot, 2.6 tall, a cuff line above. */
function boot(g: G, f: P, toe: P): void {
  const ang = Math.atan2(toe[1], toe[0])
  g.save()
  g.translate(...f)
  g.rotate(ang)
  g.fillStyle = INK
  g.beginPath()
  g.roundRect(-1.4, -2.4, 4.8, 3.1, 0.9)
  g.fill()
  line(g, [[-1.6, -3.1], [1.6, -3.1]], 1.4)
  g.restore()
}

/** T23.14: unicorn wings — two swept feathers from the shoulder blades; `flap` 0 folded … 1 spread. */
function wings(g: G, neck: P, flap: number): void {
  const root: P = [neck[0] - 2.2, neck[1] + 2.4]
  // Longer than a leg (a thigh + shin is 13.8): at the game's 1.15 scale a wing any smaller hid behind the scarf
  // and the pack (looked at: shots/wings-after.png, T23.14's first cut at 11/9).
  for (const [lift, len] of [[0.3, 17], [-0.1, 13]] as [number, number][]) {
    const a = -Math.PI / 2 - 0.45 - (lift + flap * 0.6)
    const tip: P = [root[0] + Math.cos(a) * len, root[1] + Math.sin(a) * len * 0.85]
    const back: P = [root[0] + Math.cos(a + 0.6) * len * 0.6, root[1] + Math.sin(a + 0.6) * len * 0.5 + 3]
    g.fillStyle = INK
    g.beginPath()
    g.moveTo(...root)
    g.quadraticCurveTo(root[0] + (tip[0] - root[0]) * 0.4, tip[1] - 1.5, ...tip)
    g.quadraticCurveTo(back[0], back[1], root[0] + 0.4, root[1] + 2.2)
    g.closePath()
    g.fill()
  }
}
