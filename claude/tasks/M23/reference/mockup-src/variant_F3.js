// F3: space mode in style F — dark, a distant star behind the planet limbs (god rays), effects as key lights.
import * as THREE from 'three'
import { buildMask, derive, groundAt, W } from './world.js'
import { SPACE } from './maps.js'
import { ribbon, explosion, sprite, softTex, wy } from './kit.js'
import * as S from './e_style.js'
import { frame, lit } from './f_kit.js'
function ceilingAt(m, x, y0) { x = Math.round(x); for (let y = y0; y > 0; y--) if (m.solid[y * W + x]) return y; return 0 }

export default async function () {
  const world = derive(buildMask(SPACE), 'asteroid')
  const gy = (x, y0) => groundAt(world, x, y0)
  const A = '#e8482c', B = '#18c2b8'
  const hx = 430, hy = gy(hx, 200), ex = 700, ey = 330
  const l0 = [ex - 17, ey - 22], l1 = [hx + 50, gy(hx + 50, 200) + 1]
  const tx = 1060, ty = gy(tx, 100), m0 = [tx - 22, ty - 24], tg = [ex + 8, ey - 18]
  const rp = []; const sx = hx + 18, sy = hy - 38
  for (let i = 0; i <= 22; i++) { const t = i / 22; rp.push([sx + t * 300, sy - t * 110]) }
  const [rx, ry] = rp[rp.length - 1]
  const spx = 960, spy = ceilingAt(world, spx, 420), bx = 1010, by = gy(bx, 480), gx = 1100, gyy = gy(gx, 460)
  const L = (x, y, z, r, rgb, i) => ({ x, y, z, r, rgb, i })
  const lights = [L(900, 205, 70, 420, '255,140,50', 3.0), L(l1[0], l1[1] - 4, 20, 170, '40,225,210', 2.4), L(m0[0], m0[1], 30, 120, '255,200,110', 1.8),
    L(ex + 4, ey - 4, 20, 100, '255,140,50', 1.3), L(rx - 8, ry, 20, 120, '255,140,50', 1.5), L(gx, gyy - 24, 30, 150, '255,120,220', 1.6),
    L(250, gy(250, 240) - 14, 20, 120, '90,255,220', 1.3), L(650, gy(650, 100) - 10, 20, 90, '255,190,80', 1.0), L(1180, 350, 20, 110, '255,140,50', 1.3)]
  const moon = { dx: -0.75, dy: -0.65, rgb: '215,225,255', w: 0.8, fill: '70,60,110' }
  frame({
    world, lights, bloom: [0.6, 0.45, 0.7], grade: { vignette: 0.6, sat: 1.05, cool: [0.88, 0.95, 1.15] }, exposure: 1.1,
    bg: { skyTop: 0x030408, skyBottom: 0x1e1830, haze: 0x2c2440, horizon: 620, stars: 0.006, grainK: 0.02, rays: [150, 60, 0.12, 700], rayColor: 0xc8d0ff, sun: { x: 150, y: 60, r: 8, k: 1, color: 0xffffff }, glowY: 620, glowColor: 0x201636, layers: [
      { shape: 'arc', x: 980, y: 130, r: 620, color: 0x1f1b2c, step: 6, soft: 3, fade: [360, 620, 0.5], jitter: 0.8 },
      { shape: 'arc', x: 240, y: 330, r: 260, color: 0x16131f, step: 5, soft: 1.8, fade: [440, 620, 0.5], jitter: 0.6 },
      { shape: 'arc', x: 720, y: 560, r: 1100, color: 0x0e0c14, step: 5, soft: 1.2, fade: [620, 720, 0.6], jitter: 0.5 },
    ] },
    terrain: { scorch: SPACE.scorch, sunDir: [-0.7, 0.55, 0.42], sunCol: [0.75, 0.78, 0.9], sky: [0.03, 0.03, 0.06], ground: [0.02, 0.015, 0.03], rimCol: [0.45, 0.55, 1.0], rimK: 0.5, lipK: 0.1, lipCol: [0.6, 0.65, 0.9], interior: 0.65, bevel: 14 },
    fogBack: { color: [0.1, 0.07, 0.16], y0: 420, y1: 640, k: 0.6, scale: 0.003 },
    draw2d: g => {
      const stick = (x, y, o, extra = {}) => lit(g, lights, moon, x, y, (gg, dx, dy, rc) => S.stick(gg, x + dx, y + dy, { ...o, accent: rc ?? o.accent, marker: rc ? false : o.marker }), extra)
      const any = (x, y, fn, extra = {}) => lit(g, lights, moon, x, y, (gg, dx, dy, rc) => fn(gg, x + dx, y + dy, rc), extra)
      S.smoke(g, rp.slice(0, -1), { rgb: '120,110,140', a: 0.12, size: 5, grow: 1.4 })
      stick(ex, ey, { face: -1, rot: 0.3, aim: -0.2, weapon: 'laser', accent: B, jet: true, pose: 'jet' }, { shadow: false })
      stick(hx, hy, { aim: 0.45, weapon: 'bazooka', accent: A, marker: A })
      stick(1180, 360, { rot: -0.6, aim: 0.2, weapon: 'flamer', accent: A, jet: true, pose: 'jet', face: -1 }, { shadow: false })
      any(rx, ry, (gg, x, y) => S.rocket(gg, x, y, Math.atan2(110, 300)), { shadow: false })
      any(tx, ty, (gg, x, y, rc) => S.turret(gg, x, y, { face: -1, aim: 0.3, muzzle: !rc }), { size: 1.2 })
      any(spx, spy - 0.5, (gg, x, y) => S.spider(gg, x, y, { rot: Math.PI, eye: '#ff5030' }), { shadow: false, halo: '110,120,190', size: 0.6 })
      any(bx, by + 0.5, (gg, x, y) => S.beetle(gg, x, y, { rot: 0.55 }), { size: 0.6, halo: '110,120,190' })
      any(gx, gyy + 1, (gg, x, y, rc) => S.gate(gg, x, y, { s: 1.3, accent: rc ? 'rgba(0,0,0,0)' : '#ff9adf', inner: rc ? 'rgba(0,0,0,0)' : 'rgba(40,20,50,0.9)' }), { size: 1.4 })
      any(250, gy(250, 240) + 2, (gg, x, y) => S.crystals(gg, x, y, { glowRGB: '90,255,220' }), { shadow: false })
      any(650, gy(650, 100) + 2, (gg, x, y) => S.crystals(gg, x, y, { glowRGB: '255,190,80', n: 4, s: 0.7, seed: 9 }), { shadow: false })
    },
    fx3d: fx => {
      for (let k = 0; k < 4; k++) { const t0 = 0.12 + k * 0.2, t1 = t0 + 0.07, P0 = t => [m0[0] + (tg[0] - m0[0]) * t, wy(m0[1] + (tg[1] - m0[1]) * t)]; fx.add(ribbon([P0(t1), P0(t0)], 3, [4, 3, 1.4], [1.0, 0.45, 0.08], { z: 40, fadePow: 1.2 })) }
      fx.add(sprite(softTex(), m0[0], wy(m0[1]), 42, 34, new THREE.Color(2.5, 1.6, 0.6), 0.9, true))
      fx.add(ribbon([[l0[0], wy(l0[1])], [l1[0], wy(l1[1])]], 6, [1.2, 3.4, 3.6], [0.05, 0.5, 0.7], { z: 41, fadePow: 0.2, headBoost: 0 }))
      fx.add(sprite(softTex(), l1[0], wy(l1[1]), 43, 50, new THREE.Color(0.4, 1.6, 2.0), 1, true))
      fx.add(sprite(softTex(), rx - 8, wy(ry), 43, 16, new THREE.Color(2.4, 1.2, 0.3), 0.9, true))
      fx.add(explosion(900, wy(205), 0.5, { z: 50, smoke: 0x14121c }))
    },
  })
  S.setInk('#16110d')
  S.hudE({ timer: '1:12', accent: A, dark: true, bottomLight: true, timerLight: true })
}
