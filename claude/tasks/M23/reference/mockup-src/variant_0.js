// Baseline: today's approach on the same composition — flat sky, grey mottled
// terrain with a white rim, flat-coloured actors, no lighting, no glow.
import * as THREE from 'three'
import { W, H } from './world.js'
import { makeRenderer, orthoCam, fieldTextures, screenQuad, NOISE_GLSL, ribbon, hud, wy } from './kit.js'
import { arenaWorld, populate } from './arena.js'

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`
export default async function () {
  const world = arenaWorld()
  const r = makeRenderer(); r.toneMapping = THREE.NoToneMapping
  const cam = orthoCam(); const scene = new THREE.Scene()
  const { field } = fieldTextures(world)
  scene.add(screenQuad(new THREE.ShaderMaterial({ depthWrite: false, vertexShader: VS, fragmentShader: NOISE_GLSL + `varying vec2 vUv;
    void main(){ vec2 p = vec2(vUv.x*1280., (1.-vUv.y)*720.);
      vec3 c = mix(vec3(0.42,0.62,0.86), vec3(0.55,0.72,0.92), p.y/720.);
      if (length(p - vec2(860.,110.)) < 62.) c = vec3(1.,0.97,0.8);
      float hl = 470. - 90.*fbm(vec2(p.x*0.004, 1.), 3); if (p.y > hl) c = vec3(0.5,0.62,0.66);
      gl_FragColor = vec4(c, 1.); }` }), -900))
  scene.add(screenQuad(new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { field: { value: field } }, vertexShader: VS, fragmentShader: NOISE_GLSL + `varying vec2 vUv; uniform sampler2D field;
    void main(){ vec2 p = vec2(vUv.x*1280., (1.-vUv.y)*720.); vec4 f = texture2D(field, p/vec2(1280.,720.));
      float din = f.r*64.; bool solid = din > 0.3; bool back = f.b > 0.5;
      if (!solid && !back) discard;
      float n = fbm(p*0.035, 4);
      vec3 c = mix(vec3(0.5,0.52,0.56), vec3(0.62,0.64,0.68), n);
      // white rim on up-facing edges
      float up = texture2D(field, (p+vec2(0.,4.))/vec2(1280.,720.)).r*64. - din;
      if (solid && din < 4. && up > 1.) c = vec3(0.95,0.97,1.);
      if (!solid) c = vec3(0.38,0.4,0.44)*(0.9+0.2*n);
      gl_FragColor = vec4(c, 1.); }` }), 0))
  const { actors, fx } = populate(scene, world, { z: 40 })
  fx.visible = false
  actors.traverse(o => { if (o.isMesh && o.material && !o.material.isShaderMaterial) { const m = o.material; o.material = new THREE.MeshBasicMaterial({ color: m.color || 0xffffff, map: m.map || null, transparent: m.transparent, opacity: m.opacity, blending: m.blending, depthWrite: m.depthWrite }) } })
  // today's effects: plain lines and flat blobs
  const line = (a, b, col, w) => scene.add(ribbon([a, b], w, [0, 0, 0], [0, 0, 0], {}).material ? (() => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: col })); const dx = b[0] - a[0], dy = b[1] - a[1]; m.scale.set(Math.hypot(dx, dy), w, 1); m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 60); m.rotation.z = Math.atan2(dy, dx); return m })() : null)
  line([410, wy(192)], [538, wy(178)], 0x7fe0ff, 2)
  for (let k = 0; k < 4; k++) { const x = 490 - k * 30; line([x, wy(210 - k * 6)], [x - 12, wy(212 - k * 6)], 0xffd040, 2) }
  line([760, wy(282)], [986, wy(160)], 0xdddddd, 1)
  for (const [dx, dy, rr, col] of [[0, 0, 46, 0xff8c1a], [-30, 20, 30, 0xffa030], [28, 16, 34, 0xff7a10], [0, -8, 22, 0xffe070]]) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(rr, 32), new THREE.MeshBasicMaterial({ color: col })); m.position.set(1120 + dx, wy(438) + dy, 70); scene.add(m)
  }
  r.render(scene, cam)
  hud({ style: 'old' })
}
