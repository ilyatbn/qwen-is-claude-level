/**
 * Drawing the ground animals (T20.10).
 *
 * `BirdLayer`'s shape, with three differences that matter:
 *
 *  - **Depth `actors`, not `birds`.** A bird is drawn *behind* the terrain, which
 *    is what §C16's "no collision" looks like on screen. An animal stands on the
 *    ground and collides with it, so drawing it behind would put a spider inside
 *    the hill it is sitting on.
 *  - **Facing comes from the wire.** A bird's direction is its travel; a beetle
 *    turns and a spider rests between hops, where "moved right since last frame"
 *    flips the sprite every time it stops.
 *  - **Legs, not wings.** Same per-id phase trick, so a row of them is not a
 *    chorus line.
 *
 * Arithmetic is in `animals-math.ts` (§A8); this file is Phaser. No atlas entry
 * exists, and `docs/50` §8 says a missing texture falls back rather than breaks —
 * so, like the birds, the body is primitives rather than a placeholder box.
 */
import Phaser from 'phaser'
import { DEPTH } from './backdrop'
import { BEETLE, bodyColor, bodySize, legPhase } from './animals-math'
import type { AnimalView } from '../net/worldMirror'

interface Entry {
  root: Phaser.GameObjects.Container
  body: Phaser.GameObjects.Ellipse
  legs: Phaser.GameObjects.Rectangle[]
  kind: number
}

export class AnimalLayer {
  private readonly container: Phaser.GameObjects.Container
  private readonly entries = new Map<number, Entry>()
  private readonly seen = new Set<number>()

  constructor(private readonly scene: Phaser.Scene) {
    this.container = scene.add.container(0, 0).setDepth(DEPTH.actors)
  }

  /** Ids currently drawn. A check asserts on this, not on intent (§A15). */
  get ids(): number[] {
    return [...this.entries.keys()]
  }

  get count(): number {
    return this.entries.size
  }

  /** Show or hide the whole layer, for a check's control frame (§C2). */
  setVisible(on: boolean): void {
    this.container.setVisible(on)
  }

  /**
   * Where each animal is **drawn**, as opposed to where the mirror says it is.
   *
   * The reason `BirdLayer.drawn` exists, and it applies harder here: a check that
   * computes a patch from mirror coordinates and then screenshots is comparing
   * two different instants, and a hopping spider can leave the patch between
   * them.
   */
  get drawn(): Array<{ id: number; x: number; y: number; kind: number }> {
    return [...this.entries.entries()].map(([id, e]) => ({
      id,
      x: e.root.x,
      y: e.root.y,
      kind: e.kind,
    }))
  }

  /** Reconcile against the mirror and animate. Diffed, not rebuilt. */
  update(animals: Iterable<AnimalView>, nowMs: number): void {
    this.seen.clear()
    const seen = this.seen
    for (const a of animals) {
      seen.add(a.id)
      let e = this.entries.get(a.id)
      if (!e || e.kind !== a.kind) {
        e?.root.destroy()
        e = this.make(a)
        this.entries.set(a.id, e)
      }
      e.root.setPosition(a.x, a.y)
      e.root.setScale(a.right ? 1 : -1, 1)

      const swing = legPhase(nowMs, a.id, a.kind)
      const { h } = bodySize(a.kind)
      e.legs.forEach((leg, i) => {
        const dir = i % 2 === 0 ? 1 : -1
        leg.setY(h * 0.35 + swing * dir * h * 0.12)
      })
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        e.root.destroy()
        this.entries.delete(id)
      }
    }
  }

  private make(a: AnimalView): Entry {
    const { w, h } = bodySize(a.kind)
    const colour = bodyColor(a.kind)
    const root = this.scene.add.container(a.x, a.y)
    // A beetle is a wide low dome; a spider is a small body with long legs. The
    // silhouettes have to differ, not the palette.
    const body =
      a.kind === BEETLE
        ? this.scene.add.ellipse(0, 0, w * 0.9, h * 0.8, colour)
        : this.scene.add.ellipse(0, -h * 0.1, w * 0.5, h * 0.55, colour)
    const legCount = a.kind === BEETLE ? 4 : 6
    const legs: Phaser.GameObjects.Rectangle[] = []
    for (let i = 0; i < legCount; i++) {
      const t = i / (legCount - 1)
      const x = -w * 0.45 + t * w * 0.9
      const len = a.kind === BEETLE ? h * 0.35 : h * 0.7
      legs.push(this.scene.add.rectangle(x, h * 0.35, 1.5, len, colour))
    }
    root.add([...legs, body])
    this.container.add(root)
    return { root, body, legs, kind: a.kind }
  }

  destroy(): void {
    for (const e of this.entries.values()) e.root.destroy()
    this.entries.clear()
    this.container.destroy()
  }
}
