/**
 * T23.18: the effects in the world renderer — `kit.js`'s `ribbon`, `sprite` and `explosion` meshes, batched: one
 * draw each for the smoke sprites (normal blending, `kit.js::sprite(smokeTex(), …, false)`), the soft additive sprites
 * (`sprite(softTex(), …, true)`), the ribbons (tracers, beams, sparks) and the shaded discs (fireballs, flames, the
 * shock ring). Into the linear HDR scene, after the actors and their glows (renderOrder `FX_ORDER`) and before the
 * foreground leaves — where `f_kit.js::frame` puts its fx group (z 40–60: over the actor canvas at z 20, under the
 * foreground at z 900) — so the post's bloom picks up what exceeds 1, as the mockup's does.
 *
 * **Order.** The mockup's transparent meshes are sorted by z: the tracers, beams and soft sprites (40–43) first, then
 * the explosion's smoke (45–47), then its ring, glow, fire and sparks. Additive draws commute among themselves, so the
 * one order that matters is which side of the smoke each is on: `under` sprites and ribbons are drawn before it (F1's
 * flamethrower glow is darkened by the plume drifting over it), everything else after.
 */
import {
  AddEquation,
  BufferAttribute,
  MaxEquation,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  Mesh,
  NormalBlending,
  OneFactor,
  OrthographicCamera,
  ShaderMaterial,
  SrcAlphaFactor,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three'
import { NOISE_GLSL } from '../skyMaterial'
import type { FxDisc, FxFrame, FxRibbon, FxSprite } from './kit'
import { smokeTex, softTex } from './textures'

/** After the actors (7) and their glows (8), before the foreground leaves (10). */
export const FX_ORDER = 9

const SPRITE_VS = /* glsl */ `
attribute vec2 aUv; attribute vec4 aColor; attribute float aTex;
varying vec2 vUv; varying vec4 vColor; varying float vTex;
void main(){ vUv = aUv; vColor = aColor; vTex = aTex; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`
// MeshBasicMaterial({ map, color, opacity }): (color · map.rgb, opacity · map.a), blended by the mesh's blending.
const SPRITE_FS = /* glsl */ `
uniform sampler2D map; uniform float premul;
varying vec2 vUv; varying vec4 vColor; varying float vTex;
// One texture per batch (the smoke batch samples smokeTex, the glows softTex): one fetch a fragment, not two.
void main(){ vec4 t = texture2D(map, vUv); vec4 c = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  // Under MAX blending (no blend factors) the alpha has to be in the colour already.
  gl_FragColor = premul > 0.5 ? vec4(c.rgb * c.a, c.a) : c; }`

const RIBBON_VS = /* glsl */ `
attribute vec2 aUv; attribute vec3 aCore; attribute vec3 aGlow; attribute vec2 aFade;
varying vec2 vUv; varying vec3 vCore; varying vec3 vGlow; varying vec2 vFade;
void main(){ vUv = aUv; vCore = aCore; vGlow = aGlow; vFade = aFade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`
// `kit.js::ribbon`'s fragment shader, its uniforms per vertex — and one guard: the tail's `vUv.x` 0 interpolates to a
// hair below 0 on D3D12, where `pow` of a negative is NaN, and a NaN in the HDR target is spread by the bloom over half
// the frame (measured: a blast's sparks blacked 83 % of a mid-frame region on the owner's GPU; SwiftShader returned 0).
const RIBBON_FS = /* glsl */ `
varying vec2 vUv; varying vec3 vCore; varying vec3 vGlow; varying vec2 vFade;
void main(){ float y = abs(vUv.y-0.5)*2.; float f = (vUv.x > 0. ? pow(vUv.x, vFade.x) : 0.) * (1. + vFade.y*smoothstep(0.85,1.,vUv.x));
  vec3 c = vCore*exp(-y*y*28.) + vGlow*exp(-y*y*3.5);
  gl_FragColor = vec4(c*f, 1.); }`

const DISC_VS = /* glsl */ `
attribute vec2 aUv; attribute float aKind; attribute vec4 aP; attribute vec3 aColor;
varying vec2 vUv; varying float vKind; varying vec4 vP; varying vec3 vColor;
void main(){ vUv = aUv; vKind = aKind; vP = aP; vColor = aColor; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`
// Kind 0: `kit.js::explosion`'s fireball, verbatim at noise offset 0, flow 0, heat 1 (vUv here is its p = uv·2 − 1).
// Kind 1: the same fire as a flame's tongue — its body lifted and narrowed, boiling upward with time.
// Kind 2: the shock ring, an additive annulus (vP.x..vP.y of the radius) in vColor · vP.w.
const DISC_FS =
  NOISE_GLSL +
  /* glsl */ `
uniform float time;
varying vec2 vUv; varying float vKind; varying vec4 vP; varying vec3 vColor;
void main(){
  vec2 p = vUv; float r = length(p);
  if (vKind > 1.5) {
    // RingGeometry under 4× MSAA: each edge's coverage ramps over a pixel.
    float w = max(fwidth(r), 1e-4);
    float ring = clamp((r - vP.x) / w + 0.5, 0., 1.) * clamp((vP.y - r) / w + 0.5, 0., 1.);
    gl_FragColor = vec4(vColor * vP.w * ring, 1.);
    return;
  }
  float rr = r;
  vec2 q = p;
  // A tongue: long above its body (p.y = −0.35), short below it, faded off before the quad's edge.
  float edge = 1.;
  if (vKind > 0.5) { float dy = p.y + 0.35; q = vec2(p.x, dy * (dy > 0. ? 0.62 : 1.3)); rr = length(q); edge = smoothstep(1., 0.8, max(abs(p.x), abs(p.y))); }
  vec2 drift = vec2(vP.x, -vP.y * time + vP.x * 0.7);
  float n = fbm(p*3.2 + vec2(0.,-0.4) + drift, 6); float n2 = fbm(p*7. + n*2. + drift, 4);
  float shape = smoothstep(0.78, 0.2, rr + (n-0.5)*0.75 + (n2-0.5)*0.25);
  float temp = shape * (1.25 - rr*0.9) * (0.7 + n2*0.6) * vP.z;
  vec3 c = vec3(0.9,0.16,0.02)*smoothstep(0.,0.3,temp) + vec3(1.0,0.45,0.06)*smoothstep(0.25,0.6,temp) + vec3(1.2,0.9,0.4)*smoothstep(0.6,0.95,temp) + vec3(2.,1.8,1.4)*smoothstep(0.95,1.15,temp);
  float soot = smoothstep(0.45, 0.7, n2) * (1. - smoothstep(0.5, 0.9, temp));
  gl_FragColor = vec4(c*1.1*shape*(1. - 0.6*soot) * vP.w * edge, 1.);
}`

type Floats = Record<string, number>

/** A growable batch of quads (or strips) with the given float attributes; indices written by the caller's layout. */
class Batch {
  readonly geometry = new BufferGeometry()
  readonly mesh: Mesh
  private verts = 0
  private indices = 0

  constructor(
    readonly material: ShaderMaterial,
    private readonly attrs: Floats,
    order: number,
  ) {
    this.mesh = new Mesh(this.geometry, material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = order
    this.mesh.visible = false
    this.grow(64, 96)
  }

  /** Every frame rewrites what it draws, so a grown buffer starts empty. */
  private grow(verts: number, indices: number): void {
    this.verts = verts
    this.indices = indices
    for (const [k, size] of Object.entries(this.attrs)) this.geometry.setAttribute(k, new BufferAttribute(new Float32Array(verts * size), size))
    this.geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1))
  }

  /** Make room for `v` vertices and `i` indices this frame. */
  reserve(v: number, i: number): void {
    if (v > this.verts || i > this.indices) this.grow(Math.max(v, this.verts * 2), Math.max(i, this.indices * 2))
  }

  arr(k: string): Float32Array {
    return (this.geometry.getAttribute(k) as BufferAttribute).array as Float32Array
  }

  idx(): Uint32Array {
    return this.geometry.getIndex()!.array as Uint32Array
  }

  commit(indices: number): void {
    for (const k of Object.keys(this.attrs)) (this.geometry.getAttribute(k) as BufferAttribute).needsUpdate = true
    this.geometry.getIndex()!.needsUpdate = true
    this.geometry.setDrawRange(0, indices)
    this.mesh.visible = indices > 0
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}

const additive = { transparent: true, blending: CustomBlending, blendEquation: AddEquation, blendSrc: SrcAlphaFactor, blendDst: OneFactor, depthTest: false, depthWrite: false }
const summed = { ...additive, blendSrc: OneFactor }

/** Quads `[i*4, …]` as two triangles each; mask-px corners are flipped by the camera's y, so both faces are drawn. */
function quadIndices(idx: Uint32Array, n: number): void {
  for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6)
}

export class FxLayer {
  private readonly soft: Texture = softTex()
  private readonly smokeT: Texture = smokeTex()
  private readonly glowUnder: Batch
  private readonly ribbonsUnder: Batch
  private readonly smoke: Batch
  private readonly ink: Batch
  private readonly glow: Batch
  private readonly ribbons: Batch
  private readonly discs: Batch
  private readonly glowMax: Batch
  private readonly discsMax: Batch
  private readonly time = { value: 0 }
  /** Dev: what the last `place` laid out, by list (`flames`: the discs blended by the brightest — the fire on the ground). */
  drawn = { smoke: 0, ink: 0, soft: 0, ribbons: 0, discs: 0, flames: 0 }

  constructor() {
    const spriteMat = (blend: object, map: Texture, premul = 0): ShaderMaterial =>
      new ShaderMaterial({
        name: 'fx-sprite',
        vertexShader: SPRITE_VS,
        fragmentShader: SPRITE_FS,
        uniforms: { map: { value: map }, premul: { value: premul } },
        side: DoubleSide,
        ...blend,
      })
    const spriteAttrs = { position: 3, aUv: 2, aColor: 4, aTex: 1 }
    const ribbonMat = (): ShaderMaterial => new ShaderMaterial({ name: 'fx-ribbon', vertexShader: RIBBON_VS, fragmentShader: RIBBON_FS, side: DoubleSide, ...summed })
    const ribbonAttrs = { position: 3, aUv: 2, aCore: 3, aGlow: 3, aFade: 2 }
    this.glowUnder = new Batch(spriteMat(additive, this.soft), spriteAttrs, FX_ORDER - 0.2)
    this.ribbonsUnder = new Batch(ribbonMat(), ribbonAttrs, FX_ORDER - 0.1)
    this.smoke = new Batch(spriteMat({ transparent: true, blending: NormalBlending, depthTest: false, depthWrite: false }, this.smokeT), spriteAttrs, FX_ORDER)
    this.ink = new Batch(spriteMat({ transparent: true, blending: NormalBlending, depthTest: false, depthWrite: false }, this.soft), spriteAttrs, FX_ORDER + 0.05)
    this.glow = new Batch(spriteMat(additive, this.soft), spriteAttrs, FX_ORDER + 0.1)
    this.ribbons = new Batch(ribbonMat(), ribbonAttrs, FX_ORDER + 0.2)
    const discMat = (blend: object): ShaderMaterial =>
      new ShaderMaterial({ name: 'fx-disc', vertexShader: DISC_VS, fragmentShader: DISC_FS, uniforms: { time: this.time }, side: DoubleSide, ...blend })
    const discAttrs = { position: 3, aUv: 2, aKind: 1, aP: 4, aColor: 3 }
    this.discs = new Batch(discMat(summed), discAttrs, FX_ORDER + 0.3)
    // Fire on the ground (a molotov's crowd, a flamethrower's stream): the brightest of the overlapping flames, not
    // their sum — T21.36's lesson, measured then: ten overlapping oranges summed past white and read as steam.
    const brightest = { ...summed, blendEquation: MaxEquation }
    this.glowMax = new Batch(spriteMat(brightest, this.soft, 1), spriteAttrs, FX_ORDER + 0.4)
    this.discsMax = new Batch(discMat(brightest), discAttrs, FX_ORDER + 0.5)
  }

  private get batches(): Batch[] {
    return [this.glowUnder, this.ribbonsUnder, this.smoke, this.ink, this.glow, this.ribbons, this.discs, this.glowMax, this.discsMax]
  }

  get meshes(): Mesh[] {
    return this.batches.map((b) => b.mesh)
  }

  /** Is anything drawn? (An empty layer lets the renderer skip an unchanged frame.) */
  get busy(): boolean {
    return this.drawn.smoke + this.drawn.ink + this.drawn.soft + this.drawn.ribbons + this.drawn.discs > 0
  }

  /** Lay out one frame's effects (mask px) in the y-up world of height `maskH`; `seconds` drives the flames' flow. */
  place(f: FxFrame, maskH: number, seconds: number): void {
    this.time.value = seconds % 1000
    this.sprites(this.glowUnder, f.soft.filter((s) => s.under), maskH)
    this.ribbonStrips(this.ribbonsUnder, f.ribbons.filter((r) => r.under), maskH)
    this.sprites(this.smoke, f.smoke, maskH)
    this.sprites(this.ink, f.ink, maskH)
    this.sprites(this.glow, f.soft.filter((s) => !s.under && !s.max), maskH)
    this.ribbonStrips(this.ribbons, f.ribbons.filter((r) => !r.under), maskH)
    this.discQuads(this.discs, f.discs.filter((d) => !d.max), maskH)
    this.sprites(this.glowMax, f.soft.filter((s) => s.max), maskH)
    this.discQuads(this.discsMax, f.discs.filter((d) => d.max), maskH)
    this.drawn = { smoke: f.smoke.length, ink: f.ink.length, soft: f.soft.length, ribbons: f.ribbons.length, discs: f.discs.length, flames: f.discs.filter((d) => d.max).length }
  }

  private sprites(b: Batch, list: readonly FxSprite[], H: number): void {
    const n = list.length
    b.reserve(n * 4, n * 6)
    const pos = b.arr('position')
    const uv = b.arr('aUv')
    const col = b.arr('aColor')
    const tex = b.arr('aTex')
    for (let i = 0; i < n; i++) {
      const s = list[i]!
      const h = s.size / 2
      const c = Math.cos(s.rot)
      const sn = Math.sin(s.rot)
      const wx = s.x
      const wy = H - s.y
      for (let k = 0; k < 4; k++) {
        // PlaneGeometry's corners, y up: (−,−) (+,−) (+,+) (−,+), uv (0,0) (1,0) (1,1) (0,1), turned by rot.
        const u = k === 1 || k === 2 ? 1 : 0
        const v = k >= 2 ? 1 : 0
        const lx = (u * 2 - 1) * h
        const ly = (v * 2 - 1) * h
        const j = i * 4 + k
        pos[j * 3] = wx + lx * c - ly * sn
        pos[j * 3 + 1] = wy + lx * sn + ly * c
        pos[j * 3 + 2] = 0
        uv[j * 2] = u
        uv[j * 2 + 1] = v
        col[j * 4] = s.color[0]
        col[j * 4 + 1] = s.color[1]
        col[j * 4 + 2] = s.color[2]
        col[j * 4 + 3] = s.alpha
        tex[j] = s.tex
      }
    }
    quadIndices(b.idx(), n)
    b.commit(n * 6)
  }

  /** `kit.js::ribbon`'s strip per ribbon: two vertices a point, offset ± width/2 across the local direction. */
  private ribbonStrips(b: Batch, list: readonly FxRibbon[], H: number): void {
    let v = 0
    let ix = 0
    for (const r of list) {
      v += r.pts.length * 2
      ix += Math.max(0, r.pts.length - 1) * 6
    }
    b.reserve(v, ix)
    const pos = b.arr('position')
    const uv = b.arr('aUv')
    const core = b.arr('aCore')
    const glow = b.arr('aGlow')
    const fade = b.arr('aFade')
    const idx = b.idx()
    let vi = 0
    let ii = 0
    for (const r of list) {
      const pts = r.pts
      const last = pts.length - 1
      for (let i = 0; i <= last; i++) {
        const a = pts[Math.max(0, i - 1)]!
        const c = pts[Math.min(last, i + 1)]!
        // In the y-up world, as the mockup computes it.
        let dx = c[0] - a[0]
        let dy = -(c[1] - a[1])
        const l = Math.hypot(dx, dy) || 1
        dx /= l
        dy /= l
        const t = last > 0 ? i / last : 0
        const w = r.width * (pts[i]![2] ?? 1)
        const x = pts[i]![0]
        const y = H - pts[i]![1]
        const put = (px: number, py: number, vy: number): void => {
          pos[vi * 3] = px
          pos[vi * 3 + 1] = py
          pos[vi * 3 + 2] = 0
          uv[vi * 2] = t
          uv[vi * 2 + 1] = vy
          core.set(r.core, vi * 3)
          glow.set(r.glow, vi * 3)
          fade[vi * 2] = r.fadePow
          fade[vi * 2 + 1] = r.headBoost
          vi++
        }
        put(x - (dy * w) / 2, y + (dx * w) / 2, 0)
        put(x + (dy * w) / 2, y - (dx * w) / 2, 1)
        if (i) {
          const k = vi - 2
          idx.set([k - 2, k - 1, k, k - 1, k + 1, k], ii)
          ii += 6
        }
      }
    }
    b.commit(ii)
  }

  private discQuads(b: Batch, list: readonly FxDisc[], H: number): void {
    const n = list.length
    b.reserve(n * 4, n * 6)
    const pos = b.arr('position')
    const uv = b.arr('aUv')
    const kind = b.arr('aKind')
    const p = b.arr('aP')
    const col = b.arr('aColor')
    for (let i = 0; i < n; i++) {
      const d = list[i]!
      const h = d.size / 2
      for (let k = 0; k < 4; k++) {
        const u = k === 1 || k === 2 ? 1 : -1
        const v = k >= 2 ? 1 : -1
        const j = i * 4 + k
        pos[j * 3] = d.x + u * h
        pos[j * 3 + 1] = H - d.y + v * h
        pos[j * 3 + 2] = 0
        uv[j * 2] = u
        uv[j * 2 + 1] = v
        kind[j] = d.kind
        p.set([d.a, d.b, d.heat, d.alpha], j * 4)
        col.set(d.color, j * 3)
      }
    }
    quadIndices(b.idx(), n)
    b.commit(n * 6)
  }

  /**
   * Build the four programs and upload their geometry now, at scene start (T23.14C's reason: `context-budget` counts
   * programs, and ones that first appear with the first shot make a match's count depend on who fired).
   */
  warm(r: WebGLRenderer, target: WebGLRenderTarget): void {
    const prev = r.getRenderTarget()
    const autoClear = r.autoClear
    const cam = new OrthographicCamera(0, 1, 1, 0, -1, 1)
    r.autoClear = false
    target.scissor.set(0, 0, 1, 1)
    target.scissorTest = true
    r.setRenderTarget(target)
    for (const b of this.batches) {
      const vis = b.mesh.visible
      const range = { ...b.geometry.drawRange }
      b.mesh.visible = true
      b.geometry.setDrawRange(0, 0)
      r.render(b.mesh, cam)
      b.geometry.setDrawRange(range.start, range.count)
      b.mesh.visible = vis
    }
    target.scissor.set(0, 0, target.width, target.height)
    target.scissorTest = false
    r.setRenderTarget(prev)
    r.autoClear = autoClear
  }

  dispose(): void {
    for (const b of this.batches) b.dispose()
    this.soft.dispose()
    this.smokeT.dispose()
  }
}
