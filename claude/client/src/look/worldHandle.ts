/**
 * T23.03: `window.__world`, the world renderer's dev handle (dev surface only; `no-dev-surface`
 * greps for it). Markers drawn in **both** canvases, and a same-frame readback of each — in
 * Phaser's `postrender`, after both have drawn this frame — so `world-canvas` can say whether
 * the two canvases agree on where the world is, frame by frame.
 */
import type Phaser from 'phaser'
import type { RenderStats, SceneRenderer } from './renderer'
import type { ViewRect } from './scene'
import type { WorldRenderer } from './worldRenderer'
import { sameView } from './worldRenderer-math'

/** What a dev check can reach: `window.__world` (dev surface only). */
export interface WorldHandle {
  backend: SceneRenderer['backend']
  frames(): number
  view(): ViewRect | null
  info(): ReturnType<WorldRenderer['info']> | null
  /** Add a world-anchored marker to **both** canvases: three's quad and a Phaser rect. */
  addMarker(x: number, y: number, w: number, h: number): void
  /** Remove every marker from both canvases. */
  clearMarkers(): void
  /**
   * Record the next `n` drawn frames: the marker's centre in each canvas, read back in the same
   * frame — x along CSS row `row`, y along CSS column `col`.
   */
  probe(n: number, row: number, col: number): Promise<ProbeSample[]>
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
  /** T23.04: the sky as last drawn — layers' parallax factors, periods and the offsets used. */
  sky(): ReturnType<WorldRenderer['skyInfo']> | null
  /** T23.04: draw only the sky layers not listed (`look-sky` isolates one band). */
  hideSkyLayers(hide: number[]): void
  /** T23.04B: ms per drawn frame over `n` forced draws, each finished on the GPU (`WorldRenderer.timeDraws`). */
  drawCost(n: number): ReturnType<WorldRenderer['timeDraws']>
}

export interface ProbeSample {
  /** Phaser's frame counter at the readback. */
  frame: number
  /** Whether the world renderer drew this frame (it skips unchanged ones). */
  drew: boolean
  /** Marker centre, CSS px from the canvas's left edge along the row; `null` if not on it. */
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

export function exposeWorldHandle(scene: Phaser.Scene, r: SceneRenderer, three: WorldRenderer | null): void {
  const stats = (r as { stats?: RenderStats }).stats
  const rects: Phaser.GameObjects.Rectangle[] = []
  const handle: WorldHandle = {
    backend: r.backend,
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
      const game = scene.game
      const before = stats?.frames ?? 0
      three.invalidate()
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
          resolve({ w, h, view: v ? { ...v } : null, rgba: btoa(bin) })
        }
        game.events.on('postrender', onPost)
      })
    },
    sky: () => three?.skyInfo() ?? null,
    hideSkyLayers(hide) {
      three?.hideSkyLayers(hide)
    },
    drawCost: (n) => three?.timeDraws(n) ?? null,
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
    probe(n, row, col) {
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
        const x = magentaCentre(r.row, r.w)
        const y = magentaCentre(c.col, c.h)
        return [x === null ? null : x / sx, y === null ? null : y / sy]
      }
      return new Promise((resolve) => {
        const onPost = (): void => {
          const [phaserX, phaserY] = pgl ? locate(pgl, game.canvas) : [null, null]
          // A frame the renderer skipped (nothing changed, `WorldRenderer.render`) still shows its
          // last drawn picture, but the undrawn buffer reads back blank: reuse that frame's reading.
          const drew = (stats?.frames ?? 0) !== lastFrames
          lastFrames = stats?.frames ?? 0
          if (three && drew) lastThree = locate(three.gl, three.canvas)
          const [threeX, threeY] = three ? lastThree : [null, null]
          const v = stats?.view ?? null
          const wv = scene.cameras.main.worldView
          const worldView = { x: wv.x, y: wv.y, w: wv.width, h: wv.height }
          samples.push({
            frame: game.loop.frame,
            drew,
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
