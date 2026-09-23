// F6 — the remodelled arsenal at ~3x, each rim-lit by its own muzzle/effect, with its
// projectile signature; bottom row: every weapon held at 1x game scale.
import { buildMask, derive, groundAt, W } from './world.js'
import * as S from './e_style.js'
import { frame, lit } from './f_kit.js'
import { WEAPONS, WEAPON_ORDER, held } from './weapons.js'

const BUL = '255,176,32', LAS = '40,225,210', FIRE = '255,130,40', TOX = '125,255,70', SMK = '150,145,160', PALE = '200,210,240'
const FX = {
  bazooka: { c: FIRE, f: (g, m) => { const pts = Array.from({ length: 10 }, (_, i) => [m[0] + 10 + i * 5, m[1] - i * 1.2]); S.smoke(g, pts, { rgb: '140,130,140', a: 0.18, size: 3, grow: 1.2 }); S.rocket(g, m[0] + 64, m[1] - 13, 0.22, { s: 1.8 }) } },
  grenade: { c: FIRE, f: (g, m) => { g.fillStyle = 'rgba(220,210,230,0.5)'; for (let i = 1; i < 9; i++) { const t = i / 9; g.beginPath(); g.arc(m[0] + t * 60, m[1] - 30 * Math.sin(t * Math.PI) + t * 18, 0.9, 0, 7); g.fill() } S.glow(g, m[0] + 64, m[1] + 18, 18, FIRE, 0.8); S.glow(g, m[0] + 64, m[1] + 18, 7, '255,230,150', 1) } },
  smg: { c: BUL, f: (g, m) => { for (let k = 0; k < 3; k++) S.tracer(g, [m[0] + 10 + k * 20, m[1] - k * 1.5], [m[0] + 22 + k * 20, m[1] - k * 1.5 - 0.6], BUL); S.glow(g, m[0] + 2, m[1], 9, '255,210,120', 0.9) } },
  laser_pistol: { c: LAS, f: (g, m) => { S.beam(g, [m[0] + 8, m[1]], [m[0] + 30, m[1]], LAS, 1.2); S.glow(g, m[0] + 2, m[1], 8, LAS, 0.9) } },
  laser_smg: { c: LAS, f: (g, m) => { for (let k = 0; k < 3; k++) S.beam(g, [m[0] + 8 + k * 18, m[1] - k], [m[0] + 20 + k * 18, m[1] - k], LAS, 1); S.glow(g, m[0] + 2, m[1], 9, LAS, 0.9) } },
  pistol: { c: BUL, f: (g, m) => { S.tracer(g, [m[0] + 14, m[1]], [m[0] + 30, m[1]], BUL); S.glow(g, m[0] + 2, m[1], 7, '255,210,120', 0.9) } },
  revolver: { c: BUL, f: (g, m) => { S.beam(g, [m[0] + 12, m[1]], [m[0] + 34, m[1]], BUL, 1.5); S.glow(g, m[0] + 2, m[1], 10, '255,210,120', 0.95) } },
  deagle: { c: BUL, f: (g, m) => { S.beam(g, [m[0] + 14, m[1]], [m[0] + 42, m[1]], BUL, 2.1); S.glow(g, m[0] + 3, m[1], 16, '255,200,100', 1) } },
  machinegun: { c: BUL, f: (g, m) => { for (let k = 0; k < 4; k++) S.tracer(g, [m[0] + 8 + k * 16, m[1] + k * 0.5], [m[0] + 17 + k * 16, m[1] + k * 0.5], BUL); S.glow(g, m[0] + 2, m[1], 12, '255,210,120', 0.95); g.fillStyle = 'rgba(200,170,90,0.9)'; for (let k = 0; k < 3; k++) g.fillRect(m[0] - 40 - k * 5, m[1] - 10 + k * 7, 2, 1) } },
  knife: { c: PALE, f: (g, m) => swing(g, m, 22, -1.1, 0.9) },
  bat: { c: PALE, f: (g, m) => swing(g, m, 30, -1.3, 1.0) },
  whip: { c: '255,235,170', f: (g, m) => { for (let i = 0; i < 8; i++) { const a = i * 0.785; g.strokeStyle = 'rgba(255,240,190,0.9)'; g.lineWidth = 1; g.beginPath(); g.moveTo(m[0] + 3, m[1]); g.lineTo(m[0] + 3 + Math.cos(a) * 7, m[1] + Math.sin(a) * 7); g.stroke() } S.glow(g, m[0] + 3, m[1], 12, '255,235,170', 0.9) } },
  axe: { c: PALE, f: (g, m) => { swing(g, m, 30, -1.4, 1.1); chips(g, m[0] + 8, m[1] + 22) } },
  hammer: { c: PALE, f: (g, m) => { swing(g, m, 30, -1.4, 1.1); chips(g, m[0] + 8, m[1] + 22); S.glow(g, m[0] + 8, m[1] + 20, 12, '255,220,160', 0.6) } },
  flamethrower: { c: FIRE, f: (g, m) => { for (let i = 0; i < 9; i++) S.glow(g, m[0] + 4 + i * 6, m[1] + (i % 2) - i * 0.6, 3 + i * 2.2, i < 3 ? '255,215,110' : '255,110,30', 0.9 - i * 0.07) } },
  mine: { c: '255,50,40', f: (g, m) => { g.setLineDash([3, 4]); g.strokeStyle = 'rgba(255,90,70,0.45)'; g.lineWidth = 1; g.beginPath(); g.arc(m[0], m[1] + 8, 34, Math.PI * 1.05, Math.PI * 1.95); g.stroke(); g.setLineDash([]) } },
  airburst: { c: FIRE, f: (g, m) => { const bx = m[0] + 48, by = m[1] - 22; S.glow(g, bx, by, 10, '255,220,140', 1); for (let i = 0; i < 9; i++) { const a = 0.25 + i * 0.33; S.tracer(g, [bx + Math.cos(a) * 8, by + Math.sin(a) * 8], [bx + Math.cos(a) * 22, by + Math.sin(a) * 22], BUL) } } },
  smoke: { c: SMK, f: (g, m) => S.smoke(g, Array.from({ length: 9 }, (_, i) => [m[0] + 30 + (i % 3) * 10, m[1] - 6 - Math.floor(i / 3) * 8]), { rgb: SMK, a: 0.35, size: 9, grow: 0.8 }) },
  molotov: { c: FIRE, f: (g, m) => { for (let i = 0; i < 7; i++) { S.glow(g, m[0] + 30 + i * 7, m[1] + 30 - (i % 2) * 3, 5 + (i % 3) * 3, i % 2 ? '255,110,30' : '255,190,80', 0.9) } } },
  toxic_grenade: { c: TOX, f: (g, m) => { S.smoke(g, Array.from({ length: 8 }, (_, i) => [m[0] + 34 + (i % 4) * 9, m[1] - 4 - Math.floor(i / 4) * 9]), { rgb: '110,200,60', a: 0.35, size: 9, grow: 0.7 }); g.fillStyle = 'rgba(160,255,90,0.9)'; for (let i = 0; i < 4; i++) g.fillRect(m[0] + 36 + i * 8, m[1] + 14 + (i % 2) * 5, 1.2, 3) } },
  shovel: { c: PALE, f: (g, m) => { chips(g, m[0] + 14, m[1] - 2); chips(g, m[0] + 24, m[1] - 8) } },
}
function swing(g, m, r, a0, a1) { for (let k = 0; k < 5; k++) { g.strokeStyle = `rgba(215,225,250,${0.03 + k * 0.025})`; g.lineWidth = 4 - k * 0.6; g.beginPath(); g.arc(m[0] - r * 0.7, m[1] + 4, r + k * 1.5, a0 + k * 0.08, a1); g.stroke() } }
function chips(g, x, y) { g.fillStyle = S.INK; for (let i = 0; i < 6; i++) { g.save(); g.translate(x + (i - 3) * 4, y - (i % 3) * 5 - 3); g.rotate(i); g.fillRect(-1, -1, 2.2, 1.8); g.restore() } }

export default async function () {
  const world = derive(buildMask({ ground: [[0, 692], [1280, 692]] }), 'dusk')
  const K = 3.9 * 1.15, cols = 6, cw = W / cols
  const keys = [...WEAPON_ORDER, 'platform_gun']
  const cell = i => ({ cx: cw * (i % cols) + cw / 2 - 20, cy: 118 + Math.floor(i / cols) * 128 })
  const lights = [], L = (x, y, r, rgb, i) => lights.push({ x, y, z: 20, r, rgb, i })
  const anchors = keys.map((k, i) => {
    const { cx, cy } = cell(i)
    if (k === 'platform_gun') { L(cx - 40, cy - 22, 120, BUL, 1.8); return { k, cx, cy } }
    const Wd = WEAPONS[k], x0 = cx - Wd.cx * K, y0 = cy
    const m = [x0 + Wd.muzzle[0] * K, y0 + Wd.muzzle[1] * K]
    L(m[0] + 10, m[1], 110, FX[k].c, FX[k].c === PALE ? 0.6 : 1.8)
    return { k, cx, cy, x0, y0, m }
  })
  const moon = { dx: 0.6, dy: -0.8, rgb: '185,195,245', w: 0.75, fill: '90,80,110' }
  frame({
    world, lights, bloom: [0.5, 0.4, 0.75], grade: { vignette: 0.5 }, exposure: 1.15,
    bg: { skyTop: 0x07080f, skyBottom: 0x2a2432, haze: 0x3a3242, horizon: 690, stars: 0.003, grainK: 0.02, glowY: 690, glowColor: 0x1a1216, layers: [
      { shape: 'pyramid', x: 1080, y: 360, slope: 1.05, color: 0x221e2a, step: 6, soft: 2, fade: [450, 690, 0.5], jitter: 1.1 }] },
    terrain: { sunDir: [0.55, 0.62, 0.4], sunCol: [0.22, 0.26, 0.4], sky: [0.05, 0.06, 0.1], ground: [0.03, 0.02, 0.02], rimCol: [0.55, 0.62, 0.95], rimK: 0.5, lipK: 0.14, lipCol: [0.5, 0.55, 0.8], interior: 0.6, bevel: 12 },
    draw2d: g => {
      for (const a of anchors) {
        if (a.k === 'platform_gun') {
          lit(g, lights, moon, a.cx, a.cy + 26, (gg, dx, dy, rc) => S.turret(gg, a.cx + dx, a.cy + 26 + dy, { s: 2.4, face: -1, aim: 0.18, muzzle: !rc }), { size: 2.4 })
          for (let k = 0; k < 3; k++) S.tracer(g, [a.cx - 60 - k * 18, a.cy - 20 + k * 3], [a.cx - 50 - k * 18, a.cy - 22 + k * 3], BUL)
        } else {
          const Wd = WEAPONS[a.k]
          const pale = FX[a.k].c === PALE || a.k === 'whip'
          if (pale) FX[a.k].f(g, a.m)
          lit(g, lights, moon, a.cx, a.cy, (gg, dx, dy, rc) => { gg.save(); gg.translate(a.x0 + dx, a.y0 + dy); gg.scale(K, K); Wd.draw(gg, rc ?? '#e8482c'); gg.restore() }, { size: 1.5, shadow: false })
          if (!pale) FX[a.k].f(g, a.m)
        }
        g.fillStyle = 'rgba(225,218,230,0.72)'; g.font = '11px Georgia, serif'; g.textAlign = 'center'
        g.fillText(a.k.replace(/_/g, ' ').toUpperCase().split('').join(' '), a.cx + 20, a.cy + 48)
      }
      g.fillStyle = 'rgba(225,218,230,0.5)'; g.font = 'italic 13px Georgia, serif'; g.textAlign = 'left'
      g.fillText('meteor — skipped: a world event (meteor shower), never held.', 900, 505)
      // 1x game-scale row: every weapon in hand
      const step = W / (keys.length + 0.5)
      keys.forEach((k, i) => {
        const x = step * (i + 0.75), y = groundAt(world, x, 600)
        if (k === 'platform_gun') { lit(g, lights, moon, x, y, (gg, dx, dy, rc) => S.turret(gg, x + dx, y + dy, { face: -1, aim: 0.2, muzzle: !rc })); return }
        const thrown = WEAPONS[k].thrown
        lit(g, lights, moon, x, y, (gg, dx, dy, rc) => S.stick(gg, x + dx, y + dy, { aim: thrown ? 0.9 : 0.12, weapon: held(k, rc ?? '#e8482c'), accent: rc ?? (i % 2 ? '#18c2b8' : '#e8482c') }))
      })
      g.fillStyle = 'rgba(225,218,230,0.55)'; g.font = 'italic 12px Georgia, serif'; g.textAlign = 'left'; g.fillText('1× game scale', 14, 640)
      g.fillStyle = 'rgba(225,218,230,0.78)'; g.font = 'italic 15px Georgia, serif'; g.fillText('M23 arsenal at ~4.5× — ink silhouettes, rim-lit by their own muzzle or effect; the bottom row is every weapon in hand at 1×.', 24, 34)
    },
  })
  S.setInk('#16110d')
}
