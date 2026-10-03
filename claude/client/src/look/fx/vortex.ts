/**
 * T23.20 part C — the breach vortex in the world renderer, F3's way (*"effects as key lights"*; its gate is the
 * nearest thing F3 draws: a glowing ring over a dark inside, a magenta light on the rock): a **dark opening** into the
 * void, **spiral arms** of violet-to-cyan light turning inward, and the **capture ring** — the one rule (`R98`) — a
 * bright HDR band at `VORTEX_CAPTURE_R` that the bloom makes shine.
 *
 * **Not a light for the rock** (assumed, reversible — the fireflies' ruling, T23.24): the terrain's light slots are
 * capped (`pickLights`), and a vortex light ranked as a combat light evicted an asteroid core's standing light —
 * measured in `breach-vortex`'s sandbox arm: the rock round the vortex went *darker* with it shown (red 46 → 23 at the
 * swirl's edge, and at the control 60 px past it). Reverse it by a light per vortex ranked below `fixed`.
 *
 * **The rule and the decoration as before** (`render/vortexFx-math.ts`): the ring is solid across `VORTEX_RING_W` at
 * the capture radius, full strength whatever the swirl does; the swirl is decoration and fades to nothing **at** its
 * outer radius (`swirlFade`'s curve, the shader's `smoothstep`), so nothing there reads as a line; the arms also dim
 * outward (`ARM_OUTER`), so the bloom of the bright inner arms does not reach that radius.
 *
 * **Premultiplied over** (`One, OneMinusSrcAlpha`), as the black hole: the opening is near-black at alpha 0.92 (it
 * hides the stars behind it), the ring covers what is behind it, the arms and the glow only add light.
 *
 * Where: the list the scene's `VortexFx` hands the feed (`fx/feed.ts::VortexView`) — `WorldMirror.vortices`, where
 * `vortex_open` put them. Not on the minimap (R9): the minimap is Phaser's and is never handed this list.
 */
import { AddEquation, BufferAttribute, BufferGeometry, CustomBlending, Mesh, OneFactor, OneMinusSrcAlphaFactor, OrthographicCamera, ShaderMaterial } from 'three'
import type { WebGLRenderer, WebGLRenderTarget } from 'three'
import { toWorld } from '../worldRenderer-math'

/** Beside the black hole: after the fireflies (6), before the actors (7) — a body being taken is drawn over it. */
export const VORTEX_ORDER = 6.6
/** The capture ring's HDR strength (× its colour): over the bloom threshold (0.7), so it shines. By eye. */
export const RING_HEAT = 0.7
/** The arms' HDR peak. By eye. */
export const ARM_HEAT = 0.5
/** The arms' brightness at the outer radius, as a share of theirs at the ring. By eye, and R98's edge probes. */
export const ARM_OUTER = 0.35

const VS = /* glsl */ `
attribute vec2 aP; attribute float aFade;
varying vec2 vP; varying float vFade;
void main(){ vP = aP; vFade = aFade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`

// vP: px from the vortex's centre. capture/outer: vortexRadii; fadeFrom: where swirlFade starts.
const FS = /* glsl */ `
uniform float time; uniform float capture; uniform float outer; uniform float fadeFrom; uniform float ringW;
uniform float arms; uniform float turns; uniform float spin; uniform vec3 ringCol; uniform float ringHeat; uniform float armHeat; uniform float armOuter;
varying vec2 vP; varying float vFade;
void main(){
  float r = length(vP);
  if (r > outer) { gl_FragColor = vec4(0.0); return; }
  float a = atan(vP.y, vP.x);
  float inner = capture * 0.25;
  // Logarithmic arms (vortexFx-math.ts::spiralArm's winding), sharp crests, drawn **inward**: at a fixed angle a crest's
  // radius shrinks with time (it sucks). Phaser's two paths turn the other way, which moves their crests outward.
  float wind = log(max(r, 1.0) / inner) / log(outer / inner);
  float arm = 0.5 + 0.5 * sin(arms * (a - 6.2831853 * turns * wind) - spin * time * arms);
  arm = pow(arm, 4.0);
  // swirlFade (R98): decoration, whole inside fadeFrom, gone at outer with no edge there.
  float reach = 1.0 - smoothstep(fadeFrom, outer, r);
  vec3 armCol = mix(vec3(0.45, 0.15, 0.95), vec3(0.35, 0.95, 1.0), arm);
  // A soft violet glow round the ring, fading with the swirl.
  float glow = exp(-abs(r - capture) / (capture * 0.3)) * 0.12;
  // The ring's own shine just outside its band: HDR violet over the bloom threshold, so the band reads as light.
  float shine = exp(-max(abs(r - capture) - ringW * 0.5, 0.0) / 2.5) * 0.9;
  float dim = mix(1.0, armOuter, clamp((r - capture) / (outer - capture), 0.0, 1.0));
  vec3 light = (armCol * arm * armHeat * dim + vec3(0.5, 0.2, 1.0) * glow) * reach + ringCol * shine * ringHeat;
  // The opening: near-black, its edge lit faintly from the ring.
  float core = 1.0 - smoothstep(capture * 0.55, capture * 0.78, r);
  vec3 col = light * (1.0 - core) + vec3(0.25, 0.08, 0.5) * 0.12 * core * smoothstep(0.0, capture * 0.6, r);
  float al = core * 0.92;
  // The ring: solid across ringW, the probe band, whatever the swirl does.
  float ring = 1.0 - smoothstep(ringW * 0.5, ringW * 0.5 + 1.5, abs(r - capture));
  col = mix(col, ringCol * ringHeat, ring);
  al = max(al, ring);
  gl_FragColor = vec4(col, al) * vFade;
}`

/** One vortex the scene hands over: where (mask px) and how faded (1 while it pulls, to 0 once closed). */
export interface VortexView {
  id: number
  x: number
  y: number
  fade: number
}

/** The drawing's radii and ring (`vortexFx-math.ts`), handed over with the list. */
export interface VortexLook {
  capture: number
  outer: number
  fadeFrom: number
  ringW: number
  arms: number
  turns: number
  spin: number
  ringRgb: readonly [number, number, number]
}

export class VortexLayer {
  readonly mesh: Mesh
  private readonly geometry = new BufferGeometry()
  private readonly material: ShaderMaterial
  private capacity = 0
  /** Dev: the ids drawn on the last placed frame. */
  drawn: number[] = []

  constructor() {
    this.material = new ShaderMaterial({
      name: 'vortex',
      uniforms: {
        time: { value: 0 },
        capture: { value: 32 },
        outer: { value: 64 },
        fadeFrom: { value: 43 },
        ringW: { value: 6 },
        arms: { value: 5 },
        turns: { value: 1.25 },
        spin: { value: 2.4 },
        ringCol: { value: [0.9, 0.7, 1] },
        ringHeat: { value: RING_HEAT },
        armHeat: { value: ARM_HEAT },
        armOuter: { value: ARM_OUTER },
      },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
    })
    this.grow(1)
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = VORTEX_ORDER
    this.mesh.visible = false
  }

  private grow(n: number): void {
    this.capacity = n
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(n * 12), 3))
    this.geometry.setAttribute('aP', new BufferAttribute(new Float32Array(n * 8), 2))
    this.geometry.setAttribute('aFade', new BufferAttribute(new Float32Array(n * 4), 1))
    const idx = new Uint32Array(n * 6)
    for (let q = 0; q < n; q++) idx.set([0, 2, 1, 0, 3, 2].map((i) => i + q * 4), q * 6)
    this.geometry.setIndex(new BufferAttribute(idx, 1))
  }

  /** Lay one quad on each vortex still showing (or hide the layer), at clock `t` (s, the scene's). */
  place(list: readonly VortexView[] | null, look: VortexLook | null, t: number, maskH: number): void {
    const shown = list && look ? list.filter((v) => v.fade > 0) : []
    if (!look || shown.length === 0) {
      this.mesh.visible = false
      this.drawn = []
      return
    }
    if (shown.length > this.capacity) this.grow(Math.max(shown.length, this.capacity * 2))
    const pos = (this.geometry.getAttribute('position') as BufferAttribute).array as Float32Array
    const ap = (this.geometry.getAttribute('aP') as BufferAttribute).array as Float32Array
    const fd = (this.geometry.getAttribute('aFade') as BufferAttribute).array as Float32Array
    const half = look.outer
    shown.forEach((v, q) => {
      for (let k = 0; k < 4; k++) {
        const u = (k === 1 || k === 2 ? 1 : -1) * half
        const w = (k >= 2 ? 1 : -1) * half
        const p = toWorld(v.x + u, v.y + w, maskH)
        const o = q * 4 + k
        pos[o * 3] = p.x
        pos[o * 3 + 1] = p.y
        pos[o * 3 + 2] = 0
        ap[o * 2] = u
        ap[o * 2 + 1] = -w
        fd[o] = Math.min(1, v.fade)
      }
    })
    for (const name of ['position', 'aP', 'aFade']) (this.geometry.getAttribute(name) as BufferAttribute).needsUpdate = true
    this.geometry.setDrawRange(0, shown.length * 6)
    const u = this.material.uniforms
    u['time']!.value = t
    u['capture']!.value = look.capture
    u['outer']!.value = look.outer
    u['fadeFrom']!.value = look.fadeFrom
    u['ringW']!.value = look.ringW
    u['arms']!.value = look.arms
    u['turns']!.value = look.turns
    u['spin']!.value = look.spin
    // The ring's colour is an sRGB colour (`VORTEX_RING_COLOR`); the scene is linear, so it is decoded first — as
    // given, 0xe6b3ff came out of the tone map a washed pink-white (r 200, g 184, b 187 measured in a match).
    u['ringCol']!.value = look.ringRgb.map((c) => Math.pow(c / 255, 2.2))
    this.mesh.visible = true
    this.drawn = shown.map((v) => v.id)
  }

  /** As `blackHole.ts::warm`: the program exists from scene start, not from the first breach (`context-budget`). */
  warm(r: WebGLRenderer, target: WebGLRenderTarget): void {
    const prev = r.getRenderTarget()
    const autoClear = r.autoClear
    const vis = this.mesh.visible
    r.autoClear = false
    target.scissor.set(0, 0, 1, 1)
    target.scissorTest = true
    r.setRenderTarget(target)
    this.mesh.visible = true
    this.geometry.setDrawRange(0, 0)
    r.render(this.mesh, new OrthographicCamera(0, 1, 1, 0, -1, 1))
    this.geometry.setDrawRange(0, Infinity)
    this.mesh.visible = vis
    target.scissor.set(0, 0, target.width, target.height)
    target.scissorTest = false
    r.setRenderTarget(prev)
    r.autoClear = autoClear
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
