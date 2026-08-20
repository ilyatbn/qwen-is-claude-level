/**
 * Drawing world items and crates.
 *
 * `WorldMirror` has tracked items since T6.08 and nothing drew them, so a
 * medkit lying on the ground was invisible in the real game. Items are the
 * reason to move (`docs/30`), and an invisible reason to move is no reason at
 * all — this is a gameplay fix in a cosmetic task.
 *
 * Arithmetic is in `itemSprites-math.ts` (§A8); this file is Phaser.
 */

import Phaser from 'phaser'
import { DEPTH } from './backdrop'
import {
  bobOffset,
  diffItems,
  frameFor,
  labelFor,
  parseRegistry,
  withinLabelRange,
  type ItemDefView,
  type WorldItemView,
} from './itemSprites-math'

const ATLAS = 'items'
/** Tint for the fallback box, by item id — enough to tell them apart. */
const FALLBACK_TINTS = [0xff5d5d, 0x5db4ff, 0xffe45d, 0xff9d3d, 0x9d7bff, 0x7bffb0]

interface Entry {
  sprite: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle
  label: Phaser.GameObjects.Text | null
  item: WorldItemView
}

export class ItemLayer {
  private readonly scene: Phaser.Scene
  private readonly container: Phaser.GameObjects.Container
  private readonly entries = new Map<number, Entry>()
  private defs: Map<number, ItemDefView> = new Map()
  private warned = new Set<string>()
  private t = 0

  constructor(scene: Phaser.Scene) {
    this.scene = scene
    this.container = scene.add.container(0, 0).setDepth(DEPTH.worldItems)
  }

  /** From `Core.itemRegistryJson()`. Safe to call before any item exists. */
  setRegistry(json: string): void {
    this.defs = parseRegistry(json)
  }

  get count(): number {
    return this.entries.size
  }

  /** Ids currently drawn — used by the e2e check, which asserts on effects. */
  get ids(): number[] {
    return [...this.entries.keys()]
  }

  /**
   * Sync to the live set and animate.
   *
   * Diffed rather than rebuilt: rebuilding every frame restarts every item's bob
   * on every frame, which renders as nothing moving at all.
   */
  update(dt: number, live: WorldItemView[], player: { x: number; y: number }): void {
    this.t += dt
    const { add, remove } = diffItems(this.entries.keys(), live)
    const byId = new Map(live.map((i) => [i.id, i]))

    for (const id of remove) {
      const e = this.entries.get(id)
      e?.sprite.destroy()
      e?.label?.destroy()
      this.entries.delete(id)
    }
    for (const id of add) {
      const item = byId.get(id)
      if (item) this.spawn(item)
    }

    for (const [id, e] of this.entries) {
      const item = byId.get(id)
      if (!item) continue
      e.item = item
      e.sprite.setPosition(item.x, item.y + bobOffset(id, this.t))

      // A label at every item turns the map into a wall of text; close range
      // only, per `docs/30` §5.
      const near = withinLabelRange(item, player)
      if (near && !e.label) {
        e.label = this.scene.add
          .text(item.x, item.y - 16, labelFor(item, this.defs), {
            fontFamily: 'monospace',
            fontSize: '10px',
            color: '#e8f0ff',
            backgroundColor: '#0009',
            padding: { x: 3, y: 1 },
          })
          .setOrigin(0.5, 1)
        this.container.add(e.label)
      } else if (!near && e.label) {
        e.label.destroy()
        e.label = null
      }
      e.label?.setPosition(item.x, item.y - 16 + bobOffset(id, this.t))
    }
  }

  private spawn(item: WorldItemView): void {
    const hasAtlas = this.scene.textures.exists(ATLAS)
    const texture = hasAtlas ? this.scene.textures.get(ATLAS) : null
    const frame = texture ? frameFor(item, this.defs, (f) => texture.has(f)) : null

    let sprite: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle
    if (frame) {
      sprite = this.scene.add.image(item.x, item.y, ATLAS, frame).setOrigin(0.5, 0.5)
    } else {
      // docs/50 §8: the game starts with no art, and every fallback logs once.
      const key = `item:${item.item}`
      if (!this.warned.has(key)) {
        this.warned.add(key)
        console.info(`[items] no sprite for item ${item.item} — drawing a box`)
      }
      const tint = FALLBACK_TINTS[item.item % FALLBACK_TINTS.length] ?? 0xffffff
      sprite = this.scene.add.rectangle(item.x, item.y, 14, 14, tint).setStrokeStyle(1, 0x101418)
    }
    this.container.add(sprite)
    this.entries.set(item.id, { sprite, label: null, item })
  }

  clear(): void {
    for (const e of this.entries.values()) {
      e.sprite.destroy()
      e.label?.destroy()
    }
    this.entries.clear()
  }

  destroy(): void {
    this.clear()
    this.container.destroy()
  }
}
