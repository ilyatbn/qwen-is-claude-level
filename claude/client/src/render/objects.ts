/**
 * Scenery, drawn into the chunk bake and clipped by the live mask.
 *
 * `docs/73-amendments-v5.md` §D6.
 *
 * The objects themselves are terrain — pass 6b stamped them into the mask, so
 * their collision and their destruction are the mask's job and were free (§D1).
 * All that is left is the art, and the art needs no destruction logic either:
 * it is drawn *before* the bake punches the chunk out to the mask's shape, so a
 * rocket that removes half a rock removes half the rock's pixels with it. That
 * is the whole payoff, and `a_carve_removes_the_art_over_the_carved_half` is the
 * assertion that holds it up.
 */

import type { MapObject } from '../net/codec'

/** An object placement plus the atlas frame that draws it. */
export interface ObjectDraw extends MapObject {
  frame: string
}

/**
 * Which objects overlap which chunk, built once at map load.
 *
 * §D6: *"looked up per chunk from a static index built once at map load, not
 * searched per bake"*. A bake runs up to four times a frame under a 4 ms budget
 * (`docs/60` §6); a linear scan of 36 objects per bake is 144 rectangle tests a
 * frame to answer a question whose answer never changes.
 *
 * An object overlapping a chunk boundary is listed in **both** chunks and drawn
 * in both, offset by the chunk origin — the same thing the edge band already
 * does at seams (`docs/12` §2). Clipping it to one chunk would leave a visible
 * straight cut down every object unlucky enough to straddle a 256 px line.
 */
export class ObjectIndex {
  private readonly byChunk = new Map<number, ObjectDraw[]>()
  readonly chunksX: number
  readonly count: number

  constructor(objects: readonly MapObject[], chunkSize: number, chunksX: number, chunksY: number) {
    this.chunksX = chunksX
    this.count = objects.length

    for (const o of objects) {
      const cx0 = Math.max(0, Math.floor(o.x / chunkSize))
      const cy0 = Math.max(0, Math.floor(o.y / chunkSize))
      const cx1 = Math.min(chunksX - 1, Math.floor((o.x + o.w - 1) / chunkSize))
      const cy1 = Math.min(chunksY - 1, Math.floor((o.y + o.h - 1) / chunkSize))
      const draw: ObjectDraw = { ...o, frame: frameName(o.id) }
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cy * chunksX + cx
          const list = this.byChunk.get(key)
          if (list) list.push(draw)
          else this.byChunk.set(key, [draw])
        }
      }
    }
  }

  /** Objects overlapping this chunk. Empty for most of the map. */
  at(chunkX: number, chunkY: number): readonly ObjectDraw[] {
    return this.byChunk.get(chunkY * this.chunksX + chunkX) ?? EMPTY
  }

  /** How many chunks hold at least one object — for the debug HUD and tests. */
  get occupiedChunks(): number {
    return this.byChunk.size
  }
}

const EMPTY: readonly ObjectDraw[] = []

/** Atlas frame for an object id. `build-object-masks.mjs` names them this way. */
export function frameName(id: number): string {
  return `obj_${id}`
}

/** Where an object's top-left sits inside a chunk's own 256×256 canvas. */
export function localOrigin(o: MapObject, chunkX: number, chunkY: number, size: number): {
  x: number
  y: number
} {
  return { x: o.x - chunkX * size, y: o.y - chunkY * size }
}

/**
 * What the bake needs to turn an id into something drawable.
 *
 * An interface rather than a Phaser texture so the suite can drive the real draw
 * path with a canvas it made itself — `docs/72` §C2 wants assertions on rendered
 * pixels, and a draw step that can only run inside Phaser is a draw step that
 * gets asserted on its arguments instead.
 */
export interface ObjectSprite {
  image: CanvasImageSource
  /** The frame's rect inside the atlas page. */
  sx: number
  sy: number
  sw: number
  sh: number
}

export interface ObjectArt {
  /** The frame to blit, or null when the atlas is missing (`docs/50` §8). */
  get(frame: string): ObjectSprite | null
}

/**
 * Draw every object overlapping this chunk, in id order.
 *
 * **Called between the fill and the punch-out**, so `destination-in` clips these
 * pixels along with the rock (§D6 step 2b). Nothing here knows about damage.
 *
 * Returns how many were drawn, so a caller can tell "no objects here" from "no
 * art loaded" — two very different reasons for an empty chunk, and a counter
 * that conflated them would make the fallback path untestable.
 */
export function drawObjects(
  ctx: CanvasRenderingContext2D,
  index: ObjectIndex,
  art: ObjectArt,
  chunkX: number,
  chunkY: number,
  size: number,
): number {
  const here = index.at(chunkX, chunkY)
  let drawn = 0
  for (const o of here) {
    const sprite = art.get(o.frame)
    if (!sprite) continue
    const at = localOrigin(o, chunkX, chunkY, size)
    const { image, sx, sy, sw, sh } = sprite
    if (o.flip) {
      // Mirrored about the object's own centre, which is what 6b stamped into
      // the mask (`ObjectMask::solid_flipped`). Translating to the far edge and
      // scaling by -1 puts pixel `w-1-x` where the mask put it; getting this
      // backwards leaves the art a mirror of its own collision — invisible on a
      // symmetric rock and obvious on a ruin.
      ctx.save()
      ctx.translate(at.x + o.w, at.y)
      ctx.scale(-1, 1)
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, o.w, o.h)
      ctx.restore()
    } else {
      ctx.drawImage(image, sx, sy, sw, sh, at.x, at.y, o.w, o.h)
    }
    drawn++
  }
  return drawn
}

/**
 * A Phaser texture atlas as an [`ObjectArt`], or a source of nulls if it is not
 * loaded.
 *
 * `docs/50` §8: the game must start with no art at all. There is a real
 * `objects.png` committed now, which makes the no-art path the branch nobody
 * exercises by accident — so it is built deliberately here and asserted in
 * `objectArt_with_no_atlas_draws_nothing_and_logs_once`.
 *
 * Logged **once**, not per frame: four bakes a frame × 36 objects is 144 lines a
 * frame, which is how a warning becomes noise nobody reads.
 */
export function atlasArt(
  textures: { exists(key: string): boolean; get(key: string): PhaserAtlasLike },
  key: string,
  warn: (message: string) => void = (m) => console.warn(m),
): ObjectArt {
  if (!textures.exists(key)) {
    warn(`objects atlas "${key}" is not loaded — scenery will be terrain-coloured only`)
    return { get: () => null }
  }
  const texture = textures.get(key)
  const image = asDrawable(texture.getSourceImage())
  if (!image) {
    // A `RenderTexture` is a real Phaser texture and not something a 2D context
    // can blit. Falling back is right: `drawImage` would throw mid-bake and take
    // the whole chunk with it.
    warn(`objects atlas "${key}" is not a drawable image — scenery will be terrain-coloured only`)
    return { get: () => null }
  }
  let warnedFrame = false
  return {
    get(frame: string): ObjectSprite | null {
      const f = frameRect(texture.frames, frame)
      if (!f) {
        if (!warnedFrame) {
          warnedFrame = true
          warn(`objects atlas "${key}" has no frame "${frame}" (and possibly others)`)
        }
        return null
      }
      return { image, sx: f.cutX, sy: f.cutY, sw: f.cutWidth, sh: f.cutHeight }
    },
  }
}

/** The slice of Phaser's texture API this needs, so a test can supply one. */
export interface PhaserAtlasLike {
  getSourceImage(): unknown
  /**
   * Phaser types this as `object`, so it is read through a narrowing lookup
   * rather than declared as a record here — declaring the shape we want is how
   * a type stops describing the thing it names.
   */
  frames?: object
}

/** One atlas frame's rect, if `frames` really holds one under that name. */
function frameRect(
  frames: object | undefined,
  name: string,
): { cutX: number; cutY: number; cutWidth: number; cutHeight: number } | null {
  if (!frames) return null
  const f = (frames as Record<string, unknown>)[name]
  if (!f || typeof f !== 'object') return null
  const r = f as Partial<Record<'cutX' | 'cutY' | 'cutWidth' | 'cutHeight', unknown>>
  if (
    typeof r.cutX !== 'number' ||
    typeof r.cutY !== 'number' ||
    typeof r.cutWidth !== 'number' ||
    typeof r.cutHeight !== 'number'
  ) {
    return null
  }
  return { cutX: r.cutX, cutY: r.cutY, cutWidth: r.cutWidth, cutHeight: r.cutHeight }
}

/**
 * Narrow Phaser's `getSourceImage()` to something a 2D context can blit.
 *
 * A guard rather than a cast: it really can hand back a `RenderTexture`, and
 * `drawImage` on one throws inside the bake. The `typeof` checks are because
 * these globals do not exist under vitest's node environment.
 */
function asDrawable(src: unknown): CanvasImageSource | null {
  if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) return src
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) return src
  if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) return src
  if (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas) return src
  return null
}
