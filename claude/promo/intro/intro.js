/**
 * The intro (M99, T99.03 — the owner's beat sheet): the expedition lands on Droxilon 7, the door
 * comes down, a tablet says the air is clean, one man breathes it and is fine, they all take
 * their helmets off, the tablet screams, they twitch, and he turns.
 *
 * Every frame is a pure function of `t` — `window.renderAt(t)` — so the render script can step
 * it at exactly 60 fps however long each frame takes, and the live preview (`?play=1`,
 * `player.js`) can seek anywhere. The clock is `beats.js`; the world is `world.js`.
 */
import * as THREE from 'three'
import { CREW, T } from './beats.js'
import { alarmFlash, drawTablet, FONT, tablet } from './tablet.js'
import {
  bayLight, bloom, breath, breathSeed, camera, clamp, composer, crew, door, dust, dustSeed, easeOut, EXT_LEN,
  glowBits, grade, HATCH_LEN, hero, HINGE_Y, HINGE_Z, lander, lerp, RAMP_LEN, RAMP_SLOPE, scarf, scarfBase, scarfG,
  scene, shakeN, smooth, spores, sporeSeed, thrusterGlow, thrusterLight,
} from './world.js'

scene.add(tablet)
const holder = crew[0]

// --- deterministic jitter ------------------------------------------------------------------
const hash = (a, b, c) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
  return x - Math.floor(x)
}

// --- the door ------------------------------------------------------------------------------
/** Hatch angle from closed (0) to down (π/2 + slope), and how far the ramp is out (0..1). */
function doorAt(t) {
  const swing = smooth(T.door, T.hatchOpen, t)
  const settle = t > T.hatchOpen ? -0.025 * Math.exp(-(t - T.hatchOpen) * 9) * Math.cos((t - T.hatchOpen) * 30) : 0
  return [(Math.PI / 2 + RAMP_SLOPE) * swing + settle, smooth(T.rampOut, T.rampDown, t)]
}
/** World point `s` metres down the ramp's walking surface from the hinge (ramp fully down). */
function rampPoint(s) {
  return new THREE.Vector3(0, HINGE_Y + lander.position.y - s * Math.sin(RAMP_SLOPE) + 0.11, HINGE_Z + s * Math.cos(RAMP_SLOPE))
}

// --- the crew ------------------------------------------------------------------------------
/** Where each one ends up and which way they face (yaw; 0 faces +z, towards the first shot). */
const SPOTS = [
  [-1.3, 12.6, Math.PI], // the tablet: faces the lander, and the others
  [0.6, 10.8, -0.25], // him
  [2.5, 11.6, -1.5],
  [-2.4, 10.4, 1.0],
]

function rest(f) {
  for (const j of [f.armL, f.armR, f.foreL, f.foreR, f.legL, f.legR, f.shinL, f.shinR, f.neck, f.torso]) j.rotation.set(0, 0, 0)
  f.armL.rotation.z = 0.3
  f.armR.rotation.z = -0.3
  f.hips.position.y = 0.95
  f.helmet.position.set(0, 0.2, 0)
  f.helmet.rotation.set(0, 0, 0)
  f.chest.scale.set(1, 1, 1)
}

function placeCrew(t) {
  crew.forEach((f, i) => {
    const u = t - CREW.start(i)
    const [dx, dz, yaw] = SPOTS[i]
    const dest = new THREE.Vector3(dx, 0, dz)
    const rampT = RAMP_LEN / CREW.rampSpeed
    const foot = rampPoint(RAMP_LEN).setY(0)
    const outT = foot.distanceTo(dest) / CREW.groundSpeed
    let p
    let walking = 1
    let face = 0
    if (u < rampT) p = rampPoint(Math.max(0, u) * CREW.rampSpeed)
    else if (u < rampT + outT) {
      p = foot.clone().lerp(dest, (u - rampT) / outT)
      face = Math.atan2(dest.x - foot.x, dest.z - foot.z)
    } else {
      p = dest
      walking = 0
      const k = smooth(0, CREW.turn, u - rampT - outT)
      const a = Math.atan2(dest.x - foot.x, dest.z - foot.z)
      let d = yaw - a
      d = Math.atan2(Math.sin(d), Math.cos(d))
      face = a + d * k
    }
    f.root.position.copy(p)
    f.root.visible = u >= 0
    f.root.rotation.y = face
    f.walk(u * CREW.stride, walking)
  })
}

/**
 * Taking the helmet off from `t0`: both hands up, lift it clear, bring it down to `side`
 * (+1 left hand, -1 right). `oneHand` keeps the left arm for the tablet.
 */
function helmetOff(f, t, t0, side, oneHand = false) {
  const u = (t - t0) / 1.5
  if (u <= 0) return
  const up = smooth(0, 0.4, u)
  const down = smooth(0.45, 1, u)
  const onHead = new THREE.Vector3(0, 0.2, 0)
  const lifted = new THREE.Vector3(0, 0.78, 0.1)
  const held = new THREE.Vector3(side * 0.42, -0.7, 0.14)
  const p = onHead.clone().lerp(lifted, up).lerp(held, down)
  f.helmet.position.copy(p)
  f.helmet.rotation.set(-0.4 * up * (1 - down) + 0.3 * down, 0, side * 0.5 * down)
  const raise = up * (1 - down)
  const arms = oneHand ? [side > 0 ? [f.armL, f.foreL, 1] : [f.armR, f.foreR, -1]] : [[f.armL, f.foreL, 1], [f.armR, f.foreR, -1]]
  for (const [arm, fore, s] of arms) {
    const holding = s === side
    arm.rotation.x = -2.7 * raise + (holding ? -0.15 * down : 0)
    arm.rotation.z = s * (0.3 + 0.25 * raise + (holding ? 0.35 * down : 0))
    fore.rotation.x = -1.1 * raise
  }
}

function holdTablet(f, t) {
  // Held up in his right hand, out to his right, so it clears his helmet from behind.
  const k = smooth(T.tablet - 1.0, T.tablet - 0.3, t)
  f.armR.rotation.x = lerp(f.armR.rotation.x, -0.5, k)
  f.armR.rotation.z = lerp(f.armR.rotation.z, -0.32, k)
  f.foreR.rotation.x = lerp(f.foreR.rotation.x, -0.8, k) // hand under the panel's near edge
  // The panel floats over his left forearm, tilted up to his eyes.
  const yaw = f.root.rotation.y
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
  const left = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
  tablet.position.copy(f.root.position).addScaledVector(fwd, 0.66).addScaledVector(left, -0.3).setY(1.6)
  tablet.rotation.set(0, yaw + Math.PI, 0) // the screen faces him
  tablet.rotateX(-0.55)
}

function breathe(t) {
  const f = hero
  const inh = smooth(T.inhale, T.hold, t) * (1 - smooth(T.exhale, T.exhale + 0.9, t))
  f.neck.rotation.x += -0.42 * inh
  f.chest.scale.set(1 + 0.3 * inh, 1, 1 + 0.3 * inh)
  f.torso.rotation.x += -0.1 * inh
  f.armR.rotation.z += -0.12 * inh
  // Fine: two nods and a thumbs-up.
  const fine = smooth(T.fine, T.fine + 0.35, t) * (1 - smooth(T.helmets + 1.6, T.helmets + 2.2, t))
  const nod = t > T.fine ? Math.max(0, Math.sin((t - T.fine) * 8)) * Math.exp(-(t - T.fine) * 1.1) : 0
  f.neck.rotation.x += 0.3 * nod
  f.armR.rotation.x = lerp(f.armR.rotation.x, -0.9, fine)
  f.armR.rotation.z = lerp(f.armR.rotation.z, -0.75, fine)
  f.foreR.rotation.x = lerp(f.foreR.rotation.x, -1.5, fine)
}

/** Small, glitchy jerks, gated and stepped, escalating from `T.twitch` to the turn. */
function twitch(f, i, t) {
  const amp = smooth(T.twitch - 0.4, T.turn + 0.4, t) * 0.8 * (t < T.black ? 1 : 0.4)
  if (amp <= 0) return
  const step = Math.floor(t * 15)
  const p = 0.25 + 0.55 * amp
  const n = (k) => (hash(step, i, k + 50) < p ? hash(step, i, k) * 2 - 1 : 0)
  f.neck.rotation.x += 0.55 * amp * n(1)
  f.neck.rotation.z += 0.7 * amp * n(2)
  f.neck.rotation.y += 0.5 * amp * n(3)
  f.torso.rotation.z += 0.22 * amp * n(4)
  f.torso.rotation.x += 0.18 * amp * n(5)
  f.armL.rotation.x += 0.9 * amp * n(6)
  f.armR.rotation.x += 0.9 * amp * n(7)
  f.foreL.rotation.x += 0.8 * amp * n(8)
  f.foreR.rotation.x += 0.8 * amp * n(9)
  f.hips.position.y -= 0.05 * amp * Math.abs(n(10))
}

function turn(t) {
  // White to black in flickers, then black; the eyes ignite; the scarf unfurls.
  const u = smooth(T.turn, T.black, t)
  const flick = Math.sin(t * 90) * Math.sin(t * 57) > 1 - 2 * u
  const black = t >= T.black || (t > T.turn && flick)
  hero.suit.color.set(black ? 0x07070a : 0xd9d9e0)
  hero.suit.roughness = black ? 0.85 : 0.75
  const eye = smooth(T.black - 0.1, T.black + 0.25, t)
  hero.eyeM.color.setRGB(eye, 0, 0)
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

// --- particles -----------------------------------------------------------------------------
function particles(t) {
  // Spores drift everywhere; during the breath the near ones spiral into his mouth.
  const sp = spores.geometry.attributes.position
  const mouth = new THREE.Vector3()
  hero.head.getWorldPosition(mouth)
  mouth.add(new THREE.Vector3(0, -0.04, 0.16).applyQuaternion(hero.root.quaternion))
  const pull = smooth(T.inhale - 0.1, T.inhale + 1.2, t) * (1 - smooth(T.hold + 0.4, T.hold + 0.6, t))
  for (let i = 0; i < sporeSeed.length; i++) {
    const [a, b, c, d] = sporeSeed[i]
    const near = i < 420
    const cx = near ? mouth.x + (a - 0.5) * 3.2 : (a - 0.5) * 40
    const cz = near ? mouth.z + (b - 0.5) * 3.2 : (b - 0.5) * 34 + 3
    let x = cx + Math.sin(t * (0.3 + c) + d * 9) * 0.4
    let y = (near ? mouth.y - 0.8 : 0.2) + c * (near ? 1.8 : 4) + Math.sin(t * 0.7 + a * 12) * 0.25
    let z = cz + Math.cos(t * (0.25 + d) + c * 7) * 0.4
    if (near && t > T.inhale - 0.1) {
      const k = clamp(pull * 1.5 - d * 0.6)
      const e = k * k
      const ang = e * 5 + a * 6
      const r = (1 - e) * 0.25
      x = lerp(x, mouth.x + Math.cos(ang) * r, e)
      y = lerp(y, mouth.y + Math.sin(ang) * r * 0.5, e)
      z = lerp(z, mouth.z + Math.sin(ang) * r, e)
      if (k >= 1 || t > T.hold + 0.6) y = -50
    }
    sp.setXYZ(i, x, y, z)
  }
  sp.needsUpdate = true
  spores.material.size = t > T.breath - 0.3 && t < T.helmets ? 0.05 : t > T.alarm ? 0.07 : 0.14
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
  // The breath out: a pale plume, nothing in it you could see.
  const bp = breath.geometry.attributes.position
  const bu = t - T.exhale
  const fwd = new THREE.Vector3(0, -0.15, 1).applyQuaternion(hero.root.quaternion)
  for (let i = 0; i < breathSeed.length; i++) {
    const [a, b, c] = breathSeed[i]
    const s = bu - a * 0.7
    if (s < 0 || bu > 2.2) { bp.setXYZ(i, 0, -50, 0); continue }
    const d = s * (0.6 + b * 0.7)
    bp.setXYZ(i, mouth.x + fwd.x * d + (b - 0.5) * d * 0.7, mouth.y + fwd.y * d + (c - 0.5) * d * 0.5 + d * d * 0.1, mouth.z + fwd.z * d + (c - 0.5) * d * 0.7)
  }
  bp.needsUpdate = true
  breath.material.color.set(0xb8b0e8)
  breath.material.opacity = bu > 0 ? 0.55 * Math.exp(-bu * 1.1) : 0
}

// --- the shots -----------------------------------------------------------------------------
const V = (x, y, z) => new THREE.Vector3(x, y, z)
/** In front of `f` by `d`, `side` to his left, at height `y`. */
function front(f, d, side, y, yaw = f.root.rotation.y) {
  const p = f.root.position
  return V(p.x + Math.sin(yaw) * d + Math.cos(yaw) * side, y, p.z + Math.cos(yaw) * d - Math.sin(yaw) * side)
}

/** [camera position, look-at, fov, shake] for `t`. */
function shot(t) {
  if (t < T.door) {
    const u = t / T.door
    const pos = V(lerp(-4, 3, u), lerp(1.4, 2.2, u), lerp(34, 26, u))
    const look = V(0, lerp(10, 3.5, easeOut(u * 1.1)) + lander.position.y * 0.35, 0)
    const sh = t > T.land ? Math.exp(-(t - T.land) * 2.2) * 0.35 : 0.03
    return [pos, look, 38, sh]
  }
  if (t < T.crew) {
    // The door: three-quarter on, low, a slow push as the ramp comes down.
    const u = (t - T.door) / (T.crew - T.door)
    return [V(lerp(8.6, 7.4, u), lerp(2.0, 1.7, u), lerp(17.5, 15.8, u)), V(0, lerp(3.0, 2.0, u), lerp(4.5, 6.0, u)), 36, 0.004]
  }
  if (t < T.tablet) {
    // Down the ramp: side-on and low, tracking them out.
    const u = (t - T.crew) / (T.tablet - T.crew)
    return [V(lerp(6.4, 5.6, u), lerp(1.25, 1.35, u), lerp(12.0, 14.0, u)), V(lerp(0.3, -0.4, u), lerp(1.7, 1.25, u), lerp(7.0, 10.0, u)), 38, 0.004]
  }
  if (t < T.breath || (t >= T.alarm && t < T.twitch)) {
    // Over his right shoulder onto the tablet; tighter when it screams.
    const alarm = t >= T.alarm
    const u = alarm ? (t - T.alarm) / (T.twitch - T.alarm) : (t - T.tablet) / (T.breath - T.tablet)
    const back = alarm ? lerp(0.95, 0.8, u) : lerp(1.3, 1.05, u)
    const pos = front(holder, -back, -0.95, alarm ? 1.86 : 1.92, SPOTS[0][2])
    const look = tablet.position.clone().add(V(0, 0.01, 0))
    look.lerp(front(holder, 3, 0.2, 1.4), alarm ? 0.0 : 0.05)
    return [pos, look, alarm ? 22 : 24, alarm ? 0.004 + alarmFlash(t) * 0.004 : 0.003]
  }
  if (t < T.helmets) {
    // The breath: close on him, a slow push in, then back out for the thumbs-up.
    const push = smooth(T.breath, T.fine - 0.2, t)
    const pull = smooth(T.fine - 0.2, T.fine + 0.6, t)
    const d = lerp(lerp(2.5, 1.75, push), 2.9, pull)
    const pos = front(hero, d, -0.38, lerp(1.88, 1.72, pull))
    const look = V(hero.root.position.x, lerp(1.82, 1.55, pull), hero.root.position.z)
    return [pos, look, 30, 0.003]
  }
  if (t < T.alarm) {
    // Helmets off: the group, wide enough for all four.
    const u = (t - T.helmets) / (T.alarm - T.helmets)
    return [V(lerp(5.4, 5.0, u), 1.75, lerp(18.0, 17.4, u)), V(-0.1, 1.25, 11.3), 34, 0.003]
  }
  if (t < T.turn) {
    // The twitching: closer on the group, the camera getting nervous.
    const u = (t - T.twitch) / (T.turn - T.twitch)
    return [V(lerp(3.6, 3.1, u), 1.5, lerp(16.4, 15.6, u)), V(0.0, 1.35, 11.3), 32, 0.008 + 0.03 * u * u]
  }
  const hp = hero.root.position
  if (t < T.black) {
    const u = (t - T.turn) / (T.black - T.turn)
    return [front(hero, lerp(1.9, 1.5, u), -0.3 + u * 0.2, 1.88), V(hp.x, 1.8, hp.z), 30, 0.02 + u * 0.03]
  }
  const u = smooth(T.black, T.end - 0.3, t)
  return [front(hero, lerp(1.45, 1.0, u), -0.05, 1.86), V(hp.x, 1.82, hp.z), lerp(30, 24, u), 0.03]
}

// --- the caption ---------------------------------------------------------------------------
const CAPTION = 'PLANET DROXILON 7'
const CHAR = 0.085 // s per letter
const capEl = document.getElementById('type')
capEl.style.fontFamily = FONT
function caption(t) {
  if (t < T.capOn || t >= T.capOff) { capEl.style.opacity = '0'; return }
  const n = clamp(Math.floor((t - T.capOn - 0.3) / CHAR), 0, CAPTION.length)
  const typing = n < CAPTION.length && t > T.capOn + 0.3
  const blink = typing || Math.floor((t - T.capOn) * 2.4) % 2 === 0
  capEl.querySelector('.txt').textContent = CAPTION.slice(0, n)
  capEl.querySelector('.cur').style.visibility = blink ? 'visible' : 'hidden'
  capEl.style.opacity = String(1 - smooth(T.capOff - 0.3, T.capOff - 0.05, t))
}

// --- a frame -------------------------------------------------------------------------------
window.renderAt = (t) => {
  // The lander comes down on a decelerating thrust and settles.
  const u = clamp(t / T.land)
  lander.position.y = t < T.land ? 45 * Math.pow(1 - u, 2.4) : -0.12 * Math.exp(-(t - T.land) * 5) * Math.cos((t - T.land) * 20)
  const burn = t < T.land + 0.15 ? 1 : Math.exp(-(t - T.land - 0.15) * 8)
  thrusterGlow.visible = burn > 0.02
  thrusterGlow.scale.set(1, 0.7 + 0.3 * Math.sin(t * 60) + (t < T.land ? 0.4 * (1 - u) : 0), 1)
  thrusterGlow.material.opacity = 0.75 * burn
  thrusterLight.intensity = 900 * burn
  const [hatch, out] = doorAt(t)
  door.hinge.rotation.x = hatch
  door.ext.position.y = lerp(HATCH_LEN / 2, RAMP_LEN + 0.06 - EXT_LEN / 2, out)
  bayLight.intensity = 22 * smooth(T.door + 0.2, T.hatchOpen, t)

  for (const f of crew) rest(f)
  placeCrew(t)
  holdTablet(holder, t)
  helmetOff(hero, t, T.breath + 0.25, 1)
  breathe(t)
  helmetOff(crew[2], t, T.helmets + 0.35, -1)
  helmetOff(crew[3], t, T.helmets + 0.75, 1)
  helmetOff(holder, t, T.helmets + 1.05, 1, true)
  crew.forEach((f, i) => twitch(f, i, t))
  turn(t)
  drawTablet(t)
  particles(t)
  for (const [k, l] of glowBits.entries()) l.intensity = 6 + Math.sin(t * 2 + k) * 1.5

  const [pos, look, fov, shake] = shot(t)
  pos.x += shakeN(t, 1) * shake
  pos.y += shakeN(t, 2) * shake
  camera.position.copy(pos)
  camera.lookAt(look)
  camera.fov = fov
  camera.updateProjectionMatrix()

  // Grade: the twitching and the turn glitch and split; a flash on touchdown and at ignition.
  const tw = smooth(T.twitch, T.turn, t)
  const glitch = t > T.turn && t < T.black + 0.3 ? 0.6 + 0.4 * Math.sin(t * 40) : t > T.twitch && t < T.turn ? tw * 0.5 * (hash(Math.floor(t * 15), 9, 9) > 0.6 ? 1 : 0) : 0
  grade.uniforms.uSeed.value = Math.floor(t * 60) * 0.137
  grade.uniforms.uGlitch.value = glitch
  grade.uniforms.uSplit.value = 0.002 + glitch * 0.012 + (t > T.black ? 0.006 : 0) + (t > T.alarm && t < T.twitch ? alarmFlash(t) * 0.002 : 0)
  grade.uniforms.uFlash.value = Math.max(t > T.land ? Math.exp(-(t - T.land) * 10) * 0.5 : 0, t > T.black ? Math.exp(-(t - T.black) * 12) * 0.7 : 0)
  grade.uniforms.uFade.value = smooth(0, 0.8, t) * (1 - smooth(T.end - 0.2, T.end - 0.02, t))
  bloom.strength = t > T.black ? 1.0 : 0.8

  caption(t)
  composer.render()
}

await document.fonts.load(`600 64px ${FONT}`)
await document.fonts.load(`500 46px ${FONT}`)
window.ready = true
