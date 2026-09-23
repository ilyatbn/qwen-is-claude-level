// Style F = A's lit terrain + E's composition and cast, low-key. Shared helpers.
import * as THREE from 'three'
import { W, H } from './world.js'
import { makeRenderer, orthoCam, fieldTextures, screenQuad, terrainMaterial, foregroundDoF, post, NOISE_GLSL } from './kit.js'
import * as S from './e_style.js'

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`
export const DARK_INK = '#07060a'

export function fog({ color = [0.2, 0.2, 0.3], y0 = 400, y1 = 720, k = 0.5, scale = 0.004, seed = 0 }) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { c: { value: new THREE.Vector3(...color) } },
    vertexShader: VS,
    fragmentShader: NOISE_GLSL + `varying vec2 vUv; uniform vec3 c;
      void main(){ vec2 p = vec2(vUv.x*${W}.0, (1.-vUv.y)*${H}.0);
        float n = fbm(vec2(p.x*${scale} + ${seed}.0, p.y*${scale * 3.5}), 5);
        float a = ${k} * smoothstep(${y0}.0, ${y1}.0, p.y) * smoothstep(0.3, 0.75, n);
        gl_FragColor = vec4(c, a); }`,
  })
}

/** lights: {x,y (mask px), z, r, color:[lin rgb], i, rgb:'r,g,b' (sRGB string for 2D rim)} */
export function dominant(lights, x, y, moon) {
  let best = { ...moon, w: moon.w }
  for (const l of lights) {
    const d = Math.hypot(l.x - x, l.y - y); if (d > l.r) continue
    const w = l.i * (1 - d / l.r) ** 2 * 1.6
    if (w > best.w) best = { dx: (l.x - x) / (d || 1), dy: (l.y - y) / (d || 1), rgb: l.rgb, w }
  }
  return best
}

/** Draw something twice: a rim pass offset toward the key light in its colour, then the ink pass. */
export function lit(g, lights, moon, x, y, draw, { size = 1, halo = null, shadow = true } = {}) {
  const L = dominant(lights, x, y - 14 * size, moon)
  if (halo) S.glow(g, x, y - 14 * size, 30 * size, halo, 0.22)
  if (shadow) { const gr = g.createRadialGradient(x, y, 0, x, y, 11 * size); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.save(); g.translate(x, y); g.scale(1, 0.25); g.translate(-x, -y); g.fillStyle = gr; g.beginPath(); g.arc(x, y, 11 * size, 0, 7); g.fill(); g.restore() }
  const a = Math.min(1, 0.45 + L.w * 0.5)
  const o = 1.15 * size
  S.setInk(`rgba(${L.rgb},${a * 0.35})`); draw(g, L.dx * o * 1.7, L.dy * o * 1.7, `rgba(${L.rgb},${a * 0.3})`)
  S.setInk(`rgba(${L.rgb},${a})`); draw(g, L.dx * o, L.dy * o, `rgba(${L.rgb},${a})`)
  // faint cool fill from the opposite side (the sky)
  S.setInk(`rgba(${moon.fill},0.35)`); draw(g, -L.dx * 0.7 * size, -L.dy * 0.7 * size, `rgba(${moon.fill},0.35)`)
  S.setInk(DARK_INK); draw(g, 0, 0, null)
}

export function toLin(rgbStr) { return rgbStr.split(',').map(v => Math.pow(+v / 255, 2.2)) }

/** Builds the frame: bg (E layers) → back fog → lit terrain (A) → front fog → actor canvas → fx → fg */
export function frame({ world, bg, terrain, lights, fogBack, fogFront, fg, draw2d, fx3d, bloom = [0.55, 0.45, 0.72], grade = {}, exposure = 1 }) {
  document.body.style.cssText = 'margin:0;position:relative;width:1280px;height:720px;overflow:hidden;background:#000'
  const r = makeRenderer(); r.toneMappingExposure = exposure
  const cam = orthoCam(), scene = new THREE.Scene()
  scene.add(S.bgQuad(bg))
  if (fogBack) scene.add(screenQuad(fog(fogBack), -10))
  const { field, albedo } = fieldTextures(world)
  const black = new THREE.WebGLRenderTarget(4, 4)
  scene.add(screenQuad(terrainMaterial({ field, albedo, occl: black.texture, lights: lights.map(l => ({ ...l, color: toLin(l.rgb) })), ...terrain }), 0))
  if (fogFront) scene.add(screenQuad(fog(fogFront), 10))
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const g = cv.getContext('2d'); g.lineCap = 'round'; g.lineJoin = 'round'
  draw2d(g)
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
  const aq = screenQuad(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }), 20); scene.add(aq)
  const fx = new THREE.Group(); scene.add(fx); fx3d?.(fx)
  if (fg) { const q = screenQuad(foregroundDoF(fg), 900); q.renderOrder = 10; scene.add(q) }
  const comp = post(r, scene, cam, { bloom, grade })
  comp.render()
}
