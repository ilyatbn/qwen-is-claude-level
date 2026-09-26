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
 * (full tier; the low tier halves it and drops MSAA) → `OutputPass` (ACES at `look.exposure`,
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
import {
  TIER_SAMPLES,
  TIER_SCALE,
  acesSrgb,
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
    this.renderer.setPixelRatio(dpr)
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

  info(): { tier: QualityTier; buffer: [number, number]; target: [number, number]; samples: number; exposure: number } {
    const rt = this.composer.renderTarget1
    const b = bufferSize(this.css.w, this.css.h, this.css.dpr)
    return {
      tier: this.tier,
      buffer: [b.w, b.h],
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

/** What a dev check can reach: `window.__world` (dev surface only). */
export interface WorldHandle {
  backend: SceneRenderer['backend']
  frames(): number
  view(): ViewRect | null
  info(): ReturnType<WorldRenderer['info']> | null
  /** Add a world-anchored marker to **both** canvases: three's quad and a Phaser rect. */
  addMarker(x: number, y: number, w: number, h: number): void
  /**
   * Record the next `n` drawn frames: the marker's centre in each canvas, read back in the same
   * frame — x along CSS row `row`, y along CSS column `col`.
   */
  probe(n: number, row: number, col: number): Promise<ProbeSample[]>
  /** Phaser's canvas alpha at CSS points, read back after the next drawn frame; `null` on Canvas Phaser. */
  phaserAlpha(points: [number, number][]): Promise<number[] | null>
  /** What the test layer must look like on screen: `skyBottom` through ACES at the scene's exposure, 0–255 sRGB. */
  expectedTestColor(): [number, number, number] | null
}

export interface ProbeSample {
  /** Phaser's frame counter at the readback. */
  frame: number
  /** Marker centre, CSS px from the canvas's left edge along the row; `null` if not on it. */
  phaserX: number | null
  threeX: number | null
  /** Marker centre, CSS px from the canvas's top edge along the column; `null` if not on it. */
  phaserY: number | null
  threeY: number | null
  /** The view the world renderer drew this frame. */
  viewX: number | null
  viewY: number | null
}

/** Centre of the first magenta run in a strip of RGBA px, in px along it; `null` if none. */
function magentaCentre(row: Uint8Array, w: number): number | null {
  let start = -1
  for (let x = 0; x < w; x++) {
    const r = row[x * 4]!
    const g = row[x * 4 + 1]!
    const b = row[x * 4 + 2]!
    const hit = r > 150 && b > 150 && g < 100
    if (hit && start < 0) start = x
    if (!hit && start >= 0) return (start + x - 1) / 2
  }
  return start >= 0 ? (start + w - 1) / 2 : null
}

/** Read buffer column `x` of a WebGL canvas, top-down, in the frame it was just drawn. */
function readCol(gl: WebGLRenderingContext, x: number): { col: Uint8Array; h: number } {
  const h = gl.drawingBufferHeight
  const raw = new Uint8Array(h * 4)
  const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.readPixels(x, 0, 1, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
  gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
  // GL rows run bottom-up; flip to top-down.
  const col = new Uint8Array(h * 4)
  for (let i = 0; i < h; i++) col.set(raw.subarray((h - 1 - i) * 4, (h - i) * 4), i * 4)
  return { col, h }
}

/** Read buffer row `y` (top-down) of a WebGL canvas, in the frame it was just drawn. */
function readRow(gl: WebGLRenderingContext, y: number): { row: Uint8Array; w: number } {
  const w = gl.drawingBufferWidth
  const row = new Uint8Array(w * 4)
  // Restore whatever was bound: both Phaser and three cache their GL state.
  const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.readPixels(0, gl.drawingBufferHeight - 1 - y, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, row)
  gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
  return { row, w }
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
  if (devSurface()) exposeHandle(scene, r, desc)
  return r
}

function exposeHandle(scene: Phaser.Scene, r: SceneRenderer, desc: SceneDescription): void {
  const three = r instanceof WorldRenderer ? r : null
  const stats = (r as { stats?: RenderStats }).stats
  // The description in force, followed through later `setScene` calls (a regenerated map).
  let currentDesc = desc
  const set = r.setScene.bind(r)
  r.setScene = (d: SceneDescription): void => {
    currentDesc = d
    set(d)
  }
  const handle: WorldHandle = {
    backend: r.backend,
    frames: () => stats?.frames ?? 0,
    view: () => stats?.view ?? null,
    info: () => three?.info() ?? null,
    addMarker(x, y, w, h) {
      three?.addMarker(x, y, w, h)
      scene.add.rectangle(x, y, w, h, 0xff00ff).setOrigin(0, 0).setDepth(1e6)
    },
    expectedTestColor() {
      const d = stats?.scene ? currentDesc : null
      return d ? acesSrgb(hexLinear(d.look.bg.skyBottom), d.look.exposure) : null
    },
    phaserAlpha(points) {
      const game = scene.game
      const pgl = (game.renderer as { gl?: WebGLRenderingContext }).gl ?? null
      if (!pgl) return Promise.resolve(null)
      return new Promise((resolve) => {
        game.events.once('postrender', () => {
          const pc = game.canvas
          const sx = pgl.drawingBufferWidth / (pc.clientWidth || pc.width)
          const sy = pgl.drawingBufferHeight / (pc.clientHeight || pc.height)
          const out = points.map(([x, y]) => {
            const { row } = readRow(pgl, Math.round(y * sy))
            return row[Math.round(x * sx) * 4 + 3]!
          })
          resolve(out)
        })
      })
    },
    probe(n, row, col) {
      const game = scene.game
      const pgl = (game.renderer as { gl?: WebGLRenderingContext }).gl ?? null
      const samples: ProbeSample[] = []
      /** The marker's centre in one canvas, CSS px, from a row and a column read in this frame. */
      const locate = (gl: WebGLRenderingContext, el: HTMLCanvasElement): [number | null, number | null] => {
        const cw = el.clientWidth || gl.drawingBufferWidth
        const ch = el.clientHeight || gl.drawingBufferHeight
        const sx = gl.drawingBufferWidth / cw
        const sy = gl.drawingBufferHeight / ch
        const r = readRow(gl, Math.round(row * sy))
        const c = readCol(gl, Math.round(col * sx))
        const x = magentaCentre(r.row, r.w)
        const y = magentaCentre(c.col, c.h)
        return [x === null ? null : x / sx, y === null ? null : y / sy]
      }
      return new Promise((resolve) => {
        const onPost = (): void => {
          const [phaserX, phaserY] = pgl ? locate(pgl, game.canvas) : [null, null]
          const [threeX, threeY] = three ? locate(three.gl, three.canvas) : [null, null]
          const v = stats?.view ?? null
          samples.push({ frame: game.loop.frame, phaserX, threeX, phaserY, threeY, viewX: v?.x ?? null, viewY: v?.y ?? null })
          if (samples.length >= n) {
            game.events.off('postrender', onPost)
            resolve(samples)
          }
        }
        game.events.on('postrender', onPost)
      })
    },
  }
  ;(window as unknown as { __world: WorldHandle }).__world = handle
}
