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
import { HalfFloatType, type Scene, type Camera, Vector2, Vector3, type WebGLRenderer, WebGLRenderTarget } from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { FrameLook } from './scene'
import { NOISE_GLSL } from './skyMaterial'

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
  m.fragmentShader = fs.slice(0, main) + GRADE_PARS + fs.slice(main, end) + GRADE_TAIL + fs.slice(end)
  Object.assign(pass.uniforms, {
    vig: { value: 0.35 },
    sat: { value: 1.08 },
    gradeOn: { value: 0 },
    warm: { value: new Vector3(1.03, 1, 0.95) },
    cool: { value: new Vector3(0.94, 0.98, 1.06) },
  })
  return pass
}

/** The passes a scene's look switches, and the dev switches `timePasses` flips. */
export type PassName = 'bloom' | 'grade'

export interface Post {
  readonly composer: EffectComposer
  readonly bloom: UnrealBloomPass
  /** The output pass, carrying the grade (`gradeOn`). */
  readonly output: OutputPass
}

export function buildPost(renderer: WebGLRenderer, scene: Scene, camera: Camera, samples: number): Post {
  const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples })
  const composer = new EffectComposer(renderer, rt)
  composer.addPass(new RenderPass(scene, camera))
  // The size is the composer's (`setSize` resizes every pass); the numbers are the look's (`applyPost`).
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0, 0, 1)
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
  u['gradeOn']!.value = g && !off.has('grade') ? 1 : 0
  if (!g) return
  u['vig']!.value = g.vignette ?? 0.35
  u['sat']!.value = g.sat ?? 1.08
  ;(u['warm']!.value as Vector3).set(...(g.warm ?? [1.03, 1.0, 0.95]))
  ;(u['cool']!.value as Vector3).set(...(g.cool ?? [0.94, 0.98, 1.06]))
}
