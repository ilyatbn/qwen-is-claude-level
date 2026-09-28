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
import { BIRD_METAL, bodyColor, bodySize, wingPhase } from './birds-math'
import type { BirdView } from '../net/worldMirror'
import { joinCast } from '../look/actors/cast'
import { VIEW_MARGIN, birdActor, nearView } from '../look/actors/furniture'
import { fxFeed } from '../look/fx/feed'

interface Entry {
  root: Phaser.GameObjects.Container
  body: Phaser.GameObjects.Ellipse
  left: Phaser.GameObjects.Triangle
  right: Phaser.GameObjects.Triangle
  kind: number
  facing: boolean
  /** Wing phase this frame, −1 … 1 (`wingPhase`). */
  phase: number
  /** T23.19B: its place in the world renderer's cast, while the world draws this scene. */
  leave: (() => void) | null
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

  /**
   * T23.19B: the birds are F4's — ink, rim-lit, flapping; the metal one a machine's silhouette (`draw.ts::metalBird`) —
   * drawn by the world renderer **whenever it draws this scene** (`fxFeed(scene).worldDraws`, the one flag the effects
   * already read: set by the drawer, so Phaser's shapes and the actors can never both draw or both not — space,
   * `?world=off` and no WebGL2 keep Phaser's). Depth, decided: behind the figures, in front of the rock — where they
   * have been on screen since the rock moved to the world canvas under Phaser's (T23.07); a bird is a target, and one
   * behind a hill could not be shot at where it is seen.
   */
  private worldOn = false

  constructor(private readonly scene: Phaser.Scene) {
    this.container = scene.add.container(0, 0).setDepth(DEPTH.birds)
  }

  /** T23.19B: whether the world renderer draws the birds (dev handle, checks). */
  get drawsInWorld(): boolean {
    return this.worldOn
  }

  private place(e: Entry): void {
    e.root.setVisible(!this.worldOn)
    if (this.worldOn && !e.leave) {
      const view = this.scene.cameras.main.worldView
      const { w } = bodySize(e.kind)
      e.leave = joinCast(this.scene, {
        back: true,
        actor: () => {
          const { x, y } = e.root
          if (!this.container.visible || !nearView(view, x, y, VIEW_MARGIN)) return null
          return birdActor(e.kind === BIRD_METAL, Math.round(x), Math.round(y), e.facing, w, e.phase)
        },
      })
    } else if (!this.worldOn && e.leave) {
      e.leave()
      e.leave = null
    }
  }

  /** Ids currently drawn. The e2e asserts on this, not on intent (§A15). */
  get ids(): number[] {
    return [...this.entries.keys()]
  }

  /** Show or hide the whole layer, for a check's control frame (§C2). */
  setVisible(on: boolean): void {
    this.container.setVisible(on)
  }

  get count(): number {
    return this.entries.size
  }

  /**
   * Where each bird is **drawn**, as opposed to where the mirror says it is.
   *
   * `freeze` pauses the scene, so the frame on screen is whichever one was last
   * rendered — while the mirror keeps taking socket updates. A check that
   * computes a patch from mirror coordinates and then screenshots is comparing
   * two different instants, and under load the bird has left that patch:
   * measured, `birds` read 20.9 standalone and 0.2 in the full suite on
   * identical code. These are the positions the last redraw actually used, which
   * is the only thing a screenshot can agree with.
   */
  get drawn(): Array<{ id: number; x: number; y: number }> {
    return [...this.entries.entries()].map(([id, e]) => ({
      id,
      x: e.root.x,
      y: e.root.y,
    }))
  }

  /**
   * Reconcile against the mirror and animate.
   *
   * Diffed rather than rebuilt: four birds is cheap either way, but recreating
   * game objects every frame is how a layer ends up allocating in the render
   * loop, and the ones next door already do it right.
   */
  update(birds: Iterable<BirdView>, nowMs: number): void {
    const world = fxFeed(this.scene).worldDraws
    if (world !== this.worldOn) {
      this.worldOn = world
      for (const e of this.entries.values()) this.place(e)
    }
    this.seen.clear()
    const seen = this.seen
    for (const b of birds) {
      seen.add(b.id)
      let e = this.entries.get(b.id)
      if (!e || e.kind !== b.kind) {
        e?.root.destroy()
        e?.leave?.()
        e = this.make(b)
        this.entries.set(b.id, e)
        this.place(e)
      }
      e.root.setPosition(b.x, b.y)
      // Facing: the body is symmetric, so this only has to flip the silhouette.
      e.root.setScale(b.right ? 1 : -1, 1)
      e.facing = b.right

      const flap = wingPhase(nowMs, b.id)
      e.phase = flap
      const { h } = bodySize(b.kind)
      e.left.setY(-flap * h * 0.5)
      e.right.setY(flap * h * 0.5)
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        e.root.destroy()
        e.leave?.()
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
    return { root, body, left, right, kind: b.kind, facing: b.right, phase: 0, leave: null }
  }

  destroy(): void {
    for (const e of this.entries.values()) {
      e.root.destroy()
      e.leave?.()
    }
    this.entries.clear()
    this.container.destroy()
  }
}
