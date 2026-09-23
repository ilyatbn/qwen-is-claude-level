// Procedural low-poly models, built in pixel units (1 unit = 1 screen px at game zoom).
// Stand-ins for what an artist (or a CC0 pack / AI mesh) would supply.
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.0, ...o })
const phys = (color, o = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.4, ...o })
export const mats = { std, phys }

function rotZ(m, a) { m.rotation.z = a; return m }
function mesh(geo, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m }
function limb(a, b, r, mat) { // capsule between two points (in the parent's space)
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b)
  const len = va.distanceTo(vb)
  const m = mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len), 4, 10), mat)
  m.position.copy(va).add(vb).multiplyScalar(0.5)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize())
  return m
}
function box(w, h, d, r, mat, x, y, z) { return mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat, x, y, z) }

/** Striped canvas texture (hazard stripes, camo...) */
function stripeTex(c1, c2, n = 6) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d')
  g.fillStyle = c1; g.fillRect(0, 0, 64, 64); g.fillStyle = c2
  for (let i = -64; i < 128; i += 64 / n * 2) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64 / n, 0); g.lineTo(i + 64 / n - 32, 64); g.lineTo(i - 32, 64); g.fill() }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t
}

/**
 * Soldier ~84 px tall, facing +x. aim: radians (0 = right). weapon: 'bazooka' | 'flamer' | 'laser'.
 */
export function soldier({ suit = 0x3d6b8f, accent = 0xe0a030, skin = 0xe8b08a, visor = 0x5ff3ff, aim = 0.25, weapon = 'bazooka', jet = false, legs = 'stand', face = 1 } = {}) {
  const g = new THREE.Group()
  const suitM = std(suit, { roughness: 0.55 })
  const darkM = std(0x2a2f36, { roughness: 0.5, metalness: 0.3 })
  const accM = std(accent, { roughness: 0.45 })
  const skinM = std(skin, { roughness: 0.7 })
  const visM = std(0x101820, { emissive: visor, emissiveIntensity: 1.6, roughness: 0.2, metalness: 0.5 })
  const bootM = std(0x3a2c22, { roughness: 0.8 })
  // legs
  const hip = 34
  const L = legs === 'stand' ? [[[4, hip, 5], [12, 19, 6], [11, 4, 6]], [[-4, hip, -5], [-8, 19, -6], [-11, 4, -6]]]
    : [[[4, hip, 5], [14, 22, 6], [10, 8, 6]], [[-4, hip, -5], [-8, 24, -6], [-14, 12, -6]]] // jetpack tuck
  for (const [a, b, c] of L) {
    g.add(limb(a, b, 5.2, suitM)); g.add(limb(b, c, 4.6, suitM))
    g.add(box(15, 8, 10, 3, bootM, c[0] + 3, c[1] - 1, c[2]))
    g.add(mesh(new THREE.SphereGeometry(5.6, 12, 8), accM, b[0] + 1.5, b[1], b[2] + 1)) // knee pad
  }
  // torso
  g.add(limb([0, hip, 0], [1, 56, 0], 11, suitM))
  g.add(box(22, 22, 25, 5, darkM, 3, 50, 0)) // armour vest
  g.add(box(6, 18, 26, 2, accM, 8, 48, 0)) // chest strap
  g.add(box(24, 5, 26, 2, bootM, 1, 36, 0)) // belt
  // jetpack
  const pack = new THREE.Group(); pack.position.set(-15, 50, 0); g.add(pack)
  pack.add(box(12, 26, 22, 4, std(0x8a929c, { metalness: 0.7, roughness: 0.35 }), 0, 0, 0))
  for (const z of [-7, 7]) {
    pack.add(mesh(new THREE.CylinderGeometry(4, 5, 8, 12), darkM, -2, -16, z))
    if (jet) {
      const fl = new THREE.Mesh(new THREE.ConeGeometry(5, 34, 12, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.6, 0.5), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }))
      fl.rotation.z = Math.PI; fl.position.set(-2, -37, z); pack.add(fl)
      const core = new THREE.Mesh(new THREE.ConeGeometry(2.6, 20, 10, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5, 3), blending: THREE.AdditiveBlending, depthWrite: false }))
      core.rotation.z = Math.PI; core.position.set(-2, -30, z); pack.add(core)
    }
  }
  pack.add(mesh(new THREE.SphereGeometry(3, 8, 6), std(0xff3030, { emissive: 0xff2020, emissiveIntensity: 2 }), 5, 10, 0))
  // head
  const head = new THREE.Group(); head.position.set(3, 72, 0); head.scale.setScalar(1.22); g.add(head)
  for (const z of [-11, 11]) g.add(mesh(new THREE.SphereGeometry(7, 14, 10), accM, 1, 58, z)) // shoulder pads
  head.add(mesh(new THREE.SphereGeometry(10.5, 20, 14), skinM, 1, -1, 0))
  const helm = mesh(new THREE.SphereGeometry(12.5, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), suitM, 0, 1, 0); head.add(helm)
  head.add(box(13, 7, 19, 3, visM, 8, 0, 0)) // visor
  head.add(box(3, 12, 3, 1, darkM, -3, 12, 8)) // antenna base
  head.add(mesh(new THREE.CylinderGeometry(0.6, 0.6, 12, 5), darkM, -3, 20, 8))
  head.add(mesh(new THREE.SphereGeometry(1.8, 8, 6), std(accent, { emissive: accent, emissiveIntensity: 2 }), -3, 26, 8))
  // arms + weapon, rotate about shoulder by aim
  const sh = new THREE.Group(); sh.position.set(2, 56, 0); sh.rotation.z = aim; g.add(sh)
  if (weapon === 'bazooka') {
    const tubeM = std(0x56643c, { roughness: 0.55 })
    const tube = mesh(new THREE.CylinderGeometry(6, 6, 64, 16), tubeM, 10, 6, 0); tube.rotation.z = Math.PI / 2; sh.add(tube)
    const bell = mesh(new THREE.CylinderGeometry(8.5, 6, 10, 16, 1, true), darkM, 44, 6, 0); bell.rotation.z = -Math.PI / 2; bell.material.side = THREE.DoubleSide; sh.add(bell)
    const back = mesh(new THREE.CylinderGeometry(6.5, 8, 7, 16, 1, true), darkM, -24, 6, 0); back.rotation.z = -Math.PI / 2; back.material = darkM.clone(); back.material.side = THREE.DoubleSide; sh.add(back)
    const band = std(0xd8c040, { map: stripeTex('#d8b830', '#222') })
    const b2 = mesh(new THREE.CylinderGeometry(6.4, 6.4, 6, 16), band, 30, 6, 0); b2.rotation.z = Math.PI / 2; sh.add(b2)
    sh.add(box(10, 6, 5, 1.5, darkM, 8, 15, 3)); sh.add(mesh(new THREE.SphereGeometry(1.8, 8, 6), std(0xff4040, { emissive: 0xff2020, emissiveIntensity: 3 }), 13, 15, 3))
    sh.add(box(4, 10, 4, 1.5, darkM, 4, -2, 2)); sh.add(box(4, 10, 4, 1.5, darkM, 18, -2, 2))
    // arms reaching the grips
    sh.add(limb([-2, 0, 11], [2, -13, 11], 4.4, suitM)); sh.add(limb([2, -13, 11], [5, -5, 8], 4, suitM))
    sh.add(limb([-2, 0, -11], [10, -10, -9], 4.2, suitM)); sh.add(limb([10, -10, -9], [18, -5, 3], 3.8, suitM))
    sh.add(mesh(new THREE.SphereGeometry(4, 10, 8), std(0x333333), 5, -5, 7)); sh.add(mesh(new THREE.SphereGeometry(4, 10, 8), std(0x333333), 18, -6, 5))
  } else if (weapon === 'flamer') {
    const tank = mesh(new THREE.CapsuleGeometry(5, 12, 4, 12), std(0xb03020, { roughness: 0.4, metalness: 0.3 }), 4, -6, 6); tank.rotation.z = Math.PI / 2; sh.add(tank)
    const barrel = mesh(new THREE.CylinderGeometry(3, 4, 40, 12), std(0x707880, { metalness: 0.8, roughness: 0.3 }), 20, 2, 4); barrel.rotation.z = Math.PI / 2; sh.add(barrel)
    sh.add(rotZ(mesh(new THREE.CylinderGeometry(4.5, 3.5, 6, 12), darkM, 41, 2, 4), Math.PI / 2))
    sh.add(limb([0, 0, 9], [8, -4, 6], 4.2, suitM)); sh.add(limb([0, 0, -9], [24, -2, 6], 4.2, suitM))
  } else if (weapon === 'laser') {
    const body = box(46, 9, 8, 3, std(0xe8ecf0, { roughness: 0.3, metalness: 0.4 }), 16, 3, 3); sh.add(body)
    sh.add(box(30, 3, 9, 1.4, std(0x0a1a22, { emissive: 0x40e0ff, emissiveIntensity: 3 }), 18, 3, 3.5))
    sh.add(box(12, 12, 6, 2, darkM, 4, -5, 3))
    sh.add(rotZ(mesh(new THREE.CylinderGeometry(2, 2, 12, 10), darkM, 44, 3, 3), Math.PI / 2))
    sh.add(limb([0, 0, 9], [6, -6, 6], 4.2, suitM)); sh.add(limb([0, 0, -9], [22, -1, 6], 4.2, suitM))
  }
  g.scale.x = face
  return g
}

/** Rhinoceros beetle ~46 px long, walking +x. Iridescent shell. */
export function beetle({ color = 0x1f6b3a } = {}) {
  const g = new THREE.Group()
  const shell = phys(color, { metalness: 0.6, roughness: 0.25, iridescence: 1, iridescenceIOR: 1.6, clearcoat: 1, clearcoatRoughness: 0.15 })
  const dark = std(0x16140f, { roughness: 0.5 })
  const s = mesh(new THREE.SphereGeometry(14, 24, 16), shell, -4, 13, 0); s.scale.set(1.45, 0.85, 1); g.add(s)
  const p = mesh(new THREE.SphereGeometry(9, 20, 12), shell, 16, 13, 0); p.scale.set(0.9, 0.85, 1); g.add(p)
  const h = mesh(new THREE.SphereGeometry(5, 14, 10), dark, 25, 10, 0); g.add(h)
  // horn
  const horn = mesh(new THREE.ConeGeometry(2.6, 18, 10), dark, 31, 17, 0); horn.rotation.z = -0.85; g.add(horn)
  g.add(mesh(new THREE.SphereGeometry(1.4, 8, 6), std(0xffaa33, { emissive: 0xff8800, emissiveIntensity: 2 }), 28, 12, 4))
  // shell seam
  g.add(mesh(new THREE.BoxGeometry(34, 0.8, 1.2), std(0x0a0a08), -4, 20.5, 0))
  const legs = [[14, -1], [4, 1], [-8, -1]]
  for (const [x, ph] of legs) for (const z of [-7, 7]) {
    const k = [x + 2 + ph * 2, 10, z * 1.5], f = [x + 7 + ph * 3, 0, z * 1.7]
    g.add(limb([x, 9, z * 0.8], k, 1.4, dark)); g.add(limb(k, f, 1.2, dark))
  }
  return g
}

/** Cave spider ~50 px wide */
export function spider() {
  const g = new THREE.Group()
  const body = std(0x2a2226, { roughness: 0.45 })
  const fur = std(0x3a2e30, { roughness: 0.9 })
  const ab = mesh(new THREE.SphereGeometry(12, 20, 14), body, -12, 16, 0); ab.scale.set(1.2, 1, 1); g.add(ab)
  // red hourglass marking
  const mk = mesh(new THREE.SphereGeometry(4, 10, 8), std(0xcc2020, { emissive: 0x660000, emissiveIntensity: 1 }), -14, 22, 10); mk.scale.set(1.4, 0.8, 0.5); g.add(mk)
  g.add(mesh(new THREE.SphereGeometry(7.5, 16, 12), fur, 5, 13, 0))
  for (const [x, z] of [[11, 3], [11, -3], [12, 1.5], [12, -1.5]]) g.add(mesh(new THREE.SphereGeometry(1.4, 8, 6), std(0x220000, { emissive: 0xff3322, emissiveIntensity: 4 }), x, 16, z + 2))
  g.add(limb([10, 9, 3], [14, 3, 4], 1.6, body)); g.add(limb([10, 9, -3], [15, 4, -3], 1.6, body))
  const ang = [0.6, 0.2, -0.2, -0.6]
  for (let i = 0; i < 4; i++) for (const side of [-1, 1]) {
    const a = ang[i], sx = Math.cos(a), bx = 4 + i * -1
    const knee = [bx + 16 * sx * (i < 2 ? 1 : -1) * 0.9 + (i < 2 ? 4 : -4), 28 - i * 1.5, side * (8 + i * 1.5)]
    const foot = [bx + 26 * (i < 2 ? 1 : -1) * (0.7 + 0.25 * Math.abs(sx)), 0, side * (12 + i * 2)]
    g.add(limb([bx, 13, side * 3], knee, 1.8, fur)); g.add(limb(knee, foot, 1.4, fur))
  }
  return g
}

/** Crow-like bird ~44 px wingspan-ish, wings mid-flap */
export function bird({ flap = 0.5, color = 0x22262e } = {}) {
  const g = new THREE.Group()
  const m = phys(color, { roughness: 0.4, sheen: 1, sheenColor: new THREE.Color(0x3050a0), sheenRoughness: 0.3 })
  const b = mesh(new THREE.SphereGeometry(7, 16, 12), m, 0, 0, 0); b.scale.set(1.6, 0.9, 0.9); g.add(b)
  g.add(mesh(new THREE.SphereGeometry(5, 14, 10), m, 11, 3, 0))
  const beak = mesh(new THREE.ConeGeometry(2, 8, 8), std(0xe0a020), 18, 2, 0); beak.rotation.z = -Math.PI / 2; g.add(beak)
  g.add(mesh(new THREE.SphereGeometry(1, 6, 6), std(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.5 }), 13.5, 4.5, 3))
  const tail = mesh(new THREE.ConeGeometry(5, 12, 4), m, -14, 1, 0); tail.rotation.z = Math.PI / 2; tail.scale.z = 0.3; g.add(tail)
  for (const side of [-1, 1]) {
    const w = new THREE.Group(); w.position.set(1, 3, side * 4); g.add(w)
    const wing = mesh(new THREE.SphereGeometry(10, 16, 8), m, -2, 0, side * 12); wing.scale.set(0.9, 0.18, 1.6); w.add(wing)
    const tip = mesh(new THREE.ConeGeometry(4, 16, 6), m, -5, 0, side * 28); tip.rotation.x = side * Math.PI / 2; tip.scale.set(1.2, 1, 0.3); w.add(tip)
    w.rotation.x = side * (-0.9 + flap * 1.6)
  }
  return g
}

/** Gun platform / auto-turret (the tripod thing in today's shot) */
export function turret({ aim = 0 } = {}) {
  const g = new THREE.Group()
  const metal = std(0x9aa4ae, { metalness: 0.75, roughness: 0.35 })
  const dark = std(0x2b3036, { metalness: 0.5, roughness: 0.5 })
  const pad = std(0xffffff, { map: stripeTex('#e0b020', '#1a1a1a', 8), roughness: 0.6 })
  g.add(box(88, 7, 30, 2, pad, 0, 3.5, 0))
  g.add(box(92, 3, 32, 1, dark, 0, 0.5, 0))
  for (const [x, z] of [[-24, 10], [24, 10], [0, -12]]) g.add(limb([x, 6, z], [0, 38, 0], 2.6, dark))
  g.add(mesh(new THREE.CylinderGeometry(8, 10, 8, 16), metal, 0, 40, 0))
  const head = new THREE.Group(); head.position.set(0, 50, 0); head.rotation.z = aim; g.add(head)
  head.add(box(40, 22, 26, 5, metal, -2, 0, 0))
  head.add(box(20, 8, 27, 3, std(0x1a2a3a, { emissive: 0x3070ff, emissiveIntensity: 1.2 }), 4, 4, 0))
  for (const z of [-6, 6]) { const br = mesh(new THREE.CylinderGeometry(2.8, 3.2, 34, 12), dark, 32, -2, z); br.rotation.z = Math.PI / 2; head.add(br) }
  head.add(rotZ(mesh(new THREE.CylinderGeometry(4.5, 4.5, 6, 12), dark, 48, -2, 0), Math.PI / 2))
  return g
}

/** Teleport gate: masonry ring + swirling portal (shader) */
export function gate({ r = 46, tint = [0.35, 0.6, 1.0] } = {}) {
  const g = new THREE.Group()
  const n = 18
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2
    const shade = 0.75 + ((i * 37) % 7) / 20
    const st = box(17, 13, 22, 2.5, std(new THREE.Color(0.42 * shade, 0.4 * shade, 0.38 * shade), { roughness: 0.9 }), Math.cos(a) * r, Math.sin(a) * r, 0)
    st.rotation.z = a + Math.PI / 2; g.add(st)
  }
  // runes
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.26; g.add(mesh(new THREE.BoxGeometry(4, 4, 2), std(0x000000, { emissive: new THREE.Color(...tint), emissiveIntensity: 4 }), Math.cos(a) * r, Math.sin(a) * r, 11.5)) }
  const portal = new THREE.Mesh(new THREE.CircleGeometry(r - 6, 64), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { tint: { value: new THREE.Vector3(...tint) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec2 vUv; uniform vec3 tint;
      float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
      void main(){ vec2 p=vUv*2.-1.; float r=length(p); float a=atan(p.y,p.x);
        float sw = a*2. + r*7.; float v = n(vec2(cos(sw)*2.+r*3., sin(sw)*2.)*2.) ;
        float v2 = n(vec2(a*3.+r*9., r*4.)) ;
        float core = smoothstep(0.7,0.0,r);
        vec3 c = tint*(0.25+1.4*v*v) + tint*pow(v2,3.)*1.2*(1.-r) + mix(tint, vec3(1.), 0.5)*core*core*0.6;
        c *= 0.8; float al = smoothstep(1.0,0.9,r);
        gl_FragColor = vec4(c, al*0.95); }`,
  }))
  portal.position.z = 1; g.add(portal)
  return g
}

/** Crystal cluster: flat-shaded glowing prisms */
export function crystals({ color = 0x3a7bff, n = 7, size = 1, seed = 1 } = {}) {
  const g = new THREE.Group()
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const m = phys(color, { flatShading: true, roughness: 0.15, metalness: 0.1, emissive: color, emissiveIntensity: 0.55, clearcoat: 1, transparent: true, opacity: 0.93 })
  for (let i = 0; i < n; i++) {
    const h = (26 + rnd() * 50) * size * (i === 0 ? 1.4 : 1), w = (5 + rnd() * 5) * size
    const c = new THREE.Group()
    c.add(mesh(new THREE.CylinderGeometry(w, w * 1.1, h, 6), m, 0, h / 2, 0))
    c.add(mesh(new THREE.ConeGeometry(w, w * 1.8, 6), m, 0, h + w * 0.9, 0))
    c.position.set((rnd() - 0.5) * 30 * size, -2, (rnd() - 0.5) * 20 * size)
    c.rotation.z = (rnd() - 0.5) * 1.1 - c.position.x * 0.012; c.rotation.x = (rnd() - 0.5) * 0.5; c.rotation.y = rnd() * 3
    g.add(c)
  }
  return g
}

/** Rocket, pointing +x */
export function rocket() {
  const g = new THREE.Group()
  const b = mesh(new THREE.CylinderGeometry(3.2, 3.2, 18, 12), std(0x6a7a48), 0, 0, 0); b.rotation.z = Math.PI / 2; g.add(b)
  const n = mesh(new THREE.ConeGeometry(3.2, 8, 12), std(0xc03020, { roughness: 0.4 }), 13, 0, 0); n.rotation.z = -Math.PI / 2; g.add(n)
  for (let i = 0; i < 4; i++) { const f = mesh(new THREE.BoxGeometry(6, 0.8, 5), std(0x333333), -8, 0, 0); f.rotation.x = i * Math.PI / 2; f.translateZ(3.5); g.add(f) }
  const fl = new THREE.Mesh(new THREE.ConeGeometry(3, 18, 10, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3, 1), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }))
  fl.rotation.z = Math.PI / 2; fl.position.x = -18; g.add(fl)
  return g
}

/** Small rock debris chunk */
export function debris(color = 0x7a6a5a, s = 1) {
  const m = mesh(new THREE.DodecahedronGeometry(3 * s, 0), std(color, { flatShading: true, roughness: 0.9 }))
  m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3); return m
}
