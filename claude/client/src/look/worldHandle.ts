/**
 * T23.03: `window.__world`, the world renderer's dev handle (dev surface only; `no-dev-surface`
 * greps for it). Markers drawn in **both** canvases, and a same-frame readback of each — in
 * Phaser's `postrender`, after both have drawn this frame — so `world-canvas` can say whether
 * the two canvases agree on where the world is, frame by frame.
 */
import type Phaser from 'phaser'
import type { RenderStats, SceneRenderer } from './renderer'
import type { SceneDescription, ViewRect } from './scene'
import type { WorldRenderer } from './worldRenderer'
import { acesSrgb, hexLinear } from './worldRenderer-math'

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

export function exposeWorldHandle(scene: Phaser.Scene, r: SceneRenderer, three: WorldRenderer | null, desc: SceneDescription): void {
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
      // Draw the first probed frame for certain, so there is a reading to carry over skipped ones.
      three?.invalidate()
      let lastFrames = stats?.frames ?? 0
      let lastThree: [number | null, number | null] = [null, null]
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
          // A frame the renderer skipped (nothing changed, `WorldRenderer.render`) still shows its
          // last drawn picture, but the undrawn buffer reads back blank: reuse that frame's reading.
          const drew = (stats?.frames ?? 0) !== lastFrames
          lastFrames = stats?.frames ?? 0
          if (three && drew) lastThree = locate(three.gl, three.canvas)
          const [threeX, threeY] = three ? lastThree : [null, null]
          const v = stats?.view ?? null
          samples.push({ frame: game.loop.frame, drew, phaserX, threeX, phaserY, threeY, viewX: v?.x ?? null, viewY: v?.y ?? null })
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
