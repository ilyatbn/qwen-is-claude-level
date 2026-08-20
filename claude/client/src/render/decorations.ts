/**
 * Drawing `MapMeta.decorations` — the props that stop the terrain reading bare.
 *
 * The data has existed since M1 and shipped in `map_init` since T6.04; only the
 * drawing was missing. Purely cosmetic: no collision, no gameplay effect, and a
 * client may skip the layer entirely (`docs/50` §6).
 *
 * Placement arithmetic is in `decorations-math.ts` (§A8); this file is Phaser.
 */

import Phaser from 'phaser'
import { DEPTH } from './backdrop'
import {
  destroyedBy,
  place,
  type PlacedDecoration,
  type WireDecoration,
} from './decorations-math'

/** Frames live in the `decor` atlas, built by `scripts/build-atlas.mjs`. */
const ATLAS = 'decor'

export class DecorationLayer {
  private readonly scene: Phaser.Scene
  private readonly container: Phaser.GameObjects.Container
  private placed: PlacedDecoration[] = []
  private sprites: Array<Phaser.GameObjects.Image | null> = []
  private warned = false

  constructor(scene: Phaser.Scene) {
    this.scene = scene
    this.container = scene.add.container(0, 0).setDepth(DEPTH.decorations)
  }

  get count(): number {
    return this.sprites.filter(Boolean).length
  }

  /**
   * Build the layer from the map's decorations.
   *
   * `solidAt` is the **live** mask, so a joiner arriving into a damaged map does
   * not get props hanging over craters that were blown up before they connected.
   */
  build(decorations: WireDecoration[], solidAt: (x: number, y: number) => boolean): void {
    this.clear()

    const hasAtlas = this.scene.textures.exists(ATLAS)
    if (!hasAtlas) {
      // docs/50 §8: no art is a supported state, and it logs once rather than
      // once per prop.
      if (!this.warned) {
        this.warned = true
        console.info('[decor] no decor atlas — the map runs bare')
      }
      return
    }
    const texture = this.scene.textures.get(ATLAS)
    const hasFrame = (f: string) => texture.has(f)

    this.placed = place(decorations, hasFrame, solidAt)
    this.sprites = this.placed.map((d) => {
      const img = this.scene.add
        .image(d.x, d.y, ATLAS, d.frame)
        // Anchored at the bottom centre: the position is a surface point, which
        // is where the prop's feet go, not its middle (§A26 — a coordinate
        // without its frame of reference is how things end up buried).
        .setOrigin(0.5, 1)
        .setScale(d.scale)
        .setFlipX(d.flip)
      this.container.add(img)
      return img
    })
  }

  /**
   * Remove the props a carve destroyed. Returns how many went.
   *
   * A tuft of grass floating over a fresh crater is exactly the detail that
   * makes destruction look fake, and this map is blown apart continuously.
   */
  onCarve(x: number, y: number, r: number): number {
    if (!this.placed.length) return 0
    const hit = destroyedBy(this.placed, x, y, r)
    for (const i of hit) {
      this.sprites[i]?.destroy()
      this.sprites[i] = null
    }
    if (hit.length) {
      // Compact both arrays together, or the indices stop agreeing and the next
      // carve destroys the wrong props.
      const keep = this.placed.filter((_, i) => this.sprites[i] !== null)
      const sprites = this.sprites.filter((s) => s !== null)
      this.placed = keep
      this.sprites = sprites
    }
    return hit.length
  }

  setVisible(v: boolean): void {
    this.container.setVisible(v)
  }

  private clear(): void {
    for (const s of this.sprites) s?.destroy()
    this.sprites = []
    this.placed = []
  }

  destroy(): void {
    this.clear()
    this.container.destroy()
  }
}
