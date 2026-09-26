/**
 * T23.04: the sky — a port of `mockup-src/e_style.js::bgQuad` / `bgMaterial` (sky gradient,
 * horizon glow, haze band, ≤6 stepped layers — pyramid / ziggurat / arc / mesa — with step,
 * softness, fade and jitter, stars, grain, god rays, ≤3 moons whose rays the layers occlude).
 *
 * **Verbatim where the mockup has an answer**: every expression below is `bgMaterial`'s, line
 * for line, `NOISE_GLSL` is `kit.js`'s, and the uniforms are packed the way it packs them — so with
 * every offset zero (the look-lab's scenes) this draws the pictures' sky, which `look-sky` measures.
 *
 * **What is added** (`skyLayout.ts` computes it): per layer `E = (offset x, offset y, period,
 * seed)` — the band is moved by its parallax offset and, with a period, drawn as a repeating row
 * of the mockup's shape whose copies' apexes the seed jitters (`jitterY`); `skyOff` moves the
 * gradient, horizon glow, haze band and sky grain with the farthest layer. Stars, grain, the sun
 * and the moons are at parallax 0. The frame size is a uniform (`RES`, the game's 1280×720 — R18).
 *
 * **Baked, then composited (T23.04B, R21).** Nothing in the sky changes on its own, and each part
 * of it only ever moves rigidly in one frame of reference: the gradient with `skyOff`, each band
 * with its own offset, the sun, moons, stars and rays not at all. So `bgMaterial` is split at
 * those seams and each part is shaded **once per map and tier** into a float32 target
 * (`BAKE`), and each frame only samples them (`COMPOSITE`: ≤11 nearest texture reads at
 * coordinates interpolated from the corners, a few mixes, the grain hash and `lin`'s pow).
 * Measured on the checks' SwiftShader in a match, 640×360: 38 ms per draw → ~6 (a flat quad is
 * ~4.5), panning 21 → 60 fps. The split is exact algebra, not an approximation:
 *
 * - `col = gradient(ps)·K(p) + Bp(p) + starK(p)·1.3·skyOff.y/H` — the sun, stars and moon discs
 *   are each `col·(1−a) + c` (a mix) or `col + c`, so their chain folds into one scale `K` and one
 *   offset `Bp`; the stars' `(1 − 1.3·h)` reads `ps`, which is linear in `skyOff.y`, so its
 *   `skyOff` part is carried by `starK` (the stars scaled by the moon discs drawn over them).
 * - each band's colour and alpha are a function of its own `q = p − E` only: baked over every `q`
 *   any camera in the map reaches (`skyLayout.ts::bakeExtents`), mixed in slot order as before.
 * - the rays are `R(p)·(1 − 0.75·occ) + M(p)·(1 − 0.8·occ)` = `(R+M) − occ·(0.75R + 0.8M)`.
 * - the horizon glow and the haze band's weight are functions of `ps` alone: baked beside the
 *   gradient (`Q`). The grain (a hash of the pixel's position) and `lin` stay per pixel, verbatim.
 *
 * Offsets are snapped to whole baked texels (`skyLayout.ts::snapOffsets`), so every screen pixel's
 * centre is a baked texel's centre and each frame is exactly `bgMaterial` at the snapped offset.
 * **Rebaked** only when the sky (the map seed), the tier (the texel size) or the extents (the
 * view's zoom, the map's size) change — never by a pan, a hidden band or the redraw skip.
 *
 * **Not animated.** `bgMaterial` has no clock: its stars are a static hash grid and its god rays
 * a function of angle only. So the layer is registered `animated: false` and the redraw skip
 * stays valid; a still camera redraws nothing. (R7's moving moons and star fade by darkness are
 * T23.11's, and will change that.)
 */
import {
  FloatType,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import type { Background, ViewRect } from './scene'
import type { Extent, Offset } from './skyLayout'
import { APEX_JITTER, bakeExtents, snapOffsets } from './skyLayout'
import { hexLinear } from './worldRenderer-math'

/** `kit.js::NOISE_GLSL`, verbatim. */
export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p, int o){ float t=0., a=.5; for(int i=0;i<8;i++){ if(i>=o) break; t+=a*vnoise(p); p=p*2.03+17.1; a*=.5; } return t; }
`

/** `bgMaterial`'s layer slots. */
export const SKY_LAYERS = 6
/** `bgMaterial`'s moon slots. */
export const SKY_MOONS = 3
const SHAPE = { pyramid: 0, zig: 1, arc: 2, mesa: 3 } as const

const v3 = (h: number): Vector3 => new Vector3(...hexLinear(h))

const VSQ = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.,1.); }'

const N = SKY_LAYERS

/** What a bake pass writes: `Bp,K`; `R+M, starK`; `0.75R+0.8M`; the gradient; one band; the glow and haze-band weight. */
const MODE = { base: 0, rays: 1, raysOcc: 2, gradient: 3, layer: 4, post: 5 } as const

/**
 * The bake: `bgMaterial` evaluated at `p = org + uv·ext` (frame px, y down), one part per pass
 * (`mode`). Each part is the mockup's expressions verbatim, only regrouped as the header says.
 */
const BAKE =
  NOISE_GLSL +
  /* glsl */ `varying vec2 vUv; uniform vec4 A[${N}], B[${N}], D[${N}], E[${N}]; uniform vec3 C[${N}]; uniform vec3 skyTop, skyBottom, haze, sunC; uniform float horizon, stars, jitterY; uniform vec4 sun, rays; uniform vec3 rayC, glowC; uniform vec2 RES, glowY; uniform vec4 MO[3], ML[3]; uniform vec3 MC[3];
  uniform int mode, li; uniform vec2 org, ext;
  float edgeY(int i, float x, float ay){
    vec4 a = A[i], b = B[i]; float t = b.x;
    if (t < 0.5) return ay + abs(x - a.x)*a.z;
    if (t < 1.5) { float dx = max(0., abs(x - a.x) - b.y); float yy = ay + dx*a.z; return ay + floor((yy - ay)/(a.w*5.))*(a.w*5.) + fract((yy-ay)/(a.w*5.))*a.w*5.*0.35; }
    if (t < 2.5) { float dx = x - a.x; float r = a.z; return abs(dx) < r ? ay - sqrt(r*r - dx*dx) + r : 1e5; }
    float dx = max(0., abs(x - a.x) - b.y); return ay + dx*a.z*(1. + 0.8*fbm(vec2(x*0.02, float(i)), 2));
  }
  // T23.04: a band — the shape once (period 0, the mockup's), or repeated every E.z px with each
  // copy's apex moved by the seed; the two copies either side of x, the higher edge wins.
  float bandY(int i, float x){
    float P = E[i].z;
    if (P <= 0.) return edgeY(i, x, A[i].y);
    float k0 = floor((x - A[i].x)/P);
    float e = 1e5;
    for (int j=0;j<2;j++){ float k = k0 + float(j);
      float ay = A[i].y + (hash12(vec2(k, E[i].w)) - 0.5)*2.*jitterY;
      e = min(e, edgeY(i, x - k*P, ay)); }
    return e;
  }
  void main(){
    vec2 p = org + vec2(vUv.x, 1.-vUv.y)*ext;
    if (mode == ${MODE.gradient}) {
      // p is ps here: the gradient and its brushed grain, before anything is drawn over them.
      float h = p.y/RES.y;
      vec3 col = mix(skyTop, skyBottom, smoothstep(0., horizon/RES.y, h));
      col *= 1. + (fbm(vec2(p.x*0.003, p.y*0.08), 3) - 0.5)*0.025;
      gl_FragColor = vec4(col, 1.); return;
    }
    if (mode == ${MODE.post}) {
      // p is ps here: the horizon glow, and the ground haze band's weight at the horizon.
      vec3 glow = vec3(0.);
      if (glowY.x > 0.) glow = glowC * exp(-abs(p.y - glowY.x)/90.);
      gl_FragColor = vec4(glow, 0.55*exp(-abs(p.y - horizon)/38.)); return;
    }
    if (mode == ${MODE.layer}) {
      // p is this band's q = p − E.
      int i = li; vec2 q = p;
      float st = A[i].w;
      float row = floor(q.y/st);
      float xj = q.x + (hash12(vec2(row, float(i)*7.)) - 0.5)*st*B[i].w*2.;
      float ey = bandY(i, xj);
      if (B[i].x < 0.5 || B[i].x > 1.5) ey = ceil(ey/st)*st;           // staircase
      float soft = B[i].z;
      float inside = smoothstep(ey - soft, ey + soft, q.y);
      float f = smoothstep(D[i].x, D[i].y, q.y);
      float alpha = inside * mix(1., D[i].z, pow(f, 0.8));
      vec3 lc = C[i] * (1. + (fbm(vec2(q.x*0.004, q.y*0.45), 3) - 0.5)*0.07*D[i].w);
      lc = mix(lc, haze, 0.25*f);
      gl_FragColor = vec4(lc, alpha); return;
    }
    // Screen-fixed parts, with skyOff = 0: col ↦ col·k + b over the sun, stars and moon discs.
    float h = p.y/RES.y;
    float k = 1., sk = 0.; vec3 b = vec3(0.);
    if (sun.z > 0.) { float d = length(p - sun.xy); float a = smoothstep(sun.z+1., sun.z-1., d)*sun.w; k *= 1.-a; b = mix(b, sunC, a); b += sunC*0.06*exp(-d/(sun.z*4.)); }
    if (stars > 0.) { vec2 g = floor(p/3.); float s = hash12(g); if (s > 1. - stars) { float sv = 0.8*smoothstep(0.6, 0.,length(fract(p/3.)-0.5)); b += vec3(sv) * (1.-h*1.3); sk += sv; } }
    for (int m=0;m<3;m++){ if (MO[m].z <= 0.) continue; vec2 d = p - MO[m].xy; float r = MO[m].z; float dl = length(d);
      b += MC[m] * 0.22 * ML[m].z * exp(-max(dl - r, 0.)/(r*1.1));
      if (dl < r + 1.) { vec2 n = d/r; float z = sqrt(max(0., 1. - dot(n,n)));
        float lit = clamp(dot(vec3(n, z), normalize(vec3(-ML[m].y, -0.35, 0.85))), 0., 1.);
        vec3 mc = MC[m] * (0.35 + 0.75*lit) * (0.82 + 0.25*fbm(n*4. + float(m)*7., 4)) * (0.8 + 0.2*z);
        float a = smoothstep(r + 1., r - 1., dl); k *= 1.-a; sk *= 1.-a; b = mix(b, mc, a); } }
    if (mode == ${MODE.base}) { gl_FragColor = vec4(b, k); return; }
    vec3 R = vec3(0.), M = vec3(0.);
    if (rays.z > 0.) { vec2 d = p - rays.xy; float ang = atan(d.y, d.x); float r = length(d);
      vec2 cs = vec2(cos(ang), sin(ang)); float st = pow(vnoise(cs*4.2 + 11.), 2.5)*0.7 + pow(vnoise(cs*1.5 + 37.), 3.)*0.6;
      R = rayC * rays.z * st * exp(-r/rays.w) * smoothstep(0., 60., r); }
    for (int m=0;m<3;m++){ if (MO[m].w <= 0.) continue; vec2 d = p - MO[m].xy; float ang = atan(d.y, d.x); float r = length(d);
      vec2 cs = vec2(cos(ang), sin(ang)); float st = pow(vnoise(cs*3.6 + float(m)*9. + 3.), 2.5)*0.7 + pow(vnoise(cs*1.3 + 21. + float(m)*5.), 3.)*0.6;
      M += MC[m] * MO[m].w * st * exp(-r/ML[m].x) * smoothstep(MO[m].z, MO[m].z*2.5, r); }
    gl_FragColor = mode == ${MODE.rays} ? vec4(R + M, sk) : vec4(0.75*R + 0.8*M, 0.);
  }`

/**
 * Per frame: sample the bakes, mix the bands in slot order, add the rays and glow, mix the haze
 * band, add the grain. Every bake's texture coordinate is linear in the quad's, so all of them are
 * computed at the four corners (`COMPOSITE_V`) and interpolated; measured, the per-pixel
 * arithmetic, not the texture reads, was what SwiftShader spent its time on.
 */
const COMPOSITE_V = /* glsl */ `varying vec2 vUv; varying vec4 T0, T1, T2, T3;
  uniform vec4 LR[${N}], GR; uniform vec2 E[${N}]; uniform vec2 RES, skyOff;
  // A point in a bake's own frame px → its texture coordinate (rows baked top-down, as vUv runs).
  vec2 at(vec4 r, vec2 q){ return vec2((q.x - r.x)/r.z, 1. - (q.y - r.y)/r.w); }
  void main(){
    vUv = uv;
    vec2 p = vec2(uv.x*RES.x, (1.-uv.y)*RES.y);
    T0 = vec4(at(LR[0], p - E[0]), at(LR[1], p - E[1]));
    T1 = vec4(at(LR[2], p - E[2]), at(LR[3], p - E[3]));
    T2 = vec4(at(LR[4], p - E[4]), at(LR[5], p - E[5]));
    T3 = vec4(at(GR, p - skyOff), 0., 0.);
    gl_Position = vec4(position.xy,0.,1.);
  }`
const BAND_UV = ['T0.xy', 'T0.zw', 'T1.xy', 'T1.zw', 'T2.xy', 'T2.zw']
const bandMix = Array.from(
  { length: N },
  (_, i) => `    if (on[${i}] > 0.5) { vec4 L = texture2D(L${i}, ${BAND_UV[i]}); col = mix(col, L.rgb, L.a); occ = max(occ, L.a*(0.4 + 0.6*float(${i})/${N - 1}.)); }`,
).join('\n')
const COMPOSITE = /* glsl */ `varying vec2 vUv; varying vec4 T0, T1, T2, T3;
  uniform sampler2D P1, P2, P3, G, Q, ${Array.from({ length: N }, (_, i) => `L${i}`).join(', ')};
  uniform float on[${N}];
  uniform vec3 haze; uniform float lin, grainK; uniform vec2 RES, skyOff;
  float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  void main(){
    vec4 b1 = texture2D(P1, vUv), b2 = texture2D(P2, vUv), b3 = texture2D(P3, vUv);
    vec3 col = texture2D(G, T3.xy).rgb * b1.a + b1.rgb + vec3(b2.a * 1.3 * skyOff.y/RES.y);
    float occ = 0.;
${bandMix}
    col += b2.rgb - occ*b3.rgb;
    vec4 q = texture2D(Q, T3.xy);
    col += q.rgb;
    // ground haze band at the horizon
    col = mix(col, haze, q.a);
    // Per pixel, verbatim: a hash of the pixel's own position. Baked, its input differed by an ulp
    // from the frame's and the hash scattered it — measured, F1's deltaE 0.00001 → 0.00012.
    col += (hash12(vec2(vUv.x*RES.x, (1.-vUv.y)*RES.y)) - 0.5)*grainK;
    if (lin > 0.5) col = pow(max(col, 0.), vec3(2.2));
    gl_FragColor = vec4(col, 1.);
  }`

type U = Record<string, { value: unknown }>

/**
 * A bake target, RGBA, **float32**; **nearest**-sampled except the bands. Nearest, because every
 * screen-fixed and gradient read lands on a texel centre (`snapOffsets`), and measured on SwiftShader
 * linear filtering cost ~0.7 ms a frame more. **The bands are linear at unsnapped offsets**
 * (T23.04C F6): snapped to whole texels, a slow pan moved them in 2-px (low) / 1-px (full) jumps with
 * still frames between — a band now slides by its exact parallax offset every frame; at a zero
 * offset (the look-lab) each read is still a texel centre, so Level A is the same picture. Float32, because half float's 11 bits flip the last bit of a few per cent of pixels:
 * measured on `look-sky`, half-float bands and gradient put F5's `deltaE_cave` at 0.011 of its
 * 0.0125 and half-float screen parts moved F5's `paletteDE` 0.000 → 0.089; float32 gives 0.00000,
 * as unbaked (and on SwiftShader it is the faster of the two). Where a float32 colour buffer is
 * not renderable (no `EXT_color_buffer_float`), half float.
 */
const target = (w: number, h: number, float32: boolean, linear: boolean): WebGLRenderTarget =>
  new WebGLRenderTarget(w, h, {
    type: float32 ? FloatType : HalfFloatType,
    format: RGBAFormat,
    minFilter: linear ? LinearFilter : NearestFilter,
    magFilter: linear ? LinearFilter : NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  })
/** Bytes per baked texel: RGBA float32 or half float. */
const texelBytes = (float32: boolean): number => (float32 ? 16 : 8)
const rect = (e: Extent): Vector4 => new Vector4(e.org[0], e.org[1], e.ext[0], e.ext[1])

/**
 * The sky's full-screen quad (`bgQuad`: clip space, drawn first, never culled, no depth), fed
 * with `setSky`, baked and moved by `place` before a frame is drawn. `hide` is a
 * dev check's control: those layer slots are skipped exactly as an empty slot is.
 */
export class SkyQuad {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>
  /** Bakes made so far, and the bytes the current ones hold (the dev handle reports both). */
  readonly bakeStats = { bakes: 0, bytes: 0 }
  private bg: Background | null = null
  /** Bumped by `setSky`: part of the bake key, so a new sky (a new seed) is rebaked. */
  private skyId = 0
  private hidden = new Set<number>()
  private readonly bakeMat: ShaderMaterial
  private readonly bakeQuad: Mesh<PlaneGeometry, ShaderMaterial>
  private readonly bakeScene = new Scene()
  private readonly bakeCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private targets: WebGLRenderTarget[] = []
  private bakedKey = ''

  constructor() {
    this.bakeMat = new ShaderMaterial({
      uniforms: {
        A: { value: Array.from({ length: N }, () => new Vector4()) },
        B: { value: Array.from({ length: N }, () => new Vector4()) },
        C: { value: Array.from({ length: N }, () => new Vector3()) },
        D: { value: Array.from({ length: N }, () => new Vector4()) },
        E: { value: Array.from({ length: N }, () => new Vector4()) },
        skyTop: { value: new Vector3() },
        skyBottom: { value: new Vector3() },
        haze: { value: new Vector3() },
        horizon: { value: 0 },
        sun: { value: new Vector4() },
        sunC: { value: new Vector3() },
        stars: { value: 0 },
        MO: { value: Array.from({ length: SKY_MOONS }, () => new Vector4()) },
        MC: { value: Array.from({ length: SKY_MOONS }, () => new Vector3()) },
        ML: { value: Array.from({ length: SKY_MOONS }, () => new Vector4()) },
        rays: { value: new Vector4() },
        rayC: { value: new Vector3() },
        glowY: { value: new Vector2(-1, 0) },
        glowC: { value: new Vector3() },
        RES: { value: new Vector2(1280, 720) },
        jitterY: { value: APEX_JITTER },
        mode: { value: 0 },
        li: { value: 0 },
        org: { value: new Vector2() },
        ext: { value: new Vector2(1, 1) },
      },
      vertexShader: VSQ,
      fragmentShader: BAKE,
      depthTest: false,
      depthWrite: false,
    })
    this.bakeQuad = new Mesh(new PlaneGeometry(2, 2), this.bakeMat)
    this.bakeQuad.frustumCulled = false
    this.bakeScene.add(this.bakeQuad)
    const mat = new ShaderMaterial({
      uniforms: {
        P1: { value: null },
        P2: { value: null },
        P3: { value: null },
        G: { value: null },
        Q: { value: null },
        ...Object.fromEntries(Array.from({ length: N }, (_, i) => [`L${i}`, { value: null }])),
        LR: { value: Array.from({ length: N }, () => new Vector4(0, 0, 1, 1)) },
        GR: { value: new Vector4(0, 0, 1, 1) },
        E: { value: Array.from({ length: N }, () => new Vector2()) },
        on: { value: new Array<number>(N).fill(0) },
        haze: { value: new Vector3() },
        // `bgQuad` builds `bgMaterial(o, true)`: the result is raised to 2.2 before the post chain.
        lin: { value: 1 },
        grainK: { value: 0 },
        RES: { value: new Vector2(1280, 720) },
        skyOff: { value: new Vector2() },
      },
      vertexShader: COMPOSITE_V,
      fragmentShader: COMPOSITE,
      depthTest: false,
      depthWrite: false,
    })
    this.mesh = new Mesh(new PlaneGeometry(2, 2), mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -10
    this.mesh.visible = false
  }

  private get u(): U {
    return this.mesh.material.uniforms as U
  }

  private get bu(): U {
    return this.bakeMat.uniforms as U
  }

  /** Hand over the sky (`null`: draw none — a space map). Packs the uniforms as `bgMaterial` does. */
  setSky(bg: Background | null): void {
    this.bg = bg
    this.skyId++
    this.mesh.visible = bg !== null
    if (!bg) return
    const u = this.bu
    const moons = bg.moons ?? []
    for (let i = 0; i < SKY_MOONS; i++) {
      const m = moons[i]
      ;(u['MO']!.value as Vector4[])[i]!.set(...(m ? ([m.x, m.y, m.r, m.rays ?? 0] as const) : ([0, 0, 0, 0] as const)))
      ;(u['MC']!.value as Vector3[])[i]!.set(...hexLinear(m?.color ?? 0))
      ;(u['ML']!.value as Vector4[])[i]!.set(...(m ? ([m.rayLen ?? 400, m.phase ?? 0.3, m.halo ?? 1, 0] as const) : ([1, 0, 0, 0] as const)))
    }
    this.packLayers()
    ;(u['skyTop']!.value as Vector3).copy(v3(bg.skyTop))
    ;(u['skyBottom']!.value as Vector3).copy(v3(bg.skyBottom))
    ;(u['haze']!.value as Vector3).copy(v3(bg.haze))
    ;(this.u['haze']!.value as Vector3).copy(v3(bg.haze))
    u['horizon']!.value = bg.horizon
    const s = bg.sun
    ;(u['sun']!.value as Vector4).set(...(s ? ([s.x, s.y, s.r, s.k] as const) : ([0, 0, 0, 0] as const)))
    ;(u['sunC']!.value as Vector3).copy(v3(s?.color ?? 0xffffff))
    u['stars']!.value = bg.stars ?? 0
    // `bgMaterial`'s own defaults, where a scene leaves a field out.
    this.u['grainK']!.value = bg.grainK ?? 0.035
    ;(u['rays']!.value as Vector4).set(...(bg.rays ?? ([0, 0, 0, 0] as const)))
    ;(u['rayC']!.value as Vector3).copy(v3(bg.rayColor ?? 0xffffff))
    ;(u['glowY']!.value as Vector2).set(bg.glowY ?? -1, 0)
    ;(u['glowC']!.value as Vector3).copy(v3(bg.glowColor ?? 0x000000))
  }

  private packLayers(): void {
    const bg = this.bg
    if (!bg) return
    const u = this.bu
    const A = u['A']!.value as Vector4[]
    const B = u['B']!.value as Vector4[]
    const C = u['C']!.value as Vector3[]
    const D = u['D']!.value as Vector4[]
    const E = u['E']!.value as Vector4[]
    const on = this.u['on']!.value as number[]
    for (let i = 0; i < N; i++) {
      const L = bg.layers[i]
      // A hidden band is still baked (so hiding one never rebakes) and skipped when composited.
      on[i] = L && !this.hidden.has(i) ? 1 : 0
      if (!L) {
        A[i]!.set(0, 9999, 1, 4)
        B[i]!.set(-1, 0, 0, 0)
        C[i]!.set(0, 0, 0)
        D[i]!.set(0, 1, 1, 0)
        E[i]!.set(0, 0, 0, 0)
        continue
      }
      A[i]!.set(L.x, L.y, L.slope ?? L.r ?? 1, L.step ?? 6)
      B[i]!.set(SHAPE[L.shape], L.top ?? 0, L.soft ?? 1, L.jitter ?? 0.8)
      C[i]!.set(...hexLinear(L.color))
      // `L.streak ?? 1`: no scene sets a streak, so the mockup's default.
      D[i]!.set(...(L.fade ?? [L.y, bg.horizon, 0.15]), 1)
      E[i]!.set(0, 0, L.period ?? 0, L.seed ?? 0)
    }
  }

  /**
   * Place this frame's sky: bake it if it is not baked already for this sky, this texel size
   * (`frame` px per buffer px — the tier) and these extents (`bakeExtents`: the zoom and the map's
   * size) — a panning camera changes none of them, so it never rebakes — then move the bakes by
   * `offsets` (`skyLayout.ts::skyOffsets`) **snapped to whole texels** (`snapOffsets`), and return
   * the offsets drawn. Leaves the renderer's target as it found it.
   */
  place(
    renderer: WebGLRenderer,
    view: ViewRect,
    world: { w: number; h: number },
    frame: [number, number],
    buffer: [number, number],
    offsets: { layers: Offset[]; horizon: Offset },
  ): { layers: Offset[]; horizon: Offset } {
    const bg = this.bg
    if (!bg) return offsets
    const texel = frame[0] / buffer[0]
    this.bake(renderer, bg, view, world, frame, texel)
    // The gradient, glow and haze move snapped (nearest bakes); the bands slide unsnapped (F6).
    const drawn = { layers: offsets.layers, horizon: snapOffsets(offsets, texel).horizon }
    const E = this.u['E']!.value as Vector2[]
    for (let i = 0; i < N; i++) E[i]!.set(drawn.layers[i]?.[0] ?? 0, drawn.layers[i]?.[1] ?? 0)
    ;(this.u['skyOff']!.value as Vector2).set(drawn.horizon[0], drawn.horizon[1])
    ;(this.u['RES']!.value as Vector2).set(frame[0], frame[1])
    return drawn
  }

  private bake(renderer: WebGLRenderer, bg: Background, view: ViewRect, world: { w: number; h: number }, frame: [number, number], texel: number): void {
    const x = bakeExtents(bg, view, world, frame, texel)
    const key = JSON.stringify([this.skyId, texel, frame, x])
    if (key === this.bakedKey) return
    this.bakedKey = key
    this.freeTargets()
    ;(this.bu['RES']!.value as Vector2).set(frame[0], frame[1])
    const screen: Extent = { org: [0, 0], ext: [frame[0], frame[1]] }
    const bake = (mode: number, e: Extent, li = 0): Texture => {
      // The glow and haze weight read `ps.y` alone: one column, which every x reads (clamp to edge).
      const w = mode === MODE.post ? 1 : Math.max(1, Math.round(e.ext[0] / texel))
      const band = mode === MODE.layer
      // A linear float32 read needs `OES_texture_float_linear`; without it a band bakes half float,
      // which is always filterable (measured on look-sky: F5 deltaE_cave 0.011 of 0.0125, T23.04B).
      const f32 = band ? float32Linear : float32
      const rt = target(w, Math.max(1, Math.round(e.ext[1] / texel)), f32, band)
      this.targets.push(rt)
      this.bakeStats.bytes += rt.width * rt.height * texelBytes(f32)
      this.bu['mode']!.value = mode
      this.bu['li']!.value = li
      ;(this.bu['org']!.value as Vector2).set(e.org[0], e.org[1])
      ;(this.bu['ext']!.value as Vector2).set(e.ext[0], e.ext[1])
      renderer.setRenderTarget(rt)
      renderer.render(this.bakeScene, this.bakeCam)
      return rt.texture
    }
    const float32 = renderer.extensions.has('EXT_color_buffer_float')
    const float32Linear = float32 && renderer.extensions.has('OES_texture_float_linear')
    const prev = renderer.getRenderTarget()
    const u = this.u
    u['P1']!.value = bake(MODE.base, screen)
    u['P2']!.value = bake(MODE.rays, screen)
    u['P3']!.value = bake(MODE.raysOcc, screen)
    u['G']!.value = bake(MODE.gradient, x.horizon)
    u['Q']!.value = bake(MODE.post, x.horizon)
    ;(u['GR']!.value as Vector4).copy(rect(x.horizon))
    for (let i = 0; i < N; i++) {
      const e = x.layers[i]
      u[`L${i}`]!.value = e ? bake(MODE.layer, e, i) : null
      ;(u['LR']!.value as Vector4[])[i]!.copy(e ? rect(e) : new Vector4(0, 0, 1, 1))
    }
    renderer.setRenderTarget(prev)
    this.bakeStats.bakes++
  }

  private freeTargets(): void {
    for (const t of this.targets) t.dispose()
    this.targets = []
    this.bakeStats.bytes = 0
  }

  /** Dev: draw only the layers not in `hide` (the parallax check isolates one band at a time). */
  hideLayers(hide: number[]): void {
    this.hidden = new Set(hide)
    this.packLayers()
  }

  get hiddenLayers(): number[] {
    return [...this.hidden]
  }

  dispose(): void {
    this.freeTargets()
    this.bakeScene.clear()
    // T23.04C (R22): the renderer outlives this sky now, so everything it was given goes back.
    this.bakeQuad.geometry.dispose()
    this.bakeMat.dispose()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
