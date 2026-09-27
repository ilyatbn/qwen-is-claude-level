/**
 * T23.06: the terrain's GPU state — T23.05's fields in **one world-sized RGBA8 texture** (not per
 * chunk: the shaders read ~50 px away and a seam would show), the albedo painted from them into a
 * world-sized RGBA8 target (`albedo.ts`), and the accumulated scorch mask the explosions write.
 * Texel `(x, y)` is world px `(x, y)`, row 0 the mask's row 0, in all three.
 *
 * **Dirty rectangles only.** A carve uploads the rect `render_fields_dirty` returned
 * (`texSubImage2D` straight from the wasm buffer, `UNPACK_ROW_LENGTH` = world width) and repaints
 * that rect grown by `ALBEDO_REACH` at once. The **full** pass is queued (`queueAll`) and done a few
 * units per frame (`step`), so a Large map's 8 M px never land in one frame (T23.06B F6): the fields
 * go up in `STRIP_ROWS`-row strips, and each albedo tile is painted as soon as the strips it reads
 * are up (`fullPassWork`).
 *
 * **Made at map change, uploaded nothing** (F6): the textures are allocated with `texStorage2D` and
 * no data (three's `source.dataReady = false`) — WebGL zero-fills new storage, so neither a 48 MB
 * zero upload nor a clear of the targets is needed.
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

/**
 * One queued albedo tile, px: 256 wide, 128 tall (T23.06B F6). Measured on SwiftShader, Large, low
 * tier (1 unit a frame): 256² tiles over solid rock made 33–37 ms frames (control, three off: 17–18);
 * halving the tile keeps a frame's share of the pass under budget, and the pass is not on screen
 * until it is whole (`TerrainLayer.ready`), so taking more frames costs nothing visible.
 */
export const ALBEDO_TILE_W = 256
export const ALBEDO_TILE_H = 128
/** Rows per queued field-strip upload (a Large strip is 4 MB of fields + 2 MB of `dIn²`). */
export const STRIP_ROWS = 256
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

/** One unit of the queued full pass: a strip of field rows to upload, or an albedo tile to paint. */
export type Work = { strip: { y: number; h: number } } | { tile: Rect }

/**
 * The full pass as work units (T23.06B F6): albedo tiles row-major, each preceded by the field strips
 * it reads that are not up yet — its own rows, the row above, and `ALBEDO_REACH` below (the grass
 * fringe looks 19 px down for its rock).
 */
export function fullPassWork(w: number, h: number): Work[] {
  const out: Work[] = []
  let strips = 0
  const stripsTo = (row: number): void => {
    while (strips * STRIP_ROWS <= row && strips * STRIP_ROWS < h) {
      const y = strips * STRIP_ROWS
      out.push({ strip: { y, h: Math.min(STRIP_ROWS, h - y) } })
      strips++
    }
  }
  for (const t of tilesOf(w, h)) {
    stripsTo(Math.min(h - 1, t.y + t.h - 1 + ALBEDO_REACH))
    out.push({ tile: t })
  }
  stripsTo(h - 1)
  return out
}

/** Every albedo tile of a `w × h` world, row-major. */
export function tilesOf(w: number, h: number): Rect[] {
  const out: Rect[] = []
  for (let y = 0; y < h; y += ALBEDO_TILE_H) {
    for (let x = 0; x < w; x += ALBEDO_TILE_W) out.push({ x, y, w: Math.min(ALBEDO_TILE_W, w - x), h: Math.min(ALBEDO_TILE_H, h - y) })
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
  /**
   * F3: a whole picture has been painted into this GPU side (a full pass finished) — what T23.07
   * waits for before it hides Phaser's rock. Stays true while a same-map resync repaints it.
   */
  painted = false
  private queue: Work[] = []
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
    // F6: storage only (`texStorage2D`, no data) — `uploadFields` writes it, strip by strip.
    this.field = new DataTexture(null, w, h, RGBAFormat, UnsignedByteType)
    this.field.minFilter = this.field.magFilter = LinearFilter
    this.field.generateMipmaps = false
    this.field.flipY = false
    this.field.source.dataReady = false
    this.field.needsUpdate = true
    renderer.initTexture(this.field)
    this.din2 = new DataTexture(null, w, h, RedIntegerFormat, UnsignedShortType)
    this.din2.internalFormat = 'R16UI'
    this.din2.minFilter = this.din2.magFilter = NearestFilter
    this.din2.generateMipmaps = false
    this.din2.flipY = false
    this.din2.unpackAlignment = 2
    this.din2.source.dataReady = false
    this.din2.needsUpdate = true
    renderer.initTexture(this.din2)
    const target = (format: typeof RGBAFormat | typeof RedFormat): WebGLRenderTarget => {
      const t = new WebGLRenderTarget(w, h, { format, type: UnsignedByteType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false })
      renderer.initRenderTarget(t) // allocated now (zero-filled by WebGL), not on the first paint
      return t
    }
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
    this.touch()
    this.warm()
  }

  /**
   * F6: **draw each pass once now, 1 px, at the map change.** Measured (each queued unit finished on
   * the GPU): the first albedo tile after the install cost 81–84 ms on SwiftShader and every later one
   * 4 ms — the driver builds the draw's pipeline on its first use with these textures bound, and
   * `renderer.compile` (link only) did not move it. Px (0, 0) of the albedo is written here and
   * repainted by its tile; the scorch pass draws a radius-0 blast, which writes 0 under MAX.
   */
  private warm(): void {
    const px = { x: 0, y: 0, w: 1, h: 1 }
    this.pass(this.albedo, this.albedoMat, px)
    ;(this.scorchMat.uniforms['rect']!.value as Vector4).set(0, 0, 1, 1)
    ;(this.scorchMat.uniforms['blast']!.value as Vector3).set(0, 0, 0)
    this.pass(this.scorch, this.scorchMat, px)
  }

  /** Dev (F5): the GPU bytes this side holds — fields RGBA8 + `dIn²` R16 + albedo RGBA8 + scorch R8. */
  get bytes(): number {
    return this.w * this.h * (4 + 2 + 4 + 1)
  }

  /** The fields and `dIn²` from the wasm buffers (views made **now** — F9): `rect` only, or all of it. */
  uploadFields(view: Uint8Array, din2: Uint16Array, rect: Rect | null): void {
    const r = rect ? clipRect(rect, this.w, this.h) : { x: 0, y: 0, w: this.w, h: this.h }
    if (r.w === 0 || r.h === 0) return
    if (view.length !== this.w * this.h * 4 || din2.length !== this.w * this.h) {
      throw new Error(`terrain fields: views ${view.length} B / ${din2.length} px, want ${this.w * this.h * 4} / ${this.w * this.h}`)
    }
    const gl = this.renderer.getContext() as WebGL2RenderingContext
    this.put(this.field, 4, gl.RGBA, gl.UNSIGNED_BYTE, view, r, true)
    this.put(this.din2, 2, gl.RED_INTEGER, gl.UNSIGNED_SHORT, din2, r, true)
    this.stats.uploads++
    this.stats.uploadedPx += r.w * r.h
  }

  /**
   * `texSubImage2D` of rect `r` of `t` from `data`: a whole world-sized buffer (`world`: read at `r`,
   * `UNPACK_ROW_LENGTH` = the world's width), or exactly `r`'s texels.
   */
  private put(t: DataTexture, align: number, format: number, type: number, data: ArrayBufferView, r: Rect, world: boolean): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext
    const tex = (this.renderer.properties.get(t) as { __webglTexture?: WebGLTexture }).__webglTexture
    if (!tex) throw new Error('terrain fields: texture not initialised')
    this.renderer.state.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, align)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, world ? this.w : 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, world ? r.x : 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, world ? r.y : 0)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, format, type, data)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
  }

  /**
   * F6: **pay Chrome's lazy clear now, at the map change.** Its GPU process zero-fills a texture on
   * the first partial upload or draw into it, not at allocation — measured: with nothing touched
   * here, the install's first strip frame took 117–123 ms on SwiftShader (88 MB cleared) while the
   * pump itself took 2–8 ms. A 1-px upload into each field texture and a clear of each target move
   * that into the map change, which already hitches (map load, Phaser's bake).
   */
  private touch(): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext
    const px = { x: 0, y: 0, w: 1, h: 1 }
    this.put(this.field, 4, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4), px, false)
    this.put(this.din2, 2, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(2), px, false)
    const r = this.renderer
    const prev = r.getRenderTarget()
    const alpha = r.getClearAlpha()
    const col = r.getClearColor(new Color())
    r.setClearColor(0x000000, 0) // the scorch mask must read 0: no blast yet
    for (const rt of [this.albedo, this.scorch]) {
      r.setRenderTarget(rt)
      r.clear(true, false, false)
    }
    r.setClearColor(col, alpha)
    r.setRenderTarget(prev)
  }

  /** Queue the full pass — field strips and albedo tiles, interleaved (`fullPassWork`); `step` does them. */
  queueAll(): void {
    this.queue = fullPassWork(this.w, this.h)
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

  /**
   * Do up to `units` queued units (a strip upload or a tile paint each; the strips read fresh views
   * from `fields` — F9); returns how many are left. A finished queue marks the picture `painted`.
   */
  step(units: number, fields: () => { view: Uint8Array; din2: Uint16Array } | null): number {
    for (let n = 0; n < units && this.queue.length > 0; n++) {
      const u = this.queue.shift() as Work
      if ('strip' in u) {
        const f = fields()
        if (f) this.uploadFields(f.view, f.din2, { x: 0, y: u.strip.y, w: this.w, h: u.strip.h })
      } else {
        this.pass(this.albedo, this.albedoMat, u.tile)
        this.stats.tiles++
      }
    }
    if (this.queue.length === 0) this.painted = true
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
