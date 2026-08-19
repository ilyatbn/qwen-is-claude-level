/**
 * Mask → stencil → textured chunk.
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
import { BackdropMask, backdropBits, edgeBits, stencilBits, tileOffset } from './chunkBake-math'

export {
  chunkOrigin,
  edgeBits,
  solidIn,
  stencilBits,
  tileOffset,
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

/** Mark the top `EDGE_BAND_PX` solid pixels below each air→solid transition. */
export function buildEdgeStencil(
  core: Core,
  chunkX: number,
  chunkY: number,
  scratch: BakeScratch,
): void {
  edgeBits(core, chunkX, chunkY, C().CHUNK_SIZE, C().EDGE_BAND_PX, scratch.edgePixels)
  scratch.edgeCtx.putImageData(scratch.edgeImageData, 0, 0)
}

/** Tile `image` across the whole chunk, offset so the pattern crosses seams. */
function drawTiled(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  chunkX: number,
  chunkY: number,
  size: number,
): void {
  const texW = Number((image as HTMLCanvasElement).width) || size
  const texH = Number((image as HTMLCanvasElement).height) || size
  const off = tileOffset(chunkX, chunkY, size, texW, texH)

  for (let y = -off.y; y < size; y += texH) {
    for (let x = -off.x; x < size; x += texW) {
      ctx.drawImage(image, x, y, texW, texH)
    }
  }
}

/**
 * Bake one chunk: tiled fill, punched to the mask's shape, with the edge texture
 * composited over the upward-facing band.
 */
export interface BakeLayers {
  fill: CanvasImageSource
  edge: CanvasImageSource | null
  /** Dark rock seen through craters and inside caves. */
  back?: CanvasImageSource | null
  /** The dilated silhouette that decides where "inside the landmass" is. */
  backSource?: BackdropMask | null
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
  const { fill: fillImage, edge: edgeImage } = layers

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
    drawTiled(ectx, layers.back, chunkX, chunkY, size)
    ectx.restore()
    ctx.drawImage(scratch.edgeCanvas, 0, 0)
  }

  buildStencil(core, chunkX, chunkY, scratch)

  // 1. the rock body, punched to the live mask, composited over the backdrop
  const body = scratch.edgeCtx
  body.save()
  body.globalCompositeOperation = 'copy'
  body.drawImage(scratch.stencilCanvas, 0, 0)
  body.globalCompositeOperation = 'source-in'
  drawTiled(body, fillImage, chunkX, chunkY, size)
  body.restore()
  ctx.drawImage(scratch.edgeCanvas, 0, 0)

  // 2. the grass rim, clipped to the terrain that already exists
  if (edgeImage) {
    buildEdgeStencil(core, chunkX, chunkY, scratch)
    // Draw the edge texture into the edge scratch, masked by the band stencil,
    // then composite that over the fill with source-atop so it never spills into
    // air.
    const ectx = scratch.edgeCtx
    ectx.save()
    ectx.globalCompositeOperation = 'source-in'
    drawTiled(ectx, edgeImage, chunkX, chunkY, size)
    ectx.restore()

    ctx.globalCompositeOperation = 'source-atop'
    ctx.drawImage(scratch.edgeCanvas, 0, 0)
  }

  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()
  texture.refresh()
}
