/**
 * Shader support (T21.17). **The first shaders in this project.**
 *
 * ## Why a `Shader` game object and not a post-processing pipeline
 *
 * Phaser offers both. A post-FX pipeline runs over something already drawn,
 * which is right for distorting the scene; a `Shader` is a quad that draws
 * itself, which is right for something laid *over* the scene — which is what the
 * fog veil is. It also needs no camera-pipeline surgery, so the first shader
 * here does not rewrite how the game renders.
 *
 * ## Why the source is inline
 *
 * `client/vite.config.ts` has no `glsl` handling (checked). Inline template
 * literals sidestep the question entirely; a loader can be added deliberately
 * later if these grow past readability, rather than as an unexamined dependency
 * on day one.
 *
 * **The cost of that choice: no backticks in GLSL, comments included.** One in a
 * comment — ``the mean of `fbm` here`` — closes the template literal, and what
 * TypeScript then reports is a syntax error twenty lines further on. The page
 * does not boot and the browser check times out waiting for `window.__game`,
 * which looks nothing like the cause.
 *
 * ## The rule
 *
 * **Shaders need WebGL, and the game runs `Phaser.AUTO`** — it falls back to a
 * canvas renderer where WebGL is missing. So every shader here is *additional*:
 * the thing it replaces stays, and `hasWebGL` decides which is used. That is
 * also why T21.16's High Quality toggle defaults to off.
 */

import Phaser from 'phaser'

/**
 * Can this machine run shaders at all?
 *
 * Asked of the renderer rather than assumed from the config: `Phaser.AUTO` means
 * the answer is decided at boot by what the browser actually gave us, and a
 * machine that fell back to canvas must not be handed a shader that silently
 * draws nothing.
 */
export function hasWebGL(scene: Phaser.Scene): boolean {
  return scene.game.renderer.type === Phaser.WEBGL
}

/**
 * Value noise and fbm, shared by every effect that wants drifting volume.
 *
 * One copy, for the reason `noise-math.ts` is one copy on the CPU side: two
 * noise functions drift apart and then two effects that should feel like the
 * same weather do not.
 *
 * **Two octave counts, because the cost is per pixel and it adds up fast.**
 * `fbm5` is the detailed one; `fbm3` is for fields whose detail cannot be seen
 * anyway — inside the wind, or a deliberately soft field. Heavy fog runs to 22
 * noise samples for every pixel on the screen even after sharing one wind field
 * between its three banks; spending five octaves on all of them would be paying
 * for detail that nothing resolves.
 */
const FBM = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float fbm3(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.02; a *= 0.5; }
  return v;
}

float fbm5(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.02; a *= 0.5; }
  return v;
}
`

/**
 * Heavy fog (§F9), as living volume rather than a flat wash.
 *
 * ## What carries the look, and what it is allowed to cost
 *
 * **Thickness and shade are separate fields, and only one of them is expensive
 * in fairness terms.** How opaque a patch is decides what a player can see
 * through it, so the thickness has to average out to exactly the flat veil it
 * replaces — otherwise turning High Quality on would let you see further, and a
 * graphics setting would become a competitive advantage. How *grey* a patch is
 * costs nothing by that measure. So the drama lives in the shade and the motion,
 * which are free, and the thickness stays honest.
 *
 * ## Why a domain warp
 *
 * Three noise layers at three speeds still read as three sheets of glass sliding
 * past one another. Displacing the sample point by another noise field makes the
 * fog *curl*, and that is the whole difference between moving and alive.
 *
 * `alpha` is the **same number the flat veil uses** — `fogVeilAlpha`, which the
 * flashlight already thins. The shader changes how that strength is painted and
 * nothing about what it means.
 */
export const FOG_FRAGMENT = /* glsl */ `
precision mediump float;

uniform vec2 resolution;
uniform float time;
uniform float alpha;
uniform vec3 tint;

${FBM}

// Noise units per second for the slowest bank. The others are multiples of it,
// so the whole field keeps one sense of wind while nothing moves in lockstep.
const float DRIFT = 0.5;

// How far the domain warp drags the field sideways: fog that curls rather than
// fog that slides. See the note above.
const float WARP = 0.55;

// How far thickness swings either side of the mean.
//
// **Deliberately small, and the shade carries the look instead.** Heavy fog sits
// at alpha 0.8, so a wide thickness swing clips its thick patches at fully
// opaque — and a patch that shows no ground at all destroys contrast rather than
// varying it. At 1.0 the shader let 3% of the ground's contrast through where
// the flat veil lets 20%, which is a different game, not a different look.
const float CONTRAST = 0.45;

// The pivot thickness swings around, so the result is centred on 1.0.
//
// Near the mean of the banks' weighted sum. It mattered more when CONTRAST was
// wide and the tail clipped; with a narrow swing the density stays close to 1.0
// on its own. The fog-shader browser check asserts the result rather than
// trusting this number — it measures what fraction of the ground's contrast
// survives, which is concealment itself.
const float DENSITY_PIVOT = 0.50;

// How far the grey shifts between the pale banks and the dark ones. A multiplier
// centred on 1.0, so the *average* shade is still the colour the constant names
// and only the spread is new.
//
// **This is where the drama is allowed to live.** How grey a patch is does not
// change what a player can see through it, so unlike CONTRAST above this can be
// pushed as far as it looks good. It is the free half.
const float SHADE = 0.42;

/**
 * The wind: a slow displacement field, sampled once and shared.
 *
 * **One field for every bank, not one each.** Two independent warps cost six
 * more noise samples per pixel — a fifth of the shader — and buy less than they
 * look like they should, because two banks curling to different winds read as
 * two effects rather than as weather. Sharing it also means the layers agree
 * about which way the air is moving, which is what a real sky does.
 */
vec2 wind(vec2 p, float t) {
  float wx = fbm3(p + vec2(t * 0.21, 0.0));
  float wy = fbm3(p + vec2(5.2, 1.3) - vec2(0.0, t * 0.17));
  return (vec2(wx, wy) - 0.5) * WARP;
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;

  // Wider than tall: fog banks are horizontal, and square cells read as a grid.
  vec2 p = uv * vec2(3.2, 2.1);
  float t = time * DRIFT;

  // --- three banks, none of them in step ----------------------------------
  // The far bank is large and slow, the near one small and quick. That contrast
  // is what gives the field depth instead of one texture crossing the screen.
  vec2 w = wind(p * 1.1, t * 0.8);
  // The same wind bends the near bank harder than the far one, which is what
  // separates them in depth without a second field.
  float far = fbm5(p * 0.7 + w * 0.7 + vec2(t * 0.10, t * 0.025));
  float mid = fbm5(p * 1.6 + w * 1.5 - vec2(t * 0.22, t * 0.06));
  float near = fbm3(p * 3.4 + w * 2.2 + vec2(-t * 0.38, t * 0.10));

  float d = clamp(far * 0.45 + mid * 0.35 + near * 0.20, 0.0, 1.0);

  // --- thickness: the half that must stay honest ---------------------------
  float density = 1.0 + CONTRAST * (d - DENSITY_PIVOT);

  // Fog pools low. Mean-preserving for the same reason — 1.12 and 0.88 average
  // to 1.0 across the screen. uv.y is 0 at the bottom in GL.
  density *= mix(1.12, 0.88, uv.y);

  float a = clamp(alpha * density, 0.0, 1.0);

  // --- shade: the half that is free ----------------------------------------
  // A fourth field, slower and at its own scale, decides how pale the fog is
  // rather than how thick. Kept independent on purpose: if shade tracked
  // thickness, every pale patch would also be a thin one and the fog would read
  // as one property drawn twice.
  float s = fbm3(p * 1.3 + vec2(t * 0.06, -t * 0.04));
  // Pivoted at 0.55 rather than 0.5, so the field leans to its darker greys.
  // Fog reads as weather when it is grey and as glare when it is white, and the
  // pale banks are the ones that clip — without the lean they take over.
  float shade = 1.0 + SHADE * (smoothstep(0.25, 0.75, s) - 0.55) * 2.0;

  // A little cool in the pale banks and warm in the dark ones, which is what
  // stops grey-on-grey reading as television static. The two average to about
  // 1.0, so the mean colour is still the constant's.
  // Kept gentle. Strong enough to stop grey-on-grey reading as television
  // static, weak enough that the fog is still grey rather than blue.
  vec3 temper = mix(vec3(1.05, 1.00, 0.96), vec3(0.96, 1.00, 1.06),
                    smoothstep(0.3, 0.7, s));

  vec3 col = tint * shade * temper;

  // Premultiplied: Phaser blends with a premultiplied-alpha pipeline, and
  // straight colour here comes out washed and too bright.
  gl_FragColor = vec4(col * a, a);
}
`

/**
 * `0xRRGGBB` to the value a Phaser `3f` uniform wants.
 *
 * **`{x, y, z}`, not `[r, g, b]`** — Phaser's `syncUniforms` reads a length-3
 * uniform as `value.x, value.y, value.z`, so an array binds three `undefined`s,
 * WebGL takes them as zero, and the effect renders **black** with no error
 * anywhere. That shipped here for one run: the fog came out at brightness 17.9
 * against the flat veil's 148.5. The return type is written out for that reason
 * — a tuple compiles just as happily and is just as wrong.
 */
export function rgbToUniform3f(hex: number): { x: number; y: number; z: number } {
  return {
    x: ((hex >> 16) & 0xff) / 255,
    y: ((hex >> 8) & 0xff) / 255,
    z: (hex & 0xff) / 255,
  }
}
