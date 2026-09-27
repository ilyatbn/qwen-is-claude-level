// T23.08 control: a scene's world without its cast — f_kit.js::frame exactly (sky, back fog, lit terrain,
// front fog, the foreground's depth-of-field leaves, kit.js::post with P.bloom and P.grade at P.exposure)
// with only the 2D actor canvas and the fx group taken out. What the look-lab draws of F1 once T23.08's
// fog, foreground and post chain land, before the cast (T23.12+) and the effects (T23.18).
// The lights are f_scene.js::combatF's, copied unchanged from terrainonly.js.
// Knobs (the gate's must-fail controls through the mockup): 'bloom-off' (strength 0), 'fog-off'
// (fogBack = fogFront = null), 'exposure+10' / 'exposure-10' (P.exposure x 1.1 / x 0.9), 'fg-off', 'grade-off'.
import * as THREE from 'three'
import { buildMask, derive, groundAt } from './world.js'
import { ARENA_E } from './maps.js'
import { makeRenderer, orthoCam, fieldTextures, screenQuad, terrainMaterial, foregroundDoF, post } from './kit.js'
import { toLin, fog } from './f_kit.js'
import * as S from './e_style.js'

export function worldOnly(P, knob = null) {
  document.body.style.cssText = 'margin:0;position:relative;width:1280px;height:720px;overflow:hidden;background:#000'
  const world = derive(buildMask(ARENA_E), P.theme)
  const gy = (x, y0 = 200) => groundAt(world, x, y0)
  const tx = 548, ty = gy(tx, 250), ex = 385, ey = 300, hx = 700, hy = gy(hx, 330), qx2 = 1215, qy2 = gy(qx2, 420)
  const gx = 110, gyy = gy(gx, 250)
  const m0 = [tx - 22, ty - 23]
  const l1 = [tx + 2, ty - 20]
  const rp = []; const sx = hx + 18, sy = hy - 38
  for (let i = 0; i <= 22; i++) { const t = i / 22; rp.push([sx + t * 200, sy - t * 120 + t * t * 30]) }
  const [rx, ry] = rp[rp.length - 1]
  const L = (x, y, z, r, rgb, i) => ({ x, y, z, r, rgb, i })
  const lights = [
    L(1115, 515, 70, 460, P.fire, 3.2),
    L(l1[0], l1[1], 30, 170, P.laser, 2.4),
    L(m0[0], m0[1], 30, 120, P.muzzle, 1.8),
    L(ex - 4, ey - 4, 20, 100, P.fire, 1.3),
    L(rx - 8, ry, 20, 120, P.fire, 1.5),
    L(qx2 - 34, qy2 - 26, 20, 150, P.fire, 2.0),
    L(gx, gyy - 24, 30, 150, P.gate, 1.6),
    L(250, gy(250, 250) - 14, 20, 110, P.crystal, 1.2),
    L(1110, gy(1110, 200) - 12, 20, 100, P.crystal, 1.0),
    L(735, gy(735, 520) - 8, 8, 40, '255,60,30', 0.5),
  ]
  const exposure = P.exposure * (knob === 'exposure+10' ? 1.1 : knob === 'exposure-10' ? 0.9 : 1)
  const fogBack = knob === 'fog-off' ? null : P.fogBack
  const fogFront = knob === 'fog-off' ? null : P.fogFront
  const bloom = knob === 'bloom-off' ? [0, P.bloom[1], P.bloom[2]] : P.bloom
  const grade = knob === 'grade-off' ? { vignette: 0, sat: 1, warm: [1, 1, 1], cool: [1, 1, 1] } : P.grade
  // --- f_kit.js::frame, less the actor canvas and fx ---
  const r = makeRenderer(); r.toneMappingExposure = exposure
  const cam = orthoCam(), scene = new THREE.Scene()
  scene.add(S.bgQuad(P.bg))
  if (fogBack) scene.add(screenQuad(fog(fogBack), -10))
  const { field, albedo } = fieldTextures(world)
  const black = new THREE.WebGLRenderTarget(4, 4)
  scene.add(screenQuad(terrainMaterial({ field, albedo, occl: black.texture, lights: lights.map(l => ({ ...l, color: toLin(l.rgb) })), ...P.terrain }), 0))
  if (fogFront) scene.add(screenQuad(fog(fogFront), 10))
  if (P.fg && knob !== 'fg-off') { const q = screenQuad(foregroundDoF(P.fg), 900); q.renderOrder = 10; scene.add(q) }
  const comp = post(r, scene, cam, { bloom, grade })
  comp.render()
}
