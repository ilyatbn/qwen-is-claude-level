// T23.14 control: F7's pose sheet as the look-lab draws it — `variant_F7.js` exactly (its world, lights, moon, sky,
// terrain, bloom, grade, exposure, every lit() figure and the landing dust), with only what the lab does not draw
// taken out: the text (caption and labels — T23.21), the melee swing's arc, the throw's dotted arc and grenade, the
// hit spark and the dropped smg (effects and props — T23.17/T23.18). What the stick figure (T23.14) is compared
// with, on F7's actor boxes, by `deltaE_actors`. Knob 'rim-off': lit() without its two rim passes.
import { buildMask, derive, groundAt } from './world.js'
import * as S from './e_style.js'
import { frame, dominant, DARK_INK } from './f_kit.js'
import { figure } from './poses.js'

const A = '#e8482c', B = '#18c2b8', K = 3.45
const STAND = [[0.43, 0.25], [-0.27, 0.06]]
function run(i) {
  const f = i / 8 * Math.PI * 2, L = ph => [0.62 * Math.sin(ph), 0.12 + 1.15 * Math.max(0, Math.cos(ph))]
  return { lean: 0.2, hipY: -13 + 0.55 * Math.abs(Math.cos(f)) - 0.2, legs: [L(f), L(f + Math.PI)], weapon: 'pistol', aim: 0.02, arms: [[-0.7 * Math.sin(f) - 0.1, 1.1]], scarf: [1.3, 0.15], wave: 1.6 * Math.sin(f * 2) }
}
const P = {
  idle: { legs: STAND, weapon: 'smg', aim: -0.35, scarf: [0.35, 0.05], wave: 0.8 },
  jump: { legs: [[1.25, 1.9], [0.55, 1.5]], weapon: 'smg', aim: 0.3, scarf: [0.25, -1.1], lean: -0.05 },
  jet: { legs: [[0.28, 0.5], [-0.12, 0.35]], weapon: 'laser_smg', aim: 0.1, jet: 1.2, scarf: [0.3, -1.1], wave: 2 },
  space: { legs: [[0.06, 0.12], [-0.06, 0.05]], weapon: 'laser_pistol', aim: -0.7, jet: 1.6, helmet: true, scarf: [0.7, 0.8], wave: 2.8 },
  fall: { legs: [[0.7, -0.25], [-0.75, 0.45]], weapon: 'smg', aim: 0.9, arms: [[2.7, 0.5]], scarf: [0.1, 1.3], lean: -0.1 },
  land: { hipY: -8.4, legs: [[1.05, 1.95], [-0.15, 1.35]], lean: 0.38, weapon: 'smg', aim: -0.25, scarf: [0.4, 0.9] },
  melee: { legs: [[0.75, 0.5], [-0.55, 0.1]], lean: 0.25, weapon: 'bat', aim: -0.95, scarf: [1.1, 0.2], wave: 2 },
  throw: { legs: [[0.62, 0.3], [-0.48, 0.1]], lean: 0.18, arms: [[2.35, 0.25], [-0.9, 0.5]], scarf: [0.9, 0], wave: 1.8 },
  hit: { legs: [[0.35, 0.45], [-0.25, 0.2]], lean: -0.45, headDX: -0.6, weapon: 'smg', aim: 1.0, arms: [[1.6, 0.9]], scarf: [-1.5, -0.2], wave: -2 },
  dead: { legs: [[0.25, -0.35], [0.6, 0.65]], arms: [[1.9, 0.7], [0.35, -0.5]], scarf: [0, -0.6], wave: 0.3, toe: [0.6, 1.4] },
}

/** f_kit.js::lit, verbatim, with the two rim passes behind `rim` (castonly.js's). */
function litK(rim, g, lights, moon, x, y, draw, { size = 1, halo = null, shadow = true } = {}) {
  const L = dominant(lights, x, y - 14 * size, moon)
  if (halo) S.glow(g, x, y - 14 * size, 30 * size, halo, 0.22)
  if (shadow) { const gr = g.createRadialGradient(x, y, 0, x, y, 11 * size); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.save(); g.translate(x, y); g.scale(1, 0.25); g.translate(-x, -y); g.fillStyle = gr; g.beginPath(); g.arc(x, y, 11 * size, 0, 7); g.fill(); g.restore() }
  const a = Math.min(1, 0.45 + L.w * 0.5)
  const o = 1.15 * size
  if (rim) {
    S.setInk(`rgba(${L.rgb},${a * 0.35})`); draw(g, L.dx * o * 1.7, L.dy * o * 1.7, `rgba(${L.rgb},${a * 0.3})`)
    S.setInk(`rgba(${L.rgb},${a})`); draw(g, L.dx * o, L.dy * o, `rgba(${L.rgb},${a})`)
  }
  S.setInk(`rgba(${moon.fill},0.35)`); draw(g, -L.dx * 0.7 * size, -L.dy * 0.7 * size, `rgba(${moon.fill},0.35)`)
  S.setInk(DARK_INK); draw(g, 0, 0, null)
}

export function posesOnly(knob = null) {
  const rimOn = knob !== 'rim-off'
  const lit = (...a) => litK(rimOn, ...a)
  const world = derive(buildMask({ ground: [[0, 668], [1280, 668]], blobs: [{ x: 640, y: 236, rx: 1400, ry: 14, noise: 0.02 }, { x: 640, y: 462, rx: 1400, ry: 14, noise: 0.02 }] }), 'dusk')
  const gy = (x, y0) => groundAt(world, x, y0)
  const items = []
  const r1 = 150, r2 = 380, r3 = 610
  items.push([80, gy(80, r1), P.idle, { accent: A }])
  for (let i = 0; i < 8; i++) items.push([250 + i * 132, gy(250 + i * 132, r1), run(i), { accent: A }])
  items.push([90, gy(90, r2) - 44, P.jump, { accent: B }])
  items.push([290, gy(290, r2) - 60, P.jet, { accent: B }])
  items.push([500, gy(500, r2) - 40, P.space, { accent: B, rot: 0.95 }])
  items.push([700, gy(700, r2) - 60, P.fall, { accent: A }])
  items.push([880, gy(880, r2), P.land, { accent: A }])
  items.push([1080, gy(1080, r2), P.melee, { accent: A }])
  items.push([70, gy(70, r3), P.throw, { accent: B }])
  items.push([250, gy(250, r3), P.hit, { accent: B }])
  items.push([470, gy(470, r3), P.dead, { accent: A, rot: -1.5 }])
  const aims = [-80, -40, 0, 40, 80]
  aims.forEach((d, i) => items.push([640 + i * 140, gy(640 + i * 140, r3), { legs: STAND, weapon: 'smg', aim: d * Math.PI / 180, scarf: [0.35, 0.05], wave: 0.8 }, { accent: i % 2 ? B : A }]))
  const lights = [], L = (x, y, r, rgb, i) => lights.push({ x, y, z: 20, r, rgb, i })
  L(290 - 10, gy(290, r2) - 64, 120, '255,140,50', 1.8); L(500 - 45, gy(500, r2) - 52, 120, '255,140,50', 1.8)
  L(1140, gy(1080, r2) - 40, 120, '215,225,250', 1.0); L(240, gy(250, r3) - 72, 110, '255,220,160', 1.6)
  const moon = { dx: 0.6, dy: -0.8, rgb: '185,195,245', w: 0.75, fill: '90,80,110' }
  frame({
    world, lights, bloom: [0.5, 0.4, 0.75], grade: { vignette: 0.5 }, exposure: 1.15,
    bg: { skyTop: 0x07080f, skyBottom: 0x2a2432, haze: 0x3a3242, horizon: 668, stars: 0.003, grainK: 0.02, glowY: 668, glowColor: 0x1a1216, layers: [] },
    terrain: { sunDir: [0.55, 0.62, 0.4], sunCol: [0.22, 0.26, 0.4], sky: [0.05, 0.06, 0.1], ground: [0.03, 0.02, 0.02], rimCol: [0.55, 0.62, 0.95], rimK: 0.5, lipK: 0.16, lipCol: [0.5, 0.55, 0.8], interior: 0.6, bevel: 10 },
    draw2d: g => {
      S.smoke(g, [[862, gy(880, r2) - 2], [902, gy(880, r2) - 2], [882, gy(880, r2) - 4]], { rgb: '150,140,160', a: 0.3, size: 7, grow: 0.6 })
      for (const [x, y, J, o] of items) lit(g, lights, moon, x, y, (gg, dx, dy, rc) => figure(gg, x + dx, y + dy, J, { s: K, ...o, accent: rc ?? o.accent, rim: !!rc }), { size: 1.6, shadow: !o.rot && !(J.jet) && J !== P.jump && J !== P.fall })
    },
  })
  S.setInk('#16110d')
}
