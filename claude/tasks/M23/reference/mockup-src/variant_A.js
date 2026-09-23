// A: "Lit 2.5D" — the Phaser-shaped path. Terrain = one shader over the mask's
// distance field (bevel, normals, shadows, lights); actors = lit models (in the game:
// pre-rendered sprite sheets + normal maps); background = parallax with baked DoF.
import * as THREE from 'three'
import { W, H } from './world.js'
import { makeRenderer, orthoCam, fieldTextures, screenQuad, meadowBackground, terrainMaterial, foregroundDoF, post, hud } from './kit.js'
import { arenaWorld, populate, addLights } from './arena.js'

export default async function () {
  const world = arenaWorld()
  const r = makeRenderer(); const cam = orthoCam(); const scene = new THREE.Scene()
  const { field, albedo } = fieldTextures(world)
  const occlRT = new THREE.WebGLRenderTarget(W, H)
  scene.add(screenQuad(meadowBackground({ sun: [420, 70] }), -900))
  const { lights, actors, fx } = populate(scene, world, { z: 40 })
  const terr = screenQuad(terrainMaterial({ field, albedo, occl: occlRT.texture, lights }), 0); scene.add(terr)
  addLights(scene, lights)
  const fg = screenQuad(foregroundDoF({ spots: [{ x: -10, y: 520, r: 100, n: 10 }, { x: 1300, y: 700, r: 120, n: 11 }, { x: 1290, y: -10, r: 120, n: 11 }, { x: 60, y: 730, r: 70, n: 6 }] }), 900); fg.renderOrder = 10; scene.add(fg)
  // occlusion silhouettes of the actors (drop shadow onto the terrain face)
  const occScene = new THREE.Scene(); occScene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const saved = actors.parent; occScene.add(actors); r.setRenderTarget(occlRT); r.setClearColor(0x000000, 1); r.render(occScene, cam); r.setRenderTarget(null); saved.add(actors)
  const comp = post(r, scene, cam, {})
  comp.render()
  hud({})
}
