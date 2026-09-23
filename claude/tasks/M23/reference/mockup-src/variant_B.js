// B: "Pixel-lit 2.5D" (Dead Cells pipeline). Same 3D models, rendered at half
// resolution with no AA and upscaled nearest: reads as pixel art, lit like 3D.
// Terrain uses the same mask-derived normal shader as A. Dusk mood so dynamic
// lights (explosion, crystals, portal, lasers) carry the frame.
import * as THREE from 'three'
import { W, H } from './world.js'
import { makeRenderer, orthoCam, fieldTextures, screenQuad, meadowBackground, terrainMaterial, foregroundDoF, post, hud } from './kit.js'
import { arenaWorld, populate, addLights } from './arena.js'

export default async function () {
  const S = 2
  const world = arenaWorld()
  const r = makeRenderer({ scale: S }); const cam = orthoCam(); const scene = new THREE.Scene()
  const { field, albedo } = fieldTextures(world)
  const occlRT = new THREE.WebGLRenderTarget(W, H)
  scene.add(screenQuad(meadowBackground({ sun: [1010, 400], mood: 'dusk' }), -900))
  const { lights, actors } = populate(scene, world, { z: 40 })
  const sunDir = [0.75, 0.32, 0.45]
  scene.add(screenQuad(terrainMaterial({ field, albedo, occl: occlRT.texture, lights, sunDir, sunCol: [1.1, 0.55, 0.32], sky: [0.2, 0.16, 0.36], ground: [0.14, 0.08, 0.08], rimCol: [1.0, 0.5, 0.35], ambient: 0.9 }), 0))
  addLights(scene, lights, { sunDir, sunCol: 0xff9a5a, sunI: 2.0, hemi: [0x7a6ab0, 0x2a1a18, 1.0], rimI: 2.0 })
  const fg = screenQuad(foregroundDoF({ tint: [0.01, 0.008, 0.02], spots: [{ x: -10, y: 520, r: 100, n: 10 }, { x: 1300, y: 700, r: 120, n: 11 }, { x: 1290, y: -10, r: 120, n: 11 }, { x: 60, y: 730, r: 70, n: 6 }] }), 900); fg.renderOrder = 10; scene.add(fg)
  const occScene = new THREE.Scene(); occScene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const saved = actors.parent; occScene.add(actors); r.setRenderTarget(occlRT); r.setClearColor(0x000000, 1); r.render(occScene, cam); r.setRenderTarget(null); saved.add(actors)
  const comp = post(r, scene, cam, { scale: S, bloom: [0.42, 0.35, 0.85], grade: { vignette: 0.55, sat: 1.12, warm: [1.06, 0.98, 0.92], cool: [0.9, 0.92, 1.1] } })
  comp.render()
  hud({})
}
