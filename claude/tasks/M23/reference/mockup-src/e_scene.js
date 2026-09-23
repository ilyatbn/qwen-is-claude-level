// The standard combat moment in style E, parameterised by a palette so E1/E2 share it.
import { buildMask, derive, groundAt, W, H } from './world.js'
import { fieldTextures } from './kit.js'
import { ARENA_E } from './maps.js'
import * as S from './e_style.js'

export function arenaE() { return derive(buildMask(ARENA_E), 'meadow') }

export function combat(P) {
  const world = arenaE()
  document.body.style.cssText = 'margin:0;position:relative;width:1280px;height:720px;overflow:hidden;background:#000'
  S.drawBackground(P.bg)
  const far = S.ctx2d()
  P.farDecor?.(far, world)
  const { field } = fieldTextures(world)
  S.drawTerrain(field, { ...P.terrain, scorch: ARENA_E.scorch })
  const g = S.ctx2d()
  const gy = (x, y0 = 200) => groundAt(world, x, y0)
  // turret on the left peak; enemy jetpacking over the valley; hero on the dip
  const tx = 548, ty = gy(tx, 250)
  const ex = 385, ey = 300
  const hx = 700, hy = gy(hx, 330)
  // tracers turret -> enemy
  const m0 = [tx - 19, ty - 20], tgt = [ex + 4, ey - 16]
  for (let k = 0; k < 4; k++) { const t0 = 0.12 + k * 0.21, t1 = t0 + 0.06; S.tracer(g, [m0[0] + (tgt[0] - m0[0]) * t1, m0[1] + (tgt[1] - m0[1]) * t1], [m0[0] + (tgt[0] - m0[0]) * t0, m0[1] + (tgt[1] - m0[1]) * t0], P.tracer) }
  S.turret(g, tx, ty, { face: -1, aim: 0.22, muzzle: true })
  // laser enemy -> turret
  const l0 = [ex + 16, ey - 26], l1 = [tx + 2, ty - 18]
  S.beam(g, l0, l1, P.laser, 1.4); S.glow(g, l1[0], l1[1], 22, P.laser, 0.9); S.glow(g, l0[0], l0[1], 8, P.laser, 0.9)
  S.stick(g, ex, ey, { aim: -0.33, weapon: 'laser', accent: P.teamB, jet: true, pose: 'jet' })
  // hero + rocket
  const rp = []; const sx = hx + 16, sy = hy - 33
  for (let i = 0; i <= 22; i++) { const t = i / 22; rp.push([sx + t * 200, sy - t * 120 + t * t * 30]) }
  S.smoke(g, rp.slice(0, -1), P.smoke)
  const [rx, ry] = rp[rp.length - 1], [qx, qy] = rp[rp.length - 3]
  S.rocket(g, rx, ry, Math.atan2(-(ry - qy), rx - qx))
  S.smoke(g, [[hx - 12, hy - 26], [hx - 18, hy - 24], [hx - 24, hy - 21]], { ...P.smoke, size: 5, grow: 1 })
  S.stick(g, hx, hy, { aim: 0.5, weapon: 'bazooka', accent: P.teamA, marker: P.teamA })
  // teammate on the right plateau with a flamethrower, facing the beetle
  const fx = 1215, fy = gy(fx, 420)
  S.halo(g, fx, fy - 18, 30, P.haloRGB, 0.2); S.stick(g, fx, fy, { face: -1, aim: -0.1, weapon: 'flamer', accent: P.teamA, flame: gg => { for (let i = 0; i < 7; i++) S.glow(gg, 15 + i * 4.5, 0.5 + (i % 2), 3 + i * 1.6, i < 3 ? '255,210,90' : '255,110,30', 0.85 - i * 0.08) } })
  // explosion in the crater
  S.explosion(g, 1115, 526, { s: 0.85, smokeRGB: P.plume })
  // gate, crystals
  const gx = 110; S.gate(g, gx, gy(gx, 250) + 1, { s: 1.35, accent: P.gateAccent, inner: P.gateInner })
  S.crystals(g, 250, gy(250, 250) + 2, { glowRGB: P.crystal })
  S.crystals(g, 1110, gy(1110, 200) + 2, { glowRGB: P.crystal, n: 4, seed: 11, s: 0.8 })
  // animals
  const bx = 990; S.halo(g, bx, gy(bx, 380) - 5, 20, P.haloRGB, 0.2); S.beetle(g, bx, gy(bx, 380) + 0.5, { rot: 0.45 })
  S.halo(g, 735, gy(735, 520) - 6, 26, P.haloRGB, 0.3); S.spider(g, 735, gy(735, 520) + 0.5, { face: -1, eye: P.eye })
  for (const [x, y, f, s] of [[610, 120, 0.2, 1], [640, 104, 0.8, 0.85], [668, 128, 0.5, 0.9], [890, 70, 0.1, 0.7]]) S.bird(g, x, y, { flap: f, s })
  P.overlay?.(g)
  S.grain(g, P.grain ?? 0.05)
  S.hudE(P.hud)
}
