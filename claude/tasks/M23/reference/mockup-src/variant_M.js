// Model sheet: the stand-in models at 2.6x game scale, lit like variant A.
import * as THREE from 'three'
import { W, H } from './world.js'
import { makeRenderer, screenQuad, post, ribbon, softTex, sprite, NOISE_GLSL } from './kit.js'
import * as M from './models.js'
const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`

export default async function () {
  const r = makeRenderer(); r.toneMappingExposure = 1.1
  const S = 2.6
  const cam = new THREE.OrthographicCamera(0, W / S, H / S - 12, -12, -2000, 2000); cam.position.z = 1000
  const scene = new THREE.Scene()
  scene.add(screenQuad(new THREE.ShaderMaterial({ depthWrite: false, vertexShader: VS, fragmentShader: NOISE_GLSL + `varying vec2 vUv;
    void main(){ vec3 c = mix(vec3(0.05,0.06,0.08), vec3(0.2,0.24,0.3), vUv.y); c += vec3(0.12,0.1,0.08)*exp(-length((vUv-vec2(0.5,0.55))*vec2(1.6,1.))*3.);
      c += (hash12(vUv*900.)-0.5)*0.01; gl_FragColor = vec4(c,1.); }` }), -900).translateX(0))
  scene.children[0].scale.set(1 / S, 1 / S, 1); scene.children[0].position.set(W / S / 2, H / S / 2 - 12, -900)
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W / S, 6, 80), new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.6 })); floor.position.set(W / S / 2, 3, -20); floor.receiveShadow = true; scene.add(floor)
  const add = (o, x, y, z = 0) => { o.position.set(x, y, z); scene.add(o); return o }
  add(M.soldier({ suit: 0x2f6f9f, accent: 0xf0b030, aim: 0.15, weapon: 'bazooka' }), 50, 6)
  add(M.soldier({ suit: 0xa8322c, accent: 0xe8e0d0, visor: 0xffb040, aim: 0.05, weapon: 'laser' }), 140, 6)
  add(M.soldier({ suit: 0x44603a, accent: 0xd0c070, visor: 0x80ff80, aim: -0.1, weapon: 'flamer', jet: true, legs: 'jet' }), 222, 22)
  add(M.soldier({ suit: 0xdfe4ea, accent: 0x2f8fff, visor: 0xffb030, weapon: 'bazooka', aim: 0.6 }), 350, 6)
  add(M.turret({ aim: 0.1 }), 440, 6)
  add(M.beetle(), 95, 172).scale.setScalar(1.3)
  add(M.spider(), 185, 170).scale.setScalar(1.2)
  add(M.bird({ flap: 0.2 }), 272, 200).scale.setScalar(1.3)
  add(M.bird({ flap: 0.9 }), 338, 192).scale.setScalar(1.1)
  add(M.gate({ r: 38 }), 440, 196, -30)
  add(M.crystals({ color: 0x2f6bff, n: 7, size: 0.7, seed: 3 }), 26, 150, -10)
  add(M.crystals({ color: 0x8a3cff, n: 6, size: 0.55, seed: 11 }), 385, 150, -10)
  const rk = add(M.rocket(), 150, 138, 10); rk.scale.setScalar(1.6)
  scene.add(ribbon([[70, 138], [120, 138]], 6, [2.5, 1.4, 0.5], [0.6, 0.25, 0.05], { z: 5, fadePow: 2 }))
  for (let k = 0; k < 6; k++) scene.add(sprite(softTex(), 272 + k * 7, 74 + (k % 2) * 2, 8, 8 + k * 4, new THREE.Color(1.8, 0.7 - k * 0.08, 0.1), 0.95 - k * 0.1, true))
  scene.add(sprite(softTex(), 205, 66, 8, 14, new THREE.Color(0.6, 2.4, 3), 1, true))
  const key = new THREE.DirectionalLight(0xfff0dd, 3.2); key.position.set(-300, 500, 600); scene.add(key)
  scene.add(new THREE.HemisphereLight(0x9ec4ff, 0x3a3028, 1.0))
  const rim = new THREE.DirectionalLight(0x9fc8ff, 3.0); rim.position.set(500, 300, -500); scene.add(rim)
  const comp = post(r, scene, cam, { bloom: [0.3, 0.4, 0.9], grade: { vignette: 0.4 } })
  comp.render()
  const lab = document.createElement('div'); lab.style.cssText = 'position:fixed;left:24px;top:18px;font:600 15px system-ui;color:#cfd8e0;letter-spacing:.04em'
  lab.textContent = 'Stand-in models at 2.6x game scale (procedural low-poly; real ones would come from an artist, a CC0 pack, or an AI mesh + retopo)'
  document.body.appendChild(lab)
}
