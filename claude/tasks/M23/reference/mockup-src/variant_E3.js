// E3: space mode in style E. Dark sky above, a luminous nebula haze band below; giant
// stepped planet arcs dissolve into it. Figures switch to bone-white ink (max contrast rule).
import { buildMask, derive, groundAt, W, H } from './world.js'
import { fieldTextures } from './kit.js'
import { SPACE } from './maps.js'
import * as S from './e_style.js'
function ceilingAt(m, x, y0) { x = Math.round(x); for (let y = y0; y > 0; y--) if (m.solid[y * W + x]) return y; return 0 }

export default async function () {
  document.body.style.cssText = 'margin:0;position:relative;width:1280px;height:720px;overflow:hidden;background:#000'
  const world = derive(buildMask(SPACE), 'asteroid')
  S.drawBackground({ skyTop: 0x262533, skyBottom: 0xe8e2e4, haze: 0xece6e7, horizon: 600, stars: 0.005, grainK: 0.025, layers: [
    { shape: 'arc', x: 930, y: 70, r: 640, color: 0xb8aeb7, step: 6, soft: 3, fade: [330, 600, 0.0], jitter: 0.9 },
    { shape: 'arc', x: 260, y: 250, r: 260, color: 0x9b909c, step: 5, soft: 1.8, fade: [400, 600, 0.02], jitter: 0.7 },
    { shape: 'arc', x: 720, y: 540, r: 1100, color: 0x7e7380, step: 5, soft: 1.2, fade: [600, 720, 0.2], jitter: 0.5 },
  ] })
  S.ctx2d()
  const { field } = fieldTextures(world)
  S.drawTerrain(field, { top: 0x5a4a52, mid: 0x30262f, deep: 0x141016, haze: 0xece6e7, rim: 0xf0e2cf, rimK: 0.7, yK: 0.45, scorch: SPACE.scorch })
  const g = S.ctx2d()
  const A = '#d8432a', B = '#1fb5ad'
  const hx = 430, hy = groundAt(world, hx, 200)
  const ex = 700, ey = 330
  // enemy laser hits the rock by the hero
  const l0 = [ex - 16, ey - 20], l1 = [hx + 50, groundAt(world, hx + 50, 200) + 1]
  S.beam(g, l0, l1, '40,225,210', 1.4); S.glow(g, l1[0], l1[1], 26, '40,225,210', 0.9)
  for (let i = 0; i < 10; i++) { const a = -0.3 - i * 0.26, r = 8 + (i % 3) * 7; g.strokeStyle = 'rgba(160,255,245,0.9)'; g.lineWidth = 1; g.beginPath(); g.moveTo(l1[0], l1[1]); g.lineTo(l1[0] + Math.cos(a) * r, l1[1] + Math.sin(a) * r); g.stroke() }
  S.stick(g, ex, ey, { face: -1, rot: 0.3, aim: -0.2, weapon: 'laser', accent: B, jet: true, pose: 'jet' })
  // hero rocket toward the right asteroid
  const rp = []; const sx = hx + 18, sy = hy - 36
  for (let i = 0; i <= 22; i++) { const t = i / 22; rp.push([sx + t * 300, sy - t * 110]) }
  S.smoke(g, rp.slice(0, -1), { rgb: '90,80,100', a: 0.16, size: 5, grow: 1.4 })
  const [rx, ry] = rp[rp.length - 1]; S.rocket(g, rx, ry, Math.atan2(110, 300))
  S.stick(g, hx, hy, { aim: 0.45, weapon: 'bazooka', accent: A, marker: A })
  // turret on the right asteroid shooting at the enemy
  const tx = 1060, ty = groundAt(world, tx, 100)
  const m0 = [tx - 19, ty - 22], tg = [ex + 8, ey - 18]
  for (let k = 0; k < 4; k++) { const t0 = 0.12 + k * 0.2, t1 = t0 + 0.06; S.tracer(g, [m0[0] + (tg[0] - m0[0]) * t1, m0[1] + (tg[1] - m0[1]) * t1], [m0[0] + (tg[0] - m0[0]) * t0, m0[1] + (tg[1] - m0[1]) * t0]) }
  S.turret(g, tx, ty, { face: -1, aim: 0.3, muzzle: true })
  // explosion in the blast hole (space: little smoke)
  S.explosion(g, 900, 205, { s: 0.75, smokeRGB: '60,50,64' })
  // spider upside-down under the right asteroid; beetle on the small asteroid's flank
  const spx = 960, spy = ceilingAt(world, spx, 420); S.halo(g, spx, spy + 6, 22, '236,230,231', 0.3); S.spider(g, spx, spy - 0.5, { rot: Math.PI, eye: '#ff5030' })
  const bx = 1010, by = groundAt(world, bx, 480); S.halo(g, bx, by - 4, 20, '236,230,231', 0.25); S.beetle(g, bx, by + 0.5, { rot: 0.55 })
  const gx = 1100; S.gate(g, gx, groundAt(world, gx, 460) + 1, { s: 1.3, accent: '#ff9adf', inner: 'rgba(248,240,246,0.95)' })
  S.crystals(g, 250, groundAt(world, 250, 240) + 2, { glowRGB: '90,255,220' })
  S.crystals(g, 650, groundAt(world, 650, 100) + 2, { glowRGB: '255,190,80', n: 4, s: 0.7, seed: 9 })
  // teammate drifting in zero-g, far right
  S.stick(g, 1180, 360, { rot: -0.6, aim: 0.2, weapon: 'flamer', accent: A, jet: true, pose: 'jet', face: -1 })
  S.grain(g, 0.04)
  S.hudE({ timer: '1:12', accent: A, bottomLight: true, timerLight: true, centerDark: true })
}
