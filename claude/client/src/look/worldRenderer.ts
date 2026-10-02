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
 * The post chain is the mockup's (`kit.js::post`, T23.08 — `post.ts`): a half-float target with 4× MSAA
 * (full tier; the low tier renders the whole canvas at half resolution and drops MSAA) → bloom →
 * `OutputPass` (ACES at `look.exposure`, then sRGB) → the grade. The back fog, front fog and the
 * foreground leaves are `atmosphere.ts` (T23.08), in `f_kit.js::frame`'s order around the terrain.
 *
 * **What it draws: the sky** (T23.04, `skyMaterial.ts` — the mockup's `bgQuad`), its layers
 * moved per frame by their parallax offsets (`skyLayout.ts::skyOffsets`, from the same view the
 * ortho camera is laid out from); baked once per sky and tier, composited per frame (T23.04B, R21). T23.20: space's
 * sky is F3's, its bodies moved per frame by the scene's space feed (`space.ts`). `createWorldRenderer` is the single constructor the look-lab, `GameScene`,
 * `SandboxScene` and `TitleScene` call.
 */
import type Phaser from 'phaser'
import {
  ACESFilmicToneMapping,
  Color,
  Mesh,
  MeshBasicMaterial,
  NoBlending,
  NormalBlending,
  type Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { devSurface } from '../dev'
import { detectTier, onHighQualityChange, qualityTier, rendererString } from '../ui/settings'
import { StubRenderer, driveFromScene, sceneCounts, type RenderStats, type SceneRenderer } from './renderer'
import type { Actor, Background, Box, FrameLook, Light, SceneDescription, ViewRect } from './scene'
import { Atmosphere } from './atmosphere'
import { ActorLayer } from './actors/layer'
import { GlowLayer } from './actors/glow'
import { FxLayer } from './fx/layer'
import { FireflyLayer } from './fireflyLayer'
import { FIREFLY_HZ, fieldSampler, fireflyFade, placeFireflies, type Firefly } from './fireflies'
import { clearFrame, emptyFrame, sceneFx, type FxFrame } from './fx/kit'
import { fxFeed, gameFrame, setWorldDraws, type FxFeed } from './fx/feed'
import { EARTH_BAND, MOON_BAND, SPACE_SMOKE, SpaceStars, spaceDescription, spaceFeed, starKey, type SpaceFeed } from './space'
import { castOf } from './actors/cast'
import { NIGHT_CIRCLES, applyNight, applyPost, buildPost, type NightUniforms, type Post } from './post'
import { SkyQuad } from './skyMaterial'
import { albedoTheme } from './albedo'
import { Backdrop } from './backdrop'
import { worldLook, type WorldLookId } from './worlds'
import { ambientEmbers, emberSprites, mockupEmbers } from './embers'

import { blendLook, blendPalette, clamp01, MOON_REACH, MOON_TRAVEL, moonArcs } from './daylight'
import { gameSky, skyOffsets, type Offset } from './skyLayout'
import { exposeWorldHandle } from './worldHandle'
import type { TerrainFeed } from './terrainFields'
import { TerrainLayer } from './terrainLayer'
import { disposeAlbedoView, makeAlbedoView, syncAlbedoView, type AlbedoView } from './terrainDev'
import { makeTerrainMaterials, setLights, setLook, setTextures } from './terrainMaterial'
import { TERRAIN_LIGHTS, TERRAIN_LIGHTS_LOW, pickLights } from './terrainLights'
import { CAVE_WALL_DEFAULT, bufferFor, caveWallFromUrl, hourFromUrl, mustDraw, nightUniforms, orthoFromView, toWorld, type NightView, type QualityTier } from './worldRenderer-math'

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
    depth: false,
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

/**
 * R14 (T23.08): the low tier's bloom runs at this fraction of the low tier's own buffer (already half the
 * pictures'). Measured on the checks' SwiftShader in a match (640×360, camera panning): the bloom at the
 * buffer's size cost 8.3 ms of a 19.3 ms drawn frame and the match fell 60 → 43 fps.
 */
export const LOW_BLOOM_SCALE = 0.5
/** T23.31: F2's sparks, frame px = the lab's scene px (its camera is the mockup's frame). */
const MOCKUP_SPARKS = mockupEmbers()

/**
 * T23.11: steps of `t` the hour is drawn in. Dusk takes ~14 s (`world/cycle.rs`: u 0.50 → 0.62 of 120 s), so 256
 * steps is one every ~0.06 s — a change no one sees as a step (the sky's colours are 8-bit hex anyway), and the
 * redraw skip still holds between them.
 */
export const DAYLIGHT_T_STEPS = 256

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
  /** T23.10: the scene's night view (`setNightView`), and the uniforms it made on the last drawn frame. */
  private night: NightView | null = null
  private nightLast: NightUniforms | null = null
  /** T23.11: the hour drawn — `t` (0 moonlit day, 1 night) and the cycle position (null: the moons at the pictures' places), quantised. */
  private hour: { t: number; u: number | null } = { t: 1, u: null }
  /** T23.11: the sky as handed to the composite — the blend at `hour`, its moons moved (null: the description's own). */
  private skyNow: Background | null = null
  /** T23.11 (dev, `&hour=`): the hour every frame draws, whatever the scene hands over (`hourFromUrl`). */
  private readonly pinnedHour = devSurface() ? hourFromUrl(location.search) : null
  /** T23.08: the composer's passes the look drives (`post.ts`). */
  private post!: Post
  /** T23.08: back fog, front fog, foreground leaves (`atmosphere.ts`). */
  private readonly atmos = new Atmosphere()
  /** T23.31: the world look's backdrop (the volcano, its planets). */
  private readonly backdrop = new Backdrop()
  /** T23.08: player boxes (mask px) the foreground fades over, besides the description's stick figures — `setOccluders`. */
  private occluders: Box[] = []
  /** Dev (T23.08): layers and passes switched off — `fogBack`, `fogFront`, `fg`, `bloom`, `grade` (`hideLayers`). */
  private hidden = new Set<string>()
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
  /** T23.12: the cast — one quad per actor over its atlas cell (`actors/layer.ts`), between the front fog and the leaves. */
  private readonly actorLayer: ActorLayer
  /** T23.14B: the actors' additive glows (a jet flame's). */
  private readonly glowLayer = new GlowLayer()
  /**
   * T23.18: the effects — the description's (`desc.fx`, the look-lab's reference scenes, laid out once per scene) and
   * the game's (`fx/feed.ts`, built from the ordnance layers' records every drawn frame).
   */
  private readonly fxLayer = new FxLayer()
  private sceneFxFrame: FxFrame = emptyFrame()
  private readonly fxFrame: FxFrame = emptyFrame()
  private fxSource: FxFeed | null = null
  /** T23.20: the scene's space feed (`space.ts`) — the bodies' places and the star field, from its `SpaceSky`. */
  private spaceSource: SpaceFeed | null = null
  /** T23.20: the feed's version last drawn, and the star and the bands' hidden state last handed to the sky. */
  private spaceDrawn = { version: -1, sun: '', hide: '' }
  /** T23.20: T22.06's star field, drawn into a target the sky composites (`space.ts::SpaceStars`). */
  private readonly spaceStars = new SpaceStars()
  /** Dev (`look-sky`): the sky bands a check hid; space's hidden bodies are added to them. */
  private devSkyHidden: number[] = []
  /** The last built frame had game effects (the scene's own are static: laid out on the frame `setScene` marks). */
  private fxLive = false
  /**
   * T23.24: the fireflies — seeded per map from the description's `fireflies` (the game's, never space's or the
   * look-lab's) once the terrain fields are in (`swarmKey`: seed and map), moved by the scene's clock (`setClock`).
   */
  private readonly fireflyLayer = new FireflyLayer()
  private swarm: Firefly[] = []
  private swarmKey: string | null = null
  private clock = 0
  private fireflyStep = -1
  /** T23.31: the look-lab's scene draws the mockup's still embers this frame (`embers.ts::mockupEmbers`). */
  private embersStill = false
  /** Dev (`look-terrain`): the lights and material the last drawn frame used. */
  private drawnTerrain: { drawn: boolean; material: 'full' | 'low' | null; lights: number; wallK: number | null } = { drawn: false, material: null, lights: 0, wallK: null }

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
    // T23.31: a world look's distant painted layer (`backdrop.ts`) — static, between the sky and the back fog.
    for (const m of this.backdrop.meshes) this.addLayer({ object: m, animated: false })
    // T23.08: no clock in the fog or the leaves (`atmosphere.ts`) — the redraw skip stands.
    for (const m of this.atmos.meshes) this.addLayer({ object: m, animated: false })
    // T23.12: static like the rest — a changed cast or light list is a changed description, which marks the frame.
    this.actorLayer = new ActorLayer(this.renderer)
    this.addLayer({ object: this.actorLayer.mesh, animated: false })
    this.addLayer({ object: this.glowLayer.mesh, animated: false })
    // T23.24: not animated as a layer — a swarm in view ends the redraw skip itself, `FIREFLY_HZ` times a second at most.
    this.addLayer({ object: this.fireflyLayer.mesh, animated: false })
    // T23.18: not animated as a layer — an effect on screen ends the redraw skip itself (`placeFx`), an empty one does not.
    for (const m of this.fxLayer.meshes) this.addLayer({ object: m, animated: false })
    // R20: the tier this machine gets when the player has never chosen is read from this
    // renderer's own context — the GPU that will actually draw the world.
    this.tier = qualityTier(this.gl)
    this.composer = this.buildComposer()
    // T23.14C: the glow's program and geometry exist from scene start, not from the first jet.
    this.glowLayer.warm(this.renderer, this.composer.readBuffer)
    this.fireflyLayer.warm(this.renderer, this.composer.readBuffer)
    this.fxLayer.warm(this.renderer, this.composer.readBuffer)
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
    // R14's low tier: half-resolution bloom (`LOW_BLOOM_SCALE`) — the composer just sized it to the buffer.
    if (this.tier === 'low') this.post.bloom.setSize(Math.round(buf.w * LOW_BLOOM_SCALE), Math.round(buf.h * LOW_BLOOM_SCALE))
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
    this.post = buildPost(this.renderer, this.scene3, this.camera, this.tier)
    // T23.18B: the fog's and the fire's noise follow the tier (R14: the low tier's cheaper octaves).
    this.atmos.setTier(this.tier === 'low')
    this.fxLayer.setTier(this.tier === 'low')
    return this.post.composer
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

  /**
   * T23.07 (R14): the low tier keeps a lit bake for the scene's terrain look; the full tier none.
   * **T23.11: baked for the night's look at every hour.** The bake holds the sun's shadow march, which reads
   * `sunDir` — and F1's and F5's differ (z 0.40 / 0.45) — so a `sunDir` blended per frame would rebake the whole
   * world every step of dusk (the bake is a round-start pass: seconds on SwiftShader, the full shader meanwhile).
   * The per-frame shading (the diffuse, the rim, the colours) takes the blended look; only the shadows' direction
   * stays the night's. What that costs by day is measured in `look-day-night` (low vs full at `t` 0).
   */
  private syncBake(): void {
    const d = this.desc
    this.terrain.setBake(this.tier === 'low' && d?.litTerrain ? (d.daylight?.night ?? d.look).terrain : null)
  }

  setScene(desc: SceneDescription): void {
    this.desc = desc
    this.dirty = true
    this.sceneFxFrame = sceneFx(desc.fx)
    this.syncFxDrawer()
    this.stats.scene = sceneCounts(desc)
    // T23.31: a description that names no albedo takes its look's (`palette.theme`: F2's and the volcanic world's).
    this.terrain.setPalette(desc.albedo ?? albedoTheme((desc.daylight?.nightPalette ?? desc.palette)?.theme))
    const reach: [number, number] = desc.daylight ? MOON_REACH : desc.spaceSky?.reach ?? [0, 0]
    this.sky.setSky(desc.daylight ? desc.daylight.night.bg : desc.look.bg, desc.daylight?.day.bg ?? null, reach)
    this.spaceDrawn = { version: -1, sun: '', hide: '' }
    this.skyNow = desc.look.bg
    if (desc.daylight) this.blendHour()
    // T23.19G F6: every moon-set variant the day's blend will reach, compiled at the map change, not at the first dusk.
    if (desc.daylight) this.sky.warm(this.renderer, this.composer.readBuffer)
    this.syncBake()
  }

  /**
   * T23.11 (R7): the hour — `t` = darkness / `NIGHT_DARKNESS` (0 moonlit day, 1 night) and the cycle position `u`
   * (`sky-math.ts::cycleU`; `null`: the moons stay at the pictures' places — the look-lab). The description's `look`
   * and `palette` become the blend of its two palettes (`daylight.ts`); the sky takes the blend with its moons moved.
   * Quantised so that an unchanged picture stays unchanged (the redraw skip): `t` in `DAYLIGHT_T_STEPS`, `u` in the
   * steps the fastest moon needs to move one buffer px. A description with no palettes to blend ignores it.
   */
  setDaylight(t: number, u: number | null): void {
    if (this.pinnedHour) ({ t, u } = this.pinnedHour)
    const qt = Math.round(clamp01(t) * DAYLIGHT_T_STEPS) / DAYLIGHT_T_STEPS
    const texel = this.buf.w > 0 ? this.phaserCanvas.width / this.buf.w : 1
    const du = texel / MOON_TRAVEL
    const qu = u === null ? null : Math.floor(u / du) * du
    if (qt === this.hour.t && qu === this.hour.u) return
    this.hour = { t: qt, u: qu }
    if (this.desc?.daylight) this.blendHour()
  }

  /** The description's look, palette and sky at `this.hour` — its effect lights kept (they are the scenes' per frame). */
  private blendHour(): void {
    const d = this.desc
    if (!d?.daylight) return
    const { day, night, dayPalette, nightPalette } = d.daylight
    const look = blendLook(day, night, this.hour.t)
    d.look = { ...look, lights: d.look.lights }
    d.palette = blendPalette(dayPalette, nightPalette, this.hour.t)
    this.skyNow = look.bg ? moonArcs(look.bg, this.hour.u) : null
    if (this.skyNow) this.sky.setColours(this.skyNow, this.hour.t)
    this.dirty = true
  }

  /** Dev (T23.11): the hour last handed over, quantised as drawn. */
  get daylight(): { t: number; u: number | null } {
    return { ...this.hour }
  }

  render(view: ViewRect): void {
    if (!this.desc || !this.owns) return
    // T23.10: a watcher reading this canvas frame after frame (`fx/feed.ts::keepDrawing`) needs every frame drawn: a
    // skipped one leaves the drawing buffer cleared, and at zoom 1 the camera no longer moves every frame (m4's round
    // and its control region both read 35 — each against the clear).
    if (this.fxSource?.keepDrawing) this.dirty = true
    this.syncBox()
    // A terrain update is a new picture once the terrain is drawn (T23.07) — the carve's frame, not the next.
    if (this.terrain.pump() && (this.albedoView || this.terrain.ready)) this.dirty = true
    // T23.18: effects move on their own (age, flicker, drift) — a frame with any is a new picture, and so is the first without.
    const live = this.buildFx(view)
    if (live || this.fxLive) this.dirty = true
    this.fxLive = live
    if (this.fireflyTick()) this.dirty = true
    // An unchanged view of an unchanged, unanimated scene is an unchanged picture: the canvas
    // keeps showing the last one (`mustDraw`). Measured on the checks' SwiftShader in a match:
    // drawing every frame cost 60 → 51 fps and turned `birds` red (1/5 green; 3/3 with the
    // renderer off). An animated layer draws every frame (F3) — that cost returns with T23.04.
    // T23.20: space's bodies and stars move on the round's clock — a new feed is a new picture.
    if (this.desc.spaceSky && this.spaceSource && this.spaceSource.version !== this.spaceDrawn.version) this.dirty = true
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
      this.placeSpace(offsets, frame)
      this.drawnOffsets = this.sky.place(this.renderer, view, this.desc.world, frame, [this.buf.w, this.buf.h], offsets)
    }
    {
      const b = this.desc.backdrop
      const frame: [number, number] = [this.phaserCanvas.width, this.phaserCanvas.height]
      this.backdrop.place(!!b && !!bg && !this.hidden.has('backdrop'), b?.seed ?? 0, bg?.horizon ?? 0, view, this.desc.world, frame, [this.buf.w, this.buf.h], this.desc.daylight ? this.hour.t : 1)
    }
    this.placeTerrain(view)
    this.atmos.place(this.desc.look, view, [this.buf.w, this.buf.h], this.occluderBoxes(), this.hidden, this.desc.cloudSea ?? null)
    this.actorLayer.rimOn = this.desc.actorRim !== false
    // **Two light lists, and it is a known disagreement** (T23.27C F10, filed for the coordinator): the terrain above
    // draws `pickedLights` — culled to the view and capped to the tier's slots (`pickLights`: 12 gates + a muzzle + an
    // impact against 10 on the low tier) — while the figures, gates and pickups here are lit by the **whole** held
    // list. So past the cap a gate's orb can glow from a light whose rock is unlit. Kept as is until ruled on: one list
    // (`this.pickedLights` here) is the other answer, and it changes how figures are lit near every evicted light.
    this.actorLayer.place(this.desc.actors.map((a) => this.withDarkHalo(a)), this.desc.look.lights, this.desc.look.moon, this.desc.world.h)
    this.glowLayer.place(this.desc.actors, this.desc.world.h)
    this.fireflyLayer.place(this.swarm, this.clock, this.fireflyFadeNow, view, this.desc.world.h)
    this.fxLayer.place(this.fxFrame, this.desc.world.h, performance.now() / 1000)
    applyPost(this.post, this.desc.look, this.hidden)
    this.nightLast = this.hidden.has('night') ? null : nightUniforms(this.night, view, this.buf, NIGHT_CIRCLES)
    applyNight(this.post, this.nightLast)
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
      this.drawnTerrain = { drawn: false, material: null, lights: 0, wallK: null }
      return
    }
    const u = this.terrainMats.uniforms
    setTextures(u, g.field, g.albedo.texture, g.w, g.h, desc.world.h)
    setLook(u, desc.look.terrain)
    // T23.09A: the description's switch (the game's default is off) or the dev knob (`hideWall`).
    u['wallK']!.value = this.wallHidden || desc.caveWall === false ? 0 : 1
    // T23.18B: the tier's slot count (not the forced material's: both materials at a tier get the same list).
    const lights = pickLights(desc.look.lights, view, this.tier === 'low' ? TERRAIN_LIGHTS_LOW : TERRAIN_LIGHTS)
    setLights(u, lights)
    this.pickedLights = lights
    ;(u['ext']!.value as { set(x: number, y: number): void }).set(desc.world.w, desc.world.h)
    const low = (this.terrainForce ?? this.tier) === 'low' && this.terrain.baked && !!g.bake
    u['baked']!.value = low ? g.bake?.texture ?? null : null
    this.terrainMesh.material = low ? this.terrainMats.low : this.terrainMats.full
    // The quad covers the mask, rows 0..h, in the y-up world (`toWorld`).
    this.terrainMesh.scale.set(desc.world.w, desc.world.h, 1)
    const c = toWorld(desc.world.w / 2, desc.world.h / 2, desc.world.h)
    this.terrainMesh.position.set(c.x, c.y, 0)
    this.drawnTerrain = { drawn: true, material: low ? 'low' : 'full', lights: lights.length, wallK: u['wallK']!.value as number }
  }

  /**
   * T23.08: the boxes the foreground may not hide — the description's stick figures (the look-lab; the
   * game's once T23.12 describes its actors) and the boxes a scene hands over (`setOccluders`).
   */
  private occluderBoxes(): Box[] {
    const sticks = (this.desc?.actors ?? []).flatMap((a) => (a.kind === 'stick' && a.box ? [a.box] : []))
    return [...sticks, ...this.occluders]
  }

  /**
   * T23.20: space's moving sky, from the scene's feed — the star moved as a moon set is (a new `setColours`, no
   * rebake), the planet's and the moon's arcs offset from their baked places to the feed's, the parts a check hid
   * taken out (the star's set at weight 0, a band skipped as an empty slot is), and T22.06's star field drawn into the
   * target the sky adds. Nothing on a description without `spaceSky` (the ground; the look-lab's still F3).
   */
  private placeSpace(offsets: { layers: Offset[] }, frame: [number, number]): void {
    const d = this.desc
    const f = this.spaceSource
    if (!d?.spaceSky || !f || !d.look.bg) {
      if (this.spaceDrawn.version !== -2) {
        this.sky.setStars(null, [this.buf.w, this.buf.h])
        this.spaceDrawn.version = -2
      }
      return
    }
    const { places } = d.spaceSky
    const sunKey = JSON.stringify([f.sun, f.hidden.has('sun')])
    if (sunKey !== this.spaceDrawn.sun) {
      const bg = d.look.bg
      const [x, y] = f.sun
      const hid = f.hidden.has('sun')
      this.sky.setColours(
        {
          ...bg,
          ...(bg.sun ? { sun: { ...bg.sun, x, y, vis: hid ? 0 : 1 } } : {}),
          ...(bg.rays ? { rays: [x, y, hid ? 0 : bg.rays[2], bg.rays[3]] as [number, number, number, number] } : {}),
        },
        1,
      )
      // The cast's key light comes from the star (F3's `moon`: the rim light's direction).
      d.look = { ...d.look, moon: starKey(f.sun, frame[0], frame[1]) }
      this.spaceDrawn.sun = sunKey
    }
    offsets.layers[EARTH_BAND] = [f.earth[0] - places.earth[0], f.earth[1] - places.earth[1]]
    offsets.layers[MOON_BAND] = [f.moon[0] - places.moon[0], f.moon[1] - places.moon[1]]
    const hide = [...this.devSkyHidden, ...(f.hidden.has('earth') ? [EARTH_BAND] : []), ...(f.hidden.has('moon') ? [MOON_BAND] : [])]
    const hideKey = JSON.stringify(hide)
    if (hideKey !== this.spaceDrawn.hide) {
      this.sky.hideLayers(hide)
      this.spaceDrawn.hide = hideKey
    }
    const stars = this.spaceStars.render(this.renderer, f, frame, [this.buf.w, this.buf.h])
    this.sky.setStars(stars ? this.spaceStars.target.texture : null, [this.buf.w, this.buf.h])
    this.spaceDrawn.version = f.version
  }

  /** T23.20: the scene's space feed (`space.ts::spaceFeed`) — read on a space description, every frame it draws. */
  setSpaceFeed(feed: SpaceFeed): void {
    this.spaceSource = feed
    this.dirty = true
  }

  /** Dev (T23.20): what the space sky last drew — the bodies' places (frame px) and the stars — or null off space. */
  spaceDrawnInfo(): { sun: [number, number]; earth: [number, number]; moon: [number, number]; stars: number; hidden: string[] } | null {
    const f = this.spaceSource
    if (!this.desc?.spaceSky || !f?.shown) return null
    return { sun: [...f.sun], earth: [...f.earth], moon: [...f.moon], stars: this.spaceStars.drawn, hidden: [...f.hidden] }
  }

  /**
   * T23.18: this scene's game effects come from `feed` (the ordnance layers' records). From now on this renderer draws
   * them — `worldDraws` — wherever the map has a sky (T23.20: space included).
   */
  setFxFeed(feed: FxFeed): void {
    this.fxSource = feed
    feed.readWorld = (x, y, w, h) => this.readPatch(x, y, w, h)
    this.syncFxDrawer()
  }

  /**
   * e2e (`fx/feed.ts::readWorld`): the drawn frame's pixels in a rect of Phaser canvas px, at this canvas's buffer
   * resolution (R18: the low tier's is half), rows bottom-up as GL reads them; null when not drawing this scene.
   */
  private readPatch(x: number, y: number, w: number, h: number): Uint8Array | null {
    if (!this.owns || !this.desc) return null

    const gl = this.gl
    const sx = gl.drawingBufferWidth / this.phaserCanvas.width
    const sy = gl.drawingBufferHeight / this.phaserCanvas.height
    const bx = Math.max(0, Math.round(x * sx))
    const by = Math.max(0, Math.round(y * sy))
    const bw = Math.max(1, Math.min(gl.drawingBufferWidth - bx, Math.round(w * sx)))
    const bh = Math.max(1, Math.min(gl.drawingBufferHeight - by, Math.round(h * sy)))
    const out = new Uint8Array(bw * bh * 4)
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(bx, gl.drawingBufferHeight - by - bh, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, out)
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
    return out
  }

  private syncFxDrawer(): void {
    if (this.fxSource) setWorldDraws(this.fxSource, this.owns && !!this.desc && this.desc.look.bg !== null)
    // T23.31: the world's animals follow the description (one copy: the description's).
    if (this.fxSource) this.fxSource.fauna = this.desc?.fauna ?? 'classic'
  }

  /** This frame's effects into `fxFrame`: the game's, then the scene's (none while `fx` is hidden). Any of the game's? */
  private buildFx(view: ViewRect): boolean {
    const f = this.fxFrame
    clearFrame(f)
    if (this.hidden.has('fx')) return false
    if (this.fxSource?.worldDraws) gameFrame(this.fxSource, f, performance.now() / 1000, this.desc?.look.lights ?? [], this.desc?.spaceSky ? SPACE_SMOKE : null)
    // T23.31: a look with embers in its air (F2's `extra2d`) — drifting in the game, the mockup's still sparks in the lab.
    if (this.desc?.palette?.extra2d === 'embers' && !this.hidden.has('embers')) {
      if (this.desc.id === 'game') emberSprites(f, ambientEmbers(view, performance.now() / 1000))
      // The lab: the mockup draws them on its 2D actor canvas, so they go with the cast (`only=world` has none).
      else this.embersStill = this.desc.actors.length > 0
    } else this.embersStill = false
    const live = f.smoke.length + f.ink.length + f.soft.length + f.ribbons.length + f.discs.length > 0
    const s = this.sceneFxFrame
    f.smoke.push(...s.smoke)
    f.ink.push(...s.ink)
    f.soft.push(...s.soft)
    f.ribbons.push(...s.ribbons)
    f.discs.push(...s.discs)
    if (this.embersStill) emberSprites(f, MOCKUP_SPARKS)
    return live
  }

  /** Dev (T23.18): the scene's effect feed — the ordnance layers' live records, for a shot to stage effects in. */
  get fxFeed(): FxFeed | null {
    return this.fxSource
  }

  /** T23.24: the scene's own clock, s (`scene.time.now`): it stops while the scene is paused, and so do the fireflies. */
  setClock(s: number): void {
    this.clock = s
  }

  /** T23.24: the swarm's fade at this hour — 0 by day, and while a check hides the layer (`hideLayers(['fireflies'])`). */
  private get fireflyFadeNow(): number {
    return this.hidden.has('fireflies') ? 0 : fireflyFade(this.hour.t)
  }

  /**
   * T23.24: seed the swarm once the map's fields are in, and say whether it moved since the last drawn frame — a new
   * step of `FIREFLY_HZ` with any of it showing. Never on a scene without `fireflies` (space, the look-lab).
   */
  private fireflyTick(): boolean {
    const d = this.desc
    const feed = this.terrain.feed
    if (!d?.fireflies) {
      this.swarm = []
      this.swarmKey = null
      return false
    }
    const key = feed && this.terrain.ready ? `${d.fireflies.seed}:${feed.mapKey}` : null
    if (key !== this.swarmKey) {
      const v = key && feed ? feed.view() : null
      this.swarm = v && feed ? placeFireflies(d.fireflies.seed, feed.w, feed.h, fieldSampler(v, feed.w, feed.h)) : []
      this.swarmKey = v ? key : null
    }
    if (this.fireflyFadeNow <= 0 || this.swarm.length === 0) return false
    const step = Math.floor(this.clock * FIREFLY_HZ)
    if (step === this.fireflyStep) return false
    this.fireflyStep = step
    return true
  }

  /** Dev (T23.24): the swarm — fireflies seeded on this map, laid out on the last drawn frame, the fade and the clock. */
  firefliesDrawn(): { seeded: number; drawn: number; fade: number; clock: number; positions: [number, number][] } {
    const l = this.fireflyLayer
    return { seeded: this.swarm.length, drawn: l.drawn, fade: this.fireflyFadeNow, clock: this.clock, positions: l.positions.map((p) => [...p] as [number, number]) }
  }

  /** Dev (T23.18): what the effects layer laid out on its last drawn frame, by list. */
  fxDrawn(): { smoke: number; ink: number; soft: number; ribbons: number; discs: number; flames: number; worldDraws: boolean } {
    return { ...this.fxLayer.drawn, worldDraws: this.fxSource?.worldDraws ?? false }
  }

  /**
   * T23.09: this frame's point lights (mask px, `effectLights.ts`), culled and capped when drawn
   * (`pickLights`). A list that differs from the drawn one is a new picture — it ends the redraw skip —
   * and an unchanged one (two empty lists: no blast on the map) keeps it.
   */
  setLights(lights: Light[]): void {
    if (!this.desc || sameLights(this.desc.look.lights, lights)) return
    this.desc.look.lights = lights
    this.dirty = true
  }

  /**
   * T23.10 (R7): this frame's night view (`worldRenderer-math.ts::NightView`) — the scene's darkness and the circles
   * its player sees in; `null` by day or where there is none (the look-lab). A changed one is a new picture.
   */
  setNightView(v: NightView | null): void {
    const same =
      (v === null && this.night === null) ||
      (v !== null && this.night !== null && v.darkness === this.night.darkness && v.soft === this.night.soft &&
        v.circles.length === this.night.circles.length && v.circles.every((c, i) => c.x === this.night!.circles[i]!.x && c.y === this.night!.circles[i]!.y && c.r === this.night!.circles[i]!.r))
    this.night = v && { ...v, circles: v.circles.map((c) => ({ ...c })) }
    if (!same) this.dirty = true
  }

  /** Dev (T23.10): the night view's uniforms on the last drawn frame (buffer px), or null: none drawn. */
  nightDrawn(): NightUniforms | null {
    return this.nightLast
  }

  /**
   * T23.09C F3: **the one cave-wall switch** — the description's `caveWall` (absent: drawn, as the look-lab's scenes).
   * The game world re-describes a new map with it (`createGameWorld`), the sandbox's button and readout read it.
   */
  get caveWallOn(): boolean {
    return this.desc?.caveWall !== false
  }

  /** T23.09A: draw the cave wall or not, on the description held now (no rebake; the next frame shows it). */
  setCaveWall(on: boolean): void {
    if (!this.desc || (this.desc.caveWall !== false) === on) return
    this.desc.caveWall = on
    this.dirty = true
  }

  /** Dev (T23.09): the point lights held now, before the cull. */
  heldLights(): Light[] {
    return [...(this.desc?.look.lights ?? [])]
  }

  /** T23.08: player boxes, mask px `[x0, y0, x1, y1]`, the foreground leaves fade over (≤ 0.25 alpha). */
  setOccluders(boxes: Box[]): void {
    if (JSON.stringify(boxes) === JSON.stringify(this.occluders)) return
    this.occluders = boxes.map((b) => [...b] as Box)
    this.dirty = true
  }

  /** Dev (T23.08): switch layers/passes off by name — `fogBack`, `fogFront`, `fg`, `bloom`, `grade` (the per-pass cost, the layer hunt). */
  hideLayers(names: string[]): void {
    this.hidden = new Set(names)
    this.dirty = true
  }

  /** Dev (T23.08): what the last frame drew of the fog, leaves and post passes, and the boxes the leaves faded over. */
  atmosphereDrawn(): { fogBack: boolean; fogFront: boolean; cloudSea: boolean; fg: boolean; bloom: boolean; grade: boolean; occluders: Box[]; bloomTarget: [number, number] } {
    const bright = this.post.bloom.renderTargetBright
    return {
      bloomTarget: [bright.width, bright.height],
      fogBack: this.atmos.fogBack.visible,
      fogFront: this.atmos.fogFront.visible,
      cloudSea: this.atmos.cloudSea.visible,
      fg: this.atmos.fg.visible,
      bloom: this.post.bloom.enabled,
      grade: (this.post.output.uniforms as Record<string, { value: unknown }>)['gradeOn']!.value === 1,
      occluders: this.atmos.drawnOccluders.map((b) => [...b] as Box),
    }
  }

  /**
   * Dev (T23.08, look-gate-f1): the foreground layer's own alpha — the leaves drawn alone, unblended,
   * into an 8-bit target at this frame's view — as the max and mean over mask-px box `box` (0–1).
   * What the fade promises is an alpha, so it is read as one; the check also reads its effect in pixels.
   */
  foregroundAlpha(box: Box): { max: number; mean: number; px: number } | null {
    const desc = this.desc
    const v = this.stats.view
    if (!desc || !v || !this.atmos.fg.visible) return null
    const w = this.buf.w
    const h = this.buf.h
    const rt = new WebGLRenderTarget(w, h)
    const only = new Scene()
    const fg = this.atmos.fg
    const parent = fg.parent
    only.add(fg)
    const mat = fg.material as ShaderMaterial
    mat.blending = NoBlending
    const prev = this.renderer.getRenderTarget()
    const clear = this.renderer.getClearColor(new Color())
    const clearA = this.renderer.getClearAlpha()
    this.renderer.setRenderTarget(rt)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.clear()
    this.renderer.render(only, this.camera)
    const px = new Uint8Array(w * h * 4)
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, px)
    this.renderer.setRenderTarget(prev)
    this.renderer.setClearColor(clear, clearA)
    mat.blending = NormalBlending
    parent?.add(fg)
    rt.dispose()
    // Mask px → buffer px (rows bottom-up in the readback).
    let max = 0
    let sum = 0
    let n = 0
    for (let by = 0; by < h; by++) {
      const my = v.y + ((h - by - 0.5) * v.h) / h
      if (my < box[1] || my >= box[3]) continue
      for (let bx = 0; bx < w; bx++) {
        const mx = v.x + ((bx + 0.5) * v.w) / w
        if (mx < box[0] || mx >= box[2]) continue
        const a = px[(by * w + bx) * 4 + 3]! / 255
        max = Math.max(max, a)
        sum += a
        n++
      }
    }
    this.dirty = true
    return { max, mean: n ? sum / n : 0, px: n }
  }

  /**
   * T23.13: `lit.darkHalo` resolved — the actor's halo is that colour where the terrain's `back` field (the cave wall,
   * R17/R24) is set under its body (`lit()`'s halo centre, 14·size above the feet), none elsewhere.
   */
  private withDarkHalo(a: Actor): Actor {
    const lit = a.lit
    if (!lit?.darkHalo || lit.halo) return a
    return this.backAt(a.x, a.y - 14 * lit.size) ? { ...a, lit: { ...lit, halo: lit.darkHalo } } : a
  }

  /** T23.13: is the terrain field's `back` channel set at mask px (x, y)? False before the fields are in. */
  backAt(x: number, y: number): boolean {
    const f = this.terrain.feed
    const v = f?.view()
    if (!f || !v) return false
    const px = Math.floor(x)
    const py = Math.floor(y)
    if (px < 0 || py < 0 || px >= f.w || py >= f.h) return false
    return v[(py * f.w + px) * 4 + 2]! > 127
  }

  /** T23.13/T23.14: this frame's actors (the scenes' cast); a changed list is a new picture. */
  setActors(actors: Actor[]): void {
    this.sceneActors = actors
    this.applyActors()
  }

  /**
   * Dev (a check): draw exactly `actors` instead of the scene's cast until released with `null` — so a check can
   * pose a figure beside a light, or draw the live one without its boots, while the scene goes on gathering its own.
   */
  setDevActors(actors: Actor[] | null): void {
    this.devActors = actors
    this.applyActors()
  }

  private sceneActors: Actor[] = []
  private devActors: Actor[] | null = null

  private applyActors(): void {
    if (!this.desc) return
    const actors = this.devActors ?? this.sceneActors
    if (JSON.stringify(actors) === JSON.stringify(this.desc.actors)) return
    this.desc.actors = actors
    this.dirty = true
  }

  /** Dev (T23.12): the cast as last laid out — quads drawn and the atlas's counters. */
  actorsDrawn(): { quads: number; glows: number; redraws: number; uploads: number; resets: number; cells: number } {
    return { quads: this.actorLayer.drawn, glows: this.glowLayer.drawn, ...this.actorLayer.atlasStats }
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

  /**
   * Dev (T23.19G, `effect-lights`): the lights the terrain last drew — `pickLights`' choice, not the list it chose from.
   * A check that takes one light out of a list longer than the slots must hand back the drawn set without it, or a
   * light that had lost its slot takes it and lights rock the removed one never reached.
   */
  pickedLights: readonly Light[] = []

  /** Dev: the lit terrain as last drawn — whether, which tier's material, how many lights. */
  terrainDrawn(): { drawn: boolean; material: 'full' | 'low' | null; lights: number; wallK: number | null } {
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
    this.devSkyHidden = [...hide]
    this.sky.hideLayers(hide)
    this.spaceDrawn.hide = ''
    this.dirty = true
  }

  /** Dev (T23.19C, `rock-opaque`): the sky drawn flat in one linear colour; `null` restores it. */
  skyFlat(rgb: [number, number, number] | null): void {
    this.sky.setFlat(rgb)
    this.dirty = true
  }

  /** Dev: the sky as last drawn — its layers' factors and periods, and the offsets that frame used. */
  skyInfo(): {
    drawn: boolean
    hidden: number[]
    layers: { parallax: number; period: number }[]
    offsets: Offset[]
    horizon: Offset
    /** T23.11: the hour drawn, and where the moons (and F1's, `sun`) are in frame px, with their visibility. */
    hour: { t: number; u: number | null }
    moons: { x: number; y: number; r: number; vis: number }[]
    sun: { x: number; y: number; r: number; vis: number } | null
  } {
    const bg = this.desc?.look.bg ?? null
    const now = this.skyNow
    return {
      hour: { ...this.hour },
      moons: (now?.moons ?? []).map((m) => ({ x: m.x, y: m.y, r: m.r, vis: m.vis ?? 1 })),
      sun: now?.sun ? { x: now.sun.x, y: now.sun.y, r: now.sun.r, vis: now.sun.vis ?? 1 } : null,
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
    /** T23.04: whether the sky is drawn. */
    sky: boolean
    /** T23.20: whether it is space's sky (F3's, its bodies moved by the scene's space feed). */
    spaceSky: boolean
    /** T23.04B (R21): sky bakes made so far, and the bytes the current bakes hold. */
    skyBakes: number
    skyBakeBytes: number
    /** T23.11: of `skyBakeBytes`, the moon sets' rays — one size at every tier (`skyMaterial.ts::RAY_TEXEL`). */
    skyRayBytes: number
    /** T23.04C (R22): what three holds on the page's one context — the same at every title and every match, or a scene leaked. */
    memory: { geometries: number; textures: number; programs: number }
    /** T23.14C: the programs' names (`material.name`, '?' unnamed), sorted — which one a memory difference is. */
    programNames: string[]
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
      spaceSky: this.sky.mesh.visible && !!this.desc?.spaceSky,
      skyBakes: this.sky.bakeStats.bakes,
      skyBakeBytes: this.sky.bakeStats.bytes,
      skyRayBytes: this.sky.bakeStats.rayBytes,
      memory: {
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        programs: this.renderer.info.programs?.length ?? 0,
      },
      programNames: (this.renderer.info.programs ?? []).map((p) => p.name || '?').sort(),
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
    this.spaceStars.dispose()
    this.atmos.dispose()
    this.backdrop.dispose()
    this.actorLayer.dispose()
    this.glowLayer.dispose()
    this.fireflyLayer.dispose()
    this.fxLayer.dispose()
    if (this.fxSource) {
      setWorldDraws(this.fxSource, false)
      this.fxSource.readWorld = null
    }
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

/** Two light lists with the same lights in the same order (field by field; they are rebuilt every frame). */
export function sameLights(a: readonly Light[], b: readonly Light[]): boolean {
  // T23.09C F8: `EffectLights.frame` hands back the very list it returned last when nothing changed (and never
  // changes a list it has returned), so a still frame is one comparison.
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((l, k) => {
    const m = b[k]!
    return l.x === m.x && l.y === m.y && l.z === m.z && l.r === m.r && l.i === m.i && l.rgb === m.rgb
  })
}

/** What the game scenes tell the world renderer about the map (T23.04: its seed and whether it is space). */
export interface GameMap {
  w: number
  h: number
  /** The map seed's low 32 bits — `welcome`'s in a match, so every client of a round lays out one sky. */
  seed: number
  /** A space map (`MapGenerator.Space`): T23.20's space description (`space.ts`), F3's look. */
  space: boolean
  /**
   * T23.30: the Islands shape — the tops of a sea of cloud below the islands (world y, mask px), and a sky with
   * no far mountains (nothing stands that low, high in the clouds). Absent / null: an ordinary ground map.
   */
  cloudSea?: number | null
  /** T23.31 (docs/78 §A7): the map's world look (`worlds.ts`); absent: classic. Space keeps its own look whatever this says. */
  look?: WorldLookId
}

/**
 * The game's scene description until the sim fills more of it: F1's night look and F5's moonlit day (R7 —
 * T23.11: `setDaylight` blends them by darkness) with its sky laid out as seeded parallax bands for this map
 * (`skyLayout.ts::gameSky`) — a space map is `space.ts::spaceDescription`; the map's size for the y flip; no mask yet
 * (T23.07), no actors (T23.12+). Rebuild it when the map changes.
 */
export function gameDescription(map: GameMap, caveWall = CAVE_WALL_DEFAULT): SceneDescription {
  // T23.20: space is its own world — `P_space`, the asteroid rock, the moving sky (`space.ts`); no day to blend.
  if (map.space) return spaceDescription(map, caveWall)
  // T23.31: the map's look's two ends (classic: F1's night, F5's moonlit day — exactly what was here before).
  const wl = worldLook(map.look)
  const f1 = wl.night.look.bg as Background
  const f5 = wl.day.look.bg as Background
  // T23.11 (R7): night is F1's look, the moonlit day F5's, one seeded sky layout for both (the shapes are equal, so
  // `gameSky` lays both out alike); `setDaylight` blends them. F1's lights are the mockup scene's, not this map's.
  const end = (look: FrameLook, bg: Background): FrameLook => ({
    ...look,
    bg: gameSky(map.seed, map.cloudSea != null ? { ...bg, layers: [] } : bg),
    lights: [],
    fg: null,
  })
  const night = end(wl.night.look, f1)
  return {
    daylight: { day: end(wl.day.look, f5), night, dayPalette: wl.day.palette, nightPalette: wl.night.palette },
    ...(wl.backdrop ? { backdrop: { kind: wl.backdrop, seed: map.seed } } : {}),
    ...(wl.fauna !== 'classic' ? { fauna: wl.fauna } : {}),
    id: 'game',
    camera: { x: 0, y: 0, w: map.w, h: map.h },
    world: { w: map.w, h: map.h },
    masks: null,
    // T23.07: the lit terrain draws the rock. F1's lights are the mockup scene's, not this map's: none here — the
    // scenes hand over their effect lights each frame (T23.09, `setLights`).
    litTerrain: true,
    cloudSea: map.cloudSea ?? null,
    // T23.09A: off by default pending the owner's verdict (`CAVE_WALL_DEFAULT`); the lab's scenes keep F1's walls.
    caveWall,
    // T23.24: fireflies at night, seeded by the map — none in space (`spaceDescription`) or the look-lab.
    fireflies: { seed: map.seed },
    // T23.08: F1's fog, bloom and grade. **No foreground leaves in the game yet** (T23.08B): F1's two
    // clusters are placed for its 1280×720 frame, not a map, and a leaf may never hide a player — which
    // needs the scenes to hand over their players' boxes (`setOccluders`) before leaves are placed.
    look: { ...night },
    palette: wl.night.palette,
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
  /**
   * T23.09A/T23.09C F3: the cave-wall switch — the renderer's description (`?cavewall=` at first, default off; kept across
   * maps) — or null where three did not start; and the switch.
   */
  caveWall(): boolean | null
  setCaveWall(on: boolean): void
  /** T23.09C F3: whether the lit terrain's last drawn frame had its wall (`wallK` 1) — null before it drew. The effect. */
  caveWallDrawn(): boolean | null
  /** T23.09: this frame's effect lights (`effectLights.ts::EffectLights.frame`); dropped where three did not start. */
  setLights(lights: Light[]): void
  /** T23.10 (R7): this frame's night view; dropped where three did not start. */
  setNightView(v: NightView | null): void
  /** T23.11 (R7): this frame's hour — `t` = darkness / `NIGHT_DARKNESS`, `u` the cycle position (`WorldRenderer.setDaylight`). */
  setDaylight(t: number, u: number | null): void
  /** T23.13/T23.14: this frame's cast (`look/actors/`); dropped where three did not start. */
  setActors(actors: Actor[]): void
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
  // T23.09A: the cave wall's switch, from the URL at first; after that the renderer's description holds it (T23.09C F3:
  // one copy — it was here, in the description and in the sandbox, each set by hand).
  const renderer = createWorldRenderer(scene, gameDescription(map, caveWallFromUrl(location.search)))
  const wallNow = (): boolean => (renderer instanceof WorldRenderer ? renderer.caveWallOn : CAVE_WALL_DEFAULT)
  // T23.14: the scene's cast (its players' figures, `actors/cast.ts`), gathered before every render — not after
  // the update: a paused scene still renders, and a figure hidden or re-posed while it is paused (a check's control
  // frame, `stand-on-asteroid`'s actors-hidden instant) must reach the frame drawn next.
  if (renderer instanceof WorldRenderer) {
    // T23.18: the scene's effects, from its ordnance layers' records (`fx/feed.ts`).
    renderer.setFxFeed(fxFeed(scene))
    // T23.20: the scene's space sky (its `SpaceSky` writes the bodies and the stars each frame).
    renderer.setSpaceFeed(spaceFeed(scene))
    // T23.24: and the scene's clock, which a paused scene stops — the fireflies hold still in a frozen frame.
    const gather = (): void => {
      renderer.setActors(castOf(scene))
      renderer.setClock(scene.time.now / 1000)
    }
    scene.events.on('prerender', gather)
    scene.events.once('shutdown', () => scene.events.off('prerender', gather))
  }
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
    mapChanged: (m) => renderer.setScene(gameDescription(m, wallNow())),
    caveWall: () => (renderer instanceof WorldRenderer ? renderer.caveWallOn : null),
    setCaveWall: (on) => {
      if (renderer instanceof WorldRenderer) renderer.setCaveWall(on)
    },
    caveWallDrawn: () => {
      const k = renderer instanceof WorldRenderer ? renderer.terrainDrawn().wallK : null
      return k === null ? null : k > 0
    },
    setTerrain: (feed) => {
      if (renderer instanceof WorldRenderer) renderer.setTerrain(feed, GAME_ALBEDO_TILES[renderer.info().tier])
      else undrawn = feed
    },
    terrainReady: () => renderer instanceof WorldRenderer && renderer.drawsTerrain,
    terrainSwapPending: () => renderer instanceof WorldRenderer && renderer.litTerrainWanted && !renderer.drawsTerrain,
    setLights: (lights) => {
      if (renderer instanceof WorldRenderer) renderer.setLights(lights)
    },
    setNightView: (v) => {
      if (renderer instanceof WorldRenderer) renderer.setNightView(v)
    },
    setDaylight: (t, u) => {
      if (renderer instanceof WorldRenderer) renderer.setDaylight(t, u)
    },
    setActors: (actors) => {
      if (renderer instanceof WorldRenderer) renderer.setActors(actors)
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

