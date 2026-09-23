// The shared arena composition: same map, same actors, same moment, for every variant.
import * as THREE from 'three'
import { buildMask, derive, groundAt, H } from './world.js'
import { ARENA } from './maps.js'
import * as M from './models.js'
import { ribbon, explosion, smokeTrail, softTex, sprite, rnd, wy } from './kit.js'

export function arenaWorld() { return derive(buildMask(ARENA), 'meadow') }

const lin = (r, g, b) => [r, g, b]

/**
 * Adds actors + fx to `scene`. `zOf(layer)` maps a nominal depth to world z (so the
 * true-3D variant can push actors into the slab). Returns {lights (mask-space), actors}.
 */
export function populate(scene, world, { z = 40, shadows = false, fxScale = 1, yOff = 0 } = {}) {
  const actors = new THREE.Group(); scene.add(actors)
  const fx = new THREE.Group(); scene.add(fx)
  const put = (obj, x, y, zz = z) => { obj.position.set(x, wy(y + yOff), zz); actors.add(obj); return obj }
  const lights = []
  const light = (x, y, lz, r, color, i) => lights.push({ x, y, z: lz, r, color, i })
  const g = x => groundAt(world, x, 60)

  // --- player with bazooka, on the central dip
  const px = 700, py = groundAt(world, px, 280)
  const hero = put(M.soldier({ suit: 0x2f6f9f, accent: 0xf0b030, aim: 0.42, weapon: 'bazooka' }), px, py + 2)
  // --- enemy jetpacking over the valley, firing a laser at the turret
  const ex = 360, ey = 250
  put(M.soldier({ suit: 0xa8322c, accent: 0xe8e0d0, visor: 0xffb040, aim: 0.3, weapon: 'laser', jet: true, legs: 'jet' }), ex, ey)
  light(ex - 15, ey + 20, 30, 150, lin(1.0, 0.5, 0.15), 1.6)
  // --- turret on the left peak, shooting tracers at the enemy
  const tx = 548, ty = groundAt(world, tx, 150)
  const tur = put(M.turret({ aim: -0.25 }), tx, ty + 1); tur.scale.x = -1
  // tracers (turret muzzle -> enemy)
  const mx = tx - 50, my = ty - 45
  for (let k = 0; k < 4; k++) {
    const t0 = 0.12 + k * 0.22, t1 = t0 + 0.09
    const ax = mx + (ex + 20 - mx) * t0, ay = my + (ey - 40 - my) * t0, bx = mx + (ex + 20 - mx) * t1, by = my + (ey - 40 - my) * t1
    fx.add(ribbon([[bx, wy(by)], [ax, wy(ay)]], 4, [4, 3, 1.4], [1.0, 0.45, 0.08], { z: z + 20, fadePow: 1.2 }))
  }
  fx.add(sprite(softTex(), mx, wy(my), z + 22, 46, new THREE.Color(2.5, 1.6, 0.6), 0.9, true))
  light(mx, my, 30, 110, lin(1.0, 0.7, 0.3), 1.5)
  // laser beam from enemy muzzle toward the turret body
  const lx0 = ex + 50, ly0 = ey - 58, lx1 = tx - 10, ly1 = ty - 50
  fx.add(ribbon([[lx0, wy(ly0)], [lx1, wy(ly1)]], 8, [1.4, 3.2, 3.6], [0.05, 0.45, 0.8], { z: z + 21, fadePow: 0.2, headBoost: 0 }))
  fx.add(sprite(softTex(), lx1, wy(ly1), z + 23, 50, new THREE.Color(0.4, 1.4, 1.8), 1, true))
  fx.add(sprite(softTex(), lx0, wy(ly0), z + 23, 30, new THREE.Color(0.6, 2.4, 3), 1, true))
  for (let i = 0; i < 10; i++) { const a = rnd() * 6.28, r = 10 + rnd() * 26; fx.add(ribbon([[lx1, wy(ly1)], [lx1 + Math.cos(a) * r, wy(ly1) + Math.sin(a) * r]], 2, [3, 6, 7], [0.2, 0.8, 1.2], { z: z + 24, fadePow: 0.5 })) }
  light(lx1, ly1, 30, 160, lin(0.3, 0.8, 1.0), 2.2)
  // --- rocket in flight with smoke trail (from hero's bazooka)
  const rpath = []; const sx = px + 55, sy = py - 88
  for (let i = 0; i <= 26; i++) { const t = i / 26; rpath.push([sx + t * 230, wy(sy - t * 150 + t * t * 40)]) }
  fx.add(smokeTrail(rpath.slice(0, -2), { z: z + 10, size: 13, grow: 2.6 }))
  const rk = M.rocket(); const [rx, ryw] = rpath[rpath.length - 1]; const [qx, qyw] = rpath[rpath.length - 3]
  rk.position.set(rx, ryw, z + 12); rk.rotation.z = Math.atan2(ryw - qyw, rx - qx); rk.scale.setScalar(1.3); actors.add(rk)
  fx.add(sprite(softTex(), rx - 24, ryw - 8, z + 13, 50, new THREE.Color(2.5, 1.2, 0.3), 1, true))
  light(rx - 20, H - ryw, 30, 140, lin(1.0, 0.55, 0.2), 1.8)
  // bazooka backblast puff
  fx.add(smokeTrail([[px - 40, wy(py - 56)], [px - 55, wy(py - 50)], [px - 70, wy(py - 42)]], { z: z + 8, size: 22, grow: 1 }))
  // --- explosion in the fresh crater + debris
  const exX = 1120, exY = 438
  fx.add(explosion(exX, wy(exY), 0.95 * fxScale, { z: z + 30 }))
  for (let i = 0; i < 16; i++) { const d = M.debris(0x7a6450, 0.8 + rnd() * 1.2); const a = 0.3 + rnd() * 2.5, r = 60 + rnd() * 120; d.position.set(exX + Math.cos(a) * r, wy(exY) + Math.sin(a) * r * 0.9, z + 34); actors.add(d) }
  light(exX, exY, 90, 480, lin(1.0, 0.5, 0.18), 2.6)
  // --- gate on the left cliff
  const gx = 110, gy = groundAt(world, gx, 100)
  put(M.gate({ r: 44 }), gx, gy - 50, z - 6)
  light(gx, gy - 50, 40, 200, lin(0.35, 0.55, 1.0), 2.0)
  // --- crystals
  const c1x = 250, c1y = groundAt(world, c1x, 100)
  put(M.crystals({ color: 0x2f6bff, n: 7, size: 0.9, seed: 3 }), c1x, c1y + 4, z - 4)
  light(c1x, c1y - 30, 40, 150, lin(0.25, 0.45, 1.0), 1.6)
  const c2x = 1110, c2y = groundAt(world, c2x, 120)
  put(M.crystals({ color: 0x8a3cff, n: 6, size: 0.8, seed: 11 }), c2x, c2y + 4, z - 4)
  light(c2x, c2y - 30, 40, 150, lin(0.6, 0.3, 1.0), 1.5)
  // --- animals
  const bx = 985, by = groundAt(world, bx, 300)
  const bt = put(M.beetle(), bx, by + 1); bt.rotation.z = -0.5
  const spx = 735, spy = groundAt(world, spx, 420)
  put(M.spider(), spx, spy + 1, z - 2).scale.x = -1
  light(spx + 10, spy - 16, 10, 40, lin(1.0, 0.2, 0.1), 0.6)
  put(M.bird({ flap: 0.1 }), 640, 96).rotation.z = 0.08
  put(M.bird({ flap: 0.9 }), 700, 128).rotation.z = -0.05
  const b3 = put(M.bird({ flap: 0.5, color: 0x2a2a30 }), 1230, 300); b3.scale.set(-0.8, 0.8, 0.8)
  return { lights, actors, fx, hero }
}

/** Add three.js lights matching the mask-space light list */
export function addLights(scene, lights, { sunDir = [-0.5, 0.72, 0.42], sunCol = 0xfff0dd, sunI = 3.0, hemi = [0x9ec4ff, 0x5a4630, 0.9], shadows = false, zOff = 0, rimI = 2.2 } = {}) {
  const sun = new THREE.DirectionalLight(sunCol, sunI)
  const d = new THREE.Vector3(...sunDir).normalize()
  sun.position.set(640 + d.x * 1500, 360 + d.y * 1500, d.z * 1500); sun.target.position.set(640, 360, 0)
  scene.add(sun, sun.target)
  if (shadows) {
    sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096)
    Object.assign(sun.shadow.camera, { left: -900, right: 900, top: 900, bottom: -900, near: 10, far: 4000 }); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.6
    sun.shadow.radius = 4
  }
  scene.add(new THREE.HemisphereLight(hemi[0], hemi[1], hemi[2]))
  // back/rim light for silhouettes
  const rim = new THREE.DirectionalLight(0xbfd8ff, rimI); rim.position.set(900, 500, -600); scene.add(rim)
  for (const l of lights) {
    const p = new THREE.PointLight(new THREE.Color(...l.color), l.i * (l.r * 0.3) ** 2, l.r * 1.2, 2)
    p.position.set(l.x, H - l.y, l.z + zOff); scene.add(p)
  }
  return sun
}
