/**
 * T23.14B: an actor's glows — `kit.js::sprite(softTex(), x, y, z, size, color, opacity, true)`, the mockup's additive
 * soft sprite (F1's `fx.add(sprite(softTex(), ex - 3, wy(ey - 6), 43, 16, Color(2.2, 1.0, 0.3), 0.7, true))`, the
 * enemy's jet plume), drawn after the actors (renderOrder 8; the mockup's fx sit at z 40+, over its actor canvas at
 * z 20) into the linear HDR scene, so the post's bloom picks up a colour over 1 as the mockup's does.
 *
 * `softTex` is a radial gradient, white, alpha 1 at the centre → 0.45 at 0.35 of the radius → 0 at the edge; a
 * `MeshBasicMaterial` with it, `color` and `opacity`, additively blended (`SrcAlpha, One`), adds
 * `color × opacity × alpha(r)` — which is what this shader adds, per quad, from the actor's `fx` list.
 */
import { AddEquation, BufferAttribute, BufferGeometry, CustomBlending, Mesh, OneFactor, OrthographicCamera, ShaderMaterial } from 'three'
import type { WebGLRenderer, WebGLRenderTarget } from 'three'
import type { Actor, ActorGlow } from '../scene'
import { toWorld } from '../worldRenderer-math'

/** Over the actors (7), under the foreground leaves (10). */
export const GLOW_ORDER = 8

const VS = /* glsl */ `
attribute vec2 aUv; attribute vec3 aColor;
varying vec2 vUv; varying vec3 vColor;
void main(){ vUv = aUv; vColor = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`

const FS = /* glsl */ `
varying vec2 vUv; varying vec3 vColor;
void main(){
  float r = length(vUv);
  float a = r < 0.35 ? mix(1., 0.45, r / 0.35) : mix(0.45, 0., clamp((r - 0.35) / 0.65, 0., 1.));
  gl_FragColor = vec4(vColor * a, 1.);
}`

const FLOATS = { position: 3, aUv: 2, aColor: 3 } as const
type AttrName = keyof typeof FLOATS

export class GlowLayer {
  readonly mesh: Mesh
  private readonly geometry = new BufferGeometry()
  private readonly material: ShaderMaterial
  private capacity = 0
  /** Dev: quads the last `place` laid out. */
  drawn = 0

  constructor() {
    this.material = new ShaderMaterial({
      name: 'glow',
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      depthTest: false,
      depthWrite: false,
    })
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = GLOW_ORDER
    this.mesh.visible = false
    this.grow(8)
  }

  private grow(n: number): void {
    this.capacity = n
    for (const [k, size] of Object.entries(FLOATS) as [AttrName, number][]) {
      this.geometry.setAttribute(k, new BufferAttribute(new Float32Array(n * 4 * size), size))
    }
    const idx = new Uint32Array(n * 6)
    // As `layer.ts`: clockwise in mask px is anticlockwise once y is flipped up.
    for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2], i * 6)
    this.geometry.setIndex(new BufferAttribute(idx, 1))
  }

  /** Lay out every glow of this frame's actors; `maskH` for the y flip. */
  place(actors: readonly Actor[], maskH: number): void {
    const glows: ActorGlow[] = actors.flatMap((a) => a.glows ?? [])
    if (glows.length > this.capacity) this.grow(Math.max(glows.length, this.capacity * 2))
    const at = (k: AttrName): Float32Array => (this.geometry.getAttribute(k) as BufferAttribute).array as Float32Array
    const pos = at('position')
    const uv = at('aUv')
    const col = at('aColor')
    glows.forEach((s, n) => {
      const h = s.size / 2
      const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
      corners.forEach(([u, v], k) => {
        const i = n * 4 + k
        const w = toWorld(s.x + u * h, s.y + v * h, maskH)
        pos.set([w.x, w.y, 0], i * 3)
        uv.set([u, v], i * 2)
        col.set([s.color[0] * s.alpha, s.color[1] * s.alpha, s.color[2] * s.alpha], i * 3)
      })
    })
    for (const k of Object.keys(FLOATS)) (this.geometry.getAttribute(k) as BufferAttribute).needsUpdate = true
    this.geometry.setDrawRange(0, glows.length * 6)
    this.drawn = glows.length
    this.mesh.visible = glows.length > 0
  }

  /**
   * T23.14C: build the glow's program and upload its geometry now, at scene start, as `TerrainGpu.warm` does —
   * drawn nothing (an empty draw range) into 1 px of `target`. Without it the program and geometry appeared the
   * first time any jet fired, so a match held 8 geometries / 18 programs or 9 / 19 depending on whether the bot had
   * jetted before `context-budget` sampled it (named by the check's program list: `glow 0→1`).
   */
  warm(r: WebGLRenderer, target: WebGLRenderTarget): void {
    const prev = r.getRenderTarget()
    const autoClear = r.autoClear
    const vis = this.mesh.visible
    const range = { ...this.geometry.drawRange }
    const cam = new OrthographicCamera(0, 1, 1, 0, -1, 1)
    r.autoClear = false
    target.scissor.set(0, 0, 1, 1)
    target.scissorTest = true
    r.setRenderTarget(target)
    this.mesh.visible = true
    this.geometry.setDrawRange(0, 0)
    r.render(this.mesh, cam)
    this.geometry.setDrawRange(range.start, range.count)
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
