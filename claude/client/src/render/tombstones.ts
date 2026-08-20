/**
 * Drawing the graveyard (§B8).
 *
 * A grave is cosmetic, and a cosmetic nobody can see is the §A39 bug this
 * project has now shipped five times — so this file exists in the same commit as
 * the simulation that places them, and the e2e counts graves *drawn* against
 * graves the server holds rather than asserting the server has some.
 *
 * Arithmetic is in `tombstones-math.ts` (§A8); this file is Phaser.
 */

import Phaser from 'phaser'
import { DEPTH } from './backdrop'
import { diffTombstones, tombstoneFrame, type TombstoneView } from './tombstones-math'

const ATLAS = 'items'
/** `TOMBSTONE_W` × `TOMBSTONE_H` from the shared constants. */
const FALLBACK_FILL = 0x9aa3ad

interface Entry {
  sprite: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle
  view: TombstoneView
}

export class TombstoneLayer {
  private readonly scene: Phaser.Scene
  private readonly container: Phaser.GameObjects.Container
  private readonly entries = new Map<number, Entry>()
  private warned = false

  constructor(
    scene: Phaser.Scene,
    private readonly w: number,
    private readonly h: number,
  ) {
    this.scene = scene
    // Behind world items and in front of decorations: a grave is scenery you
    // walk past, not something you pick up.
    this.container = scene.add.container(0, 0).setDepth(DEPTH.decorations + 1)
  }

  get count(): number {
    return this.entries.size
  }

  /** Ids currently drawn. The e2e asserts on this, not on intent (§A15). */
  get ids(): number[] {
    return [...this.entries.keys()]
  }

  /**
   * Reconcile against the server's list.
   *
   * Called with the whole list rather than per-event, so a client that missed a
   * `tombstone_despawn` still converges — the same reason the item layer takes a
   * list.
   */
  update(live: readonly TombstoneView[]): void {
    const { add, remove } = diffTombstones(this.entries.keys(), live)
    for (const id of remove) {
      this.entries.get(id)?.sprite.destroy()
      this.entries.delete(id)
    }
    for (const v of add) {
      this.entries.set(v.id, { sprite: this.make(v), view: v })
    }
    // Positions move: a grave falls when the ground under it is carved.
    for (const v of live) {
      const e = this.entries.get(v.id)
      if (e) {
        e.sprite.setPosition(v.x, v.y)
        e.view = v
      }
    }
  }

  private make(v: TombstoneView): Entry['sprite'] {
    const known = this.scene.textures.exists(ATLAS)
      ? new Set(this.scene.textures.get(ATLAS).getFrameNames())
      : new Set<string>()
    const frame = tombstoneFrame(v.skinId, known)
    if (frame) {
      const img = this.scene.add.image(v.x, v.y, ATLAS, frame)
      this.container.add(img)
      return img
    }
    // No art: a box at the right size, logged once (`docs/50` §8). The game must
    // start with zero assets, and it has been running on fallbacks since M3.
    if (!this.warned) {
      this.warned = true
      console.warn('[tombstones] no tombstone art; drawing placeholders')
    }
    const rect = this.scene.add.rectangle(v.x, v.y, this.w, this.h, FALLBACK_FILL)
    rect.setStrokeStyle(1, 0x40474f)
    this.container.add(rect)
    return rect
  }

  destroy(): void {
    for (const e of this.entries.values()) e.sprite.destroy()
    this.entries.clear()
    this.container.destroy()
  }
}
