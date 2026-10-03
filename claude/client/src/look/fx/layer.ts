/**
 * T23.18: the effects in the world renderer — `kit.js`'s `ribbon`, `sprite` and `explosion` meshes, batched: one
 * draw each for the smoke sprites (normal blending, `kit.js::sprite(smokeTex(), …, false)`), the soft additive sprites
 * (`sprite(softTex(), …, true)`), the ribbons (tracers, beams, sparks) and the shaded discs (fireballs, flames, the
 * shock ring). Into the linear HDR scene, after the actors and their glows (renderOrder `FX_ORDER`) and — unlike
 * `f_kit.js::frame`, whose fx group (z 40–60) sits under the foreground at z 900 — **over the foreground leaves**
 * (`atmosphere.ts::FG_ORDER`, T23.41: a leaf may not hide danger), so the post's bloom picks up what exceeds 1, as the
 * mockup's does.
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

/** After the actors (7), their glows (8) and the foreground leaves (`FG_ORDER` 8.7; every batch is ≥ this − 0.2). */
export const FX_ORDER = 9

/** Each batch's renderOrder around `FX_ORDER` (the order rule in the header); the constructor reads these. */
export const FX_BATCH_ORDER = {
  glowUnder: FX_ORDER - 0.2,
  ribbonsUnder: FX_ORDER - 0.1,
  smoke: FX_ORDER,
  ink: FX_ORDER + 0.05,
  glow: FX_ORDER + 0.1,
  ribbons: FX_ORDER + 0.2,
  discs: FX_ORDER + 0.3,
  glowMax: FX_ORDER + 0.4,
  discsMax: FX_ORDER + 0.5,
} as const

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
// Kind 0: `kit.js::explosion`'s fireball, verbatim at noise offset 0, boil 0, heat 1 (vUv here is its p = uv·2 − 1). Its
// boil (vP.y) is how far the noise has moved, set per frame from the blast's age (T23.19D R27: 0 at the peak = the still).
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
  vec2 drift = vec2(vP.x, (vKind > 0.5 ? -vP.y * time : vP.y) + vP.x * 0.7);
  float n = fbm(p*3.2 + vec2(0.,-0.4) + drift, FIRE_OCT_A); float n2 = fbm(p*7. + n*2. + drift, FIRE_OCT_B);
  float shape = smoothstep(0.78, 0.2, rr + (n-0.5)*0.75 + (n2-0.5)*0.25);
  float temp = shape * (1.25 - rr*0.9) * (0.7 + n2*0.6) * vP.z;
  vec3 c = vec3(0.9,0.16,0.02)*smoothstep(0.,0.3,temp) + vec3(1.0,0.45,0.06)*smoothstep(0.25,0.6,temp) + vec3(1.2,0.9,0.4)*smoothstep(0.6,0.95,temp) + vec3(2.,1.8,1.4)*smoothstep(0.95,1.15,temp);
  float soot = smoothstep(0.45, 0.7, n2) * (1. - smoothstep(0.5, 0.9, temp));
  gl_FragColor = vec4(c*1.1*shape*(1. - 0.6*soot) * vP.w * edge, 1.);
}`

/** `kit.js::explosion`'s two noise octave counts (6, 4), and the low tier's. */
export const FIRE_OCTAVES: readonly [number, number] = [6, 4]
/**
 * T23.18B, R14: the low tier's fire drops the two finest octaves of each noise — detail finer than its half-resolution
 * buffer shows once the bloom has spread it. The fireball's outline is the first octaves' (`shape`'s smoothstep of
 * r + noise), so the drawn reach is kept; `blast-fx`/`fire-fx` measure it on the low tier.
 */
export const FIRE_OCTAVES_LOW: readonly [number, number] = [4, 3]

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

  /**
   * Every frame rewrites what it draws, so a grown buffer starts empty. T23.18B: the old attributes' GL buffers go
   * first — replacing an attribute leaves three holding the old buffer until the geometry is disposed (a leak per
   * growth); `dispose` releases them and the next draw uploads the new ones.
   */
  private grow(verts: number, indices: number): void {
    this.verts = verts
    this.indices = indices
    this.geometry.dispose()
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

  /**
   * `verts` vertices and `indices` indices were written this frame. T23.18B: only those are uploaded (`addUpdateRange`)
   * — the whole grown arrays went up every frame before.
   */
  commit(verts: number, indices: number): void {
    for (const [k, size] of Object.entries(this.attrs)) {
      const a = this.geometry.getAttribute(k) as BufferAttribute
      a.clearUpdateRanges()
      if (verts > 0) a.addUpdateRange(0, verts * size)
      a.needsUpdate = verts > 0
    }
    const ix = this.geometry.getIndex()!
    ix.clearUpdateRanges()
    if (indices > 0) ix.addUpdateRange(0, indices)
    ix.needsUpdate = indices > 0
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
  for (let i = 0; i < n; i++) {
    const v = i * 4
    const o = i * 6
    idx[o] = v
    idx[o + 1] = v + 1
    idx[o + 2] = v + 2
    idx[o + 3] = v
    idx[o + 4] = v + 2
    idx[o + 5] = v + 3
  }
}

/** Which soft sprites each glow batch draws (`place`): under the smoke, over it, or blended by the brightest. */
const softUnder = (s: FxSprite): boolean => !!s.under
const softOver = (s: FxSprite): boolean => !s.under && !s.max
const softMax = (s: FxSprite): boolean => !!s.max
const every = (): boolean => true

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
    this.glowUnder = new Batch(spriteMat(additive, this.soft), spriteAttrs, FX_BATCH_ORDER.glowUnder)
    this.ribbonsUnder = new Batch(ribbonMat(), ribbonAttrs, FX_BATCH_ORDER.ribbonsUnder)
    this.smoke = new Batch(spriteMat({ transparent: true, blending: NormalBlending, depthTest: false, depthWrite: false }, this.smokeT), spriteAttrs, FX_BATCH_ORDER.smoke)
    this.ink = new Batch(spriteMat({ transparent: true, blending: NormalBlending, depthTest: false, depthWrite: false }, this.soft), spriteAttrs, FX_BATCH_ORDER.ink)
    this.glow = new Batch(spriteMat(additive, this.soft), spriteAttrs, FX_BATCH_ORDER.glow)
    this.ribbons = new Batch(ribbonMat(), ribbonAttrs, FX_BATCH_ORDER.ribbons)
    const discMat = (blend: object): ShaderMaterial =>
      new ShaderMaterial({ name: 'fx-disc', vertexShader: DISC_VS, fragmentShader: DISC_FS, defines: { FIRE_OCT_A: FIRE_OCTAVES[0], FIRE_OCT_B: FIRE_OCTAVES[1] }, uniforms: { time: this.time }, side: DoubleSide, ...blend })
    const discAttrs = { position: 3, aUv: 2, aKind: 1, aP: 4, aColor: 3 }
    this.discs = new Batch(discMat(summed), discAttrs, FX_BATCH_ORDER.discs)
    // Fire on the ground (a molotov's crowd, a flamethrower's stream): the brightest of the overlapping flames, not
    // their sum — T21.36's lesson, measured then: ten overlapping oranges summed past white and read as steam.
    const brightest = { ...summed, blendEquation: MaxEquation }
    this.glowMax = new Batch(spriteMat(brightest, this.soft, 1), spriteAttrs, FX_BATCH_ORDER.glowMax)
    this.discsMax = new Batch(discMat(brightest), discAttrs, FX_BATCH_ORDER.discsMax)
  }

  private get batches(): Batch[] {
    return [this.glowUnder, this.ribbonsUnder, this.smoke, this.ink, this.glow, this.ribbons, this.discs, this.glowMax, this.discsMax]
  }

  get meshes(): Mesh[] {
    return this.batches.map((b) => b.mesh)
  }

  /** T23.18B: the tier's fire noise (`FIRE_OCTAVES_LOW` on the low tier); a change recompiles the two disc programs. */
  setTier(low: boolean): void {
    const [a, b] = low ? FIRE_OCTAVES_LOW : FIRE_OCTAVES
    for (const batch of [this.discs, this.discsMax]) {
      const d = batch.material.defines
      if (d['FIRE_OCT_A'] === a && d['FIRE_OCT_B'] === b) continue
      d['FIRE_OCT_A'] = a
      d['FIRE_OCT_B'] = b
      batch.material.needsUpdate = true
    }
  }

  /** Is anything drawn? (An empty layer lets the renderer skip an unchanged frame.) */
  get busy(): boolean {
    return this.drawn.smoke + this.drawn.ink + this.drawn.soft + this.drawn.ribbons + this.drawn.discs > 0
  }

  /** Lay out one frame's effects (mask px) in the y-up world of height `maskH`; `seconds` drives the flames' flow. */
  place(f: FxFrame, maskH: number, seconds: number): void {
    this.time.value = seconds % 1000
    // T23.18B: each batch takes the whole list and its own predicate — no filtered copy per batch per frame.
    this.sprites(this.glowUnder, f.soft, maskH, softUnder)
    this.ribbonStrips(this.ribbonsUnder, f.ribbons, maskH, true)
    this.sprites(this.smoke, f.smoke, maskH, every)
    this.sprites(this.ink, f.ink, maskH, every)
    this.sprites(this.glow, f.soft, maskH, softOver)
    this.ribbonStrips(this.ribbons, f.ribbons, maskH, false)
    this.discQuads(this.discs, f.discs, maskH, false)
    this.sprites(this.glowMax, f.soft, maskH, softMax)
    const flames = this.discQuads(this.discsMax, f.discs, maskH, true)
    const d = this.drawn
    d.smoke = f.smoke.length
    d.ink = f.ink.length
    d.soft = f.soft.length
    d.ribbons = f.ribbons.length
    d.discs = f.discs.length
    d.flames = flames
  }

  private sprites(b: Batch, all: readonly FxSprite[], H: number, keep: (s: FxSprite) => boolean): void {
    let n = 0
    for (const s of all) if (keep(s)) n++
    b.reserve(n * 4, n * 6)
    const pos = b.arr('position')
    const uv = b.arr('aUv')
    const col = b.arr('aColor')
    const tex = b.arr('aTex')
    let i = -1
    for (const s of all) {
      if (!keep(s)) continue
      i++
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
    b.commit(n * 4, n * 6)
  }

  /** `kit.js::ribbon`'s strip per ribbon: two vertices a point, offset ± width/2 across the local direction. */
  /** The ribbons drawn `under` the smoke (`under` true) or over it. */
  private ribbonStrips(b: Batch, all: readonly FxRibbon[], H: number, under: boolean): void {
    let v = 0
    let ix = 0
    for (const r of all) {
      if (!r.under !== !under) continue
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
    for (const r of all) {
      if (!r.under !== !under) continue
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
        // The two vertices across the point (T23.18B: written in place — no closure per point).
        for (let side = 0; side < 2; side++) {
          const sgn = side === 0 ? -1 : 1
          pos[vi * 3] = x + (sgn * dy * w) / 2
          pos[vi * 3 + 1] = y - (sgn * dx * w) / 2
          pos[vi * 3 + 2] = 0
          uv[vi * 2] = t
          uv[vi * 2 + 1] = side
          core[vi * 3] = r.core[0]
          core[vi * 3 + 1] = r.core[1]
          core[vi * 3 + 2] = r.core[2]
          glow[vi * 3] = r.glow[0]
          glow[vi * 3 + 1] = r.glow[1]
          glow[vi * 3 + 2] = r.glow[2]
          fade[vi * 2] = r.fadePow
          fade[vi * 2 + 1] = r.headBoost
          vi++
        }
        if (i) {
          const k = vi - 2
          idx[ii] = k - 2
          idx[ii + 1] = k - 1
          idx[ii + 2] = k
          idx[ii + 3] = k - 1
          idx[ii + 4] = k + 1
          idx[ii + 5] = k
          ii += 6
        }
      }
    }
    b.commit(vi, ii)
  }

  /** The discs blended by the brightest (`max` true) or summed; returns how many were laid out. */
  private discQuads(b: Batch, all: readonly FxDisc[], H: number, max: boolean): number {
    let n = 0
    for (const d of all) if (!d.max === !max) n++
    b.reserve(n * 4, n * 6)
    const pos = b.arr('position')
    const uv = b.arr('aUv')
    const kind = b.arr('aKind')
    const p = b.arr('aP')
    const col = b.arr('aColor')
    let i = -1
    for (const d of all) {
      if (!d.max !== !max) continue
      i++
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
        p[j * 4] = d.a
        p[j * 4 + 1] = d.b
        p[j * 4 + 2] = d.heat
        p[j * 4 + 3] = d.alpha
        col[j * 3] = d.color[0]
        col[j * 3 + 1] = d.color[1]
        col[j * 3 + 2] = d.color[2]
      }
    }
    quadIndices(b.idx(), n)
    b.commit(n * 4, n * 6)
    return n
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
