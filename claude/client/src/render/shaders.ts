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
 * Value-noise fbm, shared by every effect that wants drifting volume.
 *
 * One copy, for the reason `noise-math.ts` is one copy on the CPU side: two
 * noise functions drift apart and then two effects that should feel like the
 * same weather do not.
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

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}
`

/**
 * Heavy fog (§F9), as drifting volume rather than a flat wash.
 *
 * `alpha` is the **same number the flat veil uses** — `fogVeilAlpha`, which the
 * flashlight already thins. The shader changes how that strength is painted and
 * nothing about what it means, so what a player can *see* is identical either
 * way. That is the rule this whole effort runs on: the simulation stays, the
 * drawing changes.
 *
 * Two noise fields at different scales drifting at different speeds, because one
 * field moving in one direction reads as a texture being slid across the screen
 * rather than as air.
 */
export const FOG_FRAGMENT = /* glsl */ `
precision mediump float;

uniform vec2 resolution;
uniform float time;
uniform float alpha;
uniform vec3 tint;

${FBM}

// Noise units per second. The field spans ~3.2 units across the view, so this
// drifts a screen-width in roughly fifteen seconds — weather, not a conveyor.
const float DRIFT = 0.25;

// How far density swings either side of the mean. Higher reads as torn cloud,
// lower as the flat wash this replaces.
//
// Heavy fog sits at alpha 0.8, so there is only 1.25x of headroom before a patch
// is fully opaque and the terrain behind it stops showing through at all. Thick
// patches therefore clip, and **all the visible structure comes from the thin
// side** — at 0.55 the fog measured *less* varied than the flat veil it
// replaced, because clipping hid more terrain than the noise revealed.
const float CONTRAST = 1.0;

// The pivot the density swings around: subtracted from the noise so the result is
// centred on 1.0 rather than offset.
//
// **Calibrated against the screen, not derived.** Five octaves of value noise
// average 0.484 on paper, and using that painted a mean alpha of 0.90 where the
// flat veil paints 0.80 — because the thick tail clips at full opacity and the
// two noise fields are not independent. The number that matters is the one the
// player sees, so this is set from the measured mean brightness of the fogged
// field and the fog-shader browser check asserts the result.
const float DENSITY_PIVOT = 0.59;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;

  // Wider than tall: fog banks are horizontal, and square cells read as a grid.
  vec2 p = uv * vec2(3.2, 2.1);
  float t = time * DRIFT;

  // Two fields, different scales, different directions. One field moving one way
  // reads as a texture being slid across the screen rather than as air.
  float a1 = fbm(p + vec2(t, t * 0.22));
  float a2 = fbm(p * 1.9 - vec2(t * 0.63, t * 0.11));
  float d = clamp(mix(a1, a2, 0.45), 0.0, 1.0);

  // **Centred on 1.0, not scaled up from 0.**
  //
  // Heavy fog is concealment before it is decoration (§F9) — it is what stops a
  // player being seen. So the shader must average out to the *same* thickness as
  // the flat veil it replaces, or High Quality would hand whoever enables it a
  // clearer view of the battlefield and become a competitive advantage rather
  // than a visual preference. The variation is redistribution: thicker here,
  // thinner there, the same on average.
  float density = 1.0 + CONTRAST * (d - DENSITY_PIVOT);

  // Fog pools low. Also mean-preserving, for the reason above — 1.12 and 0.88
  // average to 1.0 across the screen. uv.y is 0 at the bottom in GL.
  density *= mix(1.12, 0.88, uv.y);

  float a = clamp(alpha * density, 0.0, 1.0);

  // Premultiplied: Phaser blends with a premultiplied-alpha pipeline, and
  // straight colour here comes out washed and too bright.
  gl_FragColor = vec4(tint * a, a);
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
