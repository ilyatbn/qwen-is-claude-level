/**
 * Mask → stencil → chunk (flat since T23.07 — see `BakeLayers`).
 *
 * The only per-pixel loop in the renderer, so it is the one place in the client
 * where micro-decisions matter (`docs/12-map-render.md` §8):
 *
 * - **Allocate nothing per bake.** `BakeScratch` owns the canvases and the
 *   `ImageData`; four bakes a frame allocating a 256×256 `ImageData` each would be
 *   1 MB of garbage per frame.
 * - **Never `getImageData` during a bake.** It forces a GPU readback and dominates
 *   the frame time. All mask data comes from WASM memory.
 * - Write the stencil through a `Uint32Array` view — one 32-bit store per pixel
 *   instead of four 8-bit ones.
 */

import type { Core } from '../core'
import { C } from '../core'
import { TERRAIN_PALETTE } from '../look/albedo'
import {
  BackdropMask,
  CORE_HEART_FRAC,
  coreHeartColour,
  IRON_TINT,
  IRON_TINT_ALPHA,
  type IronDisc,
  CORE_RIM,
  backdropBits,
  coresInChunk,
  stencilBits,
  type CoreDisc,
} from './chunkBake-math'

export {
  chunkOrigin,
  solidIn,
  stencilBits,
  MaskSnapshot,
  BackdropMask,
  backdropBits,
} from './chunkBake-math'

/** Reusable scratch buffers. Allocated once, never per bake. */
export class BakeScratch {
  readonly stencilCanvas: HTMLCanvasElement
  readonly stencilCtx: CanvasRenderingContext2D
  readonly edgeCanvas: HTMLCanvasElement
  readonly edgeCtx: CanvasRenderingContext2D
  readonly imageData: ImageData
  readonly pixels: Uint32Array
  readonly edgeImageData: ImageData
  readonly edgePixels: Uint32Array

  constructor(size = C().CHUNK_SIZE) {
    const make = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d', { willReadFrequently: false })
      if (!ctx) throw new Error('2d context unavailable for the bake scratch canvas')
      return [canvas, ctx]
    }
    ;[this.stencilCanvas, this.stencilCtx] = make()
    ;[this.edgeCanvas, this.edgeCtx] = make()

    this.imageData = this.stencilCtx.createImageData(size, size)
    this.pixels = new Uint32Array(this.imageData.data.buffer)
    this.edgeImageData = this.edgeCtx.createImageData(size, size)
    this.edgePixels = new Uint32Array(this.edgeImageData.data.buffer)
  }
}




/** Solid pixels of the chunk's slice → opaque white in the scratch stencil. */
export function buildStencil(
  core: Core,
  chunkX: number,
  chunkY: number,
  scratch: BakeScratch,
): void {
  stencilBits(core, chunkX, chunkY, C().CHUNK_SIZE, scratch.pixels)
  scratch.stencilCtx.putImageData(scratch.imageData, 0, 0)
}

/**
 * **Phaser's rock since T23.07: flat.** The lit terrain (`look/terrainMaterial.ts`, three.js) draws the
 * rock once its picture is whole (`GameWorld.terrainReady`); until then, and where three cannot start,
 * this bake does — one flat colour of the one palette (R5), the cave wall a darker one, and the space
 * rocks' cores and iron over it. The textured fill, the grass edge band and the object atlas it drew
 * before retired with their last reader (R15).
 */
/** T23.07: Phaser's flat rock — the one palette's (`world.js::THEMES.dusk`, R5) first rock colour. */
export const FLAT_ROCK = `rgb(${TERRAIN_PALETTE.rock[0].join(', ')})`
/** T23.07: Phaser's flat cave wall — the palette's first back colour. */
export const FLAT_BACK = `rgb(${TERRAIN_PALETTE.back[0].join(', ')})`

export interface BakeLayers {
  /** The rock, a CSS colour. */
  fill: string
  /** The cave wall seen through craters and inside caves, a CSS colour. */
  back?: string | null
  /** The dilated silhouette that decides where "inside the landmass" is. */
  backSource?: BackdropMask | null
  /** T22.16 (R102): the asteroids' core discs, world px (`Core.coreDiscs`). */
  cores?: readonly CoreDisc[] | null
  /** T22.21 (R113): the iron asteroids, world px (`Core.ironDiscs`). */
  irons?: readonly IronDisc[] | null
}

/**
 * T22.21 (R113): tint each iron asteroid touching this chunk into the rock layer — its
 * whole disc, before the live-mask punch, so what is solid there reads as iron and
 * the air around it stays air. Iron is never carved, so the disc is its silhouette.
 */
function drawIron(
  ctx: CanvasRenderingContext2D,
  discs: readonly IronDisc[],
  chunkX: number,
  chunkY: number,
  size: number,
): void {
  const x0 = chunkX * size
  const y0 = chunkY * size
  ctx.save()
  ctx.globalAlpha = IRON_TINT_ALPHA
  ctx.fillStyle = IRON_TINT
  for (const d of discs) {
    if (d.x + d.r < x0 || d.x - d.r >= x0 + size || d.y + d.r < y0 || d.y - d.r >= y0 + size) continue
    ctx.beginPath()
    ctx.arc(d.x - x0 + 0.5, d.y - y0 + 0.5, d.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/**
 * T22.16 (R102): paint each core touching this chunk — the ember rim, then the bright
 * heart — into the rock layer. Called **before** the live-mask punch, the objects'
 * way (§D1): a carved core loses its colour exactly where it lost its pixels, and a
 * crumbled one shows none.
 */
function drawCores(
  ctx: CanvasRenderingContext2D,
  discs: readonly CoreDisc[],
  chunkX: number,
  chunkY: number,
  size: number,
): void {
  for (const d of coresInChunk(discs, chunkX, chunkY, size)) {
    ctx.fillStyle = CORE_RIM
    ctx.beginPath()
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
    ctx.fill()
    // T22.21 (R112): the heart dims toward the rim with every hit it has taken.
    ctx.fillStyle = coreHeartColour(d.hits ?? 0, C().CORE_HITS)
    ctx.beginPath()
    ctx.arc(d.x, d.y, d.r * CORE_HEART_FRAC, 0, Math.PI * 2)
    ctx.fill()
  }
}

export function bakeChunk(
  texture: Phaser.Textures.CanvasTexture,
  layers: BakeLayers,
  chunkX: number,
  chunkY: number,
  core: Core,
  scratch: BakeScratch,
): void {
  const size = C().CHUNK_SIZE
  const ctx = texture.context

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, size, size)

  // 0. the cave backdrop, where terrain USED to be
  if (layers.back && layers.backSource) {
    backdropBits(layers.backSource, chunkX, chunkY, size, scratch.edgePixels)
    scratch.edgeCtx.putImageData(scratch.edgeImageData, 0, 0)
    const ectx = scratch.edgeCtx
    ectx.save()
    ectx.globalCompositeOperation = 'source-in'
    ectx.fillStyle = layers.back
    ectx.fillRect(0, 0, size, size)
    ectx.restore()
    ctx.drawImage(scratch.edgeCanvas, 0, 0)
  }

  buildStencil(core, chunkX, chunkY, scratch)

  // 1. the rock body, the iron and the cores, all punched to the live mask.
  //
  // **Fill, then the discs, then `destination-in`**: the discs are drawn before the punch, so a
  // carve that took half a core has already removed those bits (`buildStencil` read the live mask
  // above), and `destination-in` drops the colour over them with it.
  const body = scratch.edgeCtx
  body.save()
  body.globalCompositeOperation = 'source-over'
  body.clearRect(0, 0, size, size)
  body.fillStyle = layers.fill
  body.fillRect(0, 0, size, size)
  if (layers.irons && layers.irons.length > 0) {
    drawIron(body, layers.irons, chunkX, chunkY, size)
  }
  if (layers.cores && layers.cores.length > 0) {
    drawCores(body, layers.cores, chunkX, chunkY, size)
  }
  body.globalCompositeOperation = 'destination-in'
  body.drawImage(scratch.stencilCanvas, 0, 0)
  body.restore()
  ctx.drawImage(scratch.edgeCanvas, 0, 0)

  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()
  texture.refresh()
}
