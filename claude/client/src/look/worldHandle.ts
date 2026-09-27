/**
 * T23.03: `window.__world`, the world renderer's dev handle (dev surface only; `no-dev-surface`
 * greps for it). Markers drawn in **both** canvases, and a same-frame readback of each — in
 * Phaser's `postrender`, after both have drawn this frame — so `world-canvas` can say whether
 * the two canvases agree on where the world is, frame by frame.
 */
import type Phaser from 'phaser'
import type { RenderStats, SceneRenderer } from './renderer'
import type { Actor, Light, ViewRect } from './scene'
import type { WorldRenderer } from './worldRenderer'
import { sameView } from './worldRenderer-math'
import { hashProbe, readAlbedo, repaintAlbedo, scorchOnly, takeAlbedoPaints, terrainInfo } from './terrainDev'

/** What a dev check can reach: `window.__world` (dev surface only). */
export interface WorldHandle {
  backend: SceneRenderer['backend']
  /** T23.04C: the Phaser scene this handle belongs to — a check crossing scenes must not read the last scene's. */
  scene: string
  frames(): number
  view(): ViewRect | null
  info(): ReturnType<WorldRenderer['info']> | null
  /** Add a world-anchored marker to **both** canvases: three's quad and a Phaser rect. */
  addMarker(x: number, y: number, w: number, h: number): void
  /** Remove every marker from both canvases. */
  clearMarkers(): void
  /**
   * Record the next `n` drawn frames: the marker's centre in each canvas, read back in the same
   * frame — x along CSS row `row`, y along CSS column `col` — where the line crosses a bar `bar` CSS px
   * thick (T23.09B: `crossing`; a run of any other length is not the marker).
   */
  probe(n: number, row: number, col: number, bar: number): Promise<ProbeSample[]>
  /** Phaser's canvas alpha at page CSS points (inside its box), read back after the next drawn frame; `null` on Canvas Phaser. */
  phaserAlpha(points: [number, number][]): Promise<number[] | null>
  /**
   * T23.04: the world canvas's own pixels at page CSS points, read back in a frame it drew (the
   * frame is forced) — the 2×2 buffer block each point falls in, as `[min, max]` per channel,
   * because the page shows the buffer CSS-scaled (the low tier is half size) and so blends it.
   * `null` without three.js.
   */
  worldPixels(points: [number, number][]): Promise<{ min: number[]; max: number[] }[] | null>
  /**
   * T23.04: the whole world canvas, read back in a frame it drew (forced), with the view that
   * frame was drawn from — RGBA rows top-down, base64. `null` without three.js.
   */
  readFrame(): Promise<{ w: number; h: number; view: ViewRect | null; rgba: string } | null>
  /**
   * T23.07: the **next** frame the world canvas draws on its own (nothing forced), read back in that
   * frame, with Phaser's frame counter then — so a check can call something between frames and read
   * the first frame drawn after it (`look-terrain`: a crater lit in the frame it is carved).
   */
  readNextFrame(): Promise<{ w: number; h: number; view: ViewRect | null; rgba: string; loopFrame: number } | null>
  /**
   * T23.14, dev: `n` crops of `size` buffer px round `track()` (mask px, read each frame), one every `every` drawn
   * frames, read back in their own frames — an animation strip of a moving figure without a whole-frame round trip.
   */
  recordCrops(n: number, every: number, size: number, track: () => { x: number; y: number }): Promise<{ rgba: string; at: { x: number; y: number } }[]>
  /** T23.07: Phaser's frame counter now (`game.loop.frame`). */
  loopFrame(): number
  /** T23.04: the sky as last drawn — layers' parallax factors, periods and the offsets used. */
  sky(): ReturnType<WorldRenderer['skyInfo']> | null
  /** T23.04: draw only the sky layers not listed (`look-sky` isolates one band). */
  hideSkyLayers(hide: number[]): void
  /** T23.04B: ms per drawn frame over `n` forced draws, each finished on the GPU (`WorldRenderer.timeDraws`). */
  drawCost(n: number): ReturnType<WorldRenderer['timeDraws']>
  /** T23.06: the terrain fields/albedo state (`terrainDev.ts::terrainInfo`; `ready` is T23.07's switch — F3). */
  terrain(): ReturnType<typeof terrainInfo> | null
  /** T23.06: albedo RGBA over a world rect, rows top-down, base64 (null before the GPU side exists). */
  readAlbedo(x: number, y: number, w: number, h: number): string | null
  /** T23.06: the GLSL hash's 10k words, index order (`albedo.ts::probeInput`). */
  hashProbe(): number[] | null
  /** T23.06: draw the albedo flat instead of the world. */
  showAlbedo(on: boolean): void
  /** T23.06: the albedo rects repainted since the last call (and, `measure`, time dirty updates to GPU completion). */
  albedoPaints(measure?: boolean): { x: number; y: number; w: number; h: number }[]
  /** T23.06: repaint the whole albedo from the fields now — the full pass an incremental one must equal. */
  repaintAlbedo(): void
  /** T23.06B (F8): scorch radius `r` at `(x, y)` with no carve — `TerrainGpu.addScorch`; the rect repainted. */
  scorchOnly(x: number, y: number, r: number): { x: number; y: number; w: number; h: number } | null
  /** T23.07: the lit terrain as last drawn (whether, which material, lights uploaded); `null` without three.js. */
  litTerrain(): ReturnType<WorldRenderer['terrainDrawn']> | null
  /** T23.07: draw the terrain with one tier's material whatever the tier (`null`: the tier's own) — the bake's control. */
  forceTerrainMaterial(m: 'full' | 'low' | null): void
  /** T23.07: leave the lit terrain out of the world canvas (`gate-ground`: rock is what changes). */
  hideTerrain(hide: boolean): void
  /** T23.07B (F4): draw the lit terrain without its cave wall (`gate-ground`: rock changes with the terrain, not with the wall). */
  hideWall(hide: boolean): void
  /** T23.08: switch the fog, leaves or post passes off by name (`fogBack`, `fogFront`, `fg`, `bloom`, `grade`); `[]` restores. */
  hideLayers(names: string[]): void
  /** T23.09: the point lights the renderer holds now (before `pickLights`); `null` without three.js. */
  lights(): Light[] | null
  /**
   * T23.09: replace them. A frozen scene hands over no new list, so this holds until it resumes — a
   * check draws the same frame with one light removed (`effect-lights`' control frame).
   */
  setLights(lights: Light[]): void
  /** T23.13: draw these actors instead of the scene's cast (a check places a figure beside a light); `null` releases. */
  setActors(actors: Actor[] | null): void
  /** T23.13: the terrain's `back` field at mask px (x, y) — where the dark halo turns on. */
  backAt(x: number, y: number): boolean
  /** T23.08: player boxes (mask px) the foreground leaves fade over. */
  setOccluders(boxes: [number, number, number, number][]): void
  /** T23.08: what the last frame drew of the fog, leaves and post passes, and the boxes the leaves faded over. */
  atmosphere(): ReturnType<WorldRenderer['atmosphereDrawn']> | null
  /** T23.12: the cast as last laid out — quads, and the atlas's redraws/uploads/resets/cells. */
  actors(): ReturnType<WorldRenderer['actorsDrawn']> | null
  /** T23.08: the foreground leaves' own alpha over a mask-px box (`WorldRenderer.foregroundAlpha`). */
  foregroundAlpha(box: [number, number, number, number]): ReturnType<WorldRenderer['foregroundAlpha']>
}

export interface ProbeSample {
  /** Phaser's frame counter at the readback. */
  frame: number
  /** Whether the world renderer drew this frame (it skips unchanged ones). */
  drew: boolean
  /** Marker centre, CSS px from the canvas's left edge along the row; `null` if not on it. */
  /** T23.09B: the first canvas and line (e.g. `three row`) with two bar-thick crossings so far, else `null`. */
  ambiguous: string | null
  /** T23.09B: every magenta run on the probe row (`x`) and column (`y`) in each canvas, CSS px `[first, last]`. */
  runs: { phaser: { x: [number, number][]; y: [number, number][] }; three: { x: [number, number][]; y: [number, number][] } }
  phaserX: number | null
  threeX: number | null
  /** Marker centre, CSS px from the canvas's top edge along the column; `null` if not on it. */
  phaserY: number | null
  threeY: number | null
  /** The view the world renderer drew this frame. */
  viewX: number | null
  viewY: number | null
  /**
   * T23.03B (F1): Phaser's `cameras.main.worldView` at this frame's readback, and the view the
   * world canvas **last drew** (it keeps showing that picture on a skipped frame). They must be
   * `sameView` on every frame: a redraw skip that missed a change leaves them different.
   */
  worldView: ViewRect
  drawnView: ViewRect | null
  /** `sameView(worldView, drawnView)` — the redraw skip's own comparison, so the check and the skip cannot disagree about what "same" means. */
  same: boolean
}

/** Every magenta run in a strip of RGBA px, `[first, last]` px along it (T23.09B: the candidates). */
function magentaRuns(row: Uint8Array, w: number): [number, number][] {
  const out: [number, number][] = []
  let start = -1
  for (let x = 0; x < w; x++) {
    const hit = row[x * 4]! > 150 && row[x * 4 + 2]! > 150 && row[x * 4 + 1]! < 100
    if (hit && start < 0) start = x
    if (!hit && start >= 0) {
      out.push([start, x - 1])
      start = -1
    }
  }
  if (start >= 0) out.push([start, w - 1])
  return out
}

/**
 * T23.09B: where a probe line **crosses** a marker bar — the centre of the one magenta run whose length is
 * the bar's thickness (`bar`, same px as the runs, ± `CROSSING_SLACK`). A run of any other length is not a
 * crossing: the line lying *along* a bar (its length, clipped by the canvas and cut by whatever the sky draws
 * over it — the moon's glow did, 313.5 px from Phaser's reading), or a map feature. Two crossings: ambiguous.
 */
export function crossing(runs: readonly [number, number][], bar: number): { at: number | null; ambiguous: boolean } {
  const fits = runs.filter(([a, b]) => Math.abs(b - a + 1 - bar) <= Math.max(CROSSING_SLACK, bar * 0.25))
  if (fits.length !== 1) return { at: null, ambiguous: fits.length > 1 }
  const [a, b] = fits[0]!
  return { at: (a + b) / 2, ambiguous: false }
}

/** px either side of the bar's thickness a crossing run may measure (edge blending, the tier's scaling). */
const CROSSING_SLACK = 3

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

export function exposeWorldHandle(scene: Phaser.Scene, r: SceneRenderer, three: WorldRenderer | null): void {
  const stats = (r as { stats?: RenderStats }).stats
  const rects: Phaser.GameObjects.Rectangle[] = []
  const handle: WorldHandle = {
    backend: r.backend,
    scene: scene.scene.key,
    frames: () => stats?.frames ?? 0,
    view: () => stats?.view ?? null,
    info: () => three?.info() ?? null,
    addMarker(x, y, w, h) {
      three?.addMarker(x, y, w, h)
      rects.push(scene.add.rectangle(x, y, w, h, 0xff00ff).setOrigin(0, 0).setDepth(1e6))
    },
    clearMarkers() {
      three?.clearMarkers()
      for (const r of rects) r.destroy()
      rects.length = 0
    },
    worldPixels(points) {
      if (!three) return Promise.resolve(null)
      const game = scene.game
      const before = stats?.frames ?? 0
      three.invalidate()
      return new Promise((resolve) => {
        const onPost = (): void => {
          // Only a frame the world canvas drew has a buffer to read (it is not preserved).
          if ((stats?.frames ?? 0) === before) return
          game.events.off('postrender', onPost)
          const gl = three.gl
          const box = three.canvas.getBoundingClientRect()
          const W = gl.drawingBufferWidth
          const H = gl.drawingBufferHeight
          const sx = W / (box.width || W)
          const sy = H / (box.height || H)
          const out = points.map(([x, y]) => {
            // The buffer px either side of the CSS pixel's centre, clamped to the buffer.
            const bx = ((x + 0.5 - box.left) * sx) - 0.5
            const by = ((y + 0.5 - box.top) * sy) - 0.5
            const x0 = Math.min(W - 2, Math.max(0, Math.floor(bx)))
            const y0 = Math.min(H - 2, Math.max(0, Math.floor(by)))
            const raw = new Uint8Array(2 * 2 * 4)
            const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.readPixels(x0, H - 1 - (y0 + 1), 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, raw)
            gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
            const min = [255, 255, 255]
            const max = [0, 0, 0]
            for (let i = 0; i < 4; i++) {
              for (let c = 0; c < 3; c++) {
                min[c] = Math.min(min[c]!, raw[i * 4 + c]!)
                max[c] = Math.max(max[c]!, raw[i * 4 + c]!)
              }
            }
            return { min, max }
          })
          resolve(out)
        }
        game.events.on('postrender', onPost)
      })
    },
    readFrame() {
      if (!three) return Promise.resolve(null)
      three.invalidate()
      return handle.readNextFrame()
    },
    loopFrame: () => scene.game.loop.frame,
    recordCrops(n, every, size, track) {
      if (!three) return Promise.resolve([])
      const game = scene.game
      const out: { rgba: string; at: { x: number; y: number } }[] = []
      let k = 0
      let last = stats?.frames ?? 0
      three.invalidate()
      return new Promise((resolve) => {
        const onPost = (): void => {
          // Every frame is drawn while recording (an unchanged scene would otherwise skip — `mustDraw`).
          three.invalidate()
          if ((stats?.frames ?? 0) === last) return
          last = stats?.frames ?? 0
          if (k++ % every) return
          const gl = three.gl
          const v = stats?.view
          if (!v) return
          const w = gl.drawingBufferWidth
          const h = gl.drawingBufferHeight
          const at = track()
          const sc = w / v.w
          const x0 = Math.max(0, Math.min(w - size, Math.round((at.x - v.x) * sc - size / 2)))
          const y0 = Math.max(0, Math.min(h - size, Math.round((at.y - v.y) * sc - size * 0.6)))
          const raw = new Uint8Array(size * size * 4)
          const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.readPixels(x0, h - y0 - size, size, size, gl.RGBA, gl.UNSIGNED_BYTE, raw)
          gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
          const img = new Uint8Array(size * size * 4)
          for (let y = 0; y < size; y++) img.set(raw.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4)
          let bin = ''
          for (let i = 0; i < img.length; i += 0x8000) bin += String.fromCharCode(...img.subarray(i, i + 0x8000))
          out.push({ rgba: btoa(bin), at: { ...at } })
          if (out.length >= n) {
            game.events.off('postrender', onPost)
            resolve(out)
          }
        }
        game.events.on('postrender', onPost)
      })
    },
    readNextFrame() {
      if (!three) return Promise.resolve(null)
      const game = scene.game
      const before = stats?.frames ?? 0
      return new Promise((resolve) => {
        const onPost = (): void => {
          if ((stats?.frames ?? 0) === before) return
          game.events.off('postrender', onPost)
          const gl = three.gl
          const w = gl.drawingBufferWidth
          const h = gl.drawingBufferHeight
          const raw = new Uint8Array(w * h * 4)
          const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
          gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
          // GL rows run bottom-up; flip to top-down.
          const out = new Uint8Array(w * h * 4)
          for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
          let bin = ''
          for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000))
          const v = stats?.view ?? null
          resolve({ w, h, view: v ? { ...v } : null, rgba: btoa(bin), loopFrame: game.loop.frame })
        }
        game.events.on('postrender', onPost)
      })
    },
    sky: () => three?.skyInfo() ?? null,
    hideSkyLayers(hide) {
      three?.hideSkyLayers(hide)
    },
    drawCost: (n) => three?.timeDraws(n) ?? null,
    terrain: () => (three ? terrainInfo(three.terrain, three.albedoViewOn) : null),
    readAlbedo(x, y, w, h) {
      const px = three ? readAlbedo(three.terrain, { x, y, w, h }) : null
      if (!px) return null
      let bin = ''
      for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode(...px.subarray(i, i + 0x8000))
      return btoa(bin)
    },
    hashProbe: () => (three ? Array.from(hashProbe(three.renderer3, three.terrain)) : null),
    showAlbedo(on) {
      three?.showAlbedo(on)
    },
    repaintAlbedo() {
      if (three) repaintAlbedo(three.terrain)
    },
    scorchOnly: (x, y, r) => (three ? scorchOnly(three.terrain, x, y, r) : null),
    litTerrain: () => three?.terrainDrawn() ?? null,
    hideTerrain(hide) {
      if (!three) return
      three.terrainHidden = hide
      three.invalidate()
    },
    hideWall(hide) {
      if (!three) return
      three.wallHidden = hide
      three.invalidate()
    },
    hideLayers(names) {
      three?.hideLayers(names)
    },
    lights: () => (three ? three.heldLights() : null),
    setActors(actors) {
      three?.setDevActors(actors)
    },
    backAt: (x, y) => three?.backAt(x, y) ?? false,
    setLights(lights) {
      three?.setLights(lights)
    },
    setOccluders(boxes) {
      three?.setOccluders(boxes)
    },
    atmosphere: () => three?.atmosphereDrawn() ?? null,
    actors: () => three?.actorsDrawn() ?? null,
    foregroundAlpha: (box) => three?.foregroundAlpha(box) ?? null,
    forceTerrainMaterial(m) {
      if (!three) return
      three.terrainForce = m
      three.invalidate()
    },
    albedoPaints(measure) {
      if (three && measure !== undefined) three.terrain.measure = measure
      return three ? takeAlbedoPaints(three.terrain) : []
    },
    phaserAlpha(points) {
      const game = scene.game
      const pgl = (game.renderer as { gl?: WebGLRenderingContext }).gl ?? null
      if (!pgl) return Promise.resolve(null)
      return new Promise((resolve) => {
        game.events.once('postrender', () => {
          // Page CSS points → Phaser's buffer: FIT letterboxes the canvas (at 1100×900 it sits
          // at top 140.625, 618.75 tall), so subtract its box before scaling (T23.03B).
          const box = game.canvas.getBoundingClientRect()
          const sx = pgl.drawingBufferWidth / (box.width || pgl.drawingBufferWidth)
          const sy = pgl.drawingBufferHeight / (box.height || pgl.drawingBufferHeight)
          const clampTo = (v: number, n: number): number => Math.min(n - 1, Math.max(0, v))
          const out = points.map(([x, y]) => {
            const { row } = readRow(pgl, clampTo(Math.round((y - box.top) * sy), pgl.drawingBufferHeight))
            return row[clampTo(Math.round((x - box.left) * sx), pgl.drawingBufferWidth) * 4 + 3]!
          })
          resolve(out)
        })
      })
    },
    probe(n, row, col, bar) {
      const game = scene.game
      const pgl = (game.renderer as { gl?: WebGLRenderingContext }).gl ?? null
      const samples: ProbeSample[] = []
      // Draw the first probed frame for certain, so there is a reading to carry over skipped ones.
      three?.invalidate()
      let lastFrames = stats?.frames ?? 0
      let lastThree: [number | null, number | null] = [null, null]
      /** The marker's centre in one canvas, CSS px, from a row and a column read in this frame. */
      const locate = (gl: WebGLRenderingContext, el: HTMLCanvasElement): [number | null, number | null] => {
        // Fractional CSS box (F5): FIT can give 618.75 px, and `clientHeight` says 619.
        const box = el.getBoundingClientRect()
        const cw = box.width || gl.drawingBufferWidth
        const ch = box.height || gl.drawingBufferHeight
        const sx = gl.drawingBufferWidth / cw
        const sy = gl.drawingBufferHeight / ch
        const r = readRow(gl, Math.round(row * sy))
        const c = readCol(gl, Math.round(col * sx))
        lastRuns = {
          x: magentaRuns(r.row, r.w).map(([a, b]) => [a / sx, b / sx]),
          y: magentaRuns(c.col, c.h).map(([a, b]) => [a / sy, b / sy]),
        }
        const x = crossing(lastRuns.x, bar)
        const y = crossing(lastRuns.y, bar)
        if ((x.ambiguous || y.ambiguous) && !ambiguous) ambiguous = `${el === game.canvas ? 'phaser' : 'three'} ${x.ambiguous ? 'row' : 'column'}`
        return [x.at, y.at]
      }
      let ambiguous: string | null = null
      let lastRuns: { x: [number, number][]; y: [number, number][] } = { x: [], y: [] }
      let threeRuns: { x: [number, number][]; y: [number, number][] } = { x: [], y: [] }
      return new Promise((resolve) => {
        const onPost = (): void => {
          const [phaserX, phaserY] = pgl ? locate(pgl, game.canvas) : [null, null]
          const phaserRuns = lastRuns
          // A frame the renderer skipped (nothing changed, `WorldRenderer.render`) still shows its
          // last drawn picture, but the undrawn buffer reads back blank: reuse that frame's reading.
          const drew = (stats?.frames ?? 0) !== lastFrames
          lastFrames = stats?.frames ?? 0
          if (three && drew) {
            lastThree = locate(three.gl, three.canvas)
            threeRuns = lastRuns
          }
          const [threeX, threeY] = three ? lastThree : [null, null]
          const v = stats?.view ?? null
          const wv = scene.cameras.main.worldView
          const worldView = { x: wv.x, y: wv.y, w: wv.width, h: wv.height }
          samples.push({
            frame: game.loop.frame,
            drew,
            runs: { phaser: phaserRuns, three: threeRuns },
            ambiguous,
            phaserX,
            threeX,
            phaserY,
            threeY,
            viewX: v?.x ?? null,
            viewY: v?.y ?? null,
            worldView,
            drawnView: v ? { ...v } : null,
            same: sameView(worldView, v),
          })
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
