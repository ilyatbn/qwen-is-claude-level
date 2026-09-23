// F4: the cast at 3x in style F — each actor lit by its own weapon/effect plus a cool moon rim.
import * as THREE from 'three'
import { buildMask, derive, groundAt } from './world.js'
import { ribbon, explosion, sprite, softTex, wy } from './kit.js'
import * as S from './e_style.js'
import { frame, lit } from './f_kit.js'

export default async function () {
  const world = derive(buildMask({ ground: [[0, 606], [1280, 606]] }), 'dusk')
  const gy = x => groundAt(world, x, 450)
  const k = 3, s = 1.15 * k, A = '#e8482c', B = '#18c2b8'
  const P = [110, 290, 470, 690, 900, 1110]
  const L = (x, y, z, r, rgb, i) => ({ x, y, z, r, rgb, i })
  const lights = [
    L(P[0] - 40, gy(P[0]) - 70, 30, 160, '255,170,80', 1.6),
    L(380, gy(P[1]) - 70, 30, 170, '40,225,210', 2.4),
    L(P[2] + 110, gy(P[2]) - 60, 30, 240, '255,140,50', 2.6),
    L(P[3] - 12, 520 - 40, 20, 170, '255,140,50', 2.0),
    L(P[4] - 60, gy(P[4]) - 55, 30, 170, '255,200,110', 2.0),
    L(P[5], gy(P[5]) - 55, 30, 190, '240,190,90', 1.8),
    L(1090, 230, 60, 320, '255,140,50', 2.4), L(630, 230, 20, 140, '110,170,255', 1.6), L(880, 190, 20, 120, '255,140,50', 1.4),
  ]
  const moon = { dx: 0.6, dy: -0.8, rgb: '185,195,245', w: 0.75, fill: '90,80,110' }
  frame({
    world, lights, bloom: [0.55, 0.45, 0.72], grade: { vignette: 0.55 }, exposure: 1.15,
    bg: { skyTop: 0x07080f, skyBottom: 0x2e2636, haze: 0x3e3444, horizon: 600, stars: 0.003, grainK: 0.02, glowY: 600, glowColor: 0x1a1216, layers: [
      { shape: 'pyramid', x: 1040, y: 150, slope: 1.05, color: 0x2c2734, step: 6, soft: 2.5, fade: [300, 600, 0.5], jitter: 1.2 },
      { shape: 'pyramid', x: 980, y: 200, slope: 1.05, color: 0x1f1b27, step: 6, soft: 1.6, fade: [340, 600, 0.55], jitter: 1.0 },
    ] },
    terrain: { sunDir: [0.55, 0.62, 0.4], sunCol: [0.22, 0.26, 0.4], sky: [0.05, 0.06, 0.1], ground: [0.03, 0.02, 0.02], rimCol: [0.55, 0.62, 0.95], rimK: 0.5, lipK: 0.14, lipCol: [0.5, 0.55, 0.8], interior: 0.6, bevel: 14 },
    fogBack: { color: [0.16, 0.13, 0.17], y0: 420, y1: 600, k: 0.6 },
    draw2d: g => {
      const stick = (x, y, o, ex = {}) => lit(g, lights, moon, x, y, (gg, dx, dy, rc) => S.stick(gg, x + dx, y + dy, { ...o, s, accent: rc ?? o.accent, marker: rc ? false : o.marker, flame: rc ? null : o.flame }), { size: k, ...ex })
      const any = (x, y, fn, ex = {}) => lit(g, lights, moon, x, y, (gg, dx, dy, rc) => fn(gg, x + dx, y + dy, rc), ex)
      stick(P[0], gy(P[0]), { aim: 0.35, weapon: 'bazooka', accent: A, marker: A })
      stick(P[1], gy(P[1]), { aim: 0.05, weapon: 'laser', accent: B })
      stick(P[2], gy(P[2]), { aim: -0.05, weapon: 'flamer', accent: A, flame: gg => { for (let i = 0; i < 8; i++) S.glow(gg, 15 + i * 4.2, 0.5 + (i % 2) * 0.6, 2.5 + i * 1.4, i < 3 ? '255,215,100' : '255,110,30', 0.85 - i * 0.08) } })
      stick(P[3], 520, { aim: 0.25, weapon: 'laser', accent: B, jet: true, pose: 'jet' }, { shadow: false })
      any(P[4], gy(P[4]), (gg, x, y, rc) => S.turret(gg, x, y, { s: k, face: -1, aim: 0.25, muzzle: !rc }), { size: k })
      any(P[5], gy(P[5]), (gg, x, y, rc) => S.gate(gg, x, y, { s: k * 0.95, accent: rc ? 'rgba(0,0,0,0)' : '#f0c060', inner: rc ? 'rgba(0,0,0,0)' : 'rgba(40,30,44,0.9)' }), { size: k })
      const row = 250, halo = '120,120,170'
      any(110, row, (gg, x, y) => S.beetle(gg, x, y, { s: k }), { size: 2, halo, shadow: false })
      any(270, row, (gg, x, y) => S.spider(gg, x, y, { s: k }), { size: 2, halo, shadow: false })
      any(420, row - 40, (gg, x, y) => S.bird(gg, x, y, { s: k, flap: 0.15 }), { size: 1.5, shadow: false })
      any(500, row - 25, (gg, x, y) => S.bird(gg, x, y, { s: k * 0.8, flap: 0.85 }), { size: 1.2, shadow: false })
      any(630, row, (gg, x, y) => S.crystals(gg, x, y, { s: k * 0.8 }), { size: 2, shadow: false })
      S.smoke(g, Array.from({ length: 14 }, (_, i) => [740 + i * 10, row - 30 - i * 2]), { rgb: '130,120,130', a: 0.16, size: 9, grow: 1.5 })
      any(890, row - 58, (gg, x, y) => S.rocket(gg, x, y, 0.2, { s: 2.4 }), { size: 2, shadow: false })
      ;[[0.95, 1030], [0.3, 1120], [-0.45, 1210]].forEach(([aim, x]) => lit(g, lights, moon, x, 440, (gg, dx, dy, rc) => S.stick(gg, x + dx, 440 + dy, { s: 1.8, aim, weapon: 'bazooka', accent: rc ?? A }), { size: 1.8, shadow: false }))
      const label = (x, y, t) => { g.fillStyle = 'rgba(225,218,230,0.7)'; g.font = '12px Georgia, serif'; g.textAlign = 'center'; g.fillText(t.toUpperCase().split('').join(' '), x, y) }
      ;[['bazooka · you', P[0]], ['laser · enemy', P[1]], ['flamethrower', P[2]], ['jetpack', P[3]], ['gun platform', P[4]], ['gate', P[5]]].forEach(([t, x]) => label(x, 660, t))
      ;[['beetle', 110], ['spider', 270], ['birds', 460], ['crystals', 630], ['rocket', 830], ['explosion', 1090]].forEach(([t, x]) => label(x, row + 30, t))
      label(1120, 462, 'aim reads at a glance')
      g.fillStyle = 'rgba(225,218,230,0.75)'; g.font = 'italic 15px Georgia, serif'; g.textAlign = 'left'
      g.fillText('Cast at 3× — ink silhouettes, rim-lit by whatever is firing nearby; team colour only in the scarf and marker.', 30, 40)
    },
    fx3d: fx => {
      fx.add(ribbon([[P[1] + 15.5 * s, wy(gy(P[1]) - 21.5 * s)], [410, wy(gy(P[1]) - 21.5 * s - 3)]], 6, [1.2, 3.4, 3.6], [0.05, 0.5, 0.7], { z: 41, fadePow: 0.2, headBoost: 0 }))
      fx.add(sprite(softTex(), P[4] - 60, wy(gy(P[4]) - 52), 42, 40, new THREE.Color(2.5, 1.6, 0.6), 0.9, true))
      fx.add(ribbon([[750, wy(gy(P[4]) - 62)], [800, wy(gy(P[4]) - 58)]], 3, [4, 3, 1.4], [1.0, 0.45, 0.08], { z: 40, fadePow: 1.2 }))
      fx.add(sprite(softTex(), 870, wy(row0()), 43, 26, new THREE.Color(2.4, 1.2, 0.3), 0.9, true))
      fx.add(explosion(1090, wy(225), 0.45, { z: 50, smoke: 0x1a1418 }))
    },
  })
  function row0() { return 250 - 55 }
  S.setInk('#16110d')
}
