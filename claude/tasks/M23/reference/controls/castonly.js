// T23.12 control: F4's cast sheet as the look-lab draws it — `variant_F4.js` exactly (its world, lights, moon,
// sky, fog, terrain, bloom, grade, exposure and every lit() actor call), with only what the lab does not draw
// taken out: the fx group (ribbons, sprites, the explosion — T23.18's) and the text (the caption and the
// labels — T23.21's HUD type). What the actor atlas (T23.12) and the rim-lit sprite shader (T23.13) are compared
// with, on F4's actor boxes (`client/src/look/scenes/actor-boxes.json`), by `deltaE_actors`.
// Knobs (R25: the actor box's must-fail set = R19's through the mockup, plus rim-off): 'rim-off' (lit() without
// its two rim passes; halo, shadow, the cool fill and the ink pass stay — as F1-rim-off.png), 'exposure+10' /
// 'exposure-10' (x 1.1 / x 0.9), 'bloom-off' (strength 0), 'fog-off' (fogBack = null). R19's F0 has no F4
// counterpart (today's look never drew a cast sheet). And 'world': no cast at all — the lab's F4 world against
// the mockup's, on the actor boxes (how much of a box's distance is the background's).
import * as THREE from 'three'
import { buildMask, derive, groundAt } from './world.js'
import { makeRenderer, orthoCam, fieldTextures, screenQuad, terrainMaterial, post } from './kit.js'
import { toLin, fog, dominant, DARK_INK } from './f_kit.js'
import * as S from './e_style.js'

/** f_kit.js::lit, verbatim, with the two rim passes behind `rim`. */
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

export function castOnly(knob = null) {
  document.body.style.cssText = 'margin:0;position:relative;width:1280px;height:720px;overflow:hidden;background:#000'
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
  const bloom0 = [0.55, 0.45, 0.72]
  const bloom = knob === 'bloom-off' ? [0, bloom0[1], bloom0[2]] : bloom0
  const exposure = 1.15 * (knob === 'exposure+10' ? 1.1 : knob === 'exposure-10' ? 0.9 : 1)
  const fogBack = knob === 'fog-off' ? null : { color: [0.16, 0.13, 0.17], y0: 420, y1: 600, k: 0.6 }
  const rim = knob !== 'rim-off'
  const lit = (...a) => litK(rim, ...a)
  const bg = { skyTop: 0x07080f, skyBottom: 0x2e2636, haze: 0x3e3444, horizon: 600, stars: 0.003, grainK: 0.02, glowY: 600, glowColor: 0x1a1216, layers: [
    { shape: 'pyramid', x: 1040, y: 150, slope: 1.05, color: 0x2c2734, step: 6, soft: 2.5, fade: [300, 600, 0.5], jitter: 1.2 },
    { shape: 'pyramid', x: 980, y: 200, slope: 1.05, color: 0x1f1b27, step: 6, soft: 1.6, fade: [340, 600, 0.55], jitter: 1.0 },
  ] }
  const terrain = { sunDir: [0.55, 0.62, 0.4], sunCol: [0.22, 0.26, 0.4], sky: [0.05, 0.06, 0.1], ground: [0.03, 0.02, 0.02], rimCol: [0.55, 0.62, 0.95], rimK: 0.5, lipK: 0.14, lipCol: [0.5, 0.55, 0.8], interior: 0.6, bevel: 14 }
  // --- f_kit.js::frame, less fx3d (and no fg: F4 has none) ---
  const r = makeRenderer(); r.toneMappingExposure = exposure
  const cam = orthoCam(), scene = new THREE.Scene()
  scene.add(S.bgQuad(bg))
  if (fogBack) scene.add(screenQuad(fog(fogBack), -10))
  const { field, albedo } = fieldTextures(world)
  const black = new THREE.WebGLRenderTarget(4, 4)
  scene.add(screenQuad(terrainMaterial({ field, albedo, occl: black.texture, lights: lights.map(l => ({ ...l, color: toLin(l.rgb) })), ...terrain }), 0))
  const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720
  const g = cv.getContext('2d'); g.lineCap = 'round'; g.lineJoin = 'round'
  // --- variant_F4.js's draw2d, less label() and the caption ---
  if (knob !== 'world') {
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
  }
  S.setInk('#16110d')
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
  const aq = screenQuad(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }), 20); scene.add(aq)
  const comp = post(r, scene, cam, { bloom, grade: { vignette: 0.55 } })
  comp.render()
}
