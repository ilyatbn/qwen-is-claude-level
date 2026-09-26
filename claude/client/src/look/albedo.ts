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
 * **One palette (R5):** `world.js::THEMES.dusk`, the theme F1 and F5 are derived with. `MapMeta.theme`
 * is not read for terrain colour.
 */

/** `world.js::THEMES.dusk` — the one terrain palette (R5), sRGB bytes. */
export const TERRAIN_PALETTE = {
  grass: [[52, 70, 58], [74, 92, 70]],
  soil: [[70, 52, 44], [56, 42, 36]],
  rock: [[112, 96, 88], [96, 84, 80], [124, 108, 96], [88, 78, 76]],
  pebble: [140, 126, 116],
  back: [[52, 46, 48], [40, 36, 40]],
  scorch: [20, 16, 16],
  boulders: 0.8,
} as const

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

const v3 = (c: readonly number[]): string => `vec3(${c.map((n) => n.toFixed(1)).join(', ')})`
const P = TERRAIN_PALETTE

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
 * The albedo pass. `gl_FragCoord` is the world px (row 0 = mask row 0 — the field texture is
 * uploaded that way up and the target is written the same way). Branch for branch `world.js::derive`.
 */
export const ALBEDO_FS = /* glsl */ `
precision highp float; precision highp int;
uniform sampler2D field;
uniform highp usampler2D din2;
uniform sampler2D scorch;
uniform ivec2 size;
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
  vec2 p = vec2(float(x), float(y));
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
    if (up > 0.25 && d < soilDepth) {
      float st = min(1.0, (soilDepth - d) / 8.0) * min(1.0, (up - 0.25) * 3.0);
      c = mix(c, mix(${v3(P.soil[0])}, ${v3(P.soil[1])}, grain), st);
    }
    float grassDepth = 5.0 + fbm(vec2(p.x * 0.3, 0.0), 2, 16) * 7.0;
    if (up > 0.35 && d < grassDepth) {
      float gt = min(1.0, (up - 0.35) * 4.0);
      c = mix(c, mix(${v3(P.grass[0])}, ${v3(P.grass[1])}, fbm(p * 0.1, 2, 17)), gt);
    }
    if (sc > 0.0) {
      float t = min(1.0, sc * 2.2) * (0.75 + fbm(p * 0.1, 3, 18) * 0.35);
      c = mix(c, ${v3(P.scorch)}, min(1.0, t));
    }
    outColor = vec4(c / 255.0, 1.0);
    return;
  }
  vec4 o = vec4(0.0);
  if (f.b > 127) {
    float g = fbm(p * 0.03, 4, 19);
    vec3 c = mix(${v3(P.back[0])}, ${v3(P.back[1])}, g);
    float cl = cell(p * 0.05, 20); if (cl < 0.2) c = mix(c, c * 1.3, 0.5);
    if (sc > 0.0) c = mix(c, ${v3(P.scorch)}, min(1.0, sc * 0.9));
    o = vec4(c / 255.0, 128.0 / 255.0);
  }
  // Grass fringe: a blade grows up from the first rock below, if that rock is a top surface not burnt.
  for (int k = 1; k <= ${MAX_BLADE}; k++) {
    int ys = y + k;
    if (ys >= H) break;
    if (!solidAt(x, ys)) continue;
    if (scorchAt(x, ys) > 0.0) break;
    float r = hash(x, 7, 99), clump = fbm(vec2(float(x) * 0.08, float(ys) * 0.02), 2, 98);
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
