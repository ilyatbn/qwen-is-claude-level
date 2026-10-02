// T23.20 control: F3's world without its cast — `variant_F3.js`'s `f_kit.js::frame` call with only the 2D actor
// canvas and the fx group taken out (the HUD, drawn after `frame`, too). The world look-gate-f3 compares the
// look-lab's `?look=F3&only=world` against: sky, back fog, the asteroid-lit terrain, bloom, grade.
// F3's lights stay — they light the rock (variant_F3.js's list, copied unchanged).
import { buildMask, derive, groundAt } from './world.js'
import { SPACE } from './maps.js'
import { frame } from './f_kit.js'

export function spaceWorld() {
  const world = derive(buildMask(SPACE), 'asteroid')
  const gy = (x, y0) => groundAt(world, x, y0)
  const hx = 430, hy = gy(hx, 200), ex = 700, ey = 330
  const l1 = [hx + 50, gy(hx + 50, 200) + 1]
  const tx = 1060, ty = gy(tx, 100), m0 = [tx - 22, ty - 24]
  const rp = []; const sx = hx + 18, sy = hy - 38
  for (let i = 0; i <= 22; i++) { const t = i / 22; rp.push([sx + t * 300, sy - t * 110]) }
  const [rx, ry] = rp[rp.length - 1]
  const gx = 1100, gyy = gy(gx, 460)
  const L = (x, y, z, r, rgb, i) => ({ x, y, z, r, rgb, i })
  const lights = [L(900, 205, 70, 420, '255,140,50', 3.0), L(l1[0], l1[1] - 4, 20, 170, '40,225,210', 2.4), L(m0[0], m0[1], 30, 120, '255,200,110', 1.8),
    L(ex + 4, ey - 4, 20, 100, '255,140,50', 1.3), L(rx - 8, ry, 20, 120, '255,140,50', 1.5), L(gx, gyy - 24, 30, 150, '255,120,220', 1.6),
    L(250, gy(250, 240) - 14, 20, 120, '90,255,220', 1.3), L(650, gy(650, 100) - 10, 20, 90, '255,190,80', 1.0), L(1180, 350, 20, 110, '255,140,50', 1.3)]
  frame({
    world, lights, bloom: [0.6, 0.45, 0.7], grade: { vignette: 0.6, sat: 1.05, cool: [0.88, 0.95, 1.15] }, exposure: 1.1,
    bg: { skyTop: 0x030408, skyBottom: 0x1e1830, haze: 0x2c2440, horizon: 620, stars: 0.006, grainK: 0.02, rays: [150, 60, 0.12, 700], rayColor: 0xc8d0ff, sun: { x: 150, y: 60, r: 8, k: 1, color: 0xffffff }, glowY: 620, glowColor: 0x201636, layers: [
      { shape: 'arc', x: 980, y: 130, r: 620, color: 0x1f1b2c, step: 6, soft: 3, fade: [360, 620, 0.5], jitter: 0.8 },
      { shape: 'arc', x: 240, y: 330, r: 260, color: 0x16131f, step: 5, soft: 1.8, fade: [440, 620, 0.5], jitter: 0.6 },
      { shape: 'arc', x: 720, y: 560, r: 1100, color: 0x0e0c14, step: 5, soft: 1.2, fade: [620, 720, 0.6], jitter: 0.5 },
    ] },
    terrain: { scorch: SPACE.scorch, sunDir: [-0.7, 0.55, 0.42], sunCol: [0.75, 0.78, 0.9], sky: [0.03, 0.03, 0.06], ground: [0.02, 0.015, 0.03], rimCol: [0.45, 0.55, 1.0], rimK: 0.5, lipK: 0.1, lipCol: [0.6, 0.65, 0.9], interior: 0.65, bevel: 14 },
    fogBack: { color: [0.1, 0.07, 0.16], y0: 420, y1: 640, k: 0.6, scale: 0.003 },
    draw2d: () => {},
  })
}
