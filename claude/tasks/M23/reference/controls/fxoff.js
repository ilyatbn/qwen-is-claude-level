// T23.18 control: f_scene.js::combatF exactly, with only its fx3d group (the tracers, the laser, the soft sprites,
// the explosion) taken out — the reference scene's world and cast without its effects. The look-lab's effects
// (`look/fx/`) are measured on the fx boxes where the lab without its effects (`&knob=fx-off`) already agrees with
// this picture (`look-fx`), so the cast's own known distance (T23.12's) is not counted as the effects'.
// Rendered with a variant_<id>nofx.js that is variant_<id>.js calling combatFxOff: F1-nofx.png.
// Style F combat moment (same composition as E / A), parameterised by palette P.
import * as THREE from 'three'
import { buildMask, derive, groundAt, H } from './world.js'
import { ARENA_E } from './maps.js'
import { ribbon, explosion, sprite, softTex, smokeTrail, wy } from './kit.js'
import * as S from './e_style.js'
import { frame, lit } from './f_kit.js'

export function combatFxOff(P) {
  const world = derive(buildMask(ARENA_E), P.theme)
  const gy = (x, y0 = 200) => groundAt(world, x, y0)
  const tx = 548, ty = gy(tx, 250), ex = 385, ey = 300, hx = 700, hy = gy(hx, 330), qx2 = 1215, qy2 = gy(qx2, 420)
  const gx = 110, gyy = gy(gx, 250)
  const m0 = [tx - 22, ty - 23], tgt = [ex + 4, ey - 18]
  const l0 = [ex + 18, ey - 30], l1 = [tx + 2, ty - 20]
  const rp = []; const sx = hx + 18, sy = hy - 38
  for (let i = 0; i <= 22; i++) { const t = i / 22; rp.push([sx + t * 200, sy - t * 120 + t * t * 30]) }
  const [rx, ry] = rp[rp.length - 1], [qx, qy] = rp[rp.length - 3]
  const L = (x, y, z, r, rgb, i) => ({ x, y, z, r, rgb, i })
  const lights = [
    L(1115, 515, 70, 460, P.fire, 3.2),          // explosion
    L(l1[0], l1[1], 30, 170, P.laser, 2.4),      // laser impact
    L(m0[0], m0[1], 30, 120, P.muzzle, 1.8),     // turret muzzle
    L(ex - 4, ey - 4, 20, 100, P.fire, 1.3),     // enemy jet plume
    L(rx - 8, ry, 20, 120, P.fire, 1.5),         // rocket motor
    L(qx2 - 34, qy2 - 26, 20, 150, P.fire, 2.0),   // teammate's flamethrower
    L(gx, gyy - 24, 30, 150, P.gate, 1.6),       // gate
    L(250, gy(250, 250) - 14, 20, 110, P.crystal, 1.2),
    L(1110, gy(1110, 200) - 12, 20, 100, P.crystal, 1.0),
    L(735, gy(735, 520) - 8, 8, 40, '255,60,30', 0.5),
  ]
  const moon = P.moon
  frame({
    world, bg: P.bg, lights, fogBack: P.fogBack, fogFront: P.fogFront, fg: P.fg, bloom: P.bloom, grade: P.grade, exposure: P.exposure,
    terrain: { scorch: ARENA_E.scorch, ...P.terrain },
    draw2d: g => {
      const stick = (x, y, o, extra = {}) => lit(g, lights, moon, x, y, (gg, dx, dy, rc) => S.stick(gg, x + dx, y + dy, { ...o, accent: rc ?? o.accent, marker: rc ? false : o.marker, flame: rc ? null : o.flame }), extra)
      const any = (x, y, fn, extra = {}) => lit(g, lights, moon, x, y, (gg, dx, dy, rc) => fn(gg, x + dx, y + dy, rc), extra)
      S.smoke(g, rp.slice(0, -1), P.smoke)
      any(tx, ty, (gg, x, y, rc) => S.turret(gg, x, y, { face: -1, aim: 0.22, muzzle: !rc }), { size: 1.2 })
      stick(ex, ey, { aim: -0.33, weapon: 'laser', accent: P.teamB, jet: true, pose: 'jet' }, { shadow: false })
      stick(hx, hy, { aim: 0.5, weapon: 'bazooka', accent: P.teamA, marker: P.teamA })
      stick(qx2, qy2, { face: -1, aim: -0.1, weapon: 'flamer', accent: P.teamA, flame: gg => { for (let i = 0; i < 7; i++) S.glow(gg, 15 + i * 4.5, 0.5 + (i % 2), 3 + i * 1.8, i < 3 ? '255,215,110' : '255,110,30', 0.9 - i * 0.08) } })
      any(rx, ry, (gg, x, y, rc) => S.rocket(gg, x, y, Math.atan2(-(ry - qy), rx - qx)), { shadow: false })
      any(gx, gyy + 1, (gg, x, y, rc) => S.gate(gg, x, y, { s: 1.35, accent: rc ? 'rgba(0,0,0,0)' : P.gateAccent, inner: rc ? 'rgba(0,0,0,0)' : P.gateInner }), { size: 1.4 })
      any(250, gy(250, 250) + 2, (gg, x, y, rc) => S.crystals(gg, x, y, { glowRGB: P.crystal }), { shadow: false })
      any(1110, gy(1110, 200) + 2, (gg, x, y, rc) => S.crystals(gg, x, y, { glowRGB: P.crystal, n: 4, seed: 11, s: 0.8 }), { shadow: false })
      any(990, gy(990, 380) + 0.5, (gg, x, y) => S.beetle(gg, x, y, { rot: 0.45 }), { size: 0.6 })
      any(735, gy(735, 520) + 0.5, (gg, x, y) => S.spider(gg, x, y, { face: -1, eye: '#ff4020' }), { size: 0.6, halo: P.halo })
      if (P.extra2d === 'embers') { let q = 3; const rnd = () => (q = (q * 16807) % 2147483647) / 2147483647; for (let i = 0; i < 90; i++) { const x = rnd() * 1280, y = 200 + rnd() * 520, r = 0.6 + rnd() * 1.4; S.glow(g, x, y, r * 4, '255,120,40', 0.5); g.fillStyle = 'rgba(255,200,120,0.9)'; g.fillRect(x, y, r, r) } }
      for (const [x, y, f, s] of [[610, 120, 0.2, 1], [640, 104, 0.8, 0.85], [668, 128, 0.5, 0.9], [890, 70, 0.1, 0.7]]) any(x, y, (gg, xx, yy) => S.bird(gg, xx, yy, { flap: f, s }), { shadow: false })
    },
  })
  S.setInk('#16110d')
  S.hudE({ timer: P.timer ?? '2:57', accent: P.teamA, dark: true, bottomLight: true, timerLight: true })
}
