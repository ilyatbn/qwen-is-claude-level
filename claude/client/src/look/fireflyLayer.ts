/**
 * T23.24: the fireflies drawn — one quad per firefly in view, laid out in its body's frame (`fireflies.ts::fireflyAt`):
 * an ink body (abdomen, head, two beating wings) with a glint at the tail and the glint's faint halo around it.
 *
 * **Premultiplied over** (`One, OneMinusSrcAlpha`): the ink darkens what is behind it (alpha), the glint and its halo
 * add light (colour, alpha 0) — one draw for both, so the black body reads against its own little pool of light.
 * The glint's core goes past 1 in the linear HDR scene so the post's bloom gives it a touch of shine.
 *
 * renderOrder 6: after the front fog (5), before the actors (7) — in the background band, behind the fight.
 */
import { AddEquation, BufferAttribute, BufferGeometry, CustomBlending, Mesh, OneFactor, OneMinusSrcAlphaFactor, ShaderMaterial } from 'three'
import type { ViewRect } from './scene'
import { FIREFLY_REACH, fireflyAt, type Firefly } from './fireflies'
import { toWorld } from './worldRenderer-math'

export const FIREFLY_ORDER = 6
/** Half the quad, px: the halo's reach. */
export const FIREFLY_QUAD = 14
/** The glint's colour (linear), its core's HDR peak and the halo's peak (of the glint). Tuned by eye (t2324 shots). */
export const FIREFLY_GLINT_RGB: readonly [number, number, number] = [1.0, 0.86, 0.38]
export const FIREFLY_CORE = 3.2
export const FIREFLY_HALO = 0.14
/** The bug's size: the body below is drawn in px at 1, scaled by this (zoom 1 needs ~7 px of bug to read as one). */
export const FIREFLY_SCALE = 1.5

const VS = /* glsl */ `
attribute vec2 aBody; attribute vec4 aParam;
varying vec2 vBody; varying vec4 vParam;
void main(){ vBody = aBody; vParam = aParam; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`

// vBody: px in the body's frame (x along the heading, y across). vParam: glint, fade, wing, unused.
const FS = /* glsl */ `
uniform vec3 glintRgb; uniform float core; uniform float halo; uniform float scale;
varying vec2 vBody; varying vec4 vParam;
float ell(vec2 p, vec2 c, vec2 r){ vec2 q = (p - c) / r; return (length(q) - 1.) * min(r.x, r.y); }
void main(){
  vec2 p = vBody / scale;
  float glint = vParam.x, fade = vParam.y, wing = vParam.z;
  float body = min(ell(p, vec2(-0.5, 0.), vec2(2.1, 1.25)), ell(p, vec2(1.9, 0.), vec2(0.95, 0.9)));
  float ink = smoothstep(0.55, -0.55, body);
  vec2 wr = vec2(1.7, 0.8 + 0.5 * wing);
  float wings = min(ell(p, vec2(0.2, 1.5), wr), ell(p, vec2(0.2, -1.5), wr));
  ink = max(ink, 0.55 * smoothstep(0.6, -0.6, wings));
  float d = length(p - vec2(-1.7, 0.));
  float spot = smoothstep(1.3, 0.2, d) * core;
  float pool = exp(-d * d / 20.) * halo + exp(-d / 2.5) * halo * 0.6;
  float a = ink * fade;
  vec3 light = glintRgb * glint * fade * (spot + pool * (1. - a));
  gl_FragColor = vec4(light, a);
}`

const FLOATS = { position: 3, aBody: 2, aParam: 4 } as const
type AttrName = keyof typeof FLOATS

export class FireflyLayer {
  readonly mesh: Mesh
  private readonly geometry = new BufferGeometry()
  private readonly material: ShaderMaterial
  private capacity = 0
  /** Dev: fireflies the last `place` laid out (in view, faded in), and where (mask px) — a check's patches. */
  drawn = 0
  positions: [number, number][] = []

  constructor() {
    this.material = new ShaderMaterial({
      name: 'fireflies',
      uniforms: {
        glintRgb: { value: [...FIREFLY_GLINT_RGB] },
        core: { value: FIREFLY_CORE },
        halo: { value: FIREFLY_HALO },
        scale: { value: FIREFLY_SCALE },
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
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = FIREFLY_ORDER
    this.mesh.visible = false
    this.grow(32)
  }

  private grow(n: number): void {
    this.capacity = n
    for (const [k, size] of Object.entries(FLOATS) as [AttrName, number][]) {
      this.geometry.setAttribute(k, new BufferAttribute(new Float32Array(n * 4 * size), size))
    }
    const idx = new Uint32Array(n * 6)
    // As `actors/glow.ts`: clockwise in mask px is anticlockwise once y is flipped up.
    for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2], i * 6)
    this.geometry.setIndex(new BufferAttribute(idx, 1))
  }

  /** Lay out the swarm at clock `t` (s), faded by `fade` (0 hides it), culled to `view` (mask px). */
  place(swarm: readonly Firefly[], t: number, fade: number, view: ViewRect, maskH: number): void {
    const m = FIREFLY_REACH + FIREFLY_QUAD
    const inView = fade > 0 ? swarm.filter((f) => f.hx > view.x - m && f.hx < view.x + view.w + m && f.hy > view.y - m && f.hy < view.y + view.h + m) : []
    if (inView.length > this.capacity) this.grow(Math.max(inView.length, this.capacity * 2))
    const at = (k: AttrName): Float32Array => (this.geometry.getAttribute(k) as BufferAttribute).array as Float32Array
    const pos = at('position')
    const body = at('aBody')
    const par = at('aParam')
    let n = 0
    this.positions = []
    for (const f of inView) {
      const s = fireflyAt(f, t)
      this.positions.push([s.x, s.y])
      const c = Math.cos(s.heading)
      const sn = Math.sin(s.heading)
      for (let k = 0; k < 4; k++) {
        const u = (k === 1 || k === 2 ? 1 : -1) * FIREFLY_QUAD
        const v = (k >= 2 ? 1 : -1) * FIREFLY_QUAD
        const i = n * 4 + k
        // Body frame → mask px (y down), then the y flip.
        const w = toWorld(s.x + u * c - v * sn, s.y + u * sn + v * c, maskH)
        pos[i * 3] = w.x
        pos[i * 3 + 1] = w.y
        pos[i * 3 + 2] = 0
        body[i * 2] = u
        body[i * 2 + 1] = v
        par[i * 4] = s.glint
        par[i * 4 + 1] = fade
        par[i * 4 + 2] = s.wing
        par[i * 4 + 3] = 0
      }
      n++
    }
    for (const k of Object.keys(FLOATS)) (this.geometry.getAttribute(k) as BufferAttribute).needsUpdate = true
    this.geometry.setDrawRange(0, n * 6)
    this.drawn = n
    this.mesh.visible = n > 0
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
