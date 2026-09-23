// C: "True 3D diorama" — three.js scene, fixed side camera tilted a few degrees down,
// terrain = slab extruded from the mask, real shadow maps, real 3D grass, same actors.
import * as THREE from 'three'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { W, H } from './world.js'
import { makeRenderer, orthoCam, screenQuad, meadowBackground, foregroundDoF, post, hud } from './kit.js'
import { arenaWorld, populate, addLights } from './arena.js'
import { slabTextures, slabMesh, backdropMesh, grass } from './slab.js'
import { ARENA } from './maps.js'

export default async function () {
  const B = 12, T = 90
  const world = arenaWorld()
  const r = makeRenderer({ shadows: true })
  r.toneMappingExposure = 1.3
  const scene = new THREE.Scene()
  const tex = slabTextures(world, { backTint: 1.5 })
  scene.add(slabMesh(world, tex, { B, T }))
  scene.add(backdropMesh(tex, -T - 1))
  scene.add(grass(world, { B, T, scorch: ARENA.scorch }))
  const { lights } = populate(scene, world, { z: -T / 2, yOff: B / 3 })
  scene.traverse(o => { if (o.isMesh && !o.material.blending) { o.castShadow = true } })
  addLights(scene, lights, { shadows: true, zOff: -T / 2, sunI: 4.6, rimI: 0.9, hemi: [0xb0d0ff, 0x6a5440, 2.2] })
  const vfov = 22, D = (H / 2) / Math.tan(vfov / 2 * Math.PI / 180)
  const cam = new THREE.PerspectiveCamera(vfov, W / H, 10, 6000)
  const tilt = 9 * Math.PI / 180
  cam.position.set(W / 2, H / 2 + Math.sin(tilt) * D + 10, Math.cos(tilt) * D)
  cam.lookAt(W / 2, H / 2 + 10, -T / 2)
  // layered passes: ortho background (baked DoF), perspective world, ortho near-foreground
  const bgScene = new THREE.Scene(); bgScene.add(screenQuad(meadowBackground({ sun: [420, 70] }), -900))
  const fgScene = new THREE.Scene(); fgScene.add(screenQuad(foregroundDoF({ spots: [{ x: -10, y: 520, r: 100, n: 10 }, { x: 1300, y: 700, r: 120, n: 11 }, { x: 1290, y: -10, r: 120, n: 11 }, { x: 60, y: 730, r: 70, n: 6 }] }), 0))
  const comp = post(r, bgScene, orthoCam(), {})
  const main = new RenderPass(scene, cam); main.clear = false; main.clearDepth = true
  const fg = new RenderPass(fgScene, orthoCam()); fg.clear = false; fg.clearDepth = true
  comp.insertPass(main, 1); comp.insertPass(fg, 2)
  comp.render()
  hud({})
}
