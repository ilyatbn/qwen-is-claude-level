/**
 * T23.06: the terrain's GPU state — T23.05's fields in **one world-sized RGBA8 texture** (not per
 * chunk: the shaders read ~50 px away and a seam would show), the albedo painted from them into a
 * world-sized RGBA8 target (`albedo.ts`), and the accumulated scorch mask the explosions write.
 * Texel `(x, y)` is world px `(x, y)`, row 0 the mask's row 0, in all three.
 *
 * **Dirty rectangles only.** A carve uploads the rect `render_fields_dirty` returned
 * (`texSubImage2D` straight from the wasm buffer, `UNPACK_ROW_LENGTH` = world width) and repaints
 * that rect grown by `ALBEDO_REACH` at once. The **full** albedo pass is queued as `ALBEDO_TILE`
 * tiles and painted a few per frame (`step`), so a Large map's 8 M px never land in one frame.
 */
import {
  Color,
  CustomBlending,
  DataTexture,
  GLSL3,
  LinearFilter,
  MaxEquation,
  Mesh,
  NearestFilter,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RedFormat,
  RedIntegerFormat,
  UnsignedShortType,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import { ALBEDO_FS, HASH_PROBE_FS, HASH_PROBE_N, QUAD_VS, SCORCH_FS, SCORCH_VS } from './albedo'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Side of one queued albedo tile, px. */
export const ALBEDO_TILE = 256
/**
 * How far an albedo px reads fields: ±1 px (the `dIn` gradient) and 19 px below (the grass fringe
 * finds its surface) — so a fields rect grown by this covers every albedo px it can change.
 */
export const ALBEDO_REACH = 20

export function clipRect(r: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x))
  const y0 = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(w, Math.ceil(r.x + r.w))
  const y1 = Math.min(h, Math.ceil(r.y + r.h))
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

export function grow(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m }
}

/** Every `ALBEDO_TILE` tile of a `w × h` world, row-major. */
export function tilesOf(w: number, h: number): Rect[] {
  const out: Rect[] = []
  for (let y = 0; y < h; y += ALBEDO_TILE) {
    for (let x = 0; x < w; x += ALBEDO_TILE) out.push({ x, y, w: Math.min(ALBEDO_TILE, w - x), h: Math.min(ALBEDO_TILE, h - y) })
  }
  return out
}

export class TerrainGpu {
  readonly field: DataTexture
  /** Exact `dIn²` (R16UI) — the albedo's depth and "which way is up", unquantised as in `world.js`. */
  readonly din2: DataTexture
  readonly albedo: WebGLRenderTarget
  readonly scorch: WebGLRenderTarget
  readonly stats = { tiles: 0, dirtyPaints: 0, scorches: 0, uploads: 0, uploadedPx: 0 }
  /** Dev: every rect `paintNow` repainted since the last `takePaints` (a check's "texels changed only here"). */
  private paints: Rect[] = []
  /** Dev: the last blast scorched, `[x, y, r]`. */
  lastScorch: [number, number, number] | null = null
  private queue: Rect[] = []
  private readonly quad = new PlaneGeometry(2, 2)
  private readonly albedoMat: RawShaderMaterial
  private readonly scorchMat: RawShaderMaterial
  private readonly passScene = new Scene()
  private readonly passMesh: Mesh
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

  constructor(
    private readonly renderer: WebGLRenderer,
    readonly w: number,
    readonly h: number,
  ) {
    this.field = new DataTexture(new Uint8Array(w * h * 4), w, h, RGBAFormat, UnsignedByteType)
    this.field.minFilter = this.field.magFilter = LinearFilter
    this.field.generateMipmaps = false
    this.field.flipY = false
    this.field.needsUpdate = true
    renderer.initTexture(this.field)
    // Uploaded (zeros) and never re-uploaded from here — `uploadFields` writes it — so the JS copy goes.
    ;(this.field.image as { data: Uint8Array | null }).data = null
    this.din2 = new DataTexture(new Uint16Array(w * h), w, h, RedIntegerFormat, UnsignedShortType)
    this.din2.internalFormat = 'R16UI'
    this.din2.minFilter = this.din2.magFilter = NearestFilter
    this.din2.generateMipmaps = false
    this.din2.flipY = false
    this.din2.unpackAlignment = 2
    this.din2.needsUpdate = true
    renderer.initTexture(this.din2)
    ;(this.din2.image as unknown as { data: Uint16Array | null }).data = null
    const target = (format: typeof RGBAFormat | typeof RedFormat): WebGLRenderTarget =>
      new WebGLRenderTarget(w, h, { format, type: UnsignedByteType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false })
    this.albedo = target(RGBAFormat)
    this.scorch = target(RedFormat)
    this.albedoMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VS,
      fragmentShader: ALBEDO_FS,
      uniforms: { field: { value: this.field }, din2: { value: this.din2 }, scorch: { value: this.scorch.texture }, size: { value: new Vector2(w, h) } },
      depthTest: false,
      depthWrite: false,
    })
    this.scorchMat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: SCORCH_VS,
      fragmentShader: SCORCH_FS,
      uniforms: { rect: { value: new Vector4() }, size: { value: new Vector2(w, h) }, blast: { value: new Vector3() } },
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: MaxEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
    })
    this.passMesh = new Mesh(this.quad, this.albedoMat)
    this.passMesh.frustumCulled = false
    this.passScene.add(this.passMesh)
    this.clear(this.albedo)
    this.clear(this.scorch)
  }

  /** The fields and `dIn²` from the wasm buffers (views made **now** — F9): `rect` only, or all of it. */
  uploadFields(view: Uint8Array, din2: Uint16Array, rect: Rect | null): void {
    const r = rect ? clipRect(rect, this.w, this.h) : { x: 0, y: 0, w: this.w, h: this.h }
    if (r.w === 0 || r.h === 0) return
    if (view.length !== this.w * this.h * 4 || din2.length !== this.w * this.h) {
      throw new Error(`terrain fields: views ${view.length} B / ${din2.length} px, want ${this.w * this.h * 4} / ${this.w * this.h}`)
    }
    const gl = this.renderer.getContext() as WebGL2RenderingContext
    const put = (t: DataTexture, align: number, format: number, type: number, data: ArrayBufferView): void => {
      const tex = (this.renderer.properties.get(t) as { __webglTexture?: WebGLTexture }).__webglTexture
      if (!tex) throw new Error('terrain fields: texture not initialised')
      this.renderer.state.bindTexture(gl.TEXTURE_2D, tex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, align)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.w)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, format, type, data)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
    }
    put(this.field, 4, gl.RGBA, gl.UNSIGNED_BYTE, view)
    put(this.din2, 2, gl.RED_INTEGER, gl.UNSIGNED_SHORT, din2)
    this.stats.uploads++
    this.stats.uploadedPx += r.w * r.h
  }

  /** Queue the whole world's albedo, tile by tile (`step` paints them). */
  queueAll(): void {
    this.queue = tilesOf(this.w, this.h)
  }

  /** Repaint the albedo over `r` **now** (a carve's fields rect, grown by `ALBEDO_REACH`). */
  paintNow(r: Rect): Rect {
    const c = clipRect(grow(r, ALBEDO_REACH), this.w, this.h)
    if (c.w > 0 && c.h > 0) {
      this.pass(this.albedo, this.albedoMat, c)
      this.stats.dirtyPaints++
      this.paints.push(c)
    }
    return c
  }

  /** Dev: the rects repainted since the last call. */
  takePaints(): Rect[] {
    const p = this.paints
    this.paints = []
    return p
  }

  /** Paint up to `maxTiles` queued tiles; returns how many are left. */
  step(maxTiles: number): number {
    for (let n = 0; n < maxTiles && this.queue.length > 0; n++) {
      this.pass(this.albedo, this.albedoMat, this.queue.shift() as Rect)
      this.stats.tiles++
    }
    return this.queue.length
  }

  get pending(): number {
    return this.queue.length
  }

  /** A blast at `(x, y)` scorches radius `r`: MAX into the mask, and the albedo under it repainted now. */
  addScorch(x: number, y: number, r: number): Rect {
    const box = clipRect({ x: x - r - 1, y: y - r - 1, w: 2 * r + 3, h: 2 * r + 3 }, this.w, this.h)
    if (box.w === 0 || box.h === 0 || r <= 0) return box
    ;(this.scorchMat.uniforms['rect']!.value as Vector4).set(box.x, box.y, box.x + box.w, box.y + box.h)
    ;(this.scorchMat.uniforms['blast']!.value as Vector3).set(x, y, r)
    this.pass(this.scorch, this.scorchMat, { x: 0, y: 0, w: this.w, h: this.h })
    this.stats.scorches++
    this.lastScorch = [x, y, r]
    return this.paintNow(box)
  }

  /** Dev: the albedo bytes over `r`, rows top-down (row 0 = mask row `r.y`). */
  readAlbedo(r: Rect): Uint8Array {
    const c = clipRect(r, this.w, this.h)
    const out = new Uint8Array(c.w * c.h * 4)
    this.renderer.readRenderTargetPixels(this.albedo, c.x, c.y, c.w, c.h, out)
    return out
  }

  /** Dev (`look-albedo`): the GLSL hash's 10k words (`albedo.ts::HASH_PROBE_FS`), index order. */
  hashProbe(): Uint32Array {
    const n = HASH_PROBE_N
    const rt = new WebGLRenderTarget(n, n, { type: UnsignedByteType, depthBuffer: false })
    const mat = new RawShaderMaterial({ glslVersion: GLSL3, vertexShader: QUAD_VS, fragmentShader: HASH_PROBE_FS, depthTest: false, depthWrite: false })
    this.pass(rt, mat, { x: 0, y: 0, w: n, h: n })
    const px = new Uint8Array(n * n * 4)
    this.renderer.readRenderTargetPixels(rt, 0, 0, n, n, px)
    rt.dispose()
    mat.dispose()
    return new Uint32Array(px.buffer)
  }

  dispose(): void {
    this.field.dispose()
    this.din2.dispose()
    this.albedo.dispose()
    this.scorch.dispose()
    this.albedoMat.dispose()
    this.scorchMat.dispose()
    this.quad.dispose()
  }

  private clear(rt: WebGLRenderTarget): void {
    const r = this.renderer
    const prev = r.getRenderTarget()
    const alpha = r.getClearAlpha()
    const col = r.getClearColor(new Color())
    r.setRenderTarget(rt)
    r.setClearColor(0x000000, 0)
    r.clear(true, false, false)
    r.setClearColor(col, alpha)
    r.setRenderTarget(prev)
  }

  /** Draw `mat` over `rect` of `rt` (viewport and scissor = the rect), no clear. */
  private pass(rt: WebGLRenderTarget, mat: RawShaderMaterial, rect: Rect): void {
    const r = this.renderer
    const prev = r.getRenderTarget()
    const autoClear = r.autoClear
    r.autoClear = false
    rt.viewport.set(rect.x, rect.y, rect.w, rect.h)
    rt.scissor.set(rect.x, rect.y, rect.w, rect.h)
    rt.scissorTest = true
    this.passMesh.material = mat
    r.setRenderTarget(rt)
    r.render(this.passScene, this.cam)
    r.setRenderTarget(prev)
    r.autoClear = autoClear
  }
}
