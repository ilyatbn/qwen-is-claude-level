// T23.16 control: F6's arsenal as the look-lab draws it — `variant_F6.js` exactly (its world, lights, moon, sky,
// terrain, bloom, grade, exposure; every lit() weapon, the turret twice, the 1× row of figures holding each weapon),
// with only what the lab does not draw taken out: the text (names, the meteor note, the captions — T23.21) and every
// weapon's effect (FX: tracers, beams, muzzle glows, smoke, swing arcs, chips, the mine's arc — T23.18). What the
// remodelled weapons (T23.16/T23.17) are compared with, on F6's actor boxes, by `deltaE_actors` (`weapons-held`).
// Copy beside the mockup's modules with a variant that calls `weaponsOnly()` (see `weapons-held.mjs`).
import { buildMask, derive, groundAt, W } from './world.js'
import * as S from './e_style.js'
import { frame, lit } from './f_kit.js'
import { WEAPONS, WEAPON_ORDER, held } from './weapons.js'

const BUL = '255,176,32', LAS = '40,225,210', FIRE = '255,130,40', TOX = '125,255,70', SMK = '150,145,160', PALE = '200,210,240'
// `variant_F6.js::FX[k].c` — each weapon's light colour; the FX drawings themselves are left out.
const C = {
  bazooka: FIRE, grenade: FIRE, smg: BUL, laser_pistol: LAS, laser_smg: LAS, pistol: BUL, revolver: BUL, deagle: BUL, machinegun: BUL,
  knife: PALE, bat: PALE, whip: '255,235,170', axe: PALE, hammer: PALE, flamethrower: FIRE, mine: '255,50,40', airburst: FIRE, smoke: SMK,
  molotov: FIRE, toxic_grenade: TOX, shovel: PALE,
}

export function weaponsOnly() {
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
    L(m[0] + 10, m[1], 110, C[k], C[k] === PALE ? 0.6 : 1.8)
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
        } else {
          const Wd = WEAPONS[a.k]
          lit(g, lights, moon, a.cx, a.cy, (gg, dx, dy, rc) => { gg.save(); gg.translate(a.x0 + dx, a.y0 + dy); gg.scale(K, K); Wd.draw(gg, rc ?? '#e8482c'); gg.restore() }, { size: 1.5, shadow: false })
        }
      }
      const step = W / (keys.length + 0.5)
      keys.forEach((k, i) => {
        const x = step * (i + 0.75), y = groundAt(world, x, 600)
        if (k === 'platform_gun') { lit(g, lights, moon, x, y, (gg, dx, dy, rc) => S.turret(gg, x + dx, y + dy, { face: -1, aim: 0.2, muzzle: !rc })); return }
        const thrown = WEAPONS[k].thrown
        lit(g, lights, moon, x, y, (gg, dx, dy, rc) => S.stick(gg, x + dx, y + dy, { aim: thrown ? 0.9 : 0.12, weapon: held(k, rc ?? '#e8482c'), accent: rc ?? (i % 2 ? '#18c2b8' : '#e8482c') }))
      })
    },
  })
  S.setInk('#16110d')
}
