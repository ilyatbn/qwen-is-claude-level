// T23.07 control: a scene's sky and lit terrain alone — f_kit.js::frame with its actors, fx, fog,
// foreground, bloom and grade taken out — through the post chain the game's world renderer has
// today (half-float 4x MSAA target -> RenderPass -> OutputPass, ACES at P.exposure): kit.js::post
// without its bloom and grade passes (T23.08 adds those, and the fog). The terrain is
// kit.js::terrainMaterial exactly as frame() builds it — world.js::derive(buildMask(ARENA_E)) fields
// and albedo, the 4x4 black `occl`, and the scene's ten point lights computed by f_scene.js::combatF's
// own lines (copied below, unchanged) — so the lights are the mockup's, not the look-lab's port of them.
//
// Knobs (the must-fail controls, `terrainOnly(P, knob)`): 'rim-off' sets rimK 0, 'bevel-off' sets
// bevel 0.001 (a flat face: the bevel's height and its normals vanish), 'lights-off' drops the lights.
// Recipe: the scratch mockup harness of look-thresholds.json's `recipe`, this file under src/, one
// variant_*.js per knob calling terrainOnly(P_F1, knob); then `node render.mjs <variants>` under nice.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { W, H, buildMask, derive, groundAt } from './world.js'
import { ARENA_E } from './maps.js'
import { makeRenderer, orthoCam, fieldTextures, screenQuad, terrainMaterial } from './kit.js'
import { toLin } from './f_kit.js'
import * as S from './e_style.js'

export function terrainOnly(P, knob = null) {
  document.body.style.cssText = 'margin:0;position:relative;width:1280px;height:720px;overflow:hidden;background:#000'
  // --- f_scene.js::combatF, the world and its lights, verbatim ---
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
  // --- f_kit.js::frame, less fog, the 2D actor layer, fx, foreground and kit.js::post's bloom + grade ---
  const r = makeRenderer(); r.toneMappingExposure = P.exposure
  const scene = new THREE.Scene()
  scene.add(S.bgQuad(P.bg))
  const { field, albedo } = fieldTextures(world)
  const black = new THREE.WebGLRenderTarget(4, 4)
  const terrain = { ...P.terrain }
  if (knob === 'rim-off') terrain.rimK = 0
  if (knob === 'bevel-off') terrain.bevel = 0.001
  const lit = knob === 'lights-off' ? [] : lights.map(l => ({ ...l, color: toLin(l.rgb) }))
  scene.add(screenQuad(terrainMaterial({ field, albedo, occl: black.texture, lights: lit, ...terrain }), 0))
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 })
  const comp = new EffectComposer(r, rt)
  comp.addPass(new RenderPass(scene, orthoCam()))
  comp.addPass(new OutputPass())
  comp.render()
}
