/**
 * T23.07 (R14): the lit terrain — `mockup-src/kit.js::terrainMaterial`, ported, with F1's look.
 *
 * **What the mockup's shader does, and what is kept** (the GLSL below follows it line for line):
 * bevelled normals from `dIn` (the height is a quarter-circle of radius `bevel` over the signed
 * distance, plus `relief × 7`) with the albedo's luminance as micro-relief; the sun with a 10-step
 * self-shadow march toward it through the mask; a sky/ground ambient; interior darkening that makes
 * the deep face recede; the rim light on edges facing away from the sun; a specular glint on the
 * bevel; the glowing lip where the top edge catches the sky; grass tips; the cave wall set back
 * behind the face, shadowed by it and darkened toward the rock (`dOut`), lit by the point lights at
 * z −30, and — R24 final form, T23.07C — drawn with `back` as its coverage: hard wall is 255, soft wall
 * (landform outside the closing) fades from open sky over `render_fields.rs::BACK_RAMP_PX`; the grass fringe lit flat. Point lights: `terrainLights.ts` (culled, sorted, 16 slots).
 *
 * **Dropped, and why:** `occl` (the object contact shadow's 5×5 = 25 reads a pixel) is a blank 4×4
 * render target in every F scene (`f_kit.js::frame`'s `black`), so it multiplies by exactly 1 —
 * research § 1; removed with its two lines. `lava`/`lavaK` (F2's glowing seams): **ported back by T23.31** for the
 * volcanic world (docs/78 §A7) with the mockup's own noise (`kit.js::NOISE_GLSL`, here `lv*`); 0 in F1 and F5, where
 * the branch is skipped and the classic picture is unchanged.
 *
 * **The albedo target holds sRGB bytes** (`albedo.ts`, a plain RGBA8 target), where the mockup's
 * `DataTexture` was tagged `SRGBColorSpace` and decoded by the GPU on sampling: `A()` decodes with
 * the same piecewise curve. The mockup samples it only at texel centres (`p` is snapped to them), so
 * a `texelFetch` is the same read as its linear-filtered `texture2D`.
 *
 * **Two tiers (R14).** *Full* is the mockup's shader (`FULL_FS`). *Low* bakes what changes only with
 * the terrain — the normal (4 height + 4 luminance taps), the sun's shadow march (≈ 20 field reads)
 * and the cave wall's shadow (6) — into a world-sized RGBA8 target per dirty rect (`BAKE_FS`,
 * `terrainGpu.ts`), and per frame reads it back (`LOW_FS`): 4 texture reads a pixel instead of ≈ 40.
 * Both draw through **one** shading function (`shade`), so the tiers cannot drift apart in anything
 * but the bake's 8-bit quantisation. The bake depends on `sunDir`, `bevel` and `pixel`: a look that
 * changes them rebakes (`bakeKey`).
 */
import { CORE_HEART_A, CORE_RIM_A } from './albedo'
import { GLSL3, ShaderMaterial, Vector2, Vector3, Vector4, type Texture } from 'three'
import type { Light, TerrainLook } from './scene'
import { TERRAIN_LIGHTS, TERRAIN_LIGHTS_LOW, toLin } from './terrainLights'

/**
 * How far a baked texel reads the fields, px: the sun march's 10 × 5 px (plus the bilinear tap), the
 * cave shadow's 8 + 5 × 6, the normal's 1.5 — so a fields rect grown by this covers every texel it changes.
 */
export const BAKE_REACH = 53

/** The mockup's `pixel` (terrainMaterial's snap): 1, every F scene. */
const PIXEL = 1

/** The uniforms every terrain shader reads (the look, the lights, the textures). */
const COMMON = /* glsl */ `
uniform sampler2D field;
uniform sampler2D albedo;
uniform vec2 RES;
uniform float worldH;
uniform vec3 sunDir, sunCol, sky, ground, rimCol, lipCol;
uniform float bevel, interior, pixel, ambient, rimK, lipK;
uniform float wallK; // dev (gate-ground): 0 draws no cave wall; 1 always in play
uniform vec3 lava; uniform float lavaK; // T23.31: F2's glowing seams (0: none — the classic world)
uniform vec4 pl[${TERRAIN_LIGHTS}];
uniform vec3 plc[${TERRAIN_LIGHTS}];
uniform int nl;
vec4 F(vec2 p) { return texture(field, p / RES); }          // p: mask px, y down (texture row 0 = mask row 0)
float backOf(vec4 f) { return f.b * wallK; }
float sd(vec2 p) { vec4 f = F(p); return f.r * 64. - f.g * 64.; } // + inside
float heightOf(vec4 f) { float d = clamp((f.r * 64. - f.g * 64.) / bevel, 0., 1.); return bevel * sqrt(1. - (1. - d) * (1. - d)) + f.a * 7. * d; }
float height(vec2 p) { return heightOf(F(p)); }
// T23.31: kit.js::NOISE_GLSL (hash12, vnoise, fbm) for the lava seams — the mockup's float hash, not world.js's.
float lvHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float lvNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(lvHash(i), lvHash(i + vec2(1, 0)), f.x), mix(lvHash(i + vec2(0, 1)), lvHash(i + vec2(1, 1)), f.x), f.y); }
float lvFbm(vec2 p, int o) { float t = 0., a = .5; for (int i = 0; i < 8; i++) { if (i >= o) break; t += a * lvNoise(p); p = p * 2.03 + 17.1; a *= .5; } return t; }
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec4 A(vec2 p) { vec4 a = texelFetch(albedo, clamp(ivec2(floor(p)), ivec2(0), ivec2(RES) - 1), 0); return vec4(srgbToLinear(a.rgb), a.a); }
float lum(vec2 p) { return dot(A(p).rgb, vec3(.3, .5, .2)); }
vec3 normalAt(vec2 p) {
  float e = 1.5 * pixel;
  float hx = height(p + vec2(e, 0.)) - height(p - vec2(e, 0.));
  float hy = height(p + vec2(0., e)) - height(p - vec2(0., e));
  float bx = lum(p + vec2(1., 0.)) - lum(p - vec2(1., 0.));
  float by = lum(p + vec2(0., 1.)) - lum(p - vec2(0., 1.));
  return normalize(vec3(-hx / (2. * e) - bx * 1.5, hy / (2. * e) + by * 1.5, 1.)); // world: x right, y up, z toward viewer
}
// The sun's self-shadow: march toward the sun in the mask.
float sunShadow(vec2 p, float z) {
  float sh = 1.;
  vec2 sd2 = normalize(vec2(sunDir.x, -sunDir.y));
  for (int i = 1; i <= 10; i++) { vec2 q = p + sd2 * float(i) * 5.; float o = clamp(sd(q) + 0.5, 0., 1.); float hq = height(q); sh = min(sh, 1. - o * smoothstep(-2., 6., hq - (z + float(i) * 5. * sunDir.z / length(sunDir.xy) * 0.45))); }
  return mix(1., sh, 0.8);
}
// The cave wall: the front face casts its shadow onto it.
float backShadow(vec2 p) {
  vec2 sd2 = normalize(vec2(sunDir.x, -sunDir.y));
  float sh = 0.; for (int i = 0; i < 6; i++) { vec2 q = p + sd2 * (8. + float(i) * 6.); sh = max(sh, clamp(sd(q) + 0.5, 0., 1.)); }
  return sh;
}
`

/**
 * T23.20: how much a space rock's core adds of its own colour (linear, × albedo) — its heart's amber past the bloom
 * threshold (F3's 0.7) so the core reads as a light in the dark rock, its ember rim a glow under it. The albedo marks
 * the pixels (`albedo.ts::CORE_HEART_A` 250, `CORE_RIM_A` 253 of 255; between them `CORE_A_MID`).
 */
export const CORE_GLOW = { heart: 1.6, rim: 0.6 } as const
const CORE_A_LO = ((CORE_HEART_A - 1) / 255).toFixed(4)
const CORE_A_MID = ((CORE_HEART_A + CORE_RIM_A) / 2 / 255).toFixed(4)
const CORE_A_HI = ((CORE_RIM_A + 1) / 255).toFixed(4)

/**
 * The shading, shared by both tiers: `n`, `sh` (front) and `shB` (cave wall) are computed (full) or
 * read from the bake (low). Writes `fragColor` or discards. `slots`: the light loops' bound — the tier's
 * (`TERRAIN_LIGHTS` full, `TERRAIN_LIGHTS_LOW` low): SwiftShader runs a loop to its bound whatever `nl` is.
 */
const shade = (slots: number): string => /* glsl */ `
out vec4 fragColor;
void shade(vec2 p, vec4 f, vec4 alb, vec3 n, float sh, float shB) {
  float s = f.r * 64. - f.g * 64.;
  float cover = clamp(s + 0.5, 0., 1.);
  float bk = backOf(f); // R24: the wall's coverage, ramping up from open sky
  bool isBack = bk > 0.;
  vec3 wp = vec3(p.x, worldH - p.y, heightOf(f));
  vec3 col = vec3(0.);
  if (cover > 0.001) {
    vec3 a = alb.rgb;
    float ndl = max(dot(n, sunDir), 0.);
    vec3 lit = sunCol * ndl * sh;
    vec3 amb = mix(ground, sky, n.y * 0.5 + 0.5) * ambient;
    // interior darkening: the far-from-edge face reads as a receding mass
    float depth = smoothstep(14., 64., f.r * 64.);
    amb *= 1. - interior * depth; lit *= 1. - interior * 0.6 * depth;
    // (the mockup's object contact shadow: occl is blank in every F scene — dropped)
    // rim light on edges facing away from the sun
    float rim = pow(1. - n.z, 1.5) * max(dot(normalize(n.xy + 1e-4), -normalize(sunDir.xy)), 0.);
    vec3 pls = vec3(0.);
    for (int i = 0; i < ${slots}; i++) {
      if (i >= nl) break;
      // T23.18B: a light whose radius does not reach this px adds exactly 0 (att = 0²) — skipped before the
      // sqrt and the normalise; the square is a product, not a pow (exp/log on SwiftShader). Measured: the journal.
      vec3 L = vec3(pl[i].x, worldH - pl[i].y, pl[i].z) - wp; float d2 = dot(L, L); float r = pl[i].w;
      if (d2 >= r * r) continue;
      float inv = inversesqrt(d2); float d = d2 * inv; L *= inv;
      float a = 1. - d / r; float att = a * a;
      pls += plc[i] * att * (max(dot(n, L), 0.) * 0.85 + 0.15);
    }
    // wet/specular glint on the bevel
    vec3 hv = normalize(sunDir + vec3(0., 0., 1.));
    float spec = pow(max(dot(n, hv), 0.), 40.) * (1. - depth) * 0.25 * sh;
    col = a * (lit + amb + pls) + rimCol * rim * rimK * sh + sunCol * spec;
    // lip light: the top edge catches the sky (reads the silhouette in the dark)
    float upv = sd(p + vec2(0., 3.)) - s;
    col += lipCol * lipK * smoothstep(5., 0., s) * smoothstep(0.5, 2.5, upv);
    // T23.31: kit.js's lava seams — thin glowing cracks deep in the face, and a glow rising from the world's floor.
    // (smoothstep(0.012, 0.0, x) there, reversed edges; written as 1 − smoothstep(0, 0.012, x), the same curve.)
    if (lavaK > 0.) {
      float cr = lvFbm(p * vec2(0.012, 0.03) + lvFbm(p * 0.01, 3) * 2., 5);
      float seam = (1. - smoothstep(0.0, 0.012, abs(cr - 0.5))) * smoothstep(28., 60., f.r * 64.) * smoothstep(0.35, 0.7, lvNoise(p * 0.006));
      col += lava * lavaK * seam * (0.6 + 0.4 * lvNoise(p * 0.05));
      col += lava * 0.05 * lavaK * smoothstep(0.7, 1.0, p.y / worldH);
    }
    // grass tips catching light on top edges
    col += a * sunCol * 0.25 * smoothstep(0.4, 0.9, n.y) * sh;
    // T23.20: a space rock's core glows — its heart (albedo alpha CORE_HEART_A), its ember rim (CORE_RIM_A) less.
    if (alb.a > ${CORE_A_LO} && alb.a < ${CORE_A_HI}) col += a * (alb.a < ${CORE_A_MID} ? ${CORE_GLOW.heart.toFixed(2)} : ${CORE_GLOW.rim.toFixed(2)});
  }
  if (isBack) {
    // backdrop wall: set back behind the front face; the front casts shadow onto it
    vec3 a = alb.rgb;
    float ao = smoothstep(0., 26., f.g * 64.);
    vec3 pls = vec3(0.);
    for (int i = 0; i < ${slots}; i++) {
      if (i >= nl) break;
      vec3 L = vec3(pl[i].x, worldH - pl[i].y, pl[i].z) - vec3(wp.xy, -30.); float d2 = dot(L, L); float r = pl[i].w;
      if (d2 >= r * r) continue;
      float d = sqrt(d2); float a = 1. - d / r; pls += plc[i] * (a * a) * max(L.z / d, 0.) * 0.8;
    }
    vec3 bcol = a * ((sunCol * 0.55 * (1. - shB) + sky * 0.35) * (0.35 + 0.65 * ao) + pls);
    if (cover <= 0.001) { fragColor = vec4(bcol, bk); return; }
    // The rock over the wall, both with coverage (straight alpha); a whole wall (bk = 1) is the mockup's line.
    if (bk >= 1.) { col = mix(bcol, col, cover); cover = 1.; }
    else { float ca = cover + bk * (1. - cover); col = (col * cover + bcol * bk * (1. - cover)) / ca; cover = ca; }
  }
  fragColor = vec4(col, cover);
}
// The grass fringe (albedo alpha 200) is lit flat, before anything else.
bool fringe(vec2 p, float s, vec4 alb) {
  if (!(alb.a > 0.62 && alb.a < 0.95 && s < 0.5)) return false;
  vec3 nf = normalize(vec3(-0.2, 0.6, 0.75));
  vec3 c = alb.rgb * (sunCol * max(dot(nf, sunDir), 0.) * 1.1 + sky * 0.7);
  for (int i = 0; i < ${slots}; i++) {
    if (i >= nl) break;
    vec3 L = vec3(pl[i].x, worldH - pl[i].y, pl[i].z) - vec3(p.x, worldH - p.y, 8.); float d2 = dot(L, L); float r = pl[i].w;
    if (d2 >= r * r) continue;
    float a = 1. - sqrt(d2) / r; c += alb.rgb * plc[i] * (a * a);
  }
  fragColor = vec4(c, 1.);
  return true;
}
`

const VS = /* glsl */ `
uniform vec2 ext;
out vec2 vP;
void main() { vP = vec2(uv.x, 1.0 - uv.y) * ext; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`

/** The full tier: `kit.js::terrainMaterial`'s fragment shader. */
const FULL_FS = /* glsl */ `
${COMMON}
${shade(TERRAIN_LIGHTS)}
in vec2 vP;
void main() {
  vec2 p = (floor(vP / pixel) + 0.5) * pixel;
  vec4 f = F(p);
  vec4 alb = A(p);
  float s = f.r * 64. - f.g * 64.;
  if (fringe(p, s, alb)) return;
  if (clamp(s + 0.5, 0., 1.) <= 0.001 && !(backOf(f) > 0.)) discard;
  vec3 n = normalAt(p);
  float sh = s + 0.5 > 0.001 ? sunShadow(p, heightOf(f)) : 1.;
  float shB = f.b > 0. ? backShadow(p) : 0.;
  shade(p, f, alb, n, sh, shB);
}
`

/** The low tier, per frame: the normal and both shadows read from the bake. */
const LOW_FS = /* glsl */ `
${COMMON}
${shade(TERRAIN_LIGHTS_LOW)}
uniform sampler2D baked;
in vec2 vP;
void main() {
  vec2 p = (floor(vP / pixel) + 0.5) * pixel;
  vec4 f = F(p);
  vec4 alb = A(p);
  float s = f.r * 64. - f.g * 64.;
  if (fringe(p, s, alb)) return;
  if (clamp(s + 0.5, 0., 1.) <= 0.001 && !(backOf(f) > 0.)) discard;
  vec4 b = texelFetch(baked, clamp(ivec2(floor(p)), ivec2(0), ivec2(RES) - 1), 0);
  vec2 nxy = b.rg * 2. - 1.;
  vec3 n = vec3(nxy, sqrt(max(0., 1. - dot(nxy, nxy))));
  shade(p, f, alb, n, b.b, b.a);
}
`

/**
 * The low tier's bake, per dirty rect into the world-sized RGBA8 target: `gl_FragCoord` is the world
 * px (row 0 = mask row 0, as the albedo pass). R, G: the normal's x, y (`× 0.5 + 0.5`); B: the sun's
 * shadow; A: the cave wall's.
 */
export const BAKE_FS = /* glsl */ `
precision highp float; precision highp int;
${COMMON}
out vec4 bakeOut;
void main() {
  vec2 p = floor(gl_FragCoord.xy) + 0.5;
  vec4 f = F(p);
  vec3 n = normalAt(p);
  float s = f.r * 64. - f.g * 64.;
  float sh = s + 0.5 > 0.001 ? sunShadow(p, heightOf(f)) : 1.;
  float shB = f.b > 0. ? backShadow(p) : 0.;
  bakeOut = vec4(n.xy * 0.5 + 0.5, sh, shB);
}
`

/** The key a bake is valid for: the look parameters the bake reads. */
export function bakeKey(t: TerrainLook): string {
  return JSON.stringify([t.sunDir, t.bevel, PIXEL])
}

type Uniforms = Record<string, { value: unknown }>

/** The uniforms one terrain look sets, shared by the draw materials and the bake. */
export function lookUniforms(): Uniforms {
  return {
    field: { value: null },
    albedo: { value: null },
    RES: { value: new Vector2(1, 1) },
    worldH: { value: 0 },
    sunDir: { value: new Vector3() },
    sunCol: { value: new Vector3() },
    sky: { value: new Vector3() },
    ground: { value: new Vector3() },
    rimCol: { value: new Vector3() },
    lipCol: { value: new Vector3() },
    bevel: { value: 1 },
    interior: { value: 0 },
    pixel: { value: PIXEL },
    ambient: { value: 1 },
    rimK: { value: 0 },
    lipK: { value: 0 },
    lava: { value: new Vector3() },
    lavaK: { value: 0 },
    wallK: { value: 1 },
    pl: { value: Array.from({ length: TERRAIN_LIGHTS }, () => new Vector4(0, 0, 0, 1)) },
    plc: { value: Array.from({ length: TERRAIN_LIGHTS }, () => new Vector3()) },
    nl: { value: 0 },
  }
}

/** Set a look's parameters (`kit.js::terrainMaterial`'s, `sunDir` normalised as it does). */
export function setLook(u: Uniforms, t: TerrainLook): void {
  ;(u['sunDir']!.value as Vector3).set(...t.sunDir).normalize()
  ;(u['sunCol']!.value as Vector3).set(...t.sunCol)
  ;(u['sky']!.value as Vector3).set(...t.sky)
  ;(u['ground']!.value as Vector3).set(...t.ground)
  ;(u['rimCol']!.value as Vector3).set(...t.rimCol)
  ;(u['lipCol']!.value as Vector3).set(...t.lipCol)
  u['bevel']!.value = t.bevel
  u['interior']!.value = t.interior
  u['rimK']!.value = t.rimK
  u['lipK']!.value = t.lipK
  ;(u['lava']!.value as Vector3).set(...(t.lava ?? [0, 0, 0]))
  u['lavaK']!.value = t.lavaK ?? 0
}

/** Upload `lights` (already picked — `pickLights`) into the slots. */
export function setLights(u: Uniforms, lights: readonly Light[]): void {
  const pl = u['pl']!.value as Vector4[]
  const plc = u['plc']!.value as Vector3[]
  const n = Math.min(lights.length, TERRAIN_LIGHTS)
  for (let i = 0; i < n; i++) {
    const l = lights[i]!
    pl[i]!.set(l.x, l.y, l.z, l.r)
    plc[i]!.set(...toLin(l.rgb)).multiplyScalar(l.i)
  }
  u['nl']!.value = n
}

/** Point the uniforms at a GPU side's textures. `worldH`: the description's mask height (the y flip). */
export function setTextures(u: Uniforms, field: Texture, albedo: Texture, w: number, h: number, worldH: number): void {
  u['field']!.value = field
  u['albedo']!.value = albedo
  ;(u['RES']!.value as Vector2).set(w, h)
  u['worldH']!.value = worldH
}

/**
 * The two draw materials, sharing one uniform object (a look set once reaches both). A world-sized
 * quad: `ext` is the mask's size, so `vP` is mask px (y down) — the mockup's `p` on its screen quad.
 */
export function makeTerrainMaterials(): { full: ShaderMaterial; low: ShaderMaterial; uniforms: Uniforms } {
  const uniforms: Uniforms = { ...lookUniforms(), ext: { value: new Vector2(1, 1) }, baked: { value: null } }
  const make = (fs: string): ShaderMaterial =>
    new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms,
      vertexShader: VS,
      fragmentShader: fs,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
  return { full: make(FULL_FS), low: make(LOW_FS), uniforms }
}
