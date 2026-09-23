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

/**
 * T21.18 item 3 — a laser beam, painted rather than stroked.
 *
 * Lasers are hitscan (`Delivery::Hitscan`): there is no projectile to hide, only the
 * fading line `OrdnanceLayer` strokes in three passes. Under High Quality this quad
 * replaces those strokes — a white-hot core, a warm halo that falls off softly
 * across the beam, and a ripple running along it — and nothing else: the tracer
 * record, its lifetime and the light it casts are the same objects either way.
 *
 * The quad is one beam: x runs along it (0 at the muzzle end, 1 at the impact), y
 * across it. `life` is the flat path's own fade factor, so a beam dies on the same
 * curve in both modes; `span` is the quad's length over its width, so the ripple is
 * spaced in beam-widths however long the shot was.
 */
export const BEAM_FRAGMENT = /* glsl */ `
precision mediump float;

uniform vec2 resolution;
// 0..1, the beam's remaining life - the flat path's fade, unchanged.
uniform float life;
// Seconds of game time, for the ripple - Phaser's own uniform, set at every render.
uniform float time;
// Length over width.
uniform float span;

varying vec2 fragCoord;

${FBM}

// How tight the white core is across the quad, and how far the warm halo spreads.
const float CORE = 9.0;
const float HALO = 3.2;
// Ripple spacing in beam widths, and how fast it runs toward the target.
const float RIPPLE = 0.35;
const float SPEED = 7.0;

void main() {
  vec2 uv = fragCoord / resolution.xy;
  float y = uv.y - 0.5;
  float core = exp(-pow(y * CORE, 2.0));
  float halo = exp(-pow(y * HALO, 2.0));
  float along = uv.x * span;
  float shimmer = 0.72 + 0.28 * vnoise(vec2(along / RIPPLE - time * SPEED, time * 3.0));
  // Round the ends off rather than cutting the quad square.
  float ends = smoothstep(0.0, 0.015, uv.x) * smoothstep(1.0, 0.985, uv.x);
  vec3 warm = vec3(1.0, 0.60, 0.24);
  vec3 hot = vec3(1.0, 0.93, 0.65);
  vec3 col = warm * halo * 0.55 * shimmer + mix(hot, vec3(1.0), core) * core;
  float a = clamp((halo * 0.45 * shimmer + core) * life * ends, 0.0, 1.0);
  // Premultiplied, for the reason FOG_FRAGMENT is: a Phaser Shader has no blend
  // mode of its own, and the pipeline expects premultiplied alpha.
  gl_FragColor = vec4(col * a, a);
}
`

/**
 * T21.18 item 2 — a smoke cloud, billowing rather than three flat lobes.
 *
 * **Drawing only.** Smoke blocks vision, and that is the server's: a player inside
 * `SMOKE_RADIUS` gets `FOV_SMOKE_MULT` in their snapshot however the cloud is painted.
 * This quad replaces `OrdnanceFxLayer`'s three offset circles and nothing else — the
 * hazard record, its fade and its removal are the same either way.
 *
 * The quad is one cloud, `2 * scale` cloud radii across, centred on it. The body is a
 * soft disc whose edge is eaten by domain-warped fbm, slowly turning (the curl), and
 * it swells and thins as `life` runs out, which is the cloud dispersing. `life` is the
 * flat path's own fade factor, so both die on the same curve.
 */
export const SMOKE_FRAGMENT = /* glsl */ `
precision mediump float;

uniform vec2 resolution;
// Seconds - Phaser's own uniform, set at every render.
uniform float time;
// 0..1, the cloud's remaining life - the flat path's fade, unchanged.
uniform float life;
// Per cloud, so two clouds side by side do not billow in step.
uniform float seed;
// Quad half-width in cloud radii - SMOKE_SHADER_SCALE.
uniform float scale;
// The flat path's smoke grey.
uniform vec3 tint;

varying vec2 fragCoord;

${FBM}

// Radians per second the cloud turns: slow enough to read as curl, not spin.
const float CURL = 0.18;
// Noise cells across one cloud radius.
const float BILLOW = 1.7;
// How deep the noise eats into the edge, in cloud radii.
const float EAT = 0.42;
// How much wider a dying cloud is than a fresh one.
const float SPREAD = 0.22;
// Peak opacity: three flat lobes at 0.34 overlap to about 0.7 at the centre.
const float DENSITY = 0.82;

void main() {
  vec2 uv = fragCoord / resolution.xy;
  vec2 p = (uv - 0.5) * 2.0 * scale;
  float ang = time * CURL + seed;
  float c = cos(ang);
  float s = sin(ang);
  vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  vec2 w = vec2(fbm3(q * 1.3 + vec2(seed, time * 0.15)),
                fbm3(q * 1.3 + vec2(time * 0.12, seed * 1.7))) - 0.5;
  float n = fbm5(q * BILLOW + w * 1.6 + vec2(seed * 3.1, -time * 0.1));
  float spread = 1.0 + SPREAD * (1.0 - life);
  float d = length(p) / spread + (n - 0.5) * EAT * 2.0;
  float body = 1.0 - smoothstep(0.45, 1.0, d);
  float a = clamp(body * (0.55 + 0.7 * n) * DENSITY, 0.0, 1.0) * life;
  // Lit from above, darker in the thick of it, so it reads as volume.
  float shade = 0.72 + 0.4 * n + 0.12 * uv.y;
  vec3 col = tint * shade;
  // Premultiplied, for the reason FOG_FRAGMENT is.
  gl_FragColor = vec4(col * a, a);
}
`

/**
 * T21.18 item 4 — a flame, painted rather than three flat circles.
 *
 * **The flame is the damage area.** A flame hurts anyone within `FLAME_RADIUS` of its
 * centre, so the body here is solid out to COVER damage radii however the flicker
 * moves it: the ragged edge lives outside that ring, never inside it. A player must not
 * be burned by fire they cannot see.
 *
 * The quad is taller than wide. The flame centre sits `base` of the way up it, a tongue
 * licks upward from there, and above the tongue a faint wavering column stands in for
 * heat haze. **It is not a true distortion**: that needs the scene behind it sampled
 * into a texture, which a Shader object laid over the scene does not have.
 *
 * x and y below are in damage radii from the flame centre; fragCoord y is 0 at the
 * bottom of the quad. `aspect` is a uniform, not `resolution.y / resolution.x`:
 * resolution is the quad's base size, and setDisplaySize does not change it.
 */
export const FLAME_FRAGMENT = /* glsl */ `
precision mediump float;

uniform vec2 resolution;
// Seconds - Phaser's own uniform, set at every render.
uniform float time;
// Per flame, so a crowd does not flicker in step.
uniform float seed;
// Quad half-width in damage radii - FLAME_SHADER_SCALE.
uniform float scale;
// Quad height over width - FLAME_SHADER_ASPECT.
uniform float aspect;
// Where the flame centre sits up the quad - FLAME_SHADER_BASE.
uniform float base;

varying vec2 fragCoord;

${FBM}

// Solid out to this many damage radii, whatever the flicker does.
const float COVER = 1.1;
// How far past COVER the ragged edge may reach.
const float RAG = 0.45;
// How fast the flicker climbs, noise cells per second.
const float CLIMB = 2.6;

void main() {
  vec2 uv = fragCoord / resolution.xy;
  float x = (uv.x - 0.5) * 2.0 * scale;
  float y = (uv.y - base) * 2.0 * scale * aspect;
  float t = time + seed * 7.0;
  float n = fbm3(vec2(x * 1.4 + seed, y * 1.1 - t * CLIMB));
  // The body: a disc, and above the centre a tongue that narrows as it climbs.
  float up = max(y, 0.0);
  float d = length(vec2(x * (1.0 + up * 0.55), min(y, 0.0) + up * 0.42));
  float edge = COVER + RAG * n * (0.4 + up * 0.6);
  float body = 1.0 - smoothstep(COVER, edge + 0.001, d);
  // Heat haze: a faint wavering column over the tongue.
  float hazeY = y - 1.6;
  float haze = (1.0 - smoothstep(0.0, 2.2, abs(hazeY))) * (1.0 - smoothstep(0.3, 1.0, abs(x) / scale));
  haze *= 0.10 + 0.10 * fbm3(vec2(x * 3.0 + seed, y * 2.0 - t * 3.5));
  // Yellow heart, orange body, dark red rim.
  vec3 heart = vec3(1.0, 0.86, 0.32);
  vec3 flame = vec3(1.0, 0.50, 0.14);
  vec3 rim = vec3(0.72, 0.18, 0.04);
  float k = clamp(d / edge, 0.0, 1.0);
  vec3 col = mix(heart, flame, smoothstep(0.15, 0.55, k + 0.2 * (n - 0.5)));
  col = mix(col, rim, smoothstep(0.7, 1.0, k));
  float a = body * 0.95;
  // Premultiplied, for the reason FOG_FRAGMENT is: the flame, then the haze behind it.
  vec3 outc = col * a + vec3(1.0, 0.92, 0.8) * haze * (1.0 - a);
  float outa = a + haze * (1.0 - a);
  gl_FragColor = vec4(outc, outa);
}
`

/**
 * T21.18 item 5 — an explosion: a flash, a blast front, and soot that lingers.
 *
 * **Drawing only.** The crater, the damage and the knockback are the server's, and
 * the light still comes from the flat path's impact record. This paints a `Blast`,
 * the same explosion kept for `BLAST_SHADER_LIFE` so the soot can outlast the flash.
 *
 * Coordinates are in blast radii from the centre. `age` is 0..1 of the blast's life:
 * the fireball is gone by a third of it, the front runs out past one blast radius
 * quickly and fades, and the soot rises behind it and thins to nothing at the end.
 * Phaser's `time` only stirs the noise, so a held blast still churns.
 */
export const BLAST_FRAGMENT = /* glsl */ `
precision mediump float;

uniform vec2 resolution;
// Seconds - Phaser's own uniform, set at every render.
uniform float time;
// 0..1 of the blast's painted life.
uniform float age;
uniform float seed;
// Quad half-width in blast radii - BLAST_SHADER_SCALE.
uniform float scale;

varying vec2 fragCoord;

${FBM}

// Where the front starts and where it ends, in blast radii.
const float FRONT_FROM = 0.3;
const float FRONT_TO = 1.35;
// How quickly the front runs out: most of the way by a fifth of the life.
const float RUSH = 9.0;
// The front's thickness, in blast radii.
const float BAND = 0.16;
// Soot is solid out to this many blast radii, noise or not.
const float SOOT_COVER = 1.05;

void main() {
  vec2 uv = fragCoord / resolution.xy;
  vec2 p = (uv - 0.5) * 2.0 * scale;
  float n = fbm3(p * 2.2 + vec2(seed, time * 0.9));
  float d = length(p) + (n - 0.5) * 0.28;
  float front = mix(FRONT_FROM, FRONT_TO, 1.0 - exp(-age * RUSH));
  // The front: a bright ring that fades as it runs out.
  float ring = exp(-pow((d - front) / BAND, 2.0)) * (1.0 - smoothstep(0.35, 0.8, age));
  // Everything inside the front burns early; the fireball is gone by a third of the life.
  float inside = (1.0 - smoothstep(front - 0.1, front + 0.05, d));
  // Out by 0.22 of the life, and the soot fully in by then: measured, a slower handover
  // left the fire and the soot equal at a quarter of the life, and orange plus soot over
  // rock averaged back to rock-brown (102,64,31 over 83,69,53 in explosion-shader).
  float fire = inside * (1.0 - smoothstep(0.05, 0.22, age));
  float flash = exp(-d * d * 4.0) * (1.0 - smoothstep(0.0, 0.18, age));
  // Soot: rises behind the front and lingers, eaten at its edge, gone by the end.
  // **Solid out to SOOT_COVER whatever the noise does**, FLAME_FRAGMENT's rule: the noise
  // may only rag the edge outward. And **dark and dense enough to read against rock**:
  // measured in explosion-shader, at a quarter of the life a point just inside the blast
  // radius came out 98,69,44 over rock at 94,80,64. Worked through, that is thin soot
  // (about 0.5) plus the fading orange averaging back to brown - painted, but in the
  // rock's own colour. A scorch has to look burnt.
  float sootBody = 1.0 - smoothstep(SOOT_COVER, SOOT_COVER + 0.4 * n + 0.001, length(p));
  float soot = sootBody * smoothstep(0.05, 0.22, age) * (1.0 - smoothstep(0.55, 1.0, age)) * (0.8 + 0.2 * n);
  vec3 hot = vec3(1.0, 0.95, 0.78);
  vec3 orange = vec3(1.0, 0.55, 0.16);
  vec3 dark = vec3(0.08, 0.065, 0.06);
  float glowA = clamp(flash + fire * (0.55 + 0.45 * n) + ring * 0.9, 0.0, 1.0);
  vec3 glow = mix(orange, hot, clamp(flash + ring * 0.4, 0.0, 1.0));
  float a = clamp(glowA + soot * (1.0 - glowA), 0.0, 1.0);
  vec3 col = glow * glowA + dark * soot * (1.0 - glowA);
  // Premultiplied, for the reason FOG_FRAGMENT is.
  gl_FragColor = vec4(col, a);
}
`

/**
 * T22.04 — the suit thruster's plume under High Quality: a burst of energy
 * streaming away from the body.
 *
 * **Drawing only**, and the flat path (`thrusterPlume.ts`) is the same event in
 * the same place at the same size: the quad is exactly the flat plume's box, so
 * the two render paths answer the same pixel assertion (`thrusters`) rather than
 * sharing code (the T21.36 lesson).
 *
 * The quad runs along +x: `uv.x` 0 is the nozzle at the body's edge and 1 is the
 * tip; the game object is rotated to the plume direction. A hot white-cyan core
 * narrows as it leaves the nozzle, inside a blue sheath that frays into noise
 * streaming outward — so it reads as *moving away from you*, which is the whole
 * cue for which way the push is.
 */
export const THRUST_FRAGMENT = /* glsl */ `
precision mediump float;

uniform vec2 resolution;
// Seconds - Phaser's own uniform, set at every render.
uniform float time;
// Per player, so two thrusting players do not flicker in step.
uniform float seed;

varying vec2 fragCoord;

${FBM}

// How fast the noise streams from the nozzle to the tip, quad lengths per second.
const float FLOW = 3.2;

void main() {
  vec2 uv = fragCoord / resolution.xy;
  float x = uv.x;
  float y = (uv.y - 0.5) * 2.0;
  float n = fbm3(vec2(x * 5.0 - time * FLOW * 5.0 + seed, y * 2.2 + seed * 1.3));
  // The sheath: widest at the nozzle, tapering to a ragged point.
  float hw = mix(1.0, 0.3, x) * (0.85 + 0.3 * n);
  float sheath = (1.0 - smoothstep(hw * 0.55, hw, abs(y))) * (1.0 - smoothstep(0.55, 1.0, x + 0.25 * (n - 0.5)));
  // The core: a hot thread that is gone by half way.
  float core = (1.0 - smoothstep(0.0, 0.32 * (1.0 - x), abs(y))) * (1.0 - smoothstep(0.1, 0.55, x));
  vec3 blue = vec3(0.24, 0.62, 1.0);
  vec3 hot = vec3(0.88, 0.98, 1.0);
  float a = clamp(sheath * 0.85 + core, 0.0, 1.0);
  vec3 col = mix(blue * (0.8 + 0.4 * n), hot, clamp(core * 1.2, 0.0, 1.0));
  // Premultiplied, for the reason FOG_FRAGMENT is.
  gl_FragColor = vec4(col * a, a);
}
`
