/**
 * T23.12: the actors in the world renderer — one quad per actor, all in one draw call, each sampling its atlas
 * cell (`atlas.ts`), in the description's order (blending is in primitive order, so the order is `lit()`'s
 * canvas order). renderOrder 7: after the front fog (5), before the foreground leaves (10) — where
 * `f_kit.js::frame` puts its 2D actor canvas (z 20, between front fog 10 and fx 40).
 *
 * The fragment shader is `lit()` (`cell.ts`): under → [far rim → rim →] fill → ink, each pass its extras then
 * its flat-coloured silhouette at its offset, composited in **sRGB, premultiplied** — as the mockup's canvas
 * composites them — then decoded to linear and blended over the scene, as its sRGB `CanvasTexture` is.
 * The rim passes are T23.13's (`rimOn`); T23.12 draws halo, shadow, fill and ink.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  LinearFilter,
  Mesh,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  type WebGLRenderer,
} from 'three'
import type { Actor, Light, Moon } from '../scene'
import { toWorld } from '../worldRenderer-math'
import { ATLAS_SIZE, ActorAtlas, type Painter } from './atlas'
import { MASK_STEP, actorRect, atAnchor, hasExtras, type Lighting } from './cell'
import { Flat, type G } from './flat'
import { passes } from './lit'

/** Where the actor layer sits among the world's layers (`atmosphere.ts`: front fog 5, foreground 10). */
export const ACTOR_ORDER = 7

const VS = /* glsl */ `
attribute vec2 aLocal; attribute vec4 aSlot; attribute vec4 aRim; attribute vec4 aFill;
varying vec2 vLocal; varying vec4 vSlot; varying vec4 vRim; varying vec4 vFill;
void main(){ vLocal = aLocal; vSlot = aSlot; vRim = aRim; vFill = aFill;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`

const FS = /* glsl */ `
uniform sampler2D atlas; uniform vec2 atlasSize; uniform float rimOn;
varying vec2 vLocal; varying vec4 vSlot; varying vec4 vRim; varying vec4 vFill;
// One of the cell's images (0 under, 1 ink, then the fill, rim and far-rim masks 2, 3, 4 — each already drawn at its
// pass's offset) at local px p, clamped to its rect.
vec4 img(float k, vec2 p){
  vec2 at = vec2(mod(k, 2.), floor(k / 2.)) * vSlot.zw;
  vec2 q = clamp(p, vec2(0.5), vSlot.zw - 0.5);
  return texture2D(atlas, (vSlot.xy + at + q) / atlasSize);
}
vec4 over(vec4 top, vec4 c){ return top + c * (1. - top.a); }
// A flat pass's alpha from its stroke counts: n strokes of alpha a give 1 - (1 - a)^n; a partly covered
// stroke (the fraction) adds a * frac, as one anti-aliased stroke does.
// b^n for a whole n >= 0. GLSL leaves pow(0, 0) undefined, and a full-strength rim pass (a = 1) asks for it:
// measured, D3D12 returned NaN and erased every actor lit that hard (SwiftShader returned 1).
float powN(float b, float n){ return n < 0.5 ? 1. : pow(max(b, 1e-6), n); }
float passAlpha(vec2 m, float ai, float aa){
  vec2 n = m * (255. / ${MASK_STEP}.);
  float ti = powN(1. - ai, floor(n.x)) * (1. - ai * fract(n.x));
  float ta = powN(1. - aa, floor(n.y)) * (1. - aa * fract(n.y));
  return 1. - ti * ta;
}
// One flat pass (mask image k, drawn at the pass's offset): the silhouette in the pass's colour.
vec4 pass(vec4 c, vec2 p, float k, vec3 rgb, float ai, float aa){
  float a = passAlpha(img(k, p).rg, ai, aa);
  return over(vec4(rgb * a, a), c);
}
vec3 toLinear(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void main(){
  vec2 p = vLocal;
  vec4 c = img(0., p);
  if (vFill.a > 0.5) {
    if (rimOn > 0.5) {
      c = pass(c, p, 4., vRim.rgb, vRim.a * 0.35, vRim.a * 0.3);
      c = pass(c, p, 3., vRim.rgb, vRim.a, vRim.a);
    }
    c = pass(c, p, 2., vFill.rgb, 0.35, 0.35);
  }
  c = over(img(1., p), c);
  // The mockup's canvas holds 8-bit premultiplied values, and its CanvasTexture is uploaded unpremultiplied —
  // another 8-bit rounding, large where alpha is small (a halo's rim). Both roundings, as it does them.
  c = floor(clamp(c, 0., 1.) * 255. + 0.5) / 255.;
  vec3 s = c.a > 0. ? floor(min(c.rgb / c.a, 1.) * 255. + 0.5) / 255. : vec3(0.);
  gl_FragColor = vec4(toLinear(s) * c.a, c.a);
}`

/** The browser's painter: a scratch canvas per cell, `texSubImage2D`'d into the atlas texture, premultiplied. */
function canvasPainter(renderer: WebGLRenderer, tex: DataTexture): Painter {
  // One large scratch canvas, reused: Chrome rasterises a small canvas on the CPU and a large one on the GPU,
  // and the two dither gradients differently — the mockup draws on a 1280×720 canvas.
  const canvas = document.createElement('canvas')
  canvas.width = SCRATCH_MIN[0]
  canvas.height = SCRATCH_MIN[1]
  const g = canvas.getContext('2d')
  if (!g) throw new Error('actor atlas: no 2D context')
  // Every curve flattened (`flat.ts`): the owner's GPU canvas draws curved paths wrong.
  const flat = new Flat(g)
  let w = 0
  let h = 0
  return {
    begin(cw: number, ch: number): G {
      if (cw > canvas.width || ch > canvas.height) {
        canvas.width = Math.max(canvas.width, cw)
        canvas.height = Math.max(canvas.height, ch)
      }
      w = cw
      h = ch
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalCompositeOperation = 'source-over'
      g.globalAlpha = 1
      g.clearRect(0, 0, cw, ch)
      return flat
    },
    upload(x: number, y: number): void {
      const gl = renderer.getContext() as WebGL2RenderingContext
      const t = (renderer.properties.get(tex) as { __webglTexture?: WebGLTexture }).__webglTexture
      if (!t) throw new Error('actor atlas: texture not initialised')
      renderer.state.bindTexture(gl.TEXTURE_2D, t)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
      // WebGL2: the top-left w × h of the canvas.
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    },
  }
}

/** The scratch canvas's least size — the mockup's actor canvas. */
const SCRATCH_MIN: [number, number] = [1280, 720]

const FLOATS = { position: 3, aLocal: 2, aSlot: 4, aRim: 4, aFill: 4 } as const
type AttrName = keyof typeof FLOATS

export class ActorLayer {
  readonly mesh: Mesh
  private store: { tex: DataTexture; atlas: ActorAtlas } | null = null
  private readonly material: ShaderMaterial
  private readonly geometry = new BufferGeometry()
  private capacity = 0
  /** Dev: quads the last `place` laid out. */
  drawn = 0

  constructor(private readonly renderer: WebGLRenderer) {
    this.material = new ShaderMaterial({
      uniforms: { atlas: { value: null }, atlasSize: { value: new Vector2(ATLAS_SIZE, ATLAS_SIZE) }, rimOn: { value: 0 } },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
    })
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = ACTOR_ORDER
    this.mesh.visible = false
    this.grow(16)
  }

  /**
   * The atlas texture, made on the first frame with a cast — a scene with none (the title, a match until
   * T23.14 describes its players) holds no 16 MB texture and pays no first-upload clear.
   */
  get atlas(): ActorAtlas {
    if (this.store) return this.store.atlas
    const tex = new DataTexture(null, ATLAS_SIZE, ATLAS_SIZE, RGBAFormat, UnsignedByteType)
    tex.minFilter = tex.magFilter = LinearFilter
    tex.generateMipmaps = false
    tex.flipY = false
    tex.source.dataReady = false
    tex.needsUpdate = true
    this.renderer.initTexture(tex)
    this.material.uniforms['atlas']!.value = tex
    this.store = { tex, atlas: new ActorAtlas(canvasPainter(this.renderer, tex)) }
    return this.store.atlas
  }

  /** Dev: the atlas's counters (zeros before the first cast). */
  get atlasStats(): ActorAtlas['stats'] {
    return this.store?.atlas.stats ?? { redraws: 0, uploads: 0, resets: 0, cells: 0 }
  }

  private grow(n: number): void {
    this.capacity = n
    for (const [k, size] of Object.entries(FLOATS) as [AttrName, number][]) {
      this.geometry.setAttribute(k, new BufferAttribute(new Float32Array(n * 4 * size), size))
    }
    const idx = new Uint32Array(n * 6)
    // Corners go round clockwise in mask px (y down), so anticlockwise — front-facing — once y is flipped up.
    for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2], i * 6)
    this.geometry.setIndex(new BufferAttribute(idx, 1))
  }

  /**
   * Lay this frame's actors out, lit by `lights`/`moon`; `maskH` for the y flip. Each cell is drawn with its actor at
   * its cell position (`cell.ts::atAnchor`: the position mod `CELL_ALIGN`, fraction included), so the quad is that rect
   * moved by whole `CELL_ALIGN`s to where the actor is. Written straight into the attributes.
   */
  place(actors: readonly Actor[], lights: readonly Light[], moon: Moon, maskH: number): void {
    if (actors.length > this.capacity) this.grow(Math.max(actors.length, this.capacity * 2))
    const at = (k: AttrName): Float32Array => (this.geometry.getAttribute(k) as BufferAttribute).array as Float32Array
    const pos = at('position')
    const loc = at('aLocal')
    const slot = at('aSlot')
    const rim = at('aRim')
    const fill = at('aFill')
    let n = 0
    if (actors.length) this.atlas.beginFrame()
    for (const a of actors) {
      const ps = a.lit ? passes(lights, moon, a.x, a.y, a.lit.size) : null
      const L: Lighting | null = ps ? { offs: [ps.fillOff, ps.off, [ps.off[0] * 1.7, ps.off[1] * 1.7]], rgb: ps.rimRgb, a: ps.a, fill: ps.fillRgb, rim: this.rim } : null
      const cell = this.atlas.cellFor(a, L)
      if (!cell) continue
      const c = atAnchor(a)
      const r = actorRect(c)
      const dx = a.x - c.x
      const dy = a.y - c.y
      const lit = ps && !hasExtras(a)
      for (let k = 0; k < 4; k++) {
        const x = k === 1 || k === 2 ? r[2] : r[0]
        const y = k >= 2 ? r[3] : r[1]
        const v = n * 4 + k
        const w = toWorld(x + dx, y + dy, maskH)
        pos[v * 3] = w.x
        pos[v * 3 + 1] = w.y
        pos[v * 3 + 2] = 0
        loc[v * 2] = x - r[0]
        loc[v * 2 + 1] = y - r[1]
        slot[v * 4] = cell.x
        slot[v * 4 + 1] = cell.y
        slot[v * 4 + 2] = cell.w
        slot[v * 4 + 3] = cell.h
        rim[v * 4] = ps ? ps.rim[0] : 0
        rim[v * 4 + 1] = ps ? ps.rim[1] : 0
        rim[v * 4 + 2] = ps ? ps.rim[2] : 0
        rim[v * 4 + 3] = ps ? ps.a : 0
        // .a: 0 unlit or baked (the ink image is the whole picture), 1 lit: passes composited here.
        fill[v * 4] = lit ? ps.fill[0] : 0
        fill[v * 4 + 1] = lit ? ps.fill[1] : 0
        fill[v * 4 + 2] = lit ? ps.fill[2] : 0
        fill[v * 4 + 3] = lit ? 1 : 0
      }
      n++
    }
    for (const k of Object.keys(FLOATS)) (this.geometry.getAttribute(k) as BufferAttribute).needsUpdate = true
    this.geometry.setDrawRange(0, n * 6)
    this.drawn = n
    this.mesh.visible = n > 0
  }

  private rim = true
  /** T23.13: draw `lit()`'s two rim passes (a baked cell keys on it). */
  set rimOn(on: boolean) {
    this.rim = on
    this.material.uniforms['rimOn']!.value = on ? 1 : 0
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.store?.tex.dispose()
  }
}
