// Shared rendering kit: renderer, backgrounds, derived-terrain shader, FX, post, HUD.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { W, H } from './world.js'

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p, int o){ float t=0., a=.5; for(int i=0;i<8;i++){ if(i>=o) break; t+=a*vnoise(p); p=p*2.03+17.1; a*=.5; } return t; }
`

export function makeRenderer({ shadows = false, scale = 1 } = {}) {
  const r = new THREE.WebGLRenderer({ antialias: scale === 1, preserveDrawingBuffer: true })
  r.setPixelRatio(1); r.setSize(W / scale, H / scale, false)
  r.domElement.style.cssText = `width:${W}px;height:${H}px;image-rendering:pixelated`
  r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.0
  if (shadows) { r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap }
  document.body.appendChild(r.domElement)
  return r
}

/** Ortho camera in mask pixel space (x right, world y = H - maskY). */
export function orthoCam() { const c = new THREE.OrthographicCamera(0, W, H, 0, -2000, 2000); c.position.z = 1000; return c }
export const wy = y => H - y

export function fieldTextures(d) {
  const f = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    f[i * 4] = Math.min(255, d.dIn[i] * 4); f[i * 4 + 1] = Math.min(255, d.dOut[i] * 4)
    f[i * 4 + 2] = d.back[i] ? 255 : 0; f[i * 4 + 3] = d.relief[i] * 255
  }
  const field = new THREE.DataTexture(f, W, H); field.flipY = false; field.magFilter = field.minFilter = THREE.LinearFilter; field.needsUpdate = true
  const albedo = new THREE.DataTexture(new Uint8Array(d.albedo.buffer), W, H); albedo.colorSpace = THREE.SRGBColorSpace
  albedo.magFilter = THREE.LinearFilter; albedo.minFilter = THREE.LinearFilter; albedo.needsUpdate = true
  return { field, albedo }
}

/** Fullscreen quad at depth z in ortho space */
export function screenQuad(mat, z) { const m = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat); m.position.set(W / 2, H / 2, z); m.frustumCulled = false; return m }

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`

// ---------------- background: parallax layers with baked depth-of-field ----------------
export const MOODS = {
  day: { top: [0.16, 0.34, 0.64], mid: [0.42, 0.62, 0.84], hor: [0.93, 0.82, 0.66], sunc: [1, 0.85, 0.6], cloud: [1, 0.95, 0.9], far: [0.52, 0.6, 0.78], forest: [0.24, 0.36, 0.34], near: [0.2, 0.3, 0.16], fog: [0.8, 0.8, 0.76], snow: 0.8, sunR: 21 },
  dusk: { top: [0.07, 0.07, 0.2], mid: [0.36, 0.22, 0.42], hor: [1.0, 0.52, 0.3], sunc: [1, 0.55, 0.25], cloud: [0.95, 0.5, 0.45], far: [0.3, 0.2, 0.36], forest: [0.13, 0.1, 0.18], near: [0.08, 0.07, 0.1], fog: [0.6, 0.35, 0.4], snow: 0.25, sunR: 34 },
}
export function meadowBackground({ sun = [210, 120], cam = 0, mood = 'day' } = {}) {
  const M = MOODS[mood], v3 = a => ({ value: new THREE.Vector3(...a) })
  return new THREE.ShaderMaterial({
    depthWrite: false,
    uniforms: { sun: { value: new THREE.Vector2(...sun) }, cam: { value: cam }, cTop: v3(M.top), cMid: v3(M.mid), cHor: v3(M.hor), cSun: v3(M.sunc), cCloud: v3(M.cloud), cFar: v3(M.far), cForest: v3(M.forest), cNear: v3(M.near), cFog: v3(M.fog), snowK: { value: M.snow }, sunR: { value: M.sunR } },
    vertexShader: VS,
    fragmentShader: NOISE_GLSL + /* glsl */ `
      varying vec2 vUv; uniform vec2 sun; uniform float cam, snowK, sunR; uniform vec3 cTop, cMid, cHor, cSun, cCloud, cFar, cForest, cNear, cFog;
      vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }
      // silhouette with blur width b (px): 1 below the ridge line
      float ridge(float y, float line, float b){ return smoothstep(line - b, line + b, y); }
      void main(){
        vec2 p = vec2(vUv.x*${W}.0, (1.-vUv.y)*${H}.0);  // px, y down
        float hz = p.y/${H}.0;
        vec3 top = lin(cTop), mid = lin(cMid), hor = lin(cHor);
        vec3 col = mix(top, mid, smoothstep(0.,0.45,hz)); col = mix(col, hor, smoothstep(0.35,0.8,hz));
        float ds = length(p - sun);
        col += lin(cSun) * (0.7*exp(-ds/(sunR*3.3)) + 0.18*exp(-ds/300.));
        col = mix(col, lin(cSun)*3., smoothstep(sunR+1.,sunR-1.,ds));
        // soft clouds (far = blurred = low octaves)
        float cl = fbm(vec2(p.x*0.0022 + cam*0.05, p.y*0.006), 5);
        float cm = smoothstep(0.55, 0.68, cl) * smoothstep(0.55, 0.1, hz);
        float lit = clamp(1.0 - (fbm(vec2(p.x*0.0022+cam*0.05 - 0.02, p.y*0.006 - 0.06),5) - cl)*6.0, 0.4, 1.2);
        col = mix(col, lin(cCloud)*lit, cm*0.75);
        // god rays
        vec2 dir = normalize(p - sun); float ang = atan(dir.y, dir.x);
        float rays = pow(vnoise(vec2(ang*9., 0.)), 3.) * exp(-ds/600.) * 0.12;
        col += lin(cSun) * rays * smoothstep(0.,0.6,hz);
        // far mountains (very blurred, strong haze)
        float m1 = 330. - 150.*fbm(vec2(p.x*0.0025 + cam*0.1, 1.3), 5) + 40.;
        float a1 = ridge(p.y, m1, 5.);
        vec3 c1 = mix(lin(cFar), hor, 0.35);
        c1 += lin(cSun) * 0.25 * smoothstep(m1+30., m1, p.y) * (1.-p.x/${W}.0); // sunlit rims
        col = mix(col, c1 * (0.85 + 0.2*fbm(p*0.01,3)), a1);
        // snow caps on far peaks
        col = mix(col, lin(vec3(0.9,0.93,1.0))*snowK*1.25, a1 * smoothstep(m1+28., m1+6., p.y) * smoothstep(250., 210., m1) * 0.8);
        // mid forest ridge (blurred ~3px)
        float m2 = 450. - 110.*fbm(vec2(p.x*0.004 + cam*0.25 + 4., 2.7), 4);
        float canopy = 0.;
        for (int k=0;k<3;k++){ float sc = 17. + float(k)*9.; float cx = p.x/sc + float(k)*0.37 + vnoise(vec2(p.x*0.013,float(k)))*1.3; float fx = fract(cx) - 0.5;
          float tr = hash12(vec2(floor(cx), 3.+float(k))); if (tr < 0.35) continue; tr = 0.4 + 0.6*tr;
          canopy = max(canopy, sqrt(max(0., tr*tr*0.25 - fx*fx)) * 2. * tr * sc * 1.1); }
        float m2t = m2 - canopy + 8.;
        float a2 = ridge(p.y, m2t, 4.);
        vec3 c2 = mix(lin(cForest), hor, 0.35);
        c2 = mix(c2, lin(cFog), smoothstep(m2t, m2t+200., p.y)*0.5); // valley mist
        col = mix(col, c2, a2);
        // near hills (still behind the play layer, blur ~1.5px)
        float m3 = 560. - 90.*fbm(vec2(p.x*0.005 + cam*0.5 + 9., 4.1), 4);
        float a3 = ridge(p.y, m3, 1.5);
        vec3 c3 = mix(lin(cNear), hor, 0.18) * (0.8 + 0.4*fbm(p*vec2(0.02,0.05),3));
        c3 += lin(cSun) * 0.35 * smoothstep(m3+14., m3, p.y);
        col = mix(col, c3, a3);
        // valley fog band
        col = mix(col, lin(cFog), 0.2*smoothstep(540., 720., p.y)*(0.6+0.4*fbm(vec2(p.x*0.004,p.y*0.02),3)));
        // bokeh: out-of-focus pollen discs
        for (int k=0;k<3;k++){
          float sc = 70. + float(k)*45.;
          vec2 g = p / sc; vec2 id = floor(g); vec2 f = fract(g);
          float h = hash12(id + float(k)*13.1);
          if (h > 0.9 && hz > 0.35) {
            vec2 c = vec2(hash12(id+3.1), hash12(id+7.7))*0.6+0.2;
            float r = (0.12 + 0.1*hash12(id+1.3)) ;
            float d = length(f - c);
            float disc = smoothstep(r, r-0.02, d);
            float ring = smoothstep(r-0.05, r-0.01, d)*disc;
            col += lin(cSun) * (disc*0.025 + ring*0.03) * (1.2 - hz);
          }
        }
        gl_FragColor = vec4(col, 1.);
      }`,
  })
}

export function spaceBackground() {
  return new THREE.ShaderMaterial({
    depthWrite: false, uniforms: {},
    vertexShader: VS,
    fragmentShader: NOISE_GLSL + /* glsl */ `
      varying vec2 vUv;
      void main(){
        vec2 p = vec2(vUv.x*${W}.0, (1.-vUv.y)*${H}.0);
        vec3 col = vec3(0.004,0.006,0.014);
        // nebula: two warped fbm clouds, blurred (far)
        vec2 q = p*0.0022; vec2 wv = vec2(fbm(q+1.7,5), fbm(q+9.2,5));
        float n1 = fbm(q*1.3 + wv*1.8, 6);
        float n2 = fbm(q*2.1 - wv*1.2 + 4., 5);
        col += vec3(0.18,0.05,0.22) * pow(smoothstep(0.35,0.85,n1),1.6) * 1.3;
        col += vec3(0.02,0.12,0.22) * pow(smoothstep(0.4,0.9,n2),1.4) * 1.4;
        col += vec3(0.5,0.2,0.1) * pow(smoothstep(0.62,0.9,n1*n2*1.6),2.) * 0.6;
        // dust lanes
        col *= 0.55 + 0.45*smoothstep(0.3,0.6,fbm(q*3.+wv,5));
        // stars (3 depths; far = small, near = bokeh)
        for (int k=0;k<3;k++){
          float sc = 3.0 + float(k)*9.;
          vec2 g = p/sc; vec2 id = floor(g); vec2 f = fract(g);
          float h = hash12(id + float(k)*31.);
          float th = k==0 ? 0.985 : (k==1 ? 0.993 : 0.9965);
          if (h > th){
            vec2 c = vec2(hash12(id+1.),hash12(id+2.))*0.6+0.2;
            float d = length(f-c)*sc;
            vec3 sc3 = mix(vec3(1.,.8,.6), vec3(.6,.8,1.), hash12(id+5.));
            if (k<2) col += sc3 * (k==0?1.2:2.5) * exp(-d*d/(k==0?0.6:1.4));
            else { float r = 4.5; col += sc3*0.25*(smoothstep(r, r-1., d) + 2.*smoothstep(r-1.8,r-0.6,d)*smoothstep(r,r-0.6,d)); }
          }
        }
        // planet with atmosphere rim, lower right, far & slightly soft
        vec2 pc = vec2(1060., 980.); float pr = 520.; float dp = length(p - pc);
        if (dp < pr + 60.) {
          vec2 n2d = (p-pc)/pr; float z = sqrt(max(0., 1.-dot(n2d,n2d)));
          vec3 nrm = vec3(n2d, z); vec3 L = normalize(vec3(-0.8,-0.5,0.35));
          float bands = fbm(vec2(n2d.x*2., n2d.y*14.) + fbm(n2d*5.,4), 5);
          vec3 alb = mix(vec3(0.55,0.35,0.22), vec3(0.85,0.7,0.5), bands);
          float dif = clamp(dot(nrm, vec3(L.x,-L.y,L.z)),0.,1.);
          vec3 pcol = alb * dif * 1.1;
          float inside = smoothstep(pr+1.5, pr-1.5, dp);
          col = mix(col, pcol, inside);
          float rim = exp(-abs(dp-pr)/14.) * clamp(dot(normalize(p-pc), normalize(vec2(-0.8,-0.5)))+0.3,0.,1.);
          col += vec3(0.3,0.6,1.2)*rim*0.9;
        }
        gl_FragColor = vec4(col, 1.);
      }`,
  })
}

// ---------------- terrain: lit 2.5D from the mask's distance field ----------------
export const MAX_PL = 10
/** lights: [{x,y (mask px), z (height px), r (radius px), color:[r,g,b] linear, i}] */
export function terrainMaterial({ field, albedo, occl, sunDir = [-0.5, 0.72, 0.42], sunCol = [1.7, 1.45, 1.12], sky = [0.35, 0.48, 0.7], ground = [0.28, 0.2, 0.14], lights = [], bevel = 16, rimCol = [0.5, 0.7, 1.0], interior = 0.55, pixel = 1, ambient = 1, rimK = 0.12, lava = [0, 0, 0], lavaK = 0, lipK = 0, lipCol = [1, 1, 1] }) {
  const pl = [], plc = []
  for (let i = 0; i < MAX_PL; i++) { const l = lights[i]; pl.push(l ? new THREE.Vector4(l.x, l.y, l.z, l.r) : new THREE.Vector4(0, 0, 0, 1)); plc.push(l ? new THREE.Vector3(...l.color).multiplyScalar(l.i ?? 1) : new THREE.Vector3()) }
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      field: { value: field }, albedo: { value: albedo }, occl: { value: occl },
      sunDir: { value: new THREE.Vector3(...sunDir).normalize() }, sunCol: { value: new THREE.Vector3(...sunCol) },
      sky: { value: new THREE.Vector3(...sky) }, ground: { value: new THREE.Vector3(...ground) }, rimCol: { value: new THREE.Vector3(...rimCol) },
      pl: { value: pl }, plc: { value: plc }, bevel: { value: bevel }, interior: { value: interior }, pixel: { value: pixel }, ambient: { value: ambient }, rimK: { value: rimK }, lava: { value: new THREE.Vector3(...lava) }, lavaK: { value: lavaK }, lipK: { value: lipK }, lipCol: { value: new THREE.Vector3(...lipCol) },
    },
    vertexShader: VS,
    fragmentShader: NOISE_GLSL + /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D field, albedo, occl; uniform vec3 sunDir, sunCol, sky, ground, rimCol; uniform float bevel, interior, pixel, ambient, rimK, lavaK, lipK; uniform vec3 lava, lipCol;
      uniform vec4 pl[${MAX_PL}]; uniform vec3 plc[${MAX_PL}];
      const vec2 RES = vec2(${W}.0, ${H}.0);
      vec4 F(vec2 p){ return texture2D(field, p/RES); }          // p: mask px, y down (texture row 0 = mask row 0)
      float sd(vec2 p){ vec4 f = F(p); return f.r*64. - f.g*64.; }   // + inside
      float height(vec2 p){ float d = clamp(sd(p)/bevel, 0., 1.); return bevel * sqrt(1. - (1.-d)*(1.-d)) + F(p).a*7.*d; }
      float lum(vec2 p){ vec3 c = texture2D(albedo, p/RES).rgb; return dot(c, vec3(.3,.5,.2)); }
      void main(){
        vec2 p = vec2(vUv.x, 1.-vUv.y) * RES;
        p = (floor(p/pixel)+0.5)*pixel;
        vec4 f = F(p);
        float s = sd(p);
        float cover = clamp(s + 0.5, 0., 1.);
        bool isBack = f.b > 0.5;
        vec4 alb = texture2D(albedo, p/RES);
        bool fringe = alb.a > 0.62 && alb.a < 0.95 && s < 0.5;
        if (fringe) {
          vec3 nf = normalize(vec3(-0.2, 0.6, 0.75));
          vec3 c = alb.rgb * (sunCol * max(dot(nf, sunDir), 0.) * 1.1 + sky * 0.7);
          for (int i=0;i<${MAX_PL};i++){ vec3 lp = vec3(pl[i].x, ${H}.0 - pl[i].y, pl[i].z); float d = length(lp - vec3(p.x, ${H}.0-p.y, 8.)); c += alb.rgb * plc[i] * pow(clamp(1. - d/pl[i].w, 0., 1.), 2.); }
          gl_FragColor = vec4(c, 1.); return;
        }
        if (cover <= 0.001 && !isBack) discard;
        // --- surface normal from the bevel + albedo micro-relief
        float e = 1.5*pixel;
        float hx = height(p+vec2(e,0.)) - height(p-vec2(e,0.));
        float hy = height(p+vec2(0.,e)) - height(p-vec2(0.,e));
        float bx = lum(p+vec2(1.,0.)) - lum(p-vec2(1.,0.));
        float by = lum(p+vec2(0.,1.)) - lum(p-vec2(0.,1.));
        vec3 n = normalize(vec3(-hx/(2.*e) - bx*1.5, hy/(2.*e) + by*1.5, 1.)); // world: x right, y up, z toward viewer
        vec3 wp = vec3(p.x, ${H}.0 - p.y, height(p));
        vec3 col;
        if (cover > 0.001) {
          vec3 a = alb.rgb;
          // sun, with self-shadow: march toward the sun in the mask
          float sh = 1.;
          vec2 sd2 = normalize(vec2(sunDir.x, -sunDir.y));
          for (int i=1;i<=10;i++){ vec2 q = p + sd2*float(i)*5.; float o = clamp(sd(q)+0.5,0.,1.); float hq = height(q); sh = min(sh, 1. - o*smoothstep(-2., 6., hq - (wp.z + float(i)*5.*sunDir.z/length(sunDir.xy)*0.45))); }
          sh = mix(1., sh, 0.8);
          float ndl = max(dot(n, sunDir), 0.);
          vec3 lit = sunCol * ndl * sh;
          vec3 amb = mix(ground, sky, n.y*0.5+0.5) * ambient;
          // interior darkening: the far-from-edge face reads as a receding mass
          float depth = smoothstep(14., 64., f.r*64.);
          amb *= 1. - interior*depth; lit *= 1. - interior*0.6*depth;
          // object contact shadow (drop shadow on the terrain face)
          float oc = 0.; vec2 off = sd2*7.;
          for (int i=0;i<5;i++){ for(int j=0;j<5;j++){ oc += texture2D(occl, (p + off + vec2(float(i)-2.,float(j)-2.)*2.5)/RES*vec2(1.,-1.)+vec2(0.,1.)).r; } }
          oc /= 25.;
          lit *= 1. - 0.75*oc; amb *= 1. - 0.45*oc;
          // rim light on edges facing away from the sun
          float rim = pow(1. - n.z, 1.5) * max(dot(normalize(n.xy+1e-4), -normalize(sunDir.xy)), 0.);
          vec3 pls = vec3(0.);
          for (int i=0;i<${MAX_PL};i++){
            vec3 lp = vec3(pl[i].x, ${H}.0 - pl[i].y, pl[i].z);
            vec3 L = lp - wp; float d = length(L); L /= d;
            float att = pow(clamp(1. - d/pl[i].w, 0., 1.), 2.);
            pls += plc[i] * att * (max(dot(n, L), 0.)*0.85 + 0.15);
          }
          // wet/specular glint on the bevel
          vec3 hv = normalize(sunDir + vec3(0.,0.,1.));
          float spec = pow(max(dot(n, hv), 0.), 40.) * (1.-depth) * 0.25 * sh;
          col = a * (lit + amb + pls) + rimCol * rim * rimK * sh + sunCol*spec;
          // lip light: the top edge catches the sky (reads the silhouette in the dark)
          float upv = sd(p + vec2(0., 3.)) - s;
          col += lipCol * lipK * smoothstep(5., 0., s) * smoothstep(0.5, 2.5, upv);
          if (lavaK > 0.) { float cr = fbm(p*vec2(0.012, 0.03) + fbm(p*0.01, 3)*2., 5); float seam = smoothstep(0.012, 0.0, abs(cr - 0.5)) * smoothstep(28., 60., f.r*64.) * smoothstep(0.35, 0.7, vnoise(p*0.006));
            col += lava * lavaK * seam * (0.6 + 0.4*vnoise(p*0.05)); col += lava*0.05*lavaK*smoothstep(0.7, 1.0, p.y/${H}.0); }
          // grass tips catching light on top edges
          col += a * sunCol * 0.25 * smoothstep(0.4, 0.9, n.y) * sh;
        }
        vec3 bcol = vec3(0.);
        if (isBack) {
          // backdrop wall: set back behind the front face; the front casts shadow onto it
          vec3 a = alb.rgb;
          vec2 sd2 = normalize(vec2(sunDir.x, -sunDir.y));
          float sh = 0.; for (int i=0;i<6;i++){ vec2 q = p + sd2*(8. + float(i)*6.); sh = max(sh, clamp(sd(q)+0.5,0.,1.)); }
          float ao = smoothstep(0., 26., f.g*64.);
          vec3 pls = vec3(0.);
          for (int i=0;i<${MAX_PL};i++){ vec3 lp = vec3(pl[i].x, ${H}.0 - pl[i].y, pl[i].z); vec3 L = lp - vec3(wp.xy, -30.); float d = length(L); float att = pow(clamp(1. - d/pl[i].w,0.,1.),2.); pls += plc[i]*att*max(L.z/d,0.)*0.8; }
          bcol = a * ((sunCol*0.55*(1.-sh) + sky*0.35) * (0.35 + 0.65*ao) + pls);
          if (cover <= 0.001) { gl_FragColor = vec4(bcol, 1.); return; }
          col = mix(bcol, col, cover); cover = 1.;
        }
        gl_FragColor = vec4(col, cover);
      }`,
  })
}

// ---------------- foreground: near-camera leaves, heavily defocused ----------------
export function foregroundDoF({ tint = [0.02, 0.035, 0.02], spots = [] } = {}) {
  // spots: [{x,y,r,n}] clusters of leaves (mask px)
  const u = spots.map(s => new THREE.Vector4(s.x, s.y, s.r, s.n ?? 8))
  while (u.length < 6) u.push(new THREE.Vector4(-999, -999, 1, 0))
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    uniforms: { spots: { value: u }, tint: { value: new THREE.Vector3(...tint) } },
    vertexShader: VS,
    fragmentShader: NOISE_GLSL + `
      varying vec2 vUv; uniform vec4 spots[6]; uniform vec3 tint;
      void main(){
        vec2 p = vec2(vUv.x*${W}.0, (1.-vUv.y)*${H}.0);
        float a = 0.; float rim = 0.;
        for (int s=0;s<6;s++){
          vec4 sp = spots[s];
          for (int k=0;k<12;k++){
            if (float(k) >= sp.w) break;
            float h1 = hash12(vec2(float(k), float(s))), h2 = hash12(vec2(float(k)+5., float(s)+1.)), h3 = hash12(vec2(float(k)+9., float(s)+3.));
            vec2 c = sp.xy + (vec2(h1,h2)-0.5)*sp.z*1.6;
            float ang = h3*6.283; vec2 d = p - c; d = mat2(cos(ang),-sin(ang),sin(ang),cos(ang))*d;
            float L = sp.z*(0.55+0.4*h2);
            float leaf = length(vec2(d.x/(L), d.y/(L*0.36)));
            float blur = 0.22;
            float m = smoothstep(1.+blur, 1.-blur, leaf);
            a = max(a, m);
            rim += smoothstep(1.+blur, 1., leaf)*smoothstep(0.6,1.,leaf)*step(0., d.y);
          }
        }
        vec3 col = tint + vec3(0.25,0.2,0.08)*clamp(rim,0.,1.)*0.3;
        gl_FragColor = vec4(col, a*0.96);
      }`,
  })
}

// ---------------- FX ----------------
function canvasTex(size, draw) { const c = document.createElement('canvas'); c.width = c.height = size; draw(c.getContext('2d'), size); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t }
export const softTex = () => canvasTex(128, (g, s) => { const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, s, s) })
let _seed = 7; export const rnd = () => (_seed = (_seed * 16807) % 2147483647) / 2147483647
export const smokeTex = () => canvasTex(128, (g, s) => {
  for (let i = 0; i < 14; i++) {
    const x = s / 2 + (rnd() - 0.5) * s * 0.45, y = s / 2 + (rnd() - 0.5) * s * 0.45, r = s * (0.12 + rnd() * 0.2)
    const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill()
  }
})

export function sprite(tex, x, y, z, size, color, opacity = 1, additive = false, rot = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: true }))
  m.position.set(x, y, z); m.rotation.z = rot; return m
}

/** Ribbon along a polyline (world coords) with a glowing core; fade from tail (0) to head (1). */
export function ribbon(pts, width, core, glow, { z = 40, fadePow = 1.5, headBoost = 1 } = {}) {
  const pos = [], uv = [], idx = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]
    let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l
    const t = i / (pts.length - 1), w = width * (pts[i][2] ?? 1)
    pos.push(pts[i][0] - dy * w / 2, pts[i][1] + dx * w / 2, z, pts[i][0] + dy * w / 2, pts[i][1] - dx * w / 2, z)
    uv.push(t, 0, t, 1)
    if (i) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k) }
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx)
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { core: { value: new THREE.Vector3(...core) }, glow: { value: new THREE.Vector3(...glow) }, fp: { value: fadePow }, hb: { value: headBoost } },
    vertexShader: VS,
    fragmentShader: `varying vec2 vUv; uniform vec3 core, glow; uniform float fp, hb;
      void main(){ float y = abs(vUv.y-0.5)*2.; float f = pow(vUv.x, fp) * (1. + hb*smoothstep(0.85,1.,vUv.x));
        vec3 c = core*exp(-y*y*28.) + glow*exp(-y*y*3.5);
        gl_FragColor = vec4(c*f, 1.); }`,
  })
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; return m
}

/** Fireball billboard (shader), plus smoke, sparks, ring. Returns group. (x,y world) */
export function explosion(x, y, s = 1, { smoke = 0x2a2522, z = 60 } = {}) {
  const g = new THREE.Group()
  const soft = softTex(), sm = smokeTex()
  // smoke behind
  for (let i = 0; i < 22; i++) {
    const a = rnd() * 6.283, r = (30 + rnd() * 60) * s
    const up = rnd()
    const c = new THREE.Color(smoke).multiplyScalar(0.8 + up * 1.2)
    g.add(sprite(sm, x + Math.cos(a) * r * 0.8, y + 20 * s + up * 110 * s + Math.sin(a) * 20 * s, z - 5 + i * 0.1, (60 + rnd() * 70) * s * (0.7 + up * 0.6), c, 0.55 + up * 0.3, false, rnd() * 6))
  }
  const fire = new THREE.Mesh(new THREE.PlaneGeometry(190 * s, 190 * s), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: VS,
    fragmentShader: NOISE_GLSL + `varying vec2 vUv;
      void main(){ vec2 p = vUv*2.-1.; float r = length(p);
        float n = fbm(p*3.2 + vec2(0.,-0.4), 6); float n2 = fbm(p*7. + n*2., 4);
        float shape = smoothstep(0.78, 0.2, r + (n-0.5)*0.75 + (n2-0.5)*0.25);
        float temp = shape * (1.25 - r*0.9) * (0.7 + n2*0.6);
        vec3 c = vec3(0.9,0.16,0.02)*smoothstep(0.,0.3,temp) + vec3(1.0,0.45,0.06)*smoothstep(0.25,0.6,temp) + vec3(1.2,0.9,0.4)*smoothstep(0.6,0.95,temp) + vec3(2.,1.8,1.4)*smoothstep(0.95,1.15,temp);
        float soot = smoothstep(0.45, 0.7, n2) * (1. - smoothstep(0.5, 0.9, temp));
        gl_FragColor = vec4(c*1.1*shape*(1. - 0.6*soot), 1.); }`,
  }))
  fire.position.set(x, y, z + 4); g.add(fire)
  g.add(sprite(soft, x, y, z + 3, 280 * s, new THREE.Color(1.0, 0.35, 0.08), 0.14, true))
  // shock ring
  const ring = new THREE.Mesh(new THREE.RingGeometry(118 * s, 126 * s, 96), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 0.55, 0.5), transparent: true, opacity: 0.04, blending: THREE.AdditiveBlending, depthWrite: false }))
  ring.position.set(x, y, z + 2); g.add(ring)
  // sparks: streaks
  for (let i = 0; i < 22; i++) {
    const a = -Math.PI * (0.05 + rnd() * 0.9) + (rnd() < 0.2 ? Math.PI : 0), r0 = 40 * s, r1 = (90 + rnd() * 130) * s
    const pts = []; for (let k = 0; k <= 6; k++) { const t = k / 6, rr = r0 + (r1 - r0) * t; pts.push([x + Math.cos(a) * rr, y - Math.sin(a) * rr - t * t * 30 * s, 1 - t * 0.5]) }
    g.add(ribbon(pts, 2.5 * s, [2.2, 1.2, 0.4], [0.5, 0.15, 0.02], { z: z + 6, fadePow: 0.7 }))
  }
  return g
}

export function smokeTrail(pts, { z = 38, color = 0xcfc8c0, size = 16, grow = 3 } = {}) {
  const g = new THREE.Group(), sm = smokeTex()
  pts.forEach((p, i) => {
    const t = i / (pts.length - 1)
    const c = new THREE.Color(color).multiplyScalar(0.8 + 0.3 * rnd())
    g.add(sprite(sm, p[0] + (rnd() - 0.5) * 6 * (1 - t), p[1] + (rnd() - 0.5) * 6 * (1 - t) + (1 - t) * 10, z, size * (1 + (1 - t) * grow), c, 0.12 + 0.5 * t, false, rnd() * 6))
  })
  return g
}

// ---------------- post: bloom + grade ----------------
export function post(renderer, scene, camera, { bloom = [0.32, 0.4, 0.92], grade = {}, scale = 1 } = {}) {
  const rt = new THREE.WebGLRenderTarget(W / scale, H / scale, { type: THREE.HalfFloatType, samples: scale === 1 ? 4 : 0 })
  const comp = new EffectComposer(renderer, rt)
  comp.addPass(new RenderPass(scene, camera))
  comp.addPass(new UnrealBloomPass(new THREE.Vector2(W / scale, H / scale), ...bloom))
  comp.addPass(new OutputPass())
  comp.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null }, vig: { value: grade.vignette ?? 0.35 }, warm: { value: new THREE.Vector3(...(grade.warm ?? [1.03, 1.0, 0.95])) }, cool: { value: new THREE.Vector3(...(grade.cool ?? [0.94, 0.98, 1.06])) }, sat: { value: grade.sat ?? 1.08 } },
    vertexShader: VS,
    fragmentShader: NOISE_GLSL + `varying vec2 vUv; uniform sampler2D tDiffuse; uniform float vig, sat; uniform vec3 warm, cool;
      void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb;
        float l = dot(c, vec3(.3,.59,.11)); c = mix(vec3(l), c, sat);
        c *= mix(cool, warm, smoothstep(0.2,0.8,l));
        vec2 q = vUv-0.5; c *= 1. - vig*dot(q,q)*1.6;
        c += (hash12(floor(vUv*${W}.0)) - 0.5)*0.018;
        gl_FragColor = vec4(c,1.); }`,
  }))
  return comp
}

// ---------------- HUD (DOM overlay, identical across variants) ----------------
export function hud({ timer = '2:57', style = 'new' } = {}) {
  const d = document.createElement('div')
  const bar = (label, v, c) => `<div style="display:flex;align-items:center;gap:8px;margin-top:6px"><span style="width:30px;font:600 11px/1 system-ui;letter-spacing:.08em;color:#cfd8e0">${label}</span><div style="width:150px;height:9px;background:rgba(10,14,20,.6);border-radius:5px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)"><div style="width:${v}%;height:100%;background:${c};box-shadow:0 0 8px ${c}"></div></div></div>`
  const slot = (on, t) => `<div style="width:42px;height:42px;border-radius:8px;background:rgba(12,16,22,.55);box-shadow:inset 0 0 0 ${on ? 2 : 1}px ${on ? '#ffd166' : 'rgba(255,255,255,.14)'};backdrop-filter:blur(4px);color:#dfe6ee;font:600 10px system-ui;display:flex;align-items:flex-end;justify-content:flex-end;padding:3px;box-sizing:border-box">${t}</div>`
  if (style === 'old') {
    d.innerHTML = `<div style="position:fixed;top:12px;left:0;right:0;text-align:center;font:700 34px monospace;color:#fff;text-shadow:2px 2px #334">${timer}</div>`
  } else {
    d.innerHTML = `<div style="position:fixed;top:14px;left:0;right:0;text-align:center;font:700 26px/1 system-ui;color:#fff;letter-spacing:.06em;text-shadow:0 2px 10px rgba(0,0,0,.45)">${timer}</div>
    <div style="position:fixed;left:18px;bottom:18px;padding:8px 12px 10px;border-radius:10px;background:rgba(10,14,20,.35);backdrop-filter:blur(6px)">${bar('HP', 78, '#5ee37a')}${bar('EN', 100, '#4fb3ff')}${bar('JET', 62, '#ffc247')}</div>
    <div style="position:fixed;left:0;right:0;bottom:18px;display:flex;justify-content:center;gap:6px">${slot(false, '')}${slot(true, 'x4')}${slot(false, 'x60')}${slot(false, 'x2')}${slot(false, '200')}${slot(false, 'x2')}${slot(false, '')}</div>`
  }
  document.body.appendChild(d)
}
