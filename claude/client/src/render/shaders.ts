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
 * Clouds (T21.18 item 1), as a drifting volume instead of twelve sprites.
 *
 * ## Why the sprites went away entirely
 *
 * The coordinator did not like them: *"i dont really like the current clouds so
 * disable them and make them shaders too if High Quality is enabled."* So with
 * High Quality **off** the sky now has no clouds at all — that is a deliberate
 * visible change, not a fallback — and with it on this paints them.
 *
 * ## The shape
 *
 * Two decks, one wind, coverage thresholded out of fbm. `FOG_FRAGMENT`'s
 * reasoning for each of those holds here and is not repeated; what differs:
 *
 * - **Coverage is a threshold, not a wash.** Fog fills the screen and varies its
 *   thickness; a cloud has an *edge*, and sky between it and the next one.
 *   `smoothstep(COVER, COVER + SOFT, n)` is that edge, and `SOFT` is how wispy
 *   it is.
 * - **Lighting comes from the field's own gradient.** A cloud is bright where
 *   its body is thicker than the air just above it, which is one extra sample
 *   rather than a second noise field, and it gives the deck a top and a base.
 * - **Nothing here reads `time`.** Every moving quantity is passed in, derived
 *   from the same `elapsed` the sprite clouds drifted on — so `setClock` freezes
 *   the clouds completely, which is what lets a check tell "this patch changed
 *   because the clouds moved" from "this patch changes anyway".
 *
 * ## The quad is a band, not the screen
 *
 * Clouds live in `CLOUD_BAND_TOP..CLOUD_BAND_BOTTOM`, so the quad covers only
 * that. **That makes `gl_FragCoord` the wrong coordinate** — it is measured from
 * the corner of the canvas, so a quad that is not at the origin would sample the
 * field from the wrong place. `fragCoord` is Phaser's own varying and is local
 * to the quad. Its y runs **0 at the bottom, 1 at the top**, which only matters
 * to anything that is not symmetric about the band's middle.
 */
export const CLOUD_FRAGMENT = /* glsl */ `
precision mediump float;

uniform vec2 resolution;
// The phase's cloud opacity - cloudTint's own alpha, unchanged.
uniform float alpha;
// The phase's cloud colour - cloudTint's own colour, unchanged.
uniform vec3 tint;
// Drift and camera parallax, in band widths. One number, so one thing moves.
uniform float offset;
// Slow reshaping, in seconds. Clouds that only slide read as wallpaper.
uniform float evolve;
// The map seed, folded into noise space: one seed, one sky.
uniform float seed;

varying vec2 fragCoord;

${FBM}

// Noise cells across the band and down it. Wider than tall, because clouds are.
const float SCALE_X = 2.9;
const float SCALE_Y = 1.7;

// How far the shared wind drags the field. Smaller than the fog's: fog curls,
// a cloud deck mostly slides and only frays at its edges.
const float WARP = 0.38;

// Where the field stops being sky and starts being cloud, and how soft that
// edge is. COVER is the one number that decides how much sky is covered; SOFT
// is the difference between a cut-out and a wisp.
const float COVER = 0.545;
const float SOFT = 0.15;

// The near deck: smaller cells, faster, and never as solid as the far one —
// otherwise the two read as one busy texture rather than as depth.
const float NEAR_SCALE = 2.1;
const float NEAR_SPEED = 1.55;
const float NEAR_WEIGHT = 0.6;

// How far above itself the field is sampled to decide what is lit. In band
// heights, so it does not change with the deck's scale.
const float LIFT = 0.06;

// How dark a cloud's underside goes and how bright its top goes, as multiples of
// the phase's colour.
//
// **Both are allowed to be strong here, and that is the difference from
// FOG_FRAGMENT.** Fog has to keep its mean honest because how opaque it is
// decides what a player can see through it; a cloud sits in the sky behind the
// world and conceals nothing, so the whole of it is the free half. At a flat
// 1.0 the deck read as pale haze rather than as cloud — the tint is already
// white mixed 55 % toward the sky, so without modelling there is barely any
// contrast left against the sky it came from.
const float SHADE_FLOOR = 0.50;
const float TOP_GAIN = 1.55;

// How much of the band's height is spent fading in at each edge. The quad has
// corners and a sky must not, so a cloud that reaches the top or the bottom of
// the band is faded out rather than cut off.
const float EDGE_FADE = 0.26;

// The wind, sampled once and shared by both decks - see FOG_FRAGMENT.
vec2 wind(vec2 p) {
  float wx = fbm3(p + vec2(evolve * 0.19, 0.0));
  float wy = fbm3(p + vec2(5.2, 1.3) - vec2(0.0, evolve * 0.14));
  return (vec2(wx, wy) - 0.5) * WARP;
}

void main() {
  vec2 uv = fragCoord / resolution.xy;

  vec2 w = wind(vec2(uv.x * SCALE_X, uv.y * SCALE_Y) * 0.8);

  // --- the far deck: large, slow, and the one that carries the silhouette ---
  vec2 qf = vec2((uv.x + offset) * SCALE_X + seed, uv.y * SCALE_Y) + w * 0.8;
  float nf = fbm5(qf);
  float af = fbm5(qf + vec2(0.0, LIFT * SCALE_Y));
  float covF = smoothstep(COVER, COVER + SOFT, nf);
  float litF = smoothstep(-0.04, 0.07, nf - af);

  // --- the near deck: small, quick, and thin ------------------------------
  vec2 qn = vec2((uv.x + offset * NEAR_SPEED) * SCALE_X * NEAR_SCALE + seed * 1.7 + 11.3,
                 uv.y * SCALE_Y * NEAR_SCALE + 4.1) + w * 1.6;
  float nn = fbm3(qn);
  float an = fbm3(qn + vec2(0.0, LIFT * SCALE_Y * NEAR_SCALE));
  float covN = smoothstep(COVER, COVER + SOFT, nn) * NEAR_WEIGHT;
  float litN = smoothstep(-0.04, 0.07, nn - an);

  float cov = max(covF, covN);
  float lit = mix(litF, litN, covN);

  float fade = smoothstep(0.0, EDGE_FADE, uv.y) * smoothstep(0.0, EDGE_FADE, 1.0 - uv.y);

  float a = clamp(alpha * cov * fade, 0.0, 1.0);
  vec3 col = clamp(tint * mix(SHADE_FLOOR, TOP_GAIN, lit), 0.0, 1.0);

  // Premultiplied, for the reason FOG_FRAGMENT is.
  gl_FragColor = vec4(col * a, a);
}
`

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
