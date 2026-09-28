/**
 * T23.08: the post chain — `mockup-src/kit.js::post`, pass for pass: a half-float target (4× MSAA at
 * the full tier) → `RenderPass` → `UnrealBloomPass(P.bloom)` → `OutputPass` (ACES at `P.exposure`, then
 * sRGB) → the grade (`P.grade`: saturation, the warm/cool split by luminance, vignette, grain), whose
 * fragment code is the mockup's verbatim, run at the end of the output pass (`gradedOutput`).
 *
 * **R14's low tier: half-resolution bloom.** The low tier draws the whole world canvas, and so this
 * chain, at half resolution (`worldRenderer-math.ts::TIER_SCALE`) — the mockup's own
 * `post(…, { scale: 2 })` — so the bloom's mip chain starts at 640×360: nothing extra to switch.
 *
 * `look.bloom[0] === 0` switches the bloom pass off (strength 0 adds nothing; skipping it saves its
 * ten blur draws), and `look.grade === null` the grade: the look-lab's `only=sky` / `only=terrain`
 * draw the T23.04–T23.07 chain their references were rendered with.
 */
import { HalfFloatType, RGBFormat, type Scene, type Camera, Vector2, Vector3, Vector4, type WebGLRenderer, WebGLRenderTarget } from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { FrameLook, Rgb } from './scene'
import { TIER_SAMPLES, type QualityTier } from './worldRenderer-math'
import { NOISE_GLSL } from './skyMaterial'

/** T23.10: the night view's circles, at most — the player's sight, then the brightest effect lights. */
export const NIGHT_CIRCLES = 8

/**
 * `kit.js::post`'s grade, verbatim, as the tail of three's `OutputShader` — one full-screen pass, not two.
 * The mockup runs it as a separate `ShaderPass` reading the output pass's half-float target; here it runs on
 * the same value before it is stored (the only difference is that half-float rounding, < 0.2 of an 8-bit
 * level). Measured on the checks' SwiftShader, 640×360: the separate pass cost 2.5 ms a drawn frame.
 * `W` = the pictures' 1280: the grain's hash cell is a 1280-wide frame's pixel.
 */
const GRADE_PARS =
  NOISE_GLSL +
  /* glsl */ `
  uniform float vig, sat, gradeOn; uniform vec3 warm, cool;
  uniform sampler2D tBloom; uniform float bloomOn;
  uniform float nightK, nightN; uniform vec3 nightFloor; uniform vec4 nightC[${NIGHT_CIRCLES}];
`
/**
 * T23.18B: the bloom's additive blend, folded into the output pass — `UnrealBloomPass` drew its composite over the
 * whole scene target in a pass of its own (three's `AdditiveBlending`: src · src alpha + dst, the composite's alpha
 * being strength × the mip weights); here the output pass reads the composite and adds `rgb · a` before tone mapping,
 * the same sum (bilinear read of the same texture at the same uv), in float instead of half float. Measured on the checks' SwiftShader (low tier, frozen sandbox): see `FoldedBloom`.
 */
const BLOOM_ADD = /* glsl */ `
  if (bloomOn > 0.5) { vec4 b = texture2D(tBloom, vUv); gl_FragColor.rgb += b.rgb * b.a; }
`
/**
 * T23.10 (R7): **the night view** — outside the circles you see (your field of view, `fovRadius`), the scene fades into
 * the night: its light scaled down by `nightK` toward the night palette's darkest colour (`nightFloor`), in linear HDR
 * before the tone map — so anything bright out there (a blast, a muzzle, a lit vent: the effect lights, T23.09) still
 * reads, and nothing is ever flat black. Circles in drawing-buffer px (`gl_FragCoord`): centre, then the radius the
 * fade starts at and the one it ends at. The seeing rule itself (a remote beyond your `fov` is not drawn) stays the
 * scenes'. Replaces the Phaser MULTIPLY lightmap (`render/lightmap.ts`, retired).
 */
const NIGHT_VIEW = /* glsl */ `
  if (nightK > 0.) { float vis = 0.;
    for (int i = 0; i < ${NIGHT_CIRCLES}; i++) { if (float(i) >= nightN) break; vec4 c = nightC[i];
      vis = max(vis, 1. - smoothstep(c.z, c.w, distance(gl_FragCoord.xy, c.xy))); }
    float f = 1. - nightK * (1. - vis); gl_FragColor.rgb = gl_FragColor.rgb * f + nightFloor * (1. - f); }
`
const GRADE_TAIL = /* glsl */ `
  if (gradeOn > 0.5) { vec3 c = gl_FragColor.rgb;
    float l = dot(c, vec3(.3,.59,.11)); c = mix(vec3(l), c, sat);
    c *= mix(cool, warm, smoothstep(0.2,0.8,l));
    vec2 q = vUv-0.5; c *= 1. - vig*dot(q,q)*1.6;
    c += (hash12(floor(vUv*1280.0)) - 0.5)*0.018;
    gl_FragColor = vec4(c,1.); }
`

/** three's `OutputPass` (ACES, sRGB) with the grade appended to its fragment shader. */
function gradedOutput(): OutputPass {
  const pass = new OutputPass()
  const m = pass.material
  const fs = m.fragmentShader
  const main = fs.indexOf('varying vec2 vUv;')
  const end = fs.lastIndexOf('}')
  if (main < 0 || end < 0) throw new Error('OutputShader changed shape: the grade has nowhere to go')
  const read = fs.indexOf('gl_FragColor = texture2D( tDiffuse, vUv );')
  if (read < 0) throw new Error('OutputShader changed shape: the bloom has nowhere to go')
  const afterRead = read + 'gl_FragColor = texture2D( tDiffuse, vUv );'.length
  m.fragmentShader = fs.slice(0, main) + GRADE_PARS + fs.slice(main, afterRead) + BLOOM_ADD + NIGHT_VIEW + fs.slice(afterRead, end) + GRADE_TAIL + fs.slice(end)
  Object.assign(pass.uniforms, {
    vig: { value: 0.35 },
    sat: { value: 1.08 },
    gradeOn: { value: 0 },
    tBloom: { value: null },
    bloomOn: { value: 0 },
    warm: { value: new Vector3(1.03, 1, 0.95) },
    cool: { value: new Vector3(0.94, 0.98, 1.06) },
    nightK: { value: 0 },
    nightN: { value: 0 },
    nightFloor: { value: new Vector3(0, 0, 0) },
    nightC: { value: Array.from({ length: NIGHT_CIRCLES }, () => new Vector4()) },
  })
  return pass
}

/** One frame's night view, in drawing-buffer px (origin bottom left, as `gl_FragCoord`). `k` 0: none. */
export interface NightUniforms {
  k: number
  floor: Rgb
  circles: readonly { x: number; y: number; inner: number; outer: number }[]
}

export function applyNight(p: Post, n: NightUniforms | null): void {
  const u = p.output.uniforms as Record<string, { value: unknown }>
  const k = n && n.k > 0 ? n.k : 0
  u['nightK']!.value = k
  if (!n || k === 0) return
  const cs = n.circles.slice(0, NIGHT_CIRCLES)
  u['nightN']!.value = cs.length
  ;(u['nightFloor']!.value as Vector3).set(...n.floor)
  const arr = u['nightC']!.value as Vector4[]
  cs.forEach((c, i) => arr[i]!.set(c.x, c.y, c.inner, c.outer))
}

/** three's `UnrealBloomPass.BlurDirectionX/Y` (its static fields are not in the type declarations). */
const BLUR_X = new Vector2(1, 0)
const BLUR_Y = new Vector2(0, 1)

/**
 * T23.18B, the low tier: the bright pass reads the whole 4 × 4 block of scene px under each of its texels (four
 * bilinear taps at ± one scene px), each through three's `LuminosityHighPassShader` threshold, averaged. With one tap
 * (three's shader) a bright point a few px across lit its texel only when the tap landed on it — so a muzzle flash
 * bloomed or did not by where it fell, and bloomed as the mips' square block (the task's "square halos").
 */
const BRIGHT4_FS = /* glsl */ `
uniform sampler2D tDiffuse; uniform vec2 srcTexel; uniform vec3 defaultColor; uniform float defaultOpacity;
uniform float luminosityThreshold; uniform float smoothWidth;
varying vec2 vUv;
vec4 bright(vec2 uv) {
  vec4 texel = texture2D(tDiffuse, uv);
  float v = dot(texel.xyz, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec4(defaultColor, defaultOpacity), texel, smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v));
}
void main() {
  gl_FragColor = 0.25 * (bright(vUv + srcTexel * vec2(-1., -1.)) + bright(vUv + srcTexel * vec2(1., -1.)) + bright(vUv + srcTexel * vec2(-1., 1.)) + bright(vUv + srcTexel * vec2(1., 1.)));
}`

/**
 * T23.18B: `UnrealBloomPass` as three draws it (its `render`, in its order), less three things SwiftShader pays for per
 * pass. Measured on the checks' SwiftShader, low tier, a frozen sandbox frame (`drawCost`, 5 × 20 draws each):
 * - **the final blend** — the composite drawn additively over the whole scene target in a pass of its own — is folded
 *   into the output pass (`BLOOM_ADD`: the same texture, the same uv, the same sum, in float instead of half float);
 * - **the clears** before each of its 12 full-target quads — the quads are opaque and cover every texel, so a clear
 *   changes nothing but costs a pass: 3.0 → 2.2 ms for the bloom;
 * - on the low tier, the one-tap bright pass (`BRIGHT4_FS`, above).
 * The render-to-screen branch is not kept: this chain never takes it.
 */
class FoldedBloom extends UnrealBloomPass {
  constructor(resolution: Vector2, strength: number, radius: number, threshold: number, low: boolean) {
    super(resolution, strength, radius, threshold)
    if (!low) return
    const m = this.materialHighPassFilter
    m.fragmentShader = BRIGHT4_FS
    m.uniforms['srcTexel'] = { value: new Vector2(1, 1) }
    m.needsUpdate = true
  }

  override render(renderer: WebGLRenderer, _write: WebGLRenderTarget, read: WebGLRenderTarget): void {
    const autoClear = renderer.autoClear
    renderer.autoClear = false
    const quad = this.fsQuad
    // 1. Extract bright areas.
    const hp = this.highPassUniforms as Record<string, { value: unknown }>
    hp['tDiffuse']!.value = read.texture
    hp['luminosityThreshold']!.value = this.threshold
    ;(this.materialHighPassFilter.uniforms['srcTexel']?.value as Vector2 | undefined)?.set(1 / read.width, 1 / read.height)
    quad.material = this.materialHighPassFilter
    renderer.setRenderTarget(this.renderTargetBright)
    quad.render(renderer)
    // 2. Blur the mips progressively.
    let input = this.renderTargetBright
    for (let i = 0; i < this.nMips; i++) {
      const blur = this.separableBlurMaterials[i]!
      quad.material = blur
      blur.uniforms['colorTexture']!.value = input.texture
      blur.uniforms['direction']!.value = BLUR_X
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]!)
      quad.render(renderer)
      blur.uniforms['colorTexture']!.value = this.renderTargetsHorizontal[i]!.texture
      blur.uniforms['direction']!.value = BLUR_Y
      renderer.setRenderTarget(this.renderTargetsVertical[i]!)
      quad.render(renderer)
      input = this.renderTargetsVertical[i]!
    }
    // 3. Composite the mips; the output pass adds it (no blend pass).
    quad.material = this.compositeMaterial
    this.compositeMaterial.uniforms['bloomStrength']!.value = this.strength
    this.compositeMaterial.uniforms['bloomRadius']!.value = this.radius
    this.compositeMaterial.uniforms['bloomTintColors']!.value = this.bloomTintColors
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]!)
    quad.render(renderer)
    renderer.autoClear = autoClear
  }
}

/** The passes a scene's look switches, and the dev switches `timePasses` flips. */
export type PassName = 'bloom' | 'grade'

export interface Post {
  readonly composer: EffectComposer
  readonly bloom: UnrealBloomPass
  /** The output pass, carrying the grade (`gradeOn`). */
  readonly output: OutputPass
}

/**
 * The chain for one tier (`TIER_SAMPLES` MSAA). On the low tier the scene target is R11F_G11F_B10F where the renderer
 * can draw into float targets (`EXT_color_buffer_float`) — the full tier (and a machine without it) keeps half float —
 * and the bright pass takes four taps (`BRIGHT4_FS`).
 * T23.18B, measured on the checks' SwiftShader (low tier, frozen sandbox, `drawCost`): every layer blends into this
 * target, and a half-float one cost 2.3 ms a frame more than an 8-bit one (13.5 → 11.2 ms) — 8 bits cannot hold the
 * HDR the bloom and tone map read (fire at 2–4); the packed float can (unsigned, 6/6/5-bit mantissas: steps of 1.6 % /
 * 3 % in linear light, under half an 8-bit level after the tone map at the night's levels), 13.5 → 11.9 ms.
 */
export function buildPost(renderer: WebGLRenderer, scene: Scene, camera: Camera, tier: QualityTier): Post {
  const samples = TIER_SAMPLES[tier]
  const low = tier === 'low'
  const rt = low && renderer.extensions.has('EXT_color_buffer_float')
    ? new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBFormat, internalFormat: 'R11F_G11F_B10F', samples, depthBuffer: false })
    : new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples, depthBuffer: false })
  const composer = new EffectComposer(renderer, rt)
  composer.addPass(new RenderPass(scene, camera))
  // The size is the composer's (`setSize` resizes every pass); the numbers are the look's (`applyPost`).
  const bloom = new FoldedBloom(new Vector2(1, 1), 0, 0, 1, low)
  // It writes no scene target: its result reaches the frame through the output pass.
  bloom.needsSwap = false
  composer.addPass(bloom)
  const output = gradedOutput()
  composer.addPass(output)
  return { composer, bloom, output }
}

/**
 * The scene's post numbers onto the passes — `kit.js::post`'s defaults where a `grade` field is left
 * out (`vignette 0.35`, `sat 1.08`, `warm [1.03, 1, 0.95]`, `cool [0.94, 0.98, 1.06]`). `off`: dev
 * switches (`WorldRenderer.hidePasses`).
 */
export function applyPost(p: Post, look: Pick<FrameLook, 'bloom' | 'grade'>, off: ReadonlySet<string>): void {
  const [strength, radius, threshold] = look.bloom
  p.bloom.strength = strength
  p.bloom.radius = radius
  p.bloom.threshold = threshold
  p.bloom.enabled = strength > 0 && !off.has('bloom')
  const g = look.grade
  const u = p.output.uniforms as Record<string, { value: unknown }>
  // The composite this frame's bloom renders (the texture is the pass's own, fixed): added only while it is on.
  u['tBloom']!.value = p.bloom.renderTargetsHorizontal[0]!.texture
  u['bloomOn']!.value = p.bloom.enabled ? 1 : 0
  u['gradeOn']!.value = g && !off.has('grade') ? 1 : 0
  if (!g) return
  u['vig']!.value = g.vignette ?? 0.35
  u['sat']!.value = g.sat ?? 1.08
  ;(u['warm']!.value as Vector3).set(...(g.warm ?? [1.03, 1.0, 0.95]))
  ;(u['cool']!.value as Vector3).set(...(g.cool ?? [0.94, 0.98, 1.06]))
}
