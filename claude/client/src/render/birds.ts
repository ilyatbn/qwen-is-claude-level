/**
 * Drawing the birds (§C16).
 *
 * A bird is worth shooting, so a bird nobody can see is a supply line nobody can
 * open — the §A39 shape this project has shipped several times. This file exists
 * in the same commit as the simulation that flies them, and `birds.mjs` counts
 * birds **drawn** against birds the server holds rather than trusting either end
 * alone.
 *
 * Arithmetic is in `birds-math.ts` (§A8); this file is Phaser.
 *
 * ## Drawn, not sprited
 *
 * No atlas entry exists for a bird, and `docs/50` §8 says a missing texture must
 * fall back rather than break the game. Rather than ship a placeholder box, the
 * body is three primitives — a body ellipse and two wing triangles — which read
 * as a bird at this size, cost one container each, and need no art pipeline.
 */
import Phaser from 'phaser'
import { DEPTH } from './backdrop'
import { bodyColor, bodySize, wingPhase } from './birds-math'
import type { BirdView } from '../net/worldMirror'

interface Entry {
  root: Phaser.GameObjects.Container
  body: Phaser.GameObjects.Ellipse
  left: Phaser.GameObjects.Triangle
  right: Phaser.GameObjects.Triangle
  kind: number
}

export class BirdLayer {
  private readonly container: Phaser.GameObjects.Container
  private readonly entries = new Map<number, Entry>()
  /**
   * Reused across frames rather than rebuilt.
   *
   * `BIRD_MAX` is 4 so this is nursery-sized either way, but the parallax layer
   * one task ago was pulled up for exactly this and consistency is worth more
   * than the allocation.
   */
  private readonly seen = new Set<number>()

  constructor(private readonly scene: Phaser.Scene) {
    this.container = scene.add.container(0, 0).setDepth(DEPTH.birds)
  }

  /** Ids currently drawn. The e2e asserts on this, not on intent (§A15). */
  get ids(): number[] {
    return [...this.entries.keys()]
  }

  get count(): number {
    return this.entries.size
  }

  /**
   * Reconcile against the mirror and animate.
   *
   * Diffed rather than rebuilt: four birds is cheap either way, but recreating
   * game objects every frame is how a layer ends up allocating in the render
   * loop, and the ones next door already do it right.
   */
  update(birds: Iterable<BirdView>, nowMs: number): void {
    this.seen.clear()
    const seen = this.seen
    for (const b of birds) {
      seen.add(b.id)
      let e = this.entries.get(b.id)
      if (!e || e.kind !== b.kind) {
        e?.root.destroy()
        e = this.make(b)
        this.entries.set(b.id, e)
      }
      e.root.setPosition(b.x, b.y)
      // Facing: the body is symmetric, so this only has to flip the silhouette.
      e.root.setScale(b.right ? 1 : -1, 1)

      const flap = wingPhase(nowMs, b.id)
      const { h } = bodySize(b.kind)
      e.left.setY(-flap * h * 0.5)
      e.right.setY(flap * h * 0.5)
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        e.root.destroy()
        this.entries.delete(id)
      }
    }
  }

  private make(b: BirdView): Entry {
    const { w, h } = bodySize(b.kind)
    const colour = bodyColor(b.kind)
    const root = this.scene.add.container(b.x, b.y)
    const body = this.scene.add.ellipse(0, 0, w * 0.55, h * 0.5, colour)
    // Wings as triangles either side, moved in antiphase by `update`.
    const left = this.scene.add.triangle(0, 0, 0, 0, -w * 0.5, -h * 0.2, 0, h * 0.25, colour)
    const right = this.scene.add.triangle(0, 0, 0, 0, w * 0.5, -h * 0.2, 0, h * 0.25, colour)
    root.add([left, right, body])
    this.container.add(root)
    return { root, body, left, right, kind: b.kind }
  }

  destroy(): void {
    for (const e of this.entries.values()) e.root.destroy()
    this.entries.clear()
    this.container.destroy()
  }
}
