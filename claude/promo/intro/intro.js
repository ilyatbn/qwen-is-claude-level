/**
 * The prequel (M99, T99.04): the expedition lands, the air is breathed, a man turns.
 *
 * Every frame is a pure function of `t` — `window.renderAt(t)` — so the render script can step
 * it at exactly 60 fps however long each frame takes, and a re-render is the same film.
 * The world borrows the game's backdrop on purpose: stepped purple pyramids, two moons, blue
 * crystals, dark rock with teal grass — so the cut to gameplay reads as the same planet.
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

const W = 1920
const H = 1080
const T = { land: 3.2, crewShot: 4.6, inhale: 8.8, helmetOff: 9.7, breathe: 10.1, exhale: 11.6, turn: 12.4, black: 13.2, end: 14.4 }

// --- helpers -------------------------------------------------------------------------------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const lerp = (a, b, u) => a + (b - a) * u
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u) }
const easeOut = (u) => 1 - Math.pow(1 - clamp(u), 3)
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** Smooth deterministic noise for camera shake. */
const shakeN = (t, k) => Math.sin(t * 37.1 + k) * 0.5 + Math.sin(t * 61.7 + k * 2.3) * 0.3 + Math.sin(t * 93.3 + k * 4.1) * 0.2

// --- renderer ------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H)
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.fog = new THREE.FogExp2(0x2c2250, 0.0105)
const camera = new THREE.PerspectiveCamera(40, W / H, 0.05, 2000)

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
const glowBits = []
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
const lander = new THREE.Group()
const hull = new THREE.MeshStandardMaterial({ color: 0xc9ccd6, roughness: 0.45, metalness: 0.6 })
const dark = new THREE.MeshStandardMaterial({ color: 0x33363f, roughness: 0.6, metalness: 0.5 })
const stripe = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5, metalness: 0.2, emissive: 0x3a1400 })
const windowM = new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffc070, emissiveIntensity: 2.4 })
let ramp
let thrusterGlow
let thrusterLight
let bayLight
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
  // The ramp, hinged at its foot on the camera side (+z); the bay light behind it.
  const hinge = new THREE.Group()
  hinge.position.set(0, 2.1, 3.35)
  const rp = add(new THREE.Mesh(new THREE.BoxGeometry(2.0, 3.2, 0.14), hull), hinge)
  rp.position.y = 1.6
  lander.add(hinge)
  ramp = hinge
  const bay = add(new THREE.Mesh(new THREE.PlaneGeometry(1.9, 3.1), new THREE.MeshStandardMaterial({ color: 0xffe9c8, emissive: 0xffd9a0, emissiveIntensity: 1.8 })))
  bay.position.set(0, 3.7, 3.18)
  bayLight = new THREE.SpotLight(0xffd9a0, 0, 22, 0.7, 0.6, 1.2)
  bayLight.position.set(0, 4.2, 2.6)
  bayLight.target.position.set(0, 0, 9)
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
class Figure {
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
    this.eyeM = new THREE.MeshBasicMaterial({ color: 0x000000 })
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

const crew = [new Figure(), new Figure(), new Figure(), new Figure()]
const hero = crew[1]
// The scarf he wears after the turn — the game's scarf, in blood red.
const scarfM = new THREE.MeshStandardMaterial({ color: 0xd01818, emissive: 0x500000, roughness: 0.7, side: THREE.DoubleSide })
const scarfG = new THREE.PlaneGeometry(0.9, 0.09, 24, 1)
scarfG.translate(-0.45, 0, 0)
const scarf = new THREE.Mesh(scarfG, scarfM)
scarf.position.set(0, 0.62, -0.02)
scarf.visible = false
hero.torso.add(scarf)
const scarfBase = Float32Array.from(scarfG.attributes.position.array)

// --- particles: spores, dust, breath -------------------------------------------------------
/** A soft round sprite, so particles read as motes, not pixels. */
const dot = (() => {
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
function points(n, color, size, blending = THREE.AdditiveBlending) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
  const m = new THREE.PointsMaterial({ color, size, map: dot, transparent: true, opacity: 1, depthWrite: false, blending, sizeAttenuation: true })
  const p = new THREE.Points(g, m)
  p.frustumCulled = false
  scene.add(p)
  return p
}
const spores = points(900, 0x7dffd0, 0.12)
const sporeSeed = (() => { const r = rng(31); return Array.from({ length: 900 }, () => [r(), r(), r(), r()]) })()
const dust = points(1400, 0x8a78a8, 1.6, THREE.NormalBlending)
const dustSeed = (() => { const r = rng(41); return Array.from({ length: 1400 }, () => [r(), r(), r()]) })()
const breath = points(260, 0x7a2ab8, 0.12)
const breathSeed = (() => { const r = rng(51); return Array.from({ length: 260 }, () => [r(), r(), r()]) })()

// --- post: bloom, then a grade with chromatic split, grain, vignette, flash ------------------
const composer = new EffectComposer(renderer)
composer.setSize(W, H)
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.8, 0.5, 0.9)
composer.addPass(bloom)
const grade = new ShaderPass({
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
      c += (h(vUv * 1000.0) - 0.5) * 0.05;
      c = mix(c, vec3(1.0), uFlash);
      gl_FragColor = vec4(c * uFade, 1.0);
    }`,
})
composer.addPass(grade)
composer.addPass(new OutputPass())

// --- the film ------------------------------------------------------------------------------
const cap = document.getElementById('cap')
function caption(t, text, a, b, cls = '') {
  if (t < a || t > b) return false
  cap.className = cls
  cap.textContent = text
  cap.style.opacity = String(Math.min(smooth(a, a + 0.35, t), 1 - smooth(b - 0.35, b, t)))
  return true
}

const crewSpots = [[-2.6, 7.2], [1.2, 8.6], [3.4, 6.6], [-0.6, 10.2]]

function placeCrew(t) {
  // Down the ramp and out, one after another, from t = 5.3.
  crew.forEach((f, i) => {
    const t0 = 5.3 + i * 0.5
    const u = t - t0
    const top = new THREE.Vector3(0, 3.1, 3.3)
    const foot = new THREE.Vector3(0, 0, 6.6)
    const dest = new THREE.Vector3(crewSpots[i][0], 0, crewSpots[i][1])
    let p
    let walking = 1
    if (u < 0) p = top.clone().setY(3.1 - 0.0).add(new THREE.Vector3(0, 0, -1.2))
    else if (u < 1.6) p = top.clone().lerp(foot, u / 1.6)
    else if (u < 3.4) p = foot.clone().lerp(dest, easeOut((u - 1.6) / 1.8))
    else { p = dest.clone(); walking = 0 }
    walking *= 1 - smooth(3.0, 3.4, u)
    f.root.position.copy(p)
    f.root.visible = u > -0.3
    const face = u < 1.6 ? 0 : Math.atan2(dest.x - foot.x, dest.z - foot.z) * (1 - smooth(2.8, 3.6, u))
    f.root.rotation.y = face
    f.walk(u * 7.5, walking)
  })
}

function heroClose(t) {
  // The breath: arms up, helmet off, inhale, exhale — then the turn.
  const f = hero
  f.walk(0, 0)
  const up = smooth(T.inhale, T.inhale + 0.6, t) * (1 - smooth(T.breathe, T.breathe + 0.5, t))
  f.armL.rotation.x = -2.6 * up
  f.armR.rotation.x = -2.6 * up
  f.armL.rotation.z = 0.3 + 0.2 * up
  f.armR.rotation.z = -0.3 - 0.2 * up
  f.foreL.rotation.x = -1.2 * up
  f.foreR.rotation.x = -1.2 * up
  const off = smooth(T.helmetOff - 0.2, T.breathe + 0.2, t)
  f.helmet.position.set(0, 0.2 + off * 0.9, -off * 0.5)
  f.helmet.rotation.x = -off * 0.8
  f.helmet.visible = off < 0.95
  const inh = smooth(T.breathe, T.exhale, t) * (1 - smooth(T.exhale, T.exhale + 0.6, t))
  f.neck.rotation.x = -0.35 * inh + 0.25 * smooth(T.exhale, T.exhale + 0.5, t) * (1 - smooth(T.black - 0.1, T.black + 0.15, t))
  f.chest.scale.set(1 + 0.25 * inh, 1, 1 + 0.25 * inh)
  f.torso.rotation.x = -0.08 * inh
}

function turn(t) {
  // White to black in flickers, then black; the eyes ignite; the scarf unfurls.
  const u = smooth(T.turn, T.black, t)
  const flick = Math.sin(t * 90) * Math.sin(t * 57) > 1 - 2 * u
  const black = t >= T.black || (t > T.turn && flick)
  hero.suit.color.set(black ? 0x07070a : 0xd9d9e0)
  hero.suit.roughness = black ? 0.85 : 0.75
  const eye = smooth(T.black - 0.1, T.black + 0.25, t)
  hero.eyeM.color.setRGB(3.2 * eye, 0.08 * eye, 0.03 * eye)
  hero.pack.visible = t < T.black
  scarf.visible = t > T.black
  if (scarf.visible) {
    const a = scarfG.attributes.position
    const grow = smooth(T.black, T.black + 0.5, t)
    for (let i = 0; i < a.count; i++) {
      const x0 = scarfBase[i * 3]
      const k = -x0 / 0.9
      a.setX(i, x0 * grow)
      a.setY(i, scarfBase[i * 3 + 1] + Math.sin(t * 14 - k * 7) * 0.06 * k - k * 0.05)
      a.setZ(i, -k * 0.35 * grow + Math.cos(t * 11 - k * 6) * 0.05 * k)
    }
    a.needsUpdate = true
  }
}

function particles(t) {
  // Spores drift everywhere; during the breath the near ones stream into his mouth.
  const sp = spores.geometry.attributes.position
  const mouth = new THREE.Vector3()
  hero.head.getWorldPosition(mouth)
  mouth.add(new THREE.Vector3(0, -0.04, 0.16).applyQuaternion(hero.root.quaternion))
  const pull = smooth(T.breathe - 0.1, T.breathe + 0.8, t) * (1 - smooth(T.exhale - 0.2, T.exhale, t))
  for (let i = 0; i < sporeSeed.length; i++) {
    const [a, b, c, d] = sporeSeed[i]
    const near = i < 420
    const cx = near ? mouth.x + (a - 0.5) * 3.2 : (a - 0.5) * 40
    const cz = near ? mouth.z + (b - 0.5) * 3.2 : (b - 0.5) * 34 + 3
    let x = cx + Math.sin(t * (0.3 + c) + d * 9) * 0.4
    let y = (near ? mouth.y - 0.8 : 0.2) + c * (near ? 1.8 : 4) + Math.sin(t * 0.7 + a * 12) * 0.25
    let z = cz + Math.cos(t * (0.25 + d) + c * 7) * 0.4
    if (near && pull > 0) {
      // Each spore leaves on its own schedule, spiralling in.
      const k = clamp((pull * 1.6 - d * 0.8))
      const e = k * k
      const ang = e * 5 + a * 6
      const r = (1 - e) * 0.25
      x = lerp(x, mouth.x + Math.cos(ang) * r, e)
      y = lerp(y, mouth.y + Math.sin(ang) * r * 0.5, e)
      z = lerp(z, mouth.z + Math.sin(ang) * r, e)
      if (k >= 1) y = -50
    }
    sp.setXYZ(i, x, y, z)
  }
  sp.needsUpdate = true
  spores.material.size = t > T.inhale - 0.3 ? 0.05 : 0.14
  // Touchdown dust: a ring blown outward.
  const dp = dust.geometry.attributes.position
  const du = t - (T.land - 0.25)
  for (let i = 0; i < dustSeed.length; i++) {
    const [a, b, c] = dustSeed[i]
    if (du < 0) { dp.setXYZ(i, 0, -50, 0); continue }
    const ang = a * Math.PI * 2
    const r = 3 + (1 - Math.exp(-du * (1.2 + b * 2))) * (6 + b * 14)
    dp.setXYZ(i, Math.cos(ang) * r, 0.2 + c * 2.2 * (1 - Math.exp(-du * 2)) + du * 0.2, Math.sin(ang) * r)
  }
  dp.needsUpdate = true
  dust.material.opacity = 0.1 * (du > 0 ? Math.exp(-du * 0.6) : 0)
  // The exhale: a dark purple breath out of him.
  const bp = breath.geometry.attributes.position
  const bu = t - T.exhale
  const fwd = new THREE.Vector3(0, -0.2, 1).applyQuaternion(hero.root.quaternion)
  for (let i = 0; i < breathSeed.length; i++) {
    const [a, b, c] = breathSeed[i]
    const s = bu - a * 0.5
    if (s < 0 || bu > 1.6) { bp.setXYZ(i, 0, -50, 0); continue }
    const d = s * (0.9 + b)
    bp.setXYZ(i, mouth.x + fwd.x * d + (b - 0.5) * d * 0.8, mouth.y + fwd.y * d + (c - 0.5) * d * 0.5, mouth.z + fwd.z * d + (c - 0.5) * d * 0.8)
  }
  bp.needsUpdate = true
  breath.material.opacity = bu > 0 ? 0.9 * Math.exp(-bu * 1.2) : 0
}

function shot(t) {
  // Returns [camera position, look-at target, fov, shake amount].
  if (t < T.crewShot) {
    const u = t / T.crewShot
    const pos = new THREE.Vector3(lerp(-4, 3, u), lerp(1.4, 2.2, u), lerp(34, 26, u))
    const land = lander.position.y
    const look = new THREE.Vector3(0, lerp(10, 3.5, easeOut(u * 1.1)) + land * 0.35, 0)
    const sh = Math.exp(-Math.max(0, t - T.land) * 2.2) * (t > T.land ? 0.35 : 0) + (t < T.land ? 0.03 : 0)
    return [pos, look, 38, sh]
  }
  if (t < T.inhale) {
    const u = (t - T.crewShot) / (T.inhale - T.crewShot)
    const pos = new THREE.Vector3(lerp(9.5, 7.5, u), lerp(1.3, 1.6, u), lerp(15, 13.5, u))
    const look = new THREE.Vector3(lerp(0.6, 0.2, u), 1.6, lerp(4.5, 7, u))
    return [pos, look, 36, 0.005]
  }
  const hp = hero.root.position
  if (t < T.turn) {
    // Close-up, slow push.
    const u = (t - T.inhale) / (T.turn - T.inhale)
    const d = lerp(2.6, 1.9, u)
    const pos = new THREE.Vector3(hp.x + 0.45, 1.9, hp.z + d)
    const look = new THREE.Vector3(hp.x, 1.8, hp.z)
    return [pos, look, 30, 0.004]
  }
  if (t < T.black) {
    // The turn: the push becomes a lurch.
    const u = (t - T.turn) / (T.black - T.turn)
    const pos = new THREE.Vector3(hp.x + 0.35 - u * 0.25, 1.88, hp.z + lerp(1.9, 1.5, u))
    return [pos, new THREE.Vector3(hp.x, 1.8, hp.z), 30, 0.02 + u * 0.03]
  }
  // Black: a crash-zoom onto the eyes.
  const u = smooth(T.black, T.end - 0.3, t)
  const pos = new THREE.Vector3(hp.x + 0.05, 1.86, hp.z + lerp(1.45, 1.0, u))
  return [pos, new THREE.Vector3(hp.x, 1.82, hp.z), lerp(30, 24, u), 0.03]
}

window.renderAt = (t) => {
  // The lander comes down on a decelerating thrust and settles.
  const u = clamp(t / T.land)
  lander.position.y = t < T.land ? 45 * Math.pow(1 - u, 2.4) : -0.12 * Math.exp(-(t - T.land) * 5) * Math.cos((t - T.land) * 20)
  const burn = t < T.land + 0.15 ? 1 : Math.exp(-(t - T.land - 0.15) * 8)
  thrusterGlow.visible = burn > 0.02
  thrusterGlow.scale.set(1, 0.7 + 0.3 * Math.sin(t * 60) + (t < T.land ? 0.4 * (1 - u) : 0), 1)
  thrusterGlow.material.opacity = 0.75 * burn
  thrusterLight.intensity = 900 * burn
  ramp.rotation.x = lerp(0, 1.28, smooth(4.7, 5.5, t))
  bayLight.intensity = 60 * smooth(4.7, 5.3, t)

  placeCrew(t)
  if (t >= T.inhale - 0.5) {
    crew.forEach((f, i) => { if (f !== hero) f.root.rotation.y = lerp(f.root.rotation.y, Math.atan2(hero.root.position.x - f.root.position.x, hero.root.position.z - f.root.position.z), smooth(T.turn, T.black, t)) })
    hero.root.rotation.y = 0
    heroClose(t)
  }
  turn(t)
  particles(t)
  for (const [k, l] of glowBits.entries()) l.intensity = 6 + Math.sin(t * 2 + k) * 1.5

  const [pos, look, fov, shake] = shot(t)
  pos.x += shakeN(t, 1) * shake
  pos.y += shakeN(t, 2) * shake
  camera.position.copy(pos)
  camera.lookAt(look)
  camera.fov = fov
  camera.updateProjectionMatrix()

  // Grade: the turn glitches and splits, a flash on touchdown and at the ignition.
  const glitch = t > T.turn && t < T.black + 0.3 ? 0.6 + 0.4 * Math.sin(t * 40) : 0
  grade.uniforms.uSeed.value = Math.floor(t * 60) * 0.137
  grade.uniforms.uGlitch.value = glitch
  grade.uniforms.uSplit.value = 0.002 + glitch * 0.012 + (t > T.black ? 0.006 : 0)
  grade.uniforms.uFlash.value = Math.max(Math.exp(-Math.max(0, t - T.land) * 10) * (t > T.land ? 0.5 : 0), Math.exp(-Math.max(0, t - T.black) * 12) * (t > T.black ? 0.7 : 0))
  grade.uniforms.uFade.value = smooth(0, 0.8, t) * (1 - smooth(T.end - 0.2, T.end - 0.02, t))
  bloom.strength = t > T.black ? 1.0 : 0.8

  const shown =
    caption(t, 'THE EXPEDITION MADE LANDFALL', 0.5, 2.9) ||
    caption(t, 'THE AIR TESTED CLEAN', 6.2, 8.6) ||
    caption(t, "IT WASN'T", 12.9, 14.25, 'red')
  if (!shown) cap.style.opacity = '0'
  composer.render()
}

window.ready = true
