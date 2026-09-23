// E4: the cast sheet at 3x game scale.
import { W, H } from './world.js'
import * as S from './e_style.js'
export default async function () {
  document.body.style.cssText = 'margin:0;position:relative;width:1280px;height:720px;overflow:hidden;background:#000'
  S.drawBackground({ skyTop: 0xf1f0ee, skyBottom: 0xe9e6e1, haze: 0xebe7e2, horizon: 600, grainK: 0.02, layers: [
    { shape: 'pyramid', x: 1040, y: 150, slope: 1.05, color: 0xdcd7d1, step: 6, soft: 2.5, fade: [150, 590, 0.0], jitter: 1.2 },
    { shape: 'pyramid', x: 980, y: 200, slope: 1.05, color: 0xcfc8c1, step: 6, soft: 1.6, fade: [200, 595, 0.02], jitter: 1.0 },
  ] })
  const g = S.ctx2d()
  const gr = g.createLinearGradient(0, 600, 0, 720); gr.addColorStop(0, '#c68b52'); gr.addColorStop(0.5, '#9b5f33'); gr.addColorStop(1, '#3a2113')
  g.fillStyle = gr; g.fillRect(0, 600, W, 120)
  const k = 3, A = '#d8432a', B = '#139a93'
  const label = (x, y, t) => { g.fillStyle = 'rgba(42,32,25,0.75)'; g.font = '12px Georgia, serif'; g.textAlign = 'center'; g.fillText(t.toUpperCase().split('').join(' '), x, y) }
  const labelL = (x, y, t) => { g.fillStyle = 'rgba(240,232,220,0.85)'; g.font = '12px Georgia, serif'; g.textAlign = 'center'; g.fillText(t.toUpperCase().split('').join(' '), x, y) }
  const s = 1.15 * k
  S.stick(g, 110, 600, { s, aim: 0.35, weapon: 'bazooka', accent: A, marker: A }); labelL(110, 640, 'bazooka · you')
  S.stick(g, 280, 600, { s, aim: 0.05, weapon: 'laser', accent: B }); S.beam(g, [280 + 15.5 * s, 600 - 21.5 * s], [400, 600 - 21.5 * s - 3], '30,215,200', 1.6); labelL(280, 640, 'laser · enemy')
  S.stick(g, 470, 600, { s, aim: -0.05, weapon: 'flamer', accent: A, flame: gg => { for (let i = 0; i < 8; i++) S.glow(gg, 15 + i * 4.2, 0.5 + (i % 2) * 0.6, 2.5 + i * 1.4, i < 3 ? '255,215,100' : '255,110,30', 0.85 - i * 0.08) } }); labelL(470, 640, 'flamethrower')
  S.stick(g, 690, 520, { s, aim: 0.25, weapon: 'laser', accent: B, jet: true, pose: 'jet' }); labelL(690, 640, 'jetpack')
  S.turret(g, 900, 600, { s: k, face: -1, aim: 0.25, muzzle: true }); S.tracer(g, [760, 600 - 58], [800, 600 - 64]); labelL(900, 640, 'gun platform')
  S.gate(g, 1110, 600, { s: k * 0.95, accent: '#e6b451' }); labelL(1110, 640, 'gate')
  // top row: fauna + ordnance
  const row = 250
  S.beetle(g, 110, row, { s: k }); label(110, row + 30, 'beetle')
  S.spider(g, 270, row, { s: k }); label(270, row + 30, 'spider')
  S.bird(g, 420, row - 40, { s: k, flap: 0.15 }); S.bird(g, 500, row - 25, { s: k * 0.8, flap: 0.85 }); label(460, row + 30, 'birds')
  S.crystals(g, 630, row, { s: k * 0.8 }); label(630, row + 30, 'crystals')
  const rp = []; for (let i = 0; i <= 14; i++) rp.push([740 + i * 10, row - 30 - i * 2]); S.smoke(g, rp.slice(0, -1), { rgb: '92,78,66', a: 0.22, size: 9, grow: 1.5 }); S.rocket(g, 890, row - 58, 0.2, { s: 2.4 }); label(830, row + 30, 'rocket')
  S.explosion(g, 1090, row - 20, { s: 0.9, smokeRGB: '38,26,18' }); label(1090, row + 30, 'explosion')
  // aim read: one figure, three aims, ghosted
  ;[[0.95, 1030], [0.3, 1120], [-0.45, 1210]].forEach(([aim, x]) => S.stick(g, x, 440, { s: 1.8, aim, weapon: 'bazooka', accent: A }))
  label(1120, 462, 'aim reads at a glance')
  g.fillStyle = 'rgba(42,32,25,0.8)'; g.font = 'italic 15px Georgia, serif'; g.textAlign = 'left'
  g.fillText('Cast at 3× game scale — ink silhouettes; the team colour lives only in the scarf, the marker and your own shots.', 30, 40)
  S.grain(g, 0.04)
}
