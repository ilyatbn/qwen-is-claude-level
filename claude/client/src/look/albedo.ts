/**
 * T23.06 (R4, R5): the rock's albedo, painted on the GPU — `mockup-src/world.js::derive`'s albedo
 * loop ported to a fragment shader that writes the same RGBA8 bytes (A = 255 rock, 128 cave wall,
 * 200 grass fringe, 0 air) into a world-sized texture, one dirty rectangle at a time.
 *
 * **The hash is integer and ports bit-exact**: `world.js::hash` is `| 0`, `Math.imul` and `>>> 0`
 * on 32-bit words, i.e. `uint` arithmetic mod 2³², which is what WebGL2's `uint` does. `hashU32`
 * is the TS spelling of the same word (vitest: equal to the mockup's over 10k inputs); the GLSL's
 * words are read back and compared to it in `look-albedo`. Everything after the hash (value noise,
 * fbm, Worley) is float32 on the GPU against the mockup's float64 — near, not bit-equal, and
 * `look-albedo` says how near.
 *
 * **Inputs are T23.05's fields** (`render_fields.rs`), not the mask: solid ⇔ `dIn > 0`, cave wall
 * ⇔ `back`, and `dIn` itself (the mockup's exact float — the RGBA's ×4 in 8 bits is 0.25 px steps, and the
 * soil and grass thresholds and the "which way is up" gradient read it — so it comes exact, `dIn²` as
 * R16UI beside the fields). Scorch is an R8 mask of
 * `1 − r / R`, max over every blast (`terrainGpu.ts`), which is the mockup's per-scorch falloff for
 * one scorch and the strongest of them where two overlap (the mockup mixes them in turn).
 *
 * **One palette per world (R5):** `world.js::THEMES.dusk`, the theme F1 and F5 are derived with, on every
 * ground map; `MapMeta.theme` is not read for terrain colour. **T23.20: space is a world of its own** —
 * `THEMES.asteroid`, the theme F3 is derived with (`variant_F3.js`), chosen by the scene description
 * (`SceneDescription.albedo`), never by the theme byte.
 */

import { CORE_DIM_TOWARD_RIM, CORE_HEART, CORE_HEART_FRAC, CORE_RIM, IRON_TINT, IRON_TINT_ALPHA } from '../render/chunkBake-math'

/** A `world.js::THEMES` entry as the albedo pass reads it, sRGB bytes. */
type B3 = readonly [number, number, number]
export interface AlbedoPalette {
  grass: readonly [B3, B3]
  soil: readonly [B3, B3]
  rock: readonly [B3, B3, B3, B3]
  pebble: B3
  back: readonly [B3, B3]
  scorch: B3
  /** The boulder id threshold — `derive`'s `T.boulders ?? 0.62`. */
  boulders: number
  /** `T.noTop`: no soil and no grass on the rock's top faces (asteroid). */
  noTop: boolean
  /** No grass fringe drawn into the air (`derive`: `themeName !== 'asteroid' && !T.noGrass`). */
  noFringe: boolean
}

/**
 * T23.20: space's rocks carry what the sim gave them (`docs/77`): **iron** (R113) drawn darker — `IRON_TINT` at
 * `IRON_TINT_ALPHA` over the rock, as the Phaser bake drew it — and each ordinary rock's **core** (R102): an ember rim
 * and an amber heart (`CORE_HEART_FRAC` of the core's radius) whose glow dims per hit toward the rim
 * (`coreHeartColour`'s mix). Their pixels are marked in the albedo's alpha (`CORE_RIM_A`, `CORE_HEART_A`, between the
 * grass fringe's 200 and rock's 255) so the lit terrain makes them glow (`terrainMaterial.ts`, `CORE_GLOW`): F3's
 * rocks are lit by the star and the fight, and a core is a light of its own. Discs are a texture (`discs`, one texel
 * each: x, y, r, hits — hits < 0 for iron), read only where the rock is.
 */
export const CORE_RIM_A = 253
export const CORE_HEART_A = 250
/** The most discs a map's albedo reads (cores + irons; a Large map seats well under this many rocks). */
export const MAX_DISCS = 256

/** `world.js::THEMES.dusk` — the ground's terrain palette (R5), sRGB bytes. */
export const TERRAIN_PALETTE = {
  grass: [[52, 70, 58], [74, 92, 70]],
  soil: [[70, 52, 44], [56, 42, 36]],
  rock: [[112, 96, 88], [96, 84, 80], [124, 108, 96], [88, 78, 76]],
  pebble: [140, 126, 116],
  back: [[52, 46, 48], [40, 36, 40]],
  scorch: [20, 16, 16],
  boulders: 0.8,
  noTop: false,
  noFringe: false,
} as const satisfies AlbedoPalette

/** T23.20: `world.js::THEMES.asteroid` — space's (F3's), sRGB bytes; `boulders` is `derive`'s default. */
export const ASTEROID_PALETTE = {
  grass: [[120, 116, 130], [150, 144, 160]],
  soil: [[92, 86, 100], [76, 70, 84]],
  rock: [[118, 110, 116], [98, 92, 100], [134, 124, 124], [88, 84, 94]],
  pebble: [160, 150, 150],
  back: [[40, 38, 50], [30, 28, 40]],
  scorch: [22, 18, 20],
  boulders: 0.62,
  noTop: true,
  noFringe: true,
} as const satisfies AlbedoPalette

/**
 * T23.31 (docs/78 §A7): `world.js::THEMES.volcanic` verbatim — F2's rock: near-black basalt, ash where the dusk palette
 * has grass, and **no grass fringe** (`T.noGrass`: `derive` skips the blades — `noFringe` here). Its glowing seams are not albedo: they are the
 * lit terrain's `lava` term (`terrainMaterial.ts`), as in the mockup.
 */
export const VOLCANIC_PALETTE = {
  grass: [[60, 54, 52], [80, 70, 64]],
  soil: [[54, 44, 42], [42, 36, 36]],
  rock: [[64, 60, 62], [48, 46, 50], [78, 72, 72], [40, 38, 42]],
  pebble: [96, 90, 92],
  back: [[34, 30, 32], [26, 24, 26]],
  scorch: [14, 10, 10],
  boulders: 0.75,
  noTop: false,
  noFringe: true,
} as const satisfies AlbedoPalette

/** The albedo palettes by name (`SceneDescription.albedo`). */
export const ALBEDO_PALETTES = { dusk: TERRAIN_PALETTE, asteroid: ASTEROID_PALETTE, volcanic: VOLCANIC_PALETTE } as const
export type AlbedoPaletteName = keyof typeof ALBEDO_PALETTES

/**
 * R24 (T23.07B F2): the albedo's per-map offset, world px, added to the position every noise reads
 * (`ALBEDO_FS`'s `p` and the grass blades' column) — so strata, boulders and cracks sit differently on
 * each map instead of identically at the same world px (the owner's T21.15 report). Hashed from the
 * map seed's two words (`map_init`'s key, or the sandbox's own); `ALBEDO_OFFSET_RANGE` keeps `p` a few
 * thousand px, far inside float32's exact integers, so the noise is the same function, only shifted.
 * The look-lab passes none (0, 0): its scenes stay the mockup's, bit for bit at the hash.
 */
export const ALBEDO_OFFSET_RANGE = 4096
/** Salts for the two axes' hashes (any fixed words; they only have to differ). */
const OFFSET_SALT_X = 211
const OFFSET_SALT_Y = 212

export function albedoOffset(seedLo: number, seedHi: number): [number, number] {
  return [hashU32(seedLo, seedHi, OFFSET_SALT_X) % ALBEDO_OFFSET_RANGE, hashU32(seedLo, seedHi, OFFSET_SALT_Y) % ALBEDO_OFFSET_RANGE]
}

/** `world.js::hash`'s 32-bit word before the `/ 2³²` — what WebGL2's `uint` computes. */
export function hashU32(x: number, y: number, s: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 144665)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * The hash probe's inputs (`look-albedo`): index `i` → `(x, y, s)`, negatives and large values
 * included. The same integer arithmetic in the shader (`HASH_PROBE_FS`) and here.
 */
export function probeInput(i: number): [number, number, number] {
  return [((i * 7919) % 40009) - 20000, ((i * 104729) % 30011) - 15000, i % 211]
}


/** T23.31: the albedo palette a combat palette's `theme` names — `volcanic`, else the ground's (`dusk`, R5). */
export function albedoTheme(theme: string | null | undefined): AlbedoPaletteName {
  return theme === 'volcanic' ? 'volcanic' : 'dusk'
}

const v3 = (c: readonly number[]): string => `vec3(${c.map((n) => n.toFixed(1)).join(', ')})`
const hexBytes = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const IRON_RGB = hexBytes(IRON_TINT)
const HEART_RGB = hexBytes(CORE_HEART)
const RIM_RGB = hexBytes(CORE_RIM)

/** `world.js`'s noise, GLSL ES 3.00. `hash` returns the mockup's `[0, 1)` value. */
export const NOISE_GLSL = /* glsl */ `
uint hashU(int x, int y, int s) {
  uint h = uint(x) * 374761393u + uint(y) * 668265263u + uint(s) * 144665u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}
float hash(int x, int y, int s) { return float(hashU(x, y, s)) / 4294967296.0; }
float vnoise(vec2 p, int s) {
  vec2 i = floor(p); vec2 f = p - i; vec2 u = f * f * (3.0 - 2.0 * f);
  int xi = int(i.x), yi = int(i.y);
  float a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
float fbm(vec2 p, int oct, int s) {
  float t = 0.0, a = 0.5, f = 1.0, n = 0.0;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; t += a * vnoise(p * f, s + i * 17); n += a; a *= 0.5; f *= 2.03; }
  return t / n;
}
vec3 cell2(vec2 p, int s) {
  vec2 fl = floor(p); int xi = int(fl.x), yi = int(fl.y); float f1 = 9.0, f2 = 9.0, id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float px = float(xi + i) + hash(xi + i, yi + j, s), py = float(yi + j) + hash(xi + i, yi + j, s + 9);
    float d = sqrt((px - p.x) * (px - p.x) + (py - p.y) * (py - p.y));
    if (d < f1) { f2 = f1; f1 = d; id = hash(xi + i, yi + j, s + 5); } else if (d < f2) f2 = d;
  }
  return vec3(f1, f2, id);
}
float cell(vec2 p, int s) {
  vec2 fl = floor(p); int xi = int(fl.x), yi = int(fl.y); float best = 9.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float px = float(xi + i) + hash(xi + i, yi + j, s), py = float(yi + j) + hash(xi + i, yi + j, s + 9);
    float d = (px - p.x) * (px - p.x) + (py - p.y) * (py - p.y); if (d < best) best = d;
  }
  return sqrt(best);
}
`

/** A clip-space quad over the whole viewport: the passes set the viewport to the rect they write. */
export const QUAD_VS = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`

/** Longest grass blade, px: `floor((2 + 11) * (0.5 + 1))` — the fringe loop's search depth. */
const MAX_BLADE = 19

/**
 * The albedo pass for palette `P`. `gl_FragCoord` is the world px (row 0 = mask row 0 — the field texture is
 * uploaded that way up and the target is written the same way). Branch for branch `world.js::derive`.
 */
export const albedoFs = (P: AlbedoPalette): string => /* glsl */ `
precision highp float; precision highp int;
uniform sampler2D field;
uniform highp usampler2D din2;
uniform sampler2D scorch;
uniform ivec2 size;
uniform ivec2 offset; // R24: the map's albedo offset (albedoOffset), 0 in the look-lab
uniform sampler2D discs; // T23.20: space's cores and irons, one texel each — x, y, r, hits (< 0: iron)
uniform int nDiscs;
uniform float coreHits;
out vec4 outColor;
${NOISE_GLSL}
int W, H;
ivec4 fieldAt(int x, int y) { return ivec4(texelFetch(field, ivec2(x, y), 0) * 255.0 + 0.5); }
// dIn exactly: √ of the integer squared distance (the RGBA's ×4-in-8-bits byte moved the soil and grass bands).
float dInAt(int x, int y) { return sqrt(float(texelFetch(din2, ivec2(x, y), 0).r)); }
// world.js reads dIn[i ± 1] and dIn[i ± W] on the flat array: off the ends is 0, and x ± 1 wraps a row.
float dInFlat(int i) {
  if (i < 0 || i >= W * H) return 0.0;
  return dInAt(i % W, i / W);
}
bool solidAt(int x, int y) { return fieldAt(x, y).r > 0; }
float scorchAt(int x, int y) { return texelFetch(scorch, ivec2(x, y), 0).r; }
vec3 rockCol(int k) {
  k = k % 4;
  return k == 0 ? ${v3(P.rock[0])} : k == 1 ? ${v3(P.rock[1])} : k == 2 ? ${v3(P.rock[2])} : ${v3(P.rock[3])};
}
void main() {
  W = size.x; H = size.y;
  int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y), i = y * W + x;
  ivec4 f = fieldAt(x, y);
  vec2 p = vec2(float(x + offset.x), float(y + offset.y));
  float sc = scorchAt(x, y);
  if (f.r > 0) {
    float d = dInAt(x, y);
    float gx = dInFlat(i + 1) - dInFlat(i - 1), gy = dInFlat(i + W) - dInFlat(i - W);
    float gl = length(vec2(gx, gy)); if (gl == 0.0) gl = 1.0;
    float up = gy / gl;
    float warp = fbm(p * 0.02, 3, 11);
    float band = mod(p.y * 0.045 + warp * 3.2 + fbm(vec2(p.x * 0.004, 0.0), 2, 12) * 4.0, 4.0);
    int bi = int(floor(band)); float bt = band - float(bi);
    vec3 c = mix(rockCol(bi), rockCol(bi + 1), pow(bt, 6.0));
    float grain = fbm(p * 0.25, 3, 13);
    c = mix(c, vec3(c.r * 0.75, c.g * 0.75, c.b * 0.78), max(0.0, grain - 0.45) * 1.8);
    vec3 b = cell2(vec2(p.x * 0.022 + warp * 0.6, p.y * 0.03 + warp * 0.4), 21);
    float edge = b.y - b.x;
    if (b.z > ${P.boulders} && d > 10.0) {
      float dome = min(1.0, edge * 2.2);
      vec3 st = mix(vec3(124.0, 118.0, 110.0), vec3(96.0, 92.0, 90.0), hash(int(floor(b.z * 1e4)), 3, 4));
      c = mix(c, st, min(1.0, dome * 4.0) * 0.85);
      if (dome < 0.12) c = mix(c, vec3(40.0, 34.0, 30.0), (0.12 - dome) * 5.0);
    }
    float cl = cell(p * 0.07, 14);
    if (cl < 0.22) c = mix(c, ${v3(P.pebble)}, (0.22 - cl) * 3.2);
    float crack = cell(vec2(p.x * 0.018 + warp, p.y * 0.03), 15);
    if (crack > 0.62 && crack < 0.65) c = mix(c, c * 0.7, 0.35);
    float soilDepth = 26.0 + warp * 16.0;
    if (${!P.noTop} && up > 0.25 && d < soilDepth) {
      float st = min(1.0, (soilDepth - d) / 8.0) * min(1.0, (up - 0.25) * 3.0);
      c = mix(c, mix(${v3(P.soil[0])}, ${v3(P.soil[1])}, grain), st);
    }
    float grassDepth = 5.0 + fbm(vec2(p.x * 0.3, 0.0), 2, 16) * 7.0;
    if (${!P.noTop} && up > 0.35 && d < grassDepth) {
      float gt = min(1.0, (up - 0.35) * 4.0);
      c = mix(c, mix(${v3(P.grass[0])}, ${v3(P.grass[1])}, fbm(p * 0.1, 2, 17)), gt);
    }
    if (sc > 0.0) {
      float t = min(1.0, sc * 2.2) * (0.75 + fbm(p * 0.1, 3, 18) * 0.35);
      c = mix(c, ${v3(P.scorch)}, min(1.0, t));
    }
    // T23.20: iron darkened; a core's rim and heart, marked for the lit terrain's glow (gl_FragCoord: world px).
    float a = 255.0;
    vec2 w = vec2(float(x) + 0.5, float(y) + 0.5);
    for (int k = 0; k < ${MAX_DISCS}; k++) {
      if (k >= nDiscs) break;
      vec4 dk = texelFetch(discs, ivec2(k, 0), 0);
      float dd = length(w - dk.xy);
      if (dd >= dk.z) continue;
      if (dk.w < 0.0) { c = mix(c, ${v3(IRON_RGB)}, ${IRON_TINT_ALPHA}); continue; }
      if (dd < dk.z * ${CORE_HEART_FRAC}) {
        c = mix(${v3(HEART_RGB)}, ${v3(RIM_RGB)}, coreHits > 0.0 ? clamp(dk.w / coreHits, 0.0, 1.0) * ${CORE_DIM_TOWARD_RIM} : 0.0);
        a = ${CORE_HEART_A}.0;
      } else {
        c = ${v3(RIM_RGB)};
        a = ${CORE_RIM_A}.0;
      }
    }
    outColor = vec4(c / 255.0, a / 255.0);
    return;
  }
  vec4 o = vec4(0.0);
  if (f.b > 0) { // any wall px, soft wall's fade included (R24): its colour is the wall's, its coverage the shader's
    float g = fbm(p * 0.03, 4, 19);
    vec3 c = mix(${v3(P.back[0])}, ${v3(P.back[1])}, g);
    float cl = cell(p * 0.05, 20); if (cl < 0.2) c = mix(c, c * 1.3, 0.5);
    if (sc > 0.0) c = mix(c, ${v3(P.scorch)}, min(1.0, sc * 0.9));
    o = vec4(c / 255.0, 128.0 / 255.0);
  }
  // Grass fringe: a blade grows up from the first rock below, if that rock is a top surface not burnt.
  // T23.06B F8: skipped where the nearest rock is farther than a blade — dOut (G, ×4 truncated) > 19
  // px means no rock within 19 straight down, so the loop could only fall through: the output is
  // unchanged and open sky costs one texel read instead of nineteen.
  if (${!P.noFringe} && f.g <= ${4 * MAX_BLADE}) for (int k = 1; k <= ${MAX_BLADE}; k++) {
    int ys = y + k;
    if (ys >= H) break;
    if (!solidAt(x, ys)) continue;
    if (scorchAt(x, ys) > 0.0) break;
    int xo = x + offset.x;
    float r = hash(xo, 7, 99), clump = fbm(vec2(float(xo) * 0.08, float(ys + offset.y) * 0.02), 2, 98);
    int hb = int(floor((2.0 + 11.0 * r * r * r) * (0.5 + clump)));
    if (k <= hb) {
      float t = float(k) / float(hb + 1);
      vec3 c = mix(${v3(P.grass[0])}, ${v3(P.grass[1])} * vec3(1.25, 1.2, 1.1), t) * 0.9;
      o = vec4(min(c, 255.0) / 255.0, 200.0 / 255.0);
    }
    break;
  }
  outColor = o;
}
`
/** The ground's albedo pass (`TERRAIN_PALETTE`). */
export const ALBEDO_FS = albedoFs(TERRAIN_PALETTE)

/** Scorch: `1 − r / R` inside the blast's circle, drawn over its bounding box with MAX blending. */
export const SCORCH_VS = /* glsl */ `
in vec3 position;
uniform vec4 rect;
uniform vec2 size;
void main() { vec2 px = mix(rect.xy, rect.zw, position.xy * 0.5 + 0.5); gl_Position = vec4(px / size * 2.0 - 1.0, 0.0, 1.0); }
`
export const SCORCH_FS = /* glsl */ `
precision highp float;
uniform vec3 blast;
out vec4 outColor;
void main() {
  float r = length(floor(gl_FragCoord.xy) - blast.xy);
  outColor = vec4(r < blast.z ? 1.0 - r / blast.z : 0.0, 0.0, 0.0, 1.0);
}
`

/** 10k hash words, 100×100: px `(i % 100, i / 100)` holds `hashU(probeInput(i))` as 4 bytes, low first. */
export const HASH_PROBE_N = 100
export const HASH_PROBE_FS = /* glsl */ `
precision highp float; precision highp int;
out vec4 outColor;
${NOISE_GLSL}
void main() {
  int i = int(gl_FragCoord.y) * ${HASH_PROBE_N} + int(gl_FragCoord.x);
  uint h = hashU((i * 7919) % 40009 - 20000, (i * 104729) % 30011 - 15000, i % 211);
  outColor = vec4(float(h & 255u), float((h >> 8u) & 255u), float((h >> 16u) & 255u), float(h >> 24u)) / 255.0;
}
`
