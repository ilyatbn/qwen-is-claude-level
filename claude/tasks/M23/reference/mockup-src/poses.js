// Posable stick figure with EXACTLY F4's proportions and line weights (see e_style.stick):
// hip (0,-13), neck (0.8,-23.5), head (1.4,-27.8) r 3.7, shoulder (1.2,-21.5); thigh ~7, shin ~6.8;
// legs 2.3, body 3, arms 1.8. Units = figure units, feet at y = 0, facing +x.
import * as S from './e_style.js'
import { WEAPONS } from './weapons.js'

const TH = 7, SH = 6.8, UA = 5.2, FA = 5
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const dir = (ang, len) => [Math.sin(ang) * len, Math.cos(ang) * len]         // angle from straight down, + = forward
function line(g, pts, w) { g.strokeStyle = S.INK; g.lineWidth = w; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); g.moveTo(...pts[0]); for (const p of pts.slice(1)) g.lineTo(...p); g.stroke() }
function disc(g, x, y, r, c) { g.fillStyle = c ?? S.INK; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill() }

/** leg from hip by thigh angle a and knee bend b (radians) */
export const leg = (hip, a, b) => { const k = add(hip, dir(a, TH)); return [k, add(k, dir(a - b, SH))] }
/** arm from shoulder by upper-arm angle a and elbow bend b */
export const arm = (sh, a, b) => { const e = add(sh, dir(a, UA)); return [e, add(e, dir(a + b, FA))] }

/**
 * J: { lean, hipY, legs:[[a,b],[a,b]], arms:[[a,b],[a,b]] (free arms), weapon, aim, scarf:[vx,vy], jet, helmet, headTilt }
 * `accent` is the team colour, or the rim colour during a rim pass.
 */
export function figure(g, x, y, J, { s = 3.45, face = 1, rot = 0, accent = '#e8482c', rim = false, visor = null } = {}) {
  g.save(); g.translate(x, y); g.rotate(rot); g.scale(s * face, s)
  const hy = J.hipY ?? -13
  const hip = [0, hy]
  g.save(); g.translate(...hip); g.rotate(J.lean ?? 0); g.translate(-hip[0], -hip[1])
  const neck = [0.8, hy - 10.5], head = [1.4 + (J.headDX ?? 0), hy - 14.8 + (J.headDY ?? 0)], sh = [1.2, hy - 8.5]
  // scarf: trails against the motion vector, with a wave; it LAGS (drawn from where the neck was)
  const [vx, vy] = J.scarf ?? [0, 0]
  const e1 = [neck[0] - 4 - vx * 6, neck[1] + 5 - vy * 6 - (Math.abs(vx) + Math.abs(vy) > 0.2 ? 5 : 0)]
  const e2 = [neck[0] - 3 - vx * 5, neck[1] + 7 - vy * 5 - (Math.abs(vx) + Math.abs(vy) > 0.2 ? 3 : 0)]
  g.strokeStyle = accent; g.lineCap = 'round'
  g.lineWidth = 2.1; g.beginPath(); g.moveTo(neck[0] - 0.2, neck[1] + 0.5); g.quadraticCurveTo((neck[0] + e1[0]) / 2 + (J.wave ?? 1.5), (neck[1] + e1[1]) / 2 - 1.5, ...e1); g.stroke()
  g.lineWidth = 1.5; g.beginPath(); g.moveTo(neck[0] - 0.4, neck[1] + 0.9); g.quadraticCurveTo((neck[0] + e2[0]) / 2 - (J.wave ?? 1.5), (neck[1] + e2[1]) / 2 + 1, ...e2); g.stroke()
  // jetpack (+ plume when firing)
  g.fillStyle = S.INK; g.beginPath(); g.roundRect(-4.6, neck[1], 3.6, 8.5, 1.2); g.fill()
  if (J.jet && !rim) {
    const L = J.jet * 12, fy = neck[1] + 8.5
    const fl = g.createLinearGradient(0, fy, 0, fy + L)
    fl.addColorStop(0, 'rgba(255,245,200,1)'); fl.addColorStop(0.35, 'rgba(255,160,40,0.95)'); fl.addColorStop(1, 'rgba(230,70,20,0)')
    g.fillStyle = fl; g.beginPath(); g.moveTo(-4.4, fy); g.quadraticCurveTo(-2.8, fy + L * 0.7, -2.8, fy + L); g.quadraticCurveTo(-2.8, fy + L * 0.7, -1.2, fy); g.fill()
  }
  // legs
  for (const [a, b] of J.legs) { const [k, f] = leg(hip, a, b); line(g, [hip, k, f], 2.3); line(g, [f, add(f, J.toe ?? [1.8, 0])], 2.3) }
  // body + head (or helmet)
  line(g, [hip, neck], 3)
  if (J.helmet) {
    disc(g, head[0], head[1], 5.1)
    if (!rim) { g.fillStyle = visor ?? accent; g.globalAlpha = 0.85; g.beginPath(); g.ellipse(head[0] + 2.2, head[1] - 0.2, 2.4, 2.9, 0, -Math.PI / 2, Math.PI / 2); g.fill(); g.globalAlpha = 1; disc(g, head[0] + 3, head[1] - 1.6, 0.6, 'rgba(255,255,255,0.8)') }
  } else disc(g, head[0], head[1], 3.7)
  // free arms
  for (const [a, b] of J.arms ?? []) { const [e, hnd] = arm(sh, a, b); line(g, [sh, e, hnd], 1.8) }
  // weapon in the shoulder frame
  if (J.weapon) {
    const W = WEAPONS[J.weapon]
    g.save(); g.translate(...sh); g.rotate(-(J.aim ?? 0))
    W.draw(g, rim ? 'rgba(0,0,0,0)' : accent)
    const hand = (h, bend) => line(g, [[0, 0], [h[0] * 0.45, h[1] * 0.45 + bend], h], 1.8)
    hand(W.grips[0], 2.8); if (W.grips[1]) hand(W.grips[1], 2.2)
    g.restore()
  }
  g.restore(); g.restore()
}
