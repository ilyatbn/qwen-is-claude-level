// Style E: "haze & silhouette" (from the owner's pyramid reference).
// Layer stack (bottom→top): WebGL sky+stepped haze layers | 2D far silhouettes |
// WebGL terrain (mask → gradient fill, hazier recesses) | 2D actors + FX + grain | DOM HUD.
import * as THREE from 'three'
import { W, H } from './world.js'
import { NOISE_GLSL } from './kit.js'

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`
const hex = h => { const c = new THREE.Color(); c.setHex(h, THREE.LinearSRGBColorSpace); return new THREE.Vector3(c.r, c.g, c.b) }

export function layerCanvas(kind = '2d') {
  const c = document.createElement('canvas'); c.width = W; c.height = H
  c.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`
  document.body.appendChild(c); return c
}

function glRenderer() {
  const cv = layerCanvas()
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true })
  r.setPixelRatio(1); r.setSize(W, H, false); r.toneMapping = THREE.NoToneMapping; r.outputColorSpace = THREE.LinearSRGBColorSpace
  r.setClearColor(0x000000, 0)
  return r
}
function quad(mat) { const s = new THREE.Scene(); const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); m.frustumCulled = false; s.add(m); return s }
const cam = new THREE.Camera()
const VSQ = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.,1.); }`

/**
 * layers: far→near, each { shape:'pyramid'|'zig'|'arc'|'mesa', x, y (apex/top, px y-down), slope | r, top (half flat top),
 *   color, step, soft, fade:[yStart,yEnd,minAlpha], jitter }
 */
export function drawBackground(o) { const r = glRenderer(); r.render(quad(bgMaterial(o)), cam) }
export function bgQuad(o) { const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMaterial(o, true)); m.frustumCulled = false; m.renderOrder = -10; m.material.depthTest = false; m.material.depthWrite = false; return m }
export function bgMaterial({ skyTop, skyBottom, haze, horizon, layers, sun = null, stars = 0, grainK = 0.035, rays = null, rayColor = 0xffffff, glowY = null, glowColor = 0x000000, moons = [] }, linear = false) {
  const MO = [], MC = [], ML = []
  for (let i = 0; i < 3; i++) { const m = moons[i]; MO.push(new THREE.Vector4(...(m ? [m.x, m.y, m.r, m.rays ?? 0] : [0, 0, 0, 0]))); MC.push(hex(m?.color ?? 0)); ML.push(new THREE.Vector4(...(m ? [m.rayLen ?? 400, m.phase ?? 0.3, m.halo ?? 1, 0] : [1, 0, 0, 0]))) }
  const N = 6
  const A = [], B = [], C = [], D = []
  for (let i = 0; i < N; i++) {
    const L = layers[i]
    if (!L) { A.push(new THREE.Vector4(0, 9999, 1, 4)); B.push(new THREE.Vector4(-1, 0, 0, 0)); C.push(new THREE.Vector3()); D.push(new THREE.Vector4(0, 1, 1, 0)); continue }
    const type = { pyramid: 0, zig: 1, arc: 2, mesa: 3 }[L.shape]
    A.push(new THREE.Vector4(L.x, L.y, L.slope ?? L.r ?? 1, L.step ?? 6))
    B.push(new THREE.Vector4(type, L.top ?? 0, L.soft ?? 1, L.jitter ?? 0.8))
    C.push(hex(L.color))
    D.push(new THREE.Vector4(...(L.fade ?? [L.y, horizon, 0.15]), L.streak ?? 1))
  }
  return new THREE.ShaderMaterial({
    uniforms: { A: { value: A }, B: { value: B }, C: { value: C }, D: { value: D }, skyTop: { value: hex(skyTop) }, skyBottom: { value: hex(skyBottom) }, haze: { value: hex(haze) }, horizon: { value: horizon },
      sun: { value: new THREE.Vector4(...(sun ? [sun.x, sun.y, sun.r, sun.k] : [0, 0, 0, 0])) }, sunC: { value: hex(sun?.color ?? 0xffffff) }, stars: { value: stars }, grainK: { value: grainK },
      MO: { value: MO }, MC: { value: MC }, ML: { value: ML }, rays: { value: new THREE.Vector4(...(rays ?? [0, 0, 0, 0])) }, rayC: { value: hex(rayColor) }, lin: { value: linear ? 1 : 0 }, glowY: { value: new THREE.Vector2(glowY ?? -1, 0) }, glowC: { value: hex(glowColor) } },
    vertexShader: VSQ,
    fragmentShader: NOISE_GLSL + `varying vec2 vUv; uniform vec4 A[${N}], B[${N}], D[${N}]; uniform vec3 C[${N}]; uniform vec3 skyTop, skyBottom, haze, sunC; uniform float horizon, stars, grainK, lin; uniform vec4 sun, rays; uniform vec3 rayC, glowC; uniform vec2 glowY; uniform vec4 MO[3], ML[3]; uniform vec3 MC[3];
      float edgeY(int i, float x){
        vec4 a = A[i], b = B[i]; float t = b.x;
        if (t < 0.5) return a.y + abs(x - a.x)*a.z;
        if (t < 1.5) { float dx = max(0., abs(x - a.x) - b.y); float yy = a.y + dx*a.z; return a.y + floor((yy - a.y)/(a.w*5.))*(a.w*5.) + fract((yy-a.y)/(a.w*5.))*a.w*5.*0.35; }
        if (t < 2.5) { float dx = x - a.x; float r = a.z; return abs(dx) < r ? a.y - sqrt(r*r - dx*dx) + r : 1e5; }
        float dx = max(0., abs(x - a.x) - b.y); return a.y + dx*a.z*(1. + 0.8*fbm(vec2(x*0.02, float(i)), 2));
      }
      void main(){
        vec2 p = vec2(vUv.x*${W}.0, (1.-vUv.y)*${H}.0);
        float h = p.y/${H}.0;
        vec3 col = mix(skyTop, skyBottom, smoothstep(0., horizon/${H}.0, h));
        // brushed sky grain
        col *= 1. + (fbm(vec2(p.x*0.003, p.y*0.08), 3) - 0.5)*0.025;
        if (sun.z > 0.) { float d = length(p - sun.xy); col = mix(col, sunC, smoothstep(sun.z+1., sun.z-1., d)*sun.w); col += sunC*0.06*exp(-d/(sun.z*4.)); }
        if (stars > 0.) { vec2 g = floor(p/3.); float s = hash12(g); if (s > 1. - stars) col += vec3(0.8)*smoothstep(0.6, 0.,length(fract(p/3.)-0.5)) * (1.-h*1.3); }
        for (int m=0;m<3;m++){ if (MO[m].z <= 0.) continue; vec2 d = p - MO[m].xy; float r = MO[m].z; float dl = length(d);
          col += MC[m] * 0.22 * ML[m].z * exp(-max(dl - r, 0.)/(r*1.1));
          if (dl < r + 1.) { vec2 n = d/r; float z = sqrt(max(0., 1. - dot(n,n)));
            float lit = clamp(dot(vec3(n, z), normalize(vec3(-ML[m].y, -0.35, 0.85))), 0., 1.);
            vec3 mc = MC[m] * (0.35 + 0.75*lit) * (0.82 + 0.25*fbm(n*4. + float(m)*7., 4)) * (0.8 + 0.2*z);
            col = mix(col, mc, smoothstep(r + 1., r - 1., dl)); } }
        float occ = 0.;
        for (int i=0;i<${N};i++){
          if (B[i].x < -0.5) continue;
          float st = A[i].w;
          float row = floor(p.y/st);
          float xj = p.x + (hash12(vec2(row, float(i)*7.)) - 0.5)*st*B[i].w*2.;
          float ey = edgeY(i, xj);
          if (B[i].x < 0.5 || B[i].x > 1.5) ey = ceil(ey/st)*st;           // staircase
          float soft = B[i].z;
          float inside = smoothstep(ey - soft, ey + soft, p.y);
          // aerial perspective: fade toward the base into haze
          float f = smoothstep(D[i].x, D[i].y, p.y);
          float alpha = inside * mix(1., D[i].z, pow(f, 0.8));
          vec3 lc = C[i] * (1. + (fbm(vec2(p.x*0.004, p.y*0.45), 3) - 0.5)*0.07*D[i].w);   // horizontal brush streaks
          lc = mix(lc, haze, 0.25*f);
          col = mix(col, lc, alpha); occ = max(occ, alpha*(0.4 + 0.6*float(i)/${N - 1}.));
        }
        if (rays.z > 0.) { vec2 d = p - rays.xy; float ang = atan(d.y, d.x); float r = length(d);
          vec2 cs = vec2(cos(ang), sin(ang)); float st = pow(vnoise(cs*4.2 + 11.), 2.5)*0.7 + pow(vnoise(cs*1.5 + 37.), 3.)*0.6;
          col += rayC * rays.z * st * exp(-r/rays.w) * (1. - 0.75*occ) * smoothstep(0., 60., r); }
        if (glowY.x > 0.) col += glowC * exp(-abs(p.y - glowY.x)/90.);
        for (int m=0;m<3;m++){ if (MO[m].w <= 0.) continue; vec2 d = p - MO[m].xy; float ang = atan(d.y, d.x); float r = length(d);
          vec2 cs = vec2(cos(ang), sin(ang)); float st = pow(vnoise(cs*3.6 + float(m)*9. + 3.), 2.5)*0.7 + pow(vnoise(cs*1.3 + 21. + float(m)*5.), 3.)*0.6;
          col += MC[m] * MO[m].w * st * exp(-r/ML[m].x) * (1. - 0.8*occ) * smoothstep(MO[m].z, MO[m].z*2.5, r); }
        // ground haze band at the horizon
        col = mix(col, haze, 0.55*exp(-abs(p.y - horizon)/38.));
        col += (hash12(p) - 0.5)*grainK;
        if (lin > 0.5) col = pow(max(col, 0.), vec3(2.2));
        gl_FragColor = vec4(col, 1.);
      }`,
  })
}

/** The play layer. Solid = gradient (light at surfaces, dark with depth and toward the screen bottom).
 *  Recesses (tunnels/craters, `back`) are drawn as hazier, lighter, further-back ground with an inner shadow. */
export function drawTerrain(field, { top, mid, deep, haze, rim = null, scorch = [], rimK = 0.35, streak = 1, yK = 0.55 }) {
  const r = glRenderer()
  const sc = scorch.map(s => new THREE.Vector3(s.x, s.y, s.r)); while (sc.length < 3) sc.push(new THREE.Vector3(-999, -999, 1))
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { field: { value: field }, top: { value: hex(top) }, mid: { value: hex(mid) }, deep: { value: hex(deep) }, haze: { value: hex(haze) }, rim: { value: hex(rim ?? top) }, rimK: { value: rim ? rimK : 0 }, sc: { value: sc }, streak: { value: streak }, yK: { value: yK } },
    vertexShader: VSQ,
    fragmentShader: NOISE_GLSL + `varying vec2 vUv; uniform sampler2D field; uniform vec3 top, mid, deep, haze, rim, sc[3]; uniform float rimK, streak, yK;
      const vec2 RES = vec2(${W}.0, ${H}.0);
      vec4 F(vec2 p){ return texture2D(field, p/RES); }
      vec3 ramp(float t){ return t < 0.5 ? mix(top, mid, t*2.) : mix(mid, deep, (t-0.5)*2.); }
      void main(){
        vec2 p = vec2(vUv.x, 1.-vUv.y)*RES;
        vec4 f = F(p); float din = f.r*64., dout = f.g*64.;
        float cover = clamp(din - dout + 0.5, 0., 1.);
        bool back = f.b > 0.5;
        if (cover < 0.01 && !back) discard;
        float yN = p.y/${H}.0;
        float t = clamp(yK*smoothstep(0.3, 1.0, yN) + (1.-yK)*smoothstep(0., 64., din), 0., 1.);
        vec3 c = ramp(t);
        // sand / stone grain: faint horizontal strata, fine speckle
        c *= 1. + (fbm(vec2(p.x*0.006, p.y*0.22), 3) - 0.5)*0.08*streak + (hash12(p) - 0.5)*0.035;
        // lit lip on up-facing edges (one soft line: reads as solid, keeps the flat look)
        float up = F(p + vec2(0., 3.)).r*64. - din;
        c = mix(c, rim, rimK * smoothstep(3., 0., din) * smoothstep(0.5, 2.5, up));
        // undersides (air just below): shaded, so overhangs, islands and tunnel roofs read as mass
        float air = 0.;
        for (int k=1;k<=8;k++){ float o = float(k)*2.5; air += (1. - clamp(F(p + vec2(0., o)).r*64. - F(p + vec2(0., o)).g*64. + 0.5, 0., 1.)) * (1. - float(k)/9.); }
        c *= 1. - 0.09*air;
        for (int i=0;i<3;i++){ float d = length(p - sc[i].xy); c = mix(c, deep*0.55, 0.85*smoothstep(sc[i].z, sc[i].z*0.45, d) * smoothstep(14., 0., din + 6.*fbm(p*0.08,2))); }
        vec3 outc = c;
        if (back) {
          // a recess: further back, so hazier and lighter (aerial perspective), with a shadow under its roof
          float tb = clamp(yK*smoothstep(0.3, 1.0, yN) + 0.3, 0., 1.);
          vec3 b = mix(ramp(tb), haze, 0.16);
          float roof = F(p - vec2(0., 10.)).r + F(p - vec2(0., 20.)).r + F(p - vec2(0., 34.)).r;  // solid above → shade
          b *= 1. - 0.45*clamp(roof*3., 0., 1.) * smoothstep(30., 2., dout);
          b *= 1. - 0.18*smoothstep(10., 0., dout);
          for (int i=0;i<3;i++){ float d = length(p - sc[i].xy); b = mix(b, deep*0.7, 0.5*smoothstep(sc[i].z*0.9, sc[i].z*0.3, d)); }
          outc = mix(b, c, cover); cover = 1.;
        }
        gl_FragColor = vec4(outc, cover);
      }`,
  })
  r.render(quad(mat), cam)
}

// ------------------------------------------------------------------ 2D silhouettes
export let INK = '#16110d'
export function setInk(c) { INK = c }
export function ctx2d() { const c = layerCanvas(); const g = c.getContext('2d'); g.lineCap = 'round'; g.lineJoin = 'round'; return g }

function withT(g, x, y, s, face, rot, fn) { g.save(); g.translate(x, y); g.rotate(rot || 0); g.scale(s * face, s); fn(); g.restore() }
function line(g, pts, w, col = INK) { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(...pts[0]); for (const p of pts.slice(1)) g.lineTo(...p); g.stroke() }
function disc(g, x, y, r, col = INK) { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill() }

export function glow(g, x, y, r, rgb, a = 0.6) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(0.35, `rgba(${rgb},${a * 0.35})`); gr.addColorStop(1, `rgba(${rgb},0)`)
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill()
}

/** Stick figure, ~30 px tall at s=1, feet at (x,y). aim in radians (0 = facing direction, + = up). */
export function halo(g, x, y, r = 24, rgb = '240,234,226', a = 0.28) { glow(g, x, y, r, rgb, a) }
export function stick(g, x, y, { s = 1.15, face = 1, rot = 0, aim = 0.3, weapon = 'bazooka', accent = '#d8432a', jet = false, pose = 'stand', marker = false, flame = null } = {}) {
  withT(g, x, y, s, face, rot, () => {
    const hip = [0, -13], neck = [0.8, -23.5], head = [1.4, -27.8]
    // scarf (team colour) trailing back and up
    g.strokeStyle = accent; g.lineWidth = 2.1
    g.beginPath(); g.moveTo(0.6, -23); g.quadraticCurveTo(-5, -24.5 + (jet ? -2 : 0), -10, -21.5 + (jet ? -5 : 0)); g.stroke()
    g.lineWidth = 1.5; g.beginPath(); g.moveTo(0.4, -22.6); g.quadraticCurveTo(-4, -21, -8.5, -17.5 + (jet ? -4 : 0)); g.stroke()
    // jetpack
    g.fillStyle = INK; g.beginPath(); g.roundRect(-4.6, -23.5, 3.6, 8.5, 1.2); g.fill()
    if (jet) {
      const fl = g.createLinearGradient(0, -15, 0, -3)
      fl.addColorStop(0, 'rgba(255,245,200,1)'); fl.addColorStop(0.4, 'rgba(255,160,40,0.95)'); fl.addColorStop(1, 'rgba(230,70,20,0)')
      g.fillStyle = fl; g.beginPath(); g.moveTo(-4.4, -15); g.quadraticCurveTo(-2.8, -6, -2.8, -3); g.quadraticCurveTo(-2.8, -6, -1.2, -15); g.fill()
    }
    // legs
    const L = pose === 'stand' ? [[[3, -6.5], [4.2, 0]], [[-1.8, -6.5], [-4, 0]]] : pose === 'run' ? [[[5, -8], [8, -3]], [[-2, -6], [-6, -1]]] : [[[4.5, -8], [2.5, -2.5]], [[-0.5, -7], [-3.2, -1.5]]]
    for (const [k, f] of L) { line(g, [hip, k, f], 2.3); line(g, [f, [f[0] + 1.8, f[1]]], 2.3) }
    // body + head
    line(g, [hip, neck], 3)
    disc(g, head[0], head[1], 3.7)
    // weapon on shoulder, rotated by aim (y up → negative canvas angle)
    const sh = [1.2, -21.5]
    g.save(); g.translate(...sh); g.rotate(-aim)
    if (weapon === 'bazooka') {
      line(g, [[-8, -1.2], [11, -1.2]], 3.6)
      g.fillStyle = INK; g.beginPath(); g.moveTo(10, -3.8); g.lineTo(14, -4.6); g.lineTo(14, 2.2); g.lineTo(10, 1.4); g.fill()
      line(g, [[0, 0], [2.5, 3.5], [4, 1]], 1.8); line(g, [[0, 0], [6, 2.5], [8, 0.8]], 1.8)
    } else if (weapon === 'laser') {
      line(g, [[-3, 0], [13, 0]], 2); line(g, [[1, 0], [1, 3]], 1.8)
      disc(g, 13.5, 0, 1.1, accent)
      line(g, [[0, 0], [3, 3], [5, 0.6]], 1.7); line(g, [[0, 0], [7, 2.5], [9, 0.4]], 1.7)
    } else if (weapon === 'flamer') {
      line(g, [[-2, 0.5], [13, 0.5]], 2.4); disc(g, -2, 4, 2.6)
      line(g, [[0, 0], [3, 3], [5, 1]], 1.7); line(g, [[0, 0], [7, 3], [9, 1]], 1.7)
      if (flame) flame(g)
    } else if (typeof weapon === 'function') { weapon(g) } else { line(g, [[0, 0], [4, 5], [7, 3]], 1.8) }
    g.restore()
  })
  if (marker) { g.fillStyle = marker === true ? '#d8432a' : marker; g.beginPath(); g.moveTo(x - 3.2 * s, y - 38 * s); g.lineTo(x + 3.2 * s, y - 38 * s); g.lineTo(x, y - 34 * s); g.fill() }
}

export function beetle(g, x, y, { s = 1, face = 1, rot = 0 } = {}) {
  withT(g, x, y, s, face, rot, () => {
    for (const [a, b] of [[[4, -3], [7, 0]], [[0, -3], [1, 0]], [[-4, -3], [-6, 0]]]) line(g, [a, [a[0] + (b[0] - a[0]) * 0.4, -4.2], b], 1.1)
    g.fillStyle = INK; g.beginPath(); g.ellipse(-0.5, -4.6, 7.2, 3.9, 0, Math.PI, 0); g.lineTo(6.7, -3); g.lineTo(-7.7, -3); g.fill()
    disc(g, 7.8, -4, 2.3); g.beginPath(); g.moveTo(8.5, -5.5); g.quadraticCurveTo(12.5, -7, 13, -11); g.quadraticCurveTo(11, -7, 9.5, -3.8); g.fill()
  })
}
export function spider(g, x, y, { s = 1, face = 1, rot = 0, eye = '#ff4a2a' } = {}) {
  withT(g, x, y, s, face, rot, () => {
    for (let i = 0; i < 4; i++) { const bx = 1 - i * 1.2, fx = [9, 6, -5, -9][i] + (i < 2 ? 2 : -2), kx = bx + (fx - bx) * 0.45; line(g, [[bx, -5], [kx, -11 + i * 0.6], [fx, 0]], 1.1) }
    disc(g, -3.5, -6.5, 4.2); disc(g, 2.2, -5.2, 2.6)
    disc(g, 4.2, -5.8, 0.7, eye)
  })
}
export function bird(g, x, y, { s = 1, face = 1, flap = 0.5 } = {}) {
  withT(g, x, y, s, face, 0, () => {
    const up = -6 + flap * 12
    g.fillStyle = INK; g.beginPath(); g.moveTo(-9, up); g.quadraticCurveTo(-4, -1.5, 0, 0); g.quadraticCurveTo(5, -1.5, 10, up + 1)
    g.quadraticCurveTo(5, 0.4, 0, 1.6); g.quadraticCurveTo(-4, 0.4, -9, up); g.fill()
    g.beginPath(); g.ellipse(0.5, 0.6, 3.2, 1.3, 0, 0, 7); g.fill(); disc(g, 3.6, 0.1, 1.1)
  })
}
export function camel(g, x, y, { s = 1, col = INK, rider = false } = {}) {
  withT(g, x, y, s, 1, 0, () => {
    g.fillStyle = col; g.strokeStyle = col
    for (const lx of [-4, -2.5, 3, 4.5]) line(g, [[lx, -7], [lx + 0.3, 0]], 0.9, col)
    g.beginPath(); g.moveTo(-6, -7); g.quadraticCurveTo(-5.5, -10, -3, -10); g.quadraticCurveTo(-1, -13.5, 1, -10.5); g.quadraticCurveTo(3, -12.5, 5.5, -9.5); g.lineTo(6.5, -7); g.closePath(); g.fill()
    line(g, [[5.5, -8.5], [8, -12.5], [9.6, -12.5]], 1.4, col)
    if (rider) { line(g, [[-0.5, -11], [-0.5, -15]], 1.2, col); disc(g, -0.5, -16, 1, col) }
  })
}
export function turret(g, x, y, { s = 1, face = 1, aim = 0.2, muzzle = false } = {}) {
  withT(g, x, y, s, face, 0, () => {
    line(g, [[-16, 0], [16, 0]], 2.4)
    for (const fx of [-11, 11, 1]) line(g, [[fx, -1], [0, -14]], 1.4)
    g.save(); g.translate(0, -17); g.rotate(-aim)
    g.fillStyle = INK; g.beginPath(); g.roundRect(-7, -4.5, 13, 8, 2); g.fill()
    line(g, [[5, -1.6], [17, -1.6]], 1.4); line(g, [[5, 1.6], [17, 1.6]], 1.4)
    if (muzzle) { glow(g, 19, 0, 10, '255,190,60', 0.9); disc(g, 18.5, 0, 1.8, '#fff3c0') }
    g.restore()
  })
}
/** Stepped stone ring with a haze window. */
export function gate(g, x, y, { s = 1, accent = '#e0b050', inner = 'rgba(245,240,232,0.92)' } = {}) {
  withT(g, x, y, s, 1, 0, () => {
    g.fillStyle = inner; g.beginPath(); g.arc(0, -18, 13, 0, 7); g.fill()
    g.strokeStyle = accent; g.lineWidth = 1; g.globalAlpha = 0.9; g.beginPath(); g.arc(0, -18, 11, 0, 7); g.stroke(); g.globalAlpha = 1
    g.fillStyle = INK
    for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; g.save(); g.translate(Math.cos(a) * 16, -18 + Math.sin(a) * 16); g.rotate(a); g.fillRect(-2.2, -3.2, 4.4, 6.4); g.restore() }
    g.fillRect(-9, -2, 18, 2.5)
  })
}
export function crystals(g, x, y, { s = 1, glowRGB = '120,190,255', n = 5, seed = 3 } = {}) {
  let q = seed; const rnd = () => (q = (q * 16807) % 2147483647) / 2147483647
  glow(g, x, y - 8 * s, 22 * s, glowRGB, 0.35)
  withT(g, x, y, s, 1, 0, () => {
    for (let i = 0; i < n; i++) {
      const bx = (rnd() - 0.5) * 12, h = 10 + rnd() * 16 * (i === 0 ? 1.4 : 1), w = 1.6 + rnd() * 1.6, lean = (rnd() - 0.5) * 0.6 + bx * 0.03
      g.save(); g.translate(bx, 0); g.rotate(lean)
      g.fillStyle = INK; g.beginPath(); g.moveTo(-w, 0); g.lineTo(-w, -h * 0.75); g.lineTo(0, -h); g.lineTo(w, -h * 0.75); g.lineTo(w, 0); g.fill()
      g.strokeStyle = `rgba(${glowRGB},0.9)`; g.lineWidth = 0.7; g.beginPath(); g.moveTo(w * 0.3, -1); g.lineTo(w * 0.3, -h * 0.7); g.stroke()
      g.restore()
    }
  })
}
export function rocket(g, x, y, ang, { s = 1 } = {}) {
  withT(g, x, y, s, 1, -ang, () => {
    glow(g, -7, 0, 9, '255,150,40', 0.9); disc(g, -6.5, 0, 1.6, '#fff0c0')
    g.fillStyle = INK; g.beginPath(); g.roundRect(-6, -1.6, 10, 3.2, 1.2); g.fill()
    g.beginPath(); g.moveTo(4, -1.6); g.lineTo(7.5, 0); g.lineTo(4, 1.6); g.fill()
    g.beginPath(); g.moveTo(-6, -1.6); g.lineTo(-8, -3.6); g.lineTo(-4, -1.6); g.fill(); g.beginPath(); g.moveTo(-6, 1.6); g.lineTo(-8, 3.6); g.lineTo(-4, 1.6); g.fill()
  })
}

/** Soft, painterly smoke puffs along a path (darker than a pale sky). */
export function smoke(g, pts, { rgb = '70,58,48', a = 0.16, size = 7, grow = 2.2, seed = 5 } = {}) {
  let q = seed; const rnd = () => (q = (q * 16807) % 2147483647) / 2147483647
  pts.forEach((p, i) => { const t = i / (pts.length - 1); const r = size * (1 + (1 - t) * grow); const gr = g.createRadialGradient(p[0], p[1] - (1 - t) * 6, 0, p[0], p[1] - (1 - t) * 6, r)
    gr.addColorStop(0, `rgba(${rgb},${a * (0.3 + 0.7 * t)})`); gr.addColorStop(1, `rgba(${rgb},0)`); g.fillStyle = gr; g.beginPath(); g.arc(p[0] + (rnd() - 0.5) * 3, p[1] - (1 - t) * 6, r, 0, 7); g.fill() })
}
export function beam(g, a, b, rgb, w = 1.6) {
  g.save(); g.lineCap = 'round'
  for (const [lw, al] of [[w * 7, 0.12], [w * 3.5, 0.25], [w * 1.6, 0.6]]) { g.strokeStyle = `rgba(${rgb},${al})`; g.lineWidth = lw; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke() }
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = w * 0.6; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); g.restore()
}
export function tracer(g, a, b, rgb = '255,176,32') { beam(g, a, b, rgb, 1.2) }

export function explosion(g, x, y, { s = 1, seed = 9, smokeRGB = '40,28,20', ground = true } = {}) {
  let q = seed; const rnd = () => (q = (q * 16807) % 2147483647) / 2147483647
  // dark plume (silhouette, brushy)
  for (let i = 0; i < 26; i++) { const t = rnd(), px = x + (rnd() - 0.5) * (18 + t * 40) * s, py = y - t * 120 * s - 10 * s, r = (10 + t * 20 + rnd() * 8) * s
    const gr = g.createRadialGradient(px, py, 0, px, py, r); gr.addColorStop(0, `rgba(${smokeRGB},${0.5 - t * 0.3})`); gr.addColorStop(1, `rgba(${smokeRGB},0)`); g.fillStyle = gr; g.beginPath(); g.arc(px, py, r, 0, 7); g.fill() }
  glow(g, x, y, 90 * s, '255,110,30', 0.55)
  glow(g, x, y, 40 * s, '255,200,80', 0.9)
  // fire tongues
  for (let i = 0; i < 14; i++) { const a = rnd() * 6.283, r = (8 + rnd() * 16) * s; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r * 0.8 - 4 * s; glow(g, px, py, (10 + rnd() * 10) * s, rnd() < 0.5 ? '255,120,20' : '255,70,20', 0.8) }
  disc(g, x, y - 2 * s, 11 * s, 'rgba(255,248,220,0.95)')
  // sparks + debris
  for (let i = 0; i < 22; i++) { const a = -Math.PI * (0.05 + rnd() * 0.9), r0 = 16 * s, r1 = (40 + rnd() * 70) * s
    g.strokeStyle = 'rgba(255,190,70,0.9)'; g.lineWidth = 1.1; g.beginPath(); g.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0); g.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1 + (r1 / 60) ** 2 * 6); g.stroke() }
  for (let i = 0; i < 18; i++) { const a = -Math.PI * (0.05 + rnd() * 0.9), r = (40 + rnd() * 90) * s; g.fillStyle = INK; g.save(); g.translate(x + Math.cos(a) * r, y + Math.sin(a) * r); g.rotate(rnd() * 3); g.fillRect(-1.3, -1.3, 2 + rnd() * 2.5, 2 + rnd() * 2); g.restore() }
}

export function snow(g, n = 260, seed = 4, rgb = '250,250,255') {
  let q = seed; const rnd = () => (q = (q * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < n; i++) { const x = rnd() * W, y = rnd() * H, d = rnd(); const r = d < 0.9 ? 0.6 + d * 1.2 : 3 + rnd() * 5
    if (r > 2.5) glow(g, x, y, r * 1.6, rgb, 0.22); else disc(g, x, y, r, `rgba(${rgb},${0.35 + d * 0.4})`) }
}
export function grain(g, k = 0.05) {
  const id = g.createImageData(W, H); const d = id.data; let q = 7
  for (let i = 0; i < d.length; i += 4) { q = (q * 16807) % 2147483647; const v = q / 2147483647; d[i] = d[i + 1] = d[i + 2] = v > 0.5 ? 255 : 0; d[i + 3] = Math.abs(v - 0.5) * 255 * k }
  const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(id, 0, 0); g.drawImage(c, 0, 0)
}

/** Minimal HUD: thin ink type and hairline bars, team colour as the only accent. */
export function hudE({ timer = '2:57', ink = '#2a2019', accent = '#d8432a', dark = false, bottomLight = true, timerLight = false, centerDark = false } = {}) {
  const c = dark ? 'rgba(236,230,220,0.85)' : ink
  const cb = bottomLight ? 'rgba(240,232,220,0.85)' : c
  const d = document.createElement('div'); d.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;font-family:Georgia,'Times New Roman',serif;color:${c}`
  const bar = (label, v, col) => `<div style="display:flex;align-items:center;gap:10px;margin-top:7px"><span style="width:28px;font:11px/1 Georgia,serif;letter-spacing:.2em;opacity:.75">${label}</span><div style="width:130px;height:2px;background:rgba(236,230,220,.2)"><div style="width:${v}%;height:100%;background:${col}"></div></div></div>`
  const slot = (on, t) => `<div style="width:34px;height:22px;border-bottom:${on ? 2 : 1}px solid ${on ? accent : 'rgba(236,230,220,.35)'};font:11px Georgia,serif;letter-spacing:.08em;text-align:center;opacity:${on ? 1 : 0.6}">${t}</div>`
  d.innerHTML = `<div style="position:absolute;top:22px;left:0;right:0;text-align:center;font:300 22px/1 Georgia,serif;letter-spacing:.35em;opacity:.8;color:${timerLight ? 'rgba(236,230,220,.9)' : c}">${timer}</div>
    <div style="position:absolute;left:26px;bottom:24px;color:${cb}">${bar('HP', 78, accent)}${bar('EN', 100, cb)}${bar('JET', 62, cb)}</div>
    <div style="position:absolute;left:0;right:0;bottom:24px;display:flex;justify-content:center;gap:10px;color:${centerDark ? ink : cb}">${slot(false, '—')}${slot(true, 'RKT')}${slot(false, 'GUN')}${slot(false, 'GRN')}${slot(false, 'FLM')}${slot(false, 'LSR')}${slot(false, '—')}</div>`
  document.body.appendChild(d)
}
