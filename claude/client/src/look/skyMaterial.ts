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
 * **Not animated by itself.** `bgMaterial` has no clock: its stars are a static hash grid and its god rays
 * a function of angle only; a still camera redraws nothing.
 *
 * **T23.11 (R7): night and moonlit day, and moons that move.** The blend moves every colour of the palette and
 * the moons move with the cycle, so neither may be baked. The split above is re-cut so that **no bake holds a
 * palette colour or a moon's place** — still exact algebra: the gradient bakes its weight and grain
 * (`col = mix(top, bottom, w)·g`) and each end's stars (weighed by `t` — star alpha follows it); a band its colour
 * weights and alpha parts (`lc = C·n + haze·hz`, `α = a0 + a1·(fade − 1)`, linear in the palette, so the linear
 * filter still commutes); the glow its shape at each end's height. The moons are two **sets**, each baked once in
 * its own frame and read at the set's offset (whole texels, nearest): the night's (F1's moon disc — `bgMaterial`'s
 * sun — and its rays: one colour each, so one texture of scalars) and the day's (F5's three moons, `col·k + b`, and
 * their rays, coarse). A new `t` or a moved moon never rebakes; it is a new picture (`WorldRenderer.setDaylight`).
 * In the game the stars ride the gradient's parallax (0.04) rather than none — measured cheaper than a hash per
 * pixel on SwiftShader; at the look-lab's zero offset the same pixels.
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

/**
 * What a bake pass writes (T23.11: **no colour of the palette is baked** — the blend moves them every frame):
 * the gradient's weight and brushed grain; the glow's shape at each end's `glowY` and the haze band's weight;
 * one band's colour weights and alpha parts; and per **moon set** — the night's (F1's moon disc, `bgMaterial`'s
 * sun, and its rays) and the day's (F5's three moons) — its screen-fixed part `col ↦ col·k + b` and its rays, in
 * the set's own frame (it moves as one, `daylight.ts::moonArcs`).
 */
const MODE = { gradient: 0, post: 1, layer: 2, night: 3, fixed: 4, rays: 5 } as const

/**
 * T23.11: the rays' bake, frame px per texel. The rays are smooth — `exp` in the radius, value noise in the angle,
 * off inside `2.5 r` of a moon (60 px of the night moon) — so a coarse texel, linearly read, carries them (Level A:
 * `look-sky` / `look-day-night`).
 */
export const RAY_TEXEL = 4

/**
 * The bake: `bgMaterial` evaluated at `p = org + uv·ext` (frame px, y down), one part per pass
 * (`mode`). Each part is the mockup's expressions verbatim, only regrouped as the header says.
 */
const BAKE =
  NOISE_GLSL +
  /* glsl */ `varying vec2 vUv; uniform vec4 A[${N}], B[${N}], D[${N}], E[${N}]; uniform float horizon, jitterY; uniform vec2 RES, glowY, stars;
  uniform vec4 sun, rays, MO[3], ML[3]; uniform vec3 MC[3];
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
      // p is ps here. col = mix(skyTop, skyBottom, w)·g: the weight and the brushed grain, not the colours; and the
      // stars of each end (z night's density, w day's), which the composite weighs by t. T23.11: baked here, the stars
      // ride the gradient's parallax (HORIZON_PARALLAX, 0.04) in the game instead of none — at the look-lab's zero
      // offset the same pixels as bgMaterial's; measured, a star hash per pixel cost SwiftShader ~0.4 ms a frame.
      float h = p.y/RES.y;
      vec2 st = vec2(0.);
      float s = hash12(floor(p/3.));
      if (s > 1. - max(stars.x, stars.y)) {
        float sv = 0.8*smoothstep(0.6, 0., length(fract(p/3.)-0.5))*(1. - h*1.3);
        st = vec2(s > 1. - stars.x ? sv : 0., s > 1. - stars.y ? sv : 0.); }
      gl_FragColor = vec4(smoothstep(0., horizon/RES.y, h), 1. + (fbm(vec2(p.x*0.003, p.y*0.08), 3) - 0.5)*0.025, st); return;
    }
    if (mode == ${MODE.post}) {
      // p is ps here: the horizon glow's shape at night's and day's glowY (x, y), and the ground haze band's weight.
      float gn = glowY.x > 0. ? exp(-abs(p.y - glowY.x)/90.) : 0.;
      float gd = glowY.y > 0. ? exp(-abs(p.y - glowY.y)/90.) : 0.;
      gl_FragColor = vec4(gn, gd, 0., 0.55*exp(-abs(p.y - horizon)/38.)); return;
    }
    if (mode == ${MODE.layer}) {
      // p is this band's q = p − E. lc = C·n + haze·hz, alpha = a0 + a1·(D.z − 1): linear in the palette's colour
      // and fade, which the composite supplies (bgMaterial's lc = mix(C·noise, haze, 0.25 f), alpha = inside·mix(1, D.z, f^0.8)).
      int i = li; vec2 q = p;
      float st = A[i].w;
      float row = floor(q.y/st);
      float xj = q.x + (hash12(vec2(row, float(i)*7.)) - 0.5)*st*B[i].w*2.;
      float ey = bandY(i, xj);
      if (B[i].x < 0.5 || B[i].x > 1.5) ey = ceil(ey/st)*st;           // staircase
      float soft = B[i].z;
      float inside = smoothstep(ey - soft, ey + soft, q.y);
      float f = smoothstep(D[i].x, D[i].y, q.y);
      float n = (1. + (fbm(vec2(q.x*0.004, q.y*0.45), 3) - 0.5)*0.07*D[i].w)*(1. - 0.25*f);
      gl_FragColor = vec4(n, 0.25*f, inside, inside*pow(f, 0.8)); return;
    }
    // The night set, in its own frame: F1's moon disc (bgMaterial's sun) is one colour, and so are its rays, so the
    // whole set is three numbers — b = sunC·x, k = y, R = rayC·z — and one read: col ↦ col·k + b, then R after the bands.
    if (mode == ${MODE.night}) {
      float k = 1., b = 0., R = 0.;
      if (sun.z > 0.) { float d = length(p - sun.xy); float a = smoothstep(sun.z+1., sun.z-1., d)*sun.w; k *= 1.-a; b = mix(b, 1., a); b += 0.06*exp(-d/(sun.z*4.)); }
      if (rays.z > 0.) { vec2 d = p - rays.xy; float ang = atan(d.y, d.x); float r = length(d);
        vec2 cs = vec2(cos(ang), sin(ang)); float st = pow(vnoise(cs*4.2 + 11.), 2.5)*0.7 + pow(vnoise(cs*1.5 + 37.), 3.)*0.6;
        R = rays.z * st * exp(-r/rays.w) * smoothstep(0., 60., r); }
      gl_FragColor = vec4(b, k, R, 0.); return;
    }
    // The day set, in its own frame (p: where the set is at its picture's place): the moons, col ↦ col·k + b
    // (the stars, drawn between the sun and the moons in bgMaterial, are the composite's).
    if (mode == ${MODE.fixed}) {
      float k = 1.; vec3 b = vec3(0.);
      for (int m=0;m<3;m++){ if (MO[m].z <= 0.) continue; vec2 d = p - MO[m].xy; float r = MO[m].z; float dl = length(d);
        b += MC[m] * 0.22 * ML[m].z * exp(-max(dl - r, 0.)/(r*1.1));
        if (dl < r + 1.) { vec2 n = d/r; float z = sqrt(max(0., 1. - dot(n,n)));
          float lit = clamp(dot(vec3(n, z), normalize(vec3(-ML[m].y, -0.35, 0.85))), 0., 1.);
          vec3 mc = MC[m] * (0.35 + 0.75*lit) * (0.82 + 0.25*fbm(n*4. + float(m)*7., 4)) * (0.8 + 0.2*z);
          float a = smoothstep(r + 1., r - 1., dl); k *= 1.-a; b = mix(b, mc, a); } }
      gl_FragColor = vec4(b, k); return;
    }
    // The day set's rays: bgMaterial's M, which the composite occludes by the bands.
    vec3 M = vec3(0.);
    for (int m=0;m<3;m++){ if (MO[m].w <= 0.) continue; vec2 d = p - MO[m].xy; float ang = atan(d.y, d.x); float r = length(d);
      vec2 cs = vec2(cos(ang), sin(ang)); float st = pow(vnoise(cs*3.6 + float(m)*9. + 3.), 2.5)*0.7 + pow(vnoise(cs*1.3 + 21. + float(m)*5.), 3.)*0.6;
      M += MC[m] * MO[m].w * st * exp(-r/ML[m].x) * smoothstep(MO[m].z, MO[m].z*2.5, r); }
    gl_FragColor = vec4(M, 0.);
  }`

/**
 * Per frame: the palette's colours on the baked weights; the night set, the stars and the day set at their places
 * and weights (`daylight.ts`); the bands mixed in slot order; the sets' rays, occluded by the bands; the glow, the
 * haze band and the grain. Every bake's texture coordinate is linear in the quad's, so all of them are computed at
 * the four corners (`COMPOSITE_V`) and interpolated; measured, the per-pixel arithmetic, not the texture reads, was
 * what SwiftShader spent its time on.
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
  (_, i) =>
    `#if NB > ${i}
    if (on[${i}] > 0.5) { vec4 L = texture2D(L${i}, ${BAND_UV[i]}); float al = L.z + L.w*(Dz[${i}] - 1.); col = mix(col, C[${i}]*L.x + haze*L.y, al); occ = max(occ, al*(0.4 + 0.6*float(${i})/${N - 1}.)); }
#endif`,
).join('\n')
const COMPOSITE = /* glsl */ `varying vec2 vUv; varying vec4 T0, T1, T2, T3;
  // T23.11: each moon set's texture coordinate is gl_FragCoord·xy + zw (place(): its offset, extent and the tier's
  // texel folded in) — one multiply-add a pixel; measured on SwiftShader, two more varyings cost ~0.5 ms a frame.
  uniform vec4 NFt, DFt, DRt;
  uniform sampler2D G, Q, NF, DF, DR, ${Array.from({ length: N }, (_, i) => `L${i}`).join(', ')};
  uniform float on[${N}], Dz[${N}];
  uniform vec3 C[${N}], skyTop, skyBottom, haze, glowC, sunC, rayC;
  uniform float lin, grainK, t; uniform vec2 RES, skyOff, sets;
  uniform vec4 flatC; // dev (T23.19C, rock-opaque): a = 1 draws the whole sky this one linear colour
#if SSTARS
  uniform sampler2D ST; uniform vec2 STt; // T23.20: space's drifting star field (look/space.ts::SpaceStars), buffer px
#endif
  float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  void main(){
    if (flatC.a > 0.5) { gl_FragColor = vec4(flatC.rgb, 1.); return; }
    vec4 g = texture2D(G, T3.xy);
    vec3 col = mix(skyTop, skyBottom, g.x)*g.y;
    // The night set (F1's moon disc: bgMaterial's sun) at its weight (sets.x: t, or 1 for one palette).
#if NSET
    vec4 n = texture2D(NF, gl_FragCoord.xy*NFt.xy + NFt.zw); col = mix(col, col*n.y + sunC*n.x, sets.x);
#endif
    // Stars: each end's set (baked in G: z night's, w day's) at its end's weight — alpha follows t (R7).
    col += vec3(g.z*t + g.w*(1. - t));
#if SSTARS
    // T23.20: T22.06's seeded field, where F3 adds its dust — before the bands, which cover it as they cover the dust.
    col += texture2D(ST, gl_FragCoord.xy*STt).rgb;
#endif
    // The day set (F5's moons) at its weight (sets.y: 1 − t).
#if DSET
    vec4 d = texture2D(DF, gl_FragCoord.xy*DFt.xy + DFt.zw); col = mix(col, col*d.a + d.rgb, sets.y);
#endif
    float occ = 0.;
${bandMix}
    // The rays, occluded by the bands (bgMaterial's 0.75 R, 0.8 M).
#if NSET
    vec3 R = rayC*n.z*sets.x;
    col += R*(1. - 0.75*occ);
#endif
#if DSET
    vec3 M = texture2D(DR, gl_FragCoord.xy*DRt.xy + DRt.zw).rgb*sets.y;
    col += M*(1. - 0.8*occ);
#endif
    vec4 q = texture2D(Q, T3.xy);
    col += glowC * mix(q.y, q.x, t);
    // ground haze band at the horizon
    col = mix(col, haze, q.a);
    // Per pixel, verbatim: a hash of the pixel's own position. Baked, its input differed by an ulp
    // from the frame's and the hash scattered it — measured, F1's deltaE 0.00001 → 0.00012.
    // T23.13B: the frame size is a compile-time constant here (GRAIN_RES), as bgMaterial's W/H literals are. On the
    // owner's D3D12 GPU (ANGLE → Mesa d3d12 → the Intel driver) the compiler folds a literal size into the hash's own
    // constants — it reassociates — so the hash is of a differently rounded number than with a uniform size; measured,
    // that alone put 47 % of the grain's px elsewhere (lab F4 world vs the mockup's, both D3D12: deltaE 0.094; grain off
    // 0.016). The vector form is the one whose folding matches the mockup's own shader in context (0 px differ, read
    // back on that GPU); the scalar form with literals did not (434 328 px). On SwiftShader the lab frame is byte-identical
    // either way (measured, F4 world).
    col += (hash12(vec2(vUv.x, 1.-vUv.y)*GRAIN_RES) - 0.5)*grainK;
    if (lin > 0.5) col = pow(max(col, 0.), vec3(2.2));
    gl_FragColor = vec4(col, 1.);
  }`

type U = Record<string, { value: unknown }>

/**
 * A bake target, RGBA, **float32**; **nearest**-sampled except the bands, the moon sets and their rays. Nearest,
 * because every gradient read lands on a texel centre (`snapOffsets`), and measured on SwiftShader linear filtering
 * cost ~0.7 ms a frame more. **The bands are linear at unsnapped offsets** (T23.04C F6): snapped to whole texels, a
 * slow pan moved them in 2-px (low) / 1-px (full) jumps with still frames between — a band now slides by its exact
 * parallax offset every frame; at a zero offset (the look-lab) each read is still a texel centre, so Level A is the
 * same picture. The moon sets (T23.11) move in whole texels (`place`), nearest; their coarse rays are linear.
 * Float32, because half float's 11 bits flip the last bit of a few per cent of pixels: measured on `look-sky`,
 * half-float bands and gradient put F5's `deltaE_cave` at 0.011 of its 0.0125 and half-float screen parts moved F5's
 * `paletteDE` 0.000 → 0.089; float32 gives 0.00000, as unbaked (and on SwiftShader it is the faster of the two).
 * Where a float32 colour buffer is not renderable (no `EXT_color_buffer_float`), half float.
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
/** T23.13B: the grain's frame size as GLSL literal text (`vec2(1280.0, 720.0)`) — see the composite's grain line. */
export const grainRes = (w: number, h: number): string => {
  const f = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v))
  return `vec2(${f(w)}, ${f(h)})`
}
/** Bytes per baked texel: RGBA float32 or half float. */
const texelBytes = (float32: boolean): number => (float32 ? 16 : 8)
const rect = (e: Extent): Vector4 => new Vector4(e.org[0], e.org[1], e.ext[0], e.ext[1])

/** A moon set's place: F5's first moon for the day set, F1's moon disc (or its rays) for the night's — `null`: none. */
const dayAnchor = (bg: Background | null): [number, number] | null => (bg?.moons?.[0] ? [bg.moons[0].x, bg.moons[0].y] : null)
const nightAnchor = (bg: Background | null): [number, number] | null =>
  bg?.sun ? [bg.sun.x, bg.sun.y] : bg?.rays ? [bg.rays[0], bg.rays[1]] : null

/**
 * The sky's full-screen quad (`bgQuad`: clip space, drawn first, never culled, no depth), fed with `setSky`
 * (what is baked: the shapes, both ends' glow heights and star densities, the two moon sets) and `setColours`
 * (per frame: the palette at `t` and where the moon sets are — `daylight.ts`), baked and moved by `place` before a
 * frame is drawn. `hide` is a dev check's control: those layer slots are skipped exactly as an empty slot is.
 */
/** T23.19G F6: the moon-set variants (`NSET`, `DSET`) a blend can draw — (0, 0) never: a sky always has one end's set. */
export const SET_VARIANTS: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, 0],
  [0, 1],
]

export class SkyQuad {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>
  /** Bakes made so far, and the bytes the current ones hold (the dev handle reports both; T23.11: `rayBytes` the moon sets' rays, one size at every tier). */
  readonly bakeStats = { bakes: 0, bytes: 0, rayBytes: 0 }
  /** What the bakes are shaped from: the night end (its shapes, its moon disc) and the day end (its moons). */
  private bg: Background | null = null
  private day: Background | null = null
  /** T23.11: how far past the frame the moon sets are baked, frame px — `MOON_REACH` when they move, 0 when not. */
  private reach: [number, number] = [0, 0]
  /** Bumped by `setSky`: part of the bake key, so a new sky (a new seed) is rebaked. */
  private skyId = 0
  private hidden = new Set<number>()
  private readonly bakeMat: ShaderMaterial
  private readonly bakeQuad: Mesh<PlaneGeometry, ShaderMaterial>
  private readonly bakeScene = new Scene()
  private readonly bakeCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private targets: WebGLRenderTarget[] = []
  private bakedKey = ''
  /** T23.11: where each moon set is against where it was baked, frame px (unsnapped; `place` snaps them). */
  private setOffsets: { night: Offset; day: Offset } = { night: [0, 0], day: [0, 0] }
  /** T23.11: the moon sets' baked extent (frame px, in a set's own frame). */
  private setsExtent: Extent = { org: [0, 0], ext: [1, 1] }

  constructor() {
    this.bakeMat = new ShaderMaterial({
      uniforms: {
        A: { value: Array.from({ length: N }, () => new Vector4()) },
        B: { value: Array.from({ length: N }, () => new Vector4()) },
        D: { value: Array.from({ length: N }, () => new Vector4()) },
        E: { value: Array.from({ length: N }, () => new Vector4()) },
        horizon: { value: 0 },
        sun: { value: new Vector4() },
        rays: { value: new Vector4() },
        MO: { value: Array.from({ length: SKY_MOONS }, () => new Vector4()) },
        MC: { value: Array.from({ length: SKY_MOONS }, () => new Vector3()) },
        ML: { value: Array.from({ length: SKY_MOONS }, () => new Vector4()) },
        glowY: { value: new Vector2(-1, -1) },
        stars: { value: new Vector2() },
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
        G: { value: null },
        Q: { value: null },
        NF: { value: null },
        DF: { value: null },
        DR: { value: null },
        ...Object.fromEntries(Array.from({ length: N }, (_, i) => [`L${i}`, { value: null }])),
        LR: { value: Array.from({ length: N }, () => new Vector4(0, 0, 1, 1)) },
        GR: { value: new Vector4(0, 0, 1, 1) },
        NFt: { value: new Vector4(0, 0, 0, 0) },
        DFt: { value: new Vector4(0, 0, 0, 0) },
        DRt: { value: new Vector4(0, 0, 0, 0) },
        E: { value: Array.from({ length: N }, () => new Vector2()) },
        on: { value: new Array<number>(N).fill(0) },
        Dz: { value: new Array<number>(N).fill(1) },
        C: { value: Array.from({ length: N }, () => new Vector3()) },
        skyTop: { value: new Vector3() },
        skyBottom: { value: new Vector3() },
        haze: { value: new Vector3() },
        glowC: { value: new Vector3() },
        sunC: { value: new Vector3() },
        rayC: { value: new Vector3() },
        sets: { value: new Vector2(1, 1) },
        t: { value: 1 },
        // `bgQuad` builds `bgMaterial(o, true)`: the result is raised to 2.2 before the post chain.
        lin: { value: 1 },
        grainK: { value: 0 },
        RES: { value: new Vector2(1280, 720) },
        skyOff: { value: new Vector2() },
        flatC: { value: new Vector4(0, 0, 0, 0) },
        ST: { value: null },
        STt: { value: new Vector2(1, 1) },
      },
      vertexShader: COMPOSITE_V,
      fragmentShader: COMPOSITE,
      // T23.11: the band slots compiled are the sky's own (`setSky`): SwiftShader runs every slot's arithmetic even
      // when its uniform switch skips it (the game's sky has four bands in six slots).
      defines: { NB: N, NSET: 1, DSET: 1, SSTARS: 0, GRAIN_RES: grainRes(1280, 720) },
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

  /**
   * Hand over the sky (`null`: draw none — a space map): `night` and, for the blend (T23.11), `day` — the same
   * shapes (a band's shape never blends), each end's glow height, star density and moon set. `reach`: how far the
   * moon sets may move (`daylight.ts::MOON_REACH`; none for the look-lab's still scenes). Then `setColours(night, 1)`
   * until the scene says otherwise. One background (the look-lab's scenes): both ends, both its sets at full weight.
   */
  setSky(night: Background | null, day: Background | null = null, reach: [number, number] = [0, 0]): void {
    this.bg = night
    this.day = day
    this.reach = night ? reach : [0, 0]
    this.skyId++
    this.mesh.visible = night !== null
    if (!night) return
    this.define('NB', Math.min(N, night.layers.length))
    const d = day ?? night
    this.packLayers()
    this.bu['horizon']!.value = night.horizon
    ;(this.bu['glowY']!.value as Vector2).set(night.glowY ?? -1, d.glowY ?? -1)
    ;(this.bu['stars']!.value as Vector2).set(night.stars ?? 0, d.stars ?? 0)
    this.setColours(night, 1)
  }

  /**
   * T23.11: this frame's sky — `bg` the blend at `t` with its moons at their places (`daylight.ts`): every colour,
   * each band's fade, where each moon set is (against where it was baked) and its weight (`vis`); `t` weighs each
   * end's stars and glow. Nothing here is baked: a new `t` or a moved moon never rebakes.
   */
  setColours(bg: Background, t: number): void {
    const u = this.u
    ;(u['skyTop']!.value as Vector3).copy(v3(bg.skyTop))
    ;(u['skyBottom']!.value as Vector3).copy(v3(bg.skyBottom))
    ;(u['haze']!.value as Vector3).copy(v3(bg.haze))
    ;(u['glowC']!.value as Vector3).copy(v3(bg.glowColor ?? 0x000000))
    u['t']!.value = t
    // `bgMaterial`'s own defaults, where a scene leaves a field out.
    u['grainK']!.value = bg.grainK ?? 0.035
    const nightBase = nightAnchor(this.bg)
    const dayBase = dayAnchor(this.day ?? this.bg)
    const night = nightAnchor(bg)
    const day = dayAnchor(bg)
    // Snapped to whole texels where the frame is placed (`place`): the sets are read nearest, texel centre on texel centre.
    this.setOffsets = {
      night: night && nightBase ? [night[0] - nightBase[0], night[1] - nightBase[1]] : [0, 0],
      day: day && dayBase ? [day[0] - dayBase[0], day[1] - dayBase[1]] : [0, 0],
    }
    // A set absent from the blend is invisible; present, at its `vis` (whole when the scene has one palette).
    const nightVis = bg.sun ? bg.sun.vis ?? 1 : bg.rays ? 1 : 0
    const dayVis = bg.moons?.length ? bg.moons[0]!.vis ?? 1 : 0
    ;(u['sets']!.value as Vector2).set(nightVis, dayVis)
    // A set at weight 0 is compiled out (full day, full night: most of the cycle) — measured on SwiftShader, its
    // reads cost even behind a uniform switch. three keeps each variant's program, so a switch compiles once.
    this.define('NSET', nightVis > 0 ? 1 : 0)
    this.define('DSET', dayVis > 0 ? 1 : 0)
    const C = u['C']!.value as Vector3[]
    const Dz = u['Dz']!.value as number[]
    for (let i = 0; i < N; i++) {
      const L = bg.layers[i]
      C[i]!.set(...(L ? hexLinear(L.color) : ([0, 0, 0] as [number, number, number])))
      Dz[i] = L ? (L.fade ?? [L.y, bg.horizon, 0.15])[2] : 1
    }
  }

  /**
   * T23.19G F6: build the composite's program for **every moon-set variant a blend reaches** now — both sets (dusk,
   * dawn), night's only, day's only (`setColours`' `NSET`/`DSET`) — drawn into 1 px of `target`, as `GlowLayer.warm`
   * does. Without it a round compiled one at its first dusk and one at its first full night: a frame stalled at a
   * gameplay moment, on the GPU tier too. three keeps each program on the material, so a later switch finds it built.
   * Nothing to do without a sky (a space map). The px is overwritten by the next drawn frame (the render pass clears).
   */
  warm(r: WebGLRenderer, target: WebGLRenderTarget): void {
    if (!this.bg) return
    const mat = this.mesh.material
    const keep = { n: mat.defines['NSET'] as number, d: mat.defines['DSET'] as number }
    const prev = r.getRenderTarget()
    const autoClear = r.autoClear
    const vis = this.mesh.visible
    r.autoClear = false
    target.scissor.set(0, 0, 1, 1)
    target.scissorTest = true
    r.setRenderTarget(target)
    this.mesh.visible = true
    for (const [n, d] of SET_VARIANTS) {
      this.define('NSET', n)
      this.define('DSET', d)
      r.render(this.mesh, this.bakeCam)
    }
    this.define('NSET', keep.n)
    this.define('DSET', keep.d)
    this.mesh.visible = vis
    target.scissor.set(0, 0, target.width, target.height)
    target.scissorTest = false
    r.setRenderTarget(prev)
    r.autoClear = autoClear
  }

  private define(name: string, v: number | string): void {
    const mat = this.mesh.material
    if (mat.defines[name] === v) return
    mat.defines[name] = v
    mat.needsUpdate = true
  }

  /** Pack one moon set into the bake's uniforms: `sunOf`'s disc and rays, `moonsOf`'s moons (either may be null). */
  private packSet(sunOf: Background | null, moonsOf: Background | null): void {
    const u = this.bu
    const s = sunOf?.sun
    ;(u['sun']!.value as Vector4).set(...(s ? ([s.x, s.y, s.r, s.k] as const) : ([0, 0, 0, 0] as const)))
    const r = sunOf?.rays
    ;(u['rays']!.value as Vector4).set(...(r ? ([r[0], r[1], r[2], r[3]] as const) : ([0, 0, 0, 0] as const)))
    // The night set's two colours are the composite's (its bake holds scalars) — set by the night set's own packing.
    if (sunOf) {
      ;(this.u['sunC']!.value as Vector3).copy(v3(sunOf.sun?.color ?? 0xffffff))
      ;(this.u['rayC']!.value as Vector3).copy(v3(sunOf.rayColor ?? 0xffffff))
    }
    const moons = moonsOf?.moons ?? []
    for (let i = 0; i < SKY_MOONS; i++) {
      const m = moons[i]
      ;(u['MO']!.value as Vector4[])[i]!.set(...(m ? ([m.x, m.y, m.r, m.rays ?? 0] as const) : ([0, 0, 0, 0] as const)))
      ;(u['MC']!.value as Vector3[])[i]!.set(...hexLinear(m?.color ?? 0))
      ;(u['ML']!.value as Vector4[])[i]!.set(...(m ? ([m.rayLen ?? 400, m.phase ?? 0.3, m.halo ?? 1, 0] as const) : ([1, 0, 0, 0] as const)))
    }
  }

  private packLayers(): void {
    const bg = this.bg
    if (!bg) return
    const u = this.bu
    const A = u['A']!.value as Vector4[]
    const B = u['B']!.value as Vector4[]
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
        D[i]!.set(0, 1, 1, 0)
        E[i]!.set(0, 0, 0, 0)
        continue
      }
      A[i]!.set(L.x, L.y, L.slope ?? L.r ?? 1, L.step ?? 6)
      B[i]!.set(SHAPE[L.shape], L.top ?? 0, L.soft ?? 1, L.jitter ?? 0.8)
      // `L.streak ?? 1`: no scene sets a streak, so the mockup's default. D.z (the fade's floor) is the composite's.
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
    this.define('GRAIN_RES', grainRes(frame[0], frame[1]))
    // The moon sets move in whole texels (as the gradient does), so their nearest reads are the bake's own values —
    // measured on SwiftShader, linear reads of the two sets cost ~0.7 ms a frame more.
    const snap = (v: number): number => Math.round(v / texel) * texel + 0
    // A frame px p = (fragX·texel, H − fragY·texel) reads its set at q = p − offset, whose texture coordinate is
    // ((q.x − org.x)/ext.x, 1 − (q.y − org.y)/ext.y) — linear in gl_FragCoord: scale and bias, per set.
    const fold = (k: string, off: Offset): void => {
      const e = this.setsExtent
      const [ox, oy] = [snap(off[0]), snap(off[1])]
      ;(this.u[k]!.value as Vector4).set(texel / e.ext[0], texel / e.ext[1], -(ox + e.org[0]) / e.ext[0], 1 - (frame[1] - oy - e.org[1]) / e.ext[1])
    }
    fold('NFt', this.setOffsets.night)
    fold('DFt', this.setOffsets.day)
    fold('DRt', this.setOffsets.day)
    return drawn
  }

  private bake(renderer: WebGLRenderer, bg: Background, view: ViewRect, world: { w: number; h: number }, frame: [number, number], texel: number): void {
    const x = bakeExtents(bg, view, world, frame, texel)
    const key = JSON.stringify([this.skyId, texel, frame, x])
    if (key === this.bakedKey) return
    this.bakedKey = key
    this.freeTargets()
    ;(this.bu['RES']!.value as Vector2).set(frame[0], frame[1])
    const bake = (mode: number, e: Extent, li = 0): Texture => {
      // The glow and haze weight read `ps.y` alone: one column, which every x reads (clamp to edge).
      const px = mode === MODE.rays ? RAY_TEXEL : texel
      const w = mode === MODE.post ? 1 : Math.max(1, Math.round(e.ext[0] / px))
      const linear = mode === MODE.layer || mode === MODE.rays
      // A linear float32 read needs `OES_texture_float_linear`; without it a band bakes half float,
      // which is always filterable (measured on look-sky: F5 deltaE_cave 0.011 of 0.0125, T23.04B).
      const f32 = linear ? float32Linear : float32
      const rt = target(w, Math.max(1, Math.round(e.ext[1] / px)), f32, linear)
      this.targets.push(rt)
      const bytes = rt.width * rt.height * texelBytes(f32)
      this.bakeStats.bytes += bytes
      if (mode === MODE.rays) this.bakeStats.rayBytes += bytes
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
    u['G']!.value = bake(MODE.gradient, x.horizon)
    u['Q']!.value = bake(MODE.post, x.horizon)
    ;(u['GR']!.value as Vector4).copy(rect(x.horizon))
    // The moon sets, each at its picture's place, the frame plus how far the set can move (whole texels).
    const up = (v: number): number => Math.ceil(v / texel) * texel
    const [rx, ry] = [up(this.reach[0]), up(this.reach[1])]
    const sets: Extent = { org: [-rx, -ry], ext: [frame[0] + 2 * rx, frame[1] + ry] }
    const night = this.bg
    const day = this.day ?? this.bg
    this.packSet(night, null)
    u['NF']!.value = bake(MODE.night, sets)
    this.packSet(null, day)
    // T23.20: a sky with no day moons (space) never reads the day set (`DSET` 0) — one texel each, not two frames' worth.
    const daySets: Extent = day?.moons?.length ? sets : { org: [0, 0], ext: [RAY_TEXEL, RAY_TEXEL] }
    u['DF']!.value = bake(MODE.fixed, daySets)
    u['DR']!.value = bake(MODE.rays, daySets)
    this.setsExtent = sets
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
    this.bakeStats.rayBytes = 0
  }

  /** Dev: draw only the layers not in `hide` (the parallax check isolates one band at a time). */
  hideLayers(hide: number[]): void {
    this.hidden = new Set(hide)
    this.packLayers()
  }

  /**
   * T23.20: add `stars` (a buffer-sized texture of the sky's pre-`lin` colour — `space.ts::SpaceStars`) where the dust
   * goes; `null`: none (compiled out). `buffer`: the drawing buffer's size, which the texture matches.
   */
  setStars(stars: Texture | null, buffer: [number, number]): void {
    this.define('SSTARS', stars ? 1 : 0)
    this.u['ST']!.value = stars
    ;(this.u['STt']!.value as Vector2).set(1 / Math.max(1, buffer[0]), 1 / Math.max(1, buffer[1]))
  }

  /**
   * Dev (T23.19C, `rock-opaque`): draw the whole sky as one flat linear colour (`null` restores) — anything the
   * sky shows through changes with it, and nothing else does.
   */
  setFlat(rgb: [number, number, number] | null): void {
    ;(this.u['flatC']!.value as Vector4).set(...(rgb ?? [0, 0, 0]), rgb ? 1 : 0)
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
