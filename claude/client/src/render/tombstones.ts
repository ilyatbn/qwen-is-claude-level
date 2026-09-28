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
import { diffTombstones, type TombstoneView } from './tombstones-math'
import { TOMBSTONE_KEY, ensureTombstoneTexture } from './tombstoneTextures'
import { joinCast } from '../look/actors/cast'
import { VIEW_MARGIN, graveActor, nearView } from '../look/actors/furniture'

/** `TOMBSTONE_W` × `TOMBSTONE_H` from the shared constants. */
const FALLBACK_FILL = 0x9aa3ad

interface Entry {
  sprite: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle
  view: TombstoneView
  /** T23.19: its place in the world renderer's cast, while `useWorld` holds. */
  leave: (() => void) | null
}

export class TombstoneLayer {
  private readonly scene: Phaser.Scene
  private readonly container: Phaser.GameObjects.Container
  private readonly entries = new Map<number, Entry>()
  private warned = false
  /** T23.19: graves are the world renderer's — rim-lit ink with F4's night halo, behind the figures (not in space). */
  private worldOn = false

  constructor(
    scene: Phaser.Scene,
    private readonly w: number,
    private readonly h: number,
  ) {
    this.scene = scene
    ensureTombstoneTexture(scene.textures)
    // Behind world items and in front of decorations: a grave is scenery you
    // walk past, not something you pick up.
    this.container = scene.add.container(0, 0).setDepth(DEPTH.decorations + 1)
  }

  /** T23.19: draw the graves in the world renderer (`on`) or with Phaser's stone (space, until T23.20). */
  useWorld(on: boolean): void {
    this.worldOn = on
    for (const e of this.entries.values()) this.place(e)
  }

  get drawsInWorld(): boolean {
    return this.worldOn
  }

  /** Show or hide the whole layer, for a check's control frame (§C2). */
  setVisible(on: boolean): void {
    this.container.setVisible(on)
  }

  private place(e: Entry): void {
    e.sprite.setVisible(!this.worldOn)
    if (this.worldOn && !e.leave) {
      const view = this.scene.cameras.main.worldView
      e.leave = joinCast(this.scene, {
        back: true,
        actor: () => {
          const { x, y } = e.sprite
          if (!this.container.visible || !nearView(view, x, y, VIEW_MARGIN)) return null
          // The sprite is centred on the grave's box; the stone stands on its bottom edge.
          return graveActor(x, y + this.h / 2, this.h)
        },
      })
    } else if (!this.worldOn && e.leave) {
      e.leave()
      e.leave = null
    }
  }

  get count(): number {
    return this.entries.size
  }

  /** T23.19: where each grave is drawn, read off the layer's objects (world px, the grave's middle). */
  get drawn(): { id: number; x: number; y: number }[] {
    return [...this.entries].map(([id, e]) => ({ id, x: e.sprite.x, y: e.sprite.y }))
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
      const e = this.entries.get(id)
      e?.sprite.destroy()
      e?.leave?.()
      this.entries.delete(id)
    }
    for (const v of add) {
      const e: Entry = { sprite: this.make(v), view: v, leave: null }
      this.entries.set(v.id, e)
      this.place(e)
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
    // T23.15 (R8): one ink stone for every grave (`tombstoneTextures.ts`); the wire's `tombstone_skin_id` is not read.
    if (this.scene.textures.exists(TOMBSTONE_KEY)) {
      const img = this.scene.add.image(v.x, v.y, TOMBSTONE_KEY)
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
    for (const e of this.entries.values()) {
      e.sprite.destroy()
      e.leave?.()
    }
    this.entries.clear()
    this.container.destroy()
  }
}
