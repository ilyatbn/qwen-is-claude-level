/**
 * T23.03 (R1, R11, R14): three.js draws the world, on its own canvas **under** Phaser's.
 *
 * Phaser keeps scenes, input, camera, audio and UI; its canvas is transparent (`main.ts`), and
 * this renderer's canvas sits beneath it, sized to the same box. Phaser's camera is the only
 * source of truth: each drawn frame `driveFromScene` hands this renderer `cameras.main.worldView`
 * **after** `Camera.preRender` (the `living-sky` trap — see `renderer.ts`), and it copies that
 * into an ortho camera in the mockup's y-up mask space (`worldRenderer-math.ts`).
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
import { onHighQualityChange, qualityTier } from '../ui/settings'
import { StubRenderer, driveFromScene, sceneCounts, type RenderStats, type SceneRenderer } from './renderer'
import type { SceneDescription, ViewRect } from './scene'
import { F1 } from './scenes/F1'
import { exposeWorldHandle } from './worldHandle'
import {
  TIER_SAMPLES,
  TIER_SCALE,
  bufferSize,
  hexLinear,
  orthoFromView,
  toWorld,
  type QualityTier,
} from './worldRenderer-math'

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

export class WorldRenderer implements SceneRenderer {
  readonly backend = 'three' as const
  readonly stats: RenderStats = { frames: 0, view: null, scene: null }
  readonly canvas: HTMLCanvasElement

  private readonly renderer: WebGLRenderer
  private readonly scene3 = new Scene()
  private readonly camera = new OrthographicCamera(0, 1, 1, 0, -2000, 2000)
  private readonly sky = testLayer()
  private composer: EffectComposer
  private desc: SceneDescription | null = null
  private tier: QualityTier
  private css = { w: 0, h: 0, dpr: 0 }
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
    this.scene3.add(this.sky)
    this.tier = qualityTier()
    this.composer = this.buildComposer()
    this.mount()
    this.unsubscribe = onHighQualityChange(() => this.setTier(qualityTier()))
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

  /** Match Phaser's box (Scale.FIT moves and resizes it) and the device pixel ratio — once each, here. */
  private syncBox(): void {
    const p = this.phaserCanvas
    const w = p.clientWidth || p.width
    const h = p.clientHeight || p.height
    const dpr = window.devicePixelRatio || 1
    const s = this.canvas.style
    const left = `${p.offsetLeft}px`
    const top = `${p.offsetTop}px`
    if (s.left !== left) s.left = left
    if (s.top !== top) s.top = top
    if (w === this.css.w && h === this.css.h && dpr === this.css.dpr) return
    this.css = { w, h, dpr }
    s.width = `${w}px`
    s.height = `${h}px`
    // R14's low tier renders the **whole** world canvas at half resolution and lets CSS scale it
    // up — the mockup's own `kit.js::makeRenderer({ scale: 2 })`. Measured on the checks'
    // SwiftShader (sandbox, seed 4242): halving only the post target cost 60 → 47 fps and put the
    // `birds` check's aim out (2/2 red, green with the renderer off); halving the canvas: 58.5–59.
    this.renderer.setPixelRatio(dpr * TIER_SCALE[this.tier])
    this.renderer.setSize(w, h, false)
    this.composer.setPixelRatio(dpr * TIER_SCALE[this.tier])
    this.composer.setSize(w, h)
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
    this.css = { w: 0, h: 0, dpr: 0 }
    this.syncBox()
  }

  setScene(desc: SceneDescription): void {
    this.desc = desc
    this.stats.scene = sceneCounts(desc)
    const [r, g, b] = hexLinear(desc.look.bg.skyBottom)
    ;(this.sky.material.uniforms['c']!.value as Vector3).set(r, g, b)
    this.renderer.toneMappingExposure = desc.look.exposure
  }

  render(view: ViewRect): void {
    if (!this.desc) return
    this.syncBox()
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

  /** Dev: a flat magenta quad anchored in the world at mask px `x, y` (top-left), `w × h`. */
  addMarker(x: number, y: number, w: number, h: number): void {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(1, 0, 1) }))
    const c = toWorld(x + w / 2, y + h / 2, this.desc?.world.h ?? 0)
    m.position.set(c.x, c.y, 0)
    this.markers.push(m)
    this.scene3.add(m)
  }

  /** `display`: Phaser's box in device px; `buffer`: this canvas's drawing buffer; `target`: the post chain's. */
  info(): {
    tier: QualityTier
    display: [number, number]
    buffer: [number, number]
    target: [number, number]
    samples: number
    exposure: number
  } {
    const rt = this.composer.renderTarget1
    const d = bufferSize(this.css.w, this.css.h, this.css.dpr)
    const gl = this.gl
    return {
      tier: this.tier,
      display: [d.w, d.h],
      buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      target: [rt.width, rt.height],
      samples: rt.samples,
      exposure: this.renderer.toneMappingExposure,
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

