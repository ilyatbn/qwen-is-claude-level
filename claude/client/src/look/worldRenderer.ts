/**
 * T23.03 (R1, R11, R14): three.js draws the world, on its own canvas **under** Phaser's.
 *
 * Phaser keeps scenes, input, camera, audio and UI; its canvas is transparent (`main.ts`), and
 * this renderer's canvas sits beneath it, sized to the same box. Phaser's camera is the only
 * source of truth: each drawn frame `driveFromScene` hands this renderer the camera's view
 * **after** `Camera.preRender` (the `living-sky` trap — see `renderer.ts`; derived unrounded,
 * `renderer.ts::viewOf`), and it copies that into an ortho camera in the mockup's y-up mask
 * space (`worldRenderer-math.ts`). **Resolution (R18):** the drawing buffer is Phaser's game
 * resolution × the tier's scale, never `devicePixelRatio` — the pictures' `setPixelRatio(1)`.
 *
 * The post chain is the mockup's skeleton (`kit.js::post`): a half-float target with 4× MSAA
 * (full tier; the low tier renders the whole canvas at half resolution and drops MSAA) → `OutputPass` (ACES at `look.exposure`,
 * then sRGB). Bloom and the grade come in T23.08.
 *
 * **What it draws: the sky** (T23.04, `skyMaterial.ts` — the mockup's `bgQuad`), its layers
 * moved per frame by their parallax offsets (`skyLayout.ts::skyOffsets`, from the same view the
 * ortho camera is laid out from); baked once per sky and tier, composited per frame (T23.04B, R21). No sky in space (`look.bg` null): T22.06's backdrop draws there
 * until T23.20. `createWorldRenderer` is the single constructor the look-lab, `GameScene`,
 * `SandboxScene` and `TitleScene` call.
 */
import type Phaser from 'phaser'
import {
  ACESFilmicToneMapping,
  Color,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  GLSL3,
  SRGBColorSpace,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { devSurface } from '../dev'
import { detectTier, onHighQualityChange, qualityTier, rendererString } from '../ui/settings'
import { StubRenderer, driveFromScene, sceneCounts, type RenderStats, type SceneRenderer } from './renderer'
import type { Background, SceneDescription, ViewRect } from './scene'
import { F1 } from './scenes/F1'
import { SkyQuad } from './skyMaterial'
import { gameSky, skyOffsets, type Offset } from './skyLayout'
import { exposeWorldHandle } from './worldHandle'
import { TerrainGpu, type Rect } from './terrainGpu'
import type { TerrainFeed } from './terrainFields'
import { TIER_SAMPLES, bufferFor, mustDraw, orthoFromView, toWorld, type QualityTier } from './worldRenderer-math'

/**
 * A layer of the world, and whether it changes on its own (T23.03B, F3). An animated layer —
 * T23.04's stars, a flickering light — ends the redraw skip (`mustDraw`): an unchanged view of
 * it is **not** an unchanged picture. Declared here, where the layer is added, so the skip
 * cannot be taught about it by a second list somewhere else.
 */
interface Layer {
  readonly object: Object3D
  readonly animated: boolean
}

/**
 * **R22: one three.js renderer for the page's lifetime** (T23.04C). Every scene that draws the world
 * — the title since T23.04, every match and rematch, the sandbox, the look-lab — used to build its
 * own `WebGLRenderer`, and `destroy()` never released the context: the review measured live
 * contexts 5 → 16 and GPU memory 343 → 933 MB over ten title ↔ match cycles, and at 17 Chrome
 * dropped the oldest context — Phaser's, a white page. So the renderer, its canvas and its context
 * are made once, by the first scene that asks, and never torn down; a `WorldRenderer` borrows them
 * (`owner`), re-parents the canvas under its scene's Phaser canvas, and on shutdown disposes only what
 * it created (bakes, post targets, materials, geometries) and takes the canvas off the page.
 */
interface PageRenderer {
  readonly renderer: WebGLRenderer
  readonly canvas: HTMLCanvasElement
  /** The scene's renderer drawing into it now; a displaced one draws nothing. */
  owner: WorldRenderer | null
}
let pageRenderer: PageRenderer | null = null
/** Why the page cannot have one (no WebGL2): asked once, so a machine without it is told once. */
let pageUnavailable: string | null = null

/**
 * The page's renderer, made on first use. The context is asked for here, with the attributes three
 * 0.170 asks for with these options, so a machine without WebGL2 gets one plain error instead of
 * three's `console.error` on every scene start (T23.04C F8); three is then handed that context.
 */
function thePageRenderer(): PageRenderer {
  if (pageRenderer) return pageRenderer
  if (pageUnavailable !== null) throw new Error(pageUnavailable)
  const canvas = document.createElement('canvas')
  canvas.dataset['world'] = 'three'
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    depth: true,
    stencil: false,
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false,
  })
  if (!gl) {
    pageUnavailable = 'no WebGL2 context for the world canvas'
    throw new Error(pageUnavailable)
  }
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ canvas, context: gl, antialias: false, alpha: false, powerPreference: 'high-performance' })
  } catch (e) {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    pageUnavailable = String(e)
    throw e
  }
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.outputColorSpace = SRGBColorSpace
  renderer.setPixelRatio(1)
  pageRenderer = { renderer, canvas, owner: null }
  return pageRenderer
}

export class WorldRenderer implements SceneRenderer {
  readonly backend = 'three' as const
  readonly stats: RenderStats & { skipped: number } = { frames: 0, view: null, scene: null, skipped: 0 }
  /** Set by anything that changes the picture other than the view: a scene, a marker. */
  private dirty = true
  readonly canvas: HTMLCanvasElement

  private readonly renderer: WebGLRenderer
  private readonly scene3 = new Scene()
  private readonly camera = new OrthographicCamera(0, 1, 1, 0, -2000, 2000)
  private readonly sky = new SkyQuad()
  /** The parallax offsets the last drawn frame used (screen px), for the dev handle. */
  private drawnOffsets: { layers: Offset[]; horizon: Offset } = { layers: [], horizon: [0, 0] }
  private composer: EffectComposer
  private desc: SceneDescription | null = null
  private tier: QualityTier
  /** Phaser's CSS box as last applied to this canvas (fractional — `getBoundingClientRect`). */
  private box = { left: NaN, top: NaN, w: NaN, h: NaN }
  /** The drawing buffer as last allocated (R18: Phaser's game resolution × the tier's scale). */
  private buf = { w: 0, h: 0 }
  private readonly layers: Layer[] = []
  private readonly markers: Mesh[] = []
  private readonly unsubscribe: () => void
  /**
   * T23.06: the terrain fields this scene feeds (`terrainFields.ts`), and their GPU side — made on
   * the first thing to draw (the fields' install, or a blast before it), sized to the feed.
   */
  private feed: TerrainFeed | null = null
  private terrain: TerrainGpu | null = null
  /** Albedo tiles painted per drawn frame while the full pass is queued (the look-lab: all). */
  private albedoTiles = 0
  /** T23.06: draw the albedo flat instead of the world (the look-lab's `only=albedo`, a dev view). */
  private albedoView: { scene: Scene; mesh: Mesh<PlaneGeometry, ShaderMaterial> } | null = null
  /** Dev: the last dirty update's cost (upload + repaint; with `measureTerrain`, until the GPU is done), ms. */
  private lastTerrainMs = NaN
  private maxTerrainMs = 0
  /** Dev: finish each dirty update on the GPU (a 1-px readback) so `lastUpdateMs` includes its work. */
  measureTerrain = false

  /**
   * @param phaserCanvas the canvas this one goes under — same parent, same box.
   * Throws where WebGL2 is missing (three 0.170 has no other path); `createWorldRenderer` catches.
   * Takes the page's one renderer (R22) from whichever scene had it.
   */
  constructor(private readonly phaserCanvas: HTMLCanvasElement) {
    const page = thePageRenderer()
    if (page.owner) console.warn('WorldRenderer: a second scene took the world canvas before the first shut down')
    page.owner = this
    this.canvas = page.canvas
    this.renderer = page.renderer
    this.camera.position.z = 1000
    // Static: `bgMaterial` has no clock (stars a hash grid, rays a function of angle), so an
    // unchanged view is an unchanged sky and the redraw skip stands (skyMaterial.ts).
    this.addLayer({ object: this.sky.mesh, animated: false })
    // R20: the tier this machine gets when the player has never chosen is read from this
    // renderer's own context — the GPU that will actually draw the world.
    this.tier = qualityTier(this.gl)
    this.composer = this.buildComposer()
    this.mount()
    this.unsubscribe = onHighQualityChange(() => this.setTier(qualityTier(this.gl)))
  }

  private addLayer(l: Layer): void {
    this.layers.push(l)
    this.scene3.add(l.object)
    this.dirty = true
  }

  /** F3: does anything drawn change on its own? Then every frame is drawn. */
  get animated(): boolean {
    return this.layers.some((l) => l.animated)
  }

  /**
   * Under Phaser's canvas: the same parent, absolutely positioned on Phaser's box, `z-index: -1`.
   *
   * **After Phaser's canvas in the DOM, below it in paint order.** Thirty-two browser checks
   * take `document.querySelector('canvas')` to be the game's canvas (its box, its 2D context on
   * the Canvas renderer); inserting this one first would hand them a WebGL canvas with
   * `pointer-events: none`. So the parent becomes a stacking context (`position: relative`,
   * `isolation: isolate`) and this canvas paints first inside it, beneath the in-flow Phaser
   * canvas, which is left exactly as Phaser styles it. `#game` is the body's first child and
   * the DOM UI is appended after it, so the UI still paints over both.
   */
  private mount(): void {
    const parent = this.phaserCanvas.parentElement
    if (!parent) throw new Error('WorldRenderer: Phaser canvas has no parent element')
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
    parent.style.isolation = 'isolate'
    Object.assign(this.canvas.style, { position: 'absolute', zIndex: '-1', pointerEvents: 'none', display: 'block' })
    this.phaserCanvas.after(this.canvas)
    this.syncBox()
  }

  /**
   * Follow Phaser's box, and size the drawing buffer — once each, here.
   *
   * **The box** (Scale.FIT moves and resizes Phaser's canvas) is read with
   * `getBoundingClientRect`, fractional (T23.03B, F5): FIT at 1100×900 gives Phaser a
   * 1100×618.75 box at top 140.625, and `clientHeight`/`offsetTop` would round this canvas to
   * 619 at 140 — a quarter-pixel stretch and a sub-pixel shift. Positioned relative to the
   * parent's padding box, which is what `position: absolute` resolves against.
   *
   * **The buffer** is R18's: Phaser's game resolution × the tier's scale, never the CSS box ×
   * `devicePixelRatio`. So a window resize changes only the CSS box, exactly as it does for
   * Phaser's canvas, and never reallocates the buffer; a tier switch does. A reallocated buffer
   * is blank, so it marks the frame dirty (the redraw skip must not keep "the last picture").
   * R14's low tier renders the **whole** canvas at half resolution and lets CSS scale it up —
   * the mockup's own `kit.js::makeRenderer({ scale: 2 })`; measured on the checks' SwiftShader
   * (sandbox, seed 4242): halving only the post target cost 60 → 47 fps and put `birds`' aim out.
   */
  private syncBox(): void {
    // The canvas and its buffer are the page's (R22): only the scene drawing into them sizes them.
    if (!this.owns) return
    const p = this.phaserCanvas
    const parent = p.parentElement
    const r = p.getBoundingClientRect()
    const pr = parent?.getBoundingClientRect()
    const box = {
      left: r.left - (pr?.left ?? 0) - (parent?.clientLeft ?? 0),
      top: r.top - (pr?.top ?? 0) - (parent?.clientTop ?? 0),
      w: r.width,
      h: r.height,
    }
    const b = this.box
    if (box.left !== b.left || box.top !== b.top || box.w !== b.w || box.h !== b.h) {
      this.box = box
      Object.assign(this.canvas.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.w}px`, height: `${box.h}px` })
    }
    const buf = bufferFor(p.width, p.height, this.tier)
    if (buf.w === this.buf.w && buf.h === this.buf.h) return
    this.buf = buf
    this.renderer.setSize(buf.w, buf.h, false)
    this.composer.setPixelRatio(1)
    this.composer.setSize(buf.w, buf.h)
    // T23.06: allocate both ping-pong targets now. three allocates a target on first use, and the
    // composer first writes its second one on its second drawn frame — so a scene that drew once
    // held one texture fewer than one that drew twice, and `context-budget`'s "the same memory at
    // every title" read the redraw skip's frame count (measured: 10 textures ⇔ 1 frame, 11 ⇔ 2,
    // 20/20 titles), which the terrain's round-start work moved.
    this.renderer.initRenderTarget(this.composer.renderTarget1)
    this.renderer.initRenderTarget(this.composer.renderTarget2)
    this.dirty = true
  }

  private buildComposer(): EffectComposer {
    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: TIER_SAMPLES[this.tier] })
    const c = new EffectComposer(this.renderer, rt)
    c.addPass(new RenderPass(this.scene3, this.camera))
    c.addPass(new OutputPass())
    return c
  }

  /** R22: this scene's composer — its two targets, its copy pass **and** its passes (`EffectComposer.dispose` leaves those). */
  private disposeComposer(): void {
    for (const p of this.composer.passes) p.dispose()
    this.composer.dispose()
  }

  /** R22: whether this scene is the one drawing into the page's canvas. */
  private get owns(): boolean {
    return pageRenderer?.owner === this
  }

  /** R14: switch tier live — rebuild the target (MSAA samples are fixed at creation) and resize. */
  setTier(tier: QualityTier): void {
    if (tier === this.tier) return
    this.tier = tier
    this.disposeComposer()
    this.composer = this.buildComposer()
    this.buf = { w: 0, h: 0 }
    this.syncBox()
  }

  setScene(desc: SceneDescription): void {
    this.desc = desc
    this.dirty = true
    this.stats.scene = sceneCounts(desc)
    this.sky.setSky(desc.look.bg)
  }

  render(view: ViewRect): void {
    if (!this.desc || !this.owns) return
    this.syncBox()
    this.pumpTerrain()
    // An unchanged view of an unchanged, unanimated scene is an unchanged picture: the canvas
    // keeps showing the last one (`mustDraw`). Measured on the checks' SwiftShader in a match:
    // drawing every frame cost 60 → 51 fps and turned `birds` red (1/5 green; 3/3 with the
    // renderer off). An animated layer draws every frame (F3) — that cost returns with T23.04.
    if (!mustDraw({ dirty: this.dirty, animated: this.animated, last: this.stats.view, view })) {
      this.stats.skipped++
      return
    }
    this.dirty = false
    // The renderer is the page's (R22): this scene's exposure is set on it every frame it draws.
    this.renderer.toneMappingExposure = this.desc.look.exposure
    const o = orthoFromView(view, this.desc.world.h)
    this.camera.left = o.left
    this.camera.right = o.right
    this.camera.top = o.top
    this.camera.bottom = o.bottom
    this.camera.updateProjectionMatrix()
    const bg = this.desc.look.bg
    if (bg) {
      // The same view the camera was just laid out from, so the bands move in the frame they are drawn in.
      const frame: [number, number] = [this.phaserCanvas.width, this.phaserCanvas.height]
      // T23.04B (R21): shaded once per sky, tier and extent — a pan only moves the bakes, by
      // whole baked texels.
      const offsets = skyOffsets(bg, view, this.desc.world, frame[0])
      this.drawnOffsets = this.sky.place(this.renderer, view, this.desc.world, frame, [this.buf.w, this.buf.h], offsets)
    }
    if (this.albedoView) {
      this.renderer.setRenderTarget(null)
      this.renderer.render(this.albedoView.scene, this.camera)
    } else {
      this.composer.render()
    }
    this.stats.frames++
    this.stats.view = { ...view }
  }

  /**
   * T23.06: hand over the scene's terrain fields (`null`: none — a new map, or the title). Tiles:
   * albedo tiles painted per frame while a full pass is queued. The old GPU side is disposed (R22:
   * scene-owned) and the new one is made when there is something to draw.
   */
  setTerrain(feed: TerrainFeed | null, tiles: number): void {
    this.terrain?.dispose()
    this.terrain = null
    this.feed = feed
    this.albedoTiles = tiles
    this.dirty = true
  }

  /** Apply what changed in the fields since the last frame; paint a few queued albedo tiles. */
  private pumpTerrain(): void {
    const feed = this.feed
    if (!feed) return
    const t = feed.take()
    if (!this.terrain && !feed.ready && t.scorches.length === 0) return
    if (!this.terrain || this.terrain.w !== feed.w || this.terrain.h !== feed.h) {
      this.terrain?.dispose()
      this.terrain = new TerrainGpu(this.renderer, feed.w, feed.h)
      if (this.albedoView) this.albedoView.mesh.material.uniforms['albedo']!.value = this.terrain.albedo.texture
      // A new GPU side has no fields: upload them whole if they are in.
      if (feed.ready) t.full = true
    }
    const g = this.terrain
    let changed = t.full || t.rects.length > 0 || t.scorches.length > 0
    const t0 = performance.now()
    if (t.full) {
      const v = feed.view()
      const d = feed.din2()
      if (v && d) {
        g.uploadFields(v, d, null)
        g.queueAll()
      }
    }
    for (const r of t.rects) {
      // Fresh views per upload: nothing here allocates in wasm, but a kept view is F9's bug.
      const v = feed.view()
      const d = feed.din2()
      if (!v || !d) continue
      g.uploadFields(v, d, r)
      g.paintNow(r)
    }
    for (const [x, y, r] of t.scorches) g.addScorch(x, y, r)
    if (t.rects.length || t.scorches.length) {
      // Dev: finish the GPU's work before the clock stops, so the number includes it.
      if (this.measureTerrain) this.renderer.readRenderTargetPixels(g.albedo, 0, 0, 1, 1, new Uint8Array(4))
      this.lastTerrainMs = performance.now() - t0
      this.maxTerrainMs = Math.max(this.maxTerrainMs, this.lastTerrainMs)
    }
    if (g.pending > 0) {
      g.step(this.albedoTiles)
      changed = true
    }
    if (changed && this.albedoView) this.dirty = true
  }

  /** T23.06 dev/look-lab: draw the albedo flat (sRGB bytes straight to the canvas, air black) instead of the world. */
  showAlbedo(on: boolean): void {
    if (!on) {
      if (this.albedoView) {
        this.albedoView.mesh.geometry.dispose()
        this.albedoView.mesh.material.dispose()
      }
      this.albedoView = null
      this.dirty = true
      return
    }
    if (this.albedoView || !this.desc) return
    const w = this.feed?.w ?? this.desc.world.w
    const h = this.feed?.h ?? this.desc.world.h
    const mat = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: { albedo: { value: this.terrain?.albedo.texture ?? null }, size: { value: [w, h] } },
      vertexShader: /* glsl */ `
        uniform vec2 size; out vec2 px;
        void main() { px = vec2(uv.x, 1.0 - uv.y) * size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float; uniform sampler2D albedo; in vec2 px; out vec4 fragColor;
        void main() {
          vec4 a = texelFetch(albedo, ivec2(floor(px)), 0);
          fragColor = a.a > 0.0 ? vec4(a.rgb, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    })
    const mesh = new Mesh(new PlaneGeometry(w, h), mat)
    const c = toWorld(w / 2, h / 2, this.desc.world.h)
    mesh.position.set(c.x, c.y, 0)
    mesh.frustumCulled = false
    const scene = new Scene()
    scene.add(mesh)
    this.albedoView = { scene, mesh }
    this.dirty = true
  }

  /** T23.06 dev: the terrain's state — whether the fields are in, tiles left, counts, the last update's cost. */
  terrainInfo(): {
    fields: boolean
    gpu: boolean
    pending: number
    lastUpdateMs: number
    maxUpdateMs: number
    albedoView: boolean
    w: number
    h: number
    lastScorch: [number, number, number] | null
    feed: Readonly<Record<string, number | string>> | null
  } & TerrainGpu['stats'] {
    const g = this.terrain
    return {
      fields: this.feed?.ready ?? false,
      gpu: !!g,
      pending: g?.pending ?? 0,
      lastUpdateMs: this.lastTerrainMs,
      maxUpdateMs: this.maxTerrainMs,
      lastScorch: g?.lastScorch ?? null,
      feed: this.feed?.stats ?? null,
      albedoView: !!this.albedoView,
      w: this.feed?.w ?? 0,
      h: this.feed?.h ?? 0,
      ...(g?.stats ?? { tiles: 0, dirtyPaints: 0, scorches: 0, uploads: 0, uploadedPx: 0 }),
    }
  }

  /**
   * T23.06 dev: the from-scratch control an incremental update is compared with — every field
   * re-uploaded from the wasm buffers, then the whole albedo repainted, now.
   */
  repaintAlbedo(): void {
    const v = this.feed?.view()
    const d = this.feed?.din2()
    if (!this.terrain || !v || !d) return
    this.terrain.uploadFields(v, d, null)
    this.terrain.queueAll()
    this.terrain.step(Infinity)
  }

  /** T23.06 dev: the albedo rects repainted since the last call. */
  takeAlbedoPaints(): Rect[] {
    return this.terrain?.takePaints() ?? []
  }

  /** T23.06 dev: albedo bytes over a world rect (rows top-down), null without a GPU side. */
  readAlbedo(r: Rect): Uint8Array | null {
    return this.terrain?.readAlbedo(r) ?? null
  }

  /** T23.06 dev: the GLSL hash's 10k words (`albedo.ts::HASH_PROBE_FS`). */
  hashProbe(): Uint32Array {
    const g = this.terrain ?? new TerrainGpu(this.renderer, 1, 1)
    const out = g.hashProbe()
    if (g !== this.terrain) g.dispose()
    return out
  }

  /** Redraw on the next frame even if nothing changed. */
  invalidate(): void {
    this.dirty = true
  }

  /**
   * Dev (T23.04B): the GPU cost of one drawn frame, ms — `n` frames drawn back to back, each
   * with the view moved 1 px (so nothing is skipped and the sky's offsets change as they do when
   * the camera pans), each finished by a 1-px readback so the time includes the GPU's work.
   */
  timeDraws(n: number): { frames: number; ms: number; perFrame: number } | null {
    const v = this.stats.view
    if (!this.desc || !v) return null
    const gl = this.gl
    const px = new Uint8Array(4)
    const t0 = performance.now()
    for (let i = 0; i < n; i++) {
      this.dirty = true
      this.render({ ...v, x: v.x + ((i % 2) * 2 - 1) * (1 + i) })
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    }
    const ms = performance.now() - t0
    this.dirty = true
    this.render(v)
    return { frames: n, ms, perFrame: ms / n }
  }

  /** Dev: a flat magenta quad anchored in the world at mask px `x, y` (top-left), `w × h`. */
  addMarker(x: number, y: number, w: number, h: number): void {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(1, 0, 1) }))
    const c = toWorld(x + w / 2, y + h / 2, this.desc?.world.h ?? 0)
    m.position.set(c.x, c.y, 0)
    this.markers.push(m)
    this.scene3.add(m)
    this.dirty = true
  }

  /** Dev (`look-sky`): draw only the sky layers not listed — one band isolated at a time. */
  hideSkyLayers(hide: number[]): void {
    this.sky.hideLayers(hide)
    this.dirty = true
  }

  /** Dev: the sky as last drawn — its layers' factors and periods, and the offsets that frame used. */
  skyInfo(): { drawn: boolean; hidden: number[]; layers: { parallax: number; period: number }[]; offsets: Offset[]; horizon: Offset } {
    const bg = this.desc?.look.bg ?? null
    return {
      drawn: this.sky.mesh.visible,
      hidden: this.sky.hiddenLayers,
      layers: (bg?.layers ?? []).map((l) => ({ parallax: l.parallax ?? 0, period: l.period ?? 0 })),
      offsets: this.drawnOffsets.layers.map((o) => [o[0], o[1]]),
      horizon: [this.drawnOffsets.horizon[0], this.drawnOffsets.horizon[1]],
    }
  }

  /** Dev: remove every marker (a check measuring twice on one page must find only its own). */
  clearMarkers(): void {
    // Only a picture that had markers changes: an empty clear must not redraw, or a check that
    // clears before measuring an invalidation would supply the redraw it is measuring.
    if (this.markers.length) this.dirty = true
    for (const m of this.markers) {
      this.scene3.remove(m)
      m.geometry.dispose()
      ;(m.material as MeshBasicMaterial).dispose()
    }
    this.markers.length = 0
  }

  /**
   * `display`: Phaser's drawing buffer (the game resolution, R18); `buffer`: this canvas's drawing
   * buffer; `target`: the post chain's; `gpu`: the renderer string the tier would be detected
   * from (R20); `animated`: whether the redraw skip is off (F3).
   */
  info(): {
    tier: QualityTier
    gpu: string
    display: [number, number]
    buffer: [number, number]
    target: [number, number]
    samples: number
    exposure: number
    animated: boolean
    /** T23.04: whether the sky is drawn (false on a space map). */
    sky: boolean
    /** T23.04B (R21): sky bakes made so far, and the bytes the current bakes hold. */
    skyBakes: number
    skyBakeBytes: number
    /** T23.04C (R22): what three holds on the page's one context — the same at every title and every match, or a scene leaked. */
    memory: { geometries: number; textures: number; programs: number }
  } {
    const rt = this.composer.renderTarget1
    const gl = this.gl
    return {
      tier: this.tier,
      gpu: rendererString(gl),
      display: [this.phaserCanvas.width, this.phaserCanvas.height],
      buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      target: [rt.width, rt.height],
      samples: rt.samples,
      exposure: this.desc?.look.exposure ?? this.renderer.toneMappingExposure,
      animated: this.animated,
      sky: this.sky.mesh.visible,
      skyBakes: this.sky.bakeStats.bakes,
      skyBakeBytes: this.sky.bakeStats.bytes,
      memory: {
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        programs: this.renderer.info.programs?.length ?? 0,
      },
    }
  }

  /** The WebGL context, for a check's same-frame readback. */
  get gl(): WebGL2RenderingContext {
    return this.renderer.getContext() as WebGL2RenderingContext
  }

  destroy(): void {
    this.unsubscribe()
    for (const m of this.markers) {
      m.geometry.dispose()
      ;(m.material as MeshBasicMaterial).dispose()
    }
    this.sky.dispose()
    this.showAlbedo(false)
    this.terrain?.dispose()
    this.terrain = null
    this.feed = null
    this.disposeComposer()
    // R22: the renderer and its context are the page's and outlive this scene. Its canvas leaves
    // the page cleared, so the next scene never shows this one's last picture before it draws.
    if (this.owns && pageRenderer) {
      this.renderer.setRenderTarget(null)
      this.renderer.clear()
      this.canvas.remove()
      pageRenderer.owner = null
    }
  }
}

/** What the game scenes tell the world renderer about the map (T23.04: its seed and whether it is space). */
export interface GameMap {
  w: number
  h: number
  /** The map seed's low 32 bits — `welcome`'s in a match, so every client of a round lays out one sky. */
  seed: number
  /** A space map (`MapGenerator.Space`): no sky is drawn; T22.06's backdrop is (until T23.20). */
  space: boolean
}

/**
 * The game's scene description until the sim fills more of it: F1's night look (R7 — T23.11
 * blends it with F5's by darkness) with its sky laid out as seeded parallax bands for this map
 * (`skyLayout.ts::gameSky`), none on a space map; the map's size for the y flip; no mask yet
 * (T23.07), no actors (T23.12+). Rebuild it when the map changes.
 */
export function gameDescription(map: GameMap): SceneDescription {
  const f1 = F1.look.bg as Background
  return {
    id: 'game',
    camera: { x: 0, y: 0, w: map.w, h: map.h },
    world: { w: map.w, h: map.h },
    masks: null,
    look: { ...F1.look, bg: map.space ? null : gameSky(map.seed, f1) },
    palette: F1.palette,
    actors: [],
    fx: [],
    labels: [],
    hud: null,
  }
}

/** The game scenes' world renderer, re-described when the map changes. */
export interface GameWorld {
  readonly renderer: SceneRenderer
  /** `map_init` / a regenerated sandbox map: describe the new map. */
  mapChanged(map: GameMap): void
  /** R20: the tier detected on this renderer's GPU (the options panel's "Auto (…)"); low where three did not start. */
  detectedTier(): QualityTier
  /**
   * T23.06: the map's terrain fields (`null` on a new map until the scene has them). Painted into
   * the albedo, not yet shown — the lit terrain is T23.07; Phaser's terrain draws the rock until then.
   */
  setTerrain(feed: TerrainFeed | null): void
}

/** T23.06: albedo tiles painted per frame in the game while the round-start pass is queued (measured: `look-albedo`). */
export const GAME_ALBEDO_TILES: Record<QualityTier, number> = { full: 4, low: 1 }

/**
 * `GameScene`, `SandboxScene` and `TitleScene`'s entry point (T23.03B, F10): they load this
 * module on demand (`loadWorldRenderer.ts`), so they cannot import `gameDescription` from it statically.
 */
export function createGameWorld(scene: Phaser.Scene, map: GameMap): GameWorld {
  const renderer = createWorldRenderer(scene, gameDescription(map))
  return {
    renderer,
    mapChanged: (m) => renderer.setScene(gameDescription(m)),
    setTerrain: (feed) => {
      if (renderer instanceof WorldRenderer) renderer.setTerrain(feed, GAME_ALBEDO_TILES[renderer.info().tier])
    },
    detectedTier: () => detectTier(renderer instanceof WorldRenderer ? renderer.gl : null),
  }
}

/**
 * The one constructor (step 4): a three.js world renderer under `scene`'s Phaser canvas, fed
 * `desc` and driven from its main camera each drawn frame; torn down on the scene's shutdown.
 *
 * Falls back to the draw-nothing `StubRenderer` where three cannot start (no WebGL2 — R2's
 * message is not enforced yet, see `webgl2.ts`) and, on the dev surface only, for `?world=off`:
 * the control a check runs to prove it is measuring this renderer.
 */
export function createWorldRenderer(scene: Phaser.Scene, desc: SceneDescription): SceneRenderer {
  let r: SceneRenderer
  const off = devSurface() && new URLSearchParams(location.search).get('world') === 'off'
  try {
    r = off ? new StubRenderer() : new WorldRenderer(scene.game.canvas)
  } catch (e) {
    console.warn('WorldRenderer unavailable, the world is not drawn by three.js:', e)
    r = new StubRenderer()
  }
  r.setScene(desc)
  driveFromScene(scene, r)
  scene.events.once('shutdown', () => r.destroy())
  if (devSurface()) exposeWorldHandle(scene, r, r instanceof WorldRenderer ? r : null)
  return r
}

