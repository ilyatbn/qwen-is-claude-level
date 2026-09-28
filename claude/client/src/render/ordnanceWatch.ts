/**
 * T23.14E F4/F8, e2e only: **was each round painted on the canvas?** — the pixels, not the layer's record count.
 *
 * While on, after every rendered frame (`POST_RENDER`, the frame's pixels still in the drawing buffer) each round the
 * ordnance layer holds for the first time has the Phaser canvas — and, T23.18, the world canvas the rounds are drawn on
 * while it draws the effects — read in a `ROUND_PATCH_PX` square around where it is
 * drawn, and a square as far on the other side of the player (the control region). On the first frame after the round
 * has left the layer the same two squares are read again (the control frame). A painted round moves its square and
 * not the control region's. Both scenes use it (`watchRounds` on their `__game`): one function, not two copies.
 */
import Phaser from 'phaser'
import type { OrdnanceState } from './ordnance-state'
import { fxFeed } from '../look/fx/feed'

/** The side of the square read around a round, canvas px. */
export const ROUND_PATCH_PX = 24

type Rect = readonly [number, number, number, number]

export interface WatchedRound {
  id: number
  kind: string
  /** Frames it was drawn on. */
  frames: number
  /** Mean per-pixel max-channel change against the control frame (0–255): the round's square, the control region's. */
  diff: number | null
  farDiff: number | null
}

interface Record extends WatchedRound {
  rect: Rect
  far: Rect
  patch: Uint8Array
  farPatch: Uint8Array
}

export interface WatchSource {
  /** The layer's records this frame, or null with no world. */
  state(): OrdnanceState | null
  /** The player the control region is mirrored about, world px (null: the round's own x). */
  centre(): { x: number } | null
}

export class RoundWatch {
  private readonly seen = new Set<number>()
  private readonly rounds: Record[] = []

  constructor(
    private readonly game: Phaser.Game,
    private readonly camera: Phaser.Cameras.Scene2D.Camera,
    private readonly src: WatchSource,
  ) {
    game.events.on(Phaser.Core.Events.POST_RENDER, this.frame, this)
  }

  /** Stop watching; what was seen. */
  stop(): WatchedRound[] {
    this.game.events.off(Phaser.Core.Events.POST_RENDER, this.frame, this)
    return this.rounds.map(({ id, kind, frames, diff, farDiff }) => ({ id, kind, frames, diff, farDiff }))
  }

  /** Both canvases' pixels in `rect`: Phaser's, then the world's (T23.18: the rounds are drawn there now) if it draws. */
  private read(rect: Rect): Uint8Array {
    const phaser = this.readPhaser(rect)
    // T23.18: the camera's scene's effect feed — the world renderer that draws the rounds there hands its pixels over.
    const world = fxFeed(this.camera.scene).readWorld?.(rect[0], rect[1], rect[2], rect[3]) ?? null
    if (!world) return phaser
    const out = new Uint8Array(phaser.length + world.length)
    out.set(phaser)
    out.set(world, phaser.length)
    return out
  }

  private readPhaser([x, y, w, h]: Rect): Uint8Array {
    const r = this.game.renderer
    if (r instanceof Phaser.Renderer.WebGL.WebGLRenderer) {
      const out = new Uint8Array(w * h * 4)
      r.gl.readPixels(x, r.height - y - h, w, h, r.gl.RGBA, r.gl.UNSIGNED_BYTE, out)
      return out
    }
    const ctx = (r as Phaser.Renderer.Canvas.CanvasRenderer).gameContext
    return new Uint8Array(ctx.getImageData(x, y, w, h).data.buffer)
  }

  private frame(): void {
    const drawn = this.src.state()?.projectiles
    if (!drawn) return
    for (const r of this.rounds) {
      if (r.diff !== null) continue
      if (drawn.has(r.id)) {
        r.frames += 1
        continue
      }
      r.diff = meanDiff(r.patch, this.read(r.rect))
      r.farDiff = meanDiff(r.farPatch, this.read(r.far))
    }
    const cam = this.camera
    const H = ROUND_PATCH_PX / 2
    const c = this.src.centre()
    for (const [id, p] of drawn) {
      if (this.seen.has(id)) continue
      this.seen.add(id)
      const sx = (p.x - cam.worldView.x) * cam.zoom
      const sy = (p.y - cam.worldView.y) * cam.zoom
      const mx = c ? (c.x - cam.worldView.x) * cam.zoom : sx
      const rect: Rect = [Math.round(sx - H), Math.round(sy - H), ROUND_PATCH_PX, ROUND_PATCH_PX]
      const far: Rect = [Math.round(2 * mx - sx - H), rect[1], ROUND_PATCH_PX, ROUND_PATCH_PX]
      this.rounds.push({ id, kind: p.kind, rect, far, patch: this.read(rect), farPatch: this.read(far), frames: 1, diff: null, farDiff: null })
    }
  }
}

function meanDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0
  // The two reads cover the same canvases unless the world renderer stopped drawing between them: compare what both have.
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 4) {
    sum += Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!))
  }
  return sum / Math.max(1, n / 4)
}
