/**
 * The intro's world (M99, T99.03): sky, land, lander, the crew's figures, particles, post.
 * Built once; `intro.js` poses it for each instant. Split out of the T99.02 intro unchanged
 * except the hatch, which is now a hatch and a ramp (see `door`).
 */
import * as THREE from 'three'
import { RAMP } from './beats.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

export const W = 1920
export const H = 1080

// --- helpers -------------------------------------------------------------------------------
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
export const lerp = (a, b, u) => a + (b - a) * u
export const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u) }
export const easeOut = (u) => 1 - Math.pow(1 - clamp(u), 3)
export function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** Smooth deterministic noise for camera shake. */
export const shakeN = (t, k) => Math.sin(t * 37.1 + k) * 0.5 + Math.sin(t * 61.7 + k * 2.3) * 0.3 + Math.sin(t * 93.3 + k * 4.1) * 0.2

// --- renderer ------------------------------------------------------------------------------
export const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
document.body.appendChild(renderer.domElement)

export const scene = new THREE.Scene()
scene.fog = new THREE.FogExp2(0x2c2250, 0.0105)
export const camera = new THREE.PerspectiveCamera(40, W / H, 0.05, 2000)

// --- sky -----------------------------------------------------------------------------------
{
  const g = new THREE.SphereGeometry(900, 48, 24)
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {},
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `varying vec3 vP;
      void main(){
        float h = vP.y;
        vec3 top = vec3(0.02,0.03,0.11);
        vec3 mid = vec3(0.16,0.12,0.36);
        vec3 hor = vec3(0.50,0.38,0.66);
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.18, h));
        c = mix(c, top, smoothstep(0.15, 0.7, h));
        c += vec3(0.25,0.12,0.30) * exp(-abs(h) * 14.0) * 0.6;
        gl_FragColor = vec4(c, 1.);
      }`,
  })
  scene.add(new THREE.Mesh(g, m))
  // Stars.
  const r = rng(7)
  const pos = []
  for (let i = 0; i < 1800; i++) {
    const th = r() * Math.PI * 2
    const y = 0.12 + r() * 0.88
    const s = Math.sqrt(1 - y * y)
    pos.push(Math.cos(th) * s * 850, y * 850, Math.sin(th) * s * 850)
  }
  const sg = new THREE.BufferGeometry()
  sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xdfe4ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 })))
  // Two moons, as in the game's sky: a big cream one and a small rose one.
  const moon = (r0, col, x, y, z) => {
    const mm = new THREE.Mesh(new THREE.SphereGeometry(r0, 48, 32), new THREE.MeshBasicMaterial({ color: col, fog: false }))
    mm.position.set(x, y, z)
    scene.add(mm)
    return mm
  }
  moon(60, 0xe8e2c8, 260, 250, -720)
  moon(18, 0xd9a8a0, -330, 330, -640)
}

// --- land ----------------------------------------------------------------------------------
const rock = new THREE.MeshStandardMaterial({ color: 0x2b2735, roughness: 0.95, metalness: 0.05 })
{
  const g = new THREE.PlaneGeometry(700, 700, 220, 220)
  g.rotateX(-Math.PI / 2)
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const z = p.getZ(i)
    const d = Math.hypot(x, z)
    const far = smooth(25, 90, d)
    const h =
      Math.sin(x * 0.21) * Math.cos(z * 0.17) * 0.25 +
      Math.sin(x * 0.043 + 1) * Math.cos(z * 0.05) * 3.5 * far +
      Math.sin(x * 0.011) * 14 * smooth(90, 220, d)
    p.setY(i, h)
  }
  g.computeVertexNormals()
  const ground = new THREE.Mesh(g, rock)
  ground.receiveShadow = true
  scene.add(ground)
}
// Stepped pyramids on the horizon — the game's background silhouettes, in three dimensions.
{
  const mat = new THREE.MeshStandardMaterial({ color: 0x5b4a8e, roughness: 1 })
  const r = rng(11)
  const spots = [[-160, -320, 90], [40, -420, 130], [210, -300, 70], [-330, -250, 60], [360, -470, 120], [-40, -260, 45]]
  for (const [x, z, s] of spots) {
    const steps = 9
    for (let k = 0; k < steps; k++) {
      const w = s * 2 * (1 - k / steps)
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, s / steps * 1.6, w * (0.6 + r() * 0.3)), mat)
      box.position.set(x, (k + 0.5) * (s / steps) * 1.6 - 4, z)
      scene.add(box)
    }
  }
}
// Rocks, teal grass, blue crystals.
export const glowBits = []
{
  const r = rng(21)
  const rockG = new THREE.DodecahedronGeometry(1, 0)
  for (let i = 0; i < 140; i++) {
    const a = r() * Math.PI * 2
    const d = 8 + r() * 70
    const m = new THREE.Mesh(rockG, rock)
    const s = 0.3 + r() * r() * 2.4
    m.scale.set(s, s * (0.5 + r() * 0.8), s)
    m.position.set(Math.cos(a) * d, s * 0.2, Math.sin(a) * d - 5)
    m.rotation.set(r() * 3, r() * 3, r() * 3)
    // Keep the crew's ground and the close shots' sightlines clear (after drawing, so the rest
    // of the field is the same as before).
    if (m.position.x > -8 && m.position.x < 10 && m.position.z > 4 && m.position.z < 24) continue
    m.castShadow = true
    m.receiveShadow = true
    scene.add(m)
  }
  const grassM = new THREE.MeshStandardMaterial({ color: 0x3f9a86, roughness: 0.8, emissive: 0x0d3a32, emissiveIntensity: 0.6 })
  const blade = new THREE.ConeGeometry(0.035, 0.45, 4)
  blade.translate(0, 0.22, 0)
  const grass = new THREE.InstancedMesh(blade, grassM, 2600)
  const o = new THREE.Object3D()
  for (let i = 0; i < 2600; i++) {
    const cx = (r() - 0.5) * 60
    const cz = (r() - 0.5) * 50 + 2
    if (Math.hypot(cx, cz) < 4.5) { o.scale.set(0, 0, 0) } else {
      o.position.set(cx + (r() - 0.5), 0, cz + (r() - 0.5))
      o.rotation.set((r() - 0.5) * 0.5, r() * 3, (r() - 0.5) * 0.5)
      const s = 0.5 + r() * 1.3
      o.scale.set(s, s, s)
    }
    o.updateMatrix()
    grass.setMatrixAt(i, o.matrix)
  }
  scene.add(grass)
  const crysM = new THREE.MeshStandardMaterial({ color: 0x2c6bff, emissive: 0x2a5cff, emissiveIntensity: 2.2, roughness: 0.3 })
  const crysG = new THREE.OctahedronGeometry(0.35, 0)
  crysG.scale(0.6, 2.2, 0.6)
  for (const [x, z] of [[-6, 3], [9, -2], [-11, -8], [4.5, 9.5], [-3.5, 11]]) {
    const cl = new THREE.Group()
    for (let k = 0; k < 4; k++) {
      const c = new THREE.Mesh(crysG, crysM)
      c.position.set((k % 2 - 0.5) * 0.4, 0.5, (k > 1 ? 0.3 : -0.2))
      c.rotation.set((k - 1.5) * 0.3, k, (k % 2 - 0.5) * 0.6)
      c.scale.setScalar(0.7 + k * 0.15)
      cl.add(c)
    }
    cl.position.set(x, 0, z)
    scene.add(cl)
    const l = new THREE.PointLight(0x3b6bff, 6, 9, 1.6)
    l.position.set(x, 1.2, z)
    scene.add(l)
    glowBits.push(l)
  }
}

// --- light ---------------------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0x8b7cd8, 0x1a1420, 0.9))
const moonLight = new THREE.DirectionalLight(0xd8d4ff, 1.6)
moonLight.position.set(30, 40, -40)
moonLight.castShadow = true
moonLight.shadow.mapSize.set(2048, 2048)
Object.assign(moonLight.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 150 })
moonLight.shadow.bias = -0.0005
scene.add(moonLight)
const rim = new THREE.DirectionalLight(0xb07cff, 0.8)
rim.position.set(-30, 10, -30)
scene.add(rim)

// --- the lander ----------------------------------------------------------------------------
export const lander = new THREE.Group()
const hull = new THREE.MeshStandardMaterial({ color: 0xc9ccd6, roughness: 0.45, metalness: 0.6 })
const dark = new THREE.MeshStandardMaterial({ color: 0x33363f, roughness: 0.6, metalness: 0.5 })
const stripe = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5, metalness: 0.2, emissive: 0x3a1400 })
const windowM = new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffc070, emissiveIntensity: 2.4 })
/** The door's geometry, shared with the crew's walk down it. */
export const HINGE_Y = RAMP.hingeY
export const HINGE_Z = RAMP.hingeZ
export const HATCH_LEN = 3.2
export const EXT_LEN = 3.0
export const RAMP_SLOPE = RAMP.slope // radians below horizontal, when down
/** From hinge to foot when the ramp is fully out: the foot is on the ground. */
export const RAMP_LEN = RAMP.len
export let door
export let thrusterGlow
export let thrusterLight
export let bayLight
{
  const add = (m, parent = lander) => { m.castShadow = true; m.receiveShadow = true; parent.add(m); return m }
  add(new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.6, 3.4, 32), hull)).position.y = 3.7
  add(new THREE.Mesh(new THREE.CylinderGeometry(3.62, 3.62, 0.35, 32), stripe)).position.y = 2.6
  add(new THREE.Mesh(new THREE.ConeGeometry(3.2, 2.6, 32), hull)).position.y = 6.7
  add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.8, 16), dark)).position.y = 8.3
  add(new THREE.Mesh(new THREE.CylinderGeometry(3.0, 2.2, 1.0, 32), dark)).position.y = 1.5
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3
    const w = add(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.1), windowM))
    w.position.set(Math.sin(a) * 3.28, 4.7, Math.cos(a) * 3.28)
    w.rotation.y = a
  }
  // Four legs.
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4
    const leg = add(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 3.6, 8), dark))
    leg.position.set(Math.sin(a) * 3.9, 1.3, Math.cos(a) * 3.9)
    leg.rotation.set(Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5)
    const pad = add(new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.18, 16), dark))
    pad.position.set(Math.sin(a) * 4.7, 0.09, Math.cos(a) * 4.7)
  }
  // The door. A hatch hinged at its foot swings out and down until its outer face faces the
  // ground, sloping at RAMP_SLOPE; then a ramp slides out of it along the slope until its foot
  // is on the ground. The bay is a lit box standing proud of the hull so it shows when open.
  const bay = add(new THREE.Mesh(new THREE.BoxGeometry(2.0, 3.1, 0.6), new THREE.MeshStandardMaterial({ color: 0x3a2a18, emissive: 0x7a4a26, emissiveIntensity: 0.6 })))
  bay.position.set(0, 3.7, 3.42)
  // The bay's ceiling strip: the one bright thing inside, so the opening reads as a room.
  const strip = add(new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 0.62), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd6a0, emissiveIntensity: 2.5 })))
  strip.position.set(0, 5.1, 3.44)
  const frame = add(new THREE.Mesh(new THREE.BoxGeometry(2.5, 3.5, 0.5), dark))
  frame.position.set(0, 3.75, 3.36)
  const hinge = new THREE.Group()
  hinge.position.set(0, HINGE_Y, HINGE_Z)
  const hp = add(new THREE.Mesh(new THREE.BoxGeometry(2.1, HATCH_LEN, 0.14), hull), hinge)
  hp.position.set(0, HATCH_LEN / 2, 0.07)
  // The hatch's inner face: a dark tread plate with orange edge stripes.
  const tread = add(new THREE.Mesh(new THREE.BoxGeometry(1.9, HATCH_LEN - 0.1, 0.02), dark), hinge)
  tread.position.set(0, HATCH_LEN / 2, -0.005)
  for (const x of [-0.98, 0.98]) add(new THREE.Mesh(new THREE.BoxGeometry(0.08, HATCH_LEN - 0.1, 0.03), stripe), hinge).position.set(x, HATCH_LEN / 2, -0.01)
  const ext = new THREE.Group()
  const ep = add(new THREE.Mesh(new THREE.BoxGeometry(1.7, EXT_LEN, 0.09), hull), ext)
  ep.position.set(0, 0, 0)
  const etread = add(new THREE.Mesh(new THREE.BoxGeometry(1.5, EXT_LEN - 0.1, 0.02), dark), ext)
  etread.position.set(0, 0, -0.05)
  for (let k = 0; k < 9; k++) add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.03), stripe), ext).position.set(0, -EXT_LEN / 2 + 0.2 + k * 0.33, -0.065)
  ext.position.z = -0.065
  hinge.add(ext)
  lander.add(hinge)
  door = { hinge, ext }
  bayLight = new THREE.SpotLight(0xffc890, 0, 26, 0.75, 0.6, 1.2)
  bayLight.position.set(0, 4.4, 3.2)
  bayLight.target.position.set(0, 0, 10)
  lander.add(bayLight, bayLight.target)
  // The thruster.
  thrusterGlow = new THREE.Mesh(
    new THREE.ConeGeometry(1.6, 5, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
  )
  thrusterGlow.rotation.x = Math.PI
  thrusterGlow.position.y = -1.4
  lander.add(thrusterGlow)
  thrusterLight = new THREE.PointLight(0xff8a30, 0, 60, 1.4)
  thrusterLight.position.y = -1
  lander.add(thrusterLight)
}
scene.add(lander)

// --- the crew ------------------------------------------------------------------------------
function capsule(r, len, mat) {
  const g = new THREE.CapsuleGeometry(r, len, 6, 12)
  g.translate(0, -len / 2, 0)
  const m = new THREE.Mesh(g, mat)
  m.castShadow = true
  return m
}
/** A stick figure in an expedition suit, built from pivots so a pose is a handful of angles. */
export class Figure {
  constructor(color = 0xd9d9e0) {
    this.suit = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.0 })
    this.root = new THREE.Group()
    this.hips = new THREE.Group()
    this.hips.position.y = 0.95
    this.root.add(this.hips)
    this.torso = new THREE.Group()
    this.hips.add(this.torso)
    const body = capsule(0.07, 0.62, this.suit)
    body.rotation.x = Math.PI
    body.position.y = 0
    this.torso.add(body)
    this.chest = body
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.16), this.suit)
    pack.position.set(0, 0.42, -0.16)
    pack.castShadow = true
    this.torso.add(pack)
    this.pack = pack
    this.neck = new THREE.Group()
    this.neck.position.y = 0.72
    this.torso.add(this.neck)
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 16), this.suit)
    this.head.position.y = 0.2
    this.head.castShadow = true
    this.neck.add(this.head)
    // Eyes: dark until the turn, when they burn.
    this.eyeM = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false })
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), this.eyeM)
      e.position.set(s * 0.06, 0.03, 0.155)
      e.scale.set(1.5, 0.6, 0.6)
      this.head.add(e)
    }
    this.helmet = new THREE.Group()
    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(0.29, 32, 24),
      new THREE.MeshPhysicalMaterial({ color: 0xdde6ff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22, clearcoat: 1 }),
    )
    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(0.295, 32, 24, -0.9, 1.8, 0.9, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x120c22, roughness: 0.08, metalness: 1, envMapIntensity: 1 }),
    )
    visor.rotation.y = 0
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.04, 8, 24), this.suit)
    ring.rotation.x = Math.PI / 2
    ring.position.y = -0.2
    this.helmet.add(glass, visor, ring)
    this.helmet.position.y = 0.2
    this.neck.add(this.helmet)
    const limb = (x, y, upLen, loLen, r) => {
      const up = new THREE.Group()
      up.position.set(x, y, 0)
      up.add(capsule(r, upLen, this.suit))
      const lo = new THREE.Group()
      lo.position.y = -upLen
      lo.add(capsule(r * 0.9, loLen, this.suit))
      up.add(lo)
      return [up, lo]
    }
    ;[this.armL, this.foreL] = limb(0.15, 0.62, 0.3, 0.3, 0.038)
    ;[this.armR, this.foreR] = limb(-0.15, 0.62, 0.3, 0.3, 0.038)
    this.torso.add(this.armL, this.armR)
    ;[this.legL, this.shinL] = limb(0.08, 0, 0.44, 0.44, 0.048)
    ;[this.legR, this.shinR] = limb(-0.08, 0, 0.44, 0.44, 0.048)
    this.hips.add(this.legL, this.legR)
    // Gloved fists, and a thumb on the right one (for the thumbs-up).
    for (const fore of [this.foreL, this.foreR]) {
      const h = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 10), this.suit)
      h.position.y = -0.34
      h.castShadow = true
      fore.add(h)
    }
    this.thumb = capsule(0.024, 0.07, this.suit)
    this.thumb.position.set(0, -0.36, 0.035)
    this.foreR.add(this.thumb)
    this.armL.rotation.z = 0.3
    this.armR.rotation.z = -0.3
    scene.add(this.root)
  }
  /** A walk cycle at `phase` (radians) with `amt` of stride; 0 is standing. */
  walk(phase, amt) {
    const s = Math.sin(phase)
    this.legL.rotation.x = s * 0.55 * amt
    this.legR.rotation.x = -s * 0.55 * amt
    this.shinL.rotation.x = Math.max(0, -Math.cos(phase)) * 0.9 * amt
    this.shinR.rotation.x = Math.max(0, Math.cos(phase)) * 0.9 * amt
    this.armL.rotation.x = -s * 0.5 * amt
    this.armR.rotation.x = s * 0.5 * amt
    this.foreL.rotation.x = -0.35 * amt
    this.foreR.rotation.x = -0.35 * amt
    this.hips.position.y = 0.95 - Math.abs(Math.cos(phase)) * 0.04 * amt
    this.torso.rotation.x = 0.06 * amt
  }
}

export const crew = [new Figure(), new Figure(), new Figure(), new Figure()]
export const hero = crew[1]
// The scarf he wears after the turn — the game's scarf, in blood red.
const scarfM = new THREE.MeshStandardMaterial({ color: 0xd01818, emissive: 0x500000, roughness: 0.7, side: THREE.DoubleSide })
export const scarfG = new THREE.PlaneGeometry(0.9, 0.09, 24, 1)
scarfG.translate(-0.45, 0, 0)
export const scarf = new THREE.Mesh(scarfG, scarfM)
scarf.position.set(0, 0.62, -0.02)
scarf.visible = false
hero.torso.add(scarf)
export const scarfBase = Float32Array.from(scarfG.attributes.position.array)

// --- particles: spores, dust, breath -------------------------------------------------------
/** A soft round sprite, so particles read as motes, not pixels. */
export const dot = (() => {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  r.addColorStop(0, 'rgba(255,255,255,1)')
  r.addColorStop(0.35, 'rgba(255,255,255,0.55)')
  r.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = r
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
})()
export function points(n, color, size, blending = THREE.AdditiveBlending) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
  const m = new THREE.PointsMaterial({ color, size, map: dot, transparent: true, opacity: 1, depthWrite: false, blending, sizeAttenuation: true })
  const p = new THREE.Points(g, m)
  p.frustumCulled = false
  scene.add(p)
  return p
}
export const spores = points(900, 0x7dffd0, 0.12)
export const sporeSeed = (() => { const r = rng(31); return Array.from({ length: 900 }, () => [r(), r(), r(), r()]) })()
export const dust = points(1400, 0x8a78a8, 1.6, THREE.NormalBlending)
export const dustSeed = (() => { const r = rng(41); return Array.from({ length: 1400 }, () => [r(), r(), r()]) })()
export const breath = points(260, 0x7a2ab8, 0.12)
export const breathSeed = (() => { const r = rng(51); return Array.from({ length: 260 }, () => [r(), r(), r()]) })()

// --- post: bloom, then a grade with chromatic split, vignette, flash (no grain — owner) ------------------
export const composer = new EffectComposer(renderer)
composer.setSize(W, H)
composer.addPass(new RenderPass(scene, camera))
export const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.8, 0.5, 0.9)
composer.addPass(bloom)
export const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uSplit: { value: 0 }, uSeed: { value: 0 }, uFlash: { value: 0 }, uFade: { value: 1 }, uGlitch: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSplit, uSeed, uFlash, uFade, uGlitch; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uSeed) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      float band = step(0.93, h(vec2(floor(uv.y * 40.0), uSeed))) * uGlitch;
      uv.x += band * (h(vec2(uSeed, floor(uv.y * 40.0))) - 0.5) * 0.12;
      vec2 d = (uv - 0.5) * uSplit;
      vec3 c = vec3(texture2D(tDiffuse, uv + d).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - d).b);
      float v = smoothstep(1.05, 0.35, length((vUv - 0.5) * vec2(1.1, 1.0)));
      c *= mix(0.55, 1.0, v);
      // Film grain removed (owner, 2026-10-02).
      c = mix(c, vec3(1.0), uFlash);
      gl_FragColor = vec4(c * uFade, 1.0);
    }`,
})
composer.addPass(grade)
composer.addPass(new OutputPass())

