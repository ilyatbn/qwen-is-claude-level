/**
 * The layers behind the terrain.
 *
 * **The real sky is T3.12's** (`docs/70-amendments-v2.md` §A4: five phases, sun,
 * moon, stars). This deliberately draws a flat placeholder colour instead — writing
 * a gradient here would mean writing it twice and throwing one away.
 *
 * The **cave backdrop is what makes destruction read correctly**: without it a
 * crater punched through a hillside shows sky through it and the map looks like
 * paper rather than rock.
 */

import { C } from '../core'

export interface ThemeColors {
  skyPlaceholder: number
  caveBack: number
}

export const DEFAULT_THEME: ThemeColors = {
  skyPlaceholder: 0x9cc7e8,
  caveBack: 0x241f1a,
}

/** Depths from `docs/12-map-render.md` §5. */
export const DEPTH = {
  sky: -30,
  parallax: -20,
  caveBack: -10,
  terrain: 0,
  decorations: 10,
  worldItems: 20,
  actors: 30,
  particles: 40,
  lightmap: 50,
  hud: 60,
} as const

export class Backdrop {
  private readonly objects: Array<{ destroy(): void }> = []

  constructor(scene: Phaser.Scene, theme: ThemeColors, mapW: number, mapH: number) {
    const c = C()

    // Flat placeholder sky, fixed to the camera. Replaced wholesale by T3.12.
    //
    // Sized generously rather than to the viewport: with scrollFactor 0 the rect is
    // drawn in camera space, so at zoom < 1 a viewport-sized rect covers only part
    // of the screen and the rest shows the clear colour. The first preview
    // screenshot was mostly black for exactly this reason.
    const sky = scene.add
      .rectangle(-c.VIEWPORT_W, -c.VIEWPORT_H, c.VIEWPORT_W * 4, c.VIEWPORT_H * 4, theme.skyPlaceholder)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DEPTH.sky)
    this.objects.push(sky)

    // The cave backdrop is NOT a layer here: it is baked into each chunk, masked
    // by the dilated terrain silhouette (`BackdropMask`). A full-map rectangle at
    // depth -10 would hide the sky everywhere, which is what the first preview
    // screenshot showed.
    void mapW
    void mapH
  }

  destroy(): void {
    for (const o of this.objects) o.destroy()
    this.objects.length = 0
  }
}
