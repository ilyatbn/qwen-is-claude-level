// D: space mode in the recommended style (A: lit 2.5D over the mask). Hard white sun,
// near-black ambient, blue planet-shine rim, nebula + planet with baked DoF.
import * as THREE from 'three'
import { W, H, buildMask, derive, groundAt } from './world.js'
import { SPACE } from './maps.js'
import { makeRenderer, orthoCam, fieldTextures, screenQuad, spaceBackground, terrainMaterial, post, hud, ribbon, explosion, smokeTrail, softTex, sprite, rnd, wy, NOISE_GLSL } from './kit.js'
import { addLights } from './arena.js'
import * as M from './models.js'

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`
function ceilingAt(m, x, y0) { x = Math.round(x); for (let y = y0; y > 0; y--) if (m.solid[y * W + x]) return y; return 0 }

export default async function () {
  const world = derive(buildMask(SPACE), 'asteroid')
  const r = makeRenderer(); const cam = orthoCam(); const scene = new THREE.Scene()
  const { field, albedo } = fieldTextures(world)
  const occlRT = new THREE.WebGLRenderTarget(W, H)
  scene.add(screenQuad(spaceBackground(), -900))
  // far drifting rocks (defocused, parallax layer)
  scene.add(screenQuad(new THREE.ShaderMaterial({ transparent: true, depthWrite: false, vertexShader: VS, fragmentShader: NOISE_GLSL + `varying vec2 vUv;
    void main(){ vec2 p = vec2(vUv.x*1280., (1.-vUv.y)*720.); float a = 0.; vec3 c = vec3(0.);
      for (int i=0;i<7;i++){ vec2 ctr = vec2(hash12(vec2(float(i),1.))*1280., hash12(vec2(float(i),2.))*520.+40.); float rr = 6. + hash12(vec2(float(i),3.))*14.;
        vec2 d = p - ctr; float ang = atan(d.y,d.x); float rad = rr*(0.8+0.35*fbm(vec2(cos(ang),sin(ang))*1.5+float(i),3));
        float m = smoothstep(rad+5., rad-5., length(d)); float lit = clamp(dot(normalize(d+1e-3), normalize(vec2(-0.8,-0.5))),0.,1.);
        c = mix(c, vec3(0.02,0.02,0.03) + vec3(0.09,0.08,0.08)*lit*lit, m); a = max(a, m); }
      gl_FragColor = vec4(c, a*0.9); }` }), -500))
  // actors
  const actors = new THREE.Group(), fx = new THREE.Group(); scene.add(actors, fx)
  const lights = []; const light = (x, y, z, rr, color, i) => lights.push({ x, y, z, r: rr, color, i })
  const put = (o, x, y, z = 40) => { o.position.set(x, wy(y), z); actors.add(o); return o }
  // hero on the big asteroid, laser rifle
  const hx = 430, hy = groundAt(world, hx, 200)
  put(M.soldier({ suit: 0xdfe4ea, accent: 0x2f8fff, visor: 0xffb030, weapon: 'bazooka', aim: 0.5 }), hx, hy + 2)
  // enemy jetpacking in zero-g, firing a laser at the hero
  const ex = 700, ey = 330
  const en = put(M.soldier({ suit: 0x2a2d33, accent: 0xff4040, visor: 0xff3030, weapon: 'laser', jet: true, legs: 'jet', aim: -0.15, face: -1 }), ex, ey); en.rotation.z = -0.3
  light(ex + 18, ey + 25, 30, 150, [1.0, 0.5, 0.2], 1.8)
  const lx0 = ex - 50, ly0 = ey - 30, lx1 = hx + 52, ly1 = groundAt(world, hx + 52, 200) + 2
  fx.add(ribbon([[lx0, wy(ly0)], [lx1, wy(ly1)]], 8, [3.2, 1.0, 1.2], [1.0, 0.08, 0.15], { z: 60, fadePow: 0.25, headBoost: 0 }))
  fx.add(sprite(softTex(), lx1, wy(ly1), 62, 60, new THREE.Color(3, 0.6, 0.6), 1, true))
  for (let i = 0; i < 12; i++) { const a = 0.2 + rnd() * 2.7, rr = 12 + rnd() * 30; fx.add(ribbon([[lx1, wy(ly1)], [lx1 + Math.cos(a) * rr, wy(ly1) + Math.sin(a) * rr]], 2, [4, 2, 1.5], [1.0, 0.2, 0.1], { z: 64, fadePow: 0.5 })) }
  light(lx1, ly1 - 6, 20, 130, [1.0, 0.25, 0.2], 2.2)
  fx.add(sprite(softTex(), lx0, wy(ly0), 62, 36, new THREE.Color(3, 0.5, 0.6), 1, true))
  light(lx0, ly0, 30, 120, [1.0, 0.2, 0.25], 1.8)
  // rocket from hero toward the right asteroid + trail (thin exhaust, space: no billow)
  const rpath = []; const sx = hx + 60, sy = hy - 100
  for (let i = 0; i <= 24; i++) { const t = i / 24; rpath.push([sx + t * 280, wy(sy - t * 90)]) }
  fx.add(ribbon(rpath.map((p, i) => [p[0], p[1], 0.3 + (i / 24) * 0.7]), 10, [1.6, 1.2, 0.8], [0.5, 0.25, 0.1], { z: 50, fadePow: 2.2 }))
  fx.add(smokeTrail(rpath.slice(0, -2), { z: 49, size: 14, grow: 1.8, color: 0x9098b0 }))
  const rk = M.rocket(); const [rx, ryw] = rpath[rpath.length - 1]; rk.position.set(rx, ryw, 52); rk.rotation.z = Math.atan2(90, 280); rk.scale.setScalar(1.3); actors.add(rk)
  fx.add(sprite(softTex(), rx - 24, ryw - 8, 53, 50, new THREE.Color(2.5, 1.2, 0.3), 1, true))
  light(rx - 20, H - ryw, 30, 140, [1.0, 0.55, 0.2], 1.8)
  // turret on the right asteroid, firing tracers at the enemy
  const tx = 1060, ty = groundAt(world, tx, 100)
  const tur = put(M.turret({ aim: -0.35 }), tx, ty + 1); tur.scale.x = -1
  const mx = tx - 50, my = ty - 48
  for (let k = 0; k < 4; k++) { const t0 = 0.1 + k * 0.2, t1 = t0 + 0.08, X = t => mx + (ex + 30 - mx) * t, Y = t => my + (ey - 40 - my) * t; fx.add(ribbon([[X(t1), wy(Y(t1))], [X(t0), wy(Y(t0))]], 4, [4, 3, 1.4], [1.0, 0.45, 0.08], { z: 60, fadePow: 1.2 })) }
  fx.add(sprite(softTex(), mx, wy(my), 62, 40, new THREE.Color(2.5, 1.6, 0.6), 0.9, true))
  light(mx, my, 30, 110, [1.0, 0.7, 0.3], 1.5)
  // explosion in the right asteroid's blast hole (space: flash, sparks, debris, little smoke)
  fx.add(explosion(900, wy(205), 0.8, { z: 70, smoke: 0x1a1a22 }))
  for (let i = 0; i < 22; i++) { const d = M.debris(0x80788a, 0.6 + rnd() * 0.9); const a = rnd() * 6.28, rr = 40 + rnd() * 110; d.position.set(900 + Math.cos(a) * rr, wy(205) + Math.sin(a) * rr, 74); actors.add(d) }
  light(900, 205, 80, 420, [1.0, 0.5, 0.2], 2.6)
  // spider walking upside-down under the right asteroid (radial gravity)
  const spx = 960, spy = ceilingAt(world, spx, 420)
  const sp = put(M.spider(), spx, spy - 1); sp.rotation.z = Math.PI
  light(spx, spy + 14, 10, 40, [1.0, 0.2, 0.1], 0.6)
  // beetle on the small asteroid, standing on its left flank
  const bx = 1000, by = groundAt(world, bx, 480)
  put(M.beetle({ color: 0x2a3f9a }), bx, by + 2).rotation.z = 0.5
  // gate on the small asteroid
  const gx = 1100, gy = groundAt(world, gx, 460)
  put(M.gate({ r: 40, tint: [1.0, 0.45, 0.9] }), gx, gy - 44, 34)
  light(gx, gy - 44, 40, 180, [1.0, 0.4, 0.9], 2.0)
  // crystals
  const c1x = 250, c1y = groundAt(world, c1x, 240)
  put(M.crystals({ color: 0x19e0c0, n: 7, size: 0.85, seed: 5 }), c1x, c1y + 4, 36)
  light(c1x, c1y - 30, 40, 160, [0.1, 1.0, 0.8], 1.6)
  const c2x = 650, c2y = groundAt(world, c2x, 100)
  put(M.crystals({ color: 0xffa020, n: 5, size: 0.6, seed: 9 }), c2x, c2y + 4, 36)
  light(c2x, c2y - 20, 40, 120, [1.0, 0.6, 0.1], 1.4)

  const sunDir = [-0.72, 0.45, 0.52]
  scene.add(screenQuad(terrainMaterial({ field, albedo, occl: occlRT.texture, lights, sunDir, sunCol: [2.3, 2.15, 2.0], sky: [0.03, 0.05, 0.1], ground: [0.05, 0.03, 0.05], rimCol: [0.5, 0.9, 2.2], interior: 0.7, ambient: 1 }), 0))
  addLights(scene, lights, { sunDir, sunCol: 0xffffff, sunI: 3.8, hemi: [0x223355, 0x110a10, 0.5], rimI: 3.0 })
  const occScene = new THREE.Scene(); occScene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
  occScene.add(actors); r.setRenderTarget(occlRT); r.setClearColor(0x000000, 1); r.render(occScene, cam); r.setRenderTarget(null); scene.add(actors)
  const comp = post(r, scene, cam, { bloom: [0.5, 0.5, 0.75], grade: { vignette: 0.5, sat: 1.1, warm: [1.04, 1.0, 0.95], cool: [0.92, 0.97, 1.1] } })
  comp.render()
  hud({ timer: '1:12' })
}
