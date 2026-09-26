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
 * **What it draws today: one test layer**, a flat quad the colour of `look.bg.skyBottom` (read
 * as linear, as `e_style.js::hex` does), so the plumbing is visible. T23.04 replaces it with
 * the sky. `createWorldRenderer` is the single constructor the look-lab, `GameScene` and
 * `SandboxScene` call.
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
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { devSurface } from '../dev'
import { detectTier, onHighQualityChange, qualityTier, rendererString } from '../ui/settings'
import { StubRenderer, driveFromScene, sceneCounts, type RenderStats, type SceneRenderer } from './renderer'
import type { SceneDescription, ViewRect } from './scene'
import { F1 } from './scenes/F1'
import { exposeWorldHandle } from './worldHandle'
import { TIER_SAMPLES, bufferFor, hexLinear, mustDraw, orthoFromView, toWorld, type QualityTier } from './worldRenderer-math'

/** The mockup's full-screen quad: clip-space, drawn first, never culled (`e_style.js::bgQuad`). */
function testLayer(): Mesh<PlaneGeometry, ShaderMaterial> {
  const mat = new ShaderMaterial({
    uniforms: { c: { value: new Vector3() } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: 'uniform vec3 c; void main(){ gl_FragColor = vec4(c, 1.); }',
    depthTest: false,
    depthWrite: false,
  })
  const m = new Mesh(new PlaneGeometry(2, 2), mat)
  m.frustumCulled = false
  m.renderOrder = -10
  return m
}

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

export class WorldRenderer implements SceneRenderer {
  readonly backend = 'three' as const
  readonly stats: RenderStats & { skipped: number } = { frames: 0, view: null, scene: null, skipped: 0 }
  /** Set by anything that changes the picture other than the view: a scene, a marker. */
  private dirty = true
  readonly canvas: HTMLCanvasElement

  private readonly renderer: WebGLRenderer
  private readonly scene3 = new Scene()
  private readonly camera = new OrthographicCamera(0, 1, 1, 0, -2000, 2000)
  private readonly sky = testLayer()
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
   * @param phaserCanvas the canvas this one goes under — same parent, same box.
   * Throws where WebGL2 is missing (three 0.170 has no other path); `createWorldRenderer` catches.
   */
  constructor(private readonly phaserCanvas: HTMLCanvasElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.dataset['world'] = 'three'
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: false, powerPreference: 'high-performance' })
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.outputColorSpace = SRGBColorSpace
    this.camera.position.z = 1000
    this.addLayer({ object: this.sky, animated: false })
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
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(buf.w, buf.h, false)
    this.composer.setPixelRatio(1)
    this.composer.setSize(buf.w, buf.h)
    this.dirty = true
  }

  private buildComposer(): EffectComposer {
    const rt = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: TIER_SAMPLES[this.tier] })
    const c = new EffectComposer(this.renderer, rt)
    c.addPass(new RenderPass(this.scene3, this.camera))
    c.addPass(new OutputPass())
    return c
  }

  /** R14: switch tier live — rebuild the target (MSAA samples are fixed at creation) and resize. */
  setTier(tier: QualityTier): void {
    if (tier === this.tier) return
    this.tier = tier
    this.composer.dispose()
    this.composer = this.buildComposer()
    this.buf = { w: 0, h: 0 }
    this.syncBox()
  }

  setScene(desc: SceneDescription): void {
    this.desc = desc
    this.dirty = true
    this.stats.scene = sceneCounts(desc)
    const [r, g, b] = hexLinear(desc.look.bg.skyBottom)
    ;(this.sky.material.uniforms['c']!.value as Vector3).set(r, g, b)
    this.renderer.toneMappingExposure = desc.look.exposure
  }

  render(view: ViewRect): void {
    if (!this.desc) return
    this.syncBox()
    // An unchanged view of an unchanged, unanimated scene is an unchanged picture: the canvas
    // keeps showing the last one (`mustDraw`). Measured on the checks' SwiftShader in a match:
    // drawing every frame cost 60 → 51 fps and turned `birds` red (1/5 green; 3/3 with the
    // renderer off). An animated layer draws every frame (F3) — that cost returns with T23.04.
    if (!mustDraw({ dirty: this.dirty, animated: this.animated, last: this.stats.view, view })) {
      this.stats.skipped++
      return
    }
    this.dirty = false
    const o = orthoFromView(view, this.desc.world.h)
    this.camera.left = o.left
    this.camera.right = o.right
    this.camera.top = o.top
    this.camera.bottom = o.bottom
    this.camera.updateProjectionMatrix()
    this.composer.render()
    this.stats.frames++
    this.stats.view = { ...view }
  }

  /** Redraw on the next frame even if nothing changed. */
  invalidate(): void {
    this.dirty = true
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
      exposure: this.renderer.toneMappingExposure,
      animated: this.animated,
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
    this.sky.geometry.dispose()
    this.sky.material.dispose()
    this.composer.dispose()
    this.renderer.dispose()
    this.canvas.remove()
  }
}

/**
 * The game's scene description until the sim fills more of it: F1's night look (R7 — T23.11
 * blends it with F5's by darkness), the map's size for the y flip, no mask yet (T23.07), no
 * actors (T23.12+). Rebuild it when the map changes size.
 */
export function gameDescription(mapW: number, mapH: number): SceneDescription {
  return {
    id: 'game',
    camera: { x: 0, y: 0, w: mapW, h: mapH },
    world: { w: mapW, h: mapH },
    masks: null,
    look: F1.look,
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
  /** `map_init` / a regenerated sandbox map: describe the new size. */
  mapChanged(mapW: number, mapH: number): void
  /** R20: the tier detected on this renderer's GPU (the options panel's "Auto (…)"); low where three did not start. */
  detectedTier(): QualityTier
}

/**
 * `GameScene` and `SandboxScene`'s entry point (T23.03B, F10): they load this module on
 * demand (`loadWorldRenderer.ts`), so they cannot import `gameDescription` from it statically.
 */
export function createGameWorld(scene: Phaser.Scene, mapW: number, mapH: number): GameWorld {
  const renderer = createWorldRenderer(scene, gameDescription(mapW, mapH))
  return {
    renderer,
    mapChanged: (w, h) => renderer.setScene(gameDescription(w, h)),
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
  if (devSurface()) exposeWorldHandle(scene, r, r instanceof WorldRenderer ? r : null, desc)
  return r
}

