/**
 * T23.04: the sky — a port of `mockup-src/e_style.js::bgQuad` / `bgMaterial` (sky gradient,
 * horizon glow, haze band, ≤6 stepped layers — pyramid / ziggurat / arc / mesa — with step,
 * softness, fade and jitter, stars, grain, god rays, ≤3 moons whose rays the layers occlude).
 *
 * **Verbatim where the mockup has an answer**: the GLSL below is `bgMaterial`'s, line for line,
 * `NOISE_GLSL` is `kit.js`'s, and the uniforms are packed the way it packs them — so with every
 * offset zero (the look-lab's scenes) this draws the pictures' sky, which `look-sky` measures.
 *
 * **What is added, and only this** (`skyLayout.ts` computes it): per layer `E = (offset x,
 * offset y, period, seed)` — the band is moved by its parallax offset and, with a period, drawn
 * as a repeating row of the mockup's shape whose copies' apexes the seed jitters (`jitterY`);
 * `skyOff` moves the gradient, horizon glow, haze band and sky grain with the farthest layer.
 * Stars, grain, the sun and the moons are at parallax 0. The frame size is a uniform (`RES`, the
 * game's 1280×720 — R18) where the mockup inlines `W`, `H`.
 *
 * **Not animated.** `bgMaterial` has no clock: its stars are a static hash grid and its god rays
 * a function of angle only. So the layer is registered `animated: false` and the redraw skip
 * stays valid; a still camera redraws nothing. (R7's moving moons and star fade by darkness are
 * T23.11's, and will change that.)
 */
import { Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3, Vector4 } from 'three'
import type { Background } from './scene'
import type { Offset } from './skyLayout'
import { APEX_JITTER } from './skyLayout'
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
const FRAG =
  NOISE_GLSL +
  /* glsl */ `varying vec2 vUv; uniform vec4 A[${N}], B[${N}], D[${N}], E[${N}]; uniform vec3 C[${N}]; uniform vec3 skyTop, skyBottom, haze, sunC; uniform float horizon, stars, grainK, lin, jitterY; uniform vec4 sun, rays; uniform vec3 rayC, glowC; uniform vec2 glowY, RES, skyOff; uniform vec4 MO[3], ML[3]; uniform vec3 MC[3];
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
    vec2 p = vec2(vUv.x*RES.x, (1.-vUv.y)*RES.y);
    vec2 ps = p - skyOff;
    float h = ps.y/RES.y;
    vec3 col = mix(skyTop, skyBottom, smoothstep(0., horizon/RES.y, h));
    // brushed sky grain
    col *= 1. + (fbm(vec2(ps.x*0.003, ps.y*0.08), 3) - 0.5)*0.025;
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
      vec2 q = p - E[i].xy;
      float st = A[i].w;
      float row = floor(q.y/st);
      float xj = q.x + (hash12(vec2(row, float(i)*7.)) - 0.5)*st*B[i].w*2.;
      float ey = bandY(i, xj);
      if (B[i].x < 0.5 || B[i].x > 1.5) ey = ceil(ey/st)*st;           // staircase
      float soft = B[i].z;
      float inside = smoothstep(ey - soft, ey + soft, q.y);
      // aerial perspective: fade toward the base into haze
      float f = smoothstep(D[i].x, D[i].y, q.y);
      float alpha = inside * mix(1., D[i].z, pow(f, 0.8));
      vec3 lc = C[i] * (1. + (fbm(vec2(q.x*0.004, q.y*0.45), 3) - 0.5)*0.07*D[i].w);   // horizontal brush streaks
      lc = mix(lc, haze, 0.25*f);
      col = mix(col, lc, alpha); occ = max(occ, alpha*(0.4 + 0.6*float(i)/${N - 1}.));
    }
    if (rays.z > 0.) { vec2 d = p - rays.xy; float ang = atan(d.y, d.x); float r = length(d);
      vec2 cs = vec2(cos(ang), sin(ang)); float st = pow(vnoise(cs*4.2 + 11.), 2.5)*0.7 + pow(vnoise(cs*1.5 + 37.), 3.)*0.6;
      col += rayC * rays.z * st * exp(-r/rays.w) * (1. - 0.75*occ) * smoothstep(0., 60., r); }
    if (glowY.x > 0.) col += glowC * exp(-abs(ps.y - glowY.x)/90.);
    for (int m=0;m<3;m++){ if (MO[m].w <= 0.) continue; vec2 d = p - MO[m].xy; float ang = atan(d.y, d.x); float r = length(d);
      vec2 cs = vec2(cos(ang), sin(ang)); float st = pow(vnoise(cs*3.6 + float(m)*9. + 3.), 2.5)*0.7 + pow(vnoise(cs*1.3 + 21. + float(m)*5.), 3.)*0.6;
      col += MC[m] * MO[m].w * st * exp(-r/ML[m].x) * (1. - 0.8*occ) * smoothstep(MO[m].z, MO[m].z*2.5, r); }
    // ground haze band at the horizon
    col = mix(col, haze, 0.55*exp(-abs(ps.y - horizon)/38.));
    col += (hash12(p) - 0.5)*grainK;
    if (lin > 0.5) col = pow(max(col, 0.), vec3(2.2));
    gl_FragColor = vec4(col, 1.);
  }`

type U = Record<string, { value: unknown }>

/**
 * The sky's full-screen quad (`bgQuad`: clip space, drawn first, never culled, no depth), fed
 * with `setSky`, moved with `setOffsets`. `hide` is a dev check's control: those layer slots are
 * skipped exactly as an empty slot is (`B.x = −1`).
 */
export class SkyQuad {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>
  private bg: Background | null = null
  private hidden = new Set<number>()

  constructor() {
    const E = Array.from({ length: N }, () => new Vector4())
    const mat = new ShaderMaterial({
      uniforms: {
        A: { value: Array.from({ length: N }, () => new Vector4()) },
        B: { value: Array.from({ length: N }, () => new Vector4()) },
        C: { value: Array.from({ length: N }, () => new Vector3()) },
        D: { value: Array.from({ length: N }, () => new Vector4()) },
        E: { value: E },
        skyTop: { value: new Vector3() },
        skyBottom: { value: new Vector3() },
        haze: { value: new Vector3() },
        horizon: { value: 0 },
        sun: { value: new Vector4() },
        sunC: { value: new Vector3() },
        stars: { value: 0 },
        grainK: { value: 0 },
        MO: { value: Array.from({ length: SKY_MOONS }, () => new Vector4()) },
        MC: { value: Array.from({ length: SKY_MOONS }, () => new Vector3()) },
        ML: { value: Array.from({ length: SKY_MOONS }, () => new Vector4()) },
        rays: { value: new Vector4() },
        rayC: { value: new Vector3() },
        // `bgQuad` builds `bgMaterial(o, true)`: the result is raised to 2.2 before the post chain.
        lin: { value: 1 },
        glowY: { value: new Vector2(-1, 0) },
        glowC: { value: new Vector3() },
        RES: { value: new Vector2(1280, 720) },
        skyOff: { value: new Vector2() },
        jitterY: { value: APEX_JITTER },
      },
      vertexShader: VSQ,
      fragmentShader: FRAG,
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

  /** Hand over the sky (`null`: draw none — a space map). Packs the uniforms as `bgMaterial` does. */
  setSky(bg: Background | null): void {
    this.bg = bg
    this.mesh.visible = bg !== null
    if (!bg) return
    const u = this.u
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
    u['horizon']!.value = bg.horizon
    const s = bg.sun
    ;(u['sun']!.value as Vector4).set(...(s ? ([s.x, s.y, s.r, s.k] as const) : ([0, 0, 0, 0] as const)))
    ;(u['sunC']!.value as Vector3).copy(v3(s?.color ?? 0xffffff))
    u['stars']!.value = bg.stars ?? 0
    // `bgMaterial`'s own defaults, where a scene leaves a field out.
    u['grainK']!.value = bg.grainK ?? 0.035
    ;(u['rays']!.value as Vector4).set(...(bg.rays ?? ([0, 0, 0, 0] as const)))
    ;(u['rayC']!.value as Vector3).copy(v3(bg.rayColor ?? 0xffffff))
    ;(u['glowY']!.value as Vector2).set(bg.glowY ?? -1, 0)
    ;(u['glowC']!.value as Vector3).copy(v3(bg.glowColor ?? 0x000000))
  }

  private packLayers(): void {
    const bg = this.bg
    if (!bg) return
    const u = this.u
    const A = u['A']!.value as Vector4[]
    const B = u['B']!.value as Vector4[]
    const C = u['C']!.value as Vector3[]
    const D = u['D']!.value as Vector4[]
    const E = u['E']!.value as Vector4[]
    for (let i = 0; i < N; i++) {
      const L = bg.layers[i]
      if (!L || this.hidden.has(i)) {
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
      E[i]!.set(E[i]!.x, E[i]!.y, L.period ?? 0, L.seed ?? 0)
    }
  }

  /** This frame's parallax offsets (`skyLayout.ts::skyOffsets`), screen px, and the frame size. */
  setOffsets(layers: Offset[], horizon: Offset, frame: [number, number]): void {
    const E = this.u['E']!.value as Vector4[]
    for (let i = 0; i < N; i++) {
      const o = layers[i]
      E[i]!.x = o?.[0] ?? 0
      E[i]!.y = o?.[1] ?? 0
    }
    ;(this.u['skyOff']!.value as Vector2).set(horizon[0], horizon[1])
    ;(this.u['RES']!.value as Vector2).set(frame[0], frame[1])
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
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
