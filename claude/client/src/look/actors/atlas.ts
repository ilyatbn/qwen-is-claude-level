/**
 * T23.12 (R12): the actor atlas — every actor drawn by code into a cell of one shared texture, a cell redrawn
 * only when its drawing changes (`cell.ts::cellKey`: the light is not in it — the shader applies that).
 *
 * The texture is `ATLAS_SIZE`² RGBA8, premultiplied, in **64-px base cells**; an actor's cell spans as many as
 * its images need (`cell.ts`, each its box's size, two to a row: under | mask, ink | fill extras, rim extras |
 * far-rim extras — the last three only for an actor with extras), first-fit on an
 * occupancy grid. A cell unused for `EVICT_FRAMES` frames is freed when room is needed; if there is still none,
 * the atlas is cleared and this frame's cells drawn again (counted: `stats.resets`).
 *
 * A drawn cell goes up by itself (`texSubImage2D` of its scratch canvas), so a frame uploads only what
 * changed — none when nothing did. The painter is injected: vitest runs this with a fake one (no canvas in node).
 */
import type { Actor } from '../scene'
import { actorRect, cellKey, drawRole, hasExtras, snapOffsets, type PassOffsets, type Role } from './cell'
import type { G } from './draw'

/** The atlas texture's side, px. */
export const ATLAS_SIZE = 2048
/** The allocation grain, px (the research's 64×64 cell; a bigger actor spans several). */
export const BASE_CELL = 64
/** Frames a cell survives unused before its room may be taken. */
export const EVICT_FRAMES = 120

const GRID = ATLAS_SIZE / BASE_CELL

/** Where a cell sits: its slot in the atlas (px) and the size of each of its four images. */
export interface Cell {
  x: number
  y: number
  /** One image's size, px (the actor's rect). */
  w: number
  h: number
  /** Grid span, in base cells. */
  gw: number
  gh: number
  lastUsed: number
}

/** A cell's images in order: index k sits at column k % 2, row ⌊k / 2⌋ (`layer.ts`'s `img(k)` reads them so). */
export const IMAGES: readonly { role: Role; pass?: number }[] = [
  { role: 'under' },
  { role: 'mask' },
  { role: 'ink' },
  { role: 'extras', pass: 0 },
  { role: 'extras', pass: 1 },
  { role: 'extras', pass: 2 },
]

/** What draws a cell and puts it on the GPU (the browser's: `layer.ts::canvasPainter`). */
export interface Painter {
  /** A cleared 2D context `w × h` to draw one cell's four images into. */
  begin(w: number, h: number): G
  /** Upload what `begin` returned to the atlas at (x, y). */
  upload(x: number, y: number): void
}

export class ActorAtlas {
  readonly stats = { redraws: 0, uploads: 0, resets: 0, cells: 0 }
  private readonly cells = new Map<string, Cell>()
  private readonly used = new Uint8Array(GRID * GRID)
  private frame = 0

  constructor(private readonly painter: Painter) {}

  /** Start a frame: cells looked up from now on are this frame's. */
  beginFrame(): void {
    this.frame++
  }

  /**
   * The cell for `a`, drawn now if its key has none; `offs` are its passes' offsets this frame (read only for
   * an actor with extras). `null` if it cannot fit even in an empty atlas.
   */
  cellFor(a: Actor, offs: PassOffsets | null = null): Cell | null {
    const key = cellKey(a, offs)
    const have = this.cells.get(key)
    if (have) {
      have.lastUsed = this.frame
      return have
    }
    const r = actorRect(a)
    const w = r[2] - r[0]
    const h = r[3] - r[1]
    const rows = hasExtras(a) ? 3 : 2
    const gw = Math.ceil((2 * w) / BASE_CELL)
    const gh = Math.ceil((rows * h) / BASE_CELL)
    if (gw > GRID || gh > GRID) return null
    let at = this.find(gw, gh)
    if (!at) {
      this.evict()
      at = this.find(gw, gh)
    }
    if (!at) {
      // Full of this frame's cells: start again (the caller's other actors redraw as they are looked up).
      this.cells.clear()
      this.used.fill(0)
      this.stats.resets++
      at = this.find(gw, gh)
      if (!at) return null
    }
    const cell: Cell = { x: at[0] * BASE_CELL, y: at[1] * BASE_CELL, w, h, gw, gh, lastUsed: this.frame }
    this.mark(at[0], at[1], gw, gh, 1)
    this.cells.set(key, cell)
    this.draw(a, cell, rows, offs ? snapOffsets(offs) : null)
    this.stats.cells = this.cells.size
    return cell
  }

  private draw(a: Actor, c: Cell, rows: number, offs: PassOffsets | null): void {
    const g = this.painter.begin(2 * c.w, rows * c.h)
    IMAGES.slice(0, 2 * rows).forEach(({ role, pass }, k) => {
      const i = k % 2
      const j = Math.floor(k / 2)
      g.save()
      g.beginPath()
      g.rect(i * c.w, j * c.h, c.w, c.h)
      g.clip()
      g.translate(i * c.w, j * c.h)
      drawRole(g, a, role, pass !== undefined && offs ? offs[pass] : [0, 0])
      g.restore()
    })
    this.painter.upload(c.x, c.y)
    this.stats.redraws++
    this.stats.uploads++
  }

  /** First fit, row-major, over the occupancy grid. */
  private find(gw: number, gh: number): [number, number] | null {
    for (let y = 0; y + gh <= GRID; y++) {
      for (let x = 0; x + gw <= GRID; x++) {
        if (this.free(x, y, gw, gh)) return [x, y]
      }
    }
    return null
  }

  private free(x: number, y: number, gw: number, gh: number): boolean {
    for (let j = y; j < y + gh; j++) for (let i = x; i < x + gw; i++) if (this.used[j * GRID + i]) return false
    return true
  }

  private mark(x: number, y: number, gw: number, gh: number, v: number): void {
    for (let j = y; j < y + gh; j++) for (let i = x; i < x + gw; i++) this.used[j * GRID + i] = v
  }

  /** Free every cell unused for `EVICT_FRAMES` frames. */
  private evict(): void {
    for (const [k, c] of this.cells) {
      if (this.frame - c.lastUsed < EVICT_FRAMES) continue
      this.mark(c.x / BASE_CELL, c.y / BASE_CELL, c.gw, c.gh, 0)
      this.cells.delete(k)
    }
    this.stats.cells = this.cells.size
  }
}
