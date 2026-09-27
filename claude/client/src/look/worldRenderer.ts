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
import type { TerrainFeed } from './terrainFields'
import { TerrainLayer } from './terrainLayer'
import { disposeAlbedoView, makeAlbedoView, syncAlbedoView, type AlbedoView } from './terrainDev'
import { makeTerrainMaterials, setLights, setLook, setTextures } from './terrainMaterial'
import { pickLights } from './terrainLights'
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
   * T23.06: the terrain fields this scene feeds and their GPU side (`terrainLayer.ts`) — scene-owned
   * (R22), made at the map change, kept across a same-map resync, `ready` once the picture is whole.
   */
  readonly terrain: TerrainLayer
  /** T23.06: draw the albedo flat instead of the world (the look-lab's `only=albedo`, a dev view — `terrainDev.ts`). */
  private albedoView: AlbedoView | null = null
  /**
   * T23.07: the lit terrain — one world-sized quad, the full tier's material or the low tier's
   * (`terrainMaterial.ts`, R14), drawn once the fields are whole (`terrain.ready`) and the scene asks
   * for it (`litTerrain`). Static: a light that moves (T23.09) marks the frame dirty itself.
   */
  private readonly terrainMats = makeTerrainMaterials()
  private readonly terrainMesh = new Mesh(new PlaneGeometry(1, 1), this.terrainMats.full)
  /** Dev (`look-terrain`): the lights and material the last drawn frame used. */
  private drawnTerrain: { drawn: boolean; material: 'full' | 'low' | null; lights: number } = { drawn: false, material: null, lights: 0 }

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
    this.terrain = new TerrainLayer(this.renderer)
    this.camera.position.z = 1000
    // Static: `bgMaterial` has no clock (stars a hash grid, rays a function of angle), so an
    // unchanged view is an unchanged sky and the redraw skip stands (skyMaterial.ts).
    this.addLayer({ object: this.sky.mesh, animated: false })
    this.terrainMesh.frustumCulled = false
    this.terrainMesh.visible = false
    this.addLayer({ object: this.terrainMesh, animated: false })
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
    this.syncBake()
    this.warmTerrain()
  }

  /** T23.07 (R14): the low tier keeps a lit bake for the scene's terrain look; the full tier none. */
  private syncBake(): void {
    this.terrain.setBake(this.tier === 'low' && this.desc?.litTerrain ? this.desc.look.terrain : null)
  }

  setScene(desc: SceneDescription): void {
    this.desc = desc
    this.dirty = true
    this.stats.scene = sceneCounts(desc)
    this.sky.setSky(desc.look.bg)
    this.syncBake()
  }

  render(view: ViewRect): void {
    if (!this.desc || !this.owns) return
    this.syncBox()
    // A terrain update is a new picture once the terrain is drawn (T23.07) — the carve's frame, not the next.
    if (this.terrain.pump() && (this.albedoView || this.terrain.ready)) this.dirty = true
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
    this.placeTerrain(view)
    if (this.albedoView) {
      syncAlbedoView(this.albedoView, this.terrain)
      this.renderer.setRenderTarget(null)
      this.renderer.render(this.albedoView.scene, this.camera)
    } else {
      this.composer.render()
    }
    this.stats.frames++
    this.stats.view = { ...view }
  }

  /**
   * T23.07: show the lit terrain if the scene asks for it and its fields are whole: this GPU side's
   * textures, the scene's look, its lights culled to `view` (`pickLights`), and the tier's material —
   * the low tier's only once its bake is whole (until then the full shader draws, at the low tier's
   * resolution: the same picture, slower).
   */
  private placeTerrain(view: ViewRect): void {
    const desc = this.desc
    const g = this.terrain.gpu
    const on = !!desc && !!g && desc.litTerrain && this.terrain.ready && !this.terrainHidden
    this.terrainMesh.visible = on
    if (!on || !desc || !g) {
      this.drawnTerrain = { drawn: false, material: null, lights: 0 }
      return
    }
    const u = this.terrainMats.uniforms
    setTextures(u, g.field, g.albedo.texture, g.w, g.h, desc.world.h)
    setLook(u, desc.look.terrain)
    u['wallK']!.value = this.wallHidden ? 0 : 1
    const lights = pickLights(desc.look.lights, view)
    setLights(u, lights)
    ;(u['ext']!.value as { set(x: number, y: number): void }).set(desc.world.w, desc.world.h)
    const low = (this.terrainForce ?? this.tier) === 'low' && this.terrain.baked && !!g.bake
    u['baked']!.value = low ? g.bake?.texture ?? null : null
    this.terrainMesh.material = low ? this.terrainMats.low : this.terrainMats.full
    // The quad covers the mask, rows 0..h, in the y-up world (`toWorld`).
    this.terrainMesh.scale.set(desc.world.w, desc.world.h, 1)
    const c = toWorld(desc.world.w / 2, desc.world.h / 2, desc.world.h)
    this.terrainMesh.position.set(c.x, c.y, 0)
    this.drawnTerrain = { drawn: true, material: low ? 'low' : 'full', lights: lights.length }
  }

  /** T23.07: whether the scene asks for the lit terrain (it draws once its picture is whole). */
  get litTerrainWanted(): boolean {
    return !!this.desc?.litTerrain
  }

  /** T23.07: whether the lit terrain draws the rock now (the scene asks for it and its picture is whole). */
  get drawsTerrain(): boolean {
    return !!this.desc?.litTerrain && this.terrain.ready
  }

  /** Dev (`gate-ground`): leave the lit terrain out of the frame — "is this pixel rock?" is "does it change". */
  terrainHidden = false

  /**
   * Dev (T23.07B F4, `gate-ground`): draw the lit terrain **without its cave wall** (`wallK` 0) — only the
   * wall branch is suppressed, so a px that changes with the terrain hidden but not with this is rock.
   */
  wallHidden = false

  /** Dev (`look-terrain`): draw the terrain with this tier's material whatever the tier (`null`: the tier's own). */
  terrainForce: QualityTier | null = null

  /** Dev: the lit terrain as last drawn — whether, which tier's material, how many lights. */
  terrainDrawn(): { drawn: boolean; material: 'full' | 'low' | null; lights: number } {
    return { ...this.drawnTerrain }
  }

  /**
   * T23.06: hand over the scene's terrain fields (`null`: none — the title). `units`: field strips and
   * albedo tiles done per drawn frame while a full pass is queued. A new map gets a new GPU side now
   * (F6: allocated, nothing uploaded); the same map's resync keeps it (F3) — `terrainLayer.ts`.
   */
  setTerrain(feed: TerrainFeed | null, units: number): void {
    const before = this.terrain.gpu
    this.terrain.setFeed(feed, units)
    this.syncBake()
    if (this.terrain.gpu && this.terrain.gpu !== before) this.warmTerrain()
    this.dirty = true
  }

  /**
   * T23.07: draw the terrain's materials once, 1 px, into this tier's target, at the map change —
   * T23.06B F6's warm for the draw. Measured (sandbox, SwiftShader, low tier): the first frame that drew
   * the lit terrain cost 58 ms (Medium) / 65 ms (Large) against 16–22 ms either side — the pipeline
   * built on first use. The px is overwritten by the next drawn frame (the render pass clears).
   */
  private warmTerrain(): void {
    const g = this.terrain.gpu
    if (!g || !this.desc) return
    const u = this.terrainMats.uniforms
    setTextures(u, g.field, g.albedo.texture, g.w, g.h, this.desc.world.h)
    setLook(u, this.desc.look.terrain)
    ;(u['ext']!.value as { set(x: number, y: number): void }).set(this.desc.world.w, this.desc.world.h)
    u['baked']!.value = g.bake?.texture ?? null
    const r = this.renderer
    const rt = this.composer.readBuffer
    const prev = r.getRenderTarget()
    const autoClear = r.autoClear
    const vis = this.terrainMesh.visible
    const mat = this.terrainMesh.material
    const cam = new OrthographicCamera(0, 1, this.desc.world.h, this.desc.world.h - 1, -2000, 2000)
    cam.position.z = 1000
    cam.updateProjectionMatrix()
    r.autoClear = false
    rt.viewport.set(0, 0, 1, 1)
    rt.scissor.set(0, 0, 1, 1)
    rt.scissorTest = true
    r.setRenderTarget(rt)
    this.terrainMesh.visible = true
    this.terrainMesh.scale.set(this.desc.world.w, this.desc.world.h, 1)
    this.terrainMesh.position.set(this.desc.world.w / 2, this.desc.world.h / 2, 0)
    for (const m of g.bake ? [this.terrainMats.full, this.terrainMats.low] : [this.terrainMats.full]) {
      this.terrainMesh.material = m
      r.render(this.scene3, cam)
    }
    rt.viewport.set(0, 0, rt.width, rt.height)
    rt.scissor.set(0, 0, rt.width, rt.height)
    rt.scissorTest = false
    this.terrainMesh.material = mat
    this.terrainMesh.visible = vis
    r.setRenderTarget(prev)
    r.autoClear = autoClear
  }

  /** T23.06 dev/look-lab: draw the albedo flat (sRGB bytes straight to the canvas, air black) instead of the world. */
  showAlbedo(on: boolean): void {
    if (!on) {
      if (this.albedoView) disposeAlbedoView(this.albedoView)
      this.albedoView = null
      this.dirty = true
      return
    }
    if (this.albedoView || !this.desc) return
    const w = this.terrain.feed?.w ?? this.desc.world.w
    const h = this.terrain.feed?.h ?? this.desc.world.h
    this.albedoView = makeAlbedoView(w, h, this.desc.world.h, this.terrain.gpu?.albedo.texture ?? null)
    this.dirty = true
  }

  /** Dev: whether the flat albedo view is on. */
  get albedoViewOn(): boolean {
    return !!this.albedoView
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
    // Last, over the lit terrain (T23.07: an opaque marker at z 0 drew first and the terrain covered it) —
    // transparent, so it sorts in the terrain's list, where `renderOrder` puts it after.
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(1, 0, 1), depthTest: false, transparent: true }))
    m.renderOrder = 1000
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

  /** Dev: the page's three.js renderer (`terrainDev.ts::hashProbe` draws on it). */
  get renderer3(): WebGLRenderer {
    return this.renderer
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
    this.terrainMesh.geometry.dispose()
    this.terrainMats.full.dispose()
    this.terrainMats.low.dispose()
    this.showAlbedo(false)
    this.terrain.dispose()
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
    // T23.07: the lit terrain draws the rock — not on a space map, whose cores and iron are drawn into
    // Phaser's rock and which T23.20 brings into the new look. F1's lights are the mockup scene's, not
    // this map's (the game's own are T23.09's): none.
    litTerrain: !map.space,
    look: { ...F1.look, bg: map.space ? null : gameSky(map.seed, f1), lights: [] },
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
  /**
   * **T23.06B (F3) / T23.07: whether the lit terrain draws the rock** — its picture is whole
   * (`TerrainLayer.ready`: every field strip up, every albedo tile painted, for this map) and the map
   * asks for it (`litTerrain`: not space). The scenes hide Phaser's rock exactly while this is true, so
   * the terrain is never absent; a same-map resync keeps it true. Always false where three did not
   * start (the stub draws no terrain — Phaser's rock stays).
   */
  terrainReady(): boolean
  /**
   * T23.07: the rock is still Phaser's but will become the lit terrain on its own (the map asks for it,
   * its picture is not whole yet) — a check that photographs the world waits this out.
   */
  terrainSwapPending(): boolean
}

/**
 * T23.06: work units (a field strip upload or an albedo tile, T23.06B F6) done per frame in the game
 * while the round-start pass is queued (measured: `look-albedo`, the Large install).
 */
export const GAME_ALBEDO_TILES: Record<QualityTier, number> = { full: 4, low: 1 }

/**
 * `GameScene`, `SandboxScene` and `TitleScene`'s entry point (T23.03B, F10): they load this
 * module on demand (`loadWorldRenderer.ts`), so they cannot import `gameDescription` from it statically.
 */
export function createGameWorld(scene: Phaser.Scene, map: GameMap): GameWorld {
  const renderer = createWorldRenderer(scene, gameDescription(map))
  // T23.06B F11: where three did not start, nothing takes the feed's rects and blasts — drain them
  // per frame so they do not pile up for a whole match.
  let undrawn: TerrainFeed | null = null
  if (!(renderer instanceof WorldRenderer)) {
    const drain = (): void => void undrawn?.take()
    scene.events.on('render', drain)
    scene.events.once('shutdown', () => scene.events.off('render', drain))
  }
  return {
    renderer,
    mapChanged: (m) => renderer.setScene(gameDescription(m)),
    setTerrain: (feed) => {
      if (renderer instanceof WorldRenderer) renderer.setTerrain(feed, GAME_ALBEDO_TILES[renderer.info().tier])
      else undrawn = feed
    },
    terrainReady: () => renderer instanceof WorldRenderer && renderer.drawsTerrain,
    terrainSwapPending: () => renderer instanceof WorldRenderer && renderer.litTerrainWanted && !renderer.drawsTerrain,
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

