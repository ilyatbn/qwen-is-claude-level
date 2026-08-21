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
import { ensureItemTextures } from './itemTextures'
import {
  beaconPulse,
  bobFor,
  diffItems,
  frameFor,
  isFallingCrate,
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
  /**
   * One Graphics for every parachute and beacon on screen, redrawn each frame.
   *
   * Per-item objects would be the obvious shape and are the wrong one here:
   * there are at most a handful of crates, and a single cleared-and-redrawn
   * canvas cannot leave a parachute behind on an item that has landed.
   */
  private readonly chutes: Phaser.GameObjects.Graphics
  private defs: Map<number, ItemDefView> = new Map()
  private warned = new Set<string>()
  private t = 0

  constructor(scene: Phaser.Scene) {
    ensureItemTextures(scene.textures)
    this.scene = scene
    this.container = scene.add.container(0, 0).setDepth(DEPTH.worldItems)
    // Behind the item itself: a crate hangs *under* its canopy.
    this.chutes = scene.add.graphics().setDepth(DEPTH.worldItems - 1)
    // ADD, so the beam brightens whatever is behind it instead of laying a
    // translucent wash over it — over a bright sky a wash is invisible.
    this.chutes.setBlendMode(Phaser.BlendModes.ADD)
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
   * Where each item is **actually drawn**, read back off the live display
   * objects.
   *
   * Not the positions handed to `update` — those are what the caller intended,
   * and the whole of §C7 is a case where the intended position and the drawn one
   * were the same number and both were wrong. Reading the sprite back means a
   * check comparing this against the server's item list is comparing two ends
   * that were arrived at independently.
   */
  get drawn(): Array<{ id: number; x: number; y: number; source: string; grounded: boolean }> {
    return [...this.entries.entries()].map(([id, e]) => ({
      id,
      x: e.sprite.x,
      y: e.sprite.y,
      source: e.item.source,
      grounded: e.item.grounded,
    }))
  }

  /** Parachutes drawn on the last frame. */
  get chutesDrawn(): number {
    return this.chutes_
  }
  private chutes_ = 0

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
      e.sprite.setPosition(item.x, item.y + bobFor(item, id, this.t))

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
      e.label?.setPosition(item.x, item.y - 16 + bobFor(item, id, this.t))
    }

    this.drawCrateMarkers(live)
  }

  /** Parachutes on the crates still falling, beacons on all of them (`docs/32` §4). */
  private drawCrateMarkers(live: WorldItemView[]): void {
    const g = this.chutes
    g.clear()
    let chutes = 0
    for (const item of live) {
      if (item.source !== 'Crate') continue

      // The beacon stays after landing. The doc asks for a crate that pulls
      // players together, and one that stops advertising itself the instant it
      // lands does the opposite — it is loudest while nobody can reach it yet.
      const a = beaconPulse(this.t)
      // A column of light going up, wider at the top the way a beam spreads.
      //
      // The first version drew this at `0.1 * a` — a measured alpha of about
      // 0.05 over a bright sky — and a screenshot showed nothing at all where
      // the beacon was. `chutesDrawn` said 1, every assertion passed, and the
      // beacon did not exist as far as a player was concerned. That is the same
      // failure as the toxic rain in T13.04: the count reports that drawing
      // happened, not that anything became visible.
      g.fillStyle(0xffe27a, 0.28 * a)
      g.fillTriangle(item.x - 4, item.y, item.x + 4, item.y, item.x + 26, item.y - 300)
      g.fillTriangle(item.x - 4, item.y, item.x + 4, item.y, item.x - 26, item.y - 300)
      g.fillStyle(0xfff3c0, 0.85 * a)
      g.fillCircle(item.x, item.y, 9 + 4 * a)
      g.fillStyle(0xffd34d, 0.35 * a)
      g.fillCircle(item.x, item.y, 20 + 8 * a)

      if (!isFallingCrate(item, item.grounded)) continue
      chutes++

      // Canopy: an arc above, with two rigging lines down to the crate's top
      // corners. Drawn from the crate's position, so it tracks the fall exactly
      // rather than being animated separately and drifting off it.
      const cy = item.y - 34
      g.lineStyle(2, 0xf2f5ff, 0.85)
      g.beginPath()
      g.arc(item.x, cy, 20, Math.PI, Math.PI * 2)
      g.strokePath()
      g.lineBetween(item.x - 20, cy, item.x - 9, item.y - 11)
      g.lineBetween(item.x + 20, cy, item.x + 9, item.y - 11)
      g.fillStyle(0xd94f4f, 0.65)
      g.fillEllipse(item.x, cy + 2, 40, 12)
    }
    this.chutes_ = chutes
  }

  private spawn(item: WorldItemView): void {
    const hasAtlas = this.scene.textures.exists(ATLAS)
    const texture = hasAtlas ? this.scene.textures.get(ATLAS) : null
    const frame = texture ? frameFor(item, this.defs, (f) => texture.has(f)) : null
    // Packed art wins; a procedural icon is the fallback `docs/51` §5 describes,
    // not a competitor. Eighteen v3 items have no packed frame (§B20), and
    // without this every one of them was an identical coloured box.
    const proc = frame
      ? null
      : frameFor(item, this.defs, (f) => this.scene.textures.exists(f))

    let sprite: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle
    if (frame) {
      sprite = this.scene.add.image(item.x, item.y, ATLAS, frame).setOrigin(0.5, 0.5)
    } else if (proc) {
      sprite = this.scene.add.image(item.x, item.y, proc).setOrigin(0.5, 0.5)
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
    this.chutes.destroy()
    this.container.destroy()
  }
}
